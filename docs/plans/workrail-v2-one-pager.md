# WorkRail v2 — One Pager

## Definition

Workrail v2 makes agent workflows resumable and rewind-proof by persisting durable outputs and execution lineage in an append-only run graph.

## Public MCP surface (final names)

Core tools:
- `list_workflows`
- `inspect_workflow`
- `start_workflow`
- `continue_workflow`
- `checkpoint_workflow` (shipped v1.4.0, currently feature-flagged)
- `resume_session` (shipped v1.4.0, currently feature-flagged)

Advanced (flagged longer):
- `start_session` (enables checkpoint-only sessions; not required for core v2 value)

## Current rollout note (implementation)

Until v2 is fully shipped, the v2 MCP tool surface may be gated behind an explicit opt-in flag:
- `WORKRAIL_ENABLE_V2_TOOLS=true`

Local data may also be rooted under a WorkRail-owned data dir, optionally overridden for testing/dev:
- `WORKRAIL_DATA_DIR=/path/to/workrail-data`

## Invariants (v2 guarantees)

1) **Token-based execution**: agents only round-trip opaque handles; `continue_workflow` supports safe rehydrate and idempotent advance (`ackToken` with `attemptId`).
2) **Pinned determinism**: every run pins to a `workflowHash` of the fully expanded compiled workflow (builtins/templates/features/contracts included).
3) **Append-only truth**: durable state is an append-only session/run graph; all “latest” views are projections.
4) **Rewinds are branches**: using a non-tip snapshot auto-forks and returns lost branch context (bounded downstream recap).
5) **Output + context durability**: Durable memory is written via `output` (notes + artifacts) and `context` (persisted via context_set events in v2); context is inputs AND session state.
6) **Bounded memory**: recaps/snippets are full when small, otherwise deterministically truncated with explicit markers.
7) **Resumable portability**: export/import bundles are versioned + integrity-checked; imports re-mint tokens from stored snapshots.
8) **Builtin authoring power + auditability**: workflows can reference builtin templates/features/contract packs; bounded decision traces exist for dashboard/logs/exports (not agent-facing by default).
9) **Modes + preferences**: execution behavior (guided vs full-auto) is controlled by a closed set of preferences, recorded durably so behavior is rewind-safe and portable.
10) **Checkpointing is replay-safe**: `checkpoint_workflow` is idempotent via an opaque `checkpointToken` and records a checkpoint node + checkpoint edge in the run DAG.

## Explicit non-goals

- No transcript dependence for correctness.
- No server push into the chat.
- No agent-managed engine internals (completed steps, loop stacks, cursors, etc.).
- No heuristic inference of structure from prose.
- No user-defined plugin code (builtin-only).
- No mutable session CRUD surface for agents.
- No implicit merges on import (default: import-as-new session).

## What’s new vs v1

- **Durable truth**: v2 stores an append-only run graph + durable outputs; v1 relies on chat state and mutable side channels.
- **Resumption**: v2 supports “resume by query” and resumable import/export; v1 resumption is fragile without transcript context.
- **Rewind safety**: v2 models rewinds as explicit forks with recovered context; v1 risks silent drift/desync.
- **Determinism**: v2 pins execution to hashed compiled workflow snapshots (including builtins); v1 behavior can drift with workflow changes.
- **Authoring power**: v2 adds builtin templates/features/contract packs to speed up authoring and standardize behavior.

## Current Status (2026-02-17)

- Slice 1 (read-only tools + pinning) ✅ merged
- Slice 2 (append-only substrate + projections) ✅ merged
- Slice 2.5 (gate+witness + execution safety) ✅ merged
- Slice 3 (token orchestration: start_workflow, continue_workflow) ✅ merged
- Slice 4a (semantics lockdown) ✅ merged (PR #55)
- Agent execution guidance (Layers 1-3) ✅ merged (PR #57)
- Typed artifact validation + blocked retry UX ✅ merged (v1.2.0)
- **Slice 4b (export/import bundles)** ✅ merged (v1.3.0)
- **Slice 4c-i (checkpoint_workflow)** ✅ merged (v1.4.0)
- **Slice 4c-ii (resume_session)** ✅ merged (v1.4.0)
  - 5-tier deterministic ranking (git SHA, branch, notes, workflow ID, recency)
  - DirectoryListingPortV2 + SessionSummaryProviderPortV2 ports
  - Up to 5 ranked candidates with fresh stateTokens
- **All functional slices complete.** Remaining: production workflow migration + polish & hardening (sub-phases A-H)

## Epics

1) **Protocol v2 MCP surface**
   - Implement the v2 tools, token/ack semantics, and rehydrate vs advance modes.
   - Deterministic recap generation and truncation markers.
   - Closed-set preferences/modes (global → session overrides) that can be updated mid-session and apply going forward.

2) **Durable store + pinning**
   - Append-only session/run graph (nodes/edges/outputs/observations).
   - Workflow hashing over fully expanded compiled workflows + snapshot persistence.
   - Bounded decision trace for auditability.

3) **Resumption + sharing**
   - `resume_session` layered search and deterministic ranking.
   - Export/import bundles (schema versioning, integrity manifest, token re-minting).
   - Conflict policy: import-as-new session by default.

4) **Authoring + durability extensions**
   - `checkpoint_workflow` rollout and guardrails.
   - `start_session` (checkpoint-only sessions) as an advanced, flagged capability.
   - JSON-first authoring with promptBlocks (structured), output contracts (validated), and explicit template/feature/capability refs.
   - Builtin templates/features/contract packs with generated catalog for discoverability (autocomplete/insert in Studio).
   - Namespaced workflow IDs (`namespace.name`) with `wr.*` reserved, legacy ID migration warnings.

5) **Console (observability + management UI)**
   - Workflow list/detail/edit/validate with JSON-first editing and source picker.
   - Source vs compiled inspection, with pinned snapshot drift warnings (pinned run vs current source).
   - Protected bundled workflows with fork/copy to editable namespaces.
   - Sources management (add/remove/health).
   - Feature flags UI with desired-vs-applied config and "restart required" guidance.
   - Preferences hub (global defaults + session overrides) with pending → applied-at-node visibility.
   - Sessions/runs dashboard with branch graph, decision traces, logs, export/import.
   - Sessions-first navigation (Sessions / Workflows / Settings); import from Sessions list and export from Session detail.
   - Default run view shows the preferred tip path (forks collapsed); `complete_with_gaps` is treated as done-with-follow-ups, not still-in-progress.

## Canonical references

- `docs/reference/workflow-execution-contract.md`
- `docs/reference/mcp-platform-constraints.md`
- `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- `docs/adrs/006-append-only-session-run-event-log.md`
- `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
- `docs/design/v2-core-design-locks.md`
