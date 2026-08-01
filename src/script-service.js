import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import persistentScriptSupervisorSource from "./workers/persistent-script-supervisor.worker.js";
import persistentScriptSandboxSource from "./workers/persistent-script.worker.js";
import parserWorkerSource from "./workers/parser.worker.js";
import { withInternalMetadata } from "./internal-command-metadata.js";
import { validateWorkerRpc } from "./script-rpc-policy.js";
import { assertSafeScriptSource } from "./script-source-policy.js";
import { ResourceLimits } from "./resource-limits.js";
import {
    normalizePersistentBaselineData,
    normalizePersistentBaselineEntries,
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult
} from "./worker-rpc-payload.js";
import { readOwnDataProperty } from "./structured-value-normalizer.js";
import { codedError } from "./validation.js";
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
    let scriptInstanceSerial = 1;
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
        const error = message.error && typeof message.error === "object" ? message.error : {};
        const workerDetails = readOwnDataProperty(error, "details");
        const structuredDetails = workerDetails && typeof workerDetails === "object"
            ? workerDetails
            : {};
        const stack = String(
            readOwnDataProperty(structuredDetails, "stack")
            || readOwnDataProperty(error, "stack")
            || ""
        );
        const location = stack.match(/desmume-persistent-user\.js:(\d+):(\d+)/);
        const structuredLine = Number(readOwnDataProperty(structuredDetails, "line"));
        const structuredColumn = Number(readOwnDataProperty(structuredDetails, "column"));
        const line = Number.isSafeInteger(structuredLine) && structuredLine > 0
            ? structuredLine
            : location ? Math.max(1, Number(location[1]) - 2) : undefined;
        const column = Number.isSafeInteger(structuredColumn) && structuredColumn > 0
            ? structuredColumn
            : location ? Number(location[2]) : undefined;
        const sourceExcerpt = line
            ? String(source).split(/\r?\n/)[line - 1]?.slice(0, 240)
            : undefined;
        return {
            phase: String(message.phase || "runtime"),
            errorName: String(
                readOwnDataProperty(structuredDetails, "errorName")
                || readOwnDataProperty(error, "name")
                || "Error"
            ),
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            sourceName: String(
                readOwnDataProperty(structuredDetails, "sourceName")
                || "desmume-persistent-user.js"
            ),
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
            String(readOwnDataProperty(message.error, "message") || "Persistent script failed"),
            scriptFailureDetails(message, source)
        );
    }

    function workerRpcError(error, fallbackCode = ErrorCode.INTERNAL_ERROR) {
        const details = error?.mcpDetails === undefined
            ? {}
            : { ...error.mcpDetails };
        if (error?.callSiteStack) details.callSiteStack = String(error.callSiteStack).slice(0, 8192);
        return {
            code: String(error?.mcpCode || fallbackCode),
            message: String(error?.message || error || "Worker RPC failed").slice(0, 2048),
            ...(Object.keys(details).length ? { details } : {})
        };
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
            row.textContent = `${script.name} · ${script.running ? "running" : "stopped"} · ${script.triggers.length} triggers · ${script.pscriptMcps.size} MCPs`;
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
            if (!script.running || !script.started) continue;
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
        if (!script.running || !script.started || script.eventBusy || !script.eventQueue.length) return;
        if (state.analysisBaselineOperation && script.eventQueue[0]?.type !== "baselineHookInvoke") return;
        script.eventBusy = true;
        try {
            script.worker.postMessage(script.eventQueue.shift());
        } catch (error) {
            script.eventBusy = false;
            void failPersistentScript(script, error);
        }
    }

    function isCurrentScript(script) {
        return script.running && state.scripts.get(script.id) === script;
    }

    function rejectPendingPScriptMcpCalls(
        script,
        code = ErrorCode.SCRIPT_RUNTIME_ERROR,
        message = "Persistent script stopped before its MCP call completed"
    ) {
        for (const pending of script.pendingPScriptMcpCalls.values()) {
            clearTimeout(pending.timer);
            pending.reject(codedError(code, message, {
                scriptId: script.id,
                name: pending.name
            }));
        }
        script.pendingPScriptMcpCalls.clear();
        script.expiredPScriptMcpCalls.clear();
        script.inFlightPScriptMcpCalls.clear();
        script.pscriptMcps.clear();
        script.pscriptMcpPublished = false;
    }

    function requestBaselineBarrierAck(script, operation, active) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (script.pendingBaselineBarrierAcks.get(operation.operationId)?.active !== active) return;
                script.pendingBaselineBarrierAcks.delete(operation.operationId);
                reject(codedError(ErrorCode.BUSY, "Persistent script baseline barrier acknowledgement timed out", {
                    scriptId: script.id,
                    operationId: operation.operationId,
                    active,
                    timeoutMs: ResourceLimits.persistentBaselineHookQueueTimeoutMs
                }));
            }, ResourceLimits.persistentBaselineHookQueueTimeoutMs);
            script.pendingBaselineBarrierAcks.set(operation.operationId, { active, resolve, reject, timer });
            try {
                script.worker?.postMessage({
                    type: "baselineBarrier",
                    active,
                    operationId: operation.operationId,
                    operation: operation.operation
                });
            } catch (error) {
                clearTimeout(timer);
                script.pendingBaselineBarrierAcks.delete(operation.operationId);
                reject(error);
            }
        });
    }

    function finishBaselineBarrierAck(script, message) {
        const operationId = Number(message.operationId);
        const pending = script.pendingBaselineBarrierAcks.get(operationId);
        if (!pending || pending.active !== (message.active === true)) return;
        clearTimeout(pending.timer);
        script.pendingBaselineBarrierAcks.delete(operationId);
        pending.resolve();
    }

    async function acquireBaselineBarriers(operation) {
        const participants = baselineParticipants();
        for (const script of participants) {
            if (script.baselineBarrier || !script.worker || !script.running || !script.started) {
                throw codedError(ErrorCode.BUSY, "Persistent script baseline barrier is unavailable", { scriptId: script.id });
            }
        }
        operation.baselineBarrierScripts = participants;
        try {
            await Promise.all(participants.map(async (script) => {
                script.baselineBarrier = {
                    operationId: operation.operationId,
                    operation: operation.operation,
                    active: false
                };
                await requestBaselineBarrierAck(script, operation, true);
                if (script.baselineBarrier?.operationId === operation.operationId) script.baselineBarrier.active = true;
            }));
            operation.barriersAcquired = true;
        } catch (error) {
            await releaseBaselineBarriers(operation);
            throw error;
        }
    }

    async function releaseBaselineBarriers(operation) {
        const scripts = (operation?.baselineBarrierScripts || []).filter((script) => (
            script.baselineBarrier?.operationId === operation.operationId
        ));
        await Promise.all(scripts.map(async (script) => {
            await requestBaselineBarrierAck(script, operation, false);
            if (script.baselineBarrier?.operationId === operation.operationId) script.baselineBarrier = null;
            pumpScriptEvents(script);
        }));
    }

    function rejectPendingBaselineHookCalls(
        script,
        code = ErrorCode.SCRIPT_RUNTIME_ERROR,
        message = "Persistent script stopped before its baseline hook completed"
    ) {
        for (const pending of script.pendingBaselineHookCalls.values()) {
            clearTimeout(pending.timer);
            pending.reject(codedError(code, message, {
                scriptId: script.id,
                operation: pending.operation
            }));
        }
        script.pendingBaselineHookCalls.clear();
        script.inFlightBaselineHookCalls.clear();
        script.baselineHookRegistered = false;
        for (const pending of script.pendingBaselineBarrierAcks.values()) {
            clearTimeout(pending.timer);
            pending.reject(codedError(code, message, { scriptId: script.id }));
        }
        script.pendingBaselineBarrierAcks.clear();
    }

    function pruneExpiredPScriptMcpTombstones(script) {
        const now = Date.now();
        for (const [callId, expiresAt] of script.expiredPScriptMcpCalls) {
            if (expiresAt > now) break;
            script.expiredPScriptMcpCalls.delete(callId);
        }
        while (script.expiredPScriptMcpCalls.size > ResourceLimits.expiredPersistentMcpCallsPerScript) {
            script.expiredPScriptMcpCalls.delete(script.expiredPScriptMcpCalls.keys().next().value);
        }
    }

    function nextPScriptMcpCallId(script) {
        for (let attempts = 0; attempts < Number.MAX_SAFE_INTEGER; attempts++) {
            const callId = script.nextPScriptMcpCallId;
            script.nextPScriptMcpCallId = callId >= Number.MAX_SAFE_INTEGER ? 1 : callId + 1;
            if (!script.inFlightPScriptMcpCalls.has(callId)) return callId;
        }
        throw codedError(ErrorCode.BUSY, "No persistent script MCP call ID is available");
    }

    function nextBaselineHookCallId(script) {
        for (let attempts = 0; attempts < Number.MAX_SAFE_INTEGER; attempts++) {
            const callId = script.nextBaselineHookCallId;
            script.nextBaselineHookCallId = callId >= Number.MAX_SAFE_INTEGER ? 1 : callId + 1;
            if (!script.inFlightBaselineHookCalls.has(callId)) return callId;
        }
        throw codedError(ErrorCode.BUSY, "No persistent baseline hook call ID is available");
    }

    async function scriptCodeSha256(script) {
        if (script.codeSha256) return script.codeSha256;
        if (!globalThis.crypto?.subtle) {
            throw codedError(ErrorCode.INTERNAL_ERROR, "SHA-256 is unavailable for persistent script identity");
        }
        const digest = await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(script.code)
        );
        script.codeSha256 = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        return script.codeSha256;
    }

    function invokeBaselineHook(script, operation, name, value = null) {
        if (!isCurrentScript(script) || !script.baselineHookRegistered) {
            throw codedError(ErrorCode.STATE_INVALID, "Persistent baseline hook is unavailable", {
                scriptId: script.id,
                scriptName: script.name,
                operation
            });
        }
        if (script.eventQueue.length >= ResourceLimits.persistentEventQueue) {
            throw codedError(ErrorCode.BUSY, "Persistent script work queue is full", {
                scriptId: script.id,
                maximum: ResourceLimits.persistentEventQueue
            });
        }
        if (script.inFlightPScriptMcpCalls.size) {
            throw codedError(ErrorCode.BUSY, "Persistent script has in-flight MCP work", {
                scriptId: script.id,
                scriptName: script.name
            });
        }
        const callId = nextBaselineHookCallId(script);
        const message = {
            type: "baselineHookInvoke",
            scriptInstanceId: script.scriptInstanceId,
            callId,
            operation,
            name,
            value: operation === "restore" ? normalizePersistentBaselineData(value) : null
        };
        const baselineOperation = state.analysisBaselineOperation;
        message.internalMetadata = {
            operationId: baselineOperation?.operationId,
            scriptId: script.id,
            scriptInstanceId: script.scriptInstanceId,
            baselineHookCallId: callId,
            save: operation
        };
        if (baselineOperation) baselineOperation.activeHookIdentity = message.internalMetadata;
        const promise = new Promise((resolve, reject) => {
            const pending = { resolve, reject, operation, timer: 0, queueTimer: 0, started: false };
            pending.queueTimer = setTimeout(() => {
                if (script.pendingBaselineHookCalls.get(callId) !== pending) return;
                script.pendingBaselineHookCalls.delete(callId);
                script.inFlightBaselineHookCalls.delete(callId);
                reject(codedError(
                    ErrorCode.BUSY,
                    `Persistent baseline ${operation} callback did not start within ${ResourceLimits.persistentBaselineHookQueueTimeoutMs}ms`,
                    {
                        scriptId: script.id,
                        scriptName: script.name,
                        operation,
                        timeoutMs: ResourceLimits.persistentBaselineHookQueueTimeoutMs
                    }
                ));
                void failPersistentScript(script, new Error(`baseline ${operation} callback did not start`));
            }, ResourceLimits.persistentBaselineHookQueueTimeoutMs);
            script.pendingBaselineHookCalls.set(callId, pending);
        });
        script.inFlightBaselineHookCalls.set(callId, { operation });
        script.eventQueue.unshift(message);
        pumpScriptEvents(script);
        return promise;
    }

    function startBaselineHookCall(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId) return;
        const callId = Number(message.callId);
        const operation = message.operation;
        const active = script.inFlightBaselineHookCalls.get(callId);
        const pending = script.pendingBaselineHookCalls.get(callId);
        if (!active || !pending || active.operation !== operation || pending.started) return;
        pending.started = true;
        clearTimeout(pending.queueTimer);
        pending.timer = setTimeout(() => {
            if (script.pendingBaselineHookCalls.get(callId) !== pending) return;
            script.pendingBaselineHookCalls.delete(callId);
            script.inFlightBaselineHookCalls.delete(callId);
            pending.reject(codedError(
                ErrorCode.TIMEOUT,
                `Persistent baseline ${operation} callback did not complete within ${ResourceLimits.persistentBaselineHookTimeoutMs}ms`,
                {
                    scriptId: script.id,
                    scriptName: script.name,
                    operation,
                    timeoutMs: ResourceLimits.persistentBaselineHookTimeoutMs
                }
            ));
            void failPersistentScript(script, new Error(`baseline ${operation} callback timed out`));
        }, ResourceLimits.persistentBaselineHookTimeoutMs);
    }

    function finishBaselineHookCall(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId) return;
        const callId = Number(message.callId);
        const operation = message.operation;
        if (!Number.isSafeInteger(callId) || callId < 1
            || (operation !== "save" && operation !== "restore")
            || typeof message.ok !== "boolean") {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent a malformed baseline hook result"
            );
        }
        const active = script.inFlightBaselineHookCalls.get(callId);
        if (!active || active.operation !== operation) {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent an unknown baseline hook result"
            );
        }
        const payload = normalizePersistentBaselineData(message.ok ? message.value : message.error);
        script.inFlightBaselineHookCalls.delete(callId);
        script.eventBusy = false;
        const pending = script.pendingBaselineHookCalls.get(callId);
        if (!pending) return;
        clearTimeout(pending.timer);
        clearTimeout(pending.queueTimer);
        script.pendingBaselineHookCalls.delete(callId);
        if (message.ok) {
            pending.resolve(payload);
            return;
        }
        const code = readOwnDataProperty(payload, "code");
        const errorMessage = readOwnDataProperty(payload, "message");
        const details = readOwnDataProperty(payload, "details");
        const workerDetails = details && typeof details === "object" ? details : {};
        pending.reject(codedError(
            typeof code === "string" ? code : ErrorCode.SCRIPT_RUNTIME_ERROR,
            typeof errorMessage === "string" ? errorMessage : `Persistent baseline ${operation} hook failed`,
            {
                scriptId: script.id,
                scriptName: script.name,
                operation,
                ...workerDetails,
                ...(details === undefined ? {} : { worker: details })
            }
        ));
    }

    function baselineParticipants() {
        const participants = [...state.scripts.values()].filter((script) => (
            isCurrentScript(script)
            && script.running
            && script.started
            && script.baselineHookRegistered
            && script.pscriptMcpPublished
        )).sort((left, right) => (
            Number(left.baselinePriority || 0) - Number(right.baselinePriority || 0)
            || Number(left.id) - Number(right.id)
        ));
        const names = new Set();
        for (const script of participants) {
            if (names.has(script.name)) {
                throw codedError(
                    ErrorCode.STATE_INVALID,
                    `Analysis baseline persistent script name is duplicated: ${script.name}`,
                    { scriptName: script.name }
                );
            }
            names.add(script.name);
        }
        return participants;
    }

    function assertBaselineParticipantsStable(snapshot) {
        const current = baselineParticipants();
        if (current.length !== snapshot.length
            || current.some((script, index) => script !== snapshot[index]
                || script.scriptInstanceId !== snapshot[index].scriptInstanceId)) {
            throw codedError(ErrorCode.STATE_INVALID, "Analysis baseline persistent script set changed during operation");
        }
    }

    async function captureAnalysisBaselineScriptState(name) {
        const participants = baselineParticipants().slice();
        const entries = [];
        for (const script of participants) {
            assertBaselineParticipantsStable(participants);
            const value = await invokeBaselineHook(script, "save", name);
            entries.push(normalizePersistentBaselineData({
                name: script.name,
                codeSha256: await scriptCodeSha256(script),
                priority: Number(script.baselinePriority || 0),
                value
            }));
            assertBaselineParticipantsStable(participants);
        }
        return normalizePersistentBaselineEntries(entries);
    }

    async function prepareAnalysisBaselineScriptState(savedEntries) {
        if (savedEntries === undefined || savedEntries === null) return [];
        const entries = normalizePersistentBaselineEntries(savedEntries);
        if (!Array.isArray(entries) || entries.length > ResourceLimits.persistentScripts) {
            throw codedError(ErrorCode.STATE_INVALID, "Analysis baseline persistent script data is invalid");
        }
        const plans = [];
        const names = new Set();
        const participants = baselineParticipants();
        for (const entry of entries) {
            const scriptName = readOwnDataProperty(entry, "name");
            const codeSha256 = readOwnDataProperty(entry, "codeSha256");
            const priority = Number(readOwnDataProperty(entry, "priority") ?? 0);
            const value = readOwnDataProperty(entry, "value");
            if (typeof scriptName !== "string" || !scriptName
                || typeof codeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(codeSha256)
                || !Number.isSafeInteger(priority)
                || names.has(scriptName)) {
                throw codedError(ErrorCode.STATE_INVALID, "Analysis baseline persistent script identity is invalid");
            }
            names.add(scriptName);
            const script = participants.find((candidate) => candidate.name === scriptName);
            if (!script || !script.baselineHookRegistered
                || Number(script.baselinePriority || 0) !== priority
                || await scriptCodeSha256(script) !== codeSha256) {
                throw codedError(
                    ErrorCode.STATE_INVALID,
                    `Analysis baseline persistent script mismatch: ${scriptName}`,
                    { scriptName, codeSha256 }
                );
            }
            plans.push({
                script,
                scriptId: script.id,
                scriptInstanceId: script.scriptInstanceId,
                name: script.name,
                codeSha256,
                priority,
                value
            });
        }
        if (plans.length !== participants.length) {
            throw codedError(
                ErrorCode.STATE_INVALID,
                "Analysis baseline persistent script participant set differs",
                {
                    saved: [...names],
                    current: participants.map((script) => script.name)
                }
            );
        }
        return plans;
    }

    async function validateAnalysisBaselineScriptState(savedEntries) {
        return prepareAnalysisBaselineScriptState(savedEntries);
    }

    async function restoreAnalysisBaselineScriptState(name, savedEntriesOrPlans, restoredScripts = []) {
        const plans = Array.isArray(savedEntriesOrPlans)
            && savedEntriesOrPlans.every((entry) => entry && entry.script)
            ? savedEntriesOrPlans
            : await prepareAnalysisBaselineScriptState(savedEntriesOrPlans);
        for (const plan of plans) {
            if (!isCurrentScript(plan.script)
                || plan.script.scriptInstanceId !== plan.scriptInstanceId
                || !plan.script.running
                || !plan.script.started
                || !plan.script.baselineHookRegistered) {
                throw codedError(
                    ErrorCode.STATE_INVALID,
                    `Analysis baseline persistent script instance changed: ${plan.name || plan.script?.name || "unknown"}`,
                    { scriptName: plan.name || plan.script?.name || "unknown" }
                );
            }
            await invokeBaselineHook(plan.script, "restore", name, plan.value);
            restoredScripts.push(plan.name || plan.script.name);
        }
    }

    function listPScriptMcps(scriptId) {
        const scripts = scriptId === undefined
            ? [...state.scripts.values()]
            : [state.scripts.get(scriptId)].filter(Boolean);
        const mcps = [];
        for (const script of scripts) {
            if (!isCurrentScript(script) || !script.pscriptMcpPublished) continue;
            for (const metadata of script.pscriptMcps.values()) {
                mcps.push({
                    scriptId: script.id,
                    scriptName: script.name,
                    name: metadata.name,
                    description: metadata.description
                });
            }
        }
        return { mcps };
    }

    function callPScriptMcp({ scriptId, name, params, blocking, timeoutMs }) {
        const script = state.scripts.get(scriptId);
        if (!script || !isCurrentScript(script)) {
            throw codedError(
                ErrorCode.SCRIPT_MCP_NOT_FOUND,
                `Persistent script is not running: ${scriptId}`,
                { scriptId, name }
            );
        }
        if (!script.pscriptMcpPublished) {
            throw codedError(
                ErrorCode.BUSY,
                "Persistent script MCP publication is not complete",
                { scriptId, name, published: false }
            );
        }
        if (state.analysisBaselineOperation) {
            throw codedError(ErrorCode.BUSY, "Persistent script baseline operation is in progress", {scriptId, name});
        }
        if (script.inFlightBaselineHookCalls?.size) {
            throw codedError(ErrorCode.BUSY, "Persistent script baseline hook is in progress", {
                scriptId,
                name
            });
        }
        if (!script.pscriptMcps.has(name)) {
            throw codedError(
                ErrorCode.SCRIPT_MCP_NOT_FOUND,
                `Persistent script MCP is not published: ${name}`,
                { scriptId, name }
            );
        }
        pruneExpiredPScriptMcpTombstones(script);
        if (script.inFlightPScriptMcpCalls.size >= ResourceLimits.pendingPersistentMcpCallsPerScript) {
            throw codedError(ErrorCode.BUSY, "Persistent script MCP call limit reached", {
                scriptId,
                maximum: ResourceLimits.pendingPersistentMcpCallsPerScript
            });
        }
        if (blocking && script.eventQueue.length >= ResourceLimits.persistentEventQueue) {
            throw codedError(ErrorCode.BUSY, "Persistent script work queue is full", {
                scriptId,
                maximum: ResourceLimits.persistentEventQueue
            });
        }
        let normalizedParams;
        try {
            normalizedParams = normalizePersistentMcpParams(params);
        } catch (error) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `Persistent script MCP params are invalid: ${String(error?.message || error)}`
            );
        }
        const callId = nextPScriptMcpCallId(script);
        const message = {
            type: "pscriptMcpInvoke",
            scriptInstanceId: script.scriptInstanceId,
            callId,
            name,
            params: normalizedParams,
            blocking
        };
        const promise = new Promise((resolve, reject) => {
            const pending = { resolve, reject, name, blocking, timer: 0 };
            pending.timer = setTimeout(() => {
                if (script.pendingPScriptMcpCalls.get(callId) !== pending) return;
                script.pendingPScriptMcpCalls.delete(callId);
                script.expiredPScriptMcpCalls.set(
                    callId,
                    Date.now() + ResourceLimits.persistentMcpTombstoneMs
                );
                pruneExpiredPScriptMcpTombstones(script);
                reject(codedError(
                    ErrorCode.TIMEOUT,
                    "Persistent script MCP call timed out.",
                    { scriptId, name, timeoutMs }
                ));
            }, timeoutMs);
            script.pendingPScriptMcpCalls.set(callId, pending);
        });
        script.inFlightPScriptMcpCalls.set(callId, { name, blocking });
        if (blocking) {
            script.eventQueue.push(message);
            pumpScriptEvents(script);
        } else {
            try {
                script.worker.postMessage(message);
            } catch (error) {
                const pending = script.pendingPScriptMcpCalls.get(callId);
                if (pending) {
                    clearTimeout(pending.timer);
                    script.pendingPScriptMcpCalls.delete(callId);
                    script.inFlightPScriptMcpCalls.delete(callId);
                    pending.reject(error);
                }
            }
        }
        return promise;
    }

    function publishPScriptMcps(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId || script.pscriptMcpPublished) {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent an invalid MCP publication"
            );
        }
        const metadata = normalizePersistentMcpMetadata(message.mcps);
        const next = new Map();
        for (const item of metadata) next.set(item.name, item);
        script.pscriptMcps = next;
        script.pscriptMcpPublished = true;
        renderScripts();
    }

    function finishPScriptMcpCall(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId) return;
        const callId = Number(message.callId);
        if (!Number.isSafeInteger(callId) || callId < 1 || typeof message.ok !== "boolean") {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent a malformed MCP result"
            );
        }
        const active = script.inFlightPScriptMcpCalls.get(callId);
        if (!active) {
            scriptConsoleLine(script, [`ignored unknown MCP result: ${callId}`]);
            return;
        }
        const payload = message.ok
            ? normalizePersistentMcpResult(message.value)
            : normalizePersistentMcpResult(message.error);
        script.inFlightPScriptMcpCalls.delete(callId);
        if (active.blocking) {
            script.eventBusy = false;
            pumpScriptEvents(script);
        }
        if (script.expiredPScriptMcpCalls.delete(callId)) return;
        const pending = script.pendingPScriptMcpCalls.get(callId);
        if (!pending) {
            scriptConsoleLine(script, [`ignored expired MCP result: ${callId}`]);
            return;
        }
        clearTimeout(pending.timer);
        script.pendingPScriptMcpCalls.delete(callId);
        if (message.ok) {
            pending.resolve({
                scriptId: script.id,
                scriptName: script.name,
                name: active.name,
                blocking: active.blocking,
                value: payload
            });
            return;
        }
        const code = readOwnDataProperty(payload, "code");
        const errorMessage = readOwnDataProperty(payload, "message");
        const details = readOwnDataProperty(payload, "details");
        const workerDetails = details && typeof details === "object" ? details : {};
        pending.reject(codedError(
            typeof code === "string" ? code : ErrorCode.SCRIPT_RUNTIME_ERROR,
            typeof errorMessage === "string" ? errorMessage : "Persistent script MCP handler failed",
            {
                scriptId: script.id,
                scriptName: script.name,
                name: active.name,
                ...workerDetails,
                ...(details === undefined ? {} : { worker: details })
            }
        ));
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
        for (const ownerId of [...script.ownedBreakpointIds]) {
            try {
                if (breakpointOwners.findBreakpointById(ownerId)) {
                    await commands.removeBreakpoint({ id: ownerId });
                }
            } catch (error) {
                breakpointOwners.discardOwner(ownerId);
                failures.push({ ownerId, message: String(error?.message || error).slice(0, 300) });
            }
        }
        script.ownedBreakpointIds.clear();
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
            if (command === "setBreakpoint" || command === "setSpecialBreakpoint") {
                const result = await commands[command](withInternalMetadata(params, {
                    origin: "script",
                    scriptId: script.id
                }));
                if (params.enabled !== false && Number.isSafeInteger(Number(result?.id))) {
                    script.ownedBreakpointIds.add(Number(result.id));
                }
                return result;
            }
            if (command === "removeBreakpoint") {
                const result = await runCommand(command, params);
                if (result?.ok !== false) script.ownedBreakpointIds.delete(Number(params.id));
                return result;
            }
            const result = command === "pause" && eventId
                ? await commands.pause(withInternalMetadata(params, {
                    scriptCallback: true,
                    scriptId: script.id,
                    scriptEventId: eventId
                }))
                : await runCommand(command, eventIdentity.internalMetadata
                    ? withInternalMetadata(params, eventIdentity.internalMetadata)
                    : params);
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
            started: false,
            output: [],
            triggers: [],
            ownedBreakpointIds: new Set(),
            eventQueue: [],
            eventBusy: false,
            droppedEvents: 0,
            scriptInstanceId: `${Date.now().toString(36)}-${scriptInstanceSerial++}`,
            pscriptMcps: new Map(),
            pendingPScriptMcpCalls: new Map(),
            expiredPScriptMcpCalls: new Map(),
            inFlightPScriptMcpCalls: new Map(),
            nextPScriptMcpCallId: 1,
            pscriptMcpPublished: false,
            baselineHookRegistered: false,
            baselinePriority: 0,
            pendingBaselineHookCalls: new Map(),
            inFlightBaselineHookCalls: new Map(),
            pendingBaselineBarrierAcks: new Map(),
            nextBaselineHookCallId: 1,
            codeSha256: "",
            createdAt: Date.now(),
            lastError: null
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
            if (state.scripts.get(script.id) !== script) return;
            try {
                if (msg.type === "ready" && !ready
                    && msg.hardened === true && msg.layer === "supervisor") {
                    ready = true;
                    worker.postMessage({
                        type: "start",
                        code,
                        asyncMode,
                        scriptInstanceId: script.scriptInstanceId,
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
                    const request = validateWorkerRpc(msg, seenRequestIds);
                    try {
                        const result = await queuePersistentScriptOperation(
                            script,
                            request.command,
                            request.params,
                            msg
                        );
                        worker.postMessage({ replyId: msg.id, result });
                        } catch (error) {
                            const rpcError = workerRpcError(error);
                            if (msg.callSiteStack) {
                                rpcError.details = {
                                    ...(rpcError.details || {}),
                                    callSiteStack: String(msg.callSiteStack).slice(0, 8192)
                                };
                            }
                            worker.postMessage({
                                replyId: msg.id,
                                error: rpcError
                            });
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
                        worker.postMessage({ replyId: msg.id, error: workerRpcError(error) });
                    } finally {
                        seenRequestIds.delete(msg.id);
                    }
                } else if (msg.type === "pscriptMcpPublished") {
                    if (!ready || !compiled || !script.running) {
                        throw new Error("Persistent script published MCP metadata before startup");
                    }
                    publishPScriptMcps(script, msg);
                } else if (msg.type === "pscriptMcpResult") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script returned an MCP result before startup");
                    }
                    finishPScriptMcpCall(script, msg);
                } else if (msg.type === "baselineHookRegistered") {
                    if (!ready || !compiled || !script.running
                        || msg.scriptInstanceId !== script.scriptInstanceId
                        || script.baselineHookRegistered) {
                        throw new Error("Persistent script sent an invalid baseline hook registration");
                    }
                    script.baselineHookRegistered = true;
                    script.baselinePriority = Number.isSafeInteger(Number(msg.priority))
                        ? Number(msg.priority) : 0;
                    renderScripts();
                } else if (msg.type === "baselineHookStarted") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script started a baseline hook before startup");
                    }
                    startBaselineHookCall(script, msg);
                } else if (msg.type === "baselineHookResult") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script returned a baseline hook result before startup");
                    }
                    finishBaselineHookCall(script, msg);
                } else if (msg.type === "baselineBarrierAck") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script acknowledged a baseline barrier before startup");
                    }
                    finishBaselineBarrierAck(script, msg);
                } else if (msg.type === "callbackError") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script returned a callback error before startup");
                    }
                    const details = scriptFailureDetails({
                        phase: "callback",
                        error: msg.error
                    }, code);
                    script.lastError = details;
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
                    script.started = true;
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
        rejectPendingPScriptMcpCalls(script);
        rejectPendingBaselineHookCalls(script);
        script.eventQueue.length = 0;
        script.eventBusy = false;
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
        return {
            id: script.id,
            name: script.name,
            running: script.running,
            started: script.started,
            asyncMode: script.asyncMode,
            triggers: script.triggers.map(({ id, type, address, cpu }) => ({
                id,
                type,
                address: hex(address),
                cpu
            })),
            mcpCount: script.pscriptMcps.size,
            mcpPublished: script.pscriptMcpPublished,
            baselineHookRegistered: script.baselineHookRegistered,
            baselinePriority: Number(script.baselinePriority || 0),
            lastError: script.lastError ? {
                phase: script.lastError.phase || null,
                errorName: script.lastError.errorName || null,
                line: script.lastError.line ?? null,
                column: script.lastError.column ?? null,
                sourceName: script.lastError.sourceName || null,
                sourceExcerpt: script.lastError.sourceExcerpt || null
            } : null,
            duplicate
        };
    }

    return {
        scriptConsoleLine,
        renderScriptConsole,
        renderScripts,
        selectScript,
        dispatchScriptEvent,
        startPersistentScript,
        stopPersistentScript,
        scriptSummary,
        listPScriptMcps,
        callPScriptMcp,
        finishPScriptMcpCall,
        captureAnalysisBaselineScriptState,
        validateAnalysisBaselineScriptState,
        restoreAnalysisBaselineScriptState,
        acquireBaselineBarriers,
        releaseBaselineBarriers,
        finishBaselineHookCall
    };
}
