# DeSmuME WebAssembly AI解析ガイド

この文書は `API.md` と `LocalAI_System.md` を、現在の実装と長時間のリバースエンジニアリング運用に合わせて統合した指示書である。AIはDeSmuME WebAssembly Debugger、永続スクリプト、Ghidra MCPを組み合わせ、ROM、Save、State、メモリ本文を外部へ出さずにローカルで解析する。

## 目的と絶対条件

- 調査目的を一文に固定する。例: 「この値を書いた関数と条件を特定する」「このbreakpointへ到達した呼び出し経路を確定する」。
- ROM、Save、State、メモリダンプ、スクリーンショットの本文をチャットへ転載しない。必要なアドレス、短い命令列、レジスタ値、ハッシュ、サイズ、解析結果だけを報告する。
- 確認済み事実、根拠付きの推測、未確認事項を混ぜない。
- 解析は一度のbreakや数stepで終えない。呼び出し元、分岐条件、戻り先、値の生成元を複数の観測で照合する。
- モデルやサービス側の繰り返し抑制を、調査を早期終了する理由にしない。同じ問いを粘り強く追う。ただし同一操作を機械的に反復せず、breakpoint、永続hook、state復帰、Ghidra、メモリ差分など観測方法を切り替える。
- 実データはブラウザ内でのみ扱う。DQ9ではユーザー指定のローカルROM、Save、Stateを使い、公開リポジトリへ追加しない。

## 現在の実装で重要な既定値

- `stack trace` はHTML上ですでにcheckedであり、ROMロード時にも無効なら自動的に有効化される。古い手順のようにROMロード前のDOM操作を必須としない。ロード後に `status.native.traceEnabled` を確認し、無効な場合だけ `setStackTraceMode({enabled:true})` を呼ぶ。
- `skip IRQ` のUI初期値はONだが、詳細解析では原則OFFにする。`setStackTracePrivilegeCheck({enabled:false})` によりIRQ entry/returnを記録し、通常経路と割り込み経路を区別する。解析中に都合よくON/OFFを切り替えて結果を混ぜない。
- `runUntilReturn` 等のtrace stepperは、指定しなければ内部でIRQ除外を有効にする場合がある。IRQを含める調査では `{skipIrq:false}` を明示する。
- `disassemble` は既定でopcode bytesを省略する。生bytesが必要なときだけ `includeBytes:true` または大文字ショートカット `A` を使う。
- `callStack` は既定でUI向けのreal frameを返す。通常解析では `raw:true` を使わない。非current coroutineは `listOtherCoroutines` と `getOtherCoroutines` で調べる。
- 永続スクリプトの既定は `asyncMode:false`。即時のレジスタ・メモリ読み書き、pause/resumeが必要な解析ではblocking modeを使う。`asyncMode:true` は非停止のレジスタ観測に限定する。
- デバッガのメモリ読み取りはread breakpointを発火させない。実行中コードによるアクセスだけを観測できる。

## 必須の開始・復帰手順

1. 解析目的、使用ROM/Save/State、再現操作、期待する観測点を永続ログへ書く。
2. ROMと必要なSave/Stateをローカルでロードする。実データ本文をMCP出力やチャットへ出さない。
3. 再現開始地点まで進め、`saveAnalysisBaseline({name:"目的名"})` で作業開始前のstateとpause/IRQ方針を保存する。このbaselineは `replace:true` を明示しない限り上書きされない。
4. `snapshotContext` と `callStack` を取得し、baselineのPC、SP、LR、CPSR、frame、pause状態をログへ書く。
5. stack traceが有効であることを確認する。無効な場合だけ有効化する。
6. `setStackTracePrivilegeCheck({enabled:false})` を実行し、`skip IRQ` をOFFのまま維持する。例外的にIRQ除外版と比較するときは別runとして記録する。
7. 必要なbreakpointまたは永続スクリプトを設定してから調査を始める。

挙動がおかしい、PCが想定外へ飛ぶ、frameが増え続ける、call stackが矛盾する、breakpointを取り逃した、操作を誤った場合は、その状態で無理に解析を継続しない。まず `snapshotContext` を取り、原因候補をログへ一行書き、`restoreAnalysisBaseline` で観測点とpause/IRQ方針を復元する。state load後はbreakpointと永続スクリプトの状態を確認してから再開する。

## ブラウザAPIの入口

