# Implementation Plan: queue-config separate file (fix/queue-config-separate-file)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## 1. Problem Statement

WorkRail MCP server validates `~/.workrail/config.json` as a flat key-value map with string values only. The WorkTrain queue config is a nested object, which broke MCP validation and caused the entire `config.json` to be silently ignored. The fix moves queue config to a separate file `~/.workrail/queue-config.json`.

## 2. Acceptance Criteria

- `loadQueueConfig()` reads from `~/.workrail/queue-config.json` by default
- `WORKRAIL_CONFIG_PATH` constant value ends with `queue-config.json`
- WHY comment block is present above `loadQueueConfig()` explaining the separation
- JSDoc for `loadQueueConfig()` says `queue-config.json` not `config.json`
- `npm run build` exits 0
- `npx vitest run` exits 0 with no regressions

## 3. Non-Goals

- Do NOT touch `src/mcp/`
- Do NOT rename the `WORKRAIL_CONFIG_PATH` constant
- Do NOT change `loadQueueConfig()` logic, return types, or validation
- Do NOT add new tests (no path-mocking tests existed before)
- Do NOT touch any caller (`polling-scheduler.ts`, `cli-worktrain.ts`)

## 4. Philosophy-Driven Constraints

- Document 'why', not 'what' -- WHY comment is required
- Targeted fix, not a refactor
- YAGNI -- change only what is needed

## 5. Invariants

- I1: `loadQueueConfig()` function signature is unchanged
- I2: All validation logic inside `loadQueueConfig()` is unchanged
- I3: Return type `Result<GitHubQueueConfig | null, string>` is unchanged
- I4: ENOENT on the config file returns `ok(null)` (no change needed, already implemented)

## 6. Selected Approach

Candidate A: change `WORKRAIL_CONFIG_PATH` constant value from `config.json` to `queue-config.json`. Add WHY comment block. Update JSDoc.

## 7. Vertical Slices

### Slice 1: Change config path constant and add WHY comment

**File**: `src/trigger/github-queue-config.ts`

Changes:
1. Line 110: change `WORKRAIL_CONFIG_PATH` value from `path.join(os.homedir(), '.workrail', 'config.json')` to `path.join(os.homedir(), '.workrail', 'queue-config.json')`
2. Add WHY comment block above `loadQueueConfig()` as specified in task description
3. Update JSDoc `@param configPath` description from `config.json` to `queue-config.json`
4. Update file-level JSDoc (line 3) from `config.json` to `queue-config.json`

**AC**: `WORKRAIL_CONFIG_PATH` ends with `queue-config.json`. WHY comment present. Build clean.

## 8. Test Design

No new tests needed. No existing tests mock the config file path for `loadQueueConfig`. The function's injectable `configPath` parameter is already available for future tests. Verification: `npx vitest run` with no regressions.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Future developer reverts path | Low | Medium | WHY comment |
| Tests break | Very Low | Low | Run `npx vitest run` to verify |

## 10. PR Packaging

Single PR. Branch: `fix/queue-config-separate-file`. One commit.

## 11. Philosophy Alignment

- document-why -> satisfied (WHY comment)
- architectural-fixes-over-patches -> satisfied (separate config files)
- YAGNI -> satisfied (minimal change)
- make-illegal-states-unrepresentable -> satisfied (by construction)

---
`unresolvedUnknownCount`: 0
`planConfidenceBand`: High
`estimatedPRCount`: 1

---
---

# Implementation Plan: GitHub Issue Queue Poll Trigger (#4)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## 1. Problem Statement

WorkTrain runs as a daemon but has no mechanism to automatically look at the GitHub issue queue, pick the highest-priority actionable item, and dispatch a new session. Every session start requires manual invocation. This plan implements feature #4: a queue poll trigger that fetches open GitHub issues on a configurable interval, applies maturity inference and idempotency checks, selects a candidate, and dispatches a WorkTrain session.

---

## 2. Acceptance Criteria

1. `npm run build` produces no TypeScript errors.
2. `npx vitest run tests/unit/github-queue-poller.test.ts` passes all tests.
3. `npx vitest run` passes with no regressions.
4. A `github_queue_poll` trigger in triggers.yml correctly assembles a `GitHubQueuePollingSource` at load time.
5. Unknown provider still produces `unknown_provider` error (no regression in trigger-store).
6. On each poll cycle: issues fetched, maturity inferred, top candidate dispatched, JSONL entry written.
7. Issues with `worktrain:in-progress` label are excluded (H3 exclusion).
8. Issues matching an active session file are skipped (idempotency).
9. When total active sessions >= `maxConcurrentSelf`, entire cycle is skipped.
10. `type: 'label' | 'mention' | 'query'` throws `not_implemented` at dispatch time.
11. GitHub API error causes cycle skip with log, no crash.
12. Bot identity (`worktrain-etienneb`) set after worktree creation when `trigger.botIdentity` is present.

---

## 3. Non-Goals

- No GitHub write-back (labels, comments, status updates).
- No multi-phase pipeline routing (that's #3's job).
- No grooming or maturity promotion.
- No `type: 'label' | 'mention' | 'query'` implementation.
- No auto-close, auto-label, auto-merge.
- No `src/mcp/` changes.
- No 4th maturity heuristic (scope lock).
- No LLM calls in maturity inference.

---

## 4. Philosophy-Driven Constraints

