# Debugger logic-fix live handoff

Updated: 2026-07-22

## Checkpoint 1 — intake and safety boundary

- User scope: read `DEBUGGER_REFACTOR_WORK_HANDOFF.md` and all of `releaseblocker.md` in 500-line chunks, fix every listed logical bug (not only P0), add tests, and record progress here incrementally rather than reconstructing it at the end.
- `DEBUGGER_REFACTOR_WORK_HANDOFF.md` has 319 lines. `releaseblocker.md` has 2,025 lines and therefore requires five chunks: 1–500, 501–1000, 1001–1500, 1501–2000, and 2001–2025.
- Pre-existing working-tree changes are present in `src/app.js` and `src/commands/command-factory.js`; preserve them and inspect before overlapping edits. Existing untracked directories are unrelated and must not be modified.
- The first combined read was output-truncated, so each requested chunk is being reread individually before implementation.
- User clarification received during intake: never include external libraries in searches. Restrict code searches to first-party paths such as `src/`, `test/`/`tests/`, and directly relevant project scripts; exclude `old/`, generated artifacts, vendored dependencies, `pixelmatch/`, `ssim/`, and `node_modules/`.

## Checkpoint 2 — documents read and baseline audit

- Completed the requested reads: all 319 lines of the refactor handoff and `releaseblocker.md` chunks 1–500, 501–1000, 1001–1500, 1501–2000, and 2001–2025. Also reread the 147-line durable `handoff.md` required for emulator work.
- Current first-party source confirms several blockers remain live: special breakpoints bypass owner management; pending script events only hold an aggregate count; eval Worker lacks a ready handshake; Worker RPC lacks a strict allowlist; `waitForScreenChange` still uses an async Promise executor; pre-aborted signals are missed in several paths; touch handlers call `native.runFrame()` directly; memory/input validation and predictable failure shapes remain incomplete.
- Existing user edits add `frameService` wiring in `src/app.js` and `src/commands/command-factory.js`. Preserve and build on them.
- An initial generic `node --test` command auto-discovered a test beneath the untracked external `pixelmatch/` tree and failed only because that external fixture lacks `pngjs`; this was an overly broad test invocation, not a project failure. Do not use it again. All 26 first-party tests that ran passed; all future local test runs must explicitly target `tests/*.test.mjs`.

## Checkpoint 3 — 50% context handoff (resume here; do not reread the review documents)

The complete review intake is already done. Do **not** reread `releaseblocker.md`, `DEBUGGER_REFACTOR_WORK_HANDOFF.md`, or `handoff.md` merely to reconstruct this task unless a later context-compaction instruction explicitly requires rereading this live handoff. The actionable state is below.

### User constraints and preserved work

- Fix all live logical bugs across P0, P1, P2, and the five newer findings; P0-only work is not accepted. Add real service/command tests.
- Never search external libraries. Restrict searches and test discovery to `src/`, `tests/`, and directly relevant first-party scripts. In particular, exclude `pixelmatch/`, `ssim/`, `old/` (except the one UI skill already read), `node_modules/`, and generated `public/` artifacts.
- Existing user edits in `src/app.js` and `src/commands/command-factory.js` add `frameService` wiring. They are intentional and must be preserved.
- Every authored write uses `apply_patch`. Continue appending this file after each bounded fix/test group.
- The project UI skill was read because behavior in `src/ui/input-controller.js` and `src/ui/ui-controller.js` must change. No visual redesign is needed: preserve the dense debugger UI, existing DOM, labels, and styles. Input controller should only mutate input state; background work should use the command boundary.

### Completed edits in this task

1. Added `src/validation.js` with:
   - `codedError(code, message, details)` for predictable typed failures.
   - `isPlainObject(value)` accepting ordinary and null-prototype objects only.
   - `positiveInteger(value, name, maximum)`.
   - `memorySize(value, name)` restricted to 1/2/4.
   - `subscribeAbort(signal, onAbort)` which subscribes and immediately observes an already-aborted signal.
