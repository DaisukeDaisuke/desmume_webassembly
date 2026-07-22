"use strict";

import { assertSandboxSource } from "./sandbox-source-policy.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
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

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches",
    "localStorage", "sessionStorage", "close",
    "navigator"
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
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        replies.set(id, { resolve, reject });
        send({ type: "call", id, command, params });
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

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
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
    if (message.type !== "run" || typeof message.code !== "string") {
        send({ type: "protocolError", message: "run message with string code is required" });
        return;
    }
    installShortcuts(message.shortcuts);
    try {
        assertSandboxSource(message.code);
        const script = `(async (mcp, webmcp) => {\n"use strict";\n${message.code}\n})\n//# sourceURL=desmume-eval-user.js`;
        const run = nativeEval(script);
        const result = await run(mcp, webmcp);
        send({ type: "done", result });
    } catch (error) {
        const phase = error?.name === "SyntaxError" ? "compile" : "runtime";
        send({ type: "error", error: describeError(error, message.code, phase) });
    }
});

send({ type: "ready", hardened: true, layer: "sandbox" });
})();
