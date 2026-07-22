import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createMcpResponder } from "../src/mcp-responder.js";
import { createOperationManager } from "../src/operation-manager.js";
import { createInputSequenceService } from "../src/input-service.js";
import { createRuntimeCommands } from "../src/commands/runtime-commands.js";
import { createInputCommands } from "../src/commands/input-commands.js";
import { createStateCommands } from "../src/commands/state-commands.js";
import { createStateService } from "../src/state-service.js";
import { createSaveCommands } from "../src/commands/save-commands.js";
import { createScreenshotCommands } from "../src/commands/screenshot-commands.js";
import { createViewService } from "../src/ui/view-service.js";
import { createEmulationLoop } from "../src/emulation-loop.js";
import { createCommandDispatcher } from "../src/command-dispatcher.js";
import { createCommandRegistry } from "../src/command-registry.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createDebuggerCoordinator } from "../src/debugger-coordinator.js";
import { createDebuggerService } from "../src/debugger-service.js";
import { registerWebMcp } from "../src/webmcp.js";
import { unwrapLegacyScalar } from "../src/legacy-scalar.js";
import { withInternalMetadata } from "../src/internal-command-metadata.js";
import { containsDynamicImport } from "../src/script-source-policy.js";
import { createScriptRunner } from "../src/script-runner.js";
import { createScreenInvalidNotice, SCREEN_INVALID_NOTICE } from "../src/screen-invalid-notice.js";

const responder = createMcpResponder({ logger: {} });
const FRAMEBUFFER_BYTES = 256 * 384 * 4;

function memoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
}

async function runEvalSandbox(code) {
    const source = await readFile(new URL("../src/workers/eval.worker.js", import.meta.url), "utf8");
    const messages = [];
    const listeners = new Map();
    let networkCalls = 0;
    const context = vm.createContext({
        console,
        crypto: { randomUUID: () => "sandbox-token" },
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        fetch: () => { networkCalls++; return Promise.resolve({ ok: true }); },
        XMLHttpRequest: function XMLHttpRequest() { networkCalls++; },
        WebSocket: function WebSocket() { networkCalls++; },
        EventSource: function EventSource() { networkCalls++; },
        Worker: function Worker() { networkCalls++; },
        SharedWorker: function SharedWorker() { networkCalls++; },
        importScripts: () => { networkCalls++; },
        BroadcastChannel: function BroadcastChannel() { networkCalls++; },
        WebTransport: function WebTransport() { networkCalls++; },
        indexedDB: {},
        caches: {}
    });
    vm.runInContext(source, context, { filename: "eval.worker.js" });
    await listeners.get("message")({ data: { type: "run", code, shortcuts: [] } });
    return { messages, networkCalls };
}

test("input sequence restores pause without cancelling its own operation", async () => {
    const state = { ready: true, paused: true, running: false, explicitPauseSerial: 0 };
    const native = { pause: () => {}, clearBreakStatus: () => {} };
    let manager;
    const commands = createRuntimeCommands({
        cancelOperation: (reason) => manager.cancel(reason),
        ensureReady: () => {},
        hasLoadedRom: () => true,
        native,
        state,
        updateStatus: () => {},
        onScreenValid: () => {}
    });
    const input = createInputSequenceService({
        responder,
        press: () => {},
        releaseAll: () => {},
        touch: () => {},
        stepFrames: async () => {},
        getPaused: () => state.paused,
        pause: () => commands.pause(withInternalMetadata({}, { operation: true })),
        resume: () => commands.resume(withInternalMetadata({}, { operation: true })),
        storage: memoryStorage()
    });
    manager = createOperationManager({ responder });

    const result = await manager.run({
        name: "runInputSequence",
        timeoutMs: 1000,
        task: (operation) => input.run({ seq: [["w", 0]] }, operation)
    });

    assert.equal(result.ok, true);
    assert.equal(state.paused, true);
    assert.equal(manager.current(), null);
});

test("legacy scalar helpers unwrap values and preserve structured failures", async () => {
    assert.equal(unwrapLegacyScalar({ ok: true, value: 0x02075628 }, "memoryGetRegister"), 0x02075628);
    assert.equal(unwrapLegacyScalar(7, "memoryReadByte"), 7);
    assert.throws(
        () => unwrapLegacyScalar({ ok: true, rows: [] }, "memoryReadDword"),
        /did not return a scalar result/
    );
    assert.throws(
        () => unwrapLegacyScalar({ ok: false, error: { code: "NATIVE_ERROR", message: "read failed", details: { nativeCode: 4 } } }, "memoryReadDword"),
        (error) => error.code === "NATIVE_ERROR" && error.details.nativeCode === 4
    );
});

