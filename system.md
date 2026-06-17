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
- `dbgDisassemble()` currently returns address plus opcode words/halfwords. A full mnemonic disassembler should be connected to DeSmuME's internal disassembler or a compact ARM/Thumb decoder.
- Stack trace mode currently exposes SP-relative words. The heavier next-call/call-stack mechanism from `D:\lua_new\lua\callstack_test.lua` should be ported behind the existing `traceSetEnabled()` switch.
