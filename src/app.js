import { applyScreenLayout } from "./ui/screen-layout.js";

const ui = Object.fromEntries(
    [...document.querySelectorAll("[id]")]
        .map((element) => [element.id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), element])
);

function applyBootstrapLayout() {
    if (!ui.screenShell) return;
    applyScreenLayout(ui.screenShell, {
        scale: Number(ui.scaleSelect?.value || 2),
        rotation: Number(ui.rotationSelect?.value || 0)
    });
}

function removeBootstrapLayoutListeners() {
    ui.scaleSelect?.removeEventListener("change", applyBootstrapLayout);
    ui.rotationSelect?.removeEventListener("change", applyBootstrapLayout);
}

applyBootstrapLayout();
ui.scaleSelect?.addEventListener("change", applyBootstrapLayout);
ui.rotationSelect?.addEventListener("change", applyBootstrapLayout);

let runtimeLoadPromise = null;
let runtimeApi = null;
let runtimeLoadError = null;
let runtimeLoadAttempts = 0;

function unloadedStatus() {
    return {
        ok: true,
        ready: false,
        emulatorLoaded: false,
        emulatorLoading: !!runtimeLoadPromise,
        emulatorLoadError: runtimeLoadError
            ? String(runtimeLoadError.message || runtimeLoadError).slice(0, 500)
            : null,
        romLoaded: false,
        paused: true,
        running: false,
        operation: null,
        fileTransaction: { active: false, serial: 0, reason: "" },
        stateLoadSerial: 0,
        frame: 0
    };
}

function fail(code, message, details) {
    return {
        ok: false,
        error: {
            code,
            message,
            recoverable: true,
            ...(details === undefined ? {} : { details })
        }
    };
}

async function ensureEmulatorLoaded() {
    if (runtimeApi) return runtimeApi;
    if (runtimeLoadPromise) return runtimeLoadPromise;
    runtimeLoadError = null;
    runtimeLoadAttempts++;
    if (ui.readyText) ui.readyText.textContent = "loading emulator";
    runtimeLoadPromise = import("./emulator.js")
        .then(() => {
            const api = window.DesmumeMCP;
            if (!api || typeof api.call !== "function") {
                throw new Error("emulator runtime did not publish its command API");
            }
            runtimeApi = api;
            removeBootstrapLayoutListeners();
            return api;
        })
        .catch((error) => {
            runtimeLoadError = error;
            if (ui.readyText) ui.readyText.textContent = "emulator load failed — retry by loading ROM";
            throw error;
        })
        .finally(() => {
            runtimeLoadPromise = null;
        });
    return runtimeLoadPromise;
}

