# Design Review Findings: `worktrain trigger poll` Command

## Tradeoff Review

| Tradeoff | Status | Notes |
|---|---|---|
| 3-layer thread-through | Acceptable | All 3 signature changes are additive optional params. Backward compat maintained. |
| forcePoll awaits synchronously | Acceptable | Spec requires 200 after completion. Add CLI AbortSignal.timeout(30s). |
| Skip-cycle guard no-ops silently | Needs fix | Surface `cycleRan: boolean` in response body so user knows if cycle ran. |

## Failure Mode Review

| Failure Mode | Coverage | Action |
|---|---|---|
| Daemon console not running | Adequate | ECONNREFUSED -> clear error message |
| Trigger not found | Adequate | 400 response |
| Wrong trigger provider | Adequate | 400 response |
| Poll cycle hangs (GitHub network) | Partial | Add CLI 30s timeout. V1 limitation for cycle itself. |
| Skip-cycle guard fires | Fix needed | Return cycleRan field in response |
| triggerId not in scheduler | Adequate | not_found result -> 400 |

## Runner-Up / Simpler Alternative Review

Candidate B (endpoint on trigger-listener port 3200) has one appealing element: port 3200 default makes natural sense. Rejected because it mixes event-input with control-plane concerns. No hybrid elements worth importing.

No simpler variant satisfies acceptance criteria without violating the established architectural pattern.

## Philosophy Alignment

- **Honored**: DI, errors-as-data, validate-at-boundaries, YAGNI, architectural-fixes-over-patches, exhaustiveness, fakes-over-mocks
- **Under tension (acceptable)**: mutable skip-cycle guard (private impl detail)
- **No conflicts**: all material principles satisfied

## Findings

### Yellow: CLI fetch needs explicit timeout
The CLI POST to daemon console has no AbortSignal.timeout(). If the poll cycle hangs (GitHub network issue), the CLI hangs indefinitely.

**Fix**: Add `signal: AbortSignal.timeout(30_000)` to the CLI fetch call.

### Yellow: Skip-cycle response needs surfacing
If a poll cycle is already running when forcePoll is called, the endpoint returns 200 immediately but the user has no way to know whether a new cycle actually ran.

**Fix**: Return `{ success: true, data: { cycleRan: boolean, message: string } }` in the 200 response. When `cycleRan: false`, include a message like "Poll cycle already in progress - skipped."

## Recommended Revisions

1. `ForcePollResult` type: `{ kind: 'ok'; cycleRan: boolean } | { kind: 'not_found' } | { kind: 'wrong_provider'; provider: string }`
2. HTTP 200 response body: `{ success: true, data: { cycleRan: boolean, triggerId: string } }`
3. CLI fetch: add `signal: AbortSignal.timeout(30_000)`
4. CLI output: print cycleRan status to stdout

## Residual Concerns

- Port default 3200 vs actual endpoint port 3456: resolved by daemon-console.lock discovery in practice. Add clear error message if connection fails on default port.
- `forcePoll` currently uses `runPollCycle` internally which handles the skip guard. The `cycleRan` boolean must be derived from whether `this.polling.get(triggerId)` was false before the call (i.e., a new cycle was actually started). Need to check the guard state BEFORE calling runPollCycle to determine cycleRan.
