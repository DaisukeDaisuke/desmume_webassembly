export function createScreenshotCommands(context) {
    const { requireValidScreen, state, ui } = context;

    return {
        async takeScreenshot(params = {}) {
            const screenError = requireValidScreen();
            if (screenError) return screenError;
            const cooldownMs = Math.max(250, Number(params.cooldownMs ?? 1200));
            if (performance.now() < state.screenshotCooldownUntil) {
                throw new Error("screenshot cooldown active");
            }
            state.screenshotCooldownUntil = performance.now() + cooldownMs;
            const type = "image/png";
            const name = String(params.name || `desmume-${Date.now()}.png`);
            const dataUrl = ui.screen.toDataURL(type);
            if (params.download !== false) {
                const link = document.createElement("a");
                link.href = dataUrl;
                link.download = name;
                link.click();
            }
            return {
                ok: true,
                type,
                name,
                width: ui.screen.width,
                height: ui.screen.height,
                cooldownMs,
                dataUrl: params.includeDataUrl ? dataUrl : undefined
            };
        }
    };
}
