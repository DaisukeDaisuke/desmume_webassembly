export function createEmulationLoop({
    state,
    ui,
    frameService,
    native,
    handleNativeFault,
    syncNativeBreakStatus,
    dispatchScriptEvent,
    updateStatus
}) {
    function drawFrame() {
        if (!state.ready || !state.render || !frameService.isValid()) return;
        const bytes = native.getFrameBytes();
        if (!bytes) return;
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
        if (state.ready && state.running && !state.paused && !state.loadingFile) {
            const elapsed = Math.min(250, now - state.lastTick);
            state.frameBudget += elapsed * 59.8261 * state.speed / 1000;
            const frames = Math.min(12, Math.floor(state.frameBudget));
            if (frames > 0) {
                const frameBefore = state.frame;
                state.frameBudget -= frames;
                applyFreezes();
                let ran = 0;
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
                    handleNativeFault(error, "runFrame");
                }
                const native = syncNativeBreakStatus();
                if (state.frame > frameBefore) {
                    for (let frame = frameBefore + 1; frame <= state.frame; frame++) {
                        frameService.onFrameCompleted(frame);
                    }
                    state.screenValid = true;
                    state.framesSinceStateLoad += state.frame - frameBefore;
                    state.completedFrameSerial += state.frame - frameBefore;
                }
                if (ran < frames || native?.lastBreak?.hit) {
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
                drawFrame();
                pumpAudio(ran);
                updateStatus();
            }
        }
        state.lastTick = now;
        scheduleTick();
    }

    function scheduleTick() {
        if (state.running && !state.paused && !state.loadingFile) requestAnimationFrame(tick);
        else setTimeout(() => requestAnimationFrame(tick), 120);
    }

    return { drawFrame, pumpAudio, applyFreezes, tick, scheduleTick };
}
