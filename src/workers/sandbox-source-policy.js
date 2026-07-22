import { parse } from "acorn";

export function assertSandboxSource(source) {
    const ast = parse(`async function __desmumeSandbox__(){\n${String(source)}\n}`, {
        ecmaVersion: "latest",
        sourceType: "script"
    });
    const pending = [ast];
    const seen = new Set();
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        if (node.type === "ImportExpression") {
            throw new SyntaxError("dynamic import is unavailable in isolated scripts");
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === "object") pending.push(value);
        }
    }
}
