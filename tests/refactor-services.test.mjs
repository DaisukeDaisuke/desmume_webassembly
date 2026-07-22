import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMcpResponder } from "../src/mcp-responder.js";
import { createOperationManager } from "../src/operation-manager.js";
import { createFrameService } from "../src/frame-service.js";
import { createInputSequenceService } from "../src/input-service.js";
import { compareFramePixels } from "../src/frame-diff/index.js";
import { createScriptPauseService } from "../src/script-pause-service.js";
import { registerWaitCommands } from "../src/commands/wait-commands.js";
import { createDebuggerService } from "../src/debugger-service.js";
import { createViewService } from "../src/ui/view-service.js";
import { createCommandDispatcher } from "../src/command-dispatcher.js";
import { createDebuggerCoordinator } from "../src/debugger-coordinator.js";
import { createRuntimeCommands } from "../src/commands/runtime-commands.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createDebuggerControlCommands } from "../src/commands/debugger-control-commands.js";
import { withInternalMetadata } from "../src/internal-command-metadata.js";
import { createScriptRunner } from "../src/script-runner.js";
import { createMemoryCommands } from "../src/commands/memory-commands.js";
import { createInputController } from "../src/ui/input-controller.js";
import { createEmulationLoop } from "../src/emulation-loop.js";
import { createBreakpointService } from "../src/breakpoint-service.js";
import { isValidAlgorithmWorkerResult } from "../src/frame-comparator-result.js";

const responder = createMcpResponder({ logger: {} });
const FRAME_WIDTH = 256;
const FRAME_HEIGHT = 384;
const FRAME_PIXELS = FRAME_WIDTH * FRAME_HEIGHT;

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

