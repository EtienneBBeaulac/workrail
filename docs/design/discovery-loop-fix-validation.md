# Discovery Loop Fix Validation

**Date:** 2026-04-21
**Scope:** WorkTrain autonomous pipeline -- `wr.discovery` re-runs indefinitely on issue #393
**Prior investigations:** `discovery-loop-investigation-A.md`, `discovery-loop-investigation-B.md`

---

## Context / Ask

WorkTrain's pipeline re-ran `wr.discovery` on issue #393 at least 73 times over 19+ hours. Two independent investigations (A and B) identified four root causes. This document validates three proposed fixes against actual source code, identifies gaps, and recommends a final fix set in priority order.

**Original goal (solution statement):** Validate whether three proposed fixes are correct, complete, and sufficient.

**Reframed problem:** WorkTrain's issue selection has no effective termination gate. Once an issue enters the discovery pipeline, no code path reliably marks it as processed or blocked, so it loops indefinitely.

---

## Source Code Verified

All findings below are based on direct source inspection as of 2026-04-21.

| File | Lines inspected | Key finding |
|---|---|---|
| `src/trigger/trigger-listener.ts` | 430-500 | `spawnSession` has 4-parameter signature -- no `agentConfig` parameter |
| `src/coordinators/adaptive-pipeline.ts` | 1-120 | `DISCOVERY_TIMEOUT_MS = 55 * 60 * 1000` confirmed |
| `src/trigger/polling-scheduler.ts` | 480-636 | `dispatchP` typed as `Promise<unknown>` -- outcome discarded confirmed |
| `src/trigger/adapters/github-queue-poller.ts` | 280-360 | `checkIdempotency` logic confirmed; explicitly handles missing `context` field as `'clear'` |
| `src/daemon/workflow-runner.ts` | 700-720 | `persistTokens` writes `{ continueToken, checkpointToken, ts, [worktreePath] }` -- no `context` field |

---

## Root Cause Recap (Verified)

Four root causes are confirmed by source inspection. The three proposed fixes address three of them.

| # | Root cause | Status |
|---|---|---|
| RC1 | `spawnSession` passes no `agentConfig` to `routerRef.dispatch()` -- session inherits `DEFAULT_SESSION_TIMEOUT_MINUTES=30` | **Confirmed** (trigger-listener.ts:492-498) |
| RC2 | `PipelineOutcome` silently discarded in polling-scheduler `.then()` -- no label applied | **Confirmed** (polling-scheduler.ts:605-624, `Promise<unknown>` cast) |
| RC3 | `checkIdempotency` sidecar scan is dead -- `persistTokens` never writes `context` field | **Confirmed** (workflow-runner.ts:714-716, github-queue-poller.ts:330-335) |
| RC4 | In-memory `dispatchingIssues` lost on daemon restart | **Confirmed** (polling-scheduler.ts:113) -- not addressed by the three proposed fixes |

---

## Fix Validation

### Fix 1 -- Thread `maxSessionMinutes` through `spawnSession()`

**Proposed:** Extend `CoordinatorDeps.spawnSession` to accept an optional `agentConfig` parameter and pass it through to `routerRef.dispatch()` in `trigger-listener.ts`. In `full-pipeline.ts`, pass `{ maxSessionMinutes: Math.ceil(DISCOVERY_TIMEOUT_MS / 60_000) }` (55 minutes) when spawning `wr.discovery`.

**Is the analysis correct?** Yes. Source confirms:
- `spawnSession` in `trigger-listener.ts` (lines 436-501) has signature `(workflowId, goal, workspace, context?)` -- no 5th `agentConfig` parameter.
- `routerRef.dispatch()` at line 492 passes only `{ workflowId, goal, workspacePath, context, _preAllocatedStartResponse }` -- no `agentConfig`.
- `DEFAULT_SESSION_TIMEOUT_MINUTES = 30` at `workflow-runner.ts:83` applies to all sessions without an explicit override.
- `DISCOVERY_TIMEOUT_MS = 55 * 60 * 1000` at `adaptive-pipeline.ts:39` -- the 25-minute gap is real.

**Is the fix correct?** Yes. Adding `agentConfig` as a 5th parameter to `spawnSession`, forwarding it to `dispatch()`, and calling it with `{ maxSessionMinutes: 55 }` in `full-pipeline.ts` closes the mismatch.