test("window.memory scalar aliases return numbers while DesmumeMCP.call stays structured", async () => {
    const previous = Object.fromEntries(["window", "navigator", "document"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name)
    ]));
    const listeners = [];
    Object.defineProperty(globalThis, "window", {
        value: {
            addEventListener: (...args) => listeners.push(args),
            location: { origin: "http://localhost" }
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
    try {
        const calls = [];
        const runCommand = async (command) => {
            calls.push(command);
            return { ok: true, value: command === "memoryGetRegister" ? 0x02075628 : 0x12345678 };
        };
        registerWebMcp({
            commands: {}, descriptions: {}, responder, runCommand,
            compact: String, installShortcuts: () => {}, logger: () => {}
        });
        assert.equal(await window.memory.reg("r14", "arm9"), 0x02075628);
        assert.equal(await window.memory.read32(0x02385f0c, "arm9"), 0x12345678);
        assert.equal(String(await window.memory.reg("r14", "arm9")).includes("[object Object]"), false);
        assert.deepEqual(await window.DesmumeMCP.call("memoryGetRegister", {}), { ok: true, value: 0x02075628 });
        assert.deepEqual(calls, ["memoryGetRegister", "memoryReadDword", "memoryGetRegister", "memoryGetRegister"]);
    } finally {
        for (const name of ["window", "navigator", "document"]) {
            if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
            else delete globalThis[name];
        }
    }
});

function createStateCommandHarness(runState, nativeResult = 0) {
    const invalidations = [];
    const state = { frame: 9 };
    const commands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        blockSaveFlush: () => {},
        bytesFromParams: () => new Uint8Array([1]),
        cancelOperation: () => {},
        dispatchScriptEvent: () => {},
        download: () => {},
        drawLoadedStateFrame: (options) => invalidations.push(options),
        ensureReady: () => {},
        ensureRomLoaded: () => {},
        idbGet: async () => null,
        idbPut: async () => {},
        isAnalysisBaselineSlot: () => false,
        loadStateBytesFromMemory: () => nativeResult,
        log: () => {},
        native: {
            loadBufferedState: () => nativeResult,
            loadStateFile: () => nativeResult
        },
        openPicker: async () => ({ file: { name: "state.dst" }, bytes: new Uint8Array([1]) }),
        pauseForFileLoad: () => ({ ...runState }),
        readFileFromInput: async () => ({ file: { name: "state.dst" }, bytes: new Uint8Array([1]) }),
        recordRecentFile: async () => {},
        rememberSlot: () => {},
        restoreAfterFileLoad: () => {},
        state,
        stopAfterFailedStateLoad: () => {},
        ui: { stateFile: { files: [] } }
    });
    return { commands, invalidations, state };
}

test("State load notice follows the run state that existed before loading", async () => {
    const running = createStateCommandHarness({ running: true, paused: false });
    await running.commands.loadState();
    assert.deepEqual(running.invalidations, [{ showResumeNotice: false }]);

    const paused = createStateCommandHarness({ running: false, paused: true });
    await paused.commands.loadState();
    assert.deepEqual(paused.invalidations, [{ showResumeNotice: true }]);
});

test("State service forwards notice ownership and preserves the requested run state", () => {
    const notices = [];
    const pauses = [];
    const state = {
        running: true, paused: false, ready: true, loadingFile: false,
        frameBudget: 3, lastTick: 0, nativeFault: false,
        screenValid: true, framesSinceStateLoad: 4, stateLoadSerial: 0,
        breakLabel: "break", breakRefreshKey: "break"
    };
    const service = createStateService({
        state,
        native: { pause: (value) => pauses.push(value), clearBreakStatus: () => {} },
        frameService: { invalidateAfterStateLoad: () => {} },
        onScreenInvalid: (options) => notices.push(options),
        onStatusChange: () => {}
    });
    const before = service.pauseForLoad();
    service.invalidateAfterLoad({ showResumeNotice: false });
    service.restoreAfterLoad(before);
    assert.deepEqual(notices, [{ showResumeNotice: false }]);
    assert.equal(state.running, true);
    assert.equal(state.paused, false);
    assert.deepEqual(pauses, [true, false]);
});

