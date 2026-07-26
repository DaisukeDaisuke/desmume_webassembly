import { ErrorCode } from "./error-codes.js";
import { codedError, subscribeAbort } from "./validation.js";

const STORAGE_KEY = "desmume-input-sequences-v1";
const BUTTONS = new Set(["A", "B", "X", "Y", "L", "R", "Start", "Select", "Up", "Down", "Left", "Right"]);

export function createInputSequenceService({
    responder,
    press,
    releaseAll,
    touch,
    stepFrames,
    getPauseDetails = () => null,
    resume = async () => ({ ok: true }),
    storage = localStorage
}) {
    const sequences = new Map();
    try {
        const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
        if (saved?.version === 1) {
            Object.entries(saved.items || {}).forEach(([id, sequence]) => {
                sequences.set(id, sequence);
            });
        }
    } catch {}

    const save = () => storage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        items: Object.fromEntries(sequences)
    }));
    const buttons = (text) => String(text)
        .split("+")
        .map((button) => button.trim())
        .filter(Boolean);
    const inputUnavailable = (details = getPauseDetails()) => {
        const pauseDetails = details && typeof details === "object"
            ? details
            : { paused: true, running: false, pauseKind: "manual" };
        return codedError(
            ErrorCode.INPUT_UNAVAILABLE,
            `input is unavailable while emulator is paused (${pauseDetails.pauseKind || "manual"})`,
            pauseDetails
        );
    };
    const requireInputRunning = () => {
        const pauseDetails = getPauseDetails();
        if (pauseDetails?.paused) throw inputUnavailable(pauseDetails);
        return pauseDetails;
    };
    const requireCompletedFrameStep = (result, requestedFrames) => {
        const pauseDetails = requireInputRunning();
        const completedFrames = Number(result?.frames);
        if (result?.paused === true
            || (Number.isFinite(completedFrames) && completedFrames < requestedFrames)) {
            throw inputUnavailable({
                ...(pauseDetails && typeof pauseDetails === "object" ? pauseDetails : {}),
                paused: true,
                running: false,
                pauseKind: pauseDetails?.pauseKind || "manual"
            });
        }
    };
    const wait = (ms, signal) => new Promise((resolve, reject) => {
        let unsubscribeAbort = () => {};
        const cleanup = () => unsubscribeAbort();
        const complete = () => {
            cleanup();
            resolve();
        };
        const timer = setTimeout(complete, Math.max(0, ms));
        const aborted = () => {
            clearTimeout(timer);
            cleanup();
            reject(new DOMException("aborted", "AbortError"));
        };
        unsubscribeAbort = subscribeAbort(signal, aborted);
    });

    function validate(sequence) {
        if (!Array.isArray(sequence) || !sequence.length) {
            throw new Error("seq must be a non-empty array");
        }
        for (const step of sequence) {
            if (!Array.isArray(step) || !["t", "s", "h", "hf", "w", "wf", "x"].includes(step[0])) {
                throw new Error("invalid sequence opcode");
            }
            const usesButtons = ["t", "s", "h", "hf"].includes(step[0]);
            if (usesButtons && buttons(step[1]).some((button) => !BUTTONS.has(button))) {
                throw new Error(`unknown button in ${step[1]}`);
            }
        }
    }

    return {
        list() {
            return responder.ok({
                sequences: [...sequences].map(([id, sequence]) => ({ id, seq: sequence }))
            });
        },
        delete({ id }) {
            if (!sequences.delete(id)) {
                return responder.fail(
                    ErrorCode.SEQUENCE_NOT_FOUND,
                    `Input sequence not found: ${id}`
                );
            }
            save();
            return responder.ok({ id });
        },
        async run(params, operation) {
            let initialPause = getPauseDetails();
            if (initialPause?.paused && initialPause.pauseKind === "manual" && params.resume === true) {
                const resumed = await resume();
                if (resumed?.ok === false) return resumed;
                initialPause = getPauseDetails();
            }
            if (initialPause?.paused) {
                return responder.fail(
                    ErrorCode.INPUT_UNAVAILABLE,
                    `input is unavailable while emulator is paused (${initialPause.pauseKind || "manual"})`,
                    initialPause
                );
            }
            let sequence = params.seq;
            const existing = sequences.get(params.id);
            if (!sequence) {
                if (!existing) {
                    return responder.fail(
                        ErrorCode.SEQUENCE_NOT_FOUND,
                        `Input sequence not found: ${params.id}`
                    );
                }
                sequence = existing;
            }
            try {
                validate(sequence);
            } catch (error) {
                return responder.fail(ErrorCode.INVALID_ARGUMENT, error.message);
            }
            const changedExisting = existing
                && JSON.stringify(existing) !== JSON.stringify(sequence);
            if (changedExisting && params.replace !== true) {
                return responder.fail(
                    ErrorCode.SEQUENCE_EXISTS,
                    `Input sequence already exists: ${params.id}`
                );
            }
            if (params.id) {
                sequences.set(params.id, sequence);
                save();
            }

            const [holdMs, gapMs] = params.tap || [40, 50];
            try {
                for (const step of sequence) {
                    requireInputRunning();
                    const [opcode, first, second] = step;
                    if (opcode === "w") {
                        await wait(first, operation.signal);
                    } else if (opcode === "wf") {
                        const requestedFrames = Number(first);
                        requireInputRunning();
                        const result = await stepFrames(requestedFrames);
                        requireCompletedFrameStep(result, requestedFrames);
                    } else if (opcode === "x") {
                        requireInputRunning();
                        touch(true, Number(first), Number(second));
                        await wait(Number(step[3] || 0), operation.signal);
                        touch(false);
                    } else {
                        const selected = buttons(first);
                        const down = () => {
                            requireInputRunning();
                            selected.forEach((button) => press(button, true));
                        };
                        const up = () => selected.forEach((button) => press(button, false));
                        if (opcode === "t") {
                            for (let index = 0; index < Number(second || 1); index++) {
                                down();
                                await wait(holdMs, operation.signal);
                                up();
                                if (index + 1 < Number(second || 1)) {
                                    await wait(gapMs, operation.signal);
                                }
                            }
                        } else if (opcode === "s") {
                            const end = performance.now() + Number(second);
                            while (performance.now() < end) {
                                down();
                                await wait(holdMs, operation.signal);
                                up();
                                await wait(gapMs, operation.signal);
                            }
                        } else if (opcode === "h") {
                            down();
                            await wait(Number(second), operation.signal);
                            up();
                        } else if (opcode === "hf") {
                            down();
                            const requestedFrames = Number(second);
                            let result;
                            try {
                                result = await stepFrames(requestedFrames);
                            } finally {
                                up();
                            }
                            requireCompletedFrameStep(result, requestedFrames);
                        }
                    }
                    requireInputRunning();
                }
                requireInputRunning();
                return responder.ok({ id: params.id || null, steps: sequence.length });
            } finally {
                releaseAll();
                touch(false);
            }
        }
    };
}
