# Session Metrics Attribution -- Hybrid Architecture Discovery

**Date:** 2026-04-21
**Status:** Discovery complete -- recommendation ready

---

## About This Document

Human-readable artifact for sharing findings and recommendations. NOT execution truth -- workflow session notes and context variables are the durable record. Read this for understanding, not for resuming the workflow.

---

## Context / Ask

**Stated goal (original):** Design the right hybrid architecture for attributing git metrics (LOC, files changed, commits) to a specific WorkRail session, accounting for concurrent sessions on the same branch.

**Goal classification:** `solution_statement` -- prescribes a specific hybrid architecture with confidence levels and agent SHA reporting rather than describing the outcome.

**Reframed problem:** Given that git attribution via branch or time-window is unreliable when sessions overlap on the same branch, what is the minimal durable record a WorkRail session needs to carry so consumers can compute accurate git metrics even under adversarial conditions?

**Prior discoveries:**
- Discovery 1: rejected agent self-reporting of LOC/files (unreliable, agents grade own homework)
- Discovery 2: found `buildSuccessOutcome()` + `extraEventsToAppend` as the hook point for a `run_completed` event; `observation_recorded` keys are locked; no event timestamps today

---

## Path Recommendation

**Selected path:** `design_first`

**Rationale:** The goal is already a well-formed solution statement, and the codebase landscape was thoroughly covered in Discoveries 1 and 2. The dominant risk is NOT "we don't know the landscape" -- it's "we're designing the wrong concept or solving a problem that's rarer than we think." `design_first` is correct here because:
- The specific concurrent same-branch attribution problem has not been validated as common
- The proposed solution (agent SHA self-reporting) has the same reliability failure mode as what Discovery 1 rejected
- The accumulation problem for commit SHAs across steps is architecturally non-trivial and hasn't been resolved

---

## Constraints / Anti-goals

**Core constraints:**
- `observation_recorded` has a CLOSED discriminated union key set -- extending it requires schema + handler updates
- `mergeContext` uses SHALLOW merge semantics (locked at §18.2) -- arrays/objects are REPLACED, not merged
- `context_set` projection uses LATEST-WINS semantics per run -- a new `context_set` with `metrics_commit_shas: ["def"]` will silently replace an earlier `["abc"]`
- No wall-clock timestamps on events today -- `durationSeconds` is blocked on this
- Token usage is NOT accessible at the MCP layer
- The `buildSuccessOutcome()` function has access to `lockedIndex: SessionIndex`, which is the current session's index only -- no cross-session queries at that point

**Anti-goals:**
- Do not design for the general case (all possible attribution problems) -- focus on the specific concurrent same-branch case
- Do not make the high-confidence path depend on agent compliance if there's an engine-side alternative
- Do not add a new event kind just to hold data that fits in an existing mechanism with minor conventions

---

## Landscape Findings (Code Investigation)

### Where `git_head_sha` is captured at session start

`src/mcp/handlers/v2-execution/start.ts` calls `resolveWorkspaceAnchors()` before `buildInitialEvents()`. The result is passed to `buildInitialEvents()` which emits one `observation_recorded` event per observation at the end of the initial event batch. The `git_head_sha` observation uses `type: 'git_sha1'` and regex-validates the 40-char hex format.

**Pattern for `run_completed`:** Mirror exactly -- capture end HEAD SHA via `resolveWorkspaceAnchors()` at the completion advance, emit an `observation_recorded` event (re-using the existing mechanism) rather than a new event kind.

**CRITICAL FINDING:** `observation_recorded` events are session-scoped (no scope field -- unique among all event kinds). The dedupeKey pattern is `observation_recorded:{sessionId}:{key}`. This means a second `git_head_sha` observation would collide with the first (same dedupeKey). To capture end HEAD SHA, either:
  (a) Use a different key (e.g., `git_head_sha_end`) -- requires schema extension
  (b) Emit the new `run_completed` event kind with the end SHA embedded in its data
  (c) Change the dedupeKey to include the runId so start and end can coexist

Option (b) is cleanest: a `run_completed` event with `endGitSha` in its data avoids the dedupeKey collision and clearly expresses the semantic (session finished at this SHA).

### What the `SessionIndex` provides at completion time

