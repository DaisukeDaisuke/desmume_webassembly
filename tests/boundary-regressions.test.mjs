import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { createHash, webcrypto } from "node:crypto";
import { createMcpResponder } from "../src/mcp-responder.js";
import { createOperationManager } from "../src/operation-manager.js";
import { createInputSequenceService } from "../src/input-service.js";
import { createRuntimeCommands } from "../src/commands/runtime-commands.js";
import { createInputCommands } from "../src/commands/input-commands.js";
import { createStateCommands } from "../src/commands/state-commands.js";
import { createStateService } from "../src/state-service.js";
import { createSaveCommands } from "../src/commands/save-commands.js";
import { createScreenshotCommands } from "../src/commands/screenshot-commands.js";
import { createViewService } from "../src/ui/view-service.js";
import { createEmulationLoop } from "../src/emulation-loop.js";
import { createCommandDispatcher } from "../src/command-dispatcher.js";
import { createCommandRegistry } from "../src/command-registry.js";
import { createBreakpointOwnerStore } from "../src/breakpoint-owner-store.js";
import { createDebuggerCoordinator } from "../src/debugger-coordinator.js";
import { createDebuggerService } from "../src/debugger-service.js";
import { registerWebMcp } from "../src/webmcp.js";
import { unwrapLegacyScalar } from "../src/legacy-scalar.js";
import { withInternalMetadata } from "../src/internal-command-metadata.js";
import { createScreenInvalidNotice, SCREEN_INVALID_NOTICE } from "../src/screen-invalid-notice.js";
import { createScriptCommands } from "../src/commands/script-commands.js";
import { createContextCommands } from "../src/commands/context-commands.js";
import { validateWorkerRpc } from "../src/script-rpc-policy.js";
import {
    normalizePersistentBaselineData,
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult,
    normalizeWorkerRpcParams,
    normalizeWorkerTrigger
} from "../src/worker-rpc-payload.js";
import { normalizeBoundedValue } from "../src/bounded-value.js";
import { createBinaryTools } from "../src/binary-tools.js";

const responder = createMcpResponder({ logger: {} });
const FRAMEBUFFER_BYTES = 256 * 384 * 4;
const workerBundles = new Map();
const dependencyBundles = new Map();
let scriptServiceModulePromise = null;

async function bundledWorkerSource(relativeUrl) {
    const entryPoint = fileURLToPath(new URL(relativeUrl, import.meta.url));
    if (!workerBundles.has(entryPoint)) {
        const result = await esbuild.build({
            entryPoints: [entryPoint], bundle: true, write: false, minify: false,
            platform: "browser", format: "iife", target: ["chrome120"], logLevel: "silent"
        });
        workerBundles.set(entryPoint, result.outputFiles[0].text);
    }
    return workerBundles.get(entryPoint);
}

async function bundledDependency(relativeUrl, globalName) {
    const entryPoint = fileURLToPath(new URL(relativeUrl, import.meta.url));
    const key = `${entryPoint}:${globalName}`;
    if (!dependencyBundles.has(key)) {
        const result = await esbuild.build({
            entryPoints: [entryPoint], bundle: true, write: false, minify: true,
            platform: "browser", format: "iife", globalName, target: ["chrome120"], logLevel: "silent"
        });
        const source = `${result.outputFiles[0].text}\n${globalName}`;
        dependencyBundles.set(key, { source, sha256: createHash("sha256").update(source).digest("hex") });
    }
    return dependencyBundles.get(key);
}

function testCrypto() {
    return { randomUUID: () => "sandbox-token", subtle: webcrypto.subtle };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value))
    };
}

async function runEvalSandbox(code) {
    const source = await bundledWorkerSource("../src/workers/eval.worker.js");
    const messages = [];
    const listeners = new Map();
    let networkCalls = 0;
    let storageCalls = 0;
    const ContextTextEncoder = class extends TextEncoder {};
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder: ContextTextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {},
        setTimeout: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        setInterval: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        fetch: () => { networkCalls++; return Promise.resolve({ ok: true }); },
        XMLHttpRequest: function XMLHttpRequest() { networkCalls++; },
        WebSocket: function WebSocket() { networkCalls++; },
        EventSource: function EventSource() { networkCalls++; },
        Worker: function Worker() { networkCalls++; },
        SharedWorker: function SharedWorker() { networkCalls++; },
        importScripts: () => { networkCalls++; },
        close: () => { networkCalls++; },
        BroadcastChannel: function BroadcastChannel() { networkCalls++; },
        WebTransport: function WebTransport() { networkCalls++; },
        indexedDB: {},
        caches: {},
        localStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        },
        sessionStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        }
    });
    context.self = context;
    vm.runInContext(source, context, { filename: "eval.worker.js" });
    const dependency = await bundledDependency("../src/dependencies/acorn.entry.js", "__desmumeAcorn");
    await listeners.get("message")({ data: { type: "initialize", dependency } });
    await listeners.get("message")({ data: { type: "run", code, shortcuts: [] } });
    return { messages, networkCalls, storageCalls };
}

async function runAlgorithmSandbox() {
    const source = await bundledWorkerSource("../src/workers/algorithm.worker.js");
    const messages = [];
    const listeners = new Map();
    let networkCalls = 0;
    let storageCalls = 0;
    const networkCapability = () => { networkCalls++; };
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {},
        setTimeout: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        setInterval: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        fetch: networkCapability,
        XMLHttpRequest: function XMLHttpRequest() { networkCalls++; },
        WebSocket: function WebSocket() { networkCalls++; },
        EventSource: function EventSource() { networkCalls++; },
        Worker: function Worker() { networkCalls++; },
        SharedWorker: function SharedWorker() { networkCalls++; },
        importScripts: networkCapability,
        close: networkCapability,
        BroadcastChannel: function BroadcastChannel() { networkCalls++; },
        WebTransport: function WebTransport() { networkCalls++; },
        indexedDB: {},
        caches: {},
        localStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        },
        sessionStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        },
        navigator: {}
    });
    context.self = context;
    vm.runInContext(source, context, { filename: "algorithm.worker.js" });
    const dependency = await bundledDependency("../src/dependencies/ssim.entry.js", "__desmumeSsim");
    const token = messages[0].channelToken;
    await listeners.get("message")({ data: { type: "initialize", dependency } });
    await listeners.get("message")({
        data: {
            type: "compare",
            channelToken: token,
            width: 16,
            screen: "top",
            region: [0, 0, 16, 16],
            baseline: new Uint32Array(16 * 192),
            current: new Uint32Array(16 * 192)
        }
    });
    return { messages, networkCalls, storageCalls };
}

test("input sequence rejects pause by default and awaits explicit manual resume", async () => {
    const state = { ready: true, paused: true, running: false, explicitPauseSerial: 0 };
    const native = { pause: () => {}, clearBreakStatus: () => {} };
    let pauseKind = "manual";
    let manager;
    const commands = createRuntimeCommands({
        cancelOperation: (reason) => manager.cancel(reason),
        ensureReady: () => {},
        hasLoadedRom: () => true,
        native,
        state,
        updateStatus: () => {},
        onScreenValid: () => {}
    });
    const input = createInputSequenceService({
        responder,
        press: () => {},
        releaseAll: () => {},
        touch: () => {},
        stepFrames: async () => {},
        getPauseDetails: () => ({
            paused: state.paused,
            running: state.running,
            pauseKind
        }),
        resume: () => commands.resume(withInternalMetadata({}, { operation: true })),
        storage: memoryStorage()
    });
    manager = createOperationManager({ responder });

    const rejected = await manager.run({
        name: "runInputSequence",
        timeoutMs: 1000,
        task: (operation) => input.run({ seq: [["w", 0]] }, operation)
    });
    assert.equal(rejected.error.code, "INPUT_UNAVAILABLE");
    assert.equal(state.paused, true);

    pauseKind = "executeBreakpoint";
    const breakpointRejected = await manager.run({
        name: "runInputSequence",
        timeoutMs: 1000,
        task: (operation) => input.run({ seq: [["w", 0]], resume: true }, operation)
    });
    assert.equal(breakpointRejected.error.code, "INPUT_UNAVAILABLE");
    assert.equal(state.paused, true);

    pauseKind = "manual";
    const result = await manager.run({
        name: "runInputSequence",
        timeoutMs: 1000,
        task: (operation) => input.run({ seq: [["w", 0]], resume: true }, operation)
    });
    assert.equal(result.ok, true);
    assert.equal(state.paused, false);
    assert.equal(state.running, true);
    assert.equal(manager.current(), null);
});

test("input sequence rejects frame-step pauses, stops later mutations, and releases held buttons", async () => {
    const breakCases = [
        ["manual", null],
        ["executeBreakpoint", "exec"],
        ["memoryBreakpoint", "read"],
        ["memoryBreakpoint", "write"],
        ["specialBreakpoint", "dataAbort"],
        ["specialBreakpoint", "prefetchAbort"],
        ["specialBreakpoint", "undefinedInstruction"]
    ];
    const createHarness = ({ pauseKind = "executeBreakpoint", breakType = "exec", incompleteOnly = false } = {}) => {
        let pauseDetails = { paused: false, running: true, pauseKind: "manual" };
        let stepCalls = 0;
        const inputEvents = [];
        const input = createInputSequenceService({
            responder,
            press: (button, pressed) => inputEvents.push([button, pressed]),
            releaseAll: () => {},
            touch: () => {},
            stepFrames: async (frames) => {
                stepCalls++;
                if (!incompleteOnly) {
                    pauseDetails = {
                        paused: true,
                        running: false,
                        pauseKind,
                        ...(breakType !== null ? {
                            breakType,
                            cpu: "arm9",
                            address: 0x02000010,
                            pc: 0x02000020
                        } : {})
                    };
                }
                return { frames: 0, requested: frames, paused: !incompleteOnly };
            },
            getPauseDetails: () => pauseDetails,
            storage: memoryStorage()
        });
        return {
            inputEvents,
            run: (seq) => input.run({ seq }, { signal: new AbortController().signal }),
            stepCalls: () => stepCalls
        };
    };

    for (const [pauseKind, breakType] of breakCases) {
        const harness = createHarness({ pauseKind, breakType });
        await assert.rejects(
            harness.run([["wf", 1]]),
            (error) => error.mcpCode === "INPUT_UNAVAILABLE"
                && error.mcpDetails.pauseKind === pauseKind
                && (breakType === null
                    ? !Object.prototype.hasOwnProperty.call(error.mcpDetails, "breakType")
                    : error.mcpDetails.breakType === breakType)
        );
        assert.equal(harness.stepCalls(), 1);
    }

    const laterFrame = createHarness();
    await assert.rejects(
        laterFrame.run([["wf", 1], ["wf", 1]]),
        (error) => error.mcpCode === "INPUT_UNAVAILABLE"
    );
    assert.equal(laterFrame.stepCalls(), 1);

    const laterInput = createHarness();
    await assert.rejects(
        laterInput.run([["wf", 1], ["h", "A", 1]]),
        (error) => error.mcpCode === "INPUT_UNAVAILABLE"
    );
    assert.deepEqual(laterInput.inputEvents, []);

    const heldInput = createHarness({ pauseKind: "memoryBreakpoint", breakType: "write" });
    await assert.rejects(
        heldInput.run([["hf", "A", 1]]),
        (error) => error.mcpCode === "INPUT_UNAVAILABLE"
            && error.mcpDetails.pauseKind === "memoryBreakpoint"
            && error.mcpDetails.breakType === "write"
    );
    assert.deepEqual(heldInput.inputEvents, [["A", true], ["A", false]]);

    const incomplete = createHarness({ incompleteOnly: true });
    await assert.rejects(
        incomplete.run([["wf", 2]]),
        (error) => error.mcpCode === "INPUT_UNAVAILABLE"
            && error.mcpDetails.paused === true
    );
});

test("legacy scalar helpers unwrap values and preserve structured failures", async () => {
    assert.equal(unwrapLegacyScalar({ ok: true, value: 0x02075628 }, "memoryGetRegister"), 0x02075628);
    assert.equal(unwrapLegacyScalar(7, "memoryReadByte"), 7);
    assert.throws(
        () => unwrapLegacyScalar({ ok: true, rows: [] }, "memoryReadDword"),
        /did not return a scalar result/
    );
    assert.throws(
        () => unwrapLegacyScalar({ ok: false, error: { code: "NATIVE_ERROR", message: "read failed", details: { nativeCode: 4 } } }, "memoryReadDword"),
        (error) => error.code === "NATIVE_ERROR" && error.details.nativeCode === 4
    );
});

