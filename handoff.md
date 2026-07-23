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
- romアップロード先のidは固定である。`uid: rom-file`**ではない。**`uid: 3_16`に上げれば良い。固定であるため、take_snapshotは使用しなくてよい
## 2026-07-01 Addendum

- `disassembleBytes` is a ROM-independent MCP command for low-capability local AI. It accepts opcode words such as `0xe12fff1e` as architectural values, or raw bytes with explicit `endian`. ARM consumes 4 bytes and Thumb consumes 2; trailing short bytes are reported as `incompleteBytes` instead of being passed to native disassembly.
- Native `dbgDisassembleOpcode()` disassembles a supplied opcode without reading emulated memory. Browser code marks `error:true` / `hasUndefined:true` when DeSmuME returns the `UNDEFINED` marker.
- `binaryFloat` calls native `utilBinaryFloat()` for IEEE-754 binary32/binary64 encode/decode. Decode is the default; encode requires `op:"encode"`.
- WebMCP uses the browser-native `document.modelContext` API with `navigator.modelContext` as a compatibility fallback. No third-party WebMCP shim or runtime CDN executable code is loaded. The page exposes `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript`; `desmume.eval` runs isolated script bodies that use `mcp.call()`.
- After the Chrome DevTools MCP setting fix, local verification saw `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript` through `list_webmcp_tools`. Use `execute_webmcp_tool` with `toolName:"desmume.eval"` for investigation scripts; do not pass `list_webmcp_tools` as a tool name. `execute_webmcp_tool` wraps results in `{status, output}`, and the plain script output is under `output.content[0].text`.
- WebMCP result content is intentionally text-first. `rawOutputText()` returns command `text` fields directly and formats other objects as plain `key: value` / row text instead of JSON, so low-capability agents do not need to parse escaped JSON for ordinary results.
- MCP/API `callStack` now returns a UI-facing subset by default. Synthetic frames, `expected`, `kind`, `mode*`, and `controlFlow` stay internal unless `{ raw: true }` is requested; active real frames include 1-3 caller/callee disassembly lines. Non-active stack lanes only explain that they are not the current coroutine and how to inspect them.
- `step`, `smartStep`, `stepOver`, `runUntilReturn`, and `runUntilNextCall` return self-contained debugger context with `pcBefore`, `pcAfter`, minimal `status`, hex `registers`, and near-PC `disassembly`, so MCP callers do not need an immediate follow-up `status`/`getRegisters`/`disassemble` call.
- `listOtherCoroutines` / `getOtherCoroutines` are the explicit public path for non-current coroutine lanes. `listOtherCoroutines` returns summaries plus copy-pasteable `getOtherCoroutines` commands/snippets; `getOtherCoroutines` returns UI-facing real frames for the requested non-current lane(s), still without synthetic/control-flow internals.

## 2026-07-06 Addendum

- `disassemble` now omits opcode/raw byte columns by default to reduce local-AI confusion and token use. Pass `includeBytes:true`, use `window.A(...)`, or set the UI Disassembly Bytes selector to `show` when raw instruction constants are needed.
- Global one-letter shortcut functions `window.a(...)` through `window.Z(...)` are hardcoded browser-side wrappers over existing commands and return the same JSON objects as `DesmumeMCP.call()`. `window.DesmumeMCP.shortcuts()` / `window.DesmumeShortcuts` lists their command mappings.
- `stepNextBranchOrReturn` / `nextBranchOrReturn` smart-steps until the current instruction is branch-like or return-like, stopping before that instruction executes. It steps over call-like `bl`/`blx` instructions while searching.

## 2026-07-11 Addendum

