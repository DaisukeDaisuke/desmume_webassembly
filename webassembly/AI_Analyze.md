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
3. 再現開始地点まで進め、作業開始前のstateを名前付きslotへ保存する。このbaseline stateを上書きしない。
4. `status`、`callStack`、短いnear-PC disassemblyを取得し、baselineのPC、SP、LR、CPSR、frame、pause状態をログへ書く。
5. stack traceが有効であることを確認する。無効な場合だけ有効化する。
6. `setStackTracePrivilegeCheck({enabled:false})` を実行し、`skip IRQ` をOFFのまま維持する。例外的にIRQ除外版と比較するときは別runとして記録する。
7. 必要なbreakpointまたは永続スクリプトを設定してから調査を始める。

挙動がおかしい、PCが想定外へ飛ぶ、frameが増え続ける、call stackが矛盾する、breakpointを取り逃した、操作を誤った場合は、その状態で無理に解析を継続しない。まず `status` を取り、原因候補をログへ一行書き、baseline stateをロードして観測点を再設定する。state load後は停止状態が維持されるため、breakpointと永続スクリプトの状態を確認してから再開する。

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