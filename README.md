# desmume_webassembly

DeSmuME WebAssembly debugger with a local-only browser UI and WebMCP-style AI control surface.

Public deployment: https://daisukedaisuke.github.io/desmume_webassembly/

## What This Provides

| Area | Supported |
|---|---|
| ROM handling | Local `.nds` upload in the browser filesystem; no ROM upload to a server |
| Save handling | `.sav`/`.dsv` import/export, browser save slots, recent save reload |
| State handling | `.dst` import/export, IndexedDB-backed state slots up to the browser storage limit, recent state reload |
| Runtime control | Pause, resume, reset, N-frame stepping, 0.25x to 4x speed, render on/off, audio on/off and volume |
| Display/input | 1x to 4x scale, 0/90/180/270 rotation, pointer touch on the lower DS screen, configurable hotkeys |
| Debugger | ARM9/ARM7 registers, changed-register highlight, PC disassembly, step, step over, continue |
| Breakpoints | Execution, memory read, memory write, data abort, prefetch abort, undefined instruction; a hit always pauses emulation |
| Memory tools | Hex dump, GUI auto-update, click-to-edit bytes, u8/u16/u32 writes, file-to-memory injection, freeze values, search/refine |
| Call stack | registerenterfunc-style call stack collection, scrollable GUI table, disassembly jump buttons |
| Automation | `window.DesmumeMCP.call()`, `postMessage`, and isolated JS injection using the same command API |

## Architecture

```mermaid
flowchart LR
  User[Browser user] --> UI[public/index.html]
  AI[AI / WebMCP client] --> MCP[DesmumeMCP command router]
  Script[Isolated JS worker] --> MCP
  UI --> MCP
  MCP --> Wasm[public/desmume.js single-file Emscripten build]
  Wasm --> Core[old/desmume DeSmuME core]
  Core --> Hooks[breakpoint, exception, call-stack hooks]
  Hooks --> Wasm
  Wasm --> UI
```

## Build

The production build runs in GitHub Actions. For a Codespace build:

```bash
bash webassembly/build.sh
```

The build emits `public/desmume.js` as a single Emscripten JavaScript file with the wasm payload embedded. Open `public/index.html` through a cross-origin-isolated server so the bundled `coi-serviceworker.js` can enable real browser threading support when available.

## Local Operation

- Upload a ROM from the browser. The ROM stays local to the browser filesystem.
- Import/export `.sav` and state files from the UI. Save imports reset the loaded ROM so the cartridge save is visible from the normal entry point. State imports load directly into the running emulator state and preserve the previous pause/running state.
- Use the canvas itself for DS touch input. The browser maps pointer coordinates back to DS coordinates after display scaling and rotation.
- Audio is disabled by default to avoid loud startup output. Enable it from the UI or `setAudio`; the volume slider is applied in the browser output path.
- Use Memory Freeze to repeatedly write one or more u8/u16/u32 values, similar to simple cheat-code freezing. This is intentionally separate from memory breakpoints so the memory viewer can still read without tripping debug-watch behavior.
- Use `window.DesmumeMCP.call(name, params)` or `postMessage` to automate emulator, debugger, memory, and input operations.
- See `webassembly/API.md` for every exposed command and its expected behavior.

## Debugger Surface

| UI Section | What to Use It For |
|---|---|
| Debugger | Select ARM9/ARM7, inspect registers, step, step over, enable heavy trace collection |
| Call Stack | Inspect recorded function entries and jump a callee address into the disassembler |
| Disassembly | Inspect PC-relative code, ARM/Thumb/auto modes, and visible execution breakpoint markers |
| Memory | Dump memory, keep the GUI auto-updated, click a byte to edit it, or inject a local binary at the selected address |
| Breakpoints | Add execution/read/write breakpoints and enable exception stops for abort/undefined-instruction cases |
| WebMCP / Script Injection | Run the same documented APIs manually, from another page, or from a sandboxed local script |

## Debugging Notes

- DS button bits are kept in the MCP-facing order `A,B,Select,Start,Right,Left,Up,Down,R,L,X,Y`, but native `NDS_setPad()` expects `right,left,down,up,select,start,B,A,Y,X,L,R`. Keep that conversion in `webassembly/wasm-port.cpp`; otherwise directions and face buttons are swapped.
- CPU `step` is instruction-level and calls `armcpu_exec<ARM9/ARM7>()`. Frame stepping remains available through `stepFrames`.
- Disassembly is backed by DeSmuME's `frontend/modules/Disassembler.cpp`; the current PC row is prefixed with `=>` and highlighted in the UI.
- Memory viewer dumps use debug reads and intentionally do not trigger memory read breakpoints. Emulated CPU reads and writes do trigger breakpoints.
- Breakpoint hits are exposed through `status().native.lastBreak` and force the emulator into pause state.
