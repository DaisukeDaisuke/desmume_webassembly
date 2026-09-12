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
import { createStateCommands } from "../src/commands/state-commands.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createDebuggerControlCommands } from "../src/commands/debugger-control-commands.js";
import { withInternalMetadata } from "../src/internal-command-metadata.js";
import { createScriptRunner } from "../src/script-runner.js";
import { createMemoryCommands } from "../src/commands/memory-commands.js";
import { createBinaryTools } from "../src/binary-tools.js";
import { createInputController } from "../src/ui/input-controller.js";
import { createEmulationLoop } from "../src/emulation-loop.js";
import { createBreakpointService } from "../src/breakpoint-service.js";
import { isValidAlgorithmWorkerResult } from "../src/frame-comparator-result.js";
import { createScriptCommands } from "../src/commands/script-commands.js";

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

test("operation timeout returns after a bounded settlement wait when task ignores abort", async () => {
  let finishTask;
  let cleanups = 0;
  const manager = createOperationManager({
    responder,
    settleTimeoutMs: 10
  });
  const result = await manager.run({
    name: "abort-ignoring-task",
    timeoutMs: 5,
    task: () => new Promise((resolve) => { finishTask = resolve; }),
    cleanup: async () => { cleanups++; }
  });

  assert.equal(result.error.code, "TIMEOUT");
  assert.equal(manager.current().name, "abort-ignoring-task");
  assert.equal(cleanups, 0);

  finishTask(responder.ok());
  await new Promise((resolve) => setImmediate(resolve));
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

function createDebuggerHarness({
    traceEnabled = false,
    readStack = null,
    getPc: getPcOverride = null,
    nativeStep = null,
    checkExecBreakpoint = null,
    syncNativeBreakStatus: syncNativeBreakStatusOverride = null,
    handleNativeFault: handleNativeFaultOverride = null
} = {}) {
    let freezes = 0;
    let disassemblyCalls = 0;
    let suspensions = 0;
    let breakClears = 0;
    let privilegeChanges = 0;
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
        traceToggle: { checked: traceEnabled }
    };
    const commands = {
        disassemble: async () => ({
            text: ++disassemblyCalls === 2
                ? "=>02000004: ea000000 b 02000010"
                : "=>02000000: e1a00000 mov r0, r0"
        }),
        setStackTraceMode: async ({ enabled }) => { ui.traceToggle.checked = enabled; },
        setStackTracePrivilegeCheck: async ({ enabled }) => {
            privilegeChanges++;
            ui.tracePrivilegeToggle.checked = enabled;
        }
    };
    const service = createDebuggerService({
        applyFreezes: () => { freezes++; },
        breakpointKindName: () => "",
        cpsrModeInfo: () => ({ className: "" }),
        disasmRefreshParams: (value) => value,
        ensureReady: () => {},
        ensureRomLoaded: () => {},
        getPc: getPcOverride || (() => 0x02000000),
        getRegisters: () => ({ pc: 0x02000000 }),
        handleNativeFault: handleNativeFaultOverride || (() => {}),
        hasLoadedRom: () => true,
        hex: (value) => `0x${(Number(value) >>> 0).toString(16)}`,
        log: () => {},
        native: {
            step: nativeStep || (() => 1),
            stepOver: () => 1,
            checkExecBreakpoint: checkExecBreakpoint || (() => false),
            clearBreakStatus: () => { breakClears++; },
            getTraceDepth: () => 1
        },
        normalizeCallStackData: (value) => value,
        publicCallStackData: (value) => value,
        readCallStackData: readStack || (() => ({ enabled: true, frames: [] })),
        renderRegisters: () => {},
        setFollowPc: () => {},
        state,
        syncNativeBreakStatus: syncNativeBreakStatusOverride || (() => ({})),
        ui,
        updateStatus: () => {},
        withCurrentExecBreakpointSuspended: async (_cpu, callback) => {
            suspensions++;
            return callback();
        },
        getCommands: () => commands
    });
    return {
        service,
        freezes: () => freezes,
        suspensions: () => suspensions,
        breakClears: () => breakClears,
        privilegeChanges: () => privilegeChanges
    };
}

test("debugger service requires and applies freezes for step paths", async () => {
    assert.throws(() => createDebuggerService({}), /requires applyFreezes/);
    const step = createDebuggerHarness();
    await step.service.runDebuggerInstruction("step");
    assert.equal(step.freezes(), 1);
    assert.equal(step.suspensions(), 1);
    const over = createDebuggerHarness();
    await over.service.runDebuggerInstruction("nativeStepOver");
    assert.equal(over.freezes(), 1);
    const branch = createDebuggerHarness();
    await branch.service.runUntilNextBranchOrReturn({ maxSteps: 2, timeoutMs: 1000 });
    assert.equal(branch.freezes(), 1);
    const trace = createDebuggerHarness();
    const traceResult = await trace.service.runTraceStepper(
        "stepOver",
        { maxSteps: 1, timeoutMs: 1000 },
        () => false,
        { trackLane: true, requireTrackedLane: true }
    );
    assert.equal(traceResult.complete, false);
    assert.equal(traceResult.stop, "maxSteps");
    assert.equal(trace.freezes(), 1);
    assert.equal(trace.breakClears(), 2);
    assert.equal(trace.privilegeChanges(), 1);
    const coldTrace = createDebuggerHarness({ traceEnabled: true });
    await assert.rejects(
        coldTrace.service.runTraceStepper("stepOver", {}, () => false, { trackLane: true, requireTrackedLane: true }),
        /requires a recorded active Stack Trace frame/
    );
    assert.equal(coldTrace.breakClears(), 0);
    assert.equal(coldTrace.privilegeChanges(), 0);
    let fallbackCalls = 0;
    assert.deepEqual(
        await coldTrace.service.runTraceStepper(
            "stepOver",
            {},
            () => false,
            {
                trackLane: true,
                requireTrackedLane: true,
                onMissingTrackedLane: async () => ({ fallback: ++fallbackCalls })
            }
        ),
        { fallback: 1 }
    );
    assert.equal(coldTrace.breakClears(), 0);
    assert.equal(coldTrace.privilegeChanges(), 0);
    const publicTrace = createDebuggerHarness({
        traceEnabled: true,
        readStack: () => ({ enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true }] })
    });
    const publicCommands = createDebuggerControlCommands({
        ensureRomLoaded: () => {},
        getPc: () => 0x02000000,
        hex: (value) => `0x${Number(value).toString(16)}`,
        instructionWidthForMode: () => 4,
        runTraceStepper: publicTrace.service.runTraceStepper,
        state: { selectedCpu: "arm9" }
    });
    const limitedResult = await publicCommands.stepOver({ maxSteps: 1, timeoutMs: 1000 });
    assert.equal(limitedResult.complete, false);
    assert.equal(limitedResult.stop, "maxSteps");
    assert.equal(publicTrace.freezes(), 1);
});

