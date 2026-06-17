# desmume_webassembly

DeSmuME WebAssembly debugger with a local-only browser UI and WebMCP-style AI control surface.

## Build

The production build runs in GitHub Actions. For a Codespace build:

```bash
bash webassembly/build.sh
```

The build emits `public/desmume.js` as a single Emscripten JavaScript file with the wasm payload embedded. Open `public/index.html` through a cross-origin-isolated server so the bundled `coi-serviceworker.js` can enable real browser threading support when available.

## Local Operation

- Upload a ROM from the browser. The ROM stays local to the browser filesystem.
- Import/export `.sav` and state files from the UI. Save and state imports reset the loaded ROM before applying the imported data because DeSmuME does not support every device buffer being swapped dynamically while the emulated machine is running.
- Use the canvas itself for DS touch input. The browser maps pointer coordinates back to DS coordinates after display scaling and rotation.
- Audio is disabled by default to avoid loud startup output. Enable it from the UI or `setAudio`; the volume slider is applied in the browser output path.
- Use Memory Freeze to repeatedly write one or more u8/u16/u32 values, similar to simple cheat-code freezing. This is intentionally separate from memory breakpoints so the memory viewer can still read without tripping debug-watch behavior.
- Use `window.DesmumeMCP.call(name, params)` or `postMessage` to automate emulator, debugger, memory, and input operations.
- See `webassembly/API.md` for every exposed command and its expected behavior.

## Debugging Notes

- DS button bits are kept in the MCP-facing order `A,B,Select,Start,Right,Left,Up,Down,R,L,X,Y`, but native `NDS_setPad()` expects `right,left,down,up,select,start,B,A,Y,X,L,R`. Keep that conversion in `webassembly/wasm-port.cpp`; otherwise directions and face buttons are swapped.
- CPU `step` is instruction-level and calls `armcpu_exec<ARM9/ARM7>()`. Frame stepping remains available through `stepFrames`.
- Disassembly is backed by DeSmuME's `frontend/modules/Disassembler.cpp`; the current PC row is prefixed with `=>` and highlighted in the UI.
