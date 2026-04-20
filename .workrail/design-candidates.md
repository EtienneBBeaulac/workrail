# Design Candidates: queue-config separate file (fix/queue-config-separate-file)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Problem Understanding

### Core Tensions

1. **Two systems, one config file**: WorkRail MCP validates `config.json` as a flat string-value map; WorkTrain needs a nested `queue` object. These constraints are incompatible in a shared file. The fix separates them at the filesystem level.
2. **Exported constant name vs value**: `WORKRAIL_CONFIG_PATH` is exported. Changing its value changes the effective config path for all callers. No external callers import it (confirmed by grep), so risk is contained.

### Likely Seam

`WORKRAIL_CONFIG_PATH` constant in `src/trigger/github-queue-config.ts` (line 110). This is the only place that hard-codes the config path. Callers use `loadQueueConfig()` with no arguments and pick up the default automatically.

### What Makes This Hard

Nothing technically hard. Risks: (1) a caller importing `WORKRAIL_CONFIG_PATH` directly expecting `config.json` -- confirmed none exist; (2) a test mocking the file path -- confirmed none exist.

---

## Philosophy Constraints

- **Document 'why', not 'what'**: The WHY comment block is required and directly addresses this principle.
- **Architectural fixes over patches**: Separating config files at the path level is an architectural fix.
- **YAGNI with discipline**: Change only the path; do not rename the constant or refactor callers.

---

## Impact Surface

- `src/trigger/polling-scheduler.ts` line 384: `loadQueueConfig()` -- no args, picks up new default automatically.
- `src/cli-worktrain.ts` line 1298: `loadQueueConfig()` -- no args, same.
- No other callers import `WORKRAIL_CONFIG_PATH` directly.
- No tests mock the config file path.

---

## Candidates

### Candidate A: Change constant value only (Recommended)

**Summary**: Change `WORKRAIL_CONFIG_PATH` value from `~/.workrail/config.json` to `~/.workrail/queue-config.json`. Add WHY comment block. Update JSDoc. No renames.

- **Tensions resolved**: Separates the two systems' configs at the filesystem level.
- **Tensions accepted**: Constant name `WORKRAIL_CONFIG_PATH` is slightly misleading post-change.
- **Boundary**: The exported constant default value -- the correct seam.
- **Failure mode**: Future developer sees `WORKRAIL_CONFIG_PATH` and incorrectly reverts it. WHY comment mitigates this.
- **Repo pattern**: Follows. Injectable default param already in place.
- **Scope**: Best-fit. Task specifies 'targeted fix, not a refactor.'
- **Philosophy**: Honors YAGNI, document-why, architectural fixes.

### Candidate B: Rename constant + change value

**Summary**: Rename `WORKRAIL_CONFIG_PATH` to `WORKRAIL_QUEUE_CONFIG_PATH` and change the value.

- **Tensions resolved**: Same as A, plus self-documenting constant name.
- **Scope judgment**: Slightly too broad. Task says change the path, not rename the constant.
- **Philosophy**: Conflicts with YAGNI.

### Candidate C: New loader function

**Summary**: Add `loadQueueConfigFromSeparateFile()` using the new path; deprecate old default.

- **Scope judgment**: Too broad. Task explicitly says 'targeted fix, not a refactor.' Rejected.

---

## Comparison and Recommendation

**Recommendation: Candidate A.** All three candidates resolve the core tension the same way. Given the explicit constraint 'targeted fix, not a refactor,' A is correct. The WHY comment addresses the only real risk.

---

## Self-Critique

**Strongest argument against A**: `WORKRAIL_CONFIG_PATH` name is now misleading.
**Mitigated by**: The WHY comment block explains the separation explicitly.
**Invalidating assumption**: None -- this is not a published library with external consumers.

---

## Open Questions for Main Agent

None. Task is fully specified, scope is clear, no human decisions required.

---
---

# Design Candidates: GitHub Issue Queue Poll Trigger (#4)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Problem Understanding

### Core Tensions

1. **Queue-poll semantics vs event-poll semantics**: Existing polling providers (gitlab_poll, github_issues_poll, github_prs_poll) use `PolledEventStore` for at-least-once delivery -- each new item is a unique event to dispatch. The queue poller is fundamentally different: it selects ONE candidate from the full issue list per cycle and only dispatches if no active session exists for that issue. Reusing `dispatchAndRecord()` would be semantically wrong.