test("trace stepper keeps the starting lane identity when another lane becomes active", async () => {
    let reads = 0;
    let observed;
    const harness = createDebuggerHarness({
        traceEnabled: true,
        readStack: () => ++reads === 1
            ? { enabled: true, activeStackId: 1, depth: 4, stacks: [{ id: 1, depth: 4, active: true }] }
            : { enabled: true, activeStackId: 2, depth: 5, stacks: [
                { id: 1, depth: 4, active: false },
                { id: 2, depth: 5, active: true }
            ] }
    });

    await harness.service.runTraceStepper("lane-test", { maxSteps: 1, timeoutMs: 1000 }, (context) => {
        observed = context;
        return true;
    }, { trackLane: true, requireTrackedLane: true });
    assert.equal(observed.startStackId, 1);
    assert.equal(observed.activeStackId, 2);
    assert.equal(observed.sameLane, false);
    assert.equal(observed.startLanePresent, true);
});

test("trace stepper keeps synthetic frames separate from the starting real frame", async () => {
    let reads = 0;
    let observed;
    const harness = createDebuggerHarness({
        traceEnabled: true,
        readStack: () => ++reads === 1
            ? { enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [
                { id: 7, caller: 0x02000004, returnAddress: 0x02000008, callee: 0x02001000 }
            ] }] }
            : { enabled: true, activeStackId: 1, depth: 2, stacks: [{ id: 1, depth: 2, active: true, frames: [
                { id: 0, caller: 0x02001234, returnAddress: 0x02001234, callee: 0x02002222, synthetic: true },
                { id: 7, caller: 0x02000004, returnAddress: 0x02000008, callee: 0x02001000 }
            ] }] }
    });

    await harness.service.runTraceStepper("frame-test", { maxSteps: 1, timeoutMs: 1000 }, (context) => {
        observed = context;
        return true;
    }, { trackLane: true, requireTrackedLane: true });
    assert.equal(observed.startDepth, 1);
    assert.equal(observed.depth, 2);
    assert.equal(observed.startFramePresent, true);
    assert.equal(observed.atStartFrame, true);
    assert.equal(observed.deeperThanStart, false);
});

test("nextCallThisDepth ignores synthetic and entry-hook frames and stops only on a direct call from the starting depth", async () => {
    const startFrame = { id: 7, caller: 0x02000004, returnAddress: 0x02000008, callee: 0x02001000 };
    const syntheticFrame = { id: 0, caller: 0x02001234, returnAddress: 0x02001234, callee: 0x02002222, synthetic: true };
    const entryHookFrame = { id: 8, caller: 0x02000004, returnAddress: 0x02000008, callee: 0x02000020 };
    const childFrame = { id: 3, caller: 0x02000000, returnAddress: 0x02000004, callee: 0x02003000 };
    let reads = 0;
    const syntheticHarness = createDebuggerHarness({
        traceEnabled: true,
        readStack: () => ++reads === 1
            ? { enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] }
            : { enabled: true, activeStackId: 1, depth: 2, stacks: [{ id: 1, depth: 2, active: true, frames: [syntheticFrame, startFrame] }] }
    });
    const syntheticCommands = createDebuggerControlCommands({
        runTraceStepper: syntheticHarness.service.runTraceStepper,
        state: { selectedCpu: "arm9" }
    });
    const syntheticResult = await syntheticCommands.nextCallThisDepth({ maxSteps: 1, timeoutMs: 1000 });
    assert.equal(syntheticResult.complete, false);
    assert.equal(syntheticResult.stop, "maxSteps");

    reads = 0;
    const entryHookHarness = createDebuggerHarness({
        traceEnabled: true,
        readStack: () => ++reads === 1
            ? { enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] }
            : { enabled: true, activeStackId: 1, depth: 2, stacks: [{ id: 1, depth: 2, active: true, frames: [entryHookFrame, startFrame] }] }
    });
    const entryHookCommands = createDebuggerControlCommands({
        runTraceStepper: entryHookHarness.service.runTraceStepper,
        state: { selectedCpu: "arm9" }
    });
    const entryHookResult = await entryHookCommands.nextCallThisDepth({ maxSteps: 1, timeoutMs: 1000 });
    assert.equal(entryHookResult.complete, false);
    assert.equal(entryHookResult.stop, "maxSteps");

    reads = 0;
    let callPc = 0x02000000;
    const callHarness = createDebuggerHarness({
        traceEnabled: true,
        getPc: () => callPc,
        nativeStep: () => {
            callPc = childFrame.callee;
            return 1;
        },
        readStack: () => ++reads === 1
            ? { enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] }
            : { enabled: true, activeStackId: 1, depth: 2, stacks: [{ id: 1, depth: 2, active: true, frames: [childFrame, startFrame] }] }
    });
    const callCommands = createDebuggerControlCommands({
        runTraceStepper: callHarness.service.runTraceStepper,
        state: { selectedCpu: "arm9" }
    });
    const callResult = await callCommands.nextCallThisDepth({ maxSteps: 1, timeoutMs: 1000 });
    assert.equal(callResult.stop, "call");
    assert.notEqual(callResult.complete, false);
});

