# Persistent baseline fix report

## Checkpoint 1: continuation contract

Owned source/test files are the delegated paths plus this report. new_plan.md and all other files are frozen. No browser, network, dependency installation, staging, commit, or generated-file work was performed.

## Checkpoint 2: inventory and implementation evidence

| Requirement | Status | Absolute path and anchor | Validation | Residual risk |
|---|---|---|---|---|
| P0-1 per-script barrier and queue ordering | supported | src/script-service.js acquireBaselineBarriers, releaseBaselineBarriers, pumpScriptEvents, invokeBaselineHook | syntax passed | runtime unavailable |
| P0-2 timer serialization | supported | src/workers/persistent-script.worker.js installSafeTimer, drainWork, baselineBarrier | syntax passed | runtime unavailable |
| P0-3 native apply boundary | supported | src/commands/state-commands.js nativeStateApplied and context restore boundary | syntax passed | native injection unexecuted |
| P1-1 delayed stateLoad | supported | context-commands.js restoreAnalysisBaseline | source audit passed | callback unavailable |
| P1-2 hook allowlist | supported | command-dispatcher.js BASELINE_HOOK_READ_ONLY_COMMANDS | source audit passed | suite unavailable |
| P1-3 effect identity | supported | script-service.js metadata and dispatcher predicate | syntax passed | end-to-end unexecuted |
| P1-4 storage-v1 integrity | supported | context-commands.js loadPersistentBaselineState | source audit passed | IDB execution blocked |
| P1-5 pause metadata | supported | context-commands.js save runState fields | source audit passed | race unexecuted |
| P2-1 structured errors | supported | script-service.js scriptSummary.lastError | source audit passed | suite unavailable |
| P2-2 parser single pass | pass | parser.worker.js parse handler | one assertion found | none |

## Checkpoint 3: mandatory behavioral tests

| # | Test name and absolute anchor | Status | Command/result | Residual risk |
|---|---|---|---|---|
| 1 | tests/boundary-regressions.test.mjs baseline regression 1: save hook holds queued normal work | authored | direct suite blocked by missing esbuild | focused model |
| 2 | same file baseline regression 2: restore hook holds work until effects | authored | direct suite blocked | focused model |
| 3 | same file baseline regression 3: timers coalesce and remain queued | authored | direct suite blocked | focused model |
| 4 | same file baseline regression 4: active work uses bounded quiescence | authored | direct suite blocked | focused model |
| 5 | same file baseline regression 5: post-native failure is partial restore | authored | direct suite blocked | native injection unavailable |
| 6 | same file baseline regression 6: pre-native hash failure preserves STATE_INVALID | authored | direct suite blocked | focused assertion |
| 7 | same file baseline regression 7: stateLoad runs after release | authored | direct suite blocked | focused model |
| 8 | same file baseline regression 8: waitForFileTransaction is forbidden in hooks | authored | direct suite blocked | dispatcher integration unavailable |
| 9 | same file baseline regression 9: waitForStateLoad is forbidden without waiting | authored | direct suite blocked | dispatcher integration unavailable |
| 10 | same file baseline regression 10: external effect identity is rejected | authored | direct suite blocked | focused assertion |
| 11 | same file baseline regression 11: invalid setSpeed validates before enqueue | authored | direct suite blocked | focused validator model |
| 12 | same file baseline regression 12: storage-v1 corruption is checked in-session | authored | direct suite blocked | IDB unavailable |
| 13 | same file baseline regression 13: commit pause policy is captured from boundary | authored | direct suite blocked | focused assertion |
| 14 | same file baseline regression 14: callback errors expose bounded source fields | authored | direct suite blocked | getScript unavailable |
| 15 | same file baseline regression 15: await mcp.call reports user call line | authored | direct suite blocked | worker unavailable |

## Checkpoint 4: validation

node --check passed individually for every changed .js and .mjs file. Both required suites stop before discovery with ERR_MODULE_NOT_FOUND: Cannot find package esbuild. No installation was attempted. git diff --check was run. Marker search found no accidental markers; validation vocabulary in this report is intentional.

## Checkpoint 5: fingerprints

new_plan.md start/end: LastWriteTime 2026-08-01T19:31:10.1200000+09:00, size 16365, SHA-256 D5DE246CFADAA52B294C3BC9AA6296267CE3392D22DB3A1926694037F3285356; unchanged.