`buildSessionIndex()` in `src/v2/durable-core/session-index.ts` builds a single-session index from the current session's sorted event log. It provides:
- `runStartedByRunId`: workflow identity per run
- `runContextByRunId`: latest context per run
- `sortedEvents`: the full sorted event log

It does NOT provide cross-session data. At the point where `buildSuccessOutcome()` runs, only the current session's truth is loaded.

**Implication for concurrent session detection:** Detecting other active sessions on the same branch at completion time would require calling `LocalSessionSummaryProviderV2.loadHealthySummaries()` which is:
1. An async, I/O-heavy operation (scans up to 200 sessions from disk)
2. Not available as a port in `AdvanceCorePorts` today
3. Sequential by design (to avoid hammering the file system)

This operation CANNOT be done synchronously at completion time without architectural changes to make it injectable. It would add significant latency to every final advance.

### The `context_set` accumulation problem -- concrete analysis

`mergeContext` contract (locked at §18.2): arrays are REPLACED, not merged.

```
step 5: context_set { metrics_commit_shas: ["abc123"] }
step 9: context_set { metrics_commit_shas: ["def456"] }
```

Result: `metrics_commit_shas` = `["def456"]` -- "abc123" is permanently lost.

Fix options:
(a) Agent always sends full accumulated list: `["abc123", "def456"]` -- relies on agent memory, fragile
(b) New append-style event type: architecturally sound but requires new event kind, schema change, new projection
(c) Agent accumulates in a single context key by always including previous SHAs -- workable if the step prompt explicitly instructs this pattern

Option (c) is workable but brittle. Option (b) is architecturally correct but has ceremony cost.

### What `run_completed` can and cannot contain (given current infrastructure)

**Can contain (authoritative, engine-computed):**
- `endGitSha` -- available at advance time via `resolveWorkspaceAnchors()`
- `runId` -- already in scope
- `captureConfidence` -- partially (see below)

**Cannot contain (blocked on infrastructure):**
- `durationSeconds` -- no event timestamps today; the session start time is not recorded anywhere in the event log
- Concurrent session detection -- cross-session queries not available at completion time

**Confidence level determination at completion time:**
The only confidence test available at completion time (without new infrastructure) is:
- Did the agent report `metrics_commit_shas`? -- check `lockedIndex.runContextByRunId`
- Is there a git_head_sha recorded? -- check sortedEvents for `observation_recorded` with key `git_head_sha`

Testing for concurrent sessions (to set `low` confidence) requires the session summary provider, which is not injectable at the advance handler level today.

---

## Design Candidates

### Candidate A: Minimal `run_completed` event (Phase 1, shippable now)

Emit a `run_completed` event in `buildSuccessOutcome()` when `newEngineState.kind === 'complete'`.

**Event schema:**
```typescript
{
  kind: 'run_completed',
  scope: { runId: string },
  data: {
    endGitSha: string | null,           // engine-authoritative (from resolveWorkspaceAnchors)
    startGitSha: string | null,         // extracted from observation_recorded events in lockedIndex
    agentCommitShas: readonly string[], // copied from context metrics_commit_shas if present (may be empty)
    captureConfidence: 'high' | 'medium' | 'none',
    // 'high' = agentCommitShas non-empty
    // 'medium' = start+end SHA available (branch diff usable, concurrent risk unknown)
    // 'none' = no git context
  }
}
```

**Confidence logic (no cross-session query):**
```
if agentCommitShas.length > 0 → 'high'
else if startGitSha && endGitSha → 'medium'
else → 'none'
```

Note: 'low' (concurrent same-branch sessions detected) is NOT computable at advance time without new infrastructure. Drop it from Phase 1.

**Accumulation problem:** Agent must send full accumulated list in each context_set. Step prompt must explicitly say "include all commit SHAs you have made so far" not "include the commit SHAs from this step."

**Schema change cost:**
- New event kind `run_completed` in `DomainEventV1Schema` discriminated union
- New Zod schema for data
- Update all exhaustive handlers (grep for exhaustive switches on DomainEventV1)
- New projection `projectRunCompletedV2` to surface this event to consumers

**What ships:** A `run_completed` event in the session log when a workflow completes. Consumers can compute LOC from `git diff --stat startGitSha..endGitSha`. When agent reported SHAs, use those for precise per-session attribution. When not, use the full diff with a 'medium' confidence label.