test("nextCallThisDepth does not accept a call made after leaving the starting depth", async () => {
    const startFrame = { id: 7, caller: 0x02000004, returnAddress: 0x02000008, callee: 0x02001000 };
    const childFrame = { id: 8, caller: 0x02000020, returnAddress: 0x02000024, callee: 0x02003000 };
    const grandchildFrame = { id: 9, caller: 0x02003000, returnAddress: 0x02003004, callee: 0x02004000 };
    let pc = 0x02000010;
    let steps = 0;
    let reads = 0;
    const harness = createDebuggerHarness({
        traceEnabled: true,
        getPc: () => pc,
        nativeStep: () => {
            steps++;
            pc = steps === 1 ? 0x02003004 : grandchildFrame.callee;
            return 1;
        },
        readStack: () => {
            reads++;
            if (reads === 1) {
                return { enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] };
            }
            if (reads === 2) {
                return { enabled: true, activeStackId: 1, depth: 2, stacks: [{ id: 1, depth: 2, active: true, frames: [childFrame, startFrame] }] };
            }
            return { enabled: true, activeStackId: 1, depth: 3, stacks: [{ id: 1, depth: 3, active: true, frames: [grandchildFrame, childFrame, startFrame] }] };
        }
    });
    const commands = createDebuggerControlCommands({
        runTraceStepper: harness.service.runTraceStepper,
        state: { selectedCpu: "arm9" }
    });
    const result = await commands.nextCallThisDepth({ maxSteps: 2, timeoutMs: 1000 });
    assert.equal(result.complete, false);
    assert.equal(result.stop, "maxSteps");
    assert.equal(result.steps, 2);
});

test("nextCallThisDepth stops on a direct call or the current function root", async () => {
    let shouldStop;
    let options;
    let useMissingFallback = false;
    let fallbackIncomplete = false;
    const commands = createDebuggerControlCommands({
        runTraceStepper: async (label, _params, predicate, receivedOptions) => {
            shouldStop = predicate;
            options = receivedOptions;
            if (useMissingFallback && typeof receivedOptions?.onMissingTrackedLane === "function") {
                return receivedOptions.onMissingTrackedLane();
            }
            if (fallbackIncomplete && label === "runUntilNextCall") {
                return { label, complete: false, stop: "maxSteps", limitReached: true };
            }
            return { label };
        },
        state: { selectedCpu: "arm9" }
    });

    assert.deepEqual(await commands.nextCallThisDepth(), { label: "nextCallThisDepth" });
    assert.equal(options.trackLane, true);
    assert.equal(options.requireTrackedLane, true);
    assert.equal(typeof options.onMissingTrackedLane, "function");
    assert.deepEqual(shouldStop({ sameLane: true, startLanePresent: true, startFramePresent: true, directCallFromStartDepth: true }), { stop: "call" });
    assert.deepEqual(shouldStop({ sameLane: true, startLanePresent: true, startFramePresent: false, directCallFromStartDepth: false }), { stop: "root", complete: false });
    assert.equal(shouldStop({ sameLane: true, startLanePresent: true, startFramePresent: true, directCallFromStartDepth: false }), false);
    assert.equal(shouldStop({ sameLane: false, startLanePresent: true, startFramePresent: true, directCallFromStartDepth: true }), false);
    assert.deepEqual(shouldStop({ sameLane: false, startLanePresent: false, startFramePresent: false, directCallFromStartDepth: false }), { stop: "root", complete: false });
    useMissingFallback = true;
    assert.deepEqual(await commands.nextCallThisDepth(), {
        label: "runUntilNextCall",
        kind: "nextCallThisDepth",
        implementation: "depth",
        stop: "call"
    });
    fallbackIncomplete = true;
    assert.deepEqual(await commands.nextCallThisDepth(), {
        label: "runUntilNextCall",
        complete: false,
        stop: "maxSteps",
        limitReached: true,
        kind: "nextCallThisDepth",
        implementation: "depth"
    });
    await assert.rejects(commands.nextCallThisDepth({ cpu: "arm7" }), /requires ARM9 Stack Trace data/);
});

test("trace stepper ignores only the initial exec breakpoint and honors a later one before executing it", async () => {
    const startFrame = { id: 1, caller: 0x01fffffc, returnAddress: 0x02001000, callee: 0x02000000 };
    let pc = 0x02000000;
    let steps = 0;
    let breakpointChecks = 0;
    let breakHit = false;
    const harness = createDebuggerHarness({
        traceEnabled: true,
        getPc: () => pc,
        nativeStep: () => {
            steps++;
            pc += 4;
            return 1;
        },
        checkExecBreakpoint: (_cpu, address) => {
            breakpointChecks++;
            breakHit = address === 0x02000004;
            return breakHit;
        },
        syncNativeBreakStatus: () => ({ lastBreak: { hit: breakHit } }),
        readStack: () => ({ enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] })
    });
    const result = await harness.service.runTraceStepper(
        "stepOver",
        { maxSteps: 2, timeoutMs: 1000 },
        () => false,
        { trackLane: true, requireTrackedLane: true }
    );
    assert.equal(result.stoppedByBreakpoint, true);
    assert.equal(result.steps, 1);
    assert.equal(steps, 1);
    assert.equal(breakpointChecks, 1);
    assert.equal(harness.suspensions(), 1);
    assert.equal(harness.freezes(), 1);
});

test("trace stepper routes native faults through the existing fault handler", async () => {
    const startFrame = { id: 1, caller: 0x01fffffc, returnAddress: 0x02001000, callee: 0x02000000 };
    const handled = [];
    const fault = Object.assign(new Error("native failed"), { mcpCode: "NATIVE_FAULT" });
    const harness = createDebuggerHarness({
        traceEnabled: true,
        nativeStep: () => { throw fault; },
        handleNativeFault: (error, where) => handled.push({ error, where }),
        readStack: () => ({ enabled: true, activeStackId: 1, depth: 1, stacks: [{ id: 1, depth: 1, active: true, frames: [startFrame] }] })
    });
    await assert.rejects(
        harness.service.runTraceStepper("stepOver", { maxSteps: 1, timeoutMs: 1000 }, () => false, { trackLane: true, requireTrackedLane: true }),
        /native failed/
    );
    assert.deepEqual(handled, [{ error: fault, where: "stepOver" }]);
});

