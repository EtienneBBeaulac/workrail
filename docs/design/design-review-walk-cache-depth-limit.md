# Design Review: Walk Cache, Depth Limit, Skip Dirs, Graceful Degradation

## Tradeoff Review

| Tradeoff | Acceptable? | Conditions for Failure |
|---|---|---|
| Non-cancelling timeout | Yes | Would fail if depth limit + skip dirs didn't bound the walk; they do |
| Module-level mutable Map cache | Yes | Would fail if Node.js were multi-threaded; it is not |
| 30s staleness window | Yes | Would fail if users frequently create/delete .workrail dirs within 30s; unlikely |
| listRememberedRoots returning [] | Yes | Acceptable because callers cannot recover from throws anyway |

## Failure Mode Review

| Failure Mode | Mitigation | Risk Level |
|---|---|---|
| Depth guard at wrong position | Test #8 (depth boundary) catches it | Low (test-covered) |
| Cache key collision | `path.resolve` + sort + `\0` separator prevents it | Low |
| Timeout error propagating out | try/catch inside `createWorkflowReaderForRequest` | Low |
| withTimeout import path in request-workflow-reader.ts | Import as `./with-timeout.js` (same shared/ dir) | Low |
| Existing tests poisoning cache | Unique mkdtempSync paths = different cache keys; afterEach clears | Low |

## Runner-Up / Simpler Alternative Review

No real runner-up. The spec fully prescribes the implementation. The selected design is already the simplest approach that satisfies all acceptance criteria.

## Philosophy Alignment

**Satisfied:** Errors are data, immutability (Set), document-why, validate-at-boundaries, compose with small pure functions, YAGNI.

**Tensions:**
- Module-level mutable Map: acceptable -- mutation is confined and `clearWalkCacheForTesting()` makes the boundary explicit
- Time-dependent TTL behavior: acceptable -- documented and short

## Findings

**Yellow (advisory):**
1. The depth guard MUST be placed INSIDE the loop, AFTER the `.workrail` entry check, BEFORE the recursive call. Placing it at the top of the function would miss `.workrail` entries at exactly depth 5. This is the highest-risk implementation detail.
2. The timeout try/catch must wrap ONLY the `discoverRootedWorkflowDirectories` call, not the entire `createWorkflowReaderForRequest` function body.

**No Red or Orange findings.** The design is straightforward and well-bounded.

## Recommended Revisions

None. Proceed with implementation as planned.

## Residual Concerns

- The background walk after timeout could theoretically consume file handles on very large repos with many remembered roots. The depth limit and skip dirs list mitigate this significantly. Not a concern in practice for the expected workload.
