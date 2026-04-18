# Design Review Findings: PR Review Coordinator

*Review completed: 2026-04-18*

## Tradeoff Review

| Tradeoff | Verdict | Conditions for Failure |
|----------|---------|------------------------|
| Port discovery duplicated from worktrain-spawn.ts | Acceptable | Lock file names change (low risk, bounded) |
| Two-tier parser is heuristic | Acceptable for MVP | False escalation rate > 20% of clean PRs |
| Fix-agent loop max 3 passes | Acceptable | If 3 passes is too few for real codebases (tunable) |

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|-------------|----------|------|
| null recapMarkdown -> unknown -> escalate | Full | Low -- conservative, correct |
| Fix loop 3 passes, persistent minor -> escalate | Full | Low |
| ECONNREFUSED -> clear error exit | Partial (needs timeout) | Low |
| Keyword false positive -> false escalation | Partial (needs negation check) | Medium |
| gh pr merge failure -> escalate without retry | Full | Low |
| Zombie session (null childSessionId) | Full | Low |

## Runner-Up / Simpler Alternative Review

Candidate A (subprocess model) has nothing worth borrowing. No beneficial hybrid exists. Candidate B is the correct shape. One naming improvement identified: `postResult` -> `writeFile(path, content)` for clarity.

## Philosophy Alignment

- All 8 CLAUDE.md principles satisfied
- Two minor tensions: mutable loop counter (acceptable, local), two-tier parser as patch (acceptable, follow-up filed)

---

## Findings

### ORANGE: Keyword false positive risk -- negation context not handled

The keyword scanner will match `BLOCKING` in contexts like 'this is not technically blocking'. This is the most likely source of false escalations in practice.

**Recommended revision:** Before returning `'blocking'`, check that the `BLOCKING` keyword is not preceded by a negation within ~30 chars: `/\b(?:not|no|without)\b.{0,30}\bblocking\b/i` -> if this matches, do not classify as blocking. Apply same check to CRITICAL.

### ORANGE: No fetch timeout on HTTP calls

`spawnSession()` and `getAgentResult()` use bare `fetch()` with no timeout. If the daemon is running but unresponsive, the coordinator hangs indefinitely.

**Recommended revision:** Add `AbortSignal.timeout(30_000)` to all dispatch and session/node fetch calls. Catch `AbortError` and return `err('Daemon request timed out after 30s')`.

### YELLOW: `postResult` dep name is unclear

The `postResult(notes: string)` name is ambiguous -- does it post to Slack? Write to a file? Create a GitHub comment?

**Recommended revision:** Rename to `writeFile(path: string, content: string): Promise<void>`. The coordinator decides the report file path. This matches the UX spec: `Full report: ./coordinator-pr-review-2026-04-18.md`.

### YELLOW: Rule 3 adaptation not explicit in original 5 robustness rules spec

The original Rule 3 (go/no-go time check) was designed for daemon sessions with known `maxSessionMinutes`. The CLI coordinator has no such parameter.

**Recommended revision:** Explicit Rule 3 adaptation: `const coordinatorStartMs = deps.now()` at startup; before each `spawnSession()` call, check `deps.now() - coordinatorStartMs > 70 * 60 * 1000` (70 min = 90 min coordinator max - 20 min buffer) and refuse to spawn if exceeded.

---

## Recommended Revisions

1. Add negation context check in keyword parser (`/\b(?:not|no|without)\b.{0,30}\bblocking\b/i`)
2. Add `AbortSignal.timeout(30_000)` to fetch calls
3. Rename `postResult` to `writeFile(path, content)`
4. Add explicit wall-clock Rule 3 adaptation to implementation spec

## Residual Concerns

- The two-tier parser's keyword scan is a heuristic. False escalation rate unknown until tested against real mr-review outputs. Follow-up: update mr-review-workflow to emit `## COORDINATOR_OUTPUT` JSON block.
- The coordinator's own timeout (90 minutes) is hardcoded. Should be configurable via `--max-runtime` flag if needed. Not for MVP.