**What does NOT ship:** Duration, concurrent session detection, 'low' confidence tier.

---

### Candidate B: `run_completed` deferred -- use context_set convention only (skip Phase 2 entirely)

The Phase 1 design (Discoveries 1+2) already recommended `metrics_commit_shas` as a flat context key. The question "when does the accumulation problem matter?" deserves scrutiny:

Concurrent same-branch sessions are ONLY a problem when:
1. Two sessions are running on the SAME branch (not just concurrently in time)
2. Both sessions are making commits

In a healthy WorkRail usage pattern (worktrees, feature branches per session), concurrent sessions use different branches. The same-branch concurrency problem is a degraded operating mode, not the common case.

**Recommendation:** If same-branch concurrency is rare (< 5% of sessions based on actual usage data), a `run_completed` event adds schema complexity, maintenance cost, and exhaustive-switch update burden for marginal attribution improvement. The right move is:
1. Require actual usage data before building Phase 2 infrastructure
2. Phase 1 (`metrics_commit_shas` flat context key) already provides the high-confidence path when agents comply
3. Consumers can use start/end SHAs from existing `observation_recorded` events for the 'medium' confidence case -- start SHA already exists; end SHA can be added via the existing `observation_recorded` mechanism with a new dedupeKey

**What ships:** Nothing new. Phase 1 convention is sufficient.

**Risk:** Attribution accuracy suffers for teams using same-branch workflows. But until we have data showing this is a real usage pattern, we don't know the actual impact.

---

### Candidate C: Append-style event for commit SHA accumulation (Phase 2, full solution)

Introduce a new event kind `commit_sha_appended` with `scope: { runId }` and `data: { sha: string, ref: string | null }`.

**Semantics:** Each time the agent makes a commit and reports it, they call `continue_workflow` with an artifact or emit a `commit_sha_appended` event (via a new MCP tool or a convention on continue_workflow). The projection folds all `commit_sha_appended` events into an ordered list.

**Advantage:** Solves the accumulation problem cleanly without relying on agent memory or the full-list convention.

**Cost:** New event kind, new schema, new MCP tool or convention, new projection. High ceremony.

**Verdict:** This is architecturally correct but over-engineered for the current problem. Worth pursuing if `commit_sha_appended` semantics turn out to be useful for more than just attribution (e.g., audit trail, PR linking). Defer until there's a concrete second use case.

---

## Recommended Resolution

**Phase 1 (ship now):** Candidate A -- minimal `run_completed` event. Rationale:
- Provides engine-authoritative `endGitSha` which is not available via any existing mechanism (the dedupeKey collision blocks using `observation_recorded` for end SHA)
- The `captureConfidence` field gives consumers a clear signal about attribution reliability
- `agentCommitShas` copied from context at completion time creates a reliable snapshot even if context is overwritten later
- Cost is bounded: one new event kind, one new schema, exhaustive switch updates (bounded set)

**Drop from Phase 1:**
- Concurrent session detection -- needs injectable `SessionSummaryProvider` in `AdvanceCorePorts`, adds latency, unvalidated use case
- `durationSeconds` -- blocked on event timestamps
- 'low' confidence tier -- requires cross-session query infrastructure

**Phase 2 (only if data supports it):**
- Inject `SessionSummaryProvider` into the advance handler ports to enable concurrent session detection
- Emit 'low' confidence when concurrent same-branch sessions are detected
- Requires measuring actual same-branch concurrency rate first

**Accumulation fix (required alongside Candidate A):**
The step prompt convention in `docs/authoring-v2.md` MUST say: "When reporting commit SHAs, always include the full list of all commits made during this session, not just commits from the current step." This is the only safe fix given the shallow-merge contract.

---

## Open Questions

1. **What is the actual same-branch concurrency rate?** The decision to build cross-session detection infrastructure depends on this. 539 time-overlapping pairs does not equal 539 branch-overlapping pairs. This data is needed before committing to Phase 2.

2. **Who are the consumers of `run_completed`?** The design assumes "the console dashboard" and "external analytics." Are there internal consumers (e.g., the daemon trigger system) that would benefit from a `run_completed` event? If so, this strengthens the case for Candidate A.