2. **Bot identity placement**: Setting `git config user.name` requires running after worktree creation, which happens inside `workflow-runner.ts`. The trigger adapter dispatches a `WorkflowTrigger` consumed by workflow-runner. The seam is `WorkflowTrigger.botIdentity?: { name: string; email: string }` field -- but this requires touching a file not explicitly listed in the pitch's modified-files list.

3. **`events:` required field vs new provider**: All existing polling providers require `source.events:` in triggers.yml. The `github_queue_poll` provider does NOT use events (queue filter comes from `~/.workrail/config.json`). The assembly path in trigger-store.ts must skip the events check for this provider without breaking existing providers.

4. **Conservative idempotency default**: Idempotency check scans `~/.workrail/daemon-sessions/*.json`. Parse errors must default to `'active'` (skip), not `'clear'` (proceed). This is a correctness invariant -- double-dispatch is worse than missed dispatch.

### Likely Seam

The `PollingScheduler.doPoll()` switch statement and the new `doPollGitHubQueue()` method. Config is loaded at runtime from `~/.workrail/config.json` (not from triggers.yml), making this provider structurally different from existing ones.

### What Makes This Hard

- The `events:` required-field check in trigger-store.ts must be bypassed for `github_queue_poll` without breaking the existing if/else chain.
- Bot identity must run AFTER worktree creation in workflow-runner.ts -- timing invariant that cannot be satisfied from the scheduler (dispatch is fire-and-forget).
- The idempotency default-to-active rule is a critical invariant that a junior developer would likely get wrong (catch block returning `'clear'` is the natural mistake).

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md` and repo patterns:

- **Errors as data**: `Result<T, E>` from `src/runtime/result.ts`. No throws at public function boundaries.
- **Make illegal states unrepresentable**: Discriminated union on `PollingSource.provider`. `github_queue_poll` without a `source:` block = hard error at config load.
- **DI for boundaries**: `FetchFn` injectable in all adapters. `DaemonRegistry | undefined` injectable in PollingScheduler.
- **Validate at boundaries**: trigger-store.ts validates all fields; adapter receives already-validated types.
- **Immutability**: All interfaces use `readonly`, `readonly string[]`.
- **Architectural fixes over patches**: Bot identity via `WorkflowTrigger.botIdentity` field (not LLM bash call).
- **YAGNI with discipline**: Exactly 3 heuristics. Non-assignee types throw `not_implemented` (no silent fallback).

No philosophy conflicts between stated principles and repo practice.

---

## Impact Surface

Files that must stay consistent:

- `src/trigger/types.ts` -- `PollingSource` union; adding `github_queue_poll` arm forces exhaustiveness in all switch statements on `pollingSource.provider`
- `src/trigger/trigger-store.ts` -- `SUPPORTED_PROVIDERS` set; `isPollingProvider` boolean; `source:` assembly block
- `src/trigger/polling-scheduler.ts` -- `doPoll()` switch default branch is currently `never`-typed; adding new arm keeps it correct
- `src/daemon/workflow-runner.ts` -- `WorkflowTrigger` interface; worktree creation block (lines 3023-3079)
- `tests/unit/github-queue-poller.test.ts` -- new test file, no existing contracts to maintain

---

## Candidates

### Candidate A: Pitch-as-Spec (Recommended)

**Summary**: Implement exactly what the pitch specifies -- new union arm, new adapter, queue config loader, `doPollGitHubQueue()` in scheduler, no PolledEventStore, JSONL logging, bot identity via `WorkflowTrigger.botIdentity?: { name: string; email: string }` optional field checked after worktree creation in workflow-runner.ts.

- **Tensions resolved**: Correct queue-poll semantics (no PolledEventStore reuse), deterministic bot identity, skip `events:` for queue provider, conservative idempotency
- **Tensions accepted**: Small touch to `workflow-runner.ts` (outside explicit modified-files list)
- **Boundary**: `src/trigger/` (primary) + `src/daemon/workflow-runner.ts` (bot identity only)
- **Why best fit**: The pitch's pre-implementation checklist explicitly requires bot identity. workflow-runner.ts is the only correct placement. `src/mcp/` is the only explicitly excluded directory.
- **Failure mode**: `botIdentity` field present in non-queue sessions (undefined by default -- no-op, harmless)
- **Repo pattern**: Adapts `github-poller.ts` FetchFn pattern. Adapts `doPollGitHub()` structure. Departs from `dispatchAndRecord()` (correct -- different semantics).
- **Gain**: Correct architecture, type safety, deterministic bot identity, full pitch compliance
- **Give up**: One additional file touched (workflow-runner.ts)
- **Scope**: Best-fit
- **Philosophy**: Honors architectural-fixes-over-patches, errors-as-data, make-illegal-states-unrepresentable, DI for boundaries

### Candidate B: Skip Bot Identity (Minimal)

**Summary**: Same as A but skip `WorkflowTrigger.botIdentity` entirely. Instead inject `context.botIdentityHint: 'worktrain-etienneb'` so the agent can optionally call `git config`.

- **Tensions resolved**: No workflow-runner.ts change (zero blast radius there)
- **Tensions accepted**: Bot identity delegated to LLM (violates "scripts over agent" philosophy); non-deterministic; commits from queue sessions use developer's personal identity
- **Failure mode**: Agent may not call `git config`; privacy issue (personal email in commits); audit failure
- **Repo pattern**: Violates established pattern of deterministic git operations
- **Give up**: Correct bot attribution, determinism, compliance with pitch pre-implementation checklist
- **Scope**: Too narrow -- explicit pitch requirement not met
- **Philosophy conflicts**: Violates "architectural fixes over patches", "determinism over cleverness"

### Candidate C: Inline Queue Config in Triggers.yml

**Summary**: Instead of loading queue config from `~/.workrail/config.json` at runtime, embed all queue filter fields (`assignee`, `excludeLabels`, etc.) directly in the `source:` block of triggers.yml and parse them at load time.

- **Tensions resolved**: No runtime config file dependency; simpler per-session config (no `loadQueueConfig()` call)
- **Tensions accepted**: Queue config not shareable across triggers; changes to queue filter require daemon restart (not hot-reloadable); pitch explicitly designed `~/.workrail/config.json` as the config location
- **Failure mode**: Tight coupling between trigger definition and queue filter; no separation of concerns; contradicts the pitch's breadboard design
- **Repo pattern**: Follows triggers.yml parsing pattern but contradicts pitch's explicit design decision
- **Give up**: Flexibility, hot-reload of queue config, pitch compliance
- **Scope**: Departs from spec -- rejected

---

## Comparison and Recommendation

| | Bot identity | Pitch compliance | Blast radius | Philosophy fit |
|---|---|---|---|---|
| A | Deterministic (correct) | Full | +1 file (workflow-runner.ts) | Full |
| B | Non-deterministic | Partial | 0 extra files | Partial |
| C | N/A | No | Same as A | Partial |

**Recommendation: Candidate A.** The pitch has made all design decisions correctly. Candidate B violates the "scripts over agent" principle and has a real privacy risk. Candidate C contradicts the pitch's explicit design.

---

## Self-Critique

**Strongest argument against A**: The pitch's modified-files list does not include `workflow-runner.ts`. Touching a large, complex file risks regressions.

**Counter**: The change is a 5-line addition inside an existing `if (trigger.branchStrategy === 'worktree')` block. It is guarded by the new `trigger.botIdentity` optional field (undefined = no-op). The risk is very low. The pitch's scope constraint ("Do NOT touch `src/mcp/`") is explicit; `src/daemon/` has no such constraint.

**Narrower option that lost**: Candidate B -- saves 1 file but leaves bot identity non-deterministic. Not acceptable given the pitch's explicit pre-implementation requirement.

**Pivot conditions**:
- If `workflow-runner.ts` is definitively off-limits: fall back to Candidate B, document bot identity as a known gap, log a warning on dispatch.
- If `~/.workrail/config.json` loading fails consistently in tests: use an injectable `configReader` function in `doPollGitHubQueue()`.

---

## Open Questions for Main Agent

None. The pitch resolves all design decisions. Bot identity placement in workflow-runner.ts is the only judgment call, and the architectural fix is clearly correct.

---
---

# Design Candidates: queue poll tasks route to FULL/IMPLEMENT not REVIEW_ONLY (fix/queue-routes-to-full-not-review)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## Problem Understanding

### Core Tensions

1. **Two providers sharing one field**: `taskCandidate` was used as a proxy for `github_prs_poll` trigger identity, conflating the queue poller (`github_queue_poll`) with the PR poller (`github_prs_poll`). These are semantically distinct providers.
2. **Comment as contract**: The JSDoc on `taskCandidate` encoded the wrong assumption ("When present, the trigger provider is 'github_prs_poll'"). Fixing the code without fixing the comment leaves a landmine.
3. **Minimal fix vs type-level fix**: A thorough fix might encode `triggerProvider` as a typed discriminated union in `AdaptivePipelineOpts`, but that is out of scope.

### Likely Seam

`adaptive-pipeline.ts` lines 288-290. The wrong inference is made at the point where `triggerProvider` is derived from opts before being passed to `routeTask()`. This IS the real seam, not just the symptom location.

### What Makes This Hard

Nothing technically hard. The wrong JSDoc was the encoded assumption that led to the implementation. A junior developer would miss: (1) the JSDoc as a required fix, (2) the need for a test proving the fix at the `runAdaptivePipeline` level, not just `routeTask()`.

---

## Philosophy Constraints

- **YAGNI with discipline**: Change only lines 288-290 and the JSDoc. Do not refactor callers.
- **Architectural fixes over patches**: Remove the wrong inference entirely rather than patching around it.
- **Document 'why', not 'what'**: The JSDoc on `taskCandidate` encoded the wrong assumption -- it must be corrected.
- **Determinism**: Same inputs (opts with taskCandidate set, no triggerProvider) must always produce FULL, never REVIEW_ONLY.

No philosophy conflicts.

---

## Impact Surface

- `trigger-router.ts:dispatchAdaptivePipeline()` - constructs opts with no triggerProvider; after fix routes queue tasks to FULL/IMPLEMENT correctly.
- `polling-scheduler.ts:doPollGitHubQueue()` - calls dispatchAdaptivePipeline with taskCandidate; after fix FULL/IMPLEMENT routing is correct.
- Routing log signal `githubPrsPollProvider: triggerProvider === 'github_prs_poll'` - will now correctly be false for queue tasks.
- `tests/unit/route-task.test.ts` - unaffected (tests routeTask() directly).

---

## Candidates

### Candidate A: One-line fix + JSDoc correction (Recommended)

**Summary**: Replace lines 288-290 with `const triggerProvider = opts.triggerProvider;` and fix the misleading JSDoc on `taskCandidate`.

- **Tensions resolved**: Eliminates the false provider identity inference. Restores determinism.
- **Tensions accepted**: `AdaptivePipelineOpts` still does not type-encode the `taskCandidate`-comes-from-queue invariant.
- **Boundary**: `adaptive-pipeline.ts` lines 288-290 + JSDoc at line 113. Correct boundary.
- **Failure mode**: Future developer adds another `taskCandidate`-based inference. WHY comment and JSDoc fix mitigate this.
- **Repo pattern**: Follows. `opts.triggerProvider` was the correct field all along.
- **Scope**: Best-fit. User constraint: 'This is a one-line fix -- do not refactor surrounding code.'
- **Philosophy**: Honors YAGNI, architectural-fixes-over-patches, document-why, determinism.

### Candidate B: Type-level fix (out of scope)

**Summary**: Split `AdaptivePipelineOpts` into `QueueDispatchOpts` (has taskCandidate, no triggerProvider) and `TriggerDispatchOpts` (has triggerProvider, no taskCandidate) as a discriminated union.

- **Tensions resolved**: Makes the illegal state unrepresentable at compile time.
- **Scope judgment**: Too broad. Requires updating all callers, all test fakes, and the CLI entry point.
- **Explicit constraint**: User said 'do not refactor surrounding code.' Rejected.
- **Philosophy**: Honors 'make illegal states unrepresentable' but violates YAGNI and explicit user scope.

---

## Comparison and Recommendation

**Recommendation: Candidate A.** Candidates converge on the same core change. For a production hotfix with explicit scope constraints, A is the only valid choice. B is the ideal refactor for a future dedicated task.

---

## Self-Critique

**Strongest argument against A**: Does not prevent the same class of bug from reoccurring at the type level.
**Mitigated by**: JSDoc correction + WHY comment make the invariant explicit. The type-level fix is the correct next step for a future refactor task.
**Invalidating assumption**: If the PR poll path were to call `dispatchAdaptivePipeline` with `taskCandidate` set expecting REVIEW_ONLY. Confirmed it does not - the PR poller uses a completely separate dispatch path.

---

## Open Questions for Main Agent

None. Task is fully specified, scope is explicit, no human decisions required.
