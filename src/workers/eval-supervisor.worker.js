"use strict";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let started = false;
const pendingRequestIds = new Set();
const MAX_PENDING_REQUESTS = 32;

function assertBoundedRpc(message) {
    if (!message || typeof message.command !== "string" || !message.params
        || typeof message.params !== "object" || Array.isArray(message.params)) {
        throw new TypeError("sandbox RPC shape is invalid");
    }
    const byteLimit = message.command === "injectBytes" ? 1024 * 1024
        : message.command === "disassembleBytes" ? 64 * 1024 : 0;
    const stack = [{ value: message.params, depth: 0, path: "" }];
    const seen = new Set();
    let nodes = 0;
    let bytes = 0;
    while (stack.length) {
        const { value, depth, path } = stack.pop();
        if (++nodes > (byteLimit || 4096) + 4096 || depth > 10) throw new RangeError("sandbox RPC exceeds structural limits");
        if (value === null || typeof value === "boolean") { bytes += 4; continue; }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new TypeError("sandbox RPC number is invalid");
            bytes += 16;
            continue;
        }
        if (typeof value === "string") { bytes += value.length * 3; continue; }
        if (typeof value !== "object" || seen.has(value)) throw new TypeError("sandbox RPC value is invalid");
        if (value instanceof Uint8Array && path === "bytes" && byteLimit) {
            if (value.byteLength > byteLimit) throw new RangeError("sandbox RPC byte input exceeds command budget");
            bytes += value.byteLength;
            if (bytes > byteLimit + 64 * 1024) throw new RangeError("sandbox RPC exceeds byte budget");
            continue;
        }
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new TypeError("sandbox RPC binary type is invalid");
        seen.add(value);
        const prototype = Object.getPrototypeOf(value);
        if (Array.isArray(value)) {
            const maximum = path === "bytes" && byteLimit ? byteLimit : 1024;
            if (value.length > maximum) throw new RangeError("sandbox RPC array exceeds item budget");
            if (path === "bytes" && byteLimit) {
                for (const byte of value) {
                    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new TypeError("sandbox RPC byte array is invalid");
                }
                bytes += value.length;
                if (bytes > byteLimit + 64 * 1024) throw new RangeError("sandbox RPC exceeds byte budget");
                continue;
            }
            for (let index = 0; index < value.length; index++) {
                stack.push({ value: value[index], depth: depth + 1, path: `${path}[${index}]` });
            }
        } else {
            if (prototype !== Object.prototype && prototype !== null) throw new TypeError("sandbox RPC object is invalid");
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const keys = Object.keys(descriptors);
            if (keys.length > 128) throw new RangeError("sandbox RPC object exceeds property budget");
            for (const key of keys) {
                if (!("value" in descriptors[key])) throw new TypeError("sandbox RPC accessor is invalid");
                bytes += key.length * 3;
                stack.push({ value: descriptors[key].value, depth: depth + 1, path: path ? `${path}.${key}` : key });
            }
        }
        if (bytes > (byteLimit ? byteLimit + 64 * 1024 : 256 * 1024)) throw new RangeError("sandbox RPC exceeds byte budget");
    }
}

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
            || typeof message.sandboxSource !== "string"
            || typeof message.dependency?.source !== "string") {
            protocolError("one run message with code, sandbox source, and fixed dependency is required");
            return;
        }
        started = true;
        try {
            sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
            sandbox = new Worker(sandboxUrl);
            sandbox.postMessage({ type: "initialize", dependency: message.dependency });
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
                    || typeof childMessage.channelToken !== "string"
                    || childMessage.dependencyHash !== message.dependency.sha256) {
                    protocolError("sandbox Worker did not provide a valid channel token");
                    disposeSandbox();
                    return;
                }
                channelToken = childMessage.channelToken;
                if (message.securityProbe) {
                    sandbox.postMessage({ type: "securityProbe", probe: message.securityProbe });
                    return;
                }
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
                try {
                    assertBoundedRpc(childMessage);
                } catch (error) {
                    protocolError(String(error?.message || error));
                    disposeSandbox();
                    return;
                }
                if (typeof childMessage.id !== "string" || !childMessage.id
                    || pendingRequestIds.has(childMessage.id)
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
