import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";

export function createScriptRunner({ source, responder, callCommand, getShortcuts = () => [] }) {
    async function run(code, timeoutMs = 3000) {
        if (typeof code !== "string" || !code.trim() || code.length > 262144) {
            return responder.fail(
                ErrorCode.SCRIPT_SOURCE_INVALID,
                "Script source must be a non-empty string up to 262144 characters"
            );
        }
        const timeout = Number(timeoutMs);
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "timeoutMs must be between 1 and 600000");
        }
        let host;
        try {
            host = createEmbeddedWorker(source);
        } catch (error) {
            return responder.fail(ErrorCode.WORKER_START_FAILED, "Script Worker could not be started", {
                errorName: String(error?.name || "Error"),
                message: String(error?.message || error)
            });
        }
        const { worker } = host;
        return new Promise((resolve) => {
            let finished = false;
            const finish = (result) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                host.dispose();
                resolve(result);
            };
            const timer = setTimeout(() => finish(responder.fail(
                ErrorCode.TIMEOUT,
                "Script execution timed out",
                { timeoutMs: timeout }
            )), timeout);
            worker.onmessage = async (event) => {
                const message = event.data || {};
                if (message.type === "call") {
                    if (typeof message.id !== "string" || typeof message.command !== "string") {
                        finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Script Worker sent a malformed RPC request"));
                        return;
                    }
                    const result = await callCommand(message.command, message.params || {});
                    if (!finished) worker.postMessage({ replyId: message.id, result });
                    return;
                }
                if (message.type === "done") {
                    finish(responder.ok({ value: message.result }));
                    return;
                }
                if (message.type === "error") {
                    const phase = message.error?.details?.phase;
                    const codeName = phase === "compile" ? ErrorCode.SCRIPT_COMPILE_ERROR : ErrorCode.SCRIPT_RUNTIME_ERROR;
                    finish(responder.fail(codeName, message.error?.message || "Script execution failed", message.error?.details));
                    return;
                }
                if (message.type === "protocolError") {
                    finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, message.message || "Script Worker protocol error"));
                    return;
                }
                finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Script Worker sent an unknown message"));
            };
            worker.onerror = (event) => finish(responder.fail(ErrorCode.WORKER_CRASHED, "Script Worker crashed", {
                message: String(event.message || "Worker error")
            }));
            worker.onmessageerror = () => finish(responder.fail(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Script Worker returned an unreadable message"
            ));
            worker.postMessage({ type: "run", code, shortcuts: getShortcuts() });
        });
    }

    return { run };
}
