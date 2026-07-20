# Debugger refactor live handoff

Updated: 2026-07-20 (first 3,000 lines reread after completed-item pruning; implementation remains active)

## LATEST RECOVERY CHECKPOINT — read this before all older sections

- **大まかな静的移植は完了した。** `src/app.js`から具体実装を分離し、native境界は`src/native-bridge.js`、dispatchは`src/command-dispatcher.js`と`src/command-registry.js`、debugger調停は`src/debugger-coordinator.js`と`src/debugger-service.js`、scriptは`src/script-service.js`、`src/script-runner.js`、`src/script-pause-service.js`、Worker lifecycleは`src/worker-host.js`、loopは`src/emulation-loop.js`、frameは`src/frame-service.js`、`src/frame-comparator.js`、`src/algorithm-loader.js`、`src/frame-diff/`、inputは`src/input-service.js`と`src/ui/input-controller.js`、UIは`src/ui/ui-controller.js`、`src/ui/view-service.js`、`src/ui/screen-visibility.js`、file/ROM/Save/Stateは`src/file-io-service.js`、`src/rom-service.js`、`src/save-service.js`、`src/state-service.js`へ移した。
- commandの静的分離先は`src/commands/command-factory.js`、`context-commands.js`、`rom-commands.js`、`save-commands.js`、`state-commands.js`、`recent-file-commands.js`、`screenshot-commands.js`、`runtime-commands.js`、`input-commands.js`、`script-commands.js`、`wait-commands.js`、`memory-commands.js`、`disassembly-commands.js`、`debugger-control-commands.js`、`utility-commands.js`、`feature-commands.js`である。旧`src/commands/legacy-commands.js`は改名・解消済みで、復活させない。
- build基盤も`package.json`、`scripts/build-js.mjs`、`scripts/check-js.mjs`、`scripts/watch-js.mjs`、`scripts/check-licenses.mjs`、`scripts/build-third-party-notices.mjs`へ移植済み。文書は`readme.md`、`webassembly/API.md`、`webassembly/API_COMPATIBILITY_INVENTORY.md`、`THIRD_PARTY_NOTICES.md`を更新済み。静的移植後の未完はChrome DevTools MCPによる実ROM/Save/State受け入れと、正しい公開先`https://daisukedaisuke.github.io/desmume_webassembly/`でのPages/COI/CDN実環境確認である。
- `src/commands/legacy-commands.js` no longer exists. Every concrete handler was split by responsibility, and the remaining composition-only layer is `src/commands/command-factory.js`. ROM, Save, State, recent-file, screenshot, runtime, input, script, wait, memory, disassembly/register, debugger control/call-stack, context/baseline, utility, and feature commands each have dedicated modules. Do not recreate the legacy monolith.
- `src/app.js` remains orchestration-only at roughly 543 lines and has no local function declarations. Its command-factory dependency object now uses consistent four-space indentation. `applyScaleRotation`の受け渡し漏れも修正済み。
- command分離を同期したCodespace buildは15/15テスト、`check:js`、`build:js`に成功し182.0 KBだった。その後のscript/Worker変更を同期したbuildも16/16テスト、`check:js`、`build:js`が完了し185.5 KBを出力した。後者のSSH wrapperは全完了ログ出力後にexit 124になっただけで、build自体は完了している。
- 明示的script pauseは実装済み。Workerがcallback中のevent IDをRPCへ添付し、main threadはpauseを通常のoperation cancelと区別して`script-pause-service.js`へpublishする。`waitForBreak`、`runUntil`、`waitForScreenChange`は自動resumeせず`SCRIPT_PAUSED`と`scriptId`を返す。script-only read/writeはstepせずresume、execだけ現在命令をstepする既存方針を維持する。
- persistent Workerはstart handshakeを待ってから成功を返す。source/compile/runtime/start/crash/protocol/timeoutを分類し、失敗したWorker、trigger、Blob URLだけをcleanupする。`script-service.js`の未定義`mcpResponder`参照も`responder`へ修正した。
- external algorithm Workerはready handshake、startup/execution timeout、crash/protocol分類、必ずdispose/revokeする経路を持つ。`AbortSignal`をWorker messageへ誤ってstructured-cloneしていた問題を修正し、clone可能なargsだけを転送する。
- hostの最新回帰テストは16/16成功。Chrome DevTools MCPはユーザーの週間リミットが少ないため来週、`https://daisukedaisuke.github.io/desmume_webassembly/`またはローカルpreviewで実施する。別エミュレーターとの比較は残作業に含めない。
- 最新のalgorithm Worker、indent、input listener cleanupまでCodespaceへ同期済み。16/16テスト、`check:js`、production `build:js`が成功し、最終bundleは186.4 KB。生成`public/app.js`もローカルへ回収済み。次の担当者はCodespace同期/buildを繰り返さず、merged instructionの残存項目をChrome依存項目と明確に分け、来週Chrome DevTools MCP受け入れから再開する。Codespaceはこのcheckpoint後に停止するため、必要時のSSHで再起動する。
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` へ停止要求を送ったがGitHub APIがHTTP 504、直後の状態確認もHTTP 503だった。停止処理が受理されたか確認不能。プロジェクト規則どおりGitHub側の一時障害として提出を妨げない。次回もし稼働中なら、作業後に`gh codespace stop -c upgraded-xylophone-697q7wgrq5535xpr`を再実行する。

以下は長期履歴であり、`legacy-commands.js`が残る、appが1,053/801/626行、テストが15件、Worker handshakeが未実装、などの記述はこのLATEST節により上書きされる。

## Immediate checkpoint at the user's 44% context warning

This is an implementation checkpoint, not a submission point. Continue from the exact state below.

### Current specification interpretation

1. `src/app.js` is allowed to orchestrate only: DOM readiness, construction/wiring, native initialization, WebMCP registration, UI binding, loop start, and top-level error display. A smaller file that still implements file loading, debugger synchronization, binary parsing, touch geometry, status rendering, or command handlers is still incomplete.
2. The enforced dependency direction is entry -> boundary/controller -> command registry/handlers -> services -> `native-bridge.js`. No source outside `native-bridge.js` may directly call `state.fns`, read WASM heaps, or use Emscripten FS.
3. The current 1,000-line `commands/legacy-commands.js` is explicitly temporary. It must be split by responsibility (`system/runtime`, `file`, `memory`, `debugger`, `script`; wait/frame/input already have partial dedicated paths). Passing a huge context object is not the final design.
4. State load has two separate display facts: API pixels are invalid until a real completed native frame increments the frame counter, while the last valid UI canvas remains visible. Invalid native pixels must not overwrite it. Short UI recovery text is allowed; internal serial/owner/Worker chatter is not. Debugger-domain information remains the explicit exception and must stay visible.
5. Script-only exec breakpoints step past the pre-instruction trap. Script-only read/write hooks resume without a step because the MMU access has completed; stepping would duplicate the access. This is not accepted until browser tests cover exec/read/write and explicit script pause produces `SCRIPT_PAUSED` without autoresume.
6. External `ssim-trim` remains optional and isolated. Fixed URL/version/hash/license source are established, but CORS/COEP, integrity mismatch, offline/CDN failure, Worker startup/protocol/crash cleanup, and built-in fallback behavior are still required browser acceptance gates.
7. A merged-instruction item is removed only after it is 100% complete at the level relevant to that item. Static migration items already proven by source/build were pruned; behavioral items remain until browser acceptance.

### Completed and verified at this checkpoint

- Reread the pruned merged instruction lines 1-3,000 in six separate 500-line reads after the first combined output truncated. The remaining 3,001+ portion had been read earlier, but should be reread again before final acceptance work.
- Added `src/native-bridge.js`. It now owns the entire `cwrap` table, lazy `desmume.js`/module initialization, ready and ROM checks, native number/text/JSON fault normalization, Emscripten FS, heap access, ROM loading, State buffers/files, Save export, framebuffer/audio views, frame execution, pause, status/register/trace/step/disassembly/call-stack/breakpoint/memory helpers.
- Removed every direct `state.fns`, `state.module.FS`, and `state.module.HEAP*` reference outside `src/native-bridge.js`. This was verified with a scoped `rg` search returning no matches.
- Migrated `src/emulation-loop.js`, `src/ui/view-service.js`, `src/debugger-service.js`, the entry helper block, and `src/commands/legacy-commands.js` to the bridge. The bridge does not import UI; initialization and fault UI effects are supplied by callbacks.
- The current `src/app.js` is 1,053 lines before the binary-helper duplicate deletion described below, down from the original 3,627 lines. It is still not entry-only.
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` was restarted, current `src/` and tests were copied with `gh codespace cp -e`, and `npm test`, `npm run check:js`, and `npm run build:js` all passed. Unit tests are 15/15 and the current production bundle is 172.6 KB.
- Host syntax checks and the same 15 tests pass. Host bundle commands fail only because host `node_modules` is absent; per rules no host install was attempted. Codespace is the valid bundle environment.
- Earlier native frame-counter change already passed `webassembly/build_safe_heap.sh` in 503.3 seconds and the native artifact was copied locally. No native source has changed since, so another safe-heap build is not currently warranted.

