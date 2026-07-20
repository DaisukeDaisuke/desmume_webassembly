import { ErrorCode } from "./error-codes.js";

const STORAGE_KEY = "desmume-input-sequences-v1";
const BUTTONS = new Set(["A", "B", "X", "Y", "L", "R", "Start", "Select", "Up", "Down", "Left", "Right"]);

export function createInputSequenceService({ responder, press, releaseAll, touch, stepFrames, getPaused, pause, resume, storage = localStorage }) {
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
    const wait = (ms, signal) => new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", aborted);
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
        signal?.addEventListener("abort", aborted, { once: true });
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

            const wasPaused = getPaused();
            const [holdMs, gapMs] = params.tap || [40, 50];
            try {
                if (wasPaused) await resume();
                for (const step of sequence) {
                    const [opcode, first, second] = step;
                    if (opcode === "w") {
                        await wait(first, operation.signal);
                    } else if (opcode === "wf") {
                        await stepFrames(Number(first));
                    } else if (opcode === "x") {
                        touch(true, Number(first), Number(second));
                        await wait(Number(step[3] || 0), operation.signal);
                        touch(false);
                    } else {
                        const selected = buttons(first);
                        const down = () => selected.forEach((button) => press(button, true));
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
                            await stepFrames(Number(second));
                            up();
                        }
                    }
                }
                return responder.ok({ id: params.id || null, steps: sequence.length });
            } finally {
                releaseAll();
                touch(false);
                if (wasPaused) await pause();
            }
        }
    };
}
