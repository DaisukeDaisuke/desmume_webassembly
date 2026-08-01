import { ErrorCode } from "./error-codes.js";
import { isPlainObject } from "./validation.js";

const UI_REFRESH_COMMANDS = new Set([
    "pause", "resume", "step", "smartStep", "stepOver", "stepNextBranchOrReturn",
    "nextBranchOrReturn", "trueNextBranch", "nextTrueBranch", "runUntilReturn", "returnToPop",
    "runUntilNextCall", "nextFunctionEnter", "nextCall", "nextFunctionCall", "stepFrames",
    "setRegister", "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze",
    "setBreakpoint", "removeBreakpoint", "setSpecialBreakpoint", "setStackTraceMode",
    "setStackTracePrivilegeCheck", "loadRomUrl", "loadState", "reloadRecentFile", "setInput",
    "runInputHold", "runInputTap"
]);

const ACTIVITY_COMMANDS = new Set([
    "loadRomFile", "loadRomBytes", "loadRomUrl", "importSaveFile", "loadSaveSlot", "saveState",
    "loadState", "importStateFile", "loadStateBytes", "loadStateUrl", "reloadRecentFile", "pause",
    "resume", "continue", "reset", "reloadRom", "step", "smartStep", "stepOver",
    "stepNextBranchOrReturn", "nextBranchOrReturn", "trueNextBranch", "nextTrueBranch",
    "runUntilReturn", "returnToPop", "runUntilNextCall", "nextFunctionEnter", "nextCall",
    "nextFunctionCall", "stepFrames", "setInput", "runInputHold", "runInputTap", "runTouchHold",
    "setRegister", "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze",
    "setCTableSeed", "memorySetRegister", "memoryWriteByte", "memoryWriteWord", "memoryWriteDword",
    "saveAnalysisBaseline", "restoreAnalysisBaseline"
]);

const CANCELLING_COMMANDS = new Set([
    "pause", "reset", "reloadRom", "loadRomFile", "loadRomBytes", "loadRomUrl", "importSaveFile",
    "loadSaveSlot", "loadState", "importStateFile", "loadStateBytes", "loadStateUrl",
    "reloadRecentFile"
]);

const FILE_TRANSACTION_ALLOWED_COMMANDS = new Set([
    "pause", "status", "listRecentFiles", "listBreakpoints", "listMemoryFreezes",
    "listScripts", "listPScriptMcp", "getScript", "listScriptPrint", "getOperation", "cancelOperation",
    "getInputState", "releaseInput", "listStateSlots", "listSaveSlots",
    "listAnalysisBaselines", "listInputRecordings", "waitForStateLoad",
    "waitForFileTransaction", "snapshotContext", "getRegisters", "dumpMemory", "searchMemory",
    "resetMemorySearch", "disassemble", "disassembleBytes", "stackTrace", "callStack",
    "copyCallStackMarkdown", "copyCallStackCsv", "listOtherCoroutines", "getOtherCoroutines",
    "memoryGetRegister", "memoryReadByte", "memoryReadWord", "memoryReadDword"
]);

const BASELINE_HOOK_READ_ONLY_COMMANDS = new Set([
    "status", "snapshotContext", "getRegisters", "dumpMemory", "searchMemory", "resetMemorySearch",
    "disassemble", "disassembleBytes", "stackTrace", "callStack", "copyCallStackMarkdown",
    "copyCallStackCsv", "listOtherCoroutines", "getOtherCoroutines", "memoryGetRegister",
    "memoryReadByte", "memoryReadWord", "memoryReadDword", "listRecentFiles", "listBreakpoints",
    "listMemoryFreezes", "listScripts", "listPScriptMcp", "getScript", "listScriptPrint",
    "getOperation", "getInputState", "listStateSlots", "listSaveSlots", "listAnalysisBaselines",
    "listInputRecordings", "waitForStateLoad", "waitForFileTransaction"
]);