### Latest completed extraction after this checkpoint was requested

- `src/binary-tools.js` is fully connected and all old app-local duplicates are removed. It owns number/address parsing, base64/hex byte parsing, opcode word parsing, endian reads, binary32/64 splitting, byte swaps, and big-endian values.
- Added `src/file-io-service.js` for browser download, file-input reading, and picker handling.
- Added `src/rom-service.js` for ROM validation/write/reload and lifecycle state reset; added `src/save-service.js` for Save virtual-file selection and ROM reload; added `src/state-service.js` for State byte loading, post-load screen invalidation, file-load pause/restore, and failure-stop behavior. Services receive callbacks rather than importing UI.
- Removed the unused app-local `restorePendingSaveBoot` and `reloadSelectedRom` functions after confirming no source references existed.
- `src/app.js` is now 801 lines. Syntax checks and 15/15 host tests pass, and a scoped search still finds no direct native/FS/heap access outside `native-bridge.js`. The combined verification command exits 1 only because that final search correctly has no matches.

### Exact next edit

- Move `updateStatus`, scale/touch geometry, typing/key release, and browser input rendering helpers into UI services without changing DOM IDs or creating elements.
- Move `getNativeStatus`, current-breakpoint suspension, break event publication, register reads, and persistent-script break completion out of the entry into debugger/breakpoint coordination. Explicit script pause still needs a structured notification path.
- Then split `commands/legacy-commands.js`; this is now the largest remaining architecture debt.

## Recovery checkpoint at the user's 33% context warning

Resume from this exact filesystem state; do not repeat completed extraction work.

### Current measured state

- `src/app.js` is 626 lines after the latest successful debugger-coordinator extraction. It passed a strict `node --check` after fixing an accidental leading `/` before the first import, and the unit suite remains 15/15.
- `src/app.js` has no direct `state.fns`, Emscripten FS, or WASM heap access. All such access remains centralized in `src/native-bridge.js`.
- `src/ui/screen-visibility.js` now owns scale/rotation CSS variables and short status/screenshot-validity rendering.
- `src/ui/input-controller.js` now owns key state/rendering, release-all, typing-target detection, touch coordinate rotation/scaling, touch state, and touch-triggered frame input.
- `disasmRefreshParams` and `setFollowPc` moved into `src/ui/view-service.js`.
- `src/debugger-coordinator.js` now owns break-kind mapping, native status, current exec-site suspension, breakpoint event publication/classification, script trigger dispatch, register snapshots, and script-only exec versus read/write continuation. It uses a lazy callback for `queueBreakpointRefresh`, avoiding an import cycle with `debugger-service.js`.
- The view service receives a lazy register callback because the coordinator needs `log`/`hex` from the view service. Do not replace this with mutual imports.

### Exact partially applied runtime-helper extraction

