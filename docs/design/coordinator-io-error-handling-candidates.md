# Coordinator I/O Error Handling -- Design Candidates

Generated: 2026-04-19

## Problem Understanding

### Core Tensions

1. **Crash-safety vs. DI purity**: The coordinator declares "all phase failures produce
   `PipelineOutcome { kind: 'escalated' }` -- never thrown" as a design invariant, but three
   injected dep functions (`getAgentResult`, `postToOutbox`, `pollForPR`) are called without
   try/catch in the mode files. Any throw from these functions crashes the coordinator silently
   instead of returning a structured `PipelineOutcome`. The fix must enforce the invariant at
   the right boundary.

2. **Verbosity vs. DRY**: `postToOutbox` is called at 8+ critical escalation points across
   `implement-shared.ts` and `full-pipeline.ts`. Each call site needs individual protection.
   Inline try/catch at 8 sites is repetitive; a helper would reduce duplication but adds
   abstraction not in the existing codebase pattern.

3. **`process.stderr.write()` vs. `deps.stderr()`**: The prescribed pattern uses
   `process.stderr.write()` in catch blocks, but the rest of the coordinator uses the injected
   `deps.stderr()`. The tension is minor -- catch blocks represent unexpected I/O failures,
   so using `process.stderr.write()` signals this is an emergency log path, not a normal
   operational log.

### Likely Seam

The mode files are the correct seam. `implement-shared.ts`, `full-pipeline.ts`, and
`implement.ts` are the callers of the three unsafe deps. The coordinator owns the
escalation-first invariant -- not the injectors (`trigger-listener.ts`, `cli-worktrain.ts`).

### What Makes This Hard

- `postToOutbox` calls are immediately followed by `return { kind: 'escalated', ... }`. The
  try/catch must wrap ONLY the `postToOutbox` call, not the return statement. Careful
  placement required.
- `pollForPR` is called in BOTH `implement.ts` (explicitly mentioned in task) AND
  `full-pipeline.ts` line 454 (not mentioned but equally unsafe). Both must be wrapped.
- UX gate zombie detection: `implement.ts` line 144 assigns `uxHandle` from `uxSpawnResult.value`
  without a null/empty-string guard before passing to `awaitSessions`. This is the only session
  handle in the coordinator without the guard -- a separate gap alongside the I/O error handling.

---

## Philosophy Constraints

**From `CLAUDE.md`:**
- "Errors are data -- represent failure as values (Result/Either), not exceptions as control flow"
- "Type safety as the first line of defense"

**From `adaptive-pipeline.ts` header (design invariant):**
- "All phase failures produce PipelineOutcome { kind: 'escalated' } -- never thrown."
- "All I/O is injected via AdaptiveCoordinatorDeps. Zero direct fs/fetch/exec imports."

**Repo precedent:**
- `archiveFile` (in `implement.ts` and `full-pipeline.ts`): try/catch inline in finally block, log-and-continue. This is the exact model for `postToOutbox`.
- `writeFile` routing log (in `adaptive-pipeline.ts`): try/catch inline, log-and-continue.

**Conflicts:** None material. The stated philosophy (errors as data) and the repo pattern (inline try/catch for non-Result deps) are consistent.

---

## Impact Surface

- `runReviewAndVerdictCycle` is called from both `implement.ts` and `full-pipeline.ts`. Fixing
  `getAgentResult` in `implement-shared.ts` protects both callers automatically.
- `runAuditChain` (also in `implement-shared.ts`) calls both `getAgentResult` and `postToOutbox`
  at multiple points.
- `adaptive-pipeline.ts` line 362 calls `postToOutbox` in the `ESCALATE` routing case -- this is
  OUT OF SCOPE for this task (task restricts changes to the 3 mode files).
- No callers outside these files change signature or return type.

---

## Candidates

### Candidate 1: Inline try/catch at each call site (prescribed pattern)

**Summary:** Wrap each `getAgentResult`, `postToOutbox`, and `pollForPR` call individually in
a try/catch block in the 3 mode files.

**Tensions resolved:** Crash-safety fully addressed. Accepts: slight verbosity from 8+
`postToOutbox` sites.

**Boundary:** At the mode file call sites -- the correct boundary. The coordinator owns the
escalation-first invariant; the mode files are where the invariant must be enforced.

**Failure mode:** Missing the `pollForPR` call in `full-pipeline.ts` (not explicitly called out
in task description but confirmed unsafe by code analysis). Must be systematic.

**Repo-pattern relationship:** Follows `archiveFile` try/catch pattern exactly. Adapts
`writeFile` routing-log pattern from `adaptive-pipeline.ts`.

