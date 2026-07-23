export function createStateService({
    state,
    native,
    frameService,
    onScreenInvalid = () => {},
    onStatusChange = () => {},
    onFault = () => {}
}) {
    function loadBytes(bytes) {
        return native.loadStateBytes(bytes);
    }

    function invalidateAfterLoad({ showResumeNotice = true } = {}) {
        frameService.invalidateAfterStateLoad();
        state.screenValid = false;
        state.framesSinceStateLoad = 0;
        state.stateLoadSerial++;
        state.traceStateSynchronized = state.traceEnabled !== true;
        onScreenInvalid({ showResumeNotice });
    }

    function pauseForLoad() {
        const runState = { running: state.running, paused: state.paused };
        state.loadingFile = true;
        state.running = false;
        state.paused = true;
        state.frameBudget = 0;
        if (state.ready) native.pause(true);
        onStatusChange();
        return runState;
    }

    function restoreAfterLoad(runState) {
        state.loadingFile = false;
        state.lastTick = performance.now();
        state.frameBudget = 0;
        if (state.nativeFault) {
            state.paused = true;
            state.running = false;
            native.pause(true);
            onStatusChange();
            return;
        }
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.lastBreakKey = "";
        native.clearBreakStatus();
        if (runState.running && !runState.paused) {
            state.paused = false;
            state.running = true;
            native.pause(false);
        } else {
            state.paused = true;
            state.running = false;
            native.pause(true);
        }
        onStatusChange();
    }

    function stopAfterFailedLoad() {
        state.loadingFile = false;
        state.lastTick = performance.now();
        state.frameBudget = 0;
        state.paused = true;
        state.running = false;
        try {
            native.pauseWithoutFaultHandling(true);
        } catch (error) {
            onFault(error, "state load failure pause");
        }
        onStatusChange();
    }

    return Object.freeze({
        invalidateAfterLoad,
        loadBytes,
        pauseForLoad,
        restoreAfterLoad,
        stopAfterFailedLoad
    });
}
