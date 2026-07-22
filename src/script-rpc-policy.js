import { ErrorCode } from "./error-codes.js";
import { codedError, isPlainObject } from "./validation.js";
import { normalizeWorkerRpcParams } from "./worker-rpc-value.js";

const COMMON_COMMANDS = [
    "status", "snapshotContext", "pause", "resume", "continue", "step", "smartStep",
    "stepOver", "stepNextBranchOrReturn", "trueNextBranch", "runUntilReturn",
    "runUntilNextCall", "stepFrames", "getRegisters", "setRegister", "memoryGetRegister",
    "memorySetRegister", "dumpMemory", "writeMemory", "injectBytes", "searchMemory",
    "resetMemorySearch", "setMemoryFreeze", "listMemoryFreezes", "memoryReadByte",
    "memoryReadWord", "memoryReadDword", "memoryWriteByte", "memoryWriteWord",
    "memoryWriteDword", "disassemble", "disassembleBytes", "stackTrace", "callStack",
    "listOtherCoroutines", "getOtherCoroutines", "setBreakpoint", "removeBreakpoint",
    "clearBreakStatus", "setSpecialBreakpoint", "setStackTraceMode",
    "setStackTracePrivilegeCheck", "setInput", "runInputHold", "runInputTap", "runTouchHold",
    "runInputSequence", "captureFrame", "compareFrame", "waitForBreak", "runUntil",
    "waitForScreenChange", "saveState", "loadState", "saveSaveSlot", "loadSaveSlot",
    "reloadRecentFile", "listRecentFiles", "binaryFloat", "setCTableSeed", "wait", "waitMs"
];

export const EVAL_RPC_ALLOWLIST = new Set(COMMON_COMMANDS);
export const PERSISTENT_RPC_ALLOWLIST = new Set(COMMON_COMMANDS);

const RESERVED_FIELDS = new Set([
    "_operation", "_origin", "_scriptId", "_triggerId", "_operationId",
    "_scriptCallback", "_scriptEventId", "_analysisBaselineSlotToken"
]);

export function validateWorkerRpc(message, allowlist, seenIds) {
    if (!isPlainObject(message)
        || typeof message.id !== "string"
        || !message.id
        || typeof message.command !== "string"
        || !allowlist.has(message.command)
        || !isPlainObject(message.params ?? {})) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, "Worker sent an invalid RPC request");
    }
    if (seenIds.has(message.id)) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, "Worker reused an RPC request ID");
    }
    let params;
    try {
        params = normalizeWorkerRpcParams(message.command, message.params ?? {});
    } catch (error) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, String(error?.message || error));
    }
    const reserved = Object.keys(params).find((key) => RESERVED_FIELDS.has(key));
    if (reserved) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, `Worker RPC used reserved parameter: ${reserved}`);
    }
    seenIds.add(message.id);
    if (seenIds.size > 4096) seenIds.delete(seenIds.values().next().value);
    return { command: message.command, params };
}
