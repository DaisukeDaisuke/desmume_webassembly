const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 10,
    maxNodes: 4096,
    maxProperties: 128,
    maxArrayItems: 1024,
    maxBytes: 256 * 1024
});

const BYTE_COMMAND_LIMITS = Object.freeze({
    injectBytes: 1024 * 1024,
    disassembleBytes: 64 * 1024
});

function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function byteLength(text) {
    return new TextEncoder().encode(String(text)).byteLength;
}

export function normalizeWorkerProtocolValue(value, options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options };
    const seen = new Set();
    let nodes = 0;
    let bytes = 0;
    const charge = (valueToCharge) => {
        bytes += byteLength(valueToCharge);
        if (bytes > limits.maxBytes) throw new RangeError("Worker RPC value exceeds byte budget");
    };
    const visit = (input, depth, path) => {
        if (++nodes > limits.maxNodes) throw new RangeError("Worker RPC value exceeds node budget");
        if (depth > limits.maxDepth) throw new RangeError("Worker RPC value exceeds depth budget");
        if (input === null) { charge("null"); return null; }
        if (typeof input === "boolean") { charge(input); return input; }
        if (typeof input === "number") {
            if (!Number.isFinite(input)) throw new TypeError("Worker RPC numbers must be finite");
            charge(input);
            return input;
        }
        if (typeof input === "string") { charge(input); return input; }
        if (typeof input !== "object") throw new TypeError(`unsupported Worker RPC value: ${typeof input}`);
        if (seen.has(input)) throw new TypeError("cyclic Worker RPC values are unavailable");
        if (input instanceof Uint8Array && options.byteField === path) {
            if (input.byteLength > options.maxByteInput) throw new RangeError("Worker RPC byte input exceeds command budget");
            bytes += input.byteLength;
            if (bytes > limits.maxBytes) throw new RangeError("Worker RPC value exceeds byte budget");
            return input.slice();
        }
        if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
            throw new TypeError("binary Worker RPC values are only available in a bounded byte field");
        }
        seen.add(input);
        try {
            if (Array.isArray(input)) {
                const byteArray = options.byteField === path;
                const maximum = byteArray ? options.maxByteInput : limits.maxArrayItems;
                if (input.length > maximum) throw new RangeError("Worker RPC array exceeds item budget");
                if (byteArray) {
                    const output = new Array(input.length);
                    for (let index = 0; index < input.length; index++) {
                        const item = input[index];
                        if (!Number.isInteger(item) || item < 0 || item > 255) {
                            throw new TypeError("Worker RPC byte arrays require integers from 0 through 255");
                        }
                        output[index] = item;
                    }
                    bytes += input.length;
                    if (bytes > limits.maxBytes) throw new RangeError("Worker RPC value exceeds byte budget");
                    return output;
                }
                return input.map((item, index) => visit(item, depth + 1, `${path}[${index}]`));
            }
            if (!isPlainRecord(input)) throw new TypeError("only plain Worker RPC objects are available");
            const descriptors = Object.getOwnPropertyDescriptors(input);
            const keys = Object.keys(descriptors);
            if (keys.length > limits.maxProperties) throw new RangeError("Worker RPC object exceeds property budget");
            const output = {};
            for (const key of keys) {
                const descriptor = descriptors[key];
                if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
                    throw new TypeError("Worker RPC accessors are unavailable");
                }
                charge(key);
                output[key] = visit(descriptor.value, depth + 1, path ? `${path}.${key}` : key);
            }
            return output;
        } finally {
            seen.delete(input);
        }
    };
    return { value: visit(value, 0, ""), bytes, nodes };
}

export function normalizeWorkerRpcParams(command, params = {}) {
    const maxByteInput = BYTE_COMMAND_LIMITS[command] || 0;
    return normalizeWorkerProtocolValue(params, {
        byteField: maxByteInput ? "bytes" : "",
        maxByteInput,
        maxArrayItems: maxByteInput || DEFAULT_LIMITS.maxArrayItems,
        maxBytes: maxByteInput ? maxByteInput + 64 * 1024 : DEFAULT_LIMITS.maxBytes,
        maxNodes: maxByteInput ? maxByteInput + DEFAULT_LIMITS.maxNodes : DEFAULT_LIMITS.maxNodes
    }).value;
}

export function normalizeWorkerTrigger(trigger) {
    return normalizeWorkerProtocolValue(trigger, { maxBytes: 64 * 1024, maxArrayItems: 256 }).value;
}
