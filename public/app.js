const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), el]));
const DESMUME_SCRIPT_URL = "desmume.js?v=20260619-immediate-memory-break";
const state = {
    module: null,
    moduleInitPromise: null,
    scriptLoadPromise: null,
    ready: false,
    running: false,
    paused: true,
    render: true,
    audio: false,
    speed: 1,
    scale: 2,
    rotation: 0,
    frame: 0,
    keys: 0,
    touch: { active: false, x: 0, y: 0 },
    selectedCpu: "arm9",
    breakpoints: [],
    nextBreakpointId: 1,
    freezes: [],
    recentFiles: [],
    previousRegisters: null,
    lastBreakKey: "",
    breakLabel: "",
    keymap: { KeyX: "A", KeyZ: "B", KeyA: "X", KeyS: "Y", KeyQ: "L", KeyW: "R", Enter: "Start", ShiftRight: "Select", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" },
    buttons: { A: 0, B: 1, Select: 2, Start: 3, Right: 4, Left: 5, Up: 6, Down: 7, R: 8, L: 9, X: 10, Y: 11 },
    fns: {},
    audioContext: null,
    audioNextTime: 0,
    imageData: null,
    loadingFile: false,
    lastTick: performance.now(),
    lastSaveFlush: 0,
    saveFlushBlockedUntil: 0,
    romSize: 0,
    romName: "",
    romBytes: null,
    frameBudget: 0,
    search: { snapshot: null, ranges: null, addresses: null, address: 0, length: 0, size: 1, rangeKey: "" },
    highlightedDisasmAddress: null,
    highlightedCallstackAddress: null,
    highlightedCallstackCpsr: null,
    selectedCallstackLaneId: null,
    knownSlots: ["dq9-debug"],
    screenshotCooldownUntil: 0,
    followPc: true,
    autoUpdate: { enabled: false, hz: 1, timer: 0 },
    breakRefreshPending: false,
    breakRefreshTimer: 0,
    breakRefreshKey: "",
    scripts: new Map(),
    nextScriptId: 1,
    nextScriptTriggerId: 1,
    activeScriptId: null,
    scriptTriggers: [],
    pendingScriptEvents: new Map(),
    nextScriptEventId: 1,
    explicitPauseSerial: 0,
    scriptStartGeneration: 0
};

const apiDescriptions = {
    status: "現在の停止状態、フレーム、速度、描画/音声/デバッグ設定、PC/CPSRを返します。",
    loadRomFile: "ユーザーがローカルROMを選択し、ブラウザ内だけで読み込みます。",
    loadRomBytes: "MCPから渡されたROMバイトをブラウザ内だけで読み込みます。bytes配列またはbase64を指定します。",
    loadRomUrl: "同一originまたはCORS許可済みURLからROMを取得し、ブラウザ内だけで読み込みます。ローカル検証は /dq9.nds のような同一origin URL が最短です。",
    importSaveFile: "ユーザーが選択したセーブファイルをカートリッジ保存領域に読み込みます。",
    exportSaveFile: "現在のセーブデータをファイルとして保存します。",
    saveSaveSlot: "現在のカートリッジ保存領域をブラウザの指定スロットに保存します。",
    loadSaveSlot: "ブラウザの指定スロットからカートリッジ保存領域を読み込み、ROMを再読み込みして反映します。",
    saveState: "現在のエミュレーター状態を保存し、slot指定時はブラウザストレージにも保存します。",
    loadState: "保存済みステートを読み込みます。停止中なら停止したまま読み込みます。",
    loadStateBytes: "MCPから渡されたステートバイトを読み込みます。bytes配列またはbase64を指定します。",
    loadStateUrl: "同一originまたはCORS許可済みURLからステートを取得して読み込みます。",
    listRecentFiles: "最近読み込んだセーブ/ステートを最大6件返します。",
    reloadRecentFile: "最近読み込んだセーブ/ステートをid指定で再読み込みします。",
    importStateFile: "外部ステートファイルを読み込みます。",
    exportStateFile: "現在のステートをファイルとして保存します。",
    pause: "エミュレーターを停止します。",
    resume: "エミュレーターを再開します。ROM未ロード時は待ち続けず、未ロード結果を即返します。",
    reset: "実行を止めて、保持しているROMバイトをWASM FSへ書き戻し、ROMロード手順を通して再起動します。",
    reloadRom: "保持しているROMをWASM FSへ再書き込みして読み直します。セーブ反映やゼロ埋め疑いの診断に使います。",
    setSpeed: "実行速度を0.25倍から4倍までで指定します。",
    stepFrames: "指定フレーム数だけ進めます。",
    setRenderEnabled: "画面描画を有効または無効にします。",
    setAudio: "音声の有効化と音量を設定します。",
    setMemoryFreeze: "指定アドレスに値を書き戻し続けるメモリフリーズを追加または削除します。",
    listMemoryFreezes: "現在有効なメモリフリーズ一覧を返します。",
    setScale: "画面倍率を指定します。",
    setRotation: "画面回転を指定します。",
    setInput: "AIまたはUIからDSボタンを押下/解放します。",
    setKeyBinding: "人間用ホットキー割り当てを変更します。",
    getRegisters: "ARM9/ARM7のレジスタを取得します。",
    setRegister: "指定レジスタを書き換えます。",
    disassemble: "PC付近または指定アドレスを逆アセンブル相当のアドレス付きダンプで返します。デフォルトではopcode列を省き、includeBytes:trueで表示します。",
    disassembleBytes: "任意のARM/Thumbバイト列または32-bit opcode列をROMなしで逆アセンブルします。未定義命令が含まれるとerror=trueになります。",
    binaryFloat: "binary32/binary64の浮動小数点ビット列をC++側でdecode/encodeします。",
    dumpMemory: "指定範囲のメモリをバイト列とhexテキストで返します。",
    runInputHold: "指定ボタンを押したまま一定時間維持し、前後の待機も含めて制御します。",
    runInputTap: "指定ボタンをms単位で一定回数連打します。GUIの入力表示も連動します。",
    runTouchHold: "下画面の座標を一定時間押し続けます。前後の待機も指定できます。",
    takeScreenshot: "現在のキャンバスをPNGとして保存します。cooldownMs指定で連打間隔も制御できます。",
    setAutoUpdate: "GUIの自動更新を有効または無効にします。Hzで毎秒の更新回数を指定します。",
    injectMemoryFile: "指定アドレスから、選択したローカルファイルのバイト列でメモリを上書きします。",
    injectBytes: "bytes/base64/hexで渡したバイト列を指定アドレスからメモリへ注入します。",
    searchMemory: "addressにallを指定すると、ミラーを除く主要メモリ範囲を値または前回検索との差分条件で検索します。",
    resetMemorySearch: "前回のメモリ検索スナップショットと候補を破棄します。",
    writeMemory: "指定アドレスにu8/u16/u32を書き込みます。",
    setBreakpoint: "実行/読み込み/書き込みブレークポイントを追加または削除します。",
    setSpecialBreakpoint: "data abort、prefetch abort、undefined instruction で停止する特殊ブレークポイントを切り替えます。",
    listBreakpoints: "現在のブレークポイント一覧を返します。",
    removeBreakpoint: "ブレークポイントをid指定で削除します。",
    clearBreakStatus: "最後にヒットしたブレークポイント表示をクリアします。",
    step: "CPUステップを指定回数実行します。",
    smartStep: "現在命令を見て、通常命令はStep、bx/bl/blxはStep Overで進めます。b系やpc書き換え系はそのまま1命令進めます。",
    stepOver: "ステップオーバーを1回実行します。",
    stepNextBranchOrReturn: "分岐またはreturnらしいPC操作命令の直前まで進めます。途中の関数呼び出しはstep overします。",
    trueNextBranch: "条件不成立の分岐を通過し、実際にPCを変更した次の分岐を実行した直後で停止します。",
    continue: "デバッグ停止から再開します。",
    setStackTraceMode: "重いスタックトレース処理を有効または無効にします。",
    setStackTracePrivilegeCheck: "スタックトレースのIRQ除外を有効または無効にします。",
    stackTrace: "registerenterfunc相当フックで記録したコールスタックとSP付近のワードを取得します。limitで返すframe数を制限できます。",
    callStack: "記録済みコールスタックをnewest-firstのJSONで取得します。SP帯やPC書き込み経路が切り替わった場合は別laneとしてstacksに分かれ、各laneにnowPcが付きます。",
    listOtherCoroutines: "現在ではないコルーチンlaneの一覧と、詳細取得用のgetOtherCoroutinesコピペコマンドを返します。",
    getOtherCoroutines: "現在ではないコルーチンlaneの公開用コールスタック詳細を返します。stackIdで1件に絞れます。",
    copyCallStackMarkdown: "記録済みコールスタックをMarkdown表にして返し、可能ならクリップボードへコピーします。",
    copyCallStackCsv: "記録済みコールスタックをCSVにして返し、可能ならクリップボードへコピーします。",
    runUntilReturn: "コールスタック深度が現在より浅くなるまで実行します。",
    runUntilNextCall: "次の関数入口フックが発火するまで実行します。",
    returnToPop: "runUntilReturn の別名です。現在の深度から1つ以上戻るまで進めます。",
    nextFunctionEnter: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    nextCall: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    nextFunctionCall: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    nextBranchOrReturn: "stepNextBranchOrReturn の別名です。",
    nextTrueBranch: "trueNextBranch の別名です。",
    wait: "指定ミリ秒だけ待機します。状態確認や外部操作待ちに使います。",
    waitMs: "指定ミリ秒だけ待機して status を返します。短い sleep 用の別名です。",
    setCTableSeed: "DQ9のCテーブル乱数相当の2ワードを書き込みます。",
    memoryGetRegister: "スクリプト向けのレジスタ読み込みです。値はBig Endianの16進数文字列で返ります。",
    memorySetRegister: "スクリプト向けのレジスタ書き込みです。Big Endianの16進数値を受け取ります。",
    memoryReadByte: "指定アドレスの1バイトを読みます。",
    memoryReadWord: "指定アドレスの2バイトをBig Endian値として読みます。",
    memoryReadDword: "指定アドレスの4バイトをBig Endian値として読みます。",
    memoryWriteByte: "指定アドレスへ1バイトを書きます。",
    memoryWriteWord: "Big Endian値をLittle Endianメモリへ2バイトとして書きます。",
    memoryWriteDword: "Big Endian値をLittle Endianメモリへ4バイトとして書きます。",
    runPersistentScript: "隔離Workerで常駐JavaScriptを開始または更新します。onTick、reset、各ブレークポイントコールバックを登録できます。",
    listScripts: "実行中・停止中の常駐スクリプト一覧とトリガー数を返します。",
    stopScript: "指定スクリプトを停止し、そのスクリプトのトリガーを全解除します。",
    restartScript: "指定スクリプトをログを消去して再起動します。",
    getScript: "指定スクリプトのJavaScript本文または正規表現検索結果を返します。",
    listScriptPrint: "常駐スクリプトのコンソール出力を最大max件返します。",
    clearScriptPrint: "指定スクリプトまたは全スクリプトのコンソール出力を消去します。",
    eval: "WebMCPから短いJavaScriptを隔離ワーカーで実行し、mcp.call()経由で複数コマンドをまとめて調査します。",
    runScript: "evalの別名です。WebMCPから隔離ワーカー内のJavaScriptを実行します。",
    injectScript: "短い隔離JavaScriptを1回実行します。常駐トリガーにはrunPersistentScriptを使います。",
    batch: "複数のMCPコマンドを順番に実行し、各結果を配列で返します。",
    setFeatureSet: "デバッガ、メモリビュー、MCPなど重い機能群をまとめて切り替えます。"
};

applyScaleRotation();

function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    ui.logOutput.textContent = (line + ui.logOutput.textContent).slice(0, 12000);
}

function hex(value, width = 8) {
    const n = Number(value) >>> 0;
    return "0x" + n.toString(16).padStart(width, "0");
}

function cpsrModeInfo(cpsr) {
    const value = Number(cpsr) >>> 0;
    const mode = value & 0x1f;
    const modes = {
        0x10: { key: "usr", label: "User", className: "" },
        0x11: { key: "fiq", label: "FIQ", className: "mode-fiq" },
        0x12: { key: "irq", label: "IRQ", className: "mode-irq" },
        0x13: { key: "svc", label: "Supervisor", className: "mode-svc" },
        0x17: { key: "abt", label: "Abort", className: "mode-abt" },
        0x1b: { key: "und", label: "Undefined", className: "mode-und" },
        0x1f: { key: "sys", label: "System", className: "" }
    };
    return modes[mode] || { key: `0x${mode.toString(16)}`, label: `Mode 0x${mode.toString(16)}`, className: "mode-svc" };
}

function normalizeCallStackData(data) {
    const frames = data && Array.isArray(data.frames) ? data.frames : [];
    const rawStacks = data && Array.isArray(data.stacks) ? data.stacks : [];
    const controlFlow = data && Array.isArray(data.controlFlow) ? data.controlFlow : [];
    const controlFlowKinds = {
        1: "bx",
        2: "mov-pc",
        3: "movs-pc",
        4: "subs-pc",
        5: "ldm-pc",
        6: "ldm-pc-spsr",
        7: "blx-reg",
        8: "irq-entry",
        9: "irq-return"
    };
    const normalizeFrames = (items) => items.map((frame, index) => {
        const cpsr = Number(frame.cpsr) >>> 0;
        const mode = cpsrModeInfo(cpsr);
        const hasReturnAddress = frame.returnAddress != null;
        const returnAddress = Number(hasReturnAddress ? frame.returnAddress : frame.caller) >>> 0;
        const caller = hasReturnAddress ? (Number(frame.caller) >>> 0) : (((returnAddress & ~1) - 4) >>> 0);
        const depthFromNewest = index;
        const kind = Number(frame.kind);
        return {
            ...frame,
            caller,
            returnAddress,
            depthFromNewest,
            ageLabel: depthFromNewest === 0 ? "newest" : `↑+${depthFromNewest}d`,
            cpsr,
            cpsrHex: hex(cpsr),
            modeValue: cpsr & 0x1f,
            modeKey: mode.key,
            modeName: mode.label,
            modeClass: mode.className,
            kindName: controlFlowKinds[kind] || (Number.isFinite(kind) ? `kind-${kind}` : "")
        };
    });
    const stacks = rawStacks.length ? rawStacks.map((stack) => ({
        ...stack,
        id: Number(stack.id),
        depth: Number(stack.depth) || 0,
        sp: Number(stack.sp) >>> 0,
        spHex: hex(Number(stack.sp) >>> 0),
        nowPc: Number(stack.nowPc) >>> 0,
        nowPcHex: hex(Number(stack.nowPc) >>> 0),
        frames: normalizeFrames(Array.isArray(stack.frames) ? stack.frames : [])
    })) : (frames.length ? [{ id: Number(data?.activeStackId ?? 1), active: true, depth: Number(data?.depth ?? frames.length) || 0, sp: 0, spHex: hex(0), frames: normalizeFrames(frames) }] : []);
    const activeStackId = Number(data?.activeStackId ?? stacks.find((stack) => stack.active)?.id ?? stacks[0]?.id ?? 1);
    return {
        ...(data || {}),
        activeStackId,
        stacks,
        frames: normalizeFrames(frames),
        controlFlow: controlFlow.map((event) => {
            const cpsr = Number(event.cpsr) >>> 0;
            const mode = cpsrModeInfo(cpsr);
            const kind = Number(event.kind);
            return { ...event, cpsr, cpsrHex: hex(cpsr), modeValue: cpsr & 0x1f, modeKey: mode.key, modeName: mode.label, modeClass: mode.className, kindName: controlFlowKinds[kind] || `kind-${kind}` };
        })
    };
}

function callStackLimit(params = {}) {
    const raw = Number(params.limit ?? 128);
    return Math.max(1, Math.min(1024, Number.isFinite(raw) ? Math.trunc(raw) : 128));
}

function readCallStackData(params = {}) {
    const limit = callStackLimit(params);
    const json = state.fns.dbgCallStackJsonLimit ? state.fns.dbgCallStackJsonLimit(limit) : state.fns.dbgCallStackJson();
    return normalizeCallStackData(JSON.parse(json));
}

function disassemblyRows(cpu, address, options = {}) {
    const addr = Number(address) >>> 0;
    const mode = options.mode || (((Number(options.cpsr) >>> 0) & 0x20) ? "thumb" : "arm");
    const count = Math.max(1, Math.min(3, Number(options.count ?? 3)));
    return String(state.fns.dbgDisassemble(cpuIndex(cpu), addr, count, modeNumber(mode)) || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function publicCallStackFrame(frame, cpu = state.selectedCpu) {
    return {
        ageLabel: frame.ageLabel,
        caller: hex(frame.caller),
        returnAddress: hex(frame.returnAddress),
        callee: hex(frame.callee),
        sp: hex(frame.sp),
        cpsr: frame.cpsrHex,
        cpuMode: frame.modeName,
        isa: frame.thumb ? "thumb" : "arm",
        id: frame.id,
        callerDisassembly: disassemblyRows(cpu, frame.caller, { cpsr: frame.cpsr }),
        calleeDisassembly: disassemblyRows(cpu, frame.callee, { cpsr: frame.cpsr })
    };
}

function publicRealFrames(stack, cpu = state.selectedCpu) {
    return (Array.isArray(stack?.frames) ? stack.frames : [])
        .filter((frame) => !frame.synthetic)
        .map((frame) => publicCallStackFrame(frame, cpu));
}

function otherCoroutineCommand(cpu, stackId, limit) {
    const params = { cpu, stackId, limit };
    return {
        command: "getOtherCoroutines",
        params,
        webMcpCall: { command: "getOtherCoroutines", params },
        injectionSnippet: `return await mcp.call("getOtherCoroutines", ${JSON.stringify(params)});`
    };
}

function publicOtherCoroutineSummary(stack, data, params = {}) {
    const cpu = String(params.cpu ?? state.selectedCpu);
    const limit = callStackLimit(params);
    const frames = publicRealFrames(stack, cpu);
    return {
        id: stack.id,
        current: false,
        activeStackId: Number(data.activeStackId),
        sp: stack.spHex,
        nowPc: stack.nowPcHex,
        depth: frames.length,
        newestFrame: frames[0] || null,
        state: "これは現在のコルーチンではありません。",
        getOtherCoroutines: otherCoroutineCommand(cpu, stack.id, limit)
    };
}

function publicOtherCoroutines(data, params = {}) {
    const stackId = params.stackId == null ? null : Number(params.stackId);
    const stacks = Array.isArray(data.stacks) ? data.stacks : [];
    const activeStackId = Number(data.activeStackId);
    const others = stacks.filter((stack) => stack.id !== activeStackId && !stack.active);
    const selected = stackId == null ? others : others.filter((stack) => stack.id === stackId);
    const coroutines = selected.map((stack) => ({
        ...publicOtherCoroutineSummary(stack, data, params),
        frames: publicRealFrames(stack, String(params.cpu ?? state.selectedCpu))
    }));
    return {
        enabled: !!data.enabled,
        activeStackId,
        count: coroutines.length,
        coroutines,
        message: coroutines.length ? "" : "現在ではないコルーチンは記録されていません。"
    };
}

function publicCallStackData(data, params = {}) {
    if (params.raw) return data;
    const cpu = String(params.cpu ?? state.selectedCpu);
    const activeStackId = Number(data.activeStackId);
    const stacks = Array.isArray(data.stacks) ? data.stacks : [];
    const activeStack = stacks.find((stack) => stack.id === activeStackId) || stacks.find((stack) => stack.active) || stacks[0] || null;
    const activeFrames = (activeStack ? activeStack.frames : data.frames || []).filter((frame) => !frame.synthetic);
    return {
        enabled: !!data.enabled,
        depth: activeFrames.length,
        activeStackId,
        frames: activeFrames.map((frame) => publicCallStackFrame(frame, cpu)),
        stacks: stacks.map((stack) => {
            const active = stack.id === activeStackId || !!stack.active;
            if (active) {
                const frames = stack.frames.filter((frame) => !frame.synthetic).map((frame) => publicCallStackFrame(frame, cpu));
                return { id: stack.id, active: true, sp: stack.spHex, nowPc: stack.nowPcHex, depth: frames.length, frames };
            }
            return {
                id: stack.id,
                active: false,
                sp: stack.spHex,
                nowPc: stack.nowPcHex,
                depth: Number(stack.frames?.filter((frame) => !frame.synthetic).length ?? stack.depth ?? 0),
                message: "これは現在のコルーチンではありません。",
                howToShow: `listOtherCoroutines({ cpu: ${JSON.stringify(cpu)} }) で一覧を確認し、getOtherCoroutines({ cpu: ${JSON.stringify(cpu)}, stackId: ${stack.id} }) で詳細を取得します。`
            };
        })
    };
}

function defaultMemorySearchRanges(cpuName) {
    const common = [
        { name: "main", address: 0x02000000, length: 0x00400000 },
        { name: "shared-wram", address: 0x03000000, length: 0x00008000 },
        { name: "palette", address: 0x05000000, length: 0x00000800 },
        { name: "vram", address: 0x06000000, length: 0x000a4000 },
        { name: "oam", address: 0x07000000, length: 0x00000800 }
    ];
    if (String(cpuName || state.selectedCpu).toLowerCase() === "arm7") {
        return [...common, { name: "arm7-wram", address: 0x03800000, length: 0x00010000 }];
    }
    return common;
}

function memorySearchRanges(params = {}) {
    const rawAddress = params.address ?? ui.searchAddress.value;
    const full = params.all === true || params.full === true || String(rawAddress).trim().toLowerCase() === "all";
    if (full) return defaultMemorySearchRanges(params.cpu);
    const address = parseAddress(rawAddress, 0, params.cpu);
    const length = Math.min(16 * 1024 * 1024, Number(params.length ?? ui.searchLength.value));
    return [{ name: "custom", address, length }];
}

function memorySearchRangeKey(ranges) {
    return ranges.map((range) => `${range.name}:${range.address}:${range.length}`).join("|");
}

async function copyText(text, label) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        log(`${label} copied`);
    } else {
        log(`${label} prepared; clipboard is unavailable in this context`);
    }
    return text;
}

