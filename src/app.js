import { createMcpResponder } from "./mcp-responder.js";
import { createCommandRegistry } from "./command-registry.js";
import { createOperationManager } from "./operation-manager.js";
import { createBreakpointOwnerStore } from "./breakpoint-owner-store.js";
import { createBreakpointService } from "./breakpoint-service.js";
import { createFrameService } from "./frame-service.js";
import { createInputSequenceService } from "./input-service.js";
import { createApiDescriptions } from "./api-descriptions.js";
import { createAppState } from "./state.js";
import { installGlobalShortcuts } from "./shortcuts.js";
import { createScriptRunner } from "./script-runner.js";
import { createScriptService } from "./script-service.js";
import { createCommands } from "./commands/command-factory.js";
import { bindUi } from "./ui/ui-controller.js";
import { registerWebMcp } from "./webmcp.js";
import { registerWaitCommands } from "./commands/wait-commands.js";
import { createEmulationLoop } from "./emulation-loop.js";
import { createAlgorithmLoader } from "./algorithm-loader.js";
import { createFrameComparator } from "./frame-comparator.js";
import { createDebuggerService } from "./debugger-service.js";
import { createViewService } from "./ui/view-service.js";
import { createNativeBridge } from "./native-bridge.js";
import { createBinaryTools } from "./binary-tools.js";
import { createFileIoService } from "./file-io-service.js";
import { createRomService } from "./rom-service.js";
import { createSaveService } from "./save-service.js";
import { createStateService } from "./state-service.js";
import { createScreenVisibility } from "./ui/screen-visibility.js";
import { createInputController } from "./ui/input-controller.js";
import { createDebuggerCoordinator } from "./debugger-coordinator.js";
import { createRuntimeTools } from "./runtime-tools.js";
import { createNativeFaultHandler } from "./native-fault-handler.js";
import { createCommandDispatcher } from "./command-dispatcher.js";
import { createScriptPauseService } from "./script-pause-service.js";
import evalWorkerSource from "./workers/eval.worker.js";
const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), el]));
const DESMUME_SCRIPT_URL = "desmume.js?v=20260619-immediate-memory-break";
const state = createAppState();
const runCommand = (name, params = {}) => commandDispatcher.run(name, params);
const runtimeTools = createRuntimeTools({
    state,
    getRomWaitMs: () => ui.romWaitMs.value
});
const { blockSaveFlush, bootWaitMs, sleep, waitChecked } = runtimeTools;
const nativeBridge = createNativeBridge({
    state,
    scriptUrl: DESMUME_SCRIPT_URL,
    onScriptLoading: () => {
        ui.readyText.textContent = "loading emulator";
    },
    onNativeReady: () => log("native module signaled ready"),
    onFault: (error, operation) => handleNativeFault(error, operation),
    onInitialized: async () => {
        nativeBridge.setTraceEnabled(ui.traceToggle.checked);
        state.imageData = ui.screen.getContext("2d").createImageData(256, 384);
        ui.readyLed.className = "led ready";
        ui.readyText.textContent = "ready";
        applyScaleRotation();
        updateStatus();
        scheduleTick();
        await webMcp.registerBrowserTools();
    }
});
const {
    ensureInitialized: ensureWasmReady,
    ensureReady,
    ensureRomLoaded,
    getPc,
    hasLoadedRom,
    tryGetPc
} = nativeBridge;
const binaryTools = createBinaryTools({
    getPc,
    getSelectedCpu: () => state.selectedCpu
});
const {
    bigEndianValue,
    bytesFromFlexibleParams,
    bytesFromParams,
    opcodeWordsFromInput,
    parseAddress,
    parseNumber,
    splitBinaryBits,
    swap16,
    swap32,
    u16FromBytes,
    u32FromBytes
} = binaryTools;
const mcpResponder = createMcpResponder({
    logger: { error: (name, error) => console.error(name, error) },
    pauseSafely: () => {
        state.paused = true;
        state.running = false;
        nativeBridge.pauseWithoutFaultHandling(true);
    }
});
const scriptRunner = createScriptRunner({
    source: evalWorkerSource,
    responder: mcpResponder,
    callCommand: (command, params) => runCommand(command, params),
    getShortcuts: () => Object.entries(window.DesmumeShortcuts || {}).map(([shortcut, definition]) => [
        shortcut,
        definition.command,
        definition.params,
        definition.defaults
    ])
});