- Persistent injection scripts use one isolated Worker per script. Their source and editor name are stored only in `localStorage` (`desmume-script-draft`); worker console output is per-script and intentionally not persisted.
- `memory.readword` / `memory.readdword` and their write counterparts use Big Endian values at the API boundary. The browser swaps 16/32-bit values before native debug memory operations so `memory.writedword(addr, 0x12345678)` lays down bytes `12 34 56 78` at `addr`.
- A script can register `memory.registerread`, `memory.registerwrite`, `memory.registerexec`, `memory.registerexception`, `emu_registerstart`, or `emu_ontick`. Registered normal breakpoints use the existing browser id registry and are removed when that script is stopped; special exception stops are disabled after the last script registration of that kind is removed.
- WebMCP exposes this through the existing dynamic `desmume.call` command with `runPersistentScript`, `listScripts`, `stopScript`, `restartScript`, `getScript`, `listScriptPrint`, and `clearScriptPrint`. `webassembly/API.md` has copy-pasteable examples.
- `scripts/dq9/` contains JavaScript ports of `Ctable_jp.lua`, `overlay_jp.lua`, `nigeru.lua`, and `setCTable_jp.lua`. These are log-oriented persistent scripts for the browser Worker; the main event coordinator resumes script-only exec sites only after every callback settles, and AI can read output via `listScriptPrint({max:10})`.
- Persistent `registerexec` hooks stop natively only while their Worker callback observes the exact pre-instruction event state. If PC is unchanged when the callback completes, `dbgStep(..., 1)` skips the current exec breakpoint for one instruction before auto-resume; another breakpoint hit by that instruction remains honored. An explicit `pause()`/`mcp.call("pause")` during the callback cancels the automatic step and resume. Worker scripts expose the full command surface as `mcp.call`/`webmcp.call` plus common direct `emu.*` shortcuts.
- Script register access accepts both architectural names and aliases: `sp`/`r13`, `lr`/`r14`, `pc`/`r15`, plus `cpsr` and `spsr`.

## 2026-07-15 Addendum

- `stepNextBranchOrReturn` clears the previous native breakpoint-hit record before its loop, preventing the breakpoint used to enter a function from being mistaken for a new hit after the first step. `trueNextBranch` is separate: it executes through untaken conditional branches and stops after a branch/call/return actually changes PC.
- ARM9 IRQ entries always receive a dedicated call-stack lane, even when IRQ SP is close to a normal lane. Toggling `skip IRQ` does not clear existing normal history, and a pending IRQ return is finalized even if filtering is enabled while the handler is active.
- Persistent scripts default to a per-script async queue. Immediate register/memory access and pause/resume fail with an explanatory error in async mode; use `asyncMode:false` for scripts that require those blocking operations.
- MCP mutations schedule a debugger-view refresh so externally driven work becomes visible in the UI. `scripts/dq9/overlay_jp.js` checks periodically but prints slot rows only at startup or when slot state changes.

## 2026-07-16 Addendum

- `snapshotContext` returns a bounded analysis context (activity state, PC/SP/LR/CPSR, near-PC, frame, break reason, trace/IRQ policy) and requires a loaded ROM because its register snapshot is native emulator state.
- `saveAnalysisBaseline` stores a named state slot plus pause/running and trace/`skipIrq` policy; `restoreAnalysisBaseline` restores all of those without changing the saved policy. Existing baseline names require explicit `replace:true` to overwrite.
- State-mutating MCP commands now append both `paused` and `running` after their operation has completed, including state loads and pause/resume, so callers do not need an immediate `status` call.

## Addendum — 2026-07-22 release-blocker security and transaction hardening

- Runtime CDN execution was removed. Acorn 8.17.0 and ssim.js 3.5.0 are exact production dependencies bundled at build time; obsolete CDN loader modules were removed. The generated application bundle is source-derived and Actions checks it for drift before the WASM build.
- Eval and persistent scripts are Acorn-parsed before Worker creation and again inside hardened sandbox Workers. Supervisors require readiness attestation; sandbox capabilities exclude DOM/window, network, storage, sub-Workers, raw messages, string timers, and runtime code generation. Dynamic import fails closed with a typed error.
- Explicit limits now cover batches/results, eval concurrency, persistent scripts/triggers, pending RPC/events, script/source output, and flattened object depth/nodes/arrays/text.
- Persistent breakpoint handling is event-scoped. Script-only sites resume only after all callbacks settle and pause priority remains unchanged; mixed user/operation ownership stays paused. Timeout/delivery/finalization failures pause, reconcile, stop participating scripts with all-settled cleanup, and retain a typed last-script error.
- Native breakpoints can be cleared and reconciled from logical ownership. Trigger cleanup attempts all removals, discards stale logical owners after native failures, reconciles, and aggregates errors.
- ROM/save reload is staged and transactional: live files/metadata/generation are committed only after native load and breakpoint reconciliation. Failure restores old files/metadata, attempts old-ROM reload/reconciliation, and remains paused. Failed file loads are never auto-resumed.
- Frame accounting uses completed native frames for ticks/audio/results and reports attempted frames separately. Native initialization uses explicit initializing/ready/failed state and separates mandatory initialization from optional post-ready registration.
- `public/index.html` includes a zero-layout accessibility-tree security note describing local file processing and the concrete distinction between hardened WebMCP eval and privileged Chrome DevTools page diagnostics. It intentionally does not declare browser-profile or OS owners outside the threat model.
- Verification: Codespace tests 81/81; JS syntax, exact-license, notices, and bundle builds passed; local diff whitespace check passed. Chrome DevTools MCP found only same-origin localhost requests, no console errors, no external scripts, correct zero-width-impact note placement, sandbox capability denial, and Acorn 8.17.0 dynamic-import rejection.
- Actions safety: the build/test job has no `github-pages` environment. Pages setup, artifact upload, and the separate deploy job run only for a normal push to `main`; manual dispatches and `webassembly`/review branches are build/test-only and cannot replace the comparison deployment.

