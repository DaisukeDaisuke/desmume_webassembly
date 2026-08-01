"use strict";

import { assertLockedGlobals, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";
import { normalizeBoundedValue } from "../bounded-value.js";
import { readOwnDataProperty } from "../structured-value-normalizer.js";
import {
    isPersistentMcpName,
    normalizePersistentBaselineData,
    normalizePersistentMcpDescription,
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult,
    normalizeWorkerRpcParams,
    normalizeWorkerTrigger
} from "../worker-rpc-payload.js";
import { serializeWorkerError } from "../worker-error-summary.js";
import { ResourceLimits } from "../resource-limits.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const NativeError = globalThis.Error;
const NativeString = globalThis.String;
const nativeObjectHasOwn = globalThis.Object.hasOwn.bind(globalThis.Object);
const nativeObjectGetPrototypeOf = globalThis.Object.getPrototypeOf.bind(globalThis.Object);
const nativeObjectGetOwnPropertyDescriptors = globalThis.Object.getOwnPropertyDescriptors.bind(globalThis.Object);
const nativeObjectKeys = globalThis.Object.keys.bind(globalThis.Object);
const nativeObjectFreeze = globalThis.Object.freeze.bind(globalThis.Object);
const nativeObjectDefineProperty = globalThis.Object.defineProperty.bind(globalThis.Object);
const nativeObjectPrototype = nativeObjectGetPrototypeOf({});
const nativeAsyncFunctionPrototype = nativeObjectGetPrototypeOf(async () => {});
const nativeJsonStringify = globalThis.JSON.stringify.bind(globalThis.JSON);
const nativeSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout?.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval?.bind(globalThis);
const channelToken = globalThis.crypto.randomUUID();
const send = (message) => {
    nativeObjectDefineProperty(message, "channelToken", {
        value: channelToken,
        enumerable: true,
        configurable: true,
        writable: true
    });
    nativePostMessage(message);
};

const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = undefined;
const Function = undefined;
const callbacks = new Map();
const persistentMcps = new Map();
let baselineSaveHook = null;
let baselineRestoreHook = null;
let baselinePriority = 0;
const replies = new Map();
let callbackSerial = 1;
const workQueue = [];
const MAX_WORK_QUEUE = ResourceLimits.persistentEventQueue;
let drainingWork = false;
let activeNonBlockingMcpCalls = 0;
let droppedTicks = 0;
let asyncMode = false;
let activeEvent = null;
let initialized = false;
let currentSource = "";
let activeBaselineIdentity = null;
let barrierActive = false;
let pendingBarrier = null;
const timerCallbacks = new Map();
let timerSerial = 1;

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
            const id = timerSerial++;
            const timer = nativeTimer(() => {
                const entry = timerCallbacks.get(id);
                if (!entry || entry.pending) return;
                entry.pending = true;
                workQueue.push({ type: "timer", id, callback, args });
                void drainWork().catch((error) => fail(error, "runtime"));
            }, delay);
            timerCallbacks.set(id, { timer, interval: name === "setInterval", pending: false });
            return id;
        },
        writable: false,
        configurable: false
    });
}

installSafeTimer("setTimeout", nativeSetTimeout);
installSafeTimer("setInterval", nativeSetInterval);
installSafeClearTimer("clearTimeout", nativeClearTimeout);
installSafeClearTimer("clearInterval", nativeClearInterval);

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
        if (!nativeObjectHasOwn(prototype, "constructor")) continue;
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
        replies.set(id, {
            resolve,
            reject,
            callSiteStack: typeof data.callSiteStack === "string" ? data.callSiteStack : ""
        });
        send({ type, id, ...data });
    });
}

