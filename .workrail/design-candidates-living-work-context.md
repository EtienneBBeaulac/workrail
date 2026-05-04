# Living Work Context -- Discovery Design Doc

> **This document is for human readers.** It captures the design exploration process in readable form.
> It is NOT the execution record -- that lives in WorkRail session notes and context variables.
> Do not rely on this file to reconstruct workflow state after a crash.

---

## Context / Ask

**Stated goal:** Design and implement living work context for the WorkTrain daemon pipeline

**Reframed problem:** Each phase in the WorkTrain pipeline (discovery -> shaping -> coding -> review) spawns a fresh session with only what's in narrow handoff artifacts. Accumulated understanding, rationale, and decisions from earlier phases are discarded. Coding agents re-investigate things shaping already resolved. Review agents don't know why coding agents made specific decisions. Retry agents start blind.

**Goal was a solution statement.** The stated solution (living work context) may or may not be the best fit for the underlying problem.

---

## Path Recommendation

**Path: `design_first`**

Rationale: Goal was a solution statement with at least 3 materially different alternative solutions (richer typed handoffs, notes replay, compression step, shared store). The tradeoffs between these are unclear without understanding what context is actually missing and where failures occur. Committing to a shared store before knowing whether bilateral handoff enrichment would suffice risks over-building.

---

## Constraints / Anti-goals

**Constraints:**
- Must not add significant latency to phase spawning (phases already run 25-65 min each)
- Must be durable across session crashes (context store must survive a daemon restart)
- Must fit the existing coordinator architecture (`spawnSession` + `awaitSessions` + `getAgentResult` chain)
- Agents must not be required to read massive unstructured text -- targeted context retrieval beats full replay
- Must not require changes to the WorkRail engine's token/session protocol
- `assembledContextSummary` injection point in `buildSystemPrompt()` is the only mechanism to reach agents -- 8KB cap is a hard constraint

**Anti-goals:**
- Not a global knowledge graph (too complex for current maturity)
- Not a replacement for existing structured artifacts (`DiscoveryHandoffArtifactV1`, `ReviewVerdictArtifactV1`) -- coexist, don't replace
- Not a human-facing product feature -- purely infrastructure for pipeline coordination
- Not a general "agent memory" system -- scoped to one pipeline run at a time

---

## Landscape Packet

### Current inter-phase context flow (what actually happens today)

**Discovery -> Shaping:**
- Coordinator calls `getAgentResult(discoveryHandle)` -> reads `artifacts[]` and `recapMarkdown`
- If `wr.discovery_handoff` artifact present and Zod-valid: builds `shapingContext = { selectedDirection, designDocPath, assembledContextSummary: renderHandoff(artifact) }`
  - `renderHandoff()` in `src/coordinators/modes/full-pipeline.ts` produces: "## Discovery Handoff / Selected Direction / Confidence / Key Invariants (bullet list)"
- Fallback: if no artifact but `recapMarkdown.length > 50`: uses raw notes as `assembledContextSummary`
- Fallback 2: if notes too short or null: spawns shaping with NO prior context
- `assembledContextSummary` is capped at **8KB** in `buildSystemPrompt()` (`src/daemon/workflow-runner.ts:2051`) and placed in a `## Prior Context` section

**Shaping -> Coding:**
- Coordinator (`src/coordinators/modes/implement.ts`, `full-pipeline.ts`) passes only `{ pitchPath: workspace + '/.workrail/current-pitch.md' }` as context
- No `assembledContextSummary`. The coding agent gets: its own system prompt + soul + workspace rules + last-3-step-notes (800 chars each from its OWN prior steps) + the pitch file (only if the agent chooses to read it)
- The coding agent does NOT automatically receive discovery findings, key invariants, or shaping rationale

**Coding -> Review:**
- Coordinator (`src/coordinators/modes/implement-shared.ts:runReviewAndVerdictCycle`) passes only `{ prUrl }` as context
- The review agent receives NO context about why design decisions were made, what tradeoffs were explored, or what shaping concluded. It must infer everything from the PR diff alone.

**Review -> Fix loop:**
- Fix agent receives `{ prUrl, findings: findingSummaries[] }` -- array of one-line finding descriptions
- No design context, no shaping context, no discovery invariants

**What `DiscoveryHandoffArtifactV1` actually carries** (`src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`):
- `selectedDirection`: one-sentence description of chosen approach
- `designDocPath`: path to generated design doc (may be empty string)
- `confidenceBand`: high/medium/low
- `keyInvariants`: array of one-line invariant statements

**What `ReviewVerdictArtifactV1` carries** (`src/v2/durable-core/schemas/artifacts/review-verdict.ts`):
- `verdict`: clean/minor/blocking
- `confidence`: high/medium/low
- `findings[]`: `{ severity, summary, findingCategory? }`
- `summary`: one-line

**None of the phase workflows use template variable interpolation.** Context injection happens exclusively via `assembledContextSummary` in the system prompt (8KB cap) or via static workflow step prompts. No `{{contextVar}}` slots exist in `wr.discovery.json`, `wr.shaping.json`, `coding-task-workflow-agentic.json`, or `mr-review-workflow.agentic.v2.json`.

### Hard constraints identified

1. `assembledContextSummary` is a single string, 8KB cap, placed in `## Prior Context` section of system prompt (`workflow-runner.ts:2054`)
2. Workflow step prompts are static -- no per-phase context variable interpolation
3. Context flows only at session creation, not during a session's execution
4. `getAgentResult()` returns `{ recapMarkdown: string | null, artifacts: readonly unknown[] }` -- this is the entire inter-phase read surface
5. `spawnSession(workflowId, goal, workspace, context?, agentConfig?)` -- `context` is `Readonly<Record<string, unknown>>` and only `assembledContextSummary` (string) is extracted from it by `buildSystemPrompt()`