test("operation timeout pauses and performs cleanup exactly once", async () => {
  let pauses = 0;
  let releases = 0;
  let cleanups = 0;
  const manager = createOperationManager({
    responder,
    pause: async () => { pauses++; },
    releaseInput: async () => { releases++; }
  });

  const result = await manager.run({
    name: "timeout-test",
    timeoutMs: 15,
    task: ({ signal }) => waitForAbort(signal),
    cleanup: async () => { cleanups++; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(pauses, 1);
  assert.equal(releases, 1);
  assert.equal(cleanups, 1);
  assert.equal(manager.current(), null);
});

test("operation cancellation reports its reason and cleans up exactly once", async () => {
  let pauses = 0;
  let releases = 0;
  let cleanups = 0;
  const manager = createOperationManager({
    responder,
    pause: async () => { pauses++; },
    releaseInput: async () => { releases++; }
  });
  const running = manager.run({
    name: "cancel-test",
    timeoutMs: 1000,
    task: ({ signal }) => waitForAbort(signal),
    cleanup: async () => { cleanups++; }
  });

  assert.equal(manager.cancel("test-request"), true);
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CANCELLED");
  assert.equal(result.error.details.reason, "test-request");
  assert.equal(pauses, 1);
  assert.equal(releases, 1);
  assert.equal(cleanups, 1);
  assert.equal(manager.cancel(), false);
});

test("operation manager is reusable after cleanup throws", async () => {
  const manager = createOperationManager({
    responder,
    releaseInput: async () => { throw new Error("release failed"); }
  });
  await assert.rejects(manager.run({
    name: "cleanup-failure",
    timeoutMs: 1000,
    task: async () => responder.ok()
  }), /release failed/);
  assert.equal(manager.current(), null);
  const next = await manager.run({
    name: "next-operation",
    timeoutMs: 1000,
    task: async () => responder.ok()
  }).catch((error) => error);
  assert.equal(manager.current(), null);
  assert.match(String(next.message), /release failed/);
});

test("operation cleanup runs both failing stages before releasing BUSY", async () => {
  let releases = 0;
  let cleanups = 0;
  const manager = createOperationManager({
    responder,
    releaseInput: async () => { releases++; throw new Error("release failed"); }
  });
  await assert.rejects(manager.run({
    name: "double-cleanup-failure",
    timeoutMs: 1000,
    task: async () => responder.ok(),
    cleanup: async () => { cleanups++; throw new Error("cleanup failed"); }
  }), /release failed/);
  assert.equal(releases, 1);
  assert.equal(cleanups, 1);
  assert.equal(manager.current(), null);
});

test("persistent script pause stops a wait with SCRIPT_PAUSED", async () => {
    const scriptPauseService = createScriptPauseService();
    const operationManager = createOperationManager({ responder });
    const commands = {
        pause: async () => ({ ok: true }),
        resume: async () => {
            scriptPauseService.publish({ scriptId: 4, eventId: 9 });
            return { ok: true };
        },
        step: async () => ({ ok: true })
    };
    registerWaitCommands({
        commands,
        descriptions: {},
        responder,
        operationManager,
        breakpointOwners: {
            hasWaitableBreakpoints: () => true
        },
        breakpointService: {
            currentSerial: () => 0,
            waitForEvent: ({ signal }) => waitForAbort(signal),
            subscribe: () => () => {}
        },
        scriptPauseService,
        frameService: {},
        inputSequenceService: {},
        getNativeStatus: () => null,
        parseAddress: Number,
        hex: String,
        getFrame: () => 0
    });

    const result = await commands.waitForBreak({ timeoutMs: 1000 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "SCRIPT_PAUSED");
    assert.equal(result.error.details.scriptId, 4);
    assert.equal(operationManager.current(), null);
});

function createDebuggerHarness() {
    let freezes = 0;
    let disassemblyCalls = 0;
    let suspensions = 0;
    const state = {
        selectedCpu: "arm9",
        paused: true,
        running: false,
        breakpoints: [],
        autoUpdate: {},
        highlightedDisasmAddress: null,
        highlightedCallstackAddress: null,
        highlightedCallstackCpsr: null
    };
    const ui = {
        disasmOutput: { innerHTML: "" },
        callstackBody: { innerHTML: "" },
        memoryAuto: { value: "0" },
        tracePrivilegeToggle: { checked: false },
        traceToggle: { checked: false }
    };
    const commands = {
        disassemble: async () => ({
            text: ++disassemblyCalls === 2
                ? "=>02000004: ea000000 b 02000010"
                : "=>02000000: e1a00000 mov r0, r0"
        })
    };
    const service = createDebuggerService({
        applyFreezes: () => { freezes++; },
        breakpointKindName: () => "",
        cpsrModeInfo: () => ({ className: "" }),
        disasmRefreshParams: (value) => value,
        ensureReady: () => {},
        ensureRomLoaded: () => {},
        getPc: () => 0x02000000,
        getRegisters: () => ({ pc: 0x02000000 }),
        hasLoadedRom: () => true,
        hex: (value) => `0x${(Number(value) >>> 0).toString(16)}`,
        log: () => {},
        native: { step: () => 1, stepOver: () => 1, clearBreakStatus: () => {} },
        normalizeCallStackData: (value) => value,
        readCallStackData: () => ({ enabled: true, frames: [] }),
        renderRegisters: () => {},
        setFollowPc: () => {},
        state,
        syncNativeBreakStatus: () => ({}),
        ui,
        updateStatus: () => {},
        withCurrentExecBreakpointSuspended: async (_cpu, callback) => {
            suspensions++;
            return callback();
        },
        getCommands: () => commands
    });
    return { service, freezes: () => freezes, suspensions: () => suspensions };
}

test("debugger service requires and applies freezes for step paths", async () => {
    assert.throws(() => createDebuggerService({}), /requires applyFreezes/);
    const step = createDebuggerHarness();
    await step.service.runDebuggerInstruction("step");
    assert.equal(step.freezes(), 1);
    assert.equal(step.suspensions(), 1);
    const over = createDebuggerHarness();
    await over.service.runDebuggerInstruction("stepOver");
    assert.equal(over.freezes(), 1);
    const branch = createDebuggerHarness();
    await branch.service.runUntilNextBranchOrReturn({ maxSteps: 2, timeoutMs: 1000 });
    assert.equal(branch.freezes(), 1);
});

test("view service converts call stack disassembly modes", () => {
    const modes = [];
    const view = createViewService({
        state: { selectedCpu: "arm9" },
        ui: {},
        native: {
            disassemble: (_cpu, _address, _count, mode) => {
                modes.push(mode);
                return "02000000: nop";
            }
        },
        getIdbPut: () => () => {}
    });
    const frame = {
        caller: 0x02000000,
        returnAddress: 0x02000004,
        callee: 0x02000008,
        sp: 0x023ffff0,
        cpsrHex: "0x00000000",
        modeName: "system",
        thumb: false,
        id: 1
    };
    assert.equal(view.publicCallStackFrame(frame).callerDisassembly.length, 1);
    assert.deepEqual(modes, [2, 2]);
    modes.length = 0;
    view.disassemblyRows("arm9", 0x02000000, { mode: "thumb" });
    view.disassemblyRows("arm9", 0x02000000, { mode: "unknown" });
    assert.deepEqual(modes, [1, 0]);
});

test("public dispatcher rejects internal metadata fields", async () => {
    let executed = 0;
    const dispatcher = createCommandDispatcher({
        state: { ready: false },
        registry: { execute: async () => { executed++; return responder.ok(); } },
        responder,
        operationManager: { current: () => ({ name: "active" }) },
        hasLoadedRom: () => false,
        emulatorActivity: () => ({}),
        refreshDebuggerViews: async () => {},
        updateStatus: () => {},
        log: () => {}
    });
    for (const field of ["_operation", "_origin", "_scriptId", "_triggerId", "_operationId", "_scriptCallback", "_scriptEventId", "_analysisBaselineSlotToken"]) {
        const result = await dispatcher.run("step", { [field]: true });
        assert.equal(result.error.code, "INVALID_ARGUMENT");
    }
    assert.equal(executed, 0);
});

test("public dispatcher accepts only plain object params", async () => {
    let executed = 0;
    const dispatcher = createCommandDispatcher({
        state: { ready: false },
        registry: { execute: async () => { executed++; return responder.ok(); } },
        responder,
        operationManager: { current: () => null },
        hasLoadedRom: () => false,
        emulatorActivity: () => ({}),
        refreshDebuggerViews: async () => {},
        updateStatus: () => {},
        log: () => {}
    });
    assert.equal((await dispatcher.run("status", undefined)).ok, true);
    for (const params of [null, [], 1, "x", new Date()]) {
        assert.equal((await dispatcher.run("status", params)).error.code, "INVALID_ARGUMENT");
    }
    assert.equal((await dispatcher.run("status", {})).ok, true);
    assert.equal((await dispatcher.run("status", Object.create(null))).ok, true);
    assert.equal(executed, 3);
});

test("special breakpoint ownership preserves user and script owners independently", async () => {
    let nativeAdds = 0;
    let nativeRemoves = 0;
    const owners = createBreakpointOwnerStore({
        onFirstOwner: () => { nativeAdds++; },
        onLastOwner: () => { nativeRemoves++; }
    });
    const state = { nextBreakpointId: 1, selectedCpu: "arm9", breakpoints: [] };
    const ui = {
        bpDataAbortToggle: { checked: false },
        bpPrefetchAbortToggle: { checked: false },
        bpUndefinedToggle: { checked: false }
    };
    const commands = createDebuggerControlCommands({
        breakpointOwners: owners,
        ensureRomLoaded: () => {},
        native: {},
        state,
        ui,
        refreshDebuggerViews: async () => {},
        renderBreakpoints: () => {},
        log: () => {}
    });
    const user = await commands.setSpecialBreakpoint({ kind: "dataAbort", enabled: true });
    const script = await commands.setSpecialBreakpoint(withInternalMetadata(
        { kind: "dataAbort", enabled: true },
        { origin: "script", scriptId: 7, triggerId: 9 }
    ));
    assert.equal(nativeAdds, 1);
    assert.equal(ui.bpDataAbortToggle.checked, true);
    await commands.setSpecialBreakpoint({ kind: "dataAbort", enabled: false });
    assert.equal(nativeRemoves, 0);
    assert.equal(ui.bpDataAbortToggle.checked, false);
    assert.equal(owners.classifySite({ cpu: "special", type: "dataAbort", address: 0 }).scriptOnly, true);
    owners.removeOwner(script.id);
    assert.equal(nativeRemoves, 1);
    assert.notEqual(user.id, script.id);
});

test("the same breakpoint publishes again after each resume", async () => {
    const state = {
        ready: true,
        selectedCpu: "arm9",
        lastBreakKey: "",
        breakRefreshKey: "",
        scriptTriggers: [],
        pendingScriptEvents: new Map(),
        frame: 0
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000000 }, { id: 1, origin: "user" });
    let published = 0;
    const native = {
        getStatus: () => ({}),
        pause: () => {},
        clearBreakStatus: () => {}
    };
    const coordinator = createDebuggerCoordinator({
        state,
        native,
        breakpointOwners: owners,
        breakpointService: { publish: () => { published++; } },
        getQueueBreakpointRefresh: () => () => {},
        log: () => {},
        hex: String,
        updateStatus: () => {}
    });
    const runtime = createRuntimeCommands({
        cancelOperation: () => {},
        ensureReady: () => {},
        hasLoadedRom: () => true,
        native,
        state,
        updateStatus: () => {}
    });
    const hit = { hit: true, cpu: "arm9", kind: 0, address: 0x02000000, pc: 0x02000000, value: 0 };
    for (let index = 0; index < 10; index++) {
        coordinator.syncNativeBreakStatus({ frame: index, lastBreak: hit });
        await runtime.resume();
    }
    assert.equal(published, 10);
});

test("runUntil reaches the tenth native-like hit and safely steps past the first nine", async () => {
    const site = { cpu: "arm9", type: "exec", address: 0x02000000 };
    let breakpointEnabled = false;
    let pc = site.address;
    let steps = 0;
    let disables = 0;
    let enables = 0;
    const state = {
        ready: true, selectedCpu: "arm9", lastBreakKey: "", breakRefreshKey: "",
        scriptTriggers: [], scripts: new Map(), pendingScriptEvents: new Map(),
        nextScriptEventId: 1, nextScriptCallbackToken: 1, explicitPauseSerial: 0, frame: 0
    };
    const native = {
        setBreakpoint: (_cpu, _type, _address, enabled) => {
            breakpointEnabled = enabled;
            if (enabled) enables++;
            else disables++;
        },
        getStatus: () => ({ arm9: { pc }, lastBreak: { hit: false } }),
        clearBreakStatus: () => {},
        pause: () => {},
        step: () => {
            if (breakpointEnabled && pc === site.address) return 0;
            pc = (pc + 4) >>> 0;
            steps++;
            return 1;
        },
        hasLoadedRom: () => true
    };
    const owners = createBreakpointOwnerStore({
        onFirstOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, true),
        onLastOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, false)
    });
    owners.addOwner(site, { id: 1, origin: "user" });
    const breakpoints = createBreakpointService({ ownerStore: owners });
    const coordinator = createDebuggerCoordinator({
        state, native, breakpointOwners: owners, breakpointService: breakpoints,
        getQueueBreakpointRefresh: () => () => {}, log: () => {}, hex: String, updateStatus: () => {}
    });
    const commands = {
        pause: async () => responder.ok(),
        resume: async () => {
            state.lastBreakKey = "";
            pc = site.address;
            queueMicrotask(() => coordinator.syncNativeBreakStatus({
                frame: state.frame++, arm9: { pc },
                lastBreak: { hit: true, cpu: "arm9", kind: 0, address: site.address, pc, value: 0 }
            }));
            return responder.ok();
        },
        step: async () => {
            await coordinator.withCurrentExecBreakpointSuspended("arm9", () => native.step("arm9", 1));
            return responder.ok();
        }
    };
    registerWaitCommands({
        commands, descriptions: {}, responder,
        operationManager: createOperationManager({ responder }),
        breakpointOwners: owners, breakpointService: breakpoints,
        scriptPauseService: createScriptPauseService(), frameService: {}, inputSequenceService: {},
        getNativeStatus: () => native.getStatus(), parseAddress: Number, hex: String,
        getFrame: () => state.frame
    });
    const result = await commands.runUntil({ bp: 1, hits: 10, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.hits, 10);
    assert.equal(steps, 9);
    assert.equal(disables, 9);
    assert.equal(enables, 10);
    assert.equal(breakpointEnabled, true);
});

test("all built-in frame algorithms accept fixed pixel buffers", async (t) => {
  const baseline = new Uint32Array(FRAME_PIXELS);
  const current = new Uint32Array(FRAME_PIXELS);
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH / 2; x++) {
      current[y * FRAME_WIDTH + x] = 0x00ffffff;
    }
  }

  for (const algorithm of ["px", "px-window", "hist", "blk", "edge"]) {
    await t.test(algorithm, async () => {
      const options = algorithm === "edge"
        ? { blurRadius: 0, trimTopPct: 0, tileThresholdPct: 0.01 }
        : { trimTopPct: 0 };
      const result = await compareFramePixels({
        baseline,
        current,
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        algorithm,
        options
      });
      assert.equal(result.ok, true);
      assert.ok(Number.isFinite(result.pct));
      assert.ok(result.pct >= 0 && result.pct <= 100);
      assert.ok(result.pct > 0, `${algorithm} should detect the synthetic change`);
    });
  }
});

