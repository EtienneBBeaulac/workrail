# Design Review Findings: Late-Bound Goals

**Feature**: Default `goalTemplate: "{{$.goal}}"` when no static `goal` and no `goalTemplate` is configured.  
**Design**: Candidate A -- parse-time sentinel injection in `validateAndResolveTrigger()`.

---

## Tradeoff Review

| Tradeoff | Conditions for failure | Status |
|---|---|---|
| Synthetic sentinel `'Autonomous task'` in `goal` field | If `trigger.goal` were used for routing/dedup (not display only). Verified: only used in `interpolateGoalTemplate` fallback and logs. | Acceptable |
| No `console.warn` on load for late-bound triggers | Operators may not discover this feature. Mitigated by adding a `console.log` at daemon startup when injection fires. | Acceptable with INFO log |
| Sentinel shows in console trigger list | Cosmetic only. Sessions get the interpolated goal from payload, not the sentinel. | Acceptable |

---

## Failure Mode Review

| Failure Mode | Handled? | Missing Mitigation | Risk |
|---|---|---|---|
| Console UI shows 'Autonomous task' | Yes -- cosmetic, not functional | Future: show `goalTemplate` in trigger list | Low |
| Payload has no `goal` field | Yes -- `interpolateGoalTemplate` already warns (line 127) | None needed | Low |
| Non-null assertion `raw.goal!.trim()` panics | Handled by replacing with `resolvedGoal: string` | TypeScript compile-time check | Low |
| `goalTemplate`-only trigger with no `goal` | Handled -- inject sentinel for this case too | None needed | Low |

No high-risk failure modes.

---

## Runner-Up / Simpler Alternative Review

- **Candidate B** (optional type): nothing worth borrowing. Cascades null checks to 3+ files.
- **Simpler variant** (only inject when both absent, skip goalTemplate-only case): does NOT satisfy acceptance criteria -- existing triggers using only `goalTemplate` would still fail with `missing_field`.
- **Hybrid improvement**: extract `'Autonomous task'` to a named constant `LATE_BOUND_GOAL_SENTINEL` for searchability. Low cost, worth including.

---

## Philosophy Alignment

**Satisfied**: validate-at-boundaries, make-illegal-states-unrepresentable, immutability, YAGNI, determinism.

**Under tension**: prefer-explicit-domain-types -- a `goalSource` discriminant would be more type-honest. Acceptable: documented as a future enhancement, not blocking this fix.

---

## Findings

### Yellow: Named constant for sentinel

**Severity**: Yellow (code quality, not correctness)  
**Finding**: `'Autonomous task'` hardcoded inline is harder to search and understand than a named constant.  
**Fix**: `const LATE_BOUND_GOAL_SENTINEL = 'Autonomous task';` at module scope.

### Yellow: Missing INFO log at injection time

**Severity**: Yellow (operator experience)  
**Finding**: Operators who configure a trigger without `goal`/`goalTemplate` get silent late-bound behavior. A `console.log` at injection time helps discoverability.  
**Fix**: `console.log('[TriggerStore] Trigger "%s" has no static goal or goalTemplate -- defaulting to goalTemplate: "{{$.goal}}" (goal from payload)', rawId);`

### Yellow: Missing WHY comment in code

**Severity**: Yellow (maintainability)  
**Finding**: The injection block needs a comment explaining the late-bound goal contract and the sentinel value.

No Red or Orange findings.

---

## Recommended Revisions

1. Extract sentinel to named constant: `const LATE_BOUND_GOAL_SENTINEL = 'Autonomous task';`
2. Add `console.log` when injecting the default.
3. Add WHY comment above the injection block.
4. Update `docs/discovery/late-bound-goals.md` with these minor additions.

---

## Residual Concerns

1. **Console UI display**: Late-bound triggers show 'Autonomous task' in the trigger list until a UI enhancement adds `goalTemplate` as a separate display field. Documented as a known limitation, not a bug.
2. **Future discriminant**: A `goalSource: 'static' | 'payload'` field on `TriggerDefinition` would be the cleaner long-term design. Filed in backlog. This change does not block it.