const breakpointOwners = createBreakpointOwnerStore({
    onFirstOwner: (site) => {
        if (!state.ready) return;
        nativeBridge.setBreakpoint(site.cpu, site.type, site.address, true);
    },
    onLastOwner: (site) => {
        if (!state.ready) return;
        nativeBridge.setBreakpoint(site.cpu, site.type, site.address, false);
    }
});
const breakpointService = createBreakpointService({ ownerStore: breakpointOwners });
const scriptPauseService = createScriptPauseService();
const algorithmLoader = createAlgorithmLoader({ responder: mcpResponder });
const frameComparator = createFrameComparator({ responder: mcpResponder, algorithmLoader });
const frameService = createFrameService({
    responder: mcpResponder,
    getFrame: () => state.frame,
    compareImplementation: frameComparator.compare,
    capturePixels: () => nativeBridge.captureFramePixels()
});
const screenVisibility = createScreenVisibility({
    state,
    ui,
    frameService,
    tryGetPc
});
const { applyScaleRotation, updateStatus } = screenVisibility;
const inputController = createInputController({ state, ui, native: nativeBridge });
const {
    isTypingTarget,
    releaseAllKeys,
    setKey,
    setTouchState,
    toButtonList,
    updateTouch
} = inputController;
const viewService = createViewService({
    state,
    ui,
    getRegisters: (cpu) => debuggerCoordinator.getRegisters(cpu),
    hasLoadedRom,
    native: nativeBridge,
    parseAddress,
    getIdbPut: () => debuggerService.idbPut
});
const {
    log,
    disasmRefreshParams,
    setFollowPc,
    hex,
    cpsrModeInfo,
    normalizeCallStackData,
    readCallStackData,
    publicOtherCoroutines,
    publicCallStackData,
    memorySearchRanges,
    memorySearchRangeKey,
    copyText,
    rawOutputText,
    setScriptOutput,
    normalizeKeyboardCode,
    saveKeymap,
    loadKeymap,
    renderRegisters,
    renderBreakpoints,
    renderFreezes,
    renderRecentFiles,
    rememberSlot,
    renderStateSlotOptions,
    recordRecentFile,
    renderHotkey
} = viewService;
const handleNativeFault = createNativeFaultHandler({
    state,
    native: nativeBridge,
    log,
    updateStatus,
    blockSaveFlush
});
const debuggerCoordinator = createDebuggerCoordinator({
    state,
    native: nativeBridge,
    breakpointOwners,
    breakpointService,
    getQueueBreakpointRefresh: () => queueBreakpointRefresh,
    log,
    hex,
    updateStatus
});
const {
    breakpointKindName,
    finishPersistentScriptEvent,
    getNativeStatus,
    getRegisters,
    syncNativeBreakStatus,
    withCurrentExecBreakpointSuspended
} = debuggerCoordinator;
const scriptService = createScriptService({
    state,
    ui,
    responder: mcpResponder,
    ensureRomLoaded,
    finishPersistentScriptEvent,
    hex,
    parseAddress,
    rawOutputText,
    runCommand,
    getCommands: () => commands,
    onExplicitPause: (event) => scriptPauseService.publish(event)
});
const {
    scriptConsoleLine,
    renderScriptConsole,
    renderScripts,
    selectScript,
    dispatchScriptEvent,
    startPersistentScript,
    stopPersistentScript,
    scriptSummary
} = scriptService;
const emulationLoop = createEmulationLoop({
    state,
    ui,
    frameService,
    native: nativeBridge,
    handleNativeFault,
    syncNativeBreakStatus,
    dispatchScriptEvent,
    updateStatus
});
const { drawFrame, pumpAudio, applyFreezes, tick, scheduleTick } = emulationLoop;

const analysisBaselineSlotToken = Symbol("analysisBaselineSlot");
const ANALYSIS_BASELINE_SLOT_PREFIX = "__analysis_baseline__:";
const ANALYSIS_BASELINE_STATE_FORMAT_VERSION = 1;

