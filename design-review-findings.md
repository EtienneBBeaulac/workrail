# Design Review Findings: WorkRail Auto Task Input MVP

**Date:** 2026-04-14
**Status:** Ready for main-agent

---

## Tradeoff Review

| Tradeoff | Status | Condition for Failure |
|---|---|---|
| TriggerRouter has 2 responsibilities | Acceptable | Only fails if class grows to 5+ divergent methods |
| mountConsoleRoutes accepts full TriggerRouter | Acceptable | Only fails if console-routes tests mock TriggerRouter (none exist) |
| WorkflowTrigger extended with optional fields | Acceptable | Only fails if tests assert exact shape (none do) |
| onComplete warning-only | Acceptable | Correctly matches task spec |

All tradeoffs pass review.

---

## Failure Mode Review

| Failure Mode | Design Coverage | Risk |
|---|---|---|
| Missing express.json() for POST route | Use inline middleware on POST route only | Low |
| Null router in console-routes returning 500 | Explicit guard returning 503 | Low |
| YAML parser indent off-by-one for agentConfig | Copy exact pattern from contextMapping block (trigger-store.ts:234-266) | Medium |
| goalTemplate partial interpolation | Short-circuit on first missing token, fall back to static goal | Low |
| sessionId not available at dispatch time | Return `{ status: 'dispatched' }` -- ORANGE finding below | ORANGE |

---

## Runner-Up / Simpler Alternative Review

- Runner-up (AutoDispatcher): Nothing worth borrowing except method naming -- use `listTriggers()` instead of `getTriggers()`.
- Simpler variant: No meaningful simplification available without dropping required endpoints.
- referenceUrls YAML: Narrow parser doesn't support YAML sequences. Parse as space-separated scalar, split on whitespace at parse time.

---

## Philosophy Alignment

| Principle | Status | Notes |
|---|---|---|
| Immutability by default | Satisfied | All new fields readonly |
| Errors are data | Satisfied | JSON errors from dispatch endpoint, Result chain for YAML |
| Make illegal states unrepresentable | Satisfied | onComplete.runOn is literal union |
| Validate at boundaries | Satisfied | YAML is boundary; agentConfig/onComplete validated at load time |
| YAGNI | Satisfied | referenceUrls simplified, onComplete execution deferred |
| Document why | To implement | Comments for onComplete warning and referenceUrls limitation |

---

## Findings

### ORANGE: sessionId return from dispatch endpoint

The task spec says POST /api/v2/auto/dispatch should return `{ sessionId: string }`. But `runWorkflow()` runs to completion asynchronously (up to 30 min). The WorkRail session ID is only assigned deep in the agent loop, not at dispatch time.

**Recommended resolution for MVP:** Return `{ status: 'dispatched', workflowId: string }` and add a code comment noting that session tracking is available via `GET /api/v2/sessions` once the daemon starts. This matches existing webhook route behavior (`{ status: 'accepted', triggerId }`).

**Console impact:** DispatchPane success state shows "Dispatched -- check Queue pane" instead of a session link.

---

### YELLOW: referenceUrls YAML parsing limitation

The narrow YAML parser doesn't support YAML sequences (`- item` lists). Parse `referenceUrls` as a space-separated scalar string and split on whitespace at parse time. Document in a code comment.

---

### YELLOW: console-routes read-only comment

Update from "All routes are GET-only (invariant: Console is read-only)" to reflect the new POST endpoint with an explanation.

---

## Recommended Revisions

1. **Dispatch return type**: `{ status: 'dispatched', workflowId: string }` instead of `{ sessionId: string }`.
2. **referenceUrls**: Parse as space-separated scalar, split on whitespace.
3. **TriggerRouter method name**: Use `listTriggers()` not `getTriggers()`.
4. **express.json()**: Inline middleware on POST route only (not app-wide).
5. **Update console-routes comment**: Reflect the new POST endpoint.
6. **onComplete warning**: Check `runOn !== 'success'` (covers both 'failure' and 'always').

---

## Residual Concerns

- The console AUTO tab has no ViewModel layer for MVP. Acceptable -- panes own their fetch hooks directly.
- Fire-and-forget dispatch means no correlation between a dispatch call and the resulting session ID without polling. Known limitation for MVP.
- YAML sub-object parsing for `onComplete` and `agentConfig` requires careful indent-level handling. Use trigger-store.ts:234-266 as the direct template.
