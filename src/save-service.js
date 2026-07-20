export function createSaveService({ native, romService }) {
    function writeForRom(name, bytes) {
        const path = String(name).toLowerCase().endsWith(".dsv") ? "rom.dsv" : "rom.sav";
        native.unlinkFile("rom.dsv");
        native.unlinkFile("rom.sav");
        native.writeFile(path, bytes);
        return { path, ret: 0 };
    }

    async function applyAndReload(name, bytes, options = {}) {
        const saveLoad = writeForRom(name, bytes);
        const result = await romService.reload(options);
        return { ...saveLoad, ret: result };
    }

    function exportBytes() {
        return native.exportSaveBytes();
    }

    return Object.freeze({ applyAndReload, exportBytes, writeForRom });
}
