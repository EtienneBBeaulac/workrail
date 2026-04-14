# WorkRail Console Execution-Trace Explainability -- Discovery Doc

**Status:** Complete
**Goal:** Identify everything the engine records that the console does not yet surface

## Final Summary

**Path used:** landscape_first -- gap analysis between what the engine records and what the console surfaces. Direct code reading of event schemas, projections, console-service.ts, and console DTOs.

**Problem framing:** The engine has a complete reasoning audit trail across 16 event kinds. The console renders 6-7. The gap is not a data problem -- it is a surfacing problem. All the data exists; three tiers of work are needed to expose it.

**Chosen direction:** Candidate B -- User-Question-Organized gap list with Priority Zero hybrid. Organizes 23 gaps by the user question they answer, with implementation tier noted per item. Priority Zero callout identifies the fast-win starting point.

**Why it won:** The brief explicitly requests 'the FULL set of things that should be visible.' Candidate B is the only response that satisfies this. Candidate C (minimum viable) covers only 3 of 23 items. Tier information is preserved per item so engineering can extract a sprint plan.

**Strongest alternative:** Candidate C (Minimum Viable Explainability). The right choice if the initiative is reframed as a quick-win sprint. Two of three named confusion patterns are Tier 1 rendering only (already computed, no backend change).

**Confidence band:** Medium-high. Gap list: high confidence (all 23 items traceable to specific code). Priority ordering: medium (user model unvalidated).

**Residual risks:**
1. User model unvalidated -- priority order within the gap list is assumption-driven. Run a 30-minute user research pulse with 3-5 users on real sessions before committing to full initiative scope.
2. Session detail API latency with 3 new projection calls not benchmarked.
3. CONTEXT_KEYS_TO_ELEVATE extension requires workflow-wide knowledge of routing-critical keys.

**Next actions for the design team:**
1. Review the Priority Zero items and ship the execution trace panel render (Tier 1, no backend change).
2. Run a user research pulse to validate the user model before proceeding.
3. If research confirms users cannot explain confusion after Priority Zero, proceed with the full 23-item design initiative.
4. If research confirms Priority Zero is sufficient, scope down to Candidate C.

**Artifacts:**
- `console-explainability-discovery.md` -- this document (primary deliverable)
- `console-explainability-design-candidates.md` -- three candidates with full reasoning
- `console-explainability-review-findings.md` -- tradeoffs, failure modes, findings

---

## Context / Ask

The WorkRail Console currently renders only `node_created` and `edge_created` events as a DAG.
Users see nodes and edges but have no visibility into:
- why the run jumped from phase 0 to phase 5 (fast-path conditions)
- what drove routing decisions (context variables like `taskComplexity`)
- why `blocked_attempt` nodes exist alongside regular step nodes
- what assessment gates concluded and whether they triggered follow-ups
- what loop iterations looked like and why a loop exited
- what divergences the engine deliberately recorded

The question: what is the full set of things users should be able to see?
This is a scoping document -- not an implementation plan.

---

## Path Recommendation

**landscape_first** -- the dominant need is understanding what data already exists in the
event log and projections vs. what the console currently exposes. There is no reframing
risk here; the problem statement is precise and grounded. A full-spectrum path would add
unnecessary overhead.

---

## Constraints / Anti-goals

- **In scope:** what data exists in the engine, what is hidden, what users would understand from seeing it
- **Out of scope:** how to implement UI panels, API changes, or performance implications
- **Anti-goal:** do not produce implementation specs or DTO changes in this discovery phase
- **Anti-goal:** do not invent data that isn't already being recorded

---

## Landscape Packet

### Event Types in the Engine (16 total in `EVENT_KIND`)

The engine records 16 distinct event kinds. The console renders only 2.

