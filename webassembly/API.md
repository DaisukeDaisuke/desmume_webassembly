# DeSmuME WebAssembly API

This document describes the browser-side API exposed by `public/index.html`.
All operations are local to the browser. ROM, save, and state files are not uploaded.

## Local security context

This security context is also included in the native WebMCP tool descriptions so an AI client receives it before choosing a tool:

- ROM, save, and State file inputs are read into the current browser page and in-memory emulator only. They are not uploaded by the file controls, debugger commands, memory commands, eval scripts, or persistent scripts. `data:` and `blob:` requests shown by DevTools are local in-memory resources, not remote transfers.
- The page loads its executable `<script>` resources only from the same origin. It uses the browser's built-in `document.modelContext` API (with `navigator.modelContext` only as a compatibility fallback) and does not load `@mcp-b/global` or another third-party WebMCP shim into the page global scope.
- The `postMessage` command bridge requires `event.origin === window.location.origin`. Opaque sandbox origins (`null`) and other origins receive no command execution and no reply, including for ROM dumps, memory reads, and register reads. Native WebMCP and an exact same-origin caller remain trusted interfaces and can intentionally request debugger data.
- One-shot eval and persistent scripts run behind supervisor Workers in inner sandbox Workers. Acorn parsing happens first in a separate dependency-only parser Worker that receives script text but no emulator, memory, register, frame, or MCP RPC capability. The execution sandbox has no DOM or `window`, and network APIs, sub-Workers, raw `postMessage`, `localStorage`, `sessionStorage`, IndexedDB, Cache API, string timers, global `eval`, and constructor-chain code generation are disabled. RPC reaches the emulator only through the authenticated supervisor protocol and an explicit command allowlist.
- No executable source is fetched from a CDN at runtime. Acorn 8.17.0 and ssim.js 3.5.0 are exact-version npm dependencies bundled at build time. `ssim-trim` runs only in its algorithm Worker, which disables network, sub-Workers, raw messages, browser storage, string timers, `eval`, constructor-chain generation, and matching Worker-global prototype capabilities before accepting comparison work. It receives only the baseline/current frame pixels and comparison options required for that call, never ROM, save, or State bytes.
- Choosing `loadRomUrl` or `loadStateUrl` is an explicit request to fetch the supplied URL. The local file controls are the appropriate path when no network fetch is desired.

These are concrete isolation guarantees for `execute_webmcp_tool` / WebMCP eval and production page code, not permission for a caller to disclose data it intentionally receives. Chrome DevTools MCP `evaluate_script` runs directly in the main page as a privileged local diagnostic and is outside the page sandbox boundary. Keep ROM/memory results out of chat and logs, and grant native WebMCP, same-origin page access, or DevTools access only to a trusted client.

## Browser Entry Points

- `window.DesmumeMCP.call(name, params)`: Runs one command and returns a result object.
- `window.DesmumeMCP.list()`: Returns command names, parameter notes, and descriptions.
- `window.DesmumeMCP.shortcuts()` / `window.DesmumeShortcuts`: Lists global one-letter shortcut functions.
- `window.a(...)` through `window.Z(...)`: Short aliases that return the same JSON objects as `DesmumeMCP.call()`. For example, `await window.a("pc", 16)` disassembles near PC without opcode bytes by default, and `await window.A("pc", 16)` includes opcode bytes. Positional arguments are mapped per shortcut; passing one object uses it directly, such as `await window.i({ timeoutMs: 1000 })`.
- `window.postMessage({ type: "desmume-mcp", id, command, params }, "*")`: Message-based command transport. The page replies with `{ type: "desmume-mcp-result", id, result }`.
- Browser WebMCP: when `document.modelContext` (or the compatibility fallback `navigator.modelContext`) is available, the page registers `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript`. Their descriptions inject the local security context above. Use `desmume.eval` for multi-command investigation scripts with `mcp.call(command, params)`.

### One-letter shortcut reference

