import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import persistentScriptSupervisorSource from "./workers/persistent-script-supervisor.worker.js";
import persistentScriptSandboxSource from "./workers/persistent-script.worker.js";
import { withInternalMetadata } from "./internal-command-metadata.js";
import { PERSISTENT_RPC_ALLOWLIST, validateWorkerRpc } from "./script-rpc-policy.js";
import { assertSafeScriptSource } from "./script-source-policy.js";

export function createScriptService({
    state,
    ui,
    responder,
    ensureRomLoaded,
    finishPersistentScriptEvent,
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

    function scriptConsoleLine(script, values) {
        const line = values.map((value) => typeof value === "string" ? value : rawOutputText(value)).join(" ");
        script.output = [...script.output, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-400);
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
            try {
                script.worker.postMessage({ type: "event", event: type, payload });
            } catch (error) {
                void failPersistentScript(script, error);
            }
        }
    }
    
    async function unregisterScriptTriggers(script) {
        for (const trigger of [...script.triggers]) {
            if (trigger.breakpointId) {
                await commands.removeBreakpoint({ id: trigger.breakpointId });
            }
            if (trigger.specialBreakpointId) {
                await commands.removeBreakpoint({ id: trigger.specialBreakpointId });
            }
            state.scriptTriggers = state.scriptTriggers.filter((item) => item.id !== trigger.id);
        }
        script.triggers = [];
    }
    
    async function registerScriptTrigger(script, trigger) {
        ensureRomLoaded("script trigger registration requires a loaded ROM");
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
    
    function queuePersistentScriptOperation(script, command, params, eventId = 0) {
        const operation = script.queue.then(async () => {
            if (!script.running) throw new Error(`script stopped before queued ${command} operation`);
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
            triggers: []
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
                if (msg.type === "ready" && !ready) {
                    ready = true;
                    worker.postMessage({
                        type: "start",
                        code,
                        asyncMode,
                        sandboxSource: persistentScriptSandboxSource,
                        shortcuts: Object.entries(window.DesmumeShortcuts || {}).map(([shortcut, definition]) => [
                            shortcut,
                            definition.command,
                            definition.params,
                            definition.defaults
                        ])
                    });
                } else if (msg.type === "call") {
                    if (!ready) throw new Error("Persistent script sent RPC before ready");
                    const request = validateWorkerRpc(msg, PERSISTENT_RPC_ALLOWLIST, seenRequestIds);
                    try {
                        const result = await queuePersistentScriptOperation(
                            script,
                            request.command,
                            request.params,
                            msg.eventId
                        );
                        worker.postMessage({ replyId: msg.id, result });
                    } catch (error) {
                        worker.postMessage({ replyId: msg.id, error: String(error?.message || error) });
                    }
                } else if (msg.type === "register") {
                    if (!ready || typeof msg.id !== "string" || seenRequestIds.has(msg.id) || !msg.trigger || typeof msg.trigger !== "object") {
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