### Contradictions / gaps

1. **Shaping-to-coding gap**: shaping produces `current-pitch.md` but the coding agent receives no pointer to it in `assembledContextSummary`, only a `pitchPath` key in the context map that `buildSystemPrompt()` ignores (it only reads `assembledContextSummary`). The coding agent must discover and read the pitch file on its own.
2. **Review agent is flying blind**: knows only the PR URL. Cannot validate that implementation matches design intent.
3. **Discovery invariants evaporate**: `keyInvariants[]` from discovery handoff reach shaping but not coding or review.
4. **`DiscoveryHandoffArtifactV1` is too thin for a multi-phase chain**: `selectedDirection` is one sentence. No rejected directions. No codebase-specific implementation constraints. No file/function pointers to orient the coding agent.
5. **No cross-phase state**: each spawned session starts fresh -- prior phase session IDs, notes, and artifacts are not referenced.

### Precedents

- `assembledContextSummary` mechanism (8KB string in system prompt) is the current single injection mechanism
- `DiscoveryHandoffArtifactV1` is the only structured typed inter-phase artifact
- `ReviewVerdictArtifactV1` is coordinator-to-coordinator (not agent context injection)
- Session recap injection (`loadSessionNotes`) is only for SAME-session prior steps, not cross-session
- Per-run routing log files already exist at `{workspace}/.workrail/pipeline-runs/{timestamp}-{mode}.json` -- same path pattern as proposed `PipelineRunContext` file

---

## Problem Frame Packet

### Primary users / stakeholders

1. **Pipeline phase agents (discovery, shaping, coding, review)** -- need to know what prior phases decided and why, so they don't re-investigate settled questions or contradict upstream design intent.
2. **The coordinator (TypeScript code)** -- needs to read structured outputs from one phase and pass relevant fields to the next. Currently manual ad-hoc string assembly; needs typed data-driven threading.
3. **The WorkTrain operator** -- needs correct pipeline output without re-runs. Every context gap that causes an agent to make a wrong assumption is a potential failed pipeline run.

### Jobs / outcomes

- Coding agent: "Given the design intent from shaping, implement it correctly without re-discovering constraints"
- Review agent: "Given what the coding agent was trying to do and why, evaluate whether it succeeded"
- Coordinator: "Thread exactly the right context to each phase without manually serializing/deserializing ad-hoc fields"
- Operator: "Pipeline runs to correct completion without rework loops caused by context loss"

### Pains / tensions

**Tension 1: Completeness vs. token budget.** More context = fewer blind spots = better decisions. But every byte in the system prompt costs tokens and attention. 8KB is already ~2000 tokens -- a full pipeline with 4 phases could consume 8000+ tokens of prior-phase context before the agent reads a single line of code.

**Tension 2: Structure vs. flexibility.** Typed artifacts (like `DiscoveryHandoffArtifactV1`) force explicit contracts at phase boundaries -- high quality, but requires updating schemas whenever phase interfaces evolve. Unstructured text is flexible but brittle.

**Tension 3: What agents actually need vs. what's available.** The coding agent needs design constraints and key invariants -- the WHY. Currently it gets a pitch file path it must read itself. If the pitch is thin, the coding agent has no fallback. The context problem may be a pitch quality problem.

**Tension 4: Per-pipeline vs. cross-pipeline context.** The living work context vision is scoped to one pipeline run. But some context is durable across runs (workspace conventions, prior decisions about the same module). These are different stores with different lifetimes -- conflating them adds complexity for unclear benefit.

### Success criteria (observable)

1. Coding agent's step notes reference specific design constraints from the shaping phase without re-investigating them
2. Review agent can state in its step notes why specific architectural decisions were made -- not just what changed
3. A failed phase retry receives accumulated context from successful prior phases, not just the most recent attempt's state
4. Coordinator code reads from a typed store rather than manually assembling `assembledContextSummary` strings per phase-pair

### Primary framing risk

**The context gap may be a pitch quality problem, not a plumbing problem.** If `wr.shaping` produces high-quality pitches containing all design constraints and invariants, the coding agent already has what it needs via the pitch file. This was challenged and partially accepted: even with a perfect pitch, the review boundary (coding->review) is unambiguously broken -- review agents receive only a PR URL regardless of pitch quality. The plumbing fix is required at minimum for that boundary.

---

## Candidate Directions

*(Four candidates evaluated -- A through D. See candidate descriptions below. Decision: Full D+B. See Decision Log and Final Summary.)*

### Candidate A: Enrich bilateral handoff artifacts (no new infra)

Add `ShapingHandoffArtifactV1` and `CodingHandoffArtifactV1` following the `DiscoveryHandoffArtifactV1` pattern. Coordinator reads each artifact after `getAgentResult()`, renders to `assembledContextSummary`, passes to next `spawnSession()`. Manual per-phase-pair coordinator code unchanged.

**Lost to D+B because:** Doesn't make the coordinator data-driven -- each new phase-pair still requires new coordinator orchestration code. Token budget problem unaddressed. Per-run file adds crash durability that A lacks.

### Candidate B: Per-run typed pipeline context file

Per-pipeline-run JSON file accumulates typed phase records. Coordinator reads before each spawn, writes after each `getAgentResult()`. Data-driven coordinator -- no manual per-pair assembly.