- All public functions return `Result<T, E>` -- no throws at boundaries.
- All interfaces use `readonly` fields.
- `sessionsDir` parameter injectable for testing.
- `FetchFn` injectable in adapter.
- Idempotency catch block MUST return `'active'`, never `'clear'`.
- Exactly 3 heuristics in `inferMaturity()` -- mark with `// SCOPE LOCK` comment.
- `not_implemented` is a typed error value, not a thrown exception.

---

## 5. Invariants

1. **Conservative idempotency**: Any error during session file scan (ENOENT, parse error, missing field) folds to `'active'`. Never dispatch on uncertainty.
2. **Concurrency cap ordering**: Total active sessions check BEFORE per-issue evaluation. If count >= `maxConcurrentSelf`, skip entire cycle.
3. **Exactly 3 heuristics**: H1 (spec URL), H2 (acceptance criteria), H3 (active/skip). H3 is an exclusion, not a maturity level.
4. **API error = skip cycle**: On any GitHub API error (network, 4xx, 5xx), log warning and return. No retry within tick.
5. **Rate limit**: If `X-RateLimit-Remaining < 100`, skip cycle and log warning.
6. **`not_implemented` at runtime**: Non-assignee queue types are rejected at dispatch time, not parse time.

---

## 6. Selected Approach

**Candidate A: Pitch-as-Spec**

New files:
- `src/trigger/github-queue-config.ts` -- `GitHubQueueConfig` type + `loadQueueConfig()`
- `src/trigger/adapters/github-queue-poller.ts` -- adapter with fetch, candidate selection, maturity inference, idempotency, JSONL logging
- `tests/unit/github-queue-poller.test.ts` -- unit tests

Modified files:
- `src/trigger/types.ts` -- add `GitHubQueuePollingSource`, `TaskCandidate`, new `PollingSource` arm
- `src/trigger/trigger-store.ts` -- add `github_queue_poll` to `SUPPORTED_PROVIDERS`, separate assembly branch (no events required)
- `src/trigger/polling-scheduler.ts` -- add `case 'github_queue_poll':` + `doPollGitHubQueue()` method
- `src/daemon/workflow-runner.ts` -- add optional `botIdentity` field to `WorkflowTrigger`, set after worktree creation

**Runner-up**: Candidate B (skip bot identity) -- rejected because bot identity is non-deterministic and violates pitch pre-implementation checklist.

---

## 7. Vertical Slices

### Slice 1: Type definitions
**Files**: `src/trigger/types.ts`, `src/trigger/github-queue-config.ts`
**Done when**: TypeScript compiles cleanly with new interfaces; `GitHubQueuePollingSource`, `TaskCandidate`, `GitHubQueueConfig` are exported and importable.

### Slice 2: trigger-store.ts extension
**Files**: `src/trigger/trigger-store.ts`
**Done when**: `github_queue_poll` is in `SUPPORTED_PROVIDERS`; a `github_queue_poll` trigger with `source: { repo, token, pollIntervalSeconds }` assembles correctly; missing `repo` or `token` returns `missing_field`; existing providers unaffected.

### Slice 3: Queue poller adapter
**Files**: `src/trigger/adapters/github-queue-poller.ts`
**Done when**: `pollGitHubQueueIssues()` fetches issues with assignee filter, returns `Result<GitHubQueueIssue[], ...>`, handles API errors, checks rate limit, injects `fetchFn`.

### Slice 4: Maturity inference + idempotency
**Files**: `src/trigger/adapters/github-queue-poller.ts` (continued)
**Done when**: `inferMaturity()` correctly classifies issues per H1/H2 (3 heuristics, scope-locked); H3 exclusion applied before scoring; `checkIdempotency()` returns `'active'` for any parse error; `sessionsDir` injectable.

### Slice 5: Scheduling integration
**Files**: `src/trigger/polling-scheduler.ts`
**Done when**: `case 'github_queue_poll':` added to `doPoll()` switch; `doPollGitHubQueue()` implements full cycle (config load, concurrency cap, fetch, selection, dispatch, JSONL log); stdout log format matches pitch spec.

### Slice 6: Bot identity
**Files**: `src/daemon/workflow-runner.ts`
**Done when**: `WorkflowTrigger.botIdentity?: { name: string; email: string }` field added; after worktree creation, if `trigger.botIdentity` is present, two `git config` commands run; failure logs WARNING but does not abort session.

### Slice 7: Tests
**Files**: `tests/unit/github-queue-poller.test.ts`
**Done when**: All tests in spec pass (see Section 9).

---

## 8. Work Packages

Not applicable -- slices are the right granularity for this task.

---

## 9. Test Design

File: `tests/unit/github-queue-poller.test.ts`

Tests required per pitch:
1. **Fetches issues matching assignee filter** -- mock fetch returns 3 issues, all returned
2. **Returns `not_implemented` for non-assignee queue types** -- config.type = 'label' -> `not_implemented` error
3. **Skips cycle on GitHub API error** -- mock fetch throws -> no dispatch, no crash
4. **Idempotency: skips issue with matching active session file** -- temp session file with matching issueNumber -> issue skipped with reason=active_session
5. **Maturity inference H1** -- body with spec URL -> `'ready'`
6. **Maturity inference H2** -- body with `- [ ] ` items -> `'specced'`
7. **Maturity inference default** -- plain body -> `'idea'`
8. **H3 exclusion** -- issue with `worktrain:in-progress` label -> excluded before scoring
9. **Concurrency cap** -- active sessions >= maxConcurrentSelf -> cycle skipped
10. **JSONL entries written** -- `task_selected` and `task_skipped` entries in temp file
11. **Rate limit skip** -- X-RateLimit-Remaining = 50 -> ok([]), log warning