test("window.memory scalar aliases return numbers while DesmumeMCP.call stays structured", async () => {
    const previous = Object.fromEntries(["window", "navigator", "document"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name)
    ]));
    const listeners = [];
    Object.defineProperty(globalThis, "window", {
        value: {
            addEventListener: (...args) => listeners.push(args),
            location: { origin: "http://localhost" }
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
    try {
        const calls = [];
        const runCommand = async (command) => {
            calls.push(command);
            return { ok: true, value: command === "memoryGetRegister" ? 0x02075628 : 0x12345678 };
        };
        registerWebMcp({
            commands: {}, descriptions: {}, responder, runCommand,
            compact: String, installShortcuts: () => {}, logger: () => {}
        });
        assert.equal(await window.memory.reg("r14", "arm9"), 0x02075628);
        assert.equal(await window.memory.read32(0x02385f0c, "arm9"), 0x12345678);
        assert.equal(String(await window.memory.reg("r14", "arm9")).includes("[object Object]"), false);
        assert.deepEqual(await window.DesmumeMCP.call("memoryGetRegister", {}), { ok: true, value: 0x02075628 });
        assert.deepEqual(calls, ["memoryGetRegister", "memoryReadDword", "memoryGetRegister", "memoryGetRegister"]);
    } finally {
        for (const name of ["window", "navigator", "document"]) {
            if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
            else delete globalThis[name];
        }
    }
});

test("WebMCP prefers document.modelContext and accepts duplicate native registrations after reload", async () => {
    const previous = Object.fromEntries(["window", "navigator", "document"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name)
    ]));
    let documentRegistrations = 0;
    let navigatorRegistrations = 0;
    const registeredDescriptions = [];
    const logs = [];
    Object.defineProperty(globalThis, "window", {
        value: { addEventListener: () => {}, location: { origin: "http://localhost:8766" } },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, "document", {
        value: {
            modelContext: {
                registerTool: async (tool) => {
                    documentRegistrations++;
                    registeredDescriptions.push(tool.description);
                    throw new Error("duplicate tool registration");
                }
            }
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, "navigator", {
        value: {
            modelContext: {
                registerTool: async () => { navigatorRegistrations++; }
            }
        },
        configurable: true,
        writable: true
    });
    try {
        const registration = registerWebMcp({
            commands: { eval: async () => responder.ok(), runScript: async () => responder.ok() },
            descriptions: {}, responder, runCommand: async () => responder.ok(), compact: String,
            installShortcuts: () => {}, logger: (message) => logs.push(String(message))
        });
        assert.equal(await registration.registerBrowserTools(), true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(documentRegistrations >= 4);
        assert.equal(navigatorRegistrations, 0);
        assert.ok(logs.some((message) => message === "WebMCP registered 4 tools"));
        const injectedContext = registeredDescriptions.join("\n");
        assert.match(injectedContext, /ROM, save, and state bytes are not uploaded/);
        assert.match(injectedContext, /cross-origin and opaque-origin message calls are ignored/);
        assert.match(injectedContext, /localStorage, sessionStorage, IndexedDB, Cache API/);
        assert.match(injectedContext, /Exact-version Acorn and SSIM dependencies are bundled locally/);
    } finally {
        for (const name of ["window", "navigator", "document"]) {
            if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
            else delete globalThis[name];
        }
    }
});

test("comparison dependencies are exact-version local bundles with no runtime CDN", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
    assert.equal(packageJson.dependencies.acorn, "8.17.0");
    assert.equal(packageJson.dependencies["ssim.js"], "3.5.0");
    assert.equal(lock.packages["node_modules/acorn"].version, "8.17.0");
    assert.equal(lock.packages["node_modules/ssim.js"].version, "3.5.0");
    assert.doesNotMatch(html, /cdn\.jsdelivr|https:\/\/[^"']+\.js/i);
    assert.doesNotMatch(appSource, /createAlgorithmLoader|algorithm-loader/);
});

test("dependency bundle verification does not execute audited parser dependency", async () => {
    const policy = await readFile(new URL("../scripts/dependency-bundle-policy.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(policy, /from\s+["']acorn["']/);
    assert.doesNotMatch(policy, /import\s*\(\s*["']acorn["']\s*\)/);
    assert.match(policy, /expected-hashes\.json/);
    assert.match(policy, /createHash\("sha256"\)/);
});

test("first-party app builds do not require a committed hash while external dependencies remain verified", async () => {
    const buildSource = await readFile(new URL("../scripts/build-js.mjs", import.meta.url), "utf8");
    const workflow = await readFile(new URL("../.github/workflows/webassembly.yml", import.meta.url), "utf8");
    const dependencyPolicy = await readFile(new URL("../scripts/dependency-bundle-policy.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(buildSource, /app\.js\.sha256|applicationBundle/);
    assert.doesNotMatch(workflow, /app\.js\.sha256/);
    assert.match(dependencyPolicy, /expected-hashes\.json/);
    assert.match(dependencyPolicy, /does not match the fixed audited hash/);
});

test("locally bundled comparison sandbox uses no network or storage capability", async () => {
    const result = await runAlgorithmSandbox();
    assert.equal(result.networkCalls, 0);
    assert.equal(result.storageCalls, 0);
    assert.deepEqual(result.messages.map((message) => message.type), ["bootstrapReady", "ready", "done"]);
    assert.equal(result.messages[2].result.pct, 0);
});

test("opaque and cross-origin contexts cannot use the message bridge to dump arbitrary ROM data", async () => {
    const previous = Object.fromEntries(["window", "navigator", "document"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name)
    ]));
    const listeners = new Map();
    Object.defineProperty(globalThis, "window", {
        value: {
            addEventListener: (type, listener) => listeners.set(type, listener),
            location: { origin: "http://localhost:8766" }
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
    try {
        const sampleRom = new Uint8Array([0x44, 0x53, 0x52, 0x4f, 0x4d]);
        let commandCalls = 0;
        registerWebMcp({
            commands: {}, descriptions: {}, responder,
            runCommand: async () => {
                commandCalls++;
                return responder.ok({ size: sampleRom.length, marker: sampleRom[0] });
            },
            compact: String,
            installShortcuts: () => {},
            logger: () => {}
        });
        const messageHandler = listeners.get("message");
        assert.equal(typeof messageHandler, "function");

        const crossOriginCommands = [
            "dumpMemory", "memoryReadByte", "memoryReadWord", "memoryReadDword", "getRegisters"
        ];
        for (const origin of ["null", "https://cross-origin.invalid"]) {
            for (const command of crossOriginCommands) {
                const replies = [];
                await messageHandler({
                    origin,
                    data: {
                        type: "desmume-mcp",
                        id: `cross-origin-${origin}-${command}`,
                        command,
                        params: { address: 0, length: sampleRom.length }
                    },
                    source: { postMessage: (...args) => replies.push(args) }
                });
                assert.deepEqual(replies, [], `${origin}:${command}`);
            }
        }
        assert.equal(commandCalls, 0);

        const trustedReplies = [];
        await messageHandler({
            origin: window.location.origin,
            data: {
                type: "desmume-mcp",
                id: "trusted",
                command: "dumpMemory",
                params: { address: 0, length: sampleRom.length }
            },
            source: { postMessage: (...args) => trustedReplies.push(args) }
        });
        assert.equal(commandCalls, 1);
        assert.equal(trustedReplies.length, 1);
        assert.equal(trustedReplies[0][0].result.marker, sampleRom[0]);
        assert.equal(trustedReplies[0][1], window.location.origin);
    } finally {
        for (const name of ["window", "navigator", "document"]) {
            if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
            else delete globalThis[name];
        }
    }
});

function createStateCommandHarness(runState, nativeResult = 0) {
    const invalidations = [];
    const state = { frame: 9 };
    const commands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        blockSaveFlush: () => {},
        bytesFromParams: () => new Uint8Array([1]),
        cancelOperation: () => {},
        dispatchScriptEvent: () => {},
        download: () => {},
        drawLoadedStateFrame: (options) => invalidations.push(options),
        ensureReady: () => {},
        ensureRomLoaded: () => {},
        idbGet: async () => null,
        idbPut: async () => {},
        isAnalysisBaselineSlot: () => false,
        loadStateBytesFromMemory: () => nativeResult,
        log: () => {},
        native: {
            loadBufferedState: () => nativeResult,
            loadStateFile: () => nativeResult
        },
        openPicker: async () => ({ file: { name: "state.dst" }, bytes: new Uint8Array([1]) }),
        pauseForFileLoad: () => ({ ...runState }),
        readFileFromInput: async () => ({ file: { name: "state.dst" }, bytes: new Uint8Array([1]) }),
        recordRecentFile: async () => {},
        rememberSlot: () => {},
        restoreAfterFileLoad: () => {},
        state,
        stopAfterFailedStateLoad: () => {},
        ui: { stateFile: { files: [] } }
    });
    return { commands, invalidations, state };
}

test("State load notice follows the run state that existed before loading", async () => {
    const running = createStateCommandHarness({ running: true, paused: false });
    await running.commands.loadState();
    assert.deepEqual(running.invalidations, [{ showResumeNotice: false }]);

    const paused = createStateCommandHarness({ running: false, paused: true });
    await paused.commands.loadState();
    assert.deepEqual(paused.invalidations, [{ showResumeNotice: true }]);
});

test("State load commits its destructive boundary only after operation cancellation settles", async () => {
    const events = [];
    const commands = createStateCommands({
        blockSaveFlush: () => {},
        bytesFromParams: () => new Uint8Array([1]),
        cancelAndWait: async () => {
            events.push("cancel");
            throw Object.assign(new Error("did not settle"), { mcpCode: "TIMEOUT" });
        },
        dispatchScriptEvent: () => {},
        drawLoadedStateFrame: () => {},
        ensureRomLoaded: () => {},
        fileTransactionService: {
            run: async (_reason, task) => task({
                commit: async () => { events.push("commit"); }
            })
        },
        native: {
            loadStateFile: () => {
                events.push("native-load");
                return 0;
            }
        },
        pauseForFileLoad: () => ({ running: true, paused: false }),
        restoreAfterFileLoad: () => {},
        state: {},
        stopAfterFailedStateLoad: () => {}
    });

    await assert.rejects(commands.loadStateBytes(), /did not settle/);
    assert.deepEqual(events, ["cancel"]);
});

test("State service forwards notice ownership and preserves the requested run state", () => {
    const notices = [];
    const pauses = [];
    const state = {
        running: true, paused: false, ready: true, loadingFile: false,
        frameBudget: 3, lastTick: 0, nativeFault: false,
        screenValid: true, framesSinceStateLoad: 4, stateLoadSerial: 0,
        breakLabel: "break", breakRefreshKey: "break"
    };
    const service = createStateService({
        state,
        native: { pause: (value) => pauses.push(value), clearBreakStatus: () => {} },
        frameService: { invalidateAfterStateLoad: () => {} },
        onScreenInvalid: (options) => notices.push(options),
        onStatusChange: () => {}
    });
    const before = service.pauseForLoad();
    service.invalidateAfterLoad({ showResumeNotice: false });
    service.restoreAfterLoad(before);
    assert.deepEqual(notices, [{ showResumeNotice: false }]);
    assert.equal(state.running, true);
    assert.equal(state.paused, false);
    assert.deepEqual(pauses, [true, false]);
});

test("status exposes a monotonic State application gate distinct from file selection", async () => {
    const commands = createContextCommands({
        state: {
            ready: false,
            paused: true,
            running: false,
            loadingFile: false,
            fileTransactionActive: true,
            fileTransactionSerial: 7,
            fileTransactionReason: "State import",
            stateLoadSerial: 3,
            romSize: 0,
            frame: 0,
            speed: 1,
            render: true,
            audio: false,
            selectedCpu: "arm9",
            recentFiles: [],
            autoUpdate: { enabled: false, hz: 1 }
        },
        hasLoadedRom: () => false,
        native: {},
        syncNativeBreakStatus: () => {}
    });
    const status = await commands.status();
    assert.deepEqual(status.fileTransaction, {
        active: true,
        serial: 7,
        reason: "State import"
    });
    assert.equal(status.stateLoadSerial, 3);
    assert.equal(status.loadingFile, false);
});

test("State service preserves an explicit pause requested while a file load is active", () => {
    const pauses = [];
    const state = {
        running: true, paused: false, ready: true, loadingFile: false,
        frameBudget: 0, lastTick: 0, nativeFault: false,
        explicitPauseSerial: 4
    };
    const service = createStateService({
        state,
        native: { pause: (value) => pauses.push(value), clearBreakStatus: () => {} },
        frameService: { invalidateAfterStateLoad: () => {} },
        onStatusChange: () => {}
    });
    const before = service.pauseForLoad();
    state.explicitPauseSerial++;
    service.restoreAfterLoad(before);

    assert.equal(state.running, false);
    assert.equal(state.paused, true);
    assert.deepEqual(pauses, [true, true]);
});

test("State resume notice clears only text that it owns", () => {
    const status = { dataset: {}, textContent: "save loaded slot" };
    const notice = createScreenInvalidNotice(status);
    notice.clear();
    assert.equal(status.textContent, "save loaded slot");

    notice.show();
    assert.equal(status.textContent, SCREEN_INVALID_NOTICE);
    assert.equal(status.dataset.screenInvalidNotice, "true");
    notice.clear();
    assert.equal(status.textContent, "");
    assert.equal("screenInvalidNotice" in status.dataset, false);

    notice.show();
    status.textContent = "state saved later";
    notice.clear();
    assert.equal(status.textContent, "state saved later");
    assert.equal("screenInvalidNotice" in status.dataset, false);
});

test("first manual frame after State load becomes valid before canvas draw", async () => {
    let valid = false;
    let draws = 0;
    let noticeClears = 0;
    const state = {
        frame: 0, running: false, paused: true, ready: true, render: true,
        touch: { active: false }, keys: 0, screenValid: false,
        framesSinceStateLoad: 0, completedFrameSerial: 0
    };
    const commands = createRuntimeCommands({
        applyFreezes: () => {},
        cancelOperation: () => {},
        dispatchScriptEvent: () => {},
        drawFrame: () => { assert.equal(valid, true); draws++; },
        ensureRomLoaded: () => {},
        frameService: {
            onFrameCompleted: () => { valid = true; },
            isValid: () => valid
        },
        native: {
            pause: () => {},
            runFrames: () => { state.frame = 1; return 1; }
        },
        onScreenValid: () => { noticeClears++; },
        pumpAudio: () => {},
        state,
        syncNativeBreakStatus: () => ({ lastBreak: { hit: false } }),
        updateStatus: () => {}
    });
    const result = await commands.stepFrames({ frames: 1 });
    assert.equal(result.frames, 1);
    assert.equal(draws, 1);
    assert.equal(noticeClears, 1);
    assert.equal(state.screenValid, true);
    assert.equal(state.completedFrameSerial, 1);
});

function createFailingFrameStep(stage, cleanupPauseFails = false) {
    const pauseCalls = [];
    let freezeCalls = 0;
    const state = {
        frame: 0, running: false, paused: true, ready: true, render: true,
        touch: { active: stage === "native.runFrame" }, keys: 0, nativeFault: false,
        screenValid: false, framesSinceStateLoad: 0, completedFrameSerial: 0,
        selectedCpu: "arm9"
    };
    const fail = (name) => {
        if (stage === name) throw new Error(`failed at ${name}`);
    };
    const commands = createRuntimeCommands({
        applyFreezes: () => {
            freezeCalls++;
            if (stage === "applyFreezes" && freezeCalls === 2) fail("applyFreezes");
        },
        dispatchScriptEvent: () => fail("dispatchScriptEvent"),
        drawFrame: () => fail("drawFrame"),
        ensureRomLoaded: () => {},
        frameService: { onFrameCompleted: () => fail("completeFrames") },
        native: {
            pause: (paused) => {
                pauseCalls.push(paused);
                if (paused && cleanupPauseFails) throw new Error("cleanup pause failed");
            },
            runFrame: () => {
                fail("native.runFrame");
                state.frame++;
                return 0;
            },
            runFrames: () => {
                fail("native.runFrames");
                state.frame++;
                return 1;
            }
        },
        pumpAudio: () => fail("pumpAudio"),
        state,
        syncNativeBreakStatus: () => {
            fail("syncNativeBreakStatus");
            return { lastBreak: { hit: false } };
        },
        updateStatus: () => {}
    });
    return { commands, pauseCalls, state };
}

test("stepFrames restores native and logical pause state after every failing stage", async () => {
    for (const stage of [
        "native.runFrame", "native.runFrames", "syncNativeBreakStatus", "completeFrames",
        "applyFreezes", "drawFrame", "pumpAudio", "dispatchScriptEvent"
    ]) {
        const harness = createFailingFrameStep(stage);
        await assert.rejects(
            harness.commands.stepFrames({ frames: 1 }),
            new RegExp(`failed at ${stage.replace(".", "\\.")}`)
        );
        assert.deepEqual(harness.pauseCalls, [false, true], stage);
        assert.equal(harness.state.paused, true, stage);
        assert.equal(harness.state.running, false, stage);
    }
});

test("stepFrames preserves its primary error when native pause cleanup also fails", async () => {
    const harness = createFailingFrameStep("drawFrame", true);
    await assert.rejects(
        harness.commands.stepFrames({ frames: 1 }),
        /failed at drawFrame/
    );
    assert.deepEqual(harness.pauseCalls, [false, true]);
    assert.equal(harness.state.paused, true);
    assert.equal(harness.state.running, false);
});

test("predictable State and Save native failures carry NATIVE_ERROR details", async () => {
    const stateHarness = createStateCommandHarness({ running: false, paused: true }, 7);
    await assert.rejects(
        stateHarness.commands.loadState(),
        (error) => error.mcpCode === "NATIVE_ERROR" && error.mcpDetails.nativeCode === 7
    );

    const save = createSaveCommands({
        ui: { stateSlot: { value: "slot" } },
        native: { exportSaveBytes: () => new Uint8Array() },
        ensureRomLoaded: () => {},
        rememberSlot: () => {},
        download: () => {}
    });
    await assert.rejects(
        save.exportSaveFile(),
        (error) => error.mcpCode === "NATIVE_ERROR" && error.mcpDetails.size === 0
    );
});

test("Batch uses the dispatcher plain-object contract and rejects malformed items predictably", async () => {
    const calls = [];
    const scriptCommands = createScriptCommands({
        state: { scripts: new Map() },
        ui: {},
        runCommand: async (command, params) => {
            calls.push({ command, params });
            return responder.ok({ command });
        }
    });
    const registry = createCommandRegistry({ responder });
    registry.registerAll(scriptCommands);
    const dispatcher = createCommandDispatcher({
        state: { ready: false }, registry, responder,
        operationManager: { current: () => null },
        hasLoadedRom: () => false,
        emulatorActivity: () => ({}),
        updateStatus: () => {}
    });
    const result = await dispatcher.run("batch", {
        commands: [{ command: "status", params: {} }]
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ command: "status", params: {} }]);
    assert.equal((await dispatcher.run("batch", [{ command: "status" }])).error.code, "INVALID_ARGUMENT");
    assert.equal((await dispatcher.run("batch", { commands: [null] })).error.code, "INVALID_ARGUMENT");
    assert.equal((await dispatcher.run("batch", { commands: [{}] })).error.code, "INVALID_ARGUMENT");

    const uiSource = await readFile(new URL("../src/ui/ui-controller.js", import.meta.url), "utf8");
    assert.match(uiSource, /runCommand\("batch", \{\s*commands:/);

    const screenshot = createScreenshotCommands({
        requireValidScreen: () => null,
        state: { screenshotCooldownUntil: 0 },
        ui: {
            screen: {
                toDataURL: () => `data:image/png;base64,${"A".repeat(2048)}`,
                width: 256,
                height: 384
            }
        }
    });
    const screenshotResult = await screenshot.takeScreenshot({
        includeDataUrl: false,
        download: false,
        cooldownMs: 250
    });
    assert.equal(Object.hasOwn(screenshotResult, "dataUrl"), false);
    const screenshotBatch = createScriptCommands({
        state: { scripts: new Map() },
        ui: {},
        runCommand: async () => screenshotResult
    });
    const batchResult = await screenshotBatch.batch({
        commands: [{ command: "takeScreenshot", params: { includeDataUrl: false } }]
    });
    assert.equal(batchResult.results.length, 1);
    assert.equal(Object.hasOwn(batchResult.results[0].result, "dataUrl"), false);

    const invalidResultBatch = createScriptCommands({
        state: { scripts: new Map() },
        ui: {},
        runCommand: async () => ({ ok: true, value: undefined })
    });
    await assert.rejects(
        invalidResultBatch.batch({ commands: [{ command: "invalidResult" }] }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
            && error.message.includes("not a supported structured value")
            && error.mcpDetails.command === "invalidResult"
            && !Object.hasOwn(error.mcpDetails, "maximumBytes")
    );
});

test("published persistent MCP commands validate inputs and preserve value envelopes", async () => {
    const calls = [];
    const commands = createScriptCommands({
        state: { scripts: new Map() },
        ui: {},
        listPScriptMcps: (scriptId) => ({
            mcps: [{ scriptId: scriptId ?? 1, name: "listActions", description: "Lists actions." }]
        }),
        callPScriptMcp: async (params) => {
            calls.push(params);
            return {
                scriptId: params.scriptId,
                scriptName: "orchestrator",
                name: params.name,
                blocking: params.blocking,
                value: [{ id: "menu.item", enabled: true }]
            };
        }
    });
    assert.equal((await commands.listPScriptMcp({ scriptId: 4 })).mcps[0].scriptId, 4);
    await assert.rejects(
        commands.callPScriptMcp({ scriptId: 4, name: "listActions", params: {} }),
        (error) => error.mcpCode === "INVALID_ARGUMENT" && /blocking/.test(error.message)
    );
    const result = await commands.callPScriptMcp({
        scriptId: 4,
        name: "listActions",
        params: {},
        blocking: true
    });
    assert.deepEqual(result.value, [{ id: "menu.item", enabled: true }]);
    assert.equal(calls[0].timeoutMs, 3000);
    const webResult = responder.toWebMcpContent(responder.ok(result));
    assert.deepEqual(
        JSON.parse(JSON.stringify(webResult.structuredContent.value)),
        [{ id: "menu.item", enabled: true }]
    );
    assert.match(webResult.content[0].text, /value=/);
});

test("persistent MCP normalizers keep structured boundaries separated", () => {
    const metadata = normalizePersistentMcpMetadata([
        { name: "listActions", description: " Lists actions. " }
    ]);
    const params = normalizePersistentMcpParams({ selection: { row: 2 } });
    const result = normalizePersistentMcpResult({ ok: false, values: [1, 2] });
    assert.equal(Object.getPrototypeOf(metadata[0]), null);
    assert.equal(Object.getPrototypeOf(params), null);
    assert.equal(Object.getPrototypeOf(params.selection), null);
    assert.equal(Object.getPrototypeOf(result), null);
});

test("persistent baseline JSON cannot pollute prototypes", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"owned":true}},"nested":{"prototype":"data"}}');
    const normalized = normalizePersistentBaselineData(input);
    assert.equal(Object.getPrototypeOf(normalized), null);
    assert.equal(Object.getPrototypeOf(normalized.__proto__), null);
    assert.equal(Object.getPrototypeOf(normalized.constructor), null);
    assert.equal(normalized.__proto__.polluted, true);
    assert.equal(normalized.constructor.prototype.owned, true);
    assert.equal({}.polluted, undefined);
    assert.equal({}.owned, undefined);
});

test("persistent events wait for the supervisor startup handshake", async () => {
    const { createScriptService } = await bundledScriptServiceModule();
    const posted = [];
    const script = {
        id: 5,
        running: true,
        started: false,
        eventQueue: [],
        eventBusy: false,
        droppedEvents: 0,
        worker: { postMessage: (message) => posted.push(message) }
    };
    const state = { scripts: new Map([[script.id, script]]) };
    const service = createScriptService({
        state,
        ui: {},
        responder,
        breakpointOwners: {},
        ensureRomLoaded: () => {},
        finishPersistentScriptEvent: async () => true,
        requestPersistentScriptResume: () => true,
        settlePersistentScriptCallbacks: async () => {},
        hex: String,
        parseAddress: Number,
        rawOutputText: JSON.stringify,
        runCommand: async () => ({}),
        getCommands: () => ({}),
        onExplicitPause: () => {}
    });
    service.dispatchScriptEvent("tick", { frame: 1 });
    assert.equal(posted.length, 0);
    assert.equal(script.eventQueue.length, 0);
    script.started = true;
    service.dispatchScriptEvent("tick", { frame: 2 });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].payload.frame, 2);
});

test("persistent MCP timeout ends caller wait without stopping FIFO state", async () => {
    const { createScriptService } = await bundledScriptServiceModule();
    const state = { scripts: new Map(), activeScriptId: 0 };
    const posted = [];
    const script = {
        id: 7,
        name: "orchestrator",
        running: true,
        started: true,
        scriptInstanceId: "instance-timeout",
        pscriptMcps: new Map([
            ["slow", { name: "slow", description: "Slow handler." }],
            ["next", { name: "next", description: "Next handler." }]
        ]),
        pscriptMcpPublished: true,
        pendingPScriptMcpCalls: new Map(),
        expiredPScriptMcpCalls: new Map(),
        inFlightPScriptMcpCalls: new Map(),
        nextPScriptMcpCallId: 1,
        eventQueue: [],
        eventBusy: false,
        worker: { postMessage: (message) => posted.push(message) },
        output: [],
        code: "",
        triggers: [],
        ownedBreakpointIds: new Set()
    };
    state.scripts.set(script.id, script);
    const service = createScriptService({
        state,
        ui: {},
        responder,
        breakpointOwners: {},
        ensureRomLoaded: () => {},
        finishPersistentScriptEvent: async () => true,
        requestPersistentScriptResume: () => true,
        settlePersistentScriptCallbacks: async () => {},
        hex: String,
        parseAddress: Number,
        rawOutputText: JSON.stringify,
        runCommand: async () => ({}),
        getCommands: () => ({}),
        onExplicitPause: () => {}
    });
    const timedOut = service.callPScriptMcp({
        scriptId: 7,
        name: "slow",
        params: {},
        blocking: true,
        timeoutMs: 5
    });
    await assert.rejects(timedOut, (error) => error.mcpCode === "TIMEOUT");
    assert.equal(script.running, true);
    assert.equal(script.eventBusy, true);
    assert.equal(script.pscriptMcps.size, 2);
    assert.equal(script.inFlightPScriptMcpCalls.size, 1);

    service.finishPScriptMcpCall(script, {
        type: "pscriptMcpResult",
        scriptInstanceId: "old-instance",
        callId: 1,
        ok: true,
        value: []
    });
    assert.equal(script.eventBusy, true);
    service.finishPScriptMcpCall(script, {
        type: "pscriptMcpResult",
        scriptInstanceId: "instance-timeout",
        callId: 1,
        ok: true,
        value: []
    });
    assert.equal(script.eventBusy, false);
    assert.equal(script.inFlightPScriptMcpCalls.size, 0);

    const next = service.callPScriptMcp({
        scriptId: 7,
        name: "next",
        params: {},
        blocking: false,
        timeoutMs: 100
    });
    service.finishPScriptMcpCall(script, {
        type: "pscriptMcpResult",
        scriptInstanceId: "instance-timeout",
        callId: 2,
        ok: true,
        value: ["ready"]
    });
    assert.deepEqual((await next).value, ["ready"]);
    assert.equal(posted.some((message) => message.callId === 2), true);
    assert.equal(service.listPScriptMcps().mcps.length, 2);
    script.running = false;
    assert.deepEqual(service.listPScriptMcps(), { mcps: [] });
});

test("reserved State storage and analysis baseline failures use stable error codes", async () => {
    const reserved = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        ensureRomLoaded: () => {},
        isAnalysisBaselineSlot: () => true,
        native: { saveStateBytes: () => ({ length: 1 }) }
    });
    await assert.rejects(
        reserved.saveState({ slot: "analysis:reserved" }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );

    const oversized = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        ensureRomLoaded: () => {},
        isAnalysisBaselineSlot: () => false,
        rememberSlot: () => {},
        native: { saveStateBytes: () => ({ length: 256 * 1024 * 1024 + 1 }) }
    });
    await assert.rejects(
        oversized.saveState({ slot: "too-large" }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );

    const baseline = {
        romName: "game.nds", romSize: 10, romSha256: "rom-hash", stateFormatVersion: 12,
        slot: "analysis:baseline", stateSize: 4, stateSha256: "state-hash"
    };
    const createContext = ({ storedBaseline = baseline, rom = baseline, stateBytes = new Uint8Array(4), stateHash = "state-hash" } = {}) => (
        createContextCommands({
            ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:",
            analysisBaselineSlotToken: Symbol("baseline"),
            ensureRomLoaded: () => {},
            readAnalysisBaseline: () => storedBaseline,
            currentRomIdentity: async () => rom,
            idbGet: async () => stateBytes,
            sha256Hex: async () => stateHash,
            state: {}, ui: {}
        })
    );
    await assert.rejects(
        createContext({ storedBaseline: null }).restoreAnalysisBaseline({ name: "missing" }),
        (error) => error.mcpCode === "STATE_NOT_LOADED"
    );
    await assert.rejects(
        createContext({ rom: { ...baseline, romSha256: "different" } }).restoreAnalysisBaseline(),
        (error) => error.mcpCode === "STATE_INVALID" && error.mcpDetails.field === "romSha256"
    );
    await assert.rejects(
        createContext({ stateHash: "different" }).restoreAnalysisBaseline(),
        (error) => error.mcpCode === "STATE_INVALID"
    );
});

test("speed, scale, rotation, and custom search length reject collapsing values", async () => {
    const state = { speed: 1, scale: 2, rotation: 0 };
    const ui = {
        speedSelect: { value: "1" },
        scaleSelect: { value: "2" },
        rotationSelect: { value: "0" },
        searchAddress: { value: "0" },
        searchLength: { value: "64" }
    };
    const runtime = createRuntimeCommands({
        applyScaleRotation: () => {},
        state,
        ui,
        updateStatus: () => {}
    });
    for (const value of [0, -1, Number.NaN, 1.25]) {
        await assert.rejects(runtime.setScale({ scale: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    for (const value of [-90, 45, Number.NaN]) {
        await assert.rejects(runtime.setRotation({ rotation: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    for (const value of [0, -1, Number.NaN, 0.75]) {
        await assert.rejects(runtime.setSpeed({ speed: value }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual({ speed: state.speed, scale: state.scale, rotation: state.rotation }, { speed: 1, scale: 2, rotation: 0 });

    const view = createViewService({
        state: { selectedCpu: "arm9" },
        ui,
        parseAddress: Number,
        getIdbPut: () => async () => {}
    });
    for (const length of [0, -1, Number.NaN, 1.5, 16 * 1024 * 1024 + 1]) {
        assert.throws(() => view.memorySearchRanges({ address: 0, length }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual(view.memorySearchRanges({ address: 32, length: 64 }), [{ name: "custom", address: 32, length: 64 }]);
});

test("NaN command inputs are rejected before mutable emulator state is touched", async () => {
    const runtimeState = {
        speed: 1, scale: 2, rotation: 0, audio: false,
        autoUpdate: { enabled: false, hz: 4 },
        running: false, paused: true, frame: 10
    };
    const runtimeUi = {
        speedSelect: { value: "1" }, scaleSelect: { value: "2" }, rotationSelect: { value: "0" },
        audioToggle: { checked: false }, volumeRange: { value: "0.25" },
        autoUpdateToggle: { checked: false }, autoUpdateRate: { value: "4" }
    };
    let nativeCalls = 0;
    const runtime = createRuntimeCommands({
        applyScaleRotation: () => {}, cancelOperation: () => {}, ensureRomLoaded: () => {},
        native: { pause: () => { nativeCalls++; }, runFrames: () => { nativeCalls++; return 0; } },
        queueAutoUpdateLoop: () => {}, state: runtimeState, stopAutoUpdateLoop: () => {},
        ui: runtimeUi, updateStatus: () => {}
    });
    const runtimeBefore = structuredClone(runtimeState);
    await assert.rejects(runtime.setAutoUpdate({ enabled: true, hz: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(runtime.setAudio({ enabled: true, volume: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    await assert.rejects(runtime.stepFrames({ frames: Number.NaN }), (error) => error.mcpCode === "INVALID_ARGUMENT");
    assert.deepEqual(runtimeState, runtimeBefore);
    assert.equal(runtimeUi.audioToggle.checked, false);
    assert.equal(runtimeUi.volumeRange.value, "0.25");
    assert.equal(nativeCalls, 0);

    const inputState = { keys: 0, touch: { active: false }, keymap: {} };
    const inputEvents = [];
    const input = createInputCommands({
        state: inputState, ensureRomLoaded: () => {}, renderHotkey: () => {}, saveKeymap: () => {},
        setKey: (...args) => inputEvents.push(["key", ...args]),
        setTouchState: (...args) => inputEvents.push(["touch", ...args]),
        toButtonList: () => ["A"], waitChecked: async () => {}
    });
    for (const call of [
        () => input.runInputTap({ button: "A", repeat: Number.NaN }),
        () => input.runInputTap({ button: "A", holdMs: Number.NaN }),
        () => input.runInputHold({ button: "A", timeoutMs: Number.NaN }),
        () => input.runInputHold({ button: "A", waitBeforeMs: Number.NaN }),
        () => input.runTouchHold({ x: Number.NaN, y: 0 })
    ]) {
        await assert.rejects(call(), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual(inputState, { keys: 0, touch: { active: false }, keymap: {} });
    assert.deepEqual(inputEvents, []);

    let cancellations = 0;
    let stateLoads = 0;
    const stateCommands = createStateCommands({
        analysisBaselineSlotToken: Symbol("baseline"),
        cancelOperation: () => { cancellations++; }, ensureRomLoaded: () => {},
        isAnalysisBaselineSlot: () => false,
        native: { loadBufferedState: () => { stateLoads++; return 0; } },
        pauseForFileLoad: () => ({ running: false, paused: true }), state: { frame: 7 }, ui: {}
    });
    await assert.rejects(
        stateCommands.loadState({ saveFlushBlockMs: Number.NaN }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(cancellations, 0);
    assert.equal(stateLoads, 0);

    const screenshotState = { screenshotCooldownUntil: 123 };
    const screenshot = createScreenshotCommands({
        requireValidScreen: () => null,
        state: screenshotState,
        ui: { screen: { toDataURL: () => "data:image/png;base64,", width: 256, height: 384 } }
    });
    await assert.rejects(
        screenshot.takeScreenshot({ cooldownMs: Number.NaN, download: false }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(screenshotState.screenshotCooldownUntil, 123);

    const debuggerHarness = createExecStepHarness("mov r0, r0");
    debuggerHarness.state.breakRefreshKey = "preserve";
    await assert.rejects(
        debuggerHarness.service.runDebuggerInstruction("step", { count: Number.NaN }),
        (error) => error.mcpCode === "INVALID_ARGUMENT"
    );
    assert.equal(debuggerHarness.state.breakRefreshKey, "preserve");
    assert.equal(debuggerHarness.pc(), 0x02000000);
});

test("input hold, tap, and touch waits enforce per-value and aggregate limits", async () => {
    const inputEvents = [];
    const input = createInputCommands({
        state: { keys: 0, touch: { active: false }, keymap: {} },
        ensureRomLoaded: () => {},
        renderHotkey: () => {},
        saveKeymap: () => {},
        setKey: (...args) => inputEvents.push(["key", ...args]),
        setTouchState: (...args) => inputEvents.push(["touch", ...args]),
        toButtonList: () => ["A"],
        waitChecked: async () => {}
    });
    for (const call of [
        () => input.runInputHold({ durationMs: 600001 }),
        () => input.runInputHold({ durationMs: 600000, waitAfterMs: 1 }),
        () => input.runInputTap({ repeat: 2, holdMs: 300001, gapMs: 0 }),
        () => input.runInputTap({ repeat: 1, holdMs: 600001 }),
        () => input.runTouchHold({ x: 1, y: 1, durationMs: 600001 }),
        () => input.runTouchHold({ x: 1, y: 1, durationMs: 600000, waitBeforeMs: 1 })
    ]) {
        await assert.rejects(call(), (error) => error.mcpCode === "INVALID_ARGUMENT");
    }
    assert.deepEqual(inputEvents, []);
    await input.runInputTap({ repeat: 2, holdMs: 100, gapMs: 50, waitBeforeMs: 10, waitAfterMs: 10 });
    assert.deepEqual(inputEvents, [
        ["key", "A", true], ["key", "A", false],
        ["key", "A", true], ["key", "A", false]
    ]);
});

test("paused input reports manual, execute, memory, and special pause kinds without mutation", async () => {
    const inputEvents = [];
    const state = {
        ready: true,
        paused: true,
        running: false,
        selectedCpu: "arm9",
        keys: 0,
        touch: { active: false },
        keymap: {}
    };
    let lastBreak = { hit: false };
    let resumes = 0;
    const input = createInputCommands({
        state,
        native: { getStatus: () => ({ lastBreak }) },
        ensureRomLoaded: () => {},
        resumeInput: async () => {
            resumes++;
            inputEvents.push(["resume", "start"]);
            await Promise.resolve();
            state.paused = false;
            state.running = true;
            lastBreak = { hit: false };
            inputEvents.push(["resume", "done"]);
            return responder.ok();
        },
        renderHotkey: () => {},
        saveKeymap: () => {},
        setKey: (...args) => inputEvents.push(["key", ...args]),
        setTouchState: (...args) => inputEvents.push(["touch", ...args]),
        toButtonList: () => ["A"],
        waitChecked: async () => {}
    });

    await assert.rejects(
        input.setInput({ button: "A", pressed: true }),
        (error) => error.mcpCode === "INPUT_UNAVAILABLE"
            && error.mcpDetails.pauseKind === "manual"
    );
    for (const [kind, pauseKind, breakType] of [
        [0, "executeBreakpoint", "exec"],
        [1, "memoryBreakpoint", "read"],
        [2, "memoryBreakpoint", "write"],
        [3, "specialBreakpoint", "dataAbort"],
        [4, "specialBreakpoint", "prefetchAbort"],
        [5, "specialBreakpoint", "undefinedInstruction"]
    ]) {
        lastBreak = {
            hit: true,
            kind,
            cpu: "arm9",
            address: 0x02000010,
            pc: 0x02000020
        };
        await assert.rejects(
            input.runInputTap({ button: "A", resume: true }),
            (error) => error.mcpCode === "INPUT_UNAVAILABLE"
                && error.mcpDetails.pauseKind === pauseKind
                && error.mcpDetails.breakType === breakType
        );
    }
    assert.equal(resumes, 0);
    assert.deepEqual(inputEvents, []);

    lastBreak = { hit: false };
    await input.setInput({ button: "A", pressed: true, resume: true });
    assert.equal(resumes, 1);
    assert.deepEqual(inputEvents, [
        ["resume", "start"],
        ["resume", "done"],
        ["key", "A", true]
    ]);
});

test("invalid framebuffer and collapsed shell diagnostics preserve the last canvas", () => {
    let canvasWrites = 0;
    const logs = [];
    const state = {
        ready: true, render: true, scale: 2, rotation: 0,
        imageData: { data: new Uint8ClampedArray(FRAMEBUFFER_BYTES) }
    };
    let connected = false;
    let rect = { width: 0, height: Number.NaN };
    let frameBytes = new Uint8Array(12);
    const loop = createEmulationLoop({
        state,
        ui: {
            screen: {
                get isConnected() { return connected; },
                getContext: () => ({ putImageData: () => { canvasWrites++; } })
            },
            screenShell: { getBoundingClientRect: () => rect }
        },
        frameService: { isValid: () => true },
        native: { getFrameBytes: () => frameBytes },
        handleNativeFault: () => {},
        syncNativeBreakStatus: () => ({}),
        dispatchScriptEvent: () => {},
        updateStatus: () => {},
        log: (message) => logs.push(message)
    });
    assert.throws(() => loop.drawFrame(), /invalid framebuffer length/);
    assert.throws(() => loop.drawFrame(), /invalid framebuffer length/);
    assert.equal(canvasWrites, 0);
    assert.equal(logs.filter((message) => message.includes("invalid framebuffer")).length, 1);

    frameBytes = new Uint8Array(FRAMEBUFFER_BYTES);
    loop.drawFrame();
    loop.drawFrame();
    assert.equal(logs.filter((message) => message.includes("canvas detached")).length, 1);

    connected = true;
    loop.drawFrame();
    loop.drawFrame();
    assert.equal(logs.filter((message) => message.includes("shell collapsed")).length, 1);

    rect = { width: 512, height: 768 };
    loop.drawFrame();
    assert.equal(logs.filter((message) => message.includes("recovered")).length, 1);
    assert.equal(canvasWrites, 5);
});

test("dispatcher owns one debugger refresh per command cycle", async () => {
    let refreshes = 0;
    const dispatcher = createCommandDispatcher({
        state: { ready: true, loadingFile: false },
        registry: { execute: async () => responder.ok() },
        responder,
        operationManager: { current: () => null },
        hasLoadedRom: () => true,
        emulatorActivity: () => ({}),
        refreshDebuggerViews: async () => { refreshes++; },
        updateStatus: () => {},
        log: () => {}
    });
    await dispatcher.run("step", { count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(refreshes, 1);

    const uiSource = await readFile(new URL("../src/ui/ui-controller.js", import.meta.url), "utf8");
    assert.doesNotMatch(uiSource, /runCommand\("(?:pause|stepFrames|step|smartStep|stepOver|stepNextBranchOrReturn|trueNextBranch)"[^\n]*\.then\(\(\) => refreshDebuggerViews/);
    assert.doesNotMatch(uiSource, /runCommand\("setRegister"[^\n]*\.then\(\(\) => refreshDebuggerViews/);
});

test("NaN and undefined command names return UNKNOWN_COMMAND without corrupting state", async () => {
    const state = { ready: false, paused: true, running: false, marker: "preserve" };
    const registry = createCommandRegistry({ responder });
    registry.register("status", async () => responder.ok({ marker: state.marker }));
    const dispatcher = createCommandDispatcher({
        state, registry, responder,
        operationManager: { current: () => null }, hasLoadedRom: () => false,
        emulatorActivity: () => ({}), refreshDebuggerViews: async () => {},
        updateStatus: () => {}, log: () => {}
    });
    const before = structuredClone(state);
    for (const name of [Number.NaN, undefined, null, "", "not-a-command"]) {
        const result = await dispatcher.run(name, undefined);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "UNKNOWN_COMMAND");
        assert.deepEqual(state, before);
    }
    assert.equal((await dispatcher.run("status", undefined)).ok, true);
    assert.deepEqual(state, before);
});

test("single dispatcher refresh keeps register change highlighting for the command cycle", async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const classes = new Set();
    const label = { textContent: "r0" };
    const output = { textContent: "" };
    const input = { value: "" };
    const row = {
        classList: {
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
            remove: (name) => classes.delete(name)
        },
        querySelector: (selector) => ({ span: label, b: output, input }[selector])
    };
    Object.defineProperty(globalThis, "document", {
        value: { activeElement: null }, configurable: true, writable: true
    });
    try {
        let r0 = 0;
        let refreshes = 0;
        const state = { selectedCpu: "arm9", previousRegisters: null, ready: true, loadingFile: false };
        const view = createViewService({
            state,
            ui: { registers: { querySelectorAll: () => [row] } },
            getRegisters: () => ({ r0 }),
            hasLoadedRom: () => true,
            getIdbPut: () => async () => {}
        });
        view.renderRegisters();
        const dispatcher = createCommandDispatcher({
            state,
            registry: { execute: async () => { r0 = 1; return responder.ok(); } },
            responder,
            operationManager: { current: () => null },
            hasLoadedRom: () => true,
            emulatorActivity: () => ({}),
            refreshDebuggerViews: async () => { refreshes++; view.renderRegisters(); },
            updateStatus: () => {}, log: () => {}
        });
        await dispatcher.run("step", {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(refreshes, 1);
        assert.equal(classes.has("changed"), true);

        await dispatcher.run("step", {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(refreshes, 2);
        assert.equal(classes.has("changed"), false);
    } finally {
        if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
        else delete globalThis.document;
    }
});

function createExecStepHarness(instruction = "bl 02000010") {
    const site = { cpu: "arm9", type: "exec", address: 0x02000000 };
    let pc = site.address;
    let enabled = false;
    let disables = 0;
    let enables = 0;
    const state = {
        ready: true, selectedCpu: "arm9", paused: true, running: false,
        breakpoints: [], autoUpdate: {}, highlightedDisasmAddress: null,
        highlightedCallstackAddress: null, highlightedCallstackCpsr: null,
        breakLabel: "", breakRefreshKey: ""
    };
    const native = {
        setBreakpoint: (_cpu, _type, _address, value) => {
            enabled = value;
            if (value) enables++;
            else disables++;
        },
        getStatus: () => ({ arm9: { pc }, lastBreak: { hit: false } }),
        clearBreakStatus: () => {},
        step: () => {
            if (enabled && pc === site.address) return 0;
            pc += 4;
            return 1;
        },
        stepOver: () => {
            if (enabled && pc === site.address) return 0;
            pc += 4;
            return 1;
        }
    };
    const owners = createBreakpointOwnerStore({
        onFirstOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, true),
        onLastOwner: (entry) => native.setBreakpoint(entry.cpu, entry.type, entry.address, false)
    });
    owners.addOwner(site, { id: 1, origin: "user" });
    const coordinator = createDebuggerCoordinator({
        state, native, breakpointOwners: owners,
        breakpointService: { publish: () => {} },
        getQueueBreakpointRefresh: () => () => {}, log: () => {}, hex: String, updateStatus: () => {}
    });
    const commands = {
        disassemble: async () => ({
            text: `=>${pc.toString(16).padStart(8, "0")}: eb000000 ${
                typeof instruction === "function" ? instruction(pc) : instruction
            }`
        })
    };
    const service = createDebuggerService({
        applyFreezes: () => {}, breakpointKindName: () => "", cpsrModeInfo: () => ({ className: "" }),
        disasmRefreshParams: (value) => value, ensureReady: () => {}, ensureRomLoaded: () => {},
        getPc: () => pc, getRegisters: () => ({ pc }), hasLoadedRom: () => true,
        hex: (value) => `0x${Number(value).toString(16)}`, log: () => {}, native,
        normalizeCallStackData: (value) => value, readCallStackData: () => ({ enabled: true, frames: [] }),
        renderRegisters: () => {}, setFollowPc: () => {}, state,
        syncNativeBreakStatus: () => native.getStatus(),
        ui: { traceToggle: { checked: false }, tracePrivilegeToggle: { checked: false } },
        updateStatus: () => {}, withCurrentExecBreakpointSuspended: coordinator.withCurrentExecBreakpointSuspended,
        getCommands: () => commands
    });
    return { service, state, pc: () => pc, disables: () => disables, enables: () => enables };
}

test("stepOver and smartStep leave a current exec breakpoint without re-hitting it", async () => {
    for (const kind of ["stepOver", "smartStep"]) {
        const harness = createExecStepHarness();
        const result = await harness.service.runDebuggerInstruction(kind);
        assert.equal(result.count, 1);
        assert.equal(harness.pc(), 0x02000004);
        assert.equal(harness.disables(), 1);
        assert.equal(harness.enables(), 2);
    }
});

test("next-branch stepping safely leaves current exec breakpoint for step and stepOver paths", async () => {
    for (const firstInstruction of ["mov r0, r0", "bl 02000010"]) {
        const harness = createExecStepHarness((pc) => (
            pc === 0x02000000 ? firstInstruction : "b 02000020"
        ));
        const result = await harness.service.runUntilNextBranchOrReturn({ maxSteps: 2, timeoutMs: 1000 });
        assert.equal(result.steps, 1);
        assert.equal(harness.pc(), 0x02000004);
        assert.equal(harness.disables(), 1);
        assert.equal(harness.enables(), 2);
    }
});

test("Worker RPC policy preserves normal debugger calls and bounded byte injection", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("status", { verbose: true }))), { verbose: true });
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("dumpMemory", {
        cpu: "arm9", address: 0x02000000, length: 64
    }))), { cpu: "arm9", address: 0x02000000, length: 64 });
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("disassemble", {
        cpu: "arm9", address: 0x02000000, count: 8, mode: "auto"
    }))), { cpu: "arm9", address: 0x02000000, count: 8, mode: "auto" });
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const normalized = normalizeWorkerRpcParams("injectBytes", { address: 0x02000000, bytes });
    assert.deepEqual(Array.from(normalized.bytes), [0, 1, 2, 255]);
    assert.notEqual(normalized.bytes, bytes);
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerTrigger({ kind: "exec", address: 0x02000000, callbackId: 1 }))), {
        kind: "exec", address: 0x02000000, callbackId: 1
    });
    const seen = new Set();
    assert.deepEqual(JSON.parse(JSON.stringify(validateWorkerRpc({
        id: "rpc-1", command: "status", params: { concise: true }
    }, seen))), { command: "status", params: { concise: true } });
    assert.deepEqual(JSON.parse(JSON.stringify(validateWorkerRpc({
        id: "rpc-speed", command: "setSpeed", params: { speed: 4 }
    }, seen))), { command: "setSpeed", params: { speed: 4 } });
    assert.deepEqual(JSON.parse(JSON.stringify(validateWorkerRpc({
        id: "rpc-persistent", command: "runPersistentScript", params: { name: "child", code: "return [];" }
    }, seen))), {
        command: "runPersistentScript",
        params: { name: "child", code: "return [];" }
    });
    assert.deepEqual(JSON.parse(JSON.stringify(validateWorkerRpc({
        id: "rpc-baseline", command: "restoreAnalysisBaseline", params: { name: "before-menu" }
    }, seen))), {
        command: "restoreAnalysisBaseline",
        params: { name: "before-menu" }
    });
});

test("persistent service owns direct script breakpoints", async () => {
    const source = await readFile(new URL("../src/script-service.js", import.meta.url), "utf8");
    assert.match(source, /ownedBreakpointIds: new Set\(\)/);
    assert.match(source, /script\.ownedBreakpointIds\.add/);
    assert.match(source, /for \(const ownerId of \[\.\.\.script\.ownedBreakpointIds\]\)/);
});

test("normalizer rejects unsafe explicit limits", () => {
    for (const value of [Infinity, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => normalizeBoundedValue("ok", { maxBytes: value }), /maxBytes/);
    }
    assert.throws(() => normalizeBoundedValue({ payload: "ok" }, {
        stringLimits: { payload: Infinity }
    }), /stringLimits\.payload/);
    assert.throws(() => normalizeBoundedValue({ payload: [1] }, {
        specialArrays: { payload: { kind: "byte", maxItems: Infinity } }
    }), /maxItems/);
    assert.throws(() => normalizeBoundedValue([1, 2], { maxArray: 1 }), /item budget/);
    assert.throws(() => normalizeBoundedValue({ a: 1, b: 2 }, { maxProperties: 1, maxArray: 2 }), /property budget/);
});

test("Worker command schema lookup treats reserved object names as ordinary command names", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("__proto__", {
        payload: "small"
    }))), { payload: "small" });
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("constructor", {
        payload: "small"
    }))), { payload: "small" });
});

test("byte command aliases share decoded-size enforcement", () => {
    const tools = createBinaryTools({ getPc: () => 0, getSelectedCpu: () => "arm9" });
    for (const params of [
        { base64: "AQID" },
        { hex: "01 02 03" },
        { input: "010203" },
        { text: "01,02,03" }
    ]) {
        assert.deepEqual(Array.from(tools.bytesFromFlexibleParams(params, 3)), [1, 2, 3]);
        assert.throws(() => tools.bytesFromFlexibleParams(params, 2), /exceeds 2 decoded bytes/);
    }
    assert.deepEqual(tools.opcodeWordsFromInput({ words: [1, 2] }, 2), [1, 2]);
    assert.deepEqual(tools.opcodeWordsFromInput({ opcodes: [1, 2] }, 2), [1, 2]);
    assert.deepEqual(Array.from(tools.bytesFromFlexibleParams({ bytes: ["0x01", "ff"] }, 2)), [1, 255]);
    assert.deepEqual(tools.opcodeWordsFromInput({ words: ["0x12345678"] }, 1), [0x12345678]);
    assert.deepEqual(tools.opcodeWordsFromInput({ opcodes: ["0xe12fff1e"] }, 1), [0xe12fff1e]);
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("injectBytes", {
        bytes: ["0x01", "ff"]
    }))), { bytes: ["0x01", "ff"] });
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeWorkerRpcParams("disassembleBytes", {
        words: ["0x12345678"], opcodes: ["0xe12fff1e"]
    }))), { words: ["0x12345678"], opcodes: ["0xe12fff1e"] });
    assert.throws(() => tools.opcodeWordsFromInput({ words: [1, 2, 3] }, 2), /exceeds 2 words/);
    assert.throws(() => tools.opcodeWordsFromInput({ opcodes: [1, 2, 3] }, 2), /exceeds 2 words/);
    assert.throws(() => normalizeWorkerRpcParams("injectBytes", {
        base64: "A".repeat(1398108)
    }), /field budget/);
    assert.throws(() => normalizeWorkerRpcParams("disassembleBytes", {
        words: new Array(16385).fill(0)
    }), /item budget/);
});

test("eval sandbox exposes no network, DOM, Window, sub-Worker, or code-generation capability", async () => {
    const harmless = await runEvalSandbox('return "plain text"');
    assert.equal(harmless.messages.find((message) => message.type === "done")?.result, "plain text");

    const capabilities = await runEvalSandbox(`
        return {
            window: typeof window,
            document: typeof document,
            HTMLElement: typeof HTMLElement,
            fetch: typeof fetch,
            xhr: typeof XMLHttpRequest,
            socket: typeof WebSocket,
            worker: typeof Worker,
            post: typeof postMessage,
            eval: typeof eval,
            localStorage: typeof localStorage,
            sessionStorage: typeof sessionStorage,
            objectConstructor: typeof ({}).constructor,
            functionConstructor: typeof (() => {}).constructor,
            close: typeof close,
            selfClose: typeof self.close
        };
    `);
    const done = capabilities.messages.find((message) => message.type === "done");
    assert.deepEqual(JSON.parse(JSON.stringify(done.result)), {
        window: "undefined",
        document: "undefined",
        HTMLElement: "undefined",
        fetch: "undefined",
        xhr: "undefined",
        socket: "undefined",
        worker: "undefined",
        post: "undefined",
        eval: "undefined",
        localStorage: "undefined",
        sessionStorage: "undefined",
        objectConstructor: "undefined",
        functionConstructor: "undefined",
        close: "undefined",
        selfClose: "undefined"
    });
    assert.equal(capabilities.networkCalls, 0);
    assert.equal(capabilities.storageCalls, 0);

    const storage = await runEvalSandbox(`
        try { localStorage.setItem("rom", "leak"); } catch {}
        try { sessionStorage.getItem("rom"); } catch {}
        return "blocked";
    `);
    assert.equal(storage.messages.find((message) => message.type === "done")?.result, "blocked");
    assert.equal(storage.storageCalls, 0);

    assert.equal(capabilities.messages.some((message) => message.type === "done"
        && message.result?.post !== "undefined"), false);
});

async function runPersistentScalarSandbox(
    code = 'const lr = await memory.reg("r14", "arm9"); const seed = await memory.read32(0x02385f0c, "arm9"); print(lr, seed);',
    replies = [0x02075628, 0x12345678]
) {
    const source = await bundledWorkerSource("../src/workers/persistent-script.worker.js");
    const messages = [];
    const listeners = new Map();
    let networkCalls = 0;
    let storageCalls = 0;
    const ContextTextEncoder = class extends TextEncoder {};
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder: ContextTextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {},
        setTimeout: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        setInterval: (handler) => {
            if (typeof handler === "string") networkCalls++;
            else handler();
        },
        fetch: () => { networkCalls++; return Promise.resolve({ ok: true }); },
        XMLHttpRequest: function XMLHttpRequest() { networkCalls++; },
        WebSocket: function WebSocket() { networkCalls++; },
        EventSource: function EventSource() { networkCalls++; },
        Worker: function Worker() { networkCalls++; },
        SharedWorker: function SharedWorker() { networkCalls++; },
        importScripts: () => { networkCalls++; },
        close: () => { networkCalls++; },
        BroadcastChannel: function BroadcastChannel() { networkCalls++; },
        WebTransport: function WebTransport() { networkCalls++; },
        indexedDB: {},
        caches: {},
        localStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        },
        sessionStorage: {
            getItem: () => { storageCalls++; },
            setItem: () => { storageCalls++; }
        }
    });
    vm.runInContext(source, context, { filename: "persistent-script.worker.js" });
    const dependency = await bundledDependency("../src/dependencies/acorn.entry.js", "__desmumeAcorn");
    await listeners.get("message")({ data: { type: "initialize", dependency } });
    const start = listeners.get("message")({
        data: {
            type: "start",
            code,
            scriptInstanceId: "sandbox-instance-1",
            shortcuts: []
        }
    });
    let handled = 0;
    for (let attempt = 0; handled < replies.length && attempt < 50; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const calls = messages.filter((message) => message.type === "call" || message.type === "register");
        while (handled < calls.length) {
            const reply = replies[handled];
            const result = calls[handled].type === "register"
                ? { id: reply }
                : { ok: true, value: reply };
            await listeners.get("message")({
                data: reply?.error
                    ? { replyId: calls[handled].id, error: reply.error }
                    : { replyId: calls[handled].id, result }
            });
            handled++;
        }
    }
    if (handled !== replies.length) {
        throw new Error(`persistent scalar RPC stalled: ${messages.map((message) => message.type).join(",")}`);
    }
    await start;
    return {
        messages,
        networkCalls,
        storageCalls,
        dispatch: (data) => listeners.get("message")({ data }),
        dispatchCloned: (data) => listeners.get("message")({
            data: vm.runInContext(`(${JSON.stringify(data)})`, context)
        })
    };
}

async function bundledScriptServiceModule() {
    if (!scriptServiceModulePromise) {
        scriptServiceModulePromise = (async () => {
            const workerSources = new Map();
            for (const relativeUrl of [
                "../src/workers/persistent-script-supervisor.worker.js",
                "../src/workers/persistent-script.worker.js",
                "../src/workers/parser.worker.js"
            ]) {
                const absolute = fileURLToPath(new URL(relativeUrl, import.meta.url));
                workerSources.set(absolute, await bundledWorkerSource(relativeUrl));
            }
            const result = await esbuild.build({
                entryPoints: [fileURLToPath(new URL("../src/script-service.js", import.meta.url))],
                bundle: true,
                write: false,
                platform: "node",
                format: "esm",
                logLevel: "silent",
                plugins: [{
                    name: "test-embedded-workers",
                    setup(build) {
                        build.onLoad({ filter: /\.worker\.js$/ }, (args) => ({
                            contents: `export default ${JSON.stringify(workerSources.get(args.path))};`,
                            loader: "js"
                        }));
                    }
                }]
            });
            return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
        })();
    }
    return scriptServiceModulePromise;
}

test("persistent sandbox accepts harmless text output", async () => {
    const { messages } = await runPersistentScalarSandbox('print("plain text");', []);
    assert.ok(messages.some((message) => message.type === "started"));
    assert.ok(messages.some((message) => message.type === "print" && message.values[0] === "plain text"));
    assert.equal(messages.some((message) => message.type === "failed"), false);
});

test("persistent baseline callbacks save and restore prototype-safe JSON", async () => {
    const harness = await runPersistentScalarSandbox(`
        emu_registerbaseline(
            async () => JSON.parse('{"__proto__":{"polluted":true},"counter":7}'),
            async (value, context) => print("restored", value.__proto__.polluted, value.counter, context.blocking),
            7
        );
    `, []);
    assert.equal(harness.messages.find((message) => message.type === "baselineHookRegistered")?.priority, 7);
    await harness.dispatch({
        type: "baselineHookInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 1,
        operation: "save",
        name: "before-menu"
    });
    for (let attempt = 0; attempt < 50
        && !harness.messages.some((message) => message.type === "baselineHookResult" && message.callId === 1);
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const saved = harness.messages.find((message) => message.type === "baselineHookResult" && message.callId === 1);
    assert.equal(saved.ok, true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(saved.value)),
        JSON.parse('{"__proto__":{"polluted":true},"counter":7}')
    );
    assert.equal({}.polluted, undefined);

    await harness.dispatch({
        type: "baselineHookInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 2,
        operation: "restore",
        name: "before-menu",
        value: saved.value
    });
    for (let attempt = 0; attempt < 50
        && !harness.messages.some((message) => message.type === "baselineHookResult" && message.callId === 2);
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(harness.messages.find((message) => (
        message.type === "baselineHookResult" && message.callId === 2
    ))?.ok, true);
    assert.ok(harness.messages.some((message) => (
        message.type === "print"
        && JSON.stringify(Array.from(message.values)) === JSON.stringify(["restored", true, 7, true])
    )));
    assert.equal({}.polluted, undefined);
});

test("persistent baseline callbacks run in deterministic priority order", async () => {
    const { createScriptService } = await bundledScriptServiceModule();
    const state = { scripts: new Map(), activeScriptId: 0 };
    const posted = [];
    let service;
    const makeScript = (id, name, priority, codeSha256) => ({
        id,
        name,
        running: true,
        started: true,
        scriptInstanceId: `${name}-instance`,
        baselineHookRegistered: true,
        baselinePriority: priority,
        pscriptMcpPublished: true,
        pscriptMcps: new Map(),
        pendingPScriptMcpCalls: new Map(),
        inFlightPScriptMcpCalls: new Map(),
        expiredPScriptMcpCalls: new Map(),
        nextPScriptMcpCallId: 1,
        pendingBaselineHookCalls: new Map(),
        inFlightBaselineHookCalls: new Map(),
        nextBaselineHookCallId: 1,
        eventQueue: [],
        eventBusy: false,
        worker: {
            postMessage: (message) => {
                posted.push({name, operation: message.operation});
                queueMicrotask(() => service.finishBaselineHookCall(
                    state.scripts.get(id),
                    {
                        scriptInstanceId: `${name}-instance`,
                        callId: message.callId,
                        operation: message.operation,
                        ok: true,
                        value: {priority}
                    }
                ));
            }
        },
        code: `${name} source`,
        codeSha256,
        output: [],
        triggers: [],
        ownedBreakpointIds: new Set()
    });
    const low = makeScript(1, "low", -10, "a".repeat(64));
    const high = makeScript(2, "high", 10, "b".repeat(64));
    state.scripts.set(low.id, low);
    state.scripts.set(high.id, high);
    service = createScriptService({
        state,
        ui: {},
        responder,
        breakpointOwners: {},
        ensureRomLoaded: () => {},
        finishPersistentScriptEvent: async () => true,
        requestPersistentScriptResume: () => true,
        settlePersistentScriptCallbacks: async () => {},
        hex: String,
        parseAddress: Number,
        rawOutputText: JSON.stringify,
        runCommand: async () => ({}),
        getCommands: () => ({}),
        onExplicitPause: () => {}
    });
    const entries = await service.captureAnalysisBaselineScriptState("priority-test");
    assert.deepEqual(posted, [
        {name: "low", operation: "save"},
        {name: "high", operation: "save"}
    ]);
    assert.deepEqual(entries.map(({name, priority}) => ({name, priority})), [
        {name: "low", priority: -10},
        {name: "high", priority: 10}
    ]);
});

test("persistent baseline registration tolerates missing callbacks and undefined state", async () => {
    const missing = await runPersistentScalarSandbox(`
        print("registered", emu_registerbaseline(undefined, null));
    `, []);
    assert.equal(missing.messages.some((message) => message.type === "failed"), false);
    assert.ok(missing.messages.some((message) => (
        message.type === "print" && Array.from(message.values).includes(false)
    )));

    const empty = await runPersistentScalarSandbox(`
        emu_registerbaseline(async () => undefined, async () => null);
    `, []);
    await empty.dispatch({
        type: "baselineHookInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 1,
        operation: "save",
        name: "empty"
    });
    for (let attempt = 0; attempt < 50
        && !empty.messages.some((message) => message.type === "baselineHookResult");
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const result = empty.messages.find((message) => message.type === "baselineHookResult");
    assert.equal(result.ok, true);
    assert.equal(result.value, null);
});

test("persistent top-level runtime errors report the user source location", async () => {
    const harness = await runPersistentScalarSandbox(`const before = true;
throw new Error("line marker");`, []);
    const failure = harness.messages.find((message) => message.type === "failed");
    assert.equal(failure.phase, "runtime");
    assert.equal(failure.error.details.line, 2);
    assert.ok(Number.isSafeInteger(failure.error.details.column));
    assert.equal(failure.error.details.sourceName, "desmume-persistent-user.js");
    assert.match(failure.error.details.sourceExcerpt, /line marker/);
});

test("persistent sandbox preserves application RPC errors without a protocol failure", async () => {
    const { messages } = await runPersistentScalarSandbox(`
        try {
            await mcp.call("missingCommand", {});
        } catch (error) {
            print(error.code, error.message);
        }
    `, [{
        error: {
            code: "UNKNOWN_COMMAND",
            message: "Unknown command: missingCommand",
            details: { command: "missingCommand" }
        }
    }]);
    const printed = messages
        .filter((message) => message.type === "print")
        .flatMap((message) => Array.from(message.values, String));
    assert.ok(printed.includes("UNKNOWN_COMMAND"));
    assert.ok(printed.some((value) => value.includes("missingCommand")));
    assert.equal(messages.some((message) => message.type === "failed"), false);
});

test("persistent callback accepts implicit undefined and undefined print arguments", async () => {
    const harness = await runPersistentScalarSandbox(`
        await memory.registerwrite(0x02000010, (hit) => {
            print("write callback", hit.frame);
        }, { cpu: "arm9" });
    `, [1]);
    const registration = harness.messages.find((message) => message.type === "register");
    assert.ok(registration);
    await harness.dispatch({
        type: "event",
        event: "write",
        eventId: 41,
        callbackId: registration.trigger.callbackId,
        callbackToken: "write-callback",
        payload: {
            address: "0x02000010",
            pc: "0x02000020",
            value: "0x00000001",
            cpu: "arm9"
        }
    });
    for (let attempt = 0; attempt < 50
        && !harness.messages.some((message) => message.type === "eventDone" && message.eventId === 41);
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const printed = harness.messages
        .filter((message) => message.type === "print")
        .flatMap((message) => Array.from(message.values, String));
    assert.ok(printed.includes("write callback"));
    assert.ok(printed.includes("undefined"));
    assert.equal(printed.some((value) => value.includes("callback error")), false);
    assert.ok(harness.messages.some((message) => message.type === "eventDone" && message.eventId === 41));
});

test("persistent memory callback errors identify the API, address input, and trigger", async () => {
    const harness = await runPersistentScalarSandbox(`
        await memory.registerexec(0x02000010, async () => {
            await memory.read32(undefined, "arm9");
        }, { cpu: "arm9" });
    `, [1]);
    const registration = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({
        type: "event",
        event: "exec",
        eventId: 42,
        callbackId: registration.trigger.callbackId,
        triggerId: 731,
        callbackToken: "exec-callback",
        payload: { address: "0x02000010", pc: "0x02000010", value: "0x00000000", cpu: "arm9" }
    });
    for (let attempt = 0; attempt < 50
        && !harness.messages.some((message) => message.type === "eventDone" && message.eventId === 42);
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const line = harness.messages
        .filter((message) => message.type === "print")
        .flatMap((message) => Array.from(message.values, String))
        .find((value) => value.includes("callback error"));
    assert.match(line, /memoryReadDword/);
    assert.match(line, /inputAddress/);
    const detailMarker = " details=";
    const details = JSON.parse(line.slice(line.indexOf(detailMarker) + detailMarker.length));
    assert.equal(details.triggerId, 731);
    assert.notEqual(details.triggerId, registration.trigger.callbackId);
});

test("persistent-script legacy memory reads remain numeric", async () => {
    const { messages } = await runPersistentScalarSandbox();
    const printed = messages.find((message) => message.type === "print");
    assert.deepEqual(Array.from(printed.values), [0x02075628, 0x12345678]);
    assert.equal(String(printed.values[0]).includes("[object Object]"), false);
});

test("persistent sandbox publishes and invokes bounded MCP handlers", async () => {
    const harness = await runPersistentScalarSandbox(`
        return [
            {
                name: "listActions",
                description: "  Lists available actions.  ",
                handler: async (params, context) => [
                    { id: params.id, enabled: true, blocking: context.blocking }
                ]
            },
            {
                name: "domainFailure",
                description: "Returns application data containing ok false.",
                handler: async () => ({ ok: false, reason: "not-selected" })
            }
        ];
    `, []);
    const published = harness.messages.find((message) => message.type === "pscriptMcpPublished");
    assert.deepEqual(JSON.parse(JSON.stringify(published.mcps)), [
        { name: "listActions", description: "Lists available actions." },
        { name: "domainFailure", description: "Returns application data containing ok false." }
    ]);

    await harness.dispatchCloned({
        type: "pscriptMcpInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 1,
        name: "listActions",
        params: { id: "menu.item" },
        blocking: true
    });
    await harness.dispatchCloned({
        type: "pscriptMcpInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 2,
        name: "domainFailure",
        params: {},
        blocking: false
    });
    for (let attempt = 0; attempt < 50
        && harness.messages.filter((message) => message.type === "pscriptMcpResult").length < 2;
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const results = harness.messages.filter((message) => message.type === "pscriptMcpResult");
    assert.equal(results[0].ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(results[0].value)), [
        { id: "menu.item", enabled: true, blocking: true }
    ]);
    assert.equal(results[1].ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(results[1].value)), {
        ok: false,
        reason: "not-selected"
    });
});

test("persistent sandbox serializes blocking MCP calls with events in FIFO order", async () => {
    const harness = await runPersistentScalarSandbox(`
        const order = [];
        await emu_registerstart(async () => { order.push("event"); });
        return [{
            name: "append",
            description: "Appends one label and returns the observed order.",
            handler: async ({ label }, context) => {
                order.push(label);
                return { order: [...order], blocking: context.blocking };
            }
        }];
    `, [71]);
    const registration = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({
        type: "event",
        event: "start",
        eventId: 81,
        callbackId: registration.trigger.callbackId,
        callbackToken: "fifo-event",
        payload: {}
    });
    await harness.dispatchCloned({
        type: "pscriptMcpInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 11,
        name: "append",
        params: { label: "first" },
        blocking: true
    });
    await harness.dispatchCloned({
        type: "pscriptMcpInvoke",
        scriptInstanceId: "sandbox-instance-1",
        callId: 12,
        name: "append",
        params: { label: "second" },
        blocking: true
    });
    for (let attempt = 0; attempt < 50
        && harness.messages.filter((message) => message.type === "pscriptMcpResult").length < 2;
        attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const results = harness.messages.filter((message) => message.type === "pscriptMcpResult");
    assert.deepEqual(JSON.parse(JSON.stringify(results[0].value.order)), ["event", "first"]);
    assert.deepEqual(JSON.parse(JSON.stringify(results[1].value.order)), ["event", "first", "second"]);
});

test("persistent sandbox rejects duplicate published MCP names", async () => {
    const harness = await runPersistentScalarSandbox(`
        return [
            { name: "same", description: "First.", handler: async () => 1 },
            { name: "same", description: "Second.", handler: async () => 2 }
        ];
    `, []);
    const failure = harness.messages.find((message) => message.type === "failed");
    assert.equal(failure.phase, "runtime");
    assert.match(failure.error.message, /duplicate persistent MCP name/);
});

test("persistent sandbox exposes no network, messaging, storage, or code-generation capability", async () => {
    const { messages, networkCalls, storageCalls } = await runPersistentScalarSandbox(`
        print(
            typeof fetch,
            typeof Worker,
            typeof postMessage,
            typeof localStorage,
            typeof sessionStorage,
            typeof eval,
            typeof Function
        );
    `, []);
    assert.equal(networkCalls, 0);
    assert.equal(storageCalls, 0);
    const printed = messages.find((message) => message.type === "print");
    assert.deepEqual(Array.from(printed.values), [
        "undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined"
    ]);
});

test("Ctable script registers hooks and lets the coordinator resume after callbacks", async () => {
    const workerSource = await bundledWorkerSource("../src/workers/persistent-script.worker.js");
    const ctableSource = await readFile(new URL("../scripts/dq9/Ctable_jp.js", import.meta.url), "utf8");
    const messages = [];
    const listeners = new Map();
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {}
    });
    vm.runInContext(workerSource, context, { filename: "persistent-script.worker.js" });
    const dependency = await bundledDependency("../src/dependencies/acorn.entry.js", "__desmumeAcorn");
    await listeners.get("message")({ data: { type: "initialize", dependency } });
    let startupComplete = false;
    const startup = listeners.get("message")({
        data: { type: "start", code: ctableSource, shortcuts: [] }
    }).then(() => { startupComplete = true; });
    let handled = 0;
    for (let attempt = 0; !startupComplete && attempt < 500; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const requests = messages.filter((message) => message.type === "register" || message.type === "call");
        while (handled < requests.length) {
            const request = requests[handled++];
            const value = request.type === "register"
                ? { id: request.trigger.callbackId }
                : request.command === "memoryReadDword"
                    ? { ok: true, value: request.params.address === 0x02385f0c ? 0x12345678 : 0x89abcdef }
                    : { ok: true };
            await listeners.get("message")({ data: { replyId: request.id, result: value } });
        }
    }
    await startup;
    const registered = messages.filter((message) => message.type === "register");
    assert.ok(registered.length >= 20);
    const startupPrint = messages.filter((message) => message.type === "print").flatMap((message) => message.values.map(String));
    assert.ok(startupPrint.some((value) => value.includes("seed1 native: 0x78563412")));
    assert.ok(startupPrint.some((value) => value.includes("seed2 native: 0xefcdab89")));
    assert.equal(startupPrint.some((value) => value.includes("[object Object]")), false);

    const first = registered[0];
    listeners.get("message")({
        data: {
            type: "event", event: "exec", eventId: 77,
            callbackId: first.trigger.callbackId, callbackToken: "callback-token", payload: {}
        }
    });
    let eventDone = false;
    for (let attempt = 0; !eventDone && attempt < 100; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const requests = messages.filter((message) => message.type === "register" || message.type === "call");
        while (handled < requests.length) {
            const request = requests[handled++];
            let result = { ok: true };
            if (request.command === "memoryGetRegister") {
                result = {
                    ok: true,
                    value: request.params.register === "r0"
                        ? 0x02385f0c
                        : request.params.register === "r14"
                            ? 0x11111111
                            : 5
                };
            }
            await listeners.get("message")({ data: { replyId: request.id, result } });
        }
        eventDone = messages.some((message) => message.type === "eventDone" && message.eventId === 77);
    }
    assert.equal(eventDone, true);
    assert.equal(messages.some((message) => message.type === "call" && message.command === "resume"), false);
    const callbackPrint = messages.filter((message) => message.type === "print").flatMap((message) => message.values.map(String));
    assert.ok(callbackPrint.some((value) => value.includes("lr 0x11111111")));
    assert.equal(callbackPrint.some((value) => value.includes("[object Object]")), false);
});

test("overlay script registers load/unload/tick hooks and reports overlay transitions", async () => {
    const workerSource = await bundledWorkerSource("../src/workers/persistent-script.worker.js");
    const overlaySource = await readFile(new URL("../scripts/dq9/overlay_jp.js", import.meta.url), "utf8");
    const messages = [];
    const listeners = new Map();
    let buttonValue = 0;
    let overlayId = 2;
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {}
    });
    vm.runInContext(workerSource, context, { filename: "persistent-script.worker.js" });
    const dependency = await bundledDependency("../src/dependencies/acorn.entry.js", "__desmumeAcorn");
    await listeners.get("message")({ data: { type: "initialize", dependency } });

    const resultFor = (request) => {
        if (request.type === "register") return { id: request.trigger.callbackId };
        if (request.command === "memoryReadByte") {
            if (request.params.address === 0x04000130) return { ok: true, value: buttonValue };
            const slot = request.params.address - 0x01ffd384;
            return { ok: true, value: slot === 0 ? 2 : 0xff };
        }
        if (request.command === "memoryReadDword") {
            if (request.params.address === 0x020e9034 + 2 * 8) return { ok: true, value: 0x03000000 };
            if (request.params.address === 0x01ffd3b4 + 2 * 0x2c + 4) return { ok: true, value: 0x00000002 };
        }
        if (request.command === "memoryGetRegister") {
            return { ok: true, value: request.params.register === "r0" ? overlayId : 0x11111111 };
        }
        throw new Error(`unexpected overlay request: ${request.command || request.type}`);
    };
    let handled = 0;
    const drainUntil = async (predicate, attempts = 500) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const requests = messages.filter((message) => message.type === "register" || message.type === "call");
            while (handled < requests.length) {
                const request = requests[handled++];
                await listeners.get("message")({
                    data: { replyId: request.id, result: resultFor(request) }
                });
            }
            if (predicate()) return;
            await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error(`overlay script stalled: ${messages.map((message) => message.type).join(",")}`);
    };

    let startupComplete = false;
    const startup = listeners.get("message")({
        data: { type: "start", code: overlaySource, shortcuts: [] }
    }).then(() => { startupComplete = true; });
    await drainUntil(() => startupComplete);
    await startup;

    const registrations = messages.filter((message) => message.type === "register");
    assert.deepEqual(registrations.map((message) => [message.trigger.kind, message.trigger.address]), [
        ["exec", 0x020a36b8],
        ["exec", 0x020a392c],
        ["tick", 0]
    ]);
    const startupPrint = messages.filter((message) => message.type === "print")
        .flatMap((message) => message.values.map(String));
    assert.ok(startupPrint.includes("slot 0: id 2 start 0x02000000"));
    assert.ok(startupPrint.includes("overlay logger registered; press the original button chord to toggle output"));

    const runEvent = async (registration, eventId, event, payload = {}) => {
        void listeners.get("message")({
            data: {
                type: "event", event, eventId,
                callbackId: registration.trigger.callbackId,
                callbackToken: `overlay-callback-${eventId}`,
                payload
            }
        });
        await drainUntil(() => messages.some((message) => (
            message.type === "eventDone" && message.eventId === eventId
        )));
    };

    await runEvent(registrations[0], 91, "exec");
    await runEvent(registrations[1], 92, "exec");
    buttonValue = 7;
    await runEvent(registrations[2], 93, "tick", { frame: 60 });
    overlayId = undefined;
    await runEvent(registrations[0], 94, "exec");

    const allPrint = messages.filter((message) => message.type === "print")
        .flatMap((message) => message.values.map(String));
    assert.ok(allPrint.includes("overlay loaded: slot 3, id 2, start 0x02000000, caller: 0x11111111"));
    assert.ok(allPrint.includes("overlay unloaded: slot 0x00000003, id 2"));
    assert.ok(allPrint.includes("overlay log disabled"));
    assert.ok(allPrint.includes("overlay event ignored: trigger 0x020a36b8, invalid r0 undefined"));
    assert.equal(allPrint.some((value) => value.includes("callback error")), false);
    assert.equal(messages.some((message) => message.type === "call" && message.command === "resume"), false);
    assert.equal(messages.some((message) => message.type === "failed"), false);
});

async function runEvalSupervisor(childMessage) {
    const source = await bundledWorkerSource("../src/workers/eval-supervisor.worker.js");
    const messages = [];
    let listener;
    let revoked = false;
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
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => { revoked = true; } }
    });
    context.onmessage = null;
    vm.runInContext(source, context, { filename: "eval-supervisor.worker.js" });
    listener = context.onmessage;
    const dependency = { source: "dependency", sha256: "dependency-hash" };
    listener({ data: {
        type: "run", code: "return 1", parserSource: "parser", sandboxSource: "sandbox", dependency, shortcuts: []
    } });
    const parser = workers[0];
    assert.deepEqual(JSON.parse(JSON.stringify(parser.messages[0])), { type: "initialize", dependency });
    parser.onmessage({ data: {
        type: "ready", hardened: true, layer: "parser", channelToken: "parser-secret",
        dependencyHash: dependency.sha256
    } });
    parser.onmessage({ data: { type: "parsed", channelToken: "parser-secret" } });
    const child = workers[1];
    child.onmessage({ data: {
        type: "ready", hardened: true, layer: "sandbox", channelToken: "secret"
    } });
    child.onmessage({ data: childMessage });
    return { messages, child, listener, revoked: () => revoked };
}

test("eval supervisor forwards authenticated sandbox completion and shutdown cleanup", async () => {
    const valid = await runEvalSupervisor({ type: "done", result: 1, channelToken: "secret" });
    assert.ok(valid.messages.some((message) => message.type === "done" && message.result === 1));
    assert.equal(valid.messages.some((message) => "channelToken" in message), false);

    valid.listener({ data: { type: "shutdown", requestId: "cleanup-1" } });
    const ack = valid.messages.find((message) => message.type === "shutdownAck");
    assert.equal(ack.requestId, "cleanup-1");
    assert.deepEqual(JSON.parse(JSON.stringify(ack.cleanup)), {
        childWorkerTerminateCalled: true,
        childBlobUrlRevokeCalled: true,
        childHandlersCleared: true,
        childPendingRpcAfter: 0
    });
    assert.equal(valid.revoked(), true);
});

test("persistent supervisor gates replies for authenticated child messages", async () => {
    const source = await bundledWorkerSource("../src/workers/persistent-script-supervisor.worker.js");
    const messages = [];
    const workers = [];
    class FakeWorker {
        constructor() { this.messages = []; this.terminated = false; workers.push(this); }
        postMessage(message) { this.messages.push(message); }
        terminate() { this.terminated = true; }
    }
    const context = vm.createContext({
        postMessage: (message) => messages.push(message),
        TextEncoder,
        Blob: class Blob {}, Worker: FakeWorker,
        URL: { createObjectURL: () => "blob:persistent", revokeObjectURL: () => {} }
    });
    context.onmessage = null;
    vm.runInContext(source, context, { filename: "persistent-script-supervisor.worker.js" });
    const dependency = { source: "dependency", sha256: "dependency-hash" };
    context.onmessage({ data: {
        type: "start", code: "return 1", scriptInstanceId: "instance-1",
        parserSource: "parser", sandboxSource: "sandbox", dependency, shortcuts: []
    } });
    const parser = workers[0];
    assert.deepEqual(JSON.parse(JSON.stringify(parser.messages[0])), { type: "initialize", dependency });
    parser.onmessage({ data: {
        type: "ready", hardened: true, layer: "parser", channelToken: "parser-secret",
        dependencyHash: dependency.sha256
    } });
    parser.onmessage({ data: { type: "parsed", channelToken: "parser-secret" } });
    const child = workers[1];
    child.onmessage({ data: {
        type: "ready", hardened: true, layer: "sandbox", channelToken: "secret"
    } });
    const childOnMessage = child.onmessage;
    const validChildCall = vm.runInContext(`({
        type: "call", id: "request-1", command: "status", params: {}, channelToken: "secret"
    })`, context);
    childOnMessage({ data: validChildCall });
    assert.ok(messages.some((message) => message.type === "call" && message.id === "request-1"));
    context.onmessage({ data: { replyId: "request-1", result: { ok: true } } });
    assert.ok(child.messages.some((message) => message.replyId === "request-1"));

    const published = vm.runInContext(`({
        type: "pscriptMcpPublished",
        mcps: [{ name: "listActions", description: "Lists actions." }],
        channelToken: "secret"
    })`, context);
    childOnMessage({ data: published });
    assert.ok(messages.some((message) => message.type === "pscriptMcpPublished"
        && message.scriptInstanceId === "instance-1"));

    const invocation = vm.runInContext(`({
        type: "pscriptMcpInvoke",
        scriptInstanceId: "instance-1",
        callId: 3,
        name: "listActions",
        params: {},
        blocking: true
    })`, context);
    context.onmessage({ data: invocation });
    assert.ok(child.messages.some((message) => message.type === "pscriptMcpInvoke"
        && message.callId === 3));
    const childResult = vm.runInContext(`({
        type: "pscriptMcpResult",
        scriptInstanceId: "instance-1",
        callId: 3,
        ok: true,
        value: [{ id: "menu.item" }],
        channelToken: "secret"
    })`, context);
    childOnMessage({ data: childResult });
    assert.ok(messages.some((message) => message.type === "pscriptMcpResult"
        && message.callId === 3 && message.value[0].id === "menu.item"));
});

test("all bundled supervisor and sandbox Worker sources parse as classic scripts", async () => {
    for (const path of [
        "../src/workers/eval-supervisor.worker.js",
        "../src/workers/persistent-script-supervisor.worker.js"
    ]) {
        const source = await bundledWorkerSource(path);
        assert.doesNotThrow(() => new vm.Script(source, { filename: path }), path);
    }
    for (const path of [
        "../src/workers/eval.worker.js",
        "../src/workers/persistent-script.worker.js",
        "../src/workers/parser.worker.js",
        "../src/workers/algorithm.worker.js"
    ]) {
        const source = await bundledWorkerSource(path);
        assert.doesNotThrow(() => new vm.Script(source, { filename: path }), path);
    }
});

test("page CSP permits the embedded single-file WASM data fetch", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    assert.match(html, /connect-src 'self' data:/);
});

test("DQ9 overlay logger validates register IDs before table address arithmetic", async () => {
    const source = await readFile(new URL("../scripts/dq9/overlay_jp.js", import.meta.url), "utf8");
    assert.match(source, /const MAX_OVERLAY_ID = 0x3f/);
    assert.match(source, /checkedOverlayId\(await reg\("r0"\), 0x020a36b8\)/);
    assert.match(source, /checkedOverlayId\(await reg\("r0"\), 0x020a392c\)/);
});

function baselineDispatcherHarness(operation = "restore") {
    const deferredEffects = [];
    const state = {
        ready: false,
        fileTransactionActive: true,
        fileTransactionReason: "Analysis baseline restore",
        analysisBaselineOperation: {
            operationId: 17,
            phase: `${operation}-hooks`,
            operation,
            deferredEffects,
            activeHookIdentity: {
                operationId: 17,
                scriptId: 3,
                scriptInstanceId: "baseline-script",
                baselineHookCallId: 9,
                save: operation
            }
        }
    };
    const registry = createCommandRegistry({ responder });
    registry.register("waitForFileTransaction", async () => responder.ok());
    registry.register("waitForStateLoad", async () => responder.ok());
    registry.register("setSpeed", async () => responder.ok());
    registry.register("setScale", async () => responder.ok());
    registry.register("setRotation", async () => responder.ok());
    registry.register("setAudio", async () => responder.ok());
    return {
        state,
        deferredEffects,
        dispatcher: createCommandDispatcher({
            state, registry, responder, operationManager: { current: () => null },
            hasLoadedRom: () => false, emulatorActivity: () => ({}), updateStatus: () => {}, log: () => {}
        }),
        metadata: (params = {}) => withInternalMetadata(params, state.analysisBaselineOperation.activeHookIdentity)
    };
}

async function createControlledPersistentSandbox(code) {
    const source = await bundledWorkerSource("../src/workers/persistent-script.worker.js");
    const messages = [];
    const listeners = new Map();
    const timers = new Map();
    let timerId = 0;
    const schedule = (handler, interval) => {
        const id = ++timerId;
        timers.set(id, { handler, interval });
        return id;
    };
    const context = vm.createContext({
        console,
        crypto: testCrypto(),
        TextEncoder,
        postMessage: (message) => messages.push(message),
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: () => {},
        setTimeout: (handler) => schedule(handler, false),
        setInterval: (handler) => schedule(handler, true),
        clearTimeout: (id) => timers.delete(id),
        clearInterval: (id) => timers.delete(id)
    });
    vm.runInContext(source, context, { filename: "persistent-script.worker.js" });
    const listener = listeners.get("message");
    const dependency = await bundledDependency("../src/dependencies/acorn.entry.js", "__desmumeAcorn");
    await listener({ data: { type: "initialize", dependency } });
    const start = listener({ data: {
        type: "start", code, scriptInstanceId: "controlled-instance", shortcuts: []
    } });
    let handled = 0;
    for (let attempt = 0; attempt < 50 && !messages.some((message) => message.type === "started"); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        const requests = messages.filter((message) => message.type === "register" || message.type === "call");
        while (handled < requests.length) {
            const request = requests[handled++];
            assert.equal(request.type, "register", "startup must not issue an unexpected MCP call");
            await listener({ data: { replyId: request.id, result: { id: request.trigger.callbackId } } });
        }
    }
    await start;
    const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 50; attempt++) {
            if (predicate()) return;
            await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error(`controlled persistent sandbox timed out: ${label}`);
    };
    return {
        messages,
        dispatch: (data) => listener({ data }),
        fireTimers: () => {
            for (const { handler } of [...timers.values()]) handler();
        },
        waitFor
    };
}

