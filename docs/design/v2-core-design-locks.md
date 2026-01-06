# WorkRail v2: Core Design Locks (Consolidated)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document consolidates the v2 “design lock” decisions that are easy to drift during implementation.

It is intentionally not a full spec. For normative protocol and platform constraints, use:
- `docs/reference/workflow-execution-contract.md`
- `docs/reference/mcp-platform-constraints.md`
- ADRs 005–007

---

## 1) Append-only truth substrate: event log + node snapshots

### Two append-only stores
WorkRail v2 persists durable truth in two append-only stores:
- **Event log (per session)**: strictly ordered, typed events.
- **Node snapshot store**: immutable, typed, versioned snapshots referenced by events.

The event log is truth for lineage and facts; node snapshots exist only to rehydrate execution deterministically and re-mint runtime tokens.

### Storage invariants (must hold)
- **Authoritative ordering**: a monotonic per-session `EventIndex` is the ordering source for projections and policies. Timestamps (if any) are informational only.
- **EventIndex origin (locked)**: `EventIndex` is **0-based**. The first domain event in a session has `eventIndex=0`.
- **Crash-safe append**: append-only, atomic writes; JSONL **segment files** (not one monolithic file).
  - write temp → `fsync(file)` → `rename` → `fsync(dir)`
- **Single writer per session**: enforce cross-process lock; if busy, fail fast with structured retryable error.
- **Segmentation is `EventIndex`-driven**: segment naming/bounds are keyed to `EventIndex` (never timestamps).
- **Segment rotation (hybrid)**: rotate segments on the first threshold hit (max events **or** max bytes).
- **Two-stream model (locked)**:
  - **Domain truth** lives in `events/*.jsonl` (typed domain events, ordered by `EventIndex`).
  - A separate append-only **control stream** lives in `manifest.jsonl` (segment attestation + snapshot pins).
- **Segment manifest (append-only, authoritative)**:
  - Segments are committed by appending a `segment_closed` record to `manifest.jsonl`.
  - **Orphan segment rule**: any segment file without a corresponding `segment_closed` record is ignored (no salvage scanning).
- **Integrity + recovery**:
  - On load, validate using `manifest.jsonl`; stop at the last valid manifest entry and fail explicitly (no guessing).
  - Segment digests must match; otherwise treat the segment (and anything after, if contiguous loading) as invalid.

### Append transaction protocol (AppendPlan → segment → manifest) (locked)
To prevent drift and “partial truth” states, all durable mutation must occur through a single append transaction protocol.

Locks:
- The storage subsystem exposes a single durable mutation operation: `append(sessionId, plan: AppendPlan)`.
- `AppendPlan` is the **atomic unit** of durable truth for the domain stream:
  - either the plan is fully committed (and becomes part of truth),
  - or it has no effect on truth (orphan segment rule applies).
- Commit is deterministic and uses the two-stream model:
  1) **Write domain events segment**:
     - write the plan’s domain events to a new temp segment file under `events/` (JSONL, ordered by `EventIndex`)
     - `fsync(file)` → `rename` to final `events/<first>-<last>.jsonl` → `fsync(dir)`
  2) **Attest the segment in the control stream**:
     - append `manifest.segment_closed` referencing the final segment rel path + sha256 digest + bounds
     - `fsync(manifest)`
  3) **Pin new snapshot refs (pin-after-close, locked)**:
     - append `manifest.snapshot_pinned` records for any `snapshotRef` introduced by the plan’s committed domain events segment
     - `fsync(manifest)`
- All of the above occurs while holding the session lock (`sessions/<sessionId>/.lock`).
- Orphan segment rule remains authoritative: any segment without a corresponding `segment_closed` is ignored and MUST NOT be scanned for salvage.

Crash-state intent (locked):
- Crash before step (2) → orphan segment ignored (no truth change).
- Crash after step (2) but before step (3) → committed segment exists, but pins may be missing. This is treated as corruption of the append transaction and MUST fail fast on load (no “pin-on-load” repair).
- Crash after step (3) → committed segment + pins exist (normal).

#### `manifest.jsonl` record ordering (locked)
- The manifest has its own monotonic per-session **`ManifestIndex`** (authoritative ordering for manifest records).
- Manifest records may reference the domain stream via `eventIndex` (e.g., `snapshot_pinned.eventIndex` refers to the associated `EventIndex`), but do not consume domain `EventIndex`.

#### `manifest.jsonl` record kinds (schemaVersion 1, locked)
`manifest.jsonl` is a closed-set discriminated union by `kind` (schemaVersion 1):
- `segment_closed`
- `snapshot_pinned`

##### `segment_closed` (locked)
Purpose: attest that an `events/*.jsonl` segment is durably committed and integrity-checked.

Required fields:
- `v` (schema version)
- `manifestIndex`
- `sessionId`
- `kind: "segment_closed"`
- `firstEventIndex`, `lastEventIndex`
- `segmentRelPath` (relative path; no absolute paths)
- `sha256` (digest of the segment file bytes)
- `bytes` (non-negative int)

Invariants:
- **Strict contiguity**: `firstEventIndex` must equal previous `lastEventIndex + 1` (no gaps, no overlaps).
- Segment contents must cover exactly [`firstEventIndex`, `lastEventIndex`] in increasing order.
- Segment is ignored unless its digest matches `sha256`.

Example:

```json
{"v":1,"manifestIndex":12,"sessionId":"sess_01JH...","kind":"segment_closed","firstEventIndex":0,"lastEventIndex":4999,"segmentRelPath":"events/00000000-00004999.jsonl","sha256":"sha256:seg_7fd2...","bytes":1837421}
```

##### `snapshot_pinned` (locked)
Purpose: make snapshot reachability explicit for export/import and CAS GC (without scanning the event log).

Locks:
- **Pin-on-create**: record `snapshot_pinned` immediately when a new `snapshotRef` is introduced (as part of the append transaction; see pin-after-close ordering).
- Pins are append-only; duplicates are allowed; projections dedupe by `snapshotRef`.

Required fields:
- `v` (schema version)
- `manifestIndex`
- `sessionId`
- `kind: "snapshot_pinned"`
- `eventIndex` (associated domain `EventIndex`, typically the `node_created` that introduced the snapshot)
- `snapshotRef`
- `createdByEventId` (provenance)

Example:

```json
{"v":1,"manifestIndex":13,"sessionId":"sess_01JH...","kind":"snapshot_pinned","eventIndex":42,"snapshotRef":"sha256:snap_f2c1...","createdByEventId":"evt_01JH..."}
```

### Type-safety baseline
Avoid base primitives for identifiers where possible; use distinct branded/opaque types:
`SessionId`, `RunId`, `NodeId`, `EventId`, `WorkflowId`, `WorkflowHash`, `SnapshotRef`, `EventIndex`.

### Minimal internal event union (closed set)
All events share an envelope: `eventId`, `eventIndex`, `sessionId`, `kind`, plus optional scope refs (`runId?`, `nodeId?`).

Closed event kinds:
- `session_created`
- `observation_recorded` (session-first, node-scoped allowed but rare/high-signal)
- `run_started` (pins `workflowId` + `workflowHash`)
- `node_created` (`nodeKind`: `step|checkpoint`, references typed snapshot)
- `edge_created` (`edgeKind`: `acked_step|checkpoint`)
- `advance_recorded` (**durable result of an attempted advance (ack attempt)**, see below)
- `node_output_appended` (append-only durable write path; optional `supersedesOutputId?` for corrections without mutation)
- `preferences_changed` (node-scoped; stores delta + effective snapshot)
- `capability_observed` (node-scoped; includes closed-set provenance)
- `gap_recorded` (node-scoped; append-only “resolution” via linkage)
- `divergence_recorded` (node-scoped)
- `decision_trace_appended` (node-scoped, strictly bounded; never required for correctness)

### Event payload contracts (initial v2 schema, locked)
This section locks the *shape* of the highest-leverage event payloads so storage/projections don’t drift during implementation.

General rules:
- All identifiers use distinct branded types (`SessionId`, `RunId`, `NodeId`, `EventId`, `OutputId`, `GapId`, etc.).
- Prefer closed sets (discriminated unions/enums) over booleans and free-form strings.
- Node/run references live in the event envelope `scope` (avoid duplicating IDs inside event-specific payloads).

#### Idempotency via `dedupeKey` (locked)
WorkRail operates in a lossy/replay-prone environment. Every session event MUST carry a `dedupeKey` that enables safe retries and idempotent replays.

Behavior (locked):
- If an append encounters an existing event in the same session with the same `dedupeKey`, treat it as an **idempotent no-op**:
  - do not append a new event
  - return/ack success deterministically based on the existing event

Rules (locked intent):
- `dedupeKey` must be derived only from stable identifiers (no timestamps).
- `dedupeKey` is length-bounded and ASCII-safe.
- When incorporating a value-like field (e.g., an observation value), use a digest rather than embedding raw free-form text.

DedupeKey pattern (locked):
- Allowed characters: `[a-z0-9_:>-]+` (lowercase letters, digits, underscore, colon, greater-than, hyphen)
- Max length: 256 characters
- Recipe format: `<kind>:<parts joined by ":">`
- Arrow notation (`->`) allowed for edge relationships (e.g., `nodeA->nodeB`)
- MUST NOT contain uppercase letters, spaces, or other characters

**Hard rule (clarification, locked):** `dedupeKey` MUST NOT be derived from `eventId`. `eventId` is server-minted per append and is not available/stable across retries. If you need an idempotency handle, use a dedicated, typed identifier in the event payload (e.g., `outputId`, `changeId`, `observationId`, `gapId`, `attemptId`, `divergenceId`, `traceId`).

Initial v2 recipes (illustrative, locked intent):
- `run_started`: `run_started:<sessionId>:<runId>`
- `node_created`: `node_created:<sessionId>:<runId>:<nodeId>`
- `edge_created`: `edge_created:<sessionId>:<runId>:<fromNodeId>-><toNodeId>:<edgeKind>`
- `node_output_appended`: `node_output_appended:<sessionId>:<outputId>`
- `gap_recorded`: `gap_recorded:<sessionId>:<gapId>`
- `preferences_changed`: `preferences_changed:<sessionId>:<changeId>`
- `capability_observed`: `capability_observed:<sessionId>:<capObsId>`
- `advance_recorded`: `advance_recorded:<sessionId>:<nodeId>:<attemptId>`
- `divergence_recorded`: `divergence_recorded:<sessionId>:<divergenceId>`
- `decision_trace_appended`: `decision_trace_appended:<sessionId>:<traceId>`
- `observation_recorded`: `observation_recorded:<sessionId>:<key>:<valueDigest>`

#### `session_created` (locked)
Purpose: mark the existence of a session as durable truth without reintroducing mutable session documents.

Lock:
- `session_created` is a **marker event only** in the initial v2 schema (no additional metadata payload).
- Session “aboutness” for resumption/search is derived from durable observations, outputs, and run history (projections), not from session-level fields.

Envelope requirements:
- `scope` must be absent (`runId`/`nodeId` not allowed).

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":0,"sessionId":"sess_01JH...","kind":"session_created","dedupeKey":"session_created:sess_01JH...","data":{}}
```

#### `run_started` (locked)
Purpose: introduce a run and pin it to a compiled workflow snapshot for deterministic execution.

Envelope requirements:
- `scope.runId` must be present.
- `scope.nodeId` must be absent.

Payload fields:
- `workflowId`
- `workflowHash`
- `workflowSourceKind`: `bundled | user | project | remote | plugin`
- `workflowSourceRef` (opaque; meaning is scoped by `workflowSourceKind`)

Invariants:
- `workflowHash` is the execution authority for the run (not `workflowSourceRef`).
- `workflowHash` must be resolvable to a persisted pinned compiled workflow snapshot (export/import requirement).

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":1,"sessionId":"sess_01JH...","kind":"run_started","scope":{"runId":"run_01JH..."},"dedupeKey":"run_started:sess_01JH:run_01JH","data":{"workflowId":"project.bug_investigation_v2","workflowHash":"sha256:wf_9a3b...","workflowSourceKind":"project","workflowSourceRef":"workflows/bug_investigation_v2.json"}}
```

#### `node_created` (locked)
Purpose: create a durable node in the run DAG and link it to the immutable rehydration snapshot (`snapshotRef`).

Envelope requirements:
- `scope.runId` must be present.
- `scope.nodeId` must be present.

Payload fields:
- `nodeKind`: `step | checkpoint`
- `parentNodeId` (nullable only for the run root node; otherwise required)
- `workflowHash` (must match the run’s pinned `workflowHash`)
- `snapshotRef`

Invariants:
- `parentNodeId` (when present) must refer to a node in the same run.
- `snapshotRef` must be pinned in `manifest.jsonl` via `snapshot_pinned` (pin-on-create, pin-after-close ordering).

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":2,"sessionId":"sess_01JH...","kind":"node_created","scope":{"runId":"run_01JH...","nodeId":"node_01JH_root"},"dedupeKey":"node_created:sess_01JH:run_01JH:node_01JH_root","data":{"nodeKind":"step","parentNodeId":null,"workflowHash":"sha256:wf_9a3b...","snapshotRef":"sha256:snap_f2c1..." }}
```

#### `preferences_changed` (locked)
Purpose: record a node-attached preference change in an append-only way that is rewind-safe and export/import safe.

Payload fields:
- `changeId` (stable identifier)
- `source`: `user | workflow_recommendation | system`
- `delta`: non-empty list of changes:
  - each item is `{ key, value }`
  - `key` is a closed set (`autonomy | riskPolicy`)
  - no duplicate keys within a single delta
- `effective`: full effective preference snapshot after applying `delta` (node-attached truth)

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":120,"sessionId":"sess_01JH...","kind":"preferences_changed","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"preferences_changed:sess_01JH:prefchg_01JH...","data":{"changeId":"prefchg_01JH...","source":"user","delta":[{"key":"autonomy","value":"full_auto_never_stop"}],"effective":{"autonomy":"full_auto_never_stop","riskPolicy":"conservative"}}}
```

#### `capability_observed` (locked)
Purpose: record observed capability status with provenance so “agent said so” is never enforcement-grade truth by default.

