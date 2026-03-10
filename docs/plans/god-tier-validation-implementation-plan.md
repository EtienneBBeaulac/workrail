# God-Tier Workflow Validation: Implementation Plan

## Mission

Make workflow validation the authoritative, runtime-equivalent gate for all workflows.

A workflow should never fail during user-visible execution because the workflow itself is invalid.
Invalid workflows should never be mergeable.
Invalid workflows should never be hidden.
Validation must catch everything runtime would care about, before users hit it.

**The mission is not complete until runtime stops hiding invalid workflows.** Phase 4 Option B (keep filtering, add reporting) is a rollout stage, not mission success. Option A (remove filtering, fail loudly) is required. Any description of the system as "done" while Option B is active is false. This is non-negotiable.

### Formal Invariants

**Invariant 1: Any workflow-definition error encountered at runtime is a validator bug.**

If a workflow passes all validation tiers and then fails during `start_workflow`, `continue_workflow`, or any execution step due to a problem with the workflow definition itself (not agent behavior, not infrastructure failure) — that is a defect in the validation system. The validator is the firewall. If something gets through, the firewall is broken.

**What counts as a workflow-definition error** (validator's responsibility):
- Schema/shape violations (JSON structure doesn't match schema)
- Structural violations (duplicate step IDs, missing prompt source, invalid function call signatures)
- Normalization failures (unresolvable templateCall, broken promptBlocks, authoring-key leaks)
- Executable schema failures (Zod `.strict()` rejection after normalization)
- Compilation failures (unknown `outputContract.contractRef`, loop body referencing missing step, duplicate step IDs in executable form)
- Missing step resolution (step ID in execution state doesn't exist in compiled workflow)
- Invalid condition source / loop structure (condition evaluation fails on shape, not on data)
- Unreachable or structurally broken start state (no reachable first step)
- Serialization round-trip failures (snapshot doesn't survive JSON stringify > parse > Zod)

**What does NOT count** (not the validator's responsibility):
- User-provided bad content in step output (agent writes garbage `notesMarkdown`)
- External tool failures (MCP tool call errors, network timeouts)
- Storage/network/infrastructure failures (pinned store unavailable, session store write fails)
- Model hallucinations in step output (LLM produces unexpected artifacts)
- Context variable values set by the agent at runtime (a loop condition evaluating to unexpected result based on agent-provided data)
- Token signing/verification failures (infrastructure)
- Session state corruption (infrastructure)

This boundary matters. Without it, Invariant 1 becomes a debate. The rule is: if the error would occur regardless of what the agent does (it's inherent in the workflow definition), it's a validator bug. If the error depends on agent behavior or infrastructure state, it's not.

**Invariant 2: Runtime must never discover a workflow-definition error that the validation pipeline cannot represent.**

If runtime produces an error kind (e.g. a new `DomainError` variant from the compiler or interpreter) that the `ValidationOutcome` union doesn't have a corresponding variant for, the error taxonomy is incomplete. Every possible workflow-definition error that runtime can produce must have a home in the validation pipeline's discriminated union. This keeps the error taxonomy honest and prevents silent classes of failure.

**Invariant 3: `start_workflow(workflowId)` must validate the same resolved source and variant that registry validation validated.**

If CI validates variant A of a workflow and runtime resolves variant B (because feature flags differ, or source priorities differ), the CI gate is useless. The validation pipeline and the runtime resolution path must converge on the same workflow for the same inputs. This is the exact bug class that the plan exists to eliminate.

**Invariant 4: No consumer may answer "is this workflow valid?" without calling the unified validation pipeline.**

If any codepath — CLI, MCP tool, CI script, runtime assertion, or future consumer — makes a validity judgment about a workflow by calling AJV directly, running structural checks independently, or reimplementing any validation phase, it is violating this invariant. The pipeline is the only authority. Consumers call the pipeline and format the result for their context. They do not perform validation logic themselves.

### Single Source of Resolution Truth

Registry validation and runtime must use the **same resolution codepath** -- not two implementations of the same logic.

This means:
- **Same storage chain**: the validator uses the identical `EnhancedMultiSourceWorkflowStorage` composition that runtime uses, not a reimplementation or simplified version
- **Same file discovery**: `findWorkflowJsonFiles()` is a shared pure function called by both `FileWorkflowStorage` and the raw file scanner — not reimplemented
- **Same variant selection**: `FileWorkflowStorage.buildWorkflowIndex()` is called once, by the shared storage chain — the validator does not reimplement variant precedence rules
- **Same cross-source resolution**: `resolveWorkflowCandidates()` is a shared pure function called by both `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` and the registry snapshot builder — not duplicated or reverse-engineered
- **Same start construction**: `resolveFirstStep()` is a shared pure function called by both `start.ts` (runtime) and the validation pipeline (Phase 1 step 8) — not reimplemented
- **Same feature-flag interpretation**: the validator receives the same feature-flag configuration that runtime would use for each variant

If this principle is violated — if validation resolves workflows through one codepath and runtime through another — Invariant 3 is unenforceable. Duplicate implementations will drift. The validator becomes a false assurance layer that validates something other than what runtime actually sees.

The `RegistrySnapshot` design (Phase 2) satisfies this: it is built by calling the actual shared functions (`resolveWorkflowCandidates`, `findWorkflowJsonFiles`) and the actual storage chain (`loadAllWorkflows` per source). The validator consumes the snapshot; it never resolves workflows itself.

### Authoritative Validation Entrypoint

There is **exactly one validation pipeline function**. Every consumer that needs to answer "is this workflow valid?" calls the same function.

| Consumer | How it calls the pipeline |
|---|---|
| **CLI `validate`** | Loads workflow from file, calls `validateWorkflow()`, reports result |
| **MCP `validate_workflow_json`** | Parses JSON, calls `validateWorkflow()`, returns result |
| **Registry validator (Phase 2)** | Iterates resolved workflows, calls `validateWorkflow()` per workflow |
| **CI / precommit (Phase 3)** | Calls registry validator, which calls `validateWorkflow()` per workflow |
| **Runtime assertions (future)** | Could call `validateWorkflow()` at `start_workflow` time as a defensive check |

This is an **architectural rule, not an implementation detail**:
- No consumer reimplements any validation phase. If a consumer needs schema validation, it calls the pipeline (which includes schema validation as phase 1), not the AJV validator directly.
- No consumer adds validation logic outside the pipeline. If a new check is needed, it goes into the pipeline — not into a specific consumer.
- The pipeline is the single source of truth for "what does valid mean." If two consumers disagree about whether a workflow is valid, one of them is wrong — and the pipeline's answer wins.

Currently 6 call sites perform overlapping validation work (see Gap 17 in the audit). After Phase 1, validation call sites use `validateWorkflow()` as the core function. The existing `ValidationEngine.validateWorkflow()`, `createValidateWorkflowFileUseCase()`, and `createValidateWorkflowJson()` call the pipeline and format the result for their specific consumer. Runtime execution (`start.ts`) does NOT call the pipeline in the initial delivery — the `ValidatedWorkflow` runtime type gate is deferred (see Cross-Cutting Concerns). Validation occurs at CI time (the gate), and at runtime through the existing pinning boundary (defense-in-depth).

---

### Success Metrics

These are the measurable outcomes that prove the system works. If any of these are not met, the effort is incomplete.

| Metric | Target | Measured by |
|---|---|---|
| Runtime workflow-definition failures in bundled workflows | **0** | No `DomainError` with a workflow-definition cause during `start_workflow` or `continue_workflow` for any bundled workflow |
| Discoverable workflow IDs covered by registry validation | **100%** | Every ID returned by `loadAllWorkflows()` under every feature-flag variant has a validation entry in the report |
| Raw discovered files covered by at least Tier 1 validation | **100%** | Every `.json` file found by `findJsonFiles()` across all sources has at least schema + structural validation |
| Bundled workflows with execution integrity tests | **100%** | Every workflow in `workflows/` has a Phase 6 test proving no `DomainError` at any step during execution (practical earlier — requires only minimal fixture data) |
| Bundled workflows with completion fixture tests | **100%** | Every workflow in `workflows/` has a Phase 6 test driving it from start to `isComplete: true` under deterministic fixtures (requires complete per-step fixture data — achievable later) |
| Validation exhaustiveness | **All failures in one run** | A single `npm run validate:workflows` invocation reports every failure across all variants -- never stops at first error |
| Ambiguous runtime workflow IDs | **0 allowed** | No duplicate non-`wr.*` workflow IDs across discoverable sources; no unresolved variant competition |
| Validation-runtime resolution parity | **Same codepath** | Registry validation and runtime use the identical storage chain and resolution logic (not two implementations) |

These metrics are not aspirational -- they are acceptance criteria. Phase completion is judged against them.

---

## Validation Tiers

Validation operates at three distinct tiers. Each tier subsumes the previous one. A workflow is only "valid" if it passes all three. This is the conceptual model for the entire plan.

### Tier 1: File Validation (Static)

Does this individual workflow file conform to the schema and structural rules?

- JSON schema validation (AJV)
- Structural checks (duplicate step IDs, prompt-source XOR, function call signatures, loop body rules)

This is what `validate-workflows.sh` does today (plus normalization). It's necessary but not sufficient.

Note: v1 compilation (`WorkflowCompiler.compile()`) is NOT part of Tier 1 — it's part of the full pipeline (Tier 2). The raw file scanner applies Tier 1 (schema + structural) to every discovered file regardless of variant selection. V1 compilation is more expensive and only runs on resolved workflows. The `Tier1Outcome` type reflects this: it has `schema_failed`, `structural_failed`, and `tier1_passed` — no compilation variant.

### Tier 2: Registry Validation (Discovery + Resolution)

Is this workflow discoverable, unambiguous, and valid in the way runtime would actually resolve it?

- Multi-source duplicate detection (no silent shadowing)
- Variant resolution (under all feature-flag combinations)
- Normalization to executable form
- Serialization round-trip (JSON stringify > parse > Zod)
- v2 executable compilation
- Startability (first step reachable, interpreter produces a pending step from initial state)

This is what the plan builds in Phases 1-5. It's the minimum bar for correctness.

**Caveat**: Phases 1-5 materially improve trust, but do not fully satisfy three philosophy-critical end states: (1) the "never hidden" requirement (`Option A` has not landed yet), (2) the runtime type gate (`ValidatedWorkflow` is not yet required by execution consumers), and (3) the full validation boundary (`renderPendingPrompt` is not yet part of the pipeline). See Phase 4 and Required Follow-Ups for details.

### Tier 3: Execution Validation (Lifecycle)

Can this workflow run start-to-completion without any workflow-definition error?

- Deterministic fixture-driven execution from start to terminal completion
- Every step advanced with fixture data
- Loops iterate and exit correctly
- All branches reachable under test fixtures
- No interpreter errors, no missing steps, no condition failures

This is Phase 6. It's the standard that earns the label "god-tier."

---

## Current State Summary

### Runtime Resolution Path

`EnhancedMultiSourceWorkflowStorage` discovers workflows from 7 priority tiers:
bundled > plugin > user > custom > git > remote > project (highest wins).

`FileWorkflowStorage.buildWorkflowIndex()` resolves variant precedence per ID:
`.v2.` > `.agentic.` > standard, governed by feature flags (`v2Tools`, `agenticRoutines`).

DI chain: `EnhancedMultiSourceWorkflowStorage` > `SchemaValidatingWorkflowStorage` (AJV) > `CachingWorkflowStorage`.

### Runtime Start Path

1. `workflowService.getWorkflowById(id)` -- resolves through storage chain
2. `compileV1WorkflowToPinnedSnapshot(workflow)` -- templates > features > refs > promptBlocks > strip authoring keys > Zod `.strict()` parse
3. Hash via JCS canonical bytes > SHA-256
4. Pin to content-addressed store
5. `loadPinnedWorkflowRuntime(pinned)` -- re-parse through `ExecutableWorkflowDefinitionSchema`
6. Create initial execution snapshot, mint tokens, render first pending prompt

### Runtime Advance Path

1. Load pinned snapshot from store by workflowHash
2. `loadPinnedWorkflowRuntime()` -- Zod re-parse
3. `new WorkflowCompiler().compileExecutable(pinnedWorkflow)` -- step graph, loop graph, contractRef validation
4. `interpreter.applyEvent()` + `interpreter.next()` -- state transition, condition evaluation, step selection

### Current Validation Path

`scripts/validate-workflows.sh` iterates `workflows/*.json` (non-recursive), runs `workrail validate <file>` per file.
CLI validate does: AJV schema > `ValidationEngine.validateWorkflow()` (structural + normalization via `compileV1WorkflowToPinnedSnapshot`).
Normalization result is discarded on success.

---

## Identified Gaps

### Gap 1: File-Centric vs Registry-Centric

`validate-workflows.sh` validates raw files in `workflows/`, not what runtime resolves.
It does not use `EnhancedMultiSourceWorkflowStorage`.
Runtime sees the composed, variant-resolved, multi-source registry; validation sees individual files.

### Gap 2: Silent Duplicate ID Shadowing

`EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` silently shadows duplicate IDs -- later sources overwrite earlier ones (except `wr.*` protection). No error, no warning, no detection.

### Gap 3: Variant Resolution Not Replicated

`FileWorkflowStorage` resolves `.v2.` vs `.agentic.` vs standard variants per feature flags. `validate-workflows.sh` validates every `*.json` independently. A file could pass standalone but never be selected by runtime.

### Gap 4: SchemaValidatingWorkflowStorage Silently Hides Invalid Workflows

Invalid workflows are filtered out in `loadAllWorkflows()` and return `null` from `getWorkflowById()`. Graceful degradation means invalid workflows are invisible, never reported.

### Gap 5: Discovery Validation Doesn't Test Validity

`validate-workflow-discovery.js` confirms listed IDs can be fetched, but does not validate that they compile, normalize, or start.

### Gap 6: No Executable Compilation in Validation

`ValidationEngine.validateWorkflow()` calls `compileV1WorkflowToPinnedSnapshot()` for normalization but does not call `WorkflowCompiler.compileExecutable()`. The executable compiler checks: duplicate step IDs in executable form, `outputContract.contractRef` against known contracts, loop body resolution, condition source derivation. None checked during validation.

### Gap 7: No Startability Validation

Nothing proves `loadAndPinWorkflow()` > initial snapshot > first pending step derivation would succeed. The interpreter's `next()` on initial state is never tested during validation.

### Gap 8: No Lifecycle Execution Testing

No deterministic harness that starts a workflow, advances step-by-step with fixture data, and drives to terminal completion.

### Gap 9: `listWorkflowSummaries()` Bypasses Validation

`SchemaValidatingWorkflowStorage.listWorkflowSummaries()` delegates directly to inner storage without validation. Summaries may include invalid workflows.

### Gap 10: Non-Recursive CI Script

`validate-workflows.sh` globs `workflows/*.json`. `FileWorkflowStorage` recursively scans subdirectories. Workflows in `workflows/routines/` are discovered by runtime but never validated by CI.

### Gap 11: Runtime Compilation Happens Per-Advance

`outcome-success.ts` creates `new WorkflowCompiler()` and calls `compileExecutable()` on every `continue_workflow` advance. If the compiler evolves (new checks), a pinned snapshot could fail mid-session.

### Gap 12: `interpreter.next()` Can Fail on Workflow Structure

The interpreter can error on missing step in compiled lookup, loop condition evaluation failures, guard iteration exceeded. These are workflow-definition errors that validation should catch statically.

### Gap 13: `renderPendingPrompt` Silently Degrades

If `getExecutableStepById` returns null, the renderer produces a fallback prompt instead of erroring. This hides structural breakage.

### Gap 14: Feature-Flag Variant Coverage

No CI step validates all workflows under all feature-flag variants. A workflow only appearing under `v2Tools=true` could be invalid and never caught.

### Gap 15: No Serialization Round-Trip Validation

Runtime serializes the executable snapshot to JSON (for hashing and pinning), then deserializes and re-parses through Zod. If `JSON.stringify` drops `undefined` fields that Zod `.strict()` then rejects, validation passes but runtime fails. The plan must test the round-trip.

### Gap 16: Dual Compilation Paths

v1 path: `WorkflowCompiler.compile(workflow: Workflow)` used by `DefaultWorkflowService`.
v2 path: `WorkflowCompiler.compileExecutable(workflow: ExecutableWorkflow)` used by advance handler.
Only validating the v2 path leaves the v1 path uncovered if v1 tools are still active.

### Gap 17: Validation Duplicated Across 6+ Call Sites

Validation logic runs in: `SchemaValidatingWorkflowStorage`, `ValidationEngine`, `validateWorkflowFileUseCase`, `validateWorkflowJson`, `loadAndPinWorkflow`, `outcome-success.ts`. The registry validator would be a 7th. No consolidation.

---

## Philosophy Alignment Constraints

The implementation targets these principles from the project coding philosophy. Most are delivered. Three are explicitly only **partially** satisfied in the initial delivery (see Cross-Cutting Concerns and Required Follow-Ups):

- **Make illegal states unrepresentable**: introduce a `ValidatedWorkflow` type that can only be produced through the validation pipeline. *(Partial: the type is created and used by the validator, but runtime execution consumers are NOT changed to require it in the initial delivery — see "`ValidatedWorkflow` as a Runtime Type Gate — Known Incompleteness" in Cross-Cutting Concerns.)*
- **Architectural fixes over patches**: extract validation from the storage decorator chain into a single, explicit boundary; do not bolt collectors onto the existing filter pattern. *(Partial in the initial delivery: Phase 4 Option B is an intentional containment patch, not the final architecture. Option A is required for mission completion.)*
- **Exhaustiveness everywhere**: use a discriminated union for validation outcomes, not a bag of optional phase results
- **Reduce path explosion**: typed error variants per phase, not stringly-typed error arrays
- **Functional/declarative**: validation pipeline as a `Result.andThen` chain, not imperative sequence
- **Prefer atomicity**: one call returns resolved registry + duplicate info + validation results from the same snapshot of disk state
- **Keep interfaces small**: duplicate detection is a pure function over `Workflow[]`, not a new method on storage
- **DI for boundaries**: registries and compilers are injected, not constructed ad-hoc in handlers
- **Cancellation/timeouts first-class**: validator accepts timeout/abort signal for slow sources
- **Higher-order functions at 3+ callsites**: consolidate the 6+ validation call sites into one composable pipeline
- **Validate at boundaries, trust inside**: the serialization round-trip (JSON stringify > parse > Zod) must be tested as part of the boundary. *(Partial in the initial delivery: prompt rendering is still outside the validation boundary until `renderPendingPrompt` is incorporated into the pipeline.)*

---

## Dependency Graph

```
Phase 1a (pipeline skeleton: schema+structural+v1+normalize)
  |
  ├──> Phase 1b (full pipeline: +roundtrip+v2+startability)
  |
  ├──> Phase 2 (registry validator + raw file scanner)
  |      |
  |      ├──> Phase 3 (CI/precommit replacement)
  |      └──> Phase 4 (eliminate silent hiding)
  |
  └──> Phase 4 (can also start from 1a alone for renderPendingPrompt fix)

Phase 1b + Phase 2-4 --> Phase 5 (regression tests)
  Note: tests 5-7 (variant resolution) require Phase 3 infrastructure
  Note: tests 15-17b (startability) require Phase 1b

Phase 5 --> Phase 6 (lifecycle execution harness)
```

Key: Phase 2 depends on Phase 1a (not 1b). This means registry-centric validation can begin before the full pipeline (round-trip, startability) is complete.

---

## Phase 1: Unified Validation Pipeline

### Goal

Create a single, composable validation pipeline that all call sites share.
Replace the 6+ scattered validation paths with one typed `Result.andThen` chain.

### Problem It Solves

Gaps 6, 7, 11, 12, 15, 16, 17.

Validation is currently fragmented: AJV in storage, structural in `ValidationEngine`, normalization in the shim, compilation in the advance handler, startability nowhere. The plan consolidates all phases into one pipeline function that every consumer uses, choosing how far through the pipeline to go.

### New File

`src/application/services/workflow-validation-pipeline.ts`

### Type Design

```typescript
// The pipeline's output type -- a discriminated union.
// Makes it impossible to represent "schema failed but compilation passed."

type ValidationOutcome =
  | { readonly kind: 'schema_failed'; readonly workflowId: string; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly workflowId: string; readonly issues: readonly string[] }
  | { readonly kind: 'v1_compilation_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'normalization_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'round_trip_failed'; readonly workflowId: string; readonly cause: string }
  | { readonly kind: 'v2_compilation_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'startability_failed'; readonly workflowId: string; readonly reason: StartabilityFailure }
  | { readonly kind: 'valid'; readonly validated: ValidatedWorkflow };

// The compile-time gate. Only constructible through the pipeline.
// Stores the ExecutableWorkflow (what runtime actually uses), not the snapshot
// (which is a serialization artifact).
interface ValidatedWorkflow {
  readonly kind: 'validated_workflow';
  readonly source: Workflow;
  readonly executable: ExecutableWorkflow;
  readonly compiledV1: CompiledWorkflow;
  readonly compiledExecutable: CompiledExecutableWorkflow;
}

type StartabilityFailure =
  | { readonly reason: 'no_steps' }                                          // workflow.definition.steps is empty
  | { readonly reason: 'first_step_not_in_executable'; readonly stepId: string } // steps[0].id doesn't resolve in executable form
  | { readonly reason: 'no_reachable_step' }                                 // interpreter.next returns isComplete with zero work
  | { readonly reason: 'interpreter_error'; readonly detail: string };        // interpreter.next returns a DomainError
```

Note: `structural_failed.issues` stays `readonly string[]` because `ValidationEngine.validateWorkflow()` currently produces `string[]`. Promoting these to typed domain objects would require reworking the entire structural validator, which is out of scope. The discriminated union on `kind` already provides exhaustiveness -- the string content is human-readable diagnostic, not machine-parsed.

### Pipeline Shape

```typescript
function validateWorkflow(
  workflow: Workflow,
  deps: ValidationPipelineDeps
): ValidationOutcome
```

Where `ValidationPipelineDeps` injects:
- `schemaValidate` (AJV)
- `structuralValidate` (`ValidationEngine.validateWorkflow` minus the normalization call)
- `compiler` (`WorkflowCompiler`)
- `interpreter` (`WorkflowInterpreter`)

The pipeline internally chains (matching the exact runtime data flow):

1. **Schema** -- AJV validation against `workflow.schema.json`
2. **Structural** -- `ValidationEngine` structural checks (step rules, loop rules, prompt-source XOR, function calls) WITHOUT the normalization call (extracted out)
3. **v1 Compilation** -- `compiler.compile(workflow)` on the raw authored workflow (what `DefaultWorkflowService.getOrCompile` does). This catches v1-only compilation errors (step graph, loop body, outputContract refs on authored form). Runs BEFORE normalization because it takes `Workflow`, not `ExecutableWorkflow`.
4. **Normalization** -- `compileV1WorkflowToPinnedSnapshot(workflow)` produces an executable snapshot with `.definition: ExecutableWorkflowDefinition`
5. **Serialization round-trip** -- `JSON.parse(JSON.stringify(snapshot))` then re-parse `.definition` through `ExecutableWorkflowDefinitionSchema`. This proves the exact bytes runtime would store and reload are valid. Produces a round-tripped `ExecutableWorkflowDefinition`.
6. **Executable construction** -- `createExecutableWorkflow(roundTrippedDefinition)` produces an `ExecutableWorkflow` (what runtime actually passes to the compiler and interpreter)
7. **v2 Compilation** -- `compiler.compileExecutable(executableWorkflow)` on the executable form (what `outcome-success.ts` does on every advance). Catches executable-only issues: step graph in executable form, loop body resolution, condition source derivation.
8. **Startability** -- calls the shared `resolveFirstStep()` function (see "Shared Start-Construction Function" below), then runs an additional interpreter reachability check:
   - **First-step resolution** (shared with runtime): `resolveFirstStep(authoredWorkflow, executable)` — the **same function** `start.ts` calls. Verifies `steps[0]` exists and its ID resolves in the executable workflow. Zero drift.
   - **Interpreter reachability** (validation-only, stricter than runtime): `interpreter.next(compiledExecutable, { kind: 'init' })` — verify the interpreter can produce a pending step from the initial state. Runtime doesn't call the interpreter at start (it trusts `steps[0]`), but this catches workflows where the first step has a false `runCondition` or is a loop with an invalid condition. Note: `{ kind: 'init' }` is the correct initial state; `ensureRunning()` internally converts it to `{ kind: 'running', completed: [], loopStack: [], pendingStep: undefined }`.
   - If `interpreter.next()` returns `isComplete: true, next: null` with zero completed steps, that's a startability failure (zero useful work — the workflow has no reachable steps).

### Shared Start-Construction Function — Eliminating Drift

**Problem (designed out)**: the previous design had the pipeline's startability check reimplementing first-step resolution logic from `start.ts`. If `start.ts` changed how it derives the first step, the validator wouldn't know.

**Solution**: extract the pure start-construction logic from `start.ts` into a **shared pure function** in a new file `src/v2/durable-core/domain/first-step-resolution.ts`:

#### Type Design (Philosophy-Aligned)

```typescript
/**
 * Discriminated union for first-step resolution outcomes.
 * 
 * Philosophy: "Make illegal states unrepresentable" + "Exhaustiveness everywhere"
 * Each failure mode is a distinct variant with specific context.
 */
export type FirstStepResolutionOutcome =
  | { readonly kind: 'no_steps_in_authored'; readonly workflowId: string }
  | { readonly kind: 'authored_step_missing_in_executable'; readonly workflowId: string; readonly authoredStepId: string }
  | { readonly kind: 'resolved'; readonly step: ResolvedFirstStep };

/**
 * The validated first step, carrying both forms.
 * 
 * Philosophy: "Prefer explicit domain types over primitives"
 * Not just a string ID — carries the full step data from both forms.
 */
export interface ResolvedFirstStep {
  readonly kind: 'resolved_first_step';
  readonly authoredStepId: string;
  readonly executableStep: ExecutableWorkflowStep;
}

/**
 * Resolve the first step of a workflow, validating consistency between
 * authored and executable forms.
 * 
 * This is the **shared source of truth** for:
 * - Runtime `start.ts` (lines 66-70): determines the initial pending step
 * - Validation pipeline Phase 1 step 8: proves startability
 * 
 * Philosophy: "Single source of resolution truth" + "Determinism over cleverness"
 * Pure function, no I/O, no hidden state, no feature-flag checks.
 */
export function resolveFirstStep(
  authored: Workflow,
  executable: ExecutableWorkflow
): FirstStepResolutionOutcome
```

#### Implementation

```typescript
export function resolveFirstStep(
  authored: Workflow,
  executable: ExecutableWorkflow
): FirstStepResolutionOutcome {
  // Step 1: Check authored form has steps
  const authoredFirstStep = authored.definition.steps[0];
  if (!authoredFirstStep) {
    return { kind: 'no_steps_in_authored', workflowId: authored.definition.id };
  }

  const authoredStepId = authoredFirstStep.id;

  // Step 2: Verify the step ID exists in the executable form
  // (Catches normalization bugs where step IDs change or are dropped)
  const executableStep = getExecutableStepById(executable, authoredStepId);
  if (!executableStep) {
    return {
      kind: 'authored_step_missing_in_executable',
      workflowId: authored.definition.id,
      authoredStepId,
    };
  }

  // Step 3: Return the validated coupling
  return {
    kind: 'resolved',
    step: {
      kind: 'resolved_first_step',
      authoredStepId,
      executableStep,
    },
  };
}
```

**Why discriminated union over `Result<T, E>`**: the philosophy says "reduce path explosion." A generic `Result` with a generic failure type forces every caller to interpret the failure. The discriminated union makes each failure mode explicit and exhaustively matchable. Callers can't ignore `authored_step_missing_in_executable` — the compiler forces them to handle it.

#### Integration: `start.ts` Refactored

**Before** (inline logic, lines 62-70):
```typescript
.andThen((workflow): RA<{ workflow: Workflow; firstStep: { readonly id: string } }, StartWorkflowError> => {
  if (!workflow) {
    return neErrorAsync({ kind: 'workflow_not_found', workflowId: asWorkflowId(workflowId) });
  }
  const firstStep = workflow.definition.steps[0];
  if (!firstStep) {
    return neErrorAsync({ kind: 'workflow_has_no_steps', workflowId: asWorkflowId(workflowId) });
  }
  return okAsync({ workflow, firstStep });
})
```

**After** (shared function, called AFTER pinning):
```typescript
.andThen(({ workflow, workflowHash, pinnedWorkflow }) => {
  // Resolve and validate first step using the shared pure function
  const resolution = resolveFirstStep(workflow, pinnedWorkflow);
  
  if (resolution.kind !== 'resolved') {
    // Map domain outcome to runtime error
    const error: StartWorkflowError = resolution.kind === 'no_steps_in_authored'
      ? { kind: 'workflow_has_no_steps', workflowId: asWorkflowId(resolution.workflowId) }
      : { kind: 'invariant_violation', message: `First step '${resolution.authoredStepId}' from authored workflow not found in executable workflow '${resolution.workflowId}'` };
    return neErrorAsync(error);
  }
  
  const { authoredStepId } = resolution.step;
  return okAsync({ workflow, firstStepId: authoredStepId, workflowHash, pinnedWorkflow });
})
```

**Reordering note**: `resolveFirstStep` is called AFTER normalization and pinning (the executable workflow is needed for the cross-form check). Currently `start.ts` resolves the first step BEFORE normalization (line 66). This is a safe reorder: if `steps[0]` doesn't exist, normalization would succeed but start would fail at the same point — just later. The behavior change: the check now also verifies cross-form resolution (which it didn't before — a bug fix).

#### Integration: Validation Pipeline (Phase 1 Step 8)

```typescript
// In validateWorkflow() pipeline, step 8 startability:
const firstStepResolution = resolveFirstStep(workflow, executableWorkflow);

if (firstStepResolution.kind !== 'resolved') {
  return {
    kind: 'startability_failed',
    workflowId: workflow.definition.id,
    reason: firstStepResolution.kind === 'no_steps_in_authored'
      ? { reason: 'no_steps_in_workflow' }
      : { reason: 'first_step_missing_in_executable', authoredStepId: firstStepResolution.authoredStepId },
  };
}

// Now prove interpreter reachability with the validated step
const interpreterResult = interpreter.next(compiledExecutable, { kind: 'init' });
// ... rest of startability validation

// Additional: interpreter reachability (stricter than runtime)
const nextRes = interpreter.next(compiledExecutable, { kind: 'init' });
if (nextRes.isErr()) return { kind: 'startability_failed', reason: { reason: 'interpreter_error', detail: nextRes.error.message } };
if (nextRes.value.isComplete && nextRes.value.next === null) {
  return { kind: 'startability_failed', reason: { reason: 'no_reachable_step' } };
}
```

**Where it lives**: `src/v2/durable-core/domain/start-construction.ts` — a shared module imported by both `start.ts` and the validation pipeline.

**Why the interpreter check is validation-only**: runtime doesn't call `interpreter.next()` at start time. It trusts `steps[0]` and sets it as the pending step. The interpreter is only invoked on the first `continue_workflow` advance. Making runtime also call `interpreter.next()` at start would be a behavior change (a workflow with `runCondition: false` on `steps[0]` currently starts successfully; with the interpreter check it would fail). The validation pipeline is allowed to be stricter than runtime — it catches potential issues that runtime would only discover on first advance.

Short-circuits on first failure, returns the typed `ValidationOutcome`.

Note: steps 3 and 4-8 form two compilation paths. Step 3 validates the v1 path (authored Workflow). Steps 4-8 validate the v2 path (executable form). Both must pass.

Note: step 6 (`createExecutableWorkflow`) is a non-failing step — it's `Object.freeze({ kind: 'executable_workflow', definition })`. No error variant is needed. It exists in the pipeline for type correctness (producing the `ExecutableWorkflow` type that phase 7 requires), not as a validation gate.

### Changes to Existing Code

- `ValidationEngine.validateWorkflow()`: the `compileV1WorkflowToPinnedSnapshot` call at the end of the method (lines 763+) must be extracted out. The engine should do structural checks only (duplicate step IDs, step validation, loop validation, function call validation). The normalization call that currently lives at the bottom of `validateWorkflow()` is removed — the pipeline calls normalization as a separate phase. This is a clean extraction: the normalization is the last thing the method does, gated by `if (issues.length === 0)`. Removing those lines doesn't affect the structural checks above.
- `createValidateWorkflowFileUseCase`: rewire to call the pipeline function
- `createValidateWorkflowJson`: rewire to call the pipeline function
- `start.ts` (`loadAndPinWorkflow`): replace inline first-step resolution (lines 66-69) with a call to the shared `resolveFirstStep()` function. The check moves to after pinning (so the executable workflow is available for cross-form verification). Error kind changes from `workflow_has_no_steps` to `startability_failed`.

### New Shared Files

- `src/application/services/workflow-validation-pipeline.ts` — the unified validation pipeline
- `src/v2/durable-core/domain/first-step-resolution.ts` — exports `resolveFirstStep()`, `FirstStepResolutionOutcome`, `ResolvedFirstStep` (shared pure function + types). Imported by both `start.ts` and the validation pipeline.

### `ValidationEngine` Demotion

After this refactor, `ValidationEngine` becomes a **structural-only validator for authored workflows**. It is a leaf dependency of the pipeline, not the center of gravity. The pipeline function (`validateWorkflow()`) is the new authority — all consumers go through it.

Concretely:
- No consumer should call `ValidationEngine.validateWorkflow()` directly. They call the pipeline.
- `ValidationEngine` is injected into the pipeline as `structuralValidate` — it's one phase, not the orchestrator.
- The class name `ValidationEngine` may suggest it's the primary validation entry point. Consider renaming to `StructuralValidator` or `AuthoredWorkflowValidator` to make its demotion explicit. (Not required for this effort, but strongly recommended as follow-up.)

### Implementation Discipline

Phase 1 is the largest single phase: 8 pipeline stages, 2 compilation paths, type-safe union output. Implementation risk is real. Guardrails:

- **Each phase is a standalone pure function**: `validateSchema(workflow) → Result<Workflow, SchemaError[]>`, `validateStructural(workflow) → Result<Workflow, string[]>`, etc. The pipeline composes them. No phase knows about any other phase.
- **Zero stringly-typed branching**: the discriminated union is the only control flow mechanism. No `if (error.message.includes(...))` anywhere.
- **Phase boundaries are type boundaries**: each phase function accepts the output type of the previous phase and returns the input type of the next. The types enforce ordering — you literally can't call `compileExecutable` without first producing an `ExecutableWorkflow`.
- **One file, one export**: `workflow-validation-pipeline.ts` exports exactly `validateWorkflow()`, `ValidationOutcome`, and `ValidatedWorkflow`. The per-phase helpers are private.
- **Test each phase independently**: before wiring the pipeline, each phase function should have its own unit tests. The pipeline integration test then just proves they compose correctly.

### Minimum Mergeable Slice (Phase 1a vs 1b)

Phase 1 is the right end-state but building all 8 stages in one PR is risky. Split into two mergeable slices:

**Phase 1a** (first merge):
- Pipeline skeleton: `validateWorkflow()` function, `ValidationOutcome` union, `ValidatedWorkflow` type
- Wire stages 1-4: schema → structural → v1 compilation → normalization
- These 4 stages reuse existing code (`validateWorkflow` from `validation.ts`, `ValidationEngine.validateWorkflow()`, `WorkflowCompiler.compile()`, `compileV1WorkflowToPinnedSnapshot`)
- Existing CLI `validate` and MCP `validate_workflow_json` rewired to use the pipeline
- Per-stage unit tests + pipeline integration test

**Phase 1b** (second merge):
- Add stages 5-8: round-trip → executable construction → v2 compilation → startability
- Extract `resolveFirstStep()` into `start-construction.ts`; refactor `start.ts` to call it
- These stages include new validation logic (round-trip test, `createExecutableWorkflow`, `compileExecutable`, `interpreter.next`) and one runtime refactor (`start.ts` first-step extraction)
- Per-stage unit tests for the new stages + test that `resolveFirstStep()` matches `start.ts` behavior

Phase 1a is useful on its own — it consolidates existing validation into the pipeline and proves the architecture. Phase 1b extends it to cover the runtime-specific checks. Phase 2 depends on Phase 1a, not 1b.

### Acceptance Criteria

- [ ] One function `validateWorkflow()` that runs all 8 phases
- [ ] Returns a discriminated union `ValidationOutcome` -- exhaustive switch required by consumers
- [ ] `ValidatedWorkflow` type is only produced on full success
- [ ] `ValidatedWorkflow` stores `ExecutableWorkflow` (not snapshot), plus both compiled forms
- [ ] Serialization round-trip (JSON stringify > parse > Zod) is phase 5 of the pipeline
- [ ] `createExecutableWorkflow()` is called on the round-tripped definition (matching runtime)
- [ ] v1 `compile()` runs on authored `Workflow` (phase 3)
- [ ] v2 `compileExecutable()` runs on `ExecutableWorkflow` from round-tripped definition (phase 7)
- [ ] Startability proven: `resolveFirstStep(authored, executable)` returns `{ kind: 'resolved' }` AND `interpreter.next({ kind: 'init' })` returns a pending step (phase 8)
- [ ] Startability failure detected when `interpreter.next()` returns `isComplete: true` with zero completed steps
- [ ] `resolveFirstStep` is a shared pure function in `first-step-resolution.ts`, imported by both `start.ts` and the pipeline
- [ ] `resolveFirstStep` returns a discriminated union (`FirstStepResolutionOutcome`) with exhaustive error variants
- [ ] `start.ts` refactored to call `resolveFirstStep` after pinning (instead of inline logic before normalization)
- [ ] v1 and v2 compilation failures distinguished in the union (`v1_compilation_failed` vs `v2_compilation_failed`)
- [ ] All deps injected -- no `new WorkflowCompiler()` inside the function
- [ ] Existing CLI `validate` and MCP `validate_workflow_json` rewired to use the pipeline

---

## Phase 2: Registry-Centric Validation

### Goal

Build a function that validates workflows the way runtime discovers and resolves them -- through the same multi-source, variant-aware registry.

### Problem It Solves

Gaps 1, 2, 3, 5, 10, 14.

### New Files

- `src/application/use-cases/validate-workflow-registry.ts` — the registry validator
- `src/infrastructure/storage/workflow-resolution.ts` — exports `resolveWorkflowCandidates()`, `ResolutionReason`, `VariantResolution`, `SourceRef` (shared pure function + types). Imported by both `EnhancedMultiSourceWorkflowStorage` and the snapshot builder.
- `src/infrastructure/storage/workflow-file-discovery.ts` — exports `findWorkflowJsonFiles()` (shared pure function). Imported by both `FileWorkflowStorage` and the raw file scanner.
- `src/application/use-cases/raw-workflow-file-scanner.ts` — scans raw files with JSON parsing + variant detection, produces `RawWorkflowFile[]`

### Design

```typescript
interface RegistryValidationReport {
  readonly variant: string;
  readonly totalWorkflows: number;
  readonly validCount: number;
  readonly invalidCount: number;
  readonly duplicateIds: readonly DuplicateIdReport[];
  // Full pipeline results for resolved workflows (what runtime uses)
  readonly resolvedResults: readonly ResolvedValidationEntry[];
  // Tier 1 results for all raw discovered files (including variant losers)
  readonly rawFileResults: readonly RawFileValidationEntry[];
}

interface DuplicateIdReport {
  readonly workflowId: string;
  readonly sources: readonly { readonly sourceKind: string; readonly sourceRef: string }[];
}

// Entry for a resolved workflow (runtime would select this one)
interface ResolvedValidationEntry {
  readonly workflowId: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly resolvedBy: ResolutionReason; // why this source/variant won
  readonly outcome: ValidationOutcome; // full Phase 1 pipeline
}

// Entry for a raw discovered file (may be a variant loser or flag-filtered)
// Only gets Tier 1 validation (schema + structural), not the full pipeline.
interface RawFileValidationEntry {
  readonly filePath: string;
  readonly sourceKind: string;
  readonly workflowId: string;
  readonly variantKind: 'v2' | 'agentic' | 'standard';
  readonly isResolvedWinner: boolean; // true if this file is also the resolved variant
  readonly tier1Outcome: Tier1Outcome; // schema + structural only
}

type Tier1Outcome =
  | { readonly kind: 'schema_failed'; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly issues: readonly string[] }
  | { readonly kind: 'tier1_passed' };

// ResolutionReason type is defined in the "Shared Resolution Function" section below
```

The two entry types serve different purposes:
- `ResolvedValidationEntry`: "is the workflow runtime would use valid?" (full pipeline)
- `RawFileValidationEntry`: "are there any invalid workflow files in the repo that could become problems later?" (Tier 1 only)

`isResolvedWinner` on raw file entries links the two: if a raw file is also the resolved winner, its full pipeline result is in `resolvedResults`. This avoids duplicating the full pipeline result.

### Registry Snapshot — Single Atomic Object

`EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` already deduplicates — later sources overwrite earlier ones. By the time the validator sees the list, duplicates are gone. To detect duplicates, the validator needs pre-deduplication data.

The design introduces a **registry snapshot** — a single immutable object produced by discovery that contains everything the validator needs:

```typescript
interface RegistrySnapshot {
  // Source reference list — all storage instances in priority order.
  // ResolutionReason uses indices into this array (SourceRef) to avoid duplicating WorkflowSource objects.
  readonly sources: readonly WorkflowSource[];
  
  // Every raw workflow file discovered on disk, before any selection.
  // This is the lowest level — every .json file found by findWorkflowJsonFiles().
  // Includes all variant candidates (.v2., .agentic., standard) for each logical ID.
  // Also includes unparseable files (invalid JSON, missing structure) — these are never silently dropped.
  readonly rawFiles: readonly RawWorkflowFile[];
  
  // Per-source variant-selected candidates (after variant precedence, before cross-source dedup)
  readonly candidates: readonly {
    readonly sourceRef: SourceRef;  // index into sources[]
    readonly workflows: readonly Workflow[];
    readonly variantResolutions: ReadonlyMap<string, VariantResolution>;  // workflowId -> how variant was chosen
  }[];
  
  // Resolved winners (after cross-source deduplication — what runtime uses)
  // Each entry includes why it won (source priority, variant precedence, bundled protection)
  // resolvedBy is produced by the same resolution function runtime uses — not reverse-engineered.
  readonly resolved: readonly {
    readonly workflow: Workflow;
    readonly resolvedBy: ResolutionReason;  // references sources[] via SourceRef
  }[];
  
  // Detected duplicate sets (IDs that appeared in multiple sources)
  readonly duplicates: readonly DuplicateIdReport[];
}
```

The `resolvedBy` field makes registry behavior debuggable. When a workflow fails validation, the report shows not just *what* failed, but *why this particular source/variant was selected* — e.g. "selected `.v2.` variant because `v2Tools=true`" or "bundled source won over user source by priority rule." This eliminates guesswork when diagnosing variant/resolution mismatches.

One function produces the snapshot from the storage chain:

```typescript
async function buildRegistrySnapshot(args: {
  readonly rawFiles: readonly RawWorkflowFile[];  // pre-scanned by caller (discriminated: parsed | unparseable)
  readonly storageInstances: readonly IWorkflowStorage[];
}): Promise<RegistrySnapshot>
```

This function:
1. Receives pre-scanned raw files from the caller (see "Raw File Scanning" below)
2. Calls `loadAllWorkflows()` on each storage instance independently (candidates — after variant selection within each source)
3. Calls `resolveWorkflowCandidates(candidates)` — the **same pure function** that runtime uses (see "Shared Resolution Function" below) — producing resolved winners with `resolvedBy` metadata
4. Runs `detectDuplicateIds()` on the candidates
5. Freezes the result

### Shared Resolution Function — Eliminating Drift

**Problem (designed out)**: the previous design had the snapshot builder reverse-engineering `resolvedBy` by comparing per-source candidates to the resolved list. This was an approximation of the resolution logic inside `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` — if resolution rules changed, the approximation would drift.

**Solution**: extract the cross-source resolution logic from `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` into a **pure function**:

#### Type Design: `ResolutionReason` (Philosophy-Aligned)

```typescript
/**
 * Reference to a source by its index in the storage chain.
 * The RegistrySnapshot carries the full source list; this is just a pointer.
 * 
 * Philosophy: "Immutability by default" + avoid duplication.
 * Instead of copying WorkflowSource objects 10+ times, reference by index.
 */
type SourceRef = number;  // index into RegistrySnapshot.sources[]

/**
 * Explains how a variant file was selected when multiple variants existed.
 * Only present when the source had multiple variant files for this workflow ID.
 * 
 * Philosophy: "Exhaustiveness everywhere" — three explicit selection paths.
 */
type VariantResolution =
  | { readonly kind: 'only_variant' }  // only one file existed
  | { 
      readonly kind: 'feature_flag_selected';
      readonly selectedVariant: 'v2' | 'agentic' | 'standard';
      readonly availableVariants: readonly ('v2' | 'agentic' | 'standard')[];
      readonly enabledFlags: { readonly v2Tools: boolean; readonly agenticRoutines: boolean };
    }
  | {
      readonly kind: 'precedence_fallback';
      /**
       * Multiple variants existed, but no feature flags enabled.
       * Precedence rule: .v2. > .agentic. > standard (independent of flags).
       * This is a fallback — the files exist but aren't being used as intended.
       */
      readonly selectedVariant: 'v2' | 'agentic' | 'standard';
      readonly availableVariants: readonly ('v2' | 'agentic' | 'standard')[];
    };

/**
 * Explains why a specific workflow won resolution across sources and variants.
 * 
 * Philosophy: "Make illegal states unrepresentable" + "Single source of truth"
 * - Each variant is exhaustive and carries exactly the needed context
 * - Variant resolution is included when applicable (not tracked separately)
 * - Source references prevent duplication
 * - Produced by a two-pass pure function, not incremental mutation
 */
export type ResolutionReason =
  | { 
      readonly kind: 'unique';
      /**
       * Exactly one source provided this workflow ID.
       * No competition, no shadowing, no ambiguity.
       */
      readonly sourceRef: SourceRef;
      readonly variantResolution?: VariantResolution;
    }
  | { 
      readonly kind: 'source_priority';
      /**
       * Multiple sources provided this workflow ID.
       * Winner selected by source priority (later sources override earlier).
       */
      readonly winnerRef: SourceRef;
      readonly shadowedRefs: readonly SourceRef[];
      readonly variantResolution?: VariantResolution;  // for the winner source
    }
  | { 
      readonly kind: 'bundled_protected';
      /**
       * `wr.*` workflow from bundled source.
       * Non-bundled sources attempted to shadow it but were blocked.
       */
      readonly bundledSourceRef: SourceRef;
      readonly attemptedShadowRefs: readonly SourceRef[];
      readonly variantResolution?: VariantResolution;  // for bundled source
    };

interface ResolvedWorkflow {
  readonly workflow: Workflow;
  readonly resolvedBy: ResolutionReason;
}
```

#### Function Signature and Implementation

```typescript
/**
 * Resolve cross-source workflow competition using priority rules.
 * 
 * Philosophy: "Functional/declarative" — two-pass pure function.
 * Pass 1: Group workflows by ID (collect all sources)
 * Pass 2: Apply resolution rules with complete information
 * 
 * This eliminates incremental mutation bugs (e.g., setting 'unique' on first
 * encounter, then upgrading it when a second source appears).
 */
function resolveWorkflowCandidates(
  candidates: readonly { readonly sourceRef: SourceRef; readonly workflows: readonly Workflow[] }[],
  variantResolutions: ReadonlyMap<string, ReadonlyMap<SourceRef, VariantResolution>>  // workflowId -> sourceRef -> how variant was chosen
): readonly ResolvedWorkflow[]
```

This function contains the entire cross-source deduplication and priority resolution logic that currently lives inside `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` (lines 275-314):
- **Unique**: one source provided the ID (no competition)
- **Source priority**: multiple sources → later sources override earlier ones
- **Bundled protection**: `wr.*` bundled workflows cannot be shadowed by non-bundled sources
- **Variant resolution**: when a source had multiple variant files, the resolution reason explains which was chosen and why

#### Implementation Sketch (Two-Pass)

```typescript
export function resolveWorkflowCandidates(
  candidates: readonly { readonly sourceRef: SourceRef; readonly workflows: readonly Workflow[] }[],
  variantResolutions: ReadonlyMap<string, ReadonlyMap<SourceRef, VariantResolution>>
): readonly { workflow: Workflow; resolvedBy: ResolutionReason }[] {
  
  // Pass 1: Group all workflows by ID
  const grouped = new Map<string, { sourceRef: SourceRef; workflow: Workflow }[]>();
  for (const { sourceRef, workflows } of candidates) {
    for (const workflow of workflows) {
      const id = workflow.definition.id;
      const existing = grouped.get(id) ?? [];
      grouped.set(id, [...existing, { sourceRef, workflow }]);
    }
  }

  // Pass 2: Apply resolution rules per ID with complete information
  const resolved: { workflow: Workflow; resolvedBy: ResolutionReason }[] = [];
  
  for (const [id, sources] of grouped.entries()) {
    if (sources.length === 1) {
      // Unique — only one source
      const { sourceRef, workflow } = sources[0]!;
      const variantResolution = variantResolutions.get(id)?.get(sourceRef);
      resolved.push({ workflow, resolvedBy: { kind: 'unique', sourceRef, variantResolution } });
      continue;
    }

    // Multiple sources — apply priority rules
    const isWr = id.startsWith('wr.');
    const bundledSource = sources.find(s => s.workflow.source.kind === 'bundled');

    if (isWr && bundledSource) {
      // Bundled protection
      const attemptedShadowRefs = sources.filter(s => s.sourceRef !== bundledSource.sourceRef).map(s => s.sourceRef);
      const variantResolution = variantResolutions.get(id)?.get(bundledSource.sourceRef);
      resolved.push({
        workflow: bundledSource.workflow,
        resolvedBy: { kind: 'bundled_protected', bundledSourceRef: bundledSource.sourceRef, attemptedShadowRefs, variantResolution },
      });
      continue;
    }

    // Source priority: last source wins (candidates are ordered by priority)
    const winner = sources[sources.length - 1]!;
    const shadowedRefs = sources.slice(0, -1).map(s => s.sourceRef);
    const variantResolution = variantResolutions.get(id)?.get(winner.sourceRef);
    resolved.push({
      workflow: winner.workflow,
      resolvedBy: { kind: 'source_priority', winnerRef: winner.sourceRef, shadowedRefs, variantResolution },
    });
  }

  return resolved;
}
```

**Philosophy: "Functional/declarative"** — two passes (group, then decide), not incremental mutation. This eliminates the bug where `kind: 'unique'` is set on first encounter, then must be upgraded when a second source appears. With two passes, we know the full picture before making any resolution decision.

#### Runtime Integration

`EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` is refactored to call this function:

```typescript
// Before (inline resolution logic):
async loadAllWorkflows(): Promise<readonly Workflow[]> {
  const allWorkflows: Workflow[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < this.storageInstances.length; i++) { /* inline resolution */ }
  return allWorkflows;
}

// After (shared pure function):
async loadAllWorkflows(): Promise<readonly Workflow[]> {
  const candidates = await this.loadCandidatesPerSource();
  const resolved = resolveWorkflowCandidates(candidates);
  return resolved.map(r => r.workflow);
}
```

The snapshot builder calls the same function:

```typescript
const candidates = /* loaded per-source from storageInstances */;
const resolved = resolveWorkflowCandidates(candidates);  // same function runtime uses
```

**Why this eliminates drift**: there is exactly one implementation of resolution logic. If the rules change (new priority scheme, new protection rules), both runtime and validation see the change immediately. `resolvedBy` is a natural output of the resolution function, not a post-hoc derivation.

**Scope**: this is an internal refactor of `EnhancedMultiSourceWorkflowStorage` — extracting ~40 lines of inline logic into a pure exported function. The `IWorkflowReader` interface does not change. The `loadAllWorkflows()` return type does not change. Runtime behavior is identical. The only new surface is the exported `resolveWorkflowCandidates()` function.

### Shared File Discovery Function — Eliminating Drift

**Problem (designed out)**: the previous design had the raw file scanner reimplementing `FileWorkflowStorage.findJsonFiles()` because it's private. If `findJsonFiles` changed its discovery rules (new skip patterns, new extensions), the scanner wouldn't know.

**Solution**: extract the recursive JSON file discovery logic from `FileWorkflowStorage.findJsonFiles()` into a **shared exported function**:

```typescript
// Shared pure function — used by both FileWorkflowStorage and the raw file scanner
export async function findWorkflowJsonFiles(
  dir: string,
  options?: { readonly maxFileSize?: number }
): Promise<readonly string[]>
```

This function contains the entire file discovery logic that currently lives inside `FileWorkflowStorage.findJsonFiles()` (lines 111-134):
- Recursive directory traversal
- Skip `examples/` directories
- Only include `.json` files
- Respect optional max file size

`FileWorkflowStorage` is refactored to call this function:

```typescript
// Before (private method):
private async findJsonFiles(dir: string): Promise<string[]> {
  /* inline recursive traversal */
}

// After (shared function):
import { findWorkflowJsonFiles } from './workflow-file-discovery.js';
// ...
const allJsonFiles = await findWorkflowJsonFiles(this.baseDirReal, { maxFileSize: this.maxFileSize });
```

The raw file scanner calls the same function:

```typescript
import { findWorkflowJsonFiles } from '../../infrastructure/storage/workflow-file-discovery.js';

async function scanRawWorkflowFiles(
  sourceDirectories: readonly { readonly dirPath: string; readonly source: WorkflowSource }[]
): Promise<readonly RawWorkflowFile[]> {
  for (const { dirPath, source } of sourceDirectories) {
    const files = await findWorkflowJsonFiles(dirPath);  // same function storage uses
    // ... parse each file, determine variantKind, produce RawWorkflowFile entries
  }
}
```

**Why this eliminates drift**: there is exactly one implementation of file discovery. If the skip rules change, both storage and the scanner see the change immediately.

**Scope**: extracting ~25 lines from `FileWorkflowStorage` into a new file `workflow-file-discovery.ts`. The `FileWorkflowStorage` method becomes a one-liner calling the shared function. The `IWorkflowStorage` interface does not change.

### Raw File Scanning

With the shared file discovery function, the raw file scanner is thin — it calls `findWorkflowJsonFiles` for discovery and adds JSON parsing + variant detection on top:

```typescript
type RawWorkflowFile =
  | { readonly kind: 'parsed'; readonly source: WorkflowSource; readonly filePath: string; readonly workflow: Workflow; readonly variantKind: 'v2' | 'agentic' | 'standard' }
  | { readonly kind: 'unparseable'; readonly source: WorkflowSource; readonly filePath: string; readonly error: string };

async function scanRawWorkflowFiles(
  sourceDirectories: readonly { readonly dirPath: string; readonly source: WorkflowSource }[]
): Promise<readonly RawWorkflowFile[]>
```

The `kind` discriminant handles files that don't parse as valid JSON or lack a `definition.id` field. `unparseable` entries still appear in the report (as `schema_failed` in `rawFileResults`) — they are not silently skipped. This avoids a type lie: the scanner does not assert `Workflow` for files it cannot parse.

This function:
1. Calls `findWorkflowJsonFiles(dirPath)` for each source directory — **same discovery logic** as `FileWorkflowStorage`
2. Attempts to parse each discovered file as JSON
3. For successful parses: extracts the `id` field, produces a `parsed` entry (skips if no `id`)
4. For failed parses (invalid JSON, missing structure): produces an `unparseable` entry
5. Determines `variantKind` from the filename: `.v2.` → `'v2'`, `.agentic.` → `'agentic'`, else → `'standard'`
6. Returns all files regardless of feature flags — no filtering

This is variant-agnostic and flag-agnostic. It runs once, not per variant. The Phase 3 script calls it before the variant loop and passes the result into `buildRegistrySnapshot`.

**Why not add a method to `IWorkflowStorage`?** Because raw file scanning is inherently flag-independent (we want ALL files), but `IWorkflowStorage` instances are configured with specific feature flags. Adding `listRawFiles()` to the storage interface would mean every storage implementation (git, remote, plugin) would need to implement it, even though it's only meaningful for file-based storage.

The validator then consumes the snapshot:

```typescript
function validateRegistry(
  snapshot: RegistrySnapshot,
  deps: ValidationPipelineDeps
): RegistryValidationReport
```

**Why the snapshot is better than interface expansion:**
- `IWorkflowReader` and `IWorkflowStorage` interfaces don't change
- Resolution logic is a shared pure function, not duplicated or reverse-engineered
- File discovery logic is a shared pure function, not reimplemented
- The snapshot is a plain data object — easy to test, serialize, log
- Discovery and validation are fully decoupled — the snapshot is the seam between them
- `buildRegistrySnapshot`, `resolveWorkflowCandidates`, `findWorkflowJsonFiles`, and `scanRawWorkflowFiles` can each be tested independently

### Duplicate Detection

Duplicate detection is a pure function over the candidates:

```typescript
function detectDuplicateIds(
  candidates: readonly { readonly source: WorkflowSource; readonly workflows: readonly Workflow[] }[]
): readonly DuplicateIdReport[]
```

`wr.*` duplicate handling rules:
- **Two non-`wr.*` IDs from different sources**: **hard error**. No exceptions.
- **Two non-bundled sources with the same `wr.*` ID**: **hard error**. This is ambiguous and dangerous — no source should be allowed to quietly win.
- **Bundled `wr.*` + non-bundled with same ID**: bundled wins (this is the existing intentional protection). Always reported as a **warning** — never silently tolerated. The warning makes it visible that a non-bundled source attempted to shadow a bundled workflow. This is the only tolerated duplicate, and it exists because bundled workflows are platform-owned and user sources shouldn't be able to override them accidentally.
- Deterministic: the outcome must be the same every time, not dependent on load order or timing.

**Tightening policy**: any shadowing that changes runtime behavior is a hard failure unless it falls into the single exception above (bundled `wr.*` protection). "Warning but still allowed" must be exceptionally rare — only the bundled-wins case qualifies. If future cases arise that seem like they should be warnings, they must be explicitly debated and documented here, not silently added. The default for any new duplicate scenario is: hard error.

### One Atomic Call

A single `validateRegistry(snapshot, deps)` call:
1. **Validates every raw discovered file** through at least schema + structural (Tier 1). This catches invalid files that variant selection would hide. A bad `.v2.` file that loses to the standard variant is still reported as invalid.
2. Checks duplicate detection results from the snapshot (hard-fail on errors)
3. **Runs the full Phase 1 pipeline on each workflow from the resolved set** (the variant winners that runtime would actually use). This is the Tier 2 validation.
4. Collects all results (exhaustive — never stops at first failure)
5. Returns the complete report

Step 1 matters because the mission says "invalid workflows should never be hidden." Hidden-by-variant-precedence is still hidden. If a `.v2.` file is invalid but never selected because the standard variant wins, the CI gate should still report it — because a future feature-flag change could select that variant, and users would hit the error at runtime.

The snapshot was already built atomically — all loads happened in the same `buildRegistrySnapshot` call. No two-method drift.

### Variant-Aware Validation

The caller (Phase 3's script) is responsible for constructing different storage chains per feature-flag variant and calling `buildRegistrySnapshot()` for each. The registry validator itself is variant-agnostic — it validates whatever the snapshot contains.

### Feature-Flag Matrix Ownership

The set of feature-flag combinations that validation must cover is a **closed, versioned list** — not derived dynamically at validation time.

**Current canonical matrix** (from `scripts/workflow-validation-variants.json`):

| Variant | `agenticRoutines` | `v2Tools` |
|---|---|---|
| default | off | off |
| agentic-enabled | on | off |
| v2-tools-enabled | off | on |
| both-enabled | on | on |

**Rules**:
- This matrix is the **single source of truth** for which flag combinations are tested. It lives in `workflow-validation-variants.json` and is version-controlled.
- **Adding a new feature flag** requires updating the matrix. The matrix grows combinatorially — this is intentional. If the matrix becomes impractically large (>8 variants), introduce a flag grouping strategy (e.g. flag profiles) rather than silently dropping combinations.
- **Every variant in the matrix is validated in CI.** No variant can be skipped, deferred, or marked "optional." If a variant is in the matrix, it's tested.
- **Removing a variant** from the matrix requires explicit justification (the flag was removed from the codebase, not just "we don't test that combo anymore").
- The registry validator logs which variants it is testing. If the matrix file and the actual flags in the codebase drift, that drift should be detectable (e.g. a flag exists in code but has no matrix entry).

### Acceptance Criteria

- [ ] `buildRegistrySnapshot()` atomically produces rawFiles, candidates, resolved, and duplicates from the same moment in time
- [ ] Every raw discovered file (including variant losers) is validated through at least schema + structural
- [ ] Invalid variant-loser files are **hard CI failures** — not warnings. Rationale: if a file is discoverable and named as a workflow variant (`.v2.json`, `.agentic.json`), it is intended to be a workflow. A future feature-flag change could promote it to the selected variant. Invalid variant losers are latent bugs, not harmless debris.
- [ ] `validateRegistry(snapshot, deps)` returns a report with `resolvedResults` (full pipeline, per resolved workflow) AND `rawFileResults` (Tier 1, per raw file)
- [ ] Duplicate IDs across sources are hard failures (with both sources reported)
- [ ] `wr.*` bundled + non-bundled: bundled wins, always reported as warning
- [ ] `wr.*` two non-bundled sources: hard error
- [ ] Non-`wr.*` duplicate from any two sources: hard error
- [ ] All workflows validated in a single call (exhaustive)
- [ ] Registry snapshot is a plain data object — no storage interfaces leaked to the validator
- [ ] Each resolved workflow includes `resolvedBy` explaining why that source/variant won
- [ ] `resolvedBy` is produced by `resolveWorkflowCandidates()` — the same function `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` uses. Not reverse-engineered.
- [ ] `ResolutionReason` is a discriminated union with 3 variants: `unique`, `source_priority`, `bundled_protected`
- [ ] `ResolutionReason` uses `SourceRef` (index) instead of duplicating `WorkflowSource` objects
- [ ] `ResolutionReason` includes optional `variantResolution` explaining within-source variant selection
- [ ] `VariantResolution` is a discriminated union with 3 variants: `only_variant`, `feature_flag_selected`, `precedence_fallback`
- [ ] `resolveWorkflowCandidates` is a two-pass pure function (group all IDs, then apply resolution rules) — not incremental mutation
- [ ] `findWorkflowJsonFiles()` is the shared file discovery function used by both `FileWorkflowStorage` and the raw file scanner. Not reimplemented.
- [ ] Duplicate detection is a standalone pure function
- [ ] Duplicates detected BEFORE deduplication (from candidates, not resolved)
- [ ] `start_workflow(workflowId)` resolves the same source and variant that registry validation validated — enforced by: (a) same `resolveWorkflowCandidates()` function, (b) same `findWorkflowJsonFiles()` function, (c) same storage chain composition, (d) same feature flags

---

## Phase 3: Replace CI Script with Registry-Centric Validator

### Goal

Replace `scripts/validate-workflows.sh` with a TypeScript registry-centric validator that runs under all feature-flag variant combinations.

### Problem It Solves

Gaps 3, 10, 14. Plus makes precommit authoritative.

### New File

`scripts/validate-workflows-registry.ts`

### Design

1. Loads `scripts/workflow-validation-variants.json` (4 existing variants: default, agentic, v2, agentic+v2)
2. For each variant:
   - Sets feature flags
   - Builds `EnhancedMultiSourceWorkflowStorage` with appropriate `IFeatureFlagProvider`
   - Calls `buildRegistrySnapshot()` to atomically capture candidates, resolved, and duplicates
   - Calls `validateRegistry(snapshot, deps)` from Phase 2
3. Collects all failures across all variants
4. Prints structured report (per-variant, per-workflow, per-phase)
5. Exits non-zero if any variant has any failure

### Output Format

```
=== Variant: default ===
  coding-task-workflow-agentic  bundled  schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok
  bug-investigation             bundled  schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok
  ...

=== Variant: v2-tools-enabled ===
  coding-task-workflow-agentic  bundled  schema:ok structural:ok v1-compile:ok normalize:FAIL
    normalization_failed: Executable workflow normalization produced an invalid definition: ...
  ...

RESULT: 1 workflow(s) invalid across 4 variants.
```

### Files Changed

- **New**: `scripts/validate-workflows-registry.ts`
- **Edit**: `package.json` -- `validate:workflows` points to new script, `precommit` updated
- **Deprecate**: `scripts/validate-workflows.sh` (keep for reference, mark deprecated)

### Timeout

The validator accepts a per-variant timeout (default: 30s). If a storage source hangs, the variant fails with a timeout error rather than blocking CI indefinitely.

### Machine-Readable Output

The validator must emit structured JSON output in addition to human-readable console output. This is CI infrastructure — it needs to be parseable by other tools, regression-testable, and integrable.

Required: `--json` flag (or `--output-format json`) that emits a JSON report to stdout:

```typescript
interface ValidationJsonReport {
  readonly variants: readonly {
    readonly variant: string;
    readonly featureFlags: Record<string, boolean>;
    readonly resolvedWorkflows: readonly {
      readonly workflowId: string;
      readonly sourceKind: string;
      readonly sourceRef: string;
      readonly resolvedBy: ResolutionReason;
      readonly outcome: ValidationOutcome;  // full pipeline, serialized
    }[];
    readonly rawFiles: readonly {
      readonly filePath: string;
      readonly workflowId: string;
      readonly variantKind: 'v2' | 'agentic' | 'standard';
      readonly isResolvedWinner: boolean;
      readonly tier1Outcome: Tier1Outcome;
    }[];
    readonly duplicates: readonly DuplicateIdReport[];
  }[];
  readonly summary: {
    readonly totalVariants: number;
    readonly totalResolvedWorkflows: number;
    readonly totalResolvedValid: number;
    readonly totalResolvedInvalid: number;
    readonly totalRawFiles: number;
    readonly totalRawFilesTier1Failed: number;
    readonly totalDuplicateErrors: number;
  };
}
```

Per-workflow, per-phase, deterministic failure codes. No string parsing needed by consumers.

### Stable Failure Codes

The stable failure codes span three distinct type systems, corresponding to the three validation levels. Each code belongs to exactly one discriminated union. CI output, tests, and downstream tools key on these codes.

**Pipeline codes** (from `ValidationOutcome.kind` — Phase 1 pipeline, per-workflow):

| Code | Phase | Meaning |
|------|-------|---------|
| `schema_failed` | 1.1 | JSON schema (AJV) violation |
| `structural_failed` | 1.2 | Structural validation error (step rules, loop rules, prompt-source) |
| `v1_compilation_failed` | 1.3 | v1 compilation error (step graph, loop graph on authored form) |
| `normalization_failed` | 1.4 | Executable normalization error (template resolution, promptBlock resolution) |
| `round_trip_failed` | 1.5 | Serialization round-trip failure (JSON stringify > parse > Zod) |
| `v2_compilation_failed` | 1.7 | v2 executable compilation error (step graph on executable form) |
| `startability_failed` | 1.8 | No reachable first step or interpreter error on initial state |

**Registry codes** (from `RegistryValidationReport` — Phase 2, per-registry):

| Code | Meaning |
|------|---------|
| `duplicate_id` | Same workflow ID in multiple sources (hard error) |
| `duplicate_id_warning` | Bundled `wr.*` shadowing non-bundled (warning, not error) |

**Lifecycle codes** (from `LifecycleTestResult.kind` — Phase 6, per-test; not included in Phase 3's JSON output until Phase 6 lands):

| Code | Meaning |
|------|---------|
| `integrity_failure` | Workflow-definition error during lifecycle execution (validator bug per Invariant 1) |
| `completion_failure` | Workflow did not reach terminal state under fixtures |

Listed here for completeness — the stable codes table is a master list across all phases, not just Phase 3's output. The Phase 3 JSON report initially includes only pipeline and registry codes. Lifecycle codes are added when Phase 6 integrates with CI.

These codes must be stable across versions. Adding new codes is fine; renaming or removing existing codes is a breaking change that requires migration. Note: the codes use the exact `kind` values from their respective discriminated unions — they are not uppercased aliases.

### Acceptance Criteria

- [ ] `npm run validate:workflows` runs registry-centric validation under all 4 variants
- [ ] Reports all failures in one run (exhaustive)
- [ ] Exits non-zero on any failure
- [ ] Recursive: catches `workflows/routines/` and subdirectories
- [ ] Feature-flag aware: validates the resolved variant, not every file independently
- [ ] Per-variant timeout prevents CI hangs
- [ ] `npm run precommit` runs the new validator
- [ ] `--json` flag emits structured `ValidationJsonReport` to stdout
- [ ] JSON output includes per-workflow, per-phase outcome with deterministic failure codes

---

## Phase 4: Eliminate Silent Hiding

### Goal

Remove the pattern where invalid workflows are silently filtered from runtime and from validation output.

### Problem It Solves

Gaps 4, 9, 13.

### Architectural Change: Separate Validation from Storage

The current `SchemaValidatingWorkflowStorage` decorator does two things:
1. Validates workflows (legitimate)
2. Silently filters invalid ones from results (hiding)

The fix separates these concerns. Two options exist:

**Option A (target state): Remove filtering entirely, add a validation boundary upstream.** `SchemaValidatingWorkflowStorage` stops filtering. Validation moves upstream into a single explicit boundary. Runtime consumers are designed to handle validation errors gracefully. Invalid workflows are never hidden from anyone.

**Option B (temporary containment): Keep filtering for runtime safety, add structured reporting.** Runtime keeps graceful degradation. But every filter action is reported through structured logging with workflow ID, source, and error. `listWorkflowSummaries()` is fixed to also filter (Gap 9). The CI gate (Phases 2-3) is the hard failure path; runtime remains soft.

Decision for this effort: **Option B, explicitly as temporary containment.**

Option B does not satisfy the mission requirement "invalid workflows should never be hidden." It is a stepping stone. Runtime still filters invalid workflows — it now *reports* them loudly instead of silently, but they remain hidden from the workflow list and discovery results.

The target state is Option A. The path to get there:
1. **This effort (Option B)**: CI gate catches everything; runtime filters but reports.
2. **Future effort**: runtime consumers (`start_workflow`, `list_workflows`, etc.) are changed to surface validation errors as typed failures instead of silently filtering. `SchemaValidatingWorkflowStorage` is demoted to an assertion layer (crash-if-invalid) rather than a filter layer (hide-if-invalid).
3. **Final state**: no component in the system silently hides invalid workflows. The CI gate prevents them from being mergeable; the pinning boundary prevents them from being executable; the runtime surfaces them as explicit errors to the user.

### Fix `renderPendingPrompt` Silent Degradation

`prompt-renderer.ts` currently:
```
const step = getExecutableStepById(args.workflow, args.stepId);
const baseTitle = step?.title ?? args.stepId;
const basePrompt = step?.prompt ?? `Pending step: ${args.stepId}`;
```

Change to:
```
const step = getExecutableStepById(args.workflow, args.stepId);
if (!step) {
  return err({ code: 'RENDER_FAILED', message: `Step '${args.stepId}' not found in executable workflow` });
}
```

If the interpreter says a step is pending but the executable workflow doesn't have it, that is a structural invariant violation, not a "use a fallback" situation.

**Critical: `renderPendingPromptOrDefault` absorbs the error.** The wrapper in `v2-execution-helpers.ts` calls `renderPendingPrompt(...).unwrapOr(fallback)`. If `renderPendingPrompt` returns an error, the `OrDefault` wrapper silently produces a fallback prompt — which is the exact silent-degradation pattern we're fixing. The fix must also change `renderPendingPromptOrDefault`:

- **Option 1 (preferred)**: Delete `renderPendingPromptOrDefault`. Change its callers (`start.ts`, `replay.ts`) to handle the `Result` from `renderPendingPrompt` explicitly — propagating the error as a typed failure. (`continue-rehydrate.ts` already calls `renderPendingPrompt` directly.) This is the "fail-fast" approach.
- **Option 2**: Keep `renderPendingPromptOrDefault` but make its fallback path log a structured warning via the error collector, so the degradation is at least observable.

Decision: **Option 1.** The callers already handle `Result`-based error flows (they use `andThen` chains). A missing step in the executable workflow is a system-level invariant violation, not a user-recoverable condition. The `OrDefault` wrapper was masking bugs.

### Fix `listWorkflowSummaries()` Bypass

In `SchemaValidatingWorkflowStorage` and `SchemaValidatingCompositeWorkflowStorage`, change `listWorkflowSummaries()` to validate through `loadAllWorkflows()` and derive summaries from the validated set, rather than delegating directly to inner storage.

### Acceptance Criteria

- [ ] Invalid workflows are reported loudly (structured log or error channel), not silently filtered
- [ ] `listWorkflowSummaries()` never includes invalid workflows
- [ ] `renderPendingPrompt` fails hard on missing step ID (returns error, not fallback)
- [ ] `renderPendingPromptOrDefault` deleted; all callers handle the `Result` from `renderPendingPrompt` explicitly
- [ ] `getWorkflowById()` for a schema-invalid workflow logs a structured warning before returning `null` (interface change to return typed error is out of scope)

---

## Phase 5: Regression Test Suite

### Goal

Tests that prove every identified gap is closed and stays closed.

### Problem It Solves

Locks down all gaps, prevents regressions.

### New File

`tests/unit/validate-workflow-registry.test.ts`

### Test Cases

#### Discovery and Duplicates

1. Two non-`wr.*` workflows with the same ID in different source directories -- hard failure with both sources reported
2. `wr.*` ID in bundled + non-bundled -- bundled wins, reported as warning (not error)
2b. `wr.*` ID in two non-bundled sources -- hard error (ambiguous, no protection applies)
3. Three workflows with the same ID -- reports all three competing sources
4. Single workflow, no duplicates -- passes

#### Variant Resolution (requires Phase 3 infrastructure)

5. `.v2.` variant invalid, standard variant valid, v2 enabled -- fails (v2 is what runtime selects)
6. `.agentic.` variant invalid, standard valid, agentic enabled -- fails
7. Standard variant invalid, `.v2.` variant valid, v2 enabled -- passes (standard not selected)

#### Normalization

8. Workflow with `promptBlocks` that fail to resolve -- normalization failure reported
9. Workflow with `templateCall` referencing unknown template -- normalization failure
10. Workflow with authoring-only fields that break `ExecutableWorkflowDefinitionSchema.strict()` -- normalization failure

#### Serialization Round-Trip

11. Workflow where normalization produces fields that `JSON.stringify` drops (e.g. `undefined`) and Zod rejects on re-parse -- round_trip_failed

#### Executable Compilation

12. Workflow that normalizes but has unknown `outputContract.contractRef` -- compilation failure
13. Workflow that normalizes but has duplicate step IDs in executable form -- compilation failure
14. Workflow with loop body referencing missing step -- compilation failure

#### Startability

15. Valid workflow -- `interpreter.next({ kind: 'init' })` returns a pending step AND `steps[0].id` resolves in executable form
16. Workflow with all steps having false `runCondition` -- `interpreter.next()` returns `isComplete: true, next: null` with zero completed steps -- startability failure (note: runtime's `start.ts` would NOT catch this because it takes `steps[0]` blindly)
17. Workflow with first step being a loop with invalid condition -- startability failure
17b. Workflow where `steps[0].id` in authored form doesn't exist in executable form -- startability failure (first-step resolution check)

#### Silent Hiding

18. `listWorkflowSummaries()` does not include schema-invalid workflows
19. `renderPendingPrompt` with missing step ID returns error, not fallback prompt
19b. `renderPendingPromptOrDefault` deleted; `start.ts` and `replay.ts` propagate `renderPendingPrompt` errors as typed failures

#### Exhaustive Reporting

20. Two invalid + one valid workflow -- report shows all three, two failures
21. Report includes phase-level discriminated union per workflow

#### Pipeline Consolidation

22. CLI `validate` command uses the same pipeline as registry validator
23. `validate_workflow_json` MCP tool uses the same pipeline as registry validator

#### Registry Snapshot and Raw File Scanning

24. `scanRawWorkflowFiles` finds all `.json` files in source directories regardless of feature flags — `.v2.`, `.agentic.`, and standard files all appear
25. `scanRawWorkflowFiles` correctly determines `variantKind` from filename (`.v2.` → `'v2'`, `.agentic.` → `'agentic'`, else → `'standard'`)
26. `buildRegistrySnapshot` with two sources, variant files across sources → rawFiles contains all files, candidates contain per-source selected variants, resolved contains cross-source winners with `resolvedBy`
27. `buildRegistrySnapshot` with a `.v2.` file that is a variant loser → file appears in rawFiles with `variantKind: 'v2'` but not in resolved
28. Raw file with invalid JSON → `kind: 'unparseable'` in rawFiles, appears in rawFileResults with `schema_failed`, does not block other files

#### Shared Function Integrity

29. `resolveWorkflowCandidates` produces the same resolved list as `EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()` for any given candidate set (the storage method is now a thin wrapper over this function)
30. `resolveWorkflowCandidates` populates `resolvedBy` correctly:
    - `{ kind: 'unique', sourceRef: 0 }` when exactly one source provides the ID
    - `{ kind: 'source_priority', winnerRef: 2, shadowedRefs: [0, 1] }` when multiple sources → later wins
    - `{ kind: 'bundled_protected', bundledSourceRef: 0, attemptedShadowRefs: [1, 2] }` for `wr.*` bundled + non-bundled shadow attempts
30b. `resolveWorkflowCandidates` includes `variantResolution` when applicable:
    - `variantResolution: { kind: 'only_variant' }` when source had one file
    - `variantResolution: { kind: 'feature_flag_selected', selectedVariant: 'v2', availableVariants: ['v2', 'standard'], enabledFlags: { v2Tools: true, ... } }` when flags drove selection
    - `variantResolution: { kind: 'precedence_fallback', selectedVariant: 'v2', availableVariants: ['v2', 'agentic', 'standard'] }` when no flags but multiple variants
31. `resolveWorkflowCandidates` is a two-pass pure function (group by ID, then apply rules) — not incremental mutation
31b. `resolveFirstStep` returns `{ kind: 'no_steps_in_authored', workflowId }` when authored workflow has empty steps array
31c. `resolveFirstStep` returns `{ kind: 'authored_step_missing_in_executable', workflowId, authoredStepId }` when `steps[0].id` doesn't exist in the executable form
31d. `resolveFirstStep` returns `{ kind: 'resolved', step: { authoredStepId, executableStep } }` when coupling is valid

#### File Discovery Function (`findWorkflowJsonFiles`)

32. File extension filtering — given directory with `workflow.json`, `readme.md`, `config.txt` → returns only `['workflow.json']`
33. `examples/` skip rule — given `workflows/main.json`, `workflows/examples/demo.json`, `workflows/examples/nested/test.json` → returns only `['main.json']` (both `examples/` files skipped)
34. Recursive traversal — given `workflows/workflow1.json`, `workflows/routines/routine1.json`, `workflows/routines/experimental/test.json` → returns all 3 files
35. Skip rules don't block siblings — given `workflows/examples/ignored.json`, `workflows/examples-related/important.json` → returns `['examples-related/important.json']` (skip is exact directory name, not prefix-match)

#### Fixture-vs-File Drift Detection

36. Each lifecycle fixture's inline workflow definition, when normalized, matches the corresponding bundled file's definition after normalization — catches fixture drift from real bundled files

### Acceptance Criteria

- [ ] All 41 test cases pass (including 2b, 17b, 19b, 22-23, 24-36, 30b)
- [ ] Tests create minimal fixture workflows (not depending on real files)
- [ ] Tests use fakes for storage, not real filesystem
- [ ] Each test is named by the gap it closes

---

## Phase 6: Lifecycle Execution Harness (Required for God-Tier)

### Goal

Deterministic end-to-end execution testing that starts workflows, feeds fixture data, advances step by step, and drives to terminal completion.

### Problem It Solves

Gap 8. This phase proves **advanceability and completion** — that a workflow can not only start, but run to terminal state without any workflow-definition error.

### Relationship to Phase 1

- **Phase 1 proves startability**: the workflow can be discovered, resolved, normalized, compiled, and the first step is reachable.
- **Phase 6 proves advanceability**: every step in the workflow can be advanced, every loop can iterate and exit, every branch can be taken, and the workflow reaches terminal completion.

Startability without advanceability is a partial guarantee. A workflow could start fine and then fail on step 3 because a loop condition references a context variable that doesn't exist, or an `outputContract.contractRef` is invalid on an interior step, or the interpreter can't resolve the next step after a loop exits. Phase 1 can't catch these — they require driving the full state machine.

### Status

This phase is **required** to meet the god-tier standard. Phases 1-5 are the minimum acceptable correctness gate. Phase 6 is what makes the system actually trustworthy for users.

### Design Principle

Start with 1-2 hardcoded tests, not a general-purpose framework. Abstract at 3+ workflows (YAGNI with discipline).

### Initial Approach

One test per workflow, each test:
1. Provides the workflow definition inline as test data (hermetic — no filesystem)
2. Runs the Phase 1 validation pipeline on the inline definition (must pass)
3. Creates an execution state (simulating `start_workflow`)
4. For each step: provides fixture output/context, calls `interpreter.applyEvent()` + `interpreter.next()`
5. Drives to `isComplete: true`
6. Fails on any workflow-definition error at any point

**Fixture-vs-file gap**: Lifecycle tests validate *workflow definitions*, not *workflow files*. The inline definition is a copy of the real bundled file, but it can drift. Phases 2-3 (CI registry validation) validate the actual files on disk through the full pipeline. The combined coverage is: CI validates the files are correct (Tier 2), lifecycle tests validate that the definition shape can execute (Tier 3). The assumption is: if CI proves the file is valid and lifecycle proves the definition shape can execute, the actual file can execute. This assumption holds as long as the inline fixture definition matches the bundled file. A Phase 5 test (see regression tests) should verify this by asserting that each lifecycle fixture's workflow definition matches the corresponding bundled file's definition after normalization.

### Fixture Data

Per-workflow fixture files in `tests/lifecycle/fixtures/` (JSON):

```typescript
interface WorkflowFixture {
  readonly workflowId: string;
  readonly startInputs?: { workspacePath?: string };
  readonly stepFixtures: Record<string, StepFixture>;
}

interface StepFixture {
  readonly notesMarkdown?: string;
  readonly artifacts?: readonly unknown[];
  readonly context?: Record<string, unknown>;
}
```

### MVP Boundary (Ruthlessly Scoped)

The MVP for Phase 6 is exactly 3 bundled, deterministic workflows with hardcoded fixtures:

1. `test-session-persistence` (3 steps, no loops, no conditions) — simplest possible linear workflow
2. `workflow-diagnose-environment` (simple, short) — validates basic start-to-completion
3. `test-artifact-loop-control` (loop with artifact contract) — validates loop iteration and exit

No more than 3 workflows in the first cut. No general-purpose harness. No fixture generation. No complex multi-branch workflows. Each test is a single test function with inline fixture data.

Expand to complex workflows (bug-investigation, coding-task) only after the 3-workflow pattern is stable and the `LifecycleTestResult` reporting model is proven.

### Two Distinct Test Goals

Lifecycle testing serves two goals that should be separated in both code and naming:

**Execution integrity tests**: no structural/runtime-contract failure at any step. These tests verify that the compiler, interpreter, and prompt renderer never error on the workflow definition during execution. The fixture data is minimal — just enough to advance. The assertion is: "no `DomainError`, no `RENDER_FAILED`, no `interpreter exceeded guard iterations`." This is the execution-contract version of the formal invariant.

**Workflow completion fixtures**: the workflow reaches terminal state under deterministic fixture data. These tests verify that a specific set of fixture inputs drives the workflow from start to `isComplete: true`. The fixture data is complete — it provides the expected output for every step, including loop iteration counts, context variables, and branch conditions. The assertion is: "the workflow completed, all steps were visited in the expected order, terminal state reached."

The distinction matters for failure diagnosis:
- Execution integrity failure = **platform bug** (something the pipeline should have caught — a validator defect)
- Completion fixture failure = **fixture bug or workflow design issue** (the fixture doesn't match the workflow's expectations)

This distinction must be first-class in the harness reporting model:

```typescript
type LifecycleTestResult =
  | { readonly kind: 'integrity_failure'; readonly stepId: string; readonly error: DomainError }
  | { readonly kind: 'completion_failure'; readonly lastStepId: string; readonly reason: 'not_terminal' | 'unexpected_step_order' }
  | { readonly kind: 'success'; readonly stepsVisited: readonly string[] };
```

When a lifecycle test fails, the result type tells you immediately whether to investigate the validator (integrity) or the fixture/workflow (completion).

### Hermeticity Requirements

Lifecycle tests must be fully hermetic — deterministic regardless of host environment, timing, or external state:

1. **No real filesystem I/O.** Workflow loading uses in-memory fakes, not `FileWorkflowStorage`. Fixture workflows are inline test data, not loaded from `workflows/`.
2. **No real pinned store I/O.** The pinned workflow store uses the existing `FakePinnedWorkflowStore`. No disk, no temp directories.
3. **No real MCP transport.** Tests drive the advance core functions directly (e.g. `handleAdvanceOutcome`), not through the MCP handler layer.
4. **No timers or timeouts.** Loop guards use explicit iteration caps from fixture data, not wall-clock timeouts.
5. **No randomness.** Workflow hashes, session IDs, and tokens are deterministic (fixed seeds or fake generators).
6. **Fakes, not mocks.** All boundary dependencies (storage, pinned store, console) use behavioral fakes with the real interface contract. No mock libraries, no `jest.fn()` as implementation stand-ins.
7. **Self-contained fixtures.** Each test carries its own minimal fixture data inline. No shared fixture state across tests. No fixture files that could drift from the code they test.

Hermeticity violations are test bugs, not workflow bugs. If a lifecycle test is flaky, the test is wrong — not the workflow.

### Acceptance Criteria

- [ ] At least 3 workflows driven start-to-completion under deterministic fixtures
- [ ] Execution integrity: no workflow-definition error at any step
- [ ] Completion: workflow reaches terminal state
- [ ] Execution integrity failures reported separately from completion failures
- [ ] Loop execution works (fixture drives iteration + exit)
- [ ] Tests report which step failed and why
- [ ] No general-purpose harness framework until 3+ tests need the same abstraction

---

## Cross-Cutting Concerns

### Two-Layer Defense Model

The implementation creates a two-layer defense:

1. **CI gate** (Phases 2-3): prevents invalid workflow definitions from entering the repository. Validates the full registry under all feature-flag variants at merge time.
2. **Pinning boundary** (already exists): prevents invalid definitions from entering execution. `compileV1WorkflowToPinnedSnapshot` > content-addressed hash > immutable store > `loadPinnedWorkflowRuntime` re-validates on load.

The CI gate prevents invalid workflows from being mergeable.
The pinning boundary prevents invalid workflows from being executable, even if they somehow appear at runtime (file changed after CI, cache stale, etc.).

### `ValidatedWorkflow` as a Runtime Type Gate — Known Incompleteness

The philosophy constraints say "execution consumers accept `ValidatedWorkflow`, not raw `Workflow`." **This plan does NOT deliver that.** This is a known incompleteness against the ideal architecture, not future polish.

No phase changes `start.ts` or any runtime handler to require `ValidatedWorkflow`. The type exists as the output of the validation pipeline (Phase 1) and is consumed by the registry validator (Phase 2), but runtime still consumes raw `Workflow`.

**What this means**: the architecture remains partially vulnerable to drift. A new runtime codepath could be added that consumes a raw `Workflow` without going through the validation pipeline. The type system does not prevent this. Only convention and code review protect against it.

Why deferred despite the risk: requiring `ValidatedWorkflow` at runtime means validation must run synchronously during `start_workflow`, which has performance implications (v1 compilation + v2 compilation + interpreter.next on every start). The CI gate (Phases 2-3) ensures invalid workflows never reach the repo; the pinning boundary ensures invalid workflows never reach execution. The type gate would add compile-time safety but requires rearchitecting the start path.

**This should be the first follow-up after Phase 6 is complete.** It is the difference between "convention-enforced safety" and "compiler-enforced safety."

### First-Step Resolution: Authored vs Executable Discrepancy (Designed Out)

`start.ts` previously took `firstStep = workflow.definition.steps[0]` from the **authored** `Workflow` and used its ID against the **executable** `ExecutableWorkflow` for prompt rendering. If normalization changed step IDs or ordering, this would produce a mismatch.

This is now resolved: the shared `resolveFirstStep()` function (Phase 1b) verifies that `steps[0].id` from the authored form resolves in the executable form. Both `start.ts` and the validation pipeline call this function. If the cross-form check fails, `start.ts` returns a typed error instead of silently proceeding with a mismatched step ID.

### Remaining Runtime Validation Primitive Gaps (Follow-Up)

**Principle: validation should reuse shared pure runtime construction/transition functions wherever possible.**

Start construction is now shared (`resolveFirstStep()`). The remaining runtime paths are not yet shared:

| Runtime path | What validation does | Drift risk | Priority |
|---|---|---|---|
| **Start** (`loadAndPinWorkflow`) | Calls shared `resolveFirstStep()` | **Eliminated** | Done (Phase 1b) |
| **Advance** (`outcome-success.ts`) | Pipeline checks v2 compilation (same `compileExecutable` function) | Low — same function already shared | Low |
| **Replay** (`replay.ts`) | Not simulated | Replay-specific prompt rendering could fail | Low |
| **Rehydrate** (`continue-rehydrate.ts`) | Not simulated | Rehydrate re-loads pinned workflow, could fail on shape | Low |
| **Prompt rendering** (`renderPendingPrompt`) | Not called during validation | Prompt rendering depends on step shape, function expansion | **High** |

The architectural fix for each is the same pattern: **extract the pure core** from the runtime handler, then have both runtime and validation call it. The start construction extraction (Phase 1b) proves the pattern. The remaining extractions are lower risk because:
- Advance already shares `compileExecutable()` and `interpreter.next()` (the pure functions are already extracted)
- Replay and rehydrate are re-entry paths that reuse the same compilation/interpretation logic
- Phase 4 improves runtime behavior (`renderPendingPromptOrDefault` deletion forces callers to handle errors explicitly), but it does **not** move prompt rendering into the validation boundary

**Status**: start construction is delivered in Phase 1b. Remaining extractions are follow-up work. The highest remaining priority is prompt rendering (adding `renderPendingPrompt` to the validation pipeline as a startability sub-check), because until that lands the validation boundary is still incomplete.

### Module-Level Singleton Registries

`workflow-compiler.ts` uses module-level singletons for ref/feature/template registries. The validation pipeline shares these with runtime (same import). This is an implicit coupling that ensures validation and runtime use the same registries. Acknowledge this; do not change it in this effort (scope control). Future: inject registries through the pipeline deps.

### Ad-Hoc Compiler Construction

`outcome-success.ts` line 59 does `new WorkflowCompiler()`. This should eventually receive the compiler as an injected dep, not construct it ad-hoc. For this effort: note it as tech debt, do not change the advance handler (scope control). The validation pipeline itself must receive the compiler as a dep.

### Temporal Validity

Workflows can change between CI validation and runtime execution (files modified, caches expired). This is acceptable because:
- CI gate prevents invalid definitions from being *merged* -- changes after merge require a new merge
- Pinning boundary prevents invalid definitions from being *executed* -- once pinned, the snapshot is immutable and content-addressed
- The gap between "file on disk" and "pinned snapshot" is covered by `start_workflow` which normalizes + pins at start time

### Pinned Snapshot Compatibility Contract

A pinned snapshot is content-addressed and immutable once stored. But runtime re-parses it through `ExecutableWorkflowDefinitionSchema` on every `continue_workflow` (in `loadPinnedWorkflowRuntime`). If the schema evolves (new required fields, tightened constraints), **already-pinned snapshots from older sessions can fail to load** — the user sees `precondition_failed` with no way to recover their session.

This is not a validation problem — the CI gate validates new workflows against the current schema. The problem is **forward compatibility**: can a snapshot pinned under schema version N survive being parsed under schema version N+1?

**Policy (named design decision)**:

1. **`ExecutableWorkflowDefinitionSchema` changes are breaking changes.** Any modification to the schema that would reject a previously-accepted snapshot must be treated as a breaking migration, not a minor fix. This must be documented and accompanied by a migration path.

2. **Additive fields are safe.** Adding new optional fields to the schema does not break existing pinned snapshots (Zod `.strict()` rejects unknown fields, but `loadPinnedWorkflowRuntime` uses `.parse()` on the definition, not the outer snapshot — verify before relying on this).

3. **Tightening constraints is unsafe.** Making a previously-optional field required, or narrowing a string union, will break existing pinned snapshots. This requires a migration strategy (version the snapshot, add a migration function from vN to vN+1).

4. **Phase 5 should include a "stale snapshot" test**: pin a snapshot under the current schema, then assert it still parses under the current schema. This test won't catch future regressions, but it establishes the pattern and documents the contract. A true compatibility test would require versioned fixture snapshots — out of scope for initial delivery but noted as a follow-up.

**Status**: This is a design policy, not a code change. The Phase 1 round-trip test (step 5) partially validates this — it serializes and re-parses in the same schema version. True cross-version compatibility testing is a follow-up concern.

---

## Required Follow-Ups (Before System Is "Complete")

These items are not required for initial merge of Phases 1-6, but they are required before the validation system can be considered complete. Without them, the system has known architectural vulnerabilities.

1. **`ValidatedWorkflow` runtime type gate** — Change `start.ts` and runtime handlers to accept `ValidatedWorkflow` instead of raw `Workflow`. Without this, the type system doesn't prevent bypassing validation. See "`ValidatedWorkflow` as a Runtime Type Gate" in Cross-Cutting Concerns.

2. **Phase 4 Option A** — Remove runtime's silent filtering of invalid workflows. Replace `SchemaValidatingWorkflowStorage` filter behavior with an assertion layer. Without this, the "never hidden" requirement is not fully satisfied. See Phase 4.

3. **Prompt rendering in validation pipeline** — Add `renderPendingPrompt` as a startability sub-check so the validation pipeline proves that the first step can be rendered without error. Currently the pipeline checks compilation and interpreter reachability but not prompt rendering. This is not just observability hardening; it is part of the actual validation boundary. Without it, `Validate at boundaries, trust inside` remains only partially satisfied. See "Remaining Runtime Validation Primitive Gaps" in Cross-Cutting Concerns.

Each of these is a known incompleteness. The system is usable and materially safer without them, but not architecturally complete and not fully philosophy-aligned.

Note: **start construction** was previously a required follow-up. It is now delivered in Phase 1b via the shared `resolveFirstStep()` function.

---

## Definition of Done

### What "valid" means — three workflow populations

The word "all workflows" is ambiguous. There are three distinct populations with different coverage requirements:

| Population | What it includes | Required validation |
|---|---|---|
| **Bundled workflows** (`workflows/` in repo) | The workflow files shipped with WorkRail. These are the ones users see by default. | Full pipeline (Phases 1-2) + lifecycle execution (Phase 6) + CI gate (Phase 3) |
| **Resolved registry** (runtime-discoverable) | All workflows that `start_workflow` could actually load: bundled + plugin + user + custom + git + remote + project, after variant selection and deduplication. | Full pipeline (Phases 1-2) under all feature-flag variants. CI gate for bundled; runtime pinning boundary for others. |
| **All raw discovered files** | Every `.json` file found by `FileWorkflowStorage.findJsonFiles()` across all sources, including variant losers and files that would be shadowed by deduplication. | At least schema + structural validation (Tier 1). Invalid files are **hard CI failures**, not warnings. No file silently escapes basic validation. |

Phase 6 lifecycle tests are required only for bundled workflows (the population we control). External workflows (user/plugin/git/remote) are validated through the pipeline at discovery time but not driven through lifecycle execution — we can't provide fixtures for workflows we don't author.

### Per-workflow "valid" criteria

A workflow is only "valid" when it has passed all of the following:

1. **File/schema validation** — conforms to JSON schema (AJV) and structural rules
2. **v1 compilation** — step graph, loop graph, outputContract refs build correctly on authored form
3. **Normalization** — resolves templates, features, refs, promptBlocks; strips authoring keys; passes Zod `.strict()`
4. **Serialization round-trip** — survives JSON stringify > parse > Zod re-parse (proving pinned snapshot integrity)
5. **v2 executable compilation** — step graph, loop body resolution, condition source derivation on executable form
6. **Startability** — first step exists and resolves in executable form; interpreter produces a pending step from initial state
7. **Prompt renderability** — `renderPendingPrompt` can render the first pending step without error on the validated executable form
8. **Registry resolution** — discoverable, unambiguous, no duplicate ID conflicts across sources, valid under all feature-flag variants
9. **Lifecycle execution** (bundled only) — can be driven start-to-completion with deterministic fixture data, no workflow-definition errors at any step

Items 1-6 are validated per-workflow by the Phase 1 pipeline in the initial delivery.
Item 7 is a required follow-up to make the validation boundary complete.
Item 8 is validated per-registry by the Phase 2 registry validator.
Item 9 is validated per-workflow by the Phase 6 lifecycle harness.

Any runtime workflow-definition failure that would have been caught by any of these checks is a validator bug.

---

## Execution Order and Scope

| Phase | Depends On | New Files | Edited Files | Scope |
|-------|-----------|-----------|-------------|-------|
| 1 | -- | 2 (validation pipeline, first-step-resolution shared function) | 4 (ValidationEngine, validateWorkflowFileUseCase, validateWorkflowJson, start.ts) | Medium-Large (8-phase pipeline, 2 compilation paths, first-step resolution extraction) |
| 2 | 1a | 4 (registry validator, raw file scanner, workflow-file-discovery, workflow-resolution) | 2 (EnhancedMultiSourceWorkflowStorage refactor to use resolveWorkflowCandidates, FileWorkflowStorage refactor to use findWorkflowJsonFiles) | Medium |
| 3 | 2 | 1 | 1 (package.json) | Medium |
| 4 | 1 | 0 | 5 (prompt-renderer, v2-execution-helpers, start, replay, schema-validating-storage) | Medium |
| 5 | 1-4 | 1 | 0 | Medium |
| 6 | 5 | 2+ | 0 | Large |

Phases 1-4 are the core deliverable: they make validation materially more runtime-authoritative, but not fully boundary-complete.
Phase 5 locks it down with regression tests.
Phases 1-5 = minimum acceptable correctness gate. **Not god-tier yet.** Phase 4 Option B still hides invalid workflows at runtime.
Phase 6 = required for god-tier execution proof.
Phase 4 Option A + Phase 6 + Required Follow-Ups = true mission completion. The system is not "complete" until all three land, and it is not fully philosophy-aligned until the runtime type gate and prompt-render boundary are both in place.

---

## Migration / Rollout Strategy

Rollout is sequenced to minimize risk. Each stage proves safety before the next one changes runtime behavior.

**Hard checkpoint policy**: Phase 1a, Phase 1b, and Phase 2 are separate merge targets — not one continuous effort. Each must be merged, tested in CI, and stabilized before the next begins. No "I'll clean it up in the next PR." Each checkpoint delivers standalone value. If the effort pauses at any checkpoint, the system is strictly better than before.

### Stage 1a: Pipeline Skeleton (Phase 1a)

- Pipeline function, `ValidationOutcome` union, `ValidatedWorkflow` type
- Schema + structural + v1 compilation + normalization wired (reuses existing code)
- CLI `validate` and MCP `validate_workflow_json` rewired to use the pipeline
- **This is the first merge.** It consolidates existing scattered validation into one entrypoint.
- Gate: all existing validation tests pass through the new pipeline. No new validation logic yet — just consolidation.

### Stage 1b: Full Pipeline (Phase 1b)

- Round-trip + executable construction + v2 compilation + startability added
- `resolveFirstStep()` extracted into `start-construction.ts`; `start.ts` refactored to call it
- Per-stage unit tests for the new stages + `resolveFirstStep()` unit test
- **One runtime behavior change**: `start.ts` now calls `resolveFirstStep()` which verifies `steps[0].id` exists in the executable form (cross-form check). Previously it only checked that `steps[0]` existed in the authored form. This is strictly additive — the new check catches a class of bug that previously caused silent failures during prompt rendering.
- Gate: all bundled workflows pass the full 8-phase pipeline. All existing start_workflow tests pass with the refactored first-step resolution.

### Stage 2: Registry Validation (Phases 2-3)

- Registry snapshot, duplicate detection, CI script replacement
- `resolveWorkflowCandidates()` extracted from `EnhancedMultiSourceWorkflowStorage` (behavior-preserving refactor)
- `findWorkflowJsonFiles()` extracted from `FileWorkflowStorage` (behavior-preserving refactor)
- `npm run validate:workflows` replaced with the registry-centric validator
- Precommit hook updated
- **Runtime behavior unchanged.** The storage refactors extract existing logic into shared pure functions — `loadAllWorkflows()` calls the extracted functions and returns the same results.
- Gate: all bundled workflows pass the full pipeline under all feature-flag variants before proceeding.

### Stage 3: Tighten Runtime (Phase 4)

- Option B lands: `SchemaValidatingWorkflowStorage` gains structured error reporting
- `renderPendingPromptOrDefault` deleted; callers handle errors explicitly
- `listWorkflowSummaries()` validates before returning
- **Runtime behavior changes are additive** (new error reporting) and **corrective** (prompt renderer fails fast instead of silently degrading, first-step resolution verifies cross-form validity). No **valid** workflows should break. Invalid workflows that were previously masked may now surface as runtime errors — this is intended.
- Gate: all bundled workflows pass validation, all existing tests pass with the new stricter checks.

### Stage 4: Regression Lock (Phase 5)

- Full regression test suite lands
- Every identified gap has a test that proves it stays closed
- Gate: all 37+ test cases pass, CI is green.

### Stage 5: Lifecycle Seeding (Phase 6 MVP)

- Lifecycle tests introduced for exactly 3 seeded bundled workflows (the simplest ones)
- Proves the harness pattern works before scaling
- Gate: all 3 lifecycle tests pass with both execution integrity and completion assertions.

### Stage 6: Lifecycle Expansion (Waves)

Lifecycle coverage expands in two waves, not one big push:

**Wave 1: Execution integrity for all bundled workflows.**
- Every bundled workflow gets a lifecycle test with minimal fixture data
- Assertion: no `DomainError`, no interpreter failure, no prompt render failure at any step
- This is practical earlier because fixtures only need to be "good enough to advance" — not realistic
- Gate: 100% execution integrity coverage for bundled workflows

**Wave 2: Completion fixtures for all bundled workflows.**
- Every bundled workflow gets full per-step fixture data driving it to `isComplete: true`
- This is harder because fixtures must match the workflow's exact expectations (loop counts, context variables, branch conditions)
- Gate: 100% completion fixture coverage for bundled workflows

The bar is not lowered — both waves are required for mission completion. The distinction makes rollout practical: integrity coverage is achievable in days, completion coverage may take weeks for complex workflows.

### Stage 7: Architectural Completion (Required Follow-Ups)

- `ValidatedWorkflow` type gate introduced
- Prompt rendering moved into the validation boundary
- Phase 4 Option A replaces Option B
- Gate: all success metrics met, all Required Follow-Ups landed. System is "complete."

Each stage is independently mergeable. No stage requires the next one to be useful. If the effort stalls at any point, the system is still strictly better than it was before that stage.