test("baseline integration 1: a save hook holds queued production events until the barrier releases", async () => {
    const harness = await createControlledPersistentSandbox(`
        emu_registerbaseline(async () => ({ counter: 1 }), async () => {});
        await emu_ontick(async () => print("normal-event"));
    `);
    const tick = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({ type: "baselineBarrier", active: true, operationId: 1, operation: "save" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineBarrierAck" && message.active), "acquire save barrier");
    await harness.dispatch({ type: "event", event: "tick", eventId: 101, callbackId: tick.trigger.callbackId, payload: {} });
    await harness.dispatch({ type: "baselineHookInvoke", scriptInstanceId: "controlled-instance", callId: 1, operation: "save", name: "before-save" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineHookResult" && message.callId === 1), "save hook result");
    assert.equal(harness.messages.some((message) => message.type === "print" && message.values[0] === "normal-event"), false);
    await harness.dispatch({ type: "baselineBarrier", active: false, operationId: 1, operation: "save" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "eventDone" && message.eventId === 101), "released save event");
    assert.equal(harness.messages.some((message) => message.type === "print" && message.values[0] === "normal-event"), true);
});

test("baseline integration 2: a restore hook holds queued production events until release", async () => {
    const harness = await createControlledPersistentSandbox(`
        emu_registerbaseline(async () => null, async () => print("restore-hook"));
        await emu_ontick(async () => print("normal-event"));
    `);
    const tick = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({ type: "baselineBarrier", active: true, operationId: 2, operation: "restore" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineBarrierAck" && message.operationId === 2 && message.active), "acquire restore barrier");
    await harness.dispatch({ type: "event", event: "tick", eventId: 102, callbackId: tick.trigger.callbackId, payload: {} });
    await harness.dispatch({ type: "baselineHookInvoke", scriptInstanceId: "controlled-instance", callId: 2, operation: "restore", name: "before-restore", value: null });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineHookResult" && message.callId === 2), "restore hook result");
    assert.equal(harness.messages.some((message) => message.type === "print" && message.values[0] === "normal-event"), false);
    await harness.dispatch({ type: "baselineBarrier", active: false, operationId: 2, operation: "restore" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "eventDone" && message.eventId === 102), "released restore event");
    assert.equal(harness.messages.some((message) => message.type === "print" && message.values[0] === "normal-event"), true);
});

test("baseline integration 3: production timeout and interval callbacks coalesce behind the barrier", async () => {
    const harness = await createControlledPersistentSandbox(`
        let count = 0;
        setTimeout(() => print("timeout", ++count), 1);
        setInterval(() => print("interval", ++count), 1);
    `);
    await harness.dispatch({ type: "baselineBarrier", active: true, operationId: 3, operation: "save" });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineBarrierAck" && message.operationId === 3 && message.active), "acquire timer barrier");
    harness.fireTimers();
    harness.fireTimers();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.messages.some((message) => message.type === "print"), false);
    await harness.dispatch({ type: "baselineBarrier", active: false, operationId: 3, operation: "save" });
    await harness.waitFor(() => harness.messages.filter((message) => message.type === "print").length === 2, "released timer callbacks");
    assert.deepEqual(harness.messages.filter((message) => message.type === "print").map((message) => message.values[0]), ["timeout", "interval"]);
});

test("baseline integration 4: a barrier acknowledgement waits for in-flight blocking MCP work", async () => {
    const harness = await createControlledPersistentSandbox(`
        await emu_ontick(async () => { await mcp.call("status", {}); });
    `);
    const tick = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({ type: "event", event: "tick", eventId: 104, callbackId: tick.trigger.callbackId, payload: {} });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "call" && message.command === "status"), "blocking MCP start");
    const call = harness.messages.find((message) => message.type === "call" && message.command === "status");
    await harness.dispatch({ type: "baselineBarrier", active: true, operationId: 4, operation: "save" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.messages.some((message) => message.type === "baselineBarrierAck" && message.operationId === 4), false);
    await harness.dispatch({ replyId: call.id, result: { ok: true } });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "baselineBarrierAck" && message.operationId === 4 && message.active), "quiescent barrier acknowledgement");
});

test("baseline integration 5: real state command reports post-native draw failures as partial", async () => {
    const commands = createStateCommands({ analysisBaselineSlotToken: Symbol("baseline"), ensureRomLoaded: () => {},
        isAnalysisBaselineSlot: () => false, native: { loadBufferedState: () => 0, pause: () => {} }, state: {}, ui: {},
        fileTransactionService: { run: async (_reason, task) => task({ commit: async () => {} }) }, pauseForFileLoad: () => ({ paused: true }),
        restoreAfterFileLoad: () => {}, stopAfterFailedStateLoad: () => {}, drawLoadedStateFrame: () => { throw new Error("draw"); },
        blockSaveFlush: () => {}, dispatchScriptEvent: () => {} });
    await assert.rejects(commands.loadState({}), (error) => error.mcpCode === "STATE_PARTIALLY_RESTORED");
});

test("baseline restore converts post-native pause failures to a paused partial restore", async () => {
    const state = { analysisBaselines: new Map() };
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:", analysisBaselineSlotToken: Symbol("baseline"), ensureRomLoaded: () => {}, state, ui: {},
        readAnalysisBaseline: () => ({
            name: "before-menu", slot: "baseline-state", stateSize: 1, stateSha256: "state",
            romName: "game.nds", romSize: 1, romSha256: "rom", persistentScripts: []
        }),
        currentRomIdentity: async () => ({ romName: "game.nds", romSize: 1, romSha256: "rom" }),
        idbGet: async () => new Uint8Array([1]), sha256Hex: async () => "state",
        call: async () => ({ ok: true }), getRegisters: () => ({ pc: 0, cpsr: 0 }), native: { pause: () => { throw new Error("pause failed"); } }
    });
    await assert.rejects(commands.restoreAnalysisBaseline({ name: "before-menu" }), (error) => (
        error.mcpCode === "STATE_PARTIALLY_RESTORED" && error.mcpDetails.nativeStateApplied === true && error.mcpDetails.paused === true
    ));
    assert.equal(state.paused, true);
    assert.equal(state.running, false);
});

