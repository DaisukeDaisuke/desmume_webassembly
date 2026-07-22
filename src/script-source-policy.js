import { parse } from "acorn";
import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

const WRAPPER_PREFIX = "async function __desmumeScript__(){\n";
const WRAPPER_SUFFIX = "\n}";

function parseScriptBody(source) {
    return parse(`${WRAPPER_PREFIX}${String(source)}${WRAPPER_SUFFIX}`, {
        ecmaVersion: "latest",
        sourceType: "script"
    });
}

function astContainsImportExpression(ast) {
    const pending = [ast];
    const seen = new Set();
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        if (node.type === "ImportExpression") return true;
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
            } else if (value && typeof value === "object") {
                pending.push(value);
            }
        }
    }
    return false;
}

export function containsDynamicImport(source) {
    return astContainsImportExpression(parseScriptBody(source));
}

export function assertSafeScriptSource(source) {
    let containsImport;
    try {
        containsImport = containsDynamicImport(source);
    } catch (error) {
        throw codedError(
            ErrorCode.SCRIPT_SOURCE_INVALID,
            `Script source could not be parsed: ${String(error?.message || error)}`,
            { parser: "acorn", version: "8.17.0" }
        );
    }
    if (containsImport) {
        throw codedError(
            ErrorCode.SCRIPT_SOURCE_INVALID,
            "dynamic import is unavailable in isolated scripts",
            { parser: "acorn", version: "8.17.0" }
        );
    }
}