const mcp = {
    call: (command, params = {}, userCallSiteStack = "") => {
        const normalizedParams = normalizeWorkerRpcParams(command, params);
        return ask("call", {
            command,
            params: normalizedParams,
            callSiteStack: NativeString(userCallSiteStack || new NativeError().stack || "").slice(0, 8192),
            eventId: activeEvent?.eventId || 0,
            callbackId: activeEvent?.callbackId,
            callbackToken: activeEvent?.callbackToken
            ,internalMetadata: activeBaselineIdentity
        });
    }
};
const webmcp = mcp;
const print = (...values) => {
    for (let index = 0; index < values.length; index++) {
        if (values[index] === undefined) values[index] = "undefined";
    }
    send({ type: "print", values: normalizeBoundedValue(values, { maxBytes: 64 * 1024 }).value });
};
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

function callbackErrorSummary(error) {
    const code = readOwnDataProperty(error, "code");
    const summary = serializeWorkerError(error, {
        phase: "callback",
        code,
        source: currentSource,
        sourceName: "desmume-persistent-user.js"
    });
    return summary;
}

function installSafeClearTimer(name, nativeClear) {
    if (!nativeClear) return;
    Object.defineProperty(globalThis, name, {
        value: (id) => {
            const entry = timerCallbacks.get(id);
            if (!entry) return;
            nativeClear(entry.timer);
            timerCallbacks.delete(id);
        },
        writable: false,
        configurable: false
    });
}

function callbackErrorMessage(error) {
    const summary = callbackErrorSummary(error);
    const details = readOwnDataProperty(error, "details");
    let detailText = "";
    try {
        if (details && typeof details === "object") {
            detailText = nativeJsonStringify(normalizeBoundedValue(details, {
                maxBytes: 4096,
                maxArray: 32,
                maxProperties: 32
            }).value);
        }
    } catch {}
    const location = summary.details.line
        ? ` at ${summary.details.sourceName || "user source"}:${summary.details.line}:${summary.details.column || 1}`
        : "";
    const excerpt = summary.details.sourceExcerpt
        ? ` sourceExcerpt=${nativeJsonStringify(summary.details.sourceExcerpt)}`
        : "";
    return `${summary.details.code ? `[${summary.details.code}] ` : ""}${summary.message}${location}${excerpt}${detailText ? ` details=${detailText}` : ""}`;
}

function unwrapLegacyScalar(result, command) {
    if (result?.ok === false) {
        const error = new Error(result.error?.message || `${command} failed`);
        error.code = result.error?.code;
        error.details = result.error?.details;
        throw error;
    }
    if (result?.ok === true && nativeObjectHasOwn(result, "value")) {
        return result.value;
    }
    if (result == null || ["number", "string", "boolean"].includes(typeof result)) {
        return result;
    }
    throw new TypeError(`${command} did not return a scalar result`);
}

async function callLegacyScalar(command, params, invoke = mcp.call) {
    return unwrapLegacyScalar(await invoke(command, params), command);
}

async function callMemory(command, params) {
    try {
        return await mcp.call(command, params);
    } catch (cause) {
        const error = cause && typeof cause === "object"
            ? cause
            : new NativeError(NativeString(cause || `${command} failed`));
        const address = params?.address;
        error.details = {
            memoryApi: command,
            inputAddress: address === undefined ? "undefined" : NativeString(address),
            triggerId: Number(activeEvent?.triggerId) || 0
        };
        throw error;
    }
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
        return await ask("register", {
            trigger: normalizeWorkerTrigger({ kind, address, callbackId, ...options })
        });
    } catch (error) {
        callbacks.delete(callbackId);
        throw error;
    }
}

