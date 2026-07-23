import { ErrorCode } from "./error-codes.js";

export function createOperationManager({ responder, pause = async () => {}, releaseInput = async () => {} }) {
    let active = null;
    let serial = 0;

    function cancel(reason = "user-cancel") {
        if (!active) return false;
        active.controller.abort(reason);
        return true;
    }

    async function cancelAndWait(reason = "user-cancel") {
        const operation = active;
        if (!operation) return false;
        operation.controller.abort(reason);
        try {
            await operation.done;
        } catch {
            // The caller only needs the operation to be fully quiesced.
        }
        return true;
    }

    async function run({
        name,
        timeoutMs,
        task,
        cleanup = async () => {},
        timeoutDetails = () => ({}),
        cancelDetails = () => ({})
    }) {
        if (active) return responder.fail(ErrorCode.BUSY, `Active operation is ${active.name}`);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "timeoutMs must be between 1 and 600000");
        }
        const controller = new AbortController();
        const operation = {
            id: ++serial,
            name,
            controller,
            signal: controller.signal,
            startedAt: performance.now()
        };
        active = operation;
        let timer = 0;
        let cleaned = false;
        const cleanupOnce = async () => {
            if (cleaned) return;
            cleaned = true;
            let cleanupError;
            try {
                await releaseInput();
            } catch (error) {
                cleanupError = error;
            }
            try {
                await cleanup(operation);
            } catch (error) {
                cleanupError ||= error;
            } finally {
                clearTimeout(timer);
                if (active === operation) active = null;
            }
            if (cleanupError) throw cleanupError;
        };
        const timeoutResult = () => responder.fail(
            ErrorCode.TIMEOUT,
            `${name} timed out`,
            { timeoutMs, ...timeoutDetails(operation) }
        );
        const cancelledResult = () => responder.fail(
            ErrorCode.CANCELLED,
            `${name} was cancelled`,
            { reason: operation.signal.reason, ...cancelDetails(operation) }
        );
        const runBody = async () => {
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => {
                    controller.abort("timeout");
                    resolve({ timedOut: true });
                }, timeoutMs);
            });
            const running = Promise.resolve(task(operation)).then((value) => ({
                value
            }), (error) => {
                if (!operation.signal.aborted) throw error;
                return { value: operation.signal.reason === "timeout" ? timeoutResult() : cancelledResult() };
            });
            const result = await Promise.race([running, timeout]);
            if (result?.timedOut) {
                await pause();
                await running.catch(() => {});
                return timeoutResult();
            }
            if (operation.signal.aborted) {
                await pause();
                return operation.signal.reason === "timeout" ? timeoutResult() : cancelledResult();
            }
            return result.value;
        };
        operation.done = runBody().finally(cleanupOnce);
        return operation.done;
    }

    return {
        run,
        cancel,
        cancelAndWait,
        current: () => active && ({ id: active.id, name: active.name, startedAt: active.startedAt })
    };
}