**Won (as part of D+B) because:** Crash-durable, operator-inspectable, data-driven. Complements D's discriminated union cleanly.

### Candidate C: Pitch quality fix + minimal review injection (reframe)

Accept shaping->coding is covered by `current-pitch.md`. Add only `CodingHandoffArtifactV1` for coding->review. Audit `wr.shaping` for pitch completeness.

**Lost because:** Bets on pitch quality being sufficient without observational evidence. Leaves 3 of 4 boundaries unchanged. Cost of adding the shaping handoff is low; the risk of being wrong is high.

### Candidate D: Typed phase artifact registry + pure `buildContextSummary()`

Closed `PhaseHandoffArtifact` discriminated union. Coordinator accumulates artifacts generically. Pure `buildContextSummary(priorArtifacts, targetPhase)` function selects and renders only relevant fields per target phase. No per-pair hardcoding.

**Won (as part of D+B) because:** Most architecturally clean. Adding a new phase requires only a new Zod schema and union variant -- no coordinator orchestration changes. Fully testable pure function.

---

## Resolution Notes

The architecture question resolved cleanly once the "minimize work" constraint was removed. The full D+B design satisfies all 5 decision criteria better than any single candidate. Key resolution decisions:

1. **D+B over D alone:** Without the per-run context file (B), crash recovery requires re-running prior phases. The file is low-cost (same pattern as existing routing log files) and adds operator inspectability.
2. **`DiscoveryHandoffArtifactV1` enrichment is a prerequisite:** The entire inter-phase context chain is only as good as its upstream inputs. A thin discovery artifact means shaping starts under-informed, which means the pitch is thin, which means coding starts under-informed. Enriching the discovery artifact is not optional.
3. **`buildContextSummary()` selection is the key design decision at implementation time:** Which exact fields from which artifacts go to which target phase must be explicitly designed and unit-tested. This is deferred to implementation but must be treated as a first-class deliverable, not an afterthought.

### Open design gaps (must be addressed before implementation is complete)

**Gap 1: No typed `phaseOutcome` signal for coordinator routing**

`PipelineRunContext` stores `artifact | null` per phase, but both look identical to the coordinator. A thin completion (artifact absent, short recapMarkdown) and a rich completion (full artifact, detailed notes) are indistinguishable. The vision requires zero-LLM turns for routing -- but without a typed quality signal, the coordinator cannot deterministically decide "is this discovery output good enough to proceed to shaping, or should it retry?" Each `PhaseRecord` needs a structured outcome field:

```typescript
interface PhaseOutcome {
  readonly completionQuality: 'full' | 'partial' | 'fallback';
  // full = artifact present and Zod-valid
  // partial = artifact absent but recapMarkdown > threshold
  // fallback = both absent or too short
  readonly confidenceBand: 'high' | 'medium' | 'low' | null;
  // from the artifact's confidenceBand field, or null if fallback
}
```

This field is written by the coordinator after `getAgentResult()` and stored in `PipelineRunContext`. The coordinator can then route deterministically: retry if `completionQuality = 'fallback'`, escalate if confidence is low on a critical phase, proceed normally otherwise. No LLM reasoning required.

**Gap 2: "Spec as ground truth" not connected**

The vision explicitly names "wiring `wr.shaping` output into coordinator dispatch so coding/review agents work from the same spec." `ShapingHandoffArtifactV1` carries `pitchPath`, `selectedShape`, `keyConstraints[]` etc. -- but these are human-readable strings, not a machine-readable spec the coordinator can use to validate whether coding output matches shaping intent. The review agent receives the coding handoff artifact but has no structured way to check "did the implementation actually satisfy the shaping constraints?" This is the typed spec contract the vision describes. Two options:

- **Option A (simpler):** `ShapingHandoffArtifactV1` includes a `validationChecklist: string[]` -- explicit acceptance criteria the review agent must verify. Coordinator passes these as `reviewContext` alongside `prUrl`. Not a formal spec but structured enough to drive review focus.
- **Option B (full spec):** A `wr.shaping_spec` artifact with a machine-readable schema (typed fields, not prose). Coordinator validates coding output against spec programmatically. This is the vision's full intent but requires significant workflow authoring work.

**Recommendation:** Ship Option A now (adds `validationChecklist[]` to `ShapingHandoffArtifactV1`), defer Option B to a follow-on. The checklist is a meaningful step toward spec-as-ground-truth without the full schema investment.

**Gap 3: `buildContextSummary()` trimming has no priority order**

The Final Summary says "budget-trimmed to fit within 8KB" with no strategy for what gets dropped when the cap is hit. Silent truncation mid-string (the current `slice(0, 8192)` behavior in `buildSystemPrompt()`) can drop the most important discovery invariants if they happen to fall at the end of the rendered string. This violates the design's own success criterion.

Explicit priority order for `buildContextSummary()` trimming:

1. **Always include (never trim):** `implementationConstraints[]`, `keyConstraints[]` (hard constraints the agent must not violate), `outOfScope[]` (explicit no-build list), `keyDecisions[]` with WHY (architectural rationale)
2. **Include if budget allows:** `keyInvariants[]`, `rabbitHoles[]`, `rejectedDirections[]`, `knownLimitations[]`
3. **Include last:** `keyCodebaseLocations[]`, `filesChanged[]`, `testsAdded[]`

Each section is rendered as a complete unit -- never split mid-array. If a section doesn't fit in the remaining budget, it's omitted entirely rather than truncated mid-item. This is a required invariant in `buildContextSummary()` and must be covered by a unit test: `buildContextSummary([...oversizedArtifacts...], 'review')` → hard constraints present, lower-priority sections absent, no truncated items.

