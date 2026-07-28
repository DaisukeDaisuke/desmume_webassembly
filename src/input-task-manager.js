import { ErrorCode } from "./error-codes.js";
import { codedError, subscribeAbort } from "./validation.js";

export function createInputTaskManager() {
    const active = new Set();
    let blocked = false;

    async function run(name, task, parentSignal = null) {
        if (blocked) {
            throw codedError(
                ErrorCode.INPUT_UNAVAILABLE,
                `${name} cannot start during a file transaction`
            );
        }
        const controller = new AbortController();
        const entry = { name, controller, done: null };
        const unsubscribeParent = subscribeAbort(parentSignal, () => {
            controller.abort(parentSignal.reason || "parent-operation");
        });
        active.add(entry);
        try {
            entry.done = Promise.resolve().then(() => task(controller.signal));
            return await entry.done;
        } catch (error) {
            if (controller.signal.aborted) {
                throw codedError(ErrorCode.CANCELLED, `${name} was cancelled`, {
                    reason: controller.signal.reason
                });
            }
            throw error;
        } finally {
            unsubscribeParent();
            active.delete(entry);
        }
    }

    async function blockAndCancel(reason = "file-transaction") {
        blocked = true;
        const pending = [...active];
        for (const entry of pending) entry.controller.abort(reason);
        await Promise.allSettled(pending.map((entry) => entry.done));
    }

    function unblock() {
        blocked = false;
    }

    return Object.freeze({
        run,
        blockAndCancel,
        unblock,
        current: () => [...active].map((entry) => entry.name)
    });
}