function rawOutputText(result) {
    if (typeof result === "string") return result;
    if (result && typeof result.text === "string") return result.text;
    return flattenObject(result);
}

function flattenObject(value) {
    const lines = [];
    let blockId = 1;

    function append(path, value) {
        if (value === null) {
            lines.push(`${path}=null`);
            return;
        }

        switch (typeof value) {
            case "string":
                if (value.includes("\n")) {
                    const tag = `plaintext+${blockId++}`;
                    lines.push(`${path}=<<<${tag}>>>`);
                    lines.push(value);
                    lines.push(`<<<${tag}>>>`);
                } else {
                    lines.push(`${path}=${value}`);
                }
                return;

            case "number":
            case "boolean":
                lines.push(`${path}=${value}`);
                return;
        }

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                append(path ? `${path}.${index}` : String(index), item);
            });
            return;
        }

        if (value && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                append(path ? `${path}.${key}` : key, item);
            }
        }
    }

    append("", value);
    return lines.join("\n");
}

function plainScalarText(value) {
    if (value === null) return "null";
    if (value === undefined) return "";
    if (typeof value === "number") return Number.isInteger(value) && value >= 0x1000 ? hex(value) : String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
}

function isPlainScalar(value) {
    return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
}

function plainRowText(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return plainOutputText(row);
    return Object.entries(row).map(([key, value]) => `${key}=${plainOutputText(value, true)}`).join("  ");
}

function plainOutputText(value, inline = false) {
    if (isPlainScalar(value)) return plainScalarText(value);
    if (Array.isArray(value)) {
        if (!value.length) return inline ? "[]" : "(empty)";
        if (value.every((item) => isPlainScalar(item))) return value.map(plainScalarText).join(inline ? ", " : "\n");
        return value.map(plainRowText).join(inline ? " | " : "\n");
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, item]) => item !== undefined);
        if (!entries.length) return inline ? "{}" : "(empty)";
        if (inline) return entries.map(([key, item]) => `${key}=${plainOutputText(item, true)}`).join(", ");
        return entries.map(([key, item]) => `${key}: ${plainOutputText(item, true)}`).join("\n");
    }
    return String(value);
}

function setScriptOutput(result) {
    const raw = rawOutputText(result);
    ui.scriptRawOutput.value = raw;
    ui.scriptOutput.textContent = raw;
    return raw;
}

function createRecentId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `recent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeKeyboardCode(event) {
    const code = String(event?.code || "");
    if (code && code !== "Unidentified") return code;
    const key = String(event?.key || "");
    const keyCode = Number(event?.keyCode ?? event?.which ?? 0);
    const right = event?.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
    if (key === "Shift" || keyCode === 16) return event?.location === KeyboardEvent.DOM_KEY_LOCATION_LEFT ? "ShiftLeft" : "ShiftRight";
    if (key === "Control" || keyCode === 17) return right ? "ControlRight" : "ControlLeft";
    if (key === "Alt" || keyCode === 18) return right ? "AltRight" : "AltLeft";
    if (key === "Meta" || keyCode === 91 || keyCode === 92) return right ? "MetaRight" : "MetaLeft";
    if (keyCode >= 65 && keyCode <= 90) return `Key${String.fromCharCode(keyCode)}`;
    if (keyCode >= 48 && keyCode <= 57) return `Digit${keyCode - 48}`;
    return code;
}

function saveKeymap() {
    try {
        localStorage.setItem("desmume-keymap", JSON.stringify(state.keymap));
    } catch {}
}

function loadKeymap() {
    try {
        const stored = JSON.parse(localStorage.getItem("desmume-keymap") || "{}");
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
        const next = {};
        for (const [code, button] of Object.entries(stored)) {
            if (typeof code === "string" && state.buttons[String(button)] !== undefined) next[code] = String(button);
        }
        let migrated = false;
        if (next.ShiftLeft === "Select" && !next.ShiftRight) {
            delete next.ShiftLeft;
            next.ShiftRight = "Select";
            migrated = true;
        }
        if (Object.keys(next).length) {
            state.keymap = next;
            if (migrated) saveKeymap();
        }
    } catch {}
}

function parseNumber(value, fallback = 0) {
    if (typeof value === "number") return value;
    if (value === "pc") return getPc();
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    return Number(text.startsWith("0x") ? parseInt(text, 16) : parseInt(text, 10));
}

function parseAddress(value, fallback = 0, cpu = state.selectedCpu) {
    if (typeof value === "number") return value >>> 0;
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return fallback >>> 0;
    if (text === "pc") return getPc(cpu);
    return (text.startsWith("0x") ? parseInt(text, 16) : parseInt(text, 16)) >>> 0;
}

function disasmRefreshParams(overrides = {}) {
    const usePc = overrides.address === "pc" || (overrides.address == null && state.followPc);
    return {
        cpu: overrides.cpu ?? state.selectedCpu,
        address: usePc ? "pc" : (overrides.address ?? ui.disasmAddress.value),
        before: Number(overrides.before ?? ui.disasmBefore.value),
        count: Number(overrides.count ?? ui.disasmCount.value),
        mode: overrides.mode ?? ui.disasmMode.value,
        keepHighlight: overrides.keepHighlight
    };
}

function setFollowPc(enabled) {
    state.followPc = !!enabled;
    if (state.followPc) ui.disasmAddress.value = "pc";
}

function toButtonList(params = {}) {
    const buttons = Array.isArray(params.buttons) ? params.buttons : [params.button].filter(Boolean);
    if (!buttons.length) throw new Error("button or buttons is required");
    return buttons.map((button) => String(button));
}

async function waitChecked(ms, deadline = 0, label = "wait") {
    const duration = Math.max(0, Number(ms) || 0);
    if (!duration) return;
    if (deadline && performance.now() + duration > deadline) throw new Error(`${label} timeout`);
    await sleep(duration);
}

function setTouchState(active, x = 0, y = 0) {
    state.touch = { active: !!active, x: Number(x) || 0, y: Number(y) || 0 };
    if (state.ready && state.touch.active) state.fns.runFrame(0, state.keys, 1, state.touch.x, state.touch.y);
}

function cpuIndex(cpu = state.selectedCpu) {
    return String(cpu).toLowerCase() === "arm7" ? 1 : 0;
}

function ensureReady() {
    if (!state.ready) throw new Error("wasm is not ready");
}

function hasLoadedRom() {
    return !!(state.ready && state.fns.isRomLoaded && state.fns.isRomLoaded() === 1 && state.romSize > 0);
}

function ensureRomLoaded(action = "ROM is not loaded") {
    ensureReady();
    if (!hasLoadedRom()) {
        throw new Error(`${action}. Load a ROM first with Files > ROM or loadRomUrl("/dq9.nds").`);
    }
}

function tryGetPc(cpu = state.selectedCpu) {
    if (!hasLoadedRom()) return null;
    return state.fns.dbgGetReg(cpuIndex(cpu), 18) >>> 0;
}

function wrap(name, ret, args) {
    state.fns[name] = state.module.cwrap(name, ret, args);
}

async function loadEmulatorScript() {
    if (typeof CreateDesmumeModule === "function") return;
    if (!state.scriptLoadPromise) {
        ui.readyText.textContent = "loading emulator";
        state.scriptLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = DESMUME_SCRIPT_URL;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error("desmume.js load failed"));
            document.head.append(script);
        }).catch((error) => {
            state.scriptLoadPromise = null;
            throw error;
        });
    }
    await state.scriptLoadPromise;
}

async function ensureWasmReady() {
    if (state.ready) return state.module;
    if (!state.moduleInitPromise) {
        state.moduleInitPromise = (async () => {
            await loadEmulatorScript();
            await initWasm();
            return state.module;
        })().catch((error) => {
            state.moduleInitPromise = null;
            throw error;
        });
    }
    return state.moduleInitPromise;
}

async function initWasm() {
    if (state.ready) return state.module;
    if (typeof CreateDesmumeModule !== "function") {
        throw new Error("desmume.js is not loaded");
    }
    window.wasmReady = () => log("native module signaled ready");
    state.module = await CreateDesmumeModule({ noInitialRun: false });
    [
        ["loadROM", "number", ["number"]], ["reset", "number", []], ["isRomLoaded", "number", []], ["runFrame", "number", ["number", "number", "number", "number", "number"]],
        ["runFrames", "number", ["number", "number", "number"]], ["fillAudioBuffer", "number", ["number"]], ["getSymbol", "number", ["number"]], ["savGetSize", "number", []],
        ["savGetPointer", "number", ["number"]], ["savImportFromFile", "number", ["number"]], ["savExportToFile", "number", []], ["savUpdateChangeFlag", "number", []], ["stateGetSize", "number", []], ["stateGetPointer", "number", ["number"]],
        ["saveStateToBuffer", "number", []], ["loadStateFromBuffer", "number", ["number"]], ["loadStateFromFile", "number", []], ["captureFrameBuffer", "number", []], ["pauseEmu", "number", ["number"]],
        ["isPaused", "number", []], ["debuggerSetEnabled", "number", ["number"]], ["traceSetEnabled", "number", ["number"]],
        ["traceSetPrivilegeCheck", "number", ["number"]], ["traceGetDepth", "number", []],
        ["dbgGetReg", "number", ["number", "number"]], ["dbgSetReg", "number", ["number", "number", "number"]],
        ["dbgRead8", "number", ["number", "number"]], ["dbgRead16", "number", ["number", "number"]], ["dbgRead32", "number", ["number", "number"]],
        ["dbgWrite8", "number", ["number", "number", "number"]], ["dbgWrite16", "number", ["number", "number", "number"]],
        ["dbgWrite32", "number", ["number", "number", "number"]], ["dbgDumpMemory", "number", ["number", "number", "number"]],
        ["dbgSetExecBreakpoint", "number", ["number", "number", "number"]], ["dbgSetReadBreakpoint", "number", ["number", "number", "number"]],
        ["dbgSetWriteBreakpoint", "number", ["number", "number", "number"]], ["dbgSetSpecialBreakpoint", "number", ["number", "number"]],
        ["dbgClearBreakStatus", "number", []], ["dbgClearAllBreakpoints", "number", []], ["dbgStep", "number", ["number", "number"]],
        ["dbgStepOver", "number", ["number"]], ["dbgGetStatusJson", "string", []], ["dbgDisassemble", "string", ["number", "number", "number", "number"]],
        ["dbgDisassembleOpcode", "string", ["number", "number", "number"]],
        ["dbgStackTrace", "string", ["number", "number"]], ["dbgCallStackJson", "string", []], ["dbgCallStackJsonLimit", "string", ["number"]], ["utilBinaryFloat", "string", ["number", "number", "number", "number", "number"]], ["emuSetOpt", "number", ["number", "number"]]
    ].forEach(([name, ret, args]) => wrap(name, ret, args));
    state.imageData = ui.screen.getContext("2d").createImageData(256, 384);
    state.ready = true;
    ui.readyLed.className = "led ready";
    ui.readyText.textContent = "ready";
    applyScaleRotation();
    updateStatus();
    scheduleTick();
    registerBrowserModelContextTools().catch((error) => log(error.message || String(error)));
}

function download(name, bytes, type = "application/octet-stream") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readFileFromInput(input) {
    return new Promise((resolve, reject) => {
        const file = input.files && input.files[0];
        if (!file) return reject(new Error("file not selected"));
        file.arrayBuffer().then((buf) => {
            input.value = "";
            resolve({ file, bytes: new Uint8Array(buf) });
        }, reject);
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function bootWaitMs(params = {}) {
    return Math.max(0, Math.min(10000, Number(params.waitMs ?? params.romWaitMs ?? ui.romWaitMs.value ?? 600)));
}

function blockSaveFlush(ms = 10000) {
    const until = performance.now() + Math.max(0, Number(ms) || 0);
    state.saveFlushBlockedUntil = Math.max(state.saveFlushBlockedUntil, until);
    state.lastSaveFlush = performance.now();
}

function handleNativeFault(error, where) {
    state.paused = true;
    state.running = false;
    state.frameBudget = 0;
    if (state.ready) state.fns.pauseEmu(1);
    state.breakLabel = `native fault ${where}`;
    blockSaveFlush(30000);
    log(`${where}: ${error && (error.stack || error.message) || error}`);
    updateStatus();
}

async function reloadSelectedRom() {
    const { file, bytes } = await readFileFromInput(ui.romFile);
    writeRomFile(file.name, bytes);
    state.fns.pauseEmu(1);
    await sleep(0);
    const ret = state.fns.loadROM(bytes.length);
    state.frame = 0;
    drawFrame();
    log(`ROM reloaded: ${file.name} (${bytes.length} bytes)`);
    return ret;
}

function writeRomFile(name, bytes) {
    const romBytes = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
    validateRomBytes(romBytes);
    state.module.FS.writeFile("rom.nds", romBytes);
    state.romName = name || "rom.nds";
    state.romBytes = romBytes;
    state.romSize = romBytes.length;
    return romBytes.length;
}

function validateRomBytes(bytes) {
    if (!bytes || bytes.length < 0x200) throw new Error("ROM data is too small or missing");
    let nonZero = false;
    for (let i = 0; i < Math.min(bytes.length, 0x200); i++) {
        if (bytes[i] !== 0) {
            nonZero = true;
            break;
        }
    }
    if (!nonZero) throw new Error("ROM header is all zero");
}

function bytesFromParams(params = {}) {
    if (params.bytes) return new Uint8Array(params.bytes);
    if (params.base64) {
        const raw = atob(String(params.base64));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes;
    }
    throw new Error("bytes or base64 is required");
}

function parseHexToken(token) {
    const text = String(token ?? "").trim().replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(text)) throw new Error(`invalid hex token: ${token}`);
    return parseInt(text, 16);
}

function bytesFromFlexibleParams(params = {}) {
    if (params.bytes) return new Uint8Array(params.bytes.map((value) => typeof value === "number" ? value & 0xff : parseHexToken(value) & 0xff));
    if (params.base64) return bytesFromParams(params);
    const text = String(params.hex ?? params.input ?? params.text ?? "").trim();
    if (!text) throw new Error("bytes, base64, hex, input, or text is required");
    const clean = text.replace(/[,;\n\r\t]+/g, " ").trim();
    const tokens = clean ? clean.split(/\s+/) : [];
    if (tokens.length > 1) return new Uint8Array(tokens.map((token) => parseHexToken(token) & 0xff));
    const one = tokens[0].replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(one) || one.length % 2) throw new Error("hex byte text must contain complete bytes");
    const bytes = new Uint8Array(one.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(one.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

function opcodeWordsFromInput(params = {}) {
    if (params.words) return params.words.map((value) => typeof value === "number" ? value >>> 0 : parseHexToken(value) >>> 0);
    const text = String(params.input ?? params.text ?? params.opcodes ?? "").trim();
    if (!text) return null;
    const tokens = text.replace(/[,;\n\r\t]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    const explicitWords = params.inputMode === "words" || params.format === "words" || tokens.some((token) => {
        const parsed = /^[0-9a-f]+$/i.test(token.replace(/^0x/i, "")) ? parseHexToken(token) : parseNumber(token);
        return /^0x/i.test(token) && parsed > 0xff;
    });
    return explicitWords ? tokens.map((token) => parseHexToken(token) >>> 0) : null;
}

function u32FromBytes(bytes, offset, endian) {
    if (endian === "big" || endian === "be") {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function u16FromBytes(bytes, offset, endian) {
    if (endian === "big" || endian === "be") return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0;
    return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function splitBinaryBits(params = {}, bits = 32) {
    if (params.bytes || params.base64 || params.hexBytes) {
        const bytes = params.hexBytes ? bytesFromFlexibleParams({ hex: params.hexBytes }) : bytesFromFlexibleParams(params);
        const needed = bits / 8;
        if (bytes.length < needed) throw new Error(`binary${bits} decode requires ${needed} bytes`);
        if (bits === 32) return { low: u32FromBytes(bytes, 0, String(params.endian ?? "big")), high: 0 };
        const endian = String(params.endian ?? "big");
        const ordered = endian === "little" || endian === "le" ? [...bytes.slice(0, 8)].reverse() : [...bytes.slice(0, 8)];
        const raw = BigInt("0x" + ordered.map((b) => b.toString(16).padStart(2, "0")).join(""));
        return { low: Number(raw & 0xffffffffn), high: Number((raw >> 32n) & 0xffffffffn) };
    }
    const text = String(params.value ?? params.bits ?? params.raw ?? params.hex ?? "").trim();
    if (!text) throw new Error("value, bits, raw, hex, bytes, or base64 is required");
    const raw = BigInt(text.startsWith("0x") || text.startsWith("0X") ? text : `0x${text}`);
    return { low: Number(raw & 0xffffffffn), high: Number((raw >> 32n) & 0xffffffffn) };
}

async function reloadCurrentRom(options = {}) {
    let romSize = state.romSize;
    if (state.romBytes) {
        romSize = writeRomFile(state.romName, state.romBytes);
    } else {
        const fs = state.module.FS;
        romSize = fs.analyzePath("rom.nds").exists ? writeRomFile("rom.nds", fs.readFile("rom.nds")) : 0;
    }
    if (!romSize) throw new Error("ROM is not loaded");
    state.fns.pauseEmu(1);
    state.running = false;
    state.paused = true;
    state.frameBudget = 0;
    await sleep(Number(options.preWaitMs ?? 0));
    const ret = state.fns.loadROM(romSize);
    state.fns.pauseEmu(1);
    await sleep(Number(options.waitMs ?? 0));
    if (ret === 0) {
        state.romSize = romSize;
        state.frame = 0;
        state.previousRegisters = null;
        state.lastBreakKey = "";
        state.breakRefreshKey = "";
        state.breakLabel = "";
        state.fns.dbgClearBreakStatus();
        state.running = options.resume === true;
        state.paused = options.resume === true ? false : true;
        state.fns.pauseEmu(options.resume === true ? 0 : 1);
        blockSaveFlush(Number(options.saveFlushBlockMs ?? 10000));
        drawFrame();
    }
    return ret;
}

function unlinkWasmFile(path) {
    const fs = state.module.FS;
    if (!fs.analyzePath(path).exists) return false;
    fs.unlink(path);
    return true;
}

function writeSaveForRom(name, bytes) {
    const path = String(name).toLowerCase().endsWith(".dsv") ? "rom.dsv" : "rom.sav";
    unlinkWasmFile("rom.dsv");
    unlinkWasmFile("rom.sav");
    state.module.FS.writeFile(path, bytes);
    return { path, ret: 0 };
}

async function applySaveAndReloadRom(name, bytes, options = {}) {
    const saveLoad = writeSaveForRom(name, bytes);
    if (saveLoad.ret !== 0) return saveLoad;
    const ret = await reloadCurrentRom(options);
    return { ...saveLoad, ret };
}

function loadStateBytesFromMemory(bytes) {
    const ptr = state.fns.stateGetPointer(bytes.length);
    if (!ptr) throw new Error("state buffer allocation failed");
    state.module.HEAPU8.set(bytes, ptr);
    return state.fns.loadStateFromBuffer(bytes.length);
}

async function restorePendingSaveBoot() {
    if (sessionStorage.getItem("desmume-pending-save-boot") !== "1") return;
    sessionStorage.removeItem("desmume-pending-save-boot");
    const rom = await idbGet("pending:rom");
    const save = await idbGet("pending:save");
    if (!rom || !save) throw new Error("pending ROM/save not found");
    const saveName = sessionStorage.getItem("desmume-pending-save-name") || "save.sav";
    sessionStorage.removeItem("desmume-pending-save-name");
    writeRomFile("pending-rom.nds", rom);
    const ret = state.fns.loadROM(rom.length);
    if (ret === 0) {
        const saveLoad = await applySaveAndReloadRom(saveName, save, { waitMs: bootWaitMs() });
        log(`save applied via ${saveLoad.path}`);
    }
    state.fns.pauseEmu(1);
    state.running = ret === 0;
    state.paused = true;
    state.frame = 0;
    drawFrame();
    log(`save imported via ${saveName} and ROM loaded in fresh core`);
}

async function openPicker(input) {
    input.value = "";
    input.click();
    return new Promise((resolve, reject) => {
        input.onchange = () => readFileFromInput(input).then(resolve, reject);
    });
}

function getPc(cpu = state.selectedCpu) {
    ensureRomLoaded("PC is unavailable because no ROM is loaded");
    return state.fns.dbgGetReg(cpuIndex(cpu), 18) >>> 0;
}

function setKey(button, pressed) {
    const bit = state.buttons[button];
    if (bit === undefined) return;
    if (pressed) state.keys |= (1 << bit);
    else state.keys &= ~(1 << bit);
    document.querySelectorAll(`[data-button="${button}"]`).forEach((el) => el.dataset.down = pressed ? "true" : "false");
}

function drawFrame() {
    if (!state.ready || !state.render) return;
    const ptr = state.fns.getSymbol(4);
    if (!ptr) return;
    const bytes = state.module.HEAPU8.subarray(ptr, ptr + 256 * 384 * 4);
    state.imageData.data.set(bytes);
    ui.screen.getContext("2d").putImageData(state.imageData, 0, 0);
}

function drawLoadedStateFrame() {
    if (state.ready && state.fns.captureFrameBuffer) state.fns.captureFrameBuffer();
    drawFrame();
}

function pumpAudio(frames = 1) {
    if (!state.audio || !state.ready) return;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!state.audioContext) state.audioContext = new AudioCtor({ sampleRate: 44100 });
    const ctx = state.audioContext;
    const desired = Math.min(8192, Math.max(256, Math.ceil((44100 / 59.8261) * Math.max(1, frames))));
    const sampleCount = state.fns.fillAudioBuffer(desired);
    if (sampleCount <= 0) return;
    const ptr = state.fns.getSymbol(6);
    const samples = state.module.HEAP16.subarray(ptr >> 1, (ptr >> 1) + sampleCount * 2);
    const buffer = ctx.createBuffer(2, sampleCount, 44100);
    const volume = Number(ui.volumeRange.value);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < sampleCount; i++) {
        left[i] = (samples[i * 2] / 32768) * volume;
        right[i] = (samples[i * 2 + 1] / 32768) * volume;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = state.speed;
    source.connect(ctx.destination);
    state.audioNextTime = Math.max(ctx.currentTime, state.audioNextTime);
    source.start(state.audioNextTime);
    state.audioNextTime += sampleCount / (44100 * state.speed);
}

function applyFreezes() {
    if (!state.ready || state.freezes.length === 0) return;
    for (const item of state.freezes) {
        const fn = item.size === 4 ? "dbgWrite32" : item.size === 2 ? "dbgWrite16" : "dbgWrite8";
        state.fns[fn](cpuIndex(item.cpu), item.address, item.value);
    }
}

function tick(now) {
    if (state.ready && state.running && !state.paused && !state.loadingFile) {
        const elapsed = Math.min(250, now - state.lastTick);
        state.frameBudget += elapsed * 59.8261 * state.speed / 1000;
        const frames = Math.min(12, Math.floor(state.frameBudget));
        if (frames > 0) {
            state.frameBudget -= frames;
            applyFreezes();
            let ran = 0;
            try {
                if (state.touch.active) {
                    for (let i = 0; i < frames; i++) {
                        ran++;
                        if (state.fns.runFrame(state.render && i === frames - 1 ? 1 : 0, state.keys, 1, state.touch.x, state.touch.y) !== 0) break;
                    }
                } else {
                    ran = state.fns.runFrames(frames, state.render ? 1 : 0, state.keys);
                }
            } catch (error) {
                handleNativeFault(error, "runFrame");
                throw error;
            }
            const native = syncNativeBreakStatus();
            if (ran < frames || (native && native.lastBreak && native.lastBreak.hit)) {
                state.paused = true;
                state.running = false;
                if (state.ready) state.fns.pauseEmu(1);
            }
            for (let i = 0; i < ran; i++) dispatchScriptEvent("tick", { frame: state.frame - ran + i + 1, cpu: state.selectedCpu });
            applyFreezes();
            drawFrame();
            pumpAudio(ran);
            updateStatus();
        }
    }
    state.lastTick = now;
    scheduleTick();
}

function scheduleTick() {
    if (state.running && !state.paused && !state.loadingFile) requestAnimationFrame(tick);
    else setTimeout(() => requestAnimationFrame(tick), 120);
}

function pauseForFileLoad() {
    const runState = { running: state.running, paused: state.paused };
    state.loadingFile = true;
    state.running = false;
    state.paused = true;
    state.frameBudget = 0;
    if (state.ready) state.fns.pauseEmu(1);
    updateStatus();
    return runState;
}

function restoreAfterFileLoad(runState) {
    state.loadingFile = false;
    state.lastTick = performance.now();
    state.frameBudget = 0;
    if (runState.running && !runState.paused) {
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.paused = false;
        state.running = true;
        state.fns.dbgClearBreakStatus();
        state.fns.pauseEmu(0);
    } else {
        state.paused = true;
        state.running = false;
        state.fns.pauseEmu(1);
    }
    updateStatus();
}

function updateStatus() {
    ui.frameStatus.textContent = `frame ${state.frame}`;
    ui.speedStatus.textContent = `speed ${state.speed.toFixed(2)}x`;
    if (state.ready) {
        const pc = tryGetPc();
        ui.pcStatus.textContent = `${state.selectedCpu} pc ${pc === null ? "--" : hex(pc)}`;
    }
    ui.readyLed.className = state.ready ? `led ${state.paused ? "paused" : "ready"}` : "led";
    ui.readyText.textContent = state.ready ? (state.breakLabel || (state.paused ? "paused" : "running")) : ui.readyText.textContent;
}

function isTypingTarget(element = document.activeElement) {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
    if (element instanceof HTMLInputElement) {
        const nonTextTypes = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
        return !nonTextTypes.has(String(element.type || "text").toLowerCase());
    }
    return !!element.isContentEditable;
}

function releaseAllKeys() {
    Object.keys(state.buttons).forEach((button) => setKey(button, false));
}

function breakpointKindName(kind) {
    return ["exec", "read", "write", "dataAbort", "prefetchAbort", "undefinedInstruction"][Number(kind)] || "unknown";
}

function getNativeStatus() {
    return state.ready ? JSON.parse(state.fns.dbgGetStatusJson()) : null;
}

function currentInstructionAddress(cpu = state.selectedCpu) {
    const native = getNativeStatus();
    const node = native && native[String(cpu).toLowerCase() === "arm7" ? "arm7" : "arm9"];
    return node ? (Number(node.pc) >>> 0) : null;
}

function currentExecBreakpoint(cpu = state.selectedCpu, address = currentInstructionAddress(cpu)) {
    if (!Number.isFinite(address)) return null;
    return state.breakpoints.find((bp) => bp.type === "exec" && bp.cpu === String(cpu) && (bp.address >>> 0) === (address >>> 0)) || null;
}

async function withCurrentExecBreakpointSuspended(cpu, callback) {
    const address = currentInstructionAddress(cpu);
    const bp = currentExecBreakpoint(cpu, address);
    const idx = cpuIndex(cpu);
    if (bp) state.fns.dbgSetExecBreakpoint(idx, address >>> 0, 0);
    try {
        return await callback(address);
    } finally {
        if (bp) state.fns.dbgSetExecBreakpoint(idx, address >>> 0, 1);
    }
}

function syncNativeBreakStatus(native = null) {
    if (!state.ready) return null;
    const status = native || JSON.parse(state.fns.dbgGetStatusJson());
    if (Number.isFinite(Number(status.frame))) state.frame = Number(status.frame);
    const bp = status.lastBreak;
    if (bp && bp.hit) {
        state.paused = true;
        state.running = false;
        state.fns.pauseEmu(1);
        state.breakLabel = `break ${breakpointKindName(bp.kind)}`;
        const key = `${bp.cpu}:${bp.kind}:${bp.address}:${bp.pc}:${bp.value}`;
        if (state.breakRefreshKey !== key) {
            state.breakRefreshKey = key;
            queueBreakpointRefresh(String(bp.cpu || state.selectedCpu));
        }
        if (state.lastBreakKey !== key) {
            state.lastBreakKey = key;
            log(`break ${breakpointKindName(bp.kind)} ${bp.cpu} at ${hex(bp.address)} pc ${hex(bp.pc)}`);
            const type = breakpointKindName(bp.kind);
            const matchingTriggers = state.scriptTriggers.filter((item) => item.type === type && (item.type === "dataAbort" || item.type === "prefetchAbort" || item.type === "undefinedInstruction" || (item.cpu === String(bp.cpu) && item.address === (Number(bp.address) >>> 0))));
            const scriptBreakpointIds = new Set(matchingTriggers.map((item) => item.breakpointId).filter(Boolean));
            const matchingBreakpoints = state.breakpoints.filter((item) => item.type === type && item.cpu === String(bp.cpu) && item.address === (Number(bp.address) >>> 0));
            const autoResume = type === "exec" && matchingTriggers.length > 0 && matchingBreakpoints.every((item) => scriptBreakpointIds.has(item.id));
            const eventId = autoResume ? state.nextScriptEventId++ : 0;
            if (autoResume) state.pendingScriptEvents.set(eventId, { remaining: matchingTriggers.length, pauseSerial: state.explicitPauseSerial, cpu: String(bp.cpu), address: Number(bp.address) >>> 0 });
            for (const trigger of matchingTriggers) {
                const script = state.scripts.get(trigger.scriptId);
                if (script?.running) script.worker.postMessage({ type: "event", eventId, callbackId: trigger.callbackId, event: type, payload: { ...bp, address: hex(bp.address), pc: hex(bp.pc), value: hex(bp.value) } });
                else if (autoResume) finishPersistentScriptEvent(eventId);
            }
        }
    }
    return status;
}

function getRegisters(cpu = state.selectedCpu) {
    ensureRomLoaded("Registers are unavailable because no ROM is loaded");
    const idx = cpuIndex(cpu);
    const names = ["r0","r1","r2","r3","r4","r5","r6","r7","r8","r9","r10","r11","r12","sp","lr","pc","cpsr","spsr"];
    const values = {};
    for (let i = 0; i < names.length; i++) values[names[i]] = state.fns.dbgGetReg(idx, i) >>> 0;
    values.r13 = values.sp;
    values.r14 = values.lr;
    values.r15 = values.pc;
    return values;
}

function finishPersistentScriptEvent(eventId) {
    const pending = state.pendingScriptEvents.get(Number(eventId));
    if (!pending || --pending.remaining > 0) return;
    state.pendingScriptEvents.delete(Number(eventId));
    if (pending.pauseSerial !== state.explicitPauseSerial || !hasLoadedRom()) return;
    if (currentInstructionAddress(pending.cpu) === pending.address) {
        state.fns.dbgStep(cpuIndex(pending.cpu), 1);
        const afterStep = getNativeStatus();
        if (afterStep?.lastBreak?.hit) {
            syncNativeBreakStatus(afterStep);
            updateStatus();
            return;
        }
    }
    state.breakLabel = "";
    state.breakRefreshKey = "";
    state.lastBreakKey = "";
    state.fns.dbgClearBreakStatus();
    state.paused = false;
    state.running = true;
    state.fns.pauseEmu(0);
    updateStatus();
}

function renderRegisters() {
    if (!hasLoadedRom()) {
        [...ui.registers.querySelectorAll("div")].forEach((row) => {
            row.classList.remove("changed");
            row.classList.remove("editing");
            row.querySelector("b").textContent = "--------";
            row.querySelector("input").value = "--------";
        });
        state.previousRegisters = null;
        return null;
    }
    const regs = getRegisters();
    [...ui.registers.querySelectorAll("div")].forEach((row) => {
        const name = row.querySelector("span").textContent;
        const changed = state.previousRegisters && state.previousRegisters[name] !== regs[name];
        const value = hex(regs[name] ?? 0);
        row.classList.toggle("changed", !!changed);
        row.querySelector("b").textContent = value;
        const input = row.querySelector("input");
        if (document.activeElement !== input) input.value = value;
    });
    state.previousRegisters = regs;
    return regs;
}

function renderBreakpoints() {
    ui.bpOutput.textContent = state.breakpoints.map((bp) => `#${bp.id} ${bp.cpu} ${bp.type} ${hex(bp.address)}`).join("\n") || "no breakpoints";
    const current = ui.bpIdSelect.value;
    ui.bpIdSelect.innerHTML = `<option value="">none</option>` + state.breakpoints.map((bp) => `<option value="${bp.id}">#${bp.id} ${bp.cpu} ${bp.type} ${hex(bp.address)}</option>`).join("");
    ui.bpIdSelect.value = state.breakpoints.some((bp) => String(bp.id) === current) ? current : "";
}

