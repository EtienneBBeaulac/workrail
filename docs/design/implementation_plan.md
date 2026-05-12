# Implementation Plan: Shared Pipeline Worktree

## Problem statement

The coordinator pipeline creates a `branchStrategy: 'worktree'` for the coding session only. Discovery writes design docs and shaping writes `current-pitch.md` to `opts.workspace` (main checkout). The coding session's worktree is forked from `main` AFTER these files were written -- they are never committed, so they are absent from the worktree. Pipeline file handoffs are silently broken.

Secondary problem: `opts.workspace` is used as an implicit workspace reference throughout `full-pipeline.ts` and `implement.ts` for path construction (`pitchPath`, `archiveDir`), delivery, and spawnSession calls. After introducing a shared worktree, every such reference must be audited and updated to the correct workspace value.

## Acceptance criteria

1. When `runFullPipeline` runs, all phase sessions (discovery, shaping, coding, review, UX gate) receive the coordinator-created worktree path as their `workspacePath`.
2. Shaping writes `.workrail/current-pitch.md` to the shared worktree; coding reads it from the same absolute path without any copy step.
3. The coordinator's `finally` block: (a) archives the pitch from the shared worktree path, then (b) removes the shared worktree. Both happen on success AND on failure.
4. Crash recovery: if `PipelineRunContext.worktreePath` is present and the path exists on disk, the pipeline resumes using the existing worktree instead of creating a second one.
5. `runImplementPipeline` applies the same pattern.
6. No per-session `branchStrategy: 'worktree'` is passed for coordinator-spawned sessions.
7. All existing tests continue to pass. New tests cover all new invariants.
8. `runCoordinatorDelivery` is called with `worktreePath` as `workspacePath`, not `opts.workspace`.

## Non-goals

- No changes to the daemon's per-session worktree mechanism (`buildPreAgentSession`)
- No changes to `QUICK_REVIEW` or `REVIEW_ONLY` modes
- No changes to the WorkRail engine, MCP server, or session store
- `CodingHandoffArtifactV1.branchName` is NOT made optional in this PR (follow-up ticket)
- `worktrain run pipeline` CLI command wiring is NOT in scope
- Startup recovery for pipeline-worktree orphans is NOT in scope (follow-up ticket)

## Philosophy-driven constraints

- **DI for boundaries:** `createPipelineWorktree` and `removePipelineWorktree` must be dep methods
- **Make illegal states unrepresentable:** `createPipelineWorktree` returns `Result<string, string>` -- no code path reaches `spawnSession` with undefined worktree path; `worktreeCreated` boolean flag prevents `removePipelineWorktree` being called when creation never succeeded
- **Single source of state truth:** `PipelineRunContext.worktreePath` is the durable path; no separate file
- **Functional core, imperative shell:** finally block has explicit, ordered cleanup steps; pitch archival before worktree removal is an invariant, not a convention
- **Architectural fix over patch:** introduce `activeWorkspacePath` to replace scattered `opts.workspace` references for within-session path construction

## Invariants

1. Worktree created BEFORE first `spawnSession` call
2. `worktreePath` persisted atomically in `createPipelineContext` call immediately after creation
3. Pitch archival runs BEFORE worktree removal in the `finally` block (pitch is inside the worktree)
4. Worktree removal runs in `finally` block ONLY if worktree was successfully created (`worktreeCreated` flag)
5. `branchStrategy` is NOT passed for any coordinator-spawned session
6. Crash resume: check `fs.access(worktreePath)` before reusing; escalate with clear message if path missing
7. All path construction using the within-session workspace (`pitchPath`, `archiveDir`, delivery `workspacePath`) uses `activeWorkspacePath` (the worktree path), not `opts.workspace`
8. `opts.workspace` is used ONLY for coordinator-owned operations: `readActiveRunId`, `readPipelineContext`, `writePhaseRecord`, `markPipelineRunComplete`, `createPipelineContext` (context file storage), and git commands run by `createPipelineWorktree`/`removePipelineWorktree`

## Selected approach

### New types and interface changes

**`AdaptiveCoordinatorDeps` (adaptive-pipeline.ts):**
```typescript
createPipelineWorktree(
  workspace: string,
  runId: string,
  baseBranch?: string,  // default: 'main'
): Promise<Result<string, string>>;  // ok(worktreePath) | err(reason)

removePipelineWorktree(
  workspace: string,
  worktreePath: string,
): Promise<void>;  // best-effort, never throws
```

**`PipelineRunContext` (pipeline-run-context.ts):**
```typescript
// new optional field (optional for backward compat with pre-feature context files)
readonly worktreePath?: string;
```
Zod schema: `worktreePath: z.string().optional()`.

