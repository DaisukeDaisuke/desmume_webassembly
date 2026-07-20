import { ErrorCode } from "./error-codes.js";

export function createMcpResponder({ logger = console, pauseSafely = () => {} } = {}) {
    function fail(code, message, details) {
        return {
            ok: false,
            error: {
                code,
                message,
                recoverable: true,
                ...(details === undefined ? {} : { details })
            }
        };
    }

    function ok(data = {}) {
        if (Object.prototype.hasOwnProperty.call(data, "ok")) {
            return fail(ErrorCode.INTERNAL_ERROR, "Result data must not override ok");
        }
        return { ok: true, ...data };
    }

    function normalizeResult(result) {
        if (result && typeof result === "object" && typeof result.ok === "boolean") {
            if (result.ok) return result;
            if (typeof result.error?.code === "string"
                && typeof result.error?.message === "string") {
                return result;
            }
            return fail(
                ErrorCode.INTERNAL_ERROR,
                "Command returned an invalid failure result",
                { result }
            );
        }
        return ok(result && typeof result === "object" ? result : { value: result });
    }

    function classify(error) {
        if (error?.mcpCode) return error.mcpCode;
        const text = String(error?.message || error || "").toLowerCase();
        if (text.includes("wasm is not ready") || text.includes("desmume.js is not loaded")) {
            return ErrorCode.WASM_NOT_READY;
        }
        if (text.includes("rom")
            && (text.includes("not loaded") || text.includes("requires a loaded"))) {
            return ErrorCode.ROM_NOT_LOADED;
        }
        if (text.includes("state")
            && (text.includes("not found") || text.includes("empty") || text.includes("not loaded"))) {
            return ErrorCode.STATE_NOT_LOADED;
        }
        if (text.includes("breakpoint not found")) return ErrorCode.BREAKPOINT_NOT_FOUND;
        if (text.includes("timeout")) return ErrorCode.TIMEOUT;
        if (text.includes("unknown command")) return ErrorCode.UNKNOWN_COMMAND;
        if (text.includes("native fault")) return ErrorCode.NATIVE_FAULT;
        if (text.includes("is required")
            || text.includes("invalid")
            || text.includes("must be")
            || text.includes("unknown button")
            || text.includes("unknown register")
            || text.includes("out of range")) {
            return ErrorCode.INVALID_ARGUMENT;
        }
        return ErrorCode.INTERNAL_ERROR;
    }

    async function runSafely(name, task) {
        try {
            return normalizeResult(await task());
        } catch (error) {
            logger.error?.(name, error);
            const code = classify(error);
            if (code === ErrorCode.INTERNAL_ERROR || code === ErrorCode.NATIVE_FAULT) {
                pauseSafely();
            }
            return fail(
                code,
                code === ErrorCode.INTERNAL_ERROR
                    ? `${name} failed internally`
                    : String(error?.message || error),
                error?.mcpDetails
            );
        }
    }

    function formatCompact(result) {
        if (result?.ok === false) {
            const normalized = normalizeResult(result);
            return `ok=false\nerror.code=${normalized.error.code}\nerror.message=${normalized.error.message}`;
        }
        if (!result || Object.keys(result).length <= 1) return "ok=true";
        const fields = Object.entries(result)
            .filter(([key]) => key !== "ok")
            .slice(0, 12)
            .map(([key, value]) => (
                `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`
            ));
        return `ok=true\n${fields.join("\n")}`;
    }

    function toWebMcpContent(result, compactFormatter = formatCompact) {
        return {
            content: [{ type: "text", text: compactFormatter(result) }],
            structuredContent: result
        };
    }

    return { ok, fail, normalizeResult, runSafely, toWebMcpContent, formatCompact };
}
