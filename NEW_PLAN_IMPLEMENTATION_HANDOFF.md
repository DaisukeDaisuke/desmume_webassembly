# new_plan.md implementation handoff

## Scope and authority

- Implementation authority: `new_plan.md`.
- Preserve existing public APIs and the compact tuple format for `runInputSequence`.
- Do not restore deleted user changes or treat old untracked notes as current requirements.
- Do not inspect generated `public/desmume.js`, `public/branches`, or `public/emulators.json`.
- Use `apply_patch` for authored changes and use the Codespace for dependency-backed builds.

## Plan map

- `new_plan.md:34`: ordered, bounded raw-pixel sampling for `waitForScreenChange`.
- `new_plan.md:57`: atomic full validation for compact input sequences.
- `new_plan.md:92`: immediate pause detection during real-time input windows.
- `new_plan.md:112`: complete `runUntil` success results.
- `new_plan.md:130`: public operation inspection and cancellation.
- `new_plan.md:146`: common serial-based `waitForPause`.
- `new_plan.md:161`: State-load and file-transaction wait APIs.
- `new_plan.md:184`: frame-match and screen-stability waits.
- `new_plan.md:201`: separate memory-read and memory-write run-until APIs.
- `new_plan.md:237`: ARM9/ARM7 PC and CPSR baseline verification.
- `new_plan.md:264`: input-state inspection and forced release.
- `new_plan.md:274`: persistent-script State event helpers.
- `new_plan.md:284`: owner-aware breakpoint bulk removal.
- `new_plan.md:295`: State, Save, and baseline storage management.
- `new_plan.md:309`: central-mutation-layer input recording.
- `new_plan.md:376`: frame-offset input replay with optional integrated State load.
- `new_plan.md:428`: recording list/delete management.
- `new_plan.md:450`: one shared long-running-operation lock.
- `new_plan.md:470`: mandatory regression coverage.
- `new_plan.md:502`: public descriptions and API documentation.
- `new_plan.md:519`: required implementation order.
- `new_plan.md:537`: required verification commands.
- `new_plan.md:549`: final reporting requirements.
- `new_plan.md:566`: ROM-triggered emulator-runtime lazy loading and bundle splitting.

## Implementation direction

### 1. Shared pause and operation foundation

- Add a common pause event service with a monotonic serial and immutable event payloads.
- Publish manual pause from `src/commands/runtime-commands.js:53`.
- Bridge explicit persistent-script pauses from the existing callback wired at `src/app.js:267`.
- Publish native breakpoint pauses where `src/debugger-coordinator.js` updates and dispatches the native break.
- Publish native faults from `src/native-fault-handler.js`.
- Keep the existing script-pause service for compatibility while using the common service for new input waits and `waitForPause`.
- Extend `src/operation-manager.js` public metadata without exposing its AbortController or task promise.
- Add `getOperation`, `cancelOperation`, and `status.operation`; cancellation must await operation settlement and cleanup.
- Recovery commands must remain callable while an operation or file transaction is active.

### 2. Frame comparison and ordered wait foundation

- Refactor `src/frame-service.js` so current-frame comparisons and captured-pixel comparisons share the same low-level comparator.
- At every selected completed-frame notification, synchronously copy pixels to an independent `Uint32Array`.
- Drain samples through one ordered asynchronous loop.
- Bound the queue and fail with a structured resource-limit error on overflow.
- Stop subscriptions, clear queued samples, and ignore late comparison completion after success, timeout, cancellation, breakpoint, or script pause.
- Reuse this ordered drain for `waitForScreenChange`, `waitForFrameMatch`, and `waitForScreenStable`.
- Preserve the fixed A baseline for screen-change and frame-match waits; use the immediately preceding sampled frame only for screen-stability waits.

### 3. Input validation and pause-aware waits

- Replace the partial validator in `src/input-service.js` with full validation before storage or input mutation.
- Validate tuple arity, opcode fields, known non-empty button lists, integral counts/frames, finite non-negative durations, touch bounds, tap tuple fields, and the total duration cap.
- Revalidate stored sequences when loaded for execution.
- Use one pause-aware timer primitive in `runInputSequence`, `runInputHold`, `runInputTap`, and `runTouchHold`.
- Subscribe before starting each timer so breakpoint, memory breakpoint, special breakpoint, script pause, and native fault release input immediately.
- Route `src/ui/input-controller.js` touch updates through `setTouchState` so all input sources cross one mutation boundary.

