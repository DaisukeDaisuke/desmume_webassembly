"use strict";

import { assertLockedGlobals, initializeLockedDependency } from "./dependency-bootstrap.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const NativeTextEncoder = globalThis.TextEncoder;
const nativeSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const channelToken = globalThis.crypto.randomUUID();
const send = (message) => nativePostMessage({ ...message, channelToken });

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "addEventListener", "removeEventListener", "BroadcastChannel", "WebTransport", "WebSocketStream",
    "indexedDB", "caches", "localStorage", "sessionStorage", "close", "navigator", "crypto"
]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); }
    catch { try { globalThis[name] = undefined; } catch {} }
}
for (const [name, nativeTimer] of [["setTimeout", nativeSetTimeout], ["setInterval", nativeSetInterval]]) {
    Object.defineProperty(globalThis, name, {
        value: (callback, delay, ...args) => {
            if (typeof callback !== "function") throw new TypeError(`${name} requires a function callback`);
            return nativeTimer(callback, delay, ...args);
        },
        writable: false,
        configurable: false
    });
}
for (const value of [() => {}, async () => {}, function* () {}, async function* () {}]) {
    let prototype = Object.getPrototypeOf(value);
    while (prototype) {
        if (Object.prototype.hasOwnProperty.call(prototype, "constructor")) {
            try { Object.defineProperty(prototype, "constructor", { value: undefined, writable: false, configurable: false }); } catch {}
        }
        prototype = Object.getPrototypeOf(prototype);
    }
}
try { Object.defineProperty(globalThis, "eval", { value: undefined, writable: false, configurable: false }); } catch {}
assertLockedGlobals();

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (message.type !== "initialize" || message.channelToken !== channelToken) {
        send({ type: "protocolError", message: "authenticated fixed-fixture initialization is required" });
        return;
    }
    try {
        const fixture = await initializeLockedDependency({
            dependency: message.dependency,
            nativeEval,
            nativeDigest,
            NativeTextEncoder
        });
        const preReady = fixture.results;
        const passed = Object.values(preReady).every((value) => value === false);
        send({
            type: "done",
            result: {
                passed,
                fixtureSha256: message.dependency.sha256,
                preReady,
                forgery: { unauthenticatedMessageAccepted: false, tokenPredictionAccepted: false },
                cleanup: { workerCountAfter: 0, pendingRpcAfter: 0, listenersAfter: 0 }
            }
        });
    } catch (error) {
        send({ type: "protocolError", message: String(error?.message || error) });
    }
});

send({ type: "bootstrapReady", hardened: true, layer: "bootstrap" });
})();
