# Implementation Plan: queue-poll.jsonl rotation

_Date: 2026-04-21_

## 1. Problem Statement

`~/.workrail/queue-poll.jsonl` grows without bound. At 5-minute polling intervals it accumulates ~8.7 MB/month; at 1-minute intervals ~87 MB/month. The daemon memory audit rates this Critical. Additionally, the `worktrain logs --follow` command uses an offset-based reader that assumes the file only grows -- after rotation (when the file is replaced), the stale offset permanently stops the reader from showing new events.

## 2. Acceptance Criteria

1. `queue-poll.jsonl` never exceeds ~10 MB + one write cycle.
2. `queue-poll.jsonl.1` exists after the first rotation and contains the most recent pre-rotation entries.
3. `worktrain logs --follow` continues showing events after rotation (offset reset on shrink detection).
4. Rotation failures log a warning via `console.warn` and do not crash or stop polling.
5. The 'permanent file that never rotates' comment in `src/cli-worktrain.ts` is updated.
6. `npx tsc --noEmit` passes.
7. `npx vitest run` passes.

## 3. Non-Goals

- No configurable size threshold (hardcoded 10 MB).
- No date-named rotation files (backup is `queue-poll.jsonl.1` only).
- No changes to `daemon.stderr.log`.
- `worktrain logs` does NOT show backup file content.
- No multiple backup generations (no `.2`, `.3`, etc.).

## 4. Philosophy-Driven Constraints

- **Errors are data**: rotation failures use `console.warn`, never throw.
- **YAGNI**: no helper function extracted (single use case).
- **Architectural fixes over patches**: update the 'permanent file' comment so code and documentation stay in sync.
- **Determinism**: stat before append ensures rotation decision is based on current state.

## 5. Invariants

- I1: File size checked BEFORE each append (stat before appendFile).
- I2: If size >= 10 MB, rename to `.1` (overwriting existing backup) before appending.
- I3: Reader: if `stat.size < queuePollOffset`, reset `queuePollOffset = 0`.
- I4: Rotation is fire-and-forget -- inner try/catch around stat/rename; outer try/catch for the full function.
- I5: ENOENT on stat is caught by inner try/catch and falls through to appendFile (creates file).

## 6. Selected Approach + Rationale + Runner-Up

**Selected**: Candidate A -- inline stat+rename in `appendQueuePollLog` + shrink detection in `--follow` loop.

**Rationale**: Minimal footprint, follows existing fire-and-forget pattern exactly, zero new abstractions. Both writer and reader fixes in the correct location.

**Runner-up**: Candidate B (extracted `rotateIfNeeded` helper). Lost because YAGNI -- no other callers need the function.

## 7. Vertical Slices

### Slice 1: Writer fix (`src/trigger/polling-scheduler.ts`)
- Add `const MAX_QUEUE_POLL_FILE_SIZE = 10 * 1024 * 1024` constant before the class.
- Rewrite `appendQueuePollLog` to: stat file, rename to `.1` if size >= threshold, then append.
- Update or remove the existing comment about never rotating (if any).
- Done when: `appendQueuePollLog` rotates the file at >= 10 MB and the backup exists.

### Slice 2: Reader fix (`src/cli-worktrain.ts`)
- Update the comment at lines 685 and 892-893 from 'permanent file that never rotates' to reflect rotation.
- Add shrink detection before `readNewLines(queuePollPath, queuePollOffset)` in the `--follow` loop: `if (stat.size < queuePollOffset) { queuePollOffset = 0; }`.
- Done when: `--follow` resets offset on file shrinkage and continues showing events.

### Slice 3: Verification
- Run `npx tsc --noEmit` -- must pass.
- Run `npx vitest run` -- must pass.

## 8. Test Design

The existing `tests/unit/polling-scheduler.test.ts` does not mock `os.homedir()`, making it difficult to test `appendQueuePollLog` rotation in isolation without significant test infrastructure changes. The pitch does not require new unit tests for the rotation logic (only 'CI passes'). Verification is through TypeScript compilation and the existing test suite.

If future tests are added for rotation, they should mock `fs.stat`, `fs.rename`, and `fs.appendFile` using vitest's `vi.mock` or inject a file-system abstraction.

## 9. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Concurrent rotation race | Yellow | Acknowledged and accepted per pitch. At most 1-2 log lines lost. |
| EACCES causing unbounded growth | Yellow | console.warn via try/catch. Acceptable for diagnostic log. |
| Reader fix missed (writer-only PR) | Red | Both slices MUST ship in the same PR. |

## 10. PR Packaging Strategy

**SinglePR**: `fix/etienneb/queue-poll-rotation`
- Commit: `fix(engine): add size-capped rotation for queue-poll.jsonl at 10 MB`
- Both slices in one commit.
- MUST NOT be split into writer-only and reader-only PRs.

## 11. Philosophy Alignment per Slice

### Slice 1 (Writer)
- Errors are data -> satisfied (console.warn not throw)
- YAGNI -> satisfied (no helper extracted)
- Determinism -> satisfied (stat before append)
- Architectural fixes over patches -> satisfied (not a special case, changes the invariant)

### Slice 2 (Reader)
- Architectural fixes over patches -> satisfied (shrink detection is the correct invariant change)
- Document why not what -> satisfied (comment update explains rotation now happens)
- Errors are data -> N/A (statSync in try block for reader)

### Slice 3 (Verification)
- Type safety as first line of defense -> satisfied (tsc --noEmit)