const BASELINE_DEFERRED_EFFECT_COMMANDS = new Set([
    "setSpeed", "setRenderEnabled", "setAudio", "setScale", "setRotation"
]);

const RECORDABLE_INPUT_COMMANDS = new Set([
    "setInput", "runInputHold", "runInputTap", "runTouchHold"
]);

const RESERVED_PARAM_FIELDS = Object.freeze([
    "_operation",
    "_origin",
    "_scriptId",
    "_triggerId",
    "_operationId",
    "_scriptCallback",
    "_scriptEventId",
    "_analysisBaselineSlotToken"
]);

export function createCommandDispatcher({
    state,
    registry,
    responder,
    operationManager,
    hasLoadedRom,
    emulatorActivity,
    refreshDebuggerViews,
    updateStatus,
    log
}) {
    let refreshTimer = 0;

    function queueUiRefresh(name) {
        if (!UI_REFRESH_COMMANDS.has(name)
            || !state.ready
            || !hasLoadedRom()
            || state.loadingFile) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = 0;
            refreshDebuggerViews({ keepHighlight: true }).catch((error) => {
                log(error.message || String(error));
            });
        }, 0);
    }

    async function run(name, params = {}) {
        if (params === undefined) params = {};
        if (!isPlainObject(params)) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "Command params must be a plain object");
        }
        const reservedField = RESERVED_PARAM_FIELDS.find((field) => (
            Object.prototype.hasOwnProperty.call(params, field)
        ));
        if (reservedField) {
            return responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                `Reserved parameter is not allowed: ${reservedField}`
            );
        }
        const active = operationManager.current();
        if (active
            && ACTIVITY_COMMANDS.has(name)
            && !CANCELLING_COMMANDS.has(name)
            && !(active.name === "recordInput" && RECORDABLE_INPUT_COMMANDS.has(name))
        ) {
            return responder.fail(ErrorCode.BUSY, `Active operation is ${active.name}`);
        }
        const baselineOperation = state.analysisBaselineOperation;
        if (baselineOperation && (name === "saveAnalysisBaseline" || name === "restoreAnalysisBaseline")) {
            return responder.fail(ErrorCode.BUSY, "Analysis baseline operation is already in progress", {
                operationId: baselineOperation.operationId,
                name: baselineOperation.name,
                phase: baselineOperation.phase,
                operation: baselineOperation.operation
            });
        }
        if (baselineOperation
            && ["save-hooks", "restore-hooks"].includes(baselineOperation.phase)
            && !BASELINE_HOOK_READ_ONLY_COMMANDS.has(name)
            && !(BASELINE_DEFERRED_EFFECT_COMMANDS.has(name)
                && baselineOperation.phase === "restore-hooks")) {
            return responder.fail(ErrorCode.COMMAND_NOT_ALLOWED, `${name} is unavailable during baseline hook`);
        }
        if (state.fileTransactionActive && !FILE_TRANSACTION_ALLOWED_COMMANDS.has(name)) {
            if (BASELINE_DEFERRED_EFFECT_COMMANDS.has(name)
                && baselineOperation?.phase === "restore-hooks") {
                if (!Array.isArray(baselineOperation.deferredEffects)) {
                    baselineOperation.deferredEffects = [];
                }
                if (baselineOperation.deferredEffects.length >= 16) {
                    return responder.fail(ErrorCode.RESOURCE_LIMIT, "Too many deferred baseline effects");
                }
                baselineOperation.deferredEffects.push({ command: name, params: { ...params } });
                return { ok: true, deferred: true, command: name };
            }
            return responder.fail(
                ErrorCode.BUSY,
                `Active file transaction is ${state.fileTransactionReason || "in progress"}`
            );
        }
        const result = await registry.execute(name, params);
        if (ACTIVITY_COMMANDS.has(name) && result && typeof result === "object") {
            Object.assign(result, emulatorActivity());
        }
        updateStatus();
        queueUiRefresh(name);
        return result;
    }

    return Object.freeze({ queueUiRefresh, run });
}