function renderFreezes() {
    ui.freezeOutput.textContent = state.freezes.map((item) => `${item.cpu} ${hex(item.address)} ${item.size === 4 ? "u32" : item.size === 2 ? "u16" : "u8"} = ${hex(item.value, item.size * 2)}`).join("\n") || "no freezes";
}

function renderRecentFiles() {
    const current = ui.recentFileSelect.value;
    ui.recentFileSelect.innerHTML = `<option value="">none</option>` + state.recentFiles.map((item) => {
        const label = item.slot ? `${item.kind} ${item.name} [${item.slot}]` : `${item.kind} ${item.name}`;
        return `<option value="${item.id}">${label.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</option>`;
    }).join("");
    ui.recentFileSelect.value = state.recentFiles.some((item) => String(item.id) === current) ? current : "";
}

function rememberSlot(slot) {
    const value = String(slot || "").trim();
    if (!value) return;
    state.knownSlots = [value, ...state.knownSlots.filter((item) => item !== value)].slice(0, 24);
    try {
        localStorage.setItem("desmume-known-slots", JSON.stringify(state.knownSlots));
    } catch {}
    renderStateSlotOptions(value);
}

function renderStateSlotOptions(selected = ui.stateSlot.value) {
    const options = [...new Set([String(selected || "").trim(), ...state.knownSlots].filter(Boolean))];
    if (!options.length) options.push("dq9-debug");
    state.knownSlots = options;
    ui.stateSlotSelect.innerHTML = options.map((slot) => {
        const safe = slot.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
        return `<option value="${safe}">${safe}</option>`;
    }).join("");
    ui.stateSlotSelect.value = options.includes(selected) ? selected : options[0];
    if (selected && ui.stateSlot.value !== selected) ui.stateSlot.value = selected;
}

async function recordRecentFile(kind, name, bytes = null, slot = "") {
    const existing = state.recentFiles.find((item) => item.kind === kind && item.name === name && item.slot === String(slot || ""));
    const id = existing?.id || createRecentId();
    const item = { id, kind, name, slot: String(slot || ""), size: bytes ? bytes.length : 0 };
    if (item.slot) rememberSlot(item.slot);
    if (bytes) {
        item.key = `recent:${kind}:${id}`;
        await idbPut(item.key, bytes);
    }
    state.recentFiles = [item, ...state.recentFiles.filter((x) => x.id !== id)].slice(0, 6);
    renderRecentFiles();
    return item;
}

function renderHotkey() {
    const button = ui.hotkeyButton.value;
    const code = Object.entries(state.keymap).find(([, mapped]) => mapped === button)?.[0] || "";
    ui.hotkeyCurrent.value = code;
    if (code) ui.hotkeyCode.value = code;
}

function instructionOpcode(line) {
    return String(line || "").replace(/^=>/, "  ");
}

function swap16(value) {
    const n = Number(value) & 0xffff;
    return ((n & 0xff) << 8) | ((n >>> 8) & 0xff);
}

function swap32(value) {
    const n = Number(value) >>> 0;
    return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | ((n >>> 24) & 0xff)) >>> 0;
}

function bigEndianValue(value, size) {
    const parsed = parseNumber(value) >>> 0;
    return size === 4 ? swap32(parsed) : size === 2 ? swap16(parsed) : parsed & 0xff;
}

function scriptConsoleLine(script, values) {
    const line = values.map((value) => typeof value === "string" ? value : rawOutputText(value)).join(" ");
    script.output = [...script.output, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-400);
    if (state.activeScriptId === script.id) renderScriptConsole(script);
}

function renderScriptConsole(script = state.scripts.get(state.activeScriptId)) {
    const text = script ? script.output.join("\n") : "No script selected.";
    ui.scriptRawOutput.value = text;
    ui.scriptOutput.textContent = text || "No console output.";
}

function renderScripts() {
    const selected = state.scripts.get(state.activeScriptId);
    ui.scriptTabs.replaceChildren();
    ui.scriptList.replaceChildren();
    for (const script of state.scripts.values()) {
        const tab = ui.scriptTabTemplate.content.firstElementChild.cloneNode(true);
        tab.textContent = script.name;
        tab.dataset.scriptTab = script.id;
        tab.setAttribute("aria-selected", String(script.id === state.activeScriptId));
        tab.addEventListener("click", () => selectScript(script.id));
        ui.scriptTabs.append(tab);
        const row = document.createElement("button");
        row.type = "button";
        row.dataset.running = String(script.running);
        row.textContent = `${script.name} · ${script.running ? "running" : "stopped"} · ${script.triggers.length} triggers`;
        row.addEventListener("click", () => selectScript(script.id));
        ui.scriptList.append(row);
    }
    if (!selected && state.scripts.size) selectScript(state.scripts.values().next().value.id);
}

function selectScript(id) {
    const script = state.scripts.get(Number(id));
    if (!script) return;
    state.activeScriptId = script.id;
    ui.scriptName.value = script.name;
    ui.scriptAsyncMode.checked = script.asyncMode;
    if (document.activeElement !== ui.scriptCode) ui.scriptCode.value = script.code;
    renderScriptConsole(script);
    renderScripts();
}

function dispatchScriptEvent(type, payload = {}) {
    for (const script of state.scripts.values()) {
        if (script.running) script.worker.postMessage({ type: "event", event: type, payload });
    }
}

async function unregisterScriptTriggers(script) {
    for (const trigger of [...script.triggers]) {
        if (trigger.breakpointId) {
            const bp = state.breakpoints.find((item) => item.id === trigger.breakpointId);
            if (bp) await commands.removeBreakpoint({ id: bp.id });
        }
        if (["dataAbort", "prefetchAbort", "undefinedInstruction"].includes(trigger.type) && !state.scriptTriggers.some((item) => item.id !== trigger.id && item.type === trigger.type)) {
            await commands.setSpecialBreakpoint({ kind: trigger.type, enabled: false });
        }
        state.scriptTriggers = state.scriptTriggers.filter((item) => item.id !== trigger.id);
    }
    script.triggers = [];
}

async function registerScriptTrigger(script, trigger) {
    ensureRomLoaded("script trigger registration requires a loaded ROM");
    const type = String(trigger.kind || trigger.type || "tick");
    const item = { id: state.nextScriptTriggerId++, scriptId: script.id, callbackId: Number(trigger.callbackId), type, cpu: String(trigger.cpu || state.selectedCpu), address: parseAddress(trigger.address, 0, trigger.cpu) };
    if (["read", "write", "exec"].includes(type)) {
        const result = await commands.setBreakpoint({ cpu: item.cpu, type, address: item.address, enabled: true });
        item.breakpointId = result.id;
    } else if (["dataAbort", "prefetchAbort", "undefinedInstruction"].includes(type)) {
        await commands.setSpecialBreakpoint({ kind: type, enabled: true });
    } else if (type !== "tick" && type !== "start" && type !== "stateLoad" && type !== "stateSave") {
        throw new Error(`unknown script trigger: ${type}`);
    }
    script.triggers.push(item);
    state.scriptTriggers.push(item);
    renderScripts();
    return item;
}