2. Patched `src/command-dispatcher.js` to normalize `undefined` params to `{}` and reject `null`, arrays, primitives, `Date`, and other non-plain objects with `INVALID_ARGUMENT` before reserved-field inspection. This fixes the direct `DesmumeMCP.call(name, null)` crash.
3. Patched `src/breakpoint-owner-store.js` transaction ordering:
   - first-owner native callback now runs before the logical site/ID commit, so a thrown native registration cannot leave a ghost owner;
   - last-owner native callback now runs before logical deletion, so a thrown native removal preserves the logical owner.
   - Tests for both failure directions still need to be added.

### Confirmed live defects and exact locations

- `src/debugger-service.js`, `runDebuggerInstruction()` around the native `step`/`stepOver` block: normal `step` still calls `native.step()` without `withCurrentExecBreakpointSuspended()`. Wrap the step path so `waitForBreak`, `runUntil`, normal step, and script-only exec all use the same safe mechanism. Read/write hooks must never step.
- `src/debugger-coordinator.js`:
  - `state.pendingScriptEvents` entries still contain only `{remaining, pauseSerial, cpu, type, address}`.
  - `dispatchScriptTriggers()` sends no main-generated callback token and does not catch synchronous `worker.postMessage()` errors.
  - `finishPersistentScriptEvent(eventId)` trusts only event ID and cannot settle callbacks on stop/crash/restart.
  - Add callback-token maps keyed by event, validate event/script/callback/token, ignore/reject duplicates, expose cleanup-by-script, and auto-resume only after the final callback settles.
- `src/script-service.js`:
  - special triggers call public-style `setSpecialBreakpoint()` with no owner metadata; unregistering one may disable another owner.
  - stop/failure does not settle pending callbacks for that script.
  - startup posts `start` immediately; no `ready` phase. `worker.onerror` always reports `WORKER_CRASHED`, even before ready.
  - Worker RPC accepts arbitrary command strings and weak message shapes. Add an explicit first-party allowlist, plain-object/reserved-field validation, duplicate request-ID tracking, safe `postMessage` handling, and cleanup integration.
- `src/workers/eval.worker.js` and `src/workers/persistent-script.worker.js`:
  - bare lexical shadows do not block `globalThis.fetch`, `self.fetch`, sub-Worker APIs, etc.
  - emit `ready` at bootstrap; disable network/process-generation globals explicitly; reject dynamic-import source before evaluation.
  - persistent startup must compile, send `compiled`, then send `started` before awaiting the user program so a long top-level await is not a startup timeout.
  - persistent `eventDone` must echo callback token, callback ID, script/event identity supplied by main.
- `src/script-runner.js`: waits only for overall timeout and posts `run` immediately. Implement separate ready/startup and execution phases; classify ready failure as `WORKER_START_FAILED`, later crash as `WORKER_CRASHED`, malformed protocol as `WORKER_PROTOCOL_ERROR`; dispose exactly once.
- `src/commands/debugger-control-commands.js`, `setSpecialBreakpoint()`:
  - directly toggles native and returns malformed `{ok: ret === 0}`.
  - Implement special sites in the existing `breakpointOwners` store (recommended site shape `{cpu:"special", type:canonicalKind, address:0}`), using user/script/operation owner metadata. First owner enables native; last owner disables native. UI toggle reflects user owner only. Script trigger registration should retain its returned owner ID and remove only that ID.
  - `src/app.js` owner-store callbacks around lines ~109–118 currently always call normal `nativeBridge.setBreakpoint`; branch on special-site CPU/type and call `setSpecialBreakpoint` for special sites.
- `src/commands/wait-commands.js`:
  - `raceScriptPause()` misses pre-abort after listener registration.
  - `runUntil` uses `Math.max` for `hits`, allowing NaN; validate finite safe positive values.
  - `waitForScreenChange()` around line ~188 still uses `new Promise(async ...)`; resume/pause results are unchecked, compare exceptions leak, `comparing` can stay true, and cleanup can run incorrectly. Rewrite with a non-async Promise constructor plus an outer async task, one-time cleanup, `try/finally` around comparison, immediate abort observation, and explicit result checks.