test("State resume notice clears only text that it owns", () => {
    const status = { dataset: {}, textContent: "save loaded slot" };
    const notice = createScreenInvalidNotice(status);
    notice.clear();
    assert.equal(status.textContent, "save loaded slot");

    notice.show();
    assert.equal(status.textContent, SCREEN_INVALID_NOTICE);
    assert.equal(status.dataset.screenInvalidNotice, "true");
    notice.clear();
    assert.equal(status.textContent, "");
    assert.equal("screenInvalidNotice" in status.dataset, false);

    notice.show();
    status.textContent = "state saved later";
    notice.clear();
    assert.equal(status.textContent, "state saved later");
    assert.equal("screenInvalidNotice" in status.dataset, false);
});

test("first manual frame after State load becomes valid before canvas draw", async () => {
    let valid = false;
    let draws = 0;
    let noticeClears = 0;
    const state = {
        frame: 0, running: false, paused: true, ready: true, render: true,
        touch: { active: false }, keys: 0, screenValid: false,
        framesSinceStateLoad: 0, completedFrameSerial: 0
    };
    const commands = createRuntimeCommands({
        applyFreezes: () => {},
        cancelOperation: () => {},
        dispatchScriptEvent: () => {},
        drawFrame: () => { assert.equal(valid, true); draws++; },
        ensureRomLoaded: () => {},
        frameService: {
            onFrameCompleted: () => { valid = true; },
            isValid: () => valid
        },
        native: {
            pause: () => {},
            runFrames: () => { state.frame = 1; return 1; }
        },
        onScreenValid: () => { noticeClears++; },
        pumpAudio: () => {},
        state,
        syncNativeBreakStatus: () => ({ lastBreak: { hit: false } }),
        updateStatus: () => {}
    });
    const result = await commands.stepFrames({ frames: 1 });
    assert.equal(result.frames, 1);
    assert.equal(draws, 1);
    assert.equal(noticeClears, 1);
    assert.equal(state.screenValid, true);
    assert.equal(state.completedFrameSerial, 1);
});

test("predictable State and Save native failures carry NATIVE_ERROR details", async () => {
    const stateHarness = createStateCommandHarness({ running: false, paused: true }, 7);
    await assert.rejects(
        stateHarness.commands.loadState(),
        (error) => error.mcpCode === "NATIVE_ERROR" && error.mcpDetails.nativeCode === 7
    );

    const save = createSaveCommands({
        ui: { stateSlot: { value: "slot" } },
        native: { exportSaveBytes: () => new Uint8Array() },
        ensureRomLoaded: () => {},
        rememberSlot: () => {},
        download: () => {}
    });
    await assert.rejects(
        save.exportSaveFile(),
        (error) => error.mcpCode === "NATIVE_ERROR" && error.mcpDetails.size === 0
    );
});