**Gains:** Zero risk to happy path. Locally visible -- reviewer can see exactly what is
protected at each call site. No new abstractions.

**Losses:** Mildly repetitive for `postToOutbox` sites. Functions grow slightly.

**Scope:** Best-fit. The 3 files are exactly the seam.

**Philosophy fit:** Honors "errors are data", "escalation-first invariant", "DI for boundaries".
Minor: uses `process.stderr.write()` in catch blocks rather than `deps.stderr()`, consistent
with prescribed pattern and emergency-log semantics.

---

### Candidate 2: Wrap at injection site (safe wrapper functions)

**Summary:** Wrap `getAgentResult`, `postToOutbox`, `pollForPR` in safe adapter functions at
the injection sites (`trigger-listener.ts`, `cli-worktrain.ts`) so the deps never throw from
the coordinator's perspective.

**Tensions resolved:** DI purity -- the mode files stay clean. Accepts: changes to 2 files
outside the permitted scope.

**Boundary:** At the injection layer. Wrong boundary for this task -- the coordinator owns the
escalation invariant, not the injectors. Injectors wire up the real implementation; they are
not responsible for the coordinator's recovery behavior.

**Failure mode:** Wrapping at injection site catches throws but cannot return `PipelineOutcome`
-- would need to return null or a sentinel, which the mode files then check. Adds complexity
at both ends, solving neither fully.

**Repo-pattern relationship:** Departs -- existing injected deps use Result types for
error-returning deps; plain-promise deps are not wrapped at injection sites.

**Scope:** Too broad -- reaches outside the permitted 3 files.

**Verdict: Rejected.** Out of scope and wrong seam.

---

### Candidate 3: Private helper `safePostToOutbox(deps, msg, meta)`

**Summary:** Extract a private helper that wraps `deps.postToOutbox` in try/catch, reducing
repetition at the 8+ `postToOutbox` call sites.

**Tensions resolved:** DRY for `postToOutbox`. Accepts: new abstraction not prescribed by task.

**Boundary:** Same 3 mode files, plus a local helper function in `implement-shared.ts`.

**Failure mode:** Helper abstraction obscures the try/catch from reviewers; may hide future
misuse (e.g., someone using the helper for a call that SHOULD escalate on failure).

**Repo-pattern relationship:** No precedent for dep-wrapper helpers in the mode files. `archiveFile`
try/catch is inline without a helper.

**Scope:** Best-fit only if `postToOutbox` had 15+ sites. At 8, YAGNI says no.

**Verdict: Skipped.** Task spec gives explicit inline pattern. YAGNI applies.

---

## Comparison and Recommendation

**Candidate 1 is the clear choice.**

All three candidates converge on the same underlying mechanism (try/catch). The only real
alternatives differ in location (injection site -- wrong boundary) or DRY abstraction (helper --
not warranted at 8 sites). Convergence is honest here.

Candidate 1:
- Follows the prescribed pattern from the task description exactly
- Follows the repo precedent (`archiveFile`, `writeFile` try/catch)
- Is locally visible and reviewable
- Carries zero happy-path risk
- Can be applied systematically to all confirmed call sites

---

## Self-Critique

**Strongest argument against:** The 8+ `postToOutbox` call sites produce repetitive code. If
the count grew to 20+, a helper would be clearly warranted. At 8, the verbosity is manageable.

**Narrower option that might work:** Only fix `getAgentResult` and `pollForPR` (HIGH severity),
skip `postToOutbox` wrapping (MEDIUM severity). Would reduce scope. Loses: `postToOutbox` crash
at escalation decision points is still a real failure mode that kills the pipeline silently.

**Broader option:** Candidate 2 (wrap at injection). Would be justified only if there were a
precedent of wrapping injected deps at the injection layer. No such precedent exists.

**Invalidating assumption:** If `postToOutbox` is guaranteed never to throw in production (e.g.,
the real impl is in-memory rather than disk-based). The audit doc confirms it uses
`fs.promises.appendFile` -- can fail on disk full or permission error. Assumption holds.

---

## Open Questions for Main Agent

None. The problem, solution, and scope are fully specified. Implementation is mechanical.

- Confirm `pollForPR` in `full-pipeline.ts` line 454 also needs wrapping (not explicitly in
  task description but confirmed unsafe -- include it).
- For `postToOutbox`: the task says "log a warning and continue". Use `process.stderr.write()`
  as prescribed, not `deps.stderr()`.
- UX gate zombie detection in `implement.ts`: add `if (!uxHandle || uxHandle.trim() === '')` guard
  after line 144, consistent with all 9 other session handle checks in the coordinator.
