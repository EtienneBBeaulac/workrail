# Session Metrics Discovery

**Date:** 2026-04-21
**Status:** Discovery complete -- recommendation ready

---

## About This Document

This document is a human-readable artifact for sharing findings and recommendations. It is NOT execution truth -- if a chat rewind occurs, the durable notes and context variables in the WorkRail session survive; this file may not. Read it for understanding, not for resuming the workflow.

---

## Context / Ask

**Stated goal (original):** Discover the best architectural approach for recording metrics and tracking data within WorkRail workflow runs, to answer questions like: LOC changed, files touched, PRs created, and eventually token cost per session.

**Note:** The original goal is a solution-statement. The actual problem is stated below.

**Reframed problem:** How can WorkRail sessions surface structured, queryable evidence of what was accomplished (code changes, artifacts created, time elapsed) without requiring workflow authors to manually instrument every step?

---

## Path Recommendation

**Selected path:** `full_spectrum`

**Rationale:**
- The original framing is solution-biased (it assumes WorkRail needs new architecture). Full-spectrum challenges this before generating candidates.
- The landscape must be understood first: the current event schema already has `observation_recorded`, `context_set`, and `node_output_appended`. Whether these are sufficient is a landscape question.
- A design-first angle is also needed: what should be attributed to WorkRail's responsibility vs. external tooling?
- `landscape_first` alone would skip the reframing needed. `design_first` alone would skip reading the actual event schema.

---

## Constraints / Anti-goals

**Core constraints:**
- WorkRail cannot directly observe what the agent does between steps -- it only sees what the agent explicitly reports via `continue_workflow`
- Token usage is NOT accessible to the MCP layer today -- Claude Code does not expose per-tool-call token counts to MCP servers
- Sessions are stored as append-only event logs in `~/.workrail/data/sessions/`
- The `observation_recorded` event has a closed key set: `['git_branch', 'git_head_sha', 'repo_root_hash', 'repo_root']`
- `context_set` carries `JsonValue` data with no schema enforcement on the `context` field itself
- Event envelopes have no wall-clock timestamps today

**Anti-goals:**
- Do not build a new mechanism if the existing `context_set` or artifact output is already sufficient with a convention
- Do not require all existing workflows to be updated to get basic metrics
- Do not make token cost a blocking requirement (it is not achievable today)
- Do not conflate WorkRail-observable facts (step count, duration, what agent self-reported) with external facts (actual git diff, actual LOC) -- these require different mechanisms

---

## Landscape Packet

### What exists today

**Event types relevant to metrics:**
- `observation_recorded` -- closed key set (`git_branch`, `git_head_sha`, `repo_root_hash`, `repo_root`). Emitted at session start by MCP handler. NOT agent-reportable today.
- `context_set` -- carries arbitrary `JsonValue` data. Source is `'initial'` or `'agent_delta'`. Already used to carry `goal`, `is_autonomous`, `parentSessionId`. This IS agent-reportable via the `context` field of `continue_workflow`.
- `node_output_appended` -- carries per-step notes (markdown) and artifact refs. Already carries structured artifacts (assessment, loop_control, coordinator_signal, review_verdict, discovery_handoff).
- `advance_recorded` -- records that an advance happened. No metrics data.
- `gap_recorded` -- records gaps/omissions. No metrics data.
- No wall-clock timestamps on any events today.

**Structured artifact contracts today:**
- `wr.contracts.assessment` -- assessment dimensions + scores
- `wr.contracts.loop_control` -- loop exit/continue decisions
- `wr.contracts.coordinator_signal` -- spawn/complete coordinator signals
- `wr.contracts.review_verdict` -- review pass/fail
- `wr.contracts.discovery_handoff` -- discovery findings

None of these are metrics-shaped.

**What the console shows today (from `ConsoleSessionSummary`):**
- sessionId, workflowId, workflowName
- status, health
- nodeCount, edgeCount, tipCount
- hasUnresolvedGaps, recapSnippet
- gitBranch (from `observation_recorded`)
- lastModifiedMs (derived from filesystem mtime, not event timestamps)
- isAutonomous, parentSessionId

