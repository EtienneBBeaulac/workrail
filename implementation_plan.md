# Implementation Plan: WorkTrain Worktree Isolation + Auto-commit (Issue #627)

**Date:** 2026-04-19
**Status:** Ready for implementation
**Branch:** feat/worktree-auto-commit

## 1. Problem Statement

Daemon coding sessions share the main checkout. Concurrent sessions or a crash can corrupt the working tree and git state. Worktree isolation gives each session a private branch at `~/.workrail/worktrees/<sessionId>`, so file edits, git index state, and HEAD are fully isolated per session.

## 2. Acceptance Criteria (from Issue #627)

- [ ] `branchStrategy`, `baseBranch`, `branchPrefix` parsed from triggers.yml
- [ ] `runWorkflow()` derives `sessionWorkspacePath`, creates worktree after `persistTokens()`
- [ ] All tool factories receive `sessionWorkspacePath`, not `trigger.workspacePath`
- [ ] `worktreePath` persisted in `~/.workrail/daemon-sessions/<uuid>.json`
- [ ] `runStartupRecovery()` removes orphan worktrees older than 24h
- [ ] Worktree removed on success; kept for debugging on failure/timeout
- [ ] `delivery-action` asserts HEAD branch before push
- [ ] `test-task` trigger: `autoCommit: true`, `autoOpenPR: true`, `branchStrategy: worktree`
- [ ] `mr-review` trigger: `branchStrategy: none`
- [ ] Concurrent sessions each get isolated worktrees -- no shared checkout
- [ ] Unit tests: worktree creation, branch assertion, orphan cleanup
- [ ] `npm run build` clean
- [ ] `npx vitest run tests/unit/workflow-runner-worktree.test.ts` all pass
- [ ] `npx vitest run` no regressions

## 3. Non-Goals

