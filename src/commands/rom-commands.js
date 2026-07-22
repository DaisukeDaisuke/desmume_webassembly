import { ErrorCode } from "../error-codes.js";
import { codedError } from "../validation.js";

export function createRomCommands({
    state,
    ui,
    native,
    cancelOperation,
    ensureReady,
    ensureWasmReady,
    bytesFromParams,
    readFileFromInput,
    openPicker,
    pauseForFileLoad,
    restoreAfterFileLoad,
    writeRomFile,
    reloadCurrentRom,
    bootWaitMs,
    log
}) {
    const commands = {
        async loadRomFile() {
            cancelOperation("rom-load");
            const selection = ui.romFile.files && ui.romFile.files[0]
                ? await readFileFromInput(ui.romFile)
                : await openPicker(ui.romFile);
            const { file, bytes } = selection;
            await ensureWasmReady();
            pauseForFileLoad();
            try {
                writeRomFile(file.name, bytes);
                const result = await reloadCurrentRom({ waitMs: bootWaitMs(), resume: true });
                if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, { nativeCode: result });
                log(`ROM loaded: ${file.name} (${bytes.length} bytes)`);
                return {
                    ret: result,
                    name: file.name,
                    size: bytes.length,
                    waitMs: bootWaitMs(),
                    romLoaded: native.isRomLoaded()
                };
            } finally {
                restoreAfterFileLoad({ running: true, paused: false });
            }
        },

        async loadRomBytes(params = {}) {
            cancelOperation("rom-load");
            await ensureWasmReady();
            const bytes = bytesFromParams(params);
            pauseForFileLoad();
            const resume = params.resume !== false;
            const name = params.name || "mcp-rom.nds";
            try {
                writeRomFile(name, bytes);
                const result = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume });
                if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, { nativeCode: result });
                log(`ROM loaded from MCP bytes: ${name} (${bytes.length} bytes)`);
                return {
                    ret: result,
                    name,
                    size: bytes.length,
                    waitMs: bootWaitMs(params),
                    romLoaded: native.isRomLoaded()
                };
            } finally {
                restoreAfterFileLoad({ running: resume, paused: !resume });
            }
        },

        async loadRomUrl(params = {}) {
            cancelOperation("rom-load");
            ensureReady();
            const url = String(params.url || "");
            if (!url) throw codedError(ErrorCode.INVALID_ARGUMENT, "url is required");
            let response;
            try {
                response = await fetch(url, { cache: "no-store" });
            } catch (error) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "ROM URL could not be fetched", {
                    message: String(error?.message || error)
                });
            }
            if (!response.ok) throw codedError(ErrorCode.INVALID_ARGUMENT, `ROM fetch failed: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            return commands.loadRomBytes({
                ...params,
                bytes,
                name: params.name || url.split("/").pop() || "url-rom.nds"
            });
        }
    };

    return Object.freeze(commands);
}
