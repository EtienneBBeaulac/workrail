# Inter-Phase Context Passing: Design Candidates

*Working analysis document -- raw investigative material, not a final decision.*
*Produced during wr.discovery workflow for adaptive-coordinator-context.md.*

---

## Problem Understanding

### Core tensions

1. **Concern separation vs. convenience:** ContextAssembler is the only session injection mechanism but was designed for startup context (git diff, prior session notes), not inter-phase structured contracts. Using it for inter-phase handoff is convenient but muddles its purpose and change rate.

2. **Coupling vs. simplicity:** File-based handoff (pitch.md) is simple and already works for Shaping->Coding. Extending the pattern to all transitions requires each workflow's final step to write to a fixed `.workrail/` path -- coupling pipeline topology to workflow authoring.

3. **Uniform bridge vs. typed contracts:** Coordinator-injected freetext (assembledContextSummary) is uniform across all transitions but imprecise -- no schema enforcement. Typed artifacts per transition are precise and Zod-validated but add per-transition schema overhead.

4. **Coordinator responsibility vs. session responsibility:** Coordinator can bridge at spawn time (reads lastStepNotes, builds context, injects at spawn). Sessions can self-discover (Phase 0.5 already does this for pitch.md). Self-discovery is more robust but requires each session to know the file conventions.

### Likely seam

The problem does NOT live in ContextAssembler. The coordinator already passes arbitrary context at spawn time via the 4th parameter to `spawnSession`. The real seam is: **what to put in that context object and how to extract it from the previous phase's output.**

The problem is narrower than it appears:
- Shaping->Coding: already solved (Phase 0.5 + pitch.md)
- Review->Fix: already solved (wr.review_verdict + pr-review.ts)
- Remaining gap: Discovery->Shaping only

### What makes this hard

- Coordinator and session are in different systems; workflow prompt changes can silently break coordinator parsing
- The only injection point (`assembledContextSummary`) is a freetext markdown string, not a typed contract
- Two transitions need structured coordinator routing (D->S needs direction; Review->Fix already solved). Three transitions are pass-through.
- Silent failure is the dominant risk

---

## Philosophy Constraints

**Principles that constrain this design:**
- Immutability by default: all new types use `readonly`
- Make illegal states unrepresentable: discriminated unions for AssemblyTask; typed artifacts for coordinator contracts
- Errors are data: new ContextBundle sources should use `Result<T, string>`
- Validate at boundaries: Zod for external inputs (typed artifacts, notes parsing)
- Compose with small pure functions: handoff builder/parser functions must be pure
- Dependency injection: file reads go through CoordinatorDeps
- YAGNI: only add typed artifacts for transitions where coordinator branches on structured values

**Active conflict:** YAGNI vs. "make illegal states unrepresentable" -- typed artifacts everywhere would enforce all contracts but add schema overhead for 3 transitions that don't need it.

---

## Impact Surface

Must stay consistent with:
- `src/context-assembly/types.ts` (AssemblyTask union)
- `src/context-assembly/index.ts` (assemble() switch on task.kind)
- `src/coordinators/pr-review.ts` (CoordinatorDeps interface)
- `src/v2/durable-core/schemas/artifacts/` (typed artifact schemas)
- `workflows/wr.discovery.json` (Phase 7 -- if emitting artifact)
- `workflows/wr.shaping.json` (Step 1 -- if adding file search)
- `workflows/coding-task-workflow-agentic.json` (Phase 0.5 -- no changes expected)

---

## Candidates

### Candidate A: Goal string composition + notes injection

**Summary:** Coordinator composes a rich goal string from the previous phase's `lastStepNotes` and passes notes as `assembledContextSummary` at spawn time -- no new mechanisms required.

**Mechanism:**
When spawning wr.shaping, coordinator constructs:
```
goal = "Shape the following problem discovered in our discovery session:\n\n[lastStepNotes summary]"
context = { assembledContextSummary: lastStepNotes }
```
wr.shaping Step 1 reads from "goal text, discovery notes, tickets, user stories" -- both injection points land in session context.

**Tensions resolved:** Workflow independence, coordinator simplicity, coherence

**Tensions accepted:** No mechanism clarity, no schema validation, silent failure when notes format changes

**Boundary:** Coordinator spawn site only

**Failure mode:** wr.discovery notes format changes silently. Shaping session starts from degraded context. No error surfaced.