test("public stepOver stops only at the sequential PC or below its starting trace depth", async () => {
    let shouldStop;
    let options;
    let instructionWidth = 4;
    let nativeKind = "";
    let useMissingFallback = false;
    const commands = createDebuggerControlCommands({
        ensureRomLoaded: () => {},
        getPc: () => 0x02000000,
        hex: (value) => `0x${Number(value).toString(16)}`,
        instructionWidthForMode: () => instructionWidth,
        runDebuggerInstruction: async (kind, params) => {
            nativeKind = kind;
            return { kind, count: 1, cpu: params.cpu };
        },
        runTraceStepper: async (label, _params, predicate, receivedOptions) => {
            shouldStop = predicate;
            options = receivedOptions;
            if (useMissingFallback && typeof receivedOptions?.onMissingTrackedLane === "function") {
                return receivedOptions.onMissingTrackedLane();
            }
            return { label };
        },
        state: { selectedCpu: "arm9" }
    });

    assert.deepEqual(await commands.stepOver(), { label: "stepOver" });
    assert.equal(options.trackLane, true);
    assert.equal(options.requireTrackedLane, true);
    assert.equal(typeof options.onMissingTrackedLane, "function");
    assert.deepEqual(shouldStop({ pc: 0x02000004, sameLane: true, startLanePresent: true, startFramePresent: true, atStartFrame: true }), {
        stop: "pc", target: "0x2000004"
    });
    assert.equal(shouldStop({ pc: 0x02000004, sameLane: false, startLanePresent: true, startFramePresent: true, atStartFrame: false }), false);
    assert.equal(shouldStop({ pc: 0x02000004, sameLane: true, startLanePresent: true, startFramePresent: true, atStartFrame: false }), false);
    assert.deepEqual(shouldStop({ pc: 0x03000000, sameLane: true, startLanePresent: true, startFramePresent: false, atStartFrame: false }), {
        stop: "root", complete: false, target: "0x2000004"
    });
    assert.equal(shouldStop({ pc: 0x03000000, sameLane: false, startLanePresent: true, startFramePresent: true, atStartFrame: false }), false);
    instructionWidth = 2;
    await commands.stepOver();
    assert.deepEqual(shouldStop({ pc: 0x02000002, sameLane: true, startLanePresent: true, startFramePresent: true, atStartFrame: true }), {
        stop: "pc", target: "0x2000002"
    });
    useMissingFallback = true;
    const missingLaneResult = await commands.stepOver();
    assert.equal(nativeKind, "nativeStepOver");
    assert.equal(missingLaneResult.kind, "stepOver");
    assert.equal(missingLaneResult.implementation, "native");
    assert.equal(missingLaneResult.count, 1);
    useMissingFallback = false;
    const arm7Result = await commands.stepOver({ cpu: "arm7" });
    assert.equal(nativeKind, "nativeStepOver");
    assert.equal(arm7Result.kind, "stepOver");
    assert.equal(arm7Result.implementation, "native");
});