**Gap 4: `PipelineRunContext` is linear-pipeline-only -- epic-mode seam not named**

The current schema (`phases: { discovery?, shaping?, coding?, review? }`) assumes a single linear pipeline. Epic-mode (full autonomous delivery of a multi-task feature) requires a task-graph structure where each task has its own phase records and can reference sibling task outputs. The design should name this as a deliberate current-scope assumption and identify the seam that epic-mode would extend:

- `PipelineRunContext.phases` → `PipelineRunContext.tasks: { [taskId]: TaskRecord }` where `TaskRecord` contains the current `phases` shape plus `dependsOn: string[]` and `status: 'pending' | 'running' | 'complete' | 'failed'`
- `buildContextSummary(priorArtifacts, targetPhase)` → `buildContextSummary(priorArtifacts, targetPhase, siblingRecords?: readonly PipelineRunContext[])` where `siblingRecords` are the completed `PipelineRunContext` files for dependency tasks. `buildContextSummary()` extracts the `full` results from sibling coding phases to orient the current task's coding agent (what did adjacent tasks implement, what did they decide, what did they correct).

Neither of these is implemented now. The current linear design should explicitly note: "the `phases` key in `PipelineRunContext` and the `PhaseHandoffArtifact[]` accumulation pattern in `buildContextSummary()` are designed as a linear pipeline. Epic-mode extends this by replacing the flat `phases` object with a keyed `tasks` map. The seam is `PipelineRunContext.phases` -- do not use primitives or inline logic that assumes exactly one discovery, one shaping, one coding, one review phase."

---

## Decision Log

### Selected direction: Full D+B -- PhaseHandoffArtifact discriminated union + `buildContextSummary()` + `PipelineRunContext` per-run file

**Winner rationale:**
- Closes all 4 phase boundaries (discovery->shaping already exists; add shaping->coding, coding->review, coding->fix)
- Makes coordinator data-driven: reads typed `PipelineRunContext` file, passes accumulated artifacts to `buildContextSummary()` -- no manual per-pair string assembly
- Crash-durable: `PipelineRunContext` file survives daemon restart, restoring `priorArtifacts` without re-running phases
- Extensible: adding a new phase requires (a) new Zod schema, (b) new union variant, (c) new `buildContextSummary()` case -- no coordinator orchestration changes
- Satisfies all 5 decision criteria: coordinator fit (no engine changes), targeted context (pure function selects per target phase), crash durable (per-run file), token-efficient (selection logic trims to relevant fields), data-driven (typed store replaces manual assembly)

**Runner-up: A+D hybrid phased**
Implement `CodingHandoffArtifactV1` first, defer rest to Phase 2. Valid if scope is constrained. Not the best architecture -- defers the clean design for marginal scope savings.

**Accepted tradeoffs:**
1. `buildContextSummary()` selection logic encodes per-target-phase relevance -- wrong selections are silent. Mitigated by per-phase unit tests. Priority-ordered trimming (Gap 3 above) is a required invariant.
2. Per-run file adds file I/O and runId management -- worth it for crash durability and operator inspectability.
3. Three new Zod schemas to maintain alongside workflow authoring changes. Four if `validationChecklist[]` is added to `ShapingHandoffArtifactV1` (Gap 2 Option A).
4. `PipelineRunContext.phases` is linear-pipeline-only (Gap 4) -- explicitly named as a seam for epic-mode extension, not something to work around with inline assumptions.

**Identified failure modes:**
1. Phase agents omit artifacts on thin completions -- coordinator falls back to `recapMarkdown`. `phaseOutcome.completionQuality = 'fallback'` makes this observable and routeable (Gap 1).
2. Schema drift caught by Zod at read boundary -- needs a `DaemonEvent` for observability (follow-up issue).
3. `wr.shaping` and `wr.coding-task` workflows not updated -- entire system silently falls back. Mitigated by lifecycle integration tests asserting artifact presence.
4. `buildContextSummary()` selection logic incorrect -- agents receive irrelevant context, no type error. Mitigated by per-phase unit tests with priority-ordered trimming invariant (Gap 3).
5. `buildContextSummary()` silently truncates important context at 8KB cap -- mitigated by priority-ordered trimming with complete-section-or-omit rule (Gap 3).

**Switch triggers:**
- Coding agents produce correct output without shaping context in real runs: drop `ShapingHandoffArtifactV1`, use pitch content injection instead
- Coordinator threading code grows to 5+ per-pair blocks before D+B ships: add `buildContextSummary()` first
- `buildContextSummary()` selection logic is unclear upfront: implement per-pair first (Candidate A shape), extract to pure function once selection logic is empirically validated
- Epic-mode work begins: replace `PipelineRunContext.phases` flat object with `tasks` keyed map (Gap 4 seam)

---

## Final Summary

### Recommendation: Full D+B architecture

**Problem:** Each WorkTrain pipeline phase spawns with almost no context from prior phases. Discovery invariants evaporate after shaping. The coding agent receives only a `pitchPath` it must read itself. The review agent receives only a `prUrl`. The coordinator manually assembles ad-hoc strings with no schema. Agents re-investigate settled questions and miss design-level issues in review.

Additionally, **`DiscoveryHandoffArtifactV1` is too thin** to support the full context chain: `selectedDirection` is one sentence with no rejected directions, no implementation-relevant constraints, and no codebase file/function pointers. Enriching it is a prerequisite to the architecture being useful.

---

