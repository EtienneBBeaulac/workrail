# Discovery Loop Fix -- Design Candidates

**Date:** 2026-04-21
**Context:** Candidates generated as part of `wr.discovery` workflow validation. Final recommendations live in `discovery-loop-fix-validation.md`.

---

## Problem Understanding

**Core tensions:**
1. Fire-and-forget dispatch (scalability) vs. outcome-aware cleanup (correctness). The existing `void dispatchP` pattern is right for responsiveness but wrong when cleanup requires type information from the result.
2. In-memory state (fast, zero I/O) vs. persistent state (crash-safe, cross-restart). `dispatchingIssues` Set is fine for within-process dedup but fails on daemon restart.
3. Coordinator budget vs. runner default. `DISCOVERY_TIMEOUT_MS=55min` (adaptive-pipeline.ts:39) and `DEFAULT_SESSION_TIMEOUT_MINUTES=30` (workflow-runner.ts:83) are owned by different concerns with no structural coupling.

**Likely seam:** The queue-poller/pipeline boundary in `polling-scheduler.ts`. The poller fires a `Promise<unknown>` and discards the typed `PipelineOutcome`. This is where the fix belongs.

**What makes it hard:**
- Three root causes are independent but interact -- fixing only one leaves the others active
- The idempotency guard `checkIdempotency` looks correct but is dead because session files never contain the `context` field it looks for
- The `Promise<unknown>` cast is a one-line antipattern that silently disables the type system

---

## Philosophy Constraints

From `CLAUDE.md` and observed repo patterns:
- **Type safety as first line of defense** -- `Promise<unknown>` cast violated this; fix must restore it
- **Make illegal states unrepresentable** -- session timeout and coordinator budget should be structurally coupled, not independently configured
- **Errors are data** -- `PipelineOutcome` is a proper Result-style discriminated union; the caller must inspect it
- **Exhaustiveness everywhere** -- the discriminated union demands all `kind` values be handled
- **YAGNI with discipline** -- incident response should be minimal; architectural refactors are follow-on

---

## Impact Surface

- `queueConfig.excludeLabels`: adding a label changes which issues are globally excluded from selection
- `CoordinatorDeps.spawnSession` interface in `pr-review.ts`: changing the signature requires updating all implementations and test fakes
- GitHub API calls from `polling-scheduler.ts`: new failure mode -- API error on label write must not crash the daemon
- `full-pipeline.ts` spawn sites: all three (discovery, shaping, coding) need the `agentConfig` threading for completeness

---

## Candidates

### Candidate 1 -- Minimal Viable: Fix 2 only (PipelineOutcome inspection + label)

**Summary:** In `polling-scheduler.ts`, change the `dispatchAdaptivePipeline` cast from `Promise<unknown>` to `Promise<PipelineOutcome>`, add `(outcome)` parameter to `.then()`, and on `outcome.kind === 'escalated'` apply `worktrain:blocked` label to the issue via GitHub API. Add `worktrain:blocked` to `queueConfig.excludeLabels`.

**Tensions resolved:** Loop prevention via persistent external signal. Fire-and-forget semantics preserved (label write is inside non-blocking `.then()`).

**Tensions accepted:** Session timeout mismatch not fixed. Discovery still dies at 30 min; loop stops by label rather than by completion. Future new issues will also be immediately labeled `worktrain:blocked` after their first 30-minute timeout.

**Boundary:** Queue-poller/pipeline boundary in `polling-scheduler.ts`. Correct seam -- this is where the issue lifecycle decision lives.

**Why this boundary is best-fit:** The poller owns issue selection and skipping. Adding label writes to the completion handler keeps the concern co-located with the dispatch decision.

**Failure mode:** GitHub API error on label write. Must be caught and logged; daemon must not crash. Add try/catch around the label write.

**Repo-pattern relationship:** Adapts existing `excludeLabels` check and `worktrain:in-progress` label pattern. No new patterns introduced.

**Gains:** Stops the loop immediately with ~20 lines of code change. Single file. Deployable today.

**Losses:** Sessions still time out -- future issues will hit the same 30-minute wall. Every new issue needs manual label removal to be retried.

**Scope judgment:** Best-fit for incident response. Too narrow for a production fix.

**Philosophy fit:** Restores type safety (removes `unknown` cast). Honors 'errors are data'. YAGNI-compatible for an incident fix.

---

### Candidate 2 -- Complete Fix Set: Fixes 1+2+3

**Summary:** Apply all three fixes. (1) Extend `CoordinatorDeps.spawnSession` to accept 5th param `agentConfig?: { readonly maxSessionMinutes?: number }` and forward it to `routerRef.dispatch()` in `trigger-listener.ts`; update all three spawn sites in `full-pipeline.ts` with the correct per-phase timeout (discovery=55, shaping=35, coding=65). (2) Fix 2 as above. (3) Write issue-ownership sidecar file to `~/.workrail/daemon-sessions/<issueNumber>-queue.json` in `doPollGitHubQueue` before dispatch, delete it in `.then`/`.catch`.

**Tensions resolved:** All three root causes addressed. Session completes successfully. Cross-restart safety via sidecar + label.

**Tensions accepted:** Larger changeset requiring test fake updates. Sidecar write adds new I/O path.

**Boundary:** Three seams simultaneously -- session timeout (trigger-listener + full-pipeline), outcome discard (polling-scheduler), idempotency (polling-scheduler + doPollGitHubQueue).

