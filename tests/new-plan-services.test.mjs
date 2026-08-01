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
import { bindScreenTouch } from "../src/ui/ui-controller.js";
import { createEmulationLoop } from "../src/emulation-loop.js";

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

function createRecordingHarness({
    store,
    failMetadataWrite = () => false,
    cancelInputTasksForOperation = async () => false,
    subscribeInputMutations = () => () => {},
    getInputSnapshot = () => ({ keyMask: 0, touchActive: false, x: 0, y: 0 }),
    releaseInput = () => {},
    getFrame = () => 10,
    frameService = { subscribe: () => () => {} },
    waitForInputWindow = async () => {}
} = {}) {
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
        frameService,
        pauseEventService: createPauseEventService(),
        fileTransactionEventService: createSerialEventService(),
        subscribeInputMutations,
        getInputSnapshot,
        applyInputSnapshot: () => {},
        releaseInput,
        getFrame,
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
        waitForInputWindow,
        cancelInputTasksForOperation
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

test("recording waits for operation-owned input tasks before returning success", async () => {
    const store = new Map();
    let releaseCancellation;
    let cancellationSettled = false;
    const cancellation = new Promise((resolve) => {
        releaseCancellation = () => {
            cancellationSettled = true;
            resolve();
        };
    });
    const { service } = createRecordingHarness({
        store,
        cancelInputTasksForOperation: async () => cancellation
    });
    const recording = service.record(
        { id: "settlement", durationMs: 1 },
        { signal: new AbortController().signal }
    );
    await new Promise((resolve) => setImmediate(resolve));
    let returned = false;
    recording.then(() => { returned = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    releaseCancellation();
    assert.equal((await recording).ok, true);
    assert.equal(cancellationSettled, true);
});

test("recording fixes its frame boundary before task settlement and appends final neutral input", async () => {
    const store = new Map();
    let frame = 100;
    let snapshot = { keyMask: 0, touchActive: false, x: 0, y: 0 };
    let publishMutation = () => {};
    const { service } = createRecordingHarness({
        store,
        getFrame: () => frame,
        getInputSnapshot: () => snapshot,
        subscribeInputMutations: (listener) => {
            publishMutation = listener;
            return () => { publishMutation = () => {}; };
        },
        frameService: {
            subscribe: (listener) => {
                queueMicrotask(() => {
                    frame = 700;
                    snapshot = { keyMask: 1, touchActive: false, x: 0, y: 0 };
                    publishMutation(snapshot);
                    listener();
                });
                return () => {};
            }
        },
        cancelInputTasksForOperation: async () => {
            frame = 704;
        },
        releaseInput: () => {
            snapshot = { keyMask: 0, touchActive: false, x: 0, y: 0 };
        }
    });
    const result = await service.record(
        { id: "fixed-boundary", frames: 600 },
        { signal: new AbortController().signal }
    );
    const events = store.get(result.dataKey);
    assert.equal(result.ok, true);
    assert.equal(result.totalFrames, 600);
    assert.deepEqual(events.at(-2), ["i", 600, 1, false, 0, 0]);
    assert.deepEqual(events.at(-1), ["i", 600, 0, false, 0, 0]);
});

test("frame recording limits a four-frame native batch to the exact three-frame boundary", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    try {
        const store = new Map();
        let frameListener = () => {};
        let snapshot = { keyMask: 1, touchActive: false, x: 0, y: 0 };
        const frameService = {
            subscribe(listener) {
                frameListener = listener;
                return () => { frameListener = () => {}; };
            },
            onFrameCompleted(frame) {
                frameListener({ frame });
            },
            isValid: () => false
        };
        const state = {
            ready: true,
            running: true,
            paused: false,
            loadingFile: false,
            lastTick: 1000,
            frameBudget: 4,
            frame: 100,
            speed: 4,
            render: false,
            audio: false,
            freezes: [],
            touch: { active: false },
            keys: 0,
            selectedCpu: "arm9",
            framesSinceStateLoad: 0,
            completedFrameSerial: 0
        };
        let nativeBatch = 0;
        let arm9Pc = 0x02001000;
        const { service } = createRecordingHarness({
            store,
            frameService,
            getFrame: () => state.frame,
            getInputSnapshot: () => snapshot,
            releaseInput: () => {
                snapshot = { keyMask: 0, touchActive: false, x: 0, y: 0 };
            }
        });
        const loop = createEmulationLoop({
            state,
            ui: {},
            frameService,
            native: {
                runFrames(count) {
                    nativeBatch = count;
                    state.frame += count;
                    arm9Pc += count * 4;
                    return count;
                },
                pause: () => {}
            },
            handleNativeFault: () => {},
            syncNativeBreakStatus: () => ({}),
            dispatchScriptEvent: () => {},
            limitFrameBatch: service.limitFrameBatch,
            updateStatus: () => {}
        });
        const recording = service.record(
            { id: "three-frames", frames: 3 },
            { signal: new AbortController().signal }
        );
        await new Promise((resolve) => setImmediate(resolve));
        loop.tick(1017);
        const result = await recording;
        const events = store.get(result.dataKey);

        assert.equal(nativeBatch, 3);
        assert.equal(result.totalFrames, 3);
        assert.equal(state.frame, 103);
        assert.equal(arm9Pc, 0x0200100c);
        assert.deepEqual(events.at(-1), ["i", 3, 0, false, 0, 0]);
    } finally {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
});

test("realtime emulation drops stale work instead of draining it after a speed change", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    try {
        const batches = [];
        const state = {
            ready: true,
            running: true,
            paused: false,
            loadingFile: false,
            lastTick: 1000,
            frameBudget: 100,
            frame: 0,
            speed: 4,
            render: false,
            audio: false,
            freezes: [],
            touch: { active: false },
            keys: 0,
            selectedCpu: "arm9",
            framesSinceStateLoad: 0,
            completedFrameSerial: 0,
            fpsSampleTime: 1000,
            fpsSampleFrame: 0,
            effectiveFps: 0
        };
        const loop = createEmulationLoop({
            state,
            ui: {},
            frameService: { isValid: () => false, onFrameCompleted: () => {} },
            native: {
                runFrames(count) {
                    batches.push(count);
                    state.frame += count;
                    return count;
                },
                pause: () => {}
            },
            handleNativeFault: () => {},
            syncNativeBreakStatus: () => ({}),
            dispatchScriptEvent: () => {},
            updateStatus: () => {}
        });

        loop.tick(1250);
        state.speed = 1;
        state.frameBudget = 100;
        loop.tick(1267);

        assert.deepEqual(batches, [4, 1]);
        assert.ok(state.frameBudget >= 0 && state.frameBudget < 1);
    } finally {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
});

test("realtime emulation targets DS 60fps multiples without exceeding each tick batch", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    try {
        const runOneSecond = (speed) => {
            const batches = [];
            const state = {
                ready: true,
                running: true,
                paused: false,
                loadingFile: false,
                lastTick: 0,
                frameBudget: 0,
                frame: 0,
                speed,
                render: false,
                audio: false,
                freezes: [],
                touch: { active: false },
                keys: 0,
                selectedCpu: "arm9",
                framesSinceStateLoad: 0,
                completedFrameSerial: 0,
                fpsSampleTime: 0,
                fpsSampleFrame: 0,
                effectiveFps: 0
            };
            const loop = createEmulationLoop({
                state,
                ui: {},
                frameService: { isValid: () => false, onFrameCompleted: () => {} },
                native: {
                    runFrames(count) {
                        batches.push(count);
                        state.frame += count;
                        return count;
                    },
                    pause: () => {}
                },
                handleNativeFault: () => {},
                syncNativeBreakStatus: () => ({}),
                dispatchScriptEvent: () => {},
                updateStatus: () => {}
            });
            for (let tick = 1; tick <= 60; tick++) loop.tick(tick * 1000 / 60);
            return { batches, state };
        };

        const normal = runOneSecond(1);
        const double = runOneSecond(2);
        const quadruple = runOneSecond(4);
        assert.equal(normal.state.frame, 59);
        assert.equal(double.state.frame, 119);
        assert.equal(quadruple.state.frame, 239);
        assert.ok(normal.batches.every((frames) => frames <= 1));
        assert.ok(double.batches.every((frames) => frames <= 2));
        assert.ok(quadruple.batches.every((frames) => frames <= 4));
    } finally {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
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

test("parent input cancellation prevents delayed presses and waits for settlement", async () => {
    const manager = createInputTaskManager();
    const parent = new AbortController();
    let pressed = false;
    let settled = false;
    let markTaskStarted;
    const taskStarted = new Promise((resolve) => { markTaskStarted = resolve; });
    const task = manager.run("runInputHold", async (signal) => {
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                pressed = true;
                resolve();
            }, 50);
            markTaskStarted();
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                setTimeout(() => {
                    settled = true;
                    resolve();
                }, 5);
            }, { once: true });
        });
    }, parent.signal).catch((error) => error);
    await taskStarted;
    assert.equal(await manager.cancelAndWaitForParent(parent.signal, "recording-ended"), true);
    assert.equal(settled, true);
    assert.equal(pressed, false);
    await task;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pressed, false);
});

