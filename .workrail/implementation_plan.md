# Implementation Plan: Living Work Context (Issue #934)

## Problem Statement

Pipeline phase agents (shaping, coding, review) start sessions with almost no context from prior phases. The coordinator manually assembles ad-hoc string context. This causes rework, contradicted design intent, and review agents flagging deliberate decisions as bugs.

## Acceptance Criteria

1. `ShapingHandoffArtifactV1` and `CodingHandoffArtifactV1` Zod schemas in `src/v2/durable-core/schemas/artifacts/`
2. `wr.contracts.shaping_handoff` and `wr.contracts.coding_handoff` in `ARTIFACT_CONTRACT_REFS` with validators
3. `wr.contracts.discovery_handoff` gets a validator case in `artifact-contract-validator.ts` (currently registered but missing switch case)
4. `PhaseHandoffArtifact` closed discriminated union in `src/v2/durable-core/schemas/artifacts/phase-handoff.ts`
5. `buildContextSummary(priorArtifacts, targetPhase)` pure function with per-phase unit tests asserting presence AND absence of correct fields. `'fix'` target phase includes `filesChanged` from coding artifact.
6. `PipelineRunContext` per-run JSON with `PhaseResult<T>` discriminated union (concrete per-phase Zod schemas). Deserialization always routes through concrete Zod schemas -- no raw casts.
7. `writePhaseRecord()` and `readPipelineContext()` on `AdaptiveCoordinatorDeps`. `writePhaseRecord` accepts a single union type (not overloads) to make illegal states unrepresentable.
8. All 4 coordinator mode files (full-pipeline, implement, implement-shared, quick-review) AND `implement.ts` updated with runId threading.
9. Crash recovery: on pipeline restart, coordinator reads existing `PipelineRunContext` file and restores `priorArtifacts` to skip re-running completed phases.
10. All 4 workflows updated (wr.discovery, wr.shaping, wr.coding-task, mr-review). Workflow prompt for `phase-8-retrospective` in coding-task explicitly states `correctedAssumptions` is populated by fix/retry agents, not the original coding agent -- leave empty on first run.
11. Lifecycle integration tests: each workflow emits expected artifact at final step
12. Validation test: all bundled workflow outputContract contractRefs exist in ARTIFACT_CONTRACT_REFS and have validator cases
13. Single PR -- no partial landing

## Non-Goals

- No buildSystemPrompt() redesign
- No cross-run context accumulation
- No coordinator retry logic
- No epic-mode task graph
- No console visualization
- No extensible contract registration
- No agent reasoning changes

## Philosophy Constraints

- Make illegal states unrepresentable: PhaseResult<T> discriminated union; writePhaseRecord accepts PhaseRecordUnion (not overloads)
- Validate at boundaries: Zod at extractPhaseArtifact() and writePhaseRecord(); all deserialization through concrete schemas
- Errors are data: Result<T, E> return types, no throws
- Compose with small pure functions: context-assembly.ts functions are pure, no I/O
- DI for boundaries: file I/O behind AdaptiveCoordinatorDeps interface
- Immutability by default: priorArtifacts accumulation uses new array creation (spread), never push()

## Invariants

1. Engine contract registration BEFORE workflow outputContract declarations (in same PR)
2. `wr.contracts.discovery_handoff` must get a validator case (currently missing despite being registered)
3. buildContextSummary() priority-ordered trimming: hard constraints never dropped; orientation aids dropped first; never truncate mid-array item
4. `'fix'` target phase includes `filesChanged` from coding artifact (fix agent needs to know which files to modify)
5. All new DiscoveryHandoffArtifactV1 fields use z.optional() for backward compat
6. PhaseResult<T> -- concrete per-phase Zod schemas; all deserialization paths use them (no raw casts)
7. runId generated at runFullPipeline()/runImplementPipeline() start, passed as explicit parameter (not closure) to all sub-functions including runReviewAndVerdictCycle()
8. priorArtifacts accumulated via spread (new array), never mutated in place

## Selected Approach

9-slice sequential implementation (reordered: types before functions that use them).

**Why single PR:** workflow outputContract declarations reference engine contractRefs. Partial landing breaks MCP sessions.

## Vertical Slices

