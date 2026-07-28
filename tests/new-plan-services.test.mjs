import test from "node:test";
import assert from "node:assert/strict";

import { createMcpResponder } from "../src/mcp-responder.js";
import { createPauseEventService } from "../src/pause-event-service.js";
import { createOrderedFrameDrain } from "../src/ordered-frame-drain.js";
import { createInputSequenceService } from "../src/input-service.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { applyScreenLayout } from "../src/ui/screen-layout.js";

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
