# Handoff Notes

このファイルは DeSmuME WebAssembly 実装の引き継ぎメモです。グローバルルール、禁止コマンド、Codespace運用は `AGENTS.md` を参照してください。

## Current Direction

- Source ownership: `old/desmume` is the DeSmuME source submodule and tracks the `webassembly` branch of `git@github.com:DaisukeDaisukeForks/desmume.git`.
- Browser output: `public/index.html` is the single-page debugger UI. Emscripten builds `public/desmume.js` with `-sSINGLE_FILE=1`, so the wasm payload is embedded in one JavaScript file.
- Memory policy: initial memory is 256MB and maximum memory is 2GB through Emscripten memory growth.
- Data policy: ROMs, saves, states, and scripts are processed locally in the browser. The UI does not upload user files.
- Build note: `public/desmume.js` is generated. Prefer changing `webassembly/wasm-port.cpp` and `public/index.html`, then rebuild.

## Current Implemented Surface

- ROM import, save import/export, state import/export, and IndexedDB state slot storage with a 256MB per-state guard.
- Emulator pause/resume/reset, N-frame advance, render toggle, display scale, rotation, speed control from 0.25x to 4x, and basic button/hotkey input.
- WebMCP command entry through `window.DesmumeMCP.call()`, `postMessage`, and browser `modelContext` tool registration when available.
- Debugger entry points for register read/write, PC/CPSR status, memory dump/write, execution/read/write breakpoint registration, stepping, stack trace, and address/opcode disassembly rows.
- Isolated script injection through a short-lived Worker that exposes only the MCP call capability and shadows network/DOM APIs.

## Critical Notes

- `gh codespace cp` を使う場合は必ず `-e` を付ける。
- Codespace build may need `git submodule update --init old/desmume` and Codespace-only `sudo apt-get install -y emscripten > /dev/null 2>&1`.
- Correct remote path example: `remote:/workspaces/desmume_webassembly/webassembly/wasm-port.cpp`.
- Local `file://` cannot register `coi-serviceworker.js`; test over HTTP/GitHub Pages when COOP/COEP matters.
- `EMUFILE_MEMORY` に `changed` メンバーは無い。セーブ変更検知に使わない。
- `dbgDisassemble()` depends on DeSmuME `frontend/modules/Disassembler.cpp`; keep that file explicitly included in `webassembly/build.sh`.
- `NDS_setPad()` does not accept MCP bit order directly. Browser order is `A,B,Select,Start,Right,Left,Up,Down,R,L,X,Y`; `wasm-port.cpp` maps to native order.
- Touch input is valid only on the DS lower screen. Do not pass upper-screen clicks as touch coordinates.
- Audio is based on 44100 Hz. Speed changes must adjust generated samples and `AudioBufferSourceNode.playbackRate` together.
- When paused, avoid a constant `requestAnimationFrame` loop; use lower-frequency polling where possible.
- Default hotkey policy: `KeyX=A`, `KeyZ=B`, `KeyA=X`, `KeyS=Y`, `KeyQ=L`, `KeyW=R`, `Enter=Start`, `ShiftRight=Select`.
- Memory search uses `searchMemory` / `resetMemorySearch`. Initial search and refine are separate; refine filters only previous candidates.

## Load/Reset Notes

- Save import should use file size-aware `savImportFromFile(forceSize)` behavior.
- State load should not reset first. Load with `loadStateFromBuffer()` / file-backed state load and preserve paused state if the emulator was paused.
- Save import/reload paths should rewrite known-good `state.romBytes` to WASM FS before `loadROM()`; do not trust a possibly stale `rom.nds` in FS.
- `NDS_Reset()` directly after save import can corrupt ARM9 PC. Use the full ROM reload path for reset-like operations.
- During save/state load, pause native execution and stop auto `.sav` slot saves. Restore the prior run/pause state afterward.
- After savestate/recent state/import state load, suppress auto save flush for 30 seconds by default. After ROM reload, suppress for 10 seconds by default.
- `loadRomBytes` exists for WebMCP debugging, but do not put real ROM bytes in public chat. Prefer GUI file picker for DQ9 validation.

## Debugger Notes

