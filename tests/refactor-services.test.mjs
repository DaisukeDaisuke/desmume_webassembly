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
        withCurrentExecBreakpointSuspended: async (_cpu, callback) => callback(),
        getCommands: () => commands
    });
    return { service, freezes: () => freezes };
}

test("debugger service requires and applies freezes for step paths", async () => {
    assert.throws(() => createDebuggerService({}), /requires applyFreezes/);
    const step = createDebuggerHarness();
    await step.service.runDebuggerInstruction("step");
    assert.equal(step.freezes(), 1);
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

test("worker sources are valid scripts covered by the esbuild text loader", async () => {
  const workerUrls = [
    new URL("../src/workers/eval.worker.js", import.meta.url),
    new URL("../src/workers/persistent-script.worker.js", import.meta.url)
  ];
  for (const workerUrl of workerUrls) {
    assert.match(fileURLToPath(workerUrl), /\.worker\.js$/);
    const source = await readFile(workerUrl, "utf8");
    assert.doesNotThrow(() => Function(source));
  }

  const buildSource = await readFile(new URL("../scripts/build-js.mjs", import.meta.url), "utf8");
  assert.match(buildSource, /loader\s*:\s*\{\s*["']\.worker\.js["']\s*:\s*["']text["']\s*\}/);
});