test("frame snapshots copy pixels and replace only when requested", async () => {
  let pixels = new Uint32Array(FRAME_PIXELS);
  const frames = createFrameService({
    responder,
    capturePixels: () => pixels,
    getFrame: () => 7
  });
  frames.onFrameCompleted(7);

  assert.equal(frames.captureFrame({ id: "baseline" }).ok, true);
  pixels.fill(0x00ffffff);
  const duplicate = frames.captureFrame({ id: "baseline" });
  assert.equal(duplicate.error.code, "FRAME_SNAPSHOT_EXISTS");

  const copiedComparison = await frames.compareFrame({
    id: "baseline",
    algorithm: "px",
    thresholdPct: 1
  });
  assert.equal(copiedComparison.changed, true);
  assert.equal(copiedComparison.pct, 100);

  assert.equal(frames.captureFrame({ id: "baseline", replace: true }).ok, true);
  pixels = new Uint32Array(FRAME_PIXELS);
  const replacedComparison = await frames.compareFrame({
    id: "baseline",
    algorithm: "px",
    thresholdPct: 1
  });
  assert.equal(replacedComparison.changed, true);
  assert.equal(replacedComparison.pct, 100);
});

test("input sequences require replace and always release input", async () => {
  const pressed = [];
  let releases = 0;
  const service = createInputSequenceService({
    responder,
    press: (button, down) => pressed.push([button, down]),
    releaseAll: () => { releases++; },
    touch: () => {},
    stepFrames: async () => {},
    getPaused: () => false,
    pause: async () => {},
    resume: async () => {},
    storage: createMemoryStorage()
  });
  const operation = { signal: new AbortController().signal };

  assert.equal((await service.run({ id: "combo", seq: [["hf", "A", 1]] }, operation)).ok, true);
  const conflict = await service.run({ id: "combo", seq: [["hf", "B", 1]] }, operation);
  assert.equal(conflict.error.code, "SEQUENCE_EXISTS");
  assert.equal((await service.run({ id: "combo", seq: [["hf", "B", 1]], replace: true }, operation)).ok, true);
  assert.deepEqual(service.list().sequences, [{ id: "combo", seq: [["hf", "B", 1]] }]);
  assert.deepEqual(pressed, [
    ["A", true], ["A", false],
    ["B", true], ["B", false]
  ]);
  assert.equal(releases, 2);
});

