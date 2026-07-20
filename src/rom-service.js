export function createRomService({
    state,
    native,
    sleep,
    blockSaveFlush,
    drawFrame
}) {
    function validateBytes(bytes) {
        if (!bytes || bytes.length < 0x200) throw new Error("ROM data is too small or missing");
        const headerLength = Math.min(bytes.length, 0x200);
        for (let index = 0; index < headerLength; index++) {
            if (bytes[index] !== 0) return;
        }
        throw new Error("ROM header is all zero");
    }

    function write(name, bytes) {
        const romBytes = new Uint8Array(bytes);
        validateBytes(romBytes);
        native.writeFile("rom.nds", romBytes);
        state.romName = name || "rom.nds";
        state.romBytes = romBytes;
        state.romSize = romBytes.length;
        state.romGeneration++;
        return romBytes.length;
    }

    async function reload(options = {}) {
        let romSize = state.romSize;
        if (state.romBytes) {
            romSize = write(state.romName, state.romBytes);
        } else if (native.fileExists("rom.nds")) {
            romSize = write("rom.nds", native.readFile("rom.nds"));
        } else {
            romSize = 0;
        }
        if (!romSize) throw new Error("ROM is not loaded");

        native.pause(true);
        state.running = false;
        state.paused = true;
        state.frameBudget = 0;
        await sleep(Number(options.preWaitMs ?? 0));
        const result = native.loadRom(romSize);
        native.pause(true);
        await sleep(Number(options.waitMs ?? 0));
        if (result === 0) {
            state.nativeFault = false;
            state.romSize = romSize;
            state.frame = 0;
            state.previousRegisters = null;
            state.lastBreakKey = "";
            state.breakRefreshKey = "";
            state.breakLabel = "";
            native.clearBreakStatus();
            state.running = options.resume === true;
            state.paused = options.resume !== true;
            native.pause(options.resume !== true);
            blockSaveFlush(Number(options.saveFlushBlockMs ?? 10000));
            drawFrame();
        }
        return result;
    }

    return Object.freeze({ reload, validateBytes, write });
}
