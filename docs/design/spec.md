# Spec: Shared Pipeline Worktree

## Feature summary

When the adaptive pipeline coordinator runs a FULL or IMPLEMENT pipeline, it creates one isolated git worktree before the first session is spawned. All pipeline phases (discovery, shaping, coding, review, UX gate) operate in this shared worktree. File handoffs between phases (design docs, pitch files) are visible across phases without committing. The coordinator owns the worktree's lifecycle: it archives the pitch and then removes the worktree in a `finally` block regardless of outcome.

## Acceptance criteria

**AC1.** When `runFullPipeline` runs, a git worktree is created at `~/.workrail/worktrees/<runId>` on branch `worktrain/<runId>` before any session is spawned.

**AC2.** Every `spawnSession` call in `runFullPipeline` (discovery, shaping, coding, review, UX gate) receives the shared worktree path as `workspacePath`. No session receives `branchStrategy: 'worktree'` from the coordinator.

**AC3.** The `pitchPath` passed to the coding session's context is `<worktreePath>/.workrail/current-pitch.md`. The shaping session writes to that same path. No copy step is required.

**AC4.** When the pipeline succeeds, the coordinator's `finally` block first archives the pitch from `<worktreePath>/.workrail/current-pitch.md`, then removes the shared worktree.

**AC5.** When the pipeline escalates (any phase failure, timeout, or spawn cutoff after the worktree was created), the `finally` block still archives the pitch and removes the worktree in that order.

**AC6.** When `createPipelineWorktree` fails, the pipeline escalates at the `init` phase with a clear error message. No sessions are spawned. No worktree removal is attempted.

**AC7.** The worktree path is persisted in `PipelineRunContext.worktreePath` immediately after creation.

**AC8.** On crash recovery: if `PipelineRunContext.worktreePath` is present and the path exists on disk, the pipeline resumes using the existing worktree. No second worktree is created.

**AC9.** On crash recovery: if `PipelineRunContext.worktreePath` is present but the path does not exist on disk, the pipeline escalates with a clear message referencing the missing path.

**AC10.** `runCoordinatorDelivery` is called with the shared worktree path as `workspacePath`, not `opts.workspace`.

**AC11.** `runImplementPipeline` applies the same pattern: coordinator-created worktree before the coding session, all paths derived from the worktree, cleanup in finally, crash resume existence check.

**AC12.** All existing tests pass without modification.

## Non-goals

- Per-session worktrees for trigger-path sessions (`branchStrategy: 'worktree'` in `triggers.yml`) are unchanged.
- `QUICK_REVIEW` and `REVIEW_ONLY` modes are unchanged.
- Discovery and shaping outputs are not committed to the branch -- they are uncommitted working-directory files.
- `CodingHandoffArtifactV1.branchName` is not made optional in this change.
- The `worktrain run pipeline` CLI command is not wired in this change.
- Startup recovery for coordinator-owned orphaned worktrees is not in this change.

## External interface contract

`PipelineRunContext` gains an optional `worktreePath?: string` field. Existing serialized context files without this field remain valid (field is optional in the Zod schema). New runs always include it.

`AdaptiveCoordinatorDeps` gains two new required methods:
- `createPipelineWorktree(workspace, runId, baseBranch?)` -- callers must handle `err` result
- `removePipelineWorktree(workspace, worktreePath)` -- best-effort, always resolves

`createPipelineContext` 5th parameter changes from absent to required (`worktreePath: string`).

## Edge cases and failure modes

| Case | Expected behavior |
|---|---|
| `git fetch` fails before worktree add | `createPipelineWorktree` returns `err`; pipeline escalates at `init`; no sessions spawned |
| Worktree directory already exists | git returns error; `createPipelineWorktree` returns `err`; pipeline escalates |
| `finally` pitch archival fails | Logged as WARN; worktree removal still runs |
| `finally` worktree removal fails | Logged as WARN; pipeline outcome is not affected |
| Daemon crashes after worktree creation but before context write | Orphaned worktree in `WORKTREES_DIR`; addressed by follow-up startup recovery ticket |
| Daemon crashes after context write; worktree exists | Next run finds `priorRunId` + `worktreePath`; verifies existence; resumes with existing worktree |
| Worktree manually deleted between runs | Existence check fails; pipeline escalates with message naming the missing path |
| Concurrent FULL pipelines for the same workspace | Each gets distinct `runId` → distinct worktree path and branch name; no collision |

## Verification method per AC

| AC | Verification |
|---|---|
| AC1 | Unit test: `createPipelineWorktree` called before first `spawnSession` |
| AC2 | Unit test: all `spawnSession` calls receive worktreePath as workspace arg; no branchStrategy arg |
| AC3 | Unit test: coding context's `pitchPath` equals `worktreePath + '/.workrail/current-pitch.md'` |
| AC4 | Unit test: `archiveFile` called before `removePipelineWorktree` in success path; call ordering verified |
| AC5 | Unit test: both `archiveFile` and `removePipelineWorktree` called when discovery/shaping/coding escalates |
| AC6 | Unit test: `createPipelineWorktree` returns err → escalated outcome at `init`; `spawnSession` not called; `removePipelineWorktree` not called |
| AC7 | Unit test: `createPipelineContext` called with worktreePath immediately after `createPipelineWorktree` |
| AC8 | Unit test: prior context with worktreePath + existence check passes → `createPipelineWorktree` NOT called; all sessions receive prior worktreePath |
| AC9 | Unit test: prior context with worktreePath + existence check fails → escalated at `init` |
| AC10 | Unit test: `runCoordinatorDelivery` 4th arg is `worktreePath` (not `opts.workspace`) |
| AC11 | Unit tests in adaptive-implement.test.ts mirroring AC1-AC10 |
| AC12 | `npx vitest run` passes with no changes to existing test expectations |