test("screen pointer release paths use the central touch mutation", () => {
    const listeners = new Map();
    const releases = [];
    bindScreenTouch({
        screenShell: {
            addEventListener: (name, listener) => listeners.set(name, listener),
            setPointerCapture: () => {}
        },
        state: { touch: { active: true } },
        updateTouch: () => {},
        setTouchState: (...args) => releases.push(args)
    });
    listeners.get("pointerup")();
    listeners.get("pointercancel")();
    listeners.get("lostpointercapture")();
    listeners.get("pointerleave")();
    assert.deepEqual(releases, [
        [false, 0, 0],
        [false, 0, 0],
        [false, 0, 0],
        [false, 0, 0]
    ]);
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

test("bootstrap WebMCP distinguishes parse failures from command failures", async () => {
    const stableError = new Error("IndexedDB unavailable");
    stableError.mcpCode = "STATE_NOT_LOADED";
    stableError.mcpDetails = { storage: "states" };
    const tools = createBootstrapWebMcpTools({
        bootstrapApi: {
            list: () => ({}),
            call: async (command) => {
                if (command === "stable") throw stableError;
                throw new Error("unexpected failure");
            }
        },
        webMcpContent: (value) => value,
        parseInput: (value) => JSON.parse(value),
        fail: (code, message, details) => ({ ok: false, error: { code, message, details } })
    });
    assert.equal((await tools[1].execute("{")).error.code, "INVALID_ARGUMENT");
    const stable = await tools[1].execute('{"command":"stable"}');
    assert.deepEqual(stable.error, {
        code: "STATE_NOT_LOADED",
        message: "IndexedDB unavailable",
        details: { storage: "states" }
    });
    const internal = await tools[1].execute('{"command":"internal"}');
    assert.equal(internal.error.code, "INTERNAL_ERROR");
    assert.equal(internal.error.message, "WebMCP command failed internally");
});

test("runtime loader times out, retries with a new attempt, and never initializes the stale module", async () => {
    const resolvers = [];
    const requestedAttempts = [];
    const initializedAttempts = [];
    const loader = createRuntimeLoader({
        loadRuntime: (attempt) => {
            requestedAttempts.push(attempt);
            return new Promise((resolve) => resolvers.push(resolve));
        },
        initializeRuntime: (module, attempt) => {
            initializedAttempts.push(attempt);
            return module.initializeEmulatorRuntime();
        },
        getApi: () => null,
        timeoutMs: 10
    });
    await assert.rejects(loader.ensureLoaded(), /timed out/);
    const retry = loader.ensureLoaded();
    resolvers[0]({ initializeEmulatorRuntime: () => ({ call: () => "stale" }) });
    await new Promise((resolve) => setImmediate(resolve));
    resolvers[1]({ initializeEmulatorRuntime: () => ({ call: () => "current" }) });
    const api = await retry;
    assert.equal(api.call(), "current");
    assert.deepEqual(requestedAttempts, [1, 2]);
    assert.deepEqual(initializedAttempts, [2]);
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
        skipIrq: false,
        persistentScripts: [{ name: "watch", codeSha256: "a".repeat(64), value: { counter: 7 } }]
    };
    let loadMetadata = null;
    const calls = [];
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
        analysisBaselineSlotToken: Symbol("baseline"),
        validateAnalysisBaselineScriptState: async (entries) => {
            assert.equal(entries, baseline.persistentScripts);
            calls.push("validatePersistentScripts");
        },
        restoreAnalysisBaselineScriptState: async (name, entries) => {
            assert.equal(name, "default");
            assert.equal(entries, baseline.persistentScripts);
            calls.push("restorePersistentScripts");
        },
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
    assert.ok(calls.indexOf("validatePersistentScripts") < calls.indexOf("loadState"));
    assert.ok(calls.indexOf("loadState") < calls.indexOf("restorePersistentScripts"));
    assert.equal(calls.at(-1), "resume");
});

test("analysis baseline replacement switches metadata before deleting the old State", async () => {
    const oldBaseline = { slot: "analysis:old", name: "default" };
    const store = new Map([["analysis:old", new Uint8Array([1])]]);
    let metadata = oldBaseline;
    let failMetadata = true;
    const saveOrder = [];
    const persistentScripts = [{ name: "watch", codeSha256: "b".repeat(64), value: null }];
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
        captureAnalysisBaselineScriptState: async () => {
            saveOrder.push("script");
            return persistentScripts;
        },
        currentRomIdentity: async () => ({
            romName: "game.nds",
            romSize: 16,
            romSha256: "rom"
        }),
        emulatorActivity: () => ({ paused: true, running: false }),
        ensureRomLoaded: () => {},
        getRegisters: (cpu) => cpu === "arm9"
            ? { pc: 1, cpsr: 2 }
            : { pc: 3, cpsr: 4 },
        idbDelete: async (key) => { store.delete(key); },
        idbPut: async (key, value) => { store.set(key, value); },
        native: { saveStateBytes: () => {
            saveOrder.push("state");
            return new Uint8Array([9, 9]);
        } },
        readAnalysisBaseline: () => metadata,
        sha256Hex: async () => "new-hash",
        state: { romGeneration: 1 },
        ui: {
            traceToggle: { checked: false },
            tracePrivilegeToggle: { checked: false }
        },
        writeAnalysisBaseline: (name, baseline) => {
            if (failMetadata) throw new Error("metadata write failed");
            assert.equal(store.has("analysis:old"), true);
            metadata = baseline;
        }
    });
    await assert.rejects(
        commands.saveAnalysisBaseline({ replace: true }),
        /metadata write failed/
    );
    assert.equal(metadata, oldBaseline);
    assert.deepEqual([...store.keys()], ["analysis:old"]);

    failMetadata = false;
    const result = await commands.saveAnalysisBaseline({ replace: true });
    assert.equal(result.ok, true);
    assert.notEqual(metadata.slot, "analysis:old");
    assert.equal(metadata.persistentScripts, persistentScripts);
    assert.deepEqual(saveOrder.slice(-2), ["script", "state"]);
    assert.equal(store.has(metadata.slot), true);
    assert.equal(store.has("analysis:old"), false);
});

