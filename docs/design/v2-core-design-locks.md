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
{"v":1,"manifestIndex":12,"sessionId":"sess_01JH...","kind":"segment_closed","firstEventIndex":1,"lastEventIndex":5000,"segmentRelPath":"events/00000001-00005000.jsonl","sha256":"sha256:seg_7fd2...","bytes":1837421}
```

##### `snapshot_pinned` (locked)
Purpose: make snapshot reachability explicit for export/import and CAS GC (without scanning the event log).

Locks:
- **Pin-on-create**: record `snapshot_pinned` immediately when a new `snapshotRef` is introduced.
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
- `edge_created` (`edgeKind`: `acked_step|forked_from_non_tip`)
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

Initial v2 recipes (illustrative, locked intent):
- `run_started`: `run_started:<sessionId>:<runId>`
- `node_created`: `node_created:<sessionId>:<runId>:<nodeId>`
- `edge_created`: `edge_created:<sessionId>:<runId>:<fromNodeId>-><toNodeId>:<edgeKind>`
- `node_output_appended`: `node_output_appended:<sessionId>:<outputId>`
- `gap_recorded`: `gap_recorded:<sessionId>:<gapId>`
- `preferences_changed`: `preferences_changed:<sessionId>:<changeId>`
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
- `createdByEventId`

Locks:
- `createdByEventId == eventId` for `node_created` (initial v2 schema).

Invariants:
- `parentNodeId` (when present) must refer to a node in the same run.
- `snapshotRef` must be pinned in `manifest.jsonl` via `snapshot_pinned` (pin-on-create).

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":2,"sessionId":"sess_01JH...","kind":"node_created","scope":{"runId":"run_01JH...","nodeId":"node_01JH_root"},"dedupeKey":"node_created:sess_01JH:run_01JH:node_01JH_root","data":{"nodeKind":"step","parentNodeId":null,"workflowHash":"sha256:wf_9a3b...","snapshotRef":"sha256:snap_f2c1...","createdByEventId":"evt_01JH..." }}
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
{"v":1,"eventId":"evt_01JH...","eventIndex":120,"sessionId":"sess_01JH...","kind":"preferences_changed","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"preferences_changed:sess_01JH:evt_01JH...","data":{"changeId":"prefchg_01JH...","source":"user","delta":[{"key":"autonomy","value":"full_auto_never_stop"}],"effective":{"autonomy":"full_auto_never_stop","riskPolicy":"conservative"}}}
```

#### `capability_observed` (locked)
Purpose: record observed capability status with provenance so “agent said so” is never enforcement-grade truth by default.