test("baseline integration 6: pre-native baseline hash mismatch remains STATE_INVALID", async () => {
    let loadCalls = 0;
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:", analysisBaselineSlotToken: Symbol("baseline"), ensureRomLoaded: () => {},
        state: { analysisBaselines: new Map() }, ui: {},
        readAnalysisBaseline: () => ({
            name: "before-menu", slot: "baseline-state", stateSize: 1, stateSha256: "expected-state",
            romName: "game.nds", romSize: 1, romSha256: "rom", persistentScripts: []
        }),
        currentRomIdentity: async () => ({ romName: "game.nds", romSize: 1, romSha256: "rom" }),
        idbGet: async () => new Uint8Array([1]), sha256Hex: async () => "wrong-state",
        call: async () => { loadCalls++; return { ok: true }; }
    });
    await assert.rejects(commands.restoreAnalysisBaseline({ name: "before-menu" }), (error) => error.mcpCode === "STATE_INVALID");
    assert.equal(loadCalls, 0);
});

test("baseline integration 7: restore releases barriers before one usable stateLoad callback", async () => {
    const order = [];
    const state = { analysisBaselines: new Map(), romGeneration: 1, fileTransactionActive: false };
    const baseline = {
        name: "before-menu", slot: "baseline-state", stateSize: 1, stateSha256: "state",
        romName: "game.nds", romSize: 1, romSha256: "rom", persistentScripts: []
    };
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:", analysisBaselineSlotToken: Symbol("baseline"),
        ensureRomLoaded: () => {}, state, ui: { traceToggle: { checked: false }, tracePrivilegeToggle: { checked: false } },
        readAnalysisBaseline: () => baseline, currentRomIdentity: async () => ({ romName: "game.nds", romSize: 1, romSha256: "rom" }),
        idbGet: async () => new Uint8Array([1]), sha256Hex: async () => "state", snapshotContext: async () => ({}),
        getRegisters: () => ({ pc: 0, cpsr: 0 }), native: { pause: () => {} },
        acquireBaselineBarriers: async () => { order.push("acquire"); },
        releaseBaselineBarriers: async () => { order.push("release"); },
        fileTransactionService: { run: async (_reason, task) => {
            state.fileTransactionActive = true;
            try { return await task({ token: "restore", commit: async () => order.push("commit") }); }
            finally { state.fileTransactionActive = false; }
        } },
        restoreAnalysisBaselineScriptState: async () => {
            order.push("restore-hooks");
            state.analysisBaselineOperation.deferredEffects.push({ command: "setSpeed", params: { speed: 2 } });
        },
        call: async (name) => { order.push(name); return { ok: true }; },
        dispatchScriptEvent: (name) => {
            assert.equal(name, "stateLoad");
            assert.equal(state.analysisBaselineOperation, null);
            assert.equal(state.fileTransactionActive, false);
            order.push("stateLoad");
        }
    });
    await commands.restoreAnalysisBaseline({ name: "before-menu" });
    assert.ok(order.indexOf("restore-hooks") < order.indexOf("setSpeed"));
    assert.ok(order.indexOf("setSpeed") < order.indexOf("release"));
    assert.deepEqual(order.slice(-2), ["release", "stateLoad"]);
    assert.equal(order.filter((item) => item === "stateLoad").length, 1);
});

