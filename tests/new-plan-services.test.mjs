import test from "node:test";
import assert from "node:assert/strict";

import { createMcpResponder } from "../src/mcp-responder.js";
import { createPauseEventService } from "../src/pause-event-service.js";
import { createSerialEventService } from "../src/serial-event-service.js";
import { createOrderedFrameDrain } from "../src/ordered-frame-drain.js";
import { createInputSequenceService } from "../src/input-service.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { applyScreenLayout } from "../src/ui/screen-layout.js";
import { createOperationManager } from "../src/operation-manager.js";
import { registerWaitCommands } from "../src/commands/wait-commands.js";
import { createInputRecordingService } from "../src/input-recording-service.js";
import { createInputTaskManager } from "../src/input-task-manager.js";
import { createFileTransactionService } from "../src/file-transaction-service.js";
import { createInputWindow } from "../src/input-window.js";
import { createInputCommands } from "../src/commands/input-commands.js";
import { createRuntimeLoader } from "../src/runtime-loader.js";
import { createBootstrapWebMcpTools } from "../src/bootstrap-webmcp.js";
import { createContextCommands } from "../src/commands/context-commands.js";
import { getInternalMetadata } from "../src/internal-command-metadata.js";

test("pause events use monotonic serials and kind filters", async () => {
    const service = createPauseEventService();
    const controller = new AbortController();
    const waiting = service.waitForEvent({
        afterSerial: service.currentSerial(),
        kinds: ["memoryBreakpoint"],
        signal: controller.signal
    });
    const manual = service.publish({ pauseKind: "manual", frame: 3 });
    const memory = service.publish({ pauseKind: "memoryBreakpoint", breakType: "write", frame: 4 });
    assert.equal(manual.serial, 1);
    assert.equal(memory.serial, 2);
    assert.equal((await waiting).breakType, "write");
});

test("ordered frame drain preserves samples completed during an async comparison", async () => {
    let listener = () => {};
    let pixel = 0;
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    const observed = [];
    const drain = createOrderedFrameDrain({
        frameService: {
            subscribe(callback) {
                listener = callback;
                return () => { listener = () => {}; };
            },
            captureCurrent: () => ({ ok: true, pixels: new Uint32Array([++pixel]) })
        },
        onSample: async (sample) => {
            observed.push(sample.pixels[0]);
            if (observed.length === 1) await firstBlocked;
        },
        onOverflow: () => assert.fail("queue should not overflow"),
        onError: (error) => assert.fail(String(error))
    });
    listener({ frame: 1, serial: 1 });
    listener({ frame: 2, serial: 2 });
    listener({ frame: 3, serial: 3 });
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, [1, 2, 3]);
    drain.stop();
});

test("ordered frame drain reports overflow instead of silently dropping samples", async () => {
    let listener = () => {};
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
    let overflow = null;
    const drain = createOrderedFrameDrain({
        frameService: {
            subscribe(callback) {
                listener = callback;
                return () => { listener = () => {}; };
            },
            captureCurrent: () => ({ ok: true, pixels: new Uint32Array([1]) })
        },
        maxQueue: 1,
        onSample: () => firstBlocked,
        onOverflow: (details) => { overflow = details; },
        onError: (error) => assert.fail(String(error))
    });
    listener({ frame: 1, serial: 1 });
    listener({ frame: 2, serial: 2 });
    listener({ frame: 3, serial: 3 });
    assert.equal(overflow?.maxQueue, 1);
    assert.equal(drain.stats().active, false);
    releaseFirst();
});

