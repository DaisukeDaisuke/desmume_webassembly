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
    search: { snapshot: null, addresses: null, address: 0, length: 0, size: 1 },
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
    breakRefreshKey: ""
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
    disassemble: "PC付近または指定アドレスを逆アセンブル相当のアドレス付きダンプで返します。",
    dumpMemory: "指定範囲のメモリをバイト列とhexテキストで返します。",
    runInputHold: "指定ボタンを押したまま一定時間維持し、前後の待機も含めて制御します。",
    runInputTap: "指定ボタンをms単位で一定回数連打します。GUIの入力表示も連動します。",
    runTouchHold: "下画面の座標を一定時間押し続けます。前後の待機も指定できます。",
    takeScreenshot: "現在のキャンバスをPNGとして保存します。cooldownMs指定で連打間隔も制御できます。",
    setAutoUpdate: "GUIの自動更新を有効または無効にします。Hzで毎秒の更新回数を指定します。",
    injectMemoryFile: "指定アドレスから、選択したローカルファイルのバイト列でメモリを上書きします。",
    searchMemory: "指定範囲のメモリを値または前回検索との差分条件で検索します。",
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
    continue: "デバッグ停止から再開します。",
    setStackTraceMode: "重いスタックトレース処理を有効または無効にします。",
    setStackTracePrivilegeCheck: "スタックトレースのIRQ除外を有効または無効にします。",
    stackTrace: "registerenterfunc相当フックで記録したコールスタックとSP付近のワードを取得します。limitで返すframe数を制限できます。",
    callStack: "記録済みコールスタックをnewest-firstのJSONで取得します。SP帯が大きく変わった経路は別laneとしてstacksに分かれます。limitの既定は128です。",
    copyCallStackMarkdown: "記録済みコールスタックをMarkdown表にして返し、可能ならクリップボードへコピーします。",
    copyCallStackCsv: "記録済みコールスタックをCSVにして返し、可能ならクリップボードへコピーします。",
    runUntilReturn: "コールスタック深度が現在より浅くなるまで実行します。",
    runUntilNextCall: "次の関数入口フックが発火するまで実行します。",
    returnToPop: "runUntilReturn の別名です。現在の深度から1つ以上戻るまで進めます。",
    nextFunctionEnter: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    nextCall: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    nextFunctionCall: "runUntilNextCall の別名です。次の関数入口まで進めます。",
    wait: "指定ミリ秒だけ待機します。状態確認や外部操作待ちに使います。",
    waitMs: "指定ミリ秒だけ待機して status を返します。短い sleep 用の別名です。",
    setCTableSeed: "DQ9のCテーブル乱数相当の2ワードを書き込みます。",
    injectScript: "隔離ワーカー内でMCP能力だけを渡してJavaScriptを実行します。",
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
        6: "ldm-pc-spsr"
    };
    const normalizeFrames = (items) => items.map((frame, index) => {
        const cpsr = Number(frame.cpsr) >>> 0;
        const mode = cpsrModeInfo(cpsr);
        const hasReturnAddress = frame.returnAddress != null;
        const returnAddress = Number(hasReturnAddress ? frame.returnAddress : frame.caller) >>> 0;
        const caller = hasReturnAddress ? (Number(frame.caller) >>> 0) : (((returnAddress & ~1) - 4) >>> 0);
        const depthFromNewest = index;
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
            modeClass: mode.className
        };
    });
    const stacks = rawStacks.length ? rawStacks.map((stack) => ({
        ...stack,
        id: Number(stack.id),
        depth: Number(stack.depth) || 0,
        sp: Number(stack.sp) >>> 0,
        spHex: hex(Number(stack.sp) >>> 0),
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

async function copyText(text, label) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        log(`${label} copied`);
    } else {
        log(`${label} prepared; clipboard is unavailable in this context`);
    }
    return text;
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
        ["dbgClearBreakStatus", "number", []], ["dbgStep", "number", ["number", "number"]],
        ["dbgStepOver", "number", ["number"]], ["dbgGetStatusJson", "string", []], ["dbgDisassemble", "string", ["number", "number", "number", "number"]],
        ["dbgStackTrace", "string", ["number", "number"]], ["dbgCallStackJson", "string", []], ["dbgCallStackJsonLimit", "string", ["number"]], ["emuSetOpt", "number", ["number", "number"]]
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
    return values;
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

function instructionBody(line) {
    return instructionOpcode(line).replace(/^\s*[0-9a-fA-F]+:\s*(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{4})\s*/i, "").trim();
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
    const isSubsPc = mnemonicMatches(mnemonic, "subs") && destPc;
    const isAluPcBranch = (mnemonicMatches(mnemonic, "add") || mnemonicMatches(mnemonic, "sub")) && destPc;
    const isPurpleBranch = mnemonic.startsWith("b") && !isCall && !isBx;
    const writesPc = isBx || isMovPc || isLdrPc || isLdmPc || isSubsPc || isAluPcBranch;
    return {
        mnemonic,
        body,
        kind: isCall ? "call" : isBx ? "bx" : (isPurpleBranch || writesPc) ? "branch" : "normal",
        isCall,
        isBx,
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

async function runDebuggerInstruction(kind, params = {}) {
    ensureRomLoaded("debugger step requires a loaded ROM");
    const cpu = String(params.cpu ?? state.selectedCpu);
    let result = { kind, count: 0 };
    state.breakRefreshKey = "";
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
    syncNativeBreakStatus();
    updateStatus();
    result.pc = getPc(cpu);
    result.paused = state.paused;
    return result;
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
        ui.callstackBody.innerHTML = `<tr><td colspan="8">${data && data.enabled ? "no frames recorded" : "stack trace disabled"}</td></tr>`;
        return;
    }
    ui.callstackBody.innerHTML = frames.map((frame) => {
        const caller = hex(frame.caller);
        const callee = hex(frame.callee);
        const highlighted = state.highlightedCallstackAddress === frame.caller || state.highlightedCallstackAddress === frame.callee;
        const cls = ["callstack-row", highlighted ? "highlight" : "", frame.modeClass].filter(Boolean).join(" ");
        const execMode = `${frame.thumb ? "thumb" : "arm"} ${frame.modeName}`;
        return `<tr class="${cls}"><td title="newest frame is the top row">${frame.ageLabel}</td><td title="return ${hex(frame.returnAddress)}">${caller}</td><td>${callee} (${frame.id})</td><td>${hex(frame.sp)}</td><td title="CPSR ${frame.cpsrHex}">${frame.cpsrHex}</td><td>${execMode}</td><td><button type="button" data-jump-address="${caller}" data-jump-cpsr="${frame.cpsr}" data-jump-label="caller">Caller</button></td><td><button type="button" data-jump-address="${callee}" data-jump-cpsr="${frame.cpsr}" data-jump-label="callee">Callee</button></td></tr>`;
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
        button.querySelector("[data-lane-label]").textContent = `SP ${stack.spHex}`;
        button.querySelector("[data-lane-depth]").textContent = `${stack.depth}`;
        button.querySelector("[data-lane-now]").hidden = !stack.active;
        button.title = `lane ${stack.id}, depth ${stack.depth}`;
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
            return { ok: false, stoppedByBreakpoint: true, steps, depth, pc: getPc(cpu), callStack, native };
        }
        if (shouldStop({ startDepth, depth, callStack })) {
            await refreshDebuggerViews({ cpu });
            return { ok: true, steps, depth, pc: getPc(cpu), callStack };
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
    async pause() { ensureReady(); state.paused = true; state.running = false; state.fns.pauseEmu(1); updateStatus(); return { ok: true }; },
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
        const names = { pc: 15, cpsr: 16, spsr: 17 };
        const reg = names[params.register] ?? Number(String(params.register).replace("r", ""));
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
        return { address: addr, before, text };
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
    async searchMemory(params = {}) {
        ensureRomLoaded("memory search requires a loaded ROM");
        const addr = parseAddress(params.address ?? ui.searchAddress.value, 0, params.cpu);
        const length = Math.min(16 * 1024 * 1024, Number(params.length ?? ui.searchLength.value));
        const size = Math.max(1, Math.min(4, Number(params.size ?? ui.searchSize.value)));
        const condition = String(params.condition ?? ui.searchCondition.value);
        const value = parseNumber(params.value ?? ui.searchValue.value);
        const limit = Math.max(1, Math.min(10000, Number(params.limit ?? ui.searchLimit.value)));
        const refine = params.refine !== false && state.search.snapshot && state.search.address === addr && state.search.length === length && state.search.size === size;
        const ptr = state.fns.dbgDumpMemory(cpuIndex(params.cpu), addr, length);
        const current = state.module.HEAPU8.slice(ptr, ptr + length);
        const previous = state.search.snapshot;
        const candidates = refine && state.search.addresses ? state.search.addresses : null;
        const matches = [];
        const maxOffset = Math.max(0, length - size);
        const testOffset = (offset) => {
            const nowValue = readSized(current, offset, size);
            const oldValue = previous && offset + size <= previous.length ? readSized(previous, offset, size) : 0;
            if (matchSearchCondition(condition, nowValue, oldValue, value, !!previous)) {
                matches.push({ address: addr + offset, value: nowValue, previous: previous ? oldValue : null });
                return matches.length >= limit;
            }
            return false;
        };
        if (candidates) {
            for (const address of candidates) {
                const offset = address - addr;
                if (offset >= 0 && offset <= maxOffset && testOffset(offset)) break;
            }
        } else {
            for (let offset = 0; offset <= maxOffset; offset += size) {
                if (testOffset(offset)) break;
            }
        }
        state.search = { snapshot: current, addresses: matches.map((item) => item.address), address: addr, length, size };
        const text = matches.map((item) => `${hex(item.address)}  ${hex(item.value, size * 2)}${item.previous === null ? "" : `  prev ${hex(item.previous, size * 2)}`}`).join("\n") || "no matches";
        return { address: addr, length, size, condition, totalShown: matches.length, truncated: matches.length >= limit, matches, text };
    },
    async resetMemorySearch() {
        state.search = { snapshot: null, addresses: null, address: 0, length: 0, size: 1 };
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
    async continue() { return commands.resume(); },
    async setStackTraceMode(params) { ensureReady(); state.fns.traceSetEnabled(params.enabled ? 1 : 0); ui.traceToggle.checked = !!params.enabled; if (!params.enabled) state.selectedCallstackLaneId = null; renderCallStack(readCallStackData(), { autoSelectActive: !!params.enabled }); return { enabled: !!params.enabled }; },
    async setStackTracePrivilegeCheck(params) { ensureReady(); state.fns.traceSetPrivilegeCheck(params.enabled ? 1 : 0); ui.tracePrivilegeToggle.checked = !!params.enabled; return { enabled: !!params.enabled }; },
    async stackTrace(params = {}) { ensureRomLoaded("stack trace requires a loaded ROM"); const callStack = readCallStackData(params); renderCallStack(callStack); return { callStack, text: state.fns.dbgStackTrace(cpuIndex(params.cpu), Number(params.words ?? 32)) }; },
    async callStack(params = {}) { ensureRomLoaded("call stack requires a loaded ROM"); const callStack = readCallStackData(params); renderCallStack(callStack); return callStack; },
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
    async returnToPop(params = {}) { return commands.runUntilReturn(params); },
    async setCTableSeed(params = {}) {
        ensureRomLoaded("CTable write requires a loaded ROM");
        const address = parseAddress(params.address ?? "02385f0c", 0, params.cpu);
        const value = parseNumber(params.value ?? "0x4b539adb");
        state.fns.dbgWrite32(cpuIndex(params.cpu), address, value);
        state.fns.dbgWrite32(cpuIndex(params.cpu), address + 4, parseNumber(params.high ?? 0));
        return { ok: true, address, value, high: parseNumber(params.high ?? 0) };
    },
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
    return result;
}

function runIsolatedScript(code, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const workerCode = `
          const fetch = undefined, XMLHttpRequest = undefined, WebSocket = undefined, EventSource = undefined, importScripts = undefined, Function = undefined;
          onmessage = async (event) => {
            const { code } = event.data;
            const mcp = { call: (command, params) => new Promise((resolve) => {
              const id = Math.random().toString(36).slice(2);
              const handler = (reply) => {
                if (reply.data && reply.data.id === id) {
                  removeEventListener("message", handler);
                  resolve(reply.data.result);
                }
              };
              addEventListener("message", handler);
              postMessage({ type: "call", id, command, params });
            }) };
            try {
              const result = await eval("(async (mcp) => { " + code + "\\n})(mcp)");
              postMessage({ type: "done", result });
            } catch (error) {
              postMessage({ type: "error", error: String(error && error.message || error) });
            }
          };
        `;
        const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" })));
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error("script timeout")); }, Math.max(1, timeoutMs));
        worker.onmessage = async (event) => {
            const msg = event.data;
            if (msg.type === "call") {
                const result = await runCommand(msg.command, msg.params || {});
                worker.postMessage({ id: msg.id, result });
            } else if (msg.type === "done") {
                clearTimeout(timeout); worker.terminate(); resolve(msg.result);
            } else if (msg.type === "error") {
                clearTimeout(timeout); worker.terminate(); reject(new Error(msg.error));
            }
        };
        worker.postMessage({ code });
    });
}

window.DesmumeMCP = {
    call: runCommand,
    list: () => Object.fromEntries(Object.keys(commands).map((name) => [name, apiDescriptions[name] || ""]))
};

async function registerBrowserModelContextTools() {
    const modelContext = ("modelContext" in navigator && navigator.modelContext)
        || ("modelContext" in document && document.modelContext);
    if (!modelContext || typeof modelContext.registerTool !== "function") return false;
    const baseSchema = {
        type: "object",
        additionalProperties: true,
        description: "Parameters passed to the matching DeSmuME Web Debugger MCP command."
    };
    const registrations = Object.keys(commands).map((name) => ({
        name: `desmume.${name}`,
        title: `DeSmuME ${name}`,
        description: apiDescriptions[name] || `Run DeSmuME command ${name}.`,
        inputSchema: baseSchema,
        annotations: { readOnlyHint: ["status", "getRegisters", "disassemble", "dumpMemory", "listBreakpoints", "listMemoryFreezes", "callStack", "stackTrace", "listRecentFiles"].includes(name) },
        execute: async (input = {}) => runCommand(name, input || {})
    }));
    registrations.push({
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
        execute: async (input = {}) => runCommand(String(input.command || ""), input.params || {})
    });
    let ok = 0;
    for (const tool of registrations) {
        try {
            await modelContext.registerTool(tool);
            ok++;
        } catch (error) {
            if (!String(error && error.message || error).includes("already")) console.warn("WebMCP register failed", tool.name, error);
        }
    }
    log(`WebMCP registered ${ok} tools`);
    return ok > 0;
}

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
ui.cpuStepDebugBtn.addEventListener("click", () => runCommand("step", { count: 1 }).then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuSmartStepDebugBtn.addEventListener("click", () => runCommand("smartStep").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
ui.cpuStepOverDebugBtn.addEventListener("click", () => runCommand("stepOver").then(() => refreshDebuggerViews({ keepHighlight: true })).catch((e) => log(e.message)));
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
ui.scriptRunBtn.addEventListener("click", () => runCommand("injectScript", { code: ui.scriptCode.value }).then((r) => ui.scriptOutput.textContent = JSON.stringify(r, null, 2)).catch((e) => ui.scriptOutput.textContent = e.message));

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
loadKeymap();
ui.readyText.textContent = "ROM待ち";
renderBreakpoints();
renderFreezes();
renderRecentFiles();
renderStateSlotOptions(ui.stateSlot.value);
renderHotkey();
updateStatus();
