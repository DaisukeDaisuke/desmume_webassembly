import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import persistentScriptSupervisorSource from "./workers/persistent-script-supervisor.worker.js";
import persistentScriptSandboxSource from "./workers/persistent-script.worker.js";
import parserWorkerSource from "./workers/parser.worker.js";
import { withInternalMetadata } from "./internal-command-metadata.js";
import { PERSISTENT_RPC_ALLOWLIST, validateWorkerRpc } from "./script-rpc-policy.js";
import { assertSafeScriptSource } from "./script-source-policy.js";
import { ResourceLimits } from "./resource-limits.js";
import acornDependency from "./dependencies/acorn.dependency-source.js";

export function createScriptService({
    state,
    ui,
    responder,
    breakpointOwners,
    ensureRomLoaded,
    finishPersistentScriptEvent,
    requestPersistentScriptResume,
    settlePersistentScriptCallbacks,
    hex,
    parseAddress,
    rawOutputText,
    runCommand,
    getCommands,
    onExplicitPause
}) {
    const commands = new Proxy({}, {
        get: (_, command) => getCommands()[command]
    });

    const scriptBytes = (script) => new TextEncoder().encode(`${script.code}\n${script.output.join("\n")}`).byteLength;

    function pruneStoppedScripts(requiredBytes = 0) {
        const stopped = [...state.scripts.values()]
            .filter((script) => !script.running && script.id !== state.activeScriptId)
            .sort((left, right) => Number(left.stoppedAt || 0) - Number(right.stoppedAt || 0));
        const totalBytes = () => [...state.scripts.values()].reduce((sum, script) => sum + scriptBytes(script), 0);
        while (stopped.length && (state.scripts.size >= ResourceLimits.totalScriptRecords
            || totalBytes() + requiredBytes > ResourceLimits.totalScriptHistoryBytes)) {
            const removed = stopped.shift();
            state.scripts.delete(removed.id);
        }
        if (!state.scripts.has(state.activeScriptId)) {
            state.activeScriptId = [...state.scripts.values()].at(-1)?.id || 0;
        }
        return totalBytes();
    }

    function scriptConsoleLine(script, values) {
        const line = values.map((value) => typeof value === "string" ? value : rawOutputText(value)).join(" ");
        script.output = [...script.output, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-400);
        let outputBytes = new TextEncoder().encode(script.output.join("\n")).byteLength;
        while (outputBytes > ResourceLimits.scriptOutputBytes && script.output.length > 1) {
            script.output.shift();
            outputBytes = new TextEncoder().encode(script.output.join("\n")).byteLength;
        }
        pruneStoppedScripts();
        if (state.activeScriptId === script.id) renderScriptConsole(script);
    }

    function scriptFailureDetails(message, source) {
        const error = message.error || {};
        const stack = String(error.stack || "");
        const location = stack.match(/desmume-persistent-user\.js:(\d+):(\d+)/);
        const line = location ? Math.max(1, Number(location[1]) - 1) : undefined;
        const column = location ? Number(location[2]) : undefined;
        const sourceExcerpt = line
            ? String(source).split(/\r?\n/)[line - 1]?.slice(0, 240)
            : undefined;
        return {
            phase: String(message.phase || "runtime"),
            errorName: String(error.name || "Error"),
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            sourceName: "desmume-persistent-user.js",
            ...(sourceExcerpt ? { sourceExcerpt } : {}),
            ...(stack ? { stack: stack.split("\n").slice(0, 3).join("\n").slice(0, 600) } : {})
        };
    }

    function scriptFailureResult(message, source) {
        const phase = String(message.phase || "runtime");
        const code = phase === "compile"
            ? ErrorCode.SCRIPT_COMPILE_ERROR
            : phase === "protocol"
                ? ErrorCode.WORKER_PROTOCOL_ERROR
                : ErrorCode.SCRIPT_RUNTIME_ERROR;
        return responder.fail(
            code,
            String(message.error?.message || message.error || "Persistent script failed"),
            scriptFailureDetails(message, source)
        );
    }
    
    function renderScriptConsole(script = state.scripts.get(state.activeScriptId)) {
        const text = script ? script.output.join("\n") : "No script selected.";
        ui.scriptRawOutput.value = text;
        ui.scriptOutput.textContent = text || "No console output.";
    }
    
    function renderScripts() {
        const selected = state.scripts.get(state.activeScriptId);
        ui.scriptTabs.replaceChildren();
        ui.scriptList.replaceChildren();
        for (const script of state.scripts.values()) {
            const tab = ui.scriptTabTemplate.content.firstElementChild.cloneNode(true);
            tab.textContent = script.name;
            tab.dataset.scriptTab = script.id;
            tab.setAttribute("aria-selected", String(script.id === state.activeScriptId));
            tab.addEventListener("click", () => selectScript(script.id));
            ui.scriptTabs.append(tab);
            const row = document.createElement("button");
            row.type = "button";
            row.dataset.running = String(script.running);
            row.textContent = `${script.name} · ${script.running ? "running" : "stopped"} · ${script.triggers.length} triggers`;
            row.addEventListener("click", () => selectScript(script.id));
            ui.scriptList.append(row);
        }
        if (!selected && state.scripts.size) selectScript(state.scripts.values().next().value.id);
    }
    
    function selectScript(id) {
        const script = state.scripts.get(Number(id));
        if (!script) return;
        state.activeScriptId = script.id;
        ui.scriptName.value = script.name;
        ui.scriptAsyncMode.checked = script.asyncMode;
        if (document.activeElement !== ui.scriptCode) ui.scriptCode.value = script.code;
        renderScriptConsole(script);
        renderScripts();
    }
    
    function dispatchScriptEvent(type, payload = {}) {
        for (const script of state.scripts.values()) {
            if (!script.running) continue;
            const message = { type: "event", event: type, payload };
            if (type === "tick") {
                const index = script.eventQueue.findIndex((queued) => queued.event === "tick");
                if (index >= 0) {
                    script.eventQueue[index] = message;
                    script.droppedEvents++;
                    continue;
                }
            }
            if (script.eventQueue.length >= ResourceLimits.persistentEventQueue) {
                void failPersistentScript(script, new Error(`main event queue exceeded ${ResourceLimits.persistentEventQueue}`));
                continue;
            }
            script.eventQueue.push(message);
            pumpScriptEvents(script);
        }
    }

    function pumpScriptEvents(script) {
        if (!script.running || script.eventBusy || !script.eventQueue.length) return;
        script.eventBusy = true;
        try {
            script.worker.postMessage(script.eventQueue.shift());
        } catch (error) {
            script.eventBusy = false;
            void failPersistentScript(script, error);
        }
    }
    
    async function unregisterScriptTriggers(script) {
        const failures = [];
        for (const trigger of [...script.triggers]) {
            for (const ownerId of [trigger.breakpointId, trigger.specialBreakpointId].filter(Boolean)) {
                try {
                    await commands.removeBreakpoint({ id: ownerId });
                } catch (error) {
                    breakpointOwners.discardOwner(ownerId);
                    failures.push({ ownerId, message: String(error?.message || error).slice(0, 300) });
                }
            }
            state.scriptTriggers = state.scriptTriggers.filter((item) => item.id !== trigger.id);
        }
        script.triggers = [];
        try {
            breakpointOwners.reconcileNativeBreakpoints();
        } catch (error) {
            failures.push({ stage: "reconcile", message: String(error?.message || error).slice(0, 300) });
        }
        if (failures.length) {
            const error = new Error("persistent script trigger cleanup required recovery");
            error.mcpCode = ErrorCode.NATIVE_ERROR;
            error.mcpDetails = { failures };
            throw error;
        }
    }
    
    async function registerScriptTrigger(script, trigger) {
        ensureRomLoaded("script trigger registration requires a loaded ROM");
        if (script.triggers.length >= ResourceLimits.scriptTriggers) {
            throw new Error(`script trigger limit exceeded (${ResourceLimits.scriptTriggers})`);
        }
        const type = String(trigger.kind || trigger.type || "tick");
        const item = { id: state.nextScriptTriggerId++, scriptId: script.id, callbackId: Number(trigger.callbackId), type, cpu: String(trigger.cpu || state.selectedCpu), address: parseAddress(trigger.address, 0, trigger.cpu) };
        if (["read", "write", "exec"].includes(type)) {
            const result = await commands.setBreakpoint(withInternalMetadata(
                { cpu: item.cpu, type, address: item.address, enabled: true },
                { origin: "script", scriptId: script.id, triggerId: item.id }
            ));
            item.breakpointId = result.id;
        } else if (["dataAbort", "prefetchAbort", "undefinedInstruction"].includes(type)) {
            const result = await commands.setSpecialBreakpoint(withInternalMetadata(
                { kind: type, enabled: true },
                { origin: "script", scriptId: script.id, triggerId: item.id }
            ));
            item.specialBreakpointId = result.id;
        } else if (type !== "tick" && type !== "start" && type !== "stateLoad" && type !== "stateSave") {
            throw new Error(`unknown script trigger: ${type}`);
        }
        script.triggers.push(item);
        state.scriptTriggers.push(item);
        renderScripts();
        return item;
    }
    
    const ASYNC_SCRIPT_BLOCKED_COMMANDS = new Set([
        "pause", "resume", "memorySetRegister",
        "memoryReadByte", "memoryReadWord", "memoryReadDword",
        "memoryWriteByte", "memoryWriteWord", "memoryWriteDword", "dumpMemory",
        "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze"
    ]);
    
    function queuePersistentScriptOperation(script, command, params, eventIdentity = {}) {
        const eventId = Number(eventIdentity.eventId) || 0;
        const operation = script.queue.then(async () => {
            if (!script.running) throw new Error(`script stopped before queued ${command} operation`);
            if (command === "resume" && eventId) {
                const deferred = requestPersistentScriptResume(eventId, {
                    scriptId: script.id,
                    callbackId: eventIdentity.callbackId,
                    callbackToken: eventIdentity.callbackToken
                });
                if (!deferred) throw new Error("resume request did not match the active script event");
                return deferred;
            }
            if (script.asyncMode && ASYNC_SCRIPT_BLOCKED_COMMANDS.has(command)) {
                throw new Error(`${command} is unavailable in persistent-script async mode because it requires immediate emulator state. Restart with asyncMode:false (or clear “async queue” in the UI).`);
            }
            if (command === "register") return registerScriptTrigger(script, params);
            const result = command === "pause" && eventId
                ? await commands.pause(withInternalMetadata(params, {
                    scriptCallback: true,
                    scriptId: script.id,
                    scriptEventId: eventId
                }))
                : await runCommand(command, params);
            if (command === "pause" && eventId && result?.ok !== false) {
                onExplicitPause({ scriptId: script.id, eventId: Number(eventId) });
            }
            return result;
        });
        script.queue = operation.catch(() => undefined);
        return operation;
    }
    
    async function startPersistentScript(params = {}) {
        const source = params.code ?? ui.scriptCode.value;
        if (typeof source !== "string" || !source.trim() || source.length > 262144) {
            return responder.fail(ErrorCode.SCRIPT_SOURCE_INVALID, "Persistent script source must be a non-empty string up to 262144 characters");
        }
        try {
            assertSafeScriptSource(source);
        } catch (error) {
            return responder.fail(error.mcpCode, error.message, error.mcpDetails);
        }
        const code = source;
        const name = String(params.name ?? ui.scriptName.value ?? "scratch").trim() || "scratch";
        const asyncMode = !!(params.asyncMode ?? ui.scriptAsyncMode.checked);
        const startupTimeoutMs = Number(params.startupTimeoutMs ?? 3000);
        if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 600000) {
            return responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                "startupTimeoutMs must be between 1 and 600000"
            );
        }
        const duplicate = [...state.scripts.values()].find((script) => script.code === code && script.asyncMode === asyncMode && script.running);
        if (duplicate) return scriptSummary(duplicate, true);
        const existing = [...state.scripts.values()].find((script) => script.name === name);
        if (existing) await stopPersistentScript({ id: existing.id });
        const sourceBytes = new TextEncoder().encode(source).byteLength;
        const retainedBytes = pruneStoppedScripts(sourceBytes);
        if (!existing && (state.scripts.size >= ResourceLimits.totalScriptRecords
            || retainedBytes + sourceBytes > ResourceLimits.totalScriptHistoryBytes)) {
            return responder.fail(ErrorCode.BUSY, "Persistent script history limit reached", {
                records: state.scripts.size,
                maximumRecords: ResourceLimits.totalScriptRecords,
                maximumBytes: ResourceLimits.totalScriptHistoryBytes
            });
        }
        const runningScripts = [...state.scripts.values()].filter((script) => script.running).length;
        if (runningScripts >= ResourceLimits.persistentScripts) {
            return responder.fail(ErrorCode.BUSY, "Persistent script limit reached", {
                running: runningScripts,
                maximum: ResourceLimits.persistentScripts
            });
        }
        const script = {
            id: existing?.id || state.nextScriptId++,
            name,
            code,
            asyncMode,
            queue: Promise.resolve(),
            worker: null,
            workerHost: null,
            running: true,
            output: [],
            triggers: [],
            eventQueue: [],
            eventBusy: false,
            droppedEvents: 0,
            createdAt: Date.now()
        };
        let workerHost;
        try {
            workerHost = createEmbeddedWorker(persistentScriptSupervisorSource);
        } catch (error) {
            return responder.fail(ErrorCode.WORKER_START_FAILED, "Persistent script Worker could not be started", {
                errorName: String(error?.name || "Error"),
                message: String(error?.message || error)
            });
        }
        const { worker } = workerHost;
        script.worker = worker;
        script.workerHost = workerHost;
        state.scripts.set(script.id, script);
        state.activeScriptId = script.id;
        let startupSettled = false;
        let ready = false;
        let compiled = false;
        const seenRequestIds = new Set();
        let resolveStartup;
        const startup = new Promise((resolve) => {
            resolveStartup = resolve;
        });
        const settleStartup = (result) => {
            if (startupSettled) return false;
            startupSettled = true;
            clearTimeout(startupTimer);
            resolveStartup(result);
            return true;
        };
        const handleWorkerFailure = async (result, message) => {
            await failPersistentScript(script, message);
            settleStartup(result);
        };
        const startupTimer = setTimeout(() => {
            const result = responder.fail(
                ErrorCode.WORKER_START_FAILED,
                "Persistent script Worker did not complete its startup handshake",
                { timeoutMs: startupTimeoutMs }
            );
            void handleWorkerFailure(result, "startup handshake timed out");
        }, startupTimeoutMs);
        worker.onmessage = async (event) => {
            const msg = event.data || {};
            try {
                if (msg.type === "ready" && !ready
                    && msg.hardened === true && msg.layer === "supervisor") {
                    ready = true;
                    worker.postMessage({
                        type: "start",
                        code,
                        asyncMode,
                        parserSource: parserWorkerSource,
                        sandboxSource: persistentScriptSandboxSource,
                        dependency: acornDependency,
                        shortcuts: Object.entries(window.DesmumeShortcuts || {}).map(([shortcut, definition]) => [
                            shortcut,
                            definition.command,
                            definition.params,
                            definition.defaults
                        ])
                    });
                } else if (msg.type === "call") {
                    if (!ready) throw new Error("Persistent script sent RPC before ready");
                    if (seenRequestIds.size >= ResourceLimits.pendingWorkerRpc) {
                        throw Object.assign(new Error("Persistent script exceeded its pending RPC limit"), {
                            mcpCode: ErrorCode.BUSY
                        });
                    }
                    const request = validateWorkerRpc(msg, PERSISTENT_RPC_ALLOWLIST, seenRequestIds);
                    try {
                        const result = await queuePersistentScriptOperation(
                            script,
                            request.command,
                            request.params,
                            msg
                        );
                        worker.postMessage({ replyId: msg.id, result });
                    } catch (error) {
                        worker.postMessage({ replyId: msg.id, error: String(error?.message || error) });
                    } finally {
                        seenRequestIds.delete(msg.id);
                    }
                } else if (msg.type === "register") {
                    if (!ready || seenRequestIds.size >= ResourceLimits.pendingWorkerRpc
                        || typeof msg.id !== "string" || seenRequestIds.has(msg.id) || !msg.trigger || typeof msg.trigger !== "object") {
                        await handleWorkerFailure(
                            responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent a malformed trigger request"),
                            "malformed Worker trigger request"
                        );
                        return;
                    }
                    seenRequestIds.add(msg.id);
                    try {
                        const result = await queuePersistentScriptOperation(script, "register", msg.trigger);
                        worker.postMessage({ replyId: msg.id, result });
                    } catch (error) {
                        worker.postMessage({ replyId: msg.id, error: String(error?.message || error) });
                    } finally {
                        seenRequestIds.delete(msg.id);
                    }
                } else if (msg.type === "eventDone" && Number.isFinite(Number(msg.eventId))) {
                    const accepted = await finishPersistentScriptEvent(msg.eventId, {
                        scriptId: script.id,
                        callbackId: msg.callbackId,
                        callbackToken: msg.callbackToken
                    });
                    if (!accepted) {
                        await handleWorkerFailure(
                            responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent an invalid event completion"),
                            "invalid Worker event completion"
                        );
                    }
                } else if (msg.type === "print" && Array.isArray(msg.values)) {
                    scriptConsoleLine(script, msg.values);
                } else if (msg.type === "eventAck") {
                    script.eventBusy = false;
                    pumpScriptEvents(script);
                } else if (msg.type === "compiled" && ready && !compiled) {
                    compiled = true;
                } else if (msg.type === "started") {
                    if (!ready || !compiled) {
                        throw new Error("Persistent script started before compile acknowledgement");
                    }
                    settleStartup(scriptSummary(script, false));
                } else if (msg.type === "failed") {
                    const result = scriptFailureResult(msg, code);
                    await handleWorkerFailure(result, result.error.message);
                } else {
                    await handleWorkerFailure(
                        responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent an unknown message"),
                        `unknown Worker message: ${String(msg.type)}`
                    );
                }
            } catch (error) {
                await handleWorkerFailure(
                    responder.fail(error?.mcpCode || ErrorCode.WORKER_PROTOCOL_ERROR, String(error?.message || error)),
                    String(error?.message || error)
                );
            }
        };
        worker.onerror = (event) => {
            const message = String(event.message || event.error?.message || "Persistent script Worker crashed");
            void handleWorkerFailure(
                responder.fail(ready ? ErrorCode.WORKER_CRASHED : ErrorCode.WORKER_START_FAILED, ready ? "Persistent script Worker crashed" : "Persistent script Worker failed during startup", { message }),
                message
            );
        };
        worker.onmessageerror = () => {
            void handleWorkerFailure(
                responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script Worker returned an unreadable message"),
                "persistent script Worker protocol error"
            );
        };
        renderScripts();
        return startup;
    }
    
    async function stopPersistentScript(params = {}) {
        const id = Number(params.id ?? state.activeScriptId);
        const script = state.scripts.get(id);
        if (!script) throw new Error(`script not found: ${id}`);
        script.running = false;
        script.stoppedAt = Date.now();
        await settlePersistentScriptCallbacks(script.id);
        try {
            await unregisterScriptTriggers(script);
        } finally {
            script.workerHost?.dispose();
            renderScripts();
            renderScriptConsole(script);
        }
        return scriptSummary(script, false);
    }
    
    async function failPersistentScript(script, error) {
        if (!script.running) return;
        scriptConsoleLine(script, ["stopped: " + String(error?.message || error)]);
        try {
            await stopPersistentScript({ id: script.id });
        } catch (stopError) {
            script.workerHost?.dispose();
            script.running = false;
            scriptConsoleLine(script, ["trigger cleanup failed: " + String(stopError?.message || stopError)]);
            renderScripts();
            renderScriptConsole(script);
        }
    }
    
    function scriptSummary(script, duplicate = false) {
        return { id: script.id, name: script.name, running: script.running, asyncMode: script.asyncMode, triggers: script.triggers.map(({ id, type, address, cpu }) => ({ id, type, address: hex(address), cpu })), duplicate };
    }

    return { scriptConsoleLine, renderScriptConsole, renderScripts, selectScript, dispatchScriptEvent, startPersistentScript, stopPersistentScript, scriptSummary };
}