test("re-enabling a suspended synchronized trace does not resume native tracing", async () => {
    let nativeEnableCalls = 0;
    const state = {
        traceEnabled: true,
        traceStateSynchronized: false
    };
    const ui = { traceToggle: { checked: false } };
    const commands = createDebuggerControlCommands({
        ensureReady: () => {},
        native: { setTraceEnabled: () => { nativeEnableCalls++; } },
        readCallStackData: () => ({ enabled: true, frames: [] }),
        renderCallStack: () => {},
        state,
        ui
    });

    assert.deepEqual(await commands.setStackTraceMode({ enabled: true }), {
        enabled: true,
        synchronized: false,
        suspended: true
    });
    assert.equal(nativeEnableCalls, 0);
    assert.equal(state.traceStateSynchronized, false);
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

test("public call stack matches UI rows without exposing internal frame data", () => {
    const view = createViewService({
        state: { selectedCpu: "arm9" },
        ui: {},
        native: { disassemble: () => "" },
        getIdbPut: () => () => {}
    });
    const frame = (caller, options = {}) => ({
        caller,
        returnAddress: caller + 4,
        callee: caller + 8,
        sp: 0x023ffff0,
        cpsr: 0x1f,
        cpsrHex: "0x0000001f",
        modeName: "System",
        thumb: false,
        id: caller,
        ...options
    });
    const data = {
        enabled: true,
        activeStackId: 1,
        stacks: [{
            id: 1,
            active: true,
            spHex: "0x023ffff0",
            nowPcHex: "0x02000000",
            frames: [
                frame(0x02000000),
                frame(0x02000010, { synthetic: true }),
                frame(0x02000020, { synthetic: true }),
                frame(0x02000030)
            ]
        }]
    };

    const result = view.publicCallStackData(view.normalizeCallStackData(data));
    assert.deepEqual(result.frames.map((item) => item.ageLabel), ["newest", "↑+1d", "↑+2d", "↑+3d"]);
    assert.deepEqual(result.frames.slice(1, 3).map((item) => item.mode), ["pc-write ", "pc-write "]);
    assert.equal(result.frames.some((item) => item.synthetic), false);
    assert.equal(result.frames.some((item) => item.kind !== undefined), false);
    assert.equal(result.frames.some((item) => item.expected !== undefined), false);
    assert.equal(result.frames.some((item) => item.target !== undefined), false);
    assert.equal("frames" in result.stacks[0], false);
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

test("public dispatcher forwards nextCallThisDepth unchanged to the command registry", async () => {
    const calls = [];
    const dispatcher = createCommandDispatcher({
        state: { ready: false },
        registry: {
            execute: async (name, params) => {
                calls.push({ name, params });
                return responder.ok({ stop: "call" });
            }
        },
        responder,
        operationManager: { current: () => null },
        hasLoadedRom: () => false,
        emulatorActivity: () => ({}),
        refreshDebuggerViews: async () => {},
        updateStatus: () => {},
        log: () => {}
    });
    const params = { maxSteps: 17, timeoutMs: 321 };
    const result = await dispatcher.run("nextCallThisDepth", params);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ name: "nextCallThisDepth", params }]);
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

test("script-only breakpoint policy rejects user and operation owners without blocking script hooks", async () => {
    const owners = createBreakpointOwnerStore();
    const state = {
        nextBreakpointId: 1,
        selectedCpu: "arm9",
        breakpoints: [],
        breakpointPolicy: "allow"
    };
    const commands = createDebuggerControlCommands({
        breakpointOwners: owners,
        ensureReady: () => {},
        ensureRomLoaded: () => {},
        parseAddress: Number,
        renderBreakpoints: () => {},
        state,
        ui: {
            bpDataAbortToggle: { checked: false },
            bpPrefetchAbortToggle: { checked: false },
            bpUndefinedToggle: { checked: false }
        }
    });

    assert.deepEqual(await commands.setBreakpointPolicy({ mode: "script-only" }), {
        mode: "script-only"
    });
    await assert.rejects(
        commands.setBreakpoint({ cpu: "arm9", type: "exec", address: 0x02000000 }),
        (error) => error.mcpCode === "BREAKPOINT_POLICY_VIOLATION"
    );
    await assert.rejects(
        commands.setBreakpoint(withInternalMetadata(
            { cpu: "arm9", type: "exec", address: 0x02000004 },
            { origin: "operation", operationId: 1 }
        )),
        (error) => error.mcpCode === "BREAKPOINT_POLICY_VIOLATION"
    );
    const script = await commands.setBreakpoint(withInternalMetadata(
        { cpu: "arm9", type: "exec", address: 0x02000008 },
        { origin: "script", scriptId: 2, triggerId: 3 }
    ));
    assert.equal(script.id, 1);
    assert.equal(owners.classifySite({ cpu: "arm9", type: "exec", address: 0x02000008 }).scriptOnly, true);
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

test("eval Worker waits for ready, forwards registered RPC commands, and disposes once", async () => {
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

    const secondPosted = [];
    const secondCalls = [];
    const secondWorker = {
        postMessage: (message) => secondPosted.push(message),
        onmessage: null,
        onerror: null,
        onmessageerror: null
    };
    const unrestricted = createScriptRunner({
        source: "worker source",
        responder,
        callCommand: async (command, params) => {
            secondCalls.push({ command, params });
            return responder.ok();
        },
        createWorker: () => ({ worker: secondWorker, dispose: () => {} })
    });
    const unrestrictedRun = unrestricted.run("return 1", 1000);
    await secondWorker.onmessage({ data: { type: "ready", hardened: true, layer: "supervisor" } });
    await secondWorker.onmessage({
        data: { type: "call", id: "1", command: "runPersistentScript", params: {} }
    });
    assert.deepEqual(JSON.parse(JSON.stringify(secondCalls)), [
        { command: "runPersistentScript", params: {} }
    ]);
    assert.equal(secondPosted.at(-1).replyId, "1");
    await secondWorker.onmessage({ data: { type: "done", result: 1 } });
    assert.equal((await unrestrictedRun).value, 1);
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
    assert.equal(event.callbackId, 8);
    assert.equal(event.triggerId, 1);
    assert.equal(await coordinator.finishPersistentScriptEvent(event.eventId, {
        scriptId: 99,
        callbackId: event.callbackId,
        callbackToken: event.callbackToken
    }), false);
    await coordinator.settlePersistentScriptCallbacks(4);
    assert.equal(state.pendingScriptEvents.size, 0);
    assert.equal(paused, true);
});

test("controlled script replacement resumes an active script-only trap after callback cancellation", async () => {
    const messages = [];
    const pauseEvents = [];
    let resumed = false;
    let wakes = 0;
    let breakHit = true;
    const state = {
        ready: true, selectedCpu: "arm9", lastBreakKey: "", breakRefreshKey: "",
        scriptTriggers: [{ id: 1, scriptId: 4, callbackId: 8, type: "dataAbort", cpu: "arm9", address: 0 }],
        scripts: new Map([[4, { running: true, worker: { postMessage: (message) => messages.push(message) } }]]),
        pendingScriptEvents: new Map(), nextScriptEventId: 1, nextScriptCallbackToken: 1,
        explicitPauseSerial: 0, frame: 0, romGeneration: 1,
        fileTransactionSerial: 0, fileTransactionActive: false, loadingFile: false,
        nativeBreakSerial: 0, breakpointsInSync: true
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "special", type: "dataAbort", address: 0 }, {
        id: 2, origin: "script", scriptId: 4, triggerId: 1
    });
    const native = {
        getStatus: () => ({
            arm9: { pc: 0x02000000 },
            lastBreak: breakHit
                ? { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
                : { hit: false }
        }),
        pause: (paused) => { if (!paused) resumed = true; },
        clearBreakStatus: () => { breakHit = false; },
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state,
        native,
        breakpointOwners: owners,
        breakpointService: createBreakpointService({ ownerStore: owners }),
        pauseEventService: { publish: (event) => pauseEvents.push(event) },
        getQueueBreakpointRefresh: () => () => {},
        getWakeEmulationLoop: () => () => { wakes++; },
        log: () => {},
        hex: String,
        updateStatus: () => {}
    });

    coordinator.syncNativeBreakStatus({
        frame: 1, arm9: { pc: 0x02000000 },
        lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc: 0x02000000, value: 0 }
    });
    assert.equal(messages.length, 1);
    assert.equal(state.paused, true);
    await coordinator.settlePersistentScriptCallbacks(4, { resumeScriptOnlyTrap: true });
    assert.equal(state.pendingScriptEvents.size, 0);
    assert.equal(state.paused, false);
    assert.equal(state.running, true);
    assert.equal(resumed, true);
    assert.equal(wakes, 1);
    assert.equal(pauseEvents.length, 0);
});

test("callback resume releases only its callback and resolves after the full breakpoint barrier", async () => {
    const messages = [];
    let nativePaused = true;
    let breakHit = true;
    let pc = 0x02000000;
    let steps = 0;
    let wakes = 0;
    const state = {
        ready: true,
        selectedCpu: "arm9",
        lastBreakKey: "",
        breakRefreshKey: "",
        scriptTriggers: [
            { id: 1, scriptId: 4, callbackId: 8, type: "exec", cpu: "arm9", address: 0x02000000 },
            { id: 2, scriptId: 5, callbackId: 9, type: "exec", cpu: "arm9", address: 0x02000000 }
        ],
        scripts: new Map([
            [4, { running: true, worker: { postMessage: (message) => messages.push(message) } }],
            [5, { running: true, worker: { postMessage: (message) => messages.push(message) } }]
        ]),
        pendingScriptEvents: new Map(),
        nextScriptEventId: 1,
        nextScriptCallbackToken: 1,
        explicitPauseSerial: 0,
        frame: 0,
        romGeneration: 1,
        fileTransactionSerial: 0,
        fileTransactionActive: false,
        loadingFile: false,
        nativeBreakSerial: 0,
        breakpointsInSync: true
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000000 }, {
        id: 2, origin: "script", scriptId: 4, triggerId: 1
    });
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000000 }, {
        id: 3, origin: "script", scriptId: 5, triggerId: 2
    });
    const native = {
        getStatus: () => ({
            arm9: { pc },
            lastBreak: breakHit
                ? { hit: true, cpu: "arm9", kind: 0, address: 0x02000000, pc: 0x02000000, value: 0 }
                : { hit: false }
        }),
        pause: (value) => { nativePaused = value; },
        isPaused: () => nativePaused,
        clearBreakStatus: () => { breakHit = false; },
        step: () => { steps++; pc += 4; return 1; },
        setBreakpoint: () => {},
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state,
        native,
        breakpointOwners: owners,
        breakpointService: { publish: () => {} },
        getQueueBreakpointRefresh: () => () => {},
        getWakeEmulationLoop: () => () => { wakes++; },
        log: () => {},
        hex: String,
        updateStatus: () => {}
    });

    coordinator.syncNativeBreakStatus({
        frame: 1,
        arm9: { pc: 0x02000000 },
        lastBreak: { hit: true, cpu: "arm9", kind: 0, address: 0x02000000, pc: 0x02000000, value: 0 }
    });
    assert.equal(messages.length, 2);
    const first = messages.find((message) => message.scriptId === 4);
    const second = messages.find((message) => message.scriptId === 5);
    const resumeCompletion = coordinator.requestPersistentScriptResume(first.eventId, {
        scriptId: first.scriptId,
        callbackId: first.callbackId,
        callbackToken: first.callbackToken
    });
    assert.ok(resumeCompletion instanceof Promise);
    assert.equal(nativePaused, true);
    assert.equal(steps, 0);
    assert.equal(state.pendingScriptEvents.size, 1);

    assert.equal(await coordinator.finishPersistentScriptEvent(second.eventId, {
        scriptId: second.scriptId,
        callbackId: second.callbackId,
        callbackToken: second.callbackToken
    }), true);
    const result = await resumeCompletion;
    assert.deepEqual(result, {
        ok: true,
        resumed: true,
        eventId: first.eventId,
        steppedPast: true,
        nativePaused: false,
        running: true,
        paused: false
    });
    assert.equal(state.pendingScriptEvents.size, 0);
    assert.equal(nativePaused, false);
    assert.equal(state.paused, false);
    assert.equal(state.running, true);
    assert.equal(steps, 1);
    assert.equal(wakes, 1);
});

