# DeSmuME WebAssembly API

This document describes the browser-side API exposed by `public/index.html`.
All operations are local to the browser. ROM, save, and state files are not uploaded.

## Browser Entry Points

- `window.DesmumeMCP.call(name, params)`: Runs one command and returns a result object.
- `window.DesmumeMCP.list()`: Returns command names, parameter notes, and descriptions.
- `window.postMessage({ type: "desmume-mcp", id, command, params }, "*")`: Message-based command transport. The page replies with `{ type: "desmume-mcp-result", id, result }`.

## Commands

- `status`: Returns pause state, file-load gate state, ROM-loaded state, frame count, render/audio/debug toggles, speed, selected CPU, and current PC/CPSR values.
- `loadRomFile`: Opens the file picker. The user selects a local `.nds` ROM, which is mounted into the in-browser filesystem and loaded.
- `loadRomBytes`: Loads ROM bytes supplied by WebMCP without opening a picker. Pass `{ "bytes": [..], "name": "debug.nds", "waitMs": 600, "resume": true }` or `{ "base64": "..." }`. Use this for local automation; do not paste private ROM data into chat.
- `importSaveFile`: Opens the file picker for a `.sav`/`.dsv` file, imports it through DeSmuME's backup device, then resets the loaded ROM so the game sees the save from boot.
- `exportSaveFile`: Exports DeSmuME's current backup device data and downloads it as `desmume-save.sav`.
- `saveSaveSlot`: Exports the current cartridge save data into a named browser slot. Pass `{ "slot": "name" }`; the UI slot name is used when omitted.
- `loadSaveSlot`: Loads cartridge save data from a named browser slot, imports it into DeSmuME's backup device, then resets the loaded ROM so the game boots with that save.
- `saveState`: Serializes the emulator state and stores it in memory. With `{ "slot": "name" }`, also stores it in IndexedDB/local storage when small enough.
- `loadState`: Loads the active in-memory state or a named browser storage slot without rebooting the emulator. Loading while paused keeps the emulator paused.
- `importStateFile`: Opens a file picker, then loads an external state file into the emulator without rebooting.
- `exportStateFile`: Downloads the current serialized state as `desmume-state.dst`.
- `listRecentFiles`: Returns up to six recently imported or saved save/state entries, each with an `id`, `kind`, `name`, and byte size.
- `reloadRecentFile`: Reloads a recent save or state by `{ "id": number }`. Save entries reset the ROM so the cartridge save is visible from boot; state entries preserve the previous pause state.
- `pause`: Pauses emulation.
- `resume`: Resumes emulation.
- `reset`: Fully stops execution, rewrites the retained ROM bytes into the in-browser filesystem, reloads the ROM through DeSmuME's load path, waits for the requested boot gate, then either stays paused or resumes. Pass `{ "waitMs": 600, "holdPaused": true }` to control the reset gate.
- `reloadRom`: Rewrites and reloads the retained ROM without requiring a new file picker. Use this for reset diagnostics or after save-file replacement. Pass `{ "waitMs": 600, "resume": false }`.
- `setSpeed`: Sets runtime speed from `0.25` to `4.0`.
- `stepFrames`: Advances `{ "frames": N }` frames while preserving the previous pause state.
- `setRenderEnabled`: Enables or disables canvas updates. Use this for fast AI operation.
- `setAudio`: Sets `{ "enabled": boolean, "volume": 0..1 }`. Disabling audio stops browser output while emulation continues.
- `setScale`: Sets the display scale to `1`, `1.5`, `2`, `2.5`, `3`, `3.5`, or `4`.
- `setRotation`: Sets screen rotation to `0`, `90`, `180`, or `270`.
- `setInput`: Presses or releases DS buttons using `{ "button": "A|B|X|Y|L|R|Start|Select|Up|Down|Left|Right", "pressed": boolean }`.
- `setKeyBinding`: Changes a human hotkey with `{ "button": "A", "key": "KeyZ" }`.
- `getRegisters`: Returns ARM9 or ARM7 registers with `{ "cpu": "arm9" | "arm7" }`.
- `setRegister`: Changes one register with `{ "cpu": "arm9", "register": "r0".."r15"|"pc"|"cpsr", "value": number|string }`.
- `disassemble`: Uses DeSmuME's ARM/Thumb disassembler and returns address/opcode/mnemonic rows with `{ "cpu": "arm9", "address": number|string, "count": number, "before": number, "mode": "auto"|"arm"|"thumb" }`. `before` dumps a small number of instructions above the address; the current PC row is prefixed with `=>`.
- `dumpMemory`: Returns a byte array and hex text for `{ "cpu": "arm9", "address": number|string, "length": number }`.
- `injectMemoryFile`: Opens a file picker and writes the selected local file into emulated memory starting at `{ "cpu": "arm9", "address": number|string }`. Script/API callers may pass `{ "bytes": [0, 1, ...], "name": "patch.bin" }` instead of using the picker.
- `searchMemory`: Searches memory with `{ "cpu": "arm9"|"arm7", "address": number|string, "length": number, "size": 1|2|4, "condition": "equal"|"notEqual"|"greater"|"less"|"changed"|"unchanged"|"increased"|"decreased", "value": number|string, "refine": boolean, "limit": number }`. Use `refine: true` to filter the previous result set against the new condition.
- `resetMemorySearch`: Clears the previous memory search snapshot and candidate list so the next search starts from the full range.
- `writeMemory`: Writes one value with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string }`.
- `setMemoryFreeze`: Adds or removes a repeated memory write with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string, "enabled": boolean }`.
- `listMemoryFreezes`: Returns the current repeated memory writes used by Memory Freeze.
- `setBreakpoint`: Adds or removes execution/read/write breakpoints with `{ "cpu": "arm9", "type": "exec"|"read"|"write", "address": number|string, "enabled": boolean }`. Addresses without `0x`, such as `20cb6c4`, are treated as hexadecimal addresses. Execution breakpoints stop before the matched instruction; read/write breakpoints stop the emulator as soon as the native memory hook observes the access. Debug memory viewer reads do not trigger memory breakpoints.
- `setSpecialBreakpoint`: Enables exception breakpoints with `{ "kind": "dataAbort"|"prefetchAbort"|"undefinedInstruction", "enabled": boolean }`. These stop the emulator and preserve the recorded call stack near the exception source; they do not destroy the emulator instance.
- `listBreakpoints`: Returns the browser-side breakpoint list used for UI markers. Each item has an `id` for deletion.
- `removeBreakpoint`: Removes one breakpoint by `{ "id": number }`.
- `clearBreakStatus`: Clears the last breakpoint hit shown by `status.native.lastBreak`.
- `step`: Runs `{ "count": N }` CPU instructions through `armcpu_exec` for ARM9 or ARM7.
- `stepOver`: Runs until the next sequential instruction address is reached, capped to avoid infinite stepping.
- `continue`: Resumes from a debugger stop.
- `setStackTraceMode`: Enables or disables registerenterfunc-equivalent call stack collection with `{ "enabled": boolean }`.
- `setStackTracePrivilegeCheck`: Enables or disables IRQ-mode filtering with `{ "enabled": boolean }`.
- `stackTrace`: Returns the recorded call stack plus stack words near SP for `{ "cpu": "arm9", "words": number }`.
- `callStack`: Returns the recorded call stack as structured JSON.
- `runUntilReturn`: Steps until the recorded call stack depth drops below the current depth. Pass `{ "timeoutMs": number, "maxSteps": number }`; timeout is reported as failure.
- `runUntilNextCall`: Steps until the next function-entry hook is recorded. Pass `{ "timeoutMs": number, "maxSteps": number }`; timeout is reported as failure.
- `wait`: Waits `{ "ms": number }` and then returns `status`. `status` also accepts `{ "waitMs": number }` for delayed polling.
- `setCTableSeed`: Implements the `setCTable_jp.lua` write pattern in JavaScript/API form. By default it writes `0x4b539adb` to `0x02385f0c` and zero to the following word; override with `{ "address": string|number, "value": string|number, "high": string|number }`.
- `injectScript`: Runs isolated JavaScript against a capability object. Network APIs, DOM access, import, and Function constructor are unavailable in the sandbox. Pass `{ "timeoutMs": number }` to change the script timeout.
- `batch`: Runs multiple WebMCP commands sequentially. Pass either an array or `{ "commands": [{ "command": "status", "params": {} }] }`; the result contains one entry per command.
- `setFeatureSet`: Enables or disables heavy tool groups with `{ "debugger": boolean, "memory": boolean, "mcp": boolean }`.

Most commands accept `{ "timeoutMs": number }` through the WebMCP runner. If the command does not finish before that deadline, the call fails with a timeout error.