| Event Kind | Currently Surfaced? | What It Contains |
|---|---|---|
| `session_created` | No (implicit) | Session birth marker |
| `observation_recorded` | Partially (git_branch extracted for display) | git_branch, git_head_sha, repo_root_hash, repo_root -- with confidence levels |
| `run_started` | Partially (workflowId/hash shown) | workflowId, workflowHash, workflowSourceKind, workflowSourceRef |
| `node_created` | YES | nodeKind, parentNodeId, workflowHash, snapshotRef |
| `edge_created` | YES | edgeKind, fromNodeId, toNodeId, cause (kind + eventId) |
| `advance_recorded` | Partially (outcome.kind on node detail) | attemptId, intent, outcome (blocked/advanced with toNodeId) |
| `validation_performed` | YES (node detail only) | validationId, attemptId, contractRef, result (valid, issues, suggestions) |
| `node_output_appended` | YES (recap channel, artifact channel) | channel, payload (notes markdown or artifact ref) |
| `assessment_recorded` | NO -- projection exists, not wired to console | assessmentId, attemptId, artifactOutputId, summary, normalizationNotes, dimensions (dimensionId, level, rationale, normalization) |
| `assessment_consequence_applied` | NO -- projection exists, not wired to console | assessmentId, trigger (dimensionId, level), effect (kind: require_followup, guidance) |
| `preferences_changed` | NO | changeId, source (user/workflow_recommendation/system), delta, effective (autonomy, riskPolicy) |
| `capability_observed` | NO -- projection exists, not wired to console | capability (delegation/web_browsing), status (unknown/available/unavailable), provenance (probe_step/attempted_use/manual_claim with details) |
| `gap_recorded` | YES (node detail only, summary flags only) | gapId, severity (info/warning/critical), reason (category + detail), summary, resolution, evidenceRefs |
| `context_set` | PARTIAL -- only `taskComplexity` is elevated to execution trace contextFacts | contextId, full context object (JsonObject), source (initial/agent_delta) -- all other keys invisible |
| `divergence_recorded` | YES (surfaced as execution trace item kind='divergence') | divergenceId, reason (enum), summary, relatedStepId |
| `decision_trace_appended` | YES (surfaced in executionTraceSummary, but panel not yet implemented in UI) | traceId, entries (kind, summary, refs) -- entry kinds: selected_next_step, evaluated_condition, entered_loop, exited_loop, detected_non_tip_advance |

### Projections That Exist But Are Not Wired to Console DTOs

| Projection | File | Status |
|---|---|---|
| `projectAssessmentsV2` | `projections/assessments.ts` | Full projection, not called in console-service.ts |
| `projectAssessmentConsequencesV2` | `projections/assessment-consequences.ts` | Full projection, not called in console-service.ts |
| `projectCapabilitiesV2` | `projections/capabilities.ts` | Full projection, not called in console-service.ts |
| `projectRunContextV2` | `projections/run-context.ts` | Full projection, only used for session title derivation -- full context object not exposed |
| `projectRunExecutionTraceV2` | `projections/run-execution-trace.ts` | Computed and placed in `ConsoleDagRun.executionTraceSummary`, but the UI panel comment says "not yet implemented" |

### What `ConsoleDagRun.executionTraceSummary` Contains (Already Computed, Not Rendered)

The `executionTraceSummary` field on `ConsoleDagRun` is populated today via
`projectRunExecutionTraceV2`. It contains:

**Items** (from `decision_trace_appended` and `divergence_recorded`):
- `selected_next_step` -- engine chose a step; summary explains why
- `evaluated_condition` -- engine evaluated a routing condition; summary + condition_id ref
- `entered_loop` -- loop entry; summary + loop_id ref
- `exited_loop` -- loop exit (condition false OR max iterations); summary + loop_id ref
- `detected_non_tip_advance` -- advance from a non-tip node (DAG fork); summary
- `divergence` -- deliberate divergence; reason enum + summary + optional step_id ref

**Context Facts** (from `context_set`):
- Only `taskComplexity` is extracted (hardcoded `CONTEXT_KEYS_TO_ELEVATE`)
- All other context keys are ignored

### Edge Cause Codes (Invisible Today)

