import { ErrorCode } from "../error-codes.js";
import { codedError } from "../validation.js";

export function createSaveCommands({
    ui,
    native,
    cancelOperation,
    ensureReady,
    ensureRomLoaded,
    readFileFromInput,
    openPicker,
    pauseForFileLoad,
    restoreAfterFileLoad,
    applySaveAndReloadRom,
    bootWaitMs,
    rememberSlot,
    idbGet,
    idbPut,
    recordRecentFile,
    download,
    log
}) {
    return Object.freeze({
        async importSaveFile() {
            cancelOperation("reset");
            ensureReady();
            const selection = ui.saveFile.files && ui.saveFile.files[0]
                ? await readFileFromInput(ui.saveFile)
                : await openPicker(ui.saveFile);
            const { file, bytes } = selection;
            const runState = pauseForFileLoad();
            try {
                const saveLoad = await applySaveAndReloadRom(file.name, bytes, {
                    waitMs: bootWaitMs()
                });
                const result = saveLoad.ret;
                if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Save import failed (${result})`, { nativeCode: result });
                if (result === 0) {
                    rememberSlot(ui.stateSlot.value);
                    await idbPut(`save:${ui.stateSlot.value}`, bytes);
                    await recordRecentFile("save", file.name, bytes, ui.stateSlot.value);
                    ui.storageStatus.textContent = `save loaded ${ui.stateSlot.value}`;
                }
                log(`save imported via ${saveLoad.path}: ${file.name}`);
                return {
                    ret: result,
                    size: bytes.length,
                    reset: result === 0,
                    reloaded: result === 0,
                    path: saveLoad.path
                };
            } finally {
                restoreAfterFileLoad(runState);
            }
        },

        async exportSaveFile() {
            ensureRomLoaded("save export requires a loaded ROM");
            const bytes = native.exportSaveBytes();
            download("desmume-save.sav", bytes);
            return { ok: true, size: bytes.length };
        },

        async saveSaveSlot(params = {}) {
            ensureRomLoaded("save slot export requires a loaded ROM");
            const slot = String(params.slot ?? ui.stateSlot.value);
            rememberSlot(slot);
            const bytes = native.exportSaveBytes();
            if (!bytes.length) throw new Error("save export produced an empty buffer");
            await idbPut(`save:${slot}`, bytes);
            await recordRecentFile("save", slot, bytes, slot);
            ui.storageStatus.textContent = `save saved ${slot}`;
            return { ok: true, slot, size: bytes.length };
        },

        async loadSaveSlot(params = {}) {
            cancelOperation("reset");
            ensureReady();
            const slot = String(params.slot ?? ui.stateSlot.value);
            rememberSlot(slot);
            const bytes = await idbGet(`save:${slot}`);
            if (!bytes) throw new Error(`save slot not found: ${slot}`);
            const runState = pauseForFileLoad();
            try {
                const saveLoad = await applySaveAndReloadRom(slot, bytes, {
                    waitMs: bootWaitMs()
                });
                const result = saveLoad.ret;
                if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Save load failed (${result})`, { nativeCode: result });
                ui.storageStatus.textContent = `save loaded ${slot}`;
                await recordRecentFile("save", slot, bytes, slot);
                return {
                    ret: result,
                    slot,
                    size: bytes.length,
                    reset: result === 0,
                    reloaded: result === 0,
                    paused: runState.paused,
                    path: saveLoad.path
                };
            } finally {
                restoreAfterFileLoad(runState);
            }
        }
    });
}