### 4. Wait and debugger APIs

- Complete `runUntil` results in `src/commands/wait-commands.js` with hexadecimal PC, existing pause-kind vocabulary, and optional break type.
- Build `waitForPause`, `waitForStateLoad`, and `waitForFileTransaction` on serial event services rather than public polling.
- Implement `runUntilMemoryRead` and `runUntilMemoryWrite` as distinct public commands with operation-owned breakpoint owners.
- Count only emulated CPU accesses and keep the existing `MMU_AT_DEBUG` exclusion visible in `old/desmume/desmume/src/MMU.h:708`, `:760`, `:825`, `:906`, `:968`, and `:1027`.
- Do not add `waitForMemoryChange`.

### 5. Baseline, ownership, script, and storage APIs

- Capture ARM9/ARM7 PC and CPSR immediately after State serialization and before the first await.
- Keep restore paused until State integrity and both CPU states are verified.
- Older baselines without CPU metadata must never report `pcVerified:true`.
- Add `getInputState` and BUSY-safe `releaseInput`.
- Expose State load/save registration helpers through the existing persistent-script event bus, whose current internal dispatch points include `src/commands/state-commands.js:57` and `:97`.
- Implement `clearBreakpoints` through the owner store, defaulting to user owners only.
- Add prefix-safe IndexedDB key enumeration/deletion for State slots, Save slots, analysis baselines, and input recordings.

### 6. Input recording and replay

- Record at the central `setKey`/`setTouchState` mutation layer, not DOM handlers.
- Store full input snapshots as compact frame-offset events and preserve same-frame order.
- Stage recording events and optional State data; commit metadata only after all storage writes succeed.
- Keep State bytes in IndexedDB under a recording-specific prefix.
- Validate the entire recording, ROM identity, optional State, hashes, PC/CPSR, and event format before the first replay input mutation.
- Integrate State load inside the replay operation with an internal file-transaction token so replay does not cancel itself.
- Replay by completed-frame offsets, release all input on every exit, and pause by default after success.

### 7. Runtime lazy loading

- Keep the initial DOM, canvas, file controls, status surface, WebMCP bootstrap, and loader in `public/app.js`.
- Move emulator-only service construction and bundled runtime dependencies behind one retryable shared loader.
- Preserve the existing canvas DOM node.
- Start the runtime only for ROM load commands; status, operation recovery, and storage-list APIs must not trigger it.
- Use one runtime-load promise for concurrent ROM requests and clear that promise after a failed load so the next request retries.
- Guard post-load continuation with the file-transaction/session identity.
- Generate a distinct runtime chunk from `scripts/build-js.mjs`; do not add it as an initial HTML script.
- Keep Emscripten/WASM loading lazy and do not re-evaluate the runtime bundle for later ROM reloads.

## Files already identified as primary edit points

- `src/app.js`: service wiring, runtime creation boundary, loader integration.
- `src/operation-manager.js`: operation metadata and settlement.
- `src/commands/wait-commands.js:165`: current `runInputSequence` registration.
- `src/commands/wait-commands.js:176`: current `waitForScreenChange`.
- `src/input-service.js`: compact sequence validation and execution.
- `src/commands/input-commands.js`: standalone timed input commands.
- `src/ui/input-controller.js`: central key/touch mutation layer.
- `src/frame-service.js`: snapshot capture and shared pixel comparison.
- `src/commands/context-commands.js:41`: current file-transaction status payload.
- `src/commands/context-commands.js:44`: current State-load serial payload.
- `src/commands/state-commands.js:57`: State save script event.
- `src/commands/state-commands.js:97`: State load script event.
- `src/debugger-coordinator.js:88`: file-transaction serial protection for callbacks.
- `src/debugger-coordinator.js:211` and `:247`: callback transaction identity capture.
- `src/file-transaction-service.js`: transaction ownership and serial publication.
- `src/state-service.js:17`: current State-load serial increment.
- `src/breakpoint-owner-store.js`: owner-preserving bulk removal.
- `src/script-service.js:231`: accepted persistent-script event names.
- `src/commands/command-factory.js`: command dependency wiring.
- `src/command-dispatcher.js`: BUSY-safe recovery command policy.
- `src/api-descriptions.js`: public descriptions.
- `src/script-rpc-policy.js:16-17`: persistent-script command allowlist.
- `scripts/build-js.mjs`: UI/runtime bundle split.
- `tests/refactor-services.test.mjs:1019` and `:1048`: existing screen-wait coverage.
- `tests/boundary-regressions.test.mjs:255-256`: existing memory-break pause vocabulary coverage.
- `webassembly/wasm-port.cpp:763-776`: debug reads/writes using `MMU_AT_DEBUG`.
- `webassembly/API_CURRENT.md:148-149`: current long-running-operation documentation.
- `webassembly/API_CURRENT.md:168`: current input-sequence documentation.
- `webassembly/API_CURRENT.md:188`: current screen-wait documentation.

