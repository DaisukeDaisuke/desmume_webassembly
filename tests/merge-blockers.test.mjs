import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";

import { normalizeBoundedValue } from "../src/bounded-value.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createDebuggerCoordinator } from "../src/debugger-coordinator.js";
import { createRomService } from "../src/rom-service.js";
import { ResourceLimits } from "../src/resource-limits.js";

function validRom(fill) {
    const bytes = new Uint8Array(0x200);
    bytes.fill(fill);
    return bytes;
}

function createScriptBreakHarness() {
    const messages = [];
    let resumeCount = 0;
    let nativeStatus = { arm9: { pc: 0 }, lastBreak: { hit: false } };
    const state = {
        ready: true,
        running: true,
        paused: false,
        selectedCpu: "arm9",
        frame: 0,
        romGeneration: 7,
        fileTransactionSerial: 3,
        fileTransactionActive: false,
        loadingFile: false,
        nativeBreakSerial: 0,
        currentBreakIdentity: null,
        breakpointsInSync: true,
        explicitPauseSerial: 0,
        lastBreakKey: "",
        breakRefreshKey: "",
        scriptTriggers: [{
            id: 11, scriptId: 5, callbackId: 17,
            type: "dataAbort", cpu: "arm9", address: 0
        }],
        scripts: new Map([[5, {
            running: true,
            worker: { postMessage: (message) => messages.push(message) }
        }]]),
        pendingScriptEvents: new Map(),
        nextScriptEventId: 1,
        nextScriptCallbackToken: 1
    };
    const owners = createBreakpointOwnerStore();
    owners.addOwner({ cpu: "special", type: "dataAbort", address: 0 }, {
        id: 11, origin: "script", scriptId: 5, triggerId: 11
    });
    const native = {
        getStatus: () => nativeStatus,
        pause: (paused) => { if (!paused) resumeCount++; },
        clearBreakStatus: () => {},
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
    const hit = (pc) => {
        nativeStatus = {
            frame: state.frame + 1,
            arm9: { pc },
            lastBreak: { hit: true, cpu: "arm9", kind: 3, address: 0, pc, value: 0 }
        };
        coordinator.syncNativeBreakStatus(nativeStatus);
        return messages.at(-1);
    };
    return { coordinator, state, messages, hit, resumeCount: () => resumeCount };
}

test("persistent callback cannot resume a different native break", async () => {
    const harness = createScriptBreakHarness();
    const first = harness.hit(0x02000000);
    harness.hit(0x02000004);

    assert.equal(await harness.coordinator.finishPersistentScriptEvent(first.eventId, {
        scriptId: 5,
        callbackId: first.callbackId,
        callbackToken: first.callbackToken
    }), true);
    assert.equal(harness.resumeCount(), 0);
    await harness.coordinator.cancelAllPersistentScriptEvents("test cleanup");
});

test("persistent callback cannot resume across a file transaction serial", async () => {
    const harness = createScriptBreakHarness();
    const event = harness.hit(0x02000000);
    harness.state.fileTransactionSerial++;

    await harness.coordinator.finishPersistentScriptEvent(event.eventId, {
        scriptId: 5,
        callbackId: event.callbackId,
        callbackToken: event.callbackToken
    });
    assert.equal(harness.resumeCount(), 0);
    assert.equal(harness.state.pendingScriptEvents.size, 0);
});

test("pending script event overflow is tracked and fails closed", async () => {
    const harness = createScriptBreakHarness();
    for (let id = 100; id < 100 + ResourceLimits.pendingScriptEvents; id++) {
        harness.state.pendingScriptEvents.set(id, { sentinel: true });
    }
    harness.hit(0x02000000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.resumeCount(), 0);
    assert.equal(harness.state.paused, true);
    assert.equal(harness.state.lastScriptError.code, "BUSY");
    assert.equal(harness.state.pendingScriptEvents.size, ResourceLimits.pendingScriptEvents);
});

test("ROM rollback failure preserves the original failure and closes the breakpoint gate", async () => {
    const oldRom = validRom(1);
    const oldSave = new Uint8Array([1, 2, 3]);
    const files = new Map([["rom.nds", oldRom], ["rom.sav", oldSave]]);
    const loadResults = [-5, -6];
    const state = {
        pendingRomCandidate: { name: "candidate.nds", bytes: validRom(2) },
        romName: "old.nds",
        romBytes: oldRom,
        romSize: oldRom.length,
        romGeneration: 4,
        running: true,
        paused: false,
        fileTransactionSerial: 0,
        fileTransactionActive: false,
        nativeBreakSerial: 0,
        breakpointsInSync: true
    };
    const native = {
        fileExists: (path) => files.has(path),
        readFile: (path) => new Uint8Array(files.get(path)),
        writeFile: (path, bytes) => files.set(path, new Uint8Array(bytes)),
        unlinkFile: (path) => files.delete(path),
        isRomLoaded: () => true,
        loadRom: () => loadResults.shift(),
        pause: () => {},
        clearBreakStatus: () => {}
    };
    let cancelled = 0;
    const service = createRomService({
        state,
        native,
        sleep: async () => {},
        blockSaveFlush: () => {},
        drawFrame: () => {},
        cancelPendingScriptEvents: async () => { cancelled++; }
    });

    await assert.rejects(service.reload(), (error) => (
        error.mcpCode === "NATIVE_ERROR"
        && error.mcpDetails?.rollbackFailed === true
        && error.mcpDetails?.nativeCode === -6
        && error.mcpDetails?.breakpointsInSync === false
    ));
    assert.equal(cancelled, 1);
    assert.equal(state.fileTransactionActive, false);
    assert.equal(state.breakpointsInSync, false);
    assert.deepEqual(files.get("rom.nds"), oldRom);
    assert.deepEqual(files.get("rom.sav"), oldSave);
    assert.equal(state.romGeneration, 4);
    assert.equal(state.running, false);
    assert.equal(state.paused, true);
});

test("breakpoint reconciliation clears partial native state before failing", () => {
    const nativeSites = new Set();
    let reconciling = false;
    let failAddress = 2;
    let inSync = true;
    const store = createBreakpointOwnerStore({
        onFirstOwner: (entry) => {
            if (!reconciling) return;
            nativeSites.add(entry.address);
            if (entry.address === failAddress) throw new Error("native registration failed");
        },
        onClearNative: () => nativeSites.clear(),
        onReconcileStart: () => { reconciling = true; inSync = false; },
        onReconcileSuccess: () => { reconciling = false; inSync = true; },
        onReconcileFailure: () => { reconciling = false; inSync = false; }
    });
    store.addOwner({ cpu: "arm9", type: "exec", address: 1 }, { id: 1, origin: "user" });
    store.addOwner({ cpu: "arm9", type: "exec", address: 2 }, { id: 2, origin: "user" });

    assert.throws(() => store.reconcileNativeBreakpoints(), /native registration failed/);
    assert.equal(inSync, false);
    assert.equal(nativeSites.size, 0);

    failAddress = -1;
    assert.deepEqual(store.reconcileNativeBreakpoints(), { cleared: true, registered: 2 });
    assert.equal(inSync, true);
    assert.deepEqual([...nativeSites], [1, 2]);
});

test("special breakpoint reconciliation clears a discarded owner after native disable failure", () => {
    let nativeSpecial = false;
    let failDisable = true;
    let inSync = true;
    const store = createBreakpointOwnerStore({
        onFirstOwner: (entry) => { if (entry.type === "dataAbort") nativeSpecial = true; },
        onLastOwner: (entry) => {
            if (entry.type !== "dataAbort") return;
            if (failDisable) throw new Error("injected native special disable failure");
            nativeSpecial = false;
        },
        onClearNative: () => { nativeSpecial = false; },
        onReconcileStart: () => { inSync = false; },
        onReconcileSuccess: () => { inSync = true; },
        onReconcileFailure: () => { inSync = false; }
    });
    store.addOwner({ cpu: "special", type: "dataAbort", address: 0 }, {
        id: 91, origin: "script", scriptId: 7
    });
    assert.equal(nativeSpecial, true);
    assert.throws(() => store.removeOwner(91), /injected native special disable failure/);
    store.discardOwner(91);
    failDisable = false;
    assert.deepEqual(store.reconcileNativeBreakpoints(), { cleared: true, registered: 0 });
    assert.equal(nativeSpecial, false);
    assert.equal(store.list().length, 0);
    assert.equal(inSync, true);
});

test("structured Worker values reject cycles, exotic objects, and all configured limits", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeBoundedValue({ ok: [1, "two", true] }).value)), { ok: [1, "two", true] });
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => normalizeBoundedValue(cyclic), /cyclic/);
    assert.throws(() => normalizeBoundedValue(new Uint8Array([1])), /binary structured values/);
    assert.throws(() => normalizeBoundedValue([1, 2], { maxArray: 1 }), /item budget/);
    assert.throws(() => normalizeBoundedValue({ a: { b: 1 } }, { maxDepth: 1 }), /depth budget/);
    assert.throws(() => normalizeBoundedValue("four", { maxBytes: 3 }), /byte budget/);
    assert.throws(() => normalizeBoundedValue({ a: 1, b: 2 }, { maxNodes: 2 }), /node budget/);
});