- `window.DesmumeMCP.call(name, params)`: 単一コマンド。
- `window.DesmumeMCP.list()`: コマンド一覧。出力が大きいため必要時だけ使う。
- `window.DesmumeMCP.shortcuts()` / `window.DesmumeShortcuts`: 一文字ショートカット一覧。
- `window.a(...)` から `window.Z(...)`: 同じAPIを短く呼ぶglobal shortcut。
- WebMCP: `desmume.call`、`desmume.eval`、`desmume.runScript`、`desmume.list`。
- `postMessage({type:"desmume-mcp", id, command, params}, "*")`: message transport。

Chrome DevTools MCPからは、まず `list_webmcp_tools` で `desmume.eval` の存在を確認し、`execute_webmcp_tool` のtool nameに `desmume.eval` を指定する。`list_webmcp_tools` 自体をtool nameとして渡さない。原則としてページ上の `evaluate_script` より `desmume.eval` を使い、複数の取得、抽出、整形を一度に行う。返却本文は `output.content[0].text` に入る環境がある。

## 解析用ショートカット早見表

一つのobjectを渡せばnamed parameter、位置引数なら次の対応になる。大文字と小文字は別物である。

| Shortcut | 用途 | 代表的な引数 |
| --- | --- | --- |
| `a` / `A` | PC周辺等のdisassemble / bytes付き | `address, count=16, before=4, mode` |
| `c` / `C` | current call stack / other coroutine | `limit=32` / `stackId, limit=32` |
| `d` / `D` | status / memory dump | `d()` / `address, length=64, view` |
| `e` / `E` | registers / isolated eval | `cpu` / `code, timeoutMs` |
| `f` / `F` | instruction step / frame step | `count=1` / `frames=1` |
| `g` / `h` | smart step / step over | 引数なし |
| `i` / `n` | 次のbranch前 / 実際にtakenされたbranch後 | `timeoutMs, maxSteps` |
| `j` / `J` | 次のfunction entry | `timeoutMs, maxSteps` |
| `k` / `K` | returnまで実行 | `timeoutMs, maxSteps` |
| `l` / `L` | breakpoint / other coroutine一覧 | `l()` / `limit=32` |
| `m` / `M` | batch / breakpoint追加 | `commands` / `address, type, enabled` |
| `o` / `O` | memory search / search reset | `address, value, condition, size` |
| `p` / `P` | pause / resume | 引数なし |
| `q` / `Q` | input状態 / tap | `button, pressed` / `button, repeat, holdMs, gapMs` |
| `r` / `R` | button hold / touch hold | `button, durationMs` / `x, y, durationMs` |
| `t` / `T` | stack trace / trace有効化 | `limit=32` / `enabled` |
| `u` / `U` | memory write / skip IRQ設定 | `address, value, size` / `enabled` |
| `x` / `X` | break status clear / stack Markdown | 引数なし |

`U(false)` が詳細解析の標準である。`i/j/k/n` には必要に応じてobjectで `{skipIrq:false, timeoutMs, maxSteps}` を渡す。

## 解析の基本ループ

### 1. 観測点を作る

break直後に最低限、PC、SP、LR、CPSR、lastBreak、near-PC命令、current call stackを保存する。一つの情報だけで結論を出さない。必要なら対象値周辺を16～64 bytesからdumpする。

### 2. 「どこ」より「なぜ」を追う

- `BL` / `BLX` はcalleeとarchitectural return addressを記録する。
- `BX LR`、`POP {...,PC}`、`LDM ...{PC}`、その他PC書き込みは、期待returnと実targetを照合する。
- 条件分岐は直前の比較、CPSR、入力レジスタ、参照メモリを確認する。
- 値の起源を調べる場合はwrite breakpoint、使われ方を調べる場合はread/exec breakpointを選ぶ。read breakpointを広範囲へ乱用しない。
- `step` の連打を避け、`smartStep`、`stepOver`、`stepNextBranchOrReturn`、`trueNextBranch`、`runUntilNextCall`、`runUntilReturn` を使い分ける。
- timeoutは失敗ではなく観測結果である。範囲、breakpoint、開始state、手法を変えて続ける。

### 3. 仮説を反証する

同じ再現をbaselineから最低2回行い、アドレス、overlay、引数、戻り値、書き込み値が一致するか確認する。値や経路が変わる場合は、入力、frame、IRQ、乱数、overlay slot、coroutineの差を分けて記録する。

### 4. 小刻みに永続化する

重要なbreak、関数同定、構造体field、overlay切替、反証のたびに永続ファイルを更新する。コンテキスト圧縮後にチャット履歴だけで再開しない。

## 永続スクリプトによる定点調査