Testing infrastructure:
- `sessionsDir`: temp directory per test (injectable)
- `fetchFn`: injectable mock (same `makeFetch()` helper pattern as `github-poller.test.ts`)
- JSONL log: temp file per test (injectable `logFile` path)

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| events bypass regresses existing providers | Low | High | Separate else-if branch; isPollingProvider unchanged |
| Idempotency returns 'clear' on error | Low | Critical | Explicit outer try/catch returning 'active' |
| workflow-runner.ts bot identity causes build error | Low | Medium | Minimal change; optional field |
| TypeScript union exhaustiveness missed | Low | Medium | Compiler error at build -- caught immediately |
| JSONL file write fails | Low | Low | Catch and log warning; don't abort |

---

## 11. PR Packaging Strategy

**Single PR**: `feat/github-queue-poll` branch. All slices in one commit (or logical sequence of commits). PR title: `feat(trigger): GitHub issue queue poll trigger with maturity inference and idempotency`.

---

## 12. Philosophy Alignment per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (Types) | Immutability by default | Satisfied -- all readonly |
| 1 (Types) | Make illegal states unrepresentable | Satisfied -- discriminated union |
| 2 (trigger-store) | Validate at boundaries | Satisfied -- all fields validated at load time |
| 3 (Adapter) | Errors are data | Satisfied -- Result<T, E> |
| 3 (Adapter) | DI for boundaries | Satisfied -- fetchFn injectable |
| 4 (Idempotency) | Determinism over cleverness | Satisfied -- file scan, no LLM |
| 4 (Idempotency) | Errors are data | Satisfied -- error folds to 'active' |
| 5 (Scheduler) | Exhaustiveness everywhere | Satisfied -- switch default type-checked |
| 5 (Scheduler) | Architectural fixes over patches | Satisfied -- new method, not PolledEventStore reuse |
| 6 (Bot identity) | Determinism over cleverness | Satisfied -- git config, not LLM |
| 6 (Bot identity) | Architectural fixes over patches | Satisfied -- WorkflowTrigger field, not context hint |
| 7 (Tests) | Prefer fakes over mocks | Satisfied -- injectable fetchFn, real temp files |
| All | YAGNI with discipline | Satisfied -- exactly 3 heuristics; no speculative abstraction |

---
---

# Implementation Plan: queue poll tasks route to FULL/IMPLEMENT not REVIEW_ONLY (fix/queue-routes-to-full-not-review)

*Generated: 2026-04-19 | Workflow: coding-task-workflow-agentic*

---

## 1. Problem Statement

When the GitHub issue queue poller dispatches a task via `dispatchAdaptivePipeline`, `opts.taskCandidate` is set but `opts.triggerProvider` is not. A buggy conditional at `adaptive-pipeline.ts:288-290` infers `triggerProvider = 'github_prs_poll'` from `taskCandidate !== undefined`. This causes `routeTask()` Rule 2 to fire, routing queue tasks to `REVIEW_ONLY`. Verified in production: issue #393 was dispatched from the queue, routed to REVIEW_ONLY, and the coordinator reviewed 5 unrelated dep-bump PRs.

---

## 2. Acceptance Criteria

1. Issue queue task with no PR number in title routes to FULL or IMPLEMENT (not REVIEW_ONLY).
2. `github_prs_poll` trigger with PR number in goal still routes to REVIEW_ONLY.
3. Goal with explicit PR number still routes to REVIEW_ONLY.
4. `npm run build` exits 0.
5. `npx vitest run src/coordinators/` passes all tests.
6. `npx vitest run` exits 0 with no regressions.

---

## 3. Non-Goals

- Do NOT touch `src/mcp/`.
- Do NOT refactor surrounding code in `adaptive-pipeline.ts`.
- Do NOT change `routeTask()` in `route-task.ts`.
- Do NOT change any callers (`trigger-router.ts`, `polling-scheduler.ts`).
- Do NOT add type-level enforcement (discriminated union split of AdaptivePipelineOpts).

---

## 4. Philosophy-Driven Constraints

- Architectural fixes over patches: remove the wrong inference entirely.
- YAGNI: change only lines 288-290 and the JSDoc. No more.
- Document 'why': fix JSDoc on `taskCandidate` field + add WHY comment at fix site.
- Determinism: same opts (taskCandidate set, no triggerProvider) must always produce FULL routing.

---

## 5. Invariants

- I1: `routeTask()` is the only place routing decisions are made (enforced by existing design).
- I2: `opts.triggerProvider` is the authoritative source of provider identity.
- I3: `taskCandidate` presence does NOT imply any particular triggerProvider.
- I4: `github_prs_poll` trigger behavior is unchanged - it passes `triggerProvider` directly.

---

## 6. Selected Approach

**Candidate A (one-line fix + JSDoc correction)**

Change:
```typescript
// BEFORE (wrong):
const triggerProvider = opts.taskCandidate !== undefined
  ? 'github_prs_poll'
  : opts.triggerProvider;

// AFTER (correct):
// taskCandidate comes from github_queue_poll, not github_prs_poll.
// github_prs_poll triggers pass triggerProvider directly in opts.
const triggerProvider = opts.triggerProvider;
```

Also fix JSDoc on `taskCandidate` field (line 113): remove "When present, the trigger provider is 'github_prs_poll'".