3. **Does the `AdvanceCorePorts` interface need to be extended for workspace anchor resolution at completion time?** No -- confirmed via code investigation. The `workspacePath` is available on `V2ContinueWorkflowInput` (the input to `handleAdvanceIntent`). Pre-resolve `endGitSha` from `input.workspacePath` before calling `executeAdvanceCore`, then pass `endGitSha: string | null` as a parameter through the call chain to `buildSuccessOutcome`. No port refactor needed.

---

## Decision Log

### Winner: Candidate A (run_completed with agentCommitShas snapshot) -- with gitBranch addition

**Why it wins:**
- Provides engine-authoritative `endGitSha` and `startGitSha` in a single self-contained event
- `agentCommitShas` snapshot from context is durable (survives future context overwrites, unlike leaving SHAs only in context_set)
- Follows `assessment_recorded` precedent (snapshots context data into event log at completion time)
- Fully reversible: if agent compliance is poor, consumers can ignore `agentCommitShas` and fall back to 'medium' -- no schema change needed
- Incremental cost over the endGitSha-only variant is trivial (one field + superRefine + sha1 validation)

**Why the runner-up (endGitSha-only) lost:**
- Would make 'high' confidence tier permanently unachievable, defeating the stated goal (concurrent same-branch disambiguation)
- Cost difference vs. winner is negligible

**Why "defer entirely" lost:**
- No mechanism for capturing `endGitSha` without a new event kind (dedupeKey collision blocks reusing `observation_recorded`)
- Without `endGitSha`, retrospective attribution queries break (current HEAD != session end SHA for old sessions)

### Final schema (confirmed after adversarial challenge and review)

```typescript
{
  kind: 'run_completed',
  scope: { runId: string },
  data: {
    startGitSha: string | null,          // from observation_recorded events (git_head_sha key)
    endGitSha: string | null,            // resolved at completion via input.workspacePath
    gitBranch: string | null,            // from observation_recorded events (git_branch key)
    agentCommitShas: readonly string[],  // sha1 validated, from context.metrics_commit_shas
    captureConfidence: 'high' | 'medium' | 'none',
    // 'high' = agentCommitShas non-empty (requires superRefine cross-field invariant)
    // 'medium' = startGitSha and endGitSha available
    // 'none' = no git context
  }
}
// Zod superRefine: captureConfidence === 'high' requires agentCommitShas.length > 0
// Zod: agentCommitShas entries validated as /^[0-9a-f]{40}$/
```

### Implementation pattern (threading fix)

In `src/mcp/handlers/v2-execution/continue-advance.ts`, before calling `executeAdvanceCore`:
```typescript
// Lazy resolution: only resolve when session might be completing
// (exact guard inside buildSuccessOutcome, so resolve eagerly at the advance site)
const endGitSha: string | null = input.workspacePath
  ? await resolveEndGitSha(ctx.v2, input.workspacePath)
  : null;
```

Pass `endGitSha` through `executeAdvanceCore` args to `buildSuccessOutcome`. Guard emission with `newEngineState.kind === 'complete'`.

---

## Final Summary

**Confidence band:** HIGH

**Residual risks:**
1. Agent compliance with full-accumulated-list convention is the riskiest assumption -- mitigation is authoring docs + step prompt, not architecture
2. No specific consumer of `run_completed` identified yet -- validate before Phase 2 investment
3. Same-branch concurrency rate unknown -- Phase 2 (concurrent detection) is data-gated on this

**Phase 1 (ship without gates):**
- `run_completed` event kind with final schema above
- `projectSessionGitAttributionV2` pure projection
- `ConsoleSessionSummary` extension (optional `gitAttribution` field, null-safe)
- `docs/authoring-v2.md` update: full-accumulated-list step prompt template (REQUIRED -- feature is dead without this)
- Consumer cross-check convention documented

**Phase 2 (data-gated):**
- Inject `SessionSummaryProvider` into `AdvanceCorePorts` for concurrent session detection
- Add 'low' confidence tier when concurrent same-branch sessions detected
- Gate on: same-branch concurrency rate > 5% OR measured production misattribution incidents

**Phase 3 (if compliance measurement shows problem):**
- `commit_sha_appended` append-style event type for clean SHA accumulation
- Gate on: full-list compliance rate < 50% for multi-commit sessions

**What cannot ship regardless of phase:** `durationSeconds` -- blocked on event envelope timestamps, which require a separate infrastructure change.