test("State load remains paused until persistent stateLoad handlers complete", async () => {
    const events = [];
    let releaseLifecycle;
    let lifecycleEntered;
    const lifecycleStarted = new Promise((resolve) => { lifecycleEntered = resolve; });
    const lifecycleHold = new Promise((resolve) => { releaseLifecycle = resolve; });
    const commands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        blockSaveFlush: () => events.push("flush-blocked"),
        cancelAndWait: async () => events.push("cancelled"),
        dispatchScriptEvent: () => {},
        dispatchScriptEventAndWait: async (event) => {
            events.push(`lifecycle:${event}`);
            lifecycleEntered();
            await lifecycleHold;
            events.push("lifecycle-complete");
        },
        drawLoadedStateFrame: () => events.push("frame-invalidated"),
        ensureRomLoaded: () => {},
        idbGet: async () => null,
        isAnalysisBaselineSlot: () => false,
        loadStateBytesFromMemory: () => 0,
        native: {
            loadBufferedState: () => { events.push("native-load"); return 0; },
            setTraceSuspended: () => {}
        },
        pauseForFileLoad: () => { events.push("paused"); return { running: true, paused: false }; },
        rememberSlot: () => {},
        restoreAfterFileLoad: () => events.push("restored"),
        state: { frame: 9, traceEnabled: false },
        stopAfterFailedStateLoad: () => events.push("failed-stop")
    });

    const loading = commands.loadState();
    await lifecycleStarted;
    assert.deepEqual(events, [
        "cancelled",
        "paused",
        "native-load",
        "flush-blocked",
        "frame-invalidated",
        "lifecycle:stateLoad"
    ]);
    releaseLifecycle();
    await loading;
    assert.deepEqual(events.slice(-2), ["lifecycle-complete", "restored"]);
    assert.equal(events.includes("failed-stop"), false);
});

test("State load handler failure never restores the previous running state", async () => {
    const events = [];
    const commands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        blockSaveFlush: () => {},
        cancelAndWait: async () => {},
        dispatchScriptEvent: () => {},
        dispatchScriptEventAndWait: async () => {
            throw new Error("stateLoad handler failed");
        },
        drawLoadedStateFrame: () => {},
        ensureRomLoaded: () => {},
        idbGet: async () => null,
        isAnalysisBaselineSlot: () => false,
        loadStateBytesFromMemory: () => 0,
        native: { loadBufferedState: () => 0, setTraceSuspended: () => {} },
        pauseForFileLoad: () => ({ running: true, paused: false }),
        rememberSlot: () => {},
        restoreAfterFileLoad: () => events.push("restored"),
        state: { frame: 9, traceEnabled: false },
        stopAfterFailedStateLoad: () => events.push("failed-stop")
    });

    await assert.rejects(commands.loadState(), /stateLoad handler failed/);
    assert.deepEqual(events, ["failed-stop"]);
});

test("callPScriptMcp accepts MCP-only lookup and defaults its caller timeout to 60 seconds", async () => {
    const calls = [];
    const commands = createScriptCommands({
        state: { scripts: new Map(), activeScriptId: 0 },
        ui: {},
        callPScriptMcp: async (params) => { calls.push(params); return { ok: true }; }
    });

    await commands.callPScriptMcp({ name: "observerRead", params: { fresh: true }, blocking: true });
    assert.deepEqual(calls, [{
        name: "observerRead",
        params: { fresh: true },
        blocking: true,
        timeoutMs: 60000
    }]);
});

