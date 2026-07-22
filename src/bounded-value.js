const DEFAULTS = Object.freeze({ maxDepth: 12, maxNodes: 2000, maxBytes: 256 * 1024, maxArray: 256 });

export function normalizeBoundedValue(value, options = {}) {
    const limits = { ...DEFAULTS, ...options };
    const seen = new Set();
    let nodes = 0;
    let bytes = 0;
    const encoder = new TextEncoder();
    const charge = (text) => {
        bytes += encoder.encode(String(text)).byteLength;
        if (bytes > limits.maxBytes) throw new RangeError("structured value exceeds byte budget");
    };
    const visit = (input, depth) => {
        if (++nodes > limits.maxNodes) throw new RangeError("structured value exceeds node budget");
        if (depth > limits.maxDepth) throw new RangeError("structured value exceeds depth budget");
        if (input === null) { charge("null"); return null; }
        if (typeof input === "boolean") { charge(input); return input; }
        if (typeof input === "number") {
            if (!Number.isFinite(input)) throw new TypeError("structured numbers must be finite");
            charge(input); return input;
        }
        if (typeof input === "string") { charge(input); return input; }
        if (typeof input !== "object") throw new TypeError(`unsupported structured value: ${typeof input}`);
        if (seen.has(input)) throw new TypeError("cyclic structured values are unavailable");
        seen.add(input);
        try {
            if (Array.isArray(input)) {
                if (input.length > limits.maxArray) throw new RangeError("structured array exceeds item budget");
                return input.map((item) => visit(item, depth + 1));
            }
            const prototype = Object.getPrototypeOf(input);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError("only plain structured objects are available");
            }
            const entries = Object.entries(input);
            if (entries.length > limits.maxArray) throw new RangeError("structured object exceeds property budget");
            const output = {};
            for (const [key, item] of entries) {
                charge(key);
                output[key] = visit(item, depth + 1);
            }
            return output;
        } finally {
            seen.delete(input);
        }
    };
    return { value: visit(value, 0), bytes, nodes };
}
