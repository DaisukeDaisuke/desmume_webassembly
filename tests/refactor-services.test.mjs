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
