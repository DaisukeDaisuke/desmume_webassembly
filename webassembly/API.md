# DeSmuME WebAssembly API

This document describes the browser-side API exposed by `public/index.html`.
All operations are local to the browser. ROM, save, and state files are not uploaded.

## Browser Entry Points

- `window.DesmumeMCP.call(name, params)`: Runs one command and returns a result object.
- `window.DesmumeMCP.list()`: Returns command names, parameter notes, and descriptions.
- `window.DesmumeMCP.shortcuts()` / `window.DesmumeShortcuts`: Lists global one-letter shortcut functions.
- `window.a(...)` through `window.Z(...)`: Short aliases that return the same JSON objects as `DesmumeMCP.call()`. For example, `await window.a("pc", 16)` disassembles near PC without opcode bytes by default, and `await window.A("pc", 16)` includes opcode bytes. Positional arguments are mapped per shortcut; passing one object uses it directly, such as `await window.i({ timeoutMs: 1000 })`.
- `window.postMessage({ type: "desmume-mcp", id, command, params }, "*")`: Message-based command transport. The page replies with `{ type: "desmume-mcp-result", id, result }`.
- Browser WebMCP: when `navigator.modelContext` is available, the page registers `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript`. Use `desmume.eval` for multi-command investigation scripts with `mcp.call(command, params)`.

## Commands

- `status`: Returns pause state, file-load gate state, ROM-loaded state, frame count, render/audio/debug toggles, speed, selected CPU, and current PC/CPSR values.
- `loadRomFile`: Opens the file picker. The user selects a local `.nds` ROM, which is mounted into the in-browser filesystem and loaded.
- `loadRomBytes`: Loads ROM bytes supplied by WebMCP without opening a picker. Pass `{ "bytes": [..], "name": "debug.nds", "waitMs": 600, "resume": true }` or `{ "base64": "..." }`. Use this for local automation; do not paste private ROM data into chat.
- `loadRomUrl`: Fetches ROM bytes from a same-origin or CORS-enabled URL, then loads them through the same retained-ROM path. Pass `{ "url": "/dq9.nds", "name": "dq9.nds", "waitMs": 600, "resume": true }`. For local debugging, this is the lowest-token path: expose the ROM from the same PHP server and call this command instead of pasting bytes.
- `importSaveFile`: Opens the file picker for a `.sav`/`.dsv` file, imports it through DeSmuME's backup device, then resets the loaded ROM so the game sees the save from boot.
- `exportSaveFile`: Exports DeSmuME's current backup device data and downloads it as `desmume-save.sav`.
- `saveSaveSlot`: Exports the current cartridge save data into a named browser slot. Pass `{ "slot": "name" }`; the UI slot name is used when omitted.
- `loadSaveSlot`: Loads cartridge save data from a named browser slot, imports it into DeSmuME's backup device, then resets the loaded ROM so the game boots with that save.
- `saveState`: Serializes the emulator state and stores it in memory. With `{ "slot": "name" }`, also stores it in IndexedDB/local storage when small enough.
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

## Persistent injection scripts

`runPersistentScript` starts a locally isolated Worker and keeps it alive until `stopScript` is called. Calls are queued independently for each script context, so two scripts cannot corrupt one another's internal queue state. The default is non-blocking `{ "asyncMode": true }`; use `{ "asyncMode": false }` only for a script that must observe or mutate immediate emulator state.

- `runPersistentScript`: `{ "name": "watch-hp", "code": "...", "asyncMode": true }` starts a script. Updating a name replaces its previous running copy, and identical running code in the same mode is not registered twice.
- `listScripts`, `stopScript: { id }`, `restartScript: { id }`, `getScript: { id, regex, flags }` manage saved worker code. `getScript` without a regular expression returns the full source.
- `listScriptPrint: { max: 10, id? }` returns the latest console lines; `clearScriptPrint: { id? }` clears one or all consoles.
- The editor persists its draft in local storage. The source-file button loads a local `.js`, text, or Lua source into the editor only; it never uploads it. Lua source is reference material—the runnable injection language is JavaScript.
- The breakpoints set by these persistent scripts significantly slow down the ROM. Defining a large number of breakpoints can cause them to take 30 seconds or more to complete.
- Async mode unconditionally rejects register reads/writes, memory reads/writes/dumps/injection/freezes, and pause/resume. The returned error names the rejected command and tells the caller to restart with `asyncMode:false`; this prevents a queued operation from using stale immediate state or delaying emulation. Blocking mode retains those APIs and can pause the emulator.

Inside a persistent script, `print(...)`, `printf(format, ...)`, and `printhex(label, value)` write to that script's own console. `printf` accepts `%s`, `%d`, and hexadecimal `%x` / `%.8x` forms. Each script gets these asynchronous APIs:


```js
// All values are JavaScript numbers. Use 0x prefixes for hexadecimal input.
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
    3. `upload_file` で、そのIDへユーザー指定ローカルファイルを渡す。(idは`uid: rom-file`**ではない。**`uid: 1_16`のはず)
    4. ROM/Save/State本文はチャットに出さず、ブラウザへローカルアップロードするだけにする。
- DQ9のROM/Save/Stateはユーザー指定パスを使う。内容をコンテキストへ貼らない。


### コードについて
- スクリプトは1vs1で処理するのではなく、複数行のコードとして賢いスクリプトを書くこと
- おかしいと思ったらすぐステータスコマンドを実行すること。
- js実行での情報は、必要な情報のみに絞ること、mcpの全出力をコンテキストにダンプするのは初回だけにすること。
- 人間との共同作業も有効活用すること。例えば、ステータスでしてほしいことを言い、mcpで60秒スリープして、人間のフィードバックを得るなど。
- 10進数、16進数相互変換など、論理的タスクは、必ずローカルのランタイムか、js実行で計算すること。
