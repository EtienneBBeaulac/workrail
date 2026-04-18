# Implementation Plan: Coordinator Artifact Protocol

**Date:** 2026-04-18  
**Branch:** `feat/coordinator-artifact-protocol`

---

## Problem Statement

The PR review coordinator (`src/coordinators/pr-review.ts`) extracts review severity from completed review sessions by running a keyword scan on free-form step notes. The coordinator ignores the `artifacts[]` field that `GET /api/v2/sessions/:id/nodes/:nodeId` already returns. This makes severity extraction brittle and unmeasurable.

The fix: define a `wr.review_verdict` artifact schema, update the final handoff step to emit it, update `getAgentResult()` to return artifacts alongside notes, and update the coordinator to try the artifact path before the keyword scan.

---

## Acceptance Criteria

1. `npm run build` completes with 0 TypeScript errors
2. `tests/unit/coordinator-pr-review.test.ts` passes (all existing tests + new `readVerdictArtifact` tests)
3. `readVerdictArtifact([{ kind: 'wr.review_verdict', verdict: 'clean', ... }])` returns `{ severity: 'clean', source: 'artifact', ... }`
4. `readVerdictArtifact([])` returns `null`
5. `readVerdictArtifact([{ kind: 'wr.review_verdict', verdict: 'INVALID' }])` returns `null` and logs WARN
6. `CoordinatorDeps.getAgentResult` return type is `Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>`
7. `WorkflowRunSuccess` has optional field `lastStepArtifacts?: readonly unknown[]`
8. `mr-review-workflow.agentic.v2.json` phase-6-final-handoff has `outputContract: { contractRef: 'wr.contracts.review_verdict', required: false }`
9. `isValidContractRef('wr.contracts.review_verdict')` returns `true`
10. `validateArtifactContract([{ kind: 'wr.review_verdict', verdict: 'clean', ... }], { contractRef: 'wr.contracts.review_verdict' })` returns `{ valid: true, artifact: ... }`

---

## Non-Goals

- Do NOT add a `/api/v2/sessions/:id/artifacts` server-side aggregation endpoint
- Do NOT change `required: false` to `required: true` (post-graduation decision)
- Do NOT remove the keyword-scan fallback from `parseFindingsFromNotes`
- Do NOT add a `coordinatorProtocol` field to the workflow JSON (deferred)
- Do NOT add artifacts to `spawn_agent` return value (post-MVP)
- Do NOT make `source` required on `ReviewFindings` (breaking change deferred)

---

## Philosophy Constraints

- **Make illegal states unrepresentable:** `verdict`, `source`, `confidence` use closed enums
- **Validate at boundaries:** Zod `safeParse` in `readVerdictArtifact()`; engine validation via `validateArtifactContract()`
- **Errors are data:** `readVerdictArtifact()` returns `ReviewFindings | null`, not throws
- **Functional/declarative:** `readVerdictArtifact()` is a pure function
- **Prefer fakes over mocks:** New tests use `makeFakeDeps()` pattern

---

## Invariants

1. `required: false` in outputContract -- never block sessions during transition
2. Schema registration (`ARTIFACT_CONTRACT_REFS`) MUST be done before workflow JSON update (compiler validates at load time via `isValidContractRef()`)
3. Keyword-scan fallback MUST remain live in `parseFindingsFromNotes`
4. All call sites of `CoordinatorDeps.getAgentResult` MUST handle `{ recapMarkdown, artifacts }` shape
5. `readVerdictArtifact()` MUST log `[WARN coord:reason=artifact_parse_failed]` when kind matches but safeParse fails
6. Per-node HTTP fetch failures MUST be caught individually (not by outer try/catch)
7. `makeContinueWorkflowTool` AND `makeCompleteStepTool` MUST both pass artifacts to `onComplete`

---

## Selected Approach

**Candidate A:** Three ordered changes, all additive, following existing repo patterns exactly.

**Rationale:** Zero new infrastructure; follows `loop-control.ts` schema pattern; follows `WorkflowRunSuccess.lastStepNotes` conditional spread pattern; follows `makeFakeDeps()` testing pattern; backward compatible via `required: false` + keyword-scan fallback.

**Runner-up:** Tip-node only artifact read. Disqualified by task spec 'CRITICAL: must aggregate artifacts across ALL session nodes'.

---

## Slices

### Slice 1: Schema registration (prerequisite for all other changes)

**Files:**
- `src/v2/durable-core/schemas/artifacts/review-verdict.ts` (NEW)
- `src/v2/durable-core/schemas/artifacts/index.ts` (update)
- `src/v2/durable-core/domain/artifact-contract-validator.ts` (update)