Payload fields:
- `capObsId` (stable identifier; primary idempotency key)
- `capability`: `delegation | web_browsing`
- `status`: `unknown | available | unavailable`
- `provenance` (closed set):
  - `kind: probe_step | attempted_use | manual_claim`
  - `enforcementGrade`: `strong | weak` (derived deterministically from `kind`, but stored for projection/UI clarity)
  - `detail` fields (minimal, explainability-first):
    - `probe_step` (strong): `{ probeTemplateId, probeStepId, result: success|failure }`
    - `attempted_use` (strong): `{ attemptContext: workflow_step|system_probe, result: success|failure, failureCode? }`
      - `failureCode` is required iff `result=failure` and is a closed set: `tool_missing | tool_error | policy_blocked | unknown`
    - `manual_claim` (weak): `{ claimedBy: agent|user, claim: available|unavailable }`

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":121,"sessionId":"sess_01JH...","kind":"capability_observed","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"capability_observed:sess_01JH:capobs_01JH...","data":{"capObsId":"capobs_01JH...","capability":"web_browsing","status":"available","provenance":{"kind":"probe_step","enforcementGrade":"strong","detail":{"probeTemplateId":"wr.templates.capability_probe","probeStepId":"wr_probe_web_browsing","result":"success"}}}}
```

**Projection rule (locked intent):** capability status is **derived**.
- History is append-only: multiple `capability_observed` events may exist for the same `(nodeId, capability)`.
- The “current” status for a node is the latest event by `EventIndex` for that `(nodeId, capability)` (ties impossible by ordering).
- `dedupeKey` prevents only true retries (same `capObsId`), not legitimate status evolution.

#### `advance_recorded` (initial v2 schema, locked)
Purpose: record the durable outcome of an attempted `continue_workflow` operation so Studio and exports never infer “what happened” from transient tool responses.

Locks:
- `advance_recorded` is the canonical durable record for **ack attempts** (attempted advancement), including **blocked** and **advanced** outcomes.
- Rehydrate-only is side-effect-free (see contract): `continue_workflow` without `ackToken` MUST NOT create durable events, therefore it MUST NOT create `advance_recorded`.
- Idempotency is keyed by `attemptId` (not by tokens, timestamps, or `eventId`).
- `advance_recorded` is **node-scoped** (the node the agent attempted to operate on).
- `advance_recorded.dedupeKey` MUST be scoped by node: `advance_recorded:<sessionId>:<nodeId>:<attemptId>`. This prevents catastrophic false-dedupe if an `attemptId` is accidentally reused on a different node.

Payload fields:
- `attemptId` (stable identifier; primary idempotency key; matches `ackToken` payload field name)
- `intent` (closed set):
  - `ack_pending` (attempt to advance using `ackToken`)
- `outcome` (closed-set discriminated union):
  - `{ kind: "blocked", blockers: BlockerReport }`
  - `{ kind: "advanced", toNodeId }`

#### `BlockerReport` (initial v2 schema, locked)
Purpose: represent “blocked” reasons as typed, deterministic errors-as-data so Studio/exports never infer from chat history.

Locks:
- `BlockerReport` is a closed-set structure (no free-form codes).
- Ordering is deterministic.
- Payloads are bounded by byte budgets.

Text budgets are UTF-8 bytes (locked):
- All text budget limits (e.g., `message`, `suggestedFix`, `summary`, `notesMarkdown`) are measured in **UTF-8 bytes**, not code units or characters.
- Validation MUST use UTF-8 byte length measurement (e.g., `TextEncoder.encode(s).length`), not string `.length`.
- This prevents multi-byte character edge cases and ensures consistent enforcement across runtimes.

Shape (conceptual):
- `blockers: [Blocker, ...]` (non-empty)
- `Blocker` fields (required):
  - `code` (closed set; see below)
  - `pointer` (typed pointer; see below)
  - `message` (bounded text)
  - `suggestedFix` (bounded text; optional but strongly recommended)

`Blocker.code` (closed set, initial; derived from `ReasonCode`):
- `USER_ONLY_DEPENDENCY`
- `MISSING_REQUIRED_OUTPUT`
- `INVALID_REQUIRED_OUTPUT`
- `REQUIRED_CAPABILITY_UNKNOWN`
- `REQUIRED_CAPABILITY_UNAVAILABLE`
- `INVARIANT_VIOLATION`
- `STORAGE_CORRUPTION_DETECTED`

`Blocker.pointer` (closed set, initial):
- `{ kind: "context_key", key: string }` (use only for declared external inputs; key must be delimiter-safe)
- `{ kind: "context_budget" }` (request context exceeded byte budget or was non-serializable; see Context budget lock)
- `{ kind: "output_contract", contractRef: string }`
- `{ kind: "capability", capability: "delegation" | "web_browsing" }`
- `{ kind: "workflow_step", stepId: string }` (stepId must be delimiter-safe)

Blocker pointer identifiers (locked):
- `context_key.key` MUST be delimiter-safe: `[a-z0-9_-]+`
- `workflow_step.stepId` MUST be delimiter-safe: `[a-z0-9_-]+`
- This ensures consistency with StepInstanceKey encoding and prevents serialization edge cases.

Budgets (locked):
- max blockers per report: 10
- max bytes per `message`: 512
- max bytes per `suggestedFix`: 1024
- if a budget would be exceeded: fail fast during validation (do not truncate silently)

Deterministic ordering (locked):
- sort blockers by `(code, pointer.kind, pointer.* stable fields)` in ascending lexical order before returning/storing.

Mapping lock (ReasonCode → Blocker.code) (locked):
- `ReasonCode.user_only_dependency:*` → `USER_ONLY_DEPENDENCY`
- `ReasonCode.contract_violation:missing_required_output` → `MISSING_REQUIRED_OUTPUT`
- `ReasonCode.contract_violation:invalid_required_output` → `INVALID_REQUIRED_OUTPUT`
- `ReasonCode.capability_missing:required_capability_unknown` → `REQUIRED_CAPABILITY_UNKNOWN`
- `ReasonCode.capability_missing:required_capability_unavailable` → `REQUIRED_CAPABILITY_UNAVAILABLE`
- `ReasonCode.unexpected:invariant_violation` → `INVARIANT_VIOLATION`
- `ReasonCode.unexpected:storage_corruption_detected` → `STORAGE_CORRUPTION_DETECTED`

Notes:
- When `outcome.kind == "advanced"`, an `edge_created` + `node_created` MUST also exist for the same logical operation (either in the same append plan or as the idempotent replay result).
- When `outcome.kind == "blocked"`, the run status projection can rely on `gap_recorded` (for never-stop) and/or blockers here (for UX). Blockers are errors-as-data and must be bounded.

#### `divergence_recorded` (initial v2 schema, locked)
Purpose: record intentional off-script behavior as a durable, node-attached explainability signal (Studio badges; not required for correctness).

Envelope requirements:
- `scope.runId` must be present.
- `scope.nodeId` must be present.

Payload fields:
- `divergenceId` (stable identifier; primary idempotency key)
- `reason` (closed set, initial):
  - `missing_user_context`
  - `capability_unavailable`
  - `efficiency_skip`
  - `safety_stop`
  - `policy_constraint`
- `summary` (bounded text; non-empty)
- `relatedStepId?` (optional step id string)

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":126,"sessionId":"sess_01JH...","kind":"divergence_recorded","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"divergence_recorded:sess_01JH:div_01JH...","data":{"divergenceId":"div_01JH...","reason":"capability_unavailable","summary":"Delegation was unavailable; executed sequentially and recorded results.","relatedStepId":"investigate"}}
```

#### `gap_recorded` (locked)
Purpose: durable disclosure primitive for never-stop behavior and explainability in blocking modes. Gaps are immutable; “resolution” is linkage.

Payload fields:
- `gapId` (stable identifier)
- `severity`: `info | warning | critical`
- `reason` (category + category-specific closed detail):
  - category: `user_only_dependency | contract_violation | capability_missing | unexpected`
  - detail enums (initial):
    - `user_only_dependency`: see `UserOnlyDependencyReason` below
    - `contract_violation`: `missing_required_output | invalid_required_output`
    - `capability_missing`: `required_capability_unavailable | required_capability_unknown`
    - `unexpected`: `invariant_violation | storage_corruption_detected`
- `summary` (bounded text)
- `resolution`: `{ kind: unresolved } | { kind: resolves, resolvesGapId }`
- `evidenceRefs` (optional, closed set):
  - `{ kind: event, eventId }`
  - `{ kind: output, outputId }`

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":122,"sessionId":"sess_01JH...","kind":"gap_recorded","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"gap_recorded:sess_01JH:gap_01JH...","data":{"gapId":"gap_01JH...","severity":"critical","reason":{"category":"contract_violation","detail":"missing_required_output"},"summary":"Required capability observation output was missing; continuing in never-stop mode.","resolution":{"kind":"unresolved"},"evidenceRefs":[{"kind":"event","eventId":"evt_01JH..."}]}}
```

#### `decision_trace_appended` (initial v2 schema, locked)
Purpose: bounded “why” trace for debugging/audit without relying on the chat transcript. Collapsed by default in Studio; never required for correctness.

Envelope requirements:
- `scope.runId` must be present.
- `scope.nodeId` must be present.

Payload fields:
- `traceId` (stable identifier; primary idempotency key)
- `entries` (non-empty list, bounded)
  - each entry has:
    - `kind` (closed set, initial):
      - `selected_next_step`
      - `evaluated_condition`
      - `entered_loop`
      - `exited_loop`
      - `detected_non_tip_advance`
    - `summary` (bounded text, UTF-8 bytes)
    - `refs?` (optional; closed union, not an open bag)

Decision trace refs (locked):
- `refs` is a **closed-set discriminated union** by `kind`, not `record<unknown>`.
- Allowed ref kinds (initial):
  - `{ kind: "step_id", stepId: string }` — references a workflow step
  - `{ kind: "loop_id", loopId: string }` — references a loop
  - `{ kind: "condition_id", conditionId: string }` — references a condition
  - `{ kind: "iteration", value: number }` — references an iteration (0-based)
- All `stepId`, `loopId`, `conditionId` must be **delimiter-safe**: `[a-z0-9_-]+`
- Max refs per entry: 10
- New ref kinds require an explicit schema version bump or union extension.

Budgets (locked):
- max entries: 25
- max summary bytes per entry: 512
- max total bytes per event: 8192
- if budgets are exceeded, deterministically truncate by bytes and append the canonical truncation marker to the affected summary (never drop entries out of order).

Loop trace completeness (locked intent):
- For any `type:"loop"` execution:
  - the engine MUST record `entered_loop` at loop entry,
  - MUST record `evaluated_condition` for each loop condition evaluation that influences control flow,
  - and MUST record `exited_loop` when the loop terminates.
- These trace entries SHOULD include `refs: { loopId }` (and `iteration?` when applicable) so “loop did not run” and “why did it exit” are diagnosable without inference.
- If a loop terminates without running its body (0 iterations), `evaluated_condition` + `exited_loop` MUST still be recorded (no silent short-circuit).

Canonical truncation marker (locked):
- append exactly: `\n\n[TRUNCATED]`
- truncation is byte-based (UTF-8). To guarantee the marker fits, reserve marker bytes and truncate the original text prefix to the remaining budget.

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":127,"sessionId":"sess_01JH...","kind":"decision_trace_appended","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"decision_trace_appended:sess_01JH:trace_01JH...","data":{"traceId":"trace_01JH...","entries":[{"kind":"selected_next_step","summary":"Chose step 'investigate' because prior evidence reduced uncertainty most.","refs":{"stepId":"investigate"}},{"kind":"detected_non_tip_advance","summary":"Provided state token was non-tip; recording fork marker and continuing on a new branch."}]}}
```

#### `edge_created` (locked)
Purpose: record authoritative relationships between nodes in a run DAG (advancement and explicit fork-from-non-tip markers).

Payload fields:
- `edgeKind`: `acked_step | checkpoint`
- `fromNodeId`, `toNodeId`
- `cause`:
  - `kind`: `idempotent_replay | intentional_fork | non_tip_advance | checkpoint_created`
  - `eventId` (required for explainability; references an event in this session)

Invariants:
- `fromNodeId` and `toNodeId` must refer to nodes in the same run.
- For `edgeKind=acked_step`:
  - `toNodeId` must have `parentNodeId == fromNodeId`.
  - `cause.kind` must be `idempotent_replay` or `intentional_fork` or `non_tip_advance`.
- For `edgeKind=checkpoint`:
  - `toNodeId` must have `parentNodeId == fromNodeId`.
  - `toNodeId` must refer to a node with `nodeKind == checkpoint`.
  - `cause.kind` must be `checkpoint_created`.

Lock (simplification): do not model fork-from-non-tip as a separate edge kind. Fork-ness is represented via `cause.kind=non_tip_advance` on the normal `acked_step` edge and derived via projections/Studio badges.

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":123,"sessionId":"sess_01JH...","kind":"edge_created","scope":{"runId":"run_01JH..."},"dedupeKey":"edge_created:sess_01JH:run_01JH:node_A->node_B:acked_step","data":{"edgeKind":"acked_step","fromNodeId":"node_A","toNodeId":"node_B","cause":{"kind":"intentional_fork","eventId":"evt_01JH..."}}}
```

### Durable outputs: append + supersede linkage (locked)
Durable outputs exist to preserve high-signal progress outside the chat transcript without introducing mutable “documents” that drift under rewinds.

Locks:
- Outputs are recorded only via **append-only** `node_output_appended` events (no in-place edits).
- Each output append assigns a stable **`outputId`** (server-owned identifier for idempotency and explainability).
- Corrections use **linkage**, not mutation:
  - `supersedesOutputId` is optional and indicates “this output corrects/replaces an earlier output”.
  - `supersedesOutputId` is **node-scoped**: it may only reference outputs from the same `nodeId`.
- Output typing is a **closed set**:
  - minimal: `notesMarkdown` (text-first)
  - structured: `outputKind` (closed set) and/or `contractRef` (WorkRail-owned contract pack reference)
- “Current view” is a projection:
  - an output is considered “superseded” if any later `node_output_appended` on the same node references it.
  - history remains visible; the “current” set is derived.

#### `node_output_appended` payload (initial v2 schema, locked)
Purpose: the single durable write path for high-signal progress and optional structured artifacts, attached to a node.

Locks:
- Outputs are append-only facts. Corrections use `supersedesOutputId` linkage (no mutation).
- `supersedesOutputId` is node-scoped: it may only reference outputs from the same `nodeId`.
- Corrections are channel-scoped: `supersedesOutputId` may only reference an output with the same `outputChannel`.
- Output payload is a closed set (initial v2 schema).
- **Deterministic expansion + ordering (locked):** if a single logical operation produces multiple outputs for a node (e.g., multiple `artifact_ref` entries), WorkRail MUST append outputs in a deterministic order:
  - at most one `outputChannel=recap` output first (if produced),
  - then `outputChannel=artifact` outputs ordered by `(sha256, contentType)` ascending (lexical).
- **Deterministic outputId derivation (locked intent):** `outputId` must be stable under retries. When an output is produced as part of an ack attempt, the `outputId` MUST be deterministically derived from the attempt identity and the payload discriminator (do not mint random IDs). The specific string encoding is intentionally opaque and versioned; only the derivation inputs are locked.

Payload fields:
- `outputId` (stable identifier; primary idempotency key)
- `supersedesOutputId?`
- `outputChannel` (closed set):
  - `recap` (default “what happened / what’s next”)
  - `artifact` (structured results referenced by digest)
- `payload` (closed-set discriminated union by `payloadKind`):
  - `notes`:
    - `{ payloadKind: "notes", notesMarkdown }`
  - `artifact_ref`:
    - `{ payloadKind: "artifact_ref", sha256, contentType, byteLength }`
    - `sha256` is a digest of the artifact bytes; artifacts live in the durable artifact store and are referenced, not duplicated into events.

Budgets (locked):
- `notesMarkdown` max bytes: 4096
- if exceeded, deterministically truncate by bytes (preserving the beginning of the text) and append the canonical truncation marker: `\n\n[TRUNCATED]`.

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":124,"sessionId":"sess_01JH...","kind":"node_output_appended","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"node_output_appended:sess_01JH:out_01JH...","data":{"outputId":"out_01JH...","outputChannel":"recap","payload":{"payloadKind":"notes","notesMarkdown":"Completed Phase 1. Next: probe web browsing capability; record observations."}}}
```