const memory = {
    getregister: (registerName, cpu) => callLegacyScalar("memoryGetRegister", { register: registerName, cpu }),
    setregister: (registerName, value, cpu) => mcp.call("memorySetRegister", { register: registerName, value, cpu }),
    readbyte: (address, cpu) => callLegacyScalar("memoryReadByte", { address, cpu }, callMemory),
    readword: (address, cpu) => callLegacyScalar("memoryReadWord", { address, cpu }, callMemory),
    readdword: (address, cpu) => callLegacyScalar("memoryReadDword", { address, cpu }, callMemory),
    writebyte: (address, value, cpu) => callMemory("memoryWriteByte", { address, value, cpu }),
    writeword: (address, value, cpu) => callMemory("memoryWriteWord", { address, value, cpu }),
    writedword: (address, value, cpu) => callMemory("memoryWriteDword", { address, value, cpu }),
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
const emu_onstateload = (callback, options) => register("stateLoad", 0, callback, options);
const emu_onstatesave = (callback, options) => register("stateSave", 0, callback, options);
const emu_registerbaseline = (saveCallback, restoreCallback, priority = 0) => {
    if (typeof saveCallback !== "function" || typeof restoreCallback !== "function"
        || nativeObjectGetPrototypeOf(saveCallback) !== nativeAsyncFunctionPrototype
        || nativeObjectGetPrototypeOf(restoreCallback) !== nativeAsyncFunctionPrototype) {
        print("baseline hook not registered: save and restore must both be async functions");
        return false;
    }
    const normalizedPriority = Number(priority);
    if (!Number.isSafeInteger(normalizedPriority) || normalizedPriority < -1000000 || normalizedPriority > 1000000) {
        print("baseline hook not registered: priority must be an integer between -1000000 and 1000000");
        return false;
    }
    if (baselineSaveHook || baselineRestoreHook) {
        throw new TypeError("emu_registerbaseline may be called only once per persistent script");
    }
    baselineSaveHook = saveCallback;
    baselineRestoreHook = restoreCallback;
    baselinePriority = normalizedPriority;
    send({ type: "baselineHookRegistered", priority: baselinePriority });
    return true;
};
const emu = Object.fromEntries([
    "pause", "resume", "status", "step", "smartStep", "stepOver", "stepNextBranchOrReturn",
    "trueNextBranch", "runUntilReturn", "runUntilNextCall", "stepFrames", "setInput",
    "runTouchHold", "setSpeed", "setRenderEnabled", "setAudio", "saveState", "loadState",
    "reloadRecentFile"
].map((command) => [command, (params = {}) => mcp.call(command, params)]));
emu.onStateLoad = emu_onstateload;
emu.onStateSave = emu_onstatesave;
emu.registerBaseline = emu_registerbaseline;

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
        error: serializeWorkerError(error, {
            phase,
            source: currentSource,
            sourceName: "desmume-persistent-user.js"
        })
    });
}

function validatePublishedMcps(value) {
    if (value === undefined || value === null) return { handlers: new Map(), metadata: [] };
    if (!Array.isArray(value)) {
        throw new TypeError("persistent script top-level return must be an MCP definition array, null, or undefined");
    }
    if (value.length > ResourceLimits.persistentMcpEndpointsPerScript) {
        throw new RangeError(
            `persistent MCP endpoint limit exceeded (${ResourceLimits.persistentMcpEndpointsPerScript})`
        );
    }
    const handlers = new Map();
    const metadata = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
        const definition = readOwnDataProperty(value, `${index}`);
        if (!definition || typeof definition !== "object") {
            throw new TypeError(`persistent MCP definition ${index} must be an object`);
        }
        const prototype = nativeObjectGetPrototypeOf(definition);
        if (prototype !== nativeObjectPrototype && prototype !== null) {
            throw new TypeError(`persistent MCP definition ${index} must be a plain object`);
        }
        const descriptors = nativeObjectGetOwnPropertyDescriptors(definition);
        for (const key of nativeObjectKeys(descriptors)) {
            const descriptor = readOwnDataProperty(descriptors, key);
            if (!descriptor || !nativeObjectHasOwn(descriptor, "value")) {
                throw new TypeError(`persistent MCP definition ${index} contains an accessor`);
            }
        }
        const name = readOwnDataProperty(definition, "name");
        const description = normalizePersistentMcpDescription(
            readOwnDataProperty(definition, "description")
        );
        const handler = readOwnDataProperty(definition, "handler");
        if (!isPersistentMcpName(name)) {
            throw new TypeError("persistent MCP name must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$");
        }
        if (typeof handler !== "function") {
            throw new TypeError(`persistent MCP handler is required: ${name}`);
        }
        if (handlers.has(name)) throw new TypeError(`duplicate persistent MCP name: ${name}`);
        handlers.set(name, handler);
        metadata[index] = { name, description };
    }
    return { handlers, metadata: normalizePersistentMcpMetadata(metadata) };
}