- `src/input-service.js`, local `wait()`: add immediate pre-abort handling via `subscribeAbort`.
- `src/algorithm-loader.js`: checks cache before abort, misses immediate abort after subscription, and converts cancellation into `ALGORITHM_UNAVAILABLE`. Abort first; preserve `CANCELLED`; leave integrity/download classifications distinct.
- `src/frame-comparator.js`: validate external Worker `done.result` as a plain object, finite `pct` in 0–100, and plain-object debug data; malformed data must immediately return `WORKER_PROTOCOL_ERROR`.
- `src/frame-diff/common.js` and `src/workers/algorithm.worker.js`: main validation is close but must explicitly reject non-array region/ignoreRects and wrong rectangle arity. Worker copy lacks integer and ignore-rectangle validation. Keep both defensive checks consistent.
- `src/frame-service.js`, `comparePixels()` catch: currently maps every exception to `INVALID_ARGUMENT`. Preserve existing `mcpCode`; map `AbortError` to `CANCELLED`, validation only to `INVALID_ARGUMENT`, unknown to `INTERNAL_ERROR`.
- `src/ui/input-controller.js`: `setKey()` silently ignores unknown buttons and interpolates untrusted selector text; `setTouchState()` and `updateTouch()` directly call `native.runFrame()`. Validate buttons against `state.buttons`, query only after validation (or escape), and remove all direct frame execution. `src/app.js` currently constructs it with `native`; remove that dependency. This is behavior-only—no DOM/CSS changes.
- `src/commands/input-commands.js`: validate all buttons through the same controller path; validate repeat/timing/touch coordinates rather than allowing NaN. Unknown inputs must become `INVALID_ARGUMENT`.
- `src/commands/memory-commands.js`: `dumpMemory` length, search `size`/limit, write/freeze size, and address+length overflow are insufficiently validated. Use `positiveInteger` and `memorySize`; cap length and reject overflow instead of silent coercion/fallback.
- `src/emulation-loop.js`: schedules manually in the failure branch and normally at the tail, but has no outer `try/finally`; throws from freezes, break sync, frame accounting, draw, audio, or status can kill scheduling. Restructure to one outer finally scheduling exactly once; native faults go through `handleNativeFault`; isolate draw/audio failures from emulation state.
- `src/ui/ui-controller.js` periodic interval near lines ~269–278 calls `applyFreezes()` and raw `commands.saveSaveSlot()`. Route both through an internal command boundary, catch/report once (avoid repeated spam), and return a disposer/clear the interval when appropriate. Do not insert startup DOM.
- Predictable malformed failures remain in `src/commands/runtime-commands.js`, `rom-commands.js`, `save-commands.js`, `recent-file-commands.js`, `disassembly-commands.js`, and `debugger-control-commands.js` (`ok: result === 0`, `ok: ret === 0`, ROM-not-loaded resume). Convert predictable failures to typed errors/results so responder does not classify them as internal. The responder already bounds malformed-result details to keys/hasError.
- `THIRD_PARTY_NOTICES.md` source-heading typo mentioned by the review must be checked directly (do not inspect generated notice output); fix source only if still present.

### Tests and verification still required

- Add focused tests under `tests/` only. Never use bare `node --test`; use `node --test tests/*.test.mjs`.
- Extend dispatcher test to cover undefined, null, array, primitive, Date, plain object, and null-prototype object.
- Add breakpoint-owner transactional native-callback failure tests.
- Add real native-like exec breakpoint step-past/runUntil 10-hit coverage, special user/script/mixed ownership, pending callback stop/crash/postMessage/duplicate/spoof cleanup, Worker lifecycle/allowlist/sandbox, all pre-abort paths, waitForScreenChange cleanup/failure paths, memory/input validation, touch accounting, comparator malformed result, and emulation-loop rescheduling.
- Host has no project dependencies installed and installation is forbidden. First-party `node --test tests/*.test.mjs` is valid. Final check/build must run in Codespace, then generated `public/app.js` must be copied back. Chrome MCP acceptance with local ROM/Save/State remains required by project instructions after the source/build checkpoint.

### Immediate continuation order

1. Finish the breakpoint cluster: transactional tests, safe step helper use, special ownership, pending callback token/cleanup.
2. Finish Worker handshake/RPC/sandbox changes and tests.
3. Finish wait/abort/operation edge cases.
4. Finish memory/input/touch/frame/algorithm/loop/timer and predictable failure fixes.
5. Run targeted first-party tests and syntax scans, append results here, then Codespace build/copy and Chrome acceptance. Continue working; this checkpoint is not a submission point.