test("input sequences release controls when aborted", async () => {
  let releases = 0;
  const touchStates = [];
  const service = createInputSequenceService({
    responder,
    press: () => {},
    releaseAll: () => { releases++; },
    touch: (down) => touchStates.push(down),
    stepFrames: async () => {},
    getPaused: () => false,
    pause: async () => {},
    resume: async () => {},
    storage: createMemoryStorage()
  });
  const controller = new AbortController();
  const running = service.run({ seq: [["w", 1000]] }, { signal: controller.signal });
  controller.abort("test-request");

  await assert.rejects(running, { name: "AbortError" });
  assert.equal(releases, 1);
  assert.deepEqual(touchStates, [false]);
});

test("supervisors are classic scripts and sandbox Workers are prebundled", async () => {
  const supervisorUrls = [
    new URL("../src/workers/eval-supervisor.worker.js", import.meta.url),
    new URL("../src/workers/persistent-script-supervisor.worker.js", import.meta.url)
  ];
  for (const workerUrl of supervisorUrls) {
    assert.match(fileURLToPath(workerUrl), /\.worker\.js$/);
    const source = await readFile(workerUrl, "utf8");
    assert.doesNotThrow(() => Function(source));
    assert.match(source, /type: "ready", hardened: true, layer: "supervisor"/);
  }
  for (const workerUrl of [
    new URL("../src/workers/eval.worker.js", import.meta.url),
    new URL("../src/workers/persistent-script.worker.js", import.meta.url)
  ]) {
    const source = await readFile(workerUrl, "utf8");
    assert.match(source, /assertSandboxSource/);
    assert.match(source, /Object\.defineProperty\(globalThis/);
    assert.match(source, /lockDownRuntimeCodeGeneration\(\);[\s\S]+nativeAddEventListener/);
    assert.match(source, /type: "ready", hardened: true, layer: "sandbox"/);
  }

  const buildSource = await readFile(new URL("../scripts/build-js.mjs", import.meta.url), "utf8");
  assert.match(buildSource, /bundledWorkers/);
  assert.match(buildSource, /embedded-workers/);
});

test("eval Worker waits for ready, enforces its RPC allowlist, and disposes once", async () => {
    const posted = [];
    let disposed = 0;
    const worker = {
        postMessage: (message) => posted.push(message),
        onmessage: null,
        onerror: null,
        onmessageerror: null
    };
    const runner = createScriptRunner({
        source: "worker source",
        responder,
        callCommand: async () => responder.ok(),
        createWorker: () => ({ worker, dispose: () => { disposed++; } })
    });
    const running = runner.run("return 7", 1000);
    assert.equal(posted.length, 0);
    await worker.onmessage({ data: { type: "ready", hardened: true, layer: "supervisor" } });
    assert.equal(posted[0].type, "run");
    await worker.onmessage({ data: { type: "done", result: 7 } });
    assert.equal((await running).value, 7);
    assert.equal(disposed, 1);

    const secondWorker = { postMessage: () => {}, onmessage: null, onerror: null, onmessageerror: null };
    const denied = createScriptRunner({
        source: "worker source",
        responder,
        callCommand: async () => responder.ok(),
        createWorker: () => ({ worker: secondWorker, dispose: () => {} })
    });
    const deniedRun = denied.run("return 1", 1000);
    await secondWorker.onmessage({ data: { type: "ready", hardened: true, layer: "supervisor" } });
    await secondWorker.onmessage({
        data: { type: "call", id: "1", command: "runPersistentScript", params: {} }
    });
    assert.equal((await deniedRun).error.code, "WORKER_PROTOCOL_ERROR");
});

test("pending script callbacks validate identity and clean up after script stop", async () => {
    const messages = [];
    const state = {
        ready: true,
        selectedCpu: "arm9",
        lastBreakKey: "",
        breakRefreshKey: "",
        scriptTriggers: [{
            id: 1,
            scriptId: 4,
            callbackId: 8,
            type: "exec",
            cpu: "arm9",
            address: 0x02000000
        }],
        scripts: new Map([[4, { running: true, worker: { postMessage: (message) => messages.push(message) } }]]),
        pendingScriptEvents: new Map(),
        nextScriptEventId: 1,
        nextScriptCallbackToken: 1,
        explicitPauseSerial: 0,
        frame: 0
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000000 }, {
        id: 2,
        origin: "script",
        scriptId: 4,
        triggerId: 1
    });
    let paused = true;
    let breakHit = true;
    const native = {
        getStatus: () => ({ arm9: { pc: 0x02000000 }, lastBreak: { hit: breakHit } }),
        pause: (value) => { paused = value; },
        clearBreakStatus: () => { breakHit = false; },
        step: () => 1,
        setBreakpoint: () => {},
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state,
        native,
        breakpointOwners: owners,
        breakpointService: { publish: () => {} },
        getQueueBreakpointRefresh: () => () => {},
        log: () => {},
        hex: String,
        updateStatus: () => {}
    });
    coordinator.syncNativeBreakStatus({
        frame: 1,
        arm9: { pc: 0x02000000 },
        lastBreak: { hit: true, cpu: "arm9", kind: 0, address: 0x02000000, pc: 0x02000000, value: 0 }
    });
    const event = messages[0];
    assert.equal(state.pendingScriptEvents.size, 1);
    assert.equal(await coordinator.finishPersistentScriptEvent(event.eventId, {
        scriptId: 99,
        callbackId: event.callbackId,
        callbackToken: event.callbackToken
    }), false);
    await coordinator.settlePersistentScriptCallbacks(4);
    assert.equal(state.pendingScriptEvents.size, 0);
    assert.equal(paused, true);
});

