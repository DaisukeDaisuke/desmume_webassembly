export function createRuntimeLoader({
    loadRuntime,
    getApi,
    timeoutMs = 30000,
    onStart = () => {},
    onLoaded = () => {},
    onError = () => {}
}) {
    let api = null;
    let inFlight = null;
    let error = null;
    let attempts = 0;
    let activeAttempt = 0;

    async function ensureLoaded() {
        if (api) return api;
        if (inFlight) return inFlight;
        const attempt = ++attempts;
        activeAttempt = attempt;
        error = null;
        onStart(attempt);
        let timer = 0;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`emulator runtime load timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
        const loading = Promise.resolve()
            .then(loadRuntime)
            .then(() => {
                const candidate = getApi();
                if (!candidate || typeof candidate.call !== "function") {
                    throw new Error("emulator runtime did not publish its command API");
                }
                return candidate;
            });
        const current = Promise.race([loading, timeout])
            .then((candidate) => {
                if (attempt !== activeAttempt) {
                    throw new Error("stale emulator runtime load attempt");
                }
                api = candidate;
                onLoaded(candidate, attempt);
                return candidate;
            })
            .catch((loadError) => {
                if (attempt === activeAttempt) {
                    activeAttempt = 0;
                    error = loadError;
                    onError(loadError, attempt);
                }
                throw loadError;
            })
            .finally(() => {
                clearTimeout(timer);
                if (inFlight === current) inFlight = null;
            });
        inFlight = current;
        return current;
    }

    return Object.freeze({
        ensureLoaded,
        api: () => api,
        status: () => ({
            loaded: !!api,
            loading: !!inFlight,
            attempts,
            error: error ? String(error.message || error) : null
        })
    });
}
