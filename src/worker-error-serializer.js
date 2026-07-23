import { readOwnDataProperty } from "./trusted-value-normalizer.js";

const NativeString = globalThis.String;
const NativeNumber = globalThis.Number;
const NativeError = globalThis.Error;
const NativeEvalError = globalThis.EvalError;
const NativeRangeError = globalThis.RangeError;
const NativeReferenceError = globalThis.ReferenceError;
const NativeSyntaxError = globalThis.SyntaxError;
const NativeTypeError = globalThis.TypeError;
const NativeURIError = globalThis.URIError;
const NativeTextEncoder = globalThis.TextEncoder;
const nativeReflectApply = globalThis.Reflect.apply;
const nativeGetPrototypeOf = globalThis.Object.getPrototypeOf;
const nativeStringSlice = NativeString.prototype.slice;
const nativeStringSplit = NativeString.prototype.split;
const nativeStringJoin = globalThis.Array.prototype.join;
const nativeArraySlice = globalThis.Array.prototype.slice;
const nativeMathFloor = globalThis.Math.floor;
const nativeMathMax = globalThis.Math.max;
const nativeTextEncode = NativeTextEncoder.prototype.encode;
const nativeTypedArrayByteLength = nativeReflectApply(globalThis.Object.getOwnPropertyDescriptor, null, [
    nativeReflectApply(globalThis.Object.getPrototypeOf, null, [globalThis.Uint8Array.prototype]),
    "byteLength"
]).get;
const trustedTextEncoder = new NativeTextEncoder();
const nativeErrorPrototypes = new Map([
    [NativeError.prototype, "Error"],
    [NativeEvalError.prototype, "EvalError"],
    [NativeRangeError.prototype, "RangeError"],
    [NativeReferenceError.prototype, "ReferenceError"],
    [NativeSyntaxError.prototype, "SyntaxError"],
    [NativeTypeError.prototype, "TypeError"],
    [NativeURIError.prototype, "URIError"]
]);

function callIntrinsic(fn, receiver, args) {
    return nativeReflectApply(fn, receiver, args);
}

function utf8Length(text) {
    const encoded = callIntrinsic(nativeTextEncode, trustedTextEncoder, [text]);
    return callIntrinsic(nativeTypedArrayByteLength, encoded, []);
}

function primitiveToString(value) {
    if (value === undefined) return "";
    if (value === null) return "null";
    const type = typeof value;
    if (type === "string") return value;
    if (type === "number" || type === "boolean" || type === "bigint" || type === "symbol") {
        return NativeString(value);
    }
    return "";
}

function truncateUtf8(text, maxBytes) {
    if (utf8Length(text) <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = nativeMathFloor((low + high + 1) / 2);
        const candidate = callIntrinsic(nativeStringSlice, text, [0, mid]);
        if (utf8Length(candidate) <= maxBytes) low = mid;
        else high = mid - 1;
    }
    return callIntrinsic(nativeStringSlice, text, [0, low]);
}

function ownPrimitiveString(object, key) {
    return primitiveToString(readOwnDataProperty(object, key));
}

function nativeErrorName(error) {
    let current = error;
    for (let depth = 0; current && depth < 4; depth++) {
        current = callIntrinsic(nativeGetPrototypeOf, null, [current]);
        const name = nativeErrorPrototypes.get(current);
        if (name) return name;
    }
    return "";
}

function stackLines(stack) {
    const lines = callIntrinsic(nativeStringSplit, stack, ["\n"]);
    return callIntrinsic(nativeStringJoin, callIntrinsic(nativeArraySlice, lines, [0, 12]), ["\n"]);
}

export function serializeWorkerError(error, {
    phase = "runtime",
    code = "",
    source = "",
    nameBytes = 256,
    messageBytes = 2048,
    stackBytes = 8192,
    sourceExcerptBytes = 4096
} = {}) {
    try {
        const primitive = primitiveToString(error);
        const name = truncateUtf8(ownPrimitiveString(error, "name") || nativeErrorName(error) || "Error", nameBytes);
        const message = truncateUtf8(ownPrimitiveString(error, "message") || primitive || "Script execution failed", messageBytes);
        const stack = truncateUtf8(stackLines(ownPrimitiveString(error, "stack")), stackBytes);
        const details = { phase: truncateUtf8(primitiveToString(phase) || "runtime", 128), errorName: name };
        if (stack) details.stack = stack;
        const match = /desmume-eval-user\.js:(\d+):(\d+)/.exec(stack);
        if (match) {
            const line = nativeMathMax(1, NativeNumber(match[1]) - 1);
            details.line = line;
            details.column = NativeNumber(match[2]);
            const sourceLines = callIntrinsic(nativeStringSplit, primitiveToString(source), ["\n"]);
            details.sourceExcerpt = truncateUtf8(sourceLines[line - 1] || "", sourceExcerptBytes);
        }
        if (code) details.code = truncateUtf8(primitiveToString(code), 128);
        return { name, message, details };
    } catch {
        return {
            name: "Error",
            message: "Script error could not be serialized safely",
            details: { phase: "serialization", errorName: "Error" }
        };
    }
}