## Addendum — 2026-07-22 merge-blocker follow-up

- This follow-up supersedes the earlier statement that Acorn parses before Worker creation. Third-party Acorn/SSIM code is now packaged as inert fixed source plus SHA-256. A first-party Worker closes network/storage/sub-Worker/raw-message/crypto/runtime-generation capabilities and asserts the locked globals before it verifies or evaluates dependency source. Acorn acceptance and pre-compilation parses both occur only in that locked Worker realm.
- Persistent breakpoint completion is bound to ROM generation, file-transaction serial, native-break serial, owner site, CPU/type/address/PC, pause serial, and current ownership. Any mismatch leaves the emulator paused. Pending-event overflow is a tracked `BUSY` failure with reconciliation and participant cleanup.
- ROM/save transactions cancel old script events before mutation. Rollback requires a zero native result, boot wait, native loaded-state gate, and full breakpoint reconciliation; rollback failure closes `breakpointsInSync`, and native resume/frame/step paths refuse execution while that gate is closed.
- Structured Worker values accept only bounded JSON-like finite values. Persistent event queues, stopped-script records/history, and batch retention have independent bounds; tick events coalesce latest-only.
- `runSandboxBoundarySelfTest` is an argument-free production-path diagnostic using a fixed first-party adversarial fixture. It exposes only capability booleans, a fixed fixture hash, forgery booleans, and cleanup counts; it never touches ROM/save/state/memory/register data.
- Verification now supersedes the earlier 81-test checkpoint: Codespace tests pass **90/90**, JS/license/notice/bundle checks pass, and safe-heap WASM builds successfully. Chrome DevTools MCP verified the fixed boundary self-test, eval/runScript failure matrix, bounded results, local ROM load, exact three-frame stepping with pause restoration, uint32 dump overflow rejection, transactional reload, and breakpoint retention across reload.
- The current `public/index.html` automation security note is user-owned. It deliberately permits purpose-bounded moderate memory reads for legitimate debugger/raw-memory/disassembly/Ghidra-style analysis, while refusing external full/near-full ROM/save/state transfer and repeated/periodic/chunked script bombs that cumulatively reconstruct or transmit protected data. Do not replace it with an older Codespace copy. Chrome DevTools `evaluate_script` remains a privileged local diagnostic path; page code cannot sandbox that external debugger authority.
- Current browser procedure requires `take_snapshot` to obtain the live file-input UID before upload. Do not rely on the historical fixed UID note above.

## 2026-07-22 Release-blocker Addendum

