# WorkRail v2: Preferred Tip Policy (Deterministic)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document defines WorkRail v2’s deterministic **preferred tip** policy.

Goals:
- Deterministic selection of a default branch tip for resume and UI.
- Stable across rewinds, replays, export/import.
- No reliance on chat transcripts or wall-clock timestamps.

Non-goals:
- Solve “merge branches” (v2 default is no implicit merges).
- Pick a preferred workflow/run across multiple runs in a session (handled by UI; policy here is per-run).

---

## Definitions

- **Run DAG**: a directed acyclic graph of nodes for a single workflow execution run.
- **Tip/leaf node**: a node with no outgoing edges (no children) in the run DAG.
- **EventIndex**: the authoritative ordering field in the session event log.

---

## Scope of the policy

Preferred tip is defined **per run**.

Rationale:
- Sessions can contain multiple runs; selecting a “default run” is a UX concern and should not be conflated with branch-tip selection.
- This keeps the policy composable and avoids cross-run ambiguity.

---

## Preferred tip selection

Given a run DAG:

1) Compute the set of **leaf nodes**.
2) For each leaf node, compute its **last-activity index**:
   - The maximum `EventIndex` among events that materially touch that node’s reachable history (node creation, output append, gap/capability/prefs/divergence, edge creation).
3) Preferred tip is the leaf node with the **highest last-activity index**.
4) Tie-breakers (deterministic):
   - highest `EventIndex` of `node_created` for that node
   - lexical order of `NodeId`

Important:
- Wall-clock timestamps must not be used to break ties; `EventIndex` is authoritative.

---

## Resume behavior requirements

For `resume_session` (tip-only):
- Candidates must be **tip nodes only**, as defined by the preferred tip policy above.
- The tool must return enough bounded context for the agent to proceed without transcript access:
  - pending-step rehydration recap (bounded; deterministically truncated when necessary)
  - branch context when resuming from non-tip snapshots (auto-fork behavior defined elsewhere)

---

## Why this policy (tradeoffs)

Why `EventIndex`:
- It is deterministic and export/import safe.
- It aligns with append-only truth; projections are pure functions over ordered events.

Why per-run:
- Avoids “confusing soup” across runs.
- Keeps UI flexibility while ensuring correctness at the run level.