**`createPipelineContext` (adaptive-pipeline.ts + coordinator-deps.ts):**
```typescript
createPipelineContext(
  workspace: string,
  runId: string,
  goal: string,
  pipelineMode: PipelineRunContext['pipelineMode'],
  worktreePath: string,  // required for new callers -- NOT optional
): Promise<Result<void, string>>;
```
Note: the 5th param is typed as required in `AdaptiveCoordinatorDeps`. Pre-feature callers in `implement.ts` always pass the value because `createPipelineWorktree` runs first. The Zod schema field remains optional for backward-compat deserialization of old context files.

### Implementation in coordinator-deps.ts

```typescript
createPipelineWorktree: async (workspace, runId, baseBranch = 'main') => {
  const worktreePath = path.join(WORKTREES_DIR, runId);
  const branchName = `worktrain/${runId}`;
  try {
    await fs.promises.mkdir(WORKTREES_DIR, { recursive: true });
    await execFileAsync('git', ['-C', workspace, 'fetch', 'origin', baseBranch]);
    await execFileAsync('git', ['-C', workspace, 'worktree', 'add',
      worktreePath, '-b', branchName, `origin/${baseBranch}`]);
    return ok(worktreePath);
  } catch (e) {
    return err(`createPipelineWorktree failed: ${e instanceof Error ? e.message : String(e)}`);
  }
},

removePipelineWorktree: async (workspace, worktreePath) => {
  try {
    await execFileAsync('git', ['-C', workspace, 'worktree', 'remove', '--force', worktreePath]);
  } catch { /* best-effort */ }
},
```

### Changes to full-pipeline.ts and implement.ts

Pattern for `runFullPipeline` / `runImplementPipeline` (the outer wrapper):

```typescript
// Before runFullPipelineCore call:
let worktreeCreated = false;
let activeWorkspacePath = opts.workspace;  // fallback until worktree is ready

// After worktree creation in core (or in outer function for implement):
// see runFullPipelineCore below

// In the finally block:
try {
  if (pitchPath was from activeWorkspacePath) {
    await deps.mkdir(archiveDir, { recursive: true });
    await deps.archiveFile(pitchPath, archivePath);  // FIRST: archive before removal
  }
} catch { /* log */ }
if (worktreeCreated) {
  await deps.removePipelineWorktree(opts.workspace, activeWorkspacePath);  // SECOND
}
```

Pattern for `runFullPipelineCore` / `runImplementCore`:

```typescript
// Step 0: Create worktree
const worktreeResult = await deps.createPipelineWorktree(opts.workspace, runId);
if (worktreeResult.isErr()) {
  return { kind: 'escalated', escalationReason: { phase: 'init', reason: worktreeResult.error } };
}
const activeWorkspacePath = worktreeResult.value;
worktreeCreated = true;  // signal to finally block

// Step 1: Persist worktreePath in context immediately (5th param required)
await deps.createPipelineContext(opts.workspace, runId, opts.goal, 'FULL', activeWorkspacePath);

// Step N: pitchPath uses activeWorkspacePath (not opts.workspace)
const pitchPath = activeWorkspacePath + '/.workrail/current-pitch.md';
const archiveDir = activeWorkspacePath + '/.workrail/used-pitches';

// All spawnSession calls: workspace = activeWorkspacePath (not opts.workspace)
deps.spawnSession('wr.discovery', opts.goal, activeWorkspacePath, ...);
deps.spawnSession('wr.shaping', opts.goal, activeWorkspacePath, ...);
deps.spawnSession('wr.coding-task', opts.goal, activeWorkspacePath, { pitchPath, ... }, ...);  // no branchStrategy
deps.spawnSession('wr.mr-review', opts.goal, activeWorkspacePath, ...);
deps.spawnSession('wr.ui-ux-design', opts.goal, activeWorkspacePath, ...);  // UX gate

// Delivery: uses activeWorkspacePath
runCoordinatorDelivery(deps, recapMarkdown, branchName, activeWorkspacePath);

// opts.workspace references preserved for:
// - writePhaseRecord(opts.workspace, runId, ...)
// - readPipelineContext(opts.workspace, runId)
// - markPipelineRunComplete(opts.workspace, runId)
```

### Crash resume path

```typescript
if (priorRunId) {
  const existingCtx = await deps.readPipelineContext(opts.workspace, priorRunId);
  if (existingCtx.isOk() && existingCtx.value?.worktreePath) {
    const priorWorktreePath = existingCtx.value.worktreePath;
    try {
      await fs.promises.access(priorWorktreePath);
      // Worktree exists -- reuse it
      activeWorkspacePath = priorWorktreePath;
      worktreeCreated = true;  // finally block will clean up
    } catch {
      return { kind: 'escalated', escalationReason: {
        phase: 'init',
        reason: `Crash recovery: prior pipeline worktree not found at ${priorWorktreePath}. ` +
                `Delete ${opts.workspace}/.workrail/pipeline-runs/${priorRunId}-context.json to start fresh.`
      }};
    }
  }
  // If worktreePath absent from context (old-format context): fall through to create fresh worktree
}
```

## Vertical slices