## Verification direction

1. Run focused first-party tests after each service group.
2. Run `npm test`, `npm run check:js`, `npm run check:dependency-bundles`, and `npm run check:licenses`.
3. Run `npm run build:js`, then run the tests again.
4. In the Codespace, run the safe-heap WASM build and pull the long build status at approximately 80-second intervals.
5. Copy generated `public/app.js`, its hash artifact if produced, the new runtime chunk, and `public/desmume.js` back to the host.
6. Stop the Codespace after artifacts are recovered.
7. Use Chrome DevTools MCP, not Browser Use, to verify initial UI without runtime loading, first ROM load, ROM reload, State/input behavior, runtime failure retry where test injection permits, and cleanup.

## Known risk and contradiction checks

- The current app already defers Emscripten script initialization through the native bridge, while `new_plan.md:566` asks to split roughly 130 KB of application code. The measurable result must distinguish already-lazy `desmume.js` from newly-lazy first-party emulator services.
- Runtime-only services currently participate in command registration at startup. The bootstrap must expose stable command descriptions without eagerly importing the runtime implementation.
- `recordInput({durationMs})` is wall-time bounded but events are frame-offset based. If the emulator produces no completed frames, duration recording can still finish with the initial and neutral snapshots; this must be documented and tested rather than guessed.
- Exact safe continuation after read/write hits depends on the existing native MMU break semantics. Read/write accesses have already completed, so exec-style step-past must not be reused.
- If browser tooling cannot inject a deterministic runtime-load failure, retry behavior will be covered by first-party integration tests and reported as browser-verification-limited rather than omitted.

## Current implementation checkpoint

- Added and wired `src/pause-event-service.js` for manual, native breakpoint, persistent-script, and native-fault pause publication.
- Extended `src/operation-manager.js` public metadata and added `getOperation`, settlement-waiting `cancelOperation`, and `status.operation`.
- Added `RECORDING_NOT_FOUND`, `RECORDING_EXISTS`, and `RESOURCE_LIMIT`.
- Refactored `src/frame-service.js` to compare captured pixel buffers and added the bounded `src/ordered-frame-drain.js`.
- Replaced `waitForScreenChange` frame dropping with ordered sampling and added `waitForFrameMatch` and `waitForScreenStable`.
- Added `waitForPause`, `waitForStateLoad`, and `waitForFileTransaction` over serial event services.
- Completed `runUntil` result fields and added separate `runUntilMemoryRead` / `runUntilMemoryWrite`.
- Added pause-aware `src/input-window.js` and applied it to compact sequences and standalone timed input commands.
- Expanded compact input sequence validation before storage or mutation.
- Routed pointer touch changes through the central input mutation layer.
- Added `getInputState`, BUSY-safe `releaseInput`, owner-aware `clearBreakpoints`, State/Save/baseline list/delete APIs, and persistent State event helpers.
- Raised analysis baseline format to version 2 and added immediate ARM9/ARM7 PC/CPSR capture and restore verification.
- Added `src/input-recording-service.js` with central mutation recording, staged metadata commit, optional associated State, frame-offset replay, list, and delete.
- Split the first-party entry into lightweight `src/app.js` and runtime `src/emulator-runtime.js`.
- `scripts/build-js.mjs` now targets exactly two minimized artifacts: `public/app.js` and `public/emulator.js`; no shared chunk is intended.
- Bootstrap WebMCP tools load `emulator.js` implicitly on first WebMCP invocation and proxy that same request to the runtime.
- Updated `src/api-descriptions.js` and the main inventory/behavior sections in `webassembly/API_CURRENT.md`.