async function bundle(entry, options = {}) {
    const result = await esbuild.build({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true,
        write: false,
        minify: options.minify ?? false,
        platform: "browser",
        format: "iife",
        globalName: options.globalName,
        target: ["chrome120"],
        logLevel: "silent"
    });
    return result.outputFiles[0].text;
}

test("fixed adversarial dependency executes only after the security Worker is locked", async () => {
    const workerSource = await bundle("../src/workers/security-boundary.worker.js");
    const globalName = "__desmumeBoundaryFixture";
    const fixtureSource = `${await bundle("../src/security-fixtures/adversarial-dependency.entry.js", {
        minify: true,
        globalName
    })}\n${globalName}`;
    const dependency = {
        source: fixtureSource,
        sha256: createHash("sha256").update(fixtureSource).digest("hex")
    };
    const messages = [];
    const listeners = new Map();
    let forbiddenCalls = 0;
    const forbidden = () => { forbiddenCalls++; };
    const context = vm.createContext({
        console,
        crypto: { randomUUID: () => "boundary-token", subtle: webcrypto.subtle },
        TextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: forbidden,
        setTimeout: (callback) => {
            if (typeof callback === "string") forbiddenCalls++;
            else callback();
        },
        setInterval: (callback) => {
            if (typeof callback === "string") forbiddenCalls++;
            else callback();
        },
        fetch: forbidden,
        XMLHttpRequest: forbidden,
        WebSocket: forbidden,
        EventSource: forbidden,
        Worker: forbidden,
        SharedWorker: forbidden,
        importScripts: forbidden,
        BroadcastChannel: forbidden,
        WebTransport: forbidden,
        indexedDB: {},
        caches: {},
        localStorage: {},
        sessionStorage: {},
        close: forbidden
    });
    context.self = context;
    vm.runInContext(workerSource, context, { filename: "security-boundary.worker.js" });
    const bootstrap = messages.shift();
    assert.equal(bootstrap.type, "bootstrapReady");
    await listeners.get("message")({
        data: { type: "initialize", channelToken: bootstrap.channelToken, dependency }
    });
    const done = messages.find((message) => message.type === "done");
    assert.equal(done.result.passed, true);
    assert.equal(done.result.fixtureSha256, dependency.sha256);
    assert.ok(Object.values(done.result.preReady).every((value) => value === false));
    assert.equal(forbiddenCalls, 0);
});