### Slice 1: Schema and interface layer (no behavior change)
- Add `worktreePath?: string` to `PipelineRunContext` + Zod schema (optional)
- Add `createPipelineWorktree` and `removePipelineWorktree` to `AdaptiveCoordinatorDeps`
- Change `createPipelineContext` 5th param from optional to required (`worktreePath: string`)
- **AC:** `npm run build` passes; all existing tests pass (no callers yet supply 5th param -- will be compile errors resolved in Slice 3/4)

### Slice 2: Implement new dep methods in coordinator-deps.ts
- Implement `createPipelineWorktree` and `removePipelineWorktree`
- Update `createPipelineContext` implementation to include `worktreePath` in initial object
- Update fake `AdaptiveCoordinatorDeps` in test files to add stub implementations (return `ok('')` / no-op)
- **AC:** `npm run build` passes; all existing tests pass

### Slice 3: Wire into full-pipeline.ts
- Introduce `worktreeCreated: boolean` and `activeWorkspacePath` variables
- Create worktree before discovery; persist to context (5th param)
- Replace ALL `opts.workspace` path-construction references with `activeWorkspacePath`:
  - `pitchPath` (lines 216, 553)
  - `archiveDir` (line 217)
  - All `spawnSession` workspace args (lines 274, 373, 458, 558)
  - `runCoordinatorDelivery` workspace arg (line 645)
  - UX gate `spawnSession` (line 458)
- Preserve `opts.workspace` for: `readActiveRunId`, `readPipelineContext`, `writePhaseRecord`, `markPipelineRunComplete`
- Finally block: pitch archival from `activeWorkspacePath` FIRST, then `removePipelineWorktree` if `worktreeCreated`
- Crash resume: existence check before reuse
- **AC:** existing tests pass; new tests added; `npm run build` passes

### Slice 4: Wire into implement.ts
- Same pattern: `worktreeCreated`, `activeWorkspacePath`, replace path-construction references
- `pitchPath` arg to `runImplementCore` must be `worktreePath`-relative: derive it inside core after worktree creation rather than constructing in the outer `runImplementPipeline`
- **AC:** existing tests pass; new tests added

### Slice 5: Test coverage for all new invariants
Tests to add in `adaptive-full-pipeline.test.ts`:
1. `createPipelineWorktree` called with `(opts.workspace, runId)` before first `spawnSession`
2. All `spawnSession` calls receive `worktreePath` as workspace (not `opts.workspace`)
3. `pitchPath` in coding context points to `worktreePath` (not `opts.workspace`)
4. `runCoordinatorDelivery` receives `worktreePath` as 4th arg
5. `removePipelineWorktree` called in finally on success (after `archiveFile`)
6. `removePipelineWorktree` called in finally on discovery escalation
7. `createPipelineWorktree` failure → escalated at `init`; `spawnSession` not called; `removePipelineWorktree` not called
8. Crash resume: prior `worktreePath` in context + existence check passes → `createPipelineWorktree` NOT called; all sessions receive prior `worktreePath`
9. Crash resume: prior `worktreePath` in context + existence check fails → escalated at `init`
10. Old-format context (no `worktreePath`): falls through to fresh worktree creation

Mirror all tests in `adaptive-implement.test.ts`.

## Test design

All tests use fully-injected fakes. `createPipelineWorktree` and `removePipelineWorktree` added to `makeFakeDeps`:
```typescript
createPipelineWorktree: vi.fn().mockResolvedValue(ok('/fake/worktree')),
removePipelineWorktree: vi.fn().mockResolvedValue(undefined),
```

Crash resume tests inject a fake `readPipelineContext` that returns a context with `worktreePath` set. The `fileExists` dep (used by `routeTask`) is separate from the `fs.access` call in crash resume -- the crash resume check uses the `deps.fileExists` method or a new `deps.worktreeExists` dep (design decision: use existing `fileExists` dep to avoid proliferating dep methods).

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Orphaned pipeline worktrees if daemon crashes before context write | Low | Known gap; startup recovery for pipeline worktrees is a follow-up ticket |
| `opts.workspace` reference missed in a spawnSession or path construction | Medium | Invariant 8 lists all allowed `opts.workspace` uses; Slice 3/4 explicitly enumerate every line number to update |
| Pitch archival before worktree removal ordering violated by future change | Low | Documented invariant 3; test 5 verifies call ordering via mock call order inspection |
| Crash resume existence check uses wrong dep method | Low | Use `deps.fileExists` (already in deps) rather than a new method |

## PR packaging strategy

Single PR. All 5 slices are logically coupled. User explicitly requested single PR.

## Follow-up tickets

1. Make `CodingHandoffArtifactV1.branchName` optional (redundant for delivery routing)
2. Wire `worktrain run pipeline` CLI command with new dep methods
3. Startup recovery for pipeline worktrees (scan `pipeline-runs/` for in-progress contexts with stale worktrees)
4. Per-phase commit strategy for richer crash recovery and audit trail

## Plan confidence: High

All blocking audit findings resolved with confirmed primary-evidence verification. No remaining unresolved questions.
