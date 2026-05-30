# Git Metrics Collection -- Design Review Findings

*Review of Candidate B (selected). Main agent synthesis.*

---

## Tradeoff Review

**T1: captureConfidence enum divergence**
`run_completed` retains `'high'|'none'` (schema locked). `git_metrics_recorded` uses `'high'|'partial'|'none'`. Two fields encoding similar concepts exist on SessionMetricsV2. Acceptable because the old field is documented as legacy/broken and gitEvidence is the authoritative replacement. Fails to be unacceptable only if a consumer starts reading the old run_completed captureConfidence and expecting 'partial' -- no current consumer does.

**T2: Two new event union members**
Both are standard DomainEventEnvelopeV1Schema.extend() registrations. TypeScript exhaustive switches will catch any unhandled cases at compile time. Projection loops skip unknown events, so backward compat holds. Acceptable.

**T3: Post-completion appendEvent window**
Confirmed by code inspection: gate.withHealthySessionLock acquires a fresh lock after session completion for usage_recorded and token_checkpoint. Same window is open for git_metrics_recorded. Appends are sequential (not concurrent) to avoid SESSION_LOCK_REENTRANT. Acceptable.

---

## Failure Mode Review

**FM-1 (git not installed / not a git repo):** Reader returns null, captureConfidence='none'. Handled.

**FM-2 (enormous git diff output):** CRITICAL -- execFile buffers all output before return. Without `maxBuffer` set, pathological repos could OOM the process. Required fix: set `maxBuffer: 5 * 1024 * 1024` on the execFile call AND implement line-count truncation. Both required.

**FM-3 (SESSION_LOCK_REENTRANT on concurrent calls):** Handled by sequential await in async IIFE.

**FM-4 (git diff timeout):** 10000ms timeout. On timeout, execFile throws, reader returns null, captureConfidence='partial'. Handled.

**FM-5 (post-completion appendEvent silent failure):** Consistent with existing pattern (usage_recorded, token_checkpoint). No observable signal but does not affect session correctness. Handled.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate D):** Extends run_completed captureConfidence to include 'partial'. Rejected -- violates [TEAM_RULE] run_completed schema unchanged. No elements worth borrowing except the insight that outcome-success.ts captureConfidence condition can be fixed within the existing type constraint.

**Simpler alternative (skip git_start_recorded):** Fails AC-1. Start dirty state is useful (baseline for 'did the agent clean up staged changes'). Not worth skipping.

**Hybrid (one consolidated event):** Aesthetic only -- no architectural benefit. Not pursued.

---

## Philosophy Alignment

**Satisfied:** explicit domain types, errors as data, pure functions, determinism, timeouts as first-class, validate at boundaries, functional core / imperative shell.

**Tensions:**
- Make illegal states unrepresentable: `committedDiff: GitCommittedDiff | null` inside GitEvidence. Resolved by invariant: null = command failed (never zero-changes).
- Single source of state truth: dual captureConfidence fields (legacy run_completed + new gitEvidence). Resolved by documenting old field as legacy.

Both tensions are acceptable.

---

## Findings

### Red (blocking)
None.

### Orange (must fix in implementation)
**O-1:** `execFile` calls must set `maxBuffer: 5 * 1024 * 1024` (5MB). Without this, Node.js default maxBuffer (~1MB for older versions) or unlimited buffering before OOM could cause issues on large diffs. Required for FM-2 mitigation.

### Yellow (should address)
**Y-1:** `SessionMetricsV2.captureConfidence` (from run_completed) is now permanently broken ('none' for all sessions) but still exposed as a top-level field. Should add a `@deprecated` JSDoc comment directing consumers to use `gitEvidence.captureConfidence` instead.

**Y-2:** The `null = command failed` invariant for `committedDiff` and `workingTree` in `GitEvidence` must be documented in the type definition (JSDoc), not just in design docs.

---

## Recommended Revisions

1. **In reader.ts:** Add `maxBuffer: 5 * 1024 * 1024` to all execFile calls (addresses O-1).
2. **In session-metrics.ts:** Add `@deprecated` JSDoc on `captureConfidence` field directing to `gitEvidence.captureConfidence` (addresses Y-1).
3. **In types.ts:** Add JSDoc on `committedDiff` and `workingTree` nullable fields: 'null means the command failed or timed out; zero-change results return a zero-valued struct, not null' (addresses Y-2).

---

## Residual Concerns

- **Silent git event loss:** If recordGitMetrics fails silently (FM-5), there is no observable signal. Acceptable by established convention, but means the feature's effectiveness cannot be monitored from outside. Future work: a periodic audit of sessions without git_metrics_recorded events.
- **maxBuffer adequacy:** 5MB covers most repos, but a truly pathological diff (e.g. adding a generated file with millions of lines) could still exceed it. The truncation logic is a secondary defense -- the maxBuffer is the primary defense against unbounded memory use.
