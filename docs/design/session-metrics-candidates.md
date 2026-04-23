# Session Metrics -- Design Candidates

*Raw investigative material for main agent synthesis. Not a final decision.*

---

## Problem Understanding

**Tensions (real tradeoffs):**

1. **Type safety vs. ergonomics.** Typed artifact contracts enforce schema at runtime (valuable for machine-queryable data) but require `outputContract` declarations on specific workflow steps. `context_set` is untyped but universally writeable at any step with no workflow changes.

2. **Session-level vs. step-level.** Metrics (PR numbers, session outcome, files changed) are session-level outcomes. Artifacts are node-scoped by design. `context_set` is run-scoped (correct match). This is a real architectural mismatch for Candidate B.

3. **Agent self-reporting reliability vs. external observation.** Git stats (LOC, files changed) computed by the agent are advisory only. Capturing the HEAD SHA at start and end and running `git diff --stat` post-hoc gives authoritative numbers -- but requires new lifecycle infrastructure.

4. **Convention vs. enforcement.** A convention requires agents to follow it voluntarily. Without a schema or validation signal, agents will be inconsistent. Enforcement (artifact contract validation, auto-injected step prompts) adds ceremony but ensures consistency.

**What makes this hard:**

- `mergeContext` uses SHALLOW merge semantics -- nested object values are REPLACED, not merged. Using `context.metrics = {...}` as the carrier is a footgun: agents who set partial updates at different steps will silently lose earlier keys. Must use FLAT top-level keys instead.
- The `observation_recorded` event has a CLOSED discriminated union key set. Adding new keys is not a data change -- it requires updating the TypeScript schema union, all exhaustive handlers, and documentation.
- No event timestamps in the event envelope -- session duration is fundamentally uncomputable from the event log today, regardless of what metrics mechanism is chosen.
- The `context_set` projection (`projectRunContextV2` and `SessionIndex.runContextByRunId`) uses LATEST-WINS semantics per run. Each agent delta completely replaces the previous context snapshot. This is fine for flat top-level keys (each key is independently addressable) but breaks nested metrics accumulation.

**Likely seam:** The projection layer (`src/v2/projections/`) and the console session summary DTO (`src/v2/usecases/console-types.ts`). The capture boundary can stay unchanged; the gap is extraction and display.

---

## Philosophy Constraints

**Principles that matter most here:**

- **Prefer explicit domain types over primitives** -- `context_set` carries `JsonValue`, which is as primitive as it gets. A typed projection output (`SessionMetricsV2` interface) can add type discipline at the extraction boundary without changing the storage format.
- **Validate at boundaries, trust inside** -- the `projectSessionMetricsV2` projection should validate and coerce context keys into typed output at the projection boundary.
- **Exhaustiveness everywhere** -- any new event kind or `observation_recorded` key extension requires updating the discriminated union. This is a real cost, not just bureaucracy.
- **YAGNI with discipline** -- token cost metrics are not achievable today; do not design for them. Event timestamps are infrastructure worth doing but orthogonal to this proposal.
- **Architectural fixes over patches** -- auto-injected final step is a patch. The right architectural answer is to define a queryable projection over existing data.

**Philosophy conflicts:**

- Using `context_set` as a metrics carrier conflicts with "prefer explicit domain types." The conflict is manageable if the projection output is typed.
- The `wr.contracts.metrics` approach honors "prefer explicit domain types" but conflicts with YAGNI (high ceremony for advisory data) and the session-vs-node scope mismatch makes it architecturally wrong.

---

## Impact Surface

**Files that must stay consistent if we change the projection layer:**

- `src/v2/projections/session-metrics.ts` (new) -- must consume `SortedEventLog` like other projections
- `src/v2/usecases/console-service.ts` -- calls `projectSessionMetricsV2`, populates `ConsoleSessionSummary`
- `src/v2/usecases/console-types.ts` -- extends `ConsoleSessionSummary` with metrics field
- `console/src/api/types.ts` -- mirrors `ConsoleSessionSummary`; must be kept in sync
- `docs/authoring-v2.md` -- convention must be documented for workflow authors
- `src/v2/infra/local/session-summary-provider/index.ts` -- may need to call the new projection

**Contracts that must remain consistent:**

- `ConsoleSessionSummary` is a published DTO consumed by the console frontend; any new field must be backward-compatible (optional or null-safe).
- `SortedEventLog` is the canonical input type for projections; new projection must accept it.

---

## Candidates

### Candidate A: `context_set` convention with flat metrics keys (simplest sufficient)

**Summary:** Define a documented `metrics_*` key convention at the top level of `context_set` events. Implement `projectSessionMetricsV2` to extract these keys. Add `metrics: SessionMetricsV2 | null` to `ConsoleSessionSummary`.

