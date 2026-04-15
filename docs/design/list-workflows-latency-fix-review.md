# list_workflows Latency Fix -- Design Review Findings

## Tradeoff Review

| Tradeoff | Safe? | Condition for failure | Hidden assumption |
|---|---|---|---|
| Module-level mutable Map | Yes | Would fail with concurrent writes -- not possible in single-threaded Node.js | Module loaded once per process (true for Node.js ESM/CJS) |
| 30s staleness window | Yes | Explicitly specified in acceptance criteria; self-healing | Roots list change within TTL causes cache miss automatically (new key = cache miss) |
| Depth limit of 5 | Yes | `.workrail` nested > 5 levels deep -- no real-world evidence | `.workrail` is always near the top of a project tree by convention |

## Failure Mode Review

| Failure mode | Handled? | Missing mitigation | Danger |
|---|---|---|---|
| `.workrail` at depth > 5 | No (silently missed) | Optional: log when depth limit hit | Low -- no real-world evidence of this pattern |
| 30s staleness for new `.workrail` dir | Yes (self-heals) | Optional: expose `invalidateWalkCache()` | Low -- edge case scenario |
| Skip list misses large dir | Depth limit backstop | None needed | Low -- two independent mitigations |
| Cache key collision | Not possible | None needed | None |

## Runner-Up / Simpler Alternative Review

- **Runner-up (B: no cache)**: the only difference is absence of cache -- a weakness, not a strength. Nothing to borrow.
- **Simpler (skip list + cache, no depth)**: saves 4 lines but removes depth safety net. Not worth it.
- **Hybrid**: no uncomfortable tradeoff to resolve. Candidate C stands.

## Philosophy Alignment

| Principle | Status |
|---|---|
| Determinism over cleverness | Satisfied -- sorted cache key, stable behavior |
| Compose with small pure functions | Satisfied -- each function stays focused |
| YAGNI with discipline | Satisfied -- TTL-only, no persistent cache |
| Architectural fixes over patches | Satisfied -- structural constraints changed |
| Immutability by default | Tension -- module-level Map is mutable; acceptable, confined behind pure interface |
| Dependency injection for boundaries | Tension -- `Date.now()` not injected; acceptable, unique per-test keys prevent leakage |

## Findings

### Yellow: Mutable module-level cache
The module-level `Map` is the only mutable state in the file. Acceptable given Node.js single-threaded execution and confinement behind the public functional interface. Not a blocking concern.

### Yellow: Injected clock not used
`Date.now()` is called directly in the cache check. Tests work correctly without fake clocks because each test uses unique temp dir paths. If future tests need to verify TTL expiry behavior, they would need to restructure the test rather than inject a clock. Document this as a known limitation in the code comment.

## Recommended Revisions

None required. The design satisfies all acceptance criteria without revision.

Optional improvements (low priority):
- Add a debug log when depth limit is reached (helps diagnose missed `.workrail` dirs in exotic repos)
- Export `clearWalkCache()` for testing TTL expiry behavior (not needed for current test suite)

## Residual Concerns

None blocking. The 30s staleness window is the most user-visible issue but is explicitly specified in the acceptance criteria and self-heals.