function persistentScriptWorkerCode() {
    return `
      const fetch = undefined, XMLHttpRequest = undefined, WebSocket = undefined, EventSource = undefined, importScripts = undefined, Function = undefined;
      const callbacks = new Map(); let callbackSerial = 1; let eventQueue = Promise.resolve();
      const ask = (type, data = {}) => new Promise((resolve, reject) => { const id = Math.random().toString(36).slice(2); const receive = (event) => { if (event.data && event.data.replyId === id) { removeEventListener("message", receive); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); } }; addEventListener("message", receive); postMessage({ type, id, ...data }); });
      const mcp = { call: (command, params = {}) => ask("call", { command, params }) };
      const webmcp = mcp;
      const print = (...values) => postMessage({ type: "print", values });
      const printf = (format, ...values) => print(String(format).replace(/%#?\.?(\\d*)x|%[sd]/g, (match, width) => { const value = values.shift(); if (match.endsWith("x")) return "0x" + (Number(value) >>> 0).toString(16).padStart(Number(width || 0), "0"); return match.endsWith("d") ? String(Number(value)) : String(value); }));
      const printhex = (label, value) => print(label + ": " + (value == null ? "nil" : "0x" + (Number(value) >>> 0).toString(16).padStart(8, "0")));
      const register = async (kind, address, callback, options = {}) => { if (typeof address === "function") { options = callback || {}; callback = address; address = 0; } if (typeof callback !== "function") throw new Error(kind + " callback is required"); const callbackId = callbackSerial++; callbacks.set(callbackId, { callback, kind }); return ask("register", { trigger: { kind, address, callbackId, ...options } }); };
      const memory = {
        getregister: (register, cpu) => ask("call", { command: "memoryGetRegister", params: { register, cpu } }),
        setregister: (register, value, cpu) => ask("call", { command: "memorySetRegister", params: { register, value, cpu } }),
        readbyte: (address, cpu) => ask("call", { command: "memoryReadByte", params: { address, cpu } }),
        readword: (address, cpu) => ask("call", { command: "memoryReadWord", params: { address, cpu } }),
        readdword: (address, cpu) => ask("call", { command: "memoryReadDword", params: { address, cpu } }),
        writebyte: (address, value, cpu) => ask("call", { command: "memoryWriteByte", params: { address, value, cpu } }),
        writeword: (address, value, cpu) => ask("call", { command: "memoryWriteWord", params: { address, value, cpu } }),
        writedword: (address, value, cpu) => ask("call", { command: "memoryWriteDword", params: { address, value, cpu } }),
        registerwrite: (address, callback, options) => register("write", address, callback, options),
        registerread: (address, callback, options) => register("read", address, callback, options),
        registerexec: (address, callback, options) => register("exec", address, callback, options),
        registerexception: (kind, callback, options) => register(kind, 0, callback, options),
        ontick: (callback, options) => register("tick", 0, callback, options)
      };
      memory.reg = memory.getregister; memory.regw = memory.setregister;
      memory.read8 = memory.readbyte; memory.read16 = memory.readword; memory.read32 = memory.readdword;
      memory.write8 = memory.writebyte; memory.write16 = memory.writeword; memory.write32 = memory.writedword;
      const emu_registerstart = (callback, options) => register("start", 0, callback, options);
      const emu_ontick = (callback, options) => register("tick", 0, callback, options);
      const emu = Object.fromEntries(["pause", "resume", "status", "step", "smartStep", "stepOver", "stepNextBranchOrReturn", "trueNextBranch", "runUntilReturn", "runUntilNextCall", "stepFrames", "setInput", "runTouchHold", "setSpeed", "setRenderEnabled", "setAudio", "saveState", "loadState", "reloadRecentFile"].map((command) => [command, (params = {}) => mcp.call(command, params)]));
      const runEvent = async (msg) => { try { for (const [id, entry] of callbacks) { if (msg.callbackId ? id !== msg.callbackId : entry.kind !== msg.event) continue; try { await entry.callback(msg.payload); } catch (error) { postMessage({ type: "print", values: ["callback error: " + String(error.message || error)] }); } } } finally { if (msg.eventId) postMessage({ type: "eventDone", eventId: msg.eventId }); } };
      onmessage = async (event) => { const msg = event.data || {}; if (msg.type === "start") { try { await (0, eval)("(async () => {\\n" + msg.code + "\\n})()\\n//# sourceURL=desmume-persistent-user.js"); postMessage({ type: "started" }); } catch (error) { postMessage({ type: "failed", error: String(error.stack || error.message || error) }); } } else if (msg.type === "event") { eventQueue = eventQueue.then(() => runEvent(msg)); } };
    `;
}

const ASYNC_SCRIPT_BLOCKED_COMMANDS = new Set([
    "pause", "resume", "memoryGetRegister", "memorySetRegister",
    "memoryReadByte", "memoryReadWord", "memoryReadDword",
    "memoryWriteByte", "memoryWriteWord", "memoryWriteDword", "dumpMemory",
    "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze"
]);

function queuePersistentScriptOperation(script, command, params) {
    const operation = script.queue.then(async () => {
        if (!script.running) throw new Error(`script stopped before queued ${command} operation`);
        if (script.asyncMode && ASYNC_SCRIPT_BLOCKED_COMMANDS.has(command)) {
            throw new Error(`${command} is unavailable in persistent-script async mode because it requires immediate emulator state. Restart with asyncMode:false (or clear “async queue” in the UI).`);
        }
        return command === "register" ? registerScriptTrigger(script, params) : runCommand(command, params);
    });
    script.queue = operation.catch(() => undefined);
    return operation;
}

async function startPersistentScript(params = {}) {
    const code = String(params.code ?? ui.scriptCode.value);
    const name = String(params.name ?? ui.scriptName.value ?? "scratch").trim() || "scratch";
    const asyncMode = !!(params.asyncMode ?? ui.scriptAsyncMode.checked);
    const duplicate = [...state.scripts.values()].find((script) => script.code === code && script.asyncMode === asyncMode && script.running);
    if (duplicate) return scriptSummary(duplicate, true);
    const existing = [...state.scripts.values()].find((script) => script.name === name);
    if (existing) await stopPersistentScript({ id: existing.id });
    const script = { id: existing?.id || state.nextScriptId++, name, code, asyncMode, queue: Promise.resolve(), worker: null, running: true, output: [], triggers: [] };
    const worker = new Worker(URL.createObjectURL(new Blob([persistentScriptWorkerCode()], { type: "text/javascript" })));
    script.worker = worker;
    state.scripts.set(script.id, script);
    state.activeScriptId = script.id;
    worker.onmessage = async (event) => {
        const msg = event.data || {};
        try {
            if (msg.type === "call") worker.postMessage({ replyId: msg.id, result: await queuePersistentScriptOperation(script, msg.command, msg.params || {}) });
            else if (msg.type === "register") worker.postMessage({ replyId: msg.id, result: await queuePersistentScriptOperation(script, "register", msg.trigger || {}) });
            else if (msg.type === "eventDone") finishPersistentScriptEvent(msg.eventId);
            else if (msg.type === "print") scriptConsoleLine(script, msg.values || []);
            else if (msg.type === "failed") { script.running = false; scriptConsoleLine(script, [msg.error]); renderScripts(); }
        } catch (error) { worker.postMessage({ replyId: msg.id, error: String(error.message || error) }); }
    };
    worker.postMessage({ type: "start", code });
    renderScripts();
    return scriptSummary(script, false);
}

async function stopPersistentScript(params = {}) {
    const id = Number(params.id ?? state.activeScriptId);
    const script = state.scripts.get(id);
    if (!script) throw new Error(`script not found: ${id}`);
    await unregisterScriptTriggers(script);
    script.worker?.terminate();
    script.running = false;
    renderScripts();
    renderScriptConsole(script);
    return scriptSummary(script, false);
}

function scriptSummary(script, duplicate = false) {
    return { id: script.id, name: script.name, running: script.running, asyncMode: script.asyncMode, triggers: script.triggers.map(({ id, type, address, cpu }) => ({ id, type, address: hex(address), cpu })), duplicate };
}

function stripDisassemblyBytesLine(line) {
    return String(line || "").replace(/^(\s*(?:=>)?\s*[0-9a-fA-F]+:\s+)[0-9a-fA-F]{1,8}\s+(.*)$/i, "$1$2");
}

function formatDisassemblyText(text, includeBytes = false) {
    if (includeBytes) return String(text || "");
    return String(text || "").split("\n").map(stripDisassemblyBytesLine).join("\n");
}

function shouldIncludeDisassemblyBytes(params = {}) {
    if (params.includeBytes != null) return !!params.includeBytes;
    if (params.bytes != null) return !!params.bytes;
    return ui.disasmBytes ? ui.disasmBytes.value === "show" : false;
}

function instructionBody(line) {
    return instructionOpcode(line).replace(/^\s*[0-9a-fA-F]+:\s*(?:(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8})\s+)?/i, "").trim();
}

function armConditionSuffix(text) {
    return /^(eq|ne|cs|cc|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)$/i.test(String(text || ""));
}

function mnemonicMatches(mnemonic, base) {
    const op = String(mnemonic || "").toLowerCase();
    if (op === base) return true;
    return op.startsWith(base) && armConditionSuffix(op.slice(base.length));
}

function isBranchLinkMnemonic(mnemonic) {
    const op = String(mnemonic || "").toLowerCase();
    return op === "bl" || (op.startsWith("bl") && armConditionSuffix(op.slice(2)));
}

function isBranchLinkExchangeMnemonic(mnemonic) {
    const op = String(mnemonic || "").toLowerCase();
    return op === "blx" || (op.startsWith("blx") && armConditionSuffix(op.slice(3)));
}

function classifyInstruction(line) {
    const body = instructionBody(line);
    const match = body.match(/^([a-z][a-z0-9]*)(?:\s+(.*))?$/i);
    const mnemonic = String(match?.[1] || "").toLowerCase();
    const operands = String(match?.[2] || "").toLowerCase();
    const isCall = isBranchLinkMnemonic(mnemonic) || isBranchLinkExchangeMnemonic(mnemonic);
    const firstOperand = (operands.match(/^\s*([^,\s\]!]+)/) || [])[1] || "";
    const destPc = firstOperand === "pc";
    const isBx = mnemonicMatches(mnemonic, "bx");
    const isMovPc = (mnemonicMatches(mnemonic, "mov") || mnemonicMatches(mnemonic, "movs")) && destPc;
    const isLdrPc = mnemonicMatches(mnemonic, "ldr") && destPc;
    const isLdmPc = /^ldm/i.test(mnemonic) && /\{[^}]*\bpc\b[^}]*\}\^?/i.test(operands);
    const isPopPc = mnemonicMatches(mnemonic, "pop") && /\{[^}]*\bpc\b[^}]*\}/i.test(operands);
    const isSubsPc = mnemonicMatches(mnemonic, "subs") && destPc;
    const isAluPcBranch = (mnemonicMatches(mnemonic, "add") || mnemonicMatches(mnemonic, "sub")) && destPc;
    const isPurpleBranch = mnemonic.startsWith("b") && !isCall && !isBx;
    const isReturn = (isBx && /\blr\b/i.test(operands)) || isLdmPc || isPopPc || isSubsPc || (isMovPc && /\blr\b/i.test(operands));
    const writesPc = isBx || isMovPc || isLdrPc || isLdmPc || isPopPc || isSubsPc || isAluPcBranch;
    return {
        mnemonic,
        body,
        kind: isCall ? "call" : isReturn ? "return" : isBx ? "bx" : (isPurpleBranch || writesPc) ? "branch" : "normal",
        isCall,
        isBx,
        isReturn,
        isBranch: isPurpleBranch || writesPc,
        writesPc
    };
}

async function getCurrentInstructionInfo(cpu = state.selectedCpu) {
    const disasm = await commands.disassemble({ cpu, address: "pc", before: 0, count: 1, mode: "auto" });
    const line = String(disasm.text || "").split("\n").find((item) => item.trim()) || "";
    const address = parseInt((line.match(/(?:=>|  )\s*([0-9a-fA-F]+):/) || [])[1] || "", 16);
    return { line, address: Number.isFinite(address) ? (address >>> 0) : null, ...classifyInstruction(line) };
}

function registerHexSnapshot(cpu = state.selectedCpu) {
    const values = getRegisters(cpu);
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, hex(value)]));
}

function stepStatusSummary(cpu, native = null) {
    const status = native || syncNativeBreakStatus() || {};
    const lastBreak = status.lastBreak && status.lastBreak.hit ? status.lastBreak : null;
    return {
        cpu: String(cpu),
        breakReason: lastBreak ? breakpointKindName(lastBreak.kind) : (state.breakLabel || ""),
        paused: !!state.paused
    };
}

async function attachDebuggerContext(result, cpu, pcBefore, native = null) {
    const pcAfter = getPc(cpu);
    const disassembly = await commands.disassemble({ cpu, address: pcAfter, before: 1, count: 2, mode: "auto" });
    return {
        ...result,
        pcBefore: hex(pcBefore),
        pcAfter: hex(pcAfter),
        pc: hex(pcAfter),
        status: stepStatusSummary(cpu, native),
        registers: registerHexSnapshot(cpu),
        disassembly: String(disassembly.text || "").split("\n").map((line) => line.trim()).filter(Boolean)
    };
}

function syncBreakpointsToNative() {
    if (!state.fns.dbgClearAllBreakpoints) return;
    state.fns.dbgClearAllBreakpoints();
    for (const bp of state.breakpoints) {
        if (!bp.enabled) continue;
        const fn = bp.type === "read" ? "dbgSetReadBreakpoint" : bp.type === "write" ? "dbgSetWriteBreakpoint" : "dbgSetExecBreakpoint";
        state.fns[fn](cpuIndex(bp.cpu), bp.address >>> 0, 1);
    }
}

async function runDebuggerInstruction(kind, params = {}) {
    ensureRomLoaded("debugger step requires a loaded ROM");
    const cpu = String(params.cpu ?? state.selectedCpu);
    const pcBefore = getPc(cpu);
    let result = { kind, count: 0 };
    state.breakRefreshKey = "";
    syncBreakpointsToNative();
    if (kind === "step") {
        result.count = state.fns.dbgStep(cpuIndex(cpu), Number(params.count ?? 1));
    } else if (kind === "stepOver") {
        result.count = state.fns.dbgStepOver(cpuIndex(cpu));
        result.ret = result.count;
    } else if (kind === "smartStep") {
        const info = await getCurrentInstructionInfo(cpu);
        const chosen = info.kind === "call" || info.kind === "bx" ? "stepOver" : "step";
        result = await runDebuggerInstruction(chosen, { ...params, cpu });
        result.kind = "smartStep";
        result.chosen = chosen;
        result.instruction = info;
        return result;
    } else {
        throw new Error(`unsupported debugger step: ${kind}`);
    }
    applyFreezes();
    const native = syncNativeBreakStatus();
    updateStatus();
    result.paused = state.paused;
    return attachDebuggerContext(result, cpu, pcBefore, native);
}

async function runUntilNextBranchOrReturn(params = {}) {
    ensureRomLoaded("next branch/return requires a loaded ROM");
    const cpu = String(params.cpu ?? state.selectedCpu);
    const pcBefore = getPc(cpu);
    const deadline = performance.now() + Math.max(1, Number(params.timeoutMs ?? 1000));
    const maxSteps = Math.max(1, Number(params.maxSteps ?? 200000));
    let steps = 0;
    state.breakRefreshKey = "";
    state.fns.dbgClearBreakStatus();
    syncBreakpointsToNative();
    while (performance.now() < deadline && steps < maxSteps) {
        const info = await getCurrentInstructionInfo(cpu);
        if (info.isReturn || info.isBranch) {
            const result = { kind: "stepNextBranchOrReturn", ok: true, steps, stop: info.isReturn ? "return" : "branch", instruction: info };
            await refreshDebuggerViews({ cpu, keepHighlight: true });
            return attachDebuggerContext(result, cpu, pcBefore);
        }
        if (info.isCall) {
            state.fns.dbgStepOver(cpuIndex(cpu));
        } else {
            state.fns.dbgStep(cpuIndex(cpu), 1);
        }
        steps++;
        applyFreezes();
        const native = syncNativeBreakStatus();
        if (native && native.lastBreak && native.lastBreak.hit) {
            await refreshDebuggerViews({ cpu, keepHighlight: true });
            return attachDebuggerContext({ kind: "stepNextBranchOrReturn", ok: false, stoppedByBreakpoint: true, steps, instruction: info }, cpu, pcBefore, native);
        }
    }
    await refreshDebuggerViews({ cpu, keepHighlight: true });
    throw new Error(`stepNextBranchOrReturn timeout after ${Math.max(1, Number(params.timeoutMs ?? 1000))}ms`);
}

async function runUntilTrueNextBranch(params = {}) {
    ensureRomLoaded("true next branch requires a loaded ROM");
    const cpu = String(params.cpu ?? state.selectedCpu);
    const pcBefore = getPc(cpu);
    const deadline = performance.now() + Math.max(1, Number(params.timeoutMs ?? 1000));
    const maxSteps = Math.max(1, Number(params.maxSteps ?? 200000));
    let steps = 0;
    state.breakRefreshKey = "";
    state.fns.dbgClearBreakStatus();
    syncBreakpointsToNative();
    while (performance.now() < deadline && steps < maxSteps) {
        const info = await getCurrentInstructionInfo(cpu);
        const sequentialPc = info.address == null ? null : (info.address + instructionWidthForMode("auto", cpu)) >>> 0;
        await withCurrentExecBreakpointSuspended(cpu, async () => state.fns.dbgStep(cpuIndex(cpu), 1));
        steps++;
        applyFreezes();
        const native = syncNativeBreakStatus();
        const pcAfter = getPc(cpu);
        if (native && native.lastBreak && native.lastBreak.hit) {
            await refreshDebuggerViews({ cpu, keepHighlight: true });
            return attachDebuggerContext({ kind: "trueNextBranch", ok: false, stoppedByBreakpoint: true, steps, instruction: info }, cpu, pcBefore, native);
        }
        if ((info.isBranch || info.isReturn || info.isCall) && sequentialPc !== null && pcAfter !== sequentialPc) {
            await refreshDebuggerViews({ cpu, keepHighlight: true });
            return attachDebuggerContext({ kind: "trueNextBranch", ok: true, steps, instruction: info, branchFrom: hex(info.address), branchTo: hex(pcAfter) }, cpu, pcBefore);
        }
    }
    await refreshDebuggerViews({ cpu, keepHighlight: true });
    throw new Error(`trueNextBranch timeout after ${Math.max(1, Number(params.timeoutMs ?? 1000))}ms`);
}

function renderDisassembly(text) {
    const lines = String(text || "").split("\n").filter(Boolean);
    ui.disasmOutput.innerHTML = lines.map((line) => {
        const current = line.startsWith("=>");
        const address = parseInt((line.match(/(?:=>|  )\s*([0-9a-fA-F]+):/) || [])[1] || "", 16);
        const highlighted = Number.isFinite(address) && state.highlightedDisasmAddress === address;
        const modeClass = highlighted && state.highlightedCallstackCpsr != null ? cpsrModeInfo(state.highlightedCallstackCpsr).className : "";
        const hasBp = state.breakpoints.some((bp) => bp.type === "exec" && bp.cpu === state.selectedCpu && bp.address === address);
        const opcode = instructionOpcode(line);
        const body = instructionBody(line);
        const info = classifyInstruction(line);
        const isCallLike = isBranchLinkMnemonic(info.mnemonic) || /\bpush\b/i.test(opcode);
        const isMemoryReturnLike = /^ldm/i.test(info.mnemonic) && /\{[^}]*\bpc\b[^}]*\}\^?/i.test(body);
        const isBranchLike = info.isBranch || info.writesPc;
        const cls = ["disasm-line", highlighted ? "highlight-line" : "", modeClass, isCallLike ? "entry-line" : "", isMemoryReturnLike ? "return-line" : "", isBranchLike ? "branch-line" : "", hasBp ? "breakpoint-line" : "", current ? "current" : ""].filter(Boolean).join(" ");
        return `<span class="${cls}">${line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`;
    }).join("");
}

function renderCallStack(data, options = {}) {
    data = normalizeCallStackData(data);
    const stacks = data && Array.isArray(data.stacks) ? data.stacks : [];
    const fallbackLaneId = Number(data?.activeStackId ?? stacks[0]?.id ?? 1);
    const selectedExists = stacks.some((stack) => stack.id === state.selectedCallstackLaneId);
    if (options.autoSelectActive || !selectedExists) state.selectedCallstackLaneId = fallbackLaneId;
    const selectedStack = stacks.find((stack) => stack.id === state.selectedCallstackLaneId) || stacks[0] || null;
    renderCallStackLanes(stacks, selectedStack ? selectedStack.id : null);
    const frames = selectedStack ? selectedStack.frames : (data && Array.isArray(data.frames) ? data.frames : []);
    if (!frames.length) {
        ui.callstackBody.innerHTML = `<tr><td colspan="9">${data && data.enabled ? "no frames recorded" : "stack trace disabled"}</td></tr>`;
        return;
    }
    ui.callstackBody.innerHTML = frames.map((frame) => {
        const caller = hex(frame.caller);
        const callee = hex(frame.callee);
        const highlighted = state.highlightedCallstackAddress === frame.caller || state.highlightedCallstackAddress === frame.callee;
        const cls = ["callstack-row", highlighted ? "highlight" : "", frame.modeClass].filter(Boolean).join(" ");
        const execMode = frame.synthetic ? `pc-write ${frame.kindName}` : `${frame.thumb ? "thumb" : "arm"} ${frame.modeName}`;
        const cpuMode = frame.modeName;
        const calleeText = frame.synthetic ? `${callee} ${frame.kindName}` : `${callee} (${frame.id})`;
        const returnTitle = frame.synthetic ? `expected ${hex(frame.expected)} target ${hex(frame.target)}` : `return ${hex(frame.returnAddress)}`;
        return `<tr class="${cls}"><td title="newest frame is the top row">${frame.ageLabel}</td><td title="${returnTitle}">${caller}</td><td>${calleeText}</td><td>${hex(frame.sp)}</td><td title="CPSR ${frame.cpsrHex}">${frame.cpsrHex}</td><td>${execMode}</td><td>${cpuMode}</td><td><button type="button" data-jump-address="${caller}" data-jump-cpsr="${frame.cpsr}" data-jump-label="caller">Caller</button></td><td><button type="button" data-jump-address="${callee}" data-jump-cpsr="${frame.cpsr}" data-jump-label="callee">Callee</button></td></tr>`;
    }).join("");
}

function renderCallStackLanes(stacks, selectedId) {
    if (!ui.callstackLaneTabs || !ui.callstackLaneTabTemplate) return;
    const fragment = document.createDocumentFragment();
    for (const stack of stacks) {
        const button = ui.callstackLaneTabTemplate.content.firstElementChild.cloneNode(true);
        button.dataset.laneId = String(stack.id);
        button.dataset.active = String(stack.id === selectedId);
        button.dataset.now = String(!!stack.active);
        button.querySelector("[data-lane-label]").textContent = `SP ${stack.spHex} PC ${stack.nowPcHex}`;
        button.querySelector("[data-lane-depth]").textContent = `${stack.depth}`;
        button.querySelector("[data-lane-now]").hidden = !stack.active;
        button.title = `lane ${stack.id}, depth ${stack.depth}, now PC ${stack.nowPcHex}`;
        fragment.append(button);
    }
    ui.callstackLaneTabs.replaceChildren(fragment);
}