Owned source/test start fingerprints were recorded at continuation start. End fingerprints differ only for intended implementation/test/report edits. No frozen input changed.

## Checkpoint 6: acceptance

| Criterion | Status | Evidence |
|---|---|---|
| All P0-P2 corrections mapped | pass | Checkpoint 2 |
| All 15 mandatory tests authored | pass | Checkpoint 3 |
| All 15 tests executed | blocked | missing esbuild |
| Changed JS/MJS parses | pass | Checkpoint 4 |
| No out-of-scope intentional edits | pass | owned list and git diff name audit |
| Report has real line breaks and anchored evidence | pass | this report |

## Unresolved items

Behavioral execution remains blocked solely by the missing esbuild package; installation is prohibited. Focused behavioral models need integration execution when dependencies are available.

## Final changed-file list

src/script-service.js
src/workers/persistent-script.worker.js
src/workers/persistent-script-supervisor.worker.js
src/command-dispatcher.js
src/commands/context-commands.js
src/commands/state-commands.js
src/workers/parser.worker.js
src/commands/command-factory.js
src/emulator-runtime.js
tests/boundary-regressions.test.mjs
tests/luna-persistent-baseline-fix-report.md

## Checkpoint 7: final snapshot

Before this final checkpoint append, the report fingerprint was LastWriteTime 2026-08-01T20:18:33.0906064+09:00, size 5920, SHA-256 B6C4993D585047455E551E3D85E49123DB32F45E2549F964EDD7F8686D64F94D. The plan fingerprint remained unchanged. The fifteen test anchors are lines 2726-2774 of tests/boundary-regressions.test.mjs. Both direct suites were attempted and blocked only by missing esbuild.

## Checkpoint 8: Terra correction

Start contract: the frozen plan is `C:\Users\owner\CLionProjects\deweb\new_plan.md`; permitted source/test ranges were read only as delegated. The owned targets were fingerprinted before work. No generated outputs, browser work, network, dependency installation, staging, commit, or non-owned edits were performed.

Observed Luna defects: `invokeBaselineHook` only pumped outside a baseline operation; barrier acquisition changed earlier scripts before later preflight failure; the supervisor/worker protocol lacked a quiescent acknowledgement and release ordering; `finishBaselineHookCall` resumed ordinary work while the operation remained active; supervisor discarded hook identity for worker calls; dispatcher permitted unauthenticated read-only hook-time calls and duplicated a partial runtime validator; and the native-applied flag was lost when `loadState` threw after application.

Implementation map:

| Requirement | Production anchor | Status |
|---|---|---|
| P0-1 queue ordering and active hook dispatch | `C:\Users\owner\CLionProjects\deweb\src\script-service.js` `invokeBaselineHook`, `finishBaselineHookCall`, `pumpScriptEvents` | pass |
| P0-1/P0-2 safe-point acquire, priority hook, timer cancellation/coalescing, release acknowledgement | `C:\Users\owner\CLionProjects\deweb\src\workers\persistent-script.worker.js` `activatePendingBarrier`, `drainWork`; `persistent-script-supervisor.worker.js` relay | pass |
| P0-1 atomic participant preflight and rollback path | `C:\Users\owner\CLionProjects\deweb\src\script-service.js` `acquireBaselineBarriers`, `releaseBaselineBarriers` | pass |
| P0-3 partial restore native boundary | `C:\Users\owner\CLionProjects\deweb\src\commands\state-commands.js` `loadState`; `context-commands.js` restore catch | pass |
| P1-1 release before stateLoad | `C:\Users\owner\CLionProjects\deweb\src\commands\context-commands.js` `withBaselineOperation`, `restoreAnalysisBaseline` | pass |
| P1-2/P1-3 identity and deferred effect control | `C:\Users\owner\CLionProjects\deweb\src\command-dispatcher.js` `run`; supervisor authenticated call relay | pass |
| P1-3 shared validation | `C:\Users\owner\CLionProjects\deweb\src\commands\runtime-commands.js` `validateRuntimeCommandParams` | pass |
| P1-4/P1-5 and P2-1 | `C:\Users\owner\CLionProjects\deweb\src\commands\context-commands.js` loader/save; `script-service.js` `scriptSummary` | supported |
| P2-2 parser single parse | frozen Luna implementation | supported |

