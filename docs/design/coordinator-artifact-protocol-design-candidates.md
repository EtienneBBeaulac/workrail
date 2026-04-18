# Design Candidates: Coordinator Artifact Protocol

**Status:** Candidate analysis complete  
**Date:** 2026-04-18  
**Task:** Implement wr.review_verdict schema, fix onComplete callback, update mr-review workflow to emit it, update coordinator to read artifacts before keyword-scanning

---

## Problem Understanding

### Core Tensions

**T1: Breaking interface vs. backward compatibility**
`CoordinatorDeps.getAgentResult` returns `Promise<string | null>` today. Changing it to `Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>` is a compile-time breaking change. All call sites (2 in coordinator, 2 in test fakes, 1 real implementation) must change simultaneously. TypeScript catches this at build, so risk is low -- but the change must be complete.

**T2: N+1 HTTP calls vs. tip-node-only simplicity**
ALL-node aggregation requires walking `runs[0].nodes` and fetching each node's detail individually. For a 6-phase workflow, that's 6 HTTP calls to localhost per session. The simple approach (tip node only) would miss a verdict artifact from any non-final step.

**T3: `required: false` vs. engine enforcement**
`outputContract` with `required: false` means the engine won't block if the artifact is absent. This is the correct transition strategy but means the coordinator must maintain two code paths (artifact + keyword-scan fallback) until the graduation criterion (10+ consecutive sessions with 0 fallback warnings) is met.

**T4: Schema strictness vs. forward compatibility**
`.strict()` rejects unknown fields (forward-incompatible). `.strip()` strips them silently (forward-compatible). The task spec says `.strict()`, which matches the `loop-control.ts` precedent. The design doc recommends `.strip()` for forward-compat. **Task spec wins** -- use `.strict()` to be consistent with existing schema patterns.

### Likely Seam

`CoordinatorDeps.getAgentResult` is the real boundary. It is already the I/O abstraction layer where the coordinator interacts with sessions. Changing the return type here forces all consumers to acknowledge the new shape without touching coordinator routing logic.

### What Makes This Hard

1. **Three separate `onComplete` sites:** `makeCompleteStepTool` (line 1249), `makeContinueWorkflowTool` (line 1046), and the closure definition (line 2096). TypeScript will catch signature mismatches on the closure but not at the two call sites if the closure's new parameter is optional.
2. **Exhaustiveness in the switch:** `artifact-contract-validator.ts` switch currently handles only `LOOP_CONTROL_CONTRACT_REF`. Adding `'wr.contracts.review_verdict'` to `ARTIFACT_CONTRACT_REFS` without adding a switch case causes `validateArtifactContract()` to hit the default `UNKNOWN_CONTRACT_REF` error for any step declaring this contract.
3. **`source?` field on ReviewFindings:** Adding `source` as required breaks 4 existing test literals. Making it optional (`source?`) is a minor type weakness but preserves backward compat.

---

## Philosophy Constraints

From CLAUDE.md:
- **Make illegal states unrepresentable:** `verdict: 'clean'|'minor'|'blocking'` not `string`. `source: 'artifact'|'keyword_scan'` not `string`.
- **Validate at boundaries:** Zod parse at coordinator read time + engine validation at advance time.
- **Errors are data:** `readVerdictArtifact()` returns `ReviewFindings | null`, not throws.
- **Functional/declarative:** `readVerdictArtifact()` is a pure function, composable with `parseFindingsFromNotes()`.
- **Prefer fakes over mocks:** The `makeFakeDeps()` pattern in tests is the established style.

**Conflict:** `required: false` during transition temporarily violates 'make illegal states unrepresentable' at the coordinator level. Accepted per design doc -- the fallback is explicit and time-boxed.

---

## Impact Surface

Files that must change:
- `src/v2/durable-core/schemas/artifacts/review-verdict.ts` (new)
- `src/v2/durable-core/schemas/artifacts/index.ts` (ARTIFACT_CONTRACT_REFS)
- `src/v2/durable-core/domain/artifact-contract-validator.ts` (switch case)
- `src/daemon/workflow-runner.ts` (onComplete signature, WorkflowRunSuccess, final return)
- `src/cli-worktrain.ts` (getAgentResult implementation + return type)
- `src/coordinators/pr-review.ts` (CoordinatorDeps, ReviewFindings, readVerdictArtifact, call sites)
- `workflows/mr-review-workflow.agentic.v2.json` (phase-6 outputContract + prompt)
- `tests/unit/coordinator-pr-review.test.ts` (new tests + updated fakes)

Must remain consistent:
- `ConsoleNodeDetail.artifacts` -- no change needed, already returns artifacts
- `projectArtifactsV2()` -- no change needed, already projects artifacts
- `delivery-action.ts` -- reads `lastStepNotes`, not artifacts; no change needed
- `makeSpawnAgentTool()` -- returns `{ notes: string }` only; `lastStepArtifacts` gap acknowledged, post-MVP