async function refreshDebuggerViews(disasmParams = {}) {
    if (!disasmParams.keepHighlight) {
        state.highlightedDisasmAddress = null;
        state.highlightedCallstackAddress = null;
        state.highlightedCallstackCpsr = null;
    }
    renderRegisters();
    renderCallStack(readCallStackData(), { autoSelectActive: true });
    const disasm = await commands.disassemble(disasmRefreshParams(disasmParams));
    renderDisassembly(disasm.text);
    if (ui.memoryAuto.value === "1") renderMemoryDump(await commands.dumpMemory({ cpu: disasmParams.cpu }));
    syncNativeBreakStatus();
    updateStatus();
    return disasm;
}

function queueBreakpointRefresh(cpu = state.selectedCpu) {
    if (state.breakRefreshPending || !hasLoadedRom()) return;
    state.breakRefreshPending = true;
    if (state.breakRefreshTimer) clearTimeout(state.breakRefreshTimer);
    state.breakRefreshTimer = setTimeout(async () => {
        state.breakRefreshPending = false;
        state.breakRefreshTimer = 0;
        try {
            state.selectedCpu = cpu;
            ui.cpuSelect.value = cpu;
            setFollowPc(true);
            state.highlightedDisasmAddress = null;
            state.highlightedCallstackAddress = null;
            state.highlightedCallstackCpsr = null;
            await refreshDebuggerViews({ cpu, address: "pc", keepHighlight: true });
        } catch (error) {
            log(error.message || String(error));
        }
    }, 5);
}

function stopAutoUpdateLoop() {
    if (state.autoUpdate.timer) clearTimeout(state.autoUpdate.timer);
    state.autoUpdate.timer = 0;
}

function queueAutoUpdateLoop() {
    stopAutoUpdateLoop();
    if (!state.autoUpdate.enabled) return;
    const hz = Math.max(1, Math.min(20, Number(state.autoUpdate.hz) || 4));
    state.autoUpdate.timer = setTimeout(async () => {
        if (state.autoUpdate.enabled && state.ready && hasLoadedRom() && !state.loadingFile) {
            try {
                await refreshDebuggerViews({ keepHighlight: true });
            } catch (error) {
                log(error.message || String(error));
            }
        }
        queueAutoUpdateLoop();
    }, Math.max(50, Math.round(1000 / hz)));
}

async function runTraceStepper(label, params = {}, shouldStop) {
    ensureRomLoaded(`${label} requires a loaded ROM`);
    const cpu = String(params.cpu ?? state.selectedCpu);
    const pcBefore = getPc(cpu);
    state.fns.dbgClearBreakStatus();
    if (!ui.traceToggle.checked) await commands.setStackTraceMode({ enabled: true });
    if ((params.skipIrq ?? true) && !ui.tracePrivilegeToggle.checked) {
        await commands.setStackTracePrivilegeCheck({ enabled: true });
    }
    const startDepth = state.fns.traceGetDepth();
    const deadline = performance.now() + Math.max(1, Number(params.timeoutMs ?? 1000));
    const maxSteps = Math.max(1, Number(params.maxSteps ?? 200000));
    let steps = 0;
    while (performance.now() < deadline && steps < maxSteps) {
        await withCurrentExecBreakpointSuspended(cpu, async () => {
            state.fns.dbgStep(cpuIndex(cpu), 1);
        });
        steps++;
        const native = syncNativeBreakStatus();
        const callStack = readCallStackData();
        const depth = Number(callStack.depth ?? callStack.frames?.length ?? 0);
        if (native && native.lastBreak && native.lastBreak.hit) {
            await refreshDebuggerViews({ cpu });
            return attachDebuggerContext({ kind: label, ok: false, stoppedByBreakpoint: true, steps, depth, callStack: publicCallStackData(callStack, { ...params, cpu }) }, cpu, pcBefore, native);
        }
        if (shouldStop({ startDepth, depth, callStack })) {
            await refreshDebuggerViews({ cpu });
            return attachDebuggerContext({ kind: label, ok: true, steps, depth, callStack: publicCallStackData(callStack, { ...params, cpu }) }, cpu, pcBefore);
        }
    }
    await refreshDebuggerViews({ cpu });
    throw new Error(`${label} timeout after ${Math.max(1, Number(params.timeoutMs ?? 1000))}ms`);
}

function renderMemoryDump(result) {
    const bytes = result.bytes || [];
    const lines = [];
    const view = String(result.view || ui.memoryView?.value || "mixed");
    const breakpointAddresses = new Set(state.breakpoints.filter((bp) => bp.cpu === state.selectedCpu && (bp.type === "read" || bp.type === "write")).map((bp) => bp.address >>> 0));
    for (let i = 0; i < bytes.length; i += 16) {
        const slice = bytes.slice(i, i + 16);
        const cells = slice.map((b, j) => {
            const addr = result.address + i + j;
            const cls = ["memory-byte", breakpointAddresses.has(addr >>> 0) ? "breakpoint-memory" : ""].filter(Boolean).join(" ");
            return `<span class="${cls}" data-memory-address="${hex(addr)}" data-memory-value="${b.toString(16).padStart(2, "0")}">${b.toString(16).padStart(2, "0")}</span>`;
        }).join(" ");
        const words = [];
        for (let j = 0; j + 3 < slice.length; j += 4) {
            const wordAddress = (result.address + i + j) >>> 0;
            const highlightWord = breakpointAddresses.has(wordAddress) || breakpointAddresses.has((wordAddress + 1) >>> 0) || breakpointAddresses.has((wordAddress + 2) >>> 0) || breakpointAddresses.has((wordAddress + 3) >>> 0);
            const word = hex(readSized(slice, j, 4));
            words.push(highlightWord ? `<span class="memory-u32 breakpoint-memory">${word}</span>` : `<span class="memory-u32">${word}</span>`);
        }
        if (view === "packed32") lines.push(`<span class="memory-line">${hex(result.address + i)}  ${words.join("  ")}</span>`);
        else if (view === "bytes") lines.push(`<span class="memory-line">${hex(result.address + i)}  <span class="memory-bytes">${cells}</span></span>`);
        else lines.push(`<span class="memory-line">${hex(result.address + i)}  <span class="memory-bytes">${cells}</span>${words.length ? `  ${words.join("  ")}` : ""}</span>`);
    }
    ui.memoryOutput.innerHTML = lines.join("\n");
}

function modeNumber(mode) {
    return mode === "thumb" ? 1 : mode === "arm" ? 2 : 0;
}

function instructionWidthForMode(mode, cpu = state.selectedCpu) {
    if (mode === "thumb") return 2;
    if (mode === "arm") return 4;
    return (getRegisters(cpu).cpsr & 0x20) ? 2 : 4;
}

function readSized(bytes, offset, size) {
    if (size === 4) return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    if (size === 2) return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
    return bytes[offset] >>> 0;
}

function matchSearchCondition(condition, current, previous, value, hasPrevious) {
    if (condition === "changed") return hasPrevious && current !== previous;
    if (condition === "unchanged") return hasPrevious && current === previous;
    if (condition === "increased") return hasPrevious && current > previous;
    if (condition === "decreased") return hasPrevious && current < previous;
    if (condition === "notEqual") return current !== value;
    if (condition === "greater") return current > value;
    if (condition === "less") return current < value;
    return current === value;
}

