# Performance Fixes: Design Review Findings

## Tradeoff Review

| Tradeoff | Verdict | Notes |
|---|---|---|
| Lazy TTL eviction (write-only) | Acceptable | Issue #241 explicitly allows lazy eviction. Roots not written again persist, but this is a known, bounded edge case. |
| Non-deterministic intermediate state during parallel scan | Acceptable | Resolved by final `files.sort()` -- stable lexicographic order. No caller asserts insertion order. |
| 10s walk timeout may be tight on slow FS | Acceptable | 30s cache means only first cold call is at risk. Error is descriptive, not silent. Constant is easy to raise. |

## Failure Mode Review

| Failure Mode | Coverage | Residual Risk |
|---|---|---|
| Order dependency in callers after parallelization | Covered by sort | Low |
| Walk timeout fires on first cold call | Descriptive error, user recovers | Medium (UX degradation, not data loss) |
| TTL eviction false positive (active root evicted) | Impossible at 30-day TTL | None |
| Latency test flakiness (cache interference) | Mitigated: unique temp dir per test run | Low |

## Runner-Up / Simpler Alternative Review

No runner-up elements worth pulling. No simpler alternative satisfies all acceptance criteria.
All four Candidate A approaches remain unchanged.

## Philosophy Alignment

All key principles satisfied: Determinism (via sort), Errors are data (ResultAsync.fromPromise
wrapping), Immutability (new arrays), YAGNI (named constants), Prefer fakes over mocks (real FS
in test), Architectural fixes over patches (parallelization, timeout).

Two minor tensions:
- `files[]` shared append in parallel scan: acceptable in single-threaded Node.js
- Timeout inside utility function vs. handler boundary: acceptable -- shared module IS the discovery boundary

## Findings

**Yellow: Walk timeout constant (10s) has no empirical basis**
- DISCOVERY_TIMEOUT_MS = 10_000 is a reasonable default but untested against real environments
- Should be commented as adjustable, not hardcoded as final
- No blocking concern for this PR; monitor in production

**Yellow: Latency test timing assertion (500ms) is generous for a small tree but may pass vacuously**
- A 500ms budget for a depth-5 breadth-3 tree (max ~243 dirs) should complete in ~10-50ms
- The test is more valuable as a non-regression guard than a strict budget test
- Document the budget reasoning in the test comment

No Red or Orange findings.

## Recommended Revisions

1. Add a comment near `DISCOVERY_TIMEOUT_MS` explaining it can be raised for slow NFS environments
2. Add a comment in the latency test explaining the 500ms budget and tree size rationale
3. Use a unique temp dir per test invocation (already in plan) to prevent walk cache interference

## Residual Concerns

- **Walk timeout vs. UX**: if production walk times are measured and commonly > 10s, the constant
  should be raised to 20s. No action needed now.
- **TTL eviction completeness**: roots that are never written again persist forever. Acceptable
  per issue #241. If this becomes a problem, a separate `evictStaleRoots()` method would be the
  right extension point.