test("pending persistent callback timeout fails closed without auto-resume", async () => {
    const messages = [];
    const logs = [];
    const state = {
        ready: true, selectedCpu: "arm9", lastBreakKey: "", breakRefreshKey: "",
        scriptTriggers: [{ id: 1, scriptId: 3, callbackId: 5, type: "dataAbort", cpu: "arm9", address: 0 }],
        scripts: new Map([[3, { running: true, worker: { postMessage: (message) => messages.push(message) } }]]),
        pendingScriptEvents: new Map(), nextScriptEventId: 1, nextScriptCallbackToken: 1,
        explicitPauseSerial: 0, frame: 0, romGeneration: 1,
        fileTransactionSerial: 0, fileTransactionActive: false, loadingFile: false,
        nativeBreakSerial: 0, breakpointsInSync: true
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "special", type: "dataAbort", address: 0 }, {
        id: 1, origin: "script", scriptId: 3, triggerId: 1
    });
    let resumed = false;
    const native = {
        getStatus: () => ({
            arm9: { pc: 0x02000000 },
            lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
        }),
        pause: (paused) => { if (!paused) resumed = true; },
        clearBreakStatus: () => {},
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state, native, breakpointOwners: owners,
        breakpointService: createBreakpointService({ ownerStore: owners }),
        getQueueBreakpointRefresh: () => () => {}, log: (message) => logs.push(message),
        hex: String, updateStatus: () => {}, scriptCallbackTimeoutMs: 5
    });
    coordinator.syncNativeBreakStatus({
        frame: 1, arm9: { pc: 0x02000000 },
        lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
    });
    assert.equal(messages.length, 1);
    assert.equal(state.pendingScriptEvents.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.pendingScriptEvents.size, 0);
    assert.equal(resumed, false);
    assert.equal(state.lastScriptError.code, "SCRIPT_EVENT_FINALIZATION_FAILED");
    assert.ok(logs.some((message) => message.includes("callback timeout")));
});