**Runner-up**: Candidate B (type-level split) -- rejected per explicit user constraint: 'do not refactor surrounding code.'

---

## 7. Vertical Slices

### Slice 1: Code fix + JSDoc correction

**File**: `src/coordinators/adaptive-pipeline.ts`

Changes:
1. Lines 288-290: replace 3-line conditional with `const triggerProvider = opts.triggerProvider;` + WHY comment.
2. Line 113 (JSDoc on `taskCandidate`): fix incorrect statement about `github_prs_poll`.

**Done when**: Code compiles. `triggerProvider` derivation is a single expression. JSDoc no longer says `github_prs_poll`.

### Slice 2: Test coverage

**File**: `tests/unit/` - new test file or addition to existing adaptive pipeline test.

A test that calls `runAdaptivePipeline` (or verifies routing via the opts construction path) with `taskCandidate` set and no `triggerProvider`, verifying the resulting mode is FULL (not REVIEW_ONLY).

**Done when**: Test passes. Covers all three acceptance criteria routing cases (queue task -> FULL, prs_poll -> REVIEW_ONLY, explicit PR number -> REVIEW_ONLY).

---

## 8. Test Design

**Option A**: Add to `tests/unit/route-task.test.ts` - add a new describe block verifying that when `triggerProvider` is undefined, no-PR-number goal routes to FULL. (This is already tested implicitly but not with a `taskCandidate` context.)

**Option B**: New test file `tests/unit/adaptive-pipeline-routing.test.ts` - test `runAdaptivePipeline` directly with a minimal fake deps, verifying opts with `taskCandidate` set and no `triggerProvider` routes to FULL.

**Preferred**: Option B. Tests the fix at the actual seam (triggerProvider derivation in `runAdaptivePipeline`), not just `routeTask()` in isolation.

Test cases to add:
1. `taskCandidate` set, no `triggerProvider`, no pitch, no PR in goal -> mode === 'FULL'
2. `triggerProvider: 'github_prs_poll'`, no taskCandidate, no PR in goal -> mode === 'REVIEW_ONLY'
3. No taskCandidate, no triggerProvider, goal contains 'PR #123' -> mode === 'REVIEW_ONLY'

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Future developer re-introduces taskCandidate inference | Low | Medium | WHY comment at fix site + corrected JSDoc |
| PR poll path broken | None | N/A | PR poller passes triggerProvider directly, unaffected |
| Build regression | Very Low | Low | npm run build |
| Test regression | Very Low | Low | npx vitest run |

---

## 10. PR Packaging Strategy

**Single PR**. Branch: `fix/queue-routes-to-full-not-review`. One commit.
Title: `fix(coordinator): queue poll tasks route to FULL/IMPLEMENT not REVIEW_ONLY`

---

## 11. Philosophy Alignment

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (Code fix) | Architectural fixes over patches | Satisfied -- wrong inference removed entirely |
| 1 (Code fix) | Determinism over cleverness | Satisfied -- same opts always produce same routing |
| 1 (Code fix) | Document 'why' | Satisfied -- JSDoc corrected, WHY comment added |
| 1 (Code fix) | YAGNI | Satisfied -- minimal change, no new abstractions |
| 2 (Tests) | Prefer fakes over mocks | Satisfied -- injectable deps as plain objects |
| All | Immutability | Satisfied -- opts is readonly throughout |

---
`unresolvedUnknownCount`: 0
`planConfidenceBand`: High
`estimatedPRCount`: 1
`followUpTickets`: [type-level enforcement: split AdaptivePipelineOpts into QueueDispatchOpts/TriggerDispatchOpts discriminated union]

---
---

# Implementation Plan: Workflow Validation Regression Test

*Generated: 2026-04-23 | Workflow: coding-task-workflow-agentic*

---

## 1. Problem Statement

No test documents that unknown top-level fields in workflow JSON files are rejected by `validate:registry`. The invariant is correct in production (Ajv enforces `additionalProperties: false`), but invisible. A future refactor could remove the enforcement without any test catching it.

## 2. Acceptance Criteria

- `tests/unit/validate-workflow-registry.test.ts` contains a test that passes a `ParsedRawWorkflowFile` with an unknown top-level field through `validateRegistry` using real `validateWorkflowSchema`
- Test asserts: `report.isValid === false`, `report.tier1FailedRawFiles === 1`, `report.rawFileResults[0].tier1Outcome.kind === 'schema_failed'`
- Test includes a comment explaining it uses real `validateWorkflowSchema` to verify the Tier 1 enforcement path
- `strict: false` removed from Ajv constructor in `src/application/validation.ts`
- `npx tsc --noEmit` passes
- `npx vitest run tests/unit/validate-workflow-registry.test.ts` passes with the new test included

## 3. Non-Goals

- Do NOT add schema validation to any new code path
- Do NOT change `spec/workflow.schema.json`
- Do NOT add a custom Ajv plugin, format, or keyword handler
- Do NOT change `additionalProperties` settings anywhere in the schema
- Do NOT address deployment sequencing or binary/schema versioning
- Do NOT add tests for any other validation invariants

## 4. Philosophy-Driven Constraints

- Prefer fakes over mocks: use real `validateWorkflowSchema` (already the default in `fakePipelineDeps()`)
- Document why not what: test must include explanatory comment
- YAGNI: exactly two files, nothing more

## 5. Invariants

