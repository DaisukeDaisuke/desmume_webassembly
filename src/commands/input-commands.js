export function createInputCommands({
    state,
    ensureRomLoaded,
    renderHotkey,
    saveKeymap,
    setKey,
    setTouchState,
    toButtonList,
    waitChecked
}) {
    async function setInput(params) {
        setKey(params.button, !!params.pressed);
        return { keys: state.keys };
    }

    async function runInputHold(params = {}) {
        ensureRomLoaded("input hold requires a loaded ROM");
        const buttons = toButtonList(params);
        const durationMs = Math.max(0, Number(params.durationMs ?? params.holdMs ?? 0));
        const deadline = params.timeoutMs
            ? performance.now() + Math.max(1, Number(params.timeoutMs))
            : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runInputHold");
        buttons.forEach((button) => setKey(button, true));
        try {
            await waitChecked(durationMs, deadline, "runInputHold");
        } finally {
            buttons.forEach((button) => setKey(button, false));
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runInputHold");
        return { ok: true, buttons, durationMs };
    }

    async function runInputTap(params = {}) {
        ensureRomLoaded("input tap requires a loaded ROM");
        const buttons = toButtonList(params);
        const repeat = Math.max(1, Number(params.repeat ?? params.count ?? 1));
        const holdMs = Math.max(0, Number(params.holdMs ?? params.pressMs ?? 50));
        const gapMs = Math.max(0, Number(params.gapMs ?? params.waitMs ?? 50));
        const deadline = params.timeoutMs
            ? performance.now() + Math.max(1, Number(params.timeoutMs))
            : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runInputTap");
        for (let index = 0; index < repeat; index++) {
            buttons.forEach((button) => setKey(button, true));
            try {
                await waitChecked(holdMs, deadline, "runInputTap");
            } finally {
                buttons.forEach((button) => setKey(button, false));
            }
            if (index < repeat - 1) await waitChecked(gapMs, deadline, "runInputTap");
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runInputTap");
        return { ok: true, buttons, repeat, holdMs, gapMs };
    }

    async function runTouchHold(params = {}) {
        ensureRomLoaded("touch hold requires a loaded ROM");
        const x = Math.max(0, Math.min(255, Number(params.x)));
        const y = Math.max(0, Math.min(191, Number(params.y)));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required");
        const durationMs = Math.max(0, Number(params.durationMs ?? params.holdMs ?? 0));
        const deadline = params.timeoutMs
            ? performance.now() + Math.max(1, Number(params.timeoutMs))
            : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runTouchHold");
        setTouchState(true, x, y);
        try {
            await waitChecked(durationMs, deadline, "runTouchHold");
        } finally {
            setTouchState(false, x, y);
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runTouchHold");
        return { ok: true, x, y, durationMs };
    }

    async function setKeyBinding(params) {
        const button = String(params.button);
        const key = String(params.key || "").trim();
        if (state.buttons[button] === undefined) throw new Error(`unknown button: ${button}`);
        if (!key) throw new Error("key is required");
        for (const [code, mapped] of Object.entries(state.keymap)) {
            if (mapped === button || code === key) delete state.keymap[code];
        }
        state.keymap[key] = button;
        saveKeymap();
        renderHotkey();
        return { keymap: state.keymap };
    }

    return Object.freeze({
        runInputHold,
        runInputTap,
        runTouchHold,
        setInput,
        setKeyBinding
    });
}
