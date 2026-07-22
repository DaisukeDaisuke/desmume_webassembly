const NativeArray = globalThis.Array;
const NativeArrayBuffer = globalThis.ArrayBuffer;
const NativeUint8Array = globalThis.Uint8Array;
const NativeSet = globalThis.Set;
const NativeTextEncoder = globalThis.TextEncoder;
const NativeTypeError = globalThis.TypeError;
const NativeRangeError = globalThis.RangeError;

const nativeReflectApply = globalThis.Reflect.apply;
const nativeArrayIsArray = NativeArray.isArray;
const nativeArrayBufferIsView = NativeArrayBuffer.isView;
const nativeGetPrototypeOf = globalThis.Object.getPrototypeOf;
const nativeGetOwnPropertyDescriptor = globalThis.Object.getOwnPropertyDescriptor;
const nativeGetOwnPropertyDescriptors = globalThis.Object.getOwnPropertyDescriptors;
const nativeObjectKeys = globalThis.Object.keys;
const nativeObjectCreate = globalThis.Object.create;
const nativeDefineProperty = globalThis.Object.defineProperty;
const nativeHasOwnProperty = globalThis.Object.prototype.hasOwnProperty;
const nativeObjectPrototype = globalThis.Object.prototype;
const nativeNumberIsFinite = globalThis.Number.isFinite;
const nativeNumberIsInteger = globalThis.Number.isInteger;
const nativeSetHas = NativeSet.prototype.has;
const nativeSetAdd = NativeSet.prototype.add;
const nativeSetDelete = NativeSet.prototype.delete;
const nativeTextEncode = NativeTextEncoder.prototype.encode;
const trustedTextEncoder = new NativeTextEncoder();
const nativeUint8Prototype = NativeUint8Array.prototype;
const nativeTypedArrayPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [nativeUint8Prototype]);
const nativeTypedArrayByteLength = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeTypedArrayPrototype,
    "byteLength"
]).get;
const nativeArrayBufferByteLength = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    NativeArrayBuffer.prototype,
    "byteLength"
]).get;

const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 12,
    maxNodes: 2000,
    maxBytes: 256 * 1024,
    maxArray: 256,
    maxProperties: 256
});

function callIntrinsic(fn, receiver, args) {
    return nativeReflectApply(fn, receiver, args);
}

function hasOwn(value, key) {
    return callIntrinsic(nativeHasOwnProperty, value, [key]);
}

function utf8Length(text) {
    const encoded = callIntrinsic(nativeTextEncode, trustedTextEncoder, [text]);
    return callIntrinsic(nativeTypedArrayByteLength, encoded, []);
}

function getSpecial(options, group, path) {
    const entries = options[group];
    return entries && hasOwn(entries, path) ? entries[path] : undefined;
}

function getUint8Length(value) {
    try {
        if (callIntrinsic(nativeGetPrototypeOf, null, [value]) !== nativeUint8Prototype) return -1;
        return callIntrinsic(nativeTypedArrayByteLength, value, []);
    } catch {
        return -1;
    }
}

function isArrayBuffer(value) {
    try {
        callIntrinsic(nativeArrayBufferByteLength, value, []);
        return true;
    } catch {
        return false;
    }
}

function defineDataProperty(target, key, value) {
    callIntrinsic(nativeDefineProperty, null, [target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
    }]);
}

