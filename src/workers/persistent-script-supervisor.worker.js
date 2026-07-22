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
