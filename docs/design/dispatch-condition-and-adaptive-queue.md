# Design: dispatchCondition Filter and Adaptive Queue Routing

## Problem Understanding

### Tensions

1. **Silent skip vs new API surface**: When `dispatchCondition` is not met, the HTTP caller already received a 202 response. Adding a new `_tag: 'skipped'` to `RouteResult` would require HTTP handler changes (the 202 was already sent). Reusing `{ _tag: 'enqueued' }` preserves the existing API contract with zero surface change. Observability is provided via a log line.

2. **Backward compat vs clean schema for `workflowId` on queue triggers**: `workflowId: string` is required in `TriggerDefinition`. Making it optional (`string | undefined`) would cascade to all callers: `dispatch()` queue key, `maybeRunDelivery()` attribution, `WorkflowTrigger.workflowId`. Using a `''` sentinel keeps the interface unchanged while allowing queue poll triggers to omit `workflowId` in YAML.

3. **Type guard vs hard failure for `dispatchAdaptivePipeline`**: The existing type-guard pattern (`'dispatchAdaptivePipeline' in this.router`) allows test fakes that only implement `dispatch()`. The new requirement is to throw when `dispatchAdaptivePipeline` is unavailable. This changes a soft-fallback to a hard failure -- intentional for production correctness.

4. **Validate at boundary vs trust inside**: `dispatchCondition.payloadPath` and `dispatchCondition.equals` must both be validated as present strings at parse time (trigger-store.ts), not at dispatch time (trigger-router.ts). This follows the existing pattern for all parsed fields.

### Likely Seam

- **`dispatchCondition` check**: `route()` in trigger-router.ts, after HMAC validation, before context mapping. This is the correct seam -- HMAC validates authenticity, then condition gates dispatch, then context mapping applies to trusted+relevant payloads.
- **Adaptive routing**: `doPollGitHubQueue()` in polling-scheduler.ts. The queue poller owns the process and calls the coordinator as a function.

### What Makes It Hard

- `extractDotPath()` in trigger-router.ts is a private module function -- but `dispatchCondition` check is in the same file, so it's directly accessible.
- The YAML parser's sub-object block handling requires adding `dispatchCondition` as a named key case BEFORE the `if (rawValue === '')` early-skip falls through. If we miss this, `dispatchCondition:` (empty value) silently skips the block.
- `workflowId` required-field check runs before provider validation in `validateAndResolveTrigger`. Must restructure slightly to skip `workflowId` check for `github_queue_poll`.

## Philosophy Constraints

**Honored:**
- Immutability by default -- new `dispatchCondition` fields are `readonly`
- Validate at boundaries -- `payloadPath` and `equals` validated at parse time in trigger-store.ts
- YAGNI with discipline -- equals-only MVP, no regex/AND/OR
- Exhaustiveness -- no new `RouteResult` variants (reuse `enqueued`)
- Document 'why' -- comments explain the skip behavior and the backward-compat warning

**Conflict:**
- 'Errors are data' vs throw for missing `dispatchAdaptivePipeline`: the spec explicitly requires a throw rather than returning a Result. Rationale: misconfiguration at construction time is a programmer error, not a domain error. Spec overrides philosophy here.

## Impact Surface

- `TriggerDefinition` (types.ts): new optional field, no breaking change
- `ParsedTriggerRaw` (trigger-store.ts): new `dispatchCondition` sub-object, YAML block parser, validation
- `route()` (trigger-router.ts): new `dispatchCondition` check after HMAC
- `doPollGitHubQueue()` (polling-scheduler.ts): removes type-guard fallback
- Tests: new tests in trigger-router.test.ts and polling-scheduler.test.ts
- **Not affected**: `src/mcp/`, `WorkflowTrigger`, `RouteResult` type shape (same variants), `maybeRunDelivery`

## Candidates

### Candidate 1: Exact Spec Implementation (Selected)

**Summary:** Add `dispatchCondition` as a sub-object block in trigger-store.ts (following `agentConfig` pattern), check in `route()` after HMAC using existing `extractDotPath()`, use `''` sentinel for `workflowId` in queue poll, throw Error in `doPollGitHubQueue` when `dispatchAdaptivePipeline` unavailable.

**Tensions resolved:** Silent skip (enqueued tag reuse), backward compat (no interface change), scope control (4 files only).

**Tensions accepted:** Slight looseness from `''` sentinel (not a true optional), philosophy conflict on throw vs Result.

**Boundary:** All 4 trigger files. No cross-file interface changes.

**Why best-fit:** `WorkflowTrigger.workflowId` is also `string` (required), so making `TriggerDefinition.workflowId` optional would cascade to `WorkflowTrigger` and all builders. Queue poll never uses `workflowId` in its dispatch path (calls `dispatchAdaptivePipeline(goal, workspace, context)` directly), so the sentinel has zero runtime impact.

**Failure mode:** `''` sentinel leaks into delivery logs if queue poll somehow runs `maybeRunDelivery`. Mitigated: queue triggers don't set `autoCommit: true` and `maybeRunDelivery` gates on `result._tag === 'success'` from `runWorkflowFn`, which is never called for queue poll (adaptive coordinator handles dispatch).

**Repo pattern:** Follows `agentConfig` block parsing exactly. Follows `validateHmac` early-return pattern. Adapts `dispatchAdaptivePipeline` Option B design.

**Gains:** Minimal blast radius, zero interface churn, backward compatible.

**Gives up:** Type-level optionality for `workflowId` in queue triggers.

**Scope:** Best-fit -- 4 files, no cascades.

**Philosophy:** Honors immutability, validate at boundaries, YAGNI. One conflict: throw vs Result (spec overrides).

---

### Candidate 2: `workflowId?: string` Optional in TriggerDefinition (Rejected)

**Summary:** Make `workflowId` optional at the type level, handle `undefined` at all callsites.

**Rejected because:** Cascades to `WorkflowTrigger.workflowId` (also required), `dispatch()` queue key, `maybeRunDelivery` attribution, all three `build*WorkflowTrigger` helpers. Unnecessary churn for a field that is simply unused in the queue poll path. Scope is too broad.

## Comparison and Recommendation

Candidate 1 is the clear winner. Candidate 2 is too broad. No other candidates are meaningfully different.

**Recommendation: Candidate 1.**

## Self-Critique

**Strongest counter-argument:** The `''` sentinel is an implicit contract. A future developer reading `trigger.workflowId === ''` in a log won't know it means 'queue poll, adaptive routing'. A comment in the code mitigates this.

**Pivot conditions:**
- If a future feature needs to dispatch queue poll triggers to specific workflows (not just adaptive), `workflowId` would become meaningful again. At that point, add explicit support rather than reactivating the ignored field.
- If `WorkflowTrigger.workflowId` becomes optional in a future refactor, revisit making `TriggerDefinition.workflowId` optional too.

## Open Questions for the Main Agent

None. The spec is fully prescriptive. The only implementation decision (sentinel vs optional) is resolved above.