test("parallel same-name baseline saves serialize and failed cleanup preserves the committed State", async () => {
    const store = new Map();
    const attemptedSlots = [];
    let metadata = null;
    let metadataWrites = 0;
    let releaseFirstPut;
    const firstPutBlocked = new Promise((resolve) => {
        releaseFirstPut = resolve;
    });
    let firstPutStarted;
    const firstPutReady = new Promise((resolve) => {
        firstPutStarted = resolve;
    });
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
        currentRomIdentity: async () => ({
            romName: "game.nds",
            romSize: 16,
            romSha256: "rom"
        }),
        emulatorActivity: () => ({ paused: true, running: false }),
        ensureRomLoaded: () => {},
        getRegisters: (cpu) => cpu === "arm9"
            ? { pc: 1, cpsr: 2 }
            : { pc: 3, cpsr: 4 },
        idbDelete: async (key) => { store.delete(key); },
        idbPut: async (key, value) => {
            attemptedSlots.push(key);
            if (attemptedSlots.length === 1) {
                firstPutStarted();
                await firstPutBlocked;
            }
            store.set(key, value);
        },
        native: { saveStateBytes: () => new Uint8Array([9, 9]) },
        readAnalysisBaseline: () => metadata,
        sha256Hex: async () => "new-hash",
        state: { romGeneration: 1 },
        ui: {
            traceToggle: { checked: false },
            tracePrivilegeToggle: { checked: false }
        },
        writeAnalysisBaseline: (name, baseline) => {
            metadataWrites++;
            if (metadataWrites === 2) throw new Error("metadata write failed");
            metadata = baseline;
        }
    });
    const first = commands.saveAnalysisBaseline({ name: "default", replace: true });
    await firstPutReady;
    const second = commands.saveAnalysisBaseline({ name: "default", replace: true });
    releaseFirstPut();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.match(results[1].reason.message, /metadata write failed/);
    assert.equal(new Set(attemptedSlots).size, 2);
    assert.equal(store.has(metadata.slot), true);
    assert.deepEqual([...store.keys()], [metadata.slot]);
});