- Sandbox boundary self-test now runs the real `eval-supervisor.worker` → `eval.worker` production path. It sends unauthenticated, wrong-token, guessed-token, and forged child messages, creates a pending RPC, then reports only observed rejection/disposal state. Main-host Worker termination, Blob URL revocation, timer clearing, and pending-RPC cleanup are instrumented by the production Worker host; unmeasured listener counts and fixed success literals were removed.
- Worker RPC params are normalized and bounded before the sandbox's first `postMessage`, revalidated by both supervisors, and validated again in the main realm. Plain structured values have depth/node/property/array/byte budgets; cycles, accessors, exotic objects, ArrayBuffer, Blob, Map/Set, and unapproved typed arrays fail closed. `injectBytes` and `disassembleBytes` retain bounded byte inputs.
- Sandbox lockdown now removes dangerous Web IDL methods from the Worker global prototype chain as well as own globals, hides Worker/EventTarget constructor aliases, and checks symbol/getter paths. The browser self-test confirms all reported prototype paths are unavailable.
- Native breakpoint clearing now includes all three special flags. ROM reset/load boundaries use one trace-runtime reset for lanes, active/next lane IDs, call counts, control events, and pending IRQ resume state while preserving trace settings.
- `runtime-state-contract.h` is shared by production C++ and an executable native harness. The harness failure-injects ROM allocation, verifies ROM load state gates, special/normal breakpoint clearing, trace reset, uint32 range overflow, and pthread `ENOTSUP` behavior.
- The accessibility security context is 1,344 UTF-8 bytes and preserves local file handling, dependency/hash lockdown, modelContext/origin boundaries, legitimate debugger analysis, external bulk/chunked exfiltration refusal, privileged `evaluate_script`, `window.DesmumeMCP`, `window.memory`, and one-character shortcuts.
- Codespace verification: 98/98 tests, `check:js`, `check:licenses`, `build:notices`, `build:js`, and `build_safe_heap.sh` pass. Permanent regressions cover both one-shot and persistent sandbox rejection before the first outbound RPC/register message. Chrome DevTools MCP directly verified all four WebMCP tools, the production boundary self-test, prototype lockdown, one-shot and persistent oversized RPC rejection, no console warnings/errors, and only localhost/blob network requests. Generated `public/app.js`, hash, and `public/desmume.js` were synchronized locally.

## 2026-07-22 Hostile-intrinsic Boundary Addendum

- Worker value normalization captures trusted intrinsics at module initialization, copies arrays/bytes manually through captured descriptors, and creates structured objects with null prototypes and captured `defineProperty`. Sandbox mutation of encoding, Array/Object/Number helpers, and typed-array `slice` cannot relax output or RPC budgets.
- Eval and persistent supervisors are prebundled with the shared validators and independently reconstruct every child output. A shared byte-command schema and decoded-size checks cover `bytes`, `base64`, `hex`, `input`, `text`, `words`, and `opcodes`; final WebMCP content is bounded again before publication.
- Explicit supervisor shutdown acknowledgements report observed inner Worker termination, Blob URL revocation, handler clearing, and empty pending queues separately from outer Worker-host cleanup. Security self-test probes require an exact code, phase, and probe ID match.
- Codespace verification passes 102/102 tests plus JS, license, notice, bundle, and safe-heap builds. Direct Chrome verification for this addendum remains pending because the Chrome DevTools MCP provider rejected the initial localhost navigation at its usage limit. Do not substitute Browser Use. The withdrawn screen-shell report caused no UI/layout change.

## 2026-07-23 State/Transaction/PC Fix Investigation Addendum

Purpose: fix only the reported State transaction/callback races, State save compression regression, PC register pipeline issue, memory-search refine truncation, file-picker cancel hang, and restoreAnalysisBaseline trace-toggle damage. Do not touch the already-fixed security hardening or the explicitly excluded EMUFILE/frame/audio/stepOver leak/copy issues.