function publishPersistentMcps(value) {
    const published = validatePublishedMcps(value);
    persistentMcps.clear();
    for (const [name, handler] of published.handlers) persistentMcps.set(name, handler);
    send({ type: "pscriptMcpPublished", mcps: published.metadata });
    for (const item of published.metadata) print(`MCP published: ${item.name}`);
}

async function runPersistentMcp(message) {
    const callId = Number(message.callId);
    const scriptInstanceId = String(message.scriptInstanceId || "");
    const name = message.name;
    const blocking = message.blocking;
    let params;
    if (!Number.isSafeInteger(callId) || callId < 1
        || !scriptInstanceId
        || !isPersistentMcpName(name)
        || typeof blocking !== "boolean") {
        fail(new TypeError("persistent MCP invocation is malformed"), "protocol");
        return;
    }
    try {
        params = normalizePersistentMcpParams(message.params);
    } catch (error) {
        fail(error, "protocol");
        return;
    }
    const handler = persistentMcps.get(name);
    if (!handler) {
        send({
            type: "pscriptMcpResult",
            callId,
            scriptInstanceId,
            ok: false,
            error: normalizePersistentMcpResult({
                code: "SCRIPT_MCP_NOT_FOUND",
                message: `Persistent script MCP is not published: ${name}`
            })
        });
        return;
    }
    print(`MCP call: ${name} · blocking=${blocking}`);
    try {
        const rawValue = await handler(params, nativeObjectFreeze({ blocking }));
        let value;
        try {
            value = normalizePersistentMcpResult(rawValue);
        } catch (error) {
            fail(error, "protocol");
            return;
        }
        send({ type: "pscriptMcpResult", callId, scriptInstanceId, ok: true, value });
    } catch (error) {
        const summary = serializeWorkerError(error, {
            phase: "persistent-mcp",
            code: "SCRIPT_RUNTIME_ERROR",
            source: currentSource,
            sourceName: "desmume-persistent-user.js"
        });
        send({
            type: "pscriptMcpResult",
            callId,
            scriptInstanceId,
            ok: false,
            error: normalizePersistentMcpResult({
                code: "SCRIPT_RUNTIME_ERROR",
                message: summary.message,
                details: summary.details
            })
        });
    }
}

async function runBaselineHook(message) {
    const callId = Number(message.callId);
    const scriptInstanceId = String(message.scriptInstanceId || "");
    const operation = message.operation;
    if (!Number.isSafeInteger(callId) || callId < 1
        || !scriptInstanceId
        || (operation !== "save" && operation !== "restore")) {
        fail(new TypeError("persistent baseline invocation is malformed"), "protocol");
        return;
    }
    const hook = operation === "save" ? baselineSaveHook : baselineRestoreHook;
    if (!hook) {
        send({
            type: "baselineHookResult",
            callId,
            scriptInstanceId,
            operation,
            ok: false,
            error: normalizePersistentBaselineData({
                code: "STATE_INVALID",
                message: `Persistent baseline ${operation} hook is not registered`
            })
        });
        return;
    }
    send({
        type: "baselineHookStarted",
        callId,
        scriptInstanceId,
        operation
    });
    try {
        activeBaselineIdentity = message.internalMetadata || null;
        const context = nativeObjectFreeze({
            name: NativeString(message.name || "default"),
            operation,
            blocking: true
        });
        if (operation === "save") {
            const rawValue = await hook(context);
            const value = normalizePersistentBaselineData(rawValue === undefined ? null : rawValue);
            send({
                type: "baselineHookResult",
                callId,
                scriptInstanceId,
                operation,
                ok: true,
                value
            });
            return;
        }
        const value = normalizePersistentBaselineData(message.value);
        await hook(value, context);
        send({
            type: "baselineHookResult",
            callId,
            scriptInstanceId,
            operation,
            ok: true,
            value: null
        });
    } catch (error) {
        const summary = serializeWorkerError(error, {
            phase: `baseline-${operation}`,
            code: "SCRIPT_RUNTIME_ERROR",
            source: currentSource,
            sourceName: "desmume-persistent-user.js"
        });
        send({
            type: "baselineHookResult",
            callId,
            scriptInstanceId,
            operation,
            ok: false,
            error: normalizePersistentBaselineData({
                code: "SCRIPT_RUNTIME_ERROR",
                message: summary.message,
                details: summary.details
            })
        });
    } finally {
        activeBaselineIdentity = null;
    }
}

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