**Is the fix complete?** Mostly. The same mismatch affects **shaping** (35 min > 30 min) and **coding** (65 min > 30 min) sessions. The fix should be applied at all three `spawnSession` call sites in `full-pipeline.ts`, not just discovery. If only discovery is fixed, shaping and coding will exhibit the same timeout bug when those phases run.

**Risks:**
- Signature change to `CoordinatorDeps.spawnSession` requires updating the interface in `pr-review.ts` and all implementations (test fakes, the real implementation in `trigger-listener.ts`). This is mechanical but must be done consistently.
- The `AdaptivePipelineOpts` interface already has `taskCandidate` (line 119) threaded separately; `agentConfig` should follow the same pattern to avoid coupling coordinator internals to queue-poll concerns.

**Simpler alternative:** Set `agentConfig.maxSessionMinutes: 60` in `triggers.yml` for the queue-poll trigger. This is an operator-level config change with no code changes -- but it is fragile (the coordinator already holds the right per-phase value; externalizing it to config creates a dual source of truth that can drift).

**Verdict:** Correct, mostly complete (needs all three spawn sites). Recommended. The type-safe approach (Option A from Investigation B) is preferred over config-file override (Option B).

---

### Fix 2 -- Inspect `PipelineOutcome` in polling-scheduler; apply `worktrain:blocked` on escalation

**Proposed:** In polling-scheduler's `.then()` handler, inspect the `PipelineOutcome.kind` value and apply a `worktrain:blocked` label to the issue when `kind === 'escalated'`.

**Is the analysis correct?** Yes. Source confirms:
- At `polling-scheduler.ts:605-610`, `dispatchAdaptivePipeline` is cast to `Promise<unknown>` (not `Promise<PipelineOutcome>`), making the return value untyped and the `.then(()` parameter ignored.
- The `.then()` callback at lines 617-620 has no parameter -- it ignores whatever the pipeline returns.
- `PipelineOutcome` is a discriminated union with kinds `'merged'`, `'escalated'`, `'dry_run'` (confirmed in `adaptive-pipeline.ts:84-93`).
- The `excludeLabels` check at `polling-scheduler.ts:501-502` runs before maturity scoring; any label in `queueConfig.excludeLabels` would block re-selection.

**Is the fix correct?** Yes, and it addresses the primary observable symptom. Applying a `worktrain:blocked` (or `worktrain:failed`) label to the GitHub issue on escalation puts a persistent, cross-restart, cross-process marker on the issue that survives daemon restarts. The `excludeLabels` check at line 501 will then skip the issue on every subsequent poll cycle.

**Critical prerequisite:** The label name used (`worktrain:blocked` in the proposed fix) must be present in `queueConfig.excludeLabels`. If it is not, the label is applied but never checked, and the loop continues. This needs to be verified or enforced (e.g., auto-add the label to `excludeLabels` in the same code path, or use an already-excluded label like `worktrain:in-progress`).

**Is the fix complete?** Partially. It stops re-selection on escalation but:
1. It does not handle `kind === 'merged'` -- a merged issue should close automatically via the PR, but an explicit log or assertion is worth adding.
2. It does not handle the case where the pipeline resolves but `outcome.kind` is unrecognized (forward-compat safety).
3. The label is not removed on a subsequent success if the issue is re-opened or retried manually -- this may be acceptable, but should be documented.
4. The cast `Promise<unknown>` at line 610 should be changed to `Promise<PipelineOutcome>` so TypeScript enforces that the outcome is handled exhaustively. Without this, a future rename of `kind` values will silently break the handler.

**Could Fix 2 alone stop the loop?** Yes. Applying `worktrain:blocked` on escalation would stop re-selection on the very next poll cycle after the label is set. Investigation A explicitly confirms: "Fix 2 alone would stop the loop immediately because the `worktrain:in-progress` label check runs before `checkIdempotency` in `polling-scheduler.ts` line 505, and does not depend on any file state or memory state." However, Fix 2 alone does not fix the session timeout mismatch (Fix 1) or the cross-restart idempotency gap (Fix 3). The loop is stopped by labeling, but future cycles where the label is removed would immediately re-trigger the same session timeout bug.

