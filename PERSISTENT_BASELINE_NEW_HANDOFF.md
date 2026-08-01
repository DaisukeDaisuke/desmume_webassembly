# Persistent baseline correction — new-chat handoff

## Objective

Finish the corrections in `new_plan.md` for atomic persistent-script baseline save/restore, add real regression coverage for all 15 mandatory cases, run dependency-backed tests/build in the Codespace, then delegate Chrome DevTools MCP acceptance to a subagent. Do not use Browser Use.

## Instructions already established

- The project `AGENTS.md` content was injected into the prior chat. In a new chat, follow the injected/current `AGENTS.md` instructions.
- Edit human-authored files with `apply_patch` only.
- Preserve unrelated user changes. In particular, do not restore deleted `.codex` files or touch the unrelated untracked directories listed by `git status`.
- Do not inspect generated `public/desmume.js`, `public/emulators.json`, or `public/branches`.
- Do not install dependencies on the Windows host. Codespace installation/build/test is allowed under the project rules.
- If Chrome testing is required, the main Sol must delegate it to the configured Chrome DevTools MCP subagent. The Chrome agent must not run `gh` commands. DevTools cannot be used concurrently by multiple agents.

## Agent findings and current worktree

The user first requested a `luna_worker` editing agent. `C:\Users\owner\.codex\agents\luna-worker.toml` was read; it uses `gpt-5.6-luna` with `model_reasoning_effort = "medium"`. Luna availability was confirmed separately.

Luna made a first implementation pass, then a follow-up pass. The main Sol rejected the result because the barrier could deadlock and the 15 added tests were synthetic models rather than production-path tests.

A bounded Terra worker then corrected much of the implementation. Its final status was `blocked`, not complete. Its detailed report is:

- `C:\Users\owner\CLionProjects\deweb\tests\luna-persistent-baseline-fix-report.md`

Current intended source/test changes are in:

- `src/command-dispatcher.js`
- `src/commands/command-factory.js`
- `src/commands/context-commands.js`
- `src/commands/runtime-commands.js`
- `src/commands/state-commands.js`
- `src/emulator-runtime.js`
- `src/script-service.js`
- `src/workers/parser.worker.js`
- `src/workers/persistent-script-supervisor.worker.js`
- `src/workers/persistent-script.worker.js`
- `tests/boundary-regressions.test.mjs`

The report is a temporary audit artifact. Remove it with `apply_patch` before final delivery if its evidence is no longer needed. Keep final product changes limited to `src` and tests unless the user authorizes otherwise.

## Implementation state

Terra added or improved:

- Per-script barrier acquire/release acknowledgements between main thread, supervisor Worker, and sandbox Worker.
- Preflight and rollback paths for multi-script barrier acquisition.
- Baseline-hook priority over queued ordinary work.
- Timer wrapping, interval coalescing, queued timer cancellation, and worker safe-point acknowledgement.
- Suppression of ordinary queue pumping while the barrier remains active.
- Internal baseline-hook identity propagation.
- Dispatcher checks for authenticated hook reads/effects and `BUSY` for external calls.
- Shared runtime setting validation for speed/audio/scale/rotation/render commands.
- Storage-version-1 IndexedDB-only loading and manifest-only in-memory baseline behavior.
- Pause/run metadata from the actual `pauseForFileLoad()` boundary.
- State-load partial-restore classification and delayed `stateLoad` dispatch.
- Bounded `lastError` in script summaries.
- Removal of the duplicate parser assertion.

Do not accept these claims without inspecting the current diff and running tests. The prior main Sol reviewed the broad diff but did not finish a final correctness audit after Terra's last patch.

## Known unresolved test gaps

Terra removed Luna's purely synthetic `baselineRegressionHarness` but still left eight tests as existence/bundle-presence checks instead of executable behavioral assertions. In `tests/boundary-regressions.test.mjs`, replace the weak `baseline integration` tests for categories:

1. Save hook holds queued ordinary work until hooks, native State, JSON, and manifest commit finish.
2. Restore holds queued work until all hooks and deferred effects finish.
3. Real worker timeout/interval callbacks remain behind the barrier, intervals coalesce, and clearing a queued timer prevents execution.
4. Active normal event/MCP/timer follows the explicit bounded quiescence/BUSY rule; partial multi-script acquisition rolls back.
7. `stateLoad` fires exactly once after file transaction, baseline operation, and all barrier releases, and its callback can issue a normal command.
12. Storage version 1 detects same-session IndexedDB missing/size/hash corruption rather than using inline data.
13. Save metadata uses the actual commit-time pause boundary, including an explicit pause during commit wait.
14. Real `getScript`/script summary exposes bounded callback, persistent MCP, save-hook, and restore-hook error locations and clears stale error data on restart.

Tests 5, 6, 8, 9, 10, 11, and 15 were converted to more meaningful production-module/worker tests, but must still be executed and reviewed. Verify all 15 cases from `new_plan.md`; do not rely only on test names.

