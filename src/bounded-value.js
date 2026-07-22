import { normalizeTrustedValue } from "./trusted-value-normalizer.js";

export function normalizeBoundedValue(value, options = {}) {
    return normalizeTrustedValue(value, options);
}
