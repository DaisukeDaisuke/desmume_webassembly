export function createEmbeddedWorker(source) {
    let url;
    try {
        url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url);
        let disposed = false;
        return {
            worker,
            dispose() {
                if (disposed) return;
                disposed = true;
                worker.terminate();
                URL.revokeObjectURL(url);
            }
        };
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        throw error;
    }
}
