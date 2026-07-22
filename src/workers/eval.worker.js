"use strict";

import { assertLockedGlobals, initializeLockedDependency, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";
import { normalizeBoundedValue } from "../bounded-value.js";
import { normalizeWorkerRpcParams } from "../worker-rpc-value.js";

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

const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = undefined;
const Function = undefined;
const replies = new Map();
let parse = null;

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror", "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches",
    "localStorage", "sessionStorage", "close",
    "navigator", "crypto", "EventTarget", "WorkerGlobalScope", "DedicatedWorkerGlobalScope"
]) {
    try {
        Object.defineProperty(globalThis, name, {
            value: undefined,
            writable: false,
            configurable: false
        });
    } catch {
        try { globalThis[name] = undefined; } catch {}
    }
}

function installSafeTimer(name, nativeTimer) {
    if (!nativeTimer) return;
    Object.defineProperty(globalThis, name, {
        value: (callback, delay, ...args) => {
            if (typeof callback !== "function") {
                throw new TypeError(`${name} requires a function callback`);
            }
            return nativeTimer(callback, delay, ...args);
        },
        writable: false,
        configurable: false
    });
}

installSafeTimer("setTimeout", nativeSetTimeout);
installSafeTimer("setInterval", nativeSetInterval);

function lockDownRuntimeCodeGeneration() {
    const prototypes = new Set();
    const collectPrototypeChain = (value) => {
        let current = value;
        while (current && !prototypes.has(current)) {
            prototypes.add(current);
            current = Object.getPrototypeOf(current);
        }
    };
    collectPrototypeChain(globalThis);
    collectPrototypeChain(() => {});
    collectPrototypeChain(async () => {});
    collectPrototypeChain(function* () {});
    collectPrototypeChain(async function* () {});
    for (const prototype of prototypes) {
        if (!Object.prototype.hasOwnProperty.call(prototype, "constructor")) continue;
        try {
            Object.defineProperty(prototype, "constructor", {
                value: undefined,
                writable: false,
                configurable: false
            });
        } catch {
            try { prototype.constructor = undefined; } catch {}
        }
    }
    try {
        Object.defineProperty(globalThis, "eval", {
            value: undefined,
            writable: false,
            configurable: false
        });
    } catch {
        try { globalThis.eval = undefined; } catch {}
    }
}

function call(command, params = {}) {
    const normalizedParams = normalizeWorkerRpcParams(command, params);
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        replies.set(id, { resolve, reject });
        send({ type: "call", id, command, params: normalizedParams });
    });
}

const mcp = { call };
const webmcp = mcp;

function installShortcuts(definitions) {
    for (const [name, command, parameterNames, defaults = {}] of definitions || []) {
        globalThis[name] = (...args) => {
            const params = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
                ? { ...defaults, ...args[0] }
                : Object.fromEntries(parameterNames.map((parameter, index) => [parameter, args[index]])
                    .filter(([, value]) => value !== undefined));
            return call(command, { ...defaults, ...params });
        };
    }
}

function describeError(error, code, phase) {
    const name = String(error?.name || "Error");
    const message = String(error?.message || error);
    const stack = String(error?.stack || "");
    const match = stack.match(/desmume-eval-user\.js:(\d+):(\d+)/);
    const details = { phase, errorName: name };
    if (match) {
        details.line = Math.max(1, Number(match[1]) - 1);
        details.column = Number(match[2]);
        details.sourceExcerpt = String(code || "").split("\n")[details.line - 1] || "";
    }
    if (stack) details.stack = stack.split("\n").slice(0, 4).join("\n");
    return { name, message, details };
}

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

function assertSandboxSource(source) {
    const ast = parse(`async function __desmumeSandbox__(){\n${String(source)}\n}`, {
        ecmaVersion: "latest",
        sourceType: "script"
    });
    const pending = [ast];
    const seen = new Set();
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        if (node.type === "ImportExpression") throw new SyntaxError("dynamic import is unavailable in isolated scripts");
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === "object") pending.push(value);
        }
    }
}

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!parse) {
        if (message.type !== "initialize") {
            send({ type: "protocolError", message: "dependency initialization is required" });
            return;
        }
        try {
            const acorn = await initializeLockedDependency({
                dependency: message.dependency,
                nativeEval,
                nativeDigest,
                NativeTextEncoder
            });
            if (typeof acorn.parse !== "function") throw new Error("Acorn parse export is unavailable");
            parse = acorn.parse;
            send({ type: "ready", hardened: true, layer: "sandbox", dependencyHash: message.dependency.sha256 });
        } catch (error) {
            send({ type: "protocolError", message: `dependency initialization failed: ${String(error?.message || error)}` });
        }
        return;
    }
    if (message.replyId) {
        const pending = replies.get(message.replyId);
        if (!pending) {
            send({ type: "protocolError", message: `unknown reply id: ${message.replyId}` });
            return;
        }
        replies.delete(message.replyId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
    }
    if (message.type === "securityProbe") {
        const forged = { type: "done", result: { forged: true } };
        if (message.probe === "wrongToken") forged.channelToken = `${channelToken}-wrong`;
        else if (message.probe === "guessedToken") forged.channelToken = "00000000-0000-4000-8000-000000000000";
        else if (message.probe === "fakeCall") Object.assign(forged, { type: "call", id: "forged", command: "status", params: {} });
        else if (message.probe === "fakePrint") Object.assign(forged, { type: "print", values: ["forged"] });
        else if (message.probe === "fakeEventDone") Object.assign(forged, { type: "eventDone", eventId: 1 });
        nativePostMessage(forged);
        return;
    }
    if (message.type !== "run" || typeof message.code !== "string") {
        send({ type: "protocolError", message: "run message with string code is required" });
        return;
    }
    installShortcuts(message.shortcuts);
    try {
        // Deliberately parse twice in the locked realm: once at acceptance and once immediately before compilation.
        assertSandboxSource(message.code);
        assertSandboxSource(message.code);
        const script = `(async (mcp, webmcp) => {\n"use strict";\n${message.code}\n})\n//# sourceURL=desmume-eval-user.js`;
        const run = nativeEval(script);
        const result = await run(mcp, webmcp);
        send({ type: "done", result: normalizeBoundedValue(result === undefined ? null : result).value });
    } catch (error) {
        const phase = error?.name === "SyntaxError" ? "compile" : "runtime";
        send({ type: "error", error: describeError(error, message.code, phase) });
    }
});
})();
