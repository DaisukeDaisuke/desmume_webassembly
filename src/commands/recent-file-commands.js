export function createRecentFileCommands(context) {
    const {
        applySaveAndReloadRom,
        blockSaveFlush,
        bootWaitMs,
        cancelOperation,
        drawLoadedStateFrame,
        ensureReady,
        ensureRomLoaded,
        idbGet,
        loadStateBytesFromMemory,
        native,
        pauseForFileLoad,
        rememberSlot,
        renderRecentFiles,
        restoreAfterFileLoad,
        state,
        stopAfterFailedStateLoad,
        ui
    } = context;

    return {
        async listRecentFiles() {
            renderRecentFiles();
            return { recentFiles: state.recentFiles };
        },

        async reloadRecentFile(params = {}) {
            ensureReady();
            const id = String(params.id ?? ui.recentFileSelect.value);
            const item = state.recentFiles.find((entry) => entry.id === id);
            if (!item) throw new Error(`recent file not found: ${id}`);
            cancelOperation(item.kind === "save" ? "reset" : "state-load");
            if (item.slot) rememberSlot(item.slot);
            const bytes = item.key
                ? await idbGet(item.key)
                : item.slot
                    ? await idbGet(`${item.kind}:${item.slot}`)
                    : null;
            if (!bytes) throw new Error(`recent bytes not found: ${id}`);

            if (item.kind === "save") {
                const runState = pauseForFileLoad();
                try {
                    const saveLoad = await applySaveAndReloadRom(
                        item.name || item.slot || "save.sav",
                        bytes,
                        { waitMs: bootWaitMs() }
                    );
                    const ret = saveLoad.ret;
                    return {
                        ok: ret === 0,
                        ret,
                        item,
                        size: bytes.length,
                        reset: ret === 0,
                        reloaded: ret === 0,
                        paused: runState.paused,
                        path: saveLoad.path
                    };
                } finally {
                    restoreAfterFileLoad(runState);
                }
            }

            const runState = pauseForFileLoad();
            let loaded = false;
            try {
                ensureRomLoaded("recent state reload requires a loaded ROM");
                const ret = item.slot ? loadStateBytesFromMemory(bytes) : native.loadStateFile(bytes);
                if (ret !== 0) throw new Error(`recent state load failed (${ret})`);
                loaded = true;
                state.frame = 0;
                blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
                drawLoadedStateFrame();
                return { ok: true, ret, item, size: bytes.length, paused: runState.paused };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        }
    };
}
