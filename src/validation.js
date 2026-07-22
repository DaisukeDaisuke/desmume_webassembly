import { ErrorCode } from "./error-codes.js";

export function codedError(code, message, details) {
    const error = new Error(message);
    error.mcpCode = code;
    if (details !== undefined) error.mcpDetails = details;
    return error;
}

export function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
        throw codedError(
            ErrorCode.INVALID_ARGUMENT,
            `${name} must be an integer between 1 and ${maximum}`
        );
    }
    return number;
}

export function memorySize(value, name = "size") {
    const size = Number(value);
    if (![1, 2, 4].includes(size)) {
        throw codedError(ErrorCode.INVALID_ARGUMENT, `${name} must be 1, 2, or 4`);
    }
    return size;
}

export function subscribeAbort(signal, onAbort) {
    if (!signal) return () => {};
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        onAbort();
        return () => {};
    }
    return () => signal.removeEventListener("abort", onAbort);
}