async function idbPut(key, bytes) {
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("desmume-web-debugger", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("states");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
        const tx = db.transaction("states", "readwrite");
        tx.objectStore("states").put(bytes, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

async function idbGet(key) {
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("desmume-web-debugger", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("states");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const value = await new Promise((resolve, reject) => {
        const tx = db.transaction("states", "readonly");
        const req = tx.objectStore("states").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
}

const commands = {
    async status() {
        const waitMs = Math.max(0, Math.min(600000, Number(arguments[0]?.waitMs ?? arguments[0]?.ms ?? 0)));
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const native = state.ready ? JSON.parse(state.fns.dbgGetStatusJson()) : null;
        if (native) syncNativeBreakStatus(native);
        return { ready: state.ready, paused: state.paused, running: state.running, loadingFile: state.loadingFile, romLoaded: hasLoadedRom(), romSize: state.romSize, frame: state.frame, speed: state.speed, render: state.render, audio: state.audio, cpu: state.selectedCpu, recentFiles: state.recentFiles, autoUpdate: { enabled: state.autoUpdate.enabled, hz: state.autoUpdate.hz }, native };
    },
    async loadRomFile() {
        const { file, bytes } = ui.romFile.files && ui.romFile.files[0] ? await readFileFromInput(ui.romFile) : await openPicker(ui.romFile);
        await ensureWasmReady();
        pauseForFileLoad();
        try {
            writeRomFile(file.name, bytes);
            const ret = await reloadCurrentRom({ waitMs: bootWaitMs(), resume: true });
            log(`ROM loaded: ${file.name} (${bytes.length} bytes)`);
            return { ok: ret === 0, ret, name: file.name, size: bytes.length, waitMs: bootWaitMs(), romLoaded: state.fns.isRomLoaded() === 1 };
        } finally {
            restoreAfterFileLoad({ running: true, paused: false });
        }
    },
    async loadRomBytes(params = {}) {
        await ensureWasmReady();
        const bytes = bytesFromParams(params);
        pauseForFileLoad();
        try {
            writeRomFile(params.name || "mcp-rom.nds", bytes);
            const ret = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume: params.resume !== false });
            log(`ROM loaded from MCP bytes: ${params.name || "mcp-rom.nds"} (${bytes.length} bytes)`);
            return { ok: ret === 0, ret, name: params.name || "mcp-rom.nds", size: bytes.length, waitMs: bootWaitMs(params), romLoaded: state.fns.isRomLoaded() === 1 };
        } finally {
            restoreAfterFileLoad({ running: params.resume !== false, paused: params.resume === false });
        }
    },
    async loadRomUrl(params = {}) {
        ensureReady();
        const url = String(params.url || "");
        if (!url) throw new Error("url is required");
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`ROM fetch failed: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return commands.loadRomBytes({ ...params, bytes, name: params.name || url.split("/").pop() || "url-rom.nds" });
    },
    async importSaveFile() {
        ensureReady();
        const { file, bytes } = ui.saveFile.files && ui.saveFile.files[0] ? await readFileFromInput(ui.saveFile) : await openPicker(ui.saveFile);
        const runState = pauseForFileLoad();
        try {
            const saveLoad = await applySaveAndReloadRom(file.name, bytes, { waitMs: bootWaitMs() });
            let ret = saveLoad.ret;
            if (ret === 0) {
                rememberSlot(ui.stateSlot.value);
                await idbPut(`save:${ui.stateSlot.value}`, bytes);
                await recordRecentFile("save", file.name, bytes, ui.stateSlot.value);
                ui.storageStatus.textContent = `save loaded ${ui.stateSlot.value}`;
            }
            log(`save imported via ${saveLoad.path}: ${file.name}`);
            return { ok: ret === 0, ret, size: bytes.length, reset: ret === 0, reloaded: ret === 0, path: saveLoad.path };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async exportSaveFile() {
        ensureRomLoaded("save export requires a loaded ROM");
        const ret = state.fns.savExportToFile();
        if (ret !== 0) throw new Error("save export failed");
        const bytes = state.module.FS.readFile("export.sav");
        download("desmume-save.sav", bytes);
        return { ok: true, size: bytes.length };
    },
    async saveSaveSlot(params = {}) {
        ensureRomLoaded("save slot export requires a loaded ROM");
        const slot = String(params.slot ?? ui.stateSlot.value);
        rememberSlot(slot);
        const ret = state.fns.savExportToFile();
        if (ret !== 0) throw new Error("save export failed");
        const bytes = state.module.FS.readFile("export.sav");
        if (!bytes.length) throw new Error("save export produced an empty buffer");
        await idbPut(`save:${slot}`, bytes);
        await recordRecentFile("save", slot, bytes, slot);
        ui.storageStatus.textContent = `save saved ${slot}`;
        return { ok: true, slot, size: bytes.length };
    },
    async loadSaveSlot(params = {}) {
        ensureReady();
        const slot = String(params.slot ?? ui.stateSlot.value);
        rememberSlot(slot);
        const bytes = await idbGet(`save:${slot}`);
        if (!bytes) throw new Error(`save slot not found: ${slot}`);
        const runState = pauseForFileLoad();
        try {
            const saveLoad = await applySaveAndReloadRom(slot, bytes, { waitMs: bootWaitMs() });
            let ret = saveLoad.ret;
            ui.storageStatus.textContent = `save loaded ${slot}`;
            await recordRecentFile("save", slot, bytes, slot);
            return { ok: ret === 0, ret, slot, size: bytes.length, reset: ret === 0, reloaded: ret === 0, paused: runState.paused, path: saveLoad.path };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async saveState(params = {}) {
        ensureRomLoaded("state save requires a loaded ROM");
        const size = state.fns.saveStateToBuffer();
        if (size <= 0) throw new Error("state save failed");
        const ptr = state.fns.stateGetPointer(0);
        const bytes = state.module.HEAPU8.slice(ptr, ptr + size);
        if (params.slot) {
            rememberSlot(params.slot);
            if (bytes.length > 256 * 1024 * 1024) throw new Error("state exceeds 256MB browser storage limit");
            await idbPut(String(params.slot), bytes);
            await recordRecentFile("state", String(params.slot), bytes, String(params.slot));
            ui.storageStatus.textContent = `state saved ${params.slot}`;
        }
        dispatchScriptEvent("stateSave", { size, slot: params.slot || null });
        return { ok: true, size };
    },
    async loadState(params = {}) {
        ensureRomLoaded("state load requires a loaded ROM");
        const runState = pauseForFileLoad();
        let bytes = null;
        try {
            if (params.slot) rememberSlot(params.slot);
            if (params.slot) bytes = await idbGet(String(params.slot));
            if (params.slot && !bytes) throw new Error(`state slot not found: ${params.slot}`);
            let ret = 0;
            if (bytes) {
                ret = loadStateBytesFromMemory(bytes);
            } else {
                const size = state.fns.stateGetSize();
                if (size <= 0) throw new Error("in-memory state is empty");
                ret = state.fns.loadStateFromBuffer(size);
            }
            if (ret !== 0) throw new Error(`state load failed (${ret})`);
            state.frame = 0;
            blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
            drawLoadedStateFrame();
            dispatchScriptEvent("stateLoad", { slot: params.slot || null });
            return { ok: true, paused: runState.paused, reset: false };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async importStateFile(params = {}) {
        ensureRomLoaded("state import requires a loaded ROM");
        const { file, bytes } = ui.stateFile.files && ui.stateFile.files[0] ? await readFileFromInput(ui.stateFile) : await openPicker(ui.stateFile);
        const runState = pauseForFileLoad();
        try {
            state.module.FS.writeFile("import.dst", bytes);
            const ret = state.fns.loadStateFromFile();
            if (ret !== 0) throw new Error(`state import failed (${ret})`);
            state.frame = 0;
            blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
            drawLoadedStateFrame();
            await recordRecentFile("state", file.name, bytes);
            log(`state imported: ${file.name}`);
            return { ok: ret === 0, ret, size: bytes.length, reset: false, paused: runState.paused };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async loadStateBytes(params = {}) {
        ensureRomLoaded("state byte load requires a loaded ROM");
        const bytes = bytesFromParams(params);
        const runState = pauseForFileLoad();
        try {
            state.module.FS.writeFile("import.dst", bytes);
            const ret = state.fns.loadStateFromFile();
            if (ret !== 0) throw new Error(`state byte load failed (${ret})`);
            state.frame = 0;
            blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
            drawLoadedStateFrame();
            log(`state loaded from MCP bytes: ${params.name || "mcp-state.dst"}`);
            return { ok: ret === 0, ret, size: bytes.length, reset: false, paused: runState.paused };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async loadStateUrl(params = {}) {
        ensureReady();
        const url = String(params.url || "");
        if (!url) throw new Error("url is required");
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`state fetch failed: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return commands.loadStateBytes({ ...params, bytes, name: params.name || url.split("/").pop() || "url-state.dst" });
    },
    async listRecentFiles() { renderRecentFiles(); return { recentFiles: state.recentFiles }; },
    async reloadRecentFile(params = {}) {
        ensureReady();
        const id = String(params.id ?? ui.recentFileSelect.value);
        const item = state.recentFiles.find((x) => x.id === id);
        if (!item) throw new Error(`recent file not found: ${id}`);
        if (item.slot) rememberSlot(item.slot);
        const bytes = item.key ? await idbGet(item.key) : item.slot ? await idbGet(`${item.kind}:${item.slot}`) : null;
        if (!bytes) throw new Error(`recent bytes not found: ${id}`);
        if (item.kind === "save") {
            const runState = pauseForFileLoad();
            try {
                const saveLoad = await applySaveAndReloadRom(item.name || item.slot || "save.sav", bytes, { waitMs: bootWaitMs() });
                let ret = saveLoad.ret;
                return { ok: ret === 0, ret, item, size: bytes.length, reset: ret === 0, reloaded: ret === 0, paused: runState.paused, path: saveLoad.path };
            } finally {
                restoreAfterFileLoad(runState);
            }
        }
        const runState = pauseForFileLoad();
        try {
            ensureRomLoaded("recent state reload requires a loaded ROM");
            const ret = item.slot ? loadStateBytesFromMemory(bytes) : (state.module.FS.writeFile("import.dst", bytes), state.fns.loadStateFromFile());
            if (ret !== 0) throw new Error(`recent state load failed (${ret})`);
            state.frame = 0;
            blockSaveFlush(Number(params.saveFlushBlockMs ?? 30000));
            drawLoadedStateFrame();
            return { ok: ret === 0, ret, item, size: bytes.length, paused: runState.paused };
        } finally {
            restoreAfterFileLoad(runState);
        }
    },
    async exportStateFile() {
        ensureRomLoaded("state export requires a loaded ROM");
        const result = await commands.saveState();
        const ptr = state.fns.stateGetPointer(0);
        download("desmume-state.dst", state.module.HEAPU8.slice(ptr, ptr + result.size));
        return result;
    },
    async takeScreenshot(params = {}) {
        const cooldownMs = Math.max(250, Number(params.cooldownMs ?? 1200));
        if (performance.now() < state.screenshotCooldownUntil) throw new Error("screenshot cooldown active");
        state.screenshotCooldownUntil = performance.now() + cooldownMs;
        const type = "image/png";
        const name = String(params.name || `desmume-${Date.now()}.png`);
        const dataUrl = ui.screen.toDataURL(type);
        if (params.download !== false) {
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = name;
            a.click();
        }
        return { ok: true, type, name, width: ui.screen.width, height: ui.screen.height, cooldownMs, dataUrl: params.includeDataUrl ? dataUrl : undefined };
    },
    async setAutoUpdate(params = {}) {
        state.autoUpdate.enabled = !!params.enabled;
        state.autoUpdate.hz = Math.max(1, Math.min(20, Number(params.hz ?? params.rate ?? ui.autoUpdateRate.value) || 4));
        ui.autoUpdateToggle.checked = state.autoUpdate.enabled;
        ui.autoUpdateRate.value = String(state.autoUpdate.hz);
        if (state.autoUpdate.enabled) queueAutoUpdateLoop();
        else stopAutoUpdateLoop();
        return { enabled: state.autoUpdate.enabled, hz: state.autoUpdate.hz };
    },
    async pause() { ensureReady(); state.explicitPauseSerial++; state.paused = true; state.running = false; state.fns.pauseEmu(1); updateStatus(); return { ok: true }; },
    async resume() {
        ensureReady();
        if (!hasLoadedRom()) {
            state.breakLabel = "ROM not loaded";
            state.paused = true;
            state.running = false;
            state.fns.pauseEmu(1);
            updateStatus();
            return { ok: false, romLoaded: false, reason: "ROM is not loaded" };
        }
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.paused = false;
        state.running = true;
        state.fns.dbgClearBreakStatus();
        state.fns.pauseEmu(0);
        updateStatus();
        return { ok: true, romLoaded: true };
    },
    async reset(params = {}) {
        ensureRomLoaded("reset requires a loaded ROM");
        const runState = pauseForFileLoad();
        const hold = params.holdPaused ?? params.hold ?? ui.resetHoldToggle.checked;
        try {
            const ret = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume: !hold && runState.running && !runState.paused });
            if (ret === 0) dispatchScriptEvent("start", { generation: ++state.scriptStartGeneration, reason: "reset" });
            return { ok: ret === 0, ret, reloaded: ret === 0, held: !!hold, waitMs: bootWaitMs(params), romLoaded: state.fns.isRomLoaded() === 1 };
        } finally {
            if (hold) restoreAfterFileLoad({ running: false, paused: true });
            else restoreAfterFileLoad(runState);
        }
    },
    async reloadRom(params = {}) {
        ensureRomLoaded("ROM reload requires a loaded ROM");
        const runState = pauseForFileLoad();
        const resume = params.resume === true || (params.resume !== false && runState.running && !runState.paused && !ui.resetHoldToggle.checked);
        try {
            const ret = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume });
            if (ret === 0) dispatchScriptEvent("start", { generation: ++state.scriptStartGeneration, reason: "reloadRom" });
            return { ok: ret === 0, ret, reloaded: ret === 0, resumed: resume, waitMs: bootWaitMs(params), romLoaded: state.fns.isRomLoaded() === 1 };
        } finally {
            if (!resume) restoreAfterFileLoad({ running: false, paused: true });
            else restoreAfterFileLoad(runState);
        }
    },
    async setSpeed(params) { state.speed = Math.min(4, Math.max(0.25, Number(params.speed ?? params.value ?? 1))); ui.speedSelect.value = String(state.speed); updateStatus(); return { speed: state.speed }; },
    async stepFrames(params) {
        ensureRomLoaded("frame stepping requires a loaded ROM");
        if (state.running && !state.paused && params.pauseWhenRunning !== false) return commands.pause();
        const frames = Math.max(1, Number(params.frames ?? 1));
        const wasPaused = state.paused;
        state.fns.pauseEmu(0);
        applyFreezes();
        let ran = 0;
        try {
            if (state.touch.active) {
                for (let i = 0; i < frames; i++) {
                    ran++;
                    if (state.fns.runFrame(state.render && i === frames - 1 ? 1 : 0, state.keys, 1, state.touch.x, state.touch.y) !== 0) break;
                }
            } else {
                ran = state.fns.runFrames(frames, state.render ? 1 : 0, state.keys);
            }
        } catch (error) {
            handleNativeFault(error, "stepFrames");
            throw error;
        }
        applyFreezes();
        drawFrame();
        pumpAudio(ran);
        const native = syncNativeBreakStatus();
        const hitBreak = !!(native && native.lastBreak && native.lastBreak.hit);
        for (let i = 0; i < ran; i++) dispatchScriptEvent("tick", { frame: state.frame - ran + i + 1, cpu: state.selectedCpu });
        if (wasPaused || ran < frames || hitBreak) state.fns.pauseEmu(1);
        state.paused = wasPaused || ran < frames || hitBreak;
        state.running = !state.paused;
        updateStatus();
        return { frames: ran, requested: frames, paused: state.paused };
    },
    async setRenderEnabled(params) { state.render = !!params.enabled; ui.renderToggle.checked = state.render; return { render: state.render }; },
    async setAudio(params) {
        state.audio = !!params.enabled;
        ui.audioToggle.checked = state.audio;
        ui.volumeRange.value = Number(params.volume ?? ui.volumeRange.value);
        if (state.audio && state.audioContext && state.audioContext.state === "suspended") await state.audioContext.resume();
        return { audio: state.audio, volume: Number(ui.volumeRange.value) };
    },
    async setScale(params) { state.scale = Number(params.scale ?? params.value ?? 2); ui.scaleSelect.value = String(state.scale); applyScaleRotation(); return { scale: state.scale }; },
    async setRotation(params) { state.rotation = Number(params.rotation ?? params.value ?? 0); ui.rotationSelect.value = String(state.rotation); applyScaleRotation(); return { rotation: state.rotation }; },
    async setInput(params) { setKey(params.button, !!params.pressed); return { keys: state.keys }; },
    async runInputHold(params = {}) {
        ensureRomLoaded("input hold requires a loaded ROM");
        const buttons = toButtonList(params);
        const durationMs = Math.max(0, Number(params.durationMs ?? params.holdMs ?? 0));
        const deadline = params.timeoutMs ? performance.now() + Math.max(1, Number(params.timeoutMs)) : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runInputHold");
        buttons.forEach((button) => setKey(button, true));
        try {
            await waitChecked(durationMs, deadline, "runInputHold");
        } finally {
            buttons.forEach((button) => setKey(button, false));
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runInputHold");
        return { ok: true, buttons, durationMs };
    },
    async runInputTap(params = {}) {
        ensureRomLoaded("input tap requires a loaded ROM");
        const buttons = toButtonList(params);
        const repeat = Math.max(1, Number(params.repeat ?? params.count ?? 1));
        const holdMs = Math.max(0, Number(params.holdMs ?? params.pressMs ?? 50));
        const gapMs = Math.max(0, Number(params.gapMs ?? params.waitMs ?? 50));
        const deadline = params.timeoutMs ? performance.now() + Math.max(1, Number(params.timeoutMs)) : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runInputTap");
        for (let i = 0; i < repeat; i++) {
            buttons.forEach((button) => setKey(button, true));
            try {
                await waitChecked(holdMs, deadline, "runInputTap");
            } finally {
                buttons.forEach((button) => setKey(button, false));
            }
            if (i < repeat - 1) await waitChecked(gapMs, deadline, "runInputTap");
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runInputTap");
        return { ok: true, buttons, repeat, holdMs, gapMs };
    },
    async runTouchHold(params = {}) {
        ensureRomLoaded("touch hold requires a loaded ROM");
        const x = Math.max(0, Math.min(255, Number(params.x)));
        const y = Math.max(0, Math.min(191, Number(params.y)));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required");
        const durationMs = Math.max(0, Number(params.durationMs ?? params.holdMs ?? 0));
        const deadline = params.timeoutMs ? performance.now() + Math.max(1, Number(params.timeoutMs)) : 0;
        await waitChecked(params.waitBeforeMs ?? 0, deadline, "runTouchHold");
        setTouchState(true, x, y);
        try {
            await waitChecked(durationMs, deadline, "runTouchHold");
        } finally {
            setTouchState(false, x, y);
        }
        await waitChecked(params.waitAfterMs ?? 0, deadline, "runTouchHold");
        return { ok: true, x, y, durationMs };
    },
    async setKeyBinding(params) {
        const button = String(params.button);
        const key = String(params.key || "").trim();
        if (state.buttons[button] === undefined) throw new Error(`unknown button: ${button}`);
        if (!key) throw new Error("key is required");
        for (const [code, mapped] of Object.entries(state.keymap)) {
            if (mapped === button || code === key) delete state.keymap[code];
        }
        state.keymap[key] = button;
        saveKeymap();
        renderHotkey();
        return { keymap: state.keymap };
    },
    async getRegisters(params = {}) { return getRegisters(params.cpu); },
    async setRegister(params) {
        ensureRomLoaded("register write requires a loaded ROM");
        const register = String(params.register).toLowerCase();
        const names = { sp: 13, lr: 14, pc: 15, cpsr: 16, spsr: 17 };
        const reg = names[register] ?? Number(register.replace("r", ""));
        if (!Number.isInteger(reg) || reg < 0 || reg > 17) throw new Error(`unknown register: ${register}`);
        const ret = state.fns.dbgSetReg(cpuIndex(params.cpu), reg, parseNumber(params.value));
        renderRegisters();
        return { ok: ret === 0, ret };
    },
    async disassemble(params = {}) {
        ensureRomLoaded("disassembly requires a loaded ROM");
        const mode = params.mode ?? ui.disasmMode.value;
        const before = Math.max(0, Math.min(64, Number(params.before ?? ui.disasmBefore.value ?? 0)));
        const width = instructionWidthForMode(mode, params.cpu);
        const base = parseAddress(params.address ?? ui.disasmAddress.value, getPc(params.cpu), params.cpu);
        const addr = (base - before * width) >>> 0;
        const count = Number(params.count ?? ui.disasmCount.value);
        const text = state.fns.dbgDisassemble(cpuIndex(params.cpu), addr, count + before, modeNumber(mode));
        return { address: addr, before, includeBytes: shouldIncludeDisassemblyBytes(params), text: formatDisassemblyText(text, shouldIncludeDisassemblyBytes(params)) };
    },
    async disassembleBytes(params = {}) {
        await ensureWasmReady();
        const mode = String(params.mode ?? "arm").toLowerCase();
        if (mode !== "arm" && mode !== "thumb") throw new Error("mode must be arm or thumb");
        const modeId = mode === "thumb" ? 1 : 2;
        const width = mode === "thumb" ? 2 : 4;
        const endian = String(params.endian ?? params.byteOrder ?? "little").toLowerCase();
        const start = parseAddress(params.address ?? params.base ?? 0, 0, params.cpu);
        const rows = [];
        let incompleteBytes = 0;
        const words = opcodeWordsFromInput(params);
        if (words) {
            words.forEach((word, index) => {
                const opcode = mode === "thumb" ? word & 0xffff : word >>> 0;
                const address = (start + index * width) >>> 0;
                const mnemonic = state.fns.dbgDisassembleOpcode(address, opcode, modeId);
                rows.push({ offset: index * width, address, opcode, mnemonic, undefined: mnemonic.includes("UNDEFINED") });
            });
        } else {
            const bytes = bytesFromFlexibleParams(params);
            const usable = bytes.length - (bytes.length % width);
            incompleteBytes = bytes.length - usable;
            for (let offset = 0; offset < usable; offset += width) {
                const opcode = mode === "thumb" ? u16FromBytes(bytes, offset, endian) : u32FromBytes(bytes, offset, endian);
                const address = (start + offset) >>> 0;
                const mnemonic = state.fns.dbgDisassembleOpcode(address, opcode, modeId);
                rows.push({ offset, address, opcode, mnemonic, undefined: mnemonic.includes("UNDEFINED") });
            }
        }
        const hasUndefined = rows.some((row) => row.undefined);
        const text = rows.map((row) => `${row.offset}: ${row.mnemonic}`).join("\n");
        return { ok: !hasUndefined && incompleteBytes === 0, error: hasUndefined || incompleteBytes > 0, hasUndefined, incompleteBytes, mode, endian, count: rows.length, rows, text };
    },
    async binaryFloat(params = {}) {
        await ensureWasmReady();
        const bits = Number(params.bits ?? params.size ?? 32);
        if (bits !== 32 && bits !== 64) throw new Error("bits must be 32 or 64");
        const op = String(params.op ?? params.action ?? "decode").toLowerCase();
        const encode = op === "encode";
        const parts = encode ? { low: 0, high: 0 } : splitBinaryBits(params, bits);
        const numeric = encode ? Number(params.value) : 0;
        const result = JSON.parse(state.fns.utilBinaryFloat(bits, parts.low >>> 0, parts.high >>> 0, numeric, encode ? 1 : 0));
        result.op = encode ? "encode" : "decode";
        return result;
    },
    async dumpMemory(params = {}) {
        ensureRomLoaded("memory dump requires a loaded ROM");
        const addr = parseAddress(params.address ?? ui.memoryAddress.value, 0, params.cpu);
        const length = Math.min(65536, Number(params.length ?? ui.memoryLength.value));
        const view = String(params.view ?? ui.memoryView?.value ?? "mixed");
        const ptr = state.fns.dbgDumpMemory(cpuIndex(params.cpu), addr, length);
        const bytes = [...state.module.HEAPU8.slice(ptr, ptr + length)];
        const lines = [];
        const words32 = [];
        for (let i = 0; i < bytes.length; i += 16) {
            const slice = bytes.slice(i, i + 16);
            const formattedWords = [];
            for (let j = 0; j + 3 < slice.length; j += 4) {
                const word = readSized(slice, j, 4);
                words32.push({ address: addr + i + j, value: word });
                formattedWords.push(hex(word));
            }
            if (view === "packed32") lines.push(`${hex(addr + i)}  ${formattedWords.join("  ")}`);
            else if (view === "bytes") lines.push(`${hex(addr + i)}  ${slice.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
            else lines.push(`${hex(addr + i)}  ${slice.map((b) => b.toString(16).padStart(2, "0")).join(" ")}${formattedWords.length ? `    ${formattedWords.join("  ")}` : ""}`);
        }
        return { address: addr, bytes, words32, view, text: lines.join("\n") };
    },
    async injectMemoryFile(params = {}) {
        ensureRomLoaded("memory injection requires a loaded ROM");
        const addr = parseAddress(params.address ?? ui.memoryAddress.value, 0, params.cpu);
        const { file, bytes } = params.bytes
            ? { file: { name: params.name || "api-bytes" }, bytes: new Uint8Array(params.bytes) }
            : ui.memoryInjectFile.files && ui.memoryInjectFile.files[0]
                ? await readFileFromInput(ui.memoryInjectFile)
                : await openPicker(ui.memoryInjectFile);
        for (let i = 0; i < bytes.length; i++) state.fns.dbgWrite8(cpuIndex(params.cpu), addr + i, bytes[i]);
        log(`memory injected: ${file.name} -> ${hex(addr)} (${bytes.length} bytes)`);
        const visibleStart = parseAddress(ui.memoryAddress.value, 0, params.cpu);
        const visibleLength = Number(ui.memoryLength.value);
        if (addr >= visibleStart && addr < visibleStart + visibleLength) renderMemoryDump(await commands.dumpMemory({ cpu: params.cpu }));
        return { ok: true, address: addr, size: bytes.length, name: file.name };
    },
    async injectBytes(params = {}) {
        const bytes = bytesFromFlexibleParams(params);
        return commands.injectMemoryFile({ ...params, bytes: [...bytes], name: params.name || "api-bytes" });
    },
    async searchMemory(params = {}) {
        ensureRomLoaded("memory search requires a loaded ROM");
        const ranges = memorySearchRanges(params);
        const rangeKey = memorySearchRangeKey(ranges);
        const size = Math.max(1, Math.min(4, Number(params.size ?? ui.searchSize.value)));
        const condition = String(params.condition ?? ui.searchCondition.value);
        const value = parseNumber(params.value ?? ui.searchValue.value);
        const limit = Math.max(1, Math.min(10000, Number(params.limit ?? ui.searchLimit.value)));
        const refine = params.refine !== false && state.search.snapshot && state.search.rangeKey === rangeKey && state.search.size === size;
        const snapshots = new Map();
        const previousSnapshots = refine ? state.search.snapshot : null;
        const candidates = refine && state.search.addresses ? state.search.addresses : null;
        const matches = [];
        const findRange = (address) => ranges.find((range) => address >= range.address && address + size <= range.address + range.length);
        const scanRange = (range, offsets) => {
            const ptr = state.fns.dbgDumpMemory(cpuIndex(params.cpu), range.address, range.length);
            const current = state.module.HEAPU8.slice(ptr, ptr + range.length);
            snapshots.set(range.name, current);
            const previous = previousSnapshots && previousSnapshots.get ? previousSnapshots.get(range.name) : null;
            const maxOffset = Math.max(0, range.length - size);
            const testOffset = (offset) => {
                if (offset < 0 || offset > maxOffset) return false;
            const nowValue = readSized(current, offset, size);
            const oldValue = previous && offset + size <= previous.length ? readSized(previous, offset, size) : 0;
            if (matchSearchCondition(condition, nowValue, oldValue, value, !!previous)) {
                    matches.push({ address: range.address + offset, range: range.name, value: nowValue, previous: previous ? oldValue : null });
                return matches.length >= limit;
            }
            return false;
        };
            if (offsets) {
                for (const offset of offsets) if (testOffset(offset)) return true;
            } else {
                for (let offset = 0; offset <= maxOffset; offset += size) if (testOffset(offset)) return true;
            }
            return false;
        };
        if (candidates) {
            const byRange = new Map();
            for (const address of candidates) {
                const range = findRange(address);
                if (!range) continue;
                if (!byRange.has(range.name)) byRange.set(range.name, []);
                byRange.get(range.name).push(address - range.address);
            }
            for (const range of ranges) if (scanRange(range, byRange.get(range.name) || [])) break;
        } else {
            for (const range of ranges) if (scanRange(range, null)) break;
        }
        state.search = { snapshot: snapshots, ranges, addresses: matches.map((item) => item.address), address: ranges[0]?.address ?? 0, length: ranges.reduce((sum, range) => sum + range.length, 0), size, rangeKey };
        const text = matches.map((item) => `${item.range} ${hex(item.address)}  ${hex(item.value, size * 2)}${item.previous === null ? "" : `  prev ${hex(item.previous, size * 2)}`}`).join("\n") || "no matches";
        return { ranges, size, condition, totalShown: matches.length, truncated: matches.length >= limit, matches, text };
    },
    async resetMemorySearch() {
        state.search = { snapshot: null, ranges: null, addresses: null, address: 0, length: 0, size: 1, rangeKey: "" };
        ui.searchOutput.textContent = "search reset";
        return { ok: true };
    },
    async writeMemory(params) {
        ensureRomLoaded("memory write requires a loaded ROM");
        const addr = parseAddress(params.address, 0, params.cpu);
        const value = parseNumber(params.value);
        const size = Number(params.size ?? 1);
        const fn = size === 4 ? "dbgWrite32" : size === 2 ? "dbgWrite16" : "dbgWrite8";
        return { ok: state.fns[fn](cpuIndex(params.cpu), addr, value) === 0 };
    },
    async setMemoryFreeze(params) {
        ensureRomLoaded("memory freeze requires a loaded ROM");
        const item = {
            cpu: String(params.cpu ?? state.selectedCpu),
            address: parseAddress(params.address, 0, params.cpu),
            value: parseNumber(params.value),
            size: Number(params.size ?? 1),
            enabled: params.enabled !== false
        };
        state.freezes = state.freezes.filter((x) => !(x.cpu === item.cpu && x.address === item.address && x.size === item.size));
        if (item.enabled) state.freezes.push(item);
        applyFreezes();
        renderFreezes();
        return { freezes: state.freezes };
    },
    async listMemoryFreezes() { return state.freezes; },
    async setBreakpoint(params) {
        ensureRomLoaded("breakpoints require a loaded ROM");
        if (params.id && params.enabled === false) return commands.removeBreakpoint({ id: params.id });
        const bp = { id: Number(params.id ?? state.nextBreakpointId++), cpu: String(params.cpu ?? state.selectedCpu), type: String(params.type ?? "exec"), address: parseAddress(params.address, 0, params.cpu), enabled: params.enabled !== false };
        const fn = bp.type === "read" ? "dbgSetReadBreakpoint" : bp.type === "write" ? "dbgSetWriteBreakpoint" : "dbgSetExecBreakpoint";
        state.fns[fn](cpuIndex(bp.cpu), bp.address, bp.enabled ? 1 : 0);
        state.breakpoints = state.breakpoints.filter((x) => !(x.cpu === bp.cpu && x.type === bp.type && x.address === bp.address));
        if (bp.enabled) state.breakpoints.push(bp);
        renderBreakpoints();
        refreshDebuggerViews({ keepHighlight: true }).catch((error) => log(error.message));
        return { id: bp.id, breakpoints: state.breakpoints };
    },
    async setSpecialBreakpoint(params = {}) {
        ensureRomLoaded("special breakpoints require a loaded ROM");
        const kindMap = { dataAbort: 3, prefetchAbort: 4, undefinedInstruction: 5, undefined: 5 };
        const kind = kindMap[String(params.kind)] ?? Number(params.kind);
        const ret = state.fns.dbgSetSpecialBreakpoint(kind, params.enabled ? 1 : 0);
        ui.bpDataAbortToggle.checked = params.kind === "dataAbort" ? !!params.enabled : ui.bpDataAbortToggle.checked;
        ui.bpPrefetchAbortToggle.checked = params.kind === "prefetchAbort" ? !!params.enabled : ui.bpPrefetchAbortToggle.checked;
        ui.bpUndefinedToggle.checked = (params.kind === "undefinedInstruction" || params.kind === "undefined") ? !!params.enabled : ui.bpUndefinedToggle.checked;
        return { ok: ret === 0, kind, enabled: !!params.enabled };
    },
    async listBreakpoints() { return state.breakpoints; },
    async removeBreakpoint(params = {}) {
        ensureRomLoaded("breakpoint removal requires a loaded ROM");
        const id = Number(params.id ?? ui.bpIdSelect.value);
        const bp = state.breakpoints.find((x) => x.id === id);
        if (!bp) throw new Error(`breakpoint not found: ${id}`);
        const fn = bp.type === "read" ? "dbgSetReadBreakpoint" : bp.type === "write" ? "dbgSetWriteBreakpoint" : "dbgSetExecBreakpoint";
        state.fns[fn](cpuIndex(bp.cpu), bp.address, 0);
        state.breakpoints = state.breakpoints.filter((x) => x.id !== id);
        renderBreakpoints();
        refreshDebuggerViews({ keepHighlight: true }).catch((error) => log(error.message));
        return { ok: true, removed: bp, breakpoints: state.breakpoints };
    },
    async clearBreakStatus() { ensureReady(); state.lastBreakKey = ""; state.breakRefreshKey = ""; state.breakLabel = ""; updateStatus(); return { ok: state.fns.dbgClearBreakStatus() === 0 }; },
    async step(params = {}) { return runDebuggerInstruction("step", params); },
    async smartStep(params = {}) { return runDebuggerInstruction("smartStep", params); },
    async stepOver(params = {}) {
        ensureRomLoaded("step over requires a loaded ROM");
        log("step over can still collide with other breakpoints; plain step is safer.");
        return runDebuggerInstruction("stepOver", params);
    },
    async stepNextBranchOrReturn(params = {}) { return runUntilNextBranchOrReturn(params); },
    async trueNextBranch(params = {}) { return runUntilTrueNextBranch(params); },
    async continue() { return commands.resume(); },
    async setStackTraceMode(params) { ensureReady(); state.fns.traceSetEnabled(params.enabled ? 1 : 0); ui.traceToggle.checked = !!params.enabled; if (!params.enabled) state.selectedCallstackLaneId = null; renderCallStack(readCallStackData(), { autoSelectActive: !!params.enabled }); return { enabled: !!params.enabled }; },
    async setStackTracePrivilegeCheck(params) { ensureReady(); state.fns.traceSetPrivilegeCheck(params.enabled ? 1 : 0); ui.tracePrivilegeToggle.checked = !!params.enabled; return { enabled: !!params.enabled }; },
    async stackTrace(params = {}) { ensureRomLoaded("stack trace requires a loaded ROM"); const callStack = readCallStackData(params); renderCallStack(callStack); return { callStack: publicCallStackData(callStack, params), text: state.fns.dbgStackTrace(cpuIndex(params.cpu), Number(params.words ?? 32)) }; },
    async callStack(params = {}) { ensureRomLoaded("call stack requires a loaded ROM"); const callStack = readCallStackData(params); renderCallStack(callStack); return publicCallStackData(callStack, params); },
    async listOtherCoroutines(params = {}) {
        ensureRomLoaded("other coroutine list requires a loaded ROM");
        const callStack = readCallStackData(params);
        renderCallStack(callStack);
        const details = publicOtherCoroutines(callStack, params);
        return { ...details, coroutines: details.coroutines.map(({ frames, ...summary }) => summary) };
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
        const rows = callStack.frames.map((frame) => `| ${frame.ageLabel} | ${hex(frame.caller)} | ${hex(frame.returnAddress)} | ${hex(frame.callee)} | ${hex(frame.sp)} | ${frame.cpsrHex} | ${frame.modeName} | ${frame.thumb ? "thumb" : "arm"} | ${frame.id} |`);
        const text = ["| age | caller | return | callee | sp | cpsr | mode | isa | id |", "|---|---|---|---|---|---|---|---|---:|", ...rows].join("\n");
        renderCallStack(callStack);
        return { text: await copyText(text, "call stack markdown"), callStack };
    },
    async copyCallStackCsv() {
        ensureRomLoaded("call stack copy requires a loaded ROM");
        const callStack = readCallStackData({ limit: 512 });
        const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
        const rows = callStack.frames.map((frame) => [frame.ageLabel, hex(frame.caller), hex(frame.returnAddress), hex(frame.callee), hex(frame.sp), frame.cpsrHex, frame.modeName, frame.thumb ? "thumb" : "arm", frame.id].map(escape).join(","));
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
        return commands.status();
    },
    async waitMs(params = {}) { return commands.wait(params); },
    async nextFunctionEnter(params = {}) { return commands.runUntilNextCall(params); },
    async nextCall(params = {}) { return commands.runUntilNextCall(params); },
    async nextFunctionCall(params = {}) { return commands.runUntilNextCall(params); },
    async nextBranchOrReturn(params = {}) { return commands.stepNextBranchOrReturn(params); },
    async nextTrueBranch(params = {}) { return commands.trueNextBranch(params); },
    async returnToPop(params = {}) { return commands.runUntilReturn(params); },
    async setCTableSeed(params = {}) {
        ensureRomLoaded("CTable write requires a loaded ROM");
        const address = parseAddress(params.address ?? "02385f0c", 0, params.cpu);
        const value = parseNumber(params.value ?? "0x4b539adb");
        state.fns.dbgWrite32(cpuIndex(params.cpu), address, value);
        state.fns.dbgWrite32(cpuIndex(params.cpu), address + 4, parseNumber(params.high ?? 0));
        return { ok: true, address, value, high: parseNumber(params.high ?? 0) };
    },
    async memoryGetRegister(params = {}) {
        ensureRomLoaded("register read requires a loaded ROM");
        const register = String(params.register ?? params.reg ?? "pc").toLowerCase();
        const value = getRegisters(params.cpu)[register];
        if (value === undefined) throw new Error(`unknown register: ${register}`);
        return value >>> 0;
    },
    async memorySetRegister(params = {}) {
        ensureRomLoaded("register write requires a loaded ROM");
        return commands.setRegister({ cpu: params.cpu, register: params.register ?? params.reg, value: params.value });
    },
    async memoryReadByte(params = {}) {
        ensureRomLoaded("memory read requires a loaded ROM");
        return state.fns.dbgRead8(cpuIndex(params.cpu), parseAddress(params.address, 0, params.cpu)) & 0xff;
    },
    async memoryReadWord(params = {}) {
        ensureRomLoaded("memory read requires a loaded ROM");
        return swap16(state.fns.dbgRead16(cpuIndex(params.cpu), parseAddress(params.address, 0, params.cpu))) & 0xffff;
    },
    async memoryReadDword(params = {}) {
        ensureRomLoaded("memory read requires a loaded ROM");
        return swap32(state.fns.dbgRead32(cpuIndex(params.cpu), parseAddress(params.address, 0, params.cpu))) >>> 0;
    },
    async memoryWriteByte(params = {}) {
        ensureRomLoaded("memory write requires a loaded ROM");
        const address = parseAddress(params.address, 0, params.cpu);
        state.fns.dbgWrite8(cpuIndex(params.cpu), address, bigEndianValue(params.value, 1));
        return { ok: true, address: hex(address), value: hex(bigEndianValue(params.value, 1), 2), endian: "big" };
    },
    async memoryWriteWord(params = {}) {
        ensureRomLoaded("memory write requires a loaded ROM");
        const address = parseAddress(params.address, 0, params.cpu);
        state.fns.dbgWrite16(cpuIndex(params.cpu), address, bigEndianValue(params.value, 2));
        return { ok: true, address: hex(address), value: hex(parseNumber(params.value), 4), endian: "big" };
    },
    async memoryWriteDword(params = {}) {
        ensureRomLoaded("memory write requires a loaded ROM");
        const address = parseAddress(params.address, 0, params.cpu);
        state.fns.dbgWrite32(cpuIndex(params.cpu), address, bigEndianValue(params.value, 4));
        return { ok: true, address: hex(address), value: hex(parseNumber(params.value)), endian: "big" };
    },
    async runPersistentScript(params = {}) { return startPersistentScript(params); },
    async listScripts() { return { scripts: [...state.scripts.values()].map((script) => scriptSummary(script)) }; },
    async stopScript(params = {}) { return stopPersistentScript(params); },
    async restartScript(params = {}) {
        const script = state.scripts.get(Number(params.id ?? state.activeScriptId));
        if (!script) throw new Error("script not found");
        const next = { name: script.name, code: script.code, asyncMode: script.asyncMode };
        await stopPersistentScript({ id: script.id });
        state.scripts.delete(script.id);
        return startPersistentScript(next);
    },
    async getScript(params = {}) {
        const script = state.scripts.get(Number(params.id ?? state.activeScriptId));
        if (!script) throw new Error("script not found");
        const pattern = params.pattern ?? params.regex;
        if (!pattern) return { id: script.id, name: script.name, code: script.code };
        const regex = new RegExp(String(pattern), String(params.flags ?? "g"));
        return { id: script.id, name: script.name, matches: [...script.code.matchAll(regex)].map((match) => ({ index: match.index, text: match[0] })) };
    },
    async listScriptPrint(params = {}) {
        const max = Math.max(1, Math.min(1000, Number(params.max ?? 10)));
        const scripts = params.id == null ? [...state.scripts.values()] : [state.scripts.get(Number(params.id))].filter(Boolean);
        return { logs: scripts.flatMap((script) => script.output.slice(-max).map((text) => ({ id: script.id, name: script.name, text }))).slice(-max) };
    },
    async clearScriptPrint(params = {}) {
        const scripts = params.id == null ? [...state.scripts.values()] : [state.scripts.get(Number(params.id))].filter(Boolean);
        scripts.forEach((script) => { script.output = []; });
        renderScriptConsole();
        return { ok: true, cleared: scripts.map((script) => script.id) };
    },
    async eval(params = {}) { return runIsolatedScript(String(params.code ?? ""), Number(params.timeoutMs ?? 3000)); },
    async runScript(params = {}) { return commands.eval(params); },
    async injectScript(params = {}) { return runIsolatedScript(String(params.code ?? ui.scriptCode.value), Number(params.timeoutMs ?? 3000)); },
    async batch(params = {}) {
        const items = Array.isArray(params) ? params : Array.isArray(params.commands) ? params.commands : [];
        if (!items.length) throw new Error("batch requires an array or { commands: [...] }");
        const results = [];
        for (const item of items) {
            const command = String(item.command ?? item.name ?? "");
            if (!command) throw new Error("batch item is missing command");
            results.push({ command, result: await runCommand(command, item.params || {}) });
        }
        return { results };
    },
    async setFeatureSet(params = {}) {
        ui.debugToggle.checked = params.debugger !== false;
        ui.memoryAuto.value = params.memory === false ? "0" : ui.memoryAuto.value;
        state.fns.debuggerSetEnabled(ui.debugToggle.checked ? 1 : 0);
        return { debugger: ui.debugToggle.checked, memoryAuto: ui.memoryAuto.value };
    },
    async setSaveType(params = {}) {
        ensureReady();
        const type = Number(params.type ?? 0);
        state.fns.emuSetOpt(1, type);
        return { type };
    }
};

Object.assign(commands, {
    reg: commands.memoryGetRegister,
    regw: commands.memorySetRegister,
    read8: commands.memoryReadByte,
    read16: commands.memoryReadWord,
    read32: commands.memoryReadDword,
    write8: commands.memoryWriteByte,
    write16: commands.memoryWriteWord,
    write32: commands.memoryWriteDword
});
Object.assign(apiDescriptions, {
    reg: "memoryGetRegisterの短縮名です。",
    regw: "memorySetRegisterの短縮名です。",
    read8: "memoryReadByteの短縮名です。",
    read16: "memoryReadWordの短縮名です。",
    read32: "memoryReadDwordの短縮名です。",
    write8: "memoryWriteByteの短縮名です。",
    write16: "memoryWriteWordの短縮名です。",
    write32: "memoryWriteDwordの短縮名です。"
});

function applyScaleRotation() {
    const vertical = state.rotation % 180 === 0;
    const canvasW = 256 * state.scale;
    const canvasH = 384 * state.scale;
    ui.screenShell.style.setProperty("--canvas-w", `${canvasW}px`);
    ui.screenShell.style.setProperty("--canvas-h", `${canvasH}px`);
    ui.screenShell.style.setProperty("--screen-w", `${(vertical ? 256 : 384) * state.scale}px`);
    ui.screenShell.style.setProperty("--screen-h", `${(vertical ? 384 : 256) * state.scale}px`);
    ui.screenShell.style.setProperty("--screen-rotation", `${state.rotation}deg`);
}

function eventToTouch(e) {
    const rect = ui.screenShell.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const canvasW = 256 * state.scale;
    const canvasH = 384 * state.scale;
    const radians = -state.rotation * Math.PI / 180;
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    const localX = dx * Math.cos(radians) - dy * Math.sin(radians) + canvasW / 2;
    const localY = dx * Math.sin(radians) + dy * Math.cos(radians) + canvasH / 2;
    const sx = localX / Math.max(1, canvasW);
    const sy = localY / Math.max(1, canvasH);
    if (sx < 0 || sx > 1 || sy < 0.5 || sy > 1) return null;
    const x = sx;
    const y = (sy - 0.5) * 2;
    return {
        x: Math.round(Math.min(255, Math.max(0, x * 255))),
        y: Math.round(Math.min(191, Math.max(0, y * 191)))
    };
}

function updateTouch(e, active) {
    const pos = eventToTouch(e);
    if (!pos) {
        state.touch = { active: false, x: 0, y: 0 };
        return;
    }
    state.touch = { active, x: pos.x, y: pos.y };
    if (state.ready && active) state.fns.runFrame(0, state.keys, 1, state.touch.x, state.touch.y);
}

const COMMAND_UI_REFRESH = new Set([
    "pause", "resume", "step", "smartStep", "stepOver", "stepNextBranchOrReturn", "trueNextBranch",
    "runUntilReturn", "runUntilNextCall", "stepFrames", "setRegister", "writeMemory", "injectBytes",
    "setBreakpoint", "removeBreakpoint", "setSpecialBreakpoint", "setStackTraceMode", "setStackTracePrivilegeCheck",
    "loadState", "reloadRecentFile", "setInput", "runInputHold", "runInputTap"
]);
let commandUiRefreshTimer = 0;

function queueCommandUiRefresh(name) {
    if (!COMMAND_UI_REFRESH.has(name) || !state.ready || !hasLoadedRom() || state.loadingFile) return;
    if (commandUiRefreshTimer) clearTimeout(commandUiRefreshTimer);
    commandUiRefreshTimer = setTimeout(() => {
        commandUiRefreshTimer = 0;
        refreshDebuggerViews({ keepHighlight: true }).catch((error) => log(error.message || String(error)));
    }, 0);
}

async function runCommand(name, params = {}) {
    if (!commands[name]) throw new Error(`unknown command: ${name}`);
    const timeoutMs = Number(params && params.timeoutMs || 0);
    const run = commands[name](params);
    const result = timeoutMs > 0
        ? await Promise.race([
            run,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs))
        ])
        : await run;
    updateStatus();
    queueCommandUiRefresh(name);
    return result;
}

function runIsolatedScript(code, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const workerCode = `
          const fetch = undefined, XMLHttpRequest = undefined, WebSocket = undefined, EventSource = undefined, importScripts = undefined, Function = undefined;
          function describeError(error, code) {
            const name = error && error.name ? String(error.name) : "Error";
            const message = error && error.message ? String(error.message) : String(error || "");
            const stack = error && error.stack ? String(error.stack) : "";
            const match = stack.match(/desmume-eval-user\\.js:(\\d+):(\\d+)/);
            const parts = [message ? name + ": " + message : name];
            if (match) {
              const userLine = Math.max(1, Number(match[1]) - 1);
              const column = Number(match[2]);
              const source = String(code || "").split("\\n")[userLine - 1] || "";
              parts.push("at eval line " + userLine + ", column " + column);
              if (source) parts.push("> " + source);
            }
            if (stack) parts.push(stack);
            return parts.join("\\n");
          }
          onmessage = async (event) => {
            if (!event.data || event.data.type !== "run") return;
            const { code } = event.data;
            const mcp = { call: (command, params) => new Promise((resolve, reject) => {
              const id = Math.random().toString(36).slice(2);
              const handler = (reply) => {
                if (reply.data && reply.data.id === id) {
                  removeEventListener("message", handler);
                  if (reply.data.error) reject(new Error(reply.data.error));
                  else resolve(reply.data.result);
                }
              };
              addEventListener("message", handler);
              postMessage({ type: "call", id, command, params });
            }) };
            try {
              const script = "(async (mcp) => {\\n" + code + "\\n})\\n//# sourceURL=desmume-eval-user.js";
              const result = await (0, eval)(script)(mcp);
              postMessage({ type: "done", result });
            } catch (error) {
              postMessage({ type: "error", error: describeError(error, code) });
            }
          };
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" })));
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error("script timeout")); }, Math.max(1, timeoutMs));
        worker.onmessage = async (event) => {
            const msg = event.data;
            if (msg.type === "call") {
                try {
                    const result = await runCommand(msg.command, msg.params || {});
                    worker.postMessage({ id: msg.id, result });
                } catch (error) {
                    worker.postMessage({ id: msg.id, error: String(error && error.message || error) });
                }
            } else if (msg.type === "done") {
                clearTimeout(timeout); worker.terminate(); resolve(msg.result);
            } else if (msg.type === "error") {
                clearTimeout(timeout); worker.terminate(); reject(new Error(msg.error));
            }
        };
        worker.postMessage({ type: "run", code });
    });
}