---

## Candidates

### Candidate A: Exact task spec implementation (RECOMMENDED)

**Summary:** Implement all three changes exactly as specified: fix `onComplete` to forward `params.artifacts`, add `wr.review_verdict` schema with `.strict()`, update `getAgentResult` to aggregate ALL-node artifacts, add `readVerdictArtifact()` pure function with keyword-scan fallback.

**Tensions resolved:**
- T1: TypeScript compile-time catch ensures completeness
- T3: `required: false` + keyword-scan fallback avoids session blocking

**Tensions accepted:**
- T2: N+1 calls (accepted -- localhost, negligible latency)
- T4: `.strict()` over `.strip()` (follows existing precedent)

**Boundary:** `CoordinatorDeps.getAgentResult` return type change. Best-fit because it is already the established abstraction boundary for coordinator-to-session I/O. All consumers must acknowledge the change at this single point.

**Failure mode:** Missing the `makeContinueWorkflowTool` `onComplete` call site (line 1046) when updating `makeCompleteStepTool` (line 1249). Both tools call `onComplete` but are in separate functions. TypeScript will not catch this if `artifacts?` is optional in the signature -- the closure will be called with `undefined` for `artifacts` from `continue_workflow`, and `lastStepArtifacts` will be silently empty.

**Repo-pattern relationship:** Follows `loop-control.ts` schema pattern exactly. Follows `WorkflowRunSuccess.lastStepNotes` conditional spread pattern. Follows `makeFakeDeps()` fake deps testing pattern. No new patterns introduced.

**Gains:**
- Coordinator reads typed data for sessions that emit the artifact
- Additive: all existing sessions continue to work via fallback
- Zero new infrastructure: 7 file changes + 1 new file
- Artifact visible in console (`hasArtifacts: true` on phase-6 node)
- Observability: `source: 'artifact'|'keyword_scan'` + logging enables emission rate tracking

**Losses:**
- N+1 HTTP calls per session for artifact aggregation
- Two coordinator code paths until graduation

**Scope:** Best-fit. Minimal delta, highest backward compatibility, clear graduation path.

**Philosophy:** Honors validate-at-boundaries, functional/declarative, prefer-fakes, exhaustiveness (closed enum `source`). Minor tension: `source?` optional field vs. type-safety-first. Temporary conflict with 'make illegal states unrepresentable' (accepted).

---

### Candidate B: Tip-node only (simpler, misses design intent)

**Summary:** Only read tip node's artifacts -- matching the existing `preferredTipNodeId` pattern in `getAgentResult` today. Avoids N+1 calls.

**Tensions resolved:**
- T2: 1 HTTP call vs. N+1

**Tensions accepted:**
- Violates task spec 'CRITICAL: must aggregate artifacts across ALL session nodes'
- If a verdict artifact is on step N-1 and the workflow gains a post-synthesis confirmation step N, coordinator silently gets zero artifacts

**Failure mode:** Silent data loss when artifact is on a non-final node. This is the ORANGE-1 constraint from the design doc.

**Scope:** Too narrow -- explicitly contradicts task requirement.

**Why rejected:** The task spec uses 'CRITICAL' emphasis for ALL-node aggregation. Disqualified.

---

## Comparison and Recommendation

**Recommendation: Candidate A.** No contest -- Candidate B is disqualified by the task spec.

| Criterion | A | B |
|-----------|---|---|
| ALL-node aggregation (task spec) | Correct | WRONG |
| N+1 calls | Accepted | Avoided |
| Backward compat | Full | Same |
| Schema precedent | Follows exactly | N/A |
| Philosophy fit | Best | N/A |

---

## Self-Critique

**Strongest counter-argument:** N+1 calls add latency. For a 6-step session, that's 6 additional HTTP calls. Acceptable on localhost (~50-100ms) but could be optimized with a `/api/v2/sessions/:id/artifacts` aggregation endpoint (Candidate C from the design doc). Evidence required: a second coordinator that needs this, or performance data showing N+1 calls are a problem.

**Narrower option that almost works:** Tip-node only. Loses for the explicit task-spec reason.

**Broader option:** Add `/api/v2/sessions/:id/artifacts` server-side endpoint. Right long-term direction, premature now.

**Assumption that would invalidate:** If `runs[0].nodes` in the session detail response returns objects without `nodeId` fields. Confirmed from `ConsoleDagNode` type that `nodeId: string` is always present.

---

## Open Questions for the Main Agent

1. Should `source?` be optional or required on `ReviewFindings`? Optional breaks fewer existing tests but weakens the type. The 4 existing `ReviewFindings` literals in tests would need `source` added if required.
2. Should `readVerdictArtifact()` log a divergence warning when both artifact severity and keyword-scan severity are available but disagree? The design doc recommends this (ORANGE finding). Adds ~10 LOC but improves observability.
