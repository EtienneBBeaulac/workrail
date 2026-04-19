# Design Candidates: Coordinator Message Queue Drain

**Task:** The PR review coordinator never reads `~/.workrail/message-queue.jsonl`, so
messages queued via `worktrain tell` (from phone, terminal, or automation) are silently ignored.
This document captures the design investigation for draining that queue inside the coordinator.

---

## Problem Understanding

### Core tensions

1. **Append-only invariant vs. consumed-message tracking.** The queue file must never be
   truncated or rewritten -- the `worktrain-tell` command's documented invariant. But without
   tracking which messages were processed, the coordinator re-processes the entire history on
   every invocation. A cursor file (same pattern as `inbox-cursor.json`) resolves this cleanly
   but adds a second file to manage.

2. **Stringly-typed messages vs. explicit domain types.** `QueuedMessage.message` is free-form
   text. The repo philosophy demands explicit domain types, but no `kind` field exists in the
   current schema. Text parsing at the coordinator's read boundary is the only option within
   the current schema -- it is not a patch, it is adapting to a pre-existing constraint.

3. **Coordinator statefulness vs. single-pass design.** The coordinator is invoked once per run
   today, not as a persistent loop. A cursor handles both cases correctly: repeat invocations
   see only new messages; a one-time invocation drains everything queued since last run.

4. **`stop` signal semantics vs. partial progress.** A `stop` in the queue must halt before any
   spawn. But `stop` might appear alongside `skip-pr 42` in the same drain batch. `stop` takes
   absolute precedence -- no partial processing, coordinator exits cleanly and writes an outbox
   acknowledgment.

### Likely seam

The real seam is the top of `runPrReviewCoordinator()`, immediately before Stage 1 (PR discovery).
This matches the backlog intent: "coordinator loop checks message-queue at the start of each cycle
before spawning new agents." The coordinator is the right owner, not a shared utility, because
message routing is coordinator-specific logic.

### What makes this hard

