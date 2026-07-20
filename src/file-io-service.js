export function createFileIoService() {
    function download(name, bytes, type = "application/octet-stream") {
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(new Blob([bytes], { type }));
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }

    function readInput(input) {
        return new Promise((resolve, reject) => {
            const file = input.files && input.files[0];
            if (!file) {
                reject(new Error("file not selected"));
                return;
            }
            file.arrayBuffer().then((buffer) => {
                input.value = "";
                resolve({ file, bytes: new Uint8Array(buffer) });
            }, reject);
        });
    }

    function openPicker(input) {
        input.value = "";
        input.click();
        return new Promise((resolve, reject) => {
            input.onchange = () => readInput(input).then(resolve, reject);
        });
    }

    return Object.freeze({ download, openPicker, readInput });
}
