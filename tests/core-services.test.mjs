import test from "node:test";
import assert from "node:assert/strict";
import { createMcpResponder } from "../src/mcp-responder.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { compareFramePixels } from "../src/frame-diff/index.js";

test("responder returns normal errors", async () => {
  const responder = createMcpResponder({ logger: {} });
  const result = await responder.runSafely("missing", () => { throw new Error("ROM is not loaded"); });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ROM_NOT_LOADED");
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