### Component 0: Enrich `DiscoveryHandoffArtifactV1` (prerequisite)

**File:** `src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`

Add to existing schema:
```typescript
// New fields added to DiscoveryHandoffArtifactV1Schema:
rejectedDirections: z.array(z.object({
  direction: z.string().max(200),
  reason: z.string().max(300),
})).max(5),

implementationConstraints: z.array(z.string().max(200)).max(8),
// Things the coding agent MUST respect (e.g. "do not add new DB columns", "must be backward-compatible")

keyCodebaseLocations: z.array(z.object({
  path: z.string().max(300),
  relevance: z.string().max(150),
})).max(10),
// Files/functions the implementation will touch -- orients coding agent without re-running discovery
```

**Workflow change required:** `workflows/wr.discovery.json` final handoff step -- update agent instruction to emit the enriched fields.

---

### Component 1: `PhaseHandoffArtifact` closed discriminated union

**File:** `src/v2/durable-core/schemas/artifacts/phase-handoff.ts` (new)

```typescript
export type PhaseHandoffArtifact =
  | DiscoveryHandoffArtifactV1
  | ShapingHandoffArtifactV1
  | CodingHandoffArtifactV1;
```

**`ShapingHandoffArtifactV1` schema:**
```typescript
export const ShapingHandoffArtifactV1Schema = z.object({
  kind: z.literal('wr.shaping_handoff'),
  version: z.literal(1),
  pitchPath: z.string().min(1),          // absolute path to current-pitch.md
  selectedShape: z.string().max(200),    // one-sentence: which solution shape was chosen
  appetite: z.string().max(100),         // e.g. "Small batch (1-2 days)", "Medium (1 week)"
  keyConstraints: z.array(z.string().max(200)).max(8),
  // What the coding agent must respect (design constraints, not implementation details)
  rabbitHoles: z.array(z.string().max(200)).max(6),
  // What NOT to build -- prevents scope creep during coding
  outOfScope: z.array(z.string().max(200)).max(6),
  // Explicitly ruled out during shaping
  validationChecklist: z.array(z.string().max(200)).max(10),
  // Explicit acceptance criteria the review agent must verify (Gap 2 Option A: step toward spec-as-ground-truth)
  // Each item is a verifiable condition: "All existing tests pass", "No new DB columns added",
  // "Auth middleware is not modified". Review agent checks these explicitly before verdicting.
}).strict();
```

**`CodingHandoffArtifactV1` schema:**
```typescript
export const CodingHandoffArtifactV1Schema = z.object({
  kind: z.literal('wr.coding_handoff'),
  version: z.literal(1),
  branchName: z.string().min(1),         // git branch containing the changes
  keyDecisions: z.array(z.string().max(200)).max(8),
  // Architectural decisions made during coding and WHY -- review agent needs these
  knownLimitations: z.array(z.string().max(200)).max(6),
  // Known gaps or shortcuts taken -- review agent should not flag these as surprises
  testsAdded: z.array(z.string().max(200)).max(10),
  // Test files/test names added -- review agent can verify coverage
  filesChanged: z.array(z.string().max(300)).max(20),
  // Primary files changed -- orients review agent before it reads the diff
  correctedAssumptions: z.array(z.object({
    assumed: z.string().max(200),   // what the coding agent believed
    actual: z.string().max(200),    // what turned out to be true
  })).max(6).optional(),
  // WHY: vision requirement -- "when WorkTrain is wrong about something, it acknowledges it
  // explicitly in session notes so the next session starts with accurate context."
  // Populated by the fix agent after corrections, not the original coding agent.
  // Optional because most coding sessions have no corrected assumptions.
}).strict();
```

All new artifacts: Zod-validated at coordinator read boundary. Emitted in `complete_step` artifacts on the final step of each workflow.

---

### Component 2: `buildContextSummary()` pure function

**File:** `src/coordinators/context-assembly.ts` (new)

```typescript
export function buildContextSummary(
  priorArtifacts: readonly PhaseHandoffArtifact[],
  targetPhase: 'shaping' | 'coding' | 'review' | 'fix',
): string;
```

**Per-phase selection logic (the key correctness surface):**

| Target phase | Artifacts included | Fields included |
|---|---|---|
| `'shaping'` | `wr.discovery_handoff` | `selectedDirection`, `rejectedDirections[]`, `implementationConstraints[]`, `keyInvariants[]`, `keyCodebaseLocations[]` |
| `'coding'` | `wr.discovery_handoff`, `wr.shaping_handoff` | Discovery: `implementationConstraints[]`, `keyInvariants[]`, `keyCodebaseLocations[]`. Shaping: `selectedShape`, `appetite`, `keyConstraints[]`, `rabbitHoles[]`, `outOfScope[]` |
| `'review'` | all three | Discovery: `implementationConstraints[]`, `keyInvariants[]`. Shaping: `keyConstraints[]`, `outOfScope[]`, `validationChecklist[]`. Coding: `keyDecisions[]`, `knownLimitations[]`, `filesChanged[]`, `correctedAssumptions[]` |
| `'fix'` | `wr.shaping_handoff`, `wr.coding_handoff` | Shaping: `keyConstraints[]`, `outOfScope[]`, `validationChecklist[]`. Coding: `keyDecisions[]`, `knownLimitations[]`, `correctedAssumptions[]` |

Output is a rendered markdown string, budget-trimmed to fit within 8KB. Each artifact's section is rendered independently; sections are concatenated with `---` separators.

**Priority-ordered trimming (Gap 3 -- required invariant, never truncate mid-item):**