**Work:**
1. Create `review-verdict.ts` following `loop-control.ts` pattern:
   - `REVIEW_VERDICT_CONTRACT_REF = 'wr.contracts.review_verdict' as const`
   - `ReviewVerdictArtifactV1Schema = z.object({ kind: z.literal('wr.review_verdict'), verdict: z.enum(['clean', 'minor', 'blocking']), confidence: z.enum(['high', 'medium', 'low']), findings: z.array(z.object({ severity: z.enum(['critical', 'major', 'minor', 'nit']), summary: z.string().min(1) }).strict()), summary: z.string().min(1) }).strict()`
   - `isReviewVerdictArtifact()` type guard
   - `parseReviewVerdictArtifact()` convenience function
2. Update `index.ts`: export all new symbols, add `'wr.contracts.review_verdict'` to `ARTIFACT_CONTRACT_REFS`
3. Update `artifact-contract-validator.ts`: import new symbols, add `case REVIEW_VERDICT_CONTRACT_REF:` to switch with `validateReviewVerdictContract()` helper

**Done when:** `isValidContractRef('wr.contracts.review_verdict')` returns `true`; `validateArtifactContract([{ kind: 'wr.review_verdict', ... }], { contractRef: 'wr.contracts.review_verdict' })` returns `{ valid: true, artifact: ... }`.

---

### Slice 2: Fix onComplete callback signature

**Files:**
- `src/daemon/workflow-runner.ts`

**Work:**
1. Change `onComplete` closure definition (line 2096) from `(notes: string | undefined): void` to `(notes: string | undefined, artifacts?: readonly unknown[]): void`
2. Add `let lastStepArtifacts: readonly unknown[] | undefined;` near `let lastStepNotes`
3. Update `onComplete` body to set `lastStepArtifacts = artifacts`
4. Add `lastStepArtifacts?: readonly unknown[]` to `WorkflowRunSuccess` interface
5. Update `makeCompleteStepTool` call to `onComplete(notes)` -> `onComplete(notes, params.artifacts as readonly unknown[] | undefined)` (line 1249)
6. Update `makeContinueWorkflowTool` call to `onComplete(params.notesMarkdown)` -> `onComplete(params.notesMarkdown, params.artifacts as readonly unknown[] | undefined)` (line 1046)
7. Update the final `return` in `runWorkflow()` (line 2622) to spread `lastStepArtifacts` conditionally

**Done when:** `WorkflowRunSuccess` has `lastStepArtifacts` field; both tool factory call sites pass artifacts; `npm run build` passes.

---

### Slice 3: Update getAgentResult to return artifacts

**Files:**
- `src/cli-worktrain.ts`

**Work:**
1. Change `getAgentResult: async (sessionHandle: string): Promise<string | null>` -> `Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>`
2. In the implementation body:
   - After reading `runs[0]`, read `runs[0].nodes` as `Array<{ nodeId: string; [key: string]: unknown }>` (with null check)
   - Walk all nodes, fetch each node detail with individual `try/catch`:
     ```
     for (const node of nodes) {
       try {
         const nodeRes = await fetch(nodeUrl + '/' + node.nodeId)
         // collect artifacts from nodeData['artifacts'] 
       } catch { /* log WARN, continue */ }
     }
     ```
   - Return `{ recapMarkdown: recap, artifacts: collectedArtifacts }` (or `{ recapMarkdown: null, artifacts: [] }` on failure)
3. Early-return failures must also return `{ recapMarkdown: null, artifacts: [] }` instead of `null`

**Done when:** Return type is `Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>`; TypeScript compile-time errors at call sites force updates.

---

### Slice 4: Update coordinator to use artifact path

**Files:**
- `src/coordinators/pr-review.ts`

**Work:**
1. Import `ReviewVerdictArtifactV1Schema` from artifacts schema
2. Update `CoordinatorDeps.getAgentResult` return type to match new shape
3. Add `source?: 'artifact' | 'keyword_scan'` to `ReviewFindings` interface
4. Add `readVerdictArtifact(artifacts: readonly unknown[]): ReviewFindings | null` pure function:
   - Walk artifacts array
   - For each, check `(raw as any).kind === 'wr.review_verdict'`
   - If kind matches, call `ReviewVerdictArtifactV1Schema.safeParse(raw)`
   - On success: return `{ severity: v.verdict, findingSummaries: v.findings.map(f => f.summary), raw: JSON.stringify(v), source: 'artifact' }`
   - On failure: log `[WARN coord:reason=artifact_parse_failed]`, continue to next artifact
   - If no valid artifact found and artifacts.length > 0: log `[INFO coord:source=keyword_scan reason=no_valid_artifact artifactCount=N]`
   - Return `null`
5. Update both call sites in `runPrReviewCoordinator()`:
   - `const { recapMarkdown: notes, artifacts } = await deps.getAgentResult(handle);`
   - `const findingsResult = readVerdictArtifact(artifacts) ? ok(readVerdictArtifact(artifacts)!) : parseFindingsFromNotes(notes);`
   - Log `[INFO coord:source=artifact]` or `[INFO coord:source=keyword_scan]`
6. Add divergence check (O2): if artifact verdict and keyword-scan severity disagree, log WARN
7. Update traceability JSON block to include `source` field