- `src/runtime-tools.js` was successfully added. It defines `sleep`, `waitChecked`, `bootWaitMs`, and `blockSaveFlush` with four-space indentation.
- `src/native-fault-handler.js` was successfully added. It defines the native-fault state transition and receives `native`, `log`, `updateStatus`, and `blockSaveFlush` as dependencies.
- `instructionOpcode` was successfully moved inside `src/debugger-service.js`, and removed from that factory's parameter list.
- The following attempted combined patch to `src/app.js` failed verification atomically and made **no app changes**: importing/constructing the two new runtime modules and removing the old app-local runtime functions. Therefore `src/app.js` still owns `waitChecked`, `sleep`, `bootWaitMs`, `blockSaveFlush`, `handleNativeFault`, and `instructionOpcode`, and still passes `instructionOpcode` into `createDebuggerService`. Integrate these with small patches next; after integration remove the now-obsolete `instructionOpcode` context property.

### Immediate recovery commands and checks

1. Inspect only the first imports/state construction, the view-service destructuring area, and the app-local helper lines reported by `rg -n "waitChecked|sleep|bootWaitMs|blockSaveFlush|handleNativeFault|instructionOpcode" src/app.js`.
2. Add imports for `createRuntimeTools` and `createNativeFaultHandler`; construct runtime tools immediately after state creation, and construct the fault handler after `viewService` exposes `log` and after `screenVisibility` exposes `updateStatus`.
3. Remove each old helper with separate small `apply_patch` operations. Remove `instructionOpcode` from the debugger-service context object in app.
4. Run strict syntax checks that stop immediately on failure, then 15 tests. Do not use a trailing successful `rg` that can hide an earlier syntax failure.
5. Continue with command dispatcher extraction and command-module splitting. Codespace build currently reflects the earlier 1,053-line bridge checkpoint, not the newer 626-line source; resync after the runtime integration and another bounded split.

### Work completed after the 33% recovery checkpoint

- Integrated `runtime-tools.js` and `native-fault-handler.js` with small patches. Removed the duplicate app-local timing/fault helpers and the obsolete `instructionOpcode` dependency; strict syntax checks and 15/15 tests pass.
- Added `src/command-dispatcher.js`. It owns BUSY gating, emulator-activity result decoration, post-command status update, and debounced debugger UI refresh. `src/app.js` now supplies only a lazy `runCommand` closure for dependency wiring.
- Removed all local function declarations from `src/app.js`. It is currently 543 lines and consists of imports, service construction, explicit dependency wiring, command registration, WebMCP registration, and UI binding. Its remaining size is mostly the temporary large legacy-command context, not concrete handlers.
- Added and physically populated `src/commands/script-commands.js` for persistent-script lifecycle commands, eval/run/inject, script output, and batch.
- Added and physically populated `src/commands/input-commands.js` for direct input, hold/tap/touch hold, and key binding. Existing long sequence commands remain in `commands/wait-commands.js` plus `input-service.js`.
- `src/commands/legacy-commands.js` still owns file/state/runtime, debugger, memory, stack/call-stack, and compatibility helper commands. Continue splitting those actual method bodies; do not merely re-export a monolith.
- The next Codespace sync/build must include all current `src/` because the remote bundle still reflects the older bridge-only checkpoint.

### Immediate continuation order

1. Finish the bounded binary-tools extraction by deleting the exact duplicate blocks and verify syntax/tests.
2. Extract ROM lifecycle into `rom-service.js`, Save virtual-file/reload flow into `save-service.js`, and State invalidation/import/buffer flow into `state-service.js`. Keep operation cancellation and UI restoration hooks explicit; do not let services import UI.
3. Extract common browser file picker/download helpers separately, and move status/touch geometry/scale rendering to UI modules. Move break-status synchronization and register helpers into breakpoint/debugger services.
4. Split `legacy-commands.js` by command responsibility and give each group only its required services. Preserve aliases and `apiDescriptions`; do not change compact output.
5. Add `scripts/watch-js.mjs` and `watch:js`, then resync and rerun Codespace unit/check/bundle. Copy the generated `public/app.js` back only after the next stable source checkpoint.
6. Refine normal errors and Worker startup handshake/explicit script pause, then run Chrome DevTools MCP against the local preview or `https://daisukedaisuke.github.io/desmume_webassembly/` with the supplied local ROM/Save/State, without uploading game data elsewhere.
7. Only after browser acceptance: prune newly completed merged-instruction items, update durable `handoff.md`, `readme.md`, and final AGENTS architecture/build notes, copy artifacts, stop the Codespace, and submit.

## Current checkpoint: external algorithm integration and entry-point reduction

The implementation is active; do not submit or stop here. The current reasoning and intended order are:

The first 3,000 lines of the pruned merged instruction were reread in six non-truncated 500-line chunks. The reread changes the next implementation checkpoint as follows:

- `src/app.js` is complete only when it contains the eight entry responsibilities in section 9: DOM readiness, module/service/native initialization, WebMCP/UI registration, loop start, and top-level error display. A smaller entry that still owns native/file/debugger helpers is not acceptable.
- The dependency direction is command handler -> service -> native bridge. `src/commands/legacy-commands.js` remains a temporary migration layer because it is monolithic and directly accesses `state.fns`; shrinking the entry alone does not satisfy sections 8, 10, 15, 16, 29, 30, 33, 37, and 53.
- Native exports, `cwrap`, native JSON/text/result parsing, typed-array views, and fault normalization must be centralized in `native-bridge.js`. ROM, Save, and State loads must then use shared services so UI, WebMCP, recent reload, and baseline restore cannot diverge.
- The later screen-validity rules override the stale Phase-C wording about hiding the canvas: after State load the API frame is invalid, invalid native pixels must not overwrite the canvas, and the last valid canvas stays visible. Only the relevant capture controls become unavailable with short next-action text.
- Script-only callback continuation is incomplete until explicit script pause produces `SCRIPT_PAUSED` without automatic resume. Read/write continuation must never re-execute the access instruction.
- External algorithms and Worker isolation are not complete merely because their files exist; CORS/COEP/integrity failure, startup handshake, crash/protocol cleanup, and browser behavior remain acceptance gates.