- I1: `validateRegistry` must call `deps.schemaValidate` for each raw file via `validateRawFileTier1`
- I2: `additionalProperties: false` in `spec/workflow.schema.json` must cause `schemaValidate` to return `err()`
- I3: The Ajv constructor must not carry settings that imply intentional relaxation of validation without documented reason

## 6. Selected Approach

Direct `fakeSnapshot` injection with real `validateWorkflowSchema`. Construct a `ParsedRawWorkflowFile` with an extra field, inject into `fakeSnapshot({ rawFiles: [...] })`, call `validateRegistry` with default `fakePipelineDeps()`, assert `schema_failed`.

Runner-up: none (all candidates converge).

## 7. Vertical Slices

### Slice 1: Add regression test

**File**: `tests/unit/validate-workflow-registry.test.ts`

Add a new describe block "Schema Enforcement (Tier 1 Regression)" after the existing section 12 (File Discovery). Test case:
- Construct definition with `unknownFieldForTesting: true` as `unknown as WorkflowDefinition`
- Wrap in `ParsedRawWorkflowFile` with `kind: 'parsed'`, `filePath: 'test.json'`, `relativeFilePath: 'test.json'`, `variantKind: 'standard'`
- `fakeSnapshot({ rawFiles: [rawFile] })` + `fakePipelineDeps()` (no overrides -- real validateWorkflowSchema)
- Assert `report.isValid === false`, `report.tier1FailedRawFiles === 1`, `report.rawFileResults[0]!.tier1Outcome.kind === 'schema_failed'`
- Comment: "Uses real validateWorkflowSchema (not a mock) to verify the Tier 1 enforcement path calls schema validation. This test ensures additionalProperties: false in workflow.schema.json is enforced at the raw-file validation boundary. If this test fails, the schema enforcement layer has been broken."

**Done when**: Test passes.

### Slice 2: Remove misleading Ajv option

**File**: `src/application/validation.ts`

Change `new Ajv({ allErrors: true, strict: false })` to `new Ajv({ allErrors: true })`.

**Done when**: `npx tsc --noEmit` passes, `npx vitest run` passes.

## 8. Test Design

See Slice 1. No new test file -- add to existing `validate-workflow-registry.test.ts`.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Ajv strict removal causes schema compile error | Very Low | Low | Empirically verified: tsc clean before changes |
| Unknown field stripped before Ajv | None | N/A | createWorkflow does not serialize/deserialize |

## 10. PR Packaging Strategy

Single PR. Branch: `fix/etienneb/workflow-validation-regression-test`. One commit.
Commit: `test(validation): add regression test for unknown workflow field rejection`

## 11. Philosophy Alignment

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (Test) | Prefer fakes over mocks | Satisfied -- real validateWorkflowSchema |
| 1 (Test) | Document why not what | Satisfied -- explanatory comment |
| 1 (Test) | Errors are data | Satisfied -- Result type used throughout |
| 2 (Ajv) | YAGNI with discipline | Satisfied -- 1-line removal, no new abstractions |
| All | Architectural fixes over patches | Satisfied -- documents correct invariant, not a patch |

---
`unresolvedUnknownCount`: 0
`planConfidenceBand`: High
`estimatedPRCount`: 1
`followUpTickets`: []

---
---

# Implementation Plan: list_workflows Validation Warnings

*Generated: 2026-04-23 | Workflow: coding-task-workflow-agentic*

---

## 1. Problem Statement

When a non-bundled workflow file fails JSON schema validation, `SchemaValidatingWorkflowStorage` and `SchemaValidatingCompositeWorkflowStorage` silently discard the workflow (logging to stderr only). Users calling `list_workflows` see no signal: their workflow is simply absent with no explanation. This turns a trivial typo fix into a multi-minute debugging session.

## 2. Acceptance Criteria

1. `list_workflows` response includes `validationWarnings` array when any non-bundled workflow fails JSON schema validation.
2. Each warning entry has `workflowId: string`, `sourceKind: string`, `errors: string[]`.
3. Bundled workflow failures (unexpected) are NOT included in `validationWarnings` -- they log to stderr as before.
4. Valid workflows still appear in `workflows[]` unchanged.
5. `IWorkflowStorage` interface is unchanged.
6. `validationWarnings` is absent (not `[]`) when all workflows pass validation.
7. Call-scoped: no instance-level state, no state leak between calls.
8. `ctx.workflowService` singleton fallback path (no workspace signal) returns no `validationWarnings` (field absent).
9. All three `handleV2ListWorkflows` payload assembly sites include `validationWarnings`.
10. `npm run build` exits 0.
11. `npx vitest run` exits 0 with no regressions.
12. Unit tests for `loadAllWorkflowsWithWarnings()` on both classes.
13. Handler integration test verifying `validationWarnings` appears in response.

## 3. Non-Goals

- Do NOT change `IWorkflowStorage` interface.
- Do NOT surface bundled workflow failures in `validationWarnings`.
- Do NOT add a `validate_workflow` MCP tool.
- Do NOT change `inspect_workflow` NOT_FOUND behavior.
- Do NOT add `validationWarnings` to any response other than `list_workflows`.

## 4. Philosophy-Driven Constraints

