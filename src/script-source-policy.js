import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const REGEX_PREFIX_TOKENS = new Set([
    null, "(", "[", "{", "=", ",", ":", ";", "!", "?", "&", "|",
    "+", "-", "*", "%", "^", "~", "<", ">", "return", "throw", "case",
    "delete", "void", "typeof", "new", "in", "instanceof", "yield", "await"
]);

function skipQuoted(source, index, quote) {
    for (let cursor = index + 1; cursor < source.length; cursor++) {
        if (source[cursor] === "\\") cursor++;
        else if (source[cursor] === quote) return cursor + 1;
    }
    return source.length;
}

function skipLineComment(source, index) {
    const newline = source.indexOf("\n", index + 2);
    return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source, index) {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
}

function skipRegex(source, index) {
    let inClass = false;
    for (let cursor = index + 1; cursor < source.length; cursor++) {
        const char = source[cursor];
        if (char === "\\") cursor++;
        else if (char === "[") inClass = true;
        else if (char === "]") inClass = false;
        else if (char === "/" && !inClass) {
            cursor++;
            while (IDENTIFIER_PART.test(source[cursor] || "")) cursor++;
            return cursor;
        } else if (char === "\n" || char === "\r") {
            return cursor;
        }
    }
    return source.length;
}

function skipTrivia(source, index) {
    let cursor = index;
    while (cursor < source.length) {
        if (/\s/.test(source[cursor])) {
            cursor++;
        } else if (source.startsWith("//", cursor)) {
            cursor = skipLineComment(source, cursor);
        } else if (source.startsWith("/*", cursor)) {
            cursor = skipBlockComment(source, cursor);
        } else if (source.startsWith("<!--", cursor) || source.startsWith("-->", cursor)) {
            cursor = skipLineComment(source, cursor);
        } else {
            break;
        }
    }
    return cursor;
}

function scanTemplate(source, index) {
    let cursor = index + 1;
    while (cursor < source.length) {
        if (source[cursor] === "\\") {
            cursor += 2;
        } else if (source[cursor] === "`") {
            return { found: false, index: cursor + 1 };
        } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
            const expression = scanCode(source, cursor + 2, true);
            if (expression.found) return expression;
            cursor = expression.index;
        } else {
            cursor++;
        }
    }
    return { found: false, index: source.length };
}

function scanCode(source, index = 0, stopAtBrace = false) {
    let cursor = index;
    let braceDepth = stopAtBrace ? 1 : 0;
    let previousToken = null;
    while (cursor < source.length) {
        const char = source[cursor];
        if (/\s/.test(char)) {
            cursor++;
            continue;
        }
        if (source.startsWith("//", cursor)) {
            cursor = skipLineComment(source, cursor);
            continue;
        }
        if (source.startsWith("/*", cursor)) {
            cursor = skipBlockComment(source, cursor);
            continue;
        }
        if (char === "'" || char === '"') {
            cursor = skipQuoted(source, cursor, char);
            previousToken = "value";
            continue;
        }
        if (char === "`") {
            const template = scanTemplate(source, cursor);
            if (template.found) return template;
            cursor = template.index;
            previousToken = "value";
            continue;
        }
        if (char === "/" && REGEX_PREFIX_TOKENS.has(previousToken)) {
            cursor = skipRegex(source, cursor);
            previousToken = "value";
            continue;
        }
        if (IDENTIFIER_START.test(char)) {
            let end = cursor + 1;
            while (IDENTIFIER_PART.test(source[end] || "")) end++;
            const identifier = source.slice(cursor, end);
            if (identifier === "import" && source[skipTrivia(source, end)] === "(") {
                return { found: true, index: cursor };
            }
            previousToken = identifier;
            cursor = end;
            continue;
        }
        if (stopAtBrace && char === "{") braceDepth++;
        if (stopAtBrace && char === "}" && --braceDepth === 0) {
            return { found: false, index: cursor + 1 };
        }
        previousToken = ")]".includes(char) || (char === "}" && !stopAtBrace)
            ? "value"
            : char;
        cursor++;
    }
    return { found: false, index: cursor };
}

export function containsDynamicImport(source) {
    return scanCode(String(source)).found;
}

export function assertSafeScriptSource(source) {
    if (containsDynamicImport(source)) {
        throw codedError(
            ErrorCode.SCRIPT_SOURCE_INVALID,
            "dynamic import is unavailable in isolated scripts"
        );
    }
}