test("baseline integration 8: matching hook waitForFileTransaction is rejected immediately", async () => {
    const h = baselineDispatcherHarness();
    assert.equal((await h.dispatcher.run("waitForFileTransaction", h.metadata())).error.code, "COMMAND_NOT_ALLOWED");
});

test("baseline integration 9: matching hook waitForStateLoad is rejected immediately", async () => {
    const h = baselineDispatcherHarness();
    assert.equal((await h.dispatcher.run("waitForStateLoad", h.metadata())).error.code, "COMMAND_NOT_ALLOWED");
});

test("baseline integration 10: external deferred effect is busy and never queued", async () => {
    const h = baselineDispatcherHarness();
    assert.equal((await h.dispatcher.run("setSpeed", { speed: 1 })).error.code, "BUSY");
    assert.deepEqual(h.deferredEffects, []);
});

test("baseline integration 11: hook effect validation uses production validator before enqueue", async () => {
    const h = baselineDispatcherHarness();
    assert.equal((await h.dispatcher.run("setSpeed", h.metadata({ speed: 9 }))).error.code, "INVALID_ARGUMENT");
    for (const params of [{ scale: 9 }, { rotation: 45 }, { enabled: true, volume: 2 }]) {
        const command = "scale" in params ? "setScale" : "rotation" in params ? "setRotation" : "setAudio";
        assert.equal((await h.dispatcher.run(command, h.metadata(params))).error.code, "INVALID_ARGUMENT");
    }
    assert.deepEqual(h.deferredEffects, []);
});