window.DesmumeMCP = {
    call: runCommand,
    list: () => Object.fromEntries(Object.keys(commands).map((name) => [name, apiDescriptions[name] || ""])),
    shortcuts: () => window.DesmumeShortcuts || {}
};

window.memory = {
    getregister: (register, cpu) => runCommand("memoryGetRegister", { register, cpu }),
    setregister: (register, value, cpu) => runCommand("memorySetRegister", { register, value, cpu }),
    readbyte: (address, cpu) => runCommand("memoryReadByte", { address, cpu }),
    readword: (address, cpu) => runCommand("memoryReadWord", { address, cpu }),
    readdword: (address, cpu) => runCommand("memoryReadDword", { address, cpu }),
    writebyte: (address, value, cpu) => runCommand("memoryWriteByte", { address, value, cpu }),
    writeword: (address, value, cpu) => runCommand("memoryWriteWord", { address, value, cpu }),
    writedword: (address, value, cpu) => runCommand("memoryWriteDword", { address, value, cpu })
};
window.memory.reg = window.memory.getregister;
window.memory.regw = window.memory.setregister;
window.memory.read8 = window.memory.readbyte;
window.memory.read16 = window.memory.readword;
window.memory.read32 = window.memory.readdword;
window.memory.write8 = window.memory.writebyte;
window.memory.write16 = window.memory.writeword;
window.memory.write32 = window.memory.writedword;

function webMcpContent(result) {
    return rawOutputText(result);
}

function parseWebMcpInput(input) {
    if (typeof input !== "string") return input || {};
    if (!input.trim()) return {};
    return JSON.parse(input);
}

const globalShortcutDefs = [
    ["a", "disassemble", ["address", "count", "before", "mode"], { count: 16, before: 4 }],
    ["A", "disassemble", ["address", "count", "before", "mode"], { count: 16, before: 4, includeBytes: true }],
    ["b", "disassembleBytes", ["input", "mode", "endian"]],
    ["B", "binaryFloat", ["value", "bits", "op"]],
    ["c", "callStack", ["limit"], { limit: 32 }],
    ["C", "getOtherCoroutines", ["stackId", "limit"], { limit: 32 }],
    ["d", "status", []],
    ["D", "dumpMemory", ["address", "length", "view"], { length: 64 }],
    ["e", "getRegisters", ["cpu"]],
    ["E", "eval", ["code", "timeoutMs"]],
    ["f", "step", ["count"], { count: 1 }],
    ["F", "stepFrames", ["frames"], { frames: 1 }],
    ["g", "smartStep", []],
    ["G", "setRegister", ["register", "value", "cpu"]],
    ["h", "stepOver", []],
    ["H", "setFeatureSet", ["debugger", "memory", "mcp"]],
    ["i", "stepNextBranchOrReturn", ["timeoutMs", "maxSteps"]],
    ["I", "injectBytes", ["address", "input"]],
    ["j", "runUntilNextCall", ["timeoutMs", "maxSteps"]],
    ["J", "nextFunctionCall", ["timeoutMs", "maxSteps"]],
    ["k", "runUntilReturn", ["timeoutMs", "maxSteps"]],
    ["K", "returnToPop", ["timeoutMs", "maxSteps"]],
    ["l", "listBreakpoints", []],
    ["L", "listOtherCoroutines", ["limit"], { limit: 32 }],
    ["m", "batch", ["commands"]],
    ["M", "setBreakpoint", ["address", "type", "enabled"]],
    ["n", "trueNextBranch", ["timeoutMs", "maxSteps"]],
    ["N", "removeBreakpoint", ["id"]],
    ["o", "searchMemory", ["address", "value", "condition", "size"], { limit: 64 }],
    ["O", "resetMemorySearch", []],
    ["p", "pause", []],
    ["P", "resume", []],
    ["q", "setInput", ["button", "pressed"]],
    ["Q", "runInputTap", ["button", "repeat", "holdMs", "gapMs"]],
    ["r", "runInputHold", ["button", "durationMs"]],
    ["R", "runTouchHold", ["x", "y", "durationMs"]],
    ["s", "setSpeed", ["speed"]],
    ["S", "setCTableSeed", ["address", "value", "high"]],
    ["t", "stackTrace", ["limit"], { limit: 32 }],
    ["T", "setStackTraceMode", ["enabled"]],
    ["u", "writeMemory", ["address", "value", "size"]],
    ["U", "setStackTracePrivilegeCheck", ["enabled"]],
    ["v", "setRenderEnabled", ["enabled"]],
    ["V", "setAudio", ["enabled", "volume"]],
    ["w", "wait", ["ms"]],
    ["W", "waitMs", ["ms"]],
    ["x", "clearBreakStatus", []],
    ["X", "copyCallStackMarkdown", []],
    ["y", "setScale", ["scale"]],
    ["Y", "copyCallStackCsv", []],
    ["z", "setRotation", ["rotation"]],
    ["Z", "takeScreenshot", ["type", "includeDataUrl"]]
];

function shortcutParams(args, names, defaults = {}) {
    if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
        return { ...defaults, ...args[0] };
    }
    const params = { ...defaults };
    names.forEach((name, index) => {
        if (index < args.length && args[index] !== undefined) params[name] = args[index];
    });
    return params;
}

function registerGlobalShortcuts() {
    const shortcuts = {};
    for (const [name, command, params, defaults] of globalShortcutDefs) {
        const fn = (...args) => runCommand(command, shortcutParams(args, params, defaults));
        Object.defineProperty(fn, "name", { value: `desmume_${name}_${command}`, configurable: true });
        fn.command = command;
        fn.params = params;
        fn.defaults = defaults || {};
        window[name] = fn;
        shortcuts[name] = { command, params, defaults: defaults || {} };
    }
    window.DesmumeShortcuts = shortcuts;
}
registerGlobalShortcuts();