1. Preserve behavior first, but satisfy the strict architecture rule that `src/app.js` becomes orchestration-only. The large legacy command object, wait commands, UI bindings, WebMCP boundary, Worker sources, Worker host, frame comparison, input sequence logic, and emulation loop have now been moved out. `src/app.js` is substantially smaller than the original but still contains native/file/debugger/script helper implementations, so the split is not complete.
2. Correct operation semantics before browser testing. Public pause/reset/ROM/Save/State mutations cancel with canonical reasons; `_operation:true` internal controls bypass self-cancellation; other mutating commands return `BUSY`; timeout/cancel releases input and pauses. `waitForScreenChange` keeps A fixed, cleans listeners once, and exposes timeout `maxPct`. These paths are implemented but still need browser integration tests, especially race behavior around a current exec breakpoint and script explicit pause.
3. Keep API frame validity separate from the last displayed canvas. Post-State invalid buffers are not drawn; screenshot/capture/compare/wait fail normally; the existing screenshot control is disabled with only a short next-action hint. Useful debugger-domain data remains visible and must not be removed under the “UI is not a specification” rule.
4. Finish optional `ssim-trim` without touching the cloned `ssim/` tree. The exact npm asset `ssim.js@3.5.0/dist/ssim.web.js` was fetched in the Codespace and verified as SHA-256 `238ab90f2dd1c6dfe9ab532d5e9da9b541545760fb970fb621398ae84daaacfe`; npm metadata and its MIT license identify Oscar Bartra Carreras. `external-algorithms.js`, `algorithm-loader.js`, an embedded algorithm Worker, and `frame-comparator.js` are authored, and notices are updated. They have not yet been bundled or run in Chrome. Next: finish API metadata text, syntax/build tests, then exercise CDN/COEP/integrity failure and confirm built-in algorithms remain available offline.
5. Continue physical source separation after the external comparator is green: introduce the native bridge and remove direct `state.fns` access from command modules, then move file/state/script/debugger helpers out of `app.js`. Avoid another all-at-once extraction; use bounded responsibility blocks and syntax/bundle checks after each.
6. Only after implementation boundaries and correctness are complete: sync explicit paths to Codespace, run the expanded unit suite and production bundle, copy `public/app.js`; run safe-heap again only if native C++ changes further. Then run Chrome MCP regression against the local preview or `https://daisukedaisuke.github.io/desmume_webassembly/` with the local ROM/Save/State, update durable docs, and stop the Codespace.

User requested that fully completed work be removed from `DESMUME_WEB_DEBUGGER_MERGED_INSTRUCTIONS.md`. Static, already verified migration items were removed from the Phase checklist: API/inventory scaffolding, responder/registry/WebMCP files and routing, source/entry/esbuild migration, embedded Worker source migration, core manager/store/service file creation, fixed external metadata, and `setSaveType` removal. Behavioral requirements remain until their relevant browser acceptance is complete. Continue pruning only after implementation, tests, and applicable browser/build acceptance are all 100% proven.

Latest verification facts:

- A real `src/native-bridge.js` now owns the complete `cwrap` table, lazy script/module initialization, ready/ROM checks, native result/text/JSON fault normalization, frame/audio views, run-frame calls, core breakpoint/step/status/register/call-stack access, and memory writes. `emulation-loop.js`, `ui/view-service.js`, and `debugger-service.js` no longer access `state.fns` directly. `src/app.js` is now 1,053 lines. Remaining direct native access is confined to the entry's file/runtime helper block and the temporary monolithic `commands/legacy-commands.js`; those are the next service/command split targets.
- After this bridge extraction, `node --check` passed for every touched module and the host unit suite remains 15/15. The final `rg` verification returned exit 1 only because it found no `state.fns` references in the three migrated modules.
- Host `npm run check:js`/`build:js` could not run because host `node_modules` is intentionally absent and host installs are forbidden. No software was installed. Bundle verification must use the already-running Codespace after the next bounded extraction/sync.
- Before the newest external-algorithm/emulation-loop edits, Codespace ran the original 3 tests, `check:js`, and `build:js`; the bundle completed at 156.2 KB. The outer SSH command hit its 10-second wrapper timeout only after the bundle completion log was printed.
- The delegated test-only agent added `tests/refactor-services.test.mjs`. Locally it reports 15/15 tests passing, covering operation timeout/cancel cleanup, all five built-in frame algorithms, snapshot copy/replace, input sequence replacement/release/abort, Worker syntax, and Worker text-loader naming. The primary agent still needs to inspect and rerun it in Codespace after syncing.
- The latest external-algorithm, emulation-loop, notice, and operation changes have not yet gone through the full syntax/test/bundle pass. This is the immediate verification task.
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` is currently running because it was used for JS bundle and fixed CDN asset verification. Stop it only after the overall task finishes, not at this checkpoint.

## Objective

Implement `DESMUME_WEB_DEBUGGER_MERGED_INSTRUCTIONS.md` and the script-only read/write breakpoint fix in `DESMUME_WEB_DEBUGGER_BUGS.md`, while preserving every existing API/UI behavior except the explicitly removed `setSaveType` command.

## Completed

- Read the injected project rules, `system.md`, and `handoff.md`.
- Read both requested instruction files in full.
- Confirmed the user-owned instruction files are modified/untracked and must not be rewritten.
- Established the required phase order: API/inventory first, incremental source/bundle migration, shared operation/breakpoint/frame/input services, then build and browser verification.
- Read the required interface-design skill. UI changes will preserve the existing dense debugger workbench, DOM IDs, layout, and controls; screen validity uses existing status/control states rather than a new panel.
- Inventoried the current browser surface: roughly 100 commands plus eight aliases, all one-letter shortcuts, four WebMCP tools, Worker helpers, and all existing UI IDs.
- Updated `webassembly/API.md` before implementation with normal error contracts, long-running operations, breakpoint wait/run semantics, input sequences, State screen validity, frame snapshots/comparison, fixed-baseline screen waits, Worker isolation, and external algorithm policy.
- Added `webassembly/API_COMPATIBILITY_INVENTORY.md`. `setSaveType` is recorded as the sole explicit removal.
- Moved the existing 3,627-line application source from generated `public/app.js` to `src/app.js` using an `apply_patch` move; the body was not reconstructed or replaced.
- Added modular error codes, MCP responder, command registry, operation manager, breakpoint owner store/service, frame service, input sequence service, and first-party `px`/`hist`/`blk`/`edge` frame algorithms.
- Wired the legacy commands through the registry and added `waitForBreak`, both `runUntil` forms, input-sequence storage/execution, frame snapshots/comparison, and fixed-baseline `waitForScreenChange`.
- Removed `setSaveType` from the command implementation.
- Fixed script-only read/write trigger continuation: MMU access hooks finish the current instruction after recording the break, so callback completion resumes directly; exec triggers alone step past the pre-instruction trap.
- Changed native frame counting so a debugger-interrupted `NDS_exec` is not reported as a completed frame.
- Reformatted newly added state/service code into stable multiline indentation after user advice; `node --check` passes for the entry and new core modules.
- Added fixed `package.json` dependencies (`esbuild 0.25.6`, `terser 5.43.1`), build/check/license/notice scripts, `package-lock.json`, unit tests, `.gitignore` generated-output rules, cache-busted `index.html`, notices, and a workflow that bundles only the application and minifies only `desmume.js`.
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` was started. Emscripten 3.1.6 was installed in the Codespace. `npm ci`, 3 initial unit tests, esbuild syntax/bundle checks, license check, and notice generation passed. The current production application bundle is 143.6 KB.
- After initializing `old/desmume`, `webassembly/build_safe_heap.sh` completed successfully in 503.3 seconds. Only pre-existing compiler warnings were emitted. Latest `public/desmume.js` was copied back locally.
- Latest modular `src/` was retransferred after the native build; `npm test`, `check:js`, and `build:js` passed again, and latest generated `public/app.js` was copied back locally.
- Extracted application state, API descriptions, shortcut definitions/installation, responder, registry, operation manager, breakpoint services, frame services/algorithms, and input sequence logic into separate modules. `src/app.js` is still 3,637 lines because the legacy command object, UI bindings, and both Worker bodies remain there.
- User correctly flagged that the remaining `src/app.js` size is not acceptable under the specification. Do not present the current state as a completed source split.