**Tension resolution:**
- Resolves: minimal author burden, backward-compatible, queryable with new projection, no schema change
- Accepts: weak type safety (JsonValue storage), agent reliability (no enforcement), agents must self-compute git stats

**Boundary solved at:** Projection layer -- the existing `context_set` mechanism is unchanged; only the extraction and display layers are new.

**Why this boundary is best-fit:** The `isAutonomous` and `parentSessionId` precedents show that `context_set` is already the approved mechanism for session-level advisory metadata. Adding a `metrics_*` convention follows the exact same pattern. This is "validate at boundaries" -- the projection validates/coerces the advisory data into a typed interface.

**Specific convention:**
- `metrics_outcome: 'success' | 'partial' | 'abandoned' | 'error'`
- `metrics_pr_numbers: number[]`
- `metrics_files_changed: number` (advisory)
- `metrics_lines_added: number` (advisory)
- `metrics_lines_removed: number` (advisory)
- `metrics_git_head_end: string` (advisory HEAD SHA at end; superseded by Phase 2)

**Failure mode:** Agents use inconsistent key names or forget to report. Console shows null metrics for most sessions. Enforcement can be added incrementally (prompted via workflow step guidance).

**Repo-pattern relationship:** Follows `projectRunContextV2` and `ConsoleSessionSummary.isAutonomous` exactly.

**Gains:** Zero schema change, works for any workflow today, reversible (just remove the projection and console field).

**Losses:** Weak type safety, no enforcement, agent-computed git stats are advisory.

**Scope:** Best-fit for Phase 1.

**Philosophy fit:** Honors YAGNI. Conflicts with "prefer explicit domain types" (JsonValue storage, mitigated by typed projection output).

---

### Candidate B: `wr.contracts.metrics` artifact contract (typed, validated)

**Summary:** Define a new Zod-validated artifact contract `wr.contracts.metrics`, declared on a workflow's final/summary step `outputContract`. Machine-verifiable at `continue_workflow` boundary.

**Tension resolution:**
- Resolves: type safety, validation at boundary, machine-queryable via existing artifact projection
- Accepts: author burden (outputContract required on final step), node-scoped (architectural mismatch for session-level metrics), not universal for existing workflows

**Boundary solved at:** The artifact contract system (`src/v2/durable-core/schemas/artifacts/`).

**Why this boundary is WRONG for this problem:** Artifacts are node-scoped (`node_output_appended` with `scope: {runId, nodeId}`). Session-level metrics don't belong to any single node. The closest existing analogs (`wr.contracts.review_verdict`, `wr.contracts.assessment`) are also node-scoped but are semantically correct there (they assess what a node did). Metrics are session-level: they describe the session outcome, not what a node did.

**Failure mode:** Most workflows don't have a dedicated final/summary step. All existing workflows would need to be updated to add a final step with `outputContract: wr.contracts.metrics`. This is a high-friction migration.

**Repo-pattern relationship:** Adapts the existing artifact contract pattern (correct for node-level structured outputs).

**Gains:** Type safety, enforcement at boundary, reuses existing validation infrastructure.

**Losses:** High author burden, wrong granularity (node vs. session), not backward-compatible.

**Scope:** Too broad for Phase 1. Potentially valid as a Phase 2 opt-in (not mandatory) for workflows that want formal metrics reporting.

**Philosophy fit:** Honors "prefer explicit domain types", "validate at boundaries." Conflicts with YAGNI and "minimal author burden."

---

### Candidate C: End-of-session HEAD SHA observation + post-hoc diff (reframe)

**Summary:** Emit an additional `observation_recorded` event with key `git_head_sha_end` when the session reaches `complete` state. Add a console endpoint `GET /api/v2/sessions/:id/diff-summary` that runs `git diff --stat <start_sha>..<end_sha>` for authoritative LOC and files-changed.

**Tension resolution:**
- Resolves: agent reliability (git stats from git, not agent), no false precision, zero author burden for git metrics
- Accepts: schema change (closed enum extension), requires git access from WorkRail at query time, complex lifecycle hook at session completion

**Boundary solved at:** Two boundaries -- (1) session lifecycle (end-of-session observation emission), (2) console query layer (new endpoint).

**Why this boundary is right for Phase 2 but wrong for Phase 1:** Authoritative git stats are more valuable than advisory agent-reported stats. But extending the `observation_recorded` closed enum requires a schema union update, and WorkRail currently has no git access at the MCP handler level. This is a significant but well-bounded engineering investment, appropriate as a follow-up after Phase 1 validates demand.

