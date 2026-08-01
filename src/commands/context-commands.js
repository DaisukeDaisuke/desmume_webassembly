import {withInternalMetadata} from "../internal-command-metadata.js";
import {ErrorCode} from "../error-codes.js";
import {readOwnDataProperty} from "../structured-value-normalizer.js";
import {codedError, nonNegativeNumber} from "../validation.js";
import {ResourceLimits} from "../resource-limits.js";

let analysisBaselineTemporarySerial = 0;

export function createContextCommands(context) {
    const {
        ANALYSIS_BASELINE_SLOT_PREFIX,
        analysisBaselineSlotToken,
        call,
        captureAnalysisBaselineScriptState = async () => [],
        currentRomIdentity,
        dispatchScriptEvent = () => {
        },
        emulatorActivity,
        ensureRomLoaded,
        fileTransactionService = {
            run: async (reason, task) => task({
                token: null, commit: async () => {
                }
            })
        },
        getRegisters,
        hasLoadedRom,
        idbGet,
        idbKeys,
        idbDelete,
        idbPut,
        native,
        operationManager = () => null,
        readAnalysisBaseline,
        sha256Hex,
        snapshotContext,
        pauseForFileLoad = () => {
            const activity = {...emulatorActivity(), explicitPauseSerial: state.explicitPauseSerial};
            state.paused = true;
            state.running = false;
            native.pause?.(true);
            return activity;
        },
        restoreAfterFileLoad = (activity) => {
            const shouldResume = !!activity?.running && !activity?.paused;
            state.paused = !shouldResume;
            state.running = shouldResume;
            native.pause?.(!shouldResume);
        },
        state,
        syncNativeBreakStatus,
        ui,
        validateAnalysisBaselineScriptState = async () => {
        },
        restoreAnalysisBaselineScriptState = async () => {
        },
        writeAnalysisBaseline
    } = context;
    const analysisBaselineLocks = new Map();

    function baselineName(params = {}, required = false) {
        if (!Object.hasOwn(params, "name")) {
            if (required) throw codedError(ErrorCode.INVALID_ARGUMENT, "name is required");
            return "default";
        }
        if (typeof params.name !== "string"
            || !params.name
            || params.name.length > ResourceLimits.analysisBaselineNameChars) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `baseline name must be a non-empty string of at most ${ResourceLimits.analysisBaselineNameChars} characters`
            );
        }
        return params.name;
    }

    function beginBaselineOperation(kind, name) {
        const active = state.analysisBaselineOperation;
        if (active) {
            throw codedError(ErrorCode.BUSY, "Analysis baseline operation is already in progress", {
                operationId: active.operationId,
                name: active.name,
                phase: active.phase,
                operation: active.operation
            });
        }
        const operation = {
            operationId: (state.analysisBaselineOperationSerial = Number(
                state.analysisBaselineOperationSerial || 0
            ) + 1),
            name,
            phase: "acquire",
            operation: kind,
            startedAt: Date.now(),
            deferredEffects: []
        };
        state.analysisBaselineOperation = operation;
        return operation;
    }

    function setBaselinePhase(operation, phase) {
        if (state.analysisBaselineOperation === operation) operation.phase = phase;
    }

    async function withBaselineOperation(kind, name, task) {
        const operation = beginBaselineOperation(kind, name);
        try {
            return await task(operation);
        } finally {
            if (state.analysisBaselineOperation === operation) state.analysisBaselineOperation = null;
        }
    }

    async function loadPersistentBaselineState(baseline) {
        const inline = readOwnDataProperty(baseline, "persistentScripts");
        if (inline !== undefined) return inline;
        const slot = readOwnDataProperty(baseline, "persistentScriptsSlot");
        if (!slot) return [];
        const bytes = await idbGet(String(slot));
        const size = Number(readOwnDataProperty(baseline, "persistentScriptsSize"));
        const hash = readOwnDataProperty(baseline, "persistentScriptsSha256");
        if (!bytes || !Number.isSafeInteger(size) || size < 0 || bytes.length !== size
            || typeof hash !== "string" || await sha256Hex(bytes) !== hash) {
            throw codedError(ErrorCode.STATE_INVALID, "analysis baseline persistent script data integrity check failed");
        }
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw codedError(ErrorCode.STATE_INVALID, "analysis baseline persistent script data is invalid");
        }
    }

    async function withAnalysisBaselineLock(name, task) {
        const previous = analysisBaselineLocks.get(name) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        analysisBaselineLocks.set(name, current);
        await previous.catch(() => {
        });
        try {
            return await task();
        } finally {
            release();
            if (analysisBaselineLocks.get(name) === current) {
                analysisBaselineLocks.delete(name);
            }
        }
    }

    const getOperationManager = () => typeof operationManager === "function"
        ? operationManager()
        : operationManager;

    return {
        async status(params = {}) {
            const waitMs = nonNegativeNumber(params.waitMs ?? params.ms ?? 0, "waitMs", 600000);
            if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
            const nativeStatus = state.ready ? native.getStatus() : null;
            if (nativeStatus) syncNativeBreakStatus(nativeStatus);
            return {
                ready: state.ready,
                emulatorLoaded: !!state.emulatorBundleLoaded,
                emulatorLoading: state.nativeInitState === "loading"
                    || state.nativeInitState === "initializing",
                emulatorLoadError: state.emulatorLoadError || null,
                paused: state.paused,
                running: state.running,
                loadingFile: state.loadingFile,
                fileTransaction: {
                    active: !!state.fileTransactionActive,
                    serial: Number(state.fileTransactionSerial || 0),
                    reason: String(state.fileTransactionReason || "")
                },
                stateLoadSerial: Number(state.stateLoadSerial || 0),
                operation: getOperationManager()?.current() || null,
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

        async getOperation() {
            return {
                operation: getOperationManager()?.current() || null
            };
        },

        async cancelOperation() {
            const manager = getOperationManager();
            const operation = manager?.current() || null;
            if (!operation) return {ok: true, cancelled: false, operation: null};
            await manager.cancelAndWait("explicit-cancel");
            return {ok: true, cancelled: true, operation};
        },

        async listStateSlots() {
            const slots = (await idbKeys()).filter((key) => (
                !key.startsWith("save:")
                && !key.startsWith(ANALYSIS_BASELINE_SLOT_PREFIX)
                && !key.startsWith("input-recording:")
            ));
            return {slots};
        },

        async deleteStateSlot(params = {}) {
            const slot = String(params.slot || "");
            if (!slot || slot.startsWith("save:")
                || slot.startsWith(ANALYSIS_BASELINE_SLOT_PREFIX)
                || slot.startsWith("input-recording:")) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "a normal State slot is required");
            }
            await idbDelete(slot);
            return {ok: true, slot};
        },

        async listSaveSlots() {
            return {
                slots: (await idbKeys())
                    .filter((key) => key.startsWith("save:"))
                    .map((key) => key.slice(5))
            };
        },

        async deleteSaveSlot(params = {}) {
            const slot = String(params.slot || "");
            if (!slot) throw codedError(ErrorCode.INVALID_ARGUMENT, "slot is required");
            await idbDelete(`save:${slot}`);
            return {ok: true, slot};
        },

        async listAnalysisBaselines() {
            const baselines = [];
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                if (!key?.startsWith("analysis-baseline:")) continue;
                const name = key.slice("analysis-baseline:".length);
                const baseline = readAnalysisBaseline(name);
                if (baseline) baselines.push({
                    name,
                    savedAt: baseline.savedAt || null,
                    romName: baseline.romName || "",
                    stateSize: Number(baseline.stateSize || 0),
                    stateFormatVersion: Number(baseline.stateFormatVersion || 0),
                    pcVerified: !!baseline.cpuState
                });
            }
            return {baselines};
        },

        async deleteAnalysisBaseline(params = {}) {
            const name = baselineName(params, true);
            return withAnalysisBaselineLock(name, async () => {
            const baseline = readAnalysisBaseline(name);
            if (!baseline) throw codedError(ErrorCode.STATE_NOT_LOADED, `analysis baseline not found: ${name}`);
            await idbDelete(String(baseline.slot || `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}`));
            if (baseline.persistentScriptsSlot) await idbDelete(String(baseline.persistentScriptsSlot));
                state.analysisBaselines.delete(name);
                localStorage.removeItem(`analysis-baseline:${name}`);
                return {ok: true, name};
            });
        },

        async snapshotContext(params = {}) {
            return snapshotContext(params);
        },

        async saveAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline requires a loaded ROM");
            const name = baselineName(params);
            return withBaselineOperation("save", name, async (operation) => {
                return withAnalysisBaselineLock(name, async () => {
                    const existing = readAnalysisBaseline(name);
                    if (existing && params.replace !== true) {
                        throw codedError(
                            ErrorCode.INVALID_ARGUMENT,
                            `analysis baseline already exists: ${name}; pass replace:true to overwrite it`
                        );
                    }
                    const slot = `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}:temporary:${Date.now().toString(36)}-${++analysisBaselineTemporarySerial}`;
                    const scriptSlot = `${slot}:scripts`;
                    const generation = state.romGeneration;
                    const activity = emulatorActivity();
                    return fileTransactionService.run("Analysis baseline save", async ({commit}) => {
                        await commit?.();
                        const runState = pauseForFileLoad();
                        let committed = false;
                        try {
                            setBaselinePhase(operation, "save-hooks");
                            const persistentScripts = await captureAnalysisBaselineScriptState(name);
                            // Re-check the exact participant set after all awaits and
                            // immediately before Native State capture.
                            await validateAnalysisBaselineScriptState(persistentScripts);
                            setBaselinePhase(operation, "native-save");
                            if (generation !== state.romGeneration) {
                                throw codedError(ErrorCode.CANCELLED, "ROM changed while saving analysis baseline");
                            }
                            const stateBytes = native.saveStateBytes();
                            const cpuState = {
                                arm9: {
                                    pc: Number(getRegisters("arm9").pc) >>> 0,
                                    cpsr: Number(getRegisters("arm9").cpsr) >>> 0
                                },
                                arm7: {
                                    pc: Number(getRegisters("arm7").pc) >>> 0,
                                    cpsr: Number(getRegisters("arm7").cpsr) >>> 0
                                }
                            };
                            const identity = await currentRomIdentity();
                            if (generation !== state.romGeneration) {
                                throw codedError(ErrorCode.CANCELLED, "ROM changed while saving analysis baseline");
                            }
                            const stateSha256 = await sha256Hex(stateBytes);
                            const scriptBytes = new TextEncoder().encode(JSON.stringify(persistentScripts));
                            const persistentScriptsSha256 = await sha256Hex(scriptBytes);
                            const baseline = {
                                name,
                                metadataVersion: 1,
                                persistentScriptsStorageVersion: 1,
                                slot,
                                persistentScriptsSlot: scriptSlot,
                                persistentScriptsSize: scriptBytes.length,
                                persistentScriptsSha256,
                                ...identity,
                                stateSize: stateBytes.length,
                                stateSha256,
                                cpuState,
                                ...activity,
                                skipIrq: !!ui.tracePrivilegeToggle.checked,
                                traceEnabled: !!ui.traceToggle.checked,
                                savedAt: new Date().toISOString()
                            };
                            Object.defineProperty(baseline, "persistentScripts", {
                                value: persistentScripts,
                                enumerable: false,
                                configurable: true
                    });
                    setBaselinePhase(operation, "commit");
                    try {
                        await idbPut(slot, stateBytes);
                        await idbPut(scriptSlot, scriptBytes);
                        writeAnalysisBaseline(name, baseline);
                        committed = true;
                    } finally {
                                if (!committed) {
                                    await idbDelete(slot).catch(() => {
                                    });
                                    await idbDelete(scriptSlot).catch(() => {
                                    });
                                }
                            }
                            const previousSlot = existing
                                ? String(existing.slot || `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}`)
                                : null;
                            const previousScriptSlot = existing?.persistentScriptsSlot
                                ? String(existing.persistentScriptsSlot)
                                : null;
                            if (previousSlot && previousSlot !== slot) await idbDelete(previousSlot).catch(() => {
                            });
                            if (previousScriptSlot && previousScriptSlot !== scriptSlot) {
                                await idbDelete(previousScriptSlot).catch(() => {
                                });
                            }
                            return {
                                ok: true,
                                name,
                                slot,
                                size: stateBytes.length,
                                pcVerified: true,
                                cpuState,
                                ...emulatorActivity(),
                                skipIrq: baseline.skipIrq,
                                traceEnabled: baseline.traceEnabled
                            };
                        } finally {
                            restoreAfterFileLoad(runState);
                        }
                    });
                });
            });
        },

        async restoreAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline restore requires a loaded ROM");
            const name = baselineName(params);
            return withBaselineOperation("restore", name, async (operation) => {
                return withAnalysisBaselineLock(name, async () => {
                    return fileTransactionService.run("Analysis baseline restore", async ({token, commit}) => {
                        const baseline = readAnalysisBaseline(name);
                        if (!baseline) {
                            throw codedError(ErrorCode.STATE_NOT_LOADED, `analysis baseline not found: ${name}`);
                        }
                        const rom = await currentRomIdentity();
                        for (const field of ["romName", "romSize", "romSha256"]) {
                            if (baseline[field] !== rom[field]) {
                                throw codedError(
                                    ErrorCode.STATE_INVALID,
                                    `analysis baseline ROM mismatch: ${field}`,
                                    {field}
                                );
                            }
                        }
                        const stateBytes = await idbGet(baseline.slot);
                        const invalidState = !stateBytes
                            || stateBytes.length !== baseline.stateSize
                            || await sha256Hex(stateBytes) !== baseline.stateSha256;
                        if (invalidState) {
                            throw codedError(
                                ErrorCode.STATE_INVALID,
                                "analysis baseline state integrity check failed"
                            );
                        }
                        await commit?.();
                        setBaselinePhase(operation, "validate");
                        const persistentScripts = await loadPersistentBaselineState(baseline);
                        const restorePlan = await validateAnalysisBaselineScriptState(persistentScripts);
                        if (restorePlan) setBaselinePhase(operation, "validated");
                        if (Array.isArray(restorePlan)) {
                            for (const entry of restorePlan) {
                                const script = entry?.script;
                                if (script && (script.scriptInstanceId !== entry.scriptInstanceId
                                    || !script.running
                                    || !script.started
                                    || !script.baselineHookRegistered)) {
                                    throw codedError(
                                        ErrorCode.STATE_INVALID,
                                        `Analysis baseline persistent script instance changed: ${entry.name || "unknown"}`,
                                        { scriptName: entry.name || null }
                                    );
                                }
                            }
                        }
                        await call("loadState", withInternalMetadata({
                            slot: baseline.slot,
                            saveFlushBlockMs: params.saveFlushBlockMs
                        }, {
                            analysisBaselineSlotToken,
                            fileTransactionToken: token,
                            holdPaused: true,
                            operation: "analysisBaseline",
                            deferStateLoadEvent: true
                        }));
                        setBaselinePhase(operation, "native-loaded");
                        state.paused = true;
                        state.running = false;
                        native.pause(true);
                        const restoredCpuState = {
                            arm9: {
                                pc: Number(getRegisters("arm9").pc) >>> 0,
                                cpsr: Number(getRegisters("arm9").cpsr) >>> 0
                            },
                            arm7: {
                                pc: Number(getRegisters("arm7").pc) >>> 0,
                                cpsr: Number(getRegisters("arm7").cpsr) >>> 0
                            }
                        };
                        const pcVerified = !!baseline.cpuState;
                        const restoredScripts = [];
                        try {
                            if (pcVerified) {
                                for (const cpu of ["arm9", "arm7"]) {
                                    for (const register of ["pc", "cpsr"]) {
                                        if ((Number(baseline.cpuState[cpu]?.[register]) >>> 0)
                                            !== restoredCpuState[cpu][register]) {
                                            throw new Error(`analysis baseline ${cpu} ${register} mismatch`);
                                        }
                                    }
                                }
                            }
                            setBaselinePhase(operation, "restore-hooks");
                            await restoreAnalysisBaselineScriptState(name, restorePlan || persistentScripts, restoredScripts);
                            setBaselinePhase(operation, "restore-effects");
                            const deferredEffects = [...(operation.deferredEffects || [])];
                            operation.deferredEffects.length = 0;
                            for (const effect of deferredEffects) await call(effect.command, effect.params);
                            if (ui.traceToggle.checked !== !!baseline.traceEnabled) {
                                await call("setStackTraceMode", {enabled: baseline.traceEnabled});
                            }
                            await call("setStackTracePrivilegeCheck", {enabled: baseline.skipIrq});
                            dispatchScriptEvent("stateLoad", {slot: baseline.slot, analysisBaseline: true});
                            if (baseline.running && !baseline.paused) await call("resume");
                            else await call("pause");
                            setBaselinePhase(operation, "complete");
                            return {
                                ok: true,
                                name,
                                restored: true,
                                pcVerified,
                                cpuState: restoredCpuState,
                                ...await snapshotContext(params)
                            };
                    } catch (error) {
                        operation.deferredEffects.length = 0;
                        native.pause?.(true);
                            state.paused = true;
                            state.running = false;
                            throw codedError(
                                ErrorCode.STATE_PARTIALLY_RESTORED,
                                `Analysis baseline restore partially completed: ${String(error?.message || error)}`,
                                {
                                    nativeStateApplied: true,
                                    restoredScripts,
                                    remainingScripts: (restorePlan || persistentScripts).map((entry) => (
                                        readOwnDataProperty(entry, "name") || entry.script?.name || ""
                                    )).filter((scriptName) => !restoredScripts.includes(scriptName)),
                                    failedScript: error?.mcpDetails?.scriptName || null,
                                    paused: true,
                                    causeCode: error?.mcpCode || null
                                }
                            );
                        }
                    });
                });
            });
        }
    };
}
