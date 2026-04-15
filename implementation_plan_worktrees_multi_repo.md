# Implementation Plan: Multi-Repo Worktrees View

## Problem Statement

The worktrees console view only shows worktrees for the repo containing the MCP server's CWD. Users working across multiple repos (e.g. `zillow-android-2` + `workrail`) can't see all their worktrees in one place. The `workspacePath` passed by agents on every `start_workflow`/`continue_workflow` call is the data we need, but it is currently discarded — only a one-way SHA256 hash (`repo_root_hash`) is persisted.

## Acceptance Criteria

1. Worktrees tab shows worktrees grouped by repo (e.g. `workrail · 11` / `zillow-android-2 · 4`)
2. A repo section appears for every unique `repo_root` observed across all sessions in the store
3. The current repo (from CWD) always appears even if it has no sessions yet
4. Repos with no worktrees (sessions existed but worktrees were pruned) show graceful empty state per repo
5. Old sessions without `repo_root` degrade gracefully — those sessions don't contribute a repo section
6. Clicking a worktree card still navigates to sessions filtered to that branch

## Non-Goals

- Repos that have never had a workflow session (no filesystem scanning)
- Cross-platform path normalization
- Editing or managing worktrees from the UI
- Registry or catalog of known repos

## Applied Philosophy Constraints

- **Immutability by default** — `readonly` on all new types, `ReadonlyMap`/`ReadonlySet` where applicable
- **Explicit domain types** — new `path` value type rather than overloading `short_string`
- **Errors are data** — no throws; `string | null` for optional observations
- **Validate at boundaries** — path length validated in `observation-builder`, not in adapters or callers
- **YAGNI** — store the raw path, no normalization, no canonicalization
- **Exhaustiveness** — TypeScript discriminated union switch enforces every new `WorkspaceAnchor` key is handled at compile time

## Invariants

1. `repo_root` uses value type `{ type: 'path', value: string }` — never `short_string`
2. `MAX_OBSERVATION_PATH_LENGTH = 512` — paths exceeding this are silently skipped (mirrors `git_branch` > 80 pattern)
3. `dedupeKey`: `observation_recorded:<sessionId>:repo_root`
4. Console service returns `repoRoot: string | null` — null for old sessions, never missing key
5. Route collects unique non-null `repoRoot` values, always appends the CWD's git root as fallback
6. `getWorktreeList` accepts `readonly string[]` of repo roots, returns `{ repos: ConsoleRepoWorktrees[] }`

## Selected Approach

**Plan A — extend observation schema.** `LocalWorkspaceAnchorV2` already has `repoRoot` in scope (used to compute `repo_root_hash`). We now also emit it as a `repo_root` anchor. Console extracts it like `gitBranch`. Route collects unique roots and passes to worktree service. Frontend groups by repo.

**Runner-up:** None. Plan B (side-channel file) introduces mutable state with stale risk. Plan C (opportunistic hash match) fails for sessions from past CWDs.

## Vertical Slices

### Slice 1: Schema layer
**Files:**
- `src/v2/ports/workspace-anchor.port.ts`
- `src/v2/durable-core/constants.ts`
- `src/v2/durable-core/domain/observation-builder.ts`
- `src/v2/infra/local/workspace-anchor/index.ts`

**Changes:**
- Add `{ key: 'repo_root'; value: string }` to `WorkspaceAnchor` union
- Add `MAX_OBSERVATION_PATH_LENGTH = 512` constant
- Add `'path'` value type to `ObservationEventData`: `{ type: 'path'; value: string }`
- Add `repo_root` case to exhaustive switch in `anchorsToObservations()`
- Emit `{ key: 'repo_root', value: repoRoot }` anchor in `runGitCommands()` after existing `repoRoot` resolution

**Tests:** `observation-builder.test.ts` — 3 new cases (maps correctly, skips > 512, accepts = 512)
**Verifiable:** `tsc --noEmit` passes, new test cases green

### Slice 2: Console service + types
**Files:**
- `src/v2/usecases/console-types.ts`
- `src/v2/usecases/console-service.ts`
- `src/v2/durable-core/schemas/session/events.ts` *(discovered: Zod schema that generates `DomainEventV1` TypeScript type — must include `repo_root` key + `path` value)*
- `src/v2/projections/resume-ranking.ts` *(discovered: `SessionObservations` interface used by resume ranking — must include `repoRoot: string | null`)*
- `src/v2/infra/local/session-summary-provider/index.ts` *(discovered: `EMPTY_OBSERVATIONS` default + exhaustive switch on observation keys)*