test("baseline integration 12: storage-v1 restore rejects same-session missing and mismatched script data", async () => {
    const baseline = {
        name: "before-menu", slot: "baseline-state", stateSize: 1, stateSha256: "state",
        romName: "game.nds", romSize: 1, romSha256: "rom", persistentScriptsStorageVersion: 1,
        persistentScripts: [{ name: "inline-cache-must-not-be-used" }], persistentScriptsSlot: "baseline-scripts",
        persistentScriptsSize: 2, persistentScriptsSha256: "scripts"
    };
    for (const scripts of [null, new Uint8Array([91, 93])]) {
        let loadCalls = 0;
        const commands = createContextCommands({
            ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:", analysisBaselineSlotToken: Symbol("baseline"),
            ensureRomLoaded: () => {}, state: { analysisBaselines: new Map() }, ui: {}, readAnalysisBaseline: () => baseline,
            currentRomIdentity: async () => ({ romName: "game.nds", romSize: 1, romSha256: "rom" }),
            idbGet: async (slot) => slot === "baseline-state" ? new Uint8Array([1]) : scripts,
            sha256Hex: async (bytes) => bytes[0] === 1 ? "state" : "wrong-script-hash",
            call: async () => { loadCalls++; return { ok: true }; }
        });
        await assert.rejects(commands.restoreAnalysisBaseline({ name: "before-menu" }), (error) => error.mcpCode === "STATE_INVALID");
        assert.equal(loadCalls, 0);
    }
});