単発MCPのポーリングより `runPersistentScript` を優先し、関数入口、メモリread/write、例外、frame tickを継続観測する。スクリプトは一つの目的に絞り、出力は状態変化時または間引いた周期だけにする。

```js
memory.registerwrite(0x02000020, async (hit) => {
  const pc = await memory.getregister("pc", "arm9");
  const lr = await memory.getregister("lr", "arm9");
  print(`write pc=0x${pc.toString(16)} lr=0x${lr.toString(16)} value=${hit.value}`);
}, { cpu: "arm9" });
```

- `registerexec` はcallback中だけnativeを止め、明示pauseがなければ現在命令を一つ進めて自動resumeする。
- 本当に停止したいcallbackでは `await emu.pause()` または `await mcp.call("pause")` を呼ぶ。
- `stopScript` で、そのscriptが登録したbreakpointも除去される。
- 出力は `listScriptPrint({max:10,id})` で小さく読む。大量ログをチャットへ流さない。
- `print`、`printf`、`printhex` を使い、address、変化前後、caller、短い識別子だけを出す。
- `memory.readword/readdword` のAPI境界はBig Endian表現であり、DSメモリの数値として読む場合はbyte orderを意識する。
- script sourceとeditor nameはlocalStorageに残るがconsole outputは永続化されない。重要行は解析ログへ移す。

DQ9ではまず `scripts/dq9/overlay_jp.js` をblocking modeで起動する。このscriptはoverlay slot 0～5を60 frame周期で確認し、起動時または状態変化時だけ `slot N: id X start 0x...` を出す。関数を追う前に、対象実アドレスが現在どのoverlayに属するかをログへ固定する。

## Ghidra MCPとの併用

動的解析で得たPC、caller、callee、分岐先、メモリアクセスをGhidra MCPへ渡し、listingだけでなくdecompileも取得する。DeSmuMEの数命令だけで高水準の意味を断定しない。

1. 実行時に現在のoverlay IDとload startを `overlay_jp.js` で確認する。
2. Ghidraでbase binaryかoverlay program/blockを選び、関数境界、references、callers/callees、decompileを取得する。
3. decompileの引数をbreakpoint時の `r0-r3`、stack引数、戻り値 `r0` と照合する。
4. 構造体offset、global、条件、side effectを動的に検証する。
5. 確定した名前、signature、説明をGhidraと永続symbol fileの両方へ反映する。

DS overlayの重複実アドレスを裸のaddressだけで指定してはいけない。DQ9では例えば `overlay_d_24:021e54fc` のようにoverlay prefixを付ける。同じ `0x021e54fc` でもoverlay 23、24、25では別命令であり、裸のaddressから選ばれたdecompileは誤り得る。

確認例:

- Program: `dq9_new.nds`
- Overlay 24: `0x021d9300-0x0220091f`
- Qualified address: `overlay_d_24:021e54fc`
- Function: `FUN_overlay_d_24__021e549c`

Ghidra結果にはprogram名、overlay ID、qualified address、関数range、取得時点を必ず添える。decompilerの型や変数名は推測であるため、動的検証前は「確認済み」にしない。

## 永続解析ファイル

長時間調査では、対象ごとに次を作成・更新する。既存の保存場所・形式があればそれを優先し、無ければ解析用directoryを作る実装指示を別タスクとして出す。

### 解析ログ

最低限、次の項目を短く追記する。

```markdown
## 2026-07-16 解析テーマ
- Goal:
- Baseline state slot:
- Reproduction:
- Overlay/slot:
- Breakpoint/hook:
- Confirmed:
- Hypothesis:
- Rejected:
- Next:
```

数分ごとではなく、意味のある発見または方針変更ごとに書く。失敗した仮説も残し、圧縮後に同じ誤りを繰り返さない。

### メモリマップ

range、owner、lifetime、access、根拠を記録する。overlayの仮想address rangeだけでなく、現在のoverlay IDとslotも持たせる。
オーバーレイごとに分離し、

```yaml
regions:
  - name: example_manager
    range: 0x02000000-0x020000ff
    overlay: base
    lifetime: persistent
    access: read-write
    evidence: write breakpoint and decompile
    fields:
      - offset: 0x10
        type: u32
        name: state
        confidence: confirmed
```

### `dqix-functions` / `symbols`