## In progress

- Physically extract the legacy command object, UI bindings, and Worker bodies. The command object is the largest remaining block.
- Two generated command-object extraction attempts failed. The first failed atomically due an invalid hunk. The second used truncated `Get-Content` tool output, produced an empty module plus erroneous declarations, and was immediately fully reverted with `apply_patch`. `node --check src/app.js` passes again. Do not extract large source from tool output subject to truncation. Use line-bounded reads below the output limit, or manual small responsibility chunks.
- After extraction, re-transfer changed `src/`, `package.json`, and `package-lock.json` to the Codespace before rebuilding the JS bundle.
- The two governing files were reread from the first line on user request. The architecture requirement is stricter than merely shrinking the file: final `src/app.js` must retain only initialization/orchestration and no concrete command handlers. Required boundaries still missing include `native-bridge.js`, `webmcp.js`, command modules, UI controller, script service, and emulation loop.
- `src/frame-diff/index.js` has now been rewritten into stable multiline indentation. `px-window` has an independent window-density implementation, and `blk`/`edge` now perform luminance conversion, optional box blur, tile grid downsampling, top-tile trimming, and abort checks. This change still needs unit and browser verification.
- Reread exposed that the earlier shortcut extraction was incomplete: `src/shortcuts.js` was empty while the real definitions remained in `src/app.js`. The complete case-sensitive `a`–`Z` definitions and positional/default mapping are now physically in `src/shortcuts.js`, and the duplicate app block is removed.
- Persistent and eval Worker bodies are now physically stored in `src/workers/persistent-script.worker.js` and `src/workers/eval.worker.js`, imported as UTF-8 strings by esbuild. `src/worker-host.js` owns Blob URL creation, one-time terminate, and revoke. Persistent lifecycle now uses that host, and eval execution moved to `src/script-runner.js` with normal source/compile/runtime/start/crash/protocol/timeout results. Worker-local one-letter shortcuts are installed from the same public mapping.
- Syntax checks pass for the entry, both Worker sources, Worker host, script runner, and rewritten frame algorithms. The production bundle still needs to be rebuilt after these changes.
- The 995-line legacy command object and its compatibility aliases are now physically in `src/commands/legacy-commands.js` behind an explicit dependency context; `src/app.js` no longer contains the concrete legacy command methods. A previously malformed `searchMemory` indentation block was corrected during the move. Syntax checks pass.
- The full UI listener/storage/periodic-save initialization block is now in `src/ui/ui-controller.js`, and WebMCP/global transport registration is in `src/webmcp.js`. Expected WebMCP parsing failures now return structured `INVALID_ARGUMENT` content instead of a bare JSON error string. The main entry fell from 3,637 lines to roughly 2,300 lines, but still contains too many runtime/debugger helper implementations and is not yet entry-point-only.
- Long wait/frame/input commands moved to `src/commands/wait-commands.js`. Breakpoint waiting now uses the service predicate subscription, `runUntil` retains hit progress for timeout details, and fixed-baseline screen wait has one-time listener cleanup, abort propagation, user-breakpoint details, sampled-frame accounting, and timeout `maxPct` through the operation manager.
- External pause/reset/ROM/Save/State mutations now cancel an active operation with canonical reasons, internal `_operation:true` pause/resume does not cancel itself, other mutating commands return `BUSY`, page unload cancels, and timeout/cancel cleanup is centralized. This requires integration tests before being considered complete.
- Screen drawing now refuses to copy an invalid framebuffer, screenshot returns `SCREEN_INVALID`, and the existing screenshot control is disabled without adding DOM while a post-State frame is invalid. The last valid canvas remains visible.

## Next actions

