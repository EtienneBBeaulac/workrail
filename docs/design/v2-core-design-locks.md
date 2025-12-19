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
- **Crash-safe append**: append-only, atomic writes; recommended JSONL segment files (not one monolithic file).
  - write temp → `fsync(file)` → `rename` → `fsync(dir)`
- **Single writer per session**: enforce cross-process lock; if busy, fail fast with structured retryable error.
- **Integrity + recovery**: maintain digests per segment/snapshot; on load, stop at last valid segment and fail explicitly (no guessing).

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

### Node snapshots: typed, versioned, minimal
Snapshots must be typed+versioned (not opaque blobs) and must not become a second engine:
- include only minimal rehydration payload + `workflowHash` linkage
- verifiable against the pinned compiled workflow snapshot
- portable for export/import; tokens are re-minted from snapshots

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
