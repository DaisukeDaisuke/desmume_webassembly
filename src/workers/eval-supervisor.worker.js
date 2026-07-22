"use strict";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let started = false;
const pendingRequestIds = new Set();
const MAX_PENDING_REQUESTS = 32;

function protocolError(message) {
    postMessage({ type: "protocolError", message });
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

onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "run") {
        if (started
            || typeof message.code !== "string"
            || typeof message.sandboxSource !== "string") {
            protocolError("one run message with string code and sandbox source is required");
            return;
        }
        started = true;
        try {
            sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
            sandbox = new Worker(sandboxUrl);
        } catch (error) {
            protocolError(`sandbox Worker could not be started: ${String(error?.message || error)}`);
            disposeSandbox();
            return;
        }
        sandbox.onmessage = (sandboxEvent) => {
            const childMessage = sandboxEvent.data || {};
            if (!channelToken) {
                if (childMessage.type !== "ready"
                    || childMessage.hardened !== true
                    || childMessage.layer !== "sandbox"
                    || typeof childMessage.channelToken !== "string") {
                    protocolError("sandbox Worker did not provide a valid channel token");
                    disposeSandbox();
                    return;
                }
                channelToken = childMessage.channelToken;
                sandbox.postMessage({ type: "run", code: message.code, shortcuts: message.shortcuts });
                return;
            }
            if (childMessage.channelToken !== channelToken
                || !["call", "done", "error", "protocolError"].includes(childMessage.type)) {
                protocolError("sandbox Worker sent an invalid message");
                disposeSandbox();
                return;
            }
            if (childMessage.type === "call") {
                if (typeof childMessage.id !== "string"
                    || pendingRequestIds.size >= MAX_PENDING_REQUESTS) {
                    protocolError(`sandbox exceeded ${MAX_PENDING_REQUESTS} pending requests`);
                    disposeSandbox();
                    return;
                }
                pendingRequestIds.add(childMessage.id);
            }
            forwardSandboxMessage(childMessage);
            if (["done", "error", "protocolError"].includes(childMessage.type)) disposeSandbox();
        };
        sandbox.onerror = (sandboxEvent) => {
            protocolError(String(sandboxEvent.message || "sandbox Worker crashed"));
            disposeSandbox();
        };
        sandbox.onmessageerror = () => {
            protocolError("sandbox Worker returned an unreadable message");
            disposeSandbox();
        };
        return;
    }
    if (message.replyId && sandbox && channelToken
        && pendingRequestIds.delete(String(message.replyId))) {
        sandbox.postMessage(message);
        return;
    }
    protocolError("unknown supervisor message");
};

postMessage({ type: "ready", hardened: true, layer: "supervisor" });
