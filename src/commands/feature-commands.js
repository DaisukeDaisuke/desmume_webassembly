export function createFeatureCommands(context) {
    const { native, ui } = context;

    return {
        async setFeatureSet(params = {}) {
            ui.debugToggle.checked = params.debugger !== false;
            ui.memoryAuto.value = params.memory === false ? "0" : ui.memoryAuto.value;
            native.setDebuggerEnabled(ui.debugToggle.checked);
            return {
                debugger: ui.debugToggle.checked,
                memoryAuto: ui.memoryAuto.value
            };
        }
    };
}
