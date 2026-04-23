# Design Candidates: Discovery Loop Fix

**Date:** 2026-04-19
**Task:** Thread session timeouts, inspect PipelineOutcome, add sidecar idempotency

---

## Problem Understanding

### Core Tensions

1. **Fire-and-forget vs. outcome inspection**: The poller uses `void dispatchP.then(...)` intentionally to avoid blocking the poll cycle. Fix 2 needs to inspect the `PipelineOutcome` -- still inside the async callback, not blocking the caller. Adding inspection doesn't change fire-and-forget semantics but adds I/O (GitHub API call) inside a previously side-effect-free callback.

2. **Interface evolution vs. backward compat**: Adding `agentConfig` to `CoordinatorDeps.spawnSession` changes a widely-used interface. All existing callers that pass 3-4 args must continue to compile and work. Optional 5th param resolves this but requires all test fakes to accept (and ignore) the new param.

3. **Cross-restart idempotency vs. simplicity**: The sidecar (Fix 3) adds filesystem I/O to the poll cycle path. `checkIdempotency` must now detect a different file format. The sidecar uses a predictable filename (`queue-issue-<N>.json`) so it can be found by name rather than content scan.

4. **Single source of truth for issue ownership**: Fix 2 (GitHub label) and Fix 3 (sidecar file) provide overlapping protection. Label is persistent, cross-process; sidecar is local, TTL-based. Both needed: label handles the post-completion case, sidecar handles the crash-during-dispatch window.

### Likely Seam

- Fix 1: `CoordinatorDeps.spawnSession` in `pr-review.ts` (interface), `trigger-listener.ts` (impl), `full-pipeline.ts` (call sites)
- Fix 2: `polling-scheduler.ts` around L605-624 (outcome handler) + new `applyGitHubLabel` method
- Fix 3: `polling-scheduler.ts` `doPollGitHubQueue` (sidecar write/delete) + `github-queue-poller.ts` `checkIdempotency` (sidecar read)

### What Makes This Hard

- Sidecar TTL requires `DISCOVERY_TIMEOUT_MS` -- that constant lives in `adaptive-pipeline.ts`. Options: (a) import it into `polling-scheduler.ts`, or (b) store the resolved TTL in the sidecar file itself. Option (b) is cleaner -- `checkIdempotency` reads `dispatchedAt + ttlMs` from the file without needing to know the constant.
- `applyGitHubLabel` uses `(this.fetchFn ?? globalThis.fetch)` -- tests that verify this call must configure the fetchFn mock to handle the labels endpoint.
- The existing conservative behavior of `checkIdempotency` (return 'active' on ANY parse error) means a malformed sidecar permanently blocks the issue until the file is deleted. Since the sidecar is written by controlled code, this is acceptable.

---

## Philosophy Constraints

From `CLAUDE.md`:
- **Immutability by default** -- all new interface fields use `readonly`
- **Errors are data** -- sidecar write failure logged but doesn't block dispatch (fire-and-forget I/O acceptable for non-fatal defense-in-depth)
- **Type safety as first line of defense** -- change `Promise<unknown>` to `Promise<PipelineOutcome>` enforces type at compile time
- **Exhaustiveness** -- `.then()` handler handles all 3 `PipelineOutcome` kinds
- **Dependency injection for boundaries** -- `applyGitHubLabel` uses injected `fetchFn`
- **YAGNI** -- no new abstractions beyond what the spec requires

**No philosophy conflicts**. The fire-and-forget pattern in the poller is an intentional design decision, not a violation.

---

## Impact Surface

Changes to `CoordinatorDeps.spawnSession` affect:
- `pr-review.ts` callers: 3 call sites (`spawnResult` for mr-review L991, fix-agent L1243, re-review L1309) -- all pass 3-4 args, no 5th arg needed, backward-compatible
- All test fakes in `adaptive-full-pipeline.test.ts`, `coordinator-pr-review.test.ts` that mock `spawnSession`
- `trigger-listener.ts` implementation (must forward the new param)