- **Errors are data:** `loadAllWorkflowsWithWarnings()` returns `{ workflows, warnings }` -- not thrown, not a side effect.
- **Immutability by default:** `readonly ValidationWarning[]` in all return types.
- **Explicit domain types:** `ValidationWarning` struct (`workflowId`, `sourceKind`, `errors[]`), not flat strings.
- **Functional/declarative over imperative:** Paired return method, not callback injection.
- **YAGNI with discipline:** Add only what is needed -- `IWorkflowStorage` stays untouched.
- **Type safety as first line of defense:** `HasValidationWarnings` named interface for compile-time safety.
- **Validate at boundaries, trust inside:** Bundled exclusion at storage method level.

## 5. Invariants

- I1: `IWorkflowStorage` interface signature is unchanged.
- I2: Existing `loadAllWorkflows()` behavior is unchanged -- valid workflows still filter identically.
- I3: `validationWarnings` absent (not present with empty array) when no failures.
- I4: `source.kind !== 'bundled'` guard in `loadAllWorkflowsWithWarnings()` prevents bundled failures from appearing.
- I5: `reportValidationFailure()` (stderr logging) still called for every filtered workflow -- no monitoring regression.
- I6: Call-scoped: method creates a fresh `warnings` array per call; no instance state.

## 6. Selected Approach + Rationale

**Candidate A: Paired return method with `HasValidationWarnings` interface**

Add `loadAllWorkflowsWithWarnings()` to both `SchemaValidatingWorkflowStorage` and `SchemaValidatingCompositeWorkflowStorage`, returning `{ workflows: readonly Workflow[]; warnings: readonly ValidationWarning[] }`. Export `HasValidationWarnings` TypeScript interface. In `handleV2ListWorkflows`, type-narrow to `HasValidationWarnings` and call the new method; thread `validationWarnings` into all 3 payload sites.

**Runner-up:** Candidate B (optional callback) -- rejected because imperative callbacks conflict with the repo's functional style.

**Architecture rationale:** Resolves interface stability (IWorkflowStorage untouched), call-scoped safety (no instance state), and signal completeness (bundled excluded at the boundary). Follows the `managedStoreError` side-channel precedent.

## 7. Vertical Slices

### Slice 1: Storage layer -- `ValidationWarning` type + `HasValidationWarnings` interface + `loadAllWorkflowsWithWarnings()` method

**File:** `src/infrastructure/storage/schema-validating-workflow-storage.ts`

Changes:
1. Export `ValidationWarning` interface: `{ readonly workflowId: string; readonly sourceKind: string; readonly errors: string[] }`
2. Export `HasValidationWarnings` interface: `{ loadAllWorkflowsWithWarnings(): Promise<{ workflows: readonly Workflow[]; warnings: readonly ValidationWarning[] }> }`
3. Add `loadAllWorkflowsWithWarnings()` to `SchemaValidatingWorkflowStorage` -- same loop as `loadAllWorkflows()` but collects `ValidationWarning` entries for non-bundled failures.
4. Add `loadAllWorkflowsWithWarnings()` to `SchemaValidatingCompositeWorkflowStorage` -- same.
5. Both methods still call `reportValidationFailure()` (invariant I5).

**Done when:** Build clean. Method exists on both classes, returns correct type, still calls `reportValidationFailure`.

### Slice 2: Output schema -- `V2ValidationWarningSchema` + optional `validationWarnings` field

**File:** `src/mcp/output-schemas.ts`

Changes:
1. Add `export const V2ValidationWarningSchema = z.object({ workflowId: z.string().min(1), sourceKind: z.string().min(1), errors: z.array(z.string().min(1)).min(1) })`
2. Add `validationWarnings: z.array(V2ValidationWarningSchema).optional().describe(...)` to `V2WorkflowListOutputSchema`.

**Done when:** Build clean. New schema type exported.

### Slice 3: Handler -- type-narrow + call new method + thread to all 3 payload sites

**File:** `src/mcp/handlers/v2-workflow.ts`

Changes:
1. Import `HasValidationWarnings`, `ValidationWarning` from storage module.
2. Replace `withTimeout(workflowReader.loadAllWorkflows(), ...)` with: type-narrow to `HasValidationWarnings`; if available call `loadAllWorkflowsWithWarnings()` (wrapped in same `withTimeout`); extract `allWorkflows` and `validationWarnings` (absent if no failures); else fall through to `loadAllWorkflows()` with `validationWarnings = undefined`.
3. Add `...(validationWarnings ? { validationWarnings } : {})` to all 3 payload assembly sites.
4. Update `_nextStep` hint: when `validationWarnings` is non-empty (and no `tagSummaryEntry`), include a hint telling the agent to fix errors and retry `list_workflows`.

**Done when:** Build clean. All 3 payload sites include `validationWarnings` spread. Handler integration test passes.

### Slice 4: Tests

**Files:**
- `tests/unit/schema-validating-composite-workflow-storage.test.ts` (extend existing)
- `tests/unit/mcp/v2-workflow-source-catalog-output.test.ts` (extend or new file for handler test)

Tests required:
1. `loadAllWorkflowsWithWarnings()` returns warning entry for non-bundled workflow with bad schema.
2. `loadAllWorkflowsWithWarnings()` does NOT include bundled workflow failures.
3. `loadAllWorkflowsWithWarnings()` returns empty `warnings` array (not absent) when all pass -- `validationWarnings` field absent in handler response.
4. Handler integration test: create temp dir with one invalid workflow JSON, call `handleV2ListWorkflows`, verify `validationWarnings` present with correct structure.

**Done when:** All new tests pass. `npx vitest run` exits 0.

## 8. Test Design

