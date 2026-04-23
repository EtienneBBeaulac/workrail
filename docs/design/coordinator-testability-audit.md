# Coordinator Testability Audit

Generated: 2026-04-19

## Context

**Motivating bug:** The `awaitSessions` HTTP bug shipped to production. The real implementation
polled an HTTP console endpoint instead of reading from the session store. The unit-test fake
always returned a success `AwaitResult`, so the wrong implementation path was invisible to tests.

**Audit question:** For each dependency function in `AdaptiveCoordinatorDeps`, does the test fake
exist? Does it simulate realistic failure modes? Could the real implementation fail in a way the
fake would NOT catch?

**Scope:**
- `tests/unit/adaptive-implement.test.ts`
- `tests/unit/adaptive-full-pipeline.test.ts`
- `tests/unit/route-task.test.ts`
- `src/coordinators/adaptive-pipeline.ts` -- `AdaptiveCoordinatorDeps` full interface
- `src/coordinators/pr-review.ts` -- `CoordinatorDeps` (parent interface)
- `src/trigger/trigger-listener.ts` -- real production wiring (lines 640-752)
- `src/cli-worktrain.ts` -- real `awaitSessions` wiring (lines 1336-1372)

**Principle under audit:** "Prefer fakes over mocks -- tests should validate behavior with
realistic substitutes." (CLAUDE.md)

---

## Interface Summary

`AdaptiveCoordinatorDeps` extends `CoordinatorDeps` with 5 additional deps.
Total: 19 named deps plus one optional (`contextAssembler`).

**Inherited from `CoordinatorDeps`:**

| Dep | Type |
|-----|------|
| `spawnSession` | async, returns `Result<string, string>` |
| `awaitSessions` | async, returns `AwaitResult` |
| `getAgentResult` | async, returns `{ recapMarkdown, artifacts }` |
| `listOpenPRs` | async, returns `PrSummary[]` |
| `mergePR` | async, returns `Result<void, string>` |
| `writeFile` | async, returns `void` |
| `readFile` | async, returns `string` (throws on ENOENT) |
| `appendFile` | async, returns `void` |
| `mkdir` | async, returns `string \| undefined` |
| `stderr` | sync, void |
| `now` | sync, returns `number` |
| `port` | value |
| `homedir` | sync, returns `string` |
| `joinPath` | sync, returns `string` |
| `nowIso` | sync, returns `string` |
| `generateId` | sync, returns `string` |
| `contextAssembler` | optional, `ContextAssembler` |

**Added by `AdaptiveCoordinatorDeps`:**

| Dep | Type |
|-----|------|
| `fileExists` | sync, returns `boolean` |
| `archiveFile` | async, returns `void` |
| `pollForPR` | async, returns `string \| null` |
| `postToOutbox` | async, returns `void` |
| `pollOutboxAck` | async, returns `'acked' \| 'timeout'` |

---

## Per-Dep Analysis

### 1. `awaitSessions`

**Fake default:** Always returns `makeSuccessAwait(handles[0])` -- outcome is always `'success'`.

**Fake failure coverage:** `makeFailedAwait()` and `makeTimeoutAwait()` helpers exist and are used
in explicit test overrides (e.g., "escalates when coding session times out"). These cover the
`outcome: 'failed'` and `outcome: 'timeout'` contract branches.

**Real implementation (cli-worktrain.ts:1336):** Calls `executeWorktrainAwaitCommand` which makes
HTTP requests to the daemon console port. If the HTTP call fails or the result is unparseable,
`resolvedResult` stays null and the function returns all sessions as `outcome: 'failed'`.

**Gap:** The fake does not simulate the scenario where `awaitSessions` returns all-failed because
the daemon is unreachable (port unavailable). This is different from a session failing: it means
the coordinator cannot determine any session status. While `makeFailedAwait` covers the contract
shape, it does not represent the CAUSE: the coordinator trusts `awaitSessions` to correctly
reflect session state, but the real impl can return all-failed even when sessions succeeded.

**The awaitSessions bug:** The bug was that the real impl polled HTTP instead of reading the
session store. A fake that validates contract shape cannot catch this. However, a fake that
simulates port-unavailable failure (returning all-failed unconditionally when `port` is set to 0
or -1) would have surfaced this as a test gap: the coordinator would escalate, and the test author
would ask why.

**Missing scenarios:**
- `awaitSessions` returns all-failed because daemon is unreachable (simulated via `port = 0`)
- `awaitSessions` called with an empty handles array

**Severity: HIGH**

---

### 2. `getAgentResult`

