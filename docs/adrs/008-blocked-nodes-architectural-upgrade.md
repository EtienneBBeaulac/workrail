# ADR 008: Blocked Nodes as First-Class DAG Nodes (Architectural Upgrade)

**Status:** Proposed (requires sign-off before implementation)  
**Date:** 2026-01-10

## Context

WorkRail v2's current model records validation failures as outcome annotations on `advance_recorded` events:
```typescript
advance_recorded.outcome = { kind: "blocked", blockers: BlockerReport }
```

This architectural approach has a correctness limitation: when a client retries with corrected output using the same `ackToken`, idempotent replay returns the recorded `blocked` outcome unchanged, ignoring the new output. Agents perceive this as a stuck state and require an unnecessary rehydrate round-trip to break the loop.

**Root cause:** Blocked is modeled as an outcome annotation on an advance attempt, not as a durable node in the run DAG. The validation that led to the block is not recorded as a first-class event, making replay deterministic but non-responsive to new inputs.

Additionally, projections must scan the entire event log to find blocked outcomes (O(n) query), and blocked nodes cannot be rendered as topology-level DAG nodes in Studio/Console.

## Decision

**Upgrade the v2 model to treat blocked attempts as first-class DAG nodes:**

1. **`nodeKind="blocked_attempt"` nodes** exist in the run DAG alongside `step` and `checkpoint` nodes.
2. **`validation_performed` events** record validation results durably before any outcome is recorded.
3. **`retryAckToken`** is minted for retryable blocks, enabling agents to retry with corrected output in a single call.
4. **Terminal blocks** create nodes but do not mint retry tokens (architectural consistency; they just don't open a retry path).

### What This Means

#### Before (outcome annotation):
```
Validation fails
  → record: advance_recorded.outcome = { kind: "blocked" }
  → no validation event exists
  → blocking decision not durable

Retry with ackToken
  → idempotent replay returns original blocked outcome
  → ignores new output
  → agent stuck (needs rehydrate)
```

#### After (DAG nodes):
```
Validation fails
  → record: validation_performed event (durable validation facts)
  → record: blocked_attempt node in DAG
  → record: edge from parent to blocked node
  → mint retryAckToken (if retryable)

Retry with retryAckToken
  → validates new output
  → creates success node OR chains another blocked node
  → agents can iterate without rehydrate
```

### Alignment with Design Locks

This change is an **intentional architectural upgrade** of v2's design locks (not a violation):

**ADR 005 (Tokens)**: Still satisfied. Tokens remain opaque; clients round-trip them unchanged.

**ADR 006 (Append-Only)**: Strengthened. Blocked outcomes become first-class nodes in the append-only DAG.

**ADR 007 (Resume & Checkpoint)**: Compatible. Blocked nodes are valid tips; checkpoints can follow blocked nodes.

**Design Locks § 1–17**: All preserved (append-only truth, idempotency, snapshot pinning, crash-safety).

**Design Locks § 18 (Event schema)**: Updated with intent. The blocked outcome on `advance_recorded` is deprecated (marked for removal after 2 releases) in favor of blocked_attempt nodes. This is **deliberate evolution**, not drift—both models coexist during the deprecation buffer.

### Decision ID

**Locked Decision 5** (per implementation_plan.md § 7, Decision 5, lines 830–843):

> "Blocked attempts are durable DAG nodes, not outcome annotations. Validation results are first-class events. This is an architectural upgrade (not a violation of append-only semantics) that strengthens guarantees while remaining backward compatible."

## Consequences

### Positive

- **Single-call retry**: Agents can retry with corrected output in one call (better UX).
- **Observable validation**: Validation facts are durable and auditable.
- **DAG topology = state machine**: Run status can be derived from node kinds (O(1) query).
- **Studio rendering**: Blocked nodes render as first-class DAG nodes.
- **Terminal blocks**: Architecturally consistent (they create nodes, just not retry paths).
- **Backward compatible**: New response fields (`retryable`, `retryAckToken`, `validation`) are additive; old clients ignore them.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Removing blocked from `advance_recorded` breaks projection consumers | S3-WP2.5: Comprehensive search + refactor before schema change |
| Validation event size causes log bloat | Bounded truncation (deterministic, sorted issues/suggestions) + tests |
| Atomicity breaks under crashes | Single append transaction (validation event + node + edge) + tests |
| Key rotation breaks replay determinism | Validation events are durable; tokens re-signed; functional equivalence proven in tests |
| Chained blocks need complex parent tracking | Parent linkage via `parentNodeId`; blocked nodes chain naturally |

### Non-Goals

- Changing validation logic (ValidationEngine stays, but exceptions → Result types).
- Supporting retry for already-advanced nodes.
- Building Studio UI (substrate only; UI is post-core).
- Adding `ackDisposition` field (YAGNI).
- Creating validation projection (load on-demand).

## Implementation Safeguards

(See implementation_plan.md § 8–15 for full execution details.)

### Pre-Implementation

1. **ADR sign-off** (this document): confirms intention to upgrade v2 locks.
2. **Comprehensive search**: `rg "advance_recorded.*blocked|outcome.*blocked"` identifies all consumers.
3. **Environment checks**: Verify `ValidationEngine` can be refactored to Result types without major surgery.

### Per-Slice

- **Slice 1** (Schemas): New types, backward-compatible response fields.
- **Slice 2** (Validation Events): Emit durable validation events before blocking decisions.
- **Slice 3** (Blocked Nodes): Create nodes; deprecate (not remove) blocked outcome.
- **Slices 4–7** (Retry, Projections, Tests): Complete the feature with comprehensive test coverage.

### Testing Strategy

- Unit tests: Schema validation, truncation determinism, token signing.
- Integration tests: End-to-end blocked→retry flow, chained blocks, atomicity.
- Determinism tests: Key rotation, idempotency, replay equivalence.
- Edge case tests: Terminal blocks, missing validation events, concurrent retries.

### Backward Compatibility

- `advance_recorded.outcome.kind="blocked"` remains valid during a 2-release buffer period (deprecated, not removed).
- Feature flag `USE_BLOCKED_NODES` (default: true) allows rollback if needed.
- New response fields are optional; old clients parse successfully.
- Projections updated before schema change (no orphaned consumers).

## Rationale

### Why This Upgrade Aligns with WorkRail Philosophy

**Immutability + append-only truth**: Blocked nodes are immutable DAG nodes; validation events are durable facts. No mutation.

**Architectural fix over patch**: Root cause is "blocked is not a node"; solution is "make it one." This is not a parameter tweak but a model upgrade.

**Make illegal states unrepresentable**: Discriminated union (`retryable_block | terminal_block`) prevents `{ terminal, retryAttemptId: "x" }`.

**Type safety first**: Node kind encodes semantics; retry paths are topology, not flags.

**Determinism over cleverness**: Retry token derivation is pure; validation events immutable; replay fact-returning.

**Errors as data**: Validation results are structured, durable events (not inferred from chat).

**Observable**: Blocked nodes + validation events = first-class audit trail.

## Comparison to Alternatives

### Alternative 1: Outcome annotation + retry token (Hybrid 1)
- **Pro**: Minimal schema change.
- **Con**: Blocking decision still not durable; projections still scan events; nodes don't appear in DAG.
- **Verdict**: Patches the symptom; doesn't address root cause.

### Alternative 2: Blocked nodes + no validation event (Minimal)
- **Pro**: Fewer events.
- **Con**: No durable validation facts; replay must recompute; non-deterministic under validation engine changes.
- **Verdict**: Violates append-only principle and determinism lock.

### Chosen: Blocked nodes + validation events (Full Upgrade)
- **Pro**: Durable validation, observable, deterministic, consistent.
- **Con**: More events (but bounded by truncation and budgets).
- **Verdict**: Strongest alignment with v2 philosophy.

## References

- `docs/adrs/005-agent-first-workflow-execution-tokens.md` (token basis)
- `docs/adrs/006-append-only-session-run-event-log.md` (append-only principle)
- `docs/design/v2-core-design-locks.md` (locked decisions)
- `implementation_plan.md` (detailed execution plan, 1214 lines, 7 vertical slices)
