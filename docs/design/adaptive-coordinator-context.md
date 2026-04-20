# Adaptive Coordinator Context Passing -- Discovery Design Document

**Status:** Complete (wr.discovery workflow)
**Date:** 2026-04-19
**Author:** WorkTrain autonomous session

---

## Context / Ask

**Stated goal (original framing):** Design how context passes between phases in the WorkTrain adaptive pipeline -- so each spawned session starts informed by previous phases, not from scratch.

**Reframed problem:** WorkTrain phases are isolated sessions with no automatic mechanism for structured output from one phase to become structured input to the next, so coordinators must bridge that gap manually without a clear contract.

**Scope:** `src/coordinators/`, `src/context-assembly/`, `src/daemon/`. NOT `src/mcp/`.

**Coordination artifact:** This doc captures inter-phase context-passing design decisions. A parallel discovery agent is designing routing/classification in `docs/design/adaptive-coordinator-routing.md`.

---

## Path Recommendation

**Chosen path:** `design_first`

**Rationale:** The goal was solution-stated (it named ContextAssembler as the delivery mechanism). The dominant risk is designing the wrong context-passing mechanism -- e.g., threading structured inter-phase contracts through a layer built for startup context, when file-based handoff (pitch.md) may already handle the Shaping->Coding case. The landscape is well-understood from the source files. What is needed is rigorous problem framing before committing to a mechanism.

---

## Constraints / Anti-goals

**Constraints:**
- Scope limited to `src/coordinators/`, `src/context-assembly/`, `src/daemon/`
- Must not design for `src/mcp/`
- Must follow the existing `CoordinatorDeps` injection pattern
- Must be TypeScript; no new runtime dependencies without justification
- ContextAssembler changes must be backward-compatible (existing `pr_review` and `coding_task` kinds must still work)

**Anti-goals:**
- Do not introduce a shared in-memory session store (violates the session isolation model)
- Do not require the daemon to understand pipeline modes -- coordinator owns bridging
- Do not build a general-purpose event bus for inter-session communication
- Do not add phase metadata to the WorkRail engine internals

---

## Artifact Strategy

This document is a **human-readable artifact only**. It is NOT workflow execution truth.

- Workflow execution truth lives in WorkRail step notes and context variables.
- This doc is for human consumption: design decisions, landscape findings, handoff contracts.
- If a chat rewind occurs: the notes and context variables survive; this file may not.
- Do not rely on this doc as the sole record of decisions -- always cross-check with WorkRail session notes.

**Available capabilities:**
- Delegation (WorkRail Executor subagents): not available in this session
- Web browsing: not available in this session
- Fallback: all research done from local source files and parallel agent's design doc. Fully sufficient -- this is a design problem over a well-understood local codebase.

---

## Landscape Packet

### Current state summary

WorkTrain sessions are fully isolated. Each spawned session starts from the workflow's first step. The only mechanism for cross-session context today is `ContextAssembler`: it assembles git diff and prior session notes, renders them to markdown, and injects them as `assembledContextSummary` in the spawn context. The daemon reads this from `trigger.context['assembledContextSummary']` and injects it into the system prompt before turn 1.

**What ContextAssembler solves today:** sessions start with awareness of recent sessions and current git state. This is *intra-session startup context*, not *structured inter-phase handoff*.

**The pipeline model:** each phase is a separate WorkTrain session. The pipeline order is: Discovery -> Shaping -> Coding -> PR -> Review -> Merge. A coordinator script (TypeScript, like pr-review.ts) spawns sessions, awaits them, reads results, and spawns the next session.

### Existing approaches / precedents

**1. File-based handoff (wr.shaping -> coding):**
- `wr.shaping` Step 9 writes `.workrail/current-pitch.md` at the workspace path
- `coding-task-workflow-agentic` Phase 0.5 actively searches for upstream docs via repo search, WebFetch, MCP integrations
- Phase 0.5 would find `.workrail/current-pitch.md` automatically
- **Status: effectively already works** -- no coordinator intervention needed for Shaping->Coding

**2. Typed artifact handoff (wr.review_verdict):**
- PR review workflow emits a `wr.review_verdict` artifact with Zod schema
- `readVerdictArtifact()` in pr-review.ts parses it from `lastStepArtifacts`
- Falls back to keyword scan on `lastStepNotes` when no artifact present
- **Status: live, but costly** -- requires Zod schema, dedicated validation function, two-tier parsing logic