1. Extract eval and persistent Worker bodies first into `src/workers/*.worker.js`, import them through the esbuild text loader, and store/revoke every Blob URL. Normalize source/compile/runtime/start/crash/protocol/timeout failures without rejecting expected failures.
2. Split commands by smaller, bounded groups rather than extracting the complete object from truncated tool output. Prefer one group per patch (`file`, `runtime/input`, `memory`, `debugger`, `script`) with explicit context factories. Preserve the original object until each group is registered and tested, then remove only that exact small block.
3. Add the missing native bridge and route command/service native calls through it incrementally; do not change stack/call-stack semantics while moving wrappers.
4. Extract WebMCP registration, UI event registration, and the requestAnimationFrame loop into `webmcp.js`, `ui/ui-controller.js`, and `emulation-loop.js`. Keep every DOM ID and behavior unchanged.
5. Fix operation edge cases before browser testing: timeout AbortError must remain `TIMEOUT`; external pause/state/ROM/reset must cancel active operations, while `_operation:true` internal pause/resume must not cancel their own operation; `waitForScreenChange` timeout details must retain `maxPct`; clean listeners exactly once.
6. Add the fixed-version optional algorithm manifest/loader/Worker only after version, URL, SHA-256, and license metadata are verified; failure must disable only that algorithm.
7. Add the missing local watch build and re-run unit tests with coverage for operation timeout/cancel/cleanup, owner mixed-site behavior, snapshot protection, all four first-party frame algorithms, fixed A baseline, stable frames, sequence replace/release, and Worker source embedding.
8. Transfer final source changes with explicit `gh codespace cp -e` destinations, run `npm ci && npm test && npm run check:js && npm run build:js`. The native frame-counter change already passed safe-heap build; rebuild native only if its source changes again.
9. Copy generated `public/app.js` and `public/desmume.js` back locally, start the approved PHP server, and use Chrome DevTools MCP. Test ROM-not-loaded normal errors, no-breakpoint wait, timeout recovery, script-only exec/read/write, mixed owner, State screen invalidation, frame capture/compare/fixed baseline, input cleanup, Worker syntax/runtime/timeout, stack/call-stack preservation, and existing UI controls.
10. Use `https://daisukedaisuke.github.io/desmume_webassembly/` as the public deployment acceptance target. Do not send ROM/save/state contents anywhere.
11. Update this handoff after each extraction/test phase, update `handoff.md` Addendum plus readme/AGENTS architecture and build instructions, copy artifacts, stop the Codespace, and only then prepare final results.

## Constraints and preservation notes

- Do not search `pixelmatch/`, `ssim/`, `old/coi-serviceworker/`, `old/interface-design/` except the explicitly required UI skill file, or other cloned third-party sources.
- Do not read/search `public/branches`, `public/emulators.json`, or generated `public/desmume.js`.
- Do not modify call-stack/stack-trace C++ behavior.
- Do not install software on the Windows host.
- All authored file changes use `apply_patch`; generated bundles are produced by their build tool.
- Existing dirty/untracked files belong to the user and must remain intact.
- Per user advice, the UI is not a specification or internal-runtime status report. Do not add operation idle/active chatter, internal serials, owner-map implementation details, Worker lifecycle, or similar developer diagnostics; use existing status/control states only for a short expected outcome and next action. **Debugger-domain information is explicitly exempt and must not be removed or hidden on this basis:** registers, disassembly, current PC/break reason, breakpoint/watchpoint data, memory/search/freeze data, stack trace, call stack/lanes, script output, and other information needed to inspect the emulated program remain first-class UI functionality. Detailed implementation state belongs in API/developer documentation, but useful debugger output stays in the debugger UI.

## Verification status

- Implementation: active and incomplete; core services/new commands exist, but entry-point-only architecture and several required policies are not finished.
- JavaScript tests/build: initial 3 unit tests, syntax checks, license check, notices, and production bundle passed before the latest frame-algorithm rewrite; rerun required.
- WASM safe-heap build: passed in 503.3 seconds after submodule initialization; latest artifact was copied locally.
- Chrome MCP regression: not run.
- Battle Emulator comparison: not run.

## Known risks requiring correction

- `src/app.js` remains too large and does not yet meet the source-responsibility completion criteria.
- Persistent/eval Worker source is no longer inline and Blob URLs use a shared revoking host. Persistent startup handshake/error reporting and per-script failure semantics still need browser verification and refinement.
- `waitForScreenChange` currently tracks `maxPct` locally but the operation-manager-generated timeout result does not include it.
- Cancellation is not yet wired into every ROM/Save/State/reset/pause mutation.
- Breakpoint owner resync after native clear/reload and special-breakpoint logical ownership still need review.
- The rewritten frame algorithms now contain the required first-party preprocessing, but algorithm acceptance tests have not yet verified their scoring behavior.
- Optional external algorithm loading, SHA-256 verification, and dedicated algorithm Worker are not implemented. Do not enable a CDN library until metadata/integrity/license are fixed.
- UI invalid-screen capture controls are not yet disabled; only the existing status text and API validity path are wired.
- `readme.md`, final `AGENTS.md` architecture/build updates, and durable `handoff.md` Addendum remain pending.
- `scripts/watch-js.mjs` and its package script are required by the reread specification and remain missing.
- The initial multi-file Codespace copy accidentally left harmless extra root files and `scripts/scripts/` in the disposable Codespace. Correct paths were subsequently copied. Do not reproduce this; use explicit destination paths.

## Long-running command monitoring

- Per user advice, poll long-running tool cells once every 60 seconds, not every 10 seconds.
- After 10 polls (about 10 minutes) without completion, run a separate read-only status check to distinguish a slow task from a stuck or disconnected one.

## Next-agent reading map before context compaction

Read in this order. These ranges refer to the files as they exist at this checkpoint; use the headings if later patches shift them.

### This handoff

