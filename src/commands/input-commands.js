import { codedError, nonNegativeNumber, positiveInteger } from "../validation.js";
import { ErrorCode } from "../error-codes.js";

const MAX_INPUT_WAIT_MS = 600000;

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
    function inputDeadline(params) {
        if (params.timeoutMs === undefined) return 0;
        return performance.now() + positiveInteger(params.timeoutMs, "timeoutMs", MAX_INPUT_WAIT_MS);
    }

    function validateTotalWait(totalMs, command) {
        if (!Number.isFinite(totalMs) || totalMs > MAX_INPUT_WAIT_MS) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `${command} total wait must not exceed ${MAX_INPUT_WAIT_MS}ms`
            );
        }
    }

    async function setInput(params) {
        const [button] = toButtonList(params);
        setKey(button, !!params.pressed);
        return { keys: state.keys };
    }

    async function runInputHold(params = {}) {
        ensureRomLoaded("input hold requires a loaded ROM");
        const buttons = toButtonList(params);
        const durationMs = nonNegativeNumber(
            params.durationMs ?? params.holdMs ?? 0,
            "durationMs",
            MAX_INPUT_WAIT_MS
        );
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(waitBeforeMs + durationMs + waitAfterMs, "runInputHold");
        const deadline = inputDeadline(params);
        await waitChecked(waitBeforeMs, deadline, "runInputHold");
        buttons.forEach((button) => setKey(button, true));
        try {
            await waitChecked(durationMs, deadline, "runInputHold");
        } finally {
            buttons.forEach((button) => setKey(button, false));
        }
        await waitChecked(waitAfterMs, deadline, "runInputHold");
        return { ok: true, buttons, durationMs };
    }

    async function runInputTap(params = {}) {
        ensureRomLoaded("input tap requires a loaded ROM");
        const buttons = toButtonList(params);
        const repeat = positiveInteger(params.repeat ?? params.count ?? 1, "repeat", 10000);
        const holdMs = nonNegativeNumber(params.holdMs ?? params.pressMs ?? 50, "holdMs", MAX_INPUT_WAIT_MS);
        const gapMs = nonNegativeNumber(params.gapMs ?? params.waitMs ?? 50, "gapMs", MAX_INPUT_WAIT_MS);
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(
            waitBeforeMs + (repeat * holdMs) + (Math.max(0, repeat - 1) * gapMs) + waitAfterMs,
            "runInputTap"
        );
        const deadline = inputDeadline(params);
        await waitChecked(waitBeforeMs, deadline, "runInputTap");
        for (let index = 0; index < repeat; index++) {
            buttons.forEach((button) => setKey(button, true));
            try {
                await waitChecked(holdMs, deadline, "runInputTap");
            } finally {
                buttons.forEach((button) => setKey(button, false));
            }
            if (index < repeat - 1) await waitChecked(gapMs, deadline, "runInputTap");
        }
        await waitChecked(waitAfterMs, deadline, "runInputTap");
        return { ok: true, buttons, repeat, holdMs, gapMs };
    }

    async function runTouchHold(params = {}) {
        ensureRomLoaded("touch hold requires a loaded ROM");
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isInteger(x) || x < 0 || x > 255 || !Number.isInteger(y) || y < 0 || y > 191) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "x must be 0..255 and y must be 0..191 integers");
        }
        const durationMs = nonNegativeNumber(
            params.durationMs ?? params.holdMs ?? 0,
            "durationMs",
            MAX_INPUT_WAIT_MS
        );
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(waitBeforeMs + durationMs + waitAfterMs, "runTouchHold");
        const deadline = inputDeadline(params);
        await waitChecked(waitBeforeMs, deadline, "runTouchHold");
        setTouchState(true, x, y);
        try {
            await waitChecked(durationMs, deadline, "runTouchHold");
        } finally {
            setTouchState(false, x, y);
        }
        await waitChecked(waitAfterMs, deadline, "runTouchHold");
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
