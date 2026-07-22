import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

const ROM_PATH = "rom.nds";
const ROM_CANDIDATE_PATH = "__candidate_rom.nds";
const SAVE_PATHS = ["rom.sav", "rom.dsv"];

export function createRomService({
    state,
    native,
    sleep,
    blockSaveFlush,
    drawFrame,
    reconcileNativeBreakpoints = () => ({ cleared: false, registered: 0 })
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
        state.pendingRomCandidate = {
            name: String(name || "rom.nds"),
            bytes: romBytes
        };
        return romBytes.length;
    }

    function snapshotFile(path) {
        return native.fileExists(path) ? native.readFile(path) : null;
    }

    function restoreFile(path, bytes) {
        if (bytes) native.writeFile(path, bytes);
        else native.unlinkFile(path);
    }

    function stageSave(candidateSave) {
        if (!candidateSave) return null;
        const bytes = new Uint8Array(candidateSave.bytes);
        const path = String(candidateSave.name).toLowerCase().endsWith(".dsv") ? "rom.dsv" : "rom.sav";
        const candidatePath = `__candidate_${path}`;
        native.writeFile(candidatePath, bytes);
        for (const livePath of SAVE_PATHS) native.unlinkFile(livePath);
        native.writeFile(path, native.readFile(candidatePath));
        return { path, candidatePath };
    }

    async function reload(options = {}) {
        const pending = state.pendingRomCandidate;
        const candidate = pending || (state.romBytes
            ? { name: state.romName || ROM_PATH, bytes: new Uint8Array(state.romBytes) }
            : native.fileExists(ROM_PATH)
                ? { name: ROM_PATH, bytes: native.readFile(ROM_PATH) }
                : null);
        if (!candidate?.bytes?.length) throw new Error("ROM is not loaded");
        validateBytes(candidate.bytes);

        const metadataBefore = {
            romName: state.romName,
            romBytes: state.romBytes,
            romSize: state.romSize,
            romGeneration: state.romGeneration,
            running: state.running,
            paused: state.paused
        };
        const filesBefore = new Map([
            [ROM_PATH, snapshotFile(ROM_PATH)],
            ...SAVE_PATHS.map((path) => [path, snapshotFile(path)])
        ]);
        const oldRomWasLoaded = native.isRomLoaded();
        let saveStage = null;

        native.pause(true);
        state.running = false;
        state.paused = true;
        state.frameBudget = 0;
        try {
            native.writeFile(ROM_CANDIDATE_PATH, candidate.bytes);
            native.writeFile(ROM_PATH, native.readFile(ROM_CANDIDATE_PATH));
            saveStage = stageSave(options.candidateSave);
            await sleep(Number(options.preWaitMs ?? 0));
            const result = native.loadRom(candidate.bytes.length);
            native.pause(true);
            await sleep(Number(options.waitMs ?? 0));
            if (result !== 0) {
                throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, {
                    nativeCode: result,
                    stage: "native-load"
                });
            }
            reconcileNativeBreakpoints();

            state.nativeFault = false;
            state.romName = candidate.name;
            state.romBytes = new Uint8Array(candidate.bytes);
            state.romSize = candidate.bytes.length;
            state.romGeneration = metadataBefore.romGeneration + 1;
            state.pendingRomCandidate = null;
            state.frame = 0;
            state.previousRegisters = null;
            state.lastBreakKey = "";
            state.breakRefreshKey = "";
            state.breakLabel = "";
            native.clearBreakStatus();
            state.running = options.resume === true;
            state.paused = options.resume !== true;
            native.pause(state.paused);
            blockSaveFlush(Number(options.saveFlushBlockMs ?? 10000));
            drawFrame();
            return result;
        } catch (error) {
            state.pendingRomCandidate = null;
            for (const [path, bytes] of filesBefore) restoreFile(path, bytes);
            Object.assign(state, metadataBefore, { running: false, paused: true });
            try {
                if (oldRomWasLoaded && filesBefore.get(ROM_PATH)?.length) {
                    native.loadRom(filesBefore.get(ROM_PATH).length);
                    reconcileNativeBreakpoints();
                }
            } catch (rollbackError) {
                error.mcpDetails = {
                    ...(error.mcpDetails || {}),
                    rollbackFailed: true,
                    rollbackMessage: String(rollbackError?.message || rollbackError).slice(0, 300)
                };
            }
            try { native.pause(true); } catch {}
            throw error;
        } finally {
            try { native.unlinkFile(ROM_CANDIDATE_PATH); } catch {}
            for (const path of [saveStage?.candidatePath, "__candidate_rom.sav", "__candidate_rom.dsv"].filter(Boolean)) {
                try { native.unlinkFile(path); } catch {}
            }
        }
    }

    return Object.freeze({ reload, validateBytes, write });
}