| Priority | Fields | Rule |
|---|---|---|
| 1 -- always include | `implementationConstraints[]`, `keyConstraints[]`, `outOfScope[]`, `validationChecklist[]`, `keyDecisions[]` | Hard constraints and rationale. Never dropped regardless of budget. |
| 2 -- include if budget allows | `keyInvariants[]`, `rabbitHoles[]`, `rejectedDirections[]`, `knownLimitations[]` | Design context. Dropped as a complete section if budget is insufficient. |
| 3 -- include last | `keyCodebaseLocations[]`, `filesChanged[]`, `testsAdded[]` | Orientation aids. Dropped first when budget is tight. |

**Trimming rule:** sections are rendered as complete units or omitted entirely. Never split an array mid-item. If adding a section would exceed the 8KB budget, omit the entire section and log a warning naming which section was dropped.

No I/O. Pure. Fully unit-testable per target phase with assertions on section presence and field content. Required test: `buildContextSummary([...oversizedArtifacts...], 'review')` → priority-1 fields present, priority-3 fields absent, no truncated items, output ≤ 8KB.

---

### Component 3: `PipelineRunContext` per-run JSON file

**Path:** `{workspace}/.workrail/pipeline-runs/{runId}-context.json`

**Schema:**
```typescript
// PhaseResult: discriminated union replaces the previous pattern of
// artifact|null + PhaseOutcome + recapMarkdown as three separate fields
// that could be mutually inconsistent (e.g. artifact=valid but outcome='fallback').
// Makes illegal states unrepresentable. Every coordinator switch is exhaustive by type.
//
// WHY generic: each phase has a different artifact type but the same result shape.
// A single generic type enforces the invariant once rather than repeating it per phase.
type PhaseResult<TArtifact> =
  | {
      readonly kind: 'full';
      readonly artifact: TArtifact;
      readonly confidenceBand: 'high' | 'medium' | 'low';
      readonly recapMarkdown: string | null;  // notes for human inspection
    }
  | {
      readonly kind: 'partial';
      readonly recapMarkdown: string;  // guaranteed non-empty (> 50 chars)
    }
  | {
      readonly kind: 'fallback';
      readonly recapMarkdown: string | null;
    };

interface PipelineRunContext {
  readonly runId: string;           // UUID, generated at coordinator start
  readonly goal: string;
  readonly workspace: string;
  readonly startedAt: string;       // ISO timestamp
  readonly pipelineMode: 'FULL' | 'IMPLEMENT' | 'REVIEW_ONLY' | 'QUICK_REVIEW';
  // DELIBERATE SCOPE CONSTRAINT: phases is a flat linear-pipeline object.
  // Epic-mode extends this by replacing phases with tasks: { [taskId]: TaskRecord }.
  // Do not add inline logic that assumes exactly one of each phase type.
  readonly phases: {
    readonly discovery?: DiscoveryPhaseRecord;
    readonly shaping?: ShapingPhaseRecord;
    readonly coding?: CodingPhaseRecord;
    readonly review?: ReviewPhaseRecord;
  };
}

interface DiscoveryPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<DiscoveryHandoffArtifactV1>;
}

interface ShapingPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<ShapingHandoffArtifactV1>;
}

interface CodingPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<CodingHandoffArtifactV1>;
}

interface ReviewPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<ReviewVerdictArtifactV1>;
}
```

**RunId generation:** `randomUUID()` at the top of `runFullPipeline()` / `runImplementPipeline()`. Passed as a parameter to all sub-functions that spawn sessions. NOT threaded through `spawnSession()` itself -- stored in closure scope of the coordinator function.

**Lifecycle:**
- Created (empty `phases: {}`) at coordinator start, before first spawn
- Updated after each `getAgentResult()` call -- coordinator writes the completed phase record
- Read at coordinator start -- if a `{runId}-context.json` exists (crash recovery), prior phase artifacts are restored into `priorArtifacts` and the pipeline resumes from the next pending phase
- Retained after completion (not deleted) -- operator can inspect

**`AdaptiveCoordinatorDeps` additions** (`src/coordinators/adaptive-pipeline.ts`):
```typescript
readPipelineContext(runId: string): Promise<Result<PipelineRunContext | null, string>>;
// Takes a complete named phase record type -- not Partial<phases> -- so each write is a
// valid whole record. Validate at the write boundary, trust inside.
writePhaseRecord(runId: string, phase: 'discovery', record: DiscoveryPhaseRecord): Promise<Result<void, string>>;
writePhaseRecord(runId: string, phase: 'shaping', record: ShapingPhaseRecord): Promise<Result<void, string>>;
writePhaseRecord(runId: string, phase: 'coding', record: CodingPhaseRecord): Promise<Result<void, string>>;
writePhaseRecord(runId: string, phase: 'review', record: ReviewPhaseRecord): Promise<Result<void, string>>;
generateRunId(): string;  // returns randomUUID() -- injectable for test determinism
```

**`PhaseResult` construction (coordinator responsibility, not deps layer):**
The coordinator builds a `PhaseResult` from `getAgentResult()` output before calling `writePhaseRecord()`:
```typescript
// Pure function -- testable in isolation, no I/O
function buildPhaseResult<TArtifact extends { confidenceBand: 'high' | 'medium' | 'low' }>(
  artifact: TArtifact | null,
  recapMarkdown: string | null,
): PhaseResult<TArtifact> {
  if (artifact !== null) {
    return { kind: 'full', artifact, confidenceBand: artifact.confidenceBand, recapMarkdown };
  }
  if (recapMarkdown !== null && recapMarkdown.trim().length > 50) {
    return { kind: 'partial', recapMarkdown: recapMarkdown.trim() };
  }
  return { kind: 'fallback', recapMarkdown };
}
```
The threshold `50` matches `MIN_NOTES_LENGTH_FOR_FALLBACK` in `full-pipeline.ts`. Coordinator switches on `result.kind` exhaustively -- TypeScript enforces all three cases are handled.