test("sandbox boundary self-test uses production supervisors and contains no fixed security success fields", async () => {
    const selfTest = await readFile(new URL("../src/sandbox-boundary-self-test.js", import.meta.url), "utf8");
    const dedicatedWorker = await readFile(new URL("../src/workers/security-boundary.worker.js", import.meta.url), "utf8");
    assert.match(selfTest, /eval-supervisor\.worker\.js/);
    assert.match(selfTest, /eval\.worker\.js/);
    assert.match(selfTest, /pendingRpcBeforeShutdown/);
    assert.match(selfTest, /childWorkerTerminateCalled/);
    assert.match(selfTest, /childBlobUrlRevokeCalled/);
    assert.match(selfTest, /host\.status\(\)/);
    assert.doesNotMatch(`${selfTest}\n${dedicatedWorker}`, /unauthenticatedMessageAccepted:\s*false/);
    assert.doesNotMatch(`${selfTest}\n${dedicatedWorker}`, /tokenPredictionAccepted:\s*false/);
    assert.doesNotMatch(`${selfTest}\n${dedicatedWorker}`, /listenersAfter:\s*0/);
});

test("automation security context preserves its boundary within the accessibility byte budget", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const note = html.match(/<aside class="automation-security-context"[^>]*>\s*([\s\S]*?)\s*<\/aside>/)?.[1] || "";
    const bytes = Buffer.byteLength(note, "utf8");
    assert.ok(bytes >= 1200 && bytes <= 1500, `security context byte length: ${bytes}`);
    for (const expected of [
        "NDS, Save, and State", "local emulation, debugging, and reverse engineering",
        "No external CDN executable code", "Exact-version Acorn and SSIM", "fixed hashes",
        "browser-native modelContext", "cross-origin or opaque-origin", "supervisor and sandbox Workers",
        "raw-memory reads", "disassembly", "Ghidra-style", "large code analysis",
        "full or near-full ROM", "repeated, periodic, or chunked exfiltration", "evaluate_script",
        "window.DesmumeMCP", "window.memory", "one-character shortcuts"
    ]) assert.match(note, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("persistent supervisor bounds queued non-tick events and terminates on overflow", async () => {
    const source = await bundle("../src/workers/persistent-script-supervisor.worker.js");
    const messages = [];
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
        TextEncoder,
        Blob: class Blob {},
        Worker: FakeWorker,
        URL: { createObjectURL: () => "blob:bounded", revokeObjectURL: () => {} }
    });
    context.onmessage = null;
    vm.runInContext(source, context, { filename: "persistent-script-supervisor.worker.js" });
    const dependency = { source: "fixed", sha256: "fixed-hash" };
    context.onmessage({ data: {
        type: "start", code: "return 1", sandboxSource: "sandbox", dependency, shortcuts: []
    } });
    const child = workers[0];
    child.onmessage({ data: {
        type: "ready", hardened: true, layer: "sandbox",
        channelToken: "queue-token", dependencyHash: dependency.sha256
    } });

    for (let id = 1; id <= ResourceLimits.persistentEventQueue + 2; id++) {
        context.onmessage({ data: {
            type: "event", event: "exec", eventId: id,
            callbackId: id, callbackToken: `token-${id}`, payload: {}
        } });
    }
    assert.equal(child.terminated, true);
    assert.ok(messages.some((message) => (
        message.type === "failed"
        && message.phase === "resource"
        && message.error?.message.includes(String(ResourceLimits.persistentEventQueue))
    )));
});

