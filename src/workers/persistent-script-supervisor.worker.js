"use strict";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let started = false;
const pendingRequestIds = new Set();
const MAX_PENDING_REQUESTS = 32;
const MAX_EVENT_QUEUE = 64;
const eventQueue = [];
let childEventBusy = false;

function assertBoundedProtocolValue(value, { byteLimit = 0, rootPath = "" } = {}) {
    const stack = [{ value, depth: 0, path: rootPath }];
    const seen = new Set();
    let nodes = 0;
    let bytes = 0;
    while (stack.length) {
        const current = stack.pop();
        const item = current.value;
        if (++nodes > (byteLimit || 4096) + 4096 || current.depth > 10) throw new RangeError("sandbox message exceeds structural limits");
        if (item === null || typeof item === "boolean") { bytes += 4; continue; }
        if (typeof item === "number") {
            if (!Number.isFinite(item)) throw new TypeError("sandbox message number is invalid");
            bytes += 16;
            continue;
        }
        if (typeof item === "string") { bytes += item.length * 3; continue; }
        if (typeof item !== "object" || seen.has(item)) throw new TypeError("sandbox message value is invalid");
        if (item instanceof Uint8Array && current.path === "bytes" && byteLimit) {
            if (item.byteLength > byteLimit) throw new RangeError("sandbox RPC byte input exceeds command budget");
            bytes += item.byteLength;
            if (bytes > byteLimit + 64 * 1024) throw new RangeError("sandbox message exceeds byte budget");
            continue;
        }
        if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) throw new TypeError("sandbox message binary type is invalid");
        seen.add(item);
        const prototype = Object.getPrototypeOf(item);
        if (Array.isArray(item)) {
            const maximum = current.path === "bytes" && byteLimit ? byteLimit : 1024;
            if (item.length > maximum) throw new RangeError("sandbox message array exceeds item budget");
            if (current.path === "bytes" && byteLimit) {
                for (const byte of item) {
                    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new TypeError("sandbox RPC byte array is invalid");
                }
                bytes += item.length;
                if (bytes > byteLimit + 64 * 1024) throw new RangeError("sandbox message exceeds byte budget");
                continue;
            }
            for (let index = 0; index < item.length; index++) {
                stack.push({ value: item[index], depth: current.depth + 1, path: `${current.path}[${index}]` });
            }
        } else {
            if (prototype !== Object.prototype && prototype !== null) throw new TypeError("sandbox message object is invalid");
            const descriptors = Object.getOwnPropertyDescriptors(item);
            const keys = Object.keys(descriptors);
            if (keys.length > 128) throw new RangeError("sandbox message object exceeds property budget");
            for (const key of keys) {
                if (!("value" in descriptors[key])) throw new TypeError("sandbox message accessor is invalid");
                bytes += key.length * 3;
                stack.push({ value: descriptors[key].value, depth: current.depth + 1, path: current.path ? `${current.path}.${key}` : key });
            }
        }
        if (bytes > (byteLimit ? byteLimit + 64 * 1024 : 256 * 1024)) throw new RangeError("sandbox message exceeds byte budget");
    }
}

function assertBoundedChildRequest(message) {
    if (message.type === "call") {
        if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
            throw new TypeError("sandbox RPC shape is invalid");
        }
        const byteLimit = message.command === "injectBytes" ? 1024 * 1024
            : message.command === "disassembleBytes" ? 64 * 1024 : 0;
        assertBoundedProtocolValue(message.params, { byteLimit });
    } else if (message.type === "register") {
        assertBoundedProtocolValue(message.trigger, { rootPath: "trigger" });
    }
}

function fail(error, phase = "protocol") {
    postMessage({
        type: "failed",
        phase,
        error: {
            name: String(error?.name || "Error"),
            message: String(error?.message || error),
            stack: String(error?.stack || "")
        }
    });
}

function disposeSandbox() {
    sandbox?.terminate();
    sandbox = null;
    if (sandboxUrl) URL.revokeObjectURL(sandboxUrl);
    sandboxUrl = "";
}