test("input sequence validation is atomic when the final tuple is invalid", async () => {
    const responder = createMcpResponder({ logger: {} });
    let mutations = 0;
    let writes = 0;
    const service = createInputSequenceService({
        responder,
        press: () => { mutations++; },
        releaseAll: () => { mutations++; },
        touch: () => { mutations++; },
        stepFrames: async () => ({ frames: 1 }),
        getPauseDetails: () => ({ paused: false, running: true }),
        storage: {
            getItem: () => null,
            setItem: () => { writes++; }
        }
    });
    const result = await service.run({
        id: "atomic",
        seq: [["t", "A", 1], ["x", 256, 0, 1]]
    }, { signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.equal(mutations, 0);
    assert.equal(writes, 0);
});

test("bulk breakpoint removal preserves non-target owners", () => {
    const store = createBreakpointOwnerStore();
    const site = { cpu: "arm9", type: "exec", address: 0x02000000 };
    store.addOwner(site, { id: 1, origin: "user" });
    store.addOwner(site, { id: 2, origin: "script", scriptId: 7 });
    const removed = store.removeOwnersByOrigin("user");
    assert.deepEqual(removed.map((item) => item.id), [1]);
    assert.deepEqual(store.getOwners(site).map((item) => item.id), [2]);
});

test("bootstrap screen layout reserves the rotated canvas position before runtime load", () => {
    const values = new Map();
    const screenShell = {
        style: {
            setProperty(name, value) {
                values.set(name, value);
            }
        }
    };
    applyScreenLayout(screenShell, { scale: 2, rotation: 90 });
    assert.equal(values.get("--canvas-w"), "512px");
    assert.equal(values.get("--canvas-h"), "768px");
    assert.equal(values.get("--screen-w"), "768px");
    assert.equal(values.get("--screen-h"), "512px");
    assert.equal(values.get("--screen-rotation"), "90deg");
});

test("serial and pause waits resolve events completed before listener registration", async () => {
    const serialEvents = createSerialEventService();
    serialEvents.publish({ stateLoadSerial: 1 });
    assert.equal((await serialEvents.waitForEvent({
        afterSerial: 0,
        predicate: (event) => event.stateLoadSerial > 0
    })).stateLoadSerial, 1);

    const pauseEvents = createPauseEventService();
    pauseEvents.publish({ pauseKind: "manual", frame: 8 });
    assert.equal((await pauseEvents.waitForEvent({
        afterSerial: 0,
        kinds: ["manual"]
    })).frame, 8);
});

test("State and idle file watchers survive the file load that completes them", async () => {
    const responder = createMcpResponder({ logger: {} });
    const operationManager = createOperationManager({ responder });
    const stateEvents = createSerialEventService();
    const fileEvents = createSerialEventService();
    const commands = {};
    registerWaitCommands({
        commands,
        descriptions: {},
        responder,
        operationManager,
        breakpointOwners: {},
        breakpointService: {},
        scriptPauseService: createSerialEventService(),
        pauseEventService: createPauseEventService(),
        stateLoadEventService: stateEvents,
        fileTransactionEventService: fileEvents,
        frameService: {},
        inputSequenceService: {},
        inputRecordingService: {},
        getNativeStatus: () => null,
        parseAddress: Number,
        hex: String,
        getFrame: () => 0
    });

    stateEvents.publish({ stateLoadSerial: 1 });
    assert.equal((await commands.waitForStateLoad({
        afterSerial: 0,
        timeoutMs: 1000
    })).stateLoadSerial, 1);

    const state = {
        fileTransactionActive: false,
        fileTransactionSerial: 0,
        nativeBreakSerial: 0
    };
    const transactions = createFileTransactionService({ state, eventService: fileEvents });
    const waiting = commands.waitForFileTransaction({
        afterSerial: 0,
        idle: true,
        timeoutMs: 1000
    });
    await transactions.run("State load", async ({ commit }) => {
        await commit();
        await new Promise((resolve) => setImmediate(resolve));
    });
    const result = await waiting;
    assert.equal(result.fileTransactionSerial, 1);
    assert.equal(result.fileTransactionActive, false);
    assert.equal(result.phase, "end");
    assert.equal(operationManager.current(), null);
});

function createRecordingHarness({ store, failMetadataWrite = () => false } = {}) {
    const responder = createMcpResponder({ logger: {} });
    let activity = { paused: false, running: true };
    const commands = {
        pause: async () => {
            activity = { paused: true, running: false };
            return responder.ok();
        },
        resume: async () => {
            activity = { paused: false, running: true };
            return responder.ok();
        },
        stepFrames: async ({ frames }) => responder.ok({ frames })
    };
    const service = createInputRecordingService({
        responder,
        idbGet: async (key) => store.get(key),
        idbPut: async (key, value) => {
            if (failMetadataWrite(key)) throw new Error("metadata write failed");
            store.set(key, value);
        },
        idbDelete: async (key) => { store.delete(key); },
        idbKeys: async () => [...store.keys()],
        frameService: { subscribe: () => () => {} },
        pauseEventService: createPauseEventService(),
        fileTransactionEventService: createSerialEventService(),
        subscribeInputMutations: () => () => {},
        getInputSnapshot: () => ({ keyMask: 0, touchActive: false, x: 0, y: 0 }),
        applyInputSnapshot: () => {},
        releaseInput: () => {},
        getFrame: () => 10,
        getActivity: () => activity,
        getCpuState: () => ({
            arm9: { pc: 1, cpsr: 2 },
            arm7: { pc: 3, cpsr: 4 }
        }),
        currentRomIdentity: async () => ({
            romName: "game.nds",
            romSize: 16,
            romSha256: "rom"
        }),
        sha256Hex: async () => "state-hash",
        saveStateBytes: () => new Uint8Array([1]),
        commands,
        waitForInputWindow: async () => {}
    });
    return { responder, service, commands };
}

test("recording replacement commits through temporary keys and preserves old data on failure", async () => {
    const oldMetadata = {
        id: "demo",
        dataKey: "input-recording:data:old",
        stateKey: "input-recording:state:old"
    };
    const store = new Map([
        ["input-recording:meta:demo", oldMetadata],
        [oldMetadata.dataKey, [["i", 0, 1, false, 0, 0]]],
        [oldMetadata.stateKey, new Uint8Array([9])]
    ]);
    let failMetadata = true;
    const { service } = createRecordingHarness({
        store,
        failMetadataWrite: (key) => failMetadata && key === "input-recording:meta:demo"
    });
    const operation = { signal: new AbortController().signal };

    await assert.rejects(
        service.record({ id: "demo", replace: true, durationMs: 1 }, operation),
        /metadata write failed/
    );
    assert.equal(store.get("input-recording:meta:demo"), oldMetadata);
    assert.equal(store.has(oldMetadata.dataKey), true);
    assert.equal(store.has(oldMetadata.stateKey), true);
    assert.deepEqual([...store.keys()].sort(), [
        "input-recording:data:old",
        "input-recording:meta:demo",
        "input-recording:state:old"
    ]);

    failMetadata = false;
    const result = await service.record({
        id: "demo",
        replace: true,
        durationMs: 1,
        captureState: false
    }, operation);
    assert.equal(result.ok, true);
    assert.equal(store.has(oldMetadata.dataKey), false);
    assert.equal(store.has(oldMetadata.stateKey), false);
    assert.equal(store.get("input-recording:meta:demo").stateKey, null);
});

test("file transactions abort and settle long input tasks before loading", async () => {
    const inputTaskManager = createInputTaskManager();
    const pauseEventService = createPauseEventService();
    const waitForInputWindow = createInputWindow({ pauseEventService });
    const pressed = new Map();
    let pressedResolve;
    const becamePressed = new Promise((resolve) => { pressedResolve = resolve; });
    const state = {
        paused: false,
        running: true,
        ready: true,
        keys: 0,
        buttons: { A: 0 },
        touch: { active: false, x: 0, y: 0 },
        keymap: {},
        fileTransactionActive: false,
        fileTransactionSerial: 0,
        nativeBreakSerial: 0
    };
    const input = createInputCommands({
        state,
        native: {},
        ensureRomLoaded: () => {},
        resumeInput: async () => ({ ok: true }),
        renderHotkey: () => {},
        saveKeymap: () => {},
        setKey: (button, down) => {
            pressed.set(button, down);
            if (down) pressedResolve();
        },
        setTouchState: () => {},
        toButtonList: () => ["A"],
        waitChecked: async () => {},
        waitForInputWindow,
        inputTaskManager
    });
    const holdOutcome = input.runInputHold({ button: "A", durationMs: 600000 })
        .catch((error) => error);
    await becamePressed;
    assert.equal(pressed.get("A"), true);

    const transactions = createFileTransactionService({ state, inputTaskManager });
    await transactions.run("State load", async () => {
        assert.equal(pressed.get("A"), false);
        assert.deepEqual(inputTaskManager.current(), []);
    });
    assert.equal((await holdOutcome).mcpCode, "CANCELLED");
});

test("replay reports skipped verification and resumes for pauseAfter false", async () => {
    const metadata = {
        id: "demo",
        dataKey: "input-recording:data:demo",
        stateKey: null,
        rom: { romName: "game.nds", romSize: 16, romSha256: "rom" },
        cpuState: {
            arm9: { pc: 100, cpsr: 200 },
            arm7: { pc: 300, cpsr: 400 }
        },
        totalFrames: 0
    };
    const store = new Map([
        ["input-recording:meta:demo", metadata],
        [metadata.dataKey, [["i", 0, 0, false, 0, 0]]]
    ]);
    const { service } = createRecordingHarness({ store });
    const result = await service.replay({
        id: "demo",
        verifyStart: false,
        pauseAfter: false
    }, { signal: new AbortController().signal });
    assert.equal(result.ok, true);
    assert.equal(result.pcVerified, null);
    assert.equal(result.verificationSkipped, true);
    assert.equal(result.paused, false);
    assert.equal(result.running, true);
});

test("bootstrap WebMCP list and status calls do not require a runtime loader", async () => {
    const calls = [];
    const bootstrapApi = {
        list: () => ({ status: "runtime-free" }),
        call: async (command, params) => {
            calls.push({ command, params });
            return { ok: true, command };
        }
    };
    const tools = createBootstrapWebMcpTools({
        bootstrapApi,
        webMcpContent: (value) => value,
        parseInput: (value) => value,
        fail: (code, message) => ({ ok: false, error: { code, message } })
    });
    assert.deepEqual(await tools[0].execute({}), { status: "runtime-free" });
    assert.deepEqual(await tools[1].execute({ command: "status", params: {} }), {
        ok: true,
        command: "status"
    });
    assert.deepEqual(calls, [{ command: "status", params: {} }]);
});

test("runtime loader times out, retries, and ignores a late stale attempt", async () => {
    const resolvers = [];
    let currentApi = null;
    const loader = createRuntimeLoader({
        loadRuntime: () => new Promise((resolve) => resolvers.push(resolve)),
        getApi: () => currentApi,
        timeoutMs: 10
    });
    await assert.rejects(loader.ensureLoaded(), /timed out/);
    const retry = loader.ensureLoaded();
    currentApi = { call: () => "stale" };
    resolvers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    currentApi = { call: () => "current" };
    resolvers[1]();
    const api = await retry;
    assert.equal(api.call(), "current");
    assert.deepEqual(loader.status(), {
        loaded: true,
        loading: false,
        attempts: 2,
        error: null
    });
});

test("analysis baseline State load remains paused through PC and CPSR verification", async () => {
    const baseline = {
        slot: "analysis:default",
        stateSize: 1,
        stateSha256: "hash",
        romName: "game.nds",
        romSize: 16,
        romSha256: "rom",
        cpuState: {
            arm9: { pc: 1, cpsr: 2 },
            arm7: { pc: 3, cpsr: 4 }
        },
        running: true,
        paused: false,
        traceEnabled: false,
        skipIrq: false
    };
    let loadMetadata = null;
    const calls = [];
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
        analysisBaselineSlotToken: Symbol("baseline"),
        call: async (name, params) => {
            calls.push(name);
            if (name === "loadState") loadMetadata = getInternalMetadata(params);
            return { ok: true };
        },
        currentRomIdentity: async () => baseline,
        emulatorActivity: () => ({ paused: true, running: false }),
        ensureRomLoaded: () => {},
        fileTransactionService: {
            run: async (reason, task) => task({ token: Symbol(reason) })
        },
        getRegisters: (cpu) => cpu === "arm9"
            ? { pc: 1, cpsr: 2 }
            : { pc: 3, cpsr: 4 },
        idbGet: async () => new Uint8Array([1]),
        native: { pause: () => {} },
        readAnalysisBaseline: () => baseline,
        sha256Hex: async () => "hash",
        snapshotContext: async () => ({ snapshot: true }),
        state: { paused: false, running: true },
        ui: {
            traceToggle: { checked: false },
            tracePrivilegeToggle: { checked: false }
        }
    });
    const result = await commands.restoreAnalysisBaseline();
    assert.equal(result.ok, true);
    assert.equal(loadMetadata.holdPaused, true);
    assert.equal(calls.at(-1), "resume");
});