Payload fields:
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
{"v":1,"eventId":"evt_01JH...","eventIndex":121,"sessionId":"sess_01JH...","kind":"capability_observed","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"capability_observed:sess_01JH:run_01JH:node_01JH:web_browsing","data":{"capability":"web_browsing","status":"available","provenance":{"kind":"probe_step","enforcementGrade":"strong","detail":{"probeTemplateId":"wr.templates.capability_probe","probeStepId":"wr_probe_web_browsing","result":"success"}}}}
```

#### `divergence_recorded` (initial v2 schema, locked)
Purpose: record intentional off-script behavior as a durable, node-attached explainability signal (Studio badges; not required for correctness).

Envelope requirements:
- `scope.runId` must be present.
- `scope.nodeId` must be present.

Payload fields:
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
{"v":1,"eventId":"evt_01JH...","eventIndex":126,"sessionId":"sess_01JH...","kind":"divergence_recorded","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"divergence_recorded:sess_01JH:evt_01JH...","data":{"reason":"capability_unavailable","summary":"Delegation was unavailable; executed sequentially and recorded results.","relatedStepId":"investigate"}}
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
- `entries` (non-empty list, bounded)
  - each entry has:
    - `kind` (closed set, initial):
      - `selected_next_step`
      - `evaluated_condition`
      - `entered_loop`
      - `exited_loop`
      - `detected_non_tip_advance`
    - `summary` (bounded text)
    - `refs?` (optional; keep minimal, typed where possible; e.g., `stepId`, `loopId`)

Budgets (locked):
- max entries: 25
- max summary bytes per entry: 512
- max total bytes per event: 8192
- if budgets are exceeded, deterministically truncate by bytes and append the canonical truncation marker to the affected summary (never drop entries out of order).

Canonical truncation marker (locked):
- append exactly: `\n\n[TRUNCATED]`
- truncation is byte-based (UTF-8). To guarantee the marker fits, reserve marker bytes and truncate the original text prefix to the remaining budget.

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":127,"sessionId":"sess_01JH...","kind":"decision_trace_appended","scope":{"runId":"run_01JH...","nodeId":"node_01JH..."},"dedupeKey":"decision_trace_appended:sess_01JH:evt_01JH...","data":{"entries":[{"kind":"selected_next_step","summary":"Chose step 'investigate' because prior evidence reduced uncertainty most.","refs":{"stepId":"investigate"}},{"kind":"detected_non_tip_advance","summary":"Provided state token was non-tip; recording fork marker and continuing on a new branch."}]}}
```

#### `edge_created` (locked)
Purpose: record authoritative relationships between nodes in a run DAG (advancement and explicit fork-from-non-tip markers).

Payload fields:
- `edgeKind`: `acked_step | forked_from_non_tip`
- `fromNodeId`, `toNodeId`
- `cause`:
  - `kind`: `idempotent_replay | intentional_fork | non_tip_advance`
  - `eventId` (required for explainability; references an event in this session)

Invariants:
- `fromNodeId` and `toNodeId` must refer to nodes in the same run.
- For `edgeKind=acked_step`:
  - `toNodeId` must have `parentNodeId == fromNodeId`.
  - `cause.kind` must be `idempotent_replay` or `intentional_fork`.
- For `edgeKind=forked_from_non_tip`:
  - `cause.kind` must be `non_tip_advance`.
  - `fromNodeId` must already have at least one child when this edge is recorded (this is a fork marker, not a normal first advance).

Example:

```json
{"v":1,"eventId":"evt_01JH...","eventIndex":123,"sessionId":"sess_01JH...","kind":"edge_created","scope":{"runId":"run_01JH..."},"dedupeKey":"edge_created:sess_01JH:run_01JH:node_A->node_B:acked_step","data":{"edgeKind":"acked_step","fromNodeId":"node_A","toNodeId":"node_B","cause":{"kind":"intentional_fork","eventId":"evt_01JH..."}}}
```

### Durable outputs: append + supersede linkage (locked)
Durable outputs exist to preserve high-signal progress outside the chat transcript without introducing mutable “documents” that drift under rewinds.

Locks:
- Outputs are recorded only via **append-only** `node_output_appended` events (no in-place edits).
- Each output append mints a stable **`outputId`** (server-owned identifier for idempotency and explainability).
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
3) substring match on latest preferred-tip `node_output_appended` recap notes (`outputChannel=recap`, `payloadKind=notes`)
4) substring match on workflow id/name (source/compiled metadata)
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
- `<payload>` is base64url of **RFC 8785 (JCS)** canonical JSON containing only the locked fields.
- `<sig>` is an HMAC/signature over `<payload>` using a locally held key; key rotation validates against a small active key set (current + previous).

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
- `ackAttemptId`

### Ack idempotency + branching (locked)
- Idempotency key: `(sessionId, runId, nodeId, ackAttemptId)`.
- Replaying the same `ackToken` is an idempotent no-op: return the same response; do not double-advance.
- WorkRail may mint multiple `ackToken`s for the same `(runId, nodeId)` with different `ackAttemptId` values to support intentional forks and safe replay handling.

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
- `suggestion?` (actionable next step)
- `details?` (bounded, structured; never required for correctness)

Lock:
- Never throw errors across MCP boundaries; map to structured error envelopes.

---

## 13) Local data directory layout (initial v2, locked)
To avoid path drift and scattered state, WorkRail persists all durable truth and derived caches under a single WorkRail-owned local data directory.

Locks:
- The data directory is **WorkRail-owned** (not inside workflow source directories).
- All paths stored in manifests/bundles are **relative** to the session root or bundle root (no absolute paths).

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

### Capabilities + contracts ergonomics (locked intent)
- Capability probes for `required` capabilities should be compiler-injected (collapsed by default) and recorded durably with strong provenance.
- Structured outputs require explicit contracts (no inline schema authoring); templates may imply `contractRef` to reduce author burden.

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