## Checkpoint 4 — first implementation group passes existing tests

- Strict `node --check` succeeded for every first-party `src/**/*.js` file. Explicit first-party tests passed 26/26 with `node --test tests/core-services.test.mjs tests/refactor-services.test.mjs`.
- `src/debugger-service.js` normal step now goes through `withCurrentExecBreakpointSuspended`, matching the script-only exec continuation path. `waitForBreak` and `runUntil` already call the step command and therefore now share the safe path.
- The existing owner store now manages special breakpoint sites too. `src/app.js` maps special first/last-owner transitions to native kinds 3/4/5; `debugger-control-commands.js` creates origin-aware owners and keeps UI toggles tied only to user ownership; script triggers retain and remove their own special owner IDs.
- Pending script events now hold main-generated callback tokens and `{scriptId, callbackId}` entries. Completion validates all identity fields, duplicate/spoofed completion is rejected, synchronous event `postMessage` failure settles immediately, and stopping a script settles its callbacks. Worker messages echo token/callback identity.
- Eval and persistent workers now emit `ready`, explicitly disable network/sub-Worker globals, and reject dynamic import source. Persistent Worker emits `compiled` then `started` before awaiting the user async body. Main lifecycle differentiates startup versus later crash and uses explicit RPC allowlists plus plain-object/reserved-field/request-ID validation.
- `wait-commands.js` no longer contains an async Promise executor. It validates hit/stability/sample integers, checks pause/resume/step failures, observes pre-abort, cleans listeners once, and resets `comparing` in `finally`.
- Algorithm loading now checks cancellation before cache and after subscription, preserving `CANCELLED`. External comparison validates main/Worker area shapes and Worker result shape/range. Frame service preserves Abort/mcp/worker/native error classifications instead of flattening all errors.
- Memory commands validate positive bounded lengths/limits, 1/2/4 sizes, and uint32 range overflow. Input commands/controller validate allowlisted buttons/timing/touch coordinates; selectors no longer interpolate untrusted button text. Touch UI only changes input state and never directly executes a native frame.
- Emulation tick scheduling is now in one outer `finally`; draw/audio/status failures are isolated and audio failure disables audio without killing the loop. UI periodic freeze/save work goes through `runCommand`, rate-limits repeated failure logs, and exposes an interval disposer.
- Predictable malformed failure shapes were removed from ROM/Save/recent/reset/reload/register paths; screenshot cooldown is typed `BUSY`; disassembly partial output now uses `complete` instead of `ok:false`. Responder fallback recognizes additional predictable not-found/input cases.
- Fixed the source notice heading in `THIRD_PARTY_NOTICES.md` (`/#` to `#`). Generated notice output has not been touched; regenerate it during the Codespace build.
- Next: add the new focused tests (current 26 only prove no regression), fix issues those tests reveal, then perform the remaining scoped malformed-result audit and Codespace/browser verification.
- User advice after this checkpoint: maximize deterministic behavioral debugging in tests rather than relying on syntax checks. Use native/Worker/timer/AbortSignal/owner-store mocks to inject re-hit, crash, malformed protocol, duplicate/spoofed callback, cleanup throw, and stage-failure behavior. Reserve Chrome/WASM acceptance for integration behavior that cannot be represented faithfully in these state-transition tests. Continue work; this advice is not a stopping condition.

## Checkpoint 5 — deterministic behavior suite expanded (43/43)