1. Read `DEBUGGER_REFACTOR_WORK_HANDOFF.md` lines 1-92 first. They are the freshest specification interpretation, completed work, recovery state, and immediate continuation order.
2. Read lines 183-218 for preservation rules, verification status, remaining risk categories, and 60-second monitoring rules. Several detailed risk bullets there are historical and may be superseded by lines 1-92; prefer the newer statement when they conflict.
3. Lines 93-182 are historical phase history. Consult them only to understand why an earlier decision was made; do not revert newer extractions because an old bullet says they are still missing.

### Merged instruction: mandatory focused ranges

- Lines 80-150: editing order, compatibility inventory, incremental-migration rules, and build constraints.
- Lines 336-477: required module boundaries, the eight allowed `src/app.js` responsibilities, dependency direction, and global-state restrictions. This is the governing architecture for the next split.
- Lines 516-878: normal error contract, Worker error classification, native bridge, registry, WebMCP, and compact-output preservation.
- Lines 886-1058: operation lock, timeout, cleanup, and cancellation semantics.
- Lines 1059-1298: breakpoint owner/event classification, script-only behavior, the read/write no-double-execution requirement, and script service responsibilities.
- Lines 1299-1439: State load invalidation, real completed-frame condition, last-valid-canvas preservation, and frame/emulation-loop boundaries.
- Lines 1441-1769: `waitForBreak`, `runUntil`, input sequences, and input-service semantics.
- Lines 1772-2159: raw frame capture, snapshots, comparison regions, and built-in/SSIM algorithm definitions.
- Lines 2160-2425: `compareFrame`, fixed-A `waitForScreenChange`, timeout `maxPct`, breakpoint interaction, and debug result rules.
- Lines 2427-2683: UI controller language, debugger-display exception from the user, API/build/watch/bundle requirements.
- Lines 2946-3039: remaining Phase checklist. Completed static bullets were already removed; treat every remaining bullet as outstanding until proven.
- Lines 3042-3497: unit, algorithm, operation, and Chrome DevTools MCP acceptance tests.
- Lines 3498 to EOF: final completion conditions. Nothing may be deleted from the instruction merely because it was authored; applicable acceptance must pass.

Also read `DESMUME_WEB_DEBUGGER_BUGS.md` around the script-only exec/read/write bug before changing `debugger-coordinator.js`. Do not search cloned third-party trees or generated `public/desmume.js`.

### Source reading map

- `src/app.js` lines 1-543: read all; it is now pure construction/wiring with no local function declarations. The largest block is the temporary legacy-command dependency context at lines 338-464. Shrink it only by physically splitting handlers and passing smaller contexts.
- `src/commands/legacy-commands.js` lines 1-905: remaining physical debt. Current groups are approximately file/State lines 104-408, runtime/view lines 409-526, debugger/memory lines 544-875, and feature/aliases at the end. Script and input bodies have already moved to dedicated modules; do not move them back.
- `src/native-bridge.js` lines 1-466: sole owner of `cwrap`, `state.fns`, Emscripten FS, and WASM heap access. Extend explicit domain methods here rather than reintroducing raw native calls elsewhere.
- `src/debugger-coordinator.js` lines 1-191 and `src/debugger-service.js` lines 1-602: read both before breakpoint/step changes. The coordinator owns event/owner/script continuation; the service owns debugger operations/views. Preserve the lazy callback that avoids their construction cycle.
- `src/script-service.js` lines 1-237 and `src/commands/wait-commands.js` lines 1-223: read before implementing explicit script-pause notification, Worker handshake cleanup, or wait races.
- `src/operation-manager.js` lines 1-81, `src/frame-service.js` lines 1-86, and `src/input-service.js` lines 1-114: small enough to read in full before changing their semantics.
- `src/mcp-responder.js` lines 1-34: must be expanded/refined; predictable legacy exceptions are not yet all normalized and its indentation still needs cleanup.
- `webassembly/API.md` lines 1-281: reread before changing public behavior. API/implementation mismatch means incomplete work.

### Exact continuation after compaction

1. Finish the in-flight `gh codespace cp -r .\src ... -e` transfer, polling its yielded cell once per 60 seconds. Then run Codespace `npm test`, `npm run check:js`, and `npm run build:js`.
2. Split file/ROM/Save/State command handlers out of `legacy-commands.js` first, using the already-created services. Next split runtime/system, then memory, then debugger commands. Run strict syntax checks and 15 tests after each bounded group.
3. Add `scripts/watch-js.mjs` plus `watch:js`; test it without leaving a watcher running.
4. Implement structured explicit-script-pause propagation and finish Worker startup/compile/runtime/crash/protocol cleanup semantics.
5. Resync/build, copy generated `public/app.js` locally, start the approved visible PHP/Chrome DevTools path, and execute the acceptance matrix with local ROM/Save/State. Use `https://daisukedaisuke.github.io/desmume_webassembly/` for public deployment acceptance.
6. Update this handoff after every group; only prune a merged-instruction item after 100% proof. Stop the Codespace only when the entire task is actually complete.

Update after writing the map: the first transfer timed out ambiguously, so the same safe explicit transfer was repeated and completed. Codespace then passed 15/15 tests, `check:js`, and `build:js`; the current bundle is 176.1 KB. Step 1 above is complete. The generated remote `public/app.js` has not yet been copied back because command splitting is still active.

### Last pre-compaction edit state

- The Codespace build completion is confirmed: current synced source at that checkpoint passed 15/15 tests, `npm run check:js`, and `npm run build:js`; esbuild produced `public/app.js` at 176.1 KB in 76 ms.
- After that successful build, `src/commands/runtime-commands.js` was added and populated with auto-update, pause/resume, reset/reload ROM, speed, frame stepping, render/audio, scale, and rotation handlers. `legacy-commands.js` now imports and spreads this factory instead of containing those bodies.
- Context compaction warning arrived immediately after the runtime-command replacement patch. A strict local `node --check` for `runtime-commands.js`, `legacy-commands.js`, and `app.js` now passes, followed by 15/15 tests. This newest extraction is still not in the 176.1 KB remote bundle. After compaction, continue with file/State command splitting, then resync the accumulated command groups.

### Final update before requested compaction

