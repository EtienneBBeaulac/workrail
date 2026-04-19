# Implementation Plan: Context Assembly Layer v1

*Authored during coding-task-workflow-agentic session | 2026-04-19*

---

## Problem Statement

When the PR review coordinator dispatches a session, it passes only a goal string.
The agent spends its first 2-3 turns re-establishing context (re-reading PR diff,
starting cold with no memory of prior reviews). Before spawning each session, the
coordinator should assemble a context bundle (git diff summary + prior session notes)
and inject it into the system prompt via the existing `trigger.context` map.

---

## Acceptance Criteria

1. `npm run build` compiles clean with zero TypeScript errors
2. `npx vitest run tests/unit/context-assembly.test.ts` -- all 5 tests pass
3. `npx vitest run` -- no regressions in full test suite
4. New module `src/context-assembly/` exists with 4 files
5. `CoordinatorDeps.contextAssembler?` optional field present
6. `CoordinatorDeps.spawnSession` accepts optional 4th `context?` arg
7. `buildSystemPrompt()` injects `## Prior Context` section when `assembledContextSummary` present in trigger context
8. `src/cli-worktrain.ts` wires `contextAssembler` and forwards `context` through HTTP body

---

## Non-Goals

1. No URL fetching from PR description bodies (v2)
2. No full git diff content -- `--stat` output only
3. No changes to `src/mcp/` or `src/v2/durable-core/`
4. No knowledge graph source (`ts-morph` stays in devDependencies)
5. No per-coordinator custom renderers
6. No context window budget trimming
7. No context assembly in `TriggerRouter.route()`
8. No HTTP endpoint schema changes
9. No workspace-scoped session filtering (v1 returns global sessions)

---

## Philosophy-Driven Constraints

- All interface fields `readonly` (immutability by default)
- `Result<T,E>` (`kind: 'ok'|'err'`) for all new code; bridge from neverthrow at `infra.ts` boundary
- Factory function `createContextAssembler()`, not a class
- `renderContextBundle()` is pure (no I/O)
- `ContextAssemblerDeps` interface contains all I/O; core has zero direct imports of `fs`/`execFile`
- Tests: fake deps, no `vi.mock()`, vitest `describe/it/expect`
- Import paths use `.js` extension (TypeScript ESM)
- JSDoc `WHY` comments on non-obvious decisions

---

## Invariants

1. **Partial failure**: `gitDiff` and `priorSessionNotes` fail independently; session always starts
2. **Zero agent turn cost**: Context injected in system prompt before turn 1
3. **Coordinator-controlled opt-in**: Only coordinators calling `assembler.assemble()` get enriched context
4. **Prior notes recency limit**: At most 3 prior sessions
5. **Git summary size**: File names and change counts only (no full diff)
6. **No engine/MCP changes**: `src/v2/durable-core/` and `src/mcp/` untouched
7. **Optional contextAssembler**: Backward-compatible -- all existing `CoordinatorDeps` fakes work

---

## Selected Approach

Use 4 new files in `src/context-assembly/` + 3 modified files, exactly as specified in
the pitch. `infra.ts` uses a direct `SessionEventLogReadonlyStorePortV2` adapter
(implementing only `load()` and `loadValidatedPrefix()` via `fs.promises` + existing Zod
schemas) instead of `LocalSessionEventLogStoreV2`. This eliminates the need for
`FileSystemPortV2` and `Sha256PortV2` shims.

**Runner-up**: Use `LocalSessionEventLogStoreV2` with write stubs. Rejected: write stubs
partially violate the interface contract even though they're provably unreachable.

---

## Vertical Slices

### Slice 1: New module `src/context-assembly/` (4 files)

**Files to create**:
- `src/context-assembly/types.ts` (~60 LOC) - AssemblyTask, SessionNote, ContextBundle, RenderOpts, ContextAssembler interface
- `src/context-assembly/deps.ts` (~35 LOC) - ContextAssemblerDeps interface (execGit, execGh, listRecentSessions, nowIso)
- `src/context-assembly/index.ts` (~80 LOC) - createContextAssembler(), renderContextBundle(), private helpers
- `src/context-assembly/infra.ts` (~80 LOC) - createListRecentSessions() adapter

**Done when**: All 4 files compile clean in isolation

**Key implementation details**:
- `types.ts`: import `Result` from `'../runtime/result.js'`
- `index.ts`: factory function `createContextAssembler(deps)`, pure `renderContextBundle(bundle, _opts?)`
- `infra.ts`: `SessionEventLogReadonlyStorePortV2` adapter using `fs.promises.readFile` + `ManifestRecordV1Schema` + `DomainEventV1Schema`; `LocalDataDirV2(process.env)` + `LocalDirectoryListingV2(directoryListingOpsAdapter)` wired into `LocalSessionSummaryProviderV2`
- `infra.ts`: `_workspacePath` named with leading underscore (intentional non-use in v1)
- Bridge: `const result = await provider.loadHealthySummaries(); if (result.isErr()) return err(...);`