## Potential source issues to scrutinize

- Inspect `requestBaselineBarrierAck`, `acquireBaselineBarriers`, and `releaseBaselineBarriers` for races when one participant rejects while other acquire acknowledgements are pending. Ensure active-request promises/timers do not leak or get overwritten incorrectly by rollback release requests.
- Verify worker `pendingBarrier` activation and hook priority when a timer/event was already queued before the barrier request.
- Verify release acknowledgement occurs before `stateLoad` can be delivered.
- Verify every failure after barrier acquisition pauses the emulator before releasing barriers. Validation failures before native State application must retain their original code.
- Verify `context-commands.js` derives `nativeStateApplied: true` from a thrown state-command partial-restore error and reports exact `restoredScripts`/`remainingScripts`.
- Verify authenticated baseline hook read-only calls remain allowed, matching restore-hook effects are validated/deferred, matching save-hook effects and wait commands return `COMMAND_NOT_ALLOWED`, and external/wrong-identity calls return `BUSY` without entering `deferredEffects`.
- Verify `validateRuntimeCommandParams` preserves the exact existing normal-command defaults, especially `setAudio` volume behavior and render/audio boolean coercion.

## Validation already performed

- Luna and Terra reported `node --check` passing for their changed JS/MJS files.
- `git diff --check -- src tests` passed in the prior chat.
- Windows-host execution of both suites stopped before discovery because `esbuild` was unavailable. No dependency installation was attempted.

These checks are not enough. Run the dependency-backed suites in Codespace after syncing the current `src` and `tests` trees.

## Codespace state and next commands

The last successful list showed:

- Codespace: `turbo-xylophone-697q7wgrwvjfpp4`
- Repository: `DaisukeDaisuke/desmume_webassembly`
- State: `Shutdown`

The prior chat attempted:

```text
gh codespace ssh -c turbo-xylophone-697q7wgrwvjfpp4 "echo started"
```

The host policy rejected it even with escalation. The user stated this was a permission mistake and has now corrected it. A new chat should retry after first running `gh codespace list` as a standalone command. Do not run `gh codespace cp` before a successful SSH start.

After start, follow the project rule to transfer directories rather than individual files. Use `gh codespace cp -r ... -e`, with no more than three concurrent copy sessions. Sync at least the current `src` and `tests` trees to `/workspaces/desmume_webassembly/`.

For long Codespace work, launch it in the background, write output to a `.log` file and exit code to a `.exit` file, check only `.exit` about every 70 seconds, and read `.log` only after completion. Do not stream long compiler/test output into chat.

Run explicit first-party tests only. At minimum execute the repository's test command that includes:

- `tests/boundary-regressions.test.mjs`
- `tests/merge-blockers.test.mjs`

After tests pass, run the required JS checks/build. If a source/WASM build is required by the final change set, follow the project build policy. This task currently changes browser JS only, so first determine the explicit package scripts rather than assuming a WASM rebuild.

If Codespace is started, always stop it at the end with:

```text
gh codespace stop -c turbo-xylophone-697q7wgrwvjfpp4
```

The project notes say a prolonged `ShuttingDown` display can be ignored after the stop command.

## Chrome DevTools MCP acceptance

Only after source tests/build pass and local generated browser assets are synchronized as required:

1. Freeze the tested source/build artifacts.
2. Spawn one Chrome DevTools MCP agent using `fork_turns = "none"` with a self-contained test specification and exact starting commit/range.
3. The Chrome agent must not use `gh` commands and must not use Browser Use.
4. Test the baseline behavior through the real page/API, including save/restore ordering, timer/event suppression, `stateLoad` post-release command availability, and structured error retrieval. Do not expose ROM/Save/State contents.
5. DevTools is single-use: do not start a second Chrome agent concurrently.

## Worktree safety

Pre-existing unrelated status entries observed in the prior chat included deleted `.codex/agents/*.toml`, deleted `.codex/config.toml`, and untracked `old/coi-serviceworker/`, `old/interface-design/`, `pixelmatch/`, and `ssim/`. These are user changes. Do not restore, clean, stage, inspect broadly, or include them in this task.

## Recommended continuation order

1. Read this handoff, `new_plan.md`, the full current Terra/Luna report, and the current `git diff -- src tests`.
2. Replace the eight weak tests with production-path behavioral assertions using existing harnesses in `tests/boundary-regressions.test.mjs`.
3. Audit and patch any source defects exposed by those tests.
4. Retry Codespace SSH, sync directory trees, run dependency-backed tests/checks/build with `.log`/`.exit` polling.
5. Review the final diff and mandatory-test mapping.
6. Delegate one Chrome DevTools MCP acceptance agent.
7. Remove the temporary report if appropriate, stop the Codespace, and deliver the final changed-file/test summary.