The console already reads worktree git state (changedFiles, aheadCount, unpushedCommits) via background enrichment scans from the daemon. This is NOT session-scoped -- it is worktree-scoped (current state, not what changed during a session).

**What is NOT recorded today (in durable events):**
- Wall-clock session duration (no event timestamps; `lastModifiedMs` is filesystem mtime only)
- Step count per run (only `nodeCount`, which includes checkpoints + blocked_attempts)
- Files touched during a session (vs. current files changed in the worktree)
- LOC changed during a session
- PRs created during a session
- Agent HEAD SHA at session end (start SHA IS captured via `observation_recorded`)
- Token usage (not accessible at MCP layer)

**What IS available for deriving duration:**
- The daemon registry tracks `startedAtMs` and `lastHeartbeatMs` per session -- but these are in-memory and ephemeral (lost on daemon restart)
- Filesystem mtime is used as `lastModifiedMs` in the console -- this is a proxy for "last event", not a start timestamp
- The very first event's `eventIndex = 0` is always `session_created`, but there is no timestamp in the event envelope

**Important finding:** The `context_set` projection (`projectRunContextV2`) and `SessionIndex` only retain the LATEST `context_set` event per run. This means agent-reported context keys are cumulative-overwrite, not append-only. A metrics key like `metrics.pr_numbers: [123]` submitted at step 3, then overwritten at step 5 with `metrics.pr_numbers: [123, 456]`, would work correctly. But if an agent only partially updates context at step 5, earlier keys survive (merge semantics).

### Key architectural constraint

WorkRail has NO read access to the filesystem or git. It can only record what agents explicitly emit. This means:
- "Files changed during a session" requires the agent to self-report, OR WorkRail to capture HEAD SHA at start and end and compute the diff externally
- The git HEAD SHA IS already captured at session start via `observation_recorded` (key: `git_head_sha`). There is no end-of-session equivalent.

---

## Problem Frame Packet

