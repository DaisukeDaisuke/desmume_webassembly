"use strict";

import { assertLockedGlobals, initializeLockedDependency } from "./dependency-bootstrap.js";
import { normalizeBoundedValue } from "../bounded-value.js";

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
const callbacks = new Map();
const replies = new Map();
let callbackSerial = 1;
const eventQueue = [];
const MAX_EVENT_QUEUE = 64;
let drainingEvents = false;
let droppedTicks = 0;
let asyncMode = false;
let activeEvent = null;
let parse = null;

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "addEventListener", "removeEventListener", "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches",
    "localStorage", "sessionStorage", "close",
    "navigator", "crypto"
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

function ask(type, data = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        replies.set(id, { resolve, reject });
        send({ type, id, ...data });
    });
}

const mcp = {
    call: (command, params = {}) => ask("call", {
        command,
        params,
        eventId: activeEvent?.eventId || 0,
        callbackId: activeEvent?.callbackId,
        callbackToken: activeEvent?.callbackToken
    })
};
const webmcp = mcp;
const print = (...values) => send({ type: "print", values: normalizeBoundedValue(values, { maxBytes: 64 * 1024 }).value });
const printf = (format, ...values) => print(String(format).replace(/%#?\.?(\d*)x|%[sd]/g, (match, width) => {
    const value = values.shift();
    if (match.endsWith("x")) {
        return "0x" + (Number(value) >>> 0).toString(16).padStart(Number(width || 0), "0");
    }
    return match.endsWith("d") ? String(Number(value)) : String(value);
}));
const printhex = (label, value) => print(
    label + ": " + (value == null ? "nil" : "0x" + (Number(value) >>> 0).toString(16).padStart(8, "0"))
);

function unwrapLegacyScalar(result, command) {
    if (result?.ok === false) {
        const error = new Error(result.error?.message || `${command} failed`);
        error.code = result.error?.code;
        error.details = result.error?.details;
        throw error;
    }
    if (result?.ok === true && Object.prototype.hasOwnProperty.call(result, "value")) {
        return result.value;
    }
    if (result == null || ["number", "string", "boolean"].includes(typeof result)) {
        return result;
    }
    throw new TypeError(`${command} did not return a scalar result`);
}

async function callLegacyScalar(command, params) {
    return unwrapLegacyScalar(await mcp.call(command, params), command);
}

async function register(kind, address, callback, options = {}) {
    if (typeof address === "function") {
        options = callback || {};
        callback = address;
        address = 0;
    }
    if (typeof callback !== "function") throw new TypeError(`${kind} callback is required`);
    const callbackId = callbackSerial++;
    callbacks.set(callbackId, { callback, kind });
    try {
        return await ask("register", { trigger: { kind, address, callbackId, ...options } });
    } catch (error) {
        callbacks.delete(callbackId);
        throw error;
    }
}

const memory = {
    getregister: (registerName, cpu) => callLegacyScalar("memoryGetRegister", { register: registerName, cpu }),
    setregister: (registerName, value, cpu) => mcp.call("memorySetRegister", { register: registerName, value, cpu }),
    readbyte: (address, cpu) => callLegacyScalar("memoryReadByte", { address, cpu }),
    readword: (address, cpu) => callLegacyScalar("memoryReadWord", { address, cpu }),
    readdword: (address, cpu) => callLegacyScalar("memoryReadDword", { address, cpu }),
    writebyte: (address, value, cpu) => mcp.call("memoryWriteByte", { address, value, cpu }),
    writeword: (address, value, cpu) => mcp.call("memoryWriteWord", { address, value, cpu }),
    writedword: (address, value, cpu) => mcp.call("memoryWriteDword", { address, value, cpu }),
    registerwrite: (address, callback, options) => register("write", address, callback, options),
    registerread: (address, callback, options) => register("read", address, callback, options),
    registerexec: (address, callback, options) => register("exec", address, callback, options),
    registerexception: (kind, callback, options) => register(kind, 0, callback, options),
    ontick: (callback, options) => register("tick", 0, callback, options)
};
memory.reg = memory.getregister;
memory.regw = memory.setregister;
memory.read8 = memory.readbyte;
memory.read16 = memory.readword;
memory.read32 = memory.readdword;
memory.write8 = memory.writebyte;
memory.write16 = memory.writeword;
memory.write32 = memory.writedword;