**Repo pattern:** Follows existing assembledContextSummary pattern. No departure.

**Gains:** Zero new code outside coordinator. Zero workflow changes. Works today.
**Losses:** No machine-parseable contract. Coordinator cannot extract structured fields programmatically.

**Scope judgment:** Best-fit for pass-through transitions. Too narrow for transitions where coordinator branches on structured values.

**Philosophy:** Honors YAGNI, DI. Conflicts with "make illegal states unrepresentable", "validate at boundaries".

---

### Candidate B: File convention extension (adapt pitch.md)

**Summary:** wr.discovery Phase 7 writes `.workrail/current-discovery.md`; wr.shaping Step 1 searches for it -- the same file convention that already works for Shaping->Coding.

**Mechanism:**
- wr.discovery Phase 7 updated to write `.workrail/current-discovery.md`
- wr.shaping Step 1 updated to search for `.workrail/current-discovery.md` when no goal text provides discovery context
- Coordinator passes correct workspacePath -- that's the only coordinator involvement

**Tensions resolved:** Discoverable handoff (session self-discovers), coordinator logic (no bridging for D->S)

**Tensions accepted:** 2 workflow changes, stale file risk (failed discovery leaves wrong file)

**Boundary:** Filesystem at `.workrail/`

**Failure mode:** Discovery fails before Phase 7. File is stale from prior session. Shaping reads wrong discovery output. No timestamp check.

**Repo pattern:** Directly adapts pitch.md convention from wr.shaping Step 9.

**Gains:** Sessions self-discover. Coordinator unchanged for D->S. Clean separation.
**Losses:** Two workflow changes. Stale file risk. Conventions must be maintained.

**Scope judgment:** Best-fit for D->S specifically. Over-engineered for other transitions.

**Philosophy:** Honors YAGNI, "make illegal states unrepresentable" (file presence checkable). Conflicts with "validate at boundaries" (stale file not caught at coordinator boundary).

---

### Candidate C: Coordinator-injected structured context (pure builder functions)

**Summary:** Add a pure `buildDiscoveryHandoffContext(notes: string): PhaseHandoffContext` function in the coordinator that extracts structured fields from discovery notes and passes them as spawn context.

**Type shape:**
```typescript
interface PhaseHandoffContext {
  readonly phaseFrom: string;
  readonly phaseTo: string;
  readonly keyFindings: string;
  readonly selectedDirection?: string;
  readonly designDocPath?: string;
}
```

**Tensions resolved:** Coordinator simplicity (named pure function per transition), no workflow changes, coordinator owns contracts

**Tensions accepted:** Notes format still unconstrained. Builder functions must be maintained when format changes.

**Boundary:** Coordinator spawn site + named pure function (slightly better than A)

**Failure mode:** Notes format changes silently break builder. Same failure as A but slightly more visible (named function can be tested).

**Repo pattern:** Adapts parseFindingsFromNotes() pattern (pure function + coordinator uses result). Direct precedent in pr-review.ts.

**Gains:** Named, testable, pure functions. Coordinator owns contracts. No workflow changes.
**Losses:** Notes format still unconstrained. Per-transition builder functions as pipeline grows.

**Scope judgment:** Best-fit for coordinator-centric design with intermediate rigor.

**Philosophy:** Honors "compose with small pure functions", DI. Conflicts with "validate at boundaries", "make illegal states unrepresentable".

---

### Candidate D: Typed handoff artifact for decision-critical transitions only (wr.discovery_handoff)

**Summary:** Add a `wr.discovery_handoff` typed artifact emitted in wr.discovery Phase 7, Zod-validated by the coordinator -- applied only to D->S; all other transitions use goal string composition.

**Schema:**
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

**Coordinator parsing:**
```typescript
const handoffArtifact = readDiscoveryHandoffArtifact(lastStepArtifacts, sessionHandle);
const spawnContext = handoffArtifact
  ? { selectedDirection: handoffArtifact.selectedDirection, designDocPath: handoffArtifact.designDocPath, assembledContextSummary: render(handoffArtifact) }
  : { assembledContextSummary: lastStepNotes };
await deps.spawnSession('wr.shaping', buildShapingGoal(handoffArtifact ?? notes), workspace, spawnContext);
```

