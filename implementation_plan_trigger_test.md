# Implementation Plan: worktrain trigger test dry-run command

## 1. Problem Statement

When configuring a GitHub queue-poll trigger, operators have no way to validate that the trigger is correctly configured without running the full daemon. Adding `worktrain trigger test <triggerId>` provides a fast feedback loop: it shows exactly which issues would be dispatched and which would be skipped, using real API calls but never dispatching any sessions.

## 2. Acceptance Criteria

- [ ] `worktrain trigger test self-improvement` loads the trigger by ID from triggers.yml
- [ ] If the trigger is not a github_queue_poll provider, prints error: "Trigger 'X' is not a queue poll trigger -- only github_queue_poll triggers can be tested with this command"
- [ ] Prints header: trigger ID, provider, queue config summary, active sessions count
- [ ] For each issue: prints whether it WOULD DISPATCH or WOULD SKIP with reason
- [ ] For WOULD DISPATCH issues: prints maturity and upstreamSpecUrl (or "(none)")
- [ ] For WOULD SKIP issues: prints the skip reason (active_session, maturity=idea, excluded_label, etc.)
- [ ] Prints summary line: "N would dispatch, M would skip"
- [ ] Exits 0 if at least 1 issue would dispatch
- [ ] Exits 1 if no issues would dispatch
- [ ] All 5 test cases in tests/unit/worktrain-trigger-test.test.ts pass
- [ ] `npm run build` succeeds
- [ ] `npx vitest run` succeeds with no regressions

## 3. Non-Goals

- No changes to `src/mcp/` (explicitly excluded per task spec)
- No changes to actual trigger dispatch logic
- No support for non-queue poll trigger types (clear error message only)
- No `--json` output flag
- No `--dry-run` flag (the entire command IS a dry-run)
- No actual session dispatch under any circumstances
- No write actions of any kind (no session files, no labels, no logs)

## 4. Philosophy-Driven Constraints

- All I/O injected via `WorktrainTriggerTestDeps` -- zero direct fs/fetch/os imports in the command file
- All failures returned as `CliResult` -- never thrown
- Tests use pure fake deps (no vi.mock())
- No mutation of any state -- pure read-only query

## 5. Invariants

1. **DRY-RUN INVARIANT**: The command must never dispatch any real sessions. Enforced architecturally: no dispatch function in the deps interface.
2. **Real API calls are permitted**: The command makes real GitHub API calls to show accurate results.
3. **Exit code convention**: exit 0 iff >= 1 issue would dispatch; exit 1 if 0 would dispatch.
4. **Provider gate**: only `github_queue_poll` triggers can be tested. All other providers produce a clear error.
5. **Skip logic must mirror the scheduler**: The same skip conditions as `doPollGitHubQueue` in polling-scheduler.ts: excludeLabels -> worktrain:in-progress label -> sess_ pattern -> checkIdempotency -> inferMaturity.

## 6. Selected Approach + Rationale

**Approach**: Single `executeWorktrainTriggerTestCommand` function with injected deps, following the exact `WorktrainTriggerTestDeps` interface from the spec. All output via `deps.print()`. Returns `{ kind: 'success' }` (exit 0) or a sentinel failure value (exit 1). The CLI layer in `cli-worktrain.ts` handles exit code directly (not via `interpretCliResultWithoutDI`) to avoid the output-formatter prepending emoji/color to the already-printed dry-run output.

**Rationale**: Matches the injectable-deps pattern of all existing worktrain commands. Single-function design matches `executeWorktrainSpawnCommand` (~120 lines, no extracted helpers). Test cases test behavioral output, not internal sub-functions.

**Runner-up**: Extract `runQueuePick()` as a separate function. Lost because: test cases test execute() behavior, not pick logic; adds a type that never leaves the file; YAGNI.

## 7. Vertical Slices

### Slice 1: Core command file
**File**: `src/cli/commands/worktrain-trigger-test.ts`

Create `WorktrainTriggerTestDeps`, `WorktrainTriggerTestOpts`, and `executeWorktrainTriggerTestCommand`.