Storage unit tests (extend `schema-validating-composite-workflow-storage.test.ts`):
- Use `InMemoryWorkflowStorage` with a workflow definition that will fail schema validation (add unknown top-level field or remove required field like `steps`).
- Call `loadAllWorkflowsWithWarnings()` on `SchemaValidatingCompositeWorkflowStorage`.
- Assert: `warnings` has one entry, `workflowId` matches, `sourceKind` matches, `errors` non-empty.
- For bundled test: use `createBundledSource()` for the invalid workflow -- assert `warnings` is empty.

Handler integration test (extend `v2-workflow-source-catalog-output.test.ts` or new file):
- Write an invalid workflow JSON to a temp directory (missing required field).
- Call `handleV2ListWorkflows` with `workspacePath` pointing at temp dir.
- Assert response includes `validationWarnings` with correct structure.
- Assert valid workflows still present in `workflows[]`.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Missing one of 3 payload sites | Low | Medium | All 3 sites updated in Slice 3; verified by test exercising primary path + code review |
| `withTimeout` not applied to new method | Very Low | Low | Wrap in same `withTimeout(workflowReader.loadAllWorkflowsWithWarnings(), TIMEOUT_MS, ...)` |
| Rename of `loadAllWorkflowsWithWarnings` breaks handler | Very Low | Low | `HasValidationWarnings` interface -- TypeScript compile catches rename |
| Bundled failures appear in `validationWarnings` | None | N/A | `source.kind !== 'bundled'` guard at collection level + dedicated test |
| `reportValidationFailure` no longer called | Very Low | Low | Both methods explicitly call it (invariant I5) |

## 10. PR Packaging Strategy

**Single PR.** Branch: `feat/etienneb/list-workflows-validation-warnings`. One commit.
Commit: `feat(mcp): surface workflow validation failures in list_workflows response`

## 11. Philosophy Alignment per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (Storage) | Errors are data | Satisfied -- ValidationWarning returned as value |
| 1 (Storage) | Immutability by default | Satisfied -- readonly return types |
| 1 (Storage) | Explicit domain types | Satisfied -- ValidationWarning struct, not flat string |
| 1 (Storage) | Functional/declarative | Satisfied -- paired return, no callback/mutation |
| 1 (Storage) | YAGNI | Satisfied -- IWorkflowStorage untouched |
| 2 (Schema) | Explicit domain types | Satisfied -- V2ValidationWarningSchema |
| 3 (Handler) | Type safety as first line | Satisfied -- HasValidationWarnings interface |
| 3 (Handler) | Validate at boundaries | Satisfied -- bundled check in storage, handler trusts result |
| 4 (Tests) | Prefer fakes over mocks | Satisfied -- InMemoryWorkflowStorage, real handler |
| All | Document why not what | Satisfied -- comments explain bundled exclusion, call-scoped invariant |

---
`unresolvedUnknownCount`: 0
`planConfidenceBand`: High
`estimatedPRCount`: 1
`followUpTickets`: ["inspect_workflow validation surface (broken workflows still NOT_FOUND, separate pitch)"]

---
---

# Implementation Plan: Graceful Shutdown via AbortRegistry

*Generated: 2026-04-23 | Workflow: wr.coding-task | Branch: fix/etienneb/graceful-shutdown*

---

## 1. Problem Statement

SIGTERM/SIGINT does not abort in-flight `AgentLoop` instances in the WorkTrain daemon. `handle.stop()` closes the HTTP server and polling, but live `AgentLoop` instances keep making LLM API calls for up to 30 minutes. This breaks container orchestrators (Kubernetes, ECS), systemd, and rolling restarts.

## 2. Acceptance Criteria

1. SIGTERM causes all in-flight `AgentLoop` instances to receive `abort()` immediately.
2. Process exits within ~5 seconds of SIGTERM rather than up to 30 minutes.
3. `session_aborted` events are emitted before `abort()` (ordering preserved).
4. `npm run build` exits 0.
5. `npx vitest run` exits 0 (5 pre-existing `polling-scheduler` failures are unrelated).

## 3. Non-Goals

- No new HTTP endpoint for per-session abort.
- No changes to the WorkRail MCP server (`src/mcp/`) or its shutdown path.
- No mid-step graceful save -- sessions are hard-aborted; crash recovery handles the interrupted token.
- No changes to `src/v2/durable-core/`.
- No configurable drain window -- 5s is fixed.

## 4. Philosophy-Driven Constraints

- **YAGNI**: add exactly what the pitch specifies, no more.
- **Dependency injection**: `abortRegistry` injected from composition root (`trigger-listener.ts`), not created inside `runWorkflow()` or `TriggerRouter`.
- **Immutability under tension**: `Map` is mutable -- same accepted compromise as `SteerRegistry`.
- **Document why**: WHY comments matching the `SteerRegistry` block pattern.

## 5. Invariants

- I1: `session_aborted` events emitted BEFORE any `abort()` call (ordering preserved).
- I2: `abort()` called BEFORE `handle.stop()` closes the HTTP server.
- I3: `handle.stop()` called BEFORE `resolve()` exits the shutdown promise.
- I4: Drain window caps at exactly 5 seconds, regardless of session count.
- I5: `abortRegistry.delete()` placed synchronously in `finally` alongside `steerRegistry.delete()`.
- I6: `makeSpawnAgentTool()` does NOT pass `abortRegistry` to child sessions (consistent with `steerRegistry` treatment).

## 6. Selected Approach + Rationale

**Candidate A: Mirror SteerRegistry pattern exactly.**

