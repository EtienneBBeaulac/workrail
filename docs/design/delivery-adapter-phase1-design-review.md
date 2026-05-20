# Delivery Adapter Phase 1 -- Design Review Findings

**Design under review:** Named Adapter Registry Phase 1 -- DeliveryAdapter interface, DeliveryReceipt union, resolveDeliveryConfig() pure function, CLI inbox adapter, migration shim. Zero behavior change.

---

## Tradeoff Review

| Tradeoff | Verdict | Condition under which it fails |
|---|---|---|
| Phase 1 does not call adapter.deliver() | Acceptable | Fails if Phase 2 is never implemented; dual representation persists indefinitely |
| PollHandle.state as Record<string,unknown> | Acceptable | Not triggered in Phase 1 (no async adapters) |
| Dual representation: legacy fields + deliveryConfig | Acceptable | Fails if Phase 2 code reads legacy flags after the adapter call is added |

---

## Failure Mode Review

| Failure mode | Handled | Missing mitigation |
|---|---|---|
| WorkflowTrigger construction sites miss deliveryConfig | Handled -- one site in route(), dispatch() takes caller-provided WT | None needed |
| resolveDeliveryConfig() precedence with both legacy + explicit config | Handled for Phase 1 -- no deliveryConfig block in triggers.yml yet | Phase 2 must define explicit-beats-legacy rule |
| CLI inbox adapter imports OutboxMessage from cli/commands/ (circular) | Unmitigated | Define OutboxMessage-compatible type inline in delivery-adapter.ts |

**Highest-risk:** Circular import if CliInboxAdapter imports from `cli/commands/worktrain-inbox.ts`. Must be resolved before implementation starts.

---

## Runner-Up / Simpler Alternative Review

- C2 (extend DeliveryStage): nothing worth borrowing for Phase 1
- Skip migration shim: rejected -- deliveryConfig would be always-empty in Phase 1, providing no foundation for Phase 2
- Define outbox entry shape inline: **recommended** -- avoids circular import, three-field struct is trivial to inline

---

## Philosophy Alignment

**Satisfied:** exhaustiveness (closed discriminated unions), functional core/imperative shell (pure resolver + imperative adapter), errors as data (DeliveryReceipt error variant), dependency injection (adapters injected), validate at boundaries (resolver validates at parse time).

**Under tension (acceptable):** PollHandle.state opaque blob; YAGNI vs. Phase 1 infrastructure. Both are bounded and documented.

---

## Findings

**ORANGE: Circular import risk**
CliInboxAdapter must NOT import `OutboxMessage` from `src/cli/commands/worktrain-inbox.ts`. The `cli/commands/` layer must not be imported by `src/trigger/` modules. Define a compatible inline type in `delivery-adapter.ts`.

**YELLOW: Migration shim precedence rule not defined**
trigger-store.ts migration shim always synthesizes deliveryConfig from legacy fields in Phase 1. Phase 2 must add a rule: explicit `delivery:` block in triggers.yml beats synthesized config. Not needed now but must be documented in Phase 1 comments.

**YELLOW: PR description must state legacy paths remain active**
Phase 1 adds the interface without calling adapter.deliver(). Any reviewer could misread this as complete pluggable delivery. PR description must be explicit that maybeRunDelivery() and maybeRunPostWorkflowActions() are untouched.

---

## Recommended Revisions

1. **Define outbox-compatible entry shape inline** in `delivery-adapter.ts` (not imported from cli/commands). Shape: `{ id: string; message: string; timestamp: string }`.
2. **Add a WHY comment** in trigger-store.ts migration shim: "Phase 1: shim synthesizes deliveryConfig unconditionally. Phase 2 will add: explicit delivery: block in triggers.yml takes precedence over synthesized config."

---

## Residual Concerns

- Phase 1 sits as dead infrastructure until Phase 2 ships the adapter.deliver() call. No correctness risk, but creates a maintenance window where dual representation exists.
- CliInboxAdapter delivery of free-text messages (the current outbox format is a `message: string`) may not be expressive enough for structured artifact delivery in Phase 2. Phase 2 will need to extend or replace the outbox entry format. Not a Phase 1 issue.
