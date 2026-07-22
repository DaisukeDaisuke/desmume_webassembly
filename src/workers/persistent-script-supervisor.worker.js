"use strict";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let started = false;
const pendingRequestIds = new Set();

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

function startSandbox(message) {
    if (started || typeof message.code !== "string" || typeof message.sandboxSource !== "string") {
        fail(new Error("one start message with string code and sandbox source is required"));
        return;
    }
    started = true;
    try {
        sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
        sandbox = new Worker(sandboxUrl);
    } catch (error) {
        fail(error, "startup");
        disposeSandbox();
        return;
    }
    sandbox.onmessage = (event) => {
        const childMessage = event.data || {};
        if (!channelToken) {
            if (childMessage.type !== "ready" || typeof childMessage.channelToken !== "string") {
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
            || !["call", "register", "eventDone", "print", "compiled", "started", "failed"].includes(childMessage.type)) {
            fail(new Error("sandbox Worker sent an invalid message"));
            disposeSandbox();
            return;
        }
        if ((childMessage.type === "call" || childMessage.type === "register")
            && typeof childMessage.id === "string") {
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
        sandbox.postMessage(message);
        return;
    }
    fail(new Error("unknown supervisor message"));
};

postMessage({ type: "ready" });
