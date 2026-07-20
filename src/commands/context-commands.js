import { withInternalMetadata } from "../internal-command-metadata.js";

export function createContextCommands(context) {
    const {
        ANALYSIS_BASELINE_SLOT_PREFIX,
        analysisBaselineSlotToken,
        call,
        currentRomIdentity,
        emulatorActivity,
        ensureRomLoaded,
        hasLoadedRom,
        idbGet,
        native,
        readAnalysisBaseline,
        sha256Hex,
        snapshotContext,
        state,
        syncNativeBreakStatus,
        ui,
        writeAnalysisBaseline
    } = context;

    return {
        async status(params = {}) {
            const waitMs = Math.max(0, Math.min(600000, Number(params.waitMs ?? params.ms ?? 0)));
            if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
            const nativeStatus = state.ready ? native.getStatus() : null;
            if (nativeStatus) syncNativeBreakStatus(nativeStatus);
            return {
                ready: state.ready,
                paused: state.paused,
                running: state.running,
                loadingFile: state.loadingFile,
                romLoaded: hasLoadedRom(),
                romSize: state.romSize,
                frame: state.frame,
                speed: state.speed,
                render: state.render,
                audio: state.audio,
                cpu: state.selectedCpu,
                recentFiles: state.recentFiles,
                autoUpdate: {
                    enabled: state.autoUpdate.enabled,
                    hz: state.autoUpdate.hz
                },
                native: nativeStatus
            };
        },

        async snapshotContext(params = {}) {
            return snapshotContext(params);
        },

        async saveAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline requires a loaded ROM");
            const name = String(params.name || "default");
            const existing = readAnalysisBaseline(name);
            if (existing && params.replace !== true) {
                throw new Error(`analysis baseline already exists: ${name}; pass replace:true to overwrite it`);
            }
            const slot = `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}`;
            const generation = state.romGeneration;
            const identity = await currentRomIdentity();
            const activity = emulatorActivity();
            const result = await call("saveState", withInternalMetadata(
                { slot },
                { analysisBaselineSlotToken }
            ));
            if (generation !== state.romGeneration) {
                throw new Error("ROM changed while saving analysis baseline");
            }
            const stateBytes = await idbGet(slot);
            if (!stateBytes) throw new Error("analysis baseline state was not stored");
            const baseline = {
                name,
                slot,
                ...identity,
                stateSize: stateBytes.length,
                stateSha256: await sha256Hex(stateBytes),
                ...activity,
                skipIrq: !!ui.tracePrivilegeToggle.checked,
                traceEnabled: !!ui.traceToggle.checked,
                savedAt: new Date().toISOString()
            };
            writeAnalysisBaseline(name, baseline);
            return {
                ok: true,
                name,
                slot,
                size: result.size,
                ...emulatorActivity(),
                skipIrq: baseline.skipIrq,
                traceEnabled: baseline.traceEnabled
            };
        },

        async restoreAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline restore requires a loaded ROM");
            const name = String(params.name || "default");
            const baseline = readAnalysisBaseline(name);
            if (!baseline) throw new Error(`analysis baseline not found: ${name}`);
            const rom = await currentRomIdentity();
            for (const field of ["romName", "romSize", "romSha256", "stateFormatVersion"]) {
                if (baseline[field] !== rom[field]) {
                    throw new Error(`analysis baseline ROM mismatch: ${field}`);
                }
            }
            const stateBytes = await idbGet(baseline.slot);
            const invalidState = !stateBytes
                || stateBytes.length !== baseline.stateSize
                || await sha256Hex(stateBytes) !== baseline.stateSha256;
            if (invalidState) throw new Error("analysis baseline state integrity check failed");
            await call("loadState", withInternalMetadata({
                slot: baseline.slot,
                saveFlushBlockMs: params.saveFlushBlockMs
            }, { analysisBaselineSlotToken }));
            await call("setStackTraceMode", { enabled: false });
            await call("setStackTraceMode", { enabled: baseline.traceEnabled });
            await call("setStackTracePrivilegeCheck", { enabled: baseline.skipIrq });
            if (baseline.running && !baseline.paused) await call("resume");
            else await call("pause");
            return {
                ok: true,
                name,
                restored: true,
                ...await snapshotContext(params)
            };
        }
    };
}