### Slice 2: Modify `src/coordinators/pr-review.ts`

**Changes**:
1. Add `contextAssembler?: ContextAssembler` field to `CoordinatorDeps` (after `spawnSession`, before `awaitSessions`)
2. Extend `spawnSession` signature: add optional 4th arg `context?: Readonly<Record<string, unknown>>`
3. Add context assembly block before `spawnSession` call in `runPrReviewCoordinator` for-loop
4. Forward same `spawnContext` to re-review spawn (~line 1265)
5. Do NOT add context assembly to fix-agent spawn

**Done when**: File compiles clean; existing tests still pass

### Slice 3: Modify `src/daemon/workflow-runner.ts`

**Change**: Insert 6-line block in `buildSystemPrompt()` BEFORE the `referenceUrls` block

**Done when**: File compiles clean; `buildSystemPrompt` tests (if any) still pass

### Slice 4: Modify `src/cli-worktrain.ts`

**Changes**:
1. Add imports for `createContextAssembler` and `createListRecentSessions`
2. Extend `spawnSession` lambda to accept optional 4th `context?` arg and include it in JSON body
3. Add `contextAssembler: createContextAssembler({...})` to deps object (after `spawnSession`)
4. Wire `execGit`, `execGh` inline using `promisify(execFile)`

**Done when**: File compiles clean

### Slice 5: Tests

**File**: `tests/unit/context-assembly.test.ts`

**Tests**:
1. `assemble()` with both sources succeeding -- returns bundle with `kind: 'ok'` on both fields
2. `assemble()` with gitSummary failing -- priorNotes still returns `ok([])`; gitDiff returns `kind: 'err'`
3. `renderBundle()` produces correct markdown sections (headings, git diff in code block)
4. `renderBundle()` with all-failed bundle -- returns empty string
5. `listRecentSessions` with no sessions directory -- returns `ok([])`

**Done when**: All 5 tests pass with `npx vitest run tests/unit/context-assembly.test.ts`

---

## Test Design

### Fake deps for context assembler

```typescript
function makeFakeDeps(overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps {
  return {
    execGit: async () => ({ kind: 'ok', value: 'src/foo.ts | 5 ++\n' }),
    execGh: async () => ({ kind: 'err', error: 'gh not available' }),
    listRecentSessions: async () => ({ kind: 'ok', value: [] }),
    nowIso: () => '2026-04-19T00:00:00.000Z',
    ...overrides,
  };
}
```

### Test for no sessions directory

Uses a real temp directory (with no sessions subdirectory) to test the graceful `ok([])` return.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `infra.ts` SessionEventLogReadonlyStorePortV2 adapter has parsing bugs | Low | Medium | Tests verify behavior with fake data; manifest format well-documented |
| `spawnSession` 4th arg breaks existing tests | Very Low | Low | Optional arg; TypeScript enforces backward compat |
| `contextAssembler` not optional breaks existing tests | Very Low | Low | `?` makes it optional; existing fakes compile without it |
| Full test suite regressions | Very Low | High | Run `npx vitest run` before PR |

---

## PR Packaging Strategy

**Single PR**: `feat/context-assembly-layer`

All 7 file changes ship together. They form a single coherent feature -- the 4 new
files are meaningless without the 3 modifications, and the modifications are safe
with or without the new files.

**Commit message**: `feat(coordinator): add context assembly layer -- git summary and prior session notes`

---

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| Slice 1 (types) | Make illegal states unrepresentable (discriminated union) | Satisfied |
| Slice 1 (index) | Functional/declarative (factory fn, pure render) | Satisfied |
| Slice 1 (infra) | DI for boundaries (all I/O behind interface) | Satisfied |
| Slice 1 (infra) | Architectural fixes over patches (reuse projection code) | Satisfied |
| Slice 2 (coordinator) | Errors are data (Result<T,E>) | Satisfied |
| Slice 2 (coordinator) | Backward compatibility via optional fields | Satisfied |
| Slice 3 (workflow-runner) | Validate at boundaries (type check before inject) | Satisfied |
| Slice 5 (tests) | Prefer fakes over mocks | Satisfied |

---

## Open Questions (Residual)

None. All questions were resolved during design review:
1. `ManifestRecordV1Schema` and `DomainEventV1Schema` -- confirmed exported
2. `asSessionId` -- confirmed exported from ids/index.ts
3. Re-review spawn context -- confirmed: forward same `spawnContext` from outer scope

**`unresolvedUnknownCount`**: 0
**`planConfidenceBand`**: High
