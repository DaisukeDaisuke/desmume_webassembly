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
    cryptoMutationAccepted
});
