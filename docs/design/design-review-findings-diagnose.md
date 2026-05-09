# Design Review Findings: worktrain diagnose

**Selected direction:** New `worktrain diagnose <sessionId>` command (Pull-Based Failure Card)
**Date:** 2026-05-09

---

## Tradeoff Review

| Tradeoff | Holds? | Condition for failure |
|---|---|---|
| New command = operator must learn `worktrain diagnose` | Yes | Only fails if many operators have `health` hardcoded in scripts -- single operator deployment, cost near-zero |
| Classification is field-reading, value is output format | Yes | Fails if `detail` field string format changes between engine versions silently |
| Extensibility is better foundation, not plug-and-play | Yes | Fails if quality inspection or aggregate view is the immediate next need after diagnose ships |

**Hidden assumption surfaced:** `worktrain health` redirect must ship alongside `diagnose`, not be deferred.

---

## Failure Mode Review

| Failure mode | Handled? | Mitigation needed |
|---|---|---|
| Orphaned/crash sessions (no session_completed, 20% of real sessions) | Requires explicit branch | Show all collected metrics + distinguish `session_aborted` (graceful stop) from no-terminal-event (crash/orphan) |
| 200-char truncation on detail field | Acceptable for dominant categories | Add `(truncated -- see conversation log for full error)` note for edge cases |
| Suggested-fix mapping fallthrough for unknown categories | Requires explicit default | Print raw session_completed line + "No automated fix suggestion available for this failure type." |

**Highest-risk failure mode:** Orphaned/crash (FM1). Most common unhandled case; produces misleading "unknown" output if not handled explicitly. Must not be deferred.

---

## Runner-Up / Simpler Alternative Review

**Best hybrid found:** `worktrain health <id>` silently delegates to `parseDaemonEvents()` when session is not in today's log, outputting a failure card instead of a health summary. Removes two-command confusion entirely. No redirect text needed. Adopted into the design.

**Simpler variant (skip suggested-fix layer):** Drops P2 30-second path criterion. Not worth it -- the fix mapping is the core P2 value.

**C1 strength borrowed:** Always show the full metrics block (turns, tool calls, step advances, duration) regardless of whether a category was determined. The category + suggested-fix is additive, not a replacement.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Errors are data / validate at boundaries | Satisfied -- failure card converts raw events to typed diagnostic data at boundary |
| Functional core, imperative shell | Satisfied -- `parseDaemonEvents()` is pure; CLI is the shell |
| YAGNI with discipline | Satisfied -- push-based auto-write and aggregate view deferred with clear seams |
| Make illegal states unrepresentable | Tension -- `detail` field is an opaque string; category detection is string-matching, not compile-time exhaustive |
| Single source of state truth | Satisfied -- reads one source per session |

**Tension:** `detail` string-matching is the price of a string-serialized event log. Acceptable; mitigated by explicit default fallback and unit tests per category.

---

## Findings

**RED -- Must fix before implementation:**

None. No blocking issues.

**ORANGE -- Must address in implementation:**

1. **Orphaned/crash handling is required, not optional.** 20% of real sessions have no `session_completed`. The design must explicitly handle this with two sub-cases: `session_aborted` (daemon graceful stop) and no-terminal-event (crash/orphan). A generic "unknown" card for 20% of sessions is a significant usability failure.

2. **Health command hybrid delegation must ship with diagnose.** If `worktrain health` continues to return "No events today" for prior-day sessions, operators have no discovery path to `worktrain diagnose`. The hybrid (health delegates to parseDaemonEvents for cross-day sessions) must be part of the same implementation pass.

**YELLOW -- Address in implementation, not blocking:**

3. **detail string-matching needs a stable contract.** Document which `detail` field strings each failure category maps to. If the engine changes the format of these strings, category detection silently breaks. One-time: add a unit test that asserts the expected string patterns against the current WorkflowRunResult union.

4. **Suggested-fix mapping needs an explicit fallback.** Any new failure category added without a corresponding suggested-fix entry should print the raw session_completed event, not silently produce a blank fix field.

---

## Recommended Revisions to Selected Design

1. Add explicit orphaned/crash handling (ORANGE 1): two sub-cases in the failure card output
2. Scope the implementation to include the health command hybrid delegation (ORANGE 2)
3. Document `detail` string patterns for each failure category and add unit test assertions (YELLOW 3)
4. Add explicit default fallback to the suggested-fix mapping (YELLOW 4)

---

## Residual Concerns

- Conversation log is not read by this design. For stuck/repeated_tool_call cases, the exact bash command that repeated is in `agent_stuck.argsSummary` (200-char truncated). If the command is long and the truncation cuts the meaningful part, the diagnosis is incomplete. Mitigated by: showing the full argsSummary and noting truncation. Full conversation log support can be added as `--deep` flag.
- The aggregate fleet view (Candidate 3) is deferred. If the operator's first question after deploying diagnose is "which workflow is failing most?", they still have no answer. Recommend building Candidate 3 in the same sprint as a companion command.