- Current explicit first-party test command passes 43/43: `node --test tests/core-services.test.mjs tests/refactor-services.test.mjs`.
- Added real state-transition tests rather than source-only checks for:
  - transactional first/last breakpoint native callback failures;
  - dispatcher plain-object boundary (`undefined`, null, array, primitive, Date, ordinary object, null-prototype object);
  - user/script mixed special breakpoint ownership and last-owner native disable;
  - native-like `runUntil({bp:1,hits:10})`: ten distinct same-site hits, exactly nine safe step-past operations, native breakpoint temporarily disabled/restored each time, and logical owner/native registration retained;
  - operation cleanup where both release and operation cleanup throw, proving both run and BUSY is released;
  - eval Worker ready gating, explicit RPC deny, and one-time disposal;
  - pending callback token identity rejection and stop cleanup;
  - script-only special exception dispatch and automatic resume;
  - algorithm/input pre-abort;
  - memory size/length/overflow and hostile button validation;
  - frame AbortError versus unknown comparator classification;
  - external Worker result shape/range validation;
  - screen-wait resume failure/comparator exception and one-time frame-listener cleanup;
  - emulation-loop rescheduling after a freeze-stage failure;
  - malformed region/ignore rectangle validation;
  - static Worker bootstrap assertions for ready message, global API disabling, and dynamic-import rejection.
- A test initially exposed that callback cleanup returned before async auto-resume completed. `settlePersistentScriptCallbacks()` is now async, awaits all completed-event continuations, and `stopPersistentScript()` awaits it. A loop test also exposed the paused scheduling path uses `setTimeout`; the deterministic test now controls both timer and animation scheduling without leaving asynchronous activity.
- Special breakpoint event classification required an additional fix: native events retain their real CPU/address for output but carry an `ownerSite` pointing to `{cpu:"special", type, address:0}` for owner classification. `breakpoint-service.js` now classifies against that owner site, so script-only special callbacks auto-resume correctly.
- External Worker result validation was extracted to first-party `src/frame-comparator-result.js`, allowing direct Node tests without importing the `.worker.js` text-loader-only module.

### New user advice for later response-shape work

- The analysis AI has a scarce ~230k-token budget. After the current correctness/blocker work, reduce excessively long successful JSON responses and repeated keys where the same meaning can be expressed compactly. Preserve semantic information and compatibility where required.
- **Never truncate or omit errors.** Error code, message, recoverability, and useful bounded details must remain complete. This optimization targets verbose successful payload repetition, not diagnostic failure information.
- Do not let this later optimization interrupt the current logical-fix/test/build/browser completion sequence.

### Current continuation

1. Finish scoped audits for remaining malformed success/failure shapes, special/pending edge cases, and Worker protocol lifecycle details.
2. Run all first-party syntax/test/check/license/notices/build checks in Codespace, regenerate source-derived notices and the production app bundle, and copy the generated bundle locally.
3. Use Chrome MCP for the required local ROM/Save/State acceptance paths and verify UI startup/input/debugger behavior; no game data is printed or uploaded.
4. Append every result here before any final response. Only then consider the later compact-success-response pass if it is safe within compatibility constraints.

## Checkpoint 6 — Codespace production verification and browser-tool correction