## Known incomplete or not-yet-proven work

- No Codespace verification has run against the current edits yet. Host checks were stopped at the user's direction; the earlier host lacked `esbuild`.
- The current source has not yet passed `npm test`, `check:js`, dependency bundle checks, license checks, or the two-artifact production build in Codespace.
- `webassembly/API_COMPATIBILITY_INVENTORY.md` still needs the additive command list and lazy-runtime compatibility note.
- `system.md` and `handoff.md` still need final addenda after verification.
- Required new regression tests are incomplete. Existing tests have not yet been adapted for every new dependency and command.
- `src/input-recording-service.js` needs Codespace test review for:
  - associated-State pause/resume behavior;
  - partial IndexedDB cleanup;
  - same-frame order;
  - mutation-free ROM/State/PC mismatch failures;
  - interruption during frame stepping;
  - final neutral input semantics.
- Lazy runtime needs verification that:
  - production build emits only minimized `app.js` and `emulator.js`;
  - `app.js` keeps `./emulator.js` as an external dynamic import;
  - initial HTML does not request `emulator.js`;
  - bootstrap ROM selection does not double-dispatch after runtime UI binding;
  - duplicate WebMCP registration remains harmless;
  - failed dynamic import can actually retry in the target Chrome module map.
- Bootstrap runtime-free storage currently implements State/Save list only. `listAnalysisBaselines` and `listInputRecordings` should also avoid loading the runtime if called through `window.DesmumeMCP`.
- Runtime cleanup between different ROM sessions has not yet received a dedicated session token/late Worker-message guard beyond the existing file transaction and persistent callback serial protections.
- `status.emulatorLoadError` covers bootstrap import failure before runtime import; native Emscripten initialization failure still needs a consistent status field.
- The public command count documented as 141 must be checked against the built registry rather than trusted arithmetically.
- The API compatibility inventory and tests must confirm that no existing command or shortcut was removed during the entry move.
- Chrome DevTools MCP verification is still pending and must not be replaced with Browser Use.

## Resume-after-compaction read list

Read these files in this order after any context compression. Do not restart discovery from the whole repository.

1. `NEW_PLAN_IMPLEMENTATION_HANDOFF.md` — this checkpoint and exact remaining work.
2. `new_plan.md:450-790` — operation exclusion, required tests/docs, verification, and lazy runtime requirements.
3. `src/app.js` — lightweight bootstrap, WebMCP proxy, ROM-triggered loader.
4. `src/emulator-runtime.js:150-660` — service construction, command wiring, recording service, operation manager, and wait registration.
5. `src/input-recording-service.js` — recording/replay correctness and cleanup.
6. `src/commands/wait-commands.js` — ordered waits and memory access run-until behavior.
7. `src/commands/context-commands.js` — operation/storage/baseline APIs.
8. `src/commands/command-factory.js` — dependency wiring.
9. `scripts/build-js.mjs`, `scripts/check-js.mjs`, `scripts/watch-js.mjs` — exactly-two-artifact build policy.
10. `tests/refactor-services.test.mjs` and `tests/boundary-regressions.test.mjs` only at the relevant existing harnesses.
11. `webassembly/API_CURRENT.md` and `webassembly/API_COMPATIBILITY_INVENTORY.md` for final documentation sync.

## Immediate continuation steps

1. Add focused tests for the new services and adapt harness defaults.
2. Finish bootstrap runtime-free metadata list calls and compatibility inventory.
3. Run `gh codespace list` by itself, then sync changed source/test/build files with `gh codespace cp -e`.
4. In Codespace run dependency-backed checks and tests first; fix all failures before the WASM build.
5. Build exactly `public/app.js` and `public/emulator.js`, record their byte sizes, then rerun tests.
6. Run the safe-heap build only if the native/source validation requires regeneration, pulling status at about 80-second intervals.
7. Copy both JS artifacts and `public/desmume.js` back, stop the Codespace, then use Chrome DevTools MCP for initial-request and ROM-load verification.