test("script-only special breakpoints dispatch and auto-resume through special ownership", async () => {
    const messages = [];
    const state = {
        ready: true, selectedCpu: "arm9", lastBreakKey: "", breakRefreshKey: "",
        scriptTriggers: [{ id: 1, scriptId: 3, callbackId: 5, type: "dataAbort", cpu: "arm9", address: 0 }],
        scripts: new Map([[3, { running: true, worker: { postMessage: (message) => messages.push(message) } }]]),
        pendingScriptEvents: new Map(), nextScriptEventId: 1, nextScriptCallbackToken: 1,
        explicitPauseSerial: 0, frame: 0, romGeneration: 1,
        fileTransactionSerial: 0, fileTransactionActive: false, loadingFile: false,
        nativeBreakSerial: 0, breakpointsInSync: true
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "special", type: "dataAbort", address: 0 }, {
        id: 1, origin: "script", scriptId: 3, triggerId: 1
    });
    let resumed = false;
    const native = {
        getStatus: () => ({
            arm9: { pc: 0x02000000 },
            lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
        }),
        pause: (paused) => { if (!paused) resumed = true; },
        clearBreakStatus: () => {},
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state, native, breakpointOwners: owners,
        breakpointService: createBreakpointService({ ownerStore: owners }),
        getQueueBreakpointRefresh: () => () => {}, log: () => {}, hex: String, updateStatus: () => {}
    });
    coordinator.syncNativeBreakStatus({
        frame: 1, arm9: { pc: 0x02000000 },
        lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
    });
    const event = messages[0];
    assert.equal(await coordinator.finishPersistentScriptEvent(event.eventId, {
        scriptId: 3, callbackId: event.callbackId, callbackToken: event.callbackToken
    }), true);
    assert.equal(resumed, true);
});