**Why this boundary is best-fit:** Each fix is at the correct seam. Fixing all three is coherent because they address separate failure modes in the same execution path.

**Failure mode:** Sidecar write failure could in theory block dispatch -- must be fire-and-forget (log error, continue). `agentConfig` threading requires updating `CoordinatorDeps` interface in `pr-review.ts` and all test fakes.

**Repo-pattern relationship:** Fix 1 follows the same pattern as `context?` threading in `spawnSession`. Fix 2 restores PipelineOutcome type safety. Fix 3 introduces a new naming convention for issue-ownership sidecars (distinguished from regular session files by `-queue.json` suffix).

**Gains:** Pipeline can actually complete successfully. Issue loop stops. Crash safety for concurrent dispatch window. All future issues benefit.

**Losses:** Larger changeset. More test updates. Slightly more complex `.then()` handler.

**Scope judgment:** Best-fit for a production fix. Slightly broad for incident response only (Fix 1 is not strictly needed to stop the loop).

**Philosophy fit:** Best alignment. Restores type safety, exhaustiveness, and structural coupling of timeout values.

---

### Candidate 3 -- Architectural: Coordinator-Owns-Termination

**Summary:** Move issue lifecycle management out of the queue poller and into the adaptive coordinator. After `runAdaptivePipeline` returns `PipelineOutcome`, the coordinator calls GitHub API via an injected dep to (a) apply `worktrain:blocked` + unassign on `kind === 'escalated'`, (b) close issue on `kind === 'merged'`. Queue poller becomes a pure selector -- it only reads from GitHub, never writes back.

**Tensions resolved:** Clean separation of concerns -- selector (poller) and executor (coordinator) are fully decoupled. Coordinator owns its own cleanup.

**Tensions accepted:** Coordinator gains a GitHub API dependency it currently does not have. Requires extending `AdaptiveCoordinatorDeps` with a `labelIssue(issueNumber, labels)` dep and threading issue context into the coordinator opts.

**Boundary:** The coordinator's `runAdaptivePipeline` function in `adaptive-pipeline.ts` / `full-pipeline.ts`. The coordinator already has `deps.postToOutbox` for side effects -- adding `deps.labelIssue` is consistent.

**Why this boundary is best-fit for the long run:** Whoever runs the pipeline should own its cleanup. This is the correct invariant for a production system. But today the coordinator has zero GitHub API surface.

**Failure mode:** Requires threading `issueNumber` into `AdaptivePipelineOpts` (currently has `taskCandidate?: Readonly<Record<string, unknown>>` -- untyped). Proper threading would need a typed `issueNumber?: number` field. Invasive but clean.

**Repo-pattern relationship:** Departs from existing pattern where GitHub API interactions live exclusively in the trigger layer. Introduces a new dep type into the coordinator.

**Gains:** Clean architectural invariant. Coordinator is self-contained. Poller logic simplifies.

**Losses:** Invasive change to coordinator interface. Out of scope for incident response. Adds deps to coordinator that have no tests yet.

**Scope judgment:** Too broad for incident response. Correct long-term architecture.

**Philosophy fit:** Honors 'architectural fixes over patches'. Conflicts with YAGNI for incident response.

---

## Comparison and Recommendation

| Criterion | Candidate 1 | Candidate 2 | Candidate 3 |
|---|---|---|---|
| Stops the loop | Yes | Yes | Yes |
| Pipeline can complete | No | Yes | Yes |
| Cross-restart safe | Partially | Fully | Fully |
| Scope | Minimal | Medium | Large |
| Test impact | Low | Medium | High |
| Philosophy fit | Good | Best | Good (long-term) |

**Recommendation: Candidate 2 (complete fix set)**

Rationale: Candidate 1 stops the loop but immediately creates a new operational burden -- every new issue that fails discovery gets permanently labeled `worktrain:blocked` and requires manual label removal. Candidate 2 is the correct production fix. Fix 1 is the necessary pairing with Fix 2; without it, every issue through FULL mode hits the 30-minute wall regardless.

Candidate 3 is the right long-term architecture but wrong scope for an incident fix.

---

## Self-Critique

**Strongest counter-argument to Candidate 2:** The signature change to `CoordinatorDeps.spawnSession` touches multiple files and test fakes. For an incident response, Candidate 1 (Fix 2 only) stops the loop with 5 minutes of work; Fix 1 can be a follow-on PR. The recommendation depends on how urgent the 'pipeline must complete' requirement is vs. 'loop must stop now'.

**Pivot conditions:**
- If operator can accept manual label removal for retry: deploy Candidate 1 now, Candidate 2 in the next sprint
- If the codebase has comprehensive test coverage of `spawnSession`: use Candidate 2 immediately (the interface change is mechanical)
- If coordinator already has GitHub API deps: Candidate 3 becomes feasible scope

**Invalidating assumption:** If `queueConfig.excludeLabels` is not configurable at deploy time, Fix 2's label has no effect. Verify the label name appears in the config before deploying.

---

## Open Questions for the Main Agent

1. Should `worktrain:blocked` be a permanent label, or should it have a TTL so transient failures can be retried autonomously after N hours?
2. Should the sidecar file (Fix 3) use the issue number as the key (not the session ID) to survive session deletion on timeout?
3. Should Fix 2 also remove the `worktrain:in-progress` label and unassign the bot from the issue when applying `worktrain:blocked`?
4. Does the coordinator need to post a GitHub comment on escalation so the operator knows what happened?
