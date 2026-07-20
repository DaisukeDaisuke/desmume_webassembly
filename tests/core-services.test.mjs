import test from "node:test";
import assert from "node:assert/strict";
import { createMcpResponder } from "../src/mcp-responder.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createBreakpointService } from "../src/breakpoint-service.js";
import { createScriptPauseService } from "../src/script-pause-service.js";
import { createNativeBridge } from "../src/native-bridge.js";
import { compareFramePixels } from "../src/frame-diff/index.js";

test("responder returns normal errors", async () => {
  const responder = createMcpResponder({ logger: {} });
  const result = await responder.runSafely("missing", () => { throw new Error("ROM is not loaded"); });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ROM_NOT_LOADED");
});

test("responder normalizes malformed failure results", () => {
  const responder = createMcpResponder({ logger: {} });
  const result = responder.normalizeResult({ ok: false, reason: "missing error" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
  assert.doesNotThrow(() => responder.formatCompact({ ok: false }));
});

test("native result codes distinguish operation errors from faults", () => {
  let faults = 0;
  const bridge = createNativeBridge({
    state: { selectedCpu: "arm9" },
    onFault: () => { faults++; }
  });
  const expected = new Map([
    [-1, "ROM_NOT_LOADED"],
    [-2, "INVALID_ARGUMENT"],
    [-3, "STATE_INVALID"],
    [-4, "BUFFER_TOO_SMALL"]
  ]);
  for (const [nativeCode, errorCode] of expected) {
    assert.throws(
      () => bridge.checkResult(nativeCode, "test"),
      (error) => error.mcpCode === errorCode && error.mcpDetails.nativeCode === nativeCode
    );
  }
  assert.equal(faults, 0);
  assert.throws(() => bridge.checkResult(-99, "test"), (error) => error.mcpCode === "NATIVE_ERROR");
  assert.throws(() => bridge.checkResult(-123, "test"), (error) => error.mcpCode === "NATIVE_FAULT");
  assert.equal(faults, 2);
});

test("event waits reject immediately for pre-aborted signals", async () => {
  const controller = new AbortController();
  controller.abort();
  const owners = createBreakpointOwnerStore();
  const breakpoints = createBreakpointService({ ownerStore: owners });
  const scriptPauses = createScriptPauseService();
  await assert.rejects(breakpoints.waitForEvent({ signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(scriptPauses.waitForEvent({ signal: controller.signal }), { name: "AbortError" });
});

test("breakpoint owners preserve mixed sites", () => {
  let adds = 0;
  let removes = 0;
  const store = createBreakpointOwnerStore({ onFirstOwner: () => adds++, onLastOwner: () => removes++ });
  const site = { cpu: "arm9", type: "exec", address: 0x02000000 };
  store.addOwner(site, { id: 1, origin: "user" });
  store.addOwner(site, { id: 2, origin: "script" });
  assert.equal(store.classifySite(site).mixed, true);
  store.removeOwner(2);
  assert.equal(removes, 0);
  store.removeOwner(1);
  assert.equal(adds, 1);
  assert.equal(removes, 1);
});

test("frame algorithms use the supplied fixed baseline", async () => {
  const width = 256;
  const height = 384;
  const baseline = new Uint32Array(width * height);
  const changed = new Uint32Array(baseline);
  changed.fill(0x00ffffff, 0, Math.floor(changed.length * 0.2));
  const result = await compareFramePixels({ baseline, current: changed, width, height, algorithm: "px", options: { tolerance: 8 } });
  assert.ok(result.pct > 19 && result.pct < 21);
  const restored = await compareFramePixels({ baseline, current: new Uint32Array(baseline), width, height, algorithm: "px" });
  assert.equal(restored.pct, 0);
});