**3. Free-form notes handoff (keyword scan):**
- `parseFindingsFromNotes()` in pr-review.ts scans `lastStepNotes` for severity keywords
- No schema required, but fragile -- keywords can be negated, missing, or ambiguous
- **Status: the only currently-live parsing path** (no workflow emits `## COORDINATOR_OUTPUT` JSON blocks)

**4. Coordinator-injected context (assembledContextSummary):**
- Coordinator reads result of phase N, builds a markdown summary, passes it as `assembledContextSummary` when spawning phase N+1
- Uses the existing ContextAssembler delivery path -- no new mechanism needed
- **Status: the natural extension** -- coordinator owns the bridging logic, ContextAssembler delivers it

### Option categories

1. **File convention** (extend the pitch.md pattern): each phase writes a standardized file to `.workrail/`. Next phase discovers it. Zero coordinator involvement.
2. **Coordinator-injected text** (extend assembledContextSummary): coordinator reads `lastStepNotes` + `designDocPath`, builds a context string, passes it at spawn time.
3. **New AssemblyTask kind** (extend ContextAssembler): add e.g. `coding_task_with_pitch` kind that reads `.workrail/current-pitch.md` and includes it. Assembler handles the injection.
4. **Typed artifacts** (extend wr.review_verdict pattern): each phase emits a structured artifact the coordinator parses.

### Hard constraints

- `ContextAssembler.assemble()` must stay backward-compatible: existing `pr_review` and `coding_task` assembly tasks must not change
- `WorkflowRunSuccess.lastStepNotes` and `lastStepArtifacts` are the only output channels from a completed session
- `trigger.context['assembledContextSummary']` is the only injection point into a new session's system prompt today
- The session isolation model must hold -- no shared mutable state between sessions

### Obvious contradictions

- **ContextAssembler was designed for startup context** (git diff, prior session notes), not structured inter-phase contracts. Adding per-phase handoff logic there mixes two concerns.
- **File-based handoff works for Shaping->Coding** because Phase 0.5 does active search. But Discovery->Shaping has no equivalent -- Step 1 (Ingest and Extract) reads from "goal text, discovery notes, tickets, user stories" but has no active file search for `.workrail/`.
- **The JSON block parser in pr-review.ts is aspirational** -- no live workflow emits `## COORDINATOR_OUTPUT` blocks. The two-tier design creates maintenance burden for a path that has never activated.

### Evidence gaps

- No adaptive pipeline coordinator for Discovery->Shaping->Coding currently exists -- this is greenfield
- The routing agent's design is in early progress; the final routing mechanism is unknown
- It is not confirmed whether `wr.shaping` Step 1 would pick up a `.workrail/current-discovery.md` file if one existed (the step prompt says "read from whatever was provided" as goal text, not from a fixed file path)
- `wr.discovery` Phase 0.5 does not currently have a standardized output file location

### Why this matters for path selection

The dominant question is: **how much standardization do we need?** If file conventions cover all transitions (like pitch.md already does for Shaping->Coding), the coordinator needs almost no inter-phase logic. If only some transitions have file conventions, the coordinator needs to bridge the rest explicitly via assembledContextSummary injection. The design-first path keeps us focused on this question before committing to an architecture.

---

## Problem Frame Packet

### Users / stakeholders

- **Coordinator author** (the developer writing the adaptive coordinator): needs clear contracts for what each phase produces and what the next phase expects; wants to write minimal bridging logic
- **Phase session** (the spawned wr.shaping or coding session): needs upstream context injected before turn 1 so it doesn't re-derive what was already decided
- **WorkTrain user** (human triggering the pipeline): wants phase transitions to be seamless and for the coding session to be informed by the pitch without manual intervention

### Jobs / goals

- Coordinator: bridge N -> N+1 with minimal bespoke logic per transition
- Shaping session: start from the discovery direction (selected problem, direction, appetite signals), not from a blank problem statement
- Coding session: start with pitch content already available; Phase 0.5 finds it without coordinator help
- Review coordinator: have enough post-coding context (PR number + what the coding session decided) to classify findings correctly

### Pains / tensions

**Tension 1: ContextAssembler's purpose vs. inter-phase contracts**
ContextAssembler was designed for intra-session startup context (git state, recent session notes). Adding per-phase handoff logic there would make it responsible for two different things: generic startup enrichment AND typed phase contracts. These have different change rates and different consumers.

