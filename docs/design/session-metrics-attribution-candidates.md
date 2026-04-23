# Session Metrics Attribution -- Design Candidates

*Raw investigative material for main agent synthesis. Not a final decision.*

---

## Problem Understanding

**Core problem:** WorkRail sessions have `startGitSha` (captured at session start via `observation_recorded`) but no `endGitSha`. Without an end SHA, consumers cannot compute a bounded git diff for a completed session. The concurrent same-branch problem (two sessions on the same branch make commits in overlapping time windows) makes branch-scoped diff attribution unreliable.

**Tensions (real tradeoffs):**

1. **Attribution accuracy vs. schema complexity.** A `run_completed` event with `endGitSha` achieves engine-authoritative bounding of the session's diff range. The consumer-offload approach (no new event) achieves zero schema cost but breaks retrospective analytics (current HEAD != session end SHA for sessions completed days ago).

2. **Agent compliance vs. architectural correctness.** The 'high' confidence tier (per-session disambiguation in same-branch concurrency) requires agents to self-report commit SHAs. An append-style event mechanism (`commit_sha_appended`) would solve the accumulation problem architecturally but doesn't fix non-compliance -- agents could still forget to report. The fundamental problem is social (agent convention), not structural.

3. **Snapshot vs. query-time computation.** Snapshotting `agentCommitShas` from context into the `run_completed` event gives consumers a pre-computed, durable record that survives future context overwrites. Leaving SHAs only in `context_set` is fragile: context can theoretically be overwritten by a subsequent advance attempt.

