import { normalizeTrustedValue } from "./trusted-value-normalizer.js";

const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 10,
    maxNodes: 4096,
    maxProperties: 128,
    maxArray: 1024,
    maxBytes: 256 * 1024
});

export const WorkerByteLimits = Object.freeze({
    injectBytes: Object.freeze({ decodedBytes: 1024 * 1024 }),
    disassembleBytes: Object.freeze({ decodedBytes: 64 * 1024, opcodeWords: 16 * 1024 })
});

const BYTE_COMMAND_SCHEMAS = Object.freeze({
    injectBytes: Object.freeze({
        maxBytes: 3 * 1024 * 1024 + 64 * 1024,
        specialArrays: Object.freeze({ bytes: Object.freeze({ kind: "byte", maxItems: 1024 * 1024 }) }),
        stringLimits: Object.freeze({
            base64: 1398104,
            hex: 3 * 1024 * 1024,
            input: 3 * 1024 * 1024,
            text: 3 * 1024 * 1024
        })
    }),
    disassembleBytes: Object.freeze({
        maxBytes: 256 * 1024,
        specialArrays: Object.freeze({
            bytes: Object.freeze({ kind: "byte", maxItems: 64 * 1024 }),
            words: Object.freeze({ kind: "uint32", maxItems: 16 * 1024 }),
            opcodes: Object.freeze({ kind: "uint32", maxItems: 16 * 1024 })
        }),
        stringLimits: Object.freeze({
            base64: 87384,
            hex: 192 * 1024,
            input: 192 * 1024,
            text: 192 * 1024,
            opcodes: 192 * 1024
        })
    })
});

export function normalizeWorkerProtocolValue(value, options = {}) {
    return normalizeTrustedValue(value, {
        ...DEFAULT_LIMITS,
        ...options,
        maxArray: options.maxArray ?? options.maxArrayItems ?? DEFAULT_LIMITS.maxArray
    });
}

export function normalizeWorkerRpcParams(command, params = {}) {
    const schema = BYTE_COMMAND_SCHEMAS[command];
    return normalizeWorkerProtocolValue(params, schema || {}).value;
}

export function normalizeWorkerTrigger(trigger) {
    return normalizeWorkerProtocolValue(trigger, { maxBytes: 64 * 1024, maxArray: 256 }).value;
}