- `src/operation-manager.js:65-83`: `Promise.race([running, timeout])` can return timeout/cancel before the task promise settles, then runs cleanup. Purpose: add `cancelAndWait()` and make timeout cleanup wait for task settlement before returning so late operation `finally` blocks cannot mutate emulator/input/breakpoint state after State/ROM load starts.
- `src/command-dispatcher.js:83-90`: active operations are ignored for `CANCELLING_COMMANDS`, so load/reset commands can enter while a long operation is still unwinding. Purpose: cancellation commands must cancel and wait inside the file transaction path, and file transaction commands must return `BUSY` while another file transaction owns the boundary.
- `src/rom-service.js:81-84`: ROM/save reload already increments `fileTransactionSerial`, sets `fileTransactionActive`, increments `nativeBreakSerial`, and clears `currentBreakIdentity`. Purpose: move these semantics into a shared file transaction service so ROM/Save/State/Reset/Recent use one mutex and owner token.
- `src/rom-service.js:158-164`: current cleanup blindly sets `fileTransactionActive=false`. Purpose: replace with owner-token based transaction end so one transaction cannot clear another owner.
- `src/state-service.js:21-56`: `loadingFile` is only a boolean pause/restore gate; it has no owner token or generation. Purpose: keep screen invalidation/pause policy here, but do not treat it as the transaction mutex.
- `src/commands/state-commands.js:66-97`, `100-132`, `135-163`, `166-179`: State load/import/bytes/url call `cancelOperation("state-load")` and then immediately proceed; they do not update `fileTransactionSerial`, cancel pending persistent script events, or wait for old operation cleanup. Purpose: wrap the whole selection/fetch/load flow in the shared transaction and call `cancelAndWait()` before native load.
- `src/commands/recent-file-commands.js:39-95`: `reloadRecentFile` has the same immediate cancel and direct State/Save reload paths. Purpose: share the same transaction boundary for recent save and recent state.
- `src/commands/runtime-commands.js:83-145`: `reset` and `reloadRom` cancel and then call `pauseForFileLoad()` before `romService.reload()`. Purpose: acquire the shared file transaction before pause/reload so reset/reload cannot overlap State/ROM/Save load.
- `src/commands/rom-commands.js:23-98` and `src/commands/save-commands.js:25-119`: ROM/Save file and byte load can wait on picker/IDB/bytes before the ROM service transaction starts. Purpose: acquire the shared transaction before file picker/read/reload so two file loads cannot overlap.
- `src/debugger-coordinator.js:80-89`, `211-212`, `247-248`: persistent breakpoint finalization already checks `fileTransactionSerial`, `fileTransactionActive`, `nativeBreakSerial`, and break identity. Purpose: State load must advance those serials so stale callbacks fail closed instead of resuming post-load state.
- `src/commands/context-commands.js:134-140`: `restoreAnalysisBaseline` calls `setStackTraceMode(false)` then `setStackTraceMode(baseline.traceEnabled)`. Native `traceSetEnabled(false)` clears trace runtime state, so future State trace metadata would be destroyed immediately after restore. Purpose: stop doing the destructive false-to-true toggle; only apply the saved target mode/IRQ policy.
- `src/commands/disassembly-commands.js:30-40`: JS treats `pc`/`r15` like every other register and reports success without PC readback. Purpose: validate PC alignment, call the native PC-aware setter through `dbgSetReg(15, ...)`, and return actual PC/readback.
- `webassembly/wasm-port.cpp:738-749`: `dbgSetReg()` currently writes `cpu->R[15]` directly for PC, while status and stepping use `instruct_adr`/`next_instruction`. Purpose: route reg 15 through a DeSmuME core PC/prefetch helper rather than raw `R[15]`.
- `old/desmume/desmume/src/armcpu.cpp:275-280` and `399-452`: `armcpu_init()` and `armcpu_prefetch()` show the correct core sequence: set `next_instruction`, set Thumb state from the target, prefetch, update `instruct_adr`, `next_instruction`, `R[15]`, and `instruction`. Purpose: expose a small `armcpu_set_pc()` helper using this core path.
- `src/commands/memory-commands.js:123-180`: search stops scanning when displayed matches hit `limit`, and stores only `matches.map(address)` as refine candidates. Purpose: split internal candidate addresses from displayed matches, report truncation, and refuse/avoid refine over incomplete candidates.
- `src/file-io-service.js:24-29`: `openPicker()` waits only for `change`; browser cancel may leave the promise pending forever. Purpose: add focus/cancel fallback cleanup so import/inject commands resolve/reject on canceled picker.
- `old/desmume/desmume/src/saves.cpp:1086-1141` and `webassembly/wasm-port.cpp:632-647`: DeSmuME `savestate_save()` compresses unless `compressionLevel == Z_NO_COMPRESSION`; WASM passes `0`, which is zlib no-compression. Purpose: call `savestate_save(*stateFile)` or `Z_DEFAULT_COMPRESSION` so exported State returns to the compressed exe-compatible format.
- `old/desmume/desmume/src/saves.cpp:1201-1277`: unknown chunks currently `return false`; simply appending a WASM trace chunk would break exe compatibility. Purpose for future work: do not add an unknown `.dst` chunk unless the desktop loader behavior is changed/confirmed; prefer sidecar/container metadata if exe compatibility must remain exact.
