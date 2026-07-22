import { codedError, positiveInteger } from "../validation.js";
import { ErrorCode } from "../error-codes.js";

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
    function nonNegativeNumber(value, name, maximum = 600000) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > maximum) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${name} must be between 0 and ${maximum}`);
        }
        return number;
    }

    async function setInput(params) {
        const [button] = toButtonList(params);
        setKey(button, !!params.pressed);
        return { keys: state.keys };
    }

    async function runInputHold(params = {}) {
        ensureRomLoaded("input hold requires a loaded ROM");
        const buttons = toButtonList(params);
        const durationMs = nonNegativeNumber(params.durationMs ?? params.holdMs ?? 0, "durationMs");
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
        const repeat = positiveInteger(params.repeat ?? params.count ?? 1, "repeat", 10000);
        const holdMs = nonNegativeNumber(params.holdMs ?? params.pressMs ?? 50, "holdMs");
        const gapMs = nonNegativeNumber(params.gapMs ?? params.waitMs ?? 50, "gapMs");
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
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isInteger(x) || x < 0 || x > 255 || !Number.isInteger(y) || y < 0 || y > 191) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "x must be 0..255 and y must be 0..191 integers");
        }
        const durationMs = nonNegativeNumber(params.durationMs ?? params.holdMs ?? 0, "durationMs");
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
        const [button] = toButtonList(params);
        const key = String(params.key || "").trim();
        if (!key) throw codedError(ErrorCode.INVALID_ARGUMENT, "key is required");
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
