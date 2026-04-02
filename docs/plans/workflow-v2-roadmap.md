# Workflow v2 Roadmap

This is the **canonical planning/status doc** for WorkRail v2.

Use it for:

- the v2 mission and invariants
- what is already shipped
- what remains partial or open
- realistic next work

Do **not** use this doc for long-form design history or chat-resumption guidance. Those belong in the companion design doc and the code.

## Mission

Make WorkRail workflows **resumable, rewind-safe, deterministic, and durable** without depending on chat transcript state.

## Core invariants

### 1. Execution happens through opaque workflow tokens

Agents should round-trip tokens, not construct engine internals.

### 2. Durable truth is append-only

Sessions and runs should be projections over append-only execution truth, not mutable JSON truth stores.

### 3. Runs are pinned to compiled workflow content

Execution should stay tied to a deterministic workflow snapshot rather than drift with later edits.

### 4. Rewinds must stay safe

If a user or client rewinds chat state, WorkRail should preserve execution integrity through branching/recovery rather than silent corruption.

## Shipped or largely shipped

- v2 MCP tool surface (`list_workflows`, `inspect_workflow`, `start_workflow`, `continue_workflow`, `checkpoint_workflow`, `resume_session`)
- append-only execution substrate and projections
- token-based execution boundary
- checkpointing and session resumption
- typed output validation and blocked retry UX
- substantial hardening/modularization work

## Still partial

- lifecycle validation coverage breadth (see `docs/plans/workflow-validation-roadmap.md`)

## Still open

- progress notifications
- stronger verification/evidence contract model
- parallel `forEach` execution
- subagent composition chains

See `docs/plans/v2-followup-enhancements.md` for the detailed open follow-up initiative list.

## Recommended next work

### Near-term

1. **Progress notifications**
2. **Verification/evidence contract improvements**

### After that

1. **Parallel loop execution and richer delegated composition**

## Canonical companions

- `docs/plans/workflow-v2-design.md`
- `docs/plans/v2-followup-enhancements.md`
- `docs/roadmap/open-work-inventory.md`
- `docs/tickets/next-up.md`