function forwardSandboxMessage(message) {
    const { channelToken: _channelToken, ...forwarded } = message;
    postMessage(forwarded);
}

function pumpEventQueue() {
    if (childEventBusy || !sandbox || !channelToken || !eventQueue.length) return;
    childEventBusy = true;
    sandbox.postMessage(eventQueue.shift());
}

function queueEvent(message) {
    if (message.event === "tick" && !message.eventId) {
        const index = eventQueue.findIndex((queued) => queued.event === "tick" && !queued.eventId);
        if (index >= 0) {
            eventQueue[index] = message;
            return;
        }
    }
    if (eventQueue.length >= MAX_EVENT_QUEUE) {
        fail(new Error(`supervisor event queue exceeded ${MAX_EVENT_QUEUE}`), "resource");
        disposeSandbox();
        return;
    }
    eventQueue.push(message);
    pumpEventQueue();
}

function startSandbox(message) {
    if (started || typeof message.code !== "string" || typeof message.sandboxSource !== "string"
        || typeof message.dependency?.source !== "string") {
        fail(new Error("one start message with code, sandbox source, and fixed dependency is required"));
        return;
    }
    started = true;
    try {
        sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
        sandbox = new Worker(sandboxUrl);
        sandbox.postMessage({ type: "initialize", dependency: message.dependency });
    } catch (error) {
        fail(error, "startup");
        disposeSandbox();
        return;
    }
    sandbox.onmessage = (event) => {
        const childMessage = event.data || {};
        if (!channelToken) {
            if (childMessage.type !== "ready"
                || childMessage.hardened !== true
                || childMessage.layer !== "sandbox"
                || typeof childMessage.channelToken !== "string"
                || childMessage.dependencyHash !== message.dependency.sha256) {
                fail(new Error("sandbox Worker did not provide a valid channel token"));
                disposeSandbox();
                return;
            }
            channelToken = childMessage.channelToken;
            sandbox.postMessage({
                type: "start",
                code: message.code,
                asyncMode: message.asyncMode,
                shortcuts: message.shortcuts
            });
            return;
        }
        if (childMessage.channelToken !== channelToken
            || !["call", "register", "eventDone", "eventProcessed", "print", "compiled", "started", "failed"].includes(childMessage.type)) {
            fail(new Error("sandbox Worker sent an invalid message"));
            disposeSandbox();
            return;
        }
        if (childMessage.type === "eventProcessed") {
            childEventBusy = false;
            postMessage({ type: "eventAck" });
            pumpEventQueue();
            return;
        }
        if ((childMessage.type === "call" || childMessage.type === "register")
            && typeof childMessage.id === "string") {
            try {
                assertBoundedChildRequest(childMessage);
            } catch (error) {
                fail(error);
                disposeSandbox();
                return;
            }
            if (!childMessage.id || pendingRequestIds.has(childMessage.id)) {
                fail(new Error("sandbox reused or omitted a request id"));
                disposeSandbox();
                return;
            }
            if (pendingRequestIds.size >= MAX_PENDING_REQUESTS) {
                fail(new Error(`sandbox exceeded ${MAX_PENDING_REQUESTS} pending requests`));
                disposeSandbox();
                return;
            }
            pendingRequestIds.add(childMessage.id);
        }
        forwardSandboxMessage(childMessage);
        if (childMessage.type === "failed") disposeSandbox();
    };
    sandbox.onerror = (event) => {
        fail(new Error(String(event.message || "sandbox Worker crashed")), "runtime");
        disposeSandbox();
    };
    sandbox.onmessageerror = () => {
        fail(new Error("sandbox Worker returned an unreadable message"));
        disposeSandbox();
    };
}

onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "start") {
        startSandbox(message);
        return;
    }
    if (message.replyId && sandbox && pendingRequestIds.delete(String(message.replyId))) {
        sandbox.postMessage(message);
        return;
    }
    if (message.type === "event" && sandbox && channelToken) {
        queueEvent(message);
        return;
    }
    fail(new Error("unknown supervisor message"));
};

postMessage({ type: "ready", hardened: true, layer: "supervisor" });
