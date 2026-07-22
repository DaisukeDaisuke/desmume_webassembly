export const ResourceLimits = Object.freeze({
    batchCommands: 64,
    batchResultBytes: 1024 * 1024,
    concurrentEvalWorkers: 4,
    persistentScripts: 8,
    scriptTriggers: 64,
    pendingWorkerRpc: 32,
    pendingScriptEvents: 128,
    scriptOutputBytes: 256 * 1024,
    scriptSourceOutputChars: 64 * 1024,
    flattenDepth: 12,
    flattenNodes: 2000,
    flattenArrayItems: 256,
    flattenTextChars: 64 * 1024
});
