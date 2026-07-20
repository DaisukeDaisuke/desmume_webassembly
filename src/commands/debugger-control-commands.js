import { getInternalMetadata } from "../internal-command-metadata.js";

export function createDebuggerControlCommands(context) {
    const {
        breakpointOwners,
        copyText,
        ensureReady,
        ensureRomLoaded,
        hex,
        log,
        native,
        parseAddress,
        publicCallStackData,
        publicOtherCoroutines,
        readCallStackData,
        refreshDebuggerViews,
        renderBreakpoints,
        renderCallStack,
        resume,
        runDebuggerInstruction,
        runTraceStepper,
        runUntilNextBranchOrReturn,
        runUntilTrueNextBranch,
        state,
        status,
        ui,
        updateStatus
    } = context;

    const debuggerCommands = {
        async setBreakpoint(params) {
            ensureRomLoaded("breakpoints require a loaded ROM");
            if (params.id && params.enabled === false) {
                return debuggerCommands.removeBreakpoint({ id: params.id });
            }
            const explicitId = params.id === undefined ? null : Number(params.id);
            if (explicitId !== null && (
                !Number.isSafeInteger(explicitId)
                || explicitId <= 0
                || explicitId >= Number.MAX_SAFE_INTEGER
            )) {
                const error = new Error("breakpoint id must be a positive safe integer");
                error.mcpCode = "INVALID_ARGUMENT";
                throw error;
            }
            const id = explicitId ?? state.nextBreakpointId++;
            if (explicitId !== null) {
                state.nextBreakpointId = Math.max(state.nextBreakpointId, explicitId + 1);
            }
            const metadata = getInternalMetadata(params);
            const origin = String(metadata.origin || "user");
            const breakpoint = {
                id,
                cpu: String(params.cpu ?? state.selectedCpu),
                type: String(params.type ?? "exec"),
                address: parseAddress(params.address, 0, params.cpu),
                enabled: params.enabled !== false,
                origin
            };
            if (!breakpoint.enabled) {
                const existing = state.breakpoints.find((item) => (
                    item.cpu === breakpoint.cpu
                    && item.type === breakpoint.type
                    && item.address === breakpoint.address
                ));
                if (existing) return debuggerCommands.removeBreakpoint({ id: existing.id });
                return { ok: true, breakpoints: state.breakpoints };
            }
            breakpointOwners.addOwner(breakpoint, {
                id: breakpoint.id,
                origin,
                scriptId: metadata.scriptId,
                triggerId: metadata.triggerId,
                operationId: metadata.operationId
            });
            if (origin === "user") state.breakpoints.push(breakpoint);
            renderBreakpoints();
            refreshDebuggerViews({ keepHighlight: true }).catch((error) => log(error.message));
            return { id: breakpoint.id, breakpoints: state.breakpoints };
        },

        async setSpecialBreakpoint(params = {}) {
            ensureRomLoaded("special breakpoints require a loaded ROM");
            const kindMap = {
                dataAbort: 3,
                prefetchAbort: 4,
                undefinedInstruction: 5,
                undefined: 5
            };
            const kind = kindMap[String(params.kind)] ?? Number(params.kind);
            const ret = native.setSpecialBreakpoint(kind, params.enabled);
            if (params.kind === "dataAbort") ui.bpDataAbortToggle.checked = !!params.enabled;
            if (params.kind === "prefetchAbort") ui.bpPrefetchAbortToggle.checked = !!params.enabled;
            if (params.kind === "undefinedInstruction" || params.kind === "undefined") {
                ui.bpUndefinedToggle.checked = !!params.enabled;
            }
            return { ok: ret === 0, kind, enabled: !!params.enabled };
        },

        async listBreakpoints() {
            return state.breakpoints;
        },

        async removeBreakpoint(params = {}) {
            ensureRomLoaded("breakpoint removal requires a loaded ROM");
            const id = Number(params.id ?? ui.bpIdSelect.value);
            const breakpoint = state.breakpoints.find((item) => item.id === id)
                || breakpointOwners.findBreakpointById(id);
            if (!breakpoint) throw new Error(`breakpoint not found: ${id}`);
            breakpointOwners.removeOwner(id);
            state.breakpoints = state.breakpoints.filter((item) => item.id !== id);
            renderBreakpoints();
            refreshDebuggerViews({ keepHighlight: true }).catch((error) => log(error.message));
            return { ok: true, removed: breakpoint, breakpoints: state.breakpoints };
        },

        async clearBreakStatus() {
            ensureReady();
            state.lastBreakKey = "";
            state.breakRefreshKey = "";
            state.breakLabel = "";
            updateStatus();
            native.clearBreakStatus();
            return { ok: true };
        },

        async step(params = {}) {
            return runDebuggerInstruction("step", params);
        },

        async smartStep(params = {}) {
            return runDebuggerInstruction("smartStep", params);
        },

        async stepOver(params = {}) {
            ensureRomLoaded("step over requires a loaded ROM");
            log("step over can still collide with other breakpoints; plain step is safer.");
            return runDebuggerInstruction("stepOver", params);
        },

        async stepNextBranchOrReturn(params = {}) {
            return runUntilNextBranchOrReturn(params);
        },

        async trueNextBranch(params = {}) {
            return runUntilTrueNextBranch(params);
        },

        async continue() {
            return resume();
        },

        async setStackTraceMode(params) {
            ensureReady();
            native.setTraceEnabled(params.enabled);
            ui.traceToggle.checked = !!params.enabled;
            if (!params.enabled) state.selectedCallstackLaneId = null;
            renderCallStack(readCallStackData(), { autoSelectActive: !!params.enabled });
            return { enabled: !!params.enabled };
        },

        async setStackTracePrivilegeCheck(params) {
            ensureReady();
            native.setTracePrivilegeCheck(params.enabled);
            ui.tracePrivilegeToggle.checked = !!params.enabled;
            return { enabled: !!params.enabled };
        },

        async stackTrace(params = {}) {
            ensureRomLoaded("stack trace requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return {
                callStack: publicCallStackData(callStack, params),
                text: native.stackTrace(params.cpu, Number(params.words ?? 32))
            };
        },

        async callStack(params = {}) {
            ensureRomLoaded("call stack requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return publicCallStackData(callStack, params);
        },

        async listOtherCoroutines(params = {}) {
            ensureRomLoaded("other coroutine list requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            const details = publicOtherCoroutines(callStack, params);
            return {
                ...details,
                coroutines: details.coroutines.map(({ frames, ...summary }) => summary)
            };
        },

        async getOtherCoroutines(params = {}) {
            ensureRomLoaded("other coroutine details require a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return publicOtherCoroutines(callStack, params);
        },

        async copyCallStackMarkdown() {
            ensureRomLoaded("call stack copy requires a loaded ROM");
            const callStack = readCallStackData({ limit: 512 });
            const rows = callStack.frames.map((frame) => (
                `| ${frame.ageLabel} | ${hex(frame.caller)} | ${hex(frame.returnAddress)} | ${hex(frame.callee)} | ${hex(frame.sp)} | ${frame.cpsrHex} | ${frame.modeName} | ${frame.thumb ? "thumb" : "arm"} | ${frame.id} |`
            ));
            const text = [
                "| age | caller | return | callee | sp | cpsr | mode | isa | id |",
                "|---|---|---|---|---|---|---|---|---:|",
                ...rows
            ].join("\n");
            renderCallStack(callStack);
            return { text: await copyText(text, "call stack markdown"), callStack };
        },

        async copyCallStackCsv() {
            ensureRomLoaded("call stack copy requires a loaded ROM");
            const callStack = readCallStackData({ limit: 512 });
            const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
            const rows = callStack.frames.map((frame) => [
                frame.ageLabel,
                hex(frame.caller),
                hex(frame.returnAddress),
                hex(frame.callee),
                hex(frame.sp),
                frame.cpsrHex,
                frame.modeName,
                frame.thumb ? "thumb" : "arm",
                frame.id
            ].map(escape).join(","));
            const text = ["age,caller,return,callee,sp,cpsr,mode,isa,id", ...rows].join("\n");
            renderCallStack(callStack);
            return { text: await copyText(text, "call stack csv"), callStack };
        },

        async runUntilReturn(params = {}) {
            return runTraceStepper("runUntilReturn", params, ({ depth, startDepth }) => depth < startDepth);
        },

        async runUntilNextCall(params = {}) {
            return runTraceStepper("runUntilNextCall", params, ({ depth, startDepth }) => depth > startDepth);
        },

        async wait(params = {}) {
            const ms = Math.max(0, Math.min(600000, Number(params.ms ?? params.waitMs ?? 0)));
            await new Promise((resolve) => setTimeout(resolve, ms));
            return status();
        },

        async waitMs(params = {}) {
            return debuggerCommands.wait(params);
        },

        async nextFunctionEnter(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextCall(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextFunctionCall(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextBranchOrReturn(params = {}) {
            return debuggerCommands.stepNextBranchOrReturn(params);
        },

        async nextTrueBranch(params = {}) {
            return debuggerCommands.trueNextBranch(params);
        },

        async returnToPop(params = {}) {
            return debuggerCommands.runUntilReturn(params);
        }
    };

    return debuggerCommands;
}