**Tension 2: File-based handoff is simple but requires workflow cooperation**
pitch.md works because wr.shaping Step 9 explicitly writes it to a fixed path. Adding more fixed-path files (current-discovery.md) requires changing each workflow's final step. Every phase needs to "know" about the file convention. This creates coupling between the coordinator design and the workflow JSON.

**Tension 3: Coordinator-injected context is flexible but coordinator-centric**
If the coordinator reads lastStepNotes and injects context as assembledContextSummary, the coordinator owns all the bridging logic. This is clean from a separation-of-concerns standpoint (coordinator = orchestrator, session = executor) but requires the coordinator to understand each phase's output format.

**Tension 4: Typed artifacts are reliable but expensive per transition**
wr.review_verdict shows typed artifacts work. But each new typed artifact requires: a Zod schema, a schema registration, a validation function, a two-tier parser in the coordinator. For 4+ transitions, this is 4x the schema overhead. The wr.review_verdict pattern was justified for the PR review coordinator because severity classification gates a merge decision. Are all phase transitions equally decision-critical?

### Constraints that matter in lived use

- The coordinator cannot read session-internal state -- only `lastStepNotes` and `lastStepArtifacts` are available post-session
- The only injection point into a new session is `trigger.context` (rendered as `assembledContextSummary` in the system prompt)
- Sessions cannot communicate with each other directly -- all inter-phase data must flow through the coordinator
- Workflow JSON changes require careful authoring; the coordinator design should not require frequent workflow changes to add new phases

### Success criteria

1. A coordinator spawns a Shaping session with enough Discovery context that wr.shaping Step 1 (Ingest and Extract) does not start from blank
2. A coding session spawned via coordinator has the pitch available, and Phase 0.5 finds it without coordinator injection (or with minimal injection)
3. Each of the 5 phase transitions (D->S, S->C, C->PR, PR->Review, Review->Fix) has a documented contract: what is produced, in what format, where it lives, what breaks if absent
4. The design adds at most one new `AssemblyTask` kind to `ContextAssembler` -- or explicitly justifies adding zero
5. The coordinator can be written with a simple per-transition helper function, not a bespoke parsing function per transition

### Assumptions

- The adaptive pipeline coordinator is a TypeScript script following pr-review.ts's pattern
- Phases are separate WorkTrain sessions, not steps within a single session
- Pipeline order: Discovery -> Shaping -> Coding -> PR -> Review -> Merge
- Not all pipelines run all phases (trivial tasks skip Discovery/Shaping)
- The coordinator reads `lastStepNotes` and `lastStepArtifacts` from WorkflowRunSuccess after awaiting each session

### Reframes / HMW questions

**HMW 1:** How might we design phase outputs so each phase self-documents what it produced -- without the coordinator needing phase-specific parsing logic?

**HMW 2:** How might we make file-based handoff work for all transitions without requiring every workflow to be changed?

### Primary Framing Risk

**If `wr.shaping` Step 1 already ingests goal text that includes the discovery direction** (because the coordinator passes it as the session goal string, not as injected context), then there may be no context-passing gap for Discovery->Shaping at all -- just goal string composition. In that case, the real problem is much smaller: only confirm that Shaping->Coding works via pitch.md, and document the contracts. This would make `ContextAssembler` changes unnecessary entirely.

---

## Candidate Directions

### Candidate generation expectations (design_first bias)

The injected routine must produce candidates that:
1. **Spread across the mechanism-complexity axis**: from simplest possible (goal string composition) to richest (typed artifacts per phase)
2. **Include at least one reframing candidate**: one direction that treats the problem as smaller than framed (goal string composition is the full solution)
3. **Challenge the ContextAssembler premise**: at least one candidate must ask whether ContextAssembler is the right delivery mechanism at all
4. **No candidate requires both coordinator changes AND every-workflow changes** unless it provides overwhelming benefit vs. simpler options
5. **Each candidate must address the primary framing risk**: does goal string composition in the coordinator goal parameter adequately seed wr.shaping Step 1?

---

### Candidate A: Goal string composition + notes injection

**One-sentence summary:** The coordinator composes a rich goal string from the previous phase's `lastStepNotes` and passes those notes as `assembledContextSummary` at spawn time -- no new mechanisms required.