const emu_registerstart = (callback, options) => register("start", 0, callback, options);
const emu_ontick = (callback, options) => register("tick", 0, callback, options);
const emu = Object.fromEntries([
    "pause", "resume", "status", "step", "smartStep", "stepOver", "stepNextBranchOrReturn",
    "trueNextBranch", "runUntilReturn", "runUntilNextCall", "stepFrames", "setInput",
    "runTouchHold", "setSpeed", "setRenderEnabled", "setAudio", "saveState", "loadState",
    "reloadRecentFile"
].map((command) => [command, (params = {}) => mcp.call(command, params)]));

function installShortcuts(definitions) {
    for (const [name, command, parameterNames, defaults = {}] of definitions || []) {
        globalThis[name] = (...args) => {
            const params = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
                ? { ...defaults, ...args[0] }
                : Object.fromEntries(parameterNames.map((parameter, index) => [parameter, args[index]])
                    .filter(([, value]) => value !== undefined));
            return mcp.call(command, { ...defaults, ...params });
        };
    }
}

function fail(error, phase = "runtime") {
    send({
        type: "failed",
        phase,
        error: {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            stack: String(error?.stack || "")
        }
    });
}

lockDownRuntimeCodeGeneration();
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

async function runEvent(message) {
    const previousEvent = activeEvent;
    activeEvent = {
        eventId: Number(message.eventId) || 0,
        callbackId: Number(message.callbackId),
        callbackToken: String(message.callbackToken || "")
    };
    try {
        for (const [id, entry] of callbacks) {
            if (message.callbackId ? id !== message.callbackId : entry.kind !== message.event) continue;
            try {
                await entry.callback(message.payload);
            } catch (error) {
                if (asyncMode) throw error;
                print(`callback error: ${String(error?.message || error)}`);
            }
        }
    } finally {
        activeEvent = previousEvent;
        if (message.eventId) send({
            type: "eventDone",
            eventId: message.eventId,
            callbackId: message.callbackId,
            callbackToken: message.callbackToken
        });
        send({ type: "eventProcessed" });
    }
}

async function drainEvents() {
    if (drainingEvents) return;
    drainingEvents = true;
    try {
        while (eventQueue.length) {
            const message = eventQueue.shift();
            try {
                await runEvent(message);
            } catch (error) {
                if (asyncMode) throw error;
                print(`callback error: ${String(error?.message || error)}`);
            }
        }
    } finally {
        drainingEvents = false;
    }
}

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!parse) {
        if (message.type !== "initialize") return fail(new Error("dependency initialization is required"), "protocol");
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
            fail(error, "startup");
        }
        return;
    }
    if (message.replyId) {
        const pending = replies.get(message.replyId);
        if (!pending) return fail(new Error(`unknown reply id: ${message.replyId}`), "protocol");
        replies.delete(message.replyId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
    }
    if (message.type === "start") {
        asyncMode = !!message.asyncMode;
        installShortcuts(message.shortcuts);
        try {
            assertSandboxSource(message.code);
            assertSandboxSource(message.code);
            const run = nativeEval(`(async (mcp, webmcp, memory, print, printf, printhex, emu, emu_registerstart, emu_ontick) => {\n"use strict";\n${message.code}\n})\n//# sourceURL=desmume-persistent-user.js`);
            send({ type: "compiled" });
            send({ type: "started" });
            await run(mcp, webmcp, memory, print, printf, printhex, emu, emu_registerstart, emu_ontick);
        } catch (error) {
            fail(error, error?.name === "SyntaxError" ? "compile" : "runtime");
        }
        return;
    }
    if (message.type === "event") {
        if (message.event === "tick" && !message.eventId) {
            const existingTick = eventQueue.findIndex((queued) => queued.event === "tick" && !queued.eventId);
            if (existingTick >= 0) {
                eventQueue[existingTick] = message;
                droppedTicks++;
                if ((droppedTicks & 63) === 1) print(`tick queue coalesced ${droppedTicks} event(s)`);
                return;
            }
        }
        if (eventQueue.length >= MAX_EVENT_QUEUE) {
            fail(new Error(`persistent event queue exceeded ${MAX_EVENT_QUEUE}`), "resource");
            return;
        }
        eventQueue.push(message);
        void drainEvents().catch((error) => fail(error, "runtime"));
        return;
    }
    fail(new Error(`unknown message type: ${String(message.type)}`), "protocol");
});
})();
