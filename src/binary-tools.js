export function createBinaryTools({ getPc, getSelectedCpu }) {
    function parseNumber(value, fallback = 0) {
        if (typeof value === "number") return value;
        if (value === "pc") return getPc();
        const text = String(value ?? "").trim();
        if (!text) return fallback;
        return Number(text.startsWith("0x") ? parseInt(text, 16) : parseInt(text, 10));
    }

    function parseAddress(value, fallback = 0, cpu = getSelectedCpu()) {
        if (typeof value === "number") return value >>> 0;
        const text = String(value ?? "").trim().toLowerCase();
        if (!text) return fallback >>> 0;
        if (text === "pc") return getPc(cpu);
        return parseInt(text.replace(/^0x/, ""), 16) >>> 0;
    }

    function bytesFromParams(params = {}) {
        if (params.bytes) return new Uint8Array(params.bytes);
        if (params.base64) {
            const raw = atob(String(params.base64));
            const bytes = new Uint8Array(raw.length);
            for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
            return bytes;
        }
        throw new Error("bytes or base64 is required");
    }

    function parseHexToken(token) {
        const text = String(token ?? "").trim().replace(/^0x/i, "");
        if (!/^[0-9a-f]+$/i.test(text)) throw new Error(`invalid hex token: ${token}`);
        return parseInt(text, 16);
    }

    function bytesFromFlexibleParams(params = {}) {
        if (params.bytes) {
            return new Uint8Array(params.bytes.map((value) => (
                typeof value === "number" ? value & 0xff : parseHexToken(value) & 0xff
            )));
        }
        if (params.base64) return bytesFromParams(params);
        const text = String(params.hex ?? params.input ?? params.text ?? "").trim();
        if (!text) throw new Error("bytes, base64, hex, input, or text is required");
        const clean = text.replace(/[,;\n\r\t]+/g, " ").trim();
        const tokens = clean ? clean.split(/\s+/) : [];
        if (tokens.length > 1) {
            return new Uint8Array(tokens.map((token) => parseHexToken(token) & 0xff));
        }
        const one = tokens[0].replace(/^0x/i, "");
        if (!/^[0-9a-f]+$/i.test(one) || one.length % 2) {
            throw new Error("hex byte text must contain complete bytes");
        }
        const bytes = new Uint8Array(one.length / 2);
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = parseInt(one.slice(index * 2, index * 2 + 2), 16);
        }
        return bytes;
    }

    function opcodeWordsFromInput(params = {}) {
        if (params.words) {
            return params.words.map((value) => (
                typeof value === "number" ? value >>> 0 : parseHexToken(value) >>> 0
            ));
        }
        const text = String(params.input ?? params.text ?? params.opcodes ?? "").trim();
        if (!text) return null;
        const tokens = text.replace(/[,;\n\r\t]+/g, " ").trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return null;
        const explicitWords = params.inputMode === "words"
            || params.format === "words"
            || tokens.some((token) => {
                const raw = token.replace(/^0x/i, "");
                const parsed = /^[0-9a-f]+$/i.test(raw) ? parseHexToken(token) : parseNumber(token);
                return /^0x/i.test(token) && parsed > 0xff;
            });
        return explicitWords ? tokens.map((token) => parseHexToken(token) >>> 0) : null;
    }

    function u32FromBytes(bytes, offset, endian) {
        if (endian === "big" || endian === "be") {
            return ((bytes[offset] << 24)
                | (bytes[offset + 1] << 16)
                | (bytes[offset + 2] << 8)
                | bytes[offset + 3]) >>> 0;
        }
        return (bytes[offset]
            | (bytes[offset + 1] << 8)
            | (bytes[offset + 2] << 16)
            | (bytes[offset + 3] << 24)) >>> 0;
    }

    function u16FromBytes(bytes, offset, endian) {
        if (endian === "big" || endian === "be") {
            return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
        }
        return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
    }

    function splitBinaryBits(params = {}, bits = 32) {
        if (params.bytes || params.base64 || params.hexBytes) {
            const bytes = params.hexBytes
                ? bytesFromFlexibleParams({ hex: params.hexBytes })
                : bytesFromFlexibleParams(params);
            const needed = bits / 8;
            if (bytes.length < needed) throw new Error(`binary${bits} decode requires ${needed} bytes`);
            if (bits === 32) {
                return { low: u32FromBytes(bytes, 0, String(params.endian ?? "big")), high: 0 };
            }
            const endian = String(params.endian ?? "big");
            const ordered = endian === "little" || endian === "le"
                ? [...bytes.slice(0, 8)].reverse()
                : [...bytes.slice(0, 8)];
            const raw = BigInt(`0x${ordered.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`);
            return {
                low: Number(raw & 0xffffffffn),
                high: Number((raw >> 32n) & 0xffffffffn)
            };
        }
        const text = String(params.value ?? params.bits ?? params.raw ?? params.hex ?? "").trim();
        if (!text) throw new Error("value, bits, raw, hex, bytes, or base64 is required");
        const raw = BigInt(text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`);
        return {
            low: Number(raw & 0xffffffffn),
            high: Number((raw >> 32n) & 0xffffffffn)
        };
    }

    function swap16(value) {
        const number = Number(value) & 0xffff;
        return ((number & 0xff) << 8) | ((number >>> 8) & 0xff);
    }

    function swap32(value) {
        const number = Number(value) >>> 0;
        return (((number & 0xff) << 24)
            | ((number & 0xff00) << 8)
            | ((number >>> 8) & 0xff00)
            | (number >>> 24)) >>> 0;
    }

    function bigEndianValue(value, size) {
        const parsed = parseNumber(value) >>> 0;
        return size === 4 ? swap32(parsed) : size === 2 ? swap16(parsed) : parsed & 0xff;
    }

    return Object.freeze({
        bigEndianValue,
        bytesFromFlexibleParams,
        bytesFromParams,
        opcodeWordsFromInput,
        parseAddress,
        parseHexToken,
        parseNumber,
        splitBinaryBits,
        swap16,
        swap32,
        u16FromBytes,
        u32FromBytes
    });
}