**Primaryuncertainty:** Is this a convention gap (agents don't know what to report and where) or a mechanism gap (no suitable mechanism exists to record metrics)?

**Known approaches (from the original prompt):**
1. (a) Auto-injected final step -- WorkRail adds a synthetic step at the end of every workflow asking the agent to report metrics
2. (b) Step-type-aware mid-session injection -- WorkRail injects metric-collection prompts at specific step types
3. (c) New `metrics` output contract type -- a new artifact contract `wr.contracts.metrics` that agents can submit at any step
4. (d) `observation_recorded` events emitted by the agent at any step -- extend the observation key set
5. (e) MCP handler layer interception -- WorkRail computes metrics automatically at the boundary without requiring agent participation

**Additional options surfaced from codebase reading:**
- (f) `context_set` as the metrics carrier -- use the existing `context_set` mechanism (already carries `JsonValue`) with a defined convention for metric keys (e.g., `metrics.pr_numbers`, `metrics.files_changed`)
- (g) Post-hoc session analysis tool -- a CLI or console feature that reads the event log + git log and derives metrics without any in-session changes
- (h) Capture HEAD SHA at session end in addition to start, enable external diff

---

## Problem Frame Packet

### Primary users and jobs

**User 1: Developer reviewing completed sessions in the console**
- Job: "I want to glance at a session and immediately know what was accomplished -- what files changed, what PR was opened, how long it took."
- Current pain: The console only shows session status, node count, and a recap snippet. Nothing about code impact.

**User 2: Workflow author**
- Job: "I want basic metrics surfaced without adding boilerplate to every workflow I write."
- Current pain: There is no convention for which step to report what. Even if `context_set` is the right carrier, there is no prompt guidance, no schema, no validation.

**User 3: WorkTrain autonomous daemon operator**
- Job: "I want to see a summary of what each autonomous session accomplished, including LOC, PRs created, and whether it succeeded."
- Current pain: The daemon has `startedAtMs`/`lastHeartbeatMs` ephemerally, but nothing structured is persisted about outcomes.

### Core tensions

1. **Convention vs. enforcement.** Using `context_set` as a metrics carrier is zero-schema-change but relies entirely on agents following a convention. Without a schema, projection/query tools won't know where to look. With a schema (e.g., a new `wr.contracts.metrics` artifact), the bar is higher but the data is machine-verifiable.

2. **Agent self-reporting vs. external observation.** The richest metrics (LOC changed, files touched) require the agent to run `git diff --stat` and report the numbers -- WorkRail cannot compute this. But agents are unreliable reporters: they may forget, lie, or be at a mid-session checkpoint. External observation (capturing HEAD SHA at start and end, then computing the diff post-hoc) is more trustworthy but requires capturing the end SHA somehow.

3. **Per-step vs. end-of-session.** Some metrics (PR number, branch name) are only known at specific steps. Others (total LOC, final status) are only meaningful at completion. A single end-of-session mechanism is simpler but cannot capture mid-session facts.

4. **Zero-workflow-change vs. author investment.** An auto-injected final step would work for any workflow without modification. But it intrudes on the agent experience and may be confusing in short utility workflows.

### HMW questions

- How might we capture the HEAD SHA automatically at session completion without requiring the agent to self-report?
- How might we make it trivially easy for workflow authors to ask for metrics without designing a whole new step?

### Primary framing risk

**The primary framing risk is: the problem is actually a query/visualization gap, not a capture gap.**

If agents ARE already reporting meaningful data via `context_set` (e.g., `pr_number`, `branch`, files touched) in the step notes -- even informally, in plain markdown -- then the right solution is a post-hoc parser or a richer console query, not new capture infrastructure. If this is true, the architecture we design for capture would add friction without improving the actual signal available to users.

Evidence that would confirm this risk: analyze a set of real session event logs and check whether agents already self-report outcomes. (We cannot do this here without access to live session data, but this should be verified before implementing any new mechanism.)

## Candidate Generation Expectations

For this `full_spectrum` pass, candidates must:

1. **Cover the full spectrum from minimal-change to structured-schema** -- at least one "zero new infrastructure" direction, and at least one "properly typed new mechanism" direction.
2. **Include at least one direction that reframes the problem** -- specifically, the "post-hoc analysis" direction that asks: what if we don't change the capture layer at all and instead improve query/extraction of what's already there?
3. **Respect landscape precedents** -- candidates must explain how they interact with `context_set`, `observation_recorded`, and the artifact contract system, not ignore them.
4. **Be layered** -- each candidate must address the immediate need (self-reported metadata) separately from the longer-term need (automatic end-of-session observation, timestamps).
5. **Be discriminating** -- candidates must be meaningfully different from each other, not just different names for the same approach.

## Candidate Directions

### Candidate A: `context_set` convention with a metrics projection layer (simplest sufficient)

**Summary:** Establish a documented key convention under `context.metrics.*` in `context_set` events. Add a `projectSessionMetricsV2` projection that extracts these keys. Expose `metrics: SessionMetricsV2 | null` in `ConsoleSessionSummary`.

**Tensions resolved:** minimal author burden, backward-compatible, zero schema change, queryable  
**Tensions accepted:** weak type safety (JsonValue), no enforcement, agents must self-compute git stats

**Convention spec:**
- Agents set `context.metrics = { pr_numbers?: number[], files_changed_count?: number, lines_added?: number, lines_removed?: number, outcome?: 'success' | 'partial' | 'abandoned' | 'error' }` via `continue_workflow` `context` field
- Multiple `context_set` events: last one wins per run (existing semantics)
- New projection: `src/v2/projections/session-metrics.ts` → `projectSessionMetricsV2`
- New console field: `ConsoleSessionSummary.metrics: SessionMetricsV2 | null`

**Failure mode:** Inconsistent key names across agents. No enforcement signal.  
**Pattern:** Follows `projectRunContextV2`. Same as how `isAutonomous` works.  
**Gain:** Zero schema change, works today for any workflow.  
**Give up:** Type safety, enforcement, reliable git quantitative metrics.  
**Scope:** Best-fit for immediate need.  
**Philosophy:** Honors YAGNI. Conflicts with "prefer explicit domain types."

---

### Candidate B: New `wr.contracts.metrics` artifact type (follow the artifact contract pattern)

**Summary:** Define a new Zod-validated artifact contract `wr.contracts.metrics`, placed on the `outputContract` of a workflow's final/summary step. Machine-verifiable at `continue_workflow` boundary.

**Artifact schema:**
```typescript
MetricsArtifactV1Schema = z.object({
  contractRef: z.literal('wr.contracts.metrics'),
  v: z.literal(1),
  outcome: z.enum(['success', 'partial', 'abandoned', 'error']),
  prNumbers: z.array(z.number().int().positive()).optional(),
  filesChangedCount: z.number().int().nonnegative().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  durationHint: z.string().optional(),
  notes: z.string().optional(),
})
```

**Tensions resolved:** type safety, validation at boundary, machine-queryable  
**Tensions accepted:** author burden (outputContract required on final step), node-scoped (metrics should be session-scoped), not universal for existing workflows

**Failure mode:** Most workflows don't have a dedicated final step; existing workflows never report metrics without modification.  
**Pattern:** Adapts `wr.contracts.assessment`, `wr.contracts.review_verdict`.  
**Gain:** Type safety, enforcement, machine-queryable via existing artifact projection.  
**Give up:** Universality, backward-compatibility (all workflows need update), simplicity.  
**Scope:** Too broad for immediate need; appropriate as Phase 2 upgrade.  
**Philosophy:** Honors "prefer explicit domain types", "validate at boundaries". Conflicts with YAGNI.

---

### Candidate C: End-of-session HEAD SHA observation + post-hoc diff (reframe: no agent self-reporting for git stats)

**Summary:** Emit a second `observation_recorded` with key `git_head_sha_end` when the workflow reaches `complete` state. Provide a console endpoint `GET /api/v2/sessions/:id/diff-summary` that computes `git diff --stat <start_sha>..<end_sha>` to derive authoritative LOC and files-changed.

**Tensions resolved:** agent reliability (git stats from git, not agent claims), no false precision, zero author burden for git-stat metrics  
**Tensions accepted:** requires extending the closed `observation_recorded` enum, requires WorkRail to access git at query time (new capability), complex lifecycle hook

**Failure mode:** observation_recorded key set is a CLOSED discriminated union -- extending it requires a schema union update and exhaustive handler updates across the codebase. WorkRail currently has no git access at the MCP handler level.  
**Pattern:** Extends the existing `observation_recorded` start-of-session pattern. The `advance_recorded` → `complete` path would need a new hook.  
**Gain:** Authoritative git metrics without agent participation.  
**Give up:** Schema change, git filesystem access in WorkRail (new boundary), significant implementation scope.  
**Scope:** Best-fit for "authoritative git metrics" but too broad for Phase 1; should be Phase 2.  
**Philosophy:** Honors "architectural fixes over patches", "determinism". Conflicts with YAGNI.

---

### Candidate D: Add `timestampMs` to the event envelope (foundational duration infrastructure)

**Summary:** Add optional `timestampMs: number` to `DomainEventEnvelopeV1Schema`, emitted by the MCP handler clock injection. Session duration = `last_event.timestampMs - first_event.timestampMs`.

**Tensions resolved:** session duration computable from event log, no agent participation, enables future event-level analytics  
**Tensions accepted:** significant schema change, not backward-compatible (older sessions show null), adds size to every event

**Failure mode:** Existing sessions have no timestamps. Schema locks doc requires update. Requires clock injection into all event builders.  
**Pattern:** Departs from existing pattern (events have no timestamps today). Requires updating `docs/design/v2-core-design-locks.md`.  
**Gain:** Duration metrics without agent participation; future event-timing analytics.  
**Give up:** Significant schema blast radius, YAGNI for "one metric."  
**Scope:** Too broad as a "metrics" change; this is foundational infrastructure. Should be a separate proposal.  
**Philosophy:** Honors "architectural fixes over patches". Conflicts with YAGNI significantly.

---

## Challenge Notes

**Challenged assumptions:**

1. **WorkRail should own metric collection**
   - Assumption: WorkRail is the right system to capture git stats, LOC, files changed.
   - Why it might be wrong: WorkRail has no filesystem access. The git worktree state data is already read by the console's background enrichment scan -- but that is current state, not session-scoped history.
   - Evidence needed: determine whether the delta (HEAD SHA at start vs. end) is sufficient for a post-hoc diff.

2. **New schema/mechanism needed**
   - Assumption: recording metrics requires new event types or output contracts.
   - Why it might be wrong: `context_set` already accepts arbitrary `JsonValue` with agent deltas. The gap may be that agents don't know they should report metrics here, and that there's no extraction/projection layer consuming them.
   - Evidence: `context_set` data carries `goal`, `is_autonomous`, `parentSessionId` already -- arbitrary agent-reported data is already possible.

3. **Token cost per session is achievable**
   - Assumption: token cost can be captured as part of this design.
   - Why it's wrong: explicitly stated in the problem context -- MCP layer cannot observe per-tool-call token counts. Building architecture around this would be premature optimization.
   - Evidence: confirmed by provided context.

---

## Resolution Notes

### Recommendation: Phase 1 = Candidate A (with flat-key convention), Phase 2 = Candidate C

**Phase 1 recommendation (Candidate A, modified):**

Use `context_set` as the metrics carrier, but with FLAT TOP-LEVEL keys (not a nested `metrics` object), to avoid the shallow-merge wipe problem.

**Why flat keys, not nested:**

`mergeContext` (`src/v2/durable-core/domain/context-merge.ts`) uses SHALLOW merge semantics. Top-level keys are merged individually; nested objects are REPLACED. If agents write `context.metrics = { pr_numbers: [...] }` and later write `context.metrics = { lines_added: 50 }`, the `pr_numbers` key is lost. Flat keys (`context.metrics_pr_numbers`, `context.metrics_outcome`) avoid this by exploiting the per-top-level-key merge semantics.

**Flat-key convention:**
- `metrics_outcome: 'success' | 'partial' | 'abandoned' | 'error'` -- session outcome
- `metrics_pr_numbers: number[]` -- PR numbers created (array, last write wins per-key)
- `metrics_files_changed: number` -- advisory, agent-reported
- `metrics_lines_added: number` -- advisory, agent-reported
- `metrics_lines_removed: number` -- advisory, agent-reported
- `metrics_git_head_end: string` -- HEAD SHA at completion (agent self-reports; advisory until Phase 2 automates this)

**What changes:**
1. `src/v2/projections/session-metrics.ts` -- new file, `projectSessionMetricsV2` reads `context_set` latest-wins projection and extracts `metrics_*` keys into a typed `SessionMetricsV2` object
2. `src/v2/usecases/console-types.ts` -- add `metrics: SessionMetricsV2 | null` to `ConsoleSessionSummary`
3. `src/v2/usecases/console-service.ts` -- call `projectSessionMetricsV2` and populate the field
4. `docs/authoring-v2.md` -- document the `metrics_*` convention so workflow authors know what keys to set and when
5. Console UI -- minimal "Metrics" row in session summary list and/or session detail panel

**What does NOT change:**
- No event schema changes
- No workflow compilation changes
- No existing workflow breakage
- No new event kinds
- No artifact contract changes

**Strongest counter-argument:** Flat metrics keys pollute the context namespace. A workflow author using `context.pr_number` (custom key) would silently conflict with `context.metrics_pr_numbers`. Convention requires discipline.

**Narrower option that lost:** Document the convention without adding a projection. Lost because queryability is a success criterion.

**Phase 2 recommendation (Candidate C):**

After Phase 1 establishes the convention and validates demand, add an end-of-session HEAD SHA mechanism:
- Extend `observation_recorded` enum with `git_head_sha_end` (or a new `session_completed` event that carries the end SHA and a step count)
- Console endpoint `GET /api/v2/sessions/:id/diff-summary` for authoritative LOC/files
- This should be a SEPARATE GitHub issue

**Candidates B and D:** Not recommended for this proposal.
- Candidate B (artifact contract): correct philosophy but wrong granularity (node-scoped). If enforcement is needed later, add it as an opt-in contract on a dedicated final step.
- Candidate D (event timestamps): separate infrastructure proposal. Track separately as `feat(engine): add event envelope timestamps`.

### Comparison summary

| Criterion | A (flat context_set) | B (artifact contract) | C (end SHA) | D (timestamps) |
|-----------|---------------------|----------------------|-------------|----------------|
| Backward compatible | ✅ | ❌ | ⚠️ | ⚠️ |
| Author burden | minimal | high | zero | zero |
| Type safety | weak (projection) | strong | strong (git) | N/A |
| Scope | best-fit | too broad | best-fit (Phase 2) | too broad |
| Phase | 1 | 2 (optional) | 2 | separate |

---

## Decision Log

### Selection: Candidate A (flat `context_set` convention + projection layer) for Phase 1

**Why Candidate A won:**
- Zero schema change: no event schema modifications, no workflow compilation changes, no breaking changes
- Best-fit boundary: the projection layer is exactly where existing advisory metadata (isAutonomous, gitBranch, parentSessionId) already lives
- `mergeContext` shallow semantics are safe for flat top-level keys (each `metrics_*` key persists independently)
- Backward-compatible: any existing session and any existing workflow continues to work unchanged
- The `isAutonomous` / `parentSessionId` precedent proves this is the approved WorkRail pattern for session-level advisory metadata

**Adversarial challenges survived:**
1. "Convention will never be adopted" -- real concern; implementation must include workflow step prompting guidance, not just docs. Does not invalidate the architecture.
2. "Flat keys pollute context" -- manageable with `metrics_` prefix convention. Not blocking.
3. "Phase 2 should be Phase 1" -- Phase 1 reliably delivers `metrics_outcome` and `metrics_pr_numbers` (agent knows these). Phase 2 delivers authoritative git stats (agent can't reliably compute LOC). The phase split is valid.
4. "Shallow merge erases history" -- REJECTED. Flat keys with `mergeContext` are safe; per-key persistence is correct.
5. "Auto-injected final step is more reliable" -- REJECTED. Auto-injection is a patch, not an architectural fix. Convention + prompting guidance is more flexible.

**Why Candidate C (runner-up) lost Phase 1:**
- Requires extending the closed `observation_recorded` discriminated union (schema migration, exhaustive handler updates)
- Requires git access at the WorkRail MCP/console boundary (new capability not currently present)
- Complex lifecycle hook at session completion
- These are real engineering investments appropriate for Phase 2, not Phase 1

**Why Candidate B lost:**
- Node-scoped artifacts are architecturally mismatched for session-level metrics
- High author burden (outputContract on final step) for advisory data
- All existing workflows require modification

**Why Candidate D is deferred:**
- Event timestamp addition is foundational infrastructure orthogonal to metrics capture
- Separate proposal: `feat(engine): add event envelope timestamps`

### Implementation notes (from adversarial challenge)

- Phase 1 MUST include concrete workflow step prompting guidance (not just convention docs) -- without prompting in the workflow itself, adoption is near-zero
- The most reliably self-reported metrics are: `metrics_outcome`, `metrics_pr_numbers`, `metrics_git_head_end` (advisory). Quantitative git stats (LOC, files) should wait for Phase 2
- Convention must be explicit that `metrics_pr_numbers` expects an array of integers (PR numbers), not URLs or strings

---

## Final Summary

### Recommendation

**Phase 1: Flat `context_set` key convention + `projectSessionMetricsV2` projection layer**

**Confidence: HIGH.** The design has been adversarially challenged, reviewed, and all tradeoffs/failure modes are explicitly addressed. No blocking issues were found.

**What to build:**

1. **Convention:** Agents use these flat top-level context keys (set via `continue_workflow`'s `context` field):
   - `metrics_outcome: 'success' | 'partial' | 'abandoned' | 'error'` -- required, highest-value metric
   - `metrics_pr_numbers: number[]` -- optional, array of PR numbers created
   - `metrics_git_head_end: string` -- optional, HEAD SHA at session completion (advisory, will be automated in Phase 2)
   - `metrics_files_changed: number` -- optional, agent-reported (advisory)
   - `metrics_lines_added: number` -- optional, agent-reported (advisory)
   - `metrics_lines_removed: number` -- optional, agent-reported (advisory)

2. **New projection:** `src/v2/projections/session-metrics.ts`
   - Pure function: `projectSessionMetricsV2(events: SortedEventLog): SessionMetricsV2 | null`
   - Reads the latest `context_set` event per run, extracts `metrics_*` keys
   - Defensive coercion: malformed values return null for that field (never throw)
   - Returns `null` if no `metrics_*` keys are present

3. **Console DTO update:** Add `metrics: SessionMetricsV2 | null` to `ConsoleSessionSummary` in `src/v2/usecases/console-types.ts`

4. **Console service update:** Call `projectSessionMetricsV2` in `console-service.ts` and populate the field

5. **Authoring docs (REQUIRED, not optional):**
   - `docs/authoring-v2.md`: Document the `metrics_*` convention
   - Include a concrete copy-paste step prompt template for the "report outcomes" step
   - Include explicit WARNING: DO NOT use `context.metrics = {...}` (nested objects are replaced, not merged)

6. **Console UI:** Advisory "agent-reported" label on all Phase 1 metric values

**Why flat keys, not nested `context.metrics`:** `mergeContext` is a shallow merge. Nested objects are replaced, not merged. If an agent sets `context.metrics = { pr_numbers: [123] }` at step 7 and `context.metrics = { lines_added: 50 }` at step 9, the `pr_numbers` key is LOST. Flat top-level keys (`metrics_pr_numbers`, `metrics_lines_added`) are independently persistent across multiple `context_set` events.

**Why `context_set` and not `wr.contracts.metrics` artifact:**
- Metrics are session-scoped; artifacts are node-scoped (wrong granularity)
- Artifact contracts require `outputContract` on specific steps; advisory metrics should be reportable at any step
- `context_set` is already the WorkRail pattern for session-level advisory metadata (`isAutonomous`, `parentSessionId`, `goal`)
- The advisory nature of self-reported data makes enforcement-heavy typed contracts over-engineered for Phase 1

### Phase 2 (separate proposal)

**Authoritative git metrics via end-of-session HEAD SHA observation**

- Add `git_head_sha_end` to the `observation_recorded` key set (requires discriminated union update)
- Emit it automatically when the session reaches `complete` state
- Console endpoint `GET /api/v2/sessions/:id/diff-summary` that computes `git diff --stat <start>..<end>`
- This supersedes agent-reported `metrics_git_head_end`, `metrics_files_changed`, `metrics_lines_added/removed`

Prerequisite: `metrics_git_head_end` in Phase 1 convention creates a forward-compatible bridge (same key, automated source in Phase 2).

### Deferred (separate proposals)

- **Event timestamps** (`timestampMs` in event envelope): Enables session duration from event log. Separate proposal: `feat(engine): add event envelope timestamps`
- **`wr.contracts.metrics` artifact contract**: If metrics ever need to drive workflow behavior (conditional branching), migrate from advisory `context_set` to a typed validated artifact. Escalation trigger documented.

### Strongest alternative (runner-up)

Candidate C (end-of-session HEAD SHA + post-hoc diff) would be selected if the primary goal were authoritative git stats rather than general-purpose outcome reporting. It is the right Phase 2.

### Residual risks

1. **Framing risk unverified:** Sample 10-20 real session logs before shipping to confirm agents don't already self-report informally in a conflicting way.
2. **Advisory `metrics_git_head_end` reliability:** Agents may report wrong commit (e.g., HEAD before final commit). Label as advisory; Phase 2 makes it authoritative.
3. **Convention projection callsite latency:** `projectSessionMetricsV2` adds a projection call to session summary loading. Should be lightweight (single context key read) and covered by the existing summary cache.
