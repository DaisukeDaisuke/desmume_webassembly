import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import workerSource from "./workers/security-boundary.worker.js";
import dependency from "./dependencies/adversarial.dependency-source.js";
import { normalizeBoundedValue } from "./bounded-value.js";

export function createSandboxBoundarySelfTest({ createWorker = createEmbeddedWorker, timeoutMs = 5000 } = {}) {
    let active = null;
    let cooldownUntil = 0;

    function run() {
        if (active) return active;
        if (Date.now() < cooldownUntil) {
            const error = new Error("Sandbox boundary self-test is cooling down");
            error.mcpCode = ErrorCode.BUSY;
            throw error;
        }
        cooldownUntil = Date.now() + 1000;
        active = new Promise((resolve, reject) => {
            const host = createWorker(workerSource);
            let channelToken = "";
            const finish = (callback, value) => {
                clearTimeout(timer);
                host.dispose();
                callback(value);
            };
            const timer = setTimeout(() => finish(reject, Object.assign(new Error("Sandbox boundary self-test timed out"), {
                mcpCode: ErrorCode.TIMEOUT
            })), timeoutMs);
            host.worker.onmessage = (event) => {
                const message = event.data || {};
                if (message.type === "bootstrapReady" && !channelToken
                    && message.hardened === true && message.layer === "bootstrap"
                    && typeof message.channelToken === "string") {
                    channelToken = message.channelToken;
                    host.worker.postMessage({ type: "initialize", channelToken, dependency });
                    return;
                }
                if (message.channelToken !== channelToken) {
                    finish(reject, Object.assign(new Error("Sandbox boundary self-test token mismatch"), { mcpCode: ErrorCode.WORKER_PROTOCOL_ERROR }));
                    return;
                }
                if (message.type === "done") {
                    try { finish(resolve, normalizeBoundedValue(message.result, { maxBytes: 64 * 1024 }).value); }
                    catch (error) { finish(reject, error); }
                    return;
                }
                finish(reject, Object.assign(new Error(message.message || "Sandbox boundary self-test protocol failure"), {
                    mcpCode: ErrorCode.WORKER_PROTOCOL_ERROR
                }));
            };
            host.worker.onerror = (event) => finish(reject, Object.assign(new Error(String(event.message || "Sandbox boundary Worker crashed")), {
                mcpCode: ErrorCode.WORKER_CRASHED
            }));
            host.worker.onmessageerror = () => finish(reject, Object.assign(new Error("Sandbox boundary Worker returned unreadable data"), {
                mcpCode: ErrorCode.WORKER_PROTOCOL_ERROR
            }));
        }).finally(() => { active = null; });
        return active;
    }

    return Object.freeze({ run });
}
