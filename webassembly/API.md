# DeSmuME WebAssembly API

This document describes the browser-side API exposed by `public/index.html`.
All operations are local to the browser. ROM, save, and state files are not uploaded.

## Browser Entry Points

- `window.DesmumeMCP.call(name, params)`: Runs one command and returns a result object.
- `window.DesmumeMCP.list()`: Returns command names, parameter notes, and descriptions.
- `window.postMessage({ type: "desmume-mcp", id, command, params }, "*")`: Message-based command transport. The page replies with `{ type: "desmume-mcp-result", id, result }`.

## Commands

- `status`: Returns pause state, frame count, render/audio/debug toggles, speed, selected CPU, and current PC/CPSR values.
- `loadRomFile`: Opens the file picker. The user selects a local `.nds` ROM, which is mounted into the in-browser filesystem and loaded.
- `importSaveFile`: Opens the file picker for a `.sav`/`.dsv` file, imports it through DeSmuME's backup device, then resets the loaded ROM so the game sees the save from boot.
- `exportSaveFile`: Exports DeSmuME's current backup device data and downloads it as `desmume-save.sav`.
- `saveState`: Serializes the emulator state and stores it in memory. With `{ "slot": "name" }`, also stores it in IndexedDB/local storage when small enough.
- `loadState`: Resets the loaded ROM, then loads the active in-memory state or a named browser storage slot. Loading while paused keeps the emulator paused.
- `importStateFile`: Opens a file picker, resets the loaded ROM, then loads an external state file into the emulator.
- `exportStateFile`: Downloads the current serialized state as `desmume-state.dst`.
- `pause`: Pauses emulation.
- `resume`: Resumes emulation.
- `reset`: Resets the loaded ROM.
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
- `disassemble`: Uses DeSmuME's ARM/Thumb disassembler and returns address/opcode/mnemonic rows with `{ "cpu": "arm9", "address": number|string, "count": number, "mode": "auto"|"arm"|"thumb" }`. The current PC row is prefixed with `=>`.
- `dumpMemory`: Returns a byte array and hex text for `{ "cpu": "arm9", "address": number|string, "length": number }`.
- `writeMemory`: Writes one value with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string }`.
- `setMemoryFreeze`: Adds or removes a repeated memory write with `{ "cpu": "arm9", "address": number|string, "size": 1|2|4, "value": number|string, "enabled": boolean }`.
- `listMemoryFreezes`: Returns the current repeated memory writes used by Memory Freeze.
- `setBreakpoint`: Adds or removes execution/read/write breakpoints with `{ "cpu": "arm9", "type": "exec"|"read"|"write", "address": number|string, "enabled": boolean }`.
- `listBreakpoints`: Returns the browser-side breakpoint list used for UI markers.
- `step`: Runs `{ "count": N }` CPU instructions through `armcpu_exec` for ARM9 or ARM7.
- `stepOver`: Runs until the next sequential instruction address is reached, capped to avoid infinite stepping.
- `continue`: Resumes from a debugger stop.
- `setStackTraceMode`: Enables or disables stack trace collection with `{ "enabled": boolean }`.
- `stackTrace`: Returns stack words near SP for `{ "cpu": "arm9", "words": number }`.
- `injectScript`: Runs isolated JavaScript against a capability object. Network APIs, DOM access, timers, import, and Function constructor are unavailable in the sandbox.
- `setFeatureSet`: Enables or disables heavy tool groups with `{ "debugger": boolean, "memory": boolean, "mcp": boolean }`.
