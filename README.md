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
- Import/export `.sav` and state files from the UI.
- Use `window.DesmumeMCP.call(name, params)` or `postMessage` to automate emulator, debugger, memory, and input operations.
- See `webassembly/API.md` for every exposed command and its expected behavior.
