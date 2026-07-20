export function createDebuggerCoordinator({
    state,
    native,
    breakpointOwners,
    breakpointService,
    getQueueBreakpointRefresh,
    log,
    hex,
    updateStatus
}) {
    function breakpointKindName(kind) {
        return [
            "exec",
            "read",
            "write",
            "dataAbort",
            "prefetchAbort",
            "undefinedInstruction"
        ][Number(kind)] || "unknown";
    }

    function getNativeStatus() {
        return state.ready ? native.getStatus() : null;
    }

    function currentInstructionAddress(cpu = state.selectedCpu) {
        const status = getNativeStatus();
        const node = status && status[String(cpu).toLowerCase() === "arm7" ? "arm7" : "arm9"];
        return node ? Number(node.pc) >>> 0 : null;
    }

    function currentExecBreakpoint(cpu = state.selectedCpu, address = currentInstructionAddress(cpu)) {
        if (!Number.isFinite(address)) return null;
        return state.breakpoints.find((breakpoint) => (
            breakpoint.type === "exec"
            && breakpoint.cpu === String(cpu)
            && (breakpoint.address >>> 0) === (address >>> 0)
        )) || null;
    }

    async function withCurrentExecBreakpointSuspended(cpu, callback) {
        const address = currentInstructionAddress(cpu);
        const breakpoint = currentExecBreakpoint(cpu, address);
        if (breakpoint) native.setBreakpoint(cpu, "exec", address, false);
        try {
            return await callback(address);
        } finally {
            if (breakpoint) native.setBreakpoint(cpu, "exec", address, true);
        }
    }

    function matchingScriptTriggers(type, breakpoint) {
        return state.scriptTriggers.filter((trigger) => (
            trigger.type === type
            && (
                trigger.type === "dataAbort"
                || trigger.type === "prefetchAbort"
                || trigger.type === "undefinedInstruction"
                || (
                    trigger.cpu === String(breakpoint.cpu)
                    && trigger.address === (Number(breakpoint.address) >>> 0)
                )
            )
        ));
    }

    function finishPersistentScriptEvent(eventId) {
        const pending = state.pendingScriptEvents.get(Number(eventId));
        if (!pending || --pending.remaining > 0) return;
        state.pendingScriptEvents.delete(Number(eventId));
        if (pending.pauseSerial !== state.explicitPauseSerial || !native.hasLoadedRom()) return;

        // Exec hooks stop before the instruction. MMU read/write hooks have already
        // completed the access, so stepping those would duplicate the side effect.
        if (pending.type === "exec" && currentInstructionAddress(pending.cpu) === pending.address) {
            native.step(pending.cpu, 1);
            const statusAfterStep = getNativeStatus();
            if (statusAfterStep?.lastBreak?.hit) {
                syncNativeBreakStatus(statusAfterStep);
                updateStatus();
                return;
            }
        }
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.lastBreakKey = "";
        native.clearBreakStatus();
        state.paused = false;
        state.running = true;
        native.pause(false);
        updateStatus();
    }

    function dispatchScriptTriggers(triggers, breakpoint, type, autoResume) {
        const eventId = autoResume ? state.nextScriptEventId++ : 0;
        if (autoResume) {
            state.pendingScriptEvents.set(eventId, {
                remaining: triggers.length,
                pauseSerial: state.explicitPauseSerial,
                cpu: String(breakpoint.cpu),
                type,
                address: Number(breakpoint.address) >>> 0
            });
        }
        for (const trigger of triggers) {
            const script = state.scripts.get(trigger.scriptId);
            if (script?.running) {
                script.worker.postMessage({
                    type: "event",
                    eventId,
                    callbackId: trigger.callbackId,
                    event: type,
                    payload: {
                        ...breakpoint,
                        address: hex(breakpoint.address),
                        pc: hex(breakpoint.pc),
                        value: hex(breakpoint.value)
                    }
                });
            } else if (autoResume) {
                finishPersistentScriptEvent(eventId);
            }
        }
    }

    function syncNativeBreakStatus(status = null) {
        if (!state.ready) return null;
        const nativeStatus = status || native.getStatus();
        if (Number.isFinite(Number(nativeStatus.frame))) state.frame = Number(nativeStatus.frame);
        const breakpoint = nativeStatus.lastBreak;
        if (!breakpoint?.hit) return nativeStatus;

        state.paused = true;
        state.running = false;
        native.pause(true);
        const type = breakpointKindName(breakpoint.kind);
        state.breakLabel = `break ${type}`;
        const key = `${breakpoint.cpu}:${breakpoint.kind}:${breakpoint.address}:${breakpoint.pc}:${breakpoint.value}`;
        if (state.breakRefreshKey !== key) {
            state.breakRefreshKey = key;
            getQueueBreakpointRefresh()(String(breakpoint.cpu || state.selectedCpu));
        }
        if (state.lastBreakKey === key) return nativeStatus;

        state.lastBreakKey = key;
        log(`break ${type} ${breakpoint.cpu} at ${hex(breakpoint.address)} pc ${hex(breakpoint.pc)}`);
        const triggers = matchingScriptTriggers(type, breakpoint);
        const site = {
            type,
            cpu: String(breakpoint.cpu),
            address: Number(breakpoint.address) >>> 0
        };
        const classification = breakpointOwners.classifySite(site);
        breakpointService.publish({
            ...breakpoint,
            ...site,
            pc: Number(breakpoint.pc) >>> 0,
            value: Number(breakpoint.value) >>> 0
        });
        const autoResume = triggers.length > 0 && classification.scriptOnly;
        dispatchScriptTriggers(triggers, breakpoint, type, autoResume);
        return nativeStatus;
    }

    function getRegisters(cpu = state.selectedCpu) {
        native.ensureRomLoaded("Registers are unavailable because no ROM is loaded");
        const names = [
            "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11",
            "r12", "sp", "lr", "pc", "cpsr", "spsr"
        ];
        const values = {};
        for (let index = 0; index < names.length; index++) {
            values[names[index]] = native.getRegister(cpu, index);
        }
        values.r13 = values.sp;
        values.r14 = values.lr;
        values.r15 = values.pc;
        return values;
    }

    return Object.freeze({
        breakpointKindName,
        currentExecBreakpoint,
        currentInstructionAddress,
        finishPersistentScriptEvent,
        getNativeStatus,
        getRegisters,
        syncNativeBreakStatus,
        withCurrentExecBreakpointSuspended
    });
}
