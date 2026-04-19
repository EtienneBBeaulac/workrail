# Implementation Plan: Coordinator Message Queue Drain

## 1. Problem Statement

`worktrain tell "<message>"` appends to `~/.workrail/message-queue.jsonl` but the PR review
coordinator (`runPrReviewCoordinator`) never reads this file. Messages sent from a phone,
terminal, or automation (e.g., "stop", "skip-pr 42") are silently ignored. The coordinator
must drain this queue at the start of each cycle and act on actionable messages before spawning
any agent.

## 2. Acceptance Criteria

AC1. When `stop` appears as the first meaningful word in a queued message (matched by
     `/^\s*stop\b/i`), the coordinator exits cleanly without reviewing any PR, and appends an
     outbox notification that includes the full triggering message text and timestamp.

AC2. When `skip-pr N` appears in a queued message (matched by `/\bskip[- ]pr[\s#]+(\d+)/i`),
     PR #N is removed from the list before Stage 1 review dispatch. An outbox notification is
     appended confirming the skip.

AC3. When `add-pr N` appears in a queued message (matched by `/\badd[- ]pr[\s#]+(\d+)/i`),
     PR #N is added to the list (with Set dedup to prevent duplicates). An outbox notification
     is appended confirming the addition.

AC4. Messages that match no recognized pattern are skipped silently (treated as notes).

AC5. After draining, the cursor in `~/.workrail/message-queue-cursor.json` is updated so
     processed messages are not re-processed on the next coordinator invocation.

AC6. If `~/.workrail/message-queue.jsonl` does not exist (ENOENT), the drain returns a no-op
     result and the coordinator proceeds normally.

AC7. Malformed JSONL lines (unparseable JSON) are skipped without crashing the coordinator.
     A stderr warning is emitted for each skipped malformed line.

AC8. All drain I/O (readFile, appendFile, homedir, joinPath, now, generateId) is injected via
     `CoordinatorDeps`. No direct `fs` imports are added to `pr-review.ts`.

AC9. Unit tests for `drainMessageQueue()` use fake deps (in-memory file map). No real filesystem
     access in tests.

## 3. Non-Goals

- No `reprioritize` message kind in this PR
- No workspace routing (workspaceHint matching) -- all messages are consumed regardless of hint
- No structured `kind` field on `QueuedMessage` (Candidate C) -- that is a follow-up issue
- No truncation or compaction of consumed messages (queue remains append-only)
- No real-time / `--watch` mode
- No multi-coordinator fan-out (single coordinator consumes the queue)
- No integration test (unit tests with fakes are sufficient)

## 4. Philosophy-Driven Constraints

- Errors as data: `drainMessageQueue` returns `DrainResult`, never throws
- All I/O injected: `CoordinatorDeps` gains `readFile` and `appendFile`; zero direct fs imports
- Immutability: `DrainResult` and all new interfaces are fully readonly
- Prefer fakes over mocks: tests use in-memory fake deps
- Validate at boundaries: JSONL parsing, ENOENT, cursor desync handled at the read boundary
- Document WHY: function header explains the cursor pattern and text-matching tradeoff

## 5. Invariants

I1. `message-queue.jsonl` is never written or truncated by the coordinator (append-only)
I2. The coordinator drains the queue BEFORE Stage 1 (PR discovery) -- never mid-agent-run
I3. `stop: true` in `DrainResult` takes absolute precedence; coordinator must check stop before
    acting on `skipPrNumbers` or `addPrNumbers`
I4. The cursor advances only AFTER successful outbox writes (best-effort; cursor write failure
    does not block drain -- same pattern as worktrain-inbox.ts)
I5. ENOENT on message-queue.jsonl = no messages = coordinator proceeds normally (not an error)
I6. Cursor desync guard: if `cursor > totalLines`, reset to 0 (queue was wiped)

## 6. Selected Approach & Rationale

**Selected: Candidate B** -- `drainMessageQueue()` pure function with cursor + text parsing.