test("speed, scale, rotation, and custom search length reject collapsing values", async () => {
    const state = { speed: 1, scale: 2, rotation: 0 };
    const ui = {
        speedSelect: { value: "1" },
        scaleSelect: { value: "2" },
        rotationSelect: { value: "0" },
        searchAddress: { value: "0" },
        searchLength: { value: "64" }
    };
    const runtime = createRuntimeCommands({
        applyScaleRotation: () => {},
        state,
        ui,
        updateStatus: () => {}
    });
    for (const value of [0, -1, Number.NaN, 1.25]) {
        await assert.rejects(runtime.setScale({ scale: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    for (const value of [-90, 45, Number.NaN]) {
        await assert.rejects(runtime.setRotation({ rotation: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    for (const value of [0, -1, Number.NaN, 0.75]) {
        await assert.rejects(runtime.setSpeed({ speed: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual({ speed: state.speed, scale: state.scale, rotation: state.rotation }, { speed: 1, scale: 2, rotation: 0 });

    const view = createViewService({
        state: { selectedCpu: "arm9" },
        ui,
        parseAddress: Number,
        getIdbPut: () => async () => {}
    });
    for (const length of [0, -1, Number.NaN, 1.5, 16 * 1024 * 1024 + 1]) {
        assert.throws(() => view.memorySearchRanges({ address: 0, length }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual(view.memorySearchRanges({ address: 32, length: 64 }), [{ name: "custom", address: 32, length: 64 }]);
});

test("NaN command inputs are rejected before mutable emulator state is touched", async () => {
    const runtimeState = {
        speed: 1, scale: 2, rotation: 0, audio: false,
        autoUpdate: { enabled: false, hz: 4 },
        running: false, paused: true, frame: 10
    };
    const runtimeUi = {
        speedSelect: { value: "1" }, scaleSelect: { value: "2" }, rotationSelect: { value: "0" },
        audioToggle: { checked: false }, volumeRange: { value: "0.25" },
        autoUpdateToggle: { checked: false }, autoUpdateRate: { value: "4" }
    };
    let nativeCalls = 0;
    const runtime = createRuntimeCommands({
        applyScaleRotation: () => {}, cancelOperation: () => {}, ensureRomLoaded: () => {},
        native: { pause: () => { nativeCalls++; }, runFrames: () => { nativeCalls++; return 0; } },
        queueAutoUpdateLoop: () => {}, state: runtimeState, stopAutoUpdateLoop: () => {},
        ui: runtimeUi, updateStatus: () => {}
    });
    const runtimeBefore = structuredClone(runtimeState);
    await assert.rejects(runtime.setAutoUpdate({ enabled: true, hz: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(runtime.setAudio({ enabled: true, volume: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(runtime.stepFrames({ frames: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    assert.deepEqual(runtimeState, runtimeBefore);
    assert.equal(runtimeUi.audioToggle.checked, false);
    assert.equal(runtimeUi.volumeRange.value, "0.25");
    assert.equal(nativeCalls, 0);

    const inputState = { keys: 0, touch: { active: false }, keymap: {} };
    const inputEvents = [];
    const input = createInputCommands({
        state: inputState, ensureRomLoaded: () => {}, renderHotkey: () => {}, saveKeymap: () => {},
        setKey: (...args) => inputEvents.push(["key", ...args]),
        setTouchState: (...args) => inputEvents.push(["touch", ...args]),
        toButtonList: () => ["A"], waitChecked: async () => {}
    });
    for (const call of [
        () => input.runInputTap({ button: "A", repeat: Number.NaN }),
        () => input.runInputTap({ button: "A", holdMs: Number.NaN }),
        () => input.runInputHold({ button: "A", timeoutMs: Number.NaN }),
        () => input.runInputHold({ button: "A", waitBeforeMs: Number.NaN }),
        () => input.runTouchHold({ x: Number.NaN, y: 0 })
    ]) {
        await assert.rejects(call(), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual(inputState, { keys: 0, touch: { active: false }, keymap: {} });
    assert.deepEqual(inputEvents, []);

    let cancellations = 0;
    let stateLoads = 0;
    const stateCommands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        cancelOperation: () => { cancellations++; }, ensureRomLoaded: () => {},
        isAnalysisBaselineSlot: () => false,
        native: { loadBufferedState: () => { stateLoads++; return 0; } },
        pauseForFileLoad: () => ({ running: false, paused: true }), state: { frame: 7 }, ui: {}
    });
    await assert.rejects(
        stateCommands.loadState({ saveFlushBlockMs: Number.NaN }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(cancellations, 0);
    assert.equal(stateLoads, 0);

    const screenshotState = { screenshotCooldownUntil: 123 };
    const screenshot = createScreenshotCommands({
        requireValidScreen: () => null,
        state: screenshotState,
        ui: { screen: { toDataURL: () => "data:image/png;base64,", width: 256, height: 384 } }
    });
    await assert.rejects(
        screenshot.takeScreenshot({ cooldownMs: Number.NaN, download: false }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(screenshotState.screenshotCooldownUntil, 123);

    const debuggerHarness = createExecStepHarness("mov r0, r0");
    debuggerHarness.state.breakRefreshKey = "preserve";
    await assert.rejects(
        debuggerHarness.service.runDebuggerInstruction("step", { count: Number.NaN }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(debuggerHarness.state.breakRefreshKey, "preserve");
    assert.equal(debuggerHarness.pc(), 0x02000000);
});

test("invalid framebuffer and collapsed shell diagnostics preserve the last canvas", () => {
    let canvasWrites = 0;
    const logs = [];
    const state = {
        ready: true, render: true, scale: 2, rotation: 0,
        imageData: { data: new Uint8ClampedArray(FRAMEBUFFER_BYTES) }
    };
    const loop = createEmulationLoop({
        state,
        ui: {
            screen: {
                isConnected: false,
                getContext: () => ({ putImageData: () => { canvasWrites++; } })
            },
            screenShell: { getBoundingClientRect: () => ({ width: 0, height: Number.NaN }) }
        },
        frameService: { isValid: () => true },
        native: { getFrameBytes: () => new Uint8Array(12) },
        handleNativeFault: () => {},
        syncNativeBreakStatus: () => ({}),
        dispatchScriptEvent: () => {},
        updateStatus: () => {},
        log: (message) => logs.push(message)
    });
    assert.throws(() => loop.drawFrame(), /invalid framebuffer length/);
    assert.equal(canvasWrites, 0);
    assert.ok(logs.some((message) => message.includes("canvas detached")));
    assert.ok(logs.some((message) => message.includes("shell collapsed")));
});

test("dispatcher owns one debugger refresh per command cycle", async () => {
    let refreshes = 0;
    const dispatcher = createCommandDispatcher({
        state: { ready: true, loadingFile: false },
        registry: { execute: async () => responder.ok() },
        responder,
        operationManager: { current: () => null },
        hasLoadedRom: () => true,
        emulatorActivity: () => ({}),
        refreshDebuggerViews: async () => { refreshes++; },
        updateStatus: () => {},
        log: () => {}
    });
    await dispatcher.run("step", { count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(refreshes, 1);

    const uiSource = await readFile(new URL("../src/ui/ui-controller.js", import.meta.url), "utf8");
    assert.doesNotMatch(uiSource, /runCommand\("(?:pause|stepFrames|step|smartStep|stepOver|stepNextBranchOrReturn|trueNextBranch)"[^\n]*\.then\(\(\) => refreshDebuggerViews/);
    assert.doesNotMatch(uiSource, /runCommand\("setRegister"[^\n]*\.then\(\(\) => refreshDebuggerViews/);
});

test("NaN and undefined command names return UNKNOWN_COMMAND without corrupting state", async () => {
    const state = { ready: false, paused: true, running: false, marker: "preserve" };
    const registry = createCommandRegistry({ responder });
    registry.register("status", async () => responder.ok({ marker: state.marker }));
    const dispatcher = createCommandDispatcher({
        state, registry, responder,
        operationManager: { current: () => null }, hasLoadedRom: () => false,
        emulatorActivity: () => ({}), refreshDebuggerViews: async () => {},
        updateStatus: () => {}, log: () => {}
    });
    const before = structuredClone(state);
    for (const name of [Number.NaN, undefined, null, "", "not-a-command"]) {
        const result = await dispatcher.run(name, undefined);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "UNKNOWN_COMMAND");
        assert.deepEqual(state, before);
    }
    assert.equal((await dispatcher.run("status", undefined)).ok, true);
    assert.deepEqual(state, before);
});

test("single dispatcher refresh keeps register change highlighting for the command cycle", async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const classes = new Set();
    const label = { textContent: "r0" };
    const output = { textContent: "" };
    const input = { value: "" };
    const row = {
        classList: {
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
            remove: (name) => classes.delete(name)
        },
        querySelector: (selector) => ({ span: label, b: output, input }[selector])
    };
    Object.defineProperty(globalThis, "document", {
        value: { activeElement: null }, configurable: true, writable: true
    });
    try {
        let r0 = 0;
        let refreshes = 0;
        const state = { selectedCpu: "arm9", previousRegisters: null, ready: true, loadingFile: false };
        const view = createViewService({
            state,
            ui: { registers: { querySelectorAll: () => [row] } },
            getRegisters: () => ({ r0 }),
            hasLoadedRom: () => true,
            getIdbPut: () => async () => {}
        });
        view.renderRegisters();
        const dispatcher = createCommandDispatcher({
            state,
            registry: { execute: async () => { r0 = 1; return responder.ok(); } },
            responder,
            operationManager: { current: () => null },
            hasLoadedRom: () => true,
            emulatorActivity: () => ({}),
            refreshDebuggerViews: async () => { refreshes++; view.renderRegisters(); },
            updateStatus: () => {}, log: () => {}
        });
        await dispatcher.run("step", {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(refreshes, 1);
        assert.equal(classes.has("changed"), true);

        await dispatcher.run("step", {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(refreshes, 2);
        assert.equal(classes.has("changed"), false);
    } finally {
        if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
        else delete globalThis.document;
    }
});

function createExecStepHarness(instruction = "bl 02000010") {
    const site = { cpu: "arm9", type: "exec", address: 0x02000000 };
    let pc = site.address;
    let enabled = false;
    let disables = 0;
    let enables = 0;
    const state = {
        ready: true, selectedCpu: "arm9", paused: true, running: false,
        breakpoints: [], autoUpdate: {}, highlightedDisasmAddress: null,
        highlightedCallstackAddress: null, highlightedCallstackCpsr: null,
        breakLabel: "", breakRefreshKey: ""
    };
    const native = {
        setBreakpoint: (_cpu, _type, _address, value) => {
            enabled = value;
            if (value) enables++;
            else disables++;
        },
        getStatus: () => ({ arm9: { pc }, lastBreak: { hit: false } }),
        clearBreakStatus: () => {},
        step: () => {
            if (enabled && pc === site.address) return 0;
            pc += 4;
            return 1;
        },
        stepOver: () => {
            if (enabled && pc === site.address) return 0;
            pc += 4;
            return 1;
        }
    };
    const owners = createBreakpointOwnerStore({
        onFirstOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, true),
        onLastOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, false)
    });
    owners.addOwner(site, { id: 1, origin: "user" });
    const coordinator = createDebuggerCoordinator({
        state, native, breakpointOwners: owners,
        breakpointService: { publish: () => {} },
        getQueueBreakpointRefresh: () => () => {}, log: () => {}, hex: String, updateStatus: () => {}
    });
    const commands = {
        disassemble: async () => ({
            text: `=>${pc.toString(16).padStart(8, "0")}: eb000000 ${
                typeof instruction === "function" ? instruction(pc) : instruction
            }`
        })
    };
    const service = createDebuggerService({
        applyFreezes: () => {}, breakpointKindName: () => "", cpsrModeInfo: () => ({ className: "" }),
        disasmRefreshParams: (value) => value, ensureReady: () => {}, ensureRomLoaded: () => {},
        getPc: () => pc, getRegisters: () => ({ pc }), hasLoadedRom: () => true,
        hex: (value) => `0x${Number(value).toString(16)}`, log: () => {}, native,
        normalizeCallStackData: (value) => value, readCallStackData: () => ({ enabled: true, frames: [] }),
        renderRegisters: () => {}, setFollowPc: () => {}, state,
        syncNativeBreakStatus: () => native.getStatus(),
        ui: { traceToggle: { checked: false }, tracePrivilegeToggle: { checked: false } },
        updateStatus: () => {}, withCurrentExecBreakpointSuspended: coordinator.withCurrentExecBreakpointSuspended,
        getCommands: () => commands
    });
    return { service, state, pc: () => pc, disables: () => disables, enables: () => enables };
}

test("stepOver and smartStep leave a current exec breakpoint without re-hitting it", async () => {
    for (const kind of ["stepOver", "smartStep"]) {
        const harness = createExecStepHarness();
        const result = await harness.service.runDebuggerInstruction(kind);
        assert.equal(result.count, 1);
        assert.equal(harness.pc(), 0x02000004);
        assert.equal(harness.disables(), 1);
        assert.equal(harness.enables(), 2);
    }
});

test("next-branch stepping safely leaves current exec breakpoint for step and stepOver paths", async () => {
    for (const firstInstruction of ["mov r0, r0", "bl 02000010"]) {
        const harness = createExecStepHarness((pc) => (
            pc === 0x02000000 ? firstInstruction : "b 02000020"
        ));
        const result = await harness.service.runUntilNextBranchOrReturn({ maxSteps: 2, timeoutMs: 1000 });
        assert.equal(result.steps, 1);
        assert.equal(harness.pc(), 0x02000004);
        assert.equal(harness.disables(), 1);
        assert.equal(harness.enables(), 2);
    }
});

test("script source policy rejects comment-separated and templated dynamic imports", () => {
    for (const source of [
        'import("https://example.com/module.js")',
        'import/**/("https://example.com/module.js")',
        'import /* split */ ("https://example.com/module.js")',
        'import<!-- split\n("https://example.com/module.js")',
        'const value = `${import/**/("https://example.com/module.js")}`'
    ]) {
        assert.equal(containsDynamicImport(source), true, source);
    }
    for (const source of [
        '"import(\\"https://example.com\\")"',
        '// import("https://example.com")\nreturn 1',
        'const pattern = /import\\s*\\(/; return pattern.test("x")',
        'const important = () => 1; return important()'
    ]) {
        assert.equal(containsDynamicImport(source), false, source);
    }
});

test("eval command rejects dynamic import bypass before any Worker starts", async () => {
    let workerStarts = 0;
    const runner = createScriptRunner({
        source: "supervisor", sandboxSource: "sandbox", responder,
        callCommand: async () => responder.ok(),
        createWorker: () => { workerStarts++; throw new Error("must not start"); }
    });
    const result = await runner.run('return import/**/("https://example.com/module.js")');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SCRIPT_SOURCE_INVALID");
    assert.equal(workerStarts, 0);
});

test("eval sandbox blocks network, DOM, Window, sub-Workers, and constructor-chain escape", async () => {
    const capabilities = await runEvalSandbox(`
        return {
            window: typeof window,
            document: typeof document,
            HTMLElement: typeof HTMLElement,
            fetch: typeof fetch,
            xhr: typeof XMLHttpRequest,
            socket: typeof WebSocket,
            worker: typeof Worker,
            post: typeof postMessage,
            constructorFetch: typeof (({}).constructor.constructor("return fetch")())
        };
    `);
    const done = capabilities.messages.find((message) => message.type === "done");
    assert.deepEqual(JSON.parse(JSON.stringify(done.result)), {
        window: "undefined",
        document: "undefined",
        HTMLElement: "undefined",
        fetch: "undefined",
        xhr: "undefined",
        socket: "undefined",
        worker: "undefined",
        post: "undefined",
        constructorFetch: "undefined"
    });
    assert.equal(capabilities.networkCalls, 0);

    const external = await runEvalSandbox('return await fetch("https://example.com/")');
    assert.equal(external.networkCalls, 0);
    assert.ok(external.messages.some((message) => message.type === "error"));

    const forged = await runEvalSandbox('postMessage({ type: "done", result: "forged" }); return "real"');
    assert.equal(forged.messages.some((message) => message.type === "done" && message.result === "forged"), false);
    assert.ok(forged.messages.some((message) => message.type === "error"));
});

async function runPersistentScalarSandbox() {
    const source = await readFile(new URL("../src/workers/persistent-script.worker.js", import.meta.url), "utf8");
    const messages = [];
    const listeners = new Map();
    const context = vm.createContext({
        console,
        crypto: { randomUUID: () => "persistent-token" },
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener)
    });
    vm.runInContext(source, context, { filename: "persistent-script.worker.js" });
    const start = listeners.get("message")({
        data: {
            type: "start",
            code: 'const lr = await memory.reg("r14", "arm9"); const seed = await memory.read32(0x02385f0c, "arm9"); print(lr, seed);',
            shortcuts: []
        }
    });
    const replies = [0x02075628, 0x12345678];
    let handled = 0;
    for (let attempt = 0; handled < replies.length && attempt < 50; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const calls = messages.filter((message) => message.type === "call");
        while (handled < calls.length) {
            await listeners.get("message")({
                data: { replyId: calls[handled].id, result: { ok: true, value: replies[handled] } }
            });
            handled++;
        }
    }
    if (handled !== replies.length) {
        throw new Error(`persistent scalar RPC stalled: ${messages.map((message) => message.type).join(",")}`);
    }
    await start;
    return messages;
}

test("persistent-script legacy memory reads remain numeric", async () => {
    const messages = await runPersistentScalarSandbox();
    const printed = messages.find((message) => message.type === "print");
    assert.deepEqual(Array.from(printed.values), [0x02075628, 0x12345678]);
    assert.equal(String(printed.values[0]).includes("[object Object]"), false);
});

test("Ctable script registers hooks, prints numeric seeds, and resumes after exec callback", async () => {
    const workerSource = await readFile(new URL("../src/workers/persistent-script.worker.js", import.meta.url), "utf8");
    const ctableSource = await readFile(new URL("../scripts/dq9/Ctable_jp.js", import.meta.url), "utf8");
    const messages = [];
    const listeners = new Map();
    const context = vm.createContext({
        console,
        crypto: { randomUUID: () => "ctable-token" },
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener)
    });
    vm.runInContext(workerSource, context, { filename: "persistent-script.worker.js" });
    let startupComplete = false;
    const startup = listeners.get("message")({
        data: { type: "start", code: ctableSource, shortcuts: [] }
    }).then(() => { startupComplete = true; });
    let handled = 0;
    for (let attempt = 0; !startupComplete && attempt < 500; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const requests = messages.filter((message) => message.type === "register" || message.type === "call");
        while (handled < requests.length) {
            const request = requests[handled++];
            const value = request.type === "register"
                ? { id: request.trigger.callbackId }
                : request.command === "memoryReadDword"
                    ? { ok: true, value: request.params.address === 0x02385f0c ? 0x12345678 : 0x89abcdef }
                    : { ok: true };
            await listeners.get("message")({ data: { replyId: request.id, result: value } });
        }
    }
    await startup;
    const registered = messages.filter((message) => message.type === "register");
    assert.ok(registered.length >= 20);
    const startupPrint = messages.filter((message) => message.type === "print").flatMap((message) => message.values.map(String));
    assert.ok(startupPrint.some((value) => value.includes("seed1 native: 0x78563412")));
    assert.ok(startupPrint.some((value) => value.includes("seed2 native: 0xefcdab89")));
    assert.equal(startupPrint.some((value) => value.includes("[object Object]")), false);

    const first = registered[0];
    listeners.get("message")({
        data: {
            type: "event", event: "exec", eventId: 77,
            callbackId: first.trigger.callbackId, callbackToken: "callback-token", payload: {}
        }
    });
    let eventDone = false;
    for (let attempt = 0; !eventDone && attempt < 100; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const requests = messages.filter((message) => message.type === "register" || message.type === "call");
        while (handled < requests.length) {
            const request = requests[handled++];
            let result = { ok: true };
            if (request.command === "memoryGetRegister") {
                result = {
                    ok: true,
                    value: request.params.register === "r0"
                        ? 0x02385f0c
                        : request.params.register === "r14"
                            ? 0x11111111
                            : 5
                };
            }
            await listeners.get("message")({ data: { replyId: request.id, result } });
        }
        eventDone = messages.some((message) => message.type === "eventDone" && message.eventId === 77);
    }
    assert.equal(eventDone, true);
    assert.ok(messages.some((message) => message.type === "call" && message.command === "resume" && message.eventId === 77));
    const callbackPrint = messages.filter((message) => message.type === "print").flatMap((message) => message.values.map(String));
    assert.ok(callbackPrint.some((value) => value.includes("lr 0x11111111")));
    assert.equal(callbackPrint.some((value) => value.includes("[object Object]")), false);
});

async function runEvalSupervisor(childMessage) {
    const source = await readFile(new URL("../src/workers/eval-supervisor.worker.js", import.meta.url), "utf8");
    const messages = [];
    let listener;
    const workers = [];
    class FakeWorker {
        constructor() {
            this.messages = [];
            this.terminated = false;
            workers.push(this);
        }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    }
    const context = vm.createContext({
        postMessage: (message) => messages.push(message),
        Blob: class Blob {},
        Worker: FakeWorker,
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} }
    });
    context.onmessage = null;
    vm.runInContext(source, context, { filename: "eval-supervisor.worker.js" });
    listener = context.onmessage;
    listener({ data: { type: "run", code: "return 1", sandboxSource: "sandbox", shortcuts: [] } });
    const child = workers[0];
    child.onmessage({ data: { type: "ready", channelToken: "secret" } });
    child.onmessage({ data: childMessage });
    return { messages, child };
}

test("eval supervisor accepts only authenticated sandbox protocol messages", async () => {
    const valid = await runEvalSupervisor({ type: "done", result: 1, channelToken: "secret" });
    assert.ok(valid.messages.some((message) => message.type === "done" && message.result === 1));
    assert.equal(valid.messages.some((message) => "channelToken" in message), false);

    const forged = await runEvalSupervisor({ type: "done", result: "forged", channelToken: "wrong" });
    assert.equal(forged.messages.some((message) => message.type === "done"), false);
    assert.ok(forged.messages.some((message) => message.type === "protocolError"));
    assert.equal(forged.child.terminated, true);
});

test("persistent supervisor gates replies and rejects forged child messages", async () => {
    const source = await readFile(new URL("../src/workers/persistent-script-supervisor.worker.js", import.meta.url), "utf8");
    const messages = [];
    const workers = [];
    class FakeWorker {
        constructor() { this.messages = []; this.terminated = false; workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    }
    const context = vm.createContext({
        postMessage: (message) => messages.push(message),
        Blob: class Blob {}, Worker: FakeWorker,
        URL: { createObjectURL: () => "blob:persistent", revokeObjectURL: () => {} }
    });
    context.onmessage = null;
    vm.runInContext(source, context, { filename: "persistent-script-supervisor.worker.js" });
    context.onmessage({ data: { type: "start", code: "return 1", sandboxSource: "sandbox", shortcuts: [] } });
    const child = workers[0];
    child.onmessage({ data: { type: "ready", channelToken: "secret" } });
    child.onmessage({ data: { type: "call", id: "request-1", command: "status", params: {}, channelToken: "secret" } });
    assert.ok(messages.some((message) => message.type === "call" && message.id === "request-1"));
    context.onmessage({ data: { replyId: "request-1", result: { ok: true } } });
    assert.ok(child.messages.some((message) => message.replyId === "request-1"));

    child.onmessage({ data: { type: "print", values: ["forged"], channelToken: "wrong" } });
    assert.equal(messages.some((message) => message.type === "print"), false);
    assert.ok(messages.some((message) => message.type === "failed" && message.phase === "protocol"));
    assert.equal(child.terminated, true);
});

test("all supervisor and sandbox Worker sources parse as classic scripts", async () => {
    for (const path of [
        "../src/workers/eval-supervisor.worker.js",
        "../src/workers/eval.worker.js",
        "../src/workers/persistent-script-supervisor.worker.js",
        "../src/workers/persistent-script.worker.js"
    ]) {
        const source = await readFile(new URL(path, import.meta.url), "utf8");
        assert.doesNotThrow(() => Function(source), path);
    }
});
