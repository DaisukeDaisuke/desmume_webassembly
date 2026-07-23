import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

export function createFileTransactionService({
    state,
    cancelPendingScriptEvents = async () => {}
}) {
    function begin(reason = "file transaction") {
        if (state.fileTransactionActive) {
            throw codedError(ErrorCode.BUSY, `Active file transaction is ${state.fileTransactionReason || "in progress"}`, {
                activeReason: state.fileTransactionReason || null
            });
        }
        const token = Symbol(reason);
        state.fileTransactionActive = true;
        state.fileTransactionOwner = token;
        state.fileTransactionReason = String(reason);
        state.fileTransactionSerial++;
        state.nativeBreakSerial = Number(state.nativeBreakSerial || 0) + 1;
        state.currentBreakIdentity = null;
        state.lastBreakKey = "";
        state.breakRefreshKey = "";
        return token;
    }

    function end(token) {
        if (state.fileTransactionOwner !== token) return false;
        state.fileTransactionActive = false;
        state.fileTransactionOwner = null;
        state.fileTransactionReason = "";
        return true;
    }

    async function run(reason, task) {
        const token = begin(reason);
        try {
            await cancelPendingScriptEvents(`${reason} started`);
            return await task({ token });
        } finally {
            end(token);
        }
    }

    return Object.freeze({ begin, end, run });
}