test("clearBreakpoints removes logical owners before one native reconciliation", async () => {
    let nativeClears = 0;
    const registered = [];
    const owners = createBreakpointOwnerStore({
        onClearNative: () => { nativeClears++; },
        onFirstOwner: (site) => registered.push(`${site.cpu}:${site.type}:${site.address}`)
    });
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000000 }, {
        id: 1, origin: "user"
    });
    owners.addOwner({ cpu: "arm9", type: "exec", address: 0x02000004 }, {
        id: 2, origin: "script", scriptId: 4
    });
    nativeClears = 0;
    registered.length = 0;
    const state = {
        breakpoints: [{ id: 1, cpu: "arm9", type: "exec", address: 0x02000000 }]
    };
    const commands = createDebuggerControlCommands({
        breakpointOwners: owners,
        ensureReady: () => {},
        renderBreakpoints: () => {},
        state,
        updateStatus: () => {}
    });

    const result = await commands.clearBreakpoints({ origin: "user" });
    assert.equal(nativeClears, 1);
    assert.deepEqual(registered, ["arm9:exec:33554436"]);
    assert.deepEqual(result.removedIds, [1]);
    assert.equal(result.breakpointsInSync, true);
    assert.deepEqual(state.breakpoints, []);
    assert.equal(owners.getOwners({ cpu: "arm9", type: "exec", address: 0x02000004 }).length, 1);
});

test("restartScript preserves API identity and requests safe resume for an active script-only trap", async () => {
    const stopCalls = [];
    const startCalls = [];
    const script = {
        id: 7,
        name: "observer",
        identitySource: "api-name",
        code: "return [];",
        asyncMode: false
    };
    const state = { scripts: new Map([[script.id, script]]), activeScriptId: script.id };
    const commands = createScriptCommands({
        state,
        ui: {},
        stopPersistentScript: async (params) => {
            stopCalls.push(params);
            return { id: params.id, name: script.name };
        },
        startPersistentScript: async (params, internalOptions) => {
            startCalls.push({ params, internalOptions });
            return { id: script.id, name: script.name, running: true, started: true };
        }
    });

    const result = await commands.restartScript({ name: script.name, startupTimeoutMs: 10000 });
    assert.deepEqual(stopCalls, [{ id: 7, resumeScriptOnlyTrap: true }]);
    assert.deepEqual(startCalls, [{
        params: { name: "observer", code: "return [];", asyncMode: false, startupTimeoutMs: 10000 },
        internalOptions: { deduplicateByCode: false, existingId: 7 }
    }]);
    assert.equal(result.id, 7);
    assert.equal(result.name, "observer");
    assert.equal(result.reloaded, true);
});

test("runLoadedPersistentScript starts the current editor source under the exact requested name", async () => {
    const startCalls = [];
    const state = {
        scripts: new Map([[3, { id: 3, name: "same-code-other-name", code: "return [];", running: true }]]),
        activeScriptId: 3
    };
    const commands = createScriptCommands({
        state,
        ui: { scriptCode: { value: "return [];" } },
        startPersistentScript: async (params, internalOptions) => {
            startCalls.push({ params, internalOptions });
            return { id: 9, name: params.name, running: true, started: true };
        }
    });

    const result = await commands.runLoadedPersistentScript({
        name: "battle_observer_mcp",
        asyncMode: false,
        startupTimeoutMs: 10000
    });
    assert.deepEqual(startCalls, [{
        params: { name: "battle_observer_mcp", asyncMode: false, startupTimeoutMs: 10000 },
        internalOptions: { source: "return [];", deduplicateByCode: false }
    }]);
    assert.equal(result.id, 9);
    assert.equal(result.name, "battle_observer_mcp");
    assert.equal(result.source, "loaded-editor");
    assert.equal(result.reloaded, false);
});

test("runLoadedPersistentScript omits an empty UI name and accepts a generated identity", async () => {
    const startCalls = [];
    const commands = createScriptCommands({
        state: { scripts: new Map(), activeScriptId: 0 },
        ui: { scriptCode: { value: "return [];" } },
        startPersistentScript: async (params, internalOptions) => {
            startCalls.push({ params, internalOptions });
            return {
                id: 12,
                name: "script-12",
                nameProvisional: true,
                identitySource: "generated",
                running: true,
                started: true,
                topLevelRunning: false,
                registrationComplete: true,
                mcpCount: 0,
                mcpNames: []
            };
        }
    });

    const result = await commands.runLoadedPersistentScript({ asyncMode: false });
    assert.deepEqual(startCalls, [{
        params: { asyncMode: false },
        internalOptions: { source: "return [];", deduplicateByCode: false }
    }]);
    assert.equal(result.id, 12);
    assert.equal(result.name, "script-12");
    assert.equal(result.mcpCount, 0);
});

test("runLoadedPersistentScript rejects code input and incomplete startup identities", async () => {
    const state = { scripts: new Map(), activeScriptId: 0 };
    const commands = createScriptCommands({
        state,
        ui: { scriptCode: { value: "return [];" } },
        startPersistentScript: async () => ({ running: true, started: true })
    });
    await assert.rejects(
        () => commands.runLoadedPersistentScript({ name: "observer", code: "return [];" }),
        /code is not allowed/
    );
    await assert.rejects(
        () => commands.runLoadedPersistentScript({ name: "observer" }),
        /required id and name/
    );

    const premature = createScriptCommands({
        state,
        ui: { scriptCode: { value: "return [];" } },
        startPersistentScript: async () => ({
            id: 4,
            name: "observer",
            running: true,
            started: false
        })
    });
    await assert.rejects(
        () => premature.runLoadedPersistentScript({ name: "observer" }),
        /before running and started were true/
    );
});

test("API_CURRENT prohibits click-based loaded-script startup", async () => {
    const api = await readFile(new URL("../webassembly/API_CURRENT.md", import.meta.url), "utf8");
    assert.match(api, /runLoadedPersistentScript/);
    assert.match(api, /UI click経由での起動は禁止する/);
    assert.match(api, /\.click\(\)/);
    assert.match(api, /dispatching a click event/);
});