Each `edge_created` event carries a `cause` field with one of four codes:
- `idempotent_replay` -- the same advance was replayed (checkpoint recovery)
- `intentional_fork` -- user or engine deliberately branched
- `non_tip_advance` -- agent advanced from a non-tip node (deliberate branch)
- `checkpoint_created` -- edge created by checkpoint operation

These cause codes are stored in the DAG projection (`RunDagEdgeV2.cause`) but are not
included in the `ConsoleDagEdge` DTO -- so edges appear as undifferentiated lines.

### `blocked_attempt` Node Kind (Confusing Today)

Nodes with `nodeKind === 'blocked_attempt'` appear in the DAG alongside `step` and
`checkpoint` nodes. The console surfaces this kind label on `ConsoleDagNode.nodeKind`,
but there is no contextual explanation of:
- what blocked the attempt (the blockers from the `advance_recorded` event's `outcome.blockers`)
- how many re-attempts were made
- what validation failures triggered the block (linked `validation_performed` events)

### Assessment Gate Results (Completely Invisible)

The `assessment_recorded` and `assessment_consequence_applied` events form a complete
quality-gate audit trail:

**`assessment_recorded`** contains:
- `dimensions[]` -- each with dimensionId, level, optional rationale, normalization type
- `summary` -- overall assessment text
- `normalizationNotes[]` -- notes about how values were normalized

**`assessment_consequence_applied`** contains:
- Which dimension triggered the consequence
- The consequence effect (currently always `require_followup` with guidance text)

None of this is exposed in any console DTO today. The `projectAssessmentsV2` and
`projectAssessmentConsequencesV2` projections exist but are not called from
`console-service.ts`.

### Capability Probing Results (Completely Invisible)

`capability_observed` events record:
- Whether `delegation` or `web_browsing` is available/unavailable/unknown
- How it was determined: probe_step, attempted_use, or manual_claim
- Failure codes (tool_missing, tool_error, policy_blocked, unknown) for attempted_use failures

This explains why a run took a degraded path when a capability was unavailable.
The `projectCapabilitiesV2` projection exists but is not called from `console-service.ts`.

### Preferences Changes (Invisible)

`preferences_changed` events record:
- Who changed preferences: user, workflow_recommendation, or system
- What changed: autonomy mode, riskPolicy
- The effective state after the change

This explains why a run's behavior changed mid-execution (e.g. switched from guided to full_auto).

### Run Context -- Full Object (Mostly Invisible)

`context_set` records the full run context as a JsonObject. The console only elevates
`taskComplexity`. Other common context keys used for routing include:
- `goal`, `taskDescription` (already used for title derivation, not exposed as facts)
- `mrTitle`, `prTitle`, `ticketTitle`, `problem` (same)
- Any custom keys the workflow uses for routing decisions

The `projectRunContextV2` projection returns the full context object but only
`taskComplexity` is surfaced in the execution trace.

---

## Priority Zero: Fast-Win Starting Point

Before proceeding to the full initiative scope, implement these two items. They cover the three named confusion patterns from the brief and require the least backend change:

1. **Render the existing `executionTraceSummary` panel** (Tier 1 -- no backend change). The data is already computed and in `ConsoleDagRun.executionTraceSummary`. This explains fast-path phase skips (`selected_next_step`, `evaluated_condition` trace entries), loop structural jumps (`entered_loop`, `exited_loop`), and the `taskComplexity` routing driver. Zero backend work required.

2. **Add blocker detail to `ConsoleAdvanceOutcome`** (Tier 3 -- DTO extension). This explains why `blocked_attempt` nodes exist. Each blocker has a typed code (10-value enum), a typed pointer (context_key/capability/output_contract/workflow_step), a message, and optional suggestedFix. Currently only `outcome.kind = 'blocked'` is exposed.

**Scope-reduction trigger:** If user testing after shipping Priority Zero items shows users can explain all named confusion patterns, scope down to Candidate C and defer items 3-23.

---

## Comprehensive Gap List: Engine Records But Console Doesn't Surface

### (a) Workflow Structure Decisions

1. **Edge cause codes** -- why each edge exists (idempotent_replay, intentional_fork, non_tip_advance, checkpoint_created). Invisible on `ConsoleDagEdge` today.
2. **Condition evaluation results** -- `decision_trace_appended` entries with `kind='evaluated_condition'` include a condition_id ref and a summary, but the UI panel for executionTraceSummary is marked "not yet implemented."
3. **Step selection rationale** -- `selected_next_step` entries in the decision trace explain why the engine chose a particular next step (e.g. fast-path skip). Same panel gap.
4. **Non-tip advance detection** -- `detected_non_tip_advance` entries explain DAG forks. Same panel gap.

### (b) Run Context and Routing

5. **Full run context object** -- all keys beyond `taskComplexity` from `context_set` events are invisible. Any key the workflow uses for routing decisions (e.g. complexity tier, feature flags, user preferences) is hidden.
6. **Context source** -- whether context was set at `initial` startup vs. updated via `agent_delta` is not surfaced.
7. **`taskComplexity` value** -- technically in `executionTraceSummary.contextFacts`, but the UI panel isn't implemented yet.
8. **Preferences at time of run** -- `preferences_changed` events record autonomy mode and riskPolicy transitions, explaining mid-run behavior changes. Completely invisible.

### (c) Assessment Results

9. **Assessment dimensions** -- each dimension's level and rationale from `assessment_recorded` is fully invisible. Users don't know whether a quality gate passed or was borderline.
10. **Assessment summary** -- the overall summary text from `assessment_recorded` is invisible.
11. **Assessment normalization notes** -- how input values were normalized before assessment is invisible.
12. **Assessment consequences** -- when an assessment dimension triggered a `require_followup` consequence, the triggering dimension, level, and guidance text are invisible.

### (d) Loop and Iteration State

13. **Loop entry events** -- `entered_loop` decision trace entries with loop_id refs are in the execution trace but the UI panel isn't implemented.
14. **Loop exit reasons** -- `exited_loop` entries explain whether a loop exited due to condition=false or maxIterations reached. Invisible.
15. **Loop iteration counts** -- the engine tracks 0-based iteration on the loop stack; this is not surfaced anywhere in the console.

### (e) Blocked Attempt Context

Note: "Why is this node blocked?" requires BOTH Tier 2 (validation failure linkage) AND Tier 3 (blocker detail) simultaneously -- these are two distinct workstreams that must be coordinated.

16. **Blocker codes and pointers** -- each blocker in a `BlockerReport` has a typed `code` (one of 10 enum values: USER_ONLY_DEPENDENCY, MISSING_REQUIRED_OUTPUT, INVALID_REQUIRED_OUTPUT, MISSING_REQUIRED_NOTES, MISSING_CONTEXT_KEY, CONTEXT_BUDGET_EXCEEDED, REQUIRED_CAPABILITY_UNKNOWN, REQUIRED_CAPABILITY_UNAVAILABLE, INVARIANT_VIOLATION, STORAGE_CORRUPTION_DETECTED) and a typed `pointer` (discriminated union pointing at a specific context_key, capability, output_contract, or workflow_step). The console only shows `outcome.kind = 'blocked'`.
17. **Blocker messages and suggestedFix** -- each blocker carries a human-readable `message` and optional `suggestedFix`. Completely invisible.
18. **Validation failure linkage** -- `validation_performed` events are surfaced on node detail but not linked back to the blocked_attempt node that caused the block. The causal chain (validation fail -> blocked outcome -> blocked_attempt node) is not visualized.

### (f) Gap Reason Detail

19. **Gap reason category and detail** -- `gap_recorded` events carry a discriminated union `reason` field with category (`user_only_dependency`, `contract_violation`, `capability_missing`, `unexpected`) and a typed detail string. The `ConsoleNodeGap` DTO drops this entirely -- only `severity`, `summary`, and `isResolved` are exposed.
20. **Gap evidence refs** -- `gap_recorded` events carry optional `evidenceRefs` (event or output pointers) explaining what produced the gap. Completely invisible.

### (g) Capability and Environment

21. **Capability probe results** -- whether delegation/web_browsing was available and how it was determined. Explains why a run took a degraded path. Completely invisible.
22. **Capability failure codes** -- when a capability was attempted and failed, the failure code (tool_missing, tool_error, policy_blocked) is recorded but invisible.
23. **Observation confidence** -- `observation_recorded` events include a confidence field (low/med/high). Git branch is shown but confidence is dropped.

---

## Problem Frame Packet

### Primary Stakeholders

**WorkRail console users (agent operators):**
- Job: understand why their session executed the way it did
- Pain: DAG looks "broken" (phases skipped, unexpected forks, blocked_attempt nodes) with no explanation
- Success: can read a run and answer "why did the agent skip phase 3?" without opening raw JSON event logs

**WorkRail workflow authors:**
- Job: verify their routing logic, conditions, and assessment gates are working as designed
- Pain: no visibility into condition evaluation results, taskComplexity routing, or assessment dimensions
- Success: can see that `taskComplexity=simple` caused the fast-path and the assessment gate produced level=acceptable

**WorkRail maintainers / platform team:**
- Job: debug stuck or confusing runs reported by users
- Pain: must correlate across raw event log, projection code, and console UI manually
- Success: console surfaces enough that most run explanations don't require console->event-log context switching

### Core Tensions

1. **Information density vs. clarity** -- showing 23 hidden data items simultaneously would overwhelm users. The tension is deciding what to surface by default vs. on-demand drill-down.

2. **"Why" is scattered across event kinds** -- routing decisions live in `decision_trace_appended`, but the context that drove those decisions lives in `context_set`, and the consequences live in `assessment_consequence_applied`. These must be composed coherently, not dumped as raw events.

3. **Projection gap vs. DTO gap vs. rendering gap** -- the three tiers of gaps require different amounts of work:
   - Tier 1 (rendering only): `executionTraceSummary` data is already in the DTO
   - Tier 2 (service wiring): assessments/capabilities need console-service.ts calls + DTO fields
   - Tier 3 (implicit data): blocker detail, gap reason, edge cause codes need DTO shape changes

### Success Criteria

- A user can explain a fast-path skip ("jumped phase 0 to phase 5") by reading the console alone
- A user can explain a blocked_attempt node ("what blocked it and why")
- A user can see what drove routing (taskComplexity or other context variables)
- Assessment gate outcomes (passed/borderline dimensions, triggered follow-ups) are readable
- Loop iteration entry/exit reasons are visible

### Framing Risks (What Could Make This Wrong)

1. **Volume problem misframed as visibility problem** -- if users are overwhelmed today by the existing UI, adding 23 more data items might make it worse. The real ask may be "hide the complexity better" rather than "show more." Counter-evidence: the ask is explicitly for scoping "what should be visible" -- the design phase can address filtering/progressive disclosure.

2. **Execution trace panel is sufficient** -- if the `executionTraceSummary` panel (already computed, just unrendered) covers 80% of user confusion, the other 22 items may be low-priority noise. Counter-evidence: assessment results and blocker detail are clearly outside the execution trace and are independently high-value.

3. **Wrong user model** -- if primary users are "curious about the run" rather than "debugging a failure," the priority order changes (assessment results matter more than blocked_attempt blocker codes). No user research data available to validate.

### How Might We Questions

- HMW: make the DAG self-explanatory so users never need to wonder why a node exists?
- HMW: surface "why this path" as a first-class affordance tied to each edge, not as a separate panel?

### The Central Framing

The engine's event log is a complete trace of "what happened and why."
The console currently shows only "what happened" (the DAG topology).
The "why" layer exists in 14+ event kinds that are either completely invisible or
surfaced in an unimplemented UI panel.

### Priority Signal from the Code

The `executionTraceSummary` field is already computed and placed in the DTO with a
comment "not yet implemented" on the UI side. This is the highest-priority gap: the
data is already there, the projection is already running, only the rendering is missing.

The assessment projections (`projectAssessmentsV2`, `projectAssessmentConsequencesV2`)
are complete but not called from the service layer at all -- they require both service
wiring and DTO additions.

---

## Candidate Directions

Three candidate framings were evaluated for how to present this gap list to the design team.
All three cover the same 23 items -- they differ in organization and recommended priority.

### Candidate A: Tier-Organized (simplest, engineering-first)

Organize by implementation effort tier:
- Tier 1 (rendering only): render the `executionTraceSummary` panel -- data already in DTO
- Tier 2 (service wiring + DTO extension): wire assessment, capability projections to service
- Tier 3 (DTO shape change): blocker detail, gap reason detail, edge cause codes, full context, preferences

**Resolves:** DTO stability, sequential scoping.  
**Accepts:** Design team gets a backlog, not a user-facing vision.  
**Scope:** Too narrow for a design initiative kickoff; best for engineering sprint planning.

### Candidate B: User-Question-Organized (recommended)

Organize by the user question each item answers, with tier noted per item:
- "Why did the run skip phases?" -- decision trace + context (Tier 1 + Tier 3)
- "Why is this node blocked?" -- blocker detail (Tier 3)
- "What did the quality gate decide?" -- assessment dimensions + consequences (Tier 2)
- "What happened in this loop?" -- loop entry/exit events (Tier 1), iteration count (Tier 3)
- "Why did behavior change mid-run?" -- preferences changes (Tier 3)
- "Why did the run take a degraded path?" -- capability probing results (Tier 2)

**Resolves:** UI coherence, design team gets a vision.  
**Accepts:** Engineering must read more carefully to extract tier information.  
**Scope:** Best-fit for design initiative kickoff. Covers all stakeholder groups.

### Candidate C: Minimum Viable Explainability (narrowest scope)

Surface only the items that explain the three specific confusion patterns named in the problem statement:
1. Fast-path phase skips: execution trace entries -- Tier 1 rendering only
2. blocked_attempt nodes: blocker codes + messages -- Tier 3 DTO extension
3. Loop structural jumps: entered_loop/exited_loop trace entries -- Tier 1 rendering only

**Resolves:** YAGNI, fastest path to user-visible improvement.  
**Accepts:** Assessment results, capability degradation, preferences deferred.  
**Scope:** Best-fit for a quick-win sprint; too narrow for a full design initiative.

### Recommendation: Candidate B

The stated goal is a design initiative scoping document. Candidate B is the best fit because:
- Design kickoffs need user-question framing to build progressive-disclosure models
- Tier information is preserved per item so engineering can extract a backlog
- All three stakeholder groups (operators, workflow authors, platform maintainers) are covered
- The current structure of this doc already implements Candidate B

**Pivot condition:** If this is reframed as an engineering sprint plan, use Candidate A. If it is a quick-win sprint, use Candidate C.

**Strongest counter-argument:** Candidate C is faster and directly solves the named pain points. Counter: it leaves assessment and capability gaps unaddressed, which matters for workflow authors.

---

## Decision Log

- Chose `landscape_first` path: the problem is clearly framed (what does the engine record
  vs. what does the console show). No reframing is needed.
- Read source files directly rather than delegating: the codebase is small and targeted,
  delegation would add latency without quality improvement.
- Organized gap list by user question (Candidate B) rather than by tier (Candidate A) or
  minimum viable scope (Candidate C) -- best fit for a design initiative kickoff.
- Identified 23 gaps across 7 categories, all traceable to specific event kinds or projections.
- Added Priority Zero callout (hybrid from Candidate C) to provide a fast-win starting point.
- Added two-tier dependency note for 'why blocked?' section (Tier 2 + Tier 3 required simultaneously).
- Runner-up: Candidate C -- the right choice if the initiative is reframed as a quick-win sprint.
- Residual risks: (1) user model unvalidated -- priority order is assumption-driven; (2) session detail API latency with 3 new projection calls not benchmarked; (3) CONTEXT_KEYS_TO_ELEVATE extension requires workflow-wide knowledge.
- Confidence band: medium-high. Gap list is fully grounded in code; priority ordering within it has a known user-model assumption.