- Current `src/`, `scripts/watch-js.mjs`, and `package.json` were transferred to the Codespace. Codespace passed 15/15 tests, `check:js`, and production `build:js`; the bundle is now 176.8 KB. This build includes the runtime/script/input command extractions.
- `npm run watch:js` was exercised in the Codespace. It printed `Watching src/**/*.js` and `[watch] build finished, watching for changes...`; `timeout 3s` then stopped it with the expected status 124. Because watch writes a development bundle, `npm run build:js` was run again afterward and successfully restored the 176.8 KB production bundle.
- `readme.md` was updated with the current source/service/native-bridge architecture, generated `public/app.js` rule, embedded Worker rule, independent `coi-serviceworker.js`, pinned npm test/check/build/notices commands, watch behavior and production rebuild requirement, local PHP server URL, Codespace native/safe-heap commands, artifact copy rule, and Codespace stop rule.
- The remote production `public/app.js` still has not been copied locally after this build because more command splitting is authorized and active. Copy it before browser testing/submission.
- Immediate next implementation remains physical extraction of file/ROM/Save/State handlers from `legacy-commands.js`, followed by memory and debugger groups. Update the source line map after those moves because `legacy-commands.js` line numbers will shift.

Additional latest local work: `runtime-commands.js` was strict-syntax checked and the suite remains 15/15. `mcp-responder.js` was reformatted to stable four-space indentation and now classifies predictable WASM-not-ready, ROM-not-loaded, State-not-found/empty, breakpoint-not-found, timeout, unknown-command, native-fault, and common invalid-argument failures into normal codes while preserving compact/structured output. Its syntax check and 15/15 tests pass. These responder changes are newer than the 176.8 KB Codespace bundle and need inclusion in the next sync.

### 次の担当者が最初に行うこと

最優先は `src/commands/legacy-commands.js` の責務別分離を完了すること。テストやブラウザ受け入れ確認へ移る前に、残っている State、recent-file/screenshot、memory、debugger の具体的なコマンド本体を小さな専用モジュールへ順番に移す。すでに分離済みの ROM、Save、runtime、script、input、wait コマンドを戻さない。各グループごとに四スペースインデントを維持し、構文チェックと既存 15 テストを実行してから次のグループへ進む。直前に追加した `src/commands/save-commands.js` はまだ未検証なので、最初に同ファイル、`legacy-commands.js`、`app.js` の厳格な構文チェックとテストを行い、その後 State 分離を開始する。

Checkpoint update: Save 分離の構文チェックと15/15テストは成功した。続いて `src/commands/state-commands.js` を追加し、`saveState`、`loadState`、`importStateFile`、`loadStateBytes`、`loadStateUrl`、`exportStateFile` を `legacy-commands.js` から物理的に移した。予約された分析ベースラインスロット、ロード前後の停止状態、失敗時停止、Stateロード後のフレーム無効化、イベント通知は維持している。State 分離後も3ファイルの構文チェックと15/15テストが成功した。次の担当者は引き続き `src/commands/legacy-commands.js` を分離し、次は recent-file/screenshot、その後 memory、debugger の順に進める。これら最新の Save/State/responder 変更は176.8 KBのCodespaceビルドより新しく、まだ同期・バンドルされていない。

Checkpoint update: recent-file と screenshot の分離も完了した。`src/commands/recent-file-commands.js` は recent Save/State の一覧・再ロードだけを、`src/commands/screenshot-commands.js` は画面妥当性、cooldown、PNG出力だけを所有する。構文チェックと15/15テストは成功した。runtime 分離時に `applyScaleRotation` が `app.js` から legacy factory へ渡されず、legacy 側でも分割代入されていなかったため、ブラウザ起動時に参照エラーになる受け渡し漏れも修正した。次の作業は引き続き `src/commands/legacy-commands.js` の memory 群、その後 debugger 群の物理分離である。

Checkpoint update: `src/commands/memory-commands.js` を追加し、dump/inject/search/reset/write/freeze、CTable seed、u8/u16/u32互換read/writeを `legacy-commands.js` から物理的に移した。新ファイルは四スペースインデントで、memory viewer用debug dump、refine用snapshot、inject後の表示更新、big-endian互換値を維持する。構文チェックと15/15テストは成功した。次の担当者の最優先は変わらず `src/commands/legacy-commands.js` の分離であり、次は register/disassembly/breakpoint/step/call-stack の debugger 群を専用モジュールへ移す。

### Legacy command split completed

`src/commands/legacy-commands.js` の分離は完了した。register/disassembly と互換register APIは `disassembly-commands.js`、breakpoint/step/stack/call-stack/trace runは `debugger-control-commands.js`、status/snapshot/analysis baselineは `context-commands.js`、binary floatは `utility-commands.js`、feature toggleは `feature-commands.js` へ移した。元ファイルには具体ハンドラがゼロになったため、合成責務を表す `src/commands/command-factory.js` へ改名し、`app.js` も `createCommands` を使用する。全新規ファイル、factory、appの構文チェックと15/15テストは成功した。古い行番号付きreading mapと過去の「legacyを次に分離する」という記述は履歴であり、この節が優先される。

次の担当者が最初に行うことは、今回の command 分離一式を Codespace へ同期し、`npm test`、`npm run check:js`、`npm run build:js` を実行してbundle時の未解決参照を検出すること。その後、明示的なscript pauseの構造化伝播とWorker startup/compile/runtime/crash/protocol cleanupを実装し、Chrome受け入れ確認へ進む。remoteの176.8 KB bundleはこのcommand分離より古い。

Checkpoint update: command分離一式をCodespaceへ同期し、15/15テスト、`npm run check:js`、production `npm run build:js` がすべて成功した。生成bundleは182.0 KB。bundle時の未解決参照はない。ユーザーの週間リミットが10%のため、Chrome DevTools MCP受け入れテストは来週でよく、現時点ではコード面の完成を優先する。次は明示的script pauseの構造化伝播とWorker cleanupを実装する。公開受け入れ対象は`https://daisukedaisuke.github.io/desmume_webassembly/`である。