## 2026-07-28 verified checkpoint

- Codespace `npm test`: 117/117 passed before and after the production JS build.
- Codespace `npm run check:js`: passed.
- Codespace `npm run check:dependency-bundles`: passed.
- Codespace `npm run check:licenses`: passed.
- Codespace `npm run build:js`: passed and emitted the intended two minimized entry artifacts:
  - `public/app.js`: 5,838 bytes.
  - `public/emulator.js`: 462,535 bytes.
- No shared chunk was emitted by the production build.
- Generated `public/app.js`, `public/emulator.js`, and the already-built Codespace `public/desmume.js` were copied back to the host.
- New permanent tests cover pause serial/kind filtering, async ordered-frame draining, explicit queue overflow, input sequence storage/mutation atomicity, and owner-preserving breakpoint bulk removal.
- Chrome DevTools MCP acceptance was not run because the user reported that the provider had not been started. Browser Use was not substituted.
- Native safe-heap recompilation was not repeated in this task because no C++/WASM source changed; the existing native `MMU_AT_DEBUG` exclusion and memory-break `size` payload were used.

## Latest continuation checkpoint — read this first after compaction

### Immediate current state

- The user reported that lazy splitting removed the pre-runtime canvas position calculation.
- The fix is implemented locally and synchronized to the running Codespace:
  - added `src/ui/screen-layout.js`;
  - `src/app.js` applies the canvas/shell CSS variables immediately from the current Scale/Rotate selects;
  - bootstrap listens for Scale/Rotate changes before runtime import;
  - bootstrap removes those temporary listeners after runtime import;
  - `src/emulator-runtime.js` initializes runtime state from the current select values;
  - `src/ui/screen-visibility.js` reuses the same layout helper after runtime import.
- Added a permanent rotated-layout regression test to `tests/new-plan-services.test.mjs`.
- A final audit also fixed manual pause versus `waitForPause`: `src/emulator-runtime.js` no longer cancels the active operation when that operation is specifically `waitForPause`; the pause event can therefore complete the wait.
- WebMCP bootstrap tools already call `ensureEmulatorLoaded()` from every tool `execute` handler. Running a tool from the WebMCP UI implicitly fetches `emulator.js`, waits for runtime publication, and proxies the same request to the runtime.
- The latest source and test were copied to Codespace `turbo-xylophone-697q7wgrwvjfpp4`, which is currently running.

### Read these files now

1. `NEW_PLAN_IMPLEMENTATION_HANDOFF.md` — especially this latest checkpoint.
2. `src/app.js` — immediate canvas layout, shared runtime loader, bootstrap WebMCP proxy.
3. `src/ui/screen-layout.js` — the shared pre/post-runtime layout calculation.
4. `src/emulator-runtime.js:35-80` — runtime state initialization from UI values.
5. `src/emulator-runtime.js:430-450` — manual-pause exception for `waitForPause`.
6. `src/ui/screen-visibility.js` — runtime reuse of the layout helper.
7. `tests/new-plan-services.test.mjs` — newest layout test plus ordered queue/input atomicity tests.
8. `scripts/build-js.mjs` — exactly two minimized production outputs.

### Remaining work only

1. Stop Codespace `turbo-xylophone-697q7wgrwvjfpp4`.
2. Do not attempt Chrome acceptance: the user explicitly reported that Chrome DevTools MCP was not started and allowed submission after tests were added.
3. Final report must call out:
   - 4 major bug groups implemented;
   - all added APIs by category;
   - record/replay and State+PC/CPSR behavior;
   - exact test/check/build results and final bundle sizes;
   - Chrome acceptance not run because the provider was not started;
   - no native rebuild because no native source changed.

### Latest verification result

- Canvas bootstrap layout and manual-pause/waitForPause fixes are synchronized.
- Codespace `npm test`: 118/118 passed before and after the final production build.
- Codespace `npm run check:js`: passed.
- Final minimized artifacts were copied to the host:
  - `public/app.js`: 6,531 bytes.
  - `public/emulator.js`: 462,685 bytes.
- No shared chunk was emitted.