---

### Coordinator call sites (files to change)

| File | Change |
|---|---|
| `src/coordinators/adaptive-pipeline.ts` | Add `readPipelineContext`, `writePhaseRecord` (overloaded), `generateRunId` to `AdaptiveCoordinatorDeps` interface |
| `src/trigger/coordinator-deps.ts` | Implement new deps methods (file I/O, atomic write via temp-rename) |
| `src/coordinators/context-assembly.ts` | New file. Contains `buildContextSummary()`, `buildPhaseResult()`, and `extractPhaseArtifact<T>(artifacts, schema)` -- consolidates all artifact validation/extraction logic currently scattered across `full-pipeline.ts` and `runReviewAndVerdictCycle()`. All three are pure functions. |
| `src/coordinators/modes/full-pipeline.ts` | Generate `runId` at top; replace inline `readDiscoveryHandoffArtifact()` with `extractPhaseArtifact()`; call `buildPhaseResult()` + `writePhaseRecord()` after each phase; call `buildContextSummary(priorArtifacts, targetPhase)` before each spawn |
| `src/coordinators/modes/implement.ts` | Same as above for IMPLEMENT mode |
| `src/coordinators/modes/implement-shared.ts` | `runReviewAndVerdictCycle()`: receive `priorArtifacts` parameter; call `buildContextSummary(priorArtifacts, 'review')` before review spawn; call `buildContextSummary(priorArtifacts, 'fix')` before fix spawn |
| `src/coordinators/modes/quick-review.ts` | Pass `priorArtifacts` if any; call `buildContextSummary(priorArtifacts, 'review')` |
| `src/daemon/workflow-runner.ts` | `buildSystemPrompt()`: named as a follow-on -- currently takes one `assembledContextSummary` string. Longer-term should take a `StructuredContext` object with named semantic slots. Not required for this design to work but is the right direction. |

---

### Workflow authoring changes (hard prerequisites)

All four workflows below must be updated before the coordinator changes are considered complete. The system silently falls back to `recapMarkdown` if any workflow is not updated.

---

**`workflows/wr.discovery.json` -- final handoff step:**

The discovery workflow accumulates information across all its phases, but the current final step prompt only asks the agent to emit the existing thin `wr.discovery_handoff` artifact. The agent needs to understand that it should have been collecting `rejectedDirections`, `implementationConstraints`, and `keyCodebaseLocations` throughout its session, not just at the end.

Update the `phase-7-handoff` step prompt to say: "Throughout this session you have explored directions, made decisions, and identified constraints. Now emit a `wr.discovery_handoff` artifact that captures what you learned." The enriched fields must be framed as things the agent accumulated, not invented at handoff time.

Artifact now includes: `selectedDirection`, `rejectedDirections[]`, `implementationConstraints[]`, `keyInvariants[]`, `keyCodebaseLocations[]`, `confidenceBand`, `designDocPath`.

---

**`workflows/wr.shaping.json` -- `finalize` step (id: `finalize`):**

Add to `outputContract`:
```json
"outputContract": {
  "artifactRef": "wr.contracts.shaping_handoff"
}
```

Add to step `prompt` (append to existing text):
```
After writing pitch.md, emit a wr.shaping_handoff artifact in your complete_step call:
{
  "kind": "wr.shaping_handoff",
  "version": 1,
  "pitchPath": "<absolute path to current-pitch.md>",
  "selectedShape": "<one sentence: which solution shape was chosen>",
  "appetite": "<time budget: e.g. 'Small batch (1-2 days)'>",
  "keyConstraints": ["<design constraint the coding agent must respect>", ...],
  "rabbitHoles": ["<scope trap to avoid>", ...],
  "outOfScope": ["<explicitly ruled out>", ...],
  "validationChecklist": ["<verifiable acceptance criterion for the review agent>", ...]
}
```

---

**`workflows/coding-task-workflow-agentic.json` -- `phase-8-retrospective` step:**

Add to `outputContract`:
```json
"outputContract": {
  "artifactRef": "wr.contracts.coding_handoff"
}
```

Add to step `prompt` (append to existing text):
```
Before completing this step, emit a wr.coding_handoff artifact:
{
  "kind": "wr.coding_handoff",
  "version": 1,
  "branchName": "<git branch name>",
  "keyDecisions": ["<decision + why>", ...],
  "knownLimitations": ["<known gap or shortcut>", ...],
  "testsAdded": ["<test file or test name>", ...],
  "filesChanged": ["<primary file path>", ...]
}
If the fix agent corrected any assumptions you made, include correctedAssumptions:
  "correctedAssumptions": [{"assumed": "<what you believed>", "actual": "<what was true>"}, ...]
```

---

**`workflows/mr-review-workflow.agentic.v2.json` -- `phase-0-understand-and-classify` step:**

The review workflow currently receives `{ prUrl, findings }` as context. It needs to receive and actively use `validationChecklist[]` from the shaping handoff.

Update `phase-0-understand-and-classify` to explicitly check each `validationChecklist` item:

Add to step `prompt` (insert after the "Step 1 -- Early exit" block):
```
Step 1b -- Validation checklist:
If `validationChecklist` is provided in context, verify each item explicitly before
proceeding to deeper review. These are acceptance criteria declared during shaping:
- Each item should be checked against the diff and test results
- A failing checklist item is a blocking finding regardless of other review depth
- Record which items passed, which failed, and which could not be verified
```

This step is what closes spec-as-ground-truth: the review agent verifies structured criteria, not just its own judgment of the diff.

---

### Tests required

**Unit tests (`tests/unit/coordinators/context-assembly.test.ts`):**
- `buildContextSummary([], 'coding')` → empty string
- `buildContextSummary([discoveryArtifact], 'coding')` → contains `implementationConstraints`, `keyCodebaseLocations`, does NOT contain `selectedDirection` (not relevant to coding agent)
- `buildContextSummary([discoveryArtifact, shapingArtifact], 'coding')` → contains both discovery implementation constraints AND shaping `keyConstraints[]` and `rabbitHoles[]`
- `buildContextSummary([discoveryArtifact, shapingArtifact, codingArtifact], 'review')` → contains coding `keyDecisions[]`, shaping `outOfScope[]`, shaping `validationChecklist[]`, discovery `keyInvariants[]`
- `buildContextSummary([...longArtifacts...], 'review')` → output length ≤ 8KB, priority-1 fields present (`keyConstraints`, `validationChecklist`, `keyDecisions`), priority-3 fields absent, no truncated array items

**Unit tests (`tests/unit/coordinators/build-phase-result.test.ts`):**
- Full artifact → `PhaseResult { kind: 'full', artifact, confidenceBand }`
- No artifact, long recapMarkdown → `PhaseResult { kind: 'partial', recapMarkdown }`
- No artifact, short recapMarkdown (≤ 50 chars) → `PhaseResult { kind: 'fallback' }`
- No artifact, null recapMarkdown → `PhaseResult { kind: 'fallback' }`
- TypeScript: switch on `result.kind` is exhaustive -- all three cases required

**Unit tests (`tests/unit/coordinators/pipeline-run-context.test.ts`):**
- `writePhaseRecord` then `readPipelineContext` round-trips cleanly with correct `result.kind`
- Write two phases with different `result.kind` values, read restores both correctly
- Read on missing file returns `ok(null)` (no error)
- Write is atomic (uses temp-rename, partial writes not possible)
- TypeScript: `writePhaseRecord('discovery', codingRecord)` is a compile-time error -- phase and record type must match

**Unit tests (`tests/unit/coordinators/extract-phase-artifact.test.ts`):**
- `extractPhaseArtifact([], ShapingHandoffArtifactV1Schema)` → `null`
- `extractPhaseArtifact([validArtifact], ShapingHandoffArtifactV1Schema)` → typed artifact
- `extractPhaseArtifact([invalidArtifact], ShapingHandoffArtifactV1Schema)` → `null` (Zod failure, logs warn)
- `extractPhaseArtifact([wrongKindArtifact], ShapingHandoffArtifactV1Schema)` → `null` (kind mismatch)

**Lifecycle integration tests (`tests/lifecycle/`):**
- `wr.discovery` final handoff step emits enriched `wr.discovery_handoff` with `rejectedDirections`, `implementationConstraints`, `keyCodebaseLocations`
- `wr.shaping` final step emits `wr.shaping_handoff` with all required fields including `validationChecklist`
- `coding-task-workflow-agentic` final step emits `wr.coding_handoff` with all required fields
- `mr-review-workflow` `phase-0-understand-and-classify` step processes `validationChecklist` items when provided in context

---

### Confidence: high

Architecture is grounded in existing patterns (`DiscoveryHandoffArtifactV1`, `AdaptiveCoordinatorDeps` DI interface, per-run routing log files). All 5 decision criteria satisfied. The four open gaps (phaseOutcome signal, spec-as-ground-truth, trimming priority order, epic-mode seam) are fully specified above -- they are design completeness items, not direction problems.

### Residual risks

1. **`buildContextSummary()` selection logic** -- priority-ordered trimming table above is the spec; per-phase unit tests with complete-section-or-omit invariant are the verification. Wrong selections are silent (no type error).
2. **Four workflow authoring prerequisites** -- if any of `wr.discovery`, `wr.shaping`, `wr.coding-task`, or `mr-review-workflow` are not updated, the system silently falls back or ignores structured context. Lifecycle integration tests per workflow must be written before the coordinator changes are considered complete.
3. **RunId threading** -- runId is generated at coordinator start and passed in closure scope. The `PipelineRunContext` file's existence on disk is the crash recovery signal.
4. **`DiscoveryHandoffArtifactV1` enrichment** -- new fields must use `z.optional()` so existing sessions degrade gracefully rather than fail Zod validation.
5. **`buildPhaseResult()` threshold** -- "partial" vs "fallback" depends on `recapMarkdown.length > 50`. Threshold matches `MIN_NOTES_LENGTH_FOR_FALLBACK` in `full-pipeline.ts`. If that constant changes, `buildPhaseResult()` must change with it. Name the dependency explicitly.
6. **Epic-mode seam** -- no inline logic should assume exactly one of each phase type. The `phases` flat object is the named seam.
7. **`buildSystemPrompt()` single-string constraint** -- the `assembledContextSummary` string blob is a limitation of the current `workflow-runner.ts` implementation, not an architectural constraint. The follow-on for named semantic slots in `buildSystemPrompt()` is the right direction and should not be designed around.

### Runner-up

A+D hybrid phased approach -- implement `CodingHandoffArtifactV1` only first, defer rest. Valid if scope is constrained. Not the best architecture.