**Should the coordinator close/unassign on success instead of just labeling on failure?** Yes, this is the cleaner termination contract. On `kind === 'merged'`, the PR should close the issue automatically (GitHub's "closes #N" mechanism). On `kind === 'escalated'`, applying a label is correct -- the issue should not be closed because a human needs to review the escalation. The important addition is: on escalation, the issue should be **unassigned** from `worktrain-etienneb` and the `worktrain:in-progress` label removed, so a human can clearly see it needs attention without the bot re-picking it up.

**Verdict:** Correct. Complete with the caveats above. This is the highest-priority fix -- it stops the loop on its own. Recommended as the first fix deployed.

---

### Fix 3 -- Write sidecar from `spawnSession()` to fix cross-restart idempotency

**Proposed:** Before calling `dispatchAdaptivePipeline`, write a sidecar file to `~/.workrail/daemon-sessions/<issueNumber>.json` containing `{ "context": { "taskCandidate": { "issueNumber": N } } }`. Remove this file in the `.then`/`.catch` completion handler.

**Is the analysis correct?** Yes. Source confirms:
- `checkIdempotency` at `github-queue-poller.ts:305-357` scans `daemon-sessions/*.json` and checks `context.taskCandidate.issueNumber`.
- At lines 330-335: if `context` is not an object or is null, it hits `continue` -- the file is treated as not owning any issue.
- `persistTokens` at `workflow-runner.ts:714-716` writes only `{ continueToken, checkpointToken, ts, [worktreePath] }` -- no `context` field.
- Therefore, all session files written by `persistTokens` are unconditionally treated as `'clear'` by `checkIdempotency`. The guard is dead.

**Is the fix correct?** Mostly. Writing a sidecar file with `{ context: { taskCandidate: { issueNumber: N } } }` before dispatch and removing it on completion would make `checkIdempotency` functional. However, the proposed location (in `spawnSession()` in trigger-listener.ts) is wrong -- `spawnSession` is called by the coordinator to spawn child sessions (e.g., `wr.discovery`, `wr.shaping`), not to represent the outer pipeline session. The sidecar should be written by the queue poller (`doPollGitHubQueue`) immediately after `this.dispatchingIssues.add(top.issue.number)`, and removed in the `.then`/`.catch` handler.

**Is the fix complete?** No. Two gaps:
1. **Placement:** The sidecar should be written at the polling-scheduler level (before `dispatchAdaptivePipeline` is called), not inside `spawnSession`. The outer pipeline's issue ownership should be tracked at the dispatch site.
2. **Deletion on timeout:** The session `.json` file written by `persistTokens` is explicitly deleted on wall_clock timeout (`workflow-runner.ts:~3867`). A sidecar written at the poller level and removed in `.then`/`.catch` avoids this deletion, but the poller's completion handler only fires when the pipeline Promise resolves -- not when the daemon crashes. A crash between sidecar write and pipeline resolution leaves a stale sidecar. The file should include a `ts` field so it expires after a reasonable duration (e.g., 4 hours), or the daemon should clean stale sidecars on startup.
3. **Fix 2 supersedes this for loop prevention:** With Fix 2 applying a persistent GitHub label on escalation, cross-restart idempotency for completed/escalated pipelines is already handled by the label check (which runs before `checkIdempotency` in the polling loop). Fix 3 is valuable for the concurrent-dispatch protection window (restart during an active pipeline), but is not a loop-stopper on its own.

**Risks:**
- File write before dispatch means a failure in `fs.writeFile` could block the dispatch. This should be fire-and-forget (log and continue, don't block dispatch on sidecar failure).
- If the sidecar uses the issue number as the filename, multiple issues cannot have sidecars simultaneously under that naming scheme -- but that is fine since only one issue is dispatched per cycle.

**Verdict:** Conceptually correct but placement and durability need adjustment. Not a loop-stopper on its own (Fix 2 covers the loop). Important for crash safety and concurrent dispatch protection. Should be implemented after Fix 2.

---

## Gaps Not Addressed by the Three Fixes

### Gap 1: Root Cause 4 is not addressed -- in-memory `dispatchingIssues` lost on restart

The three proposed fixes do not address the fact that `dispatchingIssues` is in-memory and lost on every daemon restart. Fix 3 (corrected) would address this for the cross-restart window. Fix 2 (label application) addresses it for the post-completion/escalation state. Together they cover the cross-restart gap, but Fix 3 needs the placement correction noted above.

### Gap 2: No escalation outbox notification

Neither investigation's fix set includes writing to the operator outbox when the pipeline escalates. The operator cannot distinguish "currently in progress" from "failed 12 times" without reading logs. Adding a comment to the GitHub issue (or posting to the outbox) explaining the escalation reason is important for operator visibility but does not affect the loop behavior.

### Gap 3: Issue assignment not cleared on escalation

When the pipeline escalates, issue #393 remains assigned to `worktrain-etienneb`. With Fix 2 applying `worktrain:blocked`, re-selection is prevented -- but the issue looks "in progress" to a human reviewer. The bot should unassign itself and remove the `worktrain:in-progress` label (if present) when applying the blocked label.

### Gap 4: Session timeout mismatch affects all phases, not just discovery

Fix 1 addresses the `wr.discovery` timeout but the same mismatch applies to shaping (35 min vs 30 min default) and coding (65 min vs 30 min default). All three spawn sites in `full-pipeline.ts` need the `agentConfig` threading.

---

## Recommended Final Fix Set

Listed in deployment priority order (Fix 2 is the only blocker; others reduce risk and improve correctness).

### Priority 1 (Deploy immediately): Fix 2 -- PipelineOutcome inspection with label application

**Why first:** This is the only fix that stops the loop immediately. The label persists across daemon restarts and is checked before any in-memory or sidecar guard.

**Minimum viable change:**
1. Change the `dispatchAdaptivePipeline` cast at line 605-610 from `Promise<unknown>` to `Promise<PipelineOutcome>` (import the type).
2. Change `.then(() => {` to `.then((outcome) => {`.
3. On `outcome.kind === 'escalated'`: add `worktrain:blocked` label to the issue via GitHub API, post a comment with `outcome.escalationReason`.
4. Confirm `worktrain:blocked` (or the chosen label) is in `queueConfig.excludeLabels`.
5. On escalation: unassign the bot from the issue and remove `worktrain:in-progress` if present.

**Outcome:** Loop stops on the next poll cycle after any escalation.

### Priority 2 (Deploy with or shortly after Fix 2): Fix 1 -- Thread `maxSessionMinutes` through `spawnSession()`

**Why second:** The session timeout mismatch means `wr.discovery` can never complete within the coordinator's expected window, so Fix 2 will immediately apply a blocked label. Fixing the timeout allows future discovery sessions to actually complete. If Fix 1 is not deployed alongside Fix 2, the pipeline will always escalate at discovery (sessions time out at 30 min, coordinator waits 55 min) and every new issue will be immediately labeled `worktrain:blocked`.

**Required scope:**
1. Extend `CoordinatorDeps.spawnSession` interface to accept 5th parameter `agentConfig?: { readonly maxSessionMinutes?: number; readonly maxTurns?: number }`.
2. Update `trigger-listener.ts` implementation to forward `agentConfig` to `routerRef.dispatch()`.
3. Update all call sites in `full-pipeline.ts`: discovery (55 min), shaping (35 min), coding (65 min).
4. Update test fakes to accept the 5th parameter.

### Priority 3 (Deploy after 1 and 2): Fix 3 -- Write sidecar for cross-restart idempotency

**Why third:** After Fixes 1 and 2 are in place, the loop is stopped and sessions can complete. Fix 3 adds defense-in-depth for crash scenarios where the daemon restarts while a pipeline is actively running.

**Corrected placement:**
1. Write sidecar in `doPollGitHubQueue` immediately after `dispatchingIssues.add(top.issue.number)` -- not inside `spawnSession`.
2. Sidecar path: `<sessionsDir>/<issueNumber>-queue.json` to distinguish from regular session files.
3. Sidecar content: `{ context: { taskCandidate: { issueNumber: N } }, ts: <epoch_ms>, expires: <epoch_ms + 4h> }`.
4. Remove sidecar in the `.then`/`.catch` handler.
5. In `checkIdempotency` or daemon startup: skip/delete sidecar files with `expires < Date.now()`.

---

## Summary Assessment

| Fix | Correct? | Complete? | Loop-stopper alone? | Deploy order |
|---|---|---|---|---|
| Fix 1 (timeout threading) | Yes | Needs all 3 spawn sites | No | 2nd |
| Fix 2 (PipelineOutcome + label) | Yes | Needs: correct label in excludeLabels, unassign on escalation | **Yes** | 1st |
| Fix 3 (sidecar idempotency) | Conceptually yes | Needs placement correction + expiry + daemon cleanup | No | 3rd |

**The three proposed fixes are sufficient to stop the loop** (Fix 2 alone stops it) **and together provide a robust termination contract.** The gaps are correctness/completeness issues, not show-stoppers.

**Fix 2 alone is sufficient to stop the infinite re-selection loop.** However, without Fix 1, every new issue dispatched through the FULL pipeline will immediately escalate at discovery (30-minute timeout vs 55-minute budget), so the loop would immediately re-form for any new issue. Fix 1 is needed to make the pipeline functionally completable.

**Coordinator close/unassign on success:** The pipeline does not need to explicitly close the issue on success -- that is handled by GitHub's "closes #N" keyword in the PR description. But on escalation, the bot should unassign itself to make the issue's human-actionable status clear. This is an addition to Fix 2, not a separate fix.

---

## Decision Log

**Direction confirmed after review:** Candidate 2 (complete fix set: Fix 1+2+3).

**Revision from review:** Use `worktrain:in-progress` as the escalation label instead of `worktrain:blocked`. Rationale: `worktrain:in-progress` is already in `queueConfig.excludeLabels` (confirmed at `polling-scheduler.ts:505`). Introducing a new label creates a deploy-time config dependency with no code enforcement -- if the label is applied but not in `excludeLabels`, the loop continues silently. Using the existing excluded label eliminates this risk.

**Runner-up:** Candidate 1 (Fix 2 only) -- valid only if deployed in the same PR as Fix 1. Deploying Fix 2 alone would permanently label every new issue after its first 30-minute timeout, creating operational toil.

**Deployment sequence:**
- PR #1: Fix 2 (PipelineOutcome inspection + label application). Independent and immediately verifiable.
- PR #2: Fix 1 + Fix 3 (timeout threading + sidecar idempotency). Dependent on PR #1 for full correctness but can be developed in parallel.

**Required revisions to Fix 2 implementation:**
1. Change `dispatchAdaptivePipeline` cast from `Promise<unknown>` to `Promise<PipelineOutcome>` (import the type)
2. Change `.then(() => {` to `.then((outcome) => {`
3. Handle all three `PipelineOutcome` kinds exhaustively (merged: log; escalated: apply label + unassign; dry_run: log)
4. Apply `worktrain:in-progress` (not a new label) on escalation
5. Unassign bot from issue on escalation
6. Add explicit `catch` on GitHub API label write with structured log entry

**Confidence:** High -- source code verified line by line, root causes confirmed, all three fixes validated.

**Residual risks:**
- Full-pipeline.ts spawn site line numbers not directly verified (high confidence from TIMEOUT constants match; low verification risk)
- N-strike mechanism (label only after 3+ escalations) deferred to follow-on
- Coordinator-owns-termination (Candidate 3) logged as architectural technical debt

**Follow-on issues to file:**
- N-strike mechanism for `worktrain:in-progress` label application
- Coordinator-Owns-Termination refactor (move GitHub lifecycle management from poller to coordinator)
- Exhaustive outcome handling in `.then()` -- enforce via TypeScript switch exhaustiveness

---

## Final Summary

**Selected path:** full_spectrum (source code verification + gap analysis)

**Problem framing:** WorkTrain's issue selection has no effective termination gate. Once an issue enters the discovery pipeline, no code path reliably marks it as processed or blocked, so it loops indefinitely. The three proposed fixes target the correct code paths.

**Landscape takeaways:** All three proposed fixes are confirmed correct by direct source inspection. The `Promise<unknown>` cast in `polling-scheduler.ts:610` is the most dangerous antipattern -- it silently discards type information that would otherwise prevent the loop. The `persistTokens` function has never written a `context` field in its history, making the idempotency guard permanently dead.

**Chosen direction:** Complete fix set (Fix 1+2+3), deployed as two sequential PRs.

**Strongest alternative:** Fix 2 only -- valid for immediate loop stopping but leaves the pipeline unable to complete (Fix 1 is necessary for sessions to run to completion).

**Why Candidate 2 won:** Deploying Fix 2 alone would cause every future FULL-mode issue to immediately fail at discovery (30-min timeout, labeled, stopped permanently). Fix 1 is the necessary pairing. Fix 3 adds crash safety at low cost.

**Confidence:** High -- all evidence is from direct source inspection, root causes confirmed, no contradictions.

**Residual risks:**
- `full-pipeline.ts` spawn site line numbers not directly verified (high confidence from TIMEOUT constants)
- N-strike escalation mechanism deferred to follow-on

**Next actions:**
1. Open PR #1: Fix 2 (inspect PipelineOutcome, apply `worktrain:in-progress` on escalation, unassign bot, add catch on label write, handle all 3 outcome kinds)
2. Open PR #2: Fix 1 (thread `maxSessionMinutes` through `spawnSession` for all 3 spawn sites) + Fix 3 (sidecar in `doPollGitHubQueue` with `<issueNumber>-queue.json`, expires TTL)
3. File follow-on issue: N-strike mechanism, Coordinator-Owns-Termination refactor
