# Design Review Findings: Discovery Loop Fix

**Date:** 2026-04-19
**Design reviewed:** Candidate A (exact spec implementation)

---

## Tradeoff Review

| Tradeoff | Assessment | Verdict |
|---|---|---|
| `checkIdempotency` gains TTL behavior | Time-dependent, but TTL is read from file -- no `Date.now()` mock needed in tests | Acceptable |
| `applyGitHubLabel` adds I/O in fire-and-forget callback | Non-fatal, warn logged, does not block cycle | Acceptable |
| Optional 5th param on `spawnSession` | All test fakes use `vi.fn()` without strict param-count assertions | Acceptable |
| Malformed sidecar -> conservative 'active' | Controlled write path; TTL handles cleanup on successful parse | Acceptable |

---

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| GitHub token expired when applying label | Non-fatal (warn), loop could restart | Low -- config error, warn is the signal |
| Sidecar write fails | Dispatch proceeds, Fix 2 label is primary guard | Low |
| Sidecar delete fails | TTL handles cleanup after 56 min | Low |
| Daemon crash between sidecar write and dispatch | Sidecar blocks re-dispatch until TTL expires | Low -- correct behavior |
| Fix 2 deployed without Fix 1 | Single PR strategy eliminates this risk | Mitigated |
| New PipelineOutcome kind in future | If-check safe -- new kinds don't trigger label | Low |

---

## Runner-Up / Simpler Alternative Review

- **Candidate B** (separate sidecar check function): Rejected -- creates coordination risk, no benefit over single function
- **Skip Fix 3**: Cannot satisfy acceptance criteria (sidecar test cases required)
- **No hybrid needed**: Candidate A is already minimal

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Immutability by default | Satisfied -- all new fields `readonly` |
| Type safety | Satisfied -- `Promise<PipelineOutcome>` replaces `Promise<unknown>` |
| Errors are data | Satisfied with acceptable fire-and-forget exception for non-fatal I/O |
| Dependency injection | Satisfied -- `fetchFn` injected |
| Exhaustiveness | Satisfied -- all PipelineOutcome kinds handled |
| YAGNI | Satisfied -- no extra abstractions |

---

## Findings

### Yellow (observe, no change required)

**Y1: `checkIdempotency` JSDoc needs updating**
The function comment currently describes only session file scanning. With sidecar file scanning added, the comment should document the new sidecar file format and TTL behavior. Update the JSDoc before shipping.

**Y2: `applyGitHubLabel` POST body format**
GitHub Labels API `POST /repos/:owner/:repo/issues/:issue_number/labels` requires body `{ "labels": ["label-name"] }`. Verify the implementation sends JSON with `Content-Type: application/json` header.

**Y3: Sidecar delete in .catch() handler**
The `.catch()` handler currently only calls `this.dispatchingIssues.delete(top.issue.number)`. The sidecar delete must also happen in `.catch()` to avoid a stale sidecar when the pipeline promise rejects (not escalates).

---

## Recommended Revisions

1. Update `checkIdempotency` JSDoc to describe sidecar file format and TTL behavior
2. Add `Content-Type: application/json` to `applyGitHubLabel` request headers
3. Ensure sidecar is deleted in BOTH `.then()` and `.catch()` handlers

None of these are blockers -- all are implementation details that can be addressed during coding.

---

## Residual Concerns

- **Token rotation**: If the GitHub token is rotated and the env var is not updated, `applyGitHubLabel` will silently fail. The warn log is the only signal. This is an operational concern, not a code concern.
- **Sidecar file accumulation**: If both `.then()` and `.catch()` fail to delete the sidecar (e.g., permissions issue), sidecars accumulate. They expire naturally after TTL but are never cleaned. Low risk -- cleanup could be added to daemon startup as a follow-on.