### Slice 1: Enrich DiscoveryHandoffArtifactV1 + new artifact schemas
**Files:** `src/v2/durable-core/schemas/artifacts/discovery-handoff.ts`, `src/v2/durable-core/schemas/artifacts/phase-handoff.ts` (new), `src/v2/durable-core/schemas/artifacts/index.ts`
**Done when:** `DiscoveryHandoffArtifactV1Schema` has optional `rejectedDirections`, `implementationConstraints`, `keyCodebaseLocations` with maxItems/maxLength. `ShapingHandoffArtifactV1Schema` and `CodingHandoffArtifactV1Schema` exist with all fields (including `validationChecklist` on shaping, `correctedAssumptions` optional on coding). `PhaseHandoffArtifact` union exported. All schemas use `.strict()`. All new types exported from `index.ts` including `isShapingHandoffArtifact`, `isCodingHandoffArtifact`, `parseShapingHandoffArtifact`, `parseCodingHandoffArtifact`.

### Slice 2: Engine contract registration (including discovery_handoff fix)
**Files:** `src/v2/durable-core/schemas/artifacts/index.ts`, `src/v2/durable-core/domain/artifact-contract-validator.ts`
**Done when:** `wr.contracts.shaping_handoff` and `wr.contracts.coding_handoff` in `ARTIFACT_CONTRACT_REFS`. `wr.contracts.discovery_handoff` now has a validator case in the switch (currently missing -- it's registered but falls through to UNKNOWN_CONTRACT_REF). Validators `validateShapingHandoffContract()`, `validateCodingHandoffContract()`, `validateDiscoveryHandoffContract()` implemented following `validateReviewVerdictContract()` pattern. All existing tests pass.

### Slice 3: PipelineRunContext types + Zod schemas
**File:** `src/coordinators/pipeline-run-context.ts` (new)
**Done when:** `PhaseResult<T>` interface (3 variants: full/partial/fallback). `PipelineRunContext` interface with `phases` flat object. `DiscoveryPhaseRecord/ShapingPhaseRecord/CodingPhaseRecord/ReviewPhaseRecord` interfaces. Concrete Zod schemas for each using `z.discriminatedUnion()` for PhaseResult. `buildPhaseResult<T>()` pure function. All deserialization paths use concrete schemas (no generic casts). Tests in `tests/unit/coordinators/build-phase-result.test.ts`.

### Slice 4: context-assembly.ts (depends on Slice 3)
**File:** `src/coordinators/context-assembly.ts` (new)
**Done when:** `extractPhaseArtifact<T>(artifacts, schema)` validates and returns `T | null`. `buildContextSummary(priorArtifacts, targetPhase)` implements selection table including `filesChanged` in `'fix'` target phase. Priority-ordered trimming with complete-section-or-omit rule. Unit tests in `tests/unit/coordinators/context-assembly.test.ts` asserting presence AND absence per phase plus trimming behavior.

### Slice 5: AdaptiveCoordinatorDeps additions
**File:** `src/coordinators/adaptive-pipeline.ts`
**Done when:** `readPipelineContext(runId): Promise<Result<PipelineRunContext|null, string>>`, `writePhaseRecord(runId, record: PhaseRecord): Promise<Result<void, string>>` (single union type, not overloads), and `generateRunId(): string` added to `AdaptiveCoordinatorDeps`. TypeScript compiles.

### Slice 6: coordinator-deps.ts + crash recovery
**File:** `src/trigger/coordinator-deps.ts`
**Done when:** `readPipelineContext` reads `{workspace}/.workrail/pipeline-runs/{runId}-context.json`, returns `ok(null)` if missing. `writePhaseRecord` atomically writes (temp-rename). `generateRunId` returns `randomUUID()`. Crash recovery logic: if coordinator starts and a `{runId}-context.json` exists, `readPipelineContext` restores prior phase records; mode executors check existing phase records and skip already-completed phases. Unit tests: read/write round-trip, atomicity, missing-file, crash-recovery restore.

### Slice 7: Mode executor updates
**Files:** `src/coordinators/modes/full-pipeline.ts`, `implement.ts`, `implement-shared.ts`, `quick-review.ts`
**Done when:** Each mode generates `runId` at entry. `runFullPipelineCore()` and `runReviewAndVerdictCycle()` accept `runId` and `priorArtifacts` as explicit parameters (not closure). **`implement.ts` updated simultaneously** -- it also calls `runReviewAndVerdictCycle()` and must pass these new params. `buildContextSummary(priorArtifacts, targetPhase)` called before each `spawnSession()`. `writePhaseRecord()` called after each `getAgentResult()`. priorArtifacts accumulated via spread (not push). All existing coordinator tests pass.

### Slice 8: Workflow authoring changes
**Files:** `workflows/wr.discovery.json`, `workflows/wr.shaping.json`, `workflows/coding-task-workflow-agentic.json`, `workflows/mr-review-workflow.agentic.v2.json`
**Done when:** All 4 workflows updated per pitch spec. `coding-task-workflow-agentic.json` `phase-8-retrospective` prompt explicitly states: "correctedAssumptions is populated by fix/retry agents documenting what assumptions turned out to be wrong. On a first-run coding session, omit this field." All 38 smoke tests pass. `npm run validate:registry` passes.

### Slice 9: Tests
**Files:** `tests/unit/coordinators/`, `tests/lifecycle/`, validation test
**Done when:** All unit tests from plan pass. Lifecycle integration tests assert each of 4 workflows emits expected artifact kind at final step. Validation test asserts all bundled workflow outputContract contractRefs exist in ARTIFACT_CONTRACT_REFS AND have validator cases in the switch. Build passes.

## Test Design

**Unit: `tests/unit/coordinators/context-assembly.test.ts`**
- `buildContextSummary([], 'coding')` → empty string
- `buildContextSummary([discoveryArtifact], 'coding')` → contains `implementationConstraints`, does NOT contain `selectedDirection`
- `buildContextSummary([discoveryArtifact, shapingArtifact], 'coding')` → contains `keyConstraints`, `rabbitHoles`, does NOT contain `keyDecisions`
- `buildContextSummary([all3], 'review')` → contains `validationChecklist`, `keyDecisions`, does NOT contain `keyCodebaseLocations` (orientation aid, dropped under pressure)
- `buildContextSummary([all3], 'fix')` → contains `filesChanged`, `keyDecisions`, `keyConstraints`
- `buildContextSummary([oversizedArtifacts], 'review')` → ≤ 8KB, priority-1 present, priority-3 absent, no truncated array items

**Unit: `tests/unit/coordinators/build-phase-result.test.ts`**
- Full artifact → `{ kind: 'full', artifact, confidenceBand }`
- Long recapMarkdown → `{ kind: 'partial' }`
- Short/null → `{ kind: 'fallback' }`

**Unit: `tests/unit/coordinators/pipeline-run-context.test.ts`**
- Round-trip with PhaseResult.kind preserved
- Crash recovery: write phases 1-2, read back, phases present
- Missing file → `ok(null)`
- Write is atomic

**Validation test:**
- All bundled workflow outputContract contractRefs exist in ARTIFACT_CONTRACT_REFS
- All registered contractRefs have a validator case (not falling through to default)

**Lifecycle integration:**
- `wr.shaping` final step emits `wr.shaping_handoff`
- `coding-task-workflow-agentic` final step emits `wr.coding_handoff`
- `wr.discovery` final step emits enriched `wr.discovery_handoff`
- `mr-review-workflow` phase-0 processes `validationChecklist`

**Adversarial behavioral test (`tests/integration/living-work-context-adversarial.test.ts`):**
- Run a scripted pipeline with a fake LLM client
- Shaping session emits `wr.shaping_handoff` with `validationChecklist: ["do not modify the auth middleware"]`
- Coding session emits `wr.coding_handoff` with `filesChanged: ["src/auth/middleware.ts"]`
- Review session receives assembled context including both artifacts
- Assert: review session's assembled context string contains the validationChecklist item
- Assert: review session's assembled context string contains the filesChanged entry
- WHY this test: unit tests prove plumbing; this test proves the context actually reaches the review agent in a form it can act on. It is the only test that falsifies the full chain.

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Workflow changes before engine contracts | HIGH | Slice 2 before Slice 8; single PR |
| discovery_handoff missing validator case | HIGH | Slice 2 explicitly adds it |
| runId threading blast radius (implement.ts) | MEDIUM | Slice 7 explicitly names implement.ts as co-change |
| buildContextSummary 'fix' missing filesChanged | HIGH | Fixed in selection table; test asserts presence |
| Unit tests pass for wrong reasons (coverage problem) | HIGH | Adversarial integration test (AC 21): scripted pipeline where shaping constraint is violated by coding, review must flag it |
| Type erasure at JSON boundary | MEDIUM | All deserialization paths through concrete Zod schemas |
| priorArtifacts mutation | LOW | Spread pattern enforced; invariant documented |

## PR Packaging

Single PR. All 9 slices. Gated by all existing tests + new unit + lifecycle integration + contractRef validation test.

## Follow-up Tickets

- buildSystemPrompt() named semantic slots
- console visualization of PipelineRunContext
- extensible contract registration
- coordinator retry logic based on PhaseResult.kind = 'fallback'
- targetPhase type: confirm 'discovery' is not a valid target (nothing precedes discovery) -- update docstring if so
