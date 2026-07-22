const MAX_DEPENDENCY_SOURCE_BYTES = 2 * 1024 * 1024;

function hexDigest(bytes) {
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function initializeLockedDependency({
    dependency,
    nativeEval,
    nativeDigest,
    NativeTextEncoder
}) {
    if (!dependency || typeof dependency.source !== "string"
        || !/^[a-f0-9]{64}$/.test(String(dependency.sha256))) {
        throw new TypeError("dependency source and SHA-256 are required");
    }
    const bytes = new NativeTextEncoder().encode(dependency.source);
    if (bytes.byteLength > MAX_DEPENDENCY_SOURCE_BYTES) {
        throw new RangeError("dependency source exceeds the bootstrap budget");
    }
    const actual = hexDigest(await nativeDigest("SHA-256", bytes));
    if (actual !== dependency.sha256) throw new Error("dependency source hash mismatch");
    const exports = nativeEval(dependency.source);
    if (!exports || typeof exports !== "object") throw new Error("dependency did not initialize exports");
    return Object.freeze(exports);
}

export function assertLockedGlobals() {
    for (const name of [
        "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts",
        "postMessage", "addEventListener", "removeEventListener", "indexedDB", "caches", "localStorage",
        "sessionStorage", "close", "navigator", "crypto", "eval", "Function"
    ]) {
        if (globalThis[name] !== undefined) throw new Error(`lockdown invariant failed: ${name}`);
    }
}
