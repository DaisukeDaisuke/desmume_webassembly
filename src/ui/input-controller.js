import { codedError } from "../validation.js";
import { ErrorCode } from "../error-codes.js";

export function createInputController({ state, ui }) {
    function normalizeButton(button) {
        const name = String(button);
        if (!Object.prototype.hasOwnProperty.call(state.buttons, name)) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `unknown button: ${name}`);
        }
        return name;
    }

    function toButtonList(params = {}) {
        const buttons = Array.isArray(params.buttons)
            ? params.buttons
            : [params.button].filter(Boolean);
        if (!buttons.length) throw new Error("button or buttons is required");
        return buttons.map(normalizeButton);
    }

    function setKey(button, pressed) {
        button = normalizeButton(button);
        const bit = state.buttons[button];
        if (pressed) state.keys |= 1 << bit;
        else state.keys &= ~(1 << bit);
        document.querySelectorAll("[data-button]").forEach((element) => {
            if (element.dataset.button === button) element.dataset.down = pressed ? "true" : "false";
        });
    }

    function releaseAllKeys() {
        Object.keys(state.buttons).forEach((button) => setKey(button, false));
    }

    function setTouchState(active, x = 0, y = 0) {
        state.touch = {
            active: !!active,
            x: Number(x) || 0,
            y: Number(y) || 0
        };
    }

    function isTypingTarget(element = document.activeElement) {
        if (!element) return false;
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
        if (element instanceof HTMLInputElement) {
            const nonTextTypes = new Set([
                "button", "checkbox", "color", "file", "hidden", "image", "radio", "range",
                "reset", "submit"
            ]);
            return !nonTextTypes.has(String(element.type || "text").toLowerCase());
        }
        return !!element.isContentEditable;
    }

    function eventToTouch(event) {
        const rect = ui.screenShell.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const canvasWidth = 256 * state.scale;
        const canvasHeight = 384 * state.scale;
        const radians = -state.rotation * Math.PI / 180;
        const deltaX = event.clientX - centerX;
        const deltaY = event.clientY - centerY;
        const localX = deltaX * Math.cos(radians) - deltaY * Math.sin(radians) + canvasWidth / 2;
        const localY = deltaX * Math.sin(radians) + deltaY * Math.cos(radians) + canvasHeight / 2;
        const screenX = localX / Math.max(1, canvasWidth);
        const screenY = localY / Math.max(1, canvasHeight);
        if (screenX < 0 || screenX > 1 || screenY < 0.5 || screenY > 1) return null;
        return {
            x: Math.round(Math.min(255, Math.max(0, screenX * 255))),
            y: Math.round(Math.min(191, Math.max(0, (screenY - 0.5) * 2 * 191)))
        };
    }

    function updateTouch(event, active) {
        const position = eventToTouch(event);
        if (!position) {
            state.touch = { active: false, x: 0, y: 0 };
            return;
        }
        state.touch = { active, x: position.x, y: position.y };
    }

    return Object.freeze({
        eventToTouch,
        isTypingTarget,
        releaseAllKeys,
        setKey,
        setTouchState,
        toButtonList,
        updateTouch
    });
}