async function runEvent(message) {
    const previousEvent = activeEvent;
    activeEvent = {
        eventId: Number(message.eventId) || 0,
        callbackId: Number(message.callbackId),
        triggerId: Number(message.triggerId) || 0,
        callbackToken: String(message.callbackToken || "")
    };
    try {
        for (const [id, entry] of callbacks) {
            if (message.callbackId ? id !== message.callbackId : entry.kind !== message.event) continue;
            try {
                await entry.callback(message.payload);
            } catch (error) {
                if (asyncMode) throw error;
                const summary = callbackErrorSummary(error);
                send({
                    type: "callbackError",
                    eventId: Number(message.eventId) || 0,
                    callbackId: Number(message.callbackId) || 0,
                    error: summary
                });
                print(`callback error: ${callbackErrorMessage(error)}`);
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

async function drainWork() {
    if (drainingWork) return;
    drainingWork = true;
    try {
        while (workQueue.length) {
            if (pendingBarrier || (barrierActive && workQueue[0]?.type !== "baselineHookInvoke")) return;
            const message = workQueue.shift();
            if (message.type === "pscriptMcpInvoke") {
                await runPersistentMcp(message);
                continue;
            }
            if (message.type === "baselineHookInvoke") {
                await runBaselineHook(message);
                continue;
            }
            if (message.type === "timer") {
                const entry = timerCallbacks.get(message.id);
                if (!entry) continue;
                try { await message.callback(...message.args); }
                catch (error) { send({ type: "callbackError", error: callbackErrorSummary(error) }); }
                if (entry.interval) entry.pending = false;
                else timerCallbacks.delete(message.id);
                continue;
            }
            try {
                await runEvent(message);
            } catch (error) {
                if (asyncMode) throw error;
                const summary = callbackErrorSummary(error);
                send({
                    type: "callbackError",
                    eventId: Number(message.eventId) || 0,
                    callbackId: Number(message.callbackId) || 0,
                    error: summary
                });
                print(`callback error: ${callbackErrorMessage(error)}`);
            }
        }
    } finally {
        drainingWork = false;
        activatePendingBarrier();
    }
}

function activatePendingBarrier() {
    if (!pendingBarrier || drainingWork || activeNonBlockingMcpCalls) return;
    barrierActive = pendingBarrier.active;
    const acknowledgement = pendingBarrier;
    pendingBarrier = null;
    send({
        type: "baselineBarrierAck",
        active: acknowledgement.active,
        operationId: acknowledgement.operationId,
        operation: acknowledgement.operation
    });
    if (!barrierActive) void drainWork().catch((error) => fail(error, "runtime"));
}

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!initialized) {
        if (message.type !== "initialize") return fail(new Error("sandbox initialization is required"), "protocol");
        initialized = true;
        send({ type: "ready", hardened: true, layer: "sandbox" });
        return;
    }
    if (message.replyId) {
        const pending = replies.get(message.replyId);
        if (!pending) return fail(new Error(`unknown reply id: ${message.replyId}`), "protocol");
        replies.delete(message.replyId);
        if (message.error) {
            const payload = message.error;
            const error = new NativeError(typeof payload === "object"
                ? NativeString(readOwnDataProperty(payload, "message") || "Worker RPC failed")
                : NativeString(payload));
            if (payload && typeof payload === "object") {
                const code = readOwnDataProperty(payload, "code");
                const details = readOwnDataProperty(payload, "details");
                if (typeof code === "string") error.code = code;
                const replyCallSiteStack = readOwnDataProperty(details, "callSiteStack");
                const callSiteStack = typeof replyCallSiteStack === "string" && replyCallSiteStack
                    ? replyCallSiteStack
                    : pending.callSiteStack;
                if (callSiteStack) {
                    nativeObjectDefineProperty(error, "stack", {
                        value: callSiteStack,
                        configurable: true,
                        writable: true
                    });
                }
                if (details !== undefined) {
                    error.details = details;
                }
            }
            pending.reject(error);
        } else pending.resolve(message.result);
        return;
    }
    if (message.type === "start") {
        asyncMode = !!message.asyncMode;
        currentSource = NativeString(message.code || "");
        installShortcuts(message.shortcuts);
        try {
            const run = nativeEval(`(async (__mcp, memory, print, printf, printhex, emu, emu_registerstart, emu_ontick, emu_onstateload, emu_onstatesave, emu_registerbaseline) => {\n"use strict"; const mcp = Object.freeze({ call: (command, params = {}) => __mcp.call(command, params, String(new Error().stack || "")) }); const webmcp = mcp;\n${message.code}\n})\n//# sourceURL=desmume-persistent-user.js`);
            send({ type: "compiled" });
            const published = await run(
                mcp,
                memory,
                print,
                printf,
                printhex,
                emu,
                emu_registerstart,
                emu_ontick,
                emu_onstateload,
                emu_onstatesave,
                emu_registerbaseline
            );
            publishPersistentMcps(published);
            send({ type: "started" });
        } catch (error) {
            fail(error, error?.name === "SyntaxError" ? "compile" : "runtime");
        }
        return;
    }
    if (message.type === "event") {
        if (message.event === "tick" && !message.eventId) {
            const existingTick = workQueue.findIndex((queued) => (
                queued.type === "event" && queued.event === "tick" && !queued.eventId
            ));
            if (existingTick >= 0) {
                workQueue[existingTick] = message;
                droppedTicks++;
                if ((droppedTicks & 63) === 1) print(`tick queue coalesced ${droppedTicks} event(s)`);
                return;
            }
        }
        if (workQueue.length >= MAX_WORK_QUEUE) {
            fail(new Error(`persistent work queue exceeded ${MAX_WORK_QUEUE}`), "resource");
            return;
        }
        workQueue.push(message);
        void drainWork().catch((error) => fail(error, "runtime"));
        return;
    }
    if (message.type === "baselineBarrier") {
        if (!Number.isSafeInteger(Number(message.operationId))) {
            fail(new Error("persistent baseline barrier request is malformed"), "protocol");
            return;
        }
        pendingBarrier = {
            active: message.active === true,
            operationId: Number(message.operationId),
            operation: message.operation
        };
        activatePendingBarrier();
        return;
    }
    if (message.type === "pscriptMcpInvoke") {
        if (message.blocking === true) {
            if (workQueue.length >= MAX_WORK_QUEUE) {
                fail(new Error(`persistent work queue exceeded ${MAX_WORK_QUEUE}`), "resource");
                return;
            }
            workQueue.push(message);
            void drainWork().catch((error) => fail(error, "runtime"));
            return;
        }
        if (message.blocking !== false
            || activeNonBlockingMcpCalls >= ResourceLimits.pendingPersistentMcpCallsPerScript) {
            fail(new Error("persistent non-blocking MCP call limit exceeded"), "protocol");
            return;
        }
        activeNonBlockingMcpCalls++;
        void runPersistentMcp(message).finally(() => {
            activeNonBlockingMcpCalls--;
            activatePendingBarrier();
        });
        return;
    }
    if (message.type === "baselineHookInvoke") {
        if (workQueue.length >= MAX_WORK_QUEUE) {
            fail(new Error(`persistent work queue exceeded ${MAX_WORK_QUEUE}`), "resource");
            return;
        }
        if (barrierActive) workQueue.unshift(message);
        else workQueue.push(message);
        void drainWork().catch((error) => fail(error, "runtime"));
        return;
    }
    fail(new Error(`unknown message type: ${String(message.type)}`), "protocol");
});
})();
