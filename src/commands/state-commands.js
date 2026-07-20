export function createStateCommands(context) {
    const {
        analysisBaselineSlotToken,
        blockSaveFlush,
        bytesFromParams,
        cancelOperation,
        dispatchScriptEvent,
        download,
        drawLoadedStateFrame,
        ensureReady,
        ensureRomLoaded,
        idbGet,
        idbPut,
        isAnalysisBaselineSlot,
        loadStateBytesFromMemory,
        log,
        native,
        openPicker,
        pauseForFileLoad,
        readFileFromInput,
        recordRecentFile,
        rememberSlot,
        restoreAfterFileLoad,
        state,
        stopAfterFailedStateLoad,
        ui
    } = context;

    const stateCommands = {
        async saveState(params = {}) {
            ensureRomLoaded("state save requires a loaded ROM");
            if (isAnalysisBaselineSlot(params.slot) && params._analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw new Error("analysis baseline slots are reserved");
            }
            const bytes = native.saveStateBytes();
            const size = bytes.length;
            if (params.slot) {
                if (!isAnalysisBaselineSlot(params.slot)) rememberSlot(params.slot);
                if (bytes.length > 256 * 1024 * 1024) {
                    throw new Error("state exceeds 256MB browser storage limit");
                }
                await idbPut(String(params.slot), bytes);
                if (!isAnalysisBaselineSlot(params.slot)) {
                    await recordRecentFile("state", String(params.slot), bytes, String(params.slot));
                }
                ui.storageStatus.textContent = `state saved ${params.slot}`;
            }
            dispatchScriptEvent("stateSave", { size, slot: params.slot || null });
            return { ok: true, size };
        },

        async loadState(params = {}) {
            cancelOperation("state-load");
            ensureRomLoaded("state load requires a loaded ROM");
            if (isAnalysisBaselineSlot(params.slot) && params._analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw new Error("analysis baseline slots are reserved");
            }
            const runState = pauseForFileLoad();
            let bytes = null;
            let loaded = false;
            try {
                if (params.slot && !isAnalysisBaselineSlot(params.slot)) rememberSlot(params.slot);
                if (params.slot) bytes = await idbGet(String(params.slot));
                if (params.slot && !bytes) throw new Error(`state slot not found: ${params.slot}`);
                const ret = bytes ? loadStateBytesFromMemory(bytes) : native.loadBufferedState();
                if (ret !== 0) throw new Error(`state load failed (${ret})`);
                loaded = true;
                state.frame = 0;
                blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
                drawLoadedStateFrame();
                dispatchScriptEvent("stateLoad", { slot: params.slot || null });
                return { ok: true, paused: runState.paused, reset: false };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        },

        async importStateFile(params = {}) {
            cancelOperation("state-load");
            ensureRomLoaded("state import requires a loaded ROM");
            const selected = ui.stateFile.files && ui.stateFile.files[0]
                ? await readFileFromInput(ui.stateFile)
                : await openPicker(ui.stateFile);
            const { file, bytes } = selected;
            const runState = pauseForFileLoad();
            let loaded = false;
            try {
                const ret = native.loadStateFile(bytes);
                if (ret !== 0) throw new Error(`state import failed (${ret})`);
                loaded = true;
                state.frame = 0;
                blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
                drawLoadedStateFrame();
                await recordRecentFile("state", file.name, bytes);
                log(`state imported: ${file.name}`);
                return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        },

        async loadStateBytes(params = {}) {
            cancelOperation("state-load");
            ensureRomLoaded("state byte load requires a loaded ROM");
            const bytes = bytesFromParams(params);
            const runState = pauseForFileLoad();
            let loaded = false;
            try {
                const ret = native.loadStateFile(bytes);
                if (ret !== 0) throw new Error(`state byte load failed (${ret})`);
                loaded = true;
                state.frame = 0;
                blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
                drawLoadedStateFrame();
                log(`state loaded from MCP bytes: ${params.name || "mcp-state.dst"}`);
                return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        },

        async loadStateUrl(params = {}) {
            cancelOperation("state-load");
            ensureReady();
            const url = String(params.url || "");
            if (!url) throw new Error("url is required");
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`state fetch failed: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            return stateCommands.loadStateBytes({
                ...params,
                bytes,
                name: params.name || url.split("/").pop() || "url-state.dst"
            });
        },

        async exportStateFile() {
            ensureRomLoaded("state export requires a loaded ROM");
            const result = await stateCommands.saveState();
            download("desmume-state.dst", native.getStateBufferBytes(result.size));
            return result;
        }
    };

    return stateCommands;
}