test("input waits honor pre-aborted signals", async () => {
    const controller = new AbortController();
    controller.abort("test");
    let released = 0;
    const input = createInputSequenceService({
        responder,
        press: () => {},
        releaseAll: () => { released++; },
        touch: () => {},
        stepFrames: async () => {},
        getPaused: () => false,
        pause: async () => {},
        resume: async () => {},
        storage: createMemoryStorage()
    });
    await assert.rejects(input.run({ seq: [["w", 10]] }, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(released, 1);
});

test("memory and input boundaries reject invalid sizes, lengths, and buttons", async () => {
    const memory = createMemoryCommands({
        applyFreezes: () => {},
        ensureRomLoaded: () => {},
        parseAddress: (value) => Number(value) >>> 0,
        parseNumber: Number,
        native: {
            dumpMemory: () => new Uint8Array(8),
            writeMemory: () => {}
        },
        readSized: () => 0,
        state: { freezes: [], search: {} },
        ui: {
            memoryAddress: { value: "0" }, memoryLength: { value: "8" },
            memoryView: { value: "bytes" }, searchSize: { value: "1" },
            searchCondition: { value: "equal" }, searchValue: { value: "0" },
            searchLimit: { value: "10" }
        },
        hex: String
    });
    await assert.rejects(memory.dumpMemory({ address: 0, length: -1 }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(memory.writeMemory({ address: 0, value: 1, size: 3 }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(memory.dumpMemory({ address: 0xffffffff, length: 2 }), (error) => error.mcpCode === "INVALID_ARGUMENT");

    const controller = createInputController({
        state: { buttons: { A: 0 }, keys: 0, touch: {}, ready: false },
        ui: {}
    });
    assert.throws(() => controller.toButtonList({ button: "A\"]" }), (error) => error.mcpCode === "INVALID_ARGUMENT");
});

test("frame comparison preserves cancellation and internal failure classifications", async () => {
    const pixels = new Uint32Array(FRAME_PIXELS);
    const cancelled = createFrameService({
        responder,
        capturePixels: () => pixels,
        getFrame: () => 1,
        compareImplementation: async () => { throw new DOMException("aborted", "AbortError"); }
    });
    cancelled.onFrameCompleted(1);
    assert.equal((await cancelled.comparePixels(pixels, { thresholdPct: 1 })).error.code, "CANCELLED");

    const failed = createFrameService({
        responder,
        capturePixels: () => pixels,
        getFrame: () => 1,
        compareImplementation: async () => { throw new Error("unexpected comparator failure"); }
    });
    failed.onFrameCompleted(1);
    assert.equal((await failed.comparePixels(pixels, { thresholdPct: 1 })).error.code, "INTERNAL_ERROR");
});

test("external comparator accepts only bounded plain Worker results", () => {
    assert.equal(isValidAlgorithmWorkerResult({ pct: 0 }), true);
    assert.equal(isValidAlgorithmWorkerResult({ pct: 100, debug: {} }), true);
    for (const result of [null, [], { pct: Number.NaN }, { pct: -1 }, { pct: 101 }, { pct: 1, debug: [] }]) {
        assert.equal(isValidAlgorithmWorkerResult(result), false);
    }
});

test("screen wait returns resume/comparator failures and unsubscribes once", async (t) => {
    await t.test("resume failure", async () => {
        let frameUnsubscribes = 0;
        const commands = {
            pause: async () => responder.ok(),
            resume: async () => responder.fail("ROM_NOT_LOADED", "missing ROM")
        };
        registerWaitCommands({
            commands, descriptions: {}, responder,
            operationManager: createOperationManager({ responder }),
            breakpointOwners: {},
            breakpointService: { subscribe: () => () => {} },
            scriptPauseService: { currentSerial: () => 0, subscribe: () => () => {} },
            frameService: {
                captureCurrent: () => responder.ok({ pixels: new Uint32Array(FRAME_PIXELS) }),
                subscribe: () => () => { frameUnsubscribes++; }
            },
            inputSequenceService: {}, getNativeStatus: () => null,
            parseAddress: Number, hex: String, getFrame: () => 0
        });
        const result = await commands.waitForScreenChange({ algorithm: "px", thresholdPct: 1, timeoutMs: 1000 });
        assert.equal(result.error.code, "ROM_NOT_LOADED");
        assert.equal(frameUnsubscribes, 1);
    });

    await t.test("comparator exception", async () => {
        let onFrame;
        let frameUnsubscribes = 0;
        const commands = {
            pause: async () => responder.ok(),
            resume: async () => {
                queueMicrotask(() => onFrame());
                return responder.ok();
            }
        };
        registerWaitCommands({
            commands, descriptions: {}, responder,
            operationManager: createOperationManager({ responder }),
            breakpointOwners: {},
            breakpointService: { subscribe: () => () => {} },
            scriptPauseService: { currentSerial: () => 0, subscribe: () => () => {} },
            frameService: {
                captureCurrent: () => responder.ok({ pixels: new Uint32Array(FRAME_PIXELS) }),
                subscribe: (listener) => { onFrame = listener; return () => { frameUnsubscribes++; }; },
                comparePixels: async () => { throw new Error("comparison exploded"); }
            },
            inputSequenceService: {}, getNativeStatus: () => null,
            parseAddress: Number, hex: String, getFrame: () => 0
        });
        const result = await commands.waitForScreenChange({ algorithm: "px", thresholdPct: 1, timeoutMs: 1000 });
        assert.equal(result.error.code, "INTERNAL_ERROR");
        assert.equal(frameUnsubscribes, 1);
    });
});

test("emulation loop schedules exactly once after a non-frame stage throws", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalSetTimeout = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.requestAnimationFrame = () => { scheduled++; };
    globalThis.setTimeout = (callback) => { callback(); return 1; };
    try {
        const state = {
            ready: true, running: true, paused: false, loadingFile: false,
            lastTick: 0, frameBudget: 1, speed: 1, freezes: [{ cpu: "arm9", address: 0, value: 0, size: 1 }]
        };
        const loop = createEmulationLoop({
            state,
            ui: {},
            frameService: { isValid: () => false },
            native: { writeMemory: () => { throw new Error("freeze failed"); } },
            handleNativeFault: () => {},
            syncNativeBreakStatus: () => ({}),
            dispatchScriptEvent: () => {},
            updateStatus: () => {},
            log: () => {}
        });
        loop.tick(1000);
        assert.equal(scheduled, 1);
        assert.equal(state.paused, true);
    } finally {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        globalThis.setTimeout = originalSetTimeout;
    }
});