Not technically difficult. The risks are:
- Forgetting to handle ENOENT (queue file doesn't exist yet = no messages, not a crash)
- Cursor desync: if the queue is wiped, cursor > total lines; reset to 0 (same guard as `inbox-cursor.json`)
- Text matching fragility: `stop` in "stop overthinking this" triggers coordinator halt

---

## Philosophy Constraints

From `CLAUDE.md` and observed repo patterns:

- **Errors are values, never thrown** -- `pr-review.ts` uses `Result<T, string>` throughout.
  The drain result uses a plain `DrainResult` struct (stop is not an error, it is a valid outcome).
- **All I/O injected via deps** -- new `drainMessageQueue()` must accept deps, not import `fs`.
- **Immutability by default** -- all interface fields are `readonly`.
- **Prefer fakes over mocks** -- tests use in-memory fake deps, no `vi.mock()`.
- **Validate at boundaries, trust inside** -- malformed JSONL lines are skipped at the parse
  boundary; core routing logic trusts parsed data.
- **Document WHY, not WHAT** -- comments explain rationale, not mechanics.

**Conflict:** "Explicit domain types over primitives" is under pressure from the free-form message
text. The mitigation is narrow keyword patterns and clear documentation. This conflict is not
resolved in this PR -- a `kind` field on `QueuedMessage` is the proper fix but changes the
public CLI interface (out of scope here).

---

## Impact Surface

Changes that must stay consistent if this design is implemented:

- **`CoordinatorDeps` interface** in `src/coordinators/pr-review.ts`: gains `readFile` and
  `appendFile`. These are additive -- no existing caller is broken.
- **`cli-worktrain.ts` pr-review action**: must wire `readFile` and `appendFile` into the deps
  object (two new lines in the composition root).
- **`tests/unit/coordinator-pr-review.test.ts`**: every fake `CoordinatorDeps` object needs the
  two new fields. Mechanical but must not be missed.
- **`discoverConsolePort` deps** (mini-subset type): no change needed; it already has `readFile`.

New files introduced on disk (runtime, not source):
- `~/.workrail/message-queue-cursor.json` -- created on first coordinator run after this ships.

---

## Candidates

### Candidate A -- Minimal: full-history drain, no cursor, timestamp filter

**Summary:** On each coordinator run, read all messages in `message-queue.jsonl`, discard messages
older than the coordinator's start time, act on the remainder.

**Tensions resolved:** Simplest change; no new cursor file.

**Tensions accepted:** Stale messages re-processed if clock skew or same-second invocations.
A `stop` message from two days ago can halt a coordinator run today if the clock check is ambiguous.

**Boundary:** Inline in `runPrReviewCoordinator()`, no new function or file.

**Why this boundary is wrong:** The timestamp filter is not reliable enough. Same-second writes,
NTP jumps, or leap-second events can cause a current `stop` to be discarded or a stale `stop` to
fire. The cursor is strictly more correct.

**Failure mode:** Stale `stop` from a previous session kills today's coordinator run. No recovery
path -- the coordinator just exits. Users have to manually inspect the queue to understand why.

**Repo-pattern relationship:** Departs -- `worktrain-inbox.ts` uses a cursor precisely to avoid
the re-processing problem. This candidate ignores the established pattern.

**Gains:** Zero new files.

**Gives up:** Correctness. Behavior depends on queue history, not just current inputs -- violates
"determinism over cleverness."

**Scope judgment:** Too narrow -- solves the immediate symptom but breaks on any real usage.

**Philosophy fit:** Conflicts with "determinism over cleverness." Does not honor "validate at
boundaries" (stale messages leak through).

**Verdict: Rejected.** Stale message re-processing is a correctness bug, not a tradeoff.

---

### Candidate B -- Best-fit: `drainMessageQueue()` with cursor, narrow text parsing

**Summary:** Add a pure function `drainMessageQueue(deps, opts)` to `src/coordinators/pr-review.ts`.
It reads new lines since `~/.workrail/message-queue-cursor.json`, parses message text for `stop` /
`skip-pr N` / `add-pr N` using narrow regex patterns, writes outbox acknowledgments for actionable
messages, advances the cursor. Called at the top of `runPrReviewCoordinator()` before Stage 1.

**Tensions resolved:**
- Append-only invariant respected (cursor tracks progress, queue file never modified)
- Stale message re-processing eliminated by cursor
- ENOENT handled (no queue = empty drain result = coordinator proceeds normally)
- `stop` takes absolute precedence

**Tensions accepted:**
- Text parsing is not type-safe; fragile to natural language variation

**Boundary solved at:** New exported function in `src/coordinators/pr-review.ts`.

**Why this boundary is best-fit:** Message routing is coordinator-specific. The drain reads a
coordinator-managed cursor file and writes outbox notifications -- both are coordinator
responsibilities. Extracting to a shared utility would create coupling without benefit (no other
coordinator exists today).

**Key data structures:**

```ts
export interface DrainResult {
  readonly stop: boolean;
  readonly stopReason: string | null;
  readonly skipPrNumbers: readonly number[];
  readonly addPrNumbers: readonly number[];
  readonly messagesProcessed: number;
}
```

Cursor shape: `{ lastReadCount: number }` -- identical to `InboxCursor` in `worktrain-inbox.ts`.

New `CoordinatorDeps` fields:
```ts
readonly readFile: (path: string) => Promise<string>;
readonly appendFile: (path: string, content: string) => Promise<void>;
```

Parsing patterns:
- stop: `/\bstop\b/i`
- skip-pr: `/\bskip[- ]pr[\s#]+([0-9]+)/i`
- add-pr: `/\badd[- ]pr[\s#]+([0-9]+)/i`

**Failure mode:** A note message like "stop overthinking this" triggers coordinator halt. Mitigation:
word-boundary requirement limits false positives; documented as known behavior with workaround
("add-pr" or "note:" prefix for non-command messages).

**Repo-pattern relationship:** Follows `worktrain-inbox.ts` cursor pattern exactly; follows
`CoordinatorDeps` injection pattern exactly.

**Gains:** Correct deduplication; clean separation; fully testable with fakes.

**Gives up:** Type-safe dispatch. A `kind` field would be cleaner.

**Impact surface:** `CoordinatorDeps` (additive), `cli-worktrain.ts` (2 new dep wires),
`coordinator-pr-review.test.ts` (2 new fake dep fields).

**Scope judgment:** Best-fit.

**Philosophy fit:** Honors immutability (readonly result), DI for boundaries, errors as values,
validate at boundaries. Partial conflict with "explicit domain types" (documented and accepted).

**Verdict: Recommended.**

---

### Candidate C -- Broader: structured `kind` field on `QueuedMessage`

**Summary:** Extend `QueuedMessage` with `readonly kind?: 'stop' | 'skip-pr' | 'add-pr' | 'note'`
and `readonly payload?: Record<string, unknown>`. Update `worktrain-tell.ts` to accept `--kind`
flag. Coordinator drains on `kind` field instead of text parsing.

**Tensions resolved:** Eliminates the stringly-typed tension entirely. Discriminated union on
`kind` makes routing exhaustive and type-safe.

**Tensions accepted:** Schema change affects the public CLI interface. Existing `tell` invocations
omitting `--kind` fall back to `kind: 'note'` (safe), but natural language commands no longer work
(`worktrain tell "stop"` becomes a note, not a stop signal).

**Boundary solved at:** `QueuedMessage` type in `worktrain-tell.ts` + coordinator drain in
`pr-review.ts` + CLI parser in `cli-worktrain.ts`.

**Why this boundary is too broad:** Adds `kind` to `QueuedMessage` -- a public interface change.
The `tell` command is documented as accepting any free-form text. Adding a required semantic field
is a separate design decision that should be preceded by discussion of the CLI UX.

**Failure mode:** Users who currently type `worktrain tell "stop the agent"` find it ignored
unless they learn to use `--kind stop`. The ergonomic regression is silent.

**Repo-pattern relationship:** Honors "explicit domain types" and "make illegal states
unrepresentable" from philosophy. Departs from current free-form-text CLI design.

**Gains:** Type-safe dispatch, no regex fragility, forward-compatible for new action kinds.

**Gives up:** Natural language ergonomics; requires more CLI plumbing.

**Scope judgment:** Too broad for this task.

**Philosophy fit:** Strongly honors explicit domain types, discriminated unions, exhaustiveness.
Conflicts with YAGNI -- adds schema complexity before the feature is proven.

**Verdict: Out of scope for this PR. File a follow-up issue.**

---

## Comparison and Recommendation

| | A (timestamp) | B (cursor + text) | C (structured kind) |
|---|---|---|---|
| Stale message safety | Weak | Strong | Strong |
| Schema change | No | No | Yes |
| Scope fit | Too narrow | Best-fit | Too broad |
| Testability | Full | Full | Full |
| Text-parse fragility | Avoided (no parse) | Narrow regexes | Eliminated |
| Repo-pattern alignment | Poor | Exact | Partial |
| Philosophy fit | Weak | Good (with caveat) | Strong |

**Recommendation: Candidate B.**

Candidate A fails on correctness. Candidate C solves the right problem but changes the wrong
boundary for this task. Candidate B is a direct adaptation of the existing `worktrain-inbox.ts`
cursor pattern to the coordinator context -- it introduces no new architectural ideas, just
applies the established approach.

---

## Self-Critique

**Strongest argument against Candidate B:**

The text-matching approach creates an implicit, undiscoverable API. Users sending messages from
phones have no way to know that `stop` means stop but `halt` does not. There is no help text,
no validation, no error message for unrecognized commands. This is a real UX problem.

**What would tip the decision toward Candidate C:**

Evidence that multiple clients (mobile app, automation scripts) need to send structured commands.
At that point, the text-parsing approach becomes a reliability liability. The right test: if
a second coordinator (e.g., a work-queue coordinator) also needs to consume the message queue,
Candidate C's structured dispatch becomes clearly necessary.

**Invalidating assumption:**

Candidate B assumes the word-boundary `stop` regex is specific enough. If users commonly type
messages like "stop worrying and trust the process" via phone, the stop regex will fire. Mitigation:
require the stop keyword to appear as the first meaningful token in the message, or require a
command prefix (e.g., `/stop`). This can be tightened without changing the architecture.

---

## Open Questions for the Main Agent

1. Should the drain function write an outbox notification for every actionable message, or only
   for `stop` (where the coordinator is halting and the user needs confirmation)? Suggested:
   write for all actionable messages (stop, skip-pr, add-pr) to close the feedback loop.

2. The `stop` signal exits cleanly -- should the coordinator report which messages caused the
   stop in its final report? Suggested: yes, log the message text and timestamp in the run log.

3. Should `add-pr` messages add new PRs to the list before or after deduplication? Suggested:
   add them to `prs` before Stage 1 begins, guarding against duplicates with a Set.