async function registerBrowserModelContextTools() {
    const modelContext = ("modelContext" in navigator && navigator.modelContext)
        || ("modelContext" in document && document.modelContext);
    if (!modelContext || typeof modelContext.registerTool !== "function") return false;
    const registrations = [{
        name: "desmume.list",
        title: "DeSmuME command list",
        description: "Lists available DeSmuME Web Debugger commands and their short descriptions.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => webMcpContent(window.DesmumeMCP.list())
    }, {
        name: "desmume.call",
        title: "DeSmuME command",
        description: "Runs one DeSmuME Web Debugger command by name. Use this when an agent wants to choose a command dynamically.",
        inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string" },
                params: { type: "object", additionalProperties: true }
            },
            additionalProperties: false
        },
        execute: async (input = {}) => {
            const parsed = parseWebMcpInput(input);
            return webMcpContent(await runCommand(String(parsed.command || ""), parsed.params || {}));
        }
    }, {
        name: "desmume.eval",
        title: "DeSmuME eval",
        description: "Runs a short isolated JavaScript snippet with mcp.call(command, params). Return strings for raw text output.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: {
                code: { type: "string", description: "Script body. Use await mcp.call(name, params); return a concise string or object." },
                timeoutMs: { type: "number", description: "Maximum runtime in milliseconds. Default is 3000." }
            },
            additionalProperties: false
        },
        execute: async (input = {}) => webMcpContent(await commands.eval(parseWebMcpInput(input)))
    }, {
        name: "desmume.runScript",
        title: "DeSmuME run script",
        description: "Alias for desmume.eval for clients that avoid eval-named tools.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: {
                code: { type: "string" },
                timeoutMs: { type: "number" }
            },
            additionalProperties: false
        },
        execute: async (input = {}) => webMcpContent(await commands.runScript(parseWebMcpInput(input)))
    }];
    let ok = 0;
    for (const tool of registrations) {
        try {
            await modelContext.registerTool(tool);
            ok++;
        } catch (error) {
            if (String(error && error.message || error).includes("already")) ok++;
            else console.warn("WebMCP register failed", tool.name, error);
        }
    }
    log(`WebMCP registered ${ok} tools`);
    return ok > 0;
}

registerBrowserModelContextTools().catch((error) => log(error.message || String(error)));

window.addEventListener("message", async (event) => {
    const msg = event.data || {};
    if (msg.type !== "desmume-mcp") return;
    try {
        const result = await runCommand(msg.command, msg.params || {});
        event.source.postMessage({ type: "desmume-mcp-result", id: msg.id, result }, event.origin || "*");
    } catch (error) {
        event.source.postMessage({ type: "desmume-mcp-result", id: msg.id, error: String(error.message || error) }, event.origin || "*");
    }
});

ui.romFile.closest("label").addEventListener("click", () => {});
ui.saveExportBtn.addEventListener("click", () => runCommand("exportSaveFile").catch((e) => log(e.message)));
ui.stateExportBtn.addEventListener("click", () => runCommand("exportStateFile").catch((e) => log(e.message)));
ui.romFile.addEventListener("change", () => runCommand("loadRomFile").catch((e) => log(e.message)));
ui.saveFile.addEventListener("change", () => runCommand("importSaveFile").catch((e) => log(e.message)));
ui.stateFile.addEventListener("change", () => runCommand("importStateFile").catch((e) => log(e.message)));
ui.pauseBtn.addEventListener("click", () => runCommand("pause").then(() => hasLoadedRom() ? refreshDebuggerViews({ keepHighlight: true }) : null).catch((e) => log(e.message)));
ui.resumeBtn.addEventListener("click", () => runCommand("resume").catch((e) => log(e.message)));
ui.resetBtn.addEventListener("click", () => runCommand("reset").catch((e) => log(e.message)));
ui.romReloadBtn.addEventListener("click", () => runCommand("reloadRom", { waitMs: Number(ui.romWaitMs.value), resume: !ui.resetHoldToggle.checked }).catch((e) => log(e.message)));
ui.stepFrameBtn.addEventListener("click", () => runCommand("stepFrames", { frames: 1 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.stepNBtn.addEventListener("click", () => runCommand("stepFrames", { frames: Number(ui.framesInput.value) }).catch((e) => log(e.message)));
ui.speedSelect.addEventListener("change", () => runCommand("setSpeed", { speed: Number(ui.speedSelect.value) }).catch((e) => log(e.message)));
ui.scaleSelect.addEventListener("change", () => runCommand("setScale", { scale: Number(ui.scaleSelect.value) }).catch((e) => log(e.message)));
ui.rotationSelect.addEventListener("change", () => runCommand("setRotation", { rotation: Number(ui.rotationSelect.value) }).catch((e) => log(e.message)));
ui.renderToggle.addEventListener("change", () => runCommand("setRenderEnabled", { enabled: ui.renderToggle.checked }).catch((e) => log(e.message)));
ui.audioToggle.addEventListener("change", () => runCommand("setAudio", { enabled: ui.audioToggle.checked, volume: Number(ui.volumeRange.value) }).catch((e) => log(e.message)));
ui.cpuSelect.addEventListener("change", () => { state.selectedCpu = ui.cpuSelect.value; renderRegisters(); updateStatus(); });
ui.refreshTopBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
ui.refreshDebugBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
ui.refreshBreakpointsBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
ui.nearPcBtn.addEventListener("click", () => {
    setFollowPc(true);
    state.highlightedDisasmAddress = null;
    state.highlightedCallstackAddress = null;
    state.highlightedCallstackCpsr = null;
    refreshDebuggerViews({ address: "pc", keepHighlight: true }).catch((e) => log(e.message));
});
ui.cpuStepBtn.addEventListener("click", () => runCommand("step", { count: 1 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuSmartStepBtn.addEventListener("click", () => runCommand("smartStep").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuStepOverBtn.addEventListener("click", () => runCommand("stepOver").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuNextBranchReturnBtn.addEventListener("click", () => runCommand("stepNextBranchOrReturn", { timeoutMs: 1000 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuTrueNextBranchBtn.addEventListener("click", () => runCommand("trueNextBranch", { timeoutMs: 1000 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuStepDebugBtn.addEventListener("click", () => runCommand("step", { count: 1 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuSmartStepDebugBtn.addEventListener("click", () => runCommand("smartStep").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuStepOverDebugBtn.addEventListener("click", () => runCommand("stepOver").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuNextBranchReturnDebugBtn.addEventListener("click", () => runCommand("stepNextBranchOrReturn", { timeoutMs: 1000 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuTrueNextBranchDebugBtn.addEventListener("click", () => runCommand("trueNextBranch", { timeoutMs: 1000 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.stackNextCallBtn.addEventListener("click", () => runCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackReturnBtn.addEventListener("click", () => runCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackNextCallToolbarBtn.addEventListener("click", () => runCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackReturnToolbarBtn.addEventListener("click", () => runCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackNextCallDebugBtn.addEventListener("click", () => runCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackReturnDebugBtn.addEventListener("click", () => runCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
ui.stackClearBtn.addEventListener("click", () => runCommand("setStackTraceMode", { enabled: false }).then(() => runCommand("setStackTraceMode", { enabled: true })).catch((e) => log(e.message)));
ui.stackCopyMdBtn.addEventListener("click", () => runCommand("copyCallStackMarkdown").catch((e) => log(e.message)));
ui.stackCopyCsvBtn.addEventListener("click", () => runCommand("copyCallStackCsv").catch((e) => log(e.message)));
ui.callstackLaneTabs.addEventListener("click", (e) => {
    const button = e.target.closest("[data-lane-id]");
    if (!button) return;
    state.selectedCallstackLaneId = Number(button.dataset.laneId);
    renderCallStack(readCallStackData());
});
ui.callstackBody.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-jump-address]");
    if (!button) return;
    setFollowPc(false);
    ui.disasmAddress.value = button.dataset.jumpAddress;
    state.highlightedDisasmAddress = parseAddress(button.dataset.jumpAddress, 0, state.selectedCpu);
    state.highlightedCallstackAddress = state.highlightedDisasmAddress;
    state.highlightedCallstackCpsr = parseNumber(button.dataset.jumpCpsr, null);
    runCommand("disassemble", disasmRefreshParams({ address: button.dataset.jumpAddress, keepHighlight: true })).then((r) => renderDisassembly(r.text)).then(() => renderCallStack(readCallStackData())).catch((error) => log(error.message));
});
ui.disasmAddress.addEventListener("change", () => {
    const followsPc = String(ui.disasmAddress.value).trim().toLowerCase() === "pc";
    setFollowPc(followsPc);
    state.highlightedDisasmAddress = followsPc ? null : parseAddress(ui.disasmAddress.value, 0, state.selectedCpu);
    state.highlightedCallstackAddress = null;
    state.highlightedCallstackCpsr = null;
});
ui.disasmCount.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
ui.disasmBefore.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
ui.disasmMode.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
ui.disasmBytes.addEventListener("change", () => { if (hasLoadedRom()) refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)); });
ui.autoUpdateToggle.addEventListener("change", () => runCommand("setAutoUpdate", { enabled: ui.autoUpdateToggle.checked, hz: Number(ui.autoUpdateRate.value) }).catch((e) => log(e.message)));
ui.autoUpdateRate.addEventListener("change", () => runCommand("setAutoUpdate", { enabled: ui.autoUpdateToggle.checked, hz: Number(ui.autoUpdateRate.value) }).catch((e) => log(e.message)));
ui.memoryView.addEventListener("change", () => { if (state.ready && hasLoadedRom()) runCommand("dumpMemory", {}).then(renderMemoryDump).catch((e) => log(e.message)); });
ui.traceToggle.addEventListener("change", () => runCommand("setStackTraceMode", { enabled: ui.traceToggle.checked }).catch((e) => log(e.message)));
ui.tracePrivilegeToggle.addEventListener("change", () => runCommand("setStackTracePrivilegeCheck", { enabled: ui.tracePrivilegeToggle.checked }).catch((e) => log(e.message)));
ui.memoryDumpBtn.addEventListener("click", () => runCommand("dumpMemory", {}).then(renderMemoryDump).catch((e) => log(e.message)));
ui.memoryOutput.addEventListener("click", (e) => {
    const cell = e.target.closest(".memory-byte");
    if (!cell || cell.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "memory-editor mono";
    input.value = cell.dataset.memoryValue;
    cell.textContent = "";
    cell.append(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = () => {
        if (committed) return;
        committed = true;
        return runCommand("writeMemory", { address: cell.dataset.memoryAddress, value: `0x${input.value}`, size: 1 })
            .then(() => runCommand("dumpMemory", {}).then(renderMemoryDump))
            .catch((error) => log(error.message));
    };
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
            committed = true;
            runCommand("dumpMemory", {}).then(renderMemoryDump).catch((error) => log(error.message));
        }
    });
    input.addEventListener("blur", commit, { once: true });
});
ui.searchNewBtn.addEventListener("click", () => runCommand("searchMemory", { refine: false }).then((r) => ui.searchOutput.textContent = r.text).catch((e) => log(e.message)));
ui.searchRefineBtn.addEventListener("click", () => runCommand("searchMemory", { refine: true }).then((r) => ui.searchOutput.textContent = r.text).catch((e) => log(e.message)));
ui.searchResetBtn.addEventListener("click", () => runCommand("resetMemorySearch").catch((e) => log(e.message)));
ui.memoryWriteBtn.addEventListener("click", () => runCommand("writeMemory", { address: ui.memoryAddress.value, value: ui.memoryWriteValue.value, size: Number(ui.memoryWriteSize.value) }).then(() => runCommand("dumpMemory", {}).then(renderMemoryDump)).catch((e) => log(e.message)));
ui.memoryInjectBtn.addEventListener("click", () => runCommand("injectMemoryFile", { address: ui.memoryAddress.value }).catch((e) => log(e.message)));
ui.freezeAddBtn.addEventListener("click", () => runCommand("setMemoryFreeze", { address: ui.freezeAddress.value, value: ui.freezeValue.value, size: Number(ui.freezeSize.value), enabled: true }).catch((e) => log(e.message)));
ui.freezeRemoveBtn.addEventListener("click", () => runCommand("setMemoryFreeze", { address: ui.freezeAddress.value, size: Number(ui.freezeSize.value), enabled: false }).catch((e) => log(e.message)));
ui.bpAddBtn.addEventListener("click", () => runCommand("setBreakpoint", { address: ui.bpAddress.value, type: ui.bpType.value, enabled: true }).catch((e) => log(e.message)));
ui.bpRemoveBtn.addEventListener("click", () => runCommand("setBreakpoint", { address: ui.bpAddress.value, type: ui.bpType.value, enabled: false }).catch((e) => log(e.message)));
ui.bpRemoveIdBtn.addEventListener("click", () => runCommand("removeBreakpoint", { id: Number(ui.bpIdSelect.value) }).catch((e) => log(e.message)));
ui.bpDataAbortToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "dataAbort", enabled: ui.bpDataAbortToggle.checked }).catch((e) => log(e.message)));
ui.bpPrefetchAbortToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "prefetchAbort", enabled: ui.bpPrefetchAbortToggle.checked }).catch((e) => log(e.message)));
ui.bpUndefinedToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "undefinedInstruction", enabled: ui.bpUndefinedToggle.checked }).catch((e) => log(e.message)));
ui.stateSaveBtn.addEventListener("click", () => runCommand("saveState", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
ui.stateLoadBtn.addEventListener("click", () => runCommand("loadState", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
ui.saveSlotSaveBtn.addEventListener("click", () => runCommand("saveSaveSlot", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
ui.saveSlotLoadBtn.addEventListener("click", () => runCommand("loadSaveSlot", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
ui.stateSlot.addEventListener("change", () => rememberSlot(ui.stateSlot.value));
ui.stateSlotSelect.addEventListener("change", () => { ui.stateSlot.value = ui.stateSlotSelect.value; rememberSlot(ui.stateSlot.value); });
ui.recentReloadBtn.addEventListener("click", () => runCommand("reloadRecentFile", { id: ui.recentFileSelect.value }).catch((e) => log(e.message)));
ui.hotkeyButton.addEventListener("change", renderHotkey);
ui.hotkeyRefreshBtn.addEventListener("click", renderHotkey);
ui.hotkeySetBtn.addEventListener("click", () => runCommand("setKeyBinding", { button: ui.hotkeyButton.value, key: ui.hotkeyCode.value }).catch((e) => log(e.message)));
ui.hotkeyCode.addEventListener("focus", () => {
    ui.hotkeyCode.value = "Press a key";
    ui.hotkeyCode.select();
});
ui.hotkeyCode.addEventListener("blur", renderHotkey);
ui.hotkeyCode.addEventListener("keydown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const key = normalizeKeyboardCode(event);
    if (!key) {
        renderHotkey();
        return;
    }
    ui.hotkeyCode.value = key;
    runCommand("setKeyBinding", { button: ui.hotkeyButton.value, key })
        .then(() => {
            ui.hotkeyCode.blur();
            log(`Hotkey saved: ${ui.hotkeyButton.value} = ${key}`);
        })
        .catch((error) => {
            log(error.message);
            renderHotkey();
        });
});
ui.canvasShotBtn.addEventListener("click", () => runCommand("takeScreenshot", {}).catch((e) => log(e.message)));
ui.registers.querySelectorAll("input[data-register-input]").forEach((input) => {
    const row = input.closest("div[data-register]");
    const register = input.dataset.registerInput;
    let initialValue = input.value;
    input.addEventListener("focus", () => {
        row.classList.add("editing");
        initialValue = input.value;
        input.select();
    });
    const commit = () => {
        row.classList.remove("editing");
        const value = input.value.trim();
        if (!hasLoadedRom() || !value || value === initialValue) {
            renderRegisters();
            return;
        }
        runCommand("setRegister", { register, value, cpu: state.selectedCpu })
            .then(() => refreshDebuggerViews({ keepHighlight: true }))
            .catch((error) => {
                log(error.message);
                renderRegisters();
            });
    };
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
        if (event.key === "Escape") {
            input.value = initialValue;
            input.blur();
        }
    });
    input.addEventListener("blur", commit);
});
ui.mcpRunBtn.addEventListener("click", () => {
    let params = {};
    try { params = JSON.parse(ui.mcpParams.value || "{}"); } catch (e) { console.error(e); ui.mcpOutput.textContent = e.message; return; }
    runCommand(ui.mcpCommand.value, params).then((r) => ui.mcpOutput.textContent = JSON.stringify(r, null, 2)).catch((e) => ui.mcpOutput.textContent = e.message);
});
ui.mcpBatchRunBtn.addEventListener("click", () => {
    let items = [];
    try { items = JSON.parse(ui.mcpBatch.value || "[]"); } catch (e) { console.error(e); ui.mcpOutput.textContent = e.message; return; }
    runCommand("batch", Array.isArray(items) ? items : { commands: items.commands || [] }).then((r) => ui.mcpOutput.textContent = JSON.stringify(r, null, 2)).catch((e) => ui.mcpOutput.textContent = e.message);
});
ui.scriptRunBtn.addEventListener("click", () => runCommand("runPersistentScript", { name: ui.scriptName.value, code: ui.scriptCode.value, asyncMode: ui.scriptAsyncMode.checked }).then((result) => {
    try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {}
    selectScript(result.id);
}).catch((e) => { ui.scriptRawOutput.value = e.message; ui.scriptOutput.textContent = e.message; }));
ui.scriptStopBtn.addEventListener("click", () => runCommand("stopScript", {}).catch((e) => log(e.message)));
ui.scriptRestartBtn.addEventListener("click", () => runCommand("restartScript", {}).then((result) => selectScript(result.id)).catch((e) => log(e.message)));
ui.scriptClearOutputBtn.addEventListener("click", () => runCommand("clearScriptPrint", {}).catch((e) => log(e.message)));
ui.scriptFile.addEventListener("change", () => readFileFromInput(ui.scriptFile).then(({ file, bytes }) => {
    ui.scriptCode.value = new TextDecoder().decode(bytes);
    ui.scriptName.value = file.name.replace(/\.[^.]+$/, "") || "script";
    try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {}
}).catch((e) => log(e.message)));
ui.scriptCode.addEventListener("input", () => { try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {} });
ui.scriptName.addEventListener("input", () => { try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {} });
ui.scriptCopyRawBtn.addEventListener("click", () => copyText(ui.scriptRawOutput.value, "script raw output").catch((e) => log(e.message)));
ui.scriptSelectRawBtn.addEventListener("click", () => {
    ui.scriptRawOutput.focus();
    ui.scriptRawOutput.select();
});

ui.pad.addEventListener("pointerdown", (e) => { if (e.target.dataset.button) setKey(e.target.dataset.button, true); });
ui.pad.addEventListener("pointerup", (e) => { if (e.target.dataset.button) setKey(e.target.dataset.button, false); });
ui.pad.addEventListener("pointerleave", () => Object.keys(state.buttons).forEach((button) => setKey(button, false)));
window.addEventListener("focusin", () => { if (isTypingTarget()) releaseAllKeys(); });
window.addEventListener("keydown", (e) => { if (isTypingTarget(e.target)) return; const code = normalizeKeyboardCode(e); if (state.keymap[code]) { e.preventDefault(); setKey(state.keymap[code], true); } });
window.addEventListener("keyup", (e) => { if (isTypingTarget(e.target)) return; const code = normalizeKeyboardCode(e); if (state.keymap[code]) { e.preventDefault(); setKey(state.keymap[code], false); } });
ui.screenShell.addEventListener("pointerdown", (e) => { ui.screenShell.setPointerCapture(e.pointerId); updateTouch(e, true); });
ui.screenShell.addEventListener("pointermove", (e) => { if (state.touch.active) updateTouch(e, true); });
ui.screenShell.addEventListener("pointerup", () => { state.touch.active = false; });
ui.screenShell.addEventListener("pointercancel", () => { state.touch.active = false; });
ui.volumeRange.addEventListener("input", () => { if (state.audioContext) state.audioNextTime = state.audioContext.currentTime; });

setInterval(() => {
    if (state.ready && ui.memoryAuto.value === "1") runCommand("dumpMemory", {}).then(renderMemoryDump).catch(() => {});
    applyFreezes();
    if (state.ready && state.running && !state.loadingFile && performance.now() >= state.saveFlushBlockedUntil && performance.now() - state.lastSaveFlush > 5000) {
        state.lastSaveFlush = performance.now();
        commands.saveSaveSlot({ slot: ui.stateSlot.value }).catch(() => {});
    }
}, 750);

try {
    const storedSlots = JSON.parse(localStorage.getItem("desmume-known-slots") || "[]");
    if (Array.isArray(storedSlots) && storedSlots.length) state.knownSlots = [...new Set([...storedSlots.map((slot) => String(slot)), ...state.knownSlots])].slice(0, 24);
} catch {}
try {
    const draft = JSON.parse(localStorage.getItem("desmume-script-draft") || "null");
    if (draft && typeof draft === "object") {
        if (typeof draft.name === "string") ui.scriptName.value = draft.name;
        if (typeof draft.code === "string") ui.scriptCode.value = draft.code;
    }
} catch {}
loadKeymap();
ui.readyText.textContent = "ROM待ち";
renderBreakpoints();
renderFreezes();
renderRecentFiles();
renderScripts();
renderStateSlotOptions(ui.stateSlot.value);
renderHotkey();
updateStatus();