const apiDescriptions = createApiDescriptions();
const fileIo = createFileIoService();
const {
    download,
    openPicker,
    readInput: readFileFromInput
} = fileIo;
const romService = createRomService({
    state,
    native: nativeBridge,
    sleep,
    blockSaveFlush,
    drawFrame
});
const {
    reload: reloadCurrentRom,
    write: writeRomFile
} = romService;
const saveService = createSaveService({ native: nativeBridge, romService });
const { applyAndReload: applySaveAndReloadRom } = saveService;
const stateService = createStateService({
    state,
    native: nativeBridge,
    frameService,
    onScreenInvalid: () => {
        ui.storageStatus.textContent = "画面を更新するには実行を再開してください。";
    },
    onStatusChange: updateStatus,
    onFault: handleNativeFault
});
const {
    invalidateAfterLoad: drawLoadedStateFrame,
    loadBytes: loadStateBytesFromMemory,
    pauseForLoad: pauseForFileLoad,
    restoreAfterLoad: restoreAfterFileLoad,
    stopAfterFailedLoad: stopAfterFailedStateLoad
} = stateService;

applyScaleRotation();

const debuggerService = createDebuggerService({
    ANALYSIS_BASELINE_SLOT_PREFIX,
    ANALYSIS_BASELINE_STATE_FORMAT_VERSION,
    applyFreezes,
    breakpointKindName,
    cpsrModeInfo,
    disasmRefreshParams,
    ensureReady,
    ensureRomLoaded,
    getPc,
    getRegisters,
    handleNativeFault,
    hasLoadedRom,
    hex,
    log,
    native: nativeBridge,
    normalizeCallStackData,
    publicCallStackData,
    readCallStackData,
    renderRegisters,
    setFollowPc,
    state,
    syncNativeBreakStatus,
    ui,
    updateStatus,
    withCurrentExecBreakpointSuspended,
    getCommands: () => commands
});
const {
    formatDisassemblyText,
    shouldIncludeDisassemblyBytes,
    emulatorActivity,
    isAnalysisBaselineSlot,
    currentRomIdentity,
    sha256Hex,
    readAnalysisBaseline,
    writeAnalysisBaseline,
    snapshotContext,
    runDebuggerInstruction,
    runUntilNextBranchOrReturn,
    runUntilTrueNextBranch,
    renderDisassembly,
    renderCallStack,
    refreshDebuggerViews,
    queueBreakpointRefresh,
    stopAutoUpdateLoop,
    queueAutoUpdateLoop,
    runTraceStepper,
    renderMemoryDump,
    modeNumber,
    instructionWidthForMode,
    readSized,
    matchSearchCondition,
    idbPut,
    idbGet
} = debuggerService;