test("baseline integration 13: baseline manifest records the post-commit file-load run state", async () => {
    const state = { analysisBaselines: new Map(), romGeneration: 1 };
    let manifest;
    const commands = createContextCommands({
        ANALYSIS_BASELINE_SLOT_PREFIX: "analysis:", ensureRomLoaded: () => {}, state,
        ui: { traceToggle: { checked: false }, tracePrivilegeToggle: { checked: false } }, native: { saveStateBytes: () => new Uint8Array([1]), pause: () => {} },
        getRegisters: () => ({ pc: 0, cpsr: 0 }), currentRomIdentity: async () => ({ romName: "game.nds", romSize: 1, romSha256: "rom" }),
        emulatorActivity: () => ({ running: true, paused: false }), pauseForFileLoad: () => ({ running: false, paused: true }),
        restoreAfterFileLoad: () => {}, captureAnalysisBaselineScriptState: async () => [], validateAnalysisBaselineScriptState: async () => [],
        sha256Hex: async () => "hash", idbPut: async () => {}, idbDelete: async () => {}, writeAnalysisBaseline: (_name, value) => { manifest = value; },
        readAnalysisBaseline: () => null, fileTransactionService: { run: async (_reason, task) => task({ commit: async () => {} }) }
    });
    await commands.saveAnalysisBaseline({ name: "before-menu" });
    assert.equal(manifest.running, false);
    assert.equal(manifest.paused, true);
});