既存schemaが導入されたらそれに従う。共通関数はversion別addressを持ち、overlay関数はoverlay IDを必須にする。単なる名前だけでなくABI、side effect、根拠、confidenceを残す。
既存オーバーレイに対応するファイルがない場合は新規作成する。dataセクションは必須なので適当にする。リフォーマッターを使うため、コメントは禁止、すべてdescriptionに書く。可能であればr0、r1、r2な何なのかも書く。
```yaml
main:
    functions:
      - name: memcpy
        address:
          jpn: 0x0200195c
        description: |-
          memcpy
    
          r0: to
          r1: from
          r2: length
          returns: r0 (to)
    data:
    - name: AT_LCG_Location
      address:
        jpn: 0x20EEE90
        eur: 0x20EEF30
        usa: 0x20EEF30
      length:
        jpn: 0x4
        eur: 0x4
```

overlay関数の例:

```yaml
  - name: example_overlay_function
    overlay: 24
    address:
      jpn: 0x021e549c
    description: |-
      Confirmed behavior and calling convention.
    evidence:
      - overlay_d_24:021e54fc dynamic breakpoint
      - Ghidra decompile plus two baseline reproductions
    confidence: confirmed
```

`symbols` にはglobal、table、structure、field、enum/flagを追加する。名前は挙動を断定しすぎず、未確定なら `candidate_` 等とconfidenceを付ける。addressだけを記録せず、base/overlay、version、size、read/write site、lifetimeを併記する。

### 構造体用のフォーマット
まだ未定だか、構造体と名前をリンクさせるファイルを導入してもよい。

## 状況取得の最小テンプレート

```js
const status = await mcp.call("status", {});
if (status.native?.traceEnabled !== true) {
  await mcp.call("setStackTraceMode", { enabled: true });
}
await mcp.call("setStackTracePrivilegeCheck", { enabled: false });
const regs = await mcp.call("getRegisters", { cpu: "arm9" });
const dis = await mcp.call("disassemble", {
  cpu: "arm9", address: "pc", before: 8, count: 24, mode: "auto"
});
const cs = await mcp.call("callStack", { cpu: "arm9", limit: 24 });
const frames = (cs.frames || []).slice(0, 12).map((f) =>
  `${f.callerHex || f.caller} -> ${f.calleeHex || f.callee} return=${f.returnHex || f.returnAddress}`
);
return [
  `paused=${status.paused} pc=${regs.pcHex || regs.pc} sp=${regs.spHex || regs.sp} lr=${regs.lrHex || regs.lr}`,
  `lastBreak=${status.native?.lastBreak?.addressHex || "none"}`,
  ...frames,
  dis.text
].join("\n");
```

失敗時は例外だけ返さず、可能なら最後に `status` を添える。長いobjectを `JSON.stringify` して丸ごと返さない。10進/16進変換、offset、mask、float decodeは暗算せずJavaScriptまたはローカルruntimeで計算する。
webmcpのjs実行でオブジェクトを返した場合は、特殊フォーマットでフォーマットされてからjson文字列返却される。これが嫌であれば`JSON.stringify`してから返す。

## よく使うAPIの選択基準

- 状態: `status`, `getRegisters`, `callStack`, `stackTrace`, `listOtherCoroutines`, `getOtherCoroutines`
- 命令: `disassemble`, `disassembleBytes`, `step`, `smartStep`, `stepOver`, `stepNextBranchOrReturn`, `trueNextBranch`
- 関数単位: `runUntilNextCall`, `runUntilReturn`
- メモリ: `dumpMemory`, `searchMemory`, `resetMemorySearch`, `writeMemory`, `setMemoryFreeze`
- 停止条件: `setBreakpoint`, `removeBreakpoint`, `setSpecialBreakpoint`, `clearBreakStatus`
- 再現: `saveState`, `loadState`, `stepFrames`, `runInputTap`, `runInputHold`, `runTouchHold`
- 定点観測: `runPersistentScript`, `listScripts`, `listScriptPrint`, `stopScript`, `restartScript`
- まとめ実行: `desmume.eval`, `batch`

`searchMemory` は初回検索と `refine:true` を分ける。`address:"all"` はcanonical non-mirrored rangesを対象にする。状態値探索ではbaseline stateから同一操作を再現し、changed/unchanged/increased/decreasedを段階的に絞る。

## Commands

