import { ErrorCode } from "./error-codes.js";
import { ExternalAlgorithms } from "./external-algorithms.js";
import { subscribeAbort } from "./validation.js";

function bytesToHex(bytes) {
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createAlgorithmLoader({ responder, downloadTimeoutMs = 5000 }) {
    const cache = new Map();

    async function load(algorithm, signal) {
        if (signal?.aborted) {
            return responder.fail(ErrorCode.CANCELLED, "Algorithm loading was cancelled");
        }
        const metadata = ExternalAlgorithms[algorithm];
        if (!metadata) {
            return responder.fail(ErrorCode.ALGORITHM_UNAVAILABLE, `Algorithm is unavailable: ${algorithm}`);
        }
        const cacheKey = `${metadata.version}:${metadata.sha256}`;
        if (cache.has(cacheKey)) return { ok: true, metadata, source: cache.get(cacheKey) };
        const url = new URL(metadata.url);
        if (url.protocol !== "https:" || url.hostname !== "cdn.jsdelivr.net") {
            return responder.fail(ErrorCode.ALGORITHM_UNAVAILABLE, `${algorithm} has an invalid source URL`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("download-timeout"), downloadTimeoutMs);
        const abort = () => controller.abort(signal?.reason || "cancelled");
        const unsubscribeAbort = subscribeAbort(signal, abort);
        try {
            const response = await fetch(metadata.url, {
                cache: "force-cache",
                credentials: "omit",
                referrerPolicy: "no-referrer",
                signal: controller.signal
            });
            if (!response.ok) {
                return responder.fail(ErrorCode.ALGORITHM_UNAVAILABLE, `${algorithm} could not be downloaded`, {
                    algorithm,
                    version: metadata.version,
                    status: response.status
                });
            }
            const bytes = await response.arrayBuffer();
            const actualHash = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
            if (actualHash !== metadata.sha256) {
                return responder.fail(ErrorCode.ALGORITHM_INTEGRITY_FAILED, `${algorithm} integrity check failed`, {
                    algorithm,
                    version: metadata.version
                });
            }
            const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            cache.set(cacheKey, source);
            return { ok: true, metadata, source };
        } catch (error) {
            if (signal?.aborted) {
                return responder.fail(ErrorCode.CANCELLED, "Algorithm loading was cancelled", {
                    reason: signal.reason
                });
            }
            return responder.fail(ErrorCode.ALGORITHM_UNAVAILABLE, `${algorithm} is unavailable`, {
                algorithm,
                version: metadata.version,
                reason: controller.signal.reason || String(error?.message || error)
            });
        } finally {
            clearTimeout(timeout);
            unsubscribeAbort();
        }
    }

    return { load };
}
