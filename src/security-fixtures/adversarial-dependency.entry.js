const visible = (name) => globalThis[name] !== undefined;
const constructorVisible = (value) => {
    try { return typeof value?.constructor === "function"; } catch { return false; }
};
let stringTimeoutAccepted = false;
try {
    globalThis.setTimeout("globalThis.__forbiddenTimer = true", 0);
    stringTimeoutAccepted = true;
} catch {}
let cryptoMutationAccepted = false;
try {
    if (globalThis.crypto) {
        globalThis.crypto.randomUUID = () => "forged";
        cryptoMutationAccepted = globalThis.crypto.randomUUID() === "forged";
    }
} catch {}
const dangerousPrototypeNames = new Set([
    "fetch", "postMessage", "close", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror"
]);
let prototypeCapabilityVisible = false;
let symbolCapabilityVisible = false;
let getterCapabilityVisible = false;
let currentPrototype = Object.getPrototypeOf(globalThis);
while (currentPrototype) {
    for (const key of Reflect.ownKeys(currentPrototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(currentPrototype, key);
        const keyName = typeof key === "symbol" ? String(key.description || key) : key;
        if (dangerousPrototypeNames.has(keyName) && descriptor?.value !== undefined) prototypeCapabilityVisible = true;
        if (typeof key === "symbol" && [...dangerousPrototypeNames].some((name) => keyName.includes(name))) {
            symbolCapabilityVisible = true;
        }
        if (dangerousPrototypeNames.has(keyName)
            && (typeof descriptor?.get === "function" || typeof descriptor?.set === "function")) {
            getterCapabilityVisible = true;
        }
    }
    currentPrototype = Object.getPrototypeOf(currentPrototype);
}

export const results = Object.freeze({
    fetchVisible: visible("fetch"),
    xhrVisible: visible("XMLHttpRequest"),
    websocketVisible: visible("WebSocket"),
    eventSourceVisible: visible("EventSource"),
    rawPostMessageVisible: visible("postMessage"),
    addEventListenerVisible: visible("addEventListener"),
    workerVisible: visible("Worker") || visible("SharedWorker") || visible("importScripts"),
    storageVisible: visible("localStorage") || visible("sessionStorage") || visible("indexedDB") || visible("caches"),
    evalVisible: visible("eval"),
    functionConstructorVisible: visible("Function") || constructorVisible(() => {})
        || constructorVisible(async () => {}) || constructorVisible(function* () {}),
    stringTimeoutAccepted,
    closeVisible: visible("close"),
    domVisible: visible("document") || visible("window") || visible("parent"),
    cryptoMutationAccepted,
    workerGlobalConstructorVisible: visible("WorkerGlobalScope") || visible("DedicatedWorkerGlobalScope"),
    eventTargetConstructorVisible: visible("EventTarget"),
    prototypeCapabilityVisible,
    symbolCapabilityVisible,
    getterCapabilityVisible
});
