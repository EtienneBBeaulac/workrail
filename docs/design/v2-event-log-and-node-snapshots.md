# WorkRail v2: Event Log + Node Snapshots (Minimal Union + Storage Invariants)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document locks the **minimal internal event union** and the **durable storage invariants** for WorkRail v2.

Goals:
- Deterministic, rewind-safe execution lineage (forks are first-class).
- Append-only truth; projections only.
- Closed sets and explicit types; avoid “bags of JSON”.
- Fail fast with errors-as-data; no throwing across boundaries.

Non-goals:
- Define the full workflow engine internals.
- Define UI/Console UX beyond what storage must support.

---

## Core model: two append-only stores

WorkRail v2 persists durable truth in **two append-only stores**:

1) **Event log** (per session): a strictly ordered append-only sequence of typed events.
2) **Node snapshot store**: immutable, versioned snapshots referenced by events.

The event log is the primary truth for **lineage and facts**. Node snapshots exist only to carry the minimal payload required to rehydrate execution deterministically and to re-mint runtime tokens.

---

## Storage invariants (must hold)

### Ordering
- Each session has a monotonic **`EventIndex`** that is authoritative ordering for all projections.
- Wall-clock timestamps (if present) are informational and must not affect correctness or preferred-tip policies.

### Append atomicity + durability
Event log writes must be:
- **Append-only**
- **Atomic**
- **Crash-safe**

Recommended implementation:
- Store events as **JSONL segments**, e.g. `events-000001.jsonl`, rather than rewriting a monolithic file.
- Append workflow:
  1. Write to a temp file
  2. `fsync(file)`
  3. `rename` into place
  4. `fsync(directory)`

This reduces corruption blast radius and makes recovery deterministic.

### Single-writer semantics (per session)
- Only one writer may append to a session at a time.
- The implementation must enforce a **cross-process session lock** (advisory OS file lock).
- If the lock cannot be acquired, the write fails fast with a structured, retryable error.

### Corruption detection + recovery
- The store maintains an integrity manifest (digests per segment and snapshot blob).
- On load, WorkRail reads segments in order and stops at the last valid segment if corruption is detected.
- Recovery must be explicit and explainable: projections should never silently “guess”.

---

## Types: avoid base primitives where possible

Within the domain layer, the following identifiers must be distinct branded/opaque types:
- `SessionId`, `RunId`, `NodeId`, `EventId`
- `WorkflowId`, `WorkflowHash`
- `SnapshotRef` (or `SnapshotId`)
- `EventIndex`

In TypeScript, this typically means branded strings (and branded numbers for `EventIndex`) plus runtime validation at persistence boundaries.

---

## Minimal closed event union

### Event envelope (all events)
All events must share a common envelope:
- `eventId: EventId`
- `eventIndex: EventIndex` (monotonic per session)
- `sessionId: SessionId`
- `kind: EventKind` (discriminated union tag)
- optional scope refs (only when meaningful for that event):
  - `runId?: RunId`
  - `nodeId?: NodeId`

### Event kinds (closed set)

#### Session lifecycle
- `session_created`
  - Payload: `title?`, `sessionKey?` (both optional, typed), and any future *closed-set* metadata.

#### Observations (session or node scope)
- `observation_recorded`
  - Scope: either session-scoped or node-scoped (prefer session-scoped; node-scoped should be rare/high-signal).
  - Payload: `observationKind` (closed set) + typed payload per kind.

Observation kinds (initial closed set, intentionally small):
- `git_branch`
- `git_head_sha`
- `repo_root_digest`

#### Run start + workflow pinning
- `run_started`
  - Payload: `runId`, `workflowId`, `workflowHash`, `startNodeId`.
  - Invariant: pinning is durable truth; runs are always executed against the pinned compiled workflow snapshot.

#### Run DAG construction
- `node_created`
  - Payload: `nodeId`, `nodeKind`, `snapshotRef`, `workflowHash`.
  - `nodeKind` is a closed set:
    - `step`
    - `checkpoint`
- `edge_created`
  - Payload: `parentNodeId`, `childNodeId`, `edgeKind`.
  - `edgeKind` is a closed set:
    - `acked_step`
    - `forked_from_non_tip`

#### Durable writes (single write path)
- `node_output_appended`
  - Scope: node-scoped.
  - Payload: `output` envelope (notes + optional artifacts).
  - Invariant: output is append-only.
  - Optional: allow “corrections” without mutation by including `supersedesOutputId?` in the output envelope. Projections render the latest non-superseded output as “current” while preserving history.

#### Preferences (WorkRail-defined closed set)
- `preferences_changed`
  - Scope: node-scoped (preferred): “applies from this node onward”.
  - Payload:
    - `preferenceDelta` (closed-set keys + typed values)
    - `effectivePreferencesSnapshot` (closed-set keys + typed values)

#### Capabilities (WorkRail-defined closed set)
- `capability_observed`
  - Scope: node-scoped.
  - Payload:
    - `capability` (closed set, v2: `delegation`, `web_browsing`)
    - `status` (closed set: `unknown`, `available`, `unavailable`)
    - `provenance` (closed set; “strong” vs “weak” observation)

Policy:
- Only “strong” provenance (e.g., an injected probe step) may be treated as enforcement-grade truth.
- “Weak” provenance may inform UX but must not unlock required capability paths.

#### Gaps (never-stop disclosure)
- `gap_recorded`
  - Scope: node-scoped.
  - Payload:
    - `gapId`
    - `reason` (closed set; defined separately)
    - `severity` (closed set: `warning`, `critical`)
    - `summary`
    - `howToResolve?`
    - `relatedStepId?`
    - `resolvesGapId?` (append-only “resolution” linkage)

#### Divergence markers (audit)
- `divergence_recorded`
  - Scope: node-scoped.
  - Payload: `reason` (closed set), `summary`, `relatedStepId?`

#### Decision trace (bounded, optional)
- `decision_trace_appended`
  - Scope: node-scoped.
  - Payload: a closed set of trace item kinds, with strict caps.
  - Invariant: projections must not rely on decision trace for correctness.

---

## Node snapshots: typed, versioned, and minimal

Node snapshots must be **typed and versioned**; they must not be opaque blobs.

Constraints:
- Snapshots must include only the minimal payload required to rehydrate execution deterministically and re-mint tokens.
- Snapshots must not become a “second engine.” Rich/unstable engine internals should not leak into snapshot schema.
- Snapshots must reference the pinned `workflowHash` and be verifiable against it (e.g., include a digest of the pinned compiled workflow snapshot).

Import/export rule:
- Tokens are not portable. On import, WorkRail re-mints runtime tokens from stored node snapshots.
