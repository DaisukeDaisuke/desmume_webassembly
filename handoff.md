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
