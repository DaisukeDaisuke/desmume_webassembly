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
                log(`ROM loaded: ${file.name} (${bytes.length} bytes)`);
                return {
                    ok: result === 0,
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
                log(`ROM loaded from MCP bytes: ${name} (${bytes.length} bytes)`);
                return {
                    ok: result === 0,
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
            if (!url) throw new Error("url is required");
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`ROM fetch failed: ${response.status}`);
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