**Specific shape:**
- New `observation_recorded` key: `git_head_sha_end` (requires extending `DomainEventV1Schema`)
- Emission hook: when `advanceAndRecord` produces `outcome.kind = 'advanced'` and the next snapshot state is `complete`, emit the end observation
- Console endpoint: reads start SHA (first `observation_recorded.git_head_sha`) + end SHA (last `observation_recorded.git_head_sha_end`), runs `git diff --stat start..end`, returns JSON

**Failure mode:** Extending the closed observation_recorded enum requires updating all exhaustive handlers. WorkRail has no git access today -- the console server would need to run the diff (it has access to the repo path via `repo_root` observation). Git history could be incomplete if the agent rebased between start and end.

**Repo-pattern relationship:** Extends the existing `observation_recorded` start-of-session pattern.

**Gains:** Authoritative git metrics, zero agent participation.

**Losses:** Schema blast radius (closed enum extension), new git access boundary, complex lifecycle hook.

**Scope:** Best-fit for Phase 2 (separate GitHub issue).

**Philosophy fit:** Honors "architectural fixes over patches", "determinism." Conflicts with YAGNI (Phase 1 perspective).

---

### Candidate D: Add `timestampMs` to event envelope (foundational duration infrastructure)

**Summary:** Add optional `timestampMs: number` to `DomainEventEnvelopeV1Schema`. Session duration = `last_event.timestampMs - first_event.timestampMs`.

**Tension resolution:**
- Resolves: session duration computable from event log without agent participation
- Accepts: significant schema change, not backward-compatible for existing sessions, adds size to every event

**Boundary solved at:** `DomainEventEnvelopeV1Schema` -- the lowest-level shared schema in the event log.

**Why this boundary is too broad:** This is foundational infrastructure that happens to enable one metric (duration). The blast radius affects every event builder, the session index, all parsers, and the design locks doc. This is a separate engineering investment that should be proposed and decided independently.

**Failure mode:** Existing sessions parse fine (optional field) but show null duration. Requires clock injection into all event builders. The design locks doc (`docs/design/v2-core-design-locks.md`) would need a new lock entry.

**Repo-pattern relationship:** Departs from existing pattern (events have no timestamps today).

**Gains:** Duration metrics without agent participation; future event-timing analytics.

**Losses:** Significant blast radius, orthogonal scope from "metrics capture."

**Scope:** Too broad for this proposal. Separate proposal: `feat(engine): add event envelope timestamps`.

---

## Comparison and Recommendation

**Primary recommendation: Candidate A (flat keys) for Phase 1. Candidate C for Phase 2.**

| Criterion | A (context_set) | B (artifact) | C (end SHA) | D (timestamps) |
|-----------|----------------|--------------|-------------|----------------|
| Backward compatible | ✅ | ❌ | ⚠️ | ⚠️ |
| Author burden | minimal | high | zero | zero |
| Type safety | projection-level | strong | git-authoritative | N/A |
| Scope | best-fit (P1) | too broad | best-fit (P2) | separate |
| Schema change | none | new files only | enum extension | all events |

**Candidate B loses:** Session-vs-node scope mismatch is architecturally wrong. High ceremony for advisory data.

**Candidate C is Phase 2:** Right solution for authoritative git stats, wrong phase (too complex for immediate need).

**Candidate D is a separate proposal:** Foundational infrastructure, orthogonal to metrics capture.

---

## Self-Critique

**Strongest counter-argument against Candidate A:**

Flat `metrics_*` keys pollute the global context namespace. A workflow author using `context.metrics_outcome` for their own purpose would silently conflict with the convention. The counter: the `metrics_` prefix is a documented namespace convention; conflicts are the author's error, not a framework deficiency.

**What would tip toward Candidate B:**

If the use case requires formal audit-trail compliance (e.g., billing based on LOC metrics), advisory `context_set` data is insufficient. Typed artifact contracts with validation would be necessary. No such requirement exists currently.

**What would tip toward doing nothing:**

If inspection of real session event logs reveals that agents ALREADY consistently self-report outcomes in step notes (plain markdown), the right solution is better console extraction of markdown content, not new capture infrastructure. This should be validated before Phase 1 implementation.

**Pivoting away from flat keys:**

If the context budget (`MAX_CONTEXT_BYTES = 256KB`) becomes a constraint (unlikely), or if namespace pollution proves problematic, a Phase 1.5 could introduce a lightweight `context.metrics` object with explicit full-replacement semantics (agents always send the complete object).

---

## Open Questions for Main Agent

1. Are agents already self-reporting outcomes in step notes? (Validate primary framing risk before implementing.)
2. Should Phase 1 include any enforcement signal (e.g., a final step prompt that asks for `metrics_*` keys), or is the convention sufficient initially?
3. Should `metrics_git_head_end` (advisory) be included in Phase 1, or deferred to Phase 2?
4. Is the context namespace pollution risk (flat `metrics_*` keys) acceptable, or should the convention use a namespacing strategy?
