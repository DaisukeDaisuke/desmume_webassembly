# Browser API compatibility inventory

This inventory records the pre-refactor browser surface. Every item remains compatible unless `DESMUME_WEB_DEBUGGER_MERGED_INSTRUCTIONS.md` explicitly removes it.

## Public transports

- `window.DesmumeMCP.call`, `list`, and `shortcuts`
- `window.DesmumeShortcuts` and the case-sensitive `window.a()` through `window.Z()` mappings documented in `API.md`
- `window.postMessage` requests and `desmume-mcp-result` replies
- WebMCP tools `desmume.list`, `desmume.call`, `desmume.eval`, and `desmume.runScript`
- Worker-local `mcp.call`, `webmcp.call`, `memory.*`, and `emu.*` helpers

## Commands

`status`, `snapshotContext`, `saveAnalysisBaseline`, `restoreAnalysisBaseline`, `loadRomFile`, `loadRomBytes`, `loadRomUrl`, `importSaveFile`, `exportSaveFile`, `saveSaveSlot`, `loadSaveSlot`, `saveState`, `loadState`, `importStateFile`, `loadStateBytes`, `loadStateUrl`, `listRecentFiles`, `reloadRecentFile`, `exportStateFile`, `takeScreenshot`, `setAutoUpdate`, `pause`, `resume`, `reset`, `reloadRom`, `setSpeed`, `stepFrames`, `setRenderEnabled`, `setAudio`, `setScale`, `setRotation`, `setInput`, `runInputHold`, `runInputTap`, `runTouchHold`, `setKeyBinding`, `getRegisters`, `setRegister`, `disassemble`, `disassembleBytes`, `binaryFloat`, `dumpMemory`, `injectMemoryFile`, `injectBytes`, `searchMemory`, `resetMemorySearch`, `writeMemory`, `setMemoryFreeze`, `listMemoryFreezes`, `setBreakpoint`, `setSpecialBreakpoint`, `listBreakpoints`, `removeBreakpoint`, `clearBreakStatus`, `step`, `smartStep`, `stepOver`, `stepNextBranchOrReturn`, `trueNextBranch`, `continue`, `setStackTraceMode`, `setStackTracePrivilegeCheck`, `stackTrace`, `callStack`, `listOtherCoroutines`, `getOtherCoroutines`, `copyCallStackMarkdown`, `copyCallStackCsv`, `runUntilReturn`, `runUntilNextCall`, `wait`, `waitMs`, `nextFunctionEnter`, `nextCall`, `nextFunctionCall`, `nextBranchOrReturn`, `nextTrueBranch`, `returnToPop`, `setCTableSeed`, `memoryGetRegister`, `memorySetRegister`, `memoryReadByte`, `memoryReadWord`, `memoryReadDword`, `memoryWriteByte`, `memoryWriteWord`, `memoryWriteDword`, `runPersistentScript`, `listScripts`, `stopScript`, `restartScript`, `getScript`, `listScriptPrint`, `clearScriptPrint`, `eval`, `runScript`, `injectScript`, `batch`, and `setFeatureSet`.

Aliases `reg`, `regw`, `read8`, `read16`, `read32`, `write8`, `write16`, and `write32` remain available.

`setSaveType` is the sole explicit removal. Its native option is ineffective and must not report false success.

## UI and stored behavior

- Preserve every existing element ID in `public/index.html`, including ROM/save/state pickers, runtime toolbar, canvas and pad, debugger controls, registers, disassembly, memory/search/freeze controls, call-stack lane template, breakpoint controls, storage/recent controls, hotkeys, MCP batch fields, persistent-script tabs/template/editor/output, and log/status regions.
- Preserve keyboard capture rules and the `desmume-keymap` mapping, including `ShiftRight`.
- Preserve IndexedDB state/save slots, recent files, analysis baselines, script draft, input feedback, breakpoint highlighting, call-stack lane selection, and compact output.
- Preserve call-stack frame order and public filtering. Synthetic/control-flow/internal frames remain hidden unless the existing `raw:true` diagnostic path is explicitly requested.
- Preserve all current command parameters, defaults, return fields, and emulator pause/resume side effects documented in `API.md`.

## Refactor checkpoints

- Registry adapters must expose the same command set before legacy dispatch is removed.
- WebMCP text remains compact while `structuredContent` remains an object; results must never be JSON-stringified twice.
- Worker failures clean up only that Worker and its pending RPC resources.
- UI event handlers and WebMCP call the same command registry.