export function normalizeTrustedValue(value, options = {}) {
    const limits = {
        maxDepth: options.maxDepth ?? DEFAULT_LIMITS.maxDepth,
        maxNodes: options.maxNodes ?? DEFAULT_LIMITS.maxNodes,
        maxBytes: options.maxBytes ?? DEFAULT_LIMITS.maxBytes,
        maxArray: options.maxArray ?? DEFAULT_LIMITS.maxArray,
        maxProperties: options.maxProperties ?? options.maxArray ?? DEFAULT_LIMITS.maxProperties
    };
    const seen = new NativeSet();
    let nodes = 0;
    let bytes = 0;
    const chargeBytes = (amount) => {
        bytes += amount;
        if (bytes > limits.maxBytes) throw new NativeRangeError("structured value exceeds byte budget");
    };
    const visit = (input, depth, path) => {
        nodes++;
        if (nodes > limits.maxNodes) throw new NativeRangeError("structured value exceeds node budget");
        if (depth > limits.maxDepth) throw new NativeRangeError("structured value exceeds depth budget");
        if (input === null) { chargeBytes(4); return null; }
        if (typeof input === "boolean") { chargeBytes(input ? 4 : 5); return input; }
        if (typeof input === "number") {
            if (!callIntrinsic(nativeNumberIsFinite, null, [input])) {
                throw new NativeTypeError("structured numbers must be finite");
            }
            chargeBytes(16);
            return input;
        }
        if (typeof input === "string") {
            const length = utf8Length(input);
            const stringLimit = getSpecial(options, "stringLimits", path);
            if (stringLimit !== undefined && length > stringLimit) {
                throw new NativeRangeError("structured string exceeds field budget");
            }
            chargeBytes(length);
            return input;
        }
        if (typeof input !== "object") throw new NativeTypeError(`unsupported structured value: ${typeof input}`);
        if (callIntrinsic(nativeSetHas, seen, [input])) throw new NativeTypeError("cyclic structured values are unavailable");

        const specialArray = getSpecial(options, "specialArrays", path);
        const uint8Length = getUint8Length(input);
        if (uint8Length >= 0) {
            if (!specialArray || specialArray.kind !== "byte") {
                throw new NativeTypeError("binary structured values are unavailable in this field");
            }
            if (uint8Length > specialArray.maxItems) {
                throw new NativeRangeError("structured byte input exceeds field budget");
            }
            chargeBytes(uint8Length);
            const output = new NativeUint8Array(uint8Length);
            for (let index = 0; index < uint8Length; index++) output[index] = input[index];
            return output;
        }
        if (callIntrinsic(nativeArrayBufferIsView, null, [input]) || isArrayBuffer(input)) {
            throw new NativeTypeError("unsupported binary structured value");
        }

        callIntrinsic(nativeSetAdd, seen, [input]);
        try {
            if (callIntrinsic(nativeArrayIsArray, null, [input])) {
                const maximum = specialArray?.maxItems ?? limits.maxArray;
                if (input.length > maximum) throw new NativeRangeError("structured array exceeds item budget");
                const output = new NativeArray(input.length);
                if (specialArray?.kind === "byte" || specialArray?.kind === "uint32") {
                    for (let index = 0; index < input.length; index++) {
                        const indexKey = `${index}`;
                        const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [input, indexKey]);
                        if (!descriptor || !hasOwn(descriptor, "value")) {
                            throw new NativeTypeError("structured arrays must be dense data arrays");
                        }
                        const item = descriptor.value;
                        if (!callIntrinsic(nativeNumberIsInteger, null, [item])
                            || item < 0
                            || item > (specialArray.kind === "byte" ? 0xff : 0xffffffff)) {
                            throw new NativeTypeError(`structured ${specialArray.kind} array contains an invalid value`);
                        }
                        defineDataProperty(output, indexKey, item);
                    }
                    chargeBytes(input.length * (specialArray.kind === "byte" ? 1 : 4));
                    return output;
                }
                for (let index = 0; index < input.length; index++) {
                    const indexKey = `${index}`;
                    const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [input, indexKey]);
                    if (!descriptor || !hasOwn(descriptor, "value")) {
                        throw new NativeTypeError("structured arrays must be dense data arrays");
                    }
                    defineDataProperty(output, indexKey, visit(
                        descriptor.value,
                        depth + 1,
                        `${path}[${index}]`
                    ));
                }
                return output;
            }
            const prototype = callIntrinsic(nativeGetPrototypeOf, null, [input]);
            if (prototype !== nativeObjectPrototype && prototype !== null) {
                throw new NativeTypeError("only plain structured objects are available");
            }
            const descriptors = callIntrinsic(nativeGetOwnPropertyDescriptors, null, [input]);
            const keys = callIntrinsic(nativeObjectKeys, null, [descriptors]);
            if (keys.length > limits.maxProperties) {
                throw new NativeRangeError("structured object exceeds property budget");
            }
            const output = callIntrinsic(nativeObjectCreate, null, [null]);
            for (let index = 0; index < keys.length; index++) {
                const key = keys[index];
                const descriptorHolder = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [descriptors, key]);
                const descriptor = descriptorHolder.value;
                if (!hasOwn(descriptor, "value")) throw new NativeTypeError("structured accessors are unavailable");
                chargeBytes(utf8Length(key));
                defineDataProperty(output, key, visit(
                    descriptor.value,
                    depth + 1,
                    path ? `${path}.${key}` : key
                ));
            }
            return output;
        } finally {
            callIntrinsic(nativeSetDelete, seen, [input]);
        }
    };
    return { value: visit(value, 0, ""), bytes, nodes };
}

export const TrustedValueIntrinsics = Object.freeze({
    isArray: (value) => callIntrinsic(nativeArrayIsArray, null, [value]),
    isFinite: (value) => callIntrinsic(nativeNumberIsFinite, null, [value]),
    isInteger: (value) => callIntrinsic(nativeNumberIsInteger, null, [value]),
    utf8Length
});
