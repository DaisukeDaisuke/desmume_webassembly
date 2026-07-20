export function createScriptCommands({
    state,
    ui,
    startPersistentScript,
    stopPersistentScript,
    scriptSummary,
    renderScriptConsole,
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
        if (!pattern) return { id: script.id, name: script.name, code: script.code };
        const regex = new RegExp(String(pattern), String(params.flags ?? "g"));
        return {
            id: script.id,
            name: script.name,
            matches: [...script.code.matchAll(regex)].map((match) => ({
                index: match.index,
                text: match[0]
            }))
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

    async function injectScript(params = {}) {
        return runIsolatedScript(
            String(params.code ?? ui.scriptCode.value),
            Number(params.timeoutMs ?? 3000)
        );
    }

    async function batch(params = {}) {
        const items = Array.isArray(params)
            ? params
            : Array.isArray(params.commands) ? params.commands : [];
        if (!items.length) throw new Error("batch requires an array or { commands: [...] }");
        const results = [];
        for (const item of items) {
            const command = String(item.command ?? item.name ?? "");
            if (!command) throw new Error("batch item is missing command");
            results.push({ command, result: await runCommand(command, item.params || {}) });
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
        runPersistentScript,
        runScript,
        stopScript
    });
}