**Fake default:** Always returns `{ recapMarkdown: 'APPROVE -- no findings. LGTM.', artifacts: [] }`.

**Fake failure coverage:** None in the default fake. Tests that need a specific result override
`getAgentResult` inline, but no test simulates a network failure.

**Real implementation (cli-worktrain.ts:1374):** Makes two raw `globalThis.fetch()` calls (session
detail, then node detail). Neither call is wrapped in try/catch in `implement-shared.ts` or
`full-pipeline.ts`. A network error throws an unhandled exception, crashing the coordinator.

**Gap 1 (success bias):** Default fake never returns `{ recapMarkdown: null, artifacts: [] }`,
which is the real impl's fallback on HTTP failure. The `null` recap path IS tested in
`adaptive-full-pipeline.test.ts` but only via explicit override, not as the default.

**Gap 2 (throw injection):** The real impl throws on network error (fetch rejects). The callers
in `implement-shared.ts` do not have try/catch around `getAgentResult`. If this throws, the
coordinator crashes rather than returning `{ kind: 'escalated' }`. No test exercises this.

**Missing scenarios:**
- `getAgentResult` returns `{ recapMarkdown: null, artifacts: [] }` as the default (should escalate gracefully)
- `getAgentResult` throws a network error (coordinator should escalate, not crash)

**Severity: HIGH**

---

### 3. `spawnSession`

**Fake default:** Returns `ok(nextHandle())` -- always succeeds.

**Fake failure coverage:** GOOD. Multiple tests use `vi.fn().mockResolvedValue(err('...'))` and
workflow-specific failure injection. The `err()` path is well-tested for all spawn points
(coding, UX gate, review, fix loop).

**Real implementation:** Makes an HTTP POST to the daemon console. Returns `err()` on HTTP failure.
Does not throw -- uses Result type consistently.

**Gap:** None significant. Zombie handle detection (empty string handle) is NOT explicitly tested
in the adaptive tests (it is tested in `pr-review.ts` context), but the structural coverage is good.

**Missing scenarios:**
- `spawnSession` returns `ok('')` (empty handle / zombie detection) for adaptive modes

**Severity: LOW**

---

### 4. `pollForPR`

**Fake default:** Returns `'https://github.com/org/repo/pull/42'` -- always finds a PR.

**Fake failure coverage:** `null` return IS tested via explicit override (`pollForPR: vi.fn().mockResolvedValue(null)`
in "escalates when no PR is found after coding session"). So the null path has a test.

**Real implementation (trigger-listener.ts:665):** Shells `gh pr list` every 30 seconds until
timeout. Can fail silently if `gh` is not installed, not authenticated, or the branch pattern
has no match. Returns null after timeout.

**Gap:** The default fake always returns a PR URL, so any regression that makes the real impl
always return null would be masked in all other tests. The `gh` CLI failure mode (throws, then
continues polling) is completely untested.

**Missing scenarios:**
- Default fake returning null (to catch regressions earlier -- currently only one explicit test)
- `gh` CLI throws on every poll but eventually times out

**Severity: MEDIUM**

---

### 5. `postToOutbox`

**Fake default:** Returns `undefined` (vi.fn().mockResolvedValue(undefined)) -- always succeeds.

**Fake failure coverage:** Tests verify that `postToOutbox` WAS CALLED with the right arguments,
but no test verifies coordinator behavior when `postToOutbox` throws.

**Real implementation (trigger-listener.ts:694):** Writes a JSON line to `~/.workrail/outbox.jsonl`
using `fs.promises.appendFile`. Can fail on disk full, missing directory, or permission error.

**Gap:** `postToOutbox` is called at critical escalation decision points (fix loop exhausted,
human review required, do-not-merge). If it throws, the coordinator crashes at that point and
never returns a `PipelineOutcome`. Callers do not wrap calls in try/catch.

**Missing scenarios:**
- `postToOutbox` throws an error (coordinator should continue and return escalated outcome)

**Severity: MEDIUM**

---

### 6. `pollOutboxAck`

**Fake default:** Returns `'acked'` -- always acknowledged immediately.

**Fake failure coverage:** NONE. No test in either file exercises the `'timeout'` return value.

**Real implementation (trigger-listener.ts:707):** Polls `inbox-cursor.json` every 5 minutes
for up to 24 hours. The `'timeout'` path is the most likely real-world outcome because users
do not always ack notifications promptly.

**Gap:** The UX gate escalation path on `'timeout'` is completely untested. The `'timeout'`
branch exists in `full-pipeline.ts` but no test triggers it. Any regression in that branch
(e.g., forgetting to escalate, forgetting to post another outbox message) would be invisible.