- Local first-party syntax checks, 43/43 deterministic tests, and `git diff --check` succeeded.
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` was started and received the current `src/`, `tests/`, `THIRD_PARTY_NOTICES.md`, and `public/index.html` using `gh codespace cp -e` with explicit project destinations.
- Codespace verification succeeded end-to-end:
  - `npm test`: 43/43 pass.
  - `npm run check:js`: pass.
  - `npm run check:licenses`: pass.
  - `npm run build:notices`: pass.
  - `npm run build:js`: pass; production `public/app.js` is 199.9 KB.
- The generated `public/app.js` and `public/THIRD_PARTY_NOTICES.txt` were copied back locally. The CSP-enhanced `public/index.html` was synced, and its app cache key was updated from `20260720` to `20260722` after the bundle build.
- No native/C++ source changed, so the expensive safe-heap WASM rebuild was correctly not repeated.
- Browser correction history: an initial Chrome plugin session was connected but **no page/tab was opened**. The user then said not to use Browser Use, so that session was immediately finalized without navigation. The user clarified they intended `chrome-devtools-mcp` and had forgotten to enable it. Do not use Browser Use as a substitute.
- At this checkpoint the callable tool inventory still exposes no `chrome-devtools-mcp`, `take_snapshot`, or `upload_file` tool. If a later turn exposes them, use only that DevTools MCP path for local acceptance. Otherwise do not claim browser acceptance; code/test/build completion remains valid.
- Codespace still needs a stop request before final submission.

## Checkpoint 7 — final source audit

- Scoped first-party audits now find:
  - no async Promise executor;
  - no `ok: result === 0`, `ok: ret === 0`, or command-layer `ok:false` outside the responder's canonical failure constructor;
  - no public `params._*` privilege checks;
  - no raw WASM function/FS/heap access outside `native-bridge.js`;
  - no full-breakpoint clear outside the bridge;
  - no UI background call to raw `commands.saveSaveSlot()` or `applyFreezes()`;
  - native frame execution only in `emulation-loop.js` and the common-accounting `runtime-commands.js` frame-step path, never in the input controller.
- The last CSP correction adds `'unsafe-eval'` because eval/persistent Worker script execution intentionally uses eval; without it the feature would be broken. CSP still limits workers to self/blob, network connections to self/jsDelivr, object embedding to none, and the external MCP script to its fixed version URL. Worker bootstrap separately disables network/sub-Worker globals and rejects dynamic import source.
- Final `public/index.html` (CSP plus `app.js?v=20260722`) was synced to the Codespace after the production bundle was collected.
- Current tool inventory was checked again after the user's DevTools clarification and still exposes no `chrome-devtools-mcp`/snapshot/upload calls. Browser Use remains prohibited and was not used for page navigation. Do not retry Browser Use.
- Source correction and automated validation are complete. The only unavailable acceptance layer is Chrome DevTools MCP integration; if it becomes callable in a later turn, run it against the already-copied local production bundle without changing the completed source unless a real integration regression appears.
- Final cleanup: `gh codespace stop -c upgraded-xylophone-697q7wgrq5535xpr` returned exit code 0 after all artifacts were copied. No port forwarding or local preview server was started, so there is no remaining local/server cleanup.

## New-turn entry point

Read this file, `DEBUGGER_LOGIC_FIX_LIVE_HANDOFF.md`, from the newest checkpoint sections first. Do not reread the 2,025-line `releaseblocker.md` or the historical refactor handoff to reconstruct completed work. The requested logical fixes, added deterministic tests, Codespace checks/build, generated bundle/notice recovery, cache bust, and cleanup are complete. The only optional next action is Chrome **DevTools MCP** acceptance if those tools are actually exposed in the new turn; do not use Browser Use as a substitute. A later, separate optimization requested by the user is to compact excessively repetitive successful JSON payloads for analysis-AI token efficiency while preserving all error information.

## Checkpoint 8 — post-review release blockers reopened

- A newer `releaseblocker.md` review identified six P0 regressions plus remaining P1/P2 work. Current source inspection confirmed the issues; the earlier 43/43 result is retained only as a baseline, not as completion evidence.
- P0 implementation in progress:
  - input-sequence pause/resume now uses WeakMap-backed internal command metadata;
  - legacy `window.memory` and persistent-script scalar reads unwrap normalized `{ok,value}` responses while preserving structured `mcp.call`;
  - State invalidation now distinguishes prior running/paused state and owns its resume notice;
  - running/manual frame paths share frame-completion accounting before draw, with notice clearing;
  - duplicate UI/service debugger refresh calls are being removed while all original commands and controls remain available through the dispatcher-owned refresh path;
  - step, stepOver, smartStep-selected stepOver, branch stepping, and trace stepping share current-exec-breakpoint suspension.
- P1/P2 implementation in progress:
  - predictable State/Save native failures are becoming typed `NATIVE_ERROR` results;
  - speed/scale/rotation and custom memory-search length are allowlisted/validated;
  - framebuffer length and canvas/shell invariants are checked without clearing, hiding, or recreating the canvas;
  - script source receives lexical dynamic-import validation, and a supervisor/sandbox Worker split is being implemented so user code does not share the main Worker protocol global.
- Existing first-party tests still pass 43/43 after the first P0 edits. This is an interim regression check only. New deterministic coverage is required for every new blocker and sandbox boundary before completion.
- User instruction: preserve every feature exposed by the prior `app.js`; refresh ownership changes must remove only duplicate rendering, never commands or controls. Add as comprehensive a new test suite as practical, and update this handoff incrementally rather than only at the end.

## Checkpoint 9 — release-blocker behavior suite and sandbox boundary

- Added `tests/release-blockers.test.mjs`; its current 20 tests pass independently. Coverage is behavioral and includes:
  - paused input-sequence completion without self-cancellation;
  - numeric legacy `window.memory` and persistent-script reads, while `DesmumeMCP.call` remains structured;
  - running/paused State invalidation notice policy and first-manual-frame draw ordering;
  - typed State/Save native failures;
  - speed/scale/rotation/search validation, framebuffer preservation, and canvas diagnostics;
  - one dispatcher refresh per cycle and register highlight persistence until the next cycle;
  - native-like stepOver/smartStep escape from the current exec breakpoint;
  - dynamic-import comment bypasses and template-expression detection;
  - sandbox denial of `https://example.com/` fetch before network invocation, DOM/Window/sub-Worker denial, constructor-chain denial, and raw-message forgery denial;
  - authenticated eval/persistent supervisor forwarding and forged child-message rejection.