Each shortcut is an `async` function on `window`; call it with positional arguments in the listed order, or with one parameter object to name values explicitly. Omitted arguments use the defaults shown below (or the command's normal defaults). Upper- and lower-case names are distinct. `window.DesmumeShortcuts` exposes the same command/parameter/default mapping for discovery.

| Shortcut | Command | Positional parameters and defaults |
| --- | --- | --- |
| `a` / `A` | `disassemble` | `address, count=16, before=4, mode`; `A` includes opcode bytes |
| `b` / `B` | `disassembleBytes` / `binaryFloat` | `b(input, mode, endian)` / `B(value, bits, op)` |
| `c` / `C` | `callStack` / `getOtherCoroutines` | `c(limit=32)` / `C(stackId, limit=32)` |
| `d` / `D` | `status` / `dumpMemory` | `d()` / `D(address, length=64, view)` |
| `e` / `E` | `getRegisters` / `eval` | `e(cpu)` / `E(code, timeoutMs)` |
| `f` / `F` | `step` / `stepFrames` | `f(count=1)` / `F(frames=1)` |
| `g` / `G` | `smartStep` / `setRegister` | `g()` / `G(register, value, cpu)` |
| `h` / `H` | `stepOver` / `setFeatureSet` | `h()` / `H(debugger, memory, mcp)` |
| `i` / `I` | `stepNextBranchOrReturn` / `injectBytes` | `i(timeoutMs, maxSteps)` / `I(address, input)` |
| `j` / `J` | `runUntilNextCall` / `nextFunctionCall` | `j(timeoutMs, maxSteps)` / `J(timeoutMs, maxSteps)` |
| `k` / `K` | `runUntilReturn` / `returnToPop` | `k(timeoutMs, maxSteps)` / `K(timeoutMs, maxSteps)` |
| `l` / `L` | `listBreakpoints` / `listOtherCoroutines` | `l()` / `L(limit=32)` |
| `m` / `M` | `batch` / `setBreakpoint` | `m(commands)` / `M(address, type, enabled)` |
| `n` / `N` | `trueNextBranch` / `removeBreakpoint` | `n(timeoutMs, maxSteps)` / `N(id)` |
| `o` / `O` | `searchMemory` / `resetMemorySearch` | `o(address, value, condition, size)` (limit `64`) / `O()` |
| `p` / `P` | `pause` / `resume` | `p()` / `P()` |
| `q` / `Q` | `setInput` / `runInputTap` | `q(button, pressed)` / `Q(button, repeat, holdMs, gapMs)` |
| `r` / `R` | `runInputHold` / `runTouchHold` | `r(button, durationMs)` / `R(x, y, durationMs)` |
| `s` / `S` | `setSpeed` / `setCTableSeed` | `s(speed)` / `S(address, value, high)` |
| `t` / `T` | `stackTrace` / `setStackTraceMode` | `t(limit=32)` / `T(enabled)` |
| `u` / `U` | `writeMemory` / `setStackTracePrivilegeCheck` | `u(address, value, size)` / `U(enabled)` |
| `v` / `V` | `setRenderEnabled` / `setAudio` | `v(enabled)` / `V(enabled, volume)` |
| `w` / `W` | `wait` / `waitMs` | `w(ms)` / `W(ms)` |
| `x` / `X` | `clearBreakStatus` / `copyCallStackMarkdown` | `x()` / `X()` |
| `y` / `Y` | `setScale` / `copyCallStackCsv` | `y(scale)` / `Y()` |
| `z` / `Z` | `setRotation` / `takeScreenshot` | `z(rotation)` / `Z(type, includeDataUrl)` |

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
- `batch`: Runs multiple WebMCP commands sequentially. Pass `{ "commands": [{ "command": "status", "params": {} }] }`; the result contains one entry per command.
- `setFeatureSet`: Enables or disables heavy tool groups with `{ "debugger": boolean, "memory": boolean, "mcp": boolean }`.

Most commands accept `{ "timeoutMs": number }` through the WebMCP runner. If the command does not finish before that deadline, the call fails with a timeout error.

## Long-running operations and normal errors

`waitForBreak`, `runUntil`, `runInputSequence`, and `waitForScreenChange` are mutually exclusive. A second long-running operation returns `ok:false` with `error.code="BUSY"`; it does not wait or start another emulator loop. `pause`, ROM/State load, reset, page unload, and explicit cancellation stop the active operation and release timers, listeners, temporary breakpoint owners, DS buttons, and touch input.

`waitForBreak`, `runUntil`, and `waitForScreenChange` require `timeoutMs` in the range 1 through 600000. Timeout is a normal result with `error.code="TIMEOUT"`, not a rejected Promise. The emulator is paused and the next command can run immediately.

All expected failures use this shape across `DesmumeMCP`, WebMCP, and Worker RPC:

```js
{ ok: false, error: { code, message, recoverable: true, details? } }
```

Stable error codes include `WASM_NOT_READY`, `ROM_NOT_LOADED`, `INVALID_ARGUMENT`, `UNKNOWN_COMMAND`, `TIMEOUT`, `BUSY`, `CANCELLED`, `SCREEN_INVALID`, `NO_WAITABLE_BREAKPOINTS`, `BREAKPOINT_NOT_FOUND`, `BREAKPOINT_NOT_WAITABLE`, `BREAKPOINT_INTERRUPTED`, `SCRIPT_PAUSED`, `SCRIPT_SOURCE_INVALID`, `SCRIPT_COMPILE_ERROR`, `SCRIPT_RUNTIME_ERROR`, `WORKER_START_FAILED`, `WORKER_CRASHED`, `WORKER_PROTOCOL_ERROR`, `SEQUENCE_NOT_FOUND`, `SEQUENCE_EXISTS`, `FRAME_SNAPSHOT_NOT_FOUND`, `FRAME_SNAPSHOT_EXISTS`, `ALGORITHM_UNAVAILABLE`, `ALGORITHM_INTEGRITY_FAILED`, `NATIVE_ERROR`, `NATIVE_FAULT`, and `INTERNAL_ERROR`.

Application errors remain successful WebMCP transports. Compact text contains the short `ok`/error summary, while structured content remains an object.

### `waitForBreak`

```js
waitForBreak({ timeoutMs: 30000, scriptBreakpoints: "ignore" })
```

The default ignores script-only breakpoints and requires at least one enabled non-script breakpoint. With none it returns `NO_WAITABLE_BREAKPOINTS` without resuming. Mixed script/user ownership is user-visible. A persistent script callback still runs; an explicit callback pause ends the wait with `SCRIPT_PAUSED`.

### `runUntil`

Use exactly one condition:

```js
runUntil({ timeoutMs: 30000, pc: "021e54fc" })
runUntil({ timeoutMs: 30000, bp: 12, hits: 10 })
```

The PC form owns a temporary execution breakpoint without replacing an existing owner. The hit-count form counts only events after the call begins. All temporary ownership is removed on every exit path.

### `runInputSequence`

```js
runInputSequence({ id: "menu-open", seq: [["t", "A", 2], ["w", 300], ["hf", "Up", 2]] })
runInputSequence({ id: "menu-open" })
```

Opcodes are `t` (tap), `s` (spam for milliseconds), `h` (hold for milliseconds), `hf` (hold for emulator frames), `w` (real-time wait), `wf` (emulator-frame wait), and `x` (touch). Join simultaneous buttons with `+`. The entire sequence is validated before execution. IDs are stored under the versioned `desmume-input-sequences-v1` key. Replacing a different existing sequence requires `replace:true`. `listInputSequences` and `deleteInputSequence` manage saved entries.

## Frame snapshots and comparison

State load invalidates capture APIs until one complete emulator frame increments the native frame counter. CPU stepping, a partial frame interrupted by a breakpoint, canvas repaint, and framebuffer capture alone do not validate it. During this interval the UI keeps the last valid canvas visible and reports that execution must resume; capture, comparison, screenshot, and screen-wait commands return `SCREEN_INVALID`.

`captureFrame({id, replace:false})` copies the native 256x384 framebuffer into independent JavaScript storage. At most 16 snapshots are retained; exceeding the limit or reusing an ID without `replace:true` returns a normal error. `listFrameSnapshots` and `deleteFrameSnapshot` manage them.

`compareFrame` requires `id`, `algorithm`, and `thresholdPct`. `screen` is `top`, `bottom`, or `both` (default); `region` is `[x,y,width,height]`; and absolute `ignoreRects` are not silently clipped.

| ID | Meaning | Suggested use | Main defaults |
| --- | --- | --- | --- |
| `px` | changed pixel percentage | static UI, fades | tolerance 8 |
| `px-window` | dense local pixel change | scattered noise | tolerance 8 |
| `hist` | luminance histogram distance | scenes and overall tone | 16 bins |
| `blk` | trimmed block-layout change | menus with local animation | tile 16, grid 4, blur 1, tile threshold 8%, trim 20% |
| `edge` | trimmed edge-layout change | text boxes, borders, positioning | tile 16, blur 1, tile threshold 10%, trim 20% |
| `ssim-trim` | trimmed tiled SSIM | texture/lighting tolerance | tile 16, tile threshold 12%, trim 20%; verified optional library |

All scores are 0–100, but thresholds are algorithm-specific. `hist`, `blk`, `edge`, and the built-in `px` fallback work offline.

### `waitForScreenChange`

The operation captures frame A once while paused and compares every later completed sample to A: B-vs-A, C-vs-A, D-vs-A. It never advances the baseline. `stableFrames` counts consecutive samples meeting `thresholdPct`; `sampleEveryFrames` reduces comparison frequency without changing A. A user-visible breakpoint returns `BREAKPOINT_INTERRUPTED`; script-only hits are ignored unless requested. Timeout details include `maxPct`.

## Worker and optional algorithm policy

Persistent/eval Worker sources live under `src/workers`, are embedded as strings in the production `public/app.js` bundle, and start from Blob URLs. Stop, timeout, crash, and restart terminate the Worker, settle pending RPC, and revoke its URL. Their inner sandboxes cannot access the DOM, `window`, ROM/State bytes, frame pixels, network APIs, browser storage, raw messages, sub-Workers, or unapproved RPC. `localStorage`, `sessionStorage`, IndexedDB, and Cache API are explicitly shadowed even though normal browser Workers do not expose every one of those APIs.

Optional external image algorithms use only fixed HTTPS allowlist entries with exact versions and SHA-256 verification. Integrity/network failure disables only that algorithm. License/version/hash/source metadata is maintained in `THIRD_PARTY_NOTICES.md`; `public/coi-serviceworker.js` remains an independent unminified vendored asset with its MIT header.

`ssim-trim` uses the locally bundled, exact `ssim.js` 3.5.0 package. It executes only inside the embedded algorithm Worker after that Worker removes network, storage, raw-message, sub-Worker, and runtime code-generation capabilities. The library receives only frame pixels and comparison options for the active comparison. Worker startup, timeout, protocol, or execution failures remain isolated from `px`, `px-window`, `hist`, `blk`, and `edge`.

## Persistent injection scripts

`runPersistentScript` starts a locally isolated Worker and keeps it alive until `stopScript` is called. Calls are queued independently for each script context, so two scripts cannot corrupt one another's internal queue state. The default is blocking `{ "asyncMode": false }`. Enable `{ "asyncMode": true }` only for a non-blocking register-observation script.

- `runPersistentScript`: `{ "name": "watch-hp", "code": "...", "asyncMode": false }` starts a script. Updating a name replaces its previous running copy, and identical running code in the same mode is not registered twice.
- `listScripts`, `stopScript: { id }`, `restartScript: { id }`, and `getScript: { id }` manage saved worker code. `getScript` returns at most 65536 source characters with `truncated` and `originalChars`; main-thread regular-expression evaluation is intentionally unavailable.
- `listScriptPrint: { max: 10, id? }` returns the latest console lines; `clearScriptPrint: { id? }` clears one or all consoles.
- The editor persists its draft in local storage. The source-file button loads a local `.js`, text, or Lua source into the editor only; it never uploads it. Lua source is reference material—the runnable injection language is JavaScript.
- The breakpoints set by these persistent scripts significantly slow down the ROM. Defining a large number of breakpoints can cause them to take 30 seconds or more to complete.
- Async mode permits only register reads (`memory.getregister` / `memory.reg`) among direct emulator-state APIs. It rejects register writes, memory reads/writes/dumps/injection/freezes, and pause/resume, preventing a queued script from mutating or observing stale immediate state. If an async script fails to register a callback, throws while starting or handling a callback, or its Worker reports an execution error, it is stopped automatically: its triggers are removed and its Worker is terminated. Blocking mode retains the full API and can pause the emulator.

Inside a persistent script, `print(...)`, `printf(format, ...)`, and `printhex(label, value)` write to that script's own console. `printf` accepts `%s`, `%d`, and hexadecimal `%x` / `%.8x` forms. Each script gets these asynchronous APIs:


```js
// Blocking mode: all values are JavaScript numbers. Use 0x prefixes for hexadecimal input.
const pc = await memory.getregister("pc", "arm9");
const lr = await memory.getregister("r14", "arm9"); // r13=sp, r14=lr, r15=pc
await memory.setregister("r0", 0x12345678, "arm9");

await memory.writebyte(0x02000000, 0xab);
await memory.writeword(0x02000010, 0x1234);     // memory bytes: 12 34
await memory.writedword(0x02000020, 0x12345678); // memory bytes: 12 34 56 78

printhex("word", await memory.readword(0x02000010));
printhex("dword", await memory.readdword(0x02000020));
```

`readword` / `readdword` and `writeword` / `writedword` use Big Endian values at the API boundary. The implementation converts those values to and from the emulator's Little Endian memory layout. `readbyte` / `writebyte` are aliases for one-byte access. WebMCP equivalents are `memoryGetRegister`, `memorySetRegister`, `memoryReadByte`, `memoryReadWord`, `memoryReadDword`, `memoryWriteByte`, `memoryWriteWord`, and `memoryWriteDword`.

For an async script, register the callback and only read registers inside it. This mode never writes emulator state and stops itself if registration or callback execution fails:

```js
memory.ontick(async ({ frame }) => {
  const pc = await memory.getregister("pc", "arm9");
  if ((frame % 60) === 0) printhex("ARM9 PC", pc);
});
```

Register a callback once; its registration is tied to the script and is removed automatically on `stopScript`:

```js
memory.registerwrite(0x02000020, async (hit) => {
  print("write", hit.address, "pc", hit.pc);
  await mcp.call("pause");
}, { cpu: "arm9" });

memory.registerread(0x02000020, async (hit) => print("read", hit.value), { cpu: "arm9" });
memory.registerexec(0x02000000, async (hit) => print("executing", hit.pc), { cpu: "arm9" });
memory.registerexception("dataAbort", async (hit) => print("data abort", hit.pc));
memory.registerexception("prefetchAbort", async (hit) => print("prefetch abort", hit.pc));
memory.registerexception("undefinedInstruction", async (hit) => print("undefined", hit.pc));

emu_registerstart(async ({ reason }) => print("ROM reset/reloaded:", reason));
emu_ontick(async ({ frame }) => { if ((frame % 60) === 0) print("frame", frame); });
// memory.ontick(callback) is the same frame callback.
```

`registerexec` is a non-stopping trace hook. Native execution pauses briefly before the matched ARM9 instruction so the callback sees the exact event state. After the callback, if PC is still on that execute breakpoint, the API skips that breakpoint for one instruction and then resumes normally. A trace callback therefore does not repeatedly dispatch at an unchanged PC or leave the emulator paused. A different breakpoint encountered by that one-instruction step is still honored. To intentionally stop at the original event, call `await emu.pause()` or `await mcp.call("pause")` inside the callback; that explicit pause takes effect immediately in the event state and cancels the automatic step and resume.

Persistent scripts can call WebMCP commands through `mcp.call(command, params)` or its `webmcp.call` alias, subject to the async-mode restrictions above. Common emulator and debugger operations also have shortcuts such as `emu.status()`, `emu.step()`, `emu.smartStep()`, `emu.stepOver()`, `emu.stepNextBranchOrReturn()`, `emu.trueNextBranch()`, `emu.runUntilReturn()`, `emu.runUntilNextCall()`, `emu.stepFrames(params)`, and `emu.setInput(params)`. Blocking mode also permits `emu.pause()` and `emu.resume()`.

The current version exposes `stateLoad` and `stateSave` events to the worker event bus for future scripts, and normal `mcp.call("loadState", ...)`, `mcp.call("saveState", ...)`, `mcp.call("reloadRecentFile", ...)`, and `mcp.call("setInput", ...)` remain available from callback code. The helper `setCTableSeed` provides the JavaScript equivalent of the common `setCTable_jp.lua` pattern: it writes `0x4b539adb` at `0x02385f0c` and zero at the following word unless overridden.

### Chrome MCPでのファイルアップロード

- AI側からのROM/Save/State読み込みは、Chrome MCPのアップロード対象要素IDとアップロードツールを組み合わせる。
- file inputのIDは毎回変わる可能性がある。固定IDを仮定しない。
- アップロード用ツールはデフォルトで見えていないことがある。必要なら `tool_search` で `take_snapshot` と `upload_file` を探して使う。
- 手順:
    1. Chrome MCPで対象ページ（例: `https://daisukedaisuke.github.io/desmume_webassembly/` または `http://localhost:8766/`）を開く。
    2. `take_snapshot` でDOM/アクセシビリティツリーを取り、ROM/Save/Stateの file input またはアップロードボタンの現在IDを確認する。
    3. `upload_file` で、そのIDへユーザー指定ローカルファイルを渡す。(idは`uid: rom-file`**ではない。**`uid: 3_16`のはず)
    4. ROM/Save/State本文はチャットに出さず、ブラウザへローカルアップロードするだけにする。
- DQ9のROM/Save/Stateはユーザー指定パスを使う。内容をコンテキストへ貼らない。


### コードについて
- スクリプトは1vs1で処理するのではなく、複数行のコードとして賢いスクリプトを書くこと
- おかしいと思ったらすぐステータスコマンドを実行すること。
- js実行での情報は、必要な情報のみに絞ること、mcpの全出力をコンテキストにダンプするのは初回だけにすること。
- 人間との共同作業も有効活用すること。例えば、ステータスでしてほしいことを言い、mcpで60秒スリープして、人間のフィードバックを得るなど。
- 10進数、16進数相互変換など、論理的タスクは、必ずローカルのランタイムか、js実行で計算すること。