test("native source contracts preserve allocation, frame, dump, and pthread failure semantics", async () => {
    const wasm = await readFile(new URL("../webassembly/wasm-port.cpp", import.meta.url), "utf8");
    const support = await readFile(new URL("../webassembly/support.c", import.meta.url), "utf8");
    assert.match(wasm, /prepareRomStorage\(romBuffer, romBufferCap, romLen, rl,/);
    assert.match(wasm, /if \(!romLoaded\) return -1;\s*if \(paused\) return 1;/);
    assert.match(wasm, /if \(result > 0\) break;\s*ran\+\+;/);
    assert.match(wasm, /!uint32RangeFits\(addr, \(size_t\)len\)/);
    assert.match(support, /pthread_attr_setschedpolicy[\s\S]*return ENOTSUP;/);
    assert.match(support, /pthread_setname_np[\s\S]*return ENOTSUP;/);
});

test("native runtime contracts execute failure and reset transitions", {
    skip: process.platform === "win32"
}, () => {
    const directory = mkdtempSync(join(tmpdir(), "desmume-native-contract-"));
    const executable = join(directory, "native-runtime-harness");
    try {
        execFileSync("c++", [
            "-std=c++17", "-Wall", "-Wextra", "-pedantic",
            fileURLToPath(new URL("./native-runtime-harness.cpp", import.meta.url)),
            fileURLToPath(new URL("../webassembly/support.c", import.meta.url)),
            "-pthread", "-o", executable
        ], { stdio: "pipe" });
        execFileSync(executable, [], { stdio: "pipe" });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
