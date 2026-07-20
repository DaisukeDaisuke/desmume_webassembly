import { ErrorCode } from "../error-codes.js";
import { withInternalMetadata } from "../internal-command-metadata.js";

export function registerWaitCommands({
    commands,
    descriptions,
    responder,
    operationManager,
    breakpointOwners,
    breakpointService,
    scriptPauseService,
    frameService,
    inputSequenceService,
    getNativeStatus,
    parseAddress,
    hex,
    getFrame
}) {
    function raceScriptPause(operation, waitForValue) {
        const afterSerial = scriptPauseService.currentSerial();
        const controller = new AbortController();
        const abortFromOperation = () => controller.abort(operation.signal.reason);
        operation.signal.addEventListener("abort", abortFromOperation, { once: true });
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                unsubscribePause();
                operation.signal.removeEventListener("abort", abortFromOperation);
                if (!controller.signal.aborted) controller.abort("settled");
            };
            const settle = (method, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                method(value);
            };
            const unsubscribePause = scriptPauseService.subscribe((event) => {
                if (event.serial <= afterSerial) return;
                settle(resolve, { scriptPause: event });
            });
            Promise.resolve(waitForValue(controller.signal)).then(
                (value) => settle(resolve, { value }),
                (error) => settle(reject, error)
            );
        });
    }

    function scriptPausedResult(event) {
        return responder.fail(
            ErrorCode.SCRIPT_PAUSED,
            "A persistent script explicitly paused the emulator",
            { scriptId: event.scriptId }
        );
    }

    commands.waitForBreak = async (params = {}) => {
        const includeScripts = params.scriptBreakpoints === "include";
        if (!breakpointOwners.hasWaitableBreakpoints({ includeScripts })) {
            return responder.fail(ErrorCode.NO_WAITABLE_BREAKPOINTS, "No non-script breakpoints are enabled");
        }
        return operationManager.run({
            name: "waitForBreak",
            timeoutMs: Number(params.timeoutMs),
            task: async (operation) => {
                const afterSerial = breakpointService.currentSerial();
                const pending = raceScriptPause(operation, (signal) => breakpointService.waitForEvent({
                    afterSerial,
                    scriptBreakpoints: params.scriptBreakpoints,
                    signal
                }));
                const native = getNativeStatus();
                if (native?.lastBreak?.hit && Number(native.lastBreak.kind) === 0) {
                    await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                }
                await commands.resume(withInternalMetadata({}, { operation: true }));
                const waited = await pending;
                if (waited.scriptPause) return scriptPausedResult(waited.scriptPause);
                const event = waited.value;
                await commands.pause(withInternalMetadata({}, { operation: true }));
                return responder.ok({
                    cpu: event.cpu,
                    type: event.type,
                    address: hex(event.address),
                    pc: hex(event.pc)
                });
            }
        });
    };

    commands.runUntil = async (params = {}) => {
        const hasPc = params.pc !== undefined;
        const hasBreakpoint = params.bp !== undefined;
        if (hasPc === hasBreakpoint) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "runUntil requires exactly one of pc or bp");
        }
        const progress = { hits: 0, expectedHits: 1 };
        return operationManager.run({
            name: "runUntil",
            timeoutMs: Number(params.timeoutMs),
            timeoutDetails: () => hasBreakpoint ? { ...progress } : {},
            task: async (operation) => {
                let temporaryId = 0;
                let predicate;
                if (hasPc) {
                    const address = parseAddress(params.pc, 0, params.cpu);
                    const result = await commands.setBreakpoint(withInternalMetadata({
                        cpu: params.cpu,
                        type: "exec",
                        address,
                        enabled: true
                    }, { origin: "operation", operationId: operation.id }));
                    temporaryId = result.id;
                    predicate = (event) => event.type === "exec" && event.address === address;
                } else {
                    const id = Number(params.bp);
                    const site = breakpointOwners.findBreakpointById(id);
                    if (!site) {
                        return responder.fail(ErrorCode.BREAKPOINT_NOT_FOUND, `Breakpoint not found: ${id}`);
                    }
                    if (breakpointOwners.classifySite(site).scriptOnly && params.scriptBreakpoints !== "include") {
                        return responder.fail(ErrorCode.BREAKPOINT_NOT_WAITABLE, `Breakpoint is script-only: ${id}`);
                    }
                    progress.expectedHits = Math.max(1, Number(params.hits ?? 1));
                    predicate = (event) => event.owners.some((owner) => owner.id === id);
                }
                let afterSerial = breakpointService.currentSerial();
                try {
                    while (progress.hits < progress.expectedHits) {
                        const pending = raceScriptPause(operation, (signal) => breakpointService.waitForEvent({
                            afterSerial,
                            scriptBreakpoints: params.scriptBreakpoints,
                            predicate,
                            signal
                        }));
                        await commands.resume(withInternalMetadata({}, { operation: true }));
                        const waited = await pending;
                        if (waited.scriptPause) return scriptPausedResult(waited.scriptPause);
                        const event = waited.value;
                        afterSerial = event.serial;
                        progress.hits++;
                        if (progress.hits < progress.expectedHits) {
                            if (event.type === "exec") await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                            continue;
                        }
                        await commands.pause(withInternalMetadata({}, { operation: true }));
                        return responder.ok({
                            ...(hasPc ? { pc: hex(event.pc) } : { bp: Number(params.bp), hits: progress.hits }),
                            frames: getFrame()
                        });
                    }
                } finally {
                    if (temporaryId) breakpointOwners.removeOwner(temporaryId);
                }
            }
        });
    };

    commands.runInputSequence = async (params = {}) => operationManager.run({
        name: "runInputSequence",
        timeoutMs: Number(params.timeoutMs ?? 600000),
        task: (operation) => inputSequenceService.run(params, operation)
    });
    commands.listInputSequences = async () => inputSequenceService.list();
    commands.deleteInputSequence = async (params = {}) => inputSequenceService.delete(params);
    commands.captureFrame = async (params = {}) => frameService.captureFrame(params);
    commands.listFrameSnapshots = async () => frameService.listFrameSnapshots();
    commands.deleteFrameSnapshot = async (params = {}) => frameService.deleteFrameSnapshot(params);
    commands.compareFrame = async (params = {}) => frameService.compareFrame(params);
    commands.waitForScreenChange = async (params = {}) => {
        if (!params.algorithm || !Number.isFinite(Number(params.thresholdPct))) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "algorithm and thresholdPct are required");
        }
        const progress = { maxPct: 0 };
        return operationManager.run({
            name: "waitForScreenChange",
            timeoutMs: Number(params.timeoutMs),
            timeoutDetails: () => ({ maxPct: progress.maxPct }),
            task: async (operation) => {
                await commands.pause(withInternalMetadata({}, { operation: true }));
                const baseline = frameService.captureCurrent();
                if (!baseline.ok) return baseline;
                const stableFrames = Math.max(1, Number(params.stableFrames ?? 1));
                const sampleEvery = Math.max(1, Number(params.sampleEveryFrames ?? 1));
                let stable = 0;
                let frames = 0;
                let sampledFrames = 0;
                let comparing = false;
                return new Promise(async (resolve, reject) => {
                    let finished = false;
                    const cleanup = () => {
                        unsubscribeFrame();
                        unsubscribeBreak();
                        unsubscribeScriptPause();
                        operation.signal.removeEventListener("abort", aborted);
                    };
                    const finish = async (result) => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        await commands.pause(withInternalMetadata({}, { operation: true }));
                        resolve(result);
                    };
                    const aborted = () => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        reject(new DOMException("aborted", "AbortError"));
                    };
                    const unsubscribeFrame = frameService.subscribe(async () => {
                        frames++;
                        if (finished || comparing || frames % sampleEvery) return;
                        comparing = true;
                        sampledFrames++;
                        const result = await frameService.comparePixels(baseline.pixels, {
                            ...params,
                            signal: operation.signal
                        });
                        comparing = false;
                        if (finished) return;
                        if (!result.ok) return finish(result);
                        progress.maxPct = Math.max(progress.maxPct, result.pct);
                        stable = result.changed ? stable + 1 : 0;
                        if (stable >= stableFrames) {
                            return finish(responder.ok({
                                changed: true,
                                algorithm: params.algorithm,
                                pct: result.pct,
                                frames,
                                ...(params.debug ? { sampledFrames } : {})
                            }));
                        }
                    });
                    const unsubscribeBreak = breakpointService.subscribe((event) => {
                        if (event.scriptOnly) return;
                        const breakpointId = event.owners.find((owner) => owner.origin === "user")?.id;
                        void finish(responder.fail(
                            ErrorCode.BREAKPOINT_INTERRUPTED,
                            "Screen wait was interrupted by a non-script breakpoint",
                            {
                                breakpointId,
                                cpu: event.cpu,
                                type: event.type,
                                address: hex(event.address)
                            }
                        ));
                    });
                    const scriptPauseAfterSerial = scriptPauseService.currentSerial();
                    const unsubscribeScriptPause = scriptPauseService.subscribe((event) => {
                        if (event.serial <= scriptPauseAfterSerial) return;
                        void finish(scriptPausedResult(event));
                    });
                    operation.signal.addEventListener("abort", aborted, { once: true });
                    await commands.resume(withInternalMetadata({}, { operation: true }));
                });
            }
        });
    };

    Object.assign(descriptions, {
        waitForBreak: "通常breakpointの次のhitまで待機します。timeoutMsは必須です。",
        runUntil: "PC到達またはbreakpoint hit回数まで実行します。",
        runInputSequence: "保存・再利用可能な短い入力sequenceを実行します。",
        listInputSequences: "保存済み入力sequenceを返します。",
        deleteInputSequence: "保存済み入力sequenceを削除します。",
        captureFrame: "現在の有効frameを名前付きsnapshotへ保存します。",
        listFrameSnapshots: "frame snapshot一覧を返します。",
        deleteFrameSnapshot: "frame snapshotを削除します。",
        compareFrame: "保存済みframeと現在frameを指定algorithmで比較します。",
        waitForScreenChange: "開始時frameを固定baselineとして画面変化を待ちます。"
    });
}