- Breakpoints are id-managed in UI/API. Address strings like `20cb6c4` / `020cb6c4` must be treated as hex, not decimal.
- Breakpoint hit must set both `paused=true` and native `execute=false`; otherwise the CPU loop can continue past the hit.
- Execute breakpoints are checked before instruction execution in `armcpu_exec()`. Read/write breakpoints are checked on real MMU access.
- GUI memory viewer uses `MMU_AT_DEBUG` reads and must not trigger read breakpoints.
- Data abort, prefetch abort, and undefined instruction should stop the emulator and store the last source PC/CPSR in `status().native.lastBreak`, not destroy the emulator.
- `dbgStep` / `dbgStepOver` temporarily skip only the execute breakpoint at the current PC for the first instruction, then restore it.
- `step` is CPU-instruction stepping; `stepFrames` is frame-level execution.
- Call stack UI should use `dbgCallStackJson().frames`, not SP-relative dump rows.
- Internal `CallStackEntry::caller` is raw LR/return address. API/UI `caller` is adjusted to caller instruction address `(returnAddress & ~1) - 4`; raw LR remains `returnAddress`.

## 2026-06-17 Addendum

- スタックトレースは SP 周辺ダンプではなく、`registerenterfunc` Lua フック相当の関数入口記録が主目的。WASM では `OP_STMDB_W` と `OP_PUSH_LR` から `wasmEnterFunctionHook()` を呼び、`wasm-port.cpp` 側の call stack に `caller/lr`, `callee`, `sp`, `cpsr`, thumb状態, 同一callee内idを記録する。
- `traceSetEnabled(0)` は call stack と call count をクリアする。IRQ除外は `traceSetPrivilegeCheck()` で切り替える。
- `setCTable_jp.lua` 相当は JS/API の `setCTableSeed` で実装可能。既定では `0x02385f0c = 0x4b539adb`, `0x02385f10 = 0` を書く。
- 最近読み込んだ save/state は最大6件を id 付きで保持し、`reloadRecentFile` から再ロードできる。
- `.dst` は `DeSmuME SState` version 12 で圧縮ありだった。`webassembly/build.sh` のcompileで `-DHAVE_LIBZ` を付ける。
- 外部 `.dst` はWASM FSの `import.dst` に書いて `savestate_load("import.dst")` する `loadStateFromFile()` 経路へ変更。
- `D:\software\state.dst` はWi-Fi chunk `111` を含む。EmscriptenビルドではWi-Fi emulationを使わないため、`old/desmume/desmume/src/saves.cpp` のchunk `111` は読み飛ばす。

## 2026-06-18 Addendum

- `FS.unlink()` は対象ファイルが無いと `ErrnoError errno 44` を投げる。save import 前の `rom.sav` / `rom.dsv` 掃除では `FS.analyzePath(path).exists` で存在確認してから消す。
- `reset` は `NDS_Reset()` 直叩きではなく、実行を止めて `state.romBytes` をWASM FSへ再書き込みし、`loadROM()` 手順を通す。
- デバッグ用に `status().romLoaded` / `status().loadingFile`、`reloadRom`、WebMCP `batch`、GUIのReset hold/ROM wait/Reload ROM/Batch JSONを追加した。
- `writeRomFile()` rejects ROMs smaller than `0x200` and headers whose first `0x200` bytes are all zero.
- `BackupDevice::data_command()` の `table index is out of bounds` はARM7実行中のセーブSPIアクセスで発生していた。`tick()`/`stepFrames()` はWASM RuntimeError時に即停止、save flush抑止、ログ保存後にrethrowする。
- Browser `modelContext` registration uses `navigator.modelContext` or `document.modelContext`, depending on implementation.
- `loadRomUrl`, `loadStateBytes`, and `loadStateUrl` exist for local Chrome MCP validation. Serve local ROM/state through a temporary same-origin URL; never print the data.
- `savGetPointer(desiredSize)` does not call `EMUFILE_MEMORY::truncate()`. Oversized writes must go through `savImportFromFile()`.
- `NDS_LoadROM()` does not close an existing ROM. WASM `loadROM()` calls `NDS_FreeROM()` before reloading when a ROM is already loaded.
- Known issue as of this date: `saveState` followed by browser state load had hit `table index is out of bounds` / `memory access out of bounds` around state chunk `61`, phase `10`; investigate `mmu_savestate` / `BackupDevice::load_state()` if this reappears.
- Known issue as of this date: `Save In` had logged `function signature mismatch` and set `status().romLoaded=false`; investigate ROM reload or upload handler if this reappears.
- `public/index.html` delays loading `desmume.js` until ROM selection through `ensureWasmReady()`.
- While focus is in `input` / `textarea` / `select`, global DS key input must not capture keys. Clear virtual keys on focus entry.
- On break hit, first set native pause and `paused=true`, then asynchronously refresh near-PC disassembly/debugger.

