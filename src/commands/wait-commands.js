import { ErrorCode } from "../error-codes.js";
import { withInternalMetadata } from "../internal-command-metadata.js";
import { positiveInteger, subscribeAbort } from "../validation.js";

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
        const unsubscribeOperationAbort = subscribeAbort(operation.signal, abortFromOperation);
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                unsubscribePause();
                unsubscribeOperationAbort();
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
                    const stepped = await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                    if (stepped?.ok === false) return stepped;
                }
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) return resumed;
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
                    progress.expectedHits = positiveInteger(params.hits ?? 1, "hits", 1000000);
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
                        const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                        if (resumed?.ok === false) return resumed;
                        const waited = await pending;
                        if (waited.scriptPause) return scriptPausedResult(waited.scriptPause);
                        const event = waited.value;
                        afterSerial = event.serial;
                        progress.hits++;
                        if (progress.hits < progress.expectedHits) {
                            if (event.type === "exec") {
                                const stepped = await commands.step(withInternalMetadata({ count: 1 }, { operation: true }));
                                if (stepped?.ok === false) return stepped;
                            }
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
                const initialPause = await commands.pause(withInternalMetadata({}, { operation: true }));
                if (initialPause?.ok === false) return initialPause;
                const baseline = frameService.captureCurrent();
                if (!baseline.ok) return baseline;
                const stableFrames = positiveInteger(params.stableFrames ?? 1, "stableFrames", 1000000);
                const sampleEvery = positiveInteger(params.sampleEveryFrames ?? 1, "sampleEveryFrames", 1000000);
                let stable = 0;
                let frames = 0;
                let sampledFrames = 0;
                let comparing = false;
                let finishWait = () => {};
                const waiting = new Promise((resolve, reject) => {
                    let finished = false;
                    let unsubscribeFrame = () => {};
                    let unsubscribeBreak = () => {};
                    let unsubscribeScriptPause = () => {};
                    let unsubscribeAbort = () => {};
                    const cleanup = () => {
                        unsubscribeFrame();
                        unsubscribeBreak();
                        unsubscribeScriptPause();
                        unsubscribeAbort();
                    };
                    const finish = (result) => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        Promise.resolve(commands.pause(withInternalMetadata({}, { operation: true }))).then(
                            (paused) => resolve(paused?.ok === false ? paused : result),
                            reject
                        );
                    };
                    finishWait = finish;
                    const aborted = () => {
                        if (finished) return;
                        finished = true;
                        cleanup();
                        reject(new DOMException("aborted", "AbortError"));
                    };
                    unsubscribeFrame = frameService.subscribe(async () => {
                        frames++;
                        if (finished || comparing || frames % sampleEvery) return;
                        comparing = true;
                        sampledFrames++;
                        try {
                            const result = await frameService.comparePixels(baseline.pixels, {
                                ...params,
                                signal: operation.signal
                            });
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
                        } catch (error) {
                            finish(responder.fail(
                                error?.mcpCode || ErrorCode.INTERNAL_ERROR,
                                String(error?.message || error)
                            ));
                        } finally {
                            comparing = false;
                        }
                    });
                    unsubscribeBreak = breakpointService.subscribe((event) => {
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
                    unsubscribeScriptPause = scriptPauseService.subscribe((event) => {
                        if (event.serial <= scriptPauseAfterSerial) return;
                        void finish(scriptPausedResult(event));
                    });
                    unsubscribeAbort = subscribeAbort(operation.signal, aborted);
                });
                if (operation.signal.aborted) return waiting;
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) finishWait(resumed);
                return waiting;
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