**Mechanism:** When spawning `wr.shaping`, the coordinator constructs: `goal = "Shape the following problem discovered in our discovery session:\n\n[lastStepNotes summary]"`. It also passes `{ assembledContextSummary: lastStepNotes }` as the context object. `wr.shaping` Step 1 reads from "goal text, discovery notes, tickets, user stories" -- both injection points land in session context.

**Tensions resolved:** Workflow independence (no workflow changes needed), coordinator simplicity (no new parsing schemas), coherence (uses existing mechanisms).

**Tensions accepted:** Mechanism clarity is weak -- no contract enforcement. If wr.discovery changes its notes format, the coordinator silently degrades. No typed validation.

**Boundary:** Coordinator spawn site. The coordinator owns the bridging logic; the session is unaware of the convention.

**Specific failure mode:** wr.discovery's final step notes change format (e.g., a future workflow refactor renames "selected direction" to "recommended direction"). The coordinator's context injection becomes stale and the shaping session starts from less-informed context. Fails silently.

**Relation to existing patterns:** Follows the existing `assembledContextSummary` pattern. No departure.

**What you gain:** Zero new code in ContextAssembler. Zero workflow changes. Works today.

**What you give up:** No machine-parseable handoff. Coordinator cannot programmatically extract structured fields (e.g., appetite signals, key invariants) from discovery output -- it passes the whole notes blob.

**Impact surface:** Only the coordinator spawn site for each transition. No changes to ContextAssembler, daemon, or workflows.

**Scope judgment:** Best-fit for transitions where the coordinator does not branch on the structured value. Potentially too narrow if the coordinator needs to extract specific fields to parameterize the next phase.

**Philosophy:** Honors YAGNI, dependency injection (no new deps). Conflicts with "make illegal states unrepresentable" (notes format is unconstrained) and "validate at boundaries" (no schema validation).

---

### Candidate B: File convention extension (adapt the pitch.md pattern)

**One-sentence summary:** Standardize each phase's primary output to a fixed `.workrail/` path, so downstream sessions find it by convention without coordinator intervention -- the same way `current-pitch.md` already works for Shaping->Coding.

**Mechanism:**
- `wr.discovery` Phase 7 is updated to write `.workrail/current-discovery.md` (the design doc, or a summary of it)
- `wr.shaping` Step 1 is updated to also search for `.workrail/current-discovery.md` when no goal text provides discovery context
- Other transitions (C->PR->Review->Fix) already have natural artifacts (PR number, review verdict)
- The coordinator passes the correct `workspacePath` to each session -- that's the only coordinator involvement

**File structure:**
- `.workrail/current-discovery.md` -- latest discovery output (overwritten each run)
- `.workrail/current-pitch.md` -- latest pitch (already exists, already works)

**Tensions resolved:** Discoverable handoff (session self-discovers), workflow independence for coordinator (coordinator needs no per-transition parsing), coherence (extends the existing pitch.md convention).

**Tensions accepted:** Workflow coupling -- each phase must write its output to the fixed path. Requires changes to wr.discovery Phase 7 and wr.shaping Step 1. Two-workflow change for one gap.