## 2026-06-19 Addendum

- Hotkeys are stored in `desmume-keymap`. Right Shift uses `KeyboardEvent.code === "ShiftRight"` where possible; legacy `keyCode/which === 16` generally normalizes to `ShiftRight` unless left location is explicit.
- Stack trace JSON includes `controlFlow`. With ARM9 trace enabled, PC-writing/return events are retained up to 128 entries with `pc/target/expected/sp/cpsr/kind/reg/mismatch`.
- Disassembler purple highlighting is limited to instructions that write PC. `add r0, pc` style ADR should not be purple. Current PC green highlight takes precedence.
- WASM break hit must set `execute=false` in `recordBreak()`. `pauseEmu(0)` / `loadROM()` restores `execute=true`.
- Call Stack table age shows the top row as `newest`; rows below show `↑+Nd`.
- Call stack frames are now emitted newest-first for UI/API/MCP. Return-like PC writes pop the top frame when the branch target matches the recorded LR, including ARM `BX LR` / `LDM ... {PC}` and Thumb `BX` / `POP {..., PC}`.
- Call stack tracking is split into dynamic stack lanes when the ARM9 SP jumps beyond `0x2000`; UI/API expose lane tabs/`stacks`. Empty lanes are removed after their last frame returns. `callStack` / `stackTrace` default to `limit: 128` and cap at 1024 frames to avoid huge MCP responses.
- Execute breakpoints are not hardcoded for DQ9/memcpy addresses. If a removed breakpoint appears to survive, suspect native `execBreakpoints[]` drift from the browser list; `dbgClearAllBreakpoints()` exists so JS can resync browser-side breakpoints before `step` / `stepOver`.

## 2026-06-30 Addendum

- Memory search default `Start` is `all`. This scans canonical non-mirrored ranges instead of only main RAM: ARM9 uses main RAM, shared WRAM, palette, VRAM, and OAM; ARM7 also includes ARM7 WRAM. Custom address/length searches still work.
- Call stack lanes now expose `nowPc`. Non-matching return-like PC writes (`BX LR`, `MOV(S) PC`, `SUBS PC`, `LDM/POP ... PC`) select the existing lane nearest the current SP and set its `nowPc` to the target, so ROP-style jumps do not hide the real recorded frames. Old empty lanes are compacted; `controlFlow` remains the short history for those jumps.
- ARM and Thumb `BLX reg` are now recorded in `controlFlow` as `blx-reg`, without changing the existing prologue-based function entry push behavior.
- Verified with `C:\Users\owner\Downloads\desmume-state (2).dst`: after setting ARM9 exec breakpoint `0x020f9110`, break hit reports active call stack `nowPc=0x020f9110`, and recent `controlFlow` ends with `ldm-pc` from `0x0215c954` to `0x020f9110`.
- Debugger memory reads/writes use `_MMU_*` with `MMU_AT_DEBUG` instead of public `MMU_read*` wrappers. This avoids read breakpoint side effects and correctly reads main RAM mirrors such as `0x027e3508`; verified `dumpMemory(0x027e3508)` returns first word `0x4441503c` after the DQ9 state/A-button repro.
- Mismatched PC writes now also add a synthetic call stack frame. For the DQ9 repro, the newest frame is `synthetic=true`, `kindName=ldm-pc`, `caller=0x0215c954`, `target/callee=0x020f9110`, `expected=0x02185b74`, followed by the real recorded frames.
- BL/BLX instructions now register call frames immediately using their architectural return address (`BL+4`, Thumb return address with bit0 set). The later prologue hook updates the same frame instead of duplicating it. Return-like PC writes search all real frames in the active lanes and pop through the matched frame, so ordinary stale returns such as `LDMIAEQ SP!, {...,PC}` are less likely to appear as synthetic ROP frames.
- Call Stack UI keeps the existing `mode` display for synthetic rows and restores CPU mode as a separate `cpu mode` column. `callee`, `mode`, and `cpu mode` columns are intentionally wider.
- ARM9 hardware IRQ entry now records a separate synthetic `irq-entry` stack lane when `skip IRQ` is off. The pending IRQ resume PC is tracked so matching `SUBS PC` / `LDM ... {PC}^` exception returns remove that lane instead of leaving stale IRQ frames and add `irq-return` to control-flow history; when `skip IRQ` is on, both the IRQ entry and its matching return are suppressed from call-stack/control-flow output.
- romアップロード先のidは固定である。`uid: rom-file`**ではない。**`uid: 1_16`に上げれば良い。固定であるため、take_snapshotは使用しなくてよい
## 2026-07-01 Addendum