- No changes to `src/mcp/`
- No credential-check at daemon startup (deferred to issue #5)
- No disk-space guard for worktree accumulation
- No WorktreeManager class abstraction
- No changes to workflow JSON files (filesChanged already present in handoff blocks)

## 4. Philosophy Constraints

- `execFile` (not `exec`) for all git commands -- no shell injection
- `trigger.workspacePath` is immutable -- derive `sessionWorkspacePath` as a local variable
- `branchStrategy: 'worktree' | 'none'` union type -- not a boolean
- Errors as data -- branch assertion returns `DeliveryResult`, not throws
- Injectable `execFn` in `runStartupRecovery()` for testability
- Real temp dirs in tests -- no mocked fs

## 5. Invariants

1. `trigger.workspacePath` is never mutated in `runWorkflow()`
2. `sessionWorkspacePath === trigger.workspacePath` when `branchStrategy === 'none'`
3. `persistTokens(sessionId, token, checkpoint, worktreePath)` is called immediately after `git worktree add` (crash safety)
4. Worktree removal on success is best-effort (try/catch, never throws)
5. `runStartupRecovery()` only removes worktrees from sidecars older than `MAX_WORKTREE_ORPHAN_AGE_MS` (24h)
6. `git push` never executes when expected branch != HEAD (delivery-action assertion)

## 6. Selected Approach

**Candidate A: Spec-literal implementation.**

Thread `branchStrategy/baseBranch/branchPrefix` through `TriggerDefinition` -> `WorkflowTrigger` -> `runWorkflow()`. Derive `sessionWorkspacePath` as a `let` in `runWorkflow()`. Thread to 4 tool factories. Add `sessionWorkspacePath?` to `WorkflowRunSuccess` for trigger-router consumption. Add `expectedBranch?` to `runDelivery()`. Update sidecar JSON + recovery.

Runner-up: Candidate B (assertion in runWorkflow). Lost because spec places it in delivery-action, and committing in main checkout instead of worktree would be wrong.

## 7. Vertical Slices

### Slice 1: Types (src/trigger/types.ts)
Add to `TriggerDefinition`:
```typescript
readonly branchStrategy?: 'worktree' | 'none';
readonly baseBranch?: string;
readonly branchPrefix?: string;
```
AC: TypeScript compiles with no errors.

### Slice 2: YAML Parser (src/trigger/trigger-store.ts)
- Add `branchStrategy?`, `baseBranch?`, `branchPrefix?` to `ParsedTriggerRaw`
- Add cases to `setTriggerField()`
- In `validateAndResolveTrigger()`: validate branchStrategy is 'worktree' | 'none' if present; add to returned `TriggerDefinition`
AC: `loadTriggerConfig('triggers: [{id: t, provider: generic, workflowId: w, workspacePath: /p, goal: g, branchStrategy: worktree, baseBranch: main, branchPrefix: "worktrain/"}]')` returns ok with correct fields.

### Slice 3: WorkflowTrigger type + trigger-router mapping (src/daemon/workflow-runner.ts + src/trigger/trigger-router.ts)
- Add `branchStrategy?`, `baseBranch?`, `branchPrefix?` to `WorkflowTrigger`
- Update trigger-router WorkflowTrigger mapping (lines 529-538) to spread new fields
- Add `sessionWorkspacePath?` to `WorkflowRunSuccess`
AC: TypeScript compiles. trigger-router mapping includes new fields.

### Slice 4: Sidecar + OrphanedSession + persistTokens (src/daemon/workflow-runner.ts)
- Add `worktreePath?: string` to `OrphanedSession`
- Update `persistTokens(sessionId, continueToken, checkpointToken, worktreePath?)` to write worktreePath to JSON
- Update `readAllDaemonSessions()` to read and return `worktreePath`
AC: Sidecar JSON includes worktreePath when set. readAllDaemonSessions returns it.

### Slice 5: Worktree creation + sessionWorkspacePath + tool factory threading (src/daemon/workflow-runner.ts)
Right after `persistTokens()` at line ~2845:
```typescript
let sessionWorkspacePath = trigger.workspacePath;
let sessionWorktreePath: string | undefined;
if (trigger.branchStrategy === 'worktree') {
  sessionWorkspacePath = path.join(os.homedir(), '.workrail', 'worktrees', sessionId);
  await fs.mkdir(path.join(os.homedir(), '.workrail', 'worktrees'), { recursive: true });
  await execFileAsync('git', ['-C', trigger.workspacePath, 'fetch', 'origin', trigger.baseBranch ?? 'main']);
  await execFileAsync('git', ['-C', trigger.workspacePath, 'worktree', 'add',
    sessionWorkspacePath, '-b', `${trigger.branchPrefix ?? 'worktrain/'}${sessionId}`,
    `origin/${trigger.baseBranch ?? 'main'}`]);
  sessionWorktreePath = sessionWorkspacePath;
  await persistTokens(sessionId, startContinueToken, startCheckpointToken, sessionWorktreePath);
}
```
Update tool factories (4 calls): replace `trigger.workspacePath` with `sessionWorkspacePath`.
On success path: add worktree removal before `fs.unlink()`.
Add `sessionWorkspacePath` to `WorkflowRunSuccess` return value.
AC: Tools see sessionWorkspacePath; worktree created at correct path; sidecar updated.

### Slice 6: runStartupRecovery orphan worktree cleanup (src/daemon/workflow-runner.ts)
- Add `MAX_WORKTREE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000`
- Add injectable `execFn` parameter to `runStartupRecovery(sessionsDir?, execFn?)`
- In recovery loop: if `session.worktreePath && ageMs > MAX_WORKTREE_ORPHAN_AGE_MS`, call `execFn('git', ['worktree', 'remove', '--force', session.worktreePath])`
AC: runStartupRecovery with mock execFn calls git worktree remove for 24h+ orphans.

### Slice 7: delivery-action branch assertion (src/trigger/delivery-action.ts)
- Add `expectedBranch?: string` parameter to `runDelivery()`
- Before `git push`: if expectedBranch is set, run `git -C workspacePath rev-parse --abbrev-ref HEAD` and assert it matches
- On mismatch: return `{ _tag: 'error', phase: 'commit', details: 'HEAD branch mismatch...' }`
- Update `maybeRunDelivery()` in trigger-router.ts to pass `result.sessionWorkspacePath` and the expected branch name
AC: runDelivery returns error on branch mismatch, passes on match.

### Slice 8: triggers.yml wire-up
```yaml
- id: test-task
  branchStrategy: worktree
  baseBranch: main
  branchPrefix: "worktrain/"
  autoCommit: true
  autoOpenPR: true

- id: mr-review
  branchStrategy: none
```
AC: `loadTriggerConfigFromFile(repoRoot)` returns test-task with branchStrategy='worktree', autoCommit=true, autoOpenPR=true; mr-review with branchStrategy='none'.

### Slice 9: Tests (tests/unit/workflow-runner-worktree.test.ts)
Tests:
1. `branchStrategy: 'worktree'` -> worktree created at `~/.workrail/worktrees/<sessionId>`, sidecar has worktreePath
2. `branchStrategy: 'none'` -> no worktree created, sessionWorkspacePath = trigger.workspacePath
3. delivery-action branch assertion: correct branch passes, wrong branch returns error result
4. Orphan cleanup: runStartupRecovery with worktreePath in sidecar >24h old calls git worktree remove

## 8. Test Design

- Tests use real temp dirs and real git repos (initialized with `git init && git commit`)
- No mocked fs
- Injectable `execFn` in runStartupRecovery to capture git commands without running real git
- delivery-action branch assertion tests use injectable `execFn` returning controlled output
- Existing `workflow-runner-crash-recovery.test.ts` pattern is the template

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Crash between worktree creation and sidecar write | Low | Low (stale dir) | Minimize by writing sidecar immediately |
| git fetch credential failure | Medium (new operator) | Low (clean error path) | Error captured in WorkflowRunError |
| git worktree remove failure | Very Low | Very Low | best-effort try/catch |
| Tests need real git binary | Low | Medium | CI has git; test failure is loud |

## 10. PR Packaging

Single PR: `feat(daemon): worktree isolation + auto-commit wire-up for coding sessions`

All 9 slices in one branch `feat/worktree-auto-commit`. Slices are independent but the feature is cohesive and the spec says "never ship one without the other" (autoCommit + branchStrategy).

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 (Types) | Make illegal states unrepresentable | Satisfied -- union type |
| 2 (YAML parser) | Validate at boundaries | Satisfied -- parse time validation |
| 3 (WorkflowTrigger) | Immutability by default | Satisfied -- all readonly |
| 4 (Sidecar) | Determinism over cleverness | Satisfied -- atomic temp-rename |
| 5 (Worktree creation) | execFile not exec | Satisfied -- execFileAsync |
| 6 (Recovery) | Dependency injection for boundaries | Satisfied -- injectable execFn |
| 7 (Delivery assertion) | Errors as data | Satisfied -- DeliveryResult |
| 8 (triggers.yml) | YAGNI | Satisfied -- minimal config |
| 9 (Tests) | Prefer fakes over mocks | Satisfied -- real git repos |
