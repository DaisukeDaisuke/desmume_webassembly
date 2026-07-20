export function createRuntimeCommands(context) {
    const {
        applyFreezes,
        applyScaleRotation,
        bootWaitMs,
        cancelOperation,
        dispatchScriptEvent,
        drawFrame,
        ensureReady,
        ensureRomLoaded,
        frameService,
        hasLoadedRom,
        native,
        pauseForFileLoad,
        pumpAudio,
        queueAutoUpdateLoop,
        reloadCurrentRom,
        restoreAfterFileLoad,
        state,
        stopAutoUpdateLoop,
        syncNativeBreakStatus,
        ui,
        updateStatus
    } = context;

    const commands = {
        async setAutoUpdate(params = {}) {
            state.autoUpdate.enabled = !!params.enabled;
            state.autoUpdate.hz = Math.max(
                1,
                Math.min(20, Number(params.hz ?? params.rate ?? ui.autoUpdateRate.value) || 4)
            );
            ui.autoUpdateToggle.checked = state.autoUpdate.enabled;
            ui.autoUpdateRate.value = String(state.autoUpdate.hz);
            if (state.autoUpdate.enabled) queueAutoUpdateLoop();
            else stopAutoUpdateLoop();
            return { enabled: state.autoUpdate.enabled, hz: state.autoUpdate.hz };
        },

        async pause(params = {}) {
            if (!params._operation && !params._scriptCallback) cancelOperation("pause");
            ensureReady();
            state.explicitPauseSerial++;
            state.paused = true;
            state.running = false;
            native.pause(true);
            updateStatus();
            return { ok: true };
        },

        async resume() {
            ensureReady();
            if (!hasLoadedRom()) {
                state.breakLabel = "ROM not loaded";
                state.paused = true;
                state.running = false;
                native.pause(true);
                updateStatus();
                return { ok: false, romLoaded: false, reason: "ROM is not loaded" };
            }
            state.breakLabel = "";
            state.breakRefreshKey = "";
            state.paused = false;
            state.running = true;
            native.clearBreakStatus();
            native.pause(false);
            updateStatus();
            return { ok: true, romLoaded: true };
        },

        async reset(params = {}) {
            cancelOperation("reset");
            ensureRomLoaded("reset requires a loaded ROM");
            const runState = pauseForFileLoad();
            const hold = params.holdPaused ?? params.hold ?? ui.resetHoldToggle.checked;
            try {
                const result = await reloadCurrentRom({
                    waitMs: bootWaitMs(params),
                    resume: !hold && runState.running && !runState.paused
                });
                if (result === 0) {
                    dispatchScriptEvent("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "reset"
                    });
                }
                return {
                    ok: result === 0,
                    ret: result,
                    reloaded: result === 0,
                    held: !!hold,
                    waitMs: bootWaitMs(params),
                    romLoaded: native.isRomLoaded()
                };
            } finally {
                restoreAfterFileLoad(hold ? { running: false, paused: true } : runState);
            }
        },

        async reloadRom(params = {}) {
            cancelOperation("rom-load");
            ensureRomLoaded("ROM reload requires a loaded ROM");
            const runState = pauseForFileLoad();
            const resume = params.resume === true
                || (params.resume !== false
                    && runState.running
                    && !runState.paused
                    && !ui.resetHoldToggle.checked);
            try {
                const result = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume });
                if (result === 0) {
                    dispatchScriptEvent("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "reloadRom"
                    });
                }
                return {
                    ok: result === 0,
                    ret: result,
                    reloaded: result === 0,
                    resumed: resume,
                    waitMs: bootWaitMs(params),
                    romLoaded: native.isRomLoaded()
                };
            } finally {
                restoreAfterFileLoad(resume ? runState : { running: false, paused: true });
            }
        },

        async setSpeed(params) {
            state.speed = Math.min(4, Math.max(0.25, Number(params.speed ?? params.value ?? 1)));
            ui.speedSelect.value = String(state.speed);
            updateStatus();
            return { speed: state.speed };
        },

        async stepFrames(params) {
            ensureRomLoaded("frame stepping requires a loaded ROM");
            if (state.running && !state.paused && params.pauseWhenRunning !== false) {
                return commands.pause();
            }
            const frames = Math.max(1, Number(params.frames ?? 1));
            const frameBefore = state.frame;
            const wasPaused = state.paused;
            native.pause(false);
            applyFreezes();
            let ran = 0;
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
                ran = native.runFrames(frames, { render: state.render, keys: state.keys });
            }
            applyFreezes();
            drawFrame();
            pumpAudio(ran);
            const nativeStatus = syncNativeBreakStatus();
            if (state.frame > frameBefore) {
                for (let frame = frameBefore + 1; frame <= state.frame; frame++) {
                    frameService.onFrameCompleted(frame);
                }
                const completed = state.frame - frameBefore;
                state.screenValid = true;
                state.framesSinceStateLoad += completed;
                state.completedFrameSerial += completed;
            }
            const hitBreak = !!nativeStatus?.lastBreak?.hit;
            for (let index = 0; index < ran; index++) {
                dispatchScriptEvent("tick", {
                    frame: state.frame - ran + index + 1,
                    cpu: state.selectedCpu
                });
            }
            if (wasPaused || ran < frames || hitBreak) native.pause(true);
            state.paused = wasPaused || ran < frames || hitBreak;
            state.running = !state.paused;
            updateStatus();
            return { frames: ran, requested: frames, paused: state.paused };
        },

        async setRenderEnabled(params) {
            state.render = !!params.enabled;
            ui.renderToggle.checked = state.render;
            return { render: state.render };
        },

        async setAudio(params) {
            state.audio = !!params.enabled;
            ui.audioToggle.checked = state.audio;
            ui.volumeRange.value = Number(params.volume ?? ui.volumeRange.value);
            if (state.audio && state.audioContext?.state === "suspended") {
                await state.audioContext.resume();
            }
            return { audio: state.audio, volume: Number(ui.volumeRange.value) };
        },

        async setScale(params) {
            state.scale = Number(params.scale ?? params.value ?? 2);
            ui.scaleSelect.value = String(state.scale);
            applyScaleRotation();
            return { scale: state.scale };
        },

        async setRotation(params) {
            state.rotation = Number(params.rotation ?? params.value ?? 0);
            ui.rotationSelect.value = String(state.rotation);
            applyScaleRotation();
            return { rotation: state.rotation };
        }
    };

    return Object.freeze(commands);
}