**Boundary:** Filesystem at `.workrail/`. Both the writing phase (workflow) and reading phase (next workflow's session) agree on the path convention.

**Specific failure mode:** A discovery session runs but fails before Phase 7 (the file-writing step). `.workrail/current-discovery.md` is stale from a prior session. The shaping session reads the wrong discovery output. No timestamp validation.

**Relation to existing patterns:** Directly adapts the pitch.md convention that already exists and works.

**What you gain:** Sessions self-discover upstream context. Coordinator needs no per-transition bridging logic for D->S. Clean separation: workflows are responsible for their own output files.

**What you give up:** Two workflow changes required. Stale file risk if sessions fail mid-run. File conventions must be maintained as the pipeline grows.

**Impact surface:** `wr.discovery` Phase 7 step prompt, `wr.shaping` Step 1 step prompt, coordinator (may not need to change at all).

**Scope judgment:** Best-fit for the D->S gap specifically. For the other transitions, the file convention adds little (PR number is simpler for C->Review, verdict artifact already exists for Review->Fix).

**Philosophy:** Honors "make illegal states unrepresentable" (file presence is checkable), YAGNI (minimal code changes). Conflicts with "validate at boundaries" (reading a stale file is not caught at the coordinator boundary).

---

### Candidate C: Coordinator-injected structured context (extend assembledContextSummary with per-transition builder)

**One-sentence summary:** Add a pure `buildHandoffContext(phase, lastStepNotes) -> Record<string, string>` function in the coordinator that constructs a structured context object from the previous phase's notes, injected at spawn time via the existing `context` parameter.

**Mechanism:**
- Define a `PhaseHandoffContext` record type: `{ phaseFrom: string, phaseTo: string, keyFindings: string, selectedDirection?: string, designDocPath?: string }`
- Add `buildDiscoveryHandoffContext(notes: string): PhaseHandoffContext` as a pure function -- parses the lastStepNotes from Discovery to extract the key fields (direction, design doc path)
- Pass this as the context object when spawning wr.shaping: `{ assembledContextSummary: render(handoffContext), ...handoffContext }`
- `wr.shaping` Step 1 receives both the rendered markdown (readable) and the structured fields (machine-accessible in the session's injected context)

**Parsing strategy:** Notes-based parsing with named section extraction (look for "## Selected Direction", "## Design Document", etc. -- or parse the last step's structured context variables if the coordinator can access them).

**Tensions resolved:** Mechanism clarity (per-transition builder functions are named contracts), coordinator logic is centralized and pure (testable with fakes), no workflow changes required.

**Tensions accepted:** Coordinator must understand each phase's notes format. Format changes in workflows silently break the parser. Slightly more code than Candidate A but cleaner.

**Boundary:** Coordinator spawn site, with a dedicated pure builder function per decision-critical transition.

**Specific failure mode:** Notes format changes silently break the builder. The structured fields become empty or wrong. Session starts with degraded context. Same silent failure as Candidate A but at least the builder function is an explicit boundary where tests can verify format assumptions.

**Relation to existing patterns:** Adapts and formalizes what parseFindingsFromNotes() does -- pure parsing function + coordinator uses the result to build context. Follows the pr-review.ts pattern.

**What you gain:** Explicit named functions per transition (self-documenting), testable with fakes (pure functions), no workflow changes, coordinator owns the contracts.

**What you give up:** Still no schema enforcement on notes format. Builder functions add code. If the pipeline grows to 8 phases, 8 builder functions need maintenance.

**Impact surface:** New module in `src/coordinators/` (e.g. `adaptive-pipeline-handoffs.ts`). No changes to ContextAssembler, daemon, or workflows.

**Scope judgment:** Best-fit for the coordinator design. Aligns with the design_first framing: coordinators own routing AND bridging.

**Philosophy:** Honors pure functions (builder functions are pure), dependency injection (no I/O in builders), "compose with small pure functions". Conflicts with "validate at boundaries" (no schema validation) and "make illegal states unrepresentable" (notes format is unconstrained).

---

### Candidate D: Typed handoff artifact for decision-critical transitions only (selective wr.discovery_handoff)

**One-sentence summary:** Add a `wr.discovery_handoff` typed artifact emitted in wr.discovery Phase 7, parsed by the coordinator using Zod -- only for the Discovery->Shaping transition which requires structured routing; all other transitions use goal string composition.

**Mechanism:**
- New schema: `wr.discovery_handoff` in `src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`
  ```typescript
  { kind: 'wr.discovery_handoff', selectedDirection: string, designDocPath: string, confidenceBand: 'high' | 'medium' | 'low', keyInvariants: readonly string[] }
  ```
- `wr.discovery` Phase 7 step prompt instructs the agent to emit this artifact in its final `continue_workflow` artifacts array
- Coordinator reads `lastStepArtifacts` from WorkflowRunSuccess, validates with Zod, extracts structured fields
- These fields are passed as spawn context for wr.shaping: `{ selectedDirection, designDocPath, assembledContextSummary: render(...) }`
- Shaping session has structured context fields available and can use them in Step 1

**YAGNI application:** Only Discovery->Shaping gets a typed artifact. Review->Fix already has `wr.review_verdict`. The three other transitions (S->C, C->PR, PR->Review) use goal string composition -- no coordinator branching needed on structured values.

**Tensions resolved:** Makes illegal states unrepresentable (structured artifact enforces the D->S contract), validates at boundaries (Zod at coordinator), mechanism clarity (typed schema is the explicit contract).

**Tensions accepted:** Workflow change required (wr.discovery Phase 7 must emit the artifact). Schema maintenance burden. Two-tier parsing needed (artifact + notes fallback for backward compat during transition).

**Boundary:** wr.discovery Phase 7 (emitter) + coordinator `lastStepArtifacts` handling (consumer).

**Specific failure mode:** Agent forgets to emit the artifact (or emits it with wrong field values). Coordinator falls back to notes parsing. If notes parsing also degrades, shaping session starts blind. Same two-tier vulnerability as wr.review_verdict today.

**Relation to existing patterns:** Directly follows the wr.review_verdict pattern. Zod schema + `isDiscoveryHandoffArtifact()` guard + `readDiscoveryHandoffArtifact()` function.

**What you gain:** Machine-parseable D->S contract. Coordinator can programmatically route on `selectedDirection` and `confidenceBand` (e.g., skip shaping if direction confidence is already high). Type-safe.

**What you give up:** Workflow change required (wr.discovery Phase 7). Schema maintenance. Two-tier parsing complexity. The agent must reliably emit the artifact in Phase 7.

**Impact surface:** New schema file, updated wr.discovery Phase 7 step prompt, new `readDiscoveryHandoffArtifact()` function in coordinator, `CoordinatorDeps` may need `getAgentResult` (already exists in pr-review.ts).

**Scope judgment:** Best-fit for D->S specifically, over-engineered for transitions that don't need coordinator branching. Combining with Candidate A for the other transitions gives the minimum typed surface.

**Philosophy:** Fully honors "make illegal states unrepresentable", "validate at boundaries", "type safety as first line of defense". Conflicts with YAGNI if applied beyond the two transitions that genuinely need it.

---

## Challenge Notes

**Challenge 1: Workflow change dependency**
D requires wr.discovery Phase 7 to emit the artifact. The current Phase 7 prompt does not mention artifacts. This is a real dependency. Counter: wr.review_verdict proves the pattern is repeatable. Phase 7 already has `selectedDirection`, `designDocPath`, `recommendationConfidenceBand` in context from prior steps -- the agent can construct the artifact. Not a blocking challenge.

**Challenge 2: Critical finding on trigger context injection (resolved a design assumption)**
Audit of `workflow-runner.ts` lines 3191-3193 revealed: the daemon injects ALL `trigger.context` keys as JSON in the initial prompt (`Trigger context: { ... }`). This means `selectedDirection` and `designDocPath` passed as spawn context keys are immediately readable by the session without any new injection mechanism. `assembledContextSummary` gets its own `## Prior Context` section; other keys appear in the raw JSON block. **This strengthens D**: structured fields from the typed artifact can be passed directly as trigger.context keys. The design does NOT need a new AssemblyTask kind -- the existing spawn context mechanism is sufficient.

**Challenge 3: wr.shaping Step 1 reading trigger context**
Step 1 reads "from whatever was provided (goal text, discovery notes, tickets, user stories)." The trigger context JSON appears in the initial prompt. Natural behavior for an LLM agent. Not guaranteed by the workflow prompt but reasonable assumption.

---

## Resolution Notes

**Selected direction: Hybrid D + A (medium confidence)**

### Per-phase handoff contracts

| Transition | What is produced | Format | Where it lives | What the coordinator does |
|------------|-----------------|--------|----------------|--------------------------|
| Discovery -> Shaping | Selected direction, design doc path, confidence band, key invariants | `wr.discovery_handoff` typed artifact (Zod-validated) + `lastStepNotes` as fallback | `lastStepArtifacts` from WorkflowRunSuccess | Reads artifact, extracts structured fields, composes goal string, passes as trigger.context keys + assembledContextSummary |
| Shaping -> Coding | Shaped pitch | Markdown file at `.workrail/current-pitch.md` | Filesystem (workspace-relative) | Passes `{ pitchPath: '.workrail/current-pitch.md' }` explicitly in spawn context as belt-and-suspenders. Phase 0.5 finds it via active search. |
| Coding -> PR | PR number, branch name | Goal string from the coding session's result | `lastStepNotes` from WorkflowRunSuccess | Extracts PR number from notes, passes in goal string for review session |
| PR -> Review | PR number for review | Already known to coordinator at spawn time | Coordinator state | No handoff needed; coordinator already has PR number |
| Review -> Fix | Verdict, severity, findings | `wr.review_verdict` typed artifact (Zod-validated) + keyword scan fallback | `lastStepArtifacts` | Already implemented in pr-review.ts coordinator |

### Recommended mechanism

**For Discovery->Shaping (the only gap that requires new design work):**

1. Add `wr.discovery_handoff` artifact schema in `src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`:
```typescript
interface DiscoveryHandoffArtifactV1 {
  readonly kind: 'wr.discovery_handoff';
  readonly version: 1;
  readonly selectedDirection: string;
  readonly designDocPath: string;
  readonly confidenceBand: 'high' | 'medium' | 'low';
  readonly keyInvariants: readonly string[];
}
```

2. Add `readDiscoveryHandoffArtifact(artifacts, sessionHandle)` pure function in the coordinator (mirrors `readVerdictArtifact`).

3. Coordinator spawn logic for wr.shaping:
```typescript
const handoff = readDiscoveryHandoffArtifact(lastStepArtifacts, sessionHandle);
const spawnContext = handoff
  ? { selectedDirection: handoff.selectedDirection, designDocPath: handoff.designDocPath, confidenceBand: handoff.confidenceBand, assembledContextSummary: renderHandoff(handoff) }
  : (lastStepNotes.trim().length > 50 ? { assembledContextSummary: lastStepNotes } : null);
const goal = handoff
  ? `Shape the problem identified in our discovery session: ${handoff.selectedDirection}`
  : `Shape the following problem: [extracted from discovery notes]`;
```

4. Update `wr.discovery` Phase 7 step prompt to instruct artifact emission (AFTER validating that structured routing is needed -- implement schema + coordinator parsing first, workflow change second).

**For all other transitions:** goal string composition + notes injection. No new mechanism needed.

### Minimal ContextAssembler change

**None required.** The existing `context: Record<string, unknown>` parameter on `spawnSession` is sufficient for passing structured fields. The daemon injects ALL trigger.context keys as JSON in the initial prompt (see `workflow-runner.ts` lines 3191-3193). This means downstream sessions read structured fields like `selectedDirection` from the `Trigger context: { ... }` block in their initial prompt.

### Critical invariant for coordinator authors

**Trigger context injection:** When a coordinator passes `context` to `spawnSession`, the daemon does two things with it:
1. `trigger.context['assembledContextSummary']` (if present) is rendered under `## Prior Context` in the system prompt (see `buildSystemPrompt()`)
2. ALL `trigger.context` keys are injected as a JSON block in the initial prompt: `Trigger context:\n\`\`\`json\n{...}\n\`\`\``

This means structured fields like `selectedDirection` and `designDocPath` are immediately available to the session in its first turn. No new injection mechanism needed.

### Implementation ordering

1. Define `DiscoveryHandoffArtifactV1` schema and `readDiscoveryHandoffArtifact()` function
2. Write the coordinator spawn logic with the two-tier fallback
3. Build and test the coordinator (confirm structured routing is needed and the fallback works)
4. ONLY THEN update `wr.discovery` Phase 7 to emit the artifact

### Confidence band: medium

Well-grounded in existing patterns (wr.review_verdict, CoordinatorDeps injection, Phase 0.5). Medium (not high) because:
- wr.shaping Step 1 quality with injected context is unvalidatable without a live pipeline run
- LLM inference reliability at trigger context boundary is inherent uncertainty
- The workflow change to Phase 7 depends on prompt engineering quality

### Residual risks

1. **LLM inference reliability:** the session must correctly interpret `selectedDirection` from the `Trigger context: { ... }` JSON block. Not solvable at the design level; monitor in early pipeline runs.
2. **Two-tier fallback debt:** if wr.discovery evolves, the notes-parsing fallback may accumulate technical debt. Recommend an integration test that validates graceful fallback when no artifact is emitted.
3. **C->PR contract:** the coding-to-PR transition is left as "goal string with PR number." If the adaptive coordinator needs to programmatically verify the PR was created, this is a known gap to revisit.

### Pivot condition

If wr.shaping Step 1 produces sound results with just goal string composition (Candidate A) and no coordinator branching on `selectedDirection` is needed, switch to Candidate A only. This eliminates the schema, the workflow change, and the two-tier fallback. Validate when the first adaptive coordinator is built.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-19 | Path: design_first | Goal was solution-stated; dominant risk is wrong mechanism, not lack of landscape knowledge |
| 2026-04-19 | Selected direction: Hybrid D + A | D (wr.discovery_handoff typed artifact) for D->S -- coordinator branches on structured values. A (goal string + notes) for all other pass-through transitions. No ContextAssembler change needed. |
| 2026-04-19 | Runner-up: Candidate A only | Legitimate simpler alternative if wr.shaping Step 1 works with goal string composition alone and no coordinator branching is needed. Validate when first adaptive coordinator is built. |
| 2026-04-19 | Critical finding: trigger context injection | Daemon injects ALL trigger.context keys as JSON in the initial prompt (`Trigger context: {...}`). This means structured fields (selectedDirection, designDocPath) passed in spawn context are immediately readable by the session without any new mechanism. assembledContextSummary gets a dedicated section; other keys appear in the JSON block. |

---

## Assumptions the routing agent needs to know about

The routing agent (`docs/design/adaptive-coordinator-routing.md`) is designing which phases to run for a given task. The following context-passing assumptions affect routing decisions:

1. **Shaping->Coding handoff is already solved.** The routing agent does not need to design coordinator logic for this transition. Phase 0.5 finds pitch.md automatically. The coordinator only needs to pass `pitchPath: '.workrail/current-pitch.md'` as belt-and-suspenders.

2. **Discovery->Shaping requires a `selectedDirection` field.** If the routing agent needs to skip Shaping based on discovery confidence (e.g., "skip shaping if confidence = high and the task is trivially scoped"), it should expect `confidenceBand` from the `wr.discovery_handoff` artifact. The coordinator can branch on this value.

3. **The trigger context mechanism passes ALL spawn context keys to the session.** The routing agent can safely assume that any structured field passed by the coordinator in the spawn context will be readable by the downstream session. No new injection mechanism is needed.

4. **Review->Fix is already handled.** `wr.review_verdict` + `parseFindingsFromNotes` in pr-review.ts. Routing agent can treat this as a solved contract.

5. **No ContextAssembler change is planned.** If the routing agent's design requires a new AssemblyTask kind (e.g., to add new git context for the coding session), it should propose it as a separate addition. The context-passing design deliberately chose to NOT add new AssemblyTask kinds.

6. **Fallback paths exist for all decision-critical transitions.** The coordinator always has a notes-based fallback if typed artifacts are missing. Routing decisions that depend on artifact fields should gracefully handle the fallback (e.g., treat absent `confidenceBand` as 'medium' rather than failing).

---

## Final Summary

**Selected path:** design_first

**Problem framing:** WorkTrain phases are isolated sessions; the real context-passing gap is Discovery->Shaping only. Shaping->Coding is already solved by pitch.md + Phase 0.5. All other transitions have natural artifacts (PR number, verdict).

**Landscape takeaways:**
- ContextAssembler is NOT the right layer for inter-phase contracts -- it's for intra-session startup context
- The daemon injects ALL trigger.context keys as JSON in the initial prompt -- structured fields are readable without new mechanisms
- Phase 0.5 actively searches for upstream documents including pitch.md
- The wr.review_verdict pattern is the proven template for typed phase contracts

**Chosen direction:** Hybrid D + A
- `wr.discovery_handoff` typed Zod artifact for Discovery->Shaping (the only decision-critical transition)
- Goal string + notes injection for all other pass-through transitions
- Explicit `pitchPath` injection for Shaping->Coding as belt-and-suspenders
- **No ContextAssembler change required**

**Strongest alternative:** Candidate A only (goal string composition for all transitions). Valid if wr.shaping Step 1 works with just goal string and no structured routing is needed. Pivot to A if the first live pipeline run confirms this.

**Why D won over A:** The coordinator may need to branch on `selectedDirection` and `confidenceBand` for routing decisions (e.g., skip shaping if confidence is already high). The typed contract makes these values reliable and validated. A's silent failure mode is unacceptable for a routing decision.

**Confidence band:** medium

**Residual risks:**
1. LLM inference reliability at trigger context boundary (inherent, unresolvable at design level)
2. Two-tier fallback accumulates technical debt (recommend integration test)
3. C->PR contract is a known gap (goal string only, not typed)

**Next actions:**
1. Define `DiscoveryHandoffArtifactV1` schema in `src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`
2. Write `readDiscoveryHandoffArtifact()` pure function in the coordinator
3. Write coordinator spawn logic for D->S with two-tier fallback
4. Test with a live pipeline run -- if Candidate A behavior is confirmed sufficient, remove the schema overhead
5. Only then update `wr.discovery` Phase 7 prompt to emit the artifact
6. Document trigger context injection invariant in coordinator authoring guide