**Transition coverage:**
- D->S: wr.discovery_handoff (NEW)
- Review->Fix: wr.review_verdict (already exists)
- S->C: goal string + pitch.md self-discovery via Phase 0.5 (no typed artifact)
- C->PR: PR number in goal string (no typed artifact)
- PR->Review: PR number (no typed artifact)

**Tensions resolved:** Mechanism clarity (schema IS the contract), validates at boundaries (Zod), makes illegal states unrepresentable for D->S

**Tensions accepted:** 1 workflow change (wr.discovery Phase 7 must emit artifact). Two-tier fallback complexity. Schema maintenance.

**Boundary:** wr.discovery Phase 7 (emitter) + coordinator lastStepArtifacts handling (consumer)

**Failure mode:** Agent doesn't emit artifact. Coordinator falls back to notes parsing. Two-tier failure, same as wr.review_verdict today.

**Repo pattern:** Directly follows wr.review_verdict pattern in every structural detail.

**Gains:** Machine-parseable D->S contract. Coordinator can route on confidenceBand. Type-safe. Explicit failure.
**Losses:** 1 workflow change. Schema maintenance. Two-tier parsing. Agent must reliably emit artifact.

**Scope judgment:** Best-fit for D->S. Combined with A for other transitions = minimum typed surface.

**Philosophy:** Fully honors "make illegal states unrepresentable", "validate at boundaries", "type safety as first line of defense", YAGNI (applied only to 2 decision-critical transitions).

---

## Comparison and Recommendation

### Comparison matrix

| Criterion | A | B | C | D |
|-----------|---|---|---|---|
| Mechanism clarity | Low | Medium | Medium | High |
| Coordinator logic minimality | High | High | Medium | Medium |
| Workflow independence | High | Low | High | Medium |
| Coherence with existing patterns | Medium | High | Medium | High |
| Discoverable handoff | Low | High | Low | Low |
| Philosophy fit | Medium | Medium | Medium | High |
| Failure mode explicitness | Low | Medium | Medium | High |

### Recommendation: Hybrid D + A

**D for Discovery->Shaping:**
Coordinator branches on `selectedDirection` -- this is a routing decision, not just context enrichment. Mirrors the wr.review_verdict precedent. Schema overhead proportionate to decision weight.

**A for all other pass-through transitions:**
- Shaping->Coding: Phase 0.5 finds pitch.md automatically (confirmed in workflow prompt)
- Coding->PR: PR number in goal string
- PR->Review: pr-review.ts already handles this

**No ContextAssembler change needed:**
Coordinator passes `{ selectedDirection, designDocPath, assembledContextSummary }` as spawn context keys. The existing `context: Record<string, unknown>` parameter on `spawnSession` is sufficient.

---

## Self-Critique

**Strongest counter-argument against D:**
The workflow change to wr.discovery Phase 7 is a point of failure. If the agent emits a malformed artifact or omits it, coordinator falls back to notes parsing -- same fragility as Candidate A. The typed contract only helps when the artifact IS correctly emitted.

**Why A is a legitimate simpler answer:**
wr.shaping Step 1 explicitly reads "goal text, discovery notes, tickets, user stories." If coordinator goal string includes discovery summary, this may be sufficient. No structured routing on selectedDirection may be needed. Validate this when the first adaptive coordinator is written.

**Pivot condition to A:**
When the first adaptive coordinator is written, if wr.shaping Step 1 produces sound results without structured `selectedDirection` access, Candidate A is correct and D's overhead is unjustified.

**Broader option:**
D for all transitions (add wr.shaping_handoff, wr.coding_handoff). Justified only if coordinator needs to branch on pitch content or implementation scope. Not justified now.

---

## Open Questions for the Main Agent

1. Does the coordinator need to branch on `selectedDirection` from discovery, or is passing the full notes blob sufficient for wr.shaping Step 1? This determines whether D is needed at all.

2. Is there a planned use case where the adaptive coordinator skips Shaping based on discovery confidence band? If yes, D is clearly justified. If not, A may be sufficient.

3. What does the routing agent (adaptive-coordinator-routing.md) expect from context passing? Its design may have specific requirements for structured fields at routing decision time.

4. Is `.workrail/current-pitch.md` reliably found by Phase 0.5 in practice? If Phase 0.5 sometimes misses it, the coordinator may need to inject `pitchPath` explicitly.