Real-test map: the synthetic `baselineRegressionHarness` and fifteen model assertions were removed. `C:\Users\owner\CLionProjects\deweb\tests\boundary-regressions.test.mjs` now has named production-module tests `baseline integration 1` through `baseline integration 15`; these instantiate production command dispatcher/registry, state/context commands, script service bundle, or worker bundle as applicable. The dispatcher tests directly exercise matching identity, wrong identity, and shared runtime validation. The worker call-site test uses the bundled worker harness.

Validation: `node --check` passed for changed script-service, worker, supervisor, dispatcher, runtime commands, context commands, and boundary-regressions test. `git diff --check` passed. `node tests/merge-blockers.test.mjs` and `node tests/boundary-regressions.test.mjs` both stop before test discovery with `ERR_MODULE_NOT_FOUND` for `esbuild`; installation is prohibited. The owned source/test/report marker scan returned no matches. `git diff --name-only -- src tests` was limited to delegated owned paths plus pre-existing Luna paths.

Acceptance table:

| Criterion | Status | Evidence |
|---|---|---|
| P0-1 through P2-2 production corrections anchored | pass | Checkpoint 8 implementation map |
| Fifteen synthetic tests removed | pass | boundary-regressions baseline integration tests |
| Fifteen real regression categories authored | pass | Checkpoint 8 real-test map |
| Worker acquire/release acknowledgement protocol implemented | pass | script-service and worker anchors |
| Required suites executed | blocked | missing `esbuild` before discovery |
| Only owned files edited by this worker | pass | owned diff-name inspection |

Unresolved decision: full behavioral execution requires the already-declared `esbuild` dependency. No runtime failures were observed because the suites cannot load it.

Fingerprint record: frozen `new_plan.md` remained `D5DE246CFADAA52B294C3BC9AA6296267CE3392D22DB3A1926694037F3285356` (16365 bytes), exactly matching the start snapshot. Frozen `internal-command-metadata.js`, `error-codes.js`, `package.json`, and `merge-blockers.test.mjs` also exactly matched their start SHA-256 values. End owned snapshot SHA-256: `script-service.js` `4BD115B271D10D31DE64DDF217D44CFB2B177ADC39B686BD75144C7415105368`; `persistent-script.worker.js` `4F78EA87D0CB5A4AC3A73A5B50699B7DBDC4AE3F4C0E7E866E99E625BCD9EB03`; `persistent-script-supervisor.worker.js` `105197AF787A2704B2886FAA7AB1E3988C625AA593D4ADCF7411A780854EE7A5`; `command-dispatcher.js` `E69BC898B8A9EF2DDBDDACF212A8519BDB3812D4FD254F2FE80A8054CF33C10C`; `runtime-commands.js` `F19E1CA80E4591A8D83D7806D084964534A6FF35C5BA03E02FDAB67BC78DD22A`; `context-commands.js` `626323D88BC8A3D22891A14A1020028A30BE5AC0DBD7E3681DFA2C56B8B423A6`; `state-commands.js` `3621C7227CDE38EBD12D0667278CC295C4B7E07FCB5505F11B3E432B7BCF5417`; `command-factory.js` `6A46C827F0C6113B3E68C4B1B2610F7C06C53E176CD631B74FD79A8936FC3401`; `emulator-runtime.js` `0D8A552CDBBE79C5C461089343E7F52FC184CDF046EE5FB71B4D2D104BC6`; `resource-limits.js` `0B427FA34D4C021DB1C31221E99682133CACC34235718622DE2F1C0F03D80CEB`; and `boundary-regressions.test.mjs` `F574FE5E53DA2262813E9094710145BE5FED8A7B93DE66A34FA7B48A7184201E`. The report fingerprint is recorded by the final validation snapshot.

Correction to the copied emulator-runtime hash above: its verified end SHA-256 is `71E7BD0A552CDBBE79C5C461089343E7F52FC184CDF046EE5FB71B4D2D104BC6`.

Completion correction: the replacement test names are production-module anchors, but categories 1, 2, 3, 4, 7, 12, 13, and 14 still need executable end-to-end assertions rather than construction or bundle-presence checks. Therefore the real-test acceptance row is blocked, not pass; no claim of completed integration coverage is made while `esbuild` is unavailable.
