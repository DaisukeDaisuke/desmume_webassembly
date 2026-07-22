import { getInternalMetadata } from "../internal-command-metadata.js";
import { ErrorCode } from "../error-codes.js";
import { codedError, nonNegativeNumber } from "../validation.js";

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
            if (isAnalysisBaselineSlot(params.slot)
                && getInternalMetadata(params).analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "analysis baseline slots are reserved");
            }
            const bytes = native.saveStateBytes();
            const size = bytes.length;
            if (params.slot) {
                if (!isAnalysisBaselineSlot(params.slot)) rememberSlot(params.slot);
                if (bytes.length > 256 * 1024 * 1024) {
                    throw codedError(
                        ErrorCode.INVALID_ARGUMENT,
                        "state exceeds 256MB browser storage limit"
                    );
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
            ensureRomLoaded("state load requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            cancelOperation("state-load");
            if (isAnalysisBaselineSlot(params.slot)
                && getInternalMetadata(params).analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "analysis baseline slots are reserved");
            }
            const runState = pauseForFileLoad();
            let bytes = null;
            let loaded = false;
            try {
                if (params.slot && !isAnalysisBaselineSlot(params.slot)) rememberSlot(params.slot);
                if (params.slot) bytes = await idbGet(String(params.slot));
                if (params.slot && !bytes) {
                    throw codedError(ErrorCode.STATE_NOT_LOADED, `state slot not found: ${params.slot}`);
                }
                const ret = bytes ? loadStateBytesFromMemory(bytes) : native.loadBufferedState();
                if (ret !== 0) throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    `State load failed (${ret})`,
                    { nativeCode: ret }
                );
                loaded = true;
                state.frame = 0;
                blockSaveFlush(saveFlushBlockMs);
                drawLoadedStateFrame({
                    showResumeNotice: !(runState.running && !runState.paused)
                });
                dispatchScriptEvent("stateLoad", { slot: params.slot || null });
                return { ok: true, paused: runState.paused, reset: false };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        },

        async importStateFile(params = {}) {
            ensureRomLoaded("state import requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            cancelOperation("state-load");
            const selected = ui.stateFile.files && ui.stateFile.files[0]
                ? await readFileFromInput(ui.stateFile)
                : await openPicker(ui.stateFile);
            const { file, bytes } = selected;
            const runState = pauseForFileLoad();
            let loaded = false;
            try {
                const ret = native.loadStateFile(bytes);
                if (ret !== 0) throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    `State import failed (${ret})`,
                    { nativeCode: ret }
                );
                loaded = true;
                state.frame = 0;
                blockSaveFlush(saveFlushBlockMs);
                drawLoadedStateFrame({
                    showResumeNotice: !(runState.running && !runState.paused)
                });
                await recordRecentFile("state", file.name, bytes);
                log(`state imported: ${file.name}`);
                return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
            } finally {
                if (loaded) restoreAfterFileLoad(runState);
                else stopAfterFailedStateLoad();
            }
        },

        async loadStateBytes(params = {}) {
            ensureRomLoaded("state byte load requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            cancelOperation("state-load");
            const bytes = bytesFromParams(params);
            const runState = pauseForFileLoad();
            let loaded = false;
            try {
                const ret = native.loadStateFile(bytes);
                if (ret !== 0) throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    `State byte load failed (${ret})`,
                    { nativeCode: ret }
                );
                loaded = true;
                state.frame = 0;
                blockSaveFlush(saveFlushBlockMs);
                drawLoadedStateFrame({
                    showResumeNotice: !(runState.running && !runState.paused)
                });
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
