import { ErrorCode } from "./error-codes.js";

export function breakpointSiteKey({ cpu, type, address }) {
    return `${cpu}:${type}:${Number(address) >>> 0}`;
}

export function createBreakpointOwnerStore({ onFirstOwner = () => {}, onLastOwner = () => {} } = {}) {
    const sites = new Map();
    const ids = new Map();

    function getSite(key) {
        return sites.get(typeof key === "string" ? key : breakpointSiteKey(key));
    }

    function getOwners(key) {
        return [...(getSite(key)?.owners.values() || [])];
    }

    function classifySite(key) {
        const owners = getOwners(key).filter((owner) => owner.enabled !== false);
        const has = (origin) => owners.some((owner) => owner.origin === origin);
        return {
            scriptOnly: owners.length > 0 && owners.every((owner) => owner.origin === "script"),
            userVisible: has("user"),
            operationOwned: has("operation"),
            mixed: has("script") && (has("user") || has("operation")),
            owners
        };
    }

    return {
        addOwner(site, owner) {
            const key = breakpointSiteKey(site);
            if (ids.has(owner.id)) {
                const error = new Error(`breakpoint owner ID already exists: ${owner.id}`);
                error.mcpCode = ErrorCode.BREAKPOINT_EXISTS;
                error.mcpDetails = { id: owner.id, existingSite: ids.get(owner.id), requestedSite: key };
                throw error;
            }
            let entry = sites.get(key);
            if (!entry) {
                entry = {
                    ...site,
                    key,
                    address: Number(site.address) >>> 0,
                    owners: new Map()
                };
                sites.set(key, entry);
            }
            const first = entry.owners.size === 0;
            entry.owners.set(owner.id, { enabled: true, ...owner });
            ids.set(owner.id, key);
            if (first) onFirstOwner(entry);
            return entry;
        },
        removeOwner(ownerId) {
            const key = ids.get(ownerId);
            const entry = key && sites.get(key);
            if (!entry) return null;
            const owner = entry.owners.get(ownerId);
            entry.owners.delete(ownerId);
            ids.delete(ownerId);
            if (!entry.owners.size) {
                sites.delete(key);
                onLastOwner(entry);
            }
            return { entry, owner };
        },
        findBreakpointById(ownerId) {
            const key = ids.get(ownerId);
            return key ? sites.get(key) : null;
        },
        getSite,
        getOwners,
        classifySite,
        list() {
            return [...sites.values()];
        },
        hasWaitableBreakpoints({ includeScripts = false } = {}) {
            return [...sites.values()].some((entry) => {
                const classification = classifySite(entry.key);
                return classification.userVisible
                    || classification.operationOwned
                    || (includeScripts && classification.scriptOnly);
            });
        }
    };
}