4. **Naive `observation_recorded` reuse vs. new event kind.** The dedupeKey pattern `observation_recorded:{sessionId}:{key}` means a second `git_head_sha` emit is silently discarded on replay. Adding `git_head_sha_end` to the observation key enum costs the same schema change as a new event kind but produces worse semantics (mixes pre/post-workflow observations; can't carry `captureConfidence`).

**Likely seam:** `buildSuccessOutcome()` in `src/mcp/handlers/v2-advance-core/outcome-success.ts`, inside the `when (newEngineState.kind === 'complete')` guard. This is the only place where: (a) the new engine state is known to be `complete`, and (b) the session is under lock (atomic append). The `extraEventsToAppend` mechanism is already established for this purpose (5 other event types use it).

**What makes this hard:**

1. **DedupeKey collision.** A junior developer would try to reuse `observation_recorded` for endGitSha and discover it's silently idempotency-discarded on replay (dedupeKey = `observation_recorded:{sessionId}:{key}`, same session, same key = same dedupeKey).

2. **Timing.** The `complete` engine state is only known inside `buildSuccessOutcome` (computed at line 179 of `outcome-success.ts` via `fromV1ExecutionState(out.state)`). End SHA capture must happen at this same point.

3. **`workspacePath` threading.** `buildSuccessOutcome` receives `AdvanceCorePorts` (no workspace context). End SHA resolution requires `workspacePath` from `input.workspacePath`. The resolution must happen before `executeAdvanceCore` is called and the result passed as a parameter `endGitSha: string | null` down to `buildSuccessOutcome`. This is a straightforward parameter threading change but non-obvious.

4. **Accumulation problem.** `mergeContext` (locked at §18.2) replaces arrays, not merges them. `metrics_commit_shas: ['abc']` at step 5 + `metrics_commit_shas: ['def']` at step 9 = only `['def']` survives. Agent must be instructed to send full accumulated list on every context_set. This is a convention constraint, not fixable architecturally without a new event kind.

---

## Philosophy Constraints

**Principles that matter most here:**

- **Make illegal states unrepresentable:** `captureConfidence: 'high'` with empty `agentCommitShas` is an illegal state. Must enforce via Zod `superRefine` cross-field check.
- **Exhaustiveness everywhere:** Most projections use `default: // ignore` (forward-compat pattern, confirmed in `run-dag.ts`, `session-index.ts`). New event kind does NOT require updating existing projections automatically. Primary update: `DomainEventV1Schema` Zod union + `EVENT_KIND` constant.
- **Validate at boundaries, trust inside:** Agent-reported SHAs should be validated as sha1 format (40-char hex regex) in the Zod schema, not in projections.
- **YAGNI with discipline:** Do NOT add `durationSeconds` (blocked on timestamps). Do NOT add 'low' confidence tier (blocked on cross-session queries). Placeholder fields that can't be populated are anti-YAGNI.
- **Architectural fixes over patches:** DedupeKey collision is an architectural signal -- use a new event kind, not a workaround.
- **Immutability by default:** Once `run_completed` is emitted, it cannot be modified. All fields must be computable at emission time.

**Philosophy conflicts:**

1. YAGNI vs. architectural-fixes-over-patches: YAGNI says wait for validated same-branch concurrency data. Architectural-fix principle says use a proper event kind. Resolution: build `run_completed` correctly if built at all; but the "whether to build" decision is separate.

2. §18.2 locked shallow-merge vs. make-illegal-states-unrepresentable: The shallow merge lock means agent SHA accumulation is inherently fragile. Accepted tension; document the convention.

---

## Impact Surface

Files that must stay consistent:

- `src/v2/durable-core/schemas/session/events.ts` -- `DomainEventV1Schema` Zod union, primary update target
- `src/v2/durable-core/constants.ts` -- `EVENT_KIND` constants object, must add `RUN_COMPLETED`
- `src/mcp/handlers/v2-advance-core/outcome-success.ts` -- emission site, `extraEventsToAppend` usage
- `src/mcp/handlers/v2-execution/continue-advance.ts` -- workspace anchor resolution must happen here, `endGitSha` passed down
- `src/v2/projections/run-completed.ts` (new) -- pure projection to extract `run_completed` data from event log
- `src/v2/usecases/console-service.ts` -- may need to call new projection to populate `ConsoleSessionSummary`
- `src/v2/usecases/console-types.ts` -- extend `ConsoleSessionSummary` with `gitAttribution` field
- `console/src/api/types.ts` -- mirror `ConsoleSessionSummary` changes for frontend
- `docs/authoring-v2.md` -- step prompt convention for `metrics_commit_shas` accumulation

Contracts that must remain consistent:

- `ConsoleSessionSummary` DTO: new field must be optional/null-safe (backward-compatible)
- Session event log schema: Zod parse must accept existing event logs without `run_completed` events (forward-compat, already handled by discriminated union)

---

## Candidates

### Candidate 1: Minimal `run_completed` -- endGitSha only

**One-sentence summary:** Emit a `run_completed` event at session completion containing `startGitSha`, `endGitSha`, and a two-tier confidence (`medium` / `none`), with no agent-reported data.

**Tensions resolved:**
- Attribution accuracy vs. schema complexity: resolves at minimum cost. Consumers get an authoritative start+end SHA range.
- Snapshot vs. query-time: resolves correctly -- endGitSha is snapshotted at completion, not computed from current HEAD at query time.

**Tensions accepted:**
- Agent compliance irrelevant (no agent data captured). Per-session disambiguation in same-branch concurrency is NOT solved.

**Boundary solved at:** `buildSuccessOutcome()` in `outcome-success.ts`, guarded by `newEngineState.kind === 'complete'`.

**Why this boundary is the best fit:** Only place with both complete state knowledge and atomic append capability.

**Failure mode:** `workspacePath` absent on final advance -- `endGitSha` is null, confidence 'none'. Graceful; not an error.

**Repo-pattern relationship:** Follows -- mirrors `observation_recorded` at start; uses established `extraEventsToAppend` hook.

**Gains:** Engine-authoritative diff range with minimal schema change. Zero agent compliance requirement.

**Losses:** Concurrent same-branch attribution problem remains unsolved. 'high' confidence tier is unachievable.

**Schema:**
```typescript
{
  kind: 'run_completed',
  scope: { runId: string },
  data: {
    startGitSha: string | null,
    endGitSha: string | null,
    captureConfidence: 'medium' | 'none',
    // 'medium' = both SHAs available; 'none' = no git context
  }
}
```

**Scope judgment:** Too narrow for the stated goal (concurrent same-branch attribution). Best-fit for "approximately how much did this session change."

**Philosophy fit:** YAGNI satisfied. Tension: 'high' confidence tier promised in architecture but undeliverable.

---

### Candidate 2: `run_completed` with agentCommitShas snapshot (RECOMMENDED)

**One-sentence summary:** Same as Candidate 1 plus `agentCommitShas: readonly string[]` copied from context at completion time, enabling 'high' confidence tier when agents comply.

**Tensions resolved:**
- Attribution accuracy vs. schema complexity: best resolution. Marginal schema cost increase over C1; delivers per-session disambiguation.
- Snapshot vs. query-time: fully resolved. Agent SHAs are snapshotted into the immutable event log at completion.

**Tensions accepted:**
- Agent compliance convention. Accumulation problem (agents must send full list, not incremental). No 'low' confidence tier.

**Boundary solved at:** Same as Candidate 1.

**Why this boundary is the best fit:** `lockedIndex.runContextByRunId.get(String(runId))?.metrics_commit_shas` is directly readable at this point with no additional I/O.

**Failure mode:** Agent sends partial SHA list (only current step's commits, not accumulated). `agentCommitShas` in `run_completed` is incomplete; confidence is 'high' but the record is silently wrong. Mitigation: authoring docs must explicitly state "include ALL commit SHAs made during the session in your final context_set."

**Repo-pattern relationship:** Follows -- `assessment_recorded` does the exact same thing (snapshots assessment context into event log at completion time). This is the established pattern.

**Gains:**
- Durable per-session commit SHA record that survives context overwrites
- 'high' confidence tier enables per-session disambiguation
- Fully reversible: if agent compliance is poor, consumers can ignore `agentCommitShas` and fall back to 'medium' with no schema change
- Incremental cost over Candidate 1 is trivial (one field + superRefine + sha1 validation)

**Losses:** Agent compliance convention is required for the 'high' path to be meaningful.

**Schema:**
```typescript
{
  kind: 'run_completed',
  scope: { runId: string },
  data: {
    startGitSha: string | null,
    endGitSha: string | null,
    agentCommitShas: readonly string[],  // sha1 regex validated, may be empty
    captureConfidence: 'high' | 'medium' | 'none',
    // 'high' = agentCommitShas non-empty (all sha1 validated)
    // 'medium' = start+end SHA available, agentCommitShas empty
    // 'none' = no git context
  }
}
// Zod superRefine: captureConfidence === 'high' requires agentCommitShas.length > 0
```

**Scope judgment:** Best-fit for stated goal.

**Philosophy fit:** Make illegal states unrepresentable (superRefine invariant), validate at boundaries (sha1 regex on every entry in agentCommitShas), errors are data (captureConfidence), immutability (event log snapshot).

---

### Candidate 3 (reframe): Consumer-offload -- projection only, no new event kind

**One-sentence summary:** Add a pure projection `projectSessionGitAttributionV2(events)` that surfaces existing `startGitSha`, `gitBranch`, and `metrics_commit_shas` from context into a typed DTO; let consumers compute diffs from startSha at query time.

**Tensions resolved:**
- Schema complexity: zero. No new event kind.
- YAGNI: satisfied.

**Tensions accepted:**
- Retrospective attribution broken: current HEAD != session end SHA for sessions completed days ago. `git diff startSha..HEAD` is meaningless for historical queries.

**Boundary solved at:** Projection layer only. No changes to event emission.

**Why this boundary is wrong:** Consumers need a bounded diff range. Without `endGitSha`, retrospective analytics (the primary stated use case) is impossible.

**Failure mode:** Consumer runs attribution query on a 3-month-old session. Repo's HEAD is 800 commits ahead of session end. Diff is enormous and meaningless.

**Repo-pattern relationship:** Follows projection pattern. But insufficient as a standalone solution.

**Gains:** Zero schema change cost. Can ship as a companion to Candidate 1 or 2 (the projection is needed regardless).

**Losses:** Breaks retrospective analytics. Does not solve the stated problem.

**Scope judgment:** Too narrow. Valid as a projection companion (needed for all candidates) but not as a standalone solution.

**Philosophy fit:** YAGNI (zero schema change). Conflict: architectural fixes over patches -- a projection without endGitSha capture is a workaround.

---

## Comparison and Recommendation

**Recommendation: Candidate 2**

The incremental cost of `agentCommitShas` over Candidate 1 is trivial. The gain is meaningful: a durable per-session commit SHA record and the 'high' confidence tier. The design follows the `assessment_recorded` pattern exactly. The decision is fully reversible (consumers can ignore `agentCommitShas` if compliance is poor).

Candidate 3 is a required companion (the projection is needed for all candidates to surface `run_completed` data) but is insufficient as a standalone solution.

**Phase 1 scope (what ships):**
- `run_completed` event kind with `startGitSha`, `endGitSha`, `agentCommitShas`, `captureConfidence: 'high' | 'medium' | 'none'`
- `projectSessionGitAttributionV2` pure projection
- `ConsoleSessionSummary` extension (optional `gitAttribution` field)
- `docs/authoring-v2.md` update: full-accumulated-list convention for `metrics_commit_shas`

**Deferred to Phase 2 (data-gated):**
- Concurrent session detection (`captureConfidence: 'low'`)
- `durationSeconds` (blocked on event timestamps)
- Append-style `commit_sha_appended` event (only if compliance measurement shows full-list convention is unreliable)

**Implementation threading fix required:**
Before `executeAdvanceCore` is called in `continue-advance.ts`, resolve end git SHA from `input.workspacePath` and pass `endGitSha: string | null` as a new parameter through to `buildSuccessOutcome`. The existing `resolveWorkspaceAnchors()` function can be reused.

---

## Self-Critique

**Strongest argument against Candidate 2:**

The silent-wrong-confidence problem. If agents consistently report partial SHA lists (only the current step's commits), the 'high' confidence flag in `run_completed` will be systematically misleading. This is exactly the failure mode that caused Discovery 1 to reject agent self-reporting. The mitigation (authoring docs convention) is necessary but not sufficient -- it creates a trust-the-author dependency that the WorkRail engine cannot enforce at the schema level.

**Pivot conditions:**
- Switch to Candidate 1 if: stakeholder confirms per-session disambiguation is not needed (branch-level totals are sufficient for all consumers).
- Switch to append-style events if: agent compliance measurement shows <50% of multi-commit sessions report full accumulated lists.
- Keep Candidate 2 if: adoption measurement after 30 days shows agents generally include full accumulated lists in final steps.

**Assumption that would invalidate the design:**
If `workspacePath` is frequently absent in the final `continue_workflow` call, `endGitSha` will be null for most sessions. The `run_completed` event would exist but be nearly empty (confidence 'none'). The feature would be dead in practice. This is a documentation/UX concern: the MCP schema must strongly encourage `workspacePath` on every advance call.

---

## Open Questions for the Main Agent

1. **Is per-session attribution (vs. per-branch totals) a validated consumer need?** If branch-level totals suffice, Candidate 1 or even Candidate 3 is correct.

2. **What is the actual same-branch concurrent session rate?** The decision to build Phase 2 (concurrent detection) should be data-gated on this.

3. **Should `run_completed` be scoped to `{ runId }` or `{ runId, nodeId }`?** Run-scoped (like `context_set`, `run_started`) seems right since session completion is a run-level event. But the final node's `nodeId` might be useful for linking to the last step.

4. **How does the console surface `captureConfidence`?** The design doc should specify the UI label ("agent-reported", "approximate", "engine-verified") before implementation to avoid post-hoc design decisions.

5. **Does the `workspacePath` threading require resolving git anchors eagerly (before the completion check) or lazily (only when completion is detected)?** Eager resolution adds latency to every non-final advance. Lazy resolution (resolve only when `newEngineState.kind === 'complete'`) requires the workspace anchor resolution to happen inside `buildSuccessOutcome` -- which means adding the workspace context to the ports. Trade-off: latency vs. interface cleanliness.