**Rationale:** Direct adaptation of the `worktrain-inbox.ts` cursor pattern (already tested, same
`InboxCursor` shape `{ lastReadCount: number }`). Additive to `CoordinatorDeps`. Text parsing is
narrow (`^\\s*stop\\b`) and consistent with how `parseFindingsFromNotes()` works in the same file.

**Runner-up: Candidate C** (structured `kind` field on `QueuedMessage`). Loses because it
requires a schema change to the public CLI interface (`worktrain tell`), which is out of scope.
Filed as a follow-up.

## 7. Vertical Slices

### Slice 1: Extend `CoordinatorDeps` and add `DrainResult` type

**Files:** `src/coordinators/pr-review.ts`

**Work:**
- Add `readFile: (path: string) => Promise<string>` to `CoordinatorDeps`
- Add `appendFile: (path: string, content: string) => Promise<void>` to `CoordinatorDeps`
- Add `mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>` to `CoordinatorDeps`
- Define `DrainResult` interface (readonly: stop, stopReason, skipPrNumbers, addPrNumbers, messagesProcessed)

**Done when:** TypeScript compiles with new interface fields. No runtime behavior change yet.

**Note:** Updating fake deps in `coordinator-pr-review.test.ts` is part of this slice (compile-
time requirement).

---

### Slice 2: Implement `drainMessageQueue()`

**Files:** `src/coordinators/pr-review.ts`

**Work:**
- New exported function `drainMessageQueue(deps, workrailDir)` -- deps is the coordinator deps
  subset; workrailDir defaults to `deps.joinPath(deps.homedir(), '.workrail')`
- Reads `message-queue.jsonl` (ENOENT -> return empty result)
- Reads cursor from `message-queue-cursor.json` (missing/corrupt -> 0)
- Applies cursor desync guard (cursor > totalLines -> reset to 0)
- Parses new lines (slice from cursor), skips malformed with stderr warning
- For each parsed `QueuedMessage`:
  - `^\\s*stop\\b/i` match -> set stop=true, record stopReason=message.message
  - `/\\bskip[- ]pr[\\s#]+([0-9]+)/i` match -> add to skipSet
  - `/\\badd[- ]pr[\\s#]+([0-9]+)/i` match -> add to addSet
  - Otherwise: skip (informational note)
- After processing all new messages:
  - For each actionable message: appendFile to outbox.jsonl with confirmation text
  - Append stderr `[INFO coord:drain kind=... message="..." ts=...]` per actionable message
  - Update cursor file (non-fatal on failure)
- Return `DrainResult`

**Done when:** Function exists, TypeScript compiles, unit tests pass.

---

### Slice 3: Integrate drain into `runPrReviewCoordinator()`

**Files:** `src/coordinators/pr-review.ts`

**Work:**
- Call `drainMessageQueue(deps)` at the top of `runPrReviewCoordinator()` (before Stage 1 log)
- Check `drainResult.stop` immediately:
  - If true: log stop reason, write report (empty/aborted), return early with all zeros
- Apply `drainResult.skipPrNumbers` to remove PRs from the discovered list (after Stage 1)
- Apply `drainResult.addPrNumbers` to add PRs to the list (with Set dedup, before Stage 1)
- Log drain activity: `[drain] processed N messages, skip=[...], add=[...]` if messagesProcessed > 0

**Done when:** Integration passes existing coordinator unit tests + new drain integration test.

---

### Slice 4: Wire new deps in `cli-worktrain.ts`

**Files:** `src/cli-worktrain.ts`

**Work:**
- Add `readFile: (p: string) => fs.promises.readFile(p, 'utf-8')` to CoordinatorDeps wiring
- Add `appendFile: (p: string, content: string) => fs.promises.appendFile(p, content, 'utf-8')`
  to CoordinatorDeps wiring
- Add `mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts)` to
  CoordinatorDeps wiring

