# Implementation Plan: Coordinator Delivery

## Problem Statement
The full autonomous pipeline produces zero repository output. Three sub-failures: (1) no branch isolation for coding sessions, (2) no delivery (commit + PR), (3) hollow merge outcome. Tracked in `docs/design/full-pipeline-delivery-design.md`.

## Acceptance Criteria
1. After a FULL or IMPLEMENT pipeline run, a real feature branch exists on the remote
2. A real PR is open on GitHub pointing at that branch (opened by coordinator scripts, not the agent)
3. On a clean review verdict, `gh pr merge --squash --auto` fires and the PR merges
4. On a missing `wr.coding_handoff` artifact, the pipeline escalates with a clear reason (no silent 5-minute timeout)
5. Existing trigger-dispatched sessions (autoCommit: true) are unaffected
6. `npx tsc --noEmit` clean; `npx vitest run` 0 failures

## Non-goals
- Worktree cleanup in coordinator delivery path (separate follow-up)
- Crash-recovery idempotency for delivery
- autoOpenPR flag plumbing (coordinator always opens PR when delivery runs)
- Any changes to `runDeliveryPipeline()` or `delivery-pipeline.ts`

## Philosophy-Driven Constraints
- **Errors are data:** `runCoordinatorDelivery()` returns `Result<void, string>` -- callers escalate on Err
- **Coordinator owns delivery:** no agent Bash calls, deterministic TypeScript scripts only
- **Validate at boundaries:** `parseHandoffArtifact(recapMarkdown)` is the boundary parse; `runDelivery()` trusts the result
- **Zero LLM turns for routing:** all delivery logic is pure TypeScript / script calls
- **No daemon coupling:** `runDeliveryPipeline()` must NOT be called from coordinator

## Invariants
1. `branchStrategy: 'worktree'` forwarded ONLY on coding session `spawnSession()` calls
2. `CodingHandoffArtifactV1.branchName` used for `pollForPR()` -- if absent, escalate immediately
3. `HandoffArtifact` from `parseHandoffArtifact(recapMarkdown)` -- not from `CodingHandoffArtifactV1`
4. `deps.mergePR()` called BEFORE returning `{ kind: 'merged' }` in `implement-shared.ts`
5. `runDelivery()` from `delivery-action.ts` is the only git/gh call -- no direct `execFn` in coordinator-delivery.ts

## Selected Approach
7 changes across 6 files + 1 new file. See design doc for rationale. Runner-up (Candidate C phase abstraction) rejected as YAGNI.

## Vertical Slices

### S1: `CoordinatorDeps.spawnSession` interface + implementation
**Files:** `src/coordinators/pr-review.ts:147-154`, `src/trigger/coordinator-deps.ts:237-244`
Add `branchStrategy?: 'worktree' | 'none'` as 8th optional param. Forward to `WorkflowTrigger` in impl.
**Done when:** tsc clean, existing tests pass.

### S2: New `src/coordinators/coordinator-delivery.ts`
Two pure functions:
- `extractPrNumberFromUrl(prUrl: string): number | null` -- parses `/pull/(\d+)` from URL
- `runCoordinatorDelivery(deps, recapMarkdown: string | null, branchName: string, workspacePath: string): Promise<Result<void, string>>` -- calls `parseHandoffArtifact(recapMarkdown)`, on err returns `err(reason)`, on ok calls `runDelivery(artifact, ..., execFn)`
**Done when:** tsc clean, unit tests pass for both functions.

### S3: `implement.ts` -- branchName fix + delivery + branchStrategy
- Line 264: replace wrong branchPattern with `codingArtifact?.branchName` -- if absent, return escalated
- After `getAgentResult()` + before `pollForPR()`: call `runCoordinatorDelivery()`; on Err return escalated
- Coding `spawnSession()` call: add `branchStrategy: 'worktree'` as 8th arg
**Done when:** tsc clean, adaptive-implement tests pass.

### S4: `full-pipeline.ts` -- same 3 fixes + stale comment
Same pattern as S3. Also fix header comment: "35 minute" → "60 minute" (discovery timeout).
**Done when:** tsc clean.

### S5: `implement-shared.ts:132` -- deps.mergePR on clean verdict
Call `extractPrNumberFromUrl(prUrl)` then `deps.mergePR(prNum, opts.workspace)` before `return { kind: 'merged', prUrl }`. On null prNum: log warn + skip (PR sits open).
**Done when:** tsc clean.

### S6: Tests
- `coordinator-delivery.test.ts`: unit tests for `extractPrNumberFromUrl` (valid URL, null cases, edge cases) and `runCoordinatorDelivery` (ok path with mock runDelivery, null recapMarkdown path, runDelivery error path)
- `adaptive-implement.test.ts`: verify `spawnSession` is called with `branchStrategy: 'worktree'` for coding sessions
- `adaptive-full-pipeline.test.ts` (if exists): same check
**Done when:** all new tests pass, suite green.

## Test Design
- `extractPrNumberFromUrl`: pure function, no mocks needed. Test: `https://github.com/owner/repo/pull/123` → 123; `/pull/abc` → null; empty string → null.
- `runCoordinatorDelivery`: fake `parseHandoffArtifact` + fake `runDelivery` (spy on delivery-action.ts). Test: ok path calls runDelivery; null recapMarkdown returns Err; runDelivery failure propagates as Err.
- `spawnSession` with branchStrategy: check `vi.fn()` call args include `branchStrategy: 'worktree'` for coding session, NOT for other sessions.

## Risk Register
| Risk | Likelihood | Mitigation |
|---|---|---|
| recapMarkdown null | Medium | runCoordinatorDelivery returns Err → escalation |
| branchName absent in artifact | Low | Explicit escalation before pollForPR |
| mergePR prNum null | Low | Log warn + skip merge |
| spawnSession test fake breakage | None | All fakes use vi.fn(), safe |

## PR Packaging
SinglePR. All 7 slices are tightly coupled to the same behavioral change.

## Philosophy Alignment Per Slice
| Slice | Principle | Status |
|---|---|---|
| S1: interface | Make illegal states unrepresentable | Satisfied: branchStrategy constrained to 'worktree'|'none'|undefined |
| S2: coordinator-delivery.ts | Errors are data | Satisfied: Result<void,string> return |
| S2: coordinator-delivery.ts | Functional core, imperative shell | Satisfied: extractPrNumberFromUrl pure, runCoordinatorDelivery is shell |
| S3/S4: implement + full-pipeline | Coordinator owns delivery | Satisfied: no agent delivery |
| S5: implement-shared | Zero LLM turns for routing | Satisfied: mergePR is deterministic script |
| S6: system-prompt | Agents must not perform delivery | Tension: adding commit instruction could violate backlog #8. Intentional: the system prompt instruction is a short-term complement, not the permanent architecture. |

## Estimates
- Estimated PR count: 1
- Unresolved unknown count: 0
- Plan confidence band: High