`AbortRegistry = Map<string, () => void>` -- maps workrailSessionId to abort callback. Threaded as optional 7th param through `runWorkflow()`, `RunWorkflowFn`, `TriggerRouter`, `TriggerListenerHandle`. Drain window: `Promise.race([5s timeout, registry-empty poll every 100ms])`.

- Resolves: abort-fast + cleanup budget tensions.
- Accepts: Map mutation at boundary (same as SteerRegistry).
- Follows existing pattern exactly -- zero new abstractions.

**Runner-up**: AbortController Map -- rejected because it requires `agent-loop.ts` changes excluded by pitch no-go.

## 7. Vertical Slices

### Slice 1: Add `AbortRegistry` type to `src/daemon/workflow-runner.ts`

Export `AbortRegistry = Map<string, () => void>` alongside `SteerRegistry` (after line 665).

**Done when**: `AbortRegistry` type is exported from `workflow-runner.ts`. Build clean.

### Slice 2: Wire `AbortRegistry` through `runWorkflow()`

Add `abortRegistry?: AbortRegistry` as optional 7th param to `runWorkflow()`.

After `steerRegistry?.set()` at line 3498:
```typescript
if (workrailSessionId !== null) {
  abortRegistry?.set(workrailSessionId, () => agent.abort());
}
```

In `finally` block at line 4081, after `steerRegistry?.delete()`:
```typescript
if (workrailSessionId !== null) {
  abortRegistry?.delete(workrailSessionId);
}
```

**Done when**: `runWorkflow()` accepts and uses `abortRegistry`. Build clean.

### Slice 3: Update `RunWorkflowFn` type and `TriggerRouter` in `src/trigger/trigger-router.ts`

1. Add `abortRegistry?: AbortRegistry` as 7th param to `RunWorkflowFn` type.
2. Add `private readonly abortRegistry: AbortRegistry | undefined` field to `TriggerRouter`.
3. Add `abortRegistry?: AbortRegistry` to `TriggerRouter` constructor (after `steerRegistry`).
4. Assign `this.abortRegistry = abortRegistry` in constructor body.
5. Pass `this.abortRegistry` at both `runWorkflowFn` call sites (lines 765, 910).

**Done when**: Both call sites pass `abortRegistry`. Build clean.

### Slice 4: Expose `abortRegistry` from `TriggerListenerHandle` in `src/trigger/trigger-listener.ts`

1. Import `AbortRegistry` from `workflow-runner.ts`.
2. Add `readonly abortRegistry: AbortRegistry` to `TriggerListenerHandle` interface.
3. Construct `const abortRegistry: AbortRegistry = new Map()` alongside `steerRegistry`.
4. Pass `abortRegistry` to `TriggerRouter` constructor (after `steerRegistry`).
5. Return `abortRegistry` on the handle object.

**Done when**: `TriggerListenerHandle.abortRegistry` is typed, constructed, and returned. Build clean.

### Slice 5: Update shutdown handler in `src/cli-worktrain.ts`

Replace the shutdown sequence (lines 459-482) with:
1. Emit `session_aborted` for each active session (unchanged from current).
2. Emit `daemon_stopped` (unchanged from current).
3. Call `abort()` for all `handle.abortRegistry.values()`.
4. Drain window: `Promise.race([5s timeout, registry-empty poll every 100ms])`.
5. Call `await handle.stop()`.
6. Call `resolve()`.

**Done when**: Shutdown handler drains correctly. Build and tests clean.

## 8. Test Design

No new unit tests for this change. The implementation is structural wiring (new optional param, registration/deregistration), not new logic. Verification:

- `npm run build`: TypeScript catches any signature mismatches at all call sites.
- `npx vitest run`: Existing tests exercise `runWorkflow()`, `TriggerRouter`, and `trigger-listener.ts` with the new optional param absent (which is valid).
- Manual verification: SIGTERM behavior requires a running daemon -- not testable via unit tests without significant new test infrastructure (out of scope per pitch).

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Session registers in abortRegistry after abort-all fires | Very low | Low | Same ~50ms gap as steerRegistry; accepted |
| Session finally block takes >5s | Very low | Low | Crash recovery handles incomplete sidecars |
| TypeScript build error at call site | Low | Low | Build catches immediately |

## 10. PR Packaging Strategy

Single PR. Branch: `fix/etienneb/graceful-shutdown`. One commit.
Commit: `fix(daemon): abort in-flight agent loops on SIGTERM with 5s drain window`

## 11. Philosophy Alignment per Slice

| Slice | Principle | Status |
|---|---|---|
| 1 (AbortRegistry type) | Explicit domain types | Satisfied -- named export, not inline |
| 2 (runWorkflow) | Dependency injection | Satisfied -- injected from caller, not created inside |
| 2 (runWorkflow) | Immutability under tension | Accepted -- Map mutation required for registry |
| 3 (TriggerRouter) | YAGNI | Satisfied -- mirrors steerRegistry exactly |
| 4 (TriggerListenerHandle) | Dependency injection | Satisfied -- composition root constructs registry |
| 5 (Shutdown) | Document why | Satisfied -- WHY comments in drain window |
| 5 (Shutdown) | Determinism | Satisfied -- 5s cap is fixed, not configurable |
| All | Architectural fix | Satisfied -- registry pattern solves root cause, not a workaround |

---
`unresolvedUnknownCount`: 0
`planConfidenceBand`: High
`estimatedPRCount`: 1
`followUpTickets`: []