- `status`: Returns pause state, file-load gate state, ROM-loaded state, frame count, render/audio/debug toggles, speed, selected CPU, and current PC/CPSR values.
- `snapshotContext`: Returns a compact, self-contained analysis context: `paused`/`running`, ROM state, frame, ARM9/ARM7 selection, PC/SP/LR/CPSR, up to eight near-PC lines, latest break reason, and the current trace/`skipIrq` policy. A loaded ROM is required because register access is native state.
- `saveAnalysisBaseline`: Saves a named browser state slot together with its pause/running and trace/`skipIrq` policy, ROM name, byte size, SHA-256, and baseline state-format version. Pass `{ "name": "before-menu" }`; an existing name is protected unless `{ "replace": true }` is explicit.
- `restoreAnalysisBaseline`: Verifies the current ROM against the saved name, size, SHA-256, and format version before passing state bytes to native code. It then resets trace history and restores the recorded pause/running and trace/`skipIrq` policy. Pass `{ "name": "before-menu" }`. The result includes the same compact fields as `snapshotContext`; this requires a loaded ROM because the state belongs to that ROM.
- `loadRomFile`: Opens the file picker. The user selects a local `.nds` ROM, which is mounted into the in-browser filesystem and loaded.
- `loadRomBytes`: Loads ROM bytes supplied by WebMCP without opening a picker. Pass `{ "bytes": [..], "name": "debug.nds", "waitMs": 600, "resume": true }` or `{ "base64": "..." }`. Use this for local automation; do not paste private ROM data into chat.
- `loadRomUrl`: Fetches ROM bytes from a same-origin or CORS-enabled URL, then loads them through the same retained-ROM path. Pass `{ "url": "/dq9.nds", "name": "dq9.nds", "waitMs": 600, "resume": true }`. For local debugging, this is the lowest-token path: expose the ROM from the same PHP server and call this command instead of pasting bytes.
- `importSaveFile`: Opens the file picker for a `.sav`/`.dsv` file, imports it through DeSmuME's backup device, then resets the loaded ROM so the game sees the save from boot.
- `exportSaveFile`: Exports DeSmuME's current backup device data and downloads it as `desmume-save.sav`.
- `saveSaveSlot`: Exports the current cartridge save data into a named browser slot. Pass `{ "slot": "name" }`; the UI slot name is used when omitted.
- `loadSaveSlot`: Loads cartridge save data from a named browser slot, imports it into DeSmuME's backup device, then resets the loaded ROM so the game boots with that save.
- `saveState`: Serializes the emulator state and stores it in memory. With `{ "slot": "name" }`, also stores it in IndexedDB/local storage when small enough. State-changing commands, including save/load, pause/resume, reset, stepping, input, and memory writes, return both `paused` and `running` so callers do not need a follow-up status query.
- `loadState`: Loads the active in-memory state or a named browser storage slot without rebooting the emulator. Loading while paused keeps the emulator paused. Automatic browser save-slot flushing is blocked briefly after load; pass `{ "saveFlushBlockMs": number }` to override the default.
- `loadStateBytes`: Loads emulator state bytes supplied by WebMCP without opening a picker. Pass `{ "bytes": [..], "name": "debug.dst", "saveFlushBlockMs": 30000 }` or `{ "base64": "..." }`.
- `loadStateUrl`: Fetches emulator state bytes from a same-origin or CORS-enabled URL, then loads them through the same external-state path. Pass `{ "url": "/state.dst", "name": "state.dst", "saveFlushBlockMs": 30000 }`.
- `importStateFile`: Opens a file picker, then loads an external state file into the emulator without rebooting. Automatic browser save-slot flushing is blocked briefly after load; pass `{ "saveFlushBlockMs": number }` to override the default.
- `exportStateFile`: Downloads the current serialized state as `desmume-state.dst`.
- `listRecentFiles`: Returns up to six recently imported or saved save/state entries, each with a hidden UUID-style `id`, `kind`, `name`, optional `slot`, and byte size.
- `reloadRecentFile`: Reloads a recent save or state by `{ "id": string }`. Save entries reset the ROM so the cartridge save is visible from boot; state entries preserve the previous pause state.
- `pause`: Pauses emulation. The GUI pause button also refreshes the debugger panes after the stop is visible.
- `resume`: Resumes emulation. If no ROM is loaded, it returns immediately with `{ "ok": false, "romLoaded": false }` instead of hanging the page.
- `reset`: Fully stops execution, rewrites the retained ROM bytes into the in-browser filesystem, reloads the ROM through DeSmuME's load path, waits for the requested boot gate, then either stays paused or resumes. Pass `{ "waitMs": 600, "holdPaused": true }` to control the reset gate.
- `reloadRom`: Rewrites and reloads the retained ROM without requiring a new file picker. Use this for reset diagnostics or after save-file replacement. Pass `{ "waitMs": 600, "resume": false }`.
- `setSpeed`: Sets runtime speed from `0.25` to `4.0`.
- `stepFrames`: Advances `{ "frames": N }` frames while preserving the previous pause state. The GUI `+1F` button pauses first when the emulator is already running, then refreshes the debugger panes after the stop.
- `setRenderEnabled`: Enables or disables canvas updates. Use this for fast AI operation.
- `setAudio`: Sets `{ "enabled": boolean, "volume": 0..1 }`. Disabling audio stops browser output while emulation continues.
- `setScale`: Sets the display scale to `1`, `1.5`, `2`, `2.5`, `3`, `3.5`, or `4`.
- `setRotation`: Sets screen rotation to `0`, `90`, `180`, or `270`.
- `setInput`: Presses or releases DS buttons using `{ "button": "A|B|X|Y|L|R|Start|Select|Up|Down|Left|Right", "pressed": boolean }`. The shared key state drives both emulation and the on-screen key feedback.
- `runInputHold`: Holds one or more buttons for a timed interval using `{ "button": "A" }` or `{ "buttons": ["Up","A"] }`, with optional `{ "durationMs": 500, "waitBeforeMs": 0, "waitAfterMs": 0, "timeoutMs": 2000 }`.
- `runInputTap`: Repeats one or more buttons with `{ "button": "A" }` or `{ "buttons": ["Left","B"] }`, with optional `{ "repeat": 5, "holdMs": 40, "gapMs": 50, "waitBeforeMs": 0, "waitAfterMs": 0, "timeoutMs": 2000 }`.
- `setKeyBinding`: Changes a human hotkey with `{ "button": "A", "key": "KeyZ" }` and stores the keymap in browser local storage. The UI key field also accepts the next real key press directly, including `ShiftRight`.
- `getRegisters`: Returns ARM9 or ARM7 registers with `{ "cpu": "arm9" | "arm7" }`.
- `setRegister`: Changes one register with `{ "cpu": "arm9", "register": "r0".."r15"|"pc"|"cpsr", "value": number|string }`.
- `disassemble`: Uses DeSmuME's ARM/Thumb disassembler and returns address/mnemonic rows with `{ "cpu": "arm9", "address": number|string, "count": number, "before": number, "mode": "auto"|"arm"|"thumb" }`. By default opcode bytes are omitted to keep local-AI prompts compact; pass `{ "includeBytes": true }` or use the UI Bytes selector when raw constants/opcodes are needed. `before` dumps a small number of instructions above the address; the current PC row is prefixed with `=>`.
- `disassembleBytes`: Disassembles arbitrary bytes or opcode words without reading emulator memory. This is useful for low-capability local AI when it only has copied bytes. Pass `{ "mode": "arm"|"thumb", "input": "00 11 22 33", "endian": "little"|"big", "address": 0 }` for byte text, `{ "mode": "arm", "input": "0xe12fff1e 0xe12fff1e", "inputMode": "words" }` for 32-bit opcode words, or `{ "bytes": [0x1e, 0xff, 0x2f, 0xe1], "endian": "little" }`. ARM mode consumes 4 bytes per instruction; Thumb consumes 2 bytes. Opcode-word input is treated as the architectural instruction value, so `0xe12fff1e` returns `bx lr` regardless of byte order. Byte input uses `endian`; for `bx lr`, little-endian bytes are `1e ff 2f e1` and big-endian bytes are `e1 2f ff 1e`. If a decoded row contains DeSmuME's undefined-instruction marker, the result sets `error: true` and `hasUndefined: true`. If trailing bytes are too short for one instruction, they are reported as `incompleteBytes`; the command does not crash.
- `binaryFloat`: Encodes or decodes IEEE-754 binary32/binary64 values through the native C++ helper. Decode examples: `{ "bits": 32, "value": "0x3f200000" }` returns `0.625`; `{ "bits": 64, "value": "0x3fe4000000000000" }` returns the binary64 value. Encode examples: `{ "op": "encode", "bits": 32, "value": 0.625 }` returns `0x3f200000`; use `"bits":64` for double. Byte input accepts `{ "bytes": [...], "endian": "little"|"big" }` and results include `bytesLE` and `bytesBE`.
- `dumpMemory`: Returns a byte array and hex text for `{ "cpu": "arm9", "address": number|string, "length": number, "view": "mixed"|"packed32"|"bytes" }`. `mixed` shows bytes plus little-endian `u32`, `packed32` shows only packed `u32` words, and `bytes` shows only byte cells.
- `injectMemoryFile`: Opens a file picker and writes the selected local file into emulated memory starting at `{ "cpu": "arm9", "address": number|string }`. Script/API callers may pass `{ "bytes": [0, 1, ...], "name": "patch.bin" }` instead of using the picker.
- `injectBytes`: Writes bytes supplied directly by API into emulated memory starting at `{ "cpu": "arm9", "address": number|string }`. It accepts `{ "bytes": [0, 1, ...] }`, `{ "base64": "..." }`, or hex text such as `{ "hex": "00 11 22 33" }` / `{ "input": "00112233" }`. This is an explicit MCP-friendly alias of byte-based `injectMemoryFile`; it still requires a loaded ROM because it writes emulator memory.
- `searchMemory`: Searches memory with `{ "cpu": "arm9"|"arm7", "address": number|string|"all", "length": number, "size": 1|2|4, "condition": "equal"|"notEqual"|"greater"|"less"|"changed"|"unchanged"|"increased"|"decreased", "value": number|string, "refine": boolean, "limit": number }`. Use `"address":"all"` or omit `address` in the UI default to scan canonical non-mirrored emulator memory ranges such as main RAM, WRAM, VRAM, palette, and OAM; ARM7 also includes ARM7 WRAM. Use `refine: true` to filter the previous result set against the new condition.
- `resetMemorySearch`: Clears the previous memory search snapshot and candidate list so the next search starts from the full range.
- `writeMemory`: Writes one value with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string }`.
- `setMemoryFreeze`: Adds or removes a repeated memory write with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string, "enabled": boolean }`.
- `listMemoryFreezes`: Returns the current repeated memory writes used by Memory Freeze.
- Memory dump highlighting: read/write breakpoints are reflected in the GUI memory dump as red-highlighted byte cells and packed words when the dumped range contains the watched address. This is display-only and does not move the disassembly cursor.
- `setBreakpoint`: Adds or removes execution/read/write breakpoints with `{ "cpu": "arm9", "type": "exec"|"read"|"write", "address": number|string, "enabled": boolean }`. Addresses without `0x`, such as `20cb6c4`, are treated as hexadecimal addresses. Execution breakpoints stop before the matched instruction; read/write breakpoints stop the emulator as soon as the native memory hook observes the access. Debug memory viewer reads do not trigger memory breakpoints.
- `setSpecialBreakpoint`: Enables exception breakpoints with `{ "kind": "dataAbort"|"prefetchAbort"|"undefinedInstruction", "enabled": boolean }`. These stop the emulator and preserve the recorded call stack near the exception source; they do not destroy the emulator instance.
- `listBreakpoints`: Returns the browser-side breakpoint list used for UI markers. Each item has an `id` for deletion.
- `removeBreakpoint`: Removes one breakpoint by `{ "id": number }`.
- `clearBreakStatus`: Clears the last breakpoint hit shown by `status.native.lastBreak`.
- `step`: Runs `{ "count": N }` CPU instructions through `armcpu_exec` for ARM9 or ARM7. Before stepping, the browser-side breakpoint list is synced into native breakpoint storage so deleted UI/API breakpoints cannot survive as hidden native traps. When the current PC is itself an execution breakpoint, the native side temporarily removes that one breakpoint for the first instruction so step can escape the trap, then restores it immediately. The result is self-contained: `pcBefore`, `pcAfter`, minimal `status`, hex `registers`, and near-PC `disassembly` are included.
- `smartStep`: Looks at the current disassembly line and chooses a safer single-step mode automatically. Ordinary instructions use `step`, `bx*` uses `stepOver`, and `bl*`/`blx*` also use `stepOver`. Plain `b*` and `add/sub ... pc` stay as one-instruction steps.
- `stepOver`: Runs until the next sequential instruction address is reached, capped to avoid infinite stepping. Like `step`, it temporarily removes only the current PC execution breakpoint for the first instruction, but other breakpoints can still interrupt the run, so plain `step` is safer when you are parked on a breakpoint.
- `stepNextBranchOrReturn`: Steps until the current instruction is a branch-like or return-like PC-writing instruction, then stops before executing it. Calls such as `bl`/`blx` are stepped over on the way. Pass `{ "timeoutMs": number, "maxSteps": number }`.
- `nextBranchOrReturn`: Alias for `stepNextBranchOrReturn`.
- `trueNextBranch`: Executes instructions until a branch, call, or return actually changes PC away from the sequential next address, then stops immediately after that taken branch. Untaken conditional `b*` instructions are ignored. Pass `{ "timeoutMs": number, "maxSteps": number }`. The injection shortcut is `emu.trueNextBranch()` and the global one-letter shortcut is `n()`.
- `nextTrueBranch`: Alias for `trueNextBranch`.
- `continue`: Resumes from a debugger stop.
- `setAutoUpdate`: Enables or disables GUI auto refresh with `{ "enabled": boolean, "hz": number }`. This is intended for UI/script automation and is callable through WebMCP and script injection.
- `setStackTraceMode`: Enables or disables registerenterfunc-equivalent call stack collection with `{ "enabled": boolean }`.
- `setStackTracePrivilegeCheck`: Enables or disables IRQ-mode filtering with `{ "enabled": boolean }`.
- `stackTrace`: Returns the UI-facing call stack plus stack words near SP for `{ "cpu": "arm9", "words": number, "limit": number }`. The embedded call stack omits internal synthetic/control-flow bookkeeping unless `{ "raw": true }` is passed. Please do not use `raw`. raw is intended only for debugging the call-stack implementation and should not be used for reverse engineering or normal analysis.
- `callStack`: Returns the same call stack rows the UI is meant to show: real active-lane frames ordered newest-first, with caller/callee addresses, return address, SP, CPSR, CPU mode, ISA, and 1-3 disassembly lines at each caller/callee point. Internal fields such as `synthetic`, `expected`, `kind`, `mode*`, and `controlFlow` are withheld by default and are available only with `{ "raw": true }`. Non-active stack lanes only report `これは現在のコルーチンではありません。` plus instructions for how to show them. raw is intended only for debugging the call-stack implementation and should not be used for reverse engineering or normal analysis.
- `listOtherCoroutines`: Lists non-current call-stack lanes without exposing internal bookkeeping. Each entry includes state, SP, now PC, depth, newest real frame if any, and a copy-pasteable `getOtherCoroutines` command/snippet for that lane.
- `getOtherCoroutines`: Returns public call-stack details for non-current coroutine lanes. Pass `{ "stackId": number }` to fetch one lane, or omit it to fetch all non-current lanes. Frames use the same UI-facing schema as `callStack`, including caller/callee disassembly snippets, and still omit synthetic/control-flow internals.
- `runUntilReturn`: Steps until the recorded call stack depth drops below the current depth. Pass `{ "timeoutMs": number, "maxSteps": number }`; timeout is reported as failure. If the current instruction address itself has an exec breakpoint, only that one is suspended for the single trace-step and then restored. The result includes `pcBefore`, `pcAfter`, minimal `status`, hex `registers`, and near-PC `disassembly`.
- `runUntilNextCall`: Steps until the next function-entry hook is recorded. Pass `{ "timeoutMs": number, "maxSteps": number }`; timeout is reported as failure. If the current instruction address itself has an exec breakpoint, only that one is suspended for the single trace-step and then restored. The result includes `pcBefore`, `pcAfter`, minimal `status`, hex `registers`, and near-PC `disassembly`.
- `returnToPop`: Alias for `runUntilReturn`.
- `nextFunctionEnter`: Alias for `runUntilNextCall`.
- `nextCall`: Alias for `runUntilNextCall`.
- `nextFunctionCall`: Alias for `runUntilNextCall`.
- `wait`: Waits `{ "ms": number }` and then returns `status`. `status` also accepts `{ "waitMs": number }` for delayed polling.
- `waitMs`: Alias for `wait`.
- `runTouchHold`: Holds the lower touch screen at a DS coordinate using `{ "x": 128, "y": 96, "durationMs": 300, "waitBeforeMs": 0, "waitAfterMs": 0, "timeoutMs": 2000 }`.
- `setCTableSeed`: Implements the `setCTable_jp.lua` write pattern in JavaScript/API form. By default it writes `0x4b539adb` to `0x02385f0c` and zero to the following word; override with `{ "address": string|number, "value": string|number, "high": string|number }`.
- `eval`: Runs isolated JavaScript against a capability object from WebMCP. The script body uses `await mcp.call(command, params)` and should return a concise string or object. Network APIs, DOM access, import, and Function constructor are unavailable in the sandbox. Pass `{ "code": string, "timeoutMs": number }`.
- `runScript`: Alias for `eval` for clients that avoid eval-named tools.
- `injectScript`: Runs isolated JavaScript against a capability object. Network APIs, DOM access, import, and Function constructor are unavailable in the sandbox. Pass `{ "timeoutMs": number }` to change the script timeout.
- `batch`: Runs multiple WebMCP commands sequentially. Pass either an array or `{ "commands": [{ "command": "status", "params": {} }] }`; the result contains one entry per command.
- `setFeatureSet`: Enables or disables heavy tool groups with `{ "debugger": boolean, "memory": boolean, "mcp": boolean }`.

Most commands accept `{ "timeoutMs": number }` through the WebMCP runner. If the command does not finish before that deadline, the call fails with a timeout error.