The UX gate is triggered by goals containing: 'ui', 'screen', 'component', 'design', 'ux',
'frontend' -- a common set of keywords, not an edge case.

**Missing scenarios:**
- `pollOutboxAck` returns `'timeout'` -- coordinator should escalate gracefully

**Severity: HIGH**

---

### 7. `archiveFile`

**Fake default:** Returns `undefined` -- always succeeds.

**Fake failure coverage:** GOOD. One test explicitly tests `archiveFile` throwing:
"logs a warning if archiveFile throws but does not change the outcome". The coordinator
uses a try/catch wrapper around `archiveFile` in a finally block. This is the only dep
with proper throw-handling coverage.

**Real implementation:** `fs.promises.rename(src, dest)` -- can fail on cross-device rename,
missing dest directory, or permission error.

**Gap:** None. Well-tested.

**Severity: LOW**

---

### 8. `fileExists`

**Fake default:** Returns `false` (in makeFakeDeps). `route-task.test.ts` uses explicit
`noPitch` and `hasPitch` fakes.

**Fake failure coverage:** Good for routing tests. The `fileExists` dep is sync and pure;
it does not have network failure modes.

**Real implementation:** `fs.existsSync(p)` -- cannot throw in normal operation.

**Gap:** None significant.

**Severity: LOW**

---

### 9. `mergePR`

**Fake default:** Returns `ok(undefined)` -- always succeeds.

**Fake failure coverage:** None for IMPLEMENT/FULL mode tests. `mergePR` is called by
`runPrReviewCoordinator` (pr-review.ts), not by IMPLEMENT/FULL mode logic. The IMPLEMENT
and FULL pipeline tests include `mergePR` in their fakes, but it is never called by the
code under test.

**Real implementation:** Shells `gh pr merge --squash`. Can fail on merge conflict,
required CI not passing, or branch protection rule violation.

**Gap:** Low severity because `mergePR` is not called in IMPLEMENT/FULL mode. The fake
is structurally correct but its presence in `makeFakeDeps()` is misleading -- it implies
IMPLEMENT/FULL mode merges PRs, which it does not (merging is delegated to the review
coordinator). The misleading presence could cause future confusion.

**Missing scenarios:** N/A for IMPLEMENT/FULL tests. Reviewed separately in pr-review tests.

**Severity: LOW (structural confusion only)**

---

### 10. `listOpenPRs`

Same analysis as `mergePR`: present in fakes but not called by IMPLEMENT/FULL mode logic.

**Severity: LOW (structural confusion only)**

---

### 11. `writeFile`

**Fake default:** Returns `undefined`. Called by `runAdaptivePipeline` for routing log writes
and by `writeReport` in pr-review mode. Both callers wrap in try/catch -- routing log failure
is explicitly non-fatal.

**Gap:** None significant for IMPLEMENT/FULL. The try/catch wrapper means failures are already
safe.

**Severity: LOW**

---

### 12. `readFile`

**Fake default:** Throws `Object.assign(new Error('ENOENT'), { code: 'ENOENT' })` -- simulates
missing file. This is the most realistic default of any fake in the suite: it forces callers
to handle ENOENT, which is the most common real-world readFile failure.

**Gap:** None. Well-designed default.

**Severity: LOW**

---

### 13. `contextAssembler` (optional)

**Fake:** Absent from all `makeFakeDeps()` in adaptive tests. `contextAssembler` is an optional
field and its absence means context assembly never runs in unit tests.

**Real implementation:** Assembles git diff and prior session notes. Can fail if the git command
fails or the session store is unreachable.

**Gap:** Context assembly failures are completely invisible to unit tests. If a regression in
context assembly caused `spawnSession` to receive malformed context and crash, unit tests would
not catch it. However, this is intentional -- the optional nature of the dep means the coordinator
is designed to work without it.

**Severity: LOW (by design, but worth documenting)**

---

### 14. `stderr`, `now`, `port`, `homedir`, `joinPath`, `nowIso`, `generateId`

These are synchronous utility functions with trivial or no failure modes.

- `stderr`: vi.fn() -- never throws in real impl
- `now`: vi.fn().mockReturnValue(Date.now()) -- realistic
- `port`: hardcoded 3456 -- does not simulate "port 0 = daemon not running"
- `homedir`: returns '/home/test' -- realistic enough for path construction
- `joinPath`: uses string concatenation -- realistic
- `nowIso`: returns ISO string -- realistic
- `generateId`: returns random string -- realistic

**Gap for `port`:** The `port` value in fakes is always 3456 (a valid port). A fake with `port = 0`
or `port = -1` combined with a failure-simulating `awaitSessions` would represent "daemon not
running" more realistically. This is the test scenario that would have caught the awaitSessions
HTTP bug.