const commands = createCommands({
    ANALYSIS_BASELINE_SLOT_PREFIX,
    ANALYSIS_BASELINE_STATE_FORMAT_VERSION,
    analysisBaselineSlotToken,
    applyFreezes,
    applyScaleRotation,
    applySaveAndReloadRom,
    bigEndianValue,
    blockSaveFlush,
    bootWaitMs,
    breakpointOwners,
    bytesFromFlexibleParams,
    bytesFromParams,
    cancelOperation: (reason) => operationManager.cancel(reason),
    copyText,
    currentRomIdentity,
    dispatchScriptEvent,
    download,
    drawFrame,
    drawLoadedStateFrame,
    emulatorActivity,
    ensureReady,
    ensureRomLoaded,
    ensureWasmReady,
    formatDisassemblyText,
    getPc,
    getRegisters,
    hasLoadedRom,
    hex,
    idbGet,
    idbPut,
    instructionWidthForMode,
    isAnalysisBaselineSlot,
    loadStateBytesFromMemory,
    log,
    matchSearchCondition,
    memorySearchRangeKey,
    memorySearchRanges,
    modeNumber,
    native: nativeBridge,
    opcodeWordsFromInput,
    openPicker,
    parseAddress,
    parseNumber,
    pauseForFileLoad,
    publicCallStackData,
    publicOtherCoroutines,
    pumpAudio,
    queueAutoUpdateLoop,
    readAnalysisBaseline,
    readCallStackData,
    readFileFromInput,
    readSized,
    requireValidScreen: () => frameService.requireValid(),
    recordRecentFile,
    refreshDebuggerViews,
    reloadCurrentRom,
    rememberSlot,
    renderBreakpoints,
    renderCallStack,
    renderFreezes,
    renderHotkey,
    renderMemoryDump,
    renderRecentFiles,
    renderRegisters,
    renderScriptConsole,
    restoreAfterFileLoad,
    runCommand,
    runDebuggerInstruction,
    runIsolatedScript: (code, timeoutMs) => scriptRunner.run(code, timeoutMs),
    runTraceStepper,
    runUntilNextBranchOrReturn,
    runUntilTrueNextBranch,
    saveKeymap,
    scriptSummary,
    setKey,
    setTouchState,
    sha256Hex,
    shouldIncludeDisassemblyBytes,
    snapshotContext,
    splitBinaryBits,
    startPersistentScript,
    state,
    stopAfterFailedStateLoad,
    stopAutoUpdateLoop,
    stopPersistentScript,
    swap16,
    swap32,
    syncNativeBreakStatus,
    tick,
    toButtonList,
    u16FromBytes,
    u32FromBytes,
    ui,
    updateStatus,
    waitChecked,
    writeAnalysisBaseline,
    writeRomFile
});
Object.assign(apiDescriptions, {
    reg: "memoryGetRegisterの短縮名です。",
    regw: "memorySetRegisterの短縮名です。",
    read8: "memoryReadByteの短縮名です。",
    read16: "memoryReadWordの短縮名です。",
    read32: "memoryReadDwordの短縮名です。",
    write8: "memoryWriteByteの短縮名です。",
    write16: "memoryWriteWordの短縮名です。",
    write32: "memoryWriteDwordの短縮名です。"
});

const inputSequenceService = createInputSequenceService({
    responder: mcpResponder,
    press: setKey,
    releaseAll: releaseAllKeys,
    touch: (active, x = 0, y = 0) => setTouchState(active, x, y),
    stepFrames: (frames) => commands.stepFrames({ frames, pauseWhenRunning: false }),
    getPaused: () => state.paused,
    pause: () => commands.pause({ _operation: true }),
    resume: () => commands.resume({ _operation: true })
});
const operationManager = createOperationManager({
    responder: mcpResponder,
    pause: async () => {
        state.paused = true;
        state.running = false;
        if (state.ready) nativeBridge.pause(true);
    },
    releaseInput: async () => { releaseAllKeys(); setTouchState(false); }
});
window.addEventListener("beforeunload", () => operationManager.cancel("page-unload"));

registerWaitCommands({
    commands,
    descriptions: apiDescriptions,
    responder: mcpResponder,
    operationManager,
    breakpointOwners,
    breakpointService,
    scriptPauseService,
    frameService,
    inputSequenceService,
    getNativeStatus,
    parseAddress,
    hex,
    getFrame: () => state.frame
});

const commandRegistry = createCommandRegistry({ responder: mcpResponder });
commandRegistry.registerAll(commands);
const commandDispatcher = createCommandDispatcher({
    state,
    registry: commandRegistry,
    responder: mcpResponder,
    operationManager,
    hasLoadedRom,
    emulatorActivity,
    refreshDebuggerViews,
    updateStatus,
    log
});

const webMcp = registerWebMcp({
    commands,
    descriptions: apiDescriptions,
    responder: mcpResponder,
    runCommand,
    compact: rawOutputText,
    installShortcuts: installGlobalShortcuts,
    logger: log
});

bindUi({
        applyFreezes,
        commands,
        copyText,
        disasmRefreshParams,
        hasLoadedRom,
        isTypingTarget,
        loadKeymap,
        log,
        normalizeKeyboardCode,
        parseAddress,
        parseNumber,
        queueAutoUpdateLoop,
        readCallStackData,
        readFileFromInput,
        refreshDebuggerViews,
        releaseAllKeys,
        rememberSlot,
        renderBreakpoints,
        renderCallStack,
        renderDisassembly,
        renderFreezes,
        renderHotkey,
        renderMemoryDump,
        renderRecentFiles,
        renderRegisters,
        renderScripts,
        renderStateSlotOptions,
        runCommand,
        selectScript,
        setFollowPc,
        setKey,
        state,
        ui,
        updateStatus,
        updateTouch
});