test("pending persistent callback timeout fails closed without auto-resume", async () => {
    const messages = [];
    const logs = [];
    const pauseEvents = [];
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
        pauseEventService: { publish: (event) => pauseEvents.push(event) },
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
    assert.equal(pauseEvents.length, 1);
    assert.equal(pauseEvents[0].scriptEventFailure, true);
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

test("script-only exec hooks stay internal, avoid public pause delivery, and wake immediately after completion", async () => {
    const address = 0x02000000;
    const messages = [];
    const pauseEvents = [];
    const logs = [];
    let refreshes = 0;
    let wakes = 0;
    let pc = address;
    let breakHit = true;
    let resumed = false;
    const state = {
        ready: true, selectedCpu: "arm9", lastBreakKey: "", breakRefreshKey: "",
        scriptTriggers: [{ id: 1, scriptId: 3, callbackId: 5, type: "exec", cpu: "arm9", address }],
        scripts: new Map([[3, { running: true, worker: { postMessage: (message) => messages.push(message) } }]]),
        pendingScriptEvents: new Map(), nextScriptEventId: 1, nextScriptCallbackToken: 1,
        explicitPauseSerial: 0, frame: 0, romGeneration: 1,
        fileTransactionSerial: 0, fileTransactionActive: false, loadingFile: false,
        nativeBreakSerial: 0, breakpointsInSync: true
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "arm9", type: "exec", address }, {
        id: 1, origin: "script", scriptId: 3, triggerId: 1
    });
    const native = {
        getStatus: () => ({
            arm9: { pc },
            lastBreak: breakHit
                ? { hit: true, cpu: "arm9", kind: 0, address, pc, value: 0 }
                : { hit: false }
        }),
        pause: (paused) => { if (!paused) resumed = true; },
        clearBreakStatus: () => { breakHit = false; },
        step: () => { pc += 4; return 1; },
        setBreakpoint: () => {},
        hasLoadedRom: () => true
    };
    const coordinator = createDebuggerCoordinator({
        state,
        native,
        breakpointOwners: owners,
        breakpointService: createBreakpointService({ ownerStore: owners }),
        pauseEventService: { publish: (event) => pauseEvents.push(event) },
        getQueueBreakpointRefresh: () => () => { refreshes++; },
        getWakeEmulationLoop: () => () => { wakes++; },
        log: (message) => logs.push(message),
        hex: String,
        updateStatus: () => {}
    });

    coordinator.syncNativeBreakStatus({
        frame: 1,
        arm9: { pc },
        lastBreak: { hit: true, cpu: "arm9", kind: 0, address, pc, value: 0 }
    });
    assert.equal(messages.length, 1);
    assert.equal(pauseEvents.length, 0);
    assert.equal(refreshes, 0);
    assert.equal(logs.length, 0);

    const event = messages[0];
    assert.equal(await coordinator.finishPersistentScriptEvent(event.eventId, {
        scriptId: 3,
        callbackId: event.callbackId,
        callbackToken: event.callbackToken
    }), true);
    assert.equal(resumed, true);
    assert.equal(wakes, 1);
    assert.equal(state.paused, false);
    assert.equal(state.running, true);
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

test("byte injection refreshes a prefetched instruction only after all overlapping bytes are written", async () => {
    let currentPc = 0x020f9104;
    let currentCpsr = 0x10;
    const events = [];
    const binary = createBinaryTools({
        getPc: () => currentPc,
        getSelectedCpu: () => "arm9"
    });
    const memory = createMemoryCommands({
        applyFreezes: () => {},
        bigEndianValue: binary.bigEndianValue,
        bytesFromFlexibleParams: binary.bytesFromFlexibleParams,
        ensureRomLoaded: () => {},
        hex: (value) => `0x${Number(value).toString(16)}`,
        log: () => {},
        matchSearchCondition: () => false,
        memorySearchRangeKey: () => "",
        memorySearchRanges: () => [],
        native: {
            dumpMemory: () => new Uint8Array(16),
            getPc: () => currentPc,
            getRegister: (_cpu, register) => register === 16 ? currentCpsr : 0,
            setRegister: (cpu, register, value) => events.push({ type: "register", cpu, register, value }),
            writeMemory: (cpu, address, value, size) => events.push({ type: "write", cpu, address, value, size })
        },
        openPicker: async () => { throw new Error("picker must not be used"); },
        parseAddress: binary.parseAddress,
        parseNumber: binary.parseNumber,
        readFileFromInput: async () => { throw new Error("file input must not be used"); },
        readSized: () => 0,
        renderFreezes: () => {},
        renderMemoryDump: () => {},
        state: { selectedCpu: "arm9", freezes: [], search: {} },
        swap16: binary.swap16,
        swap32: binary.swap32,
        ui: {
            memoryAddress: { value: "03000000" },
            memoryLength: { value: "16" },
            memoryView: { value: "bytes" },
            memoryInjectFile: { files: [] },
            searchSize: { value: "1" },
            searchCondition: { value: "equal" },
            searchValue: { value: "0" },
            searchLimit: { value: "10" }
        }
    });

    await memory.injectBytes({ cpu: "arm9", address: currentPc, hex: "1e ff 2f e1" });
    assert.deepEqual(events, [
        { type: "write", cpu: "arm9", address: 0x020f9104, value: 0x1e, size: 1 },
        { type: "write", cpu: "arm9", address: 0x020f9105, value: 0xff, size: 1 },
        { type: "write", cpu: "arm9", address: 0x020f9106, value: 0x2f, size: 1 },
        { type: "write", cpu: "arm9", address: 0x020f9107, value: 0xe1, size: 1 },
        { type: "register", cpu: "arm9", register: 15, value: 0x020f9104 }
    ]);

    events.length = 0;
    currentCpsr = 0x30;
    await memory.injectBytes({ cpu: "arm9", address: currentPc + 1, bytes: [0x70] });
    assert.deepEqual(events, [
        { type: "write", cpu: "arm9", address: 0x020f9105, value: 0x70, size: 1 },
        { type: "register", cpu: "arm9", register: 15, value: 0x020f9105 }
    ]);

    events.length = 0;
    await memory.injectBytes({ cpu: "arm9", address: currentPc + 0x100, bytes: [0xaa] });
    assert.deepEqual(events, [
        { type: "write", cpu: "arm9", address: 0x020f9204, value: 0xaa, size: 1 }
    ]);
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
