import { ErrorCode } from "../error-codes.js";
import { codedError, isPlainObject } from "../validation.js";
import { ResourceLimits } from "../resource-limits.js";
import { normalizeBoundedValue } from "../bounded-value.js";

export function createScriptCommands({
    state,
    ui,
    startPersistentScript,
    stopPersistentScript,
    scriptSummary,
    renderScriptConsole,
    runSandboxBoundarySelfTest,
    runIsolatedScript,
    runCommand
}) {
    async function runPersistentScript(params = {}) {
        return startPersistentScript(params);
    }

    async function listScripts() {
        return { scripts: [...state.scripts.values()].map((script) => scriptSummary(script)) };
    }

    async function stopScript(params = {}) {
        return stopPersistentScript(params);
    }

    async function restartScript(params = {}) {
        const script = state.scripts.get(Number(params.id ?? state.activeScriptId));
        if (!script) throw new Error("script not found");
        const next = { name: script.name, code: script.code, asyncMode: script.asyncMode };
        await stopPersistentScript({ id: script.id });
        state.scripts.delete(script.id);
        return startPersistentScript(next);
    }

    async function getScript(params = {}) {
        const script = state.scripts.get(Number(params.id ?? state.activeScriptId));
        if (!script) throw new Error("script not found");
        const pattern = params.pattern ?? params.regex;
        if (pattern != null || params.flags != null) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "getScript regular-expression search is unavailable; retrieve the bounded source instead"
            );
        }
        const originalChars = script.code.length;
        const code = script.code.slice(0, ResourceLimits.scriptSourceOutputChars);
        return {
            id: script.id,
            name: script.name,
            code,
            truncated: code.length !== originalChars,
            originalChars
        };
    }

    async function listScriptPrint(params = {}) {
        const max = Math.max(1, Math.min(1000, Number(params.max ?? 10)));
        const scripts = params.id == null
            ? [...state.scripts.values()]
            : [state.scripts.get(Number(params.id))].filter(Boolean);
        return {
            logs: scripts.flatMap((script) => script.output.slice(-max).map((text) => ({
                id: script.id,
                name: script.name,
                text
            }))).slice(-max)
        };
    }

    async function clearScriptPrint(params = {}) {
        const scripts = params.id == null
            ? [...state.scripts.values()]
            : [state.scripts.get(Number(params.id))].filter(Boolean);
        scripts.forEach((script) => {
            script.output = [];
        });
        renderScriptConsole();
        return { ok: true, cleared: scripts.map((script) => script.id) };
    }

    async function evaluate(params = {}) {
        return runIsolatedScript(String(params.code ?? ""), Number(params.timeoutMs ?? 3000));
    }

    async function runScript(params = {}) {
        return evaluate(params);
    }

    async function sandboxBoundarySelfTest(params = {}) {
        if (Object.keys(params).length) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "runSandboxBoundarySelfTest accepts no parameters");
        }
        return runSandboxBoundarySelfTest();
    }

    async function injectScript(params = {}) {
        return runIsolatedScript(
            String(params.code ?? ui.scriptCode.value),
            Number(params.timeoutMs ?? 3000)
        );
    }

    async function batch(params = {}) {
        const items = Array.isArray(params.commands) ? params.commands : [];
        if (!items.length) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                "batch requires { commands: [...] } with at least one command"
            );
        }
        if (items.length > ResourceLimits.batchCommands) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `batch supports at most ${ResourceLimits.batchCommands} commands`,
                { maximum: ResourceLimits.batchCommands, received: items.length }
            );
        }
        const results = [];
        let resultBytes = 0;
        for (const item of items) {
            if (!isPlainObject(item)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "batch items must be plain objects");
            }
            const command = String(item.command ?? item.name ?? "");
            if (!command) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "batch item is missing command");
            }
            if (command === "batch") {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "nested batch commands are unavailable");
            }
            const rawResult = await runCommand(command, item.params || {});
            let bounded;
            try {
                bounded = normalizeBoundedValue({ command, result: rawResult }, {
                    maxBytes: ResourceLimits.batchResultBytes - resultBytes
                });
            } catch (error) {
                throw codedError(
                    ErrorCode.INVALID_ARGUMENT,
                    `batch results exceed ${ResourceLimits.batchResultBytes} bytes`,
                    { maximumBytes: ResourceLimits.batchResultBytes, completedCommands: results.length, reason: String(error?.message || error) }
                );
            }
            resultBytes += bounded.bytes;
            results.push(bounded.value);
        }
        return { results };
    }

    return Object.freeze({
        batch,
        clearScriptPrint,
        eval: evaluate,
        getScript,
        injectScript,
        listScriptPrint,
        listScripts,
        restartScript,
        runSandboxBoundarySelfTest: sandboxBoundarySelfTest,
        runPersistentScript,
        runScript,
        stopScript
    });
}