**Changes:**
- Add `repoRoot: string | null` to `ConsoleSessionSummary`
- Add `extractRepoRoot()` function mirroring `extractGitBranch()` pattern, using key `'repo_root'` and value type `'path'`
- Call `extractRepoRoot(events)` in session summary projection

**Tests:** No new file — extraction pattern is structurally identical to `extractGitBranch`, covered by existing tests
**Verifiable:** `/api/v2/sessions` response includes `repoRoot` field

### Slice 3: Worktree service + route
**Files:**
- `src/v2/usecases/console-types.ts` (new DTO types)
- `src/v2/usecases/worktree-service.ts`
- `src/v2/usecases/console-routes.ts`

**Changes:**

New types in `console-types.ts`:
```ts
export interface ConsoleRepoWorktrees {
  readonly repoName: string;      // basename(repoRoot)
  readonly repoRoot: string;      // full path
  readonly worktrees: readonly ConsoleWorktreeSummary[];
}
// ConsoleWorktreeListResponse changes from { worktrees } to:
export interface ConsoleWorktreeListResponse {
  readonly repos: readonly ConsoleRepoWorktrees[];
}
```

`worktree-service.ts`:
- `getWorktreeList(repoRoots: readonly string[], activeSessions)` — iterates each root, runs worktree enrichment, returns `ConsoleRepoWorktrees[]`
- Sort repos: those with active sessions first, then by repo name

`console-routes.ts`:
- Collect `sessions.map(s => s.repoRoot).filter(Boolean)` → `new Set<string>()` to deduplicate
- Resolve CWD's git root via `git rev-parse --show-toplevel`; if non-null, add to set (silently skip if CWD is not a git repo)
- Pass deduped array to `getWorktreeList`

`getWorktreeList` **omits repos with 0 enriched worktrees** from the returned `repos` array. An inaccessible or deleted repo root yields 0 worktrees and should not appear as an empty section.

**Tests:** Type-checking and manual verification
**Verifiable:** `/api/v2/worktrees` returns `{ repos: [...] }` with one entry per unique repo

### Slice 4: Frontend
**Files:**
- `console/src/api/types.ts`
- `console/src/views/WorktreeList.tsx`

**Changes:**
- Add `ConsoleRepoWorktrees` type, update `ConsoleWorktreeListResponse`
- `WorktreeList` maps `data.repos` → one `RepoSection` per repo
- `RepoSection` renders a header (`repoName · N worktrees · X active · Y dirty`) then `WorktreeGrid`
- `WorktreeGrid` unchanged — reused per repo
- **Note:** `onSelectBranch` filters sessions by branch name only, not branch + repo. Acceptable for MVP — user-prefixed branch names are practically unique. Documented in component comment.

**Tests:** None new — structural, covered by TypeScript
**Verifiable:** Dashboard shows per-repo sections, click-through works per repo

## Test Design

| Test | File | Assertion |
|------|------|-----------|
| `maps repo_root to path value with high confidence` | `observation-builder.test.ts` | Correct key/value/confidence emitted |
| `skips repo_root longer than 512 chars` | `observation-builder.test.ts` | Silently excluded, no error |
| `accepts repo_root exactly 512 chars` | `observation-builder.test.ts` | Boundary value included |
| `emits repo_root anchor when git root is available` | `workspace-anchor-adapter.test.ts` | New assertion on existing test |

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `path` value type breaks existing storage/projection tests | Low | Medium | Run full test suite after Slice 1; pivot to `basename` as `short_string` if needed |
| TypeScript propagation errors from union extension | Low | Low | Exhaustive switch catches all gaps at compile time |
| All sessions predate feature — no repos discovered | Expected initially | Low | CWD fallback always ensures current repo is shown |

## PR Packaging

SinglePR — 4 slices are cohesive; frontend is meaningless without backend.

## Philosophy Alignment Per Slice

| Slice | Principle | Status |
|-------|-----------|--------|
| 1 | Exhaustiveness everywhere | ✅ switch enforces all anchor keys handled |
| 1 | Validate at boundaries | ✅ length check in observation-builder, not adapter |
| 1 | Explicit domain types | ✅ `path` type, not overloaded `short_string` |
| 2 | Errors are data | ✅ `string \| null`, not optional field, no throw |
| 3 | Immutability by default | ✅ `readonly string[]` input, all DTOs readonly |
| 3 | YAGNI | ✅ no normalization, no registry, raw path stored |
| 4 | Compose with small pure functions | ✅ `WorktreeGrid` reused per-repo |
| 4 | Determinism over cleverness | ✅ repos sorted by name, predictable order |