**Done when:** Coordinator tries artifact path first; keyword-scan fallback works; logging emits; `npm run build` passes.

---

### Slice 5: Update mr-review workflow

**Files:**
- `workflows/mr-review-workflow.agentic.v2.json`

**Work:**
1. In `phase-6-final-handoff` step, add `outputContract: { "contractRef": "wr.contracts.review_verdict", "required": false }`
2. Append to the step `prompt` field the artifact emission instruction:
   ```
   \n\nAfter completing your notes, emit a structured verdict via complete_step artifacts[] parameter. Use exactly this schema:\n{ "kind": "wr.review_verdict", "verdict": "clean|minor|blocking", "confidence": "high|medium|low", "findings": [{ "severity": "critical|major|minor|nit", "summary": "one-line description" }], "summary": "one-line overall summary" }\nFor a clean review with no findings, use findings: [].
   ```

**Done when:** Workflow JSON validates via `npm run build`; `isValidContractRef('wr.contracts.review_verdict')` returns `true` (prerequisite: Slice 1 must be done first).

---

### Slice 6: Tests

**Files:**
- `tests/unit/coordinator-pr-review.test.ts`

**Work:**
1. Update `makeFakeDeps()` to return `{ recapMarkdown: string | null; artifacts: readonly unknown[] }` from `getAgentResult` (change return type from `string | null`)
2. Update `ReviewFindings` literal objects in `buildFixGoal` tests to add `source: 'artifact'` or `source: 'keyword_scan'` (or leave as optional -- `source?` means no update needed)
3. Add new `describe('readVerdictArtifact')` block:
   - `it('returns ReviewFindings with source artifact for valid artifact')`
   - `it('returns null for invalid schema (wrong verdict enum)')`
   - `it('returns null for empty artifacts array')`
   - `it('returns null for artifact with different kind')`
   - `it('returns first valid artifact when multiple present')`
4. Import `readVerdictArtifact` from `pr-review.js`

**Done when:** All existing tests pass; 5 new `readVerdictArtifact` tests pass.

---

## Test Design

**Unit tests (pure function):**
- `readVerdictArtifact` with valid `wr.review_verdict` artifact -> returns `ReviewFindings` with `severity` mapped from `verdict`, `source: 'artifact'`
- `readVerdictArtifact` with invalid schema (wrong enum) -> returns `null`
- `readVerdictArtifact` with empty array -> returns `null`
- `readVerdictArtifact` with artifact of different `kind` -> returns `null` (no false positives)
- `readVerdictArtifact` with valid + invalid artifacts -> returns valid one (first match wins)

**Integration tests (fake deps):**
- Existing `runPrReviewCoordinator` tests must pass with updated `getAgentResult` return type
- The fake `getAgentResult` returns `{ recapMarkdown: 'APPROVE ...', artifacts: [] }` by default

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Missing `makeContinueWorkflowTool` onComplete update | Low | Silent -- artifacts not forwarded from continue_workflow path | Manual verification; code comment at both call sites |
| Per-node HTTP fetch error aborting aggregation | Low | Graceful fallback to keyword scan | Per-node try/catch (Slice 3 R2) |
| LLM emits extra fields in artifact (`.strict()` reject) | Medium | Zod fail -> WARN log -> keyword scan fallback | Acceptable during `required: false` transition |
| `runs[0].nodes` undefined or empty | Low | Empty artifact array -> keyword scan fallback | Null check in Slice 3 |

---

## PR Packaging Strategy

Single PR: `feat/coordinator-artifact-protocol`

All 6 slices in one PR. Changes are tightly coupled (schema + validator + coordinator must be consistent). Breaking the PR into multiple would require interface stubs that add noise.

**PR description structure:**
1. Summary: what was done and why
2. Change 1 (schema), Change 2 (onComplete), Change 3 (coordinator + workflow)
3. Test plan: `npm run build`, `npx vitest run tests/unit/coordinator-pr-review.test.ts`

---

## Philosophy Alignment

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (schema) | Make illegal states unrepresentable | Satisfied -- closed enums, kind literal |
| 1 (schema) | Validate at boundaries | Satisfied -- Zod strict schema |
| 2 (onComplete) | Immutability by default | Satisfied -- `readonly unknown[]` |
| 3 (getAgentResult) | Errors are data | Satisfied -- returns `{ recapMarkdown: null, artifacts: [] }` not null |
| 4 (coordinator) | Functional/declarative | Satisfied -- `readVerdictArtifact()` is pure |
| 4 (coordinator) | Make illegal states unrepresentable | Tension -- `source?` optional; accepted tradeoff |
| 6 (tests) | Prefer fakes over mocks | Satisfied -- `makeFakeDeps()` pattern |

---

## planConfidenceBand: High

- unresolvedUnknownCount: 0
- followUpTickets: Y1 (make source required post-graduation), Y2 (remove keyword scan post-graduation), spawn_agent artifacts gap (post-MVP)
