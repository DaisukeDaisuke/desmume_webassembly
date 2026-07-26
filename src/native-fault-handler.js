export function createNativeFaultHandler({ state, native, log, updateStatus, blockSaveFlush }) {
    return function handleNativeFault(error, where) {
        state.nativeFault = true;
        state.paused = true;
        state.running = false;
        state.frameBudget = 0;
        try {
            native.pauseWithoutFaultHandling(true);
        } catch (pauseError) {
            log(`pause after ${where}: ${pauseError?.stack || pauseError?.message || pauseError}`);
        }
        state.breakLabel = `native fault ${where}`;
        blockSaveFlush(30000);
        log(`${where}: ${error?.stack || error?.message || error}`);
        updateStatus();
    };
}