- Added broad NaN/state-integrity checks. Invalid numeric values now reject before mutating runtime audio/auto-update/frame state, input/touch state, State-load cancellation/native state, screenshot cooldown, or debugger break-refresh/PC state. Invalid command names including `NaN`, `undefined`, `null`, empty, and unknown strings return `UNKNOWN_COMMAND` without state changes; undefined params still normalize to `{}`.
- Worker execution is now split into supervisor and sandbox layers. User code runs only in the inner Worker; main RPC/event protocol runs in the outer Worker. Inner outbound messages carry a closure-held token, raw `postMessage` is disabled, and supervisors strip/validate the token before forwarding.
- During testing, the persistent scalar test initially stalled because IIFE isolation also hid the compatibility API from indirect eval. The implementation now passes `mcp`, `memory`, print helpers, and emulation helpers as explicit user-function arguments. The test wait is bounded and reports observed message types instead of looping indefinitely.
- Combined test run reached 62/63. The only failure was an older static assertion that required literal `postMessage({type:"ready"})`; the authenticated sandbox correctly uses `send(...)`. That assertion has been updated to cover both supervisors and sandboxes. A fresh combined run is still required.

## Checkpoint 10 — 67-test and production-build checkpoint

- Expanded the new suite further:
  - State notice ownership protects later save/state status text;
  - next-branch logic covers both native step and stepOver paths at a current exec breakpoint;
  - the eval command rejects `import/**/(...)` before constructing any Worker;
  - the real `scripts/dq9/Ctable_jp.js` runs in the sandbox harness, registers at least 20 exec hooks, prints nonzero numeric seed values without `[object Object]`, runs an exec callback, and requests `resume` before `eventDone`.
- Host dependency-free checks pass: every `src/**/*.js` passes `node --check`; the combined first-party suite passes 67/67; `git diff --check` reports no whitespace errors. Local `npm run check:js` remains intentionally unavailable because host dependencies are not installed, and no host installation was attempted.
- Codespace `upgraded-xylophone-697q7wgrq5535xpr` was started and received the current `src/` and `tests/` trees. Codespace verification passed:
  - `npm test`: 67/67;
  - `npm run check:js`: pass;
  - `npm run check:licenses`: pass;
  - `npm run build:notices`: pass;
  - `npm run build:js`: pass, production `public/app.js` is 211.0 KB.
- Generated `public/app.js` and `public/THIRD_PARTY_NOTICES.txt` were copied back locally. `public/index.html` now uses cache key `app.js?v=20260722-releaseblocker` and still needs to be synced to the Codespace.
- No C++/WASM source changed, so safe-heap native rebuild is not required. Chrome DevTools MCP acceptance remains intentionally pending user permission; Browser Use must not be used.

## Checkpoint 11 — final automated rerun before browser permission

- Added rejection for the classic-script HTML-comment split `import<!-- comment\n(...)`, then resynced the policy and test to the Codespace.
- Final Codespace rerun passes 67/67, `npm run check:js`, and `npm run build:js`. The final production bundle is 211.1 KB and has been copied back to local `public/app.js`.
- Automated source/test/build work is complete. Remaining acceptance is the explicitly permission-gated Chrome DevTools MCP run against the local production bundle. Do not use Browser Use as a substitute.
