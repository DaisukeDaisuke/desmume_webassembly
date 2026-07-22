import { ErrorCode } from "./error-codes.js";
import { completeFrames } from "./frame-completion.js";

const FRAMEBUFFER_BYTES = 256 * 384 * 4;

export function createEmulationLoop({
    state,
    ui,
    frameService,
    native,
    handleNativeFault,
    syncNativeBreakStatus,
    dispatchScriptEvent,
    onScreenValid = () => {},
    updateStatus,
    log = () => {}
}) {
    function drawFrame() {
        if (!state.ready || !state.render || !frameService.isValid()) return;
        if (!ui.screen.isConnected) log("screen canvas detached");
        const rect = ui.screenShell.getBoundingClientRect();
        if (rect.width <= 0
            || rect.height <= 0
            || !Number.isFinite(rect.width)
            || !Number.isFinite(rect.height)) {
            log(`screen shell collapsed: scale=${state.scale} rotation=${state.rotation} width=${rect.width} height=${rect.height}`);
        }
        const bytes = native.getFrameBytes();
        if (!bytes || bytes.byteLength !== FRAMEBUFFER_BYTES) {
            throw new Error("invalid framebuffer length");
        }
        state.imageData.data.set(bytes);
        ui.screen.getContext("2d").putImageData(state.imageData, 0, 0);
    }

    function pumpAudio(frames = 1) {
        if (!state.audio || !state.ready) return;
        const AudioConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioConstructor) return;
        if (!state.audioContext) state.audioContext = new AudioConstructor({ sampleRate: 44100 });
        const context = state.audioContext;
        const desired = Math.min(8192, Math.max(256, Math.ceil(
            (44100 / 59.8261) * Math.max(1, frames)
        )));
        const { sampleCount, samples } = native.fillAudioSamples(desired);
        if (sampleCount <= 0) return;
        const buffer = context.createBuffer(2, sampleCount, 44100);
        const volume = Number(ui.volumeRange.value);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let index = 0; index < sampleCount; index++) {
            left[index] = (samples[index * 2] / 32768) * volume;
            right[index] = (samples[index * 2 + 1] / 32768) * volume;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = state.speed;
        source.connect(context.destination);
        state.audioNextTime = Math.max(context.currentTime, state.audioNextTime);
        source.start(state.audioNextTime);
        state.audioNextTime += sampleCount / (44100 * state.speed);
    }

    function applyFreezes() {
        if (!state.ready || state.freezes.length === 0) return;
        for (const item of state.freezes) {
            native.writeMemory(item.cpu, item.address, item.value, item.size);
        }
    }

    function tick(now) {
        try {
            if (state.ready && state.running && !state.paused && !state.loadingFile) {
            const elapsed = Math.min(250, now - state.lastTick);
            state.frameBudget += elapsed * 59.8261 * state.speed / 1000;
            const frames = Math.min(12, Math.floor(state.frameBudget));
            if (frames > 0) {
                const frameBefore = state.frame;
                state.frameBudget -= frames;
                applyFreezes();
                let ran = 0;
                let frameFailed = false;
                try {
                    if (state.touch.active) {
                        for (let index = 0; index < frames; index++) {
                            const frameResult = native.runFrame({
                                render: state.render && index === frames - 1,
                                keys: state.keys,
                                touch: state.touch
                            });
                            ran++;
                            if (frameResult > 0) break;
                        }
                    } else {
                        ran = native.runFrames(frames, {
                            render: state.render,
                            keys: state.keys
                        });
                    }
                } catch (error) {
                    frameFailed = true;
                    if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                        || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                        handleNativeFault(error, "runFrame");
                    } else {
                        throw error;
                    }
                }
                if (frameFailed) {
                    return;
                }
                const nativeStatus = syncNativeBreakStatus();
                completeFrames({ state, frameService, frameBefore, onComplete: onScreenValid });
                if (ran < frames || nativeStatus?.lastBreak?.hit) {
                    state.paused = true;
                    state.running = false;
                    native.pause(true);
                }
                for (let index = 0; index < ran; index++) {
                    dispatchScriptEvent("tick", {
                        frame: state.frame - ran + index + 1,
                        cpu: state.selectedCpu
                    });
                }
                applyFreezes();
                try {
                    drawFrame();
                } catch (error) {
                    log(`frame draw failed: ${String(error?.message || error)}`);
                }
                try {
                    pumpAudio(ran);
                } catch (error) {
                    state.audio = false;
                    log(`audio stopped: ${String(error?.message || error)}`);
                }
                try {
                    updateStatus();
                } catch (error) {
                    log(`status update failed: ${String(error?.message || error)}`);
                }
            }
            }
        } catch (error) {
            if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                handleNativeFault(error, "emulationLoop");
            } else {
                state.paused = true;
                state.running = false;
                log(`emulation loop paused: ${String(error?.message || error)}`);
            }
        } finally {
            state.lastTick = now;
            scheduleTick();
        }
    }

    function scheduleTick() {
        if (state.running && !state.paused && !state.loadingFile) requestAnimationFrame(tick);
        else setTimeout(() => requestAnimationFrame(tick), 120);
    }

    return { drawFrame, pumpAudio, applyFreezes, tick, scheduleTick };
}
