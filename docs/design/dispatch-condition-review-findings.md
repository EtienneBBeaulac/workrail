# Design Review Findings: dispatchCondition and Adaptive Queue

## Tradeoff Review

All four accepted tradeoffs verified as safe:
1. **Silent skip (`{ _tag: 'enqueued' }`)**: HTTP 202 already sent before route() evaluates. trigger-listener.ts maps enqueued -> 202 unconditionally. Log line provides observability. No breaking change.
2. **`workflowId: ''` sentinel**: Never forwarded in adaptive dispatch path (only goal/workspace/context passed to dispatchAdaptivePipeline). No delivery path runs for queue poll.
3. **Throw for missing `dispatchAdaptivePipeline`**: Caught by runPollCycle try/catch (lines 186-196), converted to console.warn. Not a daemon crash.
4. **YAML sub-object block for `dispatchCondition`**: Handled before the `rawValue === ''` early-skip, following exact `agentConfig` pattern.

## Failure Mode Review

| Failure Mode | Status | Notes |
|---|---|---|
| YAML parser misses dispatchCondition block | Handled | Add key case before rawValue === '' check |
| dispatchCondition on polling trigger | Non-issue | route() never called for polling triggers |
| workflowId sentinel leaks to delivery | Handled | Delivery only runs from route() path |
| Throw crashes daemon | Handled | Caught by runPollCycle try/catch |
| **FM5: Strict equals comparison** | **Requires fix** | Must use `extracted === equals` (strict), not `String(extracted) === equals` |

## Runner-Up / Simpler Alternative Review

- Candidate 2 (optional workflowId): no elements worth borrowing. Blast radius unjustified.
- Simpler flat-field alternative: rejected -- spec explicitly shows sub-object YAML format.
- No hybrid improvements beyond FM5 correction.

## Philosophy Alignment

**Satisfied:** Immutability, validate at boundaries, YAGNI, compose with small functions, exhaustiveness.

**Acceptable tensions:**
- 'Errors as data' vs throw: covered by try/catch in runPollCycle; represents programmer error not domain error.
- Illegal states vs workflowId sentinel: never read in queue poll dispatch path.

## Findings

### YELLOW: FM5 -- Strict Equals Comparison

The spec says 'strictly equals this string'. The naive implementation might use `String(extractDotPath(...)) === condition.equals` which would cause type coercion (number 42 matches string '42'). Must use strict identity: `extracted === condition.equals`.

**Impact:** Behavioral correctness -- wrong values could trigger dispatch (if payload has numeric field and equals is its string representation).

**Fix:** Implement as `const extracted = extractDotPath(payload, condition.payloadPath); return extracted === condition.equals` (strict identity, no coercion).

### YELLOW: workflowId Sentinel Comment

The `''` sentinel for queue poll `workflowId` is an implicit contract. A comment is needed at the parse site explaining why it's safe.

**Impact:** Maintainability -- future developer may not understand why `''` is accepted.

**Fix:** Add comment: `// workflowId is intentionally '' for github_queue_poll -- the adaptive coordinator determines the pipeline. This field is never used in queue poll dispatch.`

## Recommended Revisions

1. Use `extracted === condition.equals` (not `String(extracted) === condition.equals`) in route()
2. Add comment at workflowId sentinel assignment in trigger-store.ts
3. Update existing queue poll test fake in polling-scheduler.test.ts to include `dispatchAdaptivePipeline` method

## Residual Concerns

None blocking. Both findings are Yellow (implementation corrections, not design flaws). The design is sound.