**Severity: LOW (port gap is only meaningful when combined with awaitSessions)**

---

## vi.mock() Audit

**Finding:** Zero `vi.mock()` calls in any of the three test files. All dependencies are
injected via `makeFakeDeps()` or explicit object literals. This correctly follows the
"prefer fakes over mocks" principle.

The `vi.fn()` calls within `makeFakeDeps()` are jest-spy instances on the fake's own methods,
not module-level mocks. This is the correct pattern.

---

## Missing Test Scenarios Summary

| Gap | Dep | Severity | File |
|-----|-----|----------|------|
| Fake never simulates daemon-unreachable (all-failed when port unavailable) | `awaitSessions` | HIGH | both |
| Fake never throws network error; callers lack try/catch | `getAgentResult` | HIGH | both |
| `pollOutboxAck` `'timeout'` path never exercised | `pollOutboxAck` | HIGH | `adaptive-full-pipeline.test.ts` |
| `postToOutbox` throw not tested; callers lack try/catch | `postToOutbox` | MEDIUM | both |
| Default always returns PR URL; only one explicit null test | `pollForPR` | MEDIUM | both |
| Empty-handle zombie detection not tested in adaptive modes | `spawnSession` | LOW | both |
| `port = 3456` always valid; never simulates "daemon not running" | `port` | LOW | both |
| `contextAssembler` absent from all fakes | `contextAssembler` | LOW | both |
| `mergePR` / `listOpenPRs` in fakes but never called by IMPLEMENT/FULL | `mergePR`, `listOpenPRs` | LOW (misleading) | both |

---

## Severity Rankings

### HIGH (must fix -- these are the awaitSessions class of gap)

1. **`awaitSessions` daemon-unreachable scenario** -- The exact class of bug that motivated this
   audit. Add a test that injects `awaitSessions` returning all-failed to simulate an unreachable
   daemon port. Verify the coordinator escalates gracefully (not crashes).

2. **`getAgentResult` throw injection** -- The real impl uses raw `fetch()` without try/catch in
   callers. Add a test where `getAgentResult` throws a `TypeError: fetch failed`. The coordinator
   should catch this and return `{ kind: 'escalated' }`. Currently it would crash.
   Fix also requires adding try/catch in `implement-shared.ts` around `getAgentResult` calls.

3. **`pollOutboxAck` timeout path** -- Add a test for the UX gate in `full-pipeline.ts` where
   `pollOutboxAck` returns `'timeout'`. Verify the coordinator escalates and does not hang.
   This is the most common real-world outcome of the UX gate.

### MEDIUM (should fix)

4. **`postToOutbox` throw injection** -- Add a test where `postToOutbox` throws. The coordinator
   calls it at critical decision points without try/catch; a throw currently crashes the pipeline.

5. **`pollForPR` null as default** -- The null path is covered by one explicit test, but the
   default fake always returns a URL. Consider making null the default in a second
   `makeFakeDeps` variant used for failure-path tests, to catch regressions earlier.

### LOW (address in cleanup)

6. **`spawnSession` zombie handle** -- Add one test where `spawnSession` returns `ok('')` (empty
   handle) for IMPLEMENT/FULL modes and verify the coordinator escalates.

7. **`mergePR` / `listOpenPRs` in `makeFakeDeps`** -- These deps are not called by IMPLEMENT/FULL
   mode. Remove them from `makeFakeDeps` to reduce noise, or add a comment explaining they are
   inherited from `CoordinatorDeps` for REVIEW_ONLY/QUICK_REVIEW modes.

8. **`contextAssembler` smoke test** -- Add at least one test that injects a minimal
   `contextAssembler` fake to verify context threading in IMPLEMENT/FULL modes.

---

## Architectural Note

The awaitSessions HTTP bug was an implementation-path bug, not an interface-contract bug. No
unit-test fake can catch "the real implementation chose the wrong data source." What a better
fake CAN do is simulate the *outcome* of that wrong choice (daemon unreachable = all-failed)
so the coordinator's escalation path for that outcome is exercised. The gap was not "bad fake"
but "untested escalation branch for a failure mode that occurs in production."

The correct fix at two levels:
1. **Fake level:** Simulate transport failures (port unavailable, network error) to exercise
   escalation paths.
2. **Implementation level:** Wrap `getAgentResult`, `pollForPR`, and `postToOutbox` calls in
   try/catch in the mode files, so transport errors return `{ kind: 'escalated' }` rather than
   crashing the coordinator.