**Done when:** `worktrain run pr-review --dry-run` compiles and runs without error.

---

### Slice 5: Unit tests for `drainMessageQueue()`

**Files:** `tests/unit/coordinator-pr-review.test.ts`

**Work:**
- Add `readFile` and `appendFile` to the existing fake CoordinatorDeps helper
- New `describe('drainMessageQueue')` block covering:
  - ENOENT -> returns empty DrainResult (messagesProcessed=0, stop=false)
  - Stop message at start of message text -> stop=true, stopReason set
  - Stop NOT triggered when 'stop' appears mid-sentence ("please stop overthinking" -- note: this
    still fires with `^\\s*stop` since it doesn't start the message; test confirms this is the
    designed behavior)
  - skip-pr with PR number -> skipPrNumbers contains the number
  - add-pr with PR number -> addPrNumbers contains the number
  - Malformed JSONL lines skipped, messagesProcessed counts only valid lines
  - Cursor advances after drain
  - Cursor desync guard resets to 0 when cursor > totalLines
  - Multiple messages: stop takes precedence regardless of order in queue
  - Note-only messages: no action, cursor advances, messagesProcessed = N

**Done when:** All new tests pass; no existing tests broken.

## 8. Test Design

**Strategy:** Fake deps only (in-memory Map for files, Set for dirs). No real filesystem.

**Key test helpers:**
```ts
interface FakeDrainFs {
  files: Map<string, string>;
}

function makeDrainDeps(fs: FakeDrainFs): Pick<CoordinatorDeps, 'readFile' | 'appendFile' | 'mkdir' | 'homedir' | 'joinPath' | 'now' | 'generateId' | 'stderr'>
```

**Critical test cases:**
- `stop` as sole message: stop=true, outbox has triggering text
- `skip-pr 42` after a note: skipPrNumbers=[42], messagesProcessed=2
- Two `skip-pr` for same PR: deduplicated in Set (skipPrNumbers=[42] not [42, 42])
- Cursor = 5, file has 5 lines: messagesProcessed=0 (all previously read)
- Cursor = 10, file has 5 lines: cursor reset to 0, all 5 processed

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `stop` false positive on note message | Low | Medium | `^\\s*stop\\b` anchor; outbox shows triggering text |
| Cursor file write failure | Very Low | Low | Non-fatal; next run re-reads from 0 (desync reset) |
| Outbox write failure during stop | Very Low | Low | Non-fatal; stderr log is backup |
| `readFile`/`appendFile` not wired in cli-worktrain.ts | Low | High | Slice 4 is explicit; TypeScript will catch missing fields at compile time |

## 10. PR Packaging Strategy

Single PR on branch `feat/coordinator-message-queue`. All 5 slices in one PR -- they are
tightly coupled (type change -> function -> integration -> wiring -> tests). Separating them
would create a non-compiling intermediate state.

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| 1 | Immutability by default | Satisfied -- all new fields are readonly |
| 1 | Explicit domain types | Tension -- DrainResult uses boolean stop not a discriminated union; documented |
| 2 | Errors are data | Satisfied -- DrainResult is a value; ENOENT returns empty result |
| 2 | Dependency injection | Satisfied -- all I/O via injected deps |
| 2 | Validate at boundaries | Satisfied -- malformed JSONL skipped at parse boundary |
| 3 | Determinism over cleverness | Satisfied -- same queue + cursor = same result |
| 4 | Compose with small pure functions | Satisfied -- drainMessageQueue is pure at logic level |
| 5 | Prefer fakes over mocks | Satisfied -- fake deps, no vi.mock() |

## 12. Follow-Up Tickets

1. **Add `kind` field to `QueuedMessage` for structured dispatch** (Candidate C) -- unblocks
   automated tooling writing to the message queue without text fragility.
2. **`worktrain tell --help` should list recognized coordinator command patterns** -- discovery
   for users who don't know what command words the coordinator recognizes.

## Summary

- `estimatedPRCount`: 1
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
