"use strict";

import { normalizeBoundedValue } from "../bounded-value.js";
import { normalizeWorkerRpcParams, normalizeWorkerTrigger } from "../worker-rpc-value.js";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let started = false;
let childWorkerTerminateCalled = false;
let childBlobUrlRevokeCalled = false;
let childHandlersCleared = false;
const pendingRequestIds = new Set();
const MAX_PENDING_REQUESTS = 32;
const MAX_EVENT_QUEUE = 64;
const eventQueue = [];
let childEventBusy = false;

function smallValue(value) {
    return normalizeBoundedValue(value, {
        maxBytes: 64 * 1024,
        maxArray: 256,
        maxNodes: 2048,
        maxDepth: 10,
        maxProperties: 128
    }).value;
}

function fail(error, phase = "protocol") {
    let normalizedError;
    try {
        normalizedError = smallValue({
            name: String(error?.name || "Error").slice(0, 256),
            message: String(error?.message || error).slice(0, 2048),
            stack: String(error?.stack || "").slice(0, 8192)
        });
    } catch {
        normalizedError = { name: "Error", message: "unrepresentable supervisor error", stack: "" };
    }
    postMessage({ type: "failed", phase: String(phase).slice(0, 128), error: normalizedError });
}

function disposeSandbox() {
    if (sandbox) {
        sandbox.onmessage = null;
        sandbox.onerror = null;
        sandbox.onmessageerror = null;
        childHandlersCleared = true;
        sandbox.terminate();
        childWorkerTerminateCalled = true;
        sandbox = null;
    }
    if (sandboxUrl) {
        URL.revokeObjectURL(sandboxUrl);
        childBlobUrlRevokeCalled = true;
        sandboxUrl = "";
    }
    pendingRequestIds.clear();
    eventQueue.length = 0;
    childEventBusy = false;
}

function shutdown(requestId) {
    disposeSandbox();
    postMessage({
        type: "shutdownAck",
        requestId: String(requestId || ""),
        cleanup: {
            childWorkerTerminateCalled,
            childBlobUrlRevokeCalled,
            childHandlersCleared,
            childPendingRpcAfter: pendingRequestIds.size,
            childQueuedEventsAfter: eventQueue.length,
            childEventBusyAfter: childEventBusy
        }
    });
}

function requireRequestId(childMessage) {
    if (typeof childMessage.id !== "string" || !childMessage.id
        || pendingRequestIds.has(childMessage.id)) {
        throw new TypeError("sandbox reused or omitted a request id");
    }
    if (pendingRequestIds.size >= MAX_PENDING_REQUESTS) {
        throw new RangeError(`sandbox exceeded ${MAX_PENDING_REQUESTS} pending requests`);
    }
    pendingRequestIds.add(childMessage.id);
}

function forwardAuthenticatedChildMessage(childMessage) {
    if (childMessage.type === "call") {
        if (typeof childMessage.command !== "string") throw new TypeError("sandbox RPC command is invalid");
        requireRequestId(childMessage);
        postMessage({
            type: "call",
            id: childMessage.id,
            command: childMessage.command,
            params: normalizeWorkerRpcParams(childMessage.command, childMessage.params || {}),
            eventId: Number(childMessage.eventId) || 0,
            callbackId: childMessage.callbackId,
            callbackToken: typeof childMessage.callbackToken === "string" ? childMessage.callbackToken : ""
        });
        return;
    }
    if (childMessage.type === "register") {
        requireRequestId(childMessage);
        postMessage({ type: "register", id: childMessage.id, trigger: normalizeWorkerTrigger(childMessage.trigger) });
        return;
    }
    if (childMessage.type === "eventDone") {
        postMessage({
            type: "eventDone",
            eventId: Number(childMessage.eventId) || 0,
            callbackId: Number(childMessage.callbackId) || 0,
            callbackToken: typeof childMessage.callbackToken === "string"
                ? childMessage.callbackToken.slice(0, 256) : ""
        });
        return;
    }
    if (childMessage.type === "print") {
        const values = smallValue(childMessage.values);
        if (!Array.isArray(values)) throw new TypeError("sandbox print payload is invalid");
        postMessage({ type: "print", values });
        return;
    }
    if (childMessage.type === "failed") {
        postMessage({
            type: "failed",
            phase: String(childMessage.phase || "runtime").slice(0, 128),
            error: smallValue(childMessage.error)
        });
        disposeSandbox();
        return;
    }
    if (childMessage.type === "compiled" || childMessage.type === "started") {
        postMessage({ type: childMessage.type });
        return;
    }
    childEventBusy = false;
    postMessage({ type: "eventAck" });
    pumpEventQueue();
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
                fail(new Error("sandbox Worker did not provide a valid channel token"), "child-auth");
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
            fail(new Error("sandbox Worker sent an invalid message"), "child-auth");
            disposeSandbox();
            return;
        }
        try {
            forwardAuthenticatedChildMessage(childMessage);
        } catch (error) {
            fail(error, "child-output");
            disposeSandbox();
        }
    };
    sandbox.onerror = (event) => {
        fail(new Error(String(event.message || "sandbox Worker crashed")), "runtime");
        disposeSandbox();
    };
    sandbox.onmessageerror = () => {
        fail(new Error("sandbox Worker returned an unreadable message"), "child-output");
        disposeSandbox();
    };
}

onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "shutdown") {
        shutdown(message.requestId);
        return;
    }
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