Changes to `checkIdempotency` in `github-queue-poller.ts` affect:
- `polling-scheduler.ts` (the only caller)
- `tests/unit/github-queue-poller.test.ts` (existing idempotency tests must still pass)

---

## Candidates

### Candidate A: Exact spec implementation (recommended)

**Summary**: Implement all 3 fixes exactly per the spec. Sidecar TTL stored in the file. `checkIdempotency` extended to also scan for `queue-issue-*.json` files by filename pattern and check `dispatchedAt + ttlMs > Date.now()`.

**Tensions resolved**:
- Fire-and-forget: preserved (outcome inspection inside async callback only)
- Interface compat: optional 5th param is additive
- Idempotency: single function handles both session files and sidecar files
- Source of truth: label (persistent) + sidecar (crash-window) coexist

**Tensions accepted**:
- `checkIdempotency` gains time-dependent behavior (TTL check)
- `applyGitHubLabel` adds network I/O inside async callback

**Boundary**: `pr-review.ts` (interface), `trigger-listener.ts` (impl), `full-pipeline.ts` (call sites), `polling-scheduler.ts` (outcome + sidecar), `github-queue-poller.ts` (checkIdempotency)

**Failure mode**: Malformed sidecar -> conservative 'active' -> issue blocked indefinitely. Acceptable since sidecar is written by controlled code and has known format.

**Repo-pattern relationship**: Follows all established patterns (injectable deps, Result types, fetchFn, fire-and-forget async, conservative idempotency)

**Gains**: Complete fix, crash-safe, type-enforced outcomes
**Losses**: `checkIdempotency` is slightly more complex

**Scope**: best-fit -- exactly the files specified in the task

**Philosophy fit**: Honors immutability, type safety, exhaustiveness, DI, YAGNI

---

### Candidate B: Separate sidecar check function

**Summary**: Leave `checkIdempotency` unchanged. Add a new exported `checkQueueSidecar(issueNumber, sessionsDir)` function. Call both from `polling-scheduler.ts`.

**Tensions resolved**:
- `checkIdempotency` semantics unchanged (no time-dependency added)

**Tensions accepted**:
- Two callsites in `polling-scheduler.ts` -- future idempotency mechanisms need to be added in two places
- More surface area to test

**Failure mode**: A future refactor adds one check and misses the other

**Scope**: slightly broader (new exported function)

**Philosophy fit**: Compose with small pure functions (honors), but creates coordination risk

---

### Candidate C: Config-based timeout (rejected)

**Summary**: Set `agentConfig.maxSessionMinutes: 65` in the trigger definition's config file (`triggers.yml`) instead of code changes.

**Rejected because**: Creates dual source of truth. Coordinator already has per-phase timeouts as constants. Config can drift. Explicitly rejected in `discovery-loop-investigation-B.md` as Option B.

---

## Comparison and Recommendation

**Recommendation: Candidate A**

Candidate A matches the spec exactly and keeps idempotency checking in one function. The TTL-in-file approach keeps `checkIdempotency` free of coordinator constants, maintaining clean module boundaries. The fire-and-forget semantics are preserved throughout.

Candidate B creates a maintenance coordination risk with no clear benefit. The two-function pattern is only beneficial if `checkIdempotency` is used in contexts where sidecar checking is unwanted -- there's only one callsite.

---

## Self-Critique

**Strongest argument against Candidate A**: Modifying `checkIdempotency` adds time-dependent behavior (TTL check) to what was a pure scan. This makes the function harder to test deterministically without mocking `Date.now()`.

**Mitigation**: Tests can control the `dispatchedAt` and `ttlMs` values in the sidecar file. An expired sidecar has `dispatchedAt + ttlMs < Date.now()` -- easily crafted in tests with `dispatchedAt: 0, ttlMs: 1`.

**Assumption that would invalidate this**: If `this.fetchFn` type in `PollingScheduler` is too narrow to call the GitHub Labels API (e.g., typed to only accept GitLab URLs). Actual type is `FetchFn | undefined` where `FetchFn = (url: string, init?: RequestInit) => Promise<Response>` -- generic enough.

---

## Open Questions for Main Agent

None. The spec is fully determined. No human-decision questions remain.
