# Design Review Findings: Coordinator Message Queue Drain

**Design reviewed:** Candidate B from `coordinator-message-queue-drain.md`
(drainMessageQueue with cursor + text parsing)

---

## Tradeoff Review

### T1: Stringly-typed dispatch (free-form text parsing)

Accepted tradeoff. The `^\\s*stop\\b/i` anchor pattern is narrower than bare `stop` matching
and covers realistic CLI usage. The risk of false-positive halt is real but diagnosable -- the
outbox notification includes the triggering message text. Condition for no longer acceptable:
automated tooling writing to the queue. Explicitly documented as a pivot trigger for Candidate C.

### T2: New cursor file on disk

Fully acceptable. Same format as `InboxCursor`; desync guard handles truncation; write failure
is non-fatal. No new schema maintenance burden.

### T3: Outbox notifications for all actionable messages

Fully acceptable. Outbox write failure is non-fatal; stderr provides a backup diagnostic.
Including notifications for all actions (not just `stop`) is the right call -- users need the
feedback loop.

---

## Failure Mode Review

| FM | Description | Mitigation | Residual risk |
|---|---|---|---|
| FM1 | `stop` fires on note message | `^\\s*stop\\b` anchor; outbox shows triggering text | Low -- diagnosable and recoverable |
| FM2 | Cursor desync after queue wipe | Reset to 0 if cursor > totalLines | Low -- re-triggers past stop if present; outbox makes it visible |
| FM3 | Duplicate add-pr | Set dedup before Stage 1 | None |
| FM4 | Outbox write failure during stop | Non-fatal; stderr fallback | None -- stop still honored |
| FM5 | ENOENT (no queue file) | Return empty DrainResult | None -- expected on fresh install |

**Highest-risk failure mode:** FM1. Must include triggering message text and timestamp in the
outbox notification and stderr log -- this is a required implementation detail, not optional.

---

## Runner-Up / Simpler Alternative Review

**Candidate C strengths borrowed:** Structured parse result logged to stderr (`[INFO drain:kind=stop
message=...]`) -- same diagnostic value as a `kind` field at zero schema cost.

**Simpler variant (skip outbox notifications):** Rejected -- silent halt is a UX regression.

**Simpler variant (skip `add-pr`):** Viable as a scope reduction. Included in this PR because the
implementation cost is ~10 lines, and `skip-pr` without `add-pr` is asymmetric.

---

## Philosophy Alignment

**Clearly satisfied:** Immutability, errors as values, DI, validate at boundaries, determinism,
fakes over mocks, small pure functions, document WHY.

**Under tension:**
- "Explicit domain types over primitives" -- free-form text dispatch. Acceptable: pre-existing
  schema constraint, documented as follow-up.
- "Make illegal states unrepresentable" -- `DrainResult` can represent `stop: true` with
  non-empty `skipPrNumbers`. Acceptable: `stop` check is first at call site; documented.

---

## Findings

### YELLOW: `stop` regex false-positive on note messages

The `^\\s*stop\\b/i` pattern is significantly better than bare `stop` matching, but it will still
fire on a message like "stop and think about this before merging." No additional regex constraint
is practical without excluding valid stop forms. The mitigation (outbox + stderr with triggering
message text) is the correct and sufficient response.

**Recommended revision:** None to the pattern itself. Ensure the outbox notification reads:
`WorkTrain coordinator stopped by queued message: "[full message text]" (queued at [timestamp])`
rather than a generic "coordinator stopped" message.

### YELLOW: `DrainResult` allows `stop: true` + non-empty `skipPrNumbers`

The call site must check `stop` before anything else. If a future maintainer adds code between
the drain call and the `stop` check, or moves the check, the skip/add arrays could be acted on
before the stop is honored.

**Recommended revision:** Add a JSDoc invariant on `DrainResult`: "When `stop` is true, all
other fields are informational only. The coordinator MUST honor `stop` before inspecting
`skipPrNumbers` or `addPrNumbers`." Also add a comment at the call site.

### YELLOW (minor): No structured parse log to stderr

Without logging which pattern matched and for which message, diagnosing unexpected behavior
requires reading the outbox. A one-line stderr log per actionable message helps during
development and debugging.

**Recommended revision:** For each actionable message (stop, skip-pr, add-pr), emit:
`[INFO coord:drain kind=stop handle=... message="..." ts=...]` to `deps.stderr`.

---

## Recommended Revisions (summary)

1. Outbox notification for `stop` must include the full triggering message text and timestamp.
2. Add JSDoc invariant on `DrainResult` documenting that `stop: true` takes absolute precedence.
3. Add a `[INFO coord:drain]` stderr log line for each actionable message (diagnostics).

None of these revisions change the architecture. All are implementation-level details.

---

## Residual Concerns

1. **Schema follow-up not filed yet.** A GitHub issue or backlog entry for adding a `kind`
   field to `QueuedMessage` (Candidate C path) should be created as part of this PR.
2. **No integration test.** Unit tests with fake deps are sufficient for the drain logic, but
   an end-to-end test (write to real queue file, run coordinator, verify outbox) is not planned.
   This is acceptable for a developer CLI tool.