- `disassembleBytes` is a ROM-independent MCP command for low-capability local AI. It accepts opcode words such as `0xe12fff1e` as architectural values, or raw bytes with explicit `endian`. ARM consumes 4 bytes and Thumb consumes 2; trailing short bytes are reported as `incompleteBytes` instead of being passed to native disassembly.
- Native `dbgDisassembleOpcode()` disassembles a supplied opcode without reading emulated memory. Browser code marks `error:true` / `hasUndefined:true` when DeSmuME returns the `UNDEFINED` marker.
- `binaryFloat` calls native `utilBinaryFloat()` for IEEE-754 binary32/binary64 encode/decode. Decode is the default; encode requires `op:"encode"`.
- WebMCP uses `@mcp-b/global` and registers tools on `navigator.modelContext` as shown by the jsDelivr package README/API. The page now exposes `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript`; `desmume.eval` runs isolated script bodies that use `mcp.call()`.
- After the Chrome DevTools MCP setting fix, local verification saw `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript` through `list_webmcp_tools`. Use `execute_webmcp_tool` with `toolName:"desmume.eval"` for investigation scripts; do not pass `list_webmcp_tools` as a tool name. `execute_webmcp_tool` wraps results in `{status, output}`, and the plain script output is under `output.content[0].text`.
- WebMCP result content is intentionally text-first. `rawOutputText()` returns command `text` fields directly and formats other objects as plain `key: value` / row text instead of JSON, so low-capability agents do not need to parse escaped JSON for ordinary results.
- MCP/API `callStack` now returns a UI-facing subset by default. Synthetic frames, `expected`, `kind`, `mode*`, and `controlFlow` stay internal unless `{ raw: true }` is requested; active real frames include 1-3 caller/callee disassembly lines. Non-active stack lanes only explain that they are not the current coroutine and how to inspect them.
- `step`, `smartStep`, `stepOver`, `runUntilReturn`, and `runUntilNextCall` return self-contained debugger context with `pcBefore`, `pcAfter`, minimal `status`, hex `registers`, and near-PC `disassembly`, so MCP callers do not need an immediate follow-up `status`/`getRegisters`/`disassemble` call.
- `listOtherCoroutines` / `getOtherCoroutines` are the explicit public path for non-current coroutine lanes. `listOtherCoroutines` returns summaries plus copy-pasteable `getOtherCoroutines` commands/snippets; `getOtherCoroutines` returns UI-facing real frames for the requested non-current lane(s), still without synthetic/control-flow internals.

## 2026-07-06 Addendum

- `disassemble` now omits opcode/raw byte columns by default to reduce local-AI confusion and token use. Pass `includeBytes:true`, use `window.A(...)`, or set the UI Disassembly Bytes selector to `show` when raw instruction constants are needed.
- Global one-letter shortcut functions `window.a(...)` through `window.Z(...)` are hardcoded browser-side wrappers over existing commands and return the same JSON objects as `DesmumeMCP.call()`. `window.DesmumeMCP.shortcuts()` / `window.DesmumeShortcuts` lists their command mappings.
- `stepNextBranchOrReturn` / `nextBranchOrReturn` smart-steps until the current instruction is branch-like or return-like, stopping before that instruction executes. It steps over call-like `bl`/`blx` instructions while searching.
