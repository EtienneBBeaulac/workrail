# Output Delivery Design Review Findings

**Selected direction:** Candidate 1 -- Named Adapter Registry with explicit DeliveryReceipt union
**Review date:** 2026-05-19

---

## Tradeoff Review

| Tradeoff | Verdict | Conditions under which it fails |
|---|---|---|
| `pollHandle.state: Record<string,unknown>` | Acceptable | Fails if two async adapters share a sidecar store without `adapterId` discriminant on recovery |
| Three-level config merge | Acceptable | Fails (UX) if `worktrain trigger validate` doesn't show resolved delivery config |
| `WorkflowTrigger.deliveryConfig` optional field | Acceptable | Fails (tech debt) if `reviewerIdentity` is not deprecated in the same PR |

---

## Failure Mode Review

| Failure mode | Risk | Mitigation status | Action required |
|---|---|---|---|
| Startup recovery loses async poll handles after restart | MEDIUM | Unmitigated | Define `pending-delivery-*.json` sidecar format with `adapterId` + `state`; update startup recovery to dispatch on `adapterId` |
| Three-level config precedence confusion | LOW | Unmitigated | `worktrain trigger validate` must print resolved delivery config per trigger |
| `WorkflowTrigger` struct escalation | LOW | Unmitigated | Deprecate `reviewerIdentity` in same PR, remove in next minor version |

---

## Runner-Up / Simpler Alternative Review

**Borrow from C3:** Append a `delivery_planned` event to the session log when `deliveryConfig` is resolved at session start. Cost: one new event kind. Benefit: console can show planned delivery channel before execution. Recommended addition.

**Do not borrow from C3:** Full `DeliveryExecutor` with `delivery_recorded`/`delivery_pending` events. Over-engineered for current problem; defer to backlog as long-term direction.

**Simpler alternative considered and rejected:** Drop middle tier (workflow-type config). Rejected -- multi-workflow operators would have no clean way to configure delivery once for all triggers of a given workflow type without polluting the global default.

---

## Philosophy Alignment

**Fully satisfied:** exhaustiveness (discriminated unions throughout), zero LLM turns for routing, dependency injection, functional core / imperative shell, errors as data.

**Under tension (acceptable):** `pollHandle.state` opaque blob vs. make-illegal-states-unrepresentable. Mitigated by `adapterId` discriminant. Existing sidecar pattern has the same trade-off; C1 does not worsen it.

**No risky tensions.**

---

## Findings

**ORANGE: Sidecar/recovery dispatch undefined (failure mode 1)**
The generalized `pending-delivery-*.json` sidecar format and startup recovery dispatch are not yet designed. The existing pattern works for one async adapter; adding a second (e.g., GitLab) without this design produces a silent dispatch failure on daemon restart. Must be designed before implementation starts.

**YELLOW: `worktrain trigger validate` does not show resolved delivery config**
Operators have no way to preview which adapter will run for a given trigger before a session fires. This will cause confusion when three-level config is misconfigured. Should be added in the same implementation milestone, not deferred.

**YELLOW: `reviewerIdentity` deprecation not in scope**
If `deliveryConfig` is shipped without deprecating `reviewerIdentity`, both fields will exist simultaneously with overlapping semantics. Contributors reading the code 18 months from now will not know which one to use. Deprecate in the initial PR.

---

## Recommended Revisions

1. **Add `delivery_planned` event** (borrow from C3) -- one event kind, written at session start, enables console observability of planned delivery channel.

2. **Design the generalized sidecar format before implementation** -- `{ adapterId: string; state: Record<string,unknown> }` with startup recovery dispatching on `adapterId`. This is a prerequisite for the async delivery path, not an afterthought.

3. **Deprecate `reviewerIdentity` in the initial delivery PR** -- emit startup warning if both fields are set; remove in the following minor release.

4. **Add resolved-delivery-config output to `worktrain trigger validate`** -- show the effective adapter for each trigger based on the three-level merge.

---

## Residual Concerns

- **Long-term:** `pollHandle.state` opaque blob remains a type safety gap. If a second async adapter is added, strongly consider widening `PollHandle` to a typed union at that point rather than adding another untyped blob.
- **Scope creep risk:** The `delivery_planned` event recommendation is additive; the temptation will be to also add `delivery_recorded` and `delivery_pending` events (full C3). Resist this unless the project commits to the event-sourced executor. The additive `delivery_planned` event is valuable alone; the rest of C3 is a different scope.
- **C3 as long-term direction:** Flag in the backlog that C3 (event-sourced delivery bus) is the intended 3-year architecture. When session event sourcing is a first-class project concern (e.g., for replay, compliance, or multi-node execution), C1 should be migrated to C3. The interface boundary (`DeliveryAdapter.deliver()`) is the same in both; the migration is in the executor layer, not the adapter layer.
