export function createScreenVisibility({ state, ui, frameService, tryGetPc }) {
    function hex(value, width = 8) {
        return `0x${(Number(value) >>> 0).toString(16).padStart(width, "0")}`;
    }

    function applyScaleRotation() {
        const vertical = state.rotation % 180 === 0;
        const canvasWidth = 256 * state.scale;
        const canvasHeight = 384 * state.scale;
        ui.screenShell.style.setProperty("--canvas-w", `${canvasWidth}px`);
        ui.screenShell.style.setProperty("--canvas-h", `${canvasHeight}px`);
        ui.screenShell.style.setProperty("--screen-w", `${(vertical ? 256 : 384) * state.scale}px`);
        ui.screenShell.style.setProperty("--screen-h", `${(vertical ? 384 : 256) * state.scale}px`);
        ui.screenShell.style.setProperty("--screen-rotation", `${state.rotation}deg`);
    }

    function updateStatus() {
        ui.frameStatus.textContent = `frame ${state.frame}`;
        ui.speedStatus.textContent = `speed ${state.speed.toFixed(2)}x`;
        if (state.ready) {
            const pc = tryGetPc();
            ui.pcStatus.textContent = `${state.selectedCpu} pc ${pc === null ? "--" : hex(pc)}`;
        }
        ui.readyLed.className = state.ready ? `led ${state.paused ? "paused" : "ready"}` : "led";
        if (state.ready) {
            ui.readyText.textContent = state.breakLabel || (state.paused ? "paused" : "running");
        }
        const screenValid = frameService.isValid();
        ui.canvasShotBtn.disabled = !screenValid;
        ui.canvasShotBtn.title = screenValid ? "" : "画面を更新するには実行を再開してください。";
    }

    return Object.freeze({ applyScaleRotation, updateStatus });
}
