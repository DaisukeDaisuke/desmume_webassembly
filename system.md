# DeSmuME WebAssembly Work Log

## Current Direction

- Source ownership: `old/desmume` is treated as the DeSmuME source submodule and tracks the `webassembly` branch of `git@github.com:DaisukeDaisukeForks/desmume.git`.
- Browser output: `public/index.html` is the single-page debugger UI. Emscripten builds `public/desmume.js` with `-sSINGLE_FILE=1`, so the wasm payload is embedded in one JavaScript file.
- Memory policy: initial memory is 256MB and maximum memory is 2GB through Emscripten memory growth.
- Data policy: ROMs, saves, states, and scripts are processed locally in the browser. The UI does not upload user files.

## Implemented Surface

- ROM import, save import/export, state import/export, and IndexedDB state slot storage with a 256MB per-state guard.
- Emulator pause/resume/reset, N-frame advance, render toggle, display scale, rotation, speed control from 0.25x to 4x, and basic button/hotkey input.
- WebMCP-style command entry through `window.DesmumeMCP.call()` and `postMessage`.
- Debugger entry points for register read/write, PC/CPSR status, memory dump/write, execution/read/write breakpoint registration, stepping, stack dump, and address/opcode disassembly rows.
- Isolated script injection through a short-lived Worker that exposes only the MCP call capability and shadows network/DOM APIs.

## Follow-up Notes

- Native memory read/write breakpoints currently have exported registration points and browser-side lists. Full trap integration should be wired into DeSmuME MMU debug access paths in the `old/desmume` submodule.
- `dbgDisassemble()` is wired to DeSmuME's `frontend/modules/Disassembler.cpp`; keep that file explicitly included in `webassembly/build.sh` because the generic core file scan excludes `frontend/`.
- `step` is CPU-instruction stepping through `armcpu_exec<0/1>()`. `stepFrames` is the frame-level operation.
- `NDS_setPad()` does not accept the same order exposed by MCP. The browser bit order remains `A,B,Select,Start,Right,Left,Up,Down,R,L,X,Y`, and `wasm-port.cpp` maps it to native `right,left,down,up,select,start,B,A,Y,X,L,R`.
- Save imports use `MMU_new.backupDevice.importData("import.sav")`; save exports use `exportData("export.sav")`. Imports reset the ROM because dynamic backup-device swapping is unreliable.
- State imports and slot loads reset before `savestate_load()` and restore the previous pause state after loading.
- Canvas layout must reserve real scaled dimensions for the rotated DS screen. Do not use only `transform: scale()` with guessed margins; it causes adjacent GUI drift.
- Stack trace mode currently exposes SP-relative words plus a lightweight possible-LR disassembly heuristic. The heavier next-call/call-stack mechanism from `D:\lua_new\lua\callstack_test.lua` still needs a native port behind `traceSetEnabled()`.