Logic:
1. `deps.loadTriggerConfig()` -> get trigger index
2. Find trigger by ID -> error if not found
3. Validate `trigger.provider === 'github_queue_poll'` -> error with specified message if not
4. Narrow pollingSource to `GitHubQueuePollingSource`
5. `deps.loadQueueConfig()` -> error if null or err
6. `deps.countActiveSessions()` -> count
7. Print header lines (trigger ID, provider, queue config summary, active sessions)
8. `deps.pollGitHubQueueIssues(queueConfig)` -> fetch issues
9. Loop over issues: classify each (excludeLabels, in-progress label, sess_ pattern, idempotency, maturity)
10. Collect `IssueDecision[]` (local type: `{issue, wouldDispatch, reason, maturity}`)
11. Print per-issue output
12. Print summary
13. Return `{ kind: 'success' }` if dispatches > 0, `{ kind: 'failure', ... }` if 0

**Done when**: file exists, exports function and types, TypeScript compiles.

### Slice 2: Export from index.ts
**File**: `src/cli/commands/index.ts`

Add export for `executeWorktrainTriggerTestCommand` and types.

**Done when**: index.ts exports the new function.

### Slice 3: Wire into CLI
**File**: `src/cli-worktrain.ts`

Add `const triggerCommand = program.command('trigger').description(...)` and `triggerCommand.command('test <triggerId>')...`. Wire real deps. Handle exit code directly:
```typescript
const result = await executeWorktrainTriggerTestCommand(deps, { triggerId, port: options.port });
if (result.kind === 'failure') process.exit(1);
```

**Done when**: `worktrain trigger test --help` works (conceptually).

### Slice 4: Tests
**File**: `tests/unit/worktrain-trigger-test.test.ts`

5 test cases:
1. Non-queue trigger returns error
2. Ready issue: prints WOULD DISPATCH, maturity: ready
3. Active session: prints WOULD SKIP, reason: active_session
4. Idea maturity: prints WOULD SKIP, reason: maturity=idea (no spec, no checklist)
5. Concurrency cap: all-skip when activeSessions >= maxTotalConcurrentSessions

**Done when**: all 5 pass.

## 8. Test Design

Pattern: `makeBaseDeps()` helper returns fake deps with valid defaults. Each test overrides the specific dep needed for that scenario.

```typescript
function makeBaseDeps(overrides = {}): { deps: WorktrainTriggerTestDeps; printLines: string[] }
```

Fake deps:
- `loadTriggerConfig`: returns ok(Map with a github_queue_poll trigger)
- `loadQueueConfig`: returns ok({ type: 'label', queueLabel: 'worktrain:ready', repo: 'owner/repo', token: 'tok', maxTotalConcurrentSessions: 1, pollIntervalSeconds: 300, excludeLabels: [] })
- `pollGitHubQueueIssues`: returns ok([])
- `countActiveSessions`: returns 0
- `checkIdempotency`: returns 'clear'
- `inferMaturity`: returns 'ready'
- `print`: pushes to printLines[]
- `stderr`: no-op

Test cases use targeted overrides.

## 9. Risk Register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Skip logic drifts from doPollGitHubQueue | Low | Comment in code points to doPollGitHubQueue as reference; SCOPE LOCK documented |
| output-formatter double-prints dry-run output | Mitigated | CLI layer handles exit code directly, bypasses interpretCliResultWithoutDI |
| pollGitHubQueueIssues signature mismatch | Low | Execute function builds GitHubQueuePollingSource from trigger.pollingSource internally |
| countActiveSessions miscounts | Low | Same 3-line logic as private function in polling-scheduler.ts |

## 10. PR Packaging Strategy

Single PR: `feat/trigger-test-command`
Commit message: `feat(cli): add worktrain trigger test dry-run command`

## 11. Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Immutability by default | Satisfied: all deps readonly, no state mutation |
| Errors are data | Satisfied: CliResult return, no throws |
| Validate at boundaries | Satisfied: provider check, config null check at entry |
| Make illegal states unrepresentable | Satisfied: no dispatch dep in interface |
| Prefer fakes over mocks | Satisfied: test uses pure fake deps |
| YAGNI with discipline | Satisfied: no extracted helpers, no extra options |
| Document why not what | Satisfied: WHY comments on failure() usage and dry-run invariant |
| Compose with small functions | Mild tension: single 100-line function -- matches repo pattern |