async function listStorageKeys() {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("desmume-web-debugger", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("states");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve, reject) => {
        const transaction = db.transaction("states", "readonly");
        const request = transaction.objectStore("states").getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
        request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
}

const bootstrapApi = {
    async call(name, params = {}) {
        if (runtimeApi) return runtimeApi.call(name, params);
        if (name === "status") return unloadedStatus();
        if (name === "getOperation") return { ok: true, operation: null };
        if (name === "cancelOperation") return { ok: true, cancelled: false, operation: null };
        if (name === "getInputState") {
            return { ok: true, keyMask: 0, buttons: [], touch: { active: false, x: 0, y: 0 } };
        }
        if (name === "releaseInput") {
            return { ok: true, keyMask: 0, buttons: [], touch: { active: false, x: 0, y: 0 } };
        }
        if (name === "listStateSlots" || name === "listSaveSlots") {
            const keys = await listStorageKeys();
            return {
                ok: true,
                slots: name === "listSaveSlots"
                    ? keys.filter((key) => key.startsWith("save:")).map((key) => key.slice(5))
                    : keys.filter((key) => (
                        !key.startsWith("save:")
                        && !key.startsWith("__analysis_baseline__:")
                        && !key.startsWith("input-recording:")
                    ))
            };
        }
        if (["loadRomFile", "loadRomBytes", "loadRomUrl"].includes(name)) {
            try {
                const api = await ensureEmulatorLoaded();
                return api.call(name, params);
            } catch (error) {
                return fail("WASM_NOT_READY", "emulator runtime could not be loaded", {
                    message: String(error?.message || error).slice(0, 500)
                });
            }
        }
        return fail("ROM_NOT_LOADED", `${name} requires a loaded ROM`, {
            emulatorLoaded: false,
            romLoaded: false
        });
    },
    list() {
        return {
            status: "Returns bootstrap status without loading the emulator runtime.",
            loadRomFile: "Loads the emulator runtime once, then loads a selected local ROM.",
            loadRomBytes: "Loads the emulator runtime once, then loads supplied ROM bytes.",
            loadRomUrl: "Loads the emulator runtime once, then fetches and loads the requested ROM.",
            warning: "This is a warning. The emulator main and web assembly have not yet been loaded into memory. This list may be incomplete!"
        };
    }
};

window.DesmumeMCP = bootstrapApi;
window.DesmumeRuntimeLoader = Object.freeze({
    ensureLoaded: ensureEmulatorLoaded,
    status: () => ({
        loaded: !!runtimeApi,
        loading: !!runtimeLoadPromise,
        attempts: runtimeLoadAttempts,
        error: runtimeLoadError ? String(runtimeLoadError.message || runtimeLoadError) : null
    })
});

function webMcpContent(result) {
    const structured = result && typeof result === "object" ? result : { ok: true, value: result };
    return {
        content: [{
            type: "text",
            text: JSON.stringify(structured)
        }],
        structuredContent: structured
    };
}

function parseWebMcpInput(input) {
    if (typeof input !== "string") return input || {};
    return input.trim() ? JSON.parse(input) : {};
}

async function registerBootstrapWebMcp() {
    const modelContext = ("modelContext" in document && document.modelContext)
        || ("modelContext" in navigator && navigator.modelContext);
    if (!modelContext || typeof modelContext.registerTool !== "function") return false;
    const withRuntime = (handler) => async (input = {}) => {
        try {
            const api = await ensureEmulatorLoaded();
            return webMcpContent(await handler(api, parseWebMcpInput(input)));
        } catch (error) {
            return webMcpContent(fail("WASM_NOT_READY", "emulator runtime could not be loaded", {
                message: String(error?.message || error).slice(0, 500)
            }));
        }
    };
    const tools = [{
        name: "desmume.list",
        title: "DeSmuME command list",
        description: "Loads the local DeSmuME runtime on demand, then lists its command surface.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: withRuntime((api) => api.list())
    }, {
        name: "desmume.call",
        title: "DeSmuME command",
        description: "Loads the local DeSmuME runtime on demand, then runs one local command.",
        inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string" },
                params: { type: "object", additionalProperties: true }
            },
            additionalProperties: false
        },
        execute: withRuntime((api, input) => api.call(String(input.command || ""), input.params || {}))
    }, {
        name: "desmume.eval",
        title: "DeSmuME eval",
        description: "Loads the local runtime, then runs isolated JavaScript in the hardened Worker sandbox.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" }, timeoutMs: { type: "number" } },
            additionalProperties: false
        },
        execute: withRuntime((api, input) => api.call("eval", input))
    }, {
        name: "desmume.runScript",
        title: "DeSmuME run script",
        description: "Loads the local runtime, then runs isolated JavaScript in the hardened Worker sandbox.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" }, timeoutMs: { type: "number" } },
            additionalProperties: false
        },
        execute: withRuntime((api, input) => api.call("runScript", input))
    }];
    for (const tool of tools) {
        try {
            await modelContext.registerTool(tool);
        } catch (error) {
            if (!/already|duplicate/i.test(String(error?.message || error))) throw error;
        }
    }
    return true;
}

void registerBootstrapWebMcp().catch((error) => {
    if (ui.readyText) ui.readyText.dataset.webmcpError = String(error?.message || error).slice(0, 200);
});

const loadSelectedRom = async () => {
    if (!ui.romFile.files?.length) return;
    const result = await bootstrapApi.call("loadRomFile", {});
    if (runtimeApi) ui.romFile.removeEventListener("change", loadSelectedRom);
    if (result?.ok === false && ui.readyText) {
        ui.readyText.textContent = result.error?.message || "ROM load failed";
    }
};
ui.romFile?.addEventListener("change", loadSelectedRom);

if (ui.readyText) ui.readyText.textContent = "select a ROM to load emulator";