test("same-name baseline delete and save serialize without removing the new metadata or State", async () => {
    const oldLocalStorage = globalThis.localStorage;
    const oldBaseline = { name: "default", slot: "analysis:old" };
    const store = new Map([[oldBaseline.slot, new Uint8Array([1])]]);
    const baselines = new Map([["default", oldBaseline]]);
    let metadata = oldBaseline;
    let releaseDelete;
    const deleteBlocked = new Promise((resolve) => { releaseDelete = resolve; });
    let deleteStarted;
    const deleteReady = new Promise((resolve) => { deleteStarted = resolve; });
    let saveCommitted = false;
    globalThis.localStorage = {
        removeItem(key) {
            if (key === "analysis-baseline:default") metadata = null;
        }
    };
    try {
        const commands = createContextCommands({
            ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
            currentRomIdentity: async () => ({
                romName: "game.nds",
                romSize: 16,
                romSha256: "rom"
            }),
            emulatorActivity: () => ({ paused: true, running: false }),
            ensureRomLoaded: () => {},
            getRegisters: (cpu) => cpu === "arm9"
                ? { pc: 1, cpsr: 2 }
                : { pc: 3, cpsr: 4 },
            idbDelete: async (key) => {
                if (key === oldBaseline.slot) {
                    deleteStarted();
                    await deleteBlocked;
                }
                store.delete(key);
            },
            idbPut: async (key, value) => { store.set(key, value); },
            native: { saveStateBytes: () => new Uint8Array([9, 9]) },
            readAnalysisBaseline: () => metadata,
            sha256Hex: async () => "new-hash",
            state: { romGeneration: 1, analysisBaselines: baselines },
            ui: {
                traceToggle: { checked: false },
                tracePrivilegeToggle: { checked: false }
            },
            writeAnalysisBaseline: (name, baseline) => {
                saveCommitted = true;
                metadata = baseline;
                baselines.set(name, baseline);
            }
        });
        const deleting = commands.deleteAnalysisBaseline({ name: "default" });
        await deleteReady;
        const saving = commands.saveAnalysisBaseline({ name: "default", replace: true });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(saveCommitted, false);
        releaseDelete();
        const [deleteResult, saveResult] = await Promise.all([deleting, saving]);

        assert.equal(deleteResult.ok, true);
        assert.equal(saveResult.ok, true);
        assert.equal(metadata.slot, saveResult.slot);
        assert.equal(store.has(metadata.slot), true);
        assert.deepEqual([...store.keys()], [metadata.slot]);
    } finally {
        if (oldLocalStorage === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = oldLocalStorage;
    }
});