#### `observation_recorded` (initial v2 schema, locked)
Purpose: record high-signal workspace identity anchors for deterministic resume/search and explainability (not telemetry).

Locks:
- Session-scoped by default (no `scope.runId` / `scope.nodeId`).
- Closed-set keys + tagged scalar values; “latest” is a projection by max `EventIndex` per key.

Payload fields:
- `key` (closed set, initial):
  - `git_branch`
  - `git_head_sha`
  - `repo_root_hash`
- `value` (tagged scalar closed set, initial):
  - `{ type: "short_string", value }` (bounded)
  - `{ type: "git_sha1", value }`
  - `{ type: "sha256", value }`
- `confidence`: `low | med | high`

Budgets (locked):
- for `value.type="short_string"`, max length: 80

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":125,"sessionId":"sess_01JH...","kind":"observation_recorded","dedupeKey":"observation_recorded:sess_01JH:git_head_sha:4f3c...","data":{"key":"git_head_sha","value":{"type":"git_sha1","value":"4f3c2a1b0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a"},"confidence":"high"}}
```

---

## 2.1) Projection contracts (initial v2, locked)
Projections drive Studio/Console and exports. They MUST be deterministic and derived from durable truth (event log + snapshots + node-attached preferences).

### Current outputs projection (locked)
For a given `nodeId`, the “current” output for a channel is the latest output in that channel that is not superseded by a later output on the same node.

Rules:
- `supersedesOutputId` is node-scoped and channel-scoped.
- A channel’s history remains visible; “current” is derived.

### Run status projection (locked)
Default run status is computed from the **preferred tip** node (per the preferred tip policy).

Let:
- `autonomy` be the effective preference snapshot at the preferred tip node
- `isComplete` be derived from the preferred tip snapshot execution state (`complete` vs `init|running`)
- `hasUnresolvedCriticalGaps` be true iff the run has any unresolved `gap_recorded` with `severity=critical`

Status:
- If `isComplete`:
  - If `hasUnresolvedCriticalGaps`: `complete_with_gaps`
  - Else: `complete`
- Else (not complete):
  - If `autonomy != full_auto_never_stop` and the preferred tip node has any unresolved critical gap in categories `user_only_dependency | contract_violation | capability_missing`: `blocked`
  - Else: `in_progress`

---

## 2.2) Retention + CAS GC (initial v2, locked)
WorkRail is local-only by default. Retention and deletion must be safe and deterministic: never delete reachable durable truth.

### Session retention (locked intent)
- Sessions are eligible for deletion after a configurable TTL (recommended default: 30–90 days).
- Some sessions may be explicitly kept (exempt from TTL) via a WorkRail-owned config/control mechanism (closed set).

### CAS snapshot GC (locked)
Use mark-and-sweep GC rooted in per-session pin lists:
- GC roots: the union of `snapshotRef`s recorded in each retained session’s `manifest.jsonl` (`snapshot_pinned`).
- Reachability is derived; no inference or scanning of event segments is required for GC correctness.
- A CAS snapshot may be deleted only if it is not reachable from any retained session’s roots.

### Safety invariants (locked)
- GC runs only after manifests for all retained sessions are loaded and validated.
- On any manifest corruption or unknown schema version, GC enters **safe mode**: no deletes; emit structured warning.
- Deletion order: delete session storage first (event segments/manifest), then run CAS GC. Never the reverse.

---

## 2.3) `resume_session` deterministic ranking (initial v2, locked)
`resume_session` exists to reduce friction in brand-new chat scenarios where the user does not have a token. Because WorkRail cannot read chat history, ranking MUST be derived from durable truth and be deterministic.

Locks:
- Results are **tip-only** (preferred tip node per run).
- Ranking is deterministic for a given durable store state.
- Responses are bounded (no unbounded history dumps).

### Ranking algorithm (locked)
Use strict tiered matching (layered search as ordering), not probabilistic scoring.

Tier order (highest to lowest):
1) exact match on `git_head_sha` observation
2) exact or prefix match on `git_branch` observation
3) token match on latest preferred-tip `node_output_appended` recap notes (`outputChannel=recap`, `payloadKind=notes`) using the locked normalization rules below
4) token match on workflow id/name (source/compiled metadata) using the locked normalization rules below
5) fallback to recency only

Within a tier, order by:
1) run preferred-tip `lastActivityEventIndex` desc
2) `sessionId` lex (deterministic tie-breaker)

### Response budget (locked)
- max candidates: 5
- max snippet bytes per candidate: 1024 (UTF-8, with canonical truncation marker)

### Match explanations (locked intent)
Each candidate includes a closed-set `whyMatched[]`, e.g.:
- `matched_head_sha`
- `matched_branch`
- `matched_notes`
- `matched_workflow_id`
- `recency_fallback`

### Text matching semantics (locked)
To prevent cross-implementation drift, any “match on text” in resume ranking uses a single deterministic normalization and token matching policy.

Locks:
- Normalize both query and candidate text by:
  1) Unicode normalization: **NFKC**
  2) Lowercase (locale-independent)
  3) Extract tokens matching regex: `[a-z0-9_-]+`
- A candidate “matches notes” iff **all query tokens** appear in the candidate token set (set membership; not raw substring).
- The searchable text corpus excludes:
  - the canonical truncation marker `\n\n[TRUNCATED]`
  - superseded outputs (only “current recap” output for the preferred tip is considered)


### Node snapshots: typed, versioned, minimal
Snapshots must be typed+versioned (not opaque blobs) and must not become a second engine:
- include only minimal rehydration payload + `workflowHash` linkage
- verifiable against the pinned compiled workflow snapshot
- portable for export/import; tokens are re-minted from snapshots

#### Snapshot execution payload boundary (initial v2 schema, locked)
Snapshots store the minimum typed interpreter state required to rehydrate execution deterministically and re-mint runtime tokens, without replaying the event log and without caching projections.

Locks:
- Snapshot payload uses a discriminated union (no booleans-as-state).
- Pending-step presence is explicit (no nullable state):
  - `pending: { kind: "none" } | { kind: "some"; step: PendingStep }`
- Impossible state is rejected:
  - when `pending.kind == "some"`, the pending step instance key MUST NOT be present in `completed`.
- Loop IDs are unique in the compiled workflow:
  - the runtime loop stack must not contain the same `loopId` twice.
- Pending loop path must exactly match the loop stack (loopId+iteration):
  - when `pending.kind == "some"`, `pending.step.loopPath == loopStack.map(loopId, iteration)`.
- Completed step instances are represented as an explicit set wrapper (not a raw array) and must be sorted lexicographically by key.

##### `StepInstanceKey` canonical format (locked)
To avoid escaping footguns, the canonical key format assumes `stepId` and `loopId` are constrained to a delimiter-safe charset.

Constraints:
- `stepId` and `loopId` use only: `[a-z0-9_-]+` (lowercase letters, digits, underscore, hyphen)
- explicitly disallowed: `@`, `/`, `:`

Format:
- If `loopPath` is empty: `StepInstanceKey = stepId`
- Else: `StepInstanceKey = (loopId@iteration joined by "/") + "::" + stepId`

Example:
- `outer@0/inner@2::triage`

---

## 1.2) Token boundary locks (opaque, signed refs) (locked)
WorkRail v2 uses tokens as opaque handles at the MCP boundary. Tokens are **not** durable truth; they are tamper-evident references into the append-only store.

### Token architecture (locked)
- Tokens are **signed refs** to durable truth (no server-side token table).
- Durable truth remains the event log + snapshots; tokens are re-minted on import.

### Token string encoding (locked intent)
- `stateToken` format: `st.v1.<payload>.<sig>`
- `ackToken` format: `ack.v1.<payload>.<sig>`
- `checkpointToken` format: `chk.v1.<payload>.<sig>`
- `<payload>` is base64url of **RFC 8785 (JCS)** canonical JSON containing only the locked fields.

### Token signing + keyring (locked)
To prevent cross-implementation drift and keep validation deterministic, v2 locks the signing algorithm and keyring semantics.

Locks:
- **Signing algorithm**: `HMAC-SHA256`
- **Signing key material**:
  - 32-byte random key
  - stored in a local WorkRail-owned keyring file under the data directory (`keys/keyring.json`)
- **Signature input bytes (locked)**:
  - `<sig>` is computed as `HMAC_SHA256(key, payloadBytes)` where `payloadBytes` are the UTF-8 bytes of the base64url-decoded `<payload>` (which is RFC 8785 JCS canonical JSON).
  - No additional separators, prefixes, or surrounding token strings are included in the HMAC input.
- **Keyring active set (locked)**:
  - exactly two keys are permitted: `current` and optional `previous`
  - verification order is deterministic: try `current`, then `previous`
- **Rotation (locked)**:
  - rotation is explicit (not time-based)
  - on rotation: `current → previous`, generate a fresh `current`
  - tokens signed by `previous` remain valid until the next rotation

### Token payload fields (locked)
`stateToken` payload (all required):
- `tokenVersion: 1`
- `tokenKind: "state"`
- `sessionId`
- `runId`
- `nodeId`
- `workflowHash`

`ackToken` payload (all required):
- `tokenVersion: 1`
- `tokenKind: "ack"`
- `sessionId`
- `runId`
- `nodeId`
- `attemptId`

`checkpointToken` payload (all required):
- `tokenVersion: 1`
- `tokenKind: "checkpoint"`
- `sessionId`
- `runId`
- `nodeId`
- `attemptId`

### Ack idempotency + branching (locked)
- Idempotency key: `(sessionId, runId, nodeId, attemptId)`.
- Replaying the same `ackToken` is an idempotent no-op: return the same response; do not double-advance.
- WorkRail may mint multiple `ackToken`s for the same `(runId, nodeId)` with different `attemptId` values to support intentional forks and safe replay handling.

### Checkpoint idempotency (locked)
- Idempotency key: `(sessionId, runId, nodeId, attemptId)`.
- Replaying the same `checkpointToken` is an idempotent no-op: do not create duplicate checkpoint nodes/edges/outputs; return the same response deterministically.

### Rehydrate/advance/replay separation (locked)
These are **semantics locks** (not just “implementation suggestions”) because v2 correctness depends on them under rewinds/retries.

Locks:
- **Rehydrate is pure**: `continue_workflow` without `ackToken` MUST NOT produce durable writes (no `append`, no outputs, no observations, no gaps, no nodes/edges).
- **Advance is append-capable**: `continue_workflow` with `ackToken` is the only correctness path that can append durable truth for the targeted node.
- **Replay is fact-returning**: replaying the same idempotency key `(sessionId, nodeId, attemptId)` MUST return from durable recorded facts (e.g., `advance_recorded` + referenced nodes/edges/outputs) and MUST NOT “re-run” step selection, validation, or rendering logic.
- **Fail-closed**: if an idempotency key is presented that should have a recorded outcome but none exists, treat it as `ReasonCode.unexpected:invariant_violation` (never silently fall back to recompute).

Implementation lock (TypeScript / structural typing):
- Append-capable APIs MUST require a non-forgeable **capability witness** (e.g., `WithHealthySessionLock` / `CanAppend`) minted only by the session health + lock gate. This prevents accidental writes by “structural” interface matching and makes illegal calls unrepresentable without deliberate construction.
- Witness misuse-after-release MUST fail-fast: if a witness is used outside the lexical lifetime of the gate callback that minted it, append-capable APIs MUST reject the call before any durable I/O. (This prevents “stash-and-reuse” of an old witness, including after a subsequent re-lock of the same session.)

### Token validation errors (errors as data, initial closed set)
- `TOKEN_INVALID_FORMAT`
- `TOKEN_UNSUPPORTED_VERSION`
- `TOKEN_BAD_SIGNATURE`
- `TOKEN_SCOPE_MISMATCH`
- `TOKEN_UNKNOWN_NODE`
- `TOKEN_WORKFLOW_HASH_MISMATCH`
- `TOKEN_SESSION_LOCKED`

---

## 1.3) Export/import bundle (resumable) (initial v2 schema, locked)
Export/import exists to share and resume durable truth across machines without relying on runtime tokens (which are handles only).

### Bundle format (locked)
- Export is a **single JSON bundle** with a versioned envelope.
- Tokens (`stateToken`, `ackToken`) are not included and are not portable.
- On import, WorkRail re-mints fresh runtime tokens from stored nodes/snapshots.

### Bundle envelope (initial v2 schema)
Required top-level fields:
- `bundleSchemaVersion: 1`
- `bundleId` (stable identifier)
- `exportedAt` (informational only; never used for ordering)
- `producer` (informational):
  - `appVersion`
  - `appliedConfigHash?`
- `integrity` (required; see below)
- `session` (required; see below)

### Session contents (required)
The bundle MUST include:
- `sessionId`
- `events`: ordered list of `SessionEvent` in ascending `eventIndex`
- `manifest`: ordered list of `SessionManifestRecord` in ascending `manifestIndex`
- `snapshots`: embedded CAS map keyed by `snapshotRef` containing `ExecutionSnapshotFile` entries
- `pinnedWorkflows`: embedded map keyed by `workflowHash` containing compiled workflow snapshots required for deterministic resume

### Integrity (required)
The bundle MUST include an integrity manifest that allows import to fail fast on corruption.

Initial integrity kind:
- `sha256_manifest_v1`

#### Deterministic hashing rule (locked)
Each integrity entry’s `sha256` is computed over the UTF-8 bytes of **RFC 8785 (JCS)** canonical JSON serialization of the referenced value (arrays preserve their required deterministic ordering, e.g., `events` by `eventIndex`, `manifest` by `manifestIndex`).

Formatting:
- integrity digests use `sha256:<hex>` string form.

Minimum integrity entries (illustrative paths):
- `session/events`
- `session/manifest`
- `session/snapshots/<snapshotRef>`
- `session/pinnedWorkflows/<workflowHash>`

### Import semantics (locked)
- Import defaults to **import-as-new** on session ID collision (no implicit merges).
- Import validates integrity and ordering before storing durable truth.

### Import failure errors (errors as data, initial closed set)
- `BUNDLE_INVALID_FORMAT`
- `BUNDLE_UNSUPPORTED_VERSION`
- `BUNDLE_INTEGRITY_FAILED`
- `BUNDLE_MISSING_SNAPSHOT`
- `BUNDLE_MISSING_PINNED_WORKFLOW`
- `BUNDLE_EVENT_ORDER_INVALID`
- `BUNDLE_MANIFEST_ORDER_INVALID`

Example (skeleton):

```json
{
  "bundleSchemaVersion": 1,
  "bundleId": "bundle_01JH...",
  "exportedAt": "2025-12-19T18:01:02.123Z",
  "producer": { "appVersion": "x.y.z", "appliedConfigHash": "sha256:..." },
  "integrity": {
    "kind": "sha256_manifest_v1",
    "entries": [
      { "path": "session/events", "sha256": "sha256:...", "bytes": 12345 }
    ]
  },
  "session": {
    "sessionId": "sess_01JH...",
    "events": [],
    "manifest": [],
    "snapshots": {},
    "pinnedWorkflows": {}
  }
}
```


#### Snapshot identity + provenance (locked)
- **`SnapshotRef` is content-addressed** (e.g., `sha256:<digest>`).
- Each referencing event also records **`createdByEventId`** for provenance/debugging (content hash for integrity/dedupe; event linkage for explainability).

#### Snapshot storage layout (locked)
- Use a **global content-addressed snapshot store (CAS)** keyed by `SnapshotRef`.
- Each session maintains an **append-only pin list** of referenced `SnapshotRef`s (for export/import and GC safety) rather than copying snapshot files per session.

#### Snapshot payload scope (locked)
- Snapshot payloads are **rehydration-only** (no cached projections like recap text; those remain events/projections).
  - This keeps snapshots from becoming a parallel event log and reduces drift risk.

---

## 1.1) Runs are DAGs; branches are projections (locked)
- A run’s lineage is a **DAG of nodes** connected by edges.
- “Branch” is a **projection concept derived from edges/leaves**, not an additional authoritative identifier (`branchId` is not part of durable truth).

---

## 2) Preferred tip policy (deterministic)

Preferred tip is defined **per run** (not per session).

Selection:
1) identify leaf nodes (no children)
2) compute each leaf’s last-activity as max `EventIndex` among events that touch the node’s reachable history (node/output/gap/capability/prefs/divergence/edge)
3) choose highest last-activity
4) tie-breakers: `node_created` index, then lexical `NodeId`

Never use wall-clock timestamps for tie-breaking.

---

## 3) Gaps + user-only dependencies (closed sets + mode behavior)

### User-only dependencies: closed reasons
`UserOnlyDependencyReason` (initial closed set):
- `needs_user_secret_or_token`
- `needs_user_account_access`
- `needs_user_artifact`
- `needs_user_choice`
- `needs_user_approval`
- `needs_user_environment_action`

Special rule:
- `needs_user_choice` is only emitted when the workflow explicitly marks the choice as **non-assumable** using `NonAssumableChoiceKind`.

`NonAssumableChoiceKind` (closed set):
- `preference_tradeoff`
- `scope_boundary`
- `irreversible_action`
- `external_side_effect`
- `policy_or_compliance`

### Gaps: the never-stop disclosure primitive
Gaps are append-only durable disclosures. They are never mutated; “resolution” is represented by append-only linkage (e.g., `resolvesGapId`).

Projection rule (recommended):
- a gap is considered “resolved” if any later gap record references it via `resolvesGapId` (or equivalent linkage)
- history remains visible; “current state” is a projection

### Mode behavior (core)
- In `guided` and `full_auto_stop_on_user_deps`: user-only dependencies can return `blocked`.
- In `full_auto_never_stop`: never `blocked`; record critical gaps and proceed with explicit durable disclosure.

### Unified reason model (blocked ↔ gaps) (initial v2, locked)
To prevent semantic drift between “blocked” (UX/control-flow) and “gaps” (durable disclosure), v2 locks a single underlying closed-set reason model.

Locks:
- Define a single closed-set `ReasonCode` used as the semantic source of truth for both:
  - `BlockerReport` (returned when the run is blocked in blocking modes)
  - `GapReason` (recorded durably in never-stop and for auditability)
- Blocking vs never-stop changes **control flow**, not meaning:
  - In blocking modes, a `ReasonCode` may produce `blocked` plus durable accounting.
  - In never-stop, the same `ReasonCode` MUST produce a `gap_recorded` (severity per mapping) and execution continues.
- Mapping is deterministic and table-driven (no ad-hoc conversions).

`ReasonCode` (closed set, initial):
- `user_only_dependency:<UserOnlyDependencyReason>`
- `contract_violation:missing_required_output`
- `contract_violation:invalid_required_output`
- `capability_missing:required_capability_unknown`
- `capability_missing:required_capability_unavailable`
- `unexpected:invariant_violation`
- `unexpected:storage_corruption_detected`

Deterministic mapping (locked intent):
- `ReasonCode.user_only_dependency:*`:
  - blocking modes → `blocked`
  - never-stop → `gap_recorded(severity=critical, category=user_only_dependency, detail=<reason>)`
- `ReasonCode.contract_violation:*`:
  - blocking modes → `blocked`
  - never-stop → `gap_recorded(severity=critical, category=contract_violation, detail=<reason>)`
- `ReasonCode.capability_missing:*`:
  - blocking modes → `blocked` iff the capability is required by the compiled workflow
  - never-stop → `gap_recorded(severity=critical, category=capability_missing, detail=<reason>)`
- `ReasonCode.unexpected:*`:
  - always → `gap_recorded(severity=critical, category=unexpected, detail=<reason>)`
  - and the protocol path must fail fast where correctness would be compromised (e.g., corruption on advancement).

---

## 4) Preferences + modes (minimal closed set)

### Preferences (v2 minimal)
- `autonomy`: `guided | full_auto_stop_on_user_deps | full_auto_never_stop`
- `riskPolicy`: `conservative | balanced | aggressive`

`riskPolicy` guardrails:
- allowed: warning thresholds + default selection between correct paths
- disallowed: bypassing contracts/capabilities, changing fork/token semantics, suppressing disclosure, redefining user-only deps

### Invariants (not preferences)
Disclosure is mandatory: assumptions/skips/missing required data must be recorded durably (via outputs and/or gaps).

### Durability + precedence
Effective preference snapshots are node-attached (rewind-safe, export/import safe).
Precedence: node-attached → session baseline → global defaults.

Mode presets (recommended v2 baseline):
- Guided: `autonomy=guided`, `riskPolicy=conservative`
- Full-auto (stop on user deps): `autonomy=full_auto_stop_on_user_deps`, `riskPolicy=balanced`
- Full-auto (never stop): `autonomy=full_auto_never_stop`, `riskPolicy=conservative`

---

## 5) Workflow recommendations + warnings (pinned, no hard blocks)

Recommendations are part of the compiled workflow snapshot (included in `workflowHash`).

### Compiled workflow snapshot + `workflowHash` canonicalization (initial v2, locked)
`workflowHash` is computed from the fully expanded **compiled** workflow snapshot, not raw source JSON. This is the determinism anchor for runs, export/import, and “pinned vs source drift” explainability.

Locks:
- WorkRail persists compiled workflow snapshots keyed by `workflowHash` as durable truth (required for long-lived runs and resumable import/export).
- `workflowHash = sha256(JCS(compiledSnapshotV1))` where `JCS` is RFC 8785 JSON Canonicalization Scheme.
- The compiled snapshot is versioned; new versions require explicit migration logic (do not silently reinterpret old snapshots).

#### `CompiledWorkflowSnapshotV1` (locked, high-level shape)
The compiled snapshot MUST contain enough information to:
- render the exact `pending.prompt` text deterministically
- validate required outputs (contract packs resolved to schemas)
- execute capability probing/fallback paths deterministically
- explain provenance (what was authored vs injected)

#### Function definitions in rewind/resumption context (locked)
Some workflows use `functionDefinitions` + `functionReferences` to reduce repeated instructions (define once, reference many times). Under chat rewinds and brand-new chat resumption, the agent may lose “what does `foo()` mean?” context unless WorkRail rehydrates it deterministically.

Locks:
- Any function definitions and reference wiring that affect the agent-visible instructions MUST be included in the pinned compiled workflow snapshot (and therefore in `workflowHash`). No reliance on transcript memory or external files is permitted for correctness.
- `continue_workflow` **rehydrate-only** responses MUST include the relevant function definitions as part of the bounded recovery context by expanding them into the rendered `pending.prompt` text (preferred) rather than introducing separate agent-facing metadata fields.
- Inclusion is deterministic and byte-budgeted:
  - **Tip node (resume)**: include all function definitions referenced by the pending step instance (including any workflow/loop/step scoped definitions visible to that step).
  - **Non-tip node (rewind/fork)**: include pending step functions **plus** any function definitions referenced by the branch-focused recovery context returned (preferred tip downstream recap + any included child-branch summaries).
  - **Priority**: pending-step referenced functions first, then downstream recap referenced functions, then other branch summaries.
  - **Ordering**: deterministic by `(scope precedence: step → loop → workflow, functionName lex)`.
  - **Truncation**: if function definitions would exceed the response budget, deterministically truncate by bytes (UTF-8) and append the canonical truncation marker `\n\n[TRUNCATED]`, plus a short deterministic omission note (e.g., “Omitted N function definitions”).

Conceptual fields (exact schema is code-canonical and generated):
- `schemaVersion`
- `workflowId`, `name?`, `description?` (identity/explainability; included in the hash to avoid “same content, different identity” ambiguity)
- `agentRole?` (post-merge effective role stance text)
- `capabilities` (desired requirements: required/preferred/disabled)
- `features` (resolved + ordered; includes typed configs)
- `contracts` (resolved contract pack definitions/schemas used by steps/templates)
- `steps[]` (fully expanded step list):
  - `stepId`, `title`, `requireConfirmation`
  - resolved `promptBlocks` and rendered `pending.prompt` text
  - `output.contractRef?` resolved to a contract schema reference
  - provenance: `{ source: authored|template_injected|feature_injected, originId? }`
- `conditions[]` (resolved closed-set conditions referenced by loops/control structures)
- `loops[]` (resolved loop definitions with stable body ordering / indices)
- `compiledWarnings[]` (closed set; no timestamps)

#### Deterministic compilation ordering rules (locked)
To keep `workflowHash` stable and avoid “order by accident” drift, compilation MUST normalize ordering as follows:

- Feature application order:
  - Resolve `features[]` to a deduped list keyed by `featureId`.
  - Apply features in ascending lexical `featureId` order (config is part of the hash; list order in source does not affect determinism).

- Template expansion order:
  - Expand `template_call` steps **in-place** (replace the call with the template’s expanded step list).
  - Template-expanded steps preserve the template-defined order.
  - If multiple templates are injected at the same anchor, order by `(originFeatureId, templateId, injectionIndex)` where:
    - `originFeatureId` is lexical (or empty for authored template calls)
    - `injectionIndex` is a stable ordinal assigned during compilation (no timestamps).

- Step list order (`steps[]` in the compiled snapshot):
  - Preserve authored `steps[]` order.
  - For each `template_call`, substitute its expansion in place (no reordering across siblings).
  - Feature-injected steps are inserted at deterministic anchor points with stable ordering by `(originFeatureId, originId, insertionIndex)`.

- Conditions:
  - Resolve to a closed-set typed list and sort by `conditionId` lex.

- Loops:
  - Loops are resolved from authored `type:"loop"` steps.
  - `loops[]` in the compiled snapshot is sorted by `loopId` lex.
  - Each loop’s `body[]` ordering is authoritative (this ordering defines `bodyIndex`).

- Contracts:
  - Resolve contract packs referenced by steps/templates/features into a deduped list keyed by `contractRef`.
  - Sort resolved contracts by `contractRef` lex.

#### What is explicitly excluded from `workflowHash` (locked)
- runtime tokens (`stateToken`, `ackToken`)
- session/run/node identifiers
- any timestamps
- any environment observations (git branch/SHA, workspace paths)

#### Embedded schema canonicalization (locked)
Compiled workflow snapshots may embed contract schemas (and other structured definitions) that are used for validation and Studio inspection.

Locks:
- Embedded schemas MUST be represented as **typed canonical data** within `CompiledWorkflowSnapshotV1` (not as raw JSON strings/blobs).
- Canonicalization and hashing MUST be performed over the single JCS serialization of the compiled snapshot (no secondary ad-hoc stringification).
- Any ordering within embedded schema structures that is semantically irrelevant MUST be normalized deterministically during compilation (e.g., sort object keys by JCS; sort lists where order is not semantically meaningful).

Closed-set recommendation targets:
- `recommendedAutonomy` (same closed set as `autonomy`)
- `recommendedRiskPolicy` (same closed set as `riskPolicy`)

Warnings:
- emitted when effective preferences exceed recommendation (by closed partial orders):
  - `guided` < `full_auto_stop_on_user_deps` < `full_auto_never_stop`
  - `conservative` < `balanced` < `aggressive`
- structured + text-first
- recorded durably on the node (event or artifact)
- never hard-block user choice

---

## Appendix: capability observation provenance (guardrail)

Capability observations must be durable and self-correcting. To prevent “agent said so” from becoming enforcement-grade truth:
- Capability observations must include a closed-set provenance.
- Only “strong” provenance (e.g., a WorkRail-injected probe step) is treated as enforcement-grade.
- “Weak” provenance (manual claim) may inform UX but must not unlock required capability paths.

---

## 6) Console architecture locks (control plane, not execution plane)

The Console is a WorkRail control plane and observability UI. It must not become an alternate execution truth.

### Projections API is internal-only (locked)
Read-only projections (session/run/node summaries) MUST be implemented as an internal, code-canonical module used by:
- Studio/Console UI
- CLI commands and exports

Lock:
- Do **not** add MCP tools for projections. The agent-facing MCP surface remains minimal; `resume_session` + export/import cover agent needs without expanding tool discovery.

Projection invariants:
- deterministic given durable truth
- bounded payloads (budgeted truncation with canonical marker)
- salvage-aware (clearly labeled; never used for execution advancement)

### Desired vs applied (restart-first UX)

Because tool discovery is bounded at initialization, the Console must model config as:
- **desired**: what the user wants
- **applied**: what is currently active in the running MCP server

Lock:
- On server start, WorkRail computes and records an **`appliedConfigHash`** for the config that is actually in effect.
- The Console must always show **desired vs applied** and the **restart requirement** when they differ.

### Restart-required triggers (closed set)

A config change is **restart-required** if it changes any of:
- the MCP **tool set** (tools added/removed)
- any MCP tool **schema** (inputs/outputs)
- workflow source registration that impacts discovery/catalog (adding/removing sources, enabling/disabling sources)
- feature flags that gate tools or tool schemas

A config change is **runtime-safe** if it only changes:
- read-only presentation settings (UI-only)
- data retention settings for projections (must not affect correctness of existing run graphs)

### Workflow editing (edit source only)

Lock:
- The Console edits **source workflows**, never compiled snapshots.
- Compiled workflows are derived artifacts used for pinning (`workflowHash`) and must not be user-editable.

### Bundled namespace protections

Lock:
- `wr.*` is reserved for bundled/core workflows and is **read-only**.
- Console must provide **fork/copy-to-editable-namespace** for any changes, rather than allowing overrides/shadowing of `wr.*`.

### Source vs compiled inspection + pinned drift warnings

Lock:
- Console must support inspecting:
  - the **source** workflow
  - the **compiled** workflow snapshot
  - the **pinned** snapshot for a given run (`workflowHash`)
- If the on-disk source differs from the pinned snapshot for a run, Console must surface a **pinned drift warning** as structured data (for explainability).

---

## 7) Workflow ID namespaces + migration locks

### Namespaced ID format (normative)

Lock:
- Workflow IDs use `namespace.name` with **exactly one dot**.
- Allowed pattern per segment: `[a-z][a-z0-9_-]*`.
- Reserved namespace: **`wr.*`** is reserved exclusively for bundled/core workflows.

### Enforcement rules (normative)

Lock:
- Any non-core source attempting to define a workflow whose ID starts with `wr.` is **rejected at load/validate time** with an actionable error.
- **No shadowing**: bundled/core (`wr.*`) workflows cannot be overridden by priority order or source precedence.

### Legacy IDs (no dot)

Lock:
- Legacy IDs remain runnable for backward compatibility.
- Creating/saving new workflows with legacy IDs is **rejected** (authoring-time enforcement).
- Loading existing legacy workflows is **warn-only** (do not break existing installs).

### Deterministic rename suggestions

Lock:
- Rename suggestions are deterministic and based on workflow **source**, not user choice:
  - user dir → `user.<name>`
  - project dir → `project.<name>`
  - git/remote/plugin → `repo.<name>` (or `team.<name>` only when explicitly configured)
- The `<name>` segment is the legacy ID normalized (lowercase; hyphens → underscores).
- If the suggested ID collides, append a short deterministic suffix (e.g., `_<sourceHash4>`). Never use timestamps.

### Bundled ID rename timing + aliasing

Lock:
- Bundled workflows should be renamed to `wr.*` **before** v2 pinning is widely created.
- Keep read-only aliases (legacy bundled id → canonical `wr.*`) for backward compatibility, emitting structured warnings.

### Relationship to pinning

Lock:
- `workflowId` is part of the compiled workflow snapshot that is hashed into `workflowHash`. This avoids “same content, different identity” ambiguity and keeps export/import and Console inspection explainable.

### Discovery output to support migration UX

Lock:
- Discovery returns explicit migration fields:
  - `idStatus: namespaced | legacy`
  - `canonicalId?` (when an alias is used)
  - `suggestedId?` (deterministic)
  - `sourceKind` (closed set: bundled | user | project | remote | plugin)

---

## 8) Tools vs docs alignment locks (drift prevention)

v1 suffered from schema/description/documentation drift. v2 must treat this as a first-class failure mode.

### Single canonical source of truth

Lock:
- MCP tool **schemas** and **descriptions** must be generated from the same canonical source (code), not maintained in parallel.
- Any docs that restate tool schemas are **derived artifacts** and must not be hand-edited.

### Generation + verification

Lock:
- Provide a deterministic generator that produces:
  - tool catalog (names, titles, schemas)
  - mode-specific descriptions (all supported modes)
  - any human-facing “tool reference” docs
- CI (or precommit) must fail if generated outputs are out of date relative to the canonical source.

### Editing rule

Lock:
- If a schema or description needs to change, the change is made **only** in the canonical definitions; regenerated outputs follow.
- This prevents “fix docs but forget schema” and “fix schema but forget docs” classes of bugs.

### Generation + verification pipeline (locked)
To prevent drift, WorkRail v2 treats TypeScript domain types + Zod schemas as the **single canonical source** for:
- MCP tool schemas and descriptions
- builtin registries (templates/features/contract packs/capabilities)
- durable store schemas (event log, manifest, snapshots, export bundle)

Generated outputs (derived artifacts):
- JSON Schemas for tool I/O and durable store schemas
- Studio-ready builtins registry metadata
- optional: a single generated “schema reference” doc that links to generated JSON schemas (never hand-edited)

Verification (locked intent):
- Provide a deterministic generator and a verifier.
- The verifier regenerates into a temp location, diffs against the committed generated artifacts, and fails fast with an actionable error if out of date.
- Determinism requirements:
  - stable ordering (sorted keys, stable arrays)
  - no timestamps in generated content
  - stable formatting

---

## 11) Canonical JSON + hashing standard (initial v2, locked)
To prevent cross-transport drift, all hashing in v2 (workflow pinning, bundle integrity, etc.) MUST use a single canonical JSON standard.

Lock:
- Use **RFC 8785 (JSON Canonicalization Scheme, JCS)** for canonical JSON serialization.
- Hash algorithm is SHA-256; digest strings use `sha256:<hex>`.

Applies to:
- `workflowHash` computation (compiled workflow snapshot)
- export/import bundle integrity entries
- any future content-addressed references stored as `sha256:*`

---

## 12) Unified error envelope (initial v2, locked)
To prevent cross-tool drift (MCP vs CLI vs Studio), all surfaced errors MUST use a single envelope shape and closed-set codes per domain.

Envelope shape (conceptual):
- `code` (closed set)
- `message` (human-readable, concise)
- `retry` (closed set; drives deterministic client behavior without parsing prose):
  - `{ kind: "not_retryable" }`
  - `{ kind: "retryable_immediate" }`
  - `{ kind: "retryable_after_ms", afterMs: number }`
- `details?` (bounded, structured; never required for correctness)

Lock:
- Never throw errors across MCP boundaries; map to structured error envelopes.
- Retry guidance MUST be conveyed via `retry` (not `message` or other free-form strings-as-data).

### Agent-first, self-correcting error messages (locked)
v2 must optimize for an honest-but-buggy agent caller. Errors must be actionable without requiring the agent to guess or reverse-engineer schemas.

Locks:
- Errors MUST be **specific**: state what is wrong, where it applies (which tool/input), and why it matters.
- Errors MUST be **self-correcting**: include a `suggestion` that tells the agent exactly what to do next.
- Errors SHOULD include structured `details` that are JSON-safe and deterministic (no file paths, no timestamps).
- For input-size/budget violations (e.g., `context` budget): the error MUST include the measured size, the max size, and the measurement method (e.g., JCS UTF-8 bytes), plus concrete reduction guidance ("remove blobs; pass references").

### Error code domains + boundary rule (locked intent)
To keep errors type-safe and prevent “guess which layer failed” behavior:
- Token-driven MCP execution tools (`start_workflow`, `continue_workflow`, `checkpoint_workflow`) MUST return only `TOKEN_*` codes for token/session locking and token validation failures.
- Storage/projection/Console/CLI operations MUST return only non-token domains (e.g., `SESSION_*`, `STORE_*`, `BUNDLE_*`) for non-token failures.

---

## 13) Local data directory layout (initial v2, locked)
To avoid path drift and scattered state, WorkRail persists all durable truth and derived caches under a single WorkRail-owned local data directory.

Locks:
- The data directory is **WorkRail-owned** (not inside workflow source directories).
- All paths stored in manifests/bundles are **relative** to the session root or bundle root (no absolute paths).

Implementation note:
- The root may be configurable for dev/testing (e.g., via an env var like `WORKRAIL_DATA_DIR`), but **relative-path-only** storage remains a hard invariant.

Conceptual layout (authoritative intent; exact root resolution is platform-specific):
- `data/`
  - `sessions/<sessionId>/`
    - `events/` (JSONL segments)
    - `manifest.jsonl` (segment attestation + snapshot pins)
    - `cache/` (derived, rebuildable projections; safe to delete)
  - `snapshots/` (global CAS, keyed by `snapshotRef`)
  - `workflows/`
    - `pinned/` (compiled workflow snapshots keyed by `workflowHash`)
  - `keys/`
    - `keyring.json` (current + previous signing keys)

---

## 14) Schema versioning policy (initial v2, locked)
Schema versions exist to preserve determinism and avoid silent reinterpretation of durable truth.

Locks:
- Every durable artifact type is versioned:
  - session events (`v`)
  - manifest records (`v`)
  - snapshots (outer `v` and inner `enginePayload` version)
  - compiled workflow snapshots (`schemaVersion`)
  - export/import bundles (`bundleSchemaVersion`)
- **Additive-only within a version**: adding optional fields is allowed; changing meaning or required fields is not.
- **Breaking changes require a version bump** and explicit migration logic (or fail-fast import with actionable error).
- **Unknown versions fail fast** (do not guess).
- **Unknown fields are ignored** only when the version is known and the fields are explicitly optional; otherwise fail-fast with a structured error.

---

## 15) Single-writer enforcement (initial v2, locked)
WorkRail must enforce a single writer per session to keep append-only ordering and idempotency deterministic.

Locks:
- Use an OS-level exclusive file lock on a session-scoped lockfile, e.g.:
  - `sessions/<sessionId>/.lock`
- The lock must be held for the duration of any append sequence that mutates durable truth for that session (event segments and/or `manifest.jsonl`).
- If the lock cannot be acquired, fail fast with a retryable structured error:
  - `TOKEN_SESSION_LOCKED` (for token/advance flows)
  - `SESSION_LOCKED` (for storage/projection operations that are not token-derived)
- Retry guidance is explicit and bounded (e.g., “retry in a few seconds; if this persists, ensure no other WorkRail process is running”).

---

## 16) Implementation sequencing (locked)
To prevent drift and rework, WorkRail v2 implementation MUST follow a “type-first, contract-frozen” sequence:

1) **Canonical models + hashing (no I/O)**:
   - branded ID types + discriminated unions
   - Zod schemas for all durable artifacts (events/manifest/snapshots/compiled snapshots/bundles)
   - RFC 8785 (JCS) canonicalization + SHA-256 helpers
   - generated JSON Schemas + verification (anti-drift)
2) **Pure projections** (deterministic, bounded):
   - preferred tip, run status, current outputs, unresolved gaps, resume ranking
3) **Storage substrate** (ports/adapters):
   - event segments + manifest, CAS snapshots, pinned workflows, locks, recovery/salvage
4) **Protocol orchestration**:
   - token mint/validate, ack attempts, start/continue, export/import
5) **Determinism suite**:
   - golden hash fixtures, replay/idempotency tests, export/import roundtrip tests

## 16.1) Implementation blueprint (where to look) (locked intent)
When implementing WorkRail v2, treat the following documents as the authoritative “blueprint” set. This is intentionally a short list to prevent drift.

1) **Primary authority (locks):**
   - `docs/design/v2-core-design-locks.md` (this document)

2) **Normative MCP boundary contract:**
   - `docs/reference/workflow-execution-contract.md`

3) **Hard platform constraints:**
   - `docs/reference/mcp-platform-constraints.md`

4) **Accepted decision records (rationale for core choices):**
   - `docs/adrs/005-agent-first-workflow-execution-tokens.md`
   - `docs/adrs/006-append-only-session-run-event-log.md`
   - `docs/adrs/007-resume-and-checkpoint-only-sessions.md`

5) **Authoring/compilation shape (compiler must match):**
   - `docs/design/workflow-authoring-v2.md`

6) **Console/Studio UX constraints (UI must not become truth):**
   - `docs/design/studio.md`

7) **High-level summary (non-normative):**
   - `docs/plans/workrail-v2-one-pager.md`

## 16.2) Generation + verifier contract (anti-drift) (locked intent)
To prevent v1-style schema/description drift, v2 requires a deterministic generator + verifier pipeline.

Locks:
- Canonical source of truth is **code-canonical** (TypeScript domain types + Zod schemas).
- Any “tool reference” docs or registries are **generated artifacts**; they must not be hand-edited.
- The verifier regenerates to a temp location and diffs byte-for-byte; it fails fast with an actionable error when outputs are out of date.
- Generated outputs MUST be deterministic:
  - stable ordering
  - no timestamps
  - stable formatting

## 16.3) Closed sets index (v2 minimal) (locked intent)
This section is a convenience index for the closed sets already defined elsewhere in this document. It exists to prevent “string bag” drift during implementation.

- **Preferences**
  - `autonomy`: `guided | full_auto_stop_on_user_deps | full_auto_never_stop`
  - `riskPolicy`: `conservative | balanced | aggressive`
- **Next intent (boundary discipline)**
  - `nextIntent`: `perform_pending_then_continue | await_user_confirmation | rehydrate_only | complete`
- **Capabilities**: `delegation | web_browsing`
- **Edge kind**: `acked_step | checkpoint`
  - `cause.kind`: `idempotent_replay | intentional_fork | non_tip_advance | checkpoint_created`
- **ReasonCode** (semantic source for blockers/gaps): see “Unified reason model (blocked ↔ gaps)”
- **Blocker codes**: `USER_ONLY_DEPENDENCY | MISSING_REQUIRED_OUTPUT | INVALID_REQUIRED_OUTPUT | REQUIRED_CAPABILITY_UNKNOWN | REQUIRED_CAPABILITY_UNAVAILABLE | INVARIANT_VIOLATION | STORAGE_CORRUPTION_DETECTED`
- **Token payload kinds**: `state | ack | checkpoint`
- **Token validation errors**: `TOKEN_INVALID_FORMAT | TOKEN_UNSUPPORTED_VERSION | TOKEN_BAD_SIGNATURE | TOKEN_SCOPE_MISMATCH | TOKEN_UNKNOWN_NODE | TOKEN_WORKFLOW_HASH_MISMATCH | TOKEN_SESSION_LOCKED`
- **Manifest record kinds**: `segment_closed | snapshot_pinned`
- **Run status**: `in_progress | blocked | complete | complete_with_gaps`

## 16.3.1) Context budget and schema discipline (locked)

`context` exists to carry **external inputs** (ticket IDs, repo paths, workflow parameters). It is not durable memory and must not be treated as a “payload bag” for large documents.

Locks:
- **No echo**: execution responses MUST NOT echo the caller’s `context` back verbatim (avoid payload bloat and accidental “send it back” loops).
- **No durability**: `context` is not persisted as durable truth (use `output` for durable memory).
- **JSON-only**: `context` must be JSON-serializable (objects/arrays/primitives only; no functions, symbols, `undefined`, circular refs).
- **Byte budget (fail fast; no silent truncation)**:
  - WorkRail MUST compute context size as UTF-8 bytes of **RFC 8785 (JCS)** canonical JSON for the provided `context`.
  - If the canonicalization fails or size exceeds **256KB**, the tool MUST fail fast with errors-as-data.
  - On MCP tool calls (`start_workflow`, `continue_workflow`), WorkRail MUST fail fast with a **tool error** (code `VALIDATION_ERROR`) that includes: measured bytes, max bytes (256KB), and measurement method (RFC 8785 / JCS UTF-8 bytes), plus concrete reduction guidance (remove blobs; pass references).
- **Schema discipline**:
  - v2 does not support workflow-authored arbitrary context schemas.
  - If a workflow needs required inputs, it must express this via step instructions + mode behavior (block in blocking modes; assume/skip+disclose in never-stop) rather than relying on implicit context echoing.

## 16.4) Implementation playbook (how to execute safely) (locked intent)
This section records execution guidance for large v2 refactors so we keep the implementation aligned with the locks and avoid mid-project drift.

### Before starting (what to consider)
- Prioritize determinism-critical substrate work first (schemas, hashing, idempotency, storage ordering). Do not build features on unstable foundations.
- Maintain strict bounded context boundaries (`src/v2/`) to prevent v2 truth from leaking into v1 mutable session paths.
- Keep closed sets explicit and versioned; do not introduce “bags” (strings/booleans) where an enum/union applies.
- Treat failure modes (crash/retry/rewind) as first-class requirements; design them upfront.
- Enforce anti-drift (generator + verifier) early so docs/schemas cannot diverge.

### How to split the work (recommended: vertical slices with layer discipline)
Build **thin end-to-end paths first**, then expand primitives incrementally. This front-loads integration risk and gives working feedback early while maintaining strict layer boundaries.

**Layer discipline (enforced throughout)**:
- `v2/durable-core/**` stays pure (no Node I/O)
- `v2/ports/**` are interfaces only
- `v2/infra/**` is the only place Node I/O exists

**Vertical slices (recommended sequencing)**:

**Slice 1 — Minimal read-only flow (proves hashing + pinning)**:
- Goal: `list_workflows` + `inspect_workflow` work end-to-end from pinned compiled snapshots
- Build:
  - minimal `CompiledWorkflowSnapshotV1` schema (id/name/description only)
  - JCS canonicalization + `workflowHash` computation (pure)
  - pinned workflow CAS store (port + adapter)
  - minimal MCP handlers (read-only)
- Why first: validates hashing/pinning compose correctly before storage complexity

**Slice 2 — Append-only substrate + projections (proves durable truth)**:
- Goal: session event log segments + `manifest.jsonl` + pure projections working end-to-end
- Build:
  - session event log (write + load): `session_created`, `run_started`, minimal `node_created`/etc.
  - minimal segment + manifest with pin-after-close (single-event segments initially)
  - typed event schema union (locked closed set)
  - pure deterministic projections (run DAG, session health, outputs, capabilities, gaps, advance outcomes, preferences)
- Why second: validates append-only truth + corruption gating + projection correctness before tokens

**Slice 2.5 — Execution safety boundaries (prep for Slice 3)**:
- Goal: gate+witness + readonly/append separation + corruption union so Slice 3 cannot violate purity
- Build:
  - `ExecutionSessionGateV2` (lock+health choke-point)
  - `WithHealthySessionLock` (opaque branded witness; append requires proof)
  - readonly vs append port split
  - `SessionHealthV2` union (`healthy | corrupt_tail | corrupt_head | unknown_version`) with manifest-attested reasons
  - typed snapshot pin enforcement (no `any`)
- Why 2.5: makes rehydrate-purity + replay-no-recompute architecturally enforceable before orchestration

**Slice 3 — Token orchestration (start/continue/rehydrate/replay)**:
- Goal: `start_workflow` + `continue_workflow` working end-to-end; rehydrate is pure; replay is idempotent
- Prerequisites (code-locked before starting Slice 3; see readiness audit below):
  - execution snapshot schema (`ExecutionSnapshotFileV1`, `EnginePayloadV1`)
  - snapshot CAS port + adapter skeleton
  - token payload codec (pure, no signer yet)
  - event union audit (confirm completeness)
  - snapshot-state helpers (`deriveIsComplete`, `derivePendingStep`)
- Build:
  - token signing + validation (HMAC-SHA256; keyring port + adapter)
  - rehydrate use-case (readonly-only; pure)
  - advance use-case (append-capable; requires witness)
  - replay use-case (fact-returning; fail-closed)
  - MCP handlers (`start_workflow`, `continue_workflow`)
- Why third: proves token/snapshot/replay correctness before modes/preferences/blockers

**Slice 4+ — Blocked + gaps, export/import, resume**:
To keep scope coherent and reduce drift risk, treat Slice 4+ as three sub-slices with explicit gates:

- **Slice 4a — Semantics lockdown (blocked ↔ gaps, prefs/modes, contracts)**:
  - build modes/preferences + output contracts + blocked/gap behavior (table-driven; no parallel “reason models”)
  - reconcile canonical docs so the contract points to these locks (avoid “open items” drift)
  - **Lock `notesMarkdown` accumulation semantics** (see Section 18.1 — must decide: per-step fresh vs cumulative)
- **Slice 4b — Portability (Gate 4)**:
  - build export bundle integrity + import validation + token re-minting
  - add export→import equivalence tests over projections (excluding runtime-only tokens/timestamps)
- **Slice 4c — Resumption + checkpoints**:
  - build `resume_session` with locked ranking/matching + budgets (healthy-only)
  - build `checkpoint_workflow` (idempotent via `checkpointToken`)

**Alternative (horizontal phases, safer for inexperienced teams)**:
If vertical slices feel too risky, use the original horizontal sequencing:
1. Phase 0 (canonical core, no I/O)
2. Phase 1 (pure projections)
3. Phase 2 (storage substrate)
4. Phase 3 (protocol orchestration)
5. Phase 4 (determinism suite)

Trade-off: slower feedback but less risk of "cut corners to integrate early."

### Slice N+1 readiness audit (locked; required before complex integration slices)
Before starting a complex integration slice (like Slice 3: orchestration), run this explicit checklist to verify prerequisite boundary schemas/ports/codecs exist. Failing this audit forces mid-slice refactors and risks drift.

**Checklist** (customize per slice):
- [ ] All required schemas exist in code (Zod + TS types) and are locked/versioned.
- [ ] All required ports exist (interfaces) and are well-typed (no base-type bags).
- [ ] Minimal adapters/skeletons exist for critical I/O paths.
- [ ] Golden fixtures exist for canonicalization/hashing (if applicable).
- [ ] Pure helpers/projections needed for orchestration exist and are testable.

**Example: Slice 3 readiness audit** (per resumption pack):
- [ ] Execution snapshot schema (`ExecutionSnapshotFileV1`, `EnginePayloadV1`) exists + golden JCS fixtures.
- [ ] Snapshot CAS port (`SnapshotStorePortV2`) exists.
- [ ] Snapshot CAS adapter skeleton exists (`put`/`get` working).
- [ ] Token payload codec exists (pure encode/decode; signing is later).
- [ ] Event union audited (all locked kinds for Slice 3 are present and typed).
- [ ] Snapshot-state helpers exist (`deriveIsComplete`, `derivePendingStep`).

### Quality gates (how we know each phase is “done”)
- **Gate 0 (schemas + hashing)**: all artifacts validate; generator/verifier passes; golden hash fixtures stable.
- **Gate 1 (projections)**: projections are pure and deterministic; ordering/truncation rules are tested.
- **Gate 2 (storage)**: crash-safety invariants hold; single-writer enforcement works; no salvage guessing.
- **Gate 2.5 (execution safety)**: append requires witness; rehydrate cannot access append ports; health gating works.
- **Gate 3 (protocol)**: rehydrate is read-only; ack advancement is idempotent; replay is fact-returning; forks behave as locked.
- **Gate 4 (portability)**: export/import integrity passes; tokens re-mint deterministically; projections are equivalent post-import.

### Handling issues mid-implementation
- If an invariant mismatch appears, stop and fix the model/lock explicitly; do not add compatibility patches that expand surface area.
- Keep commits small and layered (avoid mixing schema changes with storage changes in one commit).
- Prefer recording bounded, typed trace data (events) over ad-hoc debugging paths when explainability is required.
- When a lock conflicts with reality, make an explicit decision to amend the lock or change approach; never silently diverge.

## 16.5) Polish & Hardening Phase (locked; required before "v2 production-ready")

This phase is **cross-cutting quality work** (not a functional slice). It touches all prior slices to raise code quality, maintainability, and anti-drift enforcement before declaring v2 production-ready.

### When to run this phase
- After all functional slices ship (Slices 1–6+).
- Before v2 unflag / public rollout.
- Can be done in sub-phases (separate PRs) or as one cleanup pass.

### Sub-phase A: Extract constants + remove dead code
- **Magic constants → config/constants module**:
  - Hard-coded budgets/thresholds (e.g., `maxBlockers: 10`, `maxNotesBytes: 4096`, `maxTraceEntries: 25`, `defaultRetryAfterMs: 1000`) → `src/v2/durable-core/constants.ts`
  - Each constant must have a KDoc explaining why the limit exists and referencing the lock doc section
- **Repetitive error messages → builders/templates**:
  - Extract common error message patterns into pure helper functions
- **Hard-coded regex → named constants**:
  - E.g., `STEP_ID_PATTERN`, `SHA256_DIGEST_PATTERN` with comments
- **Remove dead code**:
  - Unused `as any` casts after schema tightening
  - Commented-out code blocks
  - Unused helper functions or types
  - Redundant type assertions

### Sub-phase B: Naming & organization consistency
- **Naming conventions** (pick one and enforce):
  - Ensure all v2 classes/functions/types use consistent `V2` suffixing
  - Port naming: `*PortV2` (consistent across all ports)
  - Error types: `*ErrorV2` or `*Error` (pick one)
- **File organization**:
  - Verify similar abstractions live in similar places (all ports in `ports/`, all adapters in `infra/local/`, all projections in `projections/`)
  - No "misc" or "utils" dumping grounds
- **Import ordering**:
  - Alphabetize or group by layer (types → ports → infra → external)
  - Use consistent import style (named vs default)

### Sub-phase C: Documentation completeness (code-level KDoc)
- **Every port interface** has KDoc explaining:
  - Purpose and locked invariants
  - When/how it should be used
  - What guarantees it provides (e.g., "idempotent", "pure", "crash-safe")
- **Every branded type** has a comment explaining:
  - What footgun it prevents
  - How to construct it safely
- **Every closed-set enum/union** has a comment:
  - Referencing the lock doc section
  - Explaining why it's closed (what drift it prevents)
- **Complex pure functions** have KDoc with:
  - Examples or edge cases
  - Performance characteristics if relevant
  - References to lock doc sections

### Sub-phase D: Anti-drift enforcement (build-time guards)
- **Forbidden import graph tests**:
  - `durable-core/**` must not import from `infra/**` or Node modules (`fs`, `crypto`, `path`)
  - `projections/**` must not import MCP wiring
  - MCP handlers must not import projections directly (only via use-cases)
- **Exact MCP tool registry snapshot test**:
  - Assert the exposed tool set is exactly the locked list (core + flagged)
  - Prevent accidental "projection MCP tools" from being added
- **Generator/verifier in CI** (three targets):
  - **MCP tool schemas/descriptions**: generate JSON Schemas from code-canonical Zod definitions; verifier diffs and fails if out of sync
  - **Builtins registry**: generate Studio-ready metadata (templates/features/contracts/capabilities/refs) from compiler canonical definitions
  - **Durable store schemas**: generate reference docs for events/manifest/snapshots/bundles from Zod schemas
  - All generators run on every commit; fail fast with actionable diff if out of sync
  - Enforce deterministic output (no timestamps, stable ordering)
- **CI workflow validation includes v2 tools**:
  - Extend `scripts/validate-workflows.sh` or add separate v2 tool validation script
  - Validate v2 MCP tool schemas match code-canonical definitions (invoke generator in verify mode)
  - Validate v2 tool descriptions are non-empty and reference current tool names (not v1 `workflow_next`)
  - Run as part of CI `validate-workflows` job or as new CI job (`.github/workflows/ci.yml`)

### Sub-phase E: Test coverage gaps (non-functional but high-signal)
- **Contract tests for v2 MCP tools** (add to `tests/contract/`):
  - `start_workflow` returns expected response shape with valid tokens
  - `continue_workflow` (rehydrate-only) is pure and idempotent
  - `continue_workflow` (with ackToken) advances and returns new tokens
  - `inspect_workflow` returns compiled snapshot with stable workflowHash
  - Response schemas match generated JSON Schemas (verifier ensures this)
- **Property-based tests** for deterministic helpers:
  - JCS canonicalization produces stable bytes for equivalent objects
  - StepInstanceKey formatting roundtrips correctly
  - Token payload encode/decode is bijective
- **Negative path coverage**:
  - Every error code in error unions has at least one test producing it
  - Every corruption reason has a test case
- **Boundary value tests**:
  - Empty arrays, max budgets reached, edge cases for sorting/truncation/deduplication
- **Idempotency/determinism stress tests** (the "no excuses" suite):
  - Replay harness: same operation replayed 100x yields byte-identical results
  - Fork harness: N different `attemptId`s from same node create N distinct branches
  - Export/import roundtrip: projections are equivalent post-import
  - Golden hash stability: workflowHash + token payloads + bundle integrity don't drift

### Sub-phase F: Error ergonomics polish
- **Error message quality**:
  - Every error includes: what went wrong, why it's a problem, what to do next
  - Retry guidance is explicit and bounded (not vague)
  - Structured error payloads include actionable hints (e.g., example next-input for blocked states)
- **Retry union correctness**:
  - Verify all `retry` unions are set correctly (not defaulting to `not_retryable` when retry is safe)
  - Lock-busy errors must include explicit retry timing and "if this persists" guidance

### Sub-phase G: Performance observability (not optimization)
- **Optional trace/timing hooks** (off by default; enabled for debugging):
  - Add minimal hooks in hot paths (projections, event loading, I/O) so you can profile bottlenecks later
  - Use a typed `TracePort` (not `console.log`)
- **Algorithm audit**:
  - Ensure no O(n²) in hot paths (projections, event loading)
  - No accidental repeated file reads (e.g., loading the same snapshot multiple times)
- **Projection budget enforcement**:
  - Verify bounded projections (recap, truncation) actually respect budgets in worst-case scenarios

### Sub-phase H: v1/v2 firewall (deprecation clarity)
- **Boundary tests**:
  - v2 code must not import from v1 session/dashboard paths
  - v2 must not leak into v1 mutable session world
- **Deprecation markers**:
  - Add explicit warnings in v1 code pointing to v2 equivalents
  - Ensure v2 feature flag gating is clean (no "half v2" states where some tools are v2 and others are v1)

---

## 9) Authoring ergonomics locks (initial v2)
These locks exist to keep authoring low-friction without compromising determinism, type-safety, or drift prevention.

### IDs and validation (locked)
- Workflow IDs follow the namespaced format (see section 7).
- Step and loop identifiers that participate in execution state MUST be delimiter-safe:
  - `step.id` and `loopId` MUST match `[a-z0-9_-]+`
  - disallow `@`, `/`, `:` to keep `StepInstanceKey` unambiguous without escaping logic.
- Studio/CLI validation must fail fast with actionable errors and offer deterministic auto-fix suggestions.

### Builtins discoverability (locked)
- Templates/features/contract packs/capabilities are WorkRail-owned closed sets.
- Studio’s Builtins Catalog is generated from the same canonical definitions used by the compiler (never hand-maintained).
- Authoring UX must not require “secret menu knowledge”: autocomplete + insert actions are first-class.

### Prompt references / inline canonical injections (initial v2, locked)
Workflows may reference WorkRail-owned canonical information *inline* in prompts (e.g., “WorkRail v2 definition”, “append-only truth”, “modes semantics”) without copy/paste.

Locks:
- **Compile-time only**: reference resolution happens only during workflow compilation. Runtime does not “look up” refs.
- **Closed set**: referenced snippets use WorkRail-owned IDs in the reserved namespace: `wr.refs.*` (no author-defined arbitrary include paths).
- **No string templating**: do not support `{{ }}` interpolation, file-path includes, or URL includes. References must be typed and validated.
- **Hashing (locked choice)**: the compiled workflow snapshot MUST embed the **fully resolved reference text** for every `wr.refs.*` usage (not just `{refId, refContentHash}`). This embedded text is part of the hashed compiled snapshot and therefore influences `workflowHash` (pinned determinism).
- **Export/import implication**: because refs are embedded, resumable bundles do not need any additional “ref registry snapshot” concept; the pinned compiled workflow snapshot remains self-contained.
- **Budgets**:
  - per referenced snippet max bytes (compiler enforced)
  - per step injected bytes cap (compiler enforced)
  - on violation: fail validation with errors-as-data (no silent truncation).
- **Allowed placements** (to keep prompts instruction-first):
  - references are allowed only within structured prompt sections (`promptBlocks.constraints`, `promptBlocks.procedure`, `promptBlocks.verify`, and optionally `promptBlocks.goal`).
  - references are disallowed inside arbitrary free-form prose fields where they would become unreadable walls of text.
- **Provenance**: compiled steps must retain provenance for injected content (at minimum: `refId` + `refContentHash` + byte counts) so Studio can render Source vs Compiled and explain “where this text came from”.

Design intent:
- Treat `wr.refs.*` as a builtin kind (like templates/features/contracts) and power it via a generated registry from canonical compiler definitions (anti-drift).

### Capabilities + contracts ergonomics (locked intent)
- Capability probes for `required` capabilities should be compiler-injected (collapsed by default) and recorded durably with strong provenance.
- Structured outputs require explicit contracts (no inline schema authoring); templates may imply `contractRef` to reduce author burden.

#### Workflow-authored output schemas (rejected for v2; locked)
Workflows often want workflow-specific structured artifacts (tables, findings, comment sets) beyond free-form notes. v2 intentionally **does not** allow workflows to author arbitrary inline JSON schemas (or project-local schema refs) for required outputs.

Locks:
- Output schema authoring is **WorkRail-owned**:
  - Steps declare requirements only by referencing a WorkRail-owned contract pack via `output.contractRef` (`wr.contracts.*`).
  - The set of contract packs is a closed set generated from code-canonical definitions (anti-drift).
- No workflow-authored schema sources:
  - Disallow inline schema definitions in workflow JSON.
  - Disallow “schemaRef” fields that point to project files, git URLs, or external registries.
- If a workflow needs richer structured artifacts:
  - Expand the WorkRail-owned contract pack catalog (preferred), or
  - fall back to `output.notesMarkdown` (generic durability) until an appropriate pack exists.

Rationale:
- Prevents schema drift and validation inconsistency across MCP/CLI/Studio.
- Keeps compilation deterministic and `workflowHash` stable.
- Preserves Studio rendering determinism and avoids “arbitrary schema” footguns.

### Contract pack registry + pinning (locked intent)
- Contract packs are WorkRail-owned and generated from canonical definitions (code).
- The compiled workflow snapshot MUST embed the resolved contract pack schemas/examples actually used (as part of the hash inputs), so:
  - long-lived runs remain deterministic even if packs evolve on disk
  - export/import bundles are self-contained

### Loops authoring (locked intent)
- Loops are authored explicitly as `type: "loop"` steps with:
  - unique delimiter-safe `loopId`
  - explicit ordered `body[]` (authoritative for `bodyIndex`)
  - required `maxIterations` (no defaults)
  - `while` as `{ kind:"condition_ref", conditionId }` referencing a closed-set condition definition
- Condition definitions are a closed set; do not introduce arbitrary expression strings.
- Prefer a contract-validated `loop_control` condition kind for real loops, rather than reading arbitrary `context` keys.
- `wr.contracts.loop_control` is the initial contract pack for loop exit control:
  - validates an `output.artifacts[]` entry with `kind="wr.loop_control"` and fields `{ loopId, decision, summary? }`

Additional locks (prevents silent loop no-op):
- **Loop control source (locked):** `while` loop continuation MUST NOT be controlled by mutable ad-hoc `context` keys (e.g., `continuePlanning`) because missing/incorrect agent output can cause the loop body to be skipped without detection.
- **Loop control contract (locked):** loop continuation MUST be derived from a contract-validated loop-control artifact/output (e.g., `wr.contracts.loop_control`), produced by an explicit loop decision step.
- **Failure mode (locked):** missing/invalid loop-control output MUST NOT be treated as “exit loop” implicitly.
  - In blocking modes: return a typed blocker (`MISSING_REQUIRED_OUTPUT` / `INVALID_REQUIRED_OUTPUT`) referencing the loop-control contract.
  - In never-stop mode: record a `gap_recorded` (severity=critical, category=contract_violation) and proceed according to the mode’s semantics.
- **Explainability (locked intent):** the loop decision step SHOULD include a bounded summary explaining why the loop continues or exits (stored as part of the loop-control artifact output).

Loop iteration semantics (locked) (prevents maxIterations/iteration conflicts):
- **Iteration indexing (locked):** `loopStack[].iteration` is **0-based**. The first loop iteration is `iteration=0`.
- **`maxIterations` meaning (locked):** `maxIterations` is a **count** of allowed loop iterations (not a max index).
  - Allowed iteration values are: `0..(maxIterations - 1)`.
  - A loop MUST NOT enter/execute a body iteration when `iteration >= maxIterations`.
- **Iteration increment point (locked):** `iteration` increments **only when starting the next loop iteration** (i.e., after completing the loop body for the previous iteration and deciding to continue). It MUST NOT increment mid-body.
- **Termination reason (locked intent):** loop termination MUST be attributable to exactly one of:
  - condition evaluated false, or
  - max iterations reached (the next would-be iteration would have `iteration == maxIterations`).
- **Failure mode (locked):** attempting to continue a loop when `iteration >= maxIterations` MUST fail fast as errors-as-data (no silent stop, no “stuck”):
  - In blocking modes: return a typed blocker (a dedicated loop-limit code is preferred; `INVARIANT_VIOLATION` is acceptable if no dedicated code exists yet).
  - In never-stop mode: record a `gap_recorded` (severity=critical, category=unexpected, detail=`invariant_violation`) and proceed according to mode semantics.
  - The blocker/gap MUST include `loopId`, `iteration`, and `maxIterations` in bounded structured details.

### Source vs compiled clarity (locked)
- Studio must clearly distinguish:
  - source workflow
  - compiled workflow (what is hashed)
  - pinned snapshot used by a run
- Compiled view must show injection provenance and “hash inputs” at a glance to reduce surprise and drift.

---

## 10) Operational envelope locks (pre-implementation)
These locks cover runtime failure modes, rollout posture, and determinism verification. They are intentionally “ops-shaped” but must remain deterministic and drift-proof.

### Corruption handling (locked)
We distinguish between **execution correctness** and **read-only UX**:
- Execution paths (token validation, rehydrate/advance, export integrity, etc.) are **strict fail-fast** on corruption relevant to the requested run/node.
- Read-only views (Studio/Console inspection and export of valid prefix) may operate in **salvage mode**:
  - load and render only up to the last valid manifest entry
  - clearly banner “corrupt tail / partial data” and never claim correctness beyond the validated prefix

Salvage surface (locked intent):
- Salvage mode is **read-only**:
  - allowed: inspect/export of validated prefix
  - disallowed: `continue_workflow` advancement from a salvaged tail
- `resume_session` must only return candidates from fully validated sessions (no candidates that require corrupted tail data).
- Corruption must be surfaced as structured warnings/errors with a closed set of codes (no silent fallback).

### Session health + tool gating (locked)
To prevent accidentally using salvage reads as an execution correctness path, v2 defines a closed-set session health classification and gates tools accordingly.

`SessionHealth` (closed set, initial):
- `healthy`
- `corrupt_tail` (validated prefix available)
- `corrupt_head` (no usable prefix)
- `unknown_version`

Tool gating (locked intent):
- Execution correctness tools MUST require `SessionHealth=healthy` for the target session/run/node:
  - `continue_workflow` advancement (with `ackToken`)
  - `checkpoint_workflow`
  - token minting/advancement paths that depend on durable truth for correctness
- Read-only tooling (Studio/Console inspection and export) MAY operate on `SessionHealth=corrupt_tail` using only the validated prefix, but MUST:
  - set an explicit salvage/banner flag in responses/exports (no silent partial data)
  - forbid any advancement/mutation from salvaged sessions

### Token signing key management (locked intent)
- Use a local **key ring file** containing a small active set (current + previous).
- Rotation is explicit (manual / controlled), not time-driven.
- Validation accepts tokens signed by any active key; tokens are not exported/imported.

Key ring storage (locked intent):
- Store the key ring in the WorkRail local data directory (WorkRail-owned, not user-authored workflow dirs).
- File must be readable/writable only by the current user (best-effort; platform-specific).
- Keep exactly two active keys: `current` and `previous`.
- Rotation semantics:
  - on rotation, `current` becomes `previous` and a fresh `current` key is generated.
  - tokens signed by `previous` remain valid until the next rotation.

### v1 coexistence and deprecation posture (locked intent)
- v2 is the correctness model; v1-style mutable session tools are not part of v2 truth.
- If v1 session tools exist for legacy reasons, keep them behind an explicit feature flag during rollout.
- No migration story is required: legacy sessions are not treated as durable truth.

### Projections + indexing (locked intent)
- Studio-facing projections may be cached as a **derived, rebuildable** per-session index.
- The cache is never truth: it is safe to delete and deterministically rebuild from the append-only store.

Projection cache invariants (locked intent):
- Cache format is versioned and includes the last processed `EventIndex`/`ManifestIndex` so rebuild/incremental update is deterministic.
- Any cache schema version mismatch or corruption causes the cache to be discarded and rebuilt (safe fallback).
- Cache must not include any data that would change correctness (e.g., it must not override preferred tip policy).

### Determinism verification suite (locked intent)
Provide a minimal “no excuses” suite that asserts v2 guarantees:
- golden fixtures for `workflowHash` (compiled snapshot → JCS bytes → sha256)
- replay harness for idempotency and branching (replay tool calls / ack attempts yields identical durable truth)
- export/import roundtrip tests (bundle integrity + token re-mint + projection equivalence)

### Rollout flags: unflag criteria (locked intent)
Some tools begin feature-flagged to reduce rollout risk. Unflagging MUST be evidence-based and driven by deterministic quality gates (not “it feels stable”).

#### `resume_session` unflag gates
- Session health gating is implemented: only `SessionHealth=healthy` sessions are eligible candidates.
- Deterministic ranking/matching is implemented exactly as locked (tiers + normalization + bounded snippets).
- Export/import roundtrip preserves resume results (post-import candidate set and ordering is equivalent for the same store contents).
- Corruption/salvage behavior is correct: corrupt sessions do not appear as candidates; errors are structured.

#### `checkpoint_workflow` unflag gates
- Idempotency is enforced via `checkpointToken` (replay-safe; no duplicate checkpoint nodes/edges/outputs).
- Checkpoint edges are recorded (`edgeKind=checkpoint`, `cause.kind=checkpoint_created`) and visible in projections.
- Rehydrate-only remains side-effect-free and cannot accidentally create checkpoint artifacts.
- Export/import roundtrip preserves checkpoint nodes/edges/outputs and re-mints `checkpointToken` deterministically.

### Notable refinement ideas (deferred; non-blocking)
These emerged during Slice 2.5 risk analysis and Polish & Hardening ideation but are not required for v2 correctness. They may be valuable later enhancements:

- **Linear append transaction primitive**: make `AppendPlan` one-shot/consumed (prevents accidental partial appends or stale plan reuse). This would require wrapping the plan in a linear capability token that is invalidated after append.
- **Pure deterministic renderer with fixtures**: for response text (recap/pending prompts). Keeps replay deterministic without storing full responses in durable truth. Renderer version is internal-only (not exposed to MCP).
- **Determinism diff tool**: for debugging; given two runs/bundles, compute canonical JCS diffs of key artifacts (events, snapshots, manifests) to localize drift. Useful for troubleshooting "why did replay produce different bytes?"

---

## 17) Implementation architecture map (locked)
WorkRail v2 implementation MUST use a coherent, compositional architecture so components integrate without drift.

### Unifying style (locked)
- **Functional core / imperative shell**:
  - pure functions for determinism-critical logic (schemas/normalization, JCS+hashing, compilation, projections, idempotency decisions)
  - small adapters for side effects (filesystem, locks, keyring IO, crypto primitives)
- **Ports & adapters** (Clean Architecture):
  - use-cases orchestrate ports; MCP handlers remain thin mappers
- **Errors as data**:
  - typed, closed-set error codes; `Result`-style flow; no throwing across MCP boundaries

### Side effects live at the edges (locked)
All non-pure operations MUST be isolated behind ports/adapters and kept out of the functional core:
- filesystem reads/writes (segments, manifest, CAS snapshots, pinned workflows, bundles)
- file locks
- keyring IO
- crypto primitives (HMAC/sign/verify)
- clocks (timestamps are informational only; never used for ordering or tie-breaking)

### Canonical “core” modules (must exist)
- **Canonical models**: branded IDs + discriminated unions + Zod schemas (code-canonical source of truth)
- **Canonicalization + hashing**: RFC 8785 (JCS) serializer + SHA-256 wrapper; hashing only accepts typed canonical artifacts
- **Compiler**: pure pipeline producing `CompiledWorkflowSnapshotV1` with deterministic ordering + provenance
- **Projections** (internal-only): pure read-model reducers/policies (preferred tip, run status, resume ranking, current outputs/gaps), bounded + salvage-aware

### Persistence ports (must exist)
- `SessionStorePort`: append/load domain events + manifest (session-scoped locking enforced here)
- `SnapshotStorePort`: CAS get/put by `SnapshotRef` (immutable)
- `PinnedWorkflowStorePort`: store/load `CompiledWorkflowSnapshotV1` keyed by `workflowHash`
- `ProjectionCachePort`: derived, rebuildable cache (versioned; never truth)
- `KeyRingPort`: current/previous keys + rotation

### Directory/package layout (Phase 0–2, locked)
Concrete structure under `src/v2/` bounded context:

```
src/
  v2/
    durable-core/
      ids/
        index.ts                    # exports branded types (SessionId, RunId, NodeId, EventId, etc.)
      errors/
        index.ts                    # exports unified error envelope + closed code unions
      canonical/
        jcs.ts                      # RFC 8785 canonicalizer (uses CryptoPort)
        hashing.ts                  # sha256 wrapper + typed hash helpers
      schemas/
        session-event/
          index.ts                  # SessionEvent Zod + types
        session-manifest/
          index.ts                  # SessionManifestRecord Zod + types
        execution-snapshot/
          index.ts                  # ExecutionSnapshotFile + enginePayload.v1 Zod + types
        compiled-workflow/
          index.ts                  # CompiledWorkflowSnapshotV1 Zod + types
        export-bundle/
          index.ts                  # Bundle Zod + types
      projections/
        session.ts                  # projectSessionSummary, projectSessionHealth
        run.ts                      # projectRunStatus, projectPreferredTip
        node.ts                     # projectNodeCurrentOutputs, projectNodeGaps
        resume-ranking.ts           # deterministic resume ranking logic
        policies/
          preferred-tip.ts          # preferred tip policy (pure)
          run-status.ts             # run status derivation (pure)
    ports/
      crypto.port.ts
      data-dir.port.ts
      file-lock.port.ts
      session-store.port.ts
      snapshot-store.port.ts
      pinned-workflow-store.port.ts
      projection-cache.port.ts
    infra/
      local/
        data-dir/
          index.ts                  # DataDirPort file implementation
        file-lock/
          index.ts                  # FileLockPort OS-level lock implementation
        session-store/
          index.ts                  # SessionStorePort file implementation (segments + manifest)
        snapshot-store/
          index.ts                  # SnapshotStorePort CAS file implementation
        pinned-workflow-store/
          index.ts                  # PinnedWorkflowStorePort file implementation
        projection-cache/
          index.ts                  # ProjectionCachePort file implementation
        crypto/
          index.ts                  # CryptoPort implementation (Node crypto)
```

Lock:
- Files under `durable-core/` export only pure functions and types.
- Files under `ports/` export only TypeScript interfaces.
- Files under `infra/` are the only places Node I/O is allowed.

### Integration rule (locked)
- Studio/Console and CLI MUST consume the internal projections module; do not duplicate projection logic or expose new MCP tools for projections.

### Dependency layering (locked)
To keep the functional core pure and prevent side-effect creep, module imports MUST follow these rules:

Pure core (no Node I/O or side effects):
- `v2/durable-core/ids` → exports branded ID types + smart constructors
- `v2/durable-core/errors` → exports unified error envelope + closed code unions
- `v2/durable-core/canonical` → exports RFC 8785 (JCS) canonicalizer + SHA-256 helpers (uses `CryptoPort`)
- `v2/durable-core/schemas/**` → exports Zod schemas + inferred TS types for all durable artifacts
- `v2/durable-core/projections/**` → pure projection functions over typed events/snapshots

Ports (pure interfaces only):
- `v2/ports/**` → TypeScript interfaces; no Node imports, no implementation

Infra (side effects only):
- `v2/infra/**` → file I/O, locks, keyring; imports from `durable-core` and `ports`; provides port implementations

Lock:
- `v2/durable-core/**` MUST NOT import from `v2/infra/**` or any Node I/O modules (fs, crypto, path).
- `v2/ports/**` MUST NOT import from `v2/infra/**`.
- Side effects are injected via ports; pure core consumes port interfaces only.

### Port interfaces (Phase 0–2, locked)
These are the exact TypeScript interfaces required for Phase 0–2 (initial v2 schema). All return `Result` or `ResultAsync` from `neverthrow`.

**Phase 0 (minimal ports, for hashing/canonicalization)**
- **`CryptoPort`**:
  - `sha256(bytes: Uint8Array): Sha256Digest`

- **`DataDirPort`**:
  - `getRoot(): AbsolutePath`
  - `sessionRoot(sessionId: SessionId): AbsolutePath`
  - `snapshotPath(snapshotRef: SnapshotRef): AbsolutePath`
  - `pinnedWorkflowPath(workflowHash: WorkflowHash): AbsolutePath`

**Phase 2 (storage + locking)**
- **`FileLockPort`**:
  - `withSessionLock<T>(sessionId: SessionId, fn: () => ResultAsync<T, E>): ResultAsync<T, SessionLockedError | E>`

- **`SessionStorePort`**:
  - `append(sessionId: SessionId, plan: AppendPlan): ResultAsync<AppendResult, SessionStoreError>`
  - `load(sessionId: SessionId): ResultAsync<LoadedSession, SessionStoreError>`
  - `loadValidatedPrefix(sessionId: SessionId): ResultAsync<LoadedSessionPrefix, SessionStoreError>` (salvage)

- **`SnapshotStorePort`** (CAS):
  - `put(snapshot: ExecutionSnapshotFile): ResultAsync<SnapshotRef, SnapshotStoreError>`
  - `get(snapshotRef: SnapshotRef): ResultAsync<ExecutionSnapshotFile, SnapshotStoreError>`

- **`PinnedWorkflowStorePort`**:
  - `put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshotV1): ResultAsync<void, PinnedWorkflowError>`
  - `get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshotV1, PinnedWorkflowError>`

- **`ProjectionCachePort`** (derived):
  - `get(sessionId: SessionId): ResultAsync<ProjectionCache | null, CacheError>`
  - `put(sessionId: SessionId, cache: ProjectionCache): ResultAsync<void, CacheError>`
  - `invalidate(sessionId: SessionId): ResultAsync<void, CacheError>`

Locks:
- All methods return `Result` or `ResultAsync` with typed errors (no throws).
- Branded types for IDs, hashes, and all payloads (no string/number soup).
- `AppendPlan`, `LoadedSession`, etc. are defined in `v2/durable-core` and imported by ports (keep ports pure interfaces).


---

## 18. Open Items (Slice 4a)

### 18.1 notesMarkdown Accumulation Semantics

**Issue**: Current tool description and contract docs don't explicitly state whether `output.notesMarkdown` in `continue_workflow` is:
- **Per-step fresh** (agent provides summary of THIS step only)
- **Cumulative** (agent appends to or includes previous notes)

**Impact**: Ambiguity will cause agents to produce exponentially growing cumulative notes, making deterministic truncation impossible and violating byte budgets.

**Current implementation** (Slice 3):
- Notes are **stored** in event log as `node_output_appended` (channel=`recap`)
- Notes are **not yet returned** in `continue_workflow` responses
- No agent guidance on accumulation behavior

**Proposed lock** (for Slice 4a):

`notesMarkdown` is **per-step, not cumulative**:
- Each `continue_workflow` call receives a **fresh summary** of work accomplished in that specific step
- Agent MUST NOT append to or reference previous step notes in `notesMarkdown`
- WorkRail aggregates notes across steps via the recap projection with deterministic budgeting
- When recap is returned (Slice 4a/4b), it's WorkRail's responsibility to provide bounded context from previous steps

**Rationale**:
1. **Deterministic truncation**: Per-step notes have predictable size; cumulative notes depend on entire chat history
2. **Byte budget enforcement**: Fresh notes can be validated against max bytes (4096); cumulative notes violate budgets by construction
3. **Rewind safety**: Each step's notes are independent; cumulative notes require reading all previous notes (breaks rehydrate purity)
4. **Composability**: Projections can aggregate/filter/budget notes deterministically

**Where to document** (when locked):
1. Update `src/mcp/v2/tools.ts` schema description for `notesMarkdown`
2. Add normative section to `docs/reference/workflow-execution-contract.md`
3. Update `docs/plans/workrail-v2-design-resumption-pack.md` philosophy section

**Decision needed before Slice 4a ships.**

**DECISION (Slice 4a continuation)**: LOCKED as **per-step fresh**.
- Tool schema updated: `src/mcp/v2/tools.ts` (describes per-step semantics)
- Contract updated: `docs/reference/workflow-execution-contract.md` (normative section added)
- Implementation: Slice 4a S6 (schema + docs)

### 18.2 Context Persistence and Auto-Loading

**Issue**: Current design lock Section 16.3.1 states "context is not persisted as durable truth," but Slice 3 implementation reveals this creates fragility:
- Agents must manually re-pass context on every `continue_workflow` call
- Missing context keys cause cryptic `advance_next_failed` errors deep in the interpreter
- Context is lost on rewinds, preventing effective resume
- Long workflows (20+ steps) compound the cognitive load and failure probability
- No way to recover context after agent restart or handoff

**Impact**: The stateless context design works for simple workflows but breaks down for:
- Complex workflows with external dependencies (forEach over `context.slices`, feature flags, environment config)
- Long-running workflows (>10 steps) where context re-passing becomes error-prone
- Rewind scenarios where agent loses local context
- Multi-agent handoffs or resume-after-delay scenarios

**Current state** (Slice 3):
- Context is validated at MCP boundary (256KB limit, JSON-only, RFC 8785 JCS)
- Context is passed to interpreter for condition evaluation
- Context is **not stored** in events or snapshots
- Agent must re-pass on every call or face errors

**Design tension identified:**
The lock assumes context is **simple external inputs** (ticket IDs, paths), but real workflows use context for:
- Loop iteration data (`context.slices` for forEach)
- Conditional gating (`context.featureFlags` for if/else)
- Workflow parameters that don't change but must be available throughout execution

**Three approaches validated via subagent analysis:**

#### Approach A: context_set Event (Append-Only)
Store context as immutable events in the event log:
```typescript
{
  kind: "context_set",
  scope: { runId },
  data: {
    contextId: string,
    context: Record<string, unknown>,
    source: "initial" | "agent_delta" | "merge"
  }
}
```

**Pros:**
- Append-only compatible (events are immutable)
- Single source of truth (everything in event log)
- Auditable (full context history visible)
- Proven pattern (mirrors `preferences_changed`)
- Supports context evolution (new context_set events as needed)

**Cons:**
- Violates Section 16.3.1 "no durability" lock (requires lock revision)
- O(n) query without metadata cache (mitigated by metadata/context.jsonl pattern)
- 18 existing tests break (assume stateless)
- 17-22 new tests needed for edge cases

**Implementation:** ~11 hours + ~25 hours testing + security hardening

#### Approach B: Context in Token Payload
Embed context directly in `stateToken` payload.

**Verdict:** ❌ REJECTED
- Token size explosion (256KB context → 347KB token)
- Breaks idempotency (signature depends on context)
- Violates 4-5 token design locks

#### Approach C: Separate CAS Context Store
Store context in parallel CAS store alongside snapshots.

**Verdict:** ⚠️ VIABLE but complex
- Not in event log (dual sources of truth)
- Requires new infrastructure
- Garbage collection needed
- Higher implementation cost

**Subagent validation results:**
- **Architect**: ❌ Rejects (violates locks, idempotency concerns)
- **Developer**: ✅ Feasible (6-8 days, 195 LOC)
- **QA**: ⚠️ 18 tests break, needs design clarifications
- **Security**: 🔴 5 critical issues (encryption, sanitization, attribution)
- **Performance**: ❌ Unacceptable without metadata cache (15s overhead at 1000 steps)

**Proposed lock revision** (for Slice 4a):

**Revise Section 16.3.1 to allow durable context storage:**

Context durability rules (revised):
- **Initial context durability**: `context` provided to `start_workflow` IS persisted as a `context_set` event for the run
- **Context evolution**: Additional `context_set` events record context deltas/changes throughout execution
- **Auto-loading**: `continue_workflow` automatically loads the latest context from `context_set` events (agent does not re-pass)
- **Optional delta**: Agent may provide `context` parameter to merge with stored context (delta overrides stored fields)
- **No echo**: Responses still MUST NOT echo full context back (only contextId or summary if needed)
- **Byte budget**: Still enforced (256KB max) at `start_workflow` and per `context_set` event
- **Projection**: Latest `context_set` event for a runId defines current context
- **Performance**: Use metadata cache pattern (`metadata/context.jsonl`) for O(1) lookup

**Rationale for revision:**
1. **Empirical evidence**: Slice 3 manual testing revealed stateless context is fragile for real workflows
2. **Alignment with v2 philosophy**: Context artifacts are immutable (append-only compatible)
3. **Proven pattern**: Mirrors `preferences_changed` and `node_output_appended` event designs
4. **User experience**: Agents should execute steps, not manage distributed state
5. **Rewind safety**: Durable context enables true resume after rewinds

**Implementation requirements:**
1. Add `context_set` to DomainEventV1 discriminated union
2. Create context projection (`projectRunContext`)
3. Emit `context_set` in `start_workflow` handler
4. Auto-load context in `continue_workflow` handler
5. Support optional delta merging
6. Add metadata cache for performance (O(1) lookup)
7. Security: sanitize `__proto__`, `constructor`, `prototype` fields
8. Testing: 17-22 new test cases for context evolution, replay, forks

**DECISION (Slice 4a continuation)**: LOCKED as **Approach A (context_set event, run-scoped)**.
- Event schema: `context_set` added to `DomainEventV1Schema` with `scope: { runId }` (run-scoped, not node-scoped)
- Merge semantics: shallow merge; `null` values delete keys (tombstones); `undefined` ignored; arrays/objects replaced; reserved keys (`__proto__`, `constructor`, `prototype`) rejected
- Implementation: Slice 4a S8 (projection + merge + auto-load)

**Security considerations:**
- Context may contain sensitive data (API keys, tokens, credentials)
- Encryption at rest recommended (AES-256-GCM with OS keychain)
- Agent attribution in event metadata for audit
- Tamper detection via manifest signing

**Performance considerations:**
- Use metadata cache pattern to avoid O(n) event log scans
- Tail-read `metadata/context.jsonl` for latest context (O(1))
- Auto-rebuild on cache miss or corruption

**Migration path:**
- Feature-flagged rollout (`WORKRAIL_ENABLE_CONTEXT_PERSISTENCE`)
- Backward compatible (old sessions without context_set still work)
- Gradual adoption per workflow

**Decision authority:** Requires design review and lock revision approval before Slice 4a implementation.

**Open sub-questions for Slice 4a:**
1. Should context be per-run (one context for entire run) or per-node (context can change per step)?
2. Merge semantics: shallow spread vs deep merge vs explicit delete markers?
3. Context in rehydrate-only path: return contextId hint or omit entirely?
4. Context size accounting: count against node output budget or separate limit?

**Decision needed before Slice 4a ships.**

---

## 19. Agent Delegation Instructions (Workflow-Driven Subagent Execution)

**Issue**: Workflows request subagent delegation (e.g., "Spawn 3 WorkRail Executors SIMULTANEOUSLY using routine-ideation") but agents frequently misinterpret these instructions, leading to:
- Agents starting new workflow runs instead of spawning subagents via the Task tool
- Sequential execution when parallel delegation is requested
- Incorrect subagent type selection (using general-purpose instead of workrail-executor)
- Missing context propagation to subagents

**Impact**: Workflow execution fails or executes incorrectly; parallel delegation benefits are lost; THOROUGH rigor mode cannot achieve intended parallelism.

**Root Cause**: Workflow prompt instructions are not explicit enough about the distinction between:
1. **Starting a new workflow run** (via `mcp_workrail_start_workflow`) - creates a new session/run with its own state
2. **Spawning a subagent** (via Task tool with `subagent_type: workrail-executor`) - delegates work within the current session

**Proposed Lock** (for workflow authoring guidance):

When workflows request subagent delegation, prompts MUST use this explicit template:

```
**If subagents + rigorMode=THOROUGH:**

SPAWN SUBAGENTS (not workflows) - use the Task tool with subagent_type: workrail-executor

Spawn {N} subagents IN PARALLEL by making {N} Task tool calls in a single response:

**Subagent 1 — [Name]:**
- Use: Task tool with subagent_type: workrail-executor
- Prompt: "Execute {routine-name} with: {params}"
- Description: "{short description}"

**Subagent 2 — [Name]:**
- Use: Task tool with subagent_type: workrail-executor  
- Prompt: "Execute {routine-name} with: {params}"
- Description: "{short description}"

DO NOT use mcp_workrail_start_workflow for delegation.
DO NOT call Task tools sequentially - make all {N} calls in one response block.
```

**Rationale**:
1. **Explicit tool naming**: "Use Task tool with subagent_type: workrail-executor" removes ambiguity
2. **Negative constraint**: "DO NOT use mcp_workrail_start_workflow" prevents wrong tool selection
3. **Parallelism guidance**: "IN PARALLEL... in one response block" ensures parallel execution
4. **Template consistency**: Standardized format across all workflows reduces learning overhead

**Implementation Requirement**:
- Update all workflows that use delegation (coding-task-workflow-agentic, mr-review-workflow-agentic, bug-investigation-agentic, etc.) to use this explicit template
- Add this guidance to workflow authoring documentation

**Verification**:
- Test that agents correctly spawn parallel subagents when instructed
- Audit existing workflows for ambiguous delegation instructions

**Decision needed**: Approve this template and plan workflow updates, or propose alternative phrasing.

---

Important notes from the user:
- Agents get confused if multiple workflows are started in the same chat due to the tokens. Need to investigate a way to fix this.