test("baseline integration 14: production callback diagnostics remain structured through script summaries", async () => {
    const harness = await createControlledPersistentSandbox(`
        await emu_ontick(async () => { throw new Error("structured callback marker"); });
    `);
    const tick = harness.messages.find((message) => message.type === "register");
    await harness.dispatch({ type: "event", event: "tick", eventId: 114, callbackId: tick.trigger.callbackId, payload: {} });
    await harness.waitFor(() => harness.messages.some((message) => message.type === "callbackError"), "structured callback error");
    const workerError = harness.messages.find((message) => message.type === "callbackError").error.details;
    const { createScriptService } = await bundledScriptServiceModule();
    const script = {
        id: 14, name: "diagnostic", running: true, started: true, asyncMode: false, triggers: [],
        pscriptMcps: new Map(), pscriptMcpPublished: true, baselineHookRegistered: false, baselinePriority: 0,
        lastError: { phase: "callback", ...workerError }
    };
    const service = createScriptService({ state: { scripts: new Map([[14, script]]) }, ui: {}, responder, breakpointOwners: {},
        ensureRomLoaded: () => {}, finishPersistentScriptEvent: async () => true, requestPersistentScriptResume: () => true,
        settlePersistentScriptCallbacks: async () => {}, hex: String, parseAddress: Number, rawOutputText: JSON.stringify,
        runCommand: async () => ({}), getCommands: () => ({}), onExplicitPause: () => {} });
    const summary = service.scriptSummary(script);
    assert.equal(summary.lastError.phase, "callback");
    assert.ok(Number.isSafeInteger(summary.lastError.line));
    assert.ok(Number.isSafeInteger(summary.lastError.column));
    assert.equal(summary.lastError.sourceName, "desmume-persistent-user.js");
    assert.match(summary.lastError.sourceExcerpt, /structured callback marker/);
});

test("baseline integration 15: bundled worker preserves user mcp call-site stacks", async () => {
    const harness = await runPersistentScalarSandbox(`\n        try { await mcp.call("missingCommand", {}); } catch (error) { print(error.stack); }\n    `, [{ error: { code: "UNKNOWN_COMMAND", message: "missing" } }]);
    const printed = harness.messages.find((message) => message.type === "print");
    assert.match(String(printed?.values?.[0] || ""), /desmume-persistent-user/);
});
