# Coordinator Architecture Audit

**Status:** In progress  
**Date:** 2026-04-19  
**Scope:** `src/coordinators/`, `src/trigger/trigger-listener.ts`, `src/daemon/` (NOT `src/mcp/`)

---

## Context / Ask

**Stated goal (solution-shaped):** Produce a dep-by-dep analysis of `CoordinatorDeps` and `AdaptiveCoordinatorDeps`, identify indirect access anti-patterns, find missing abstractions, and produce a priority-ranked fix list.

**Reframed problem:** WorkTrain coordinators cross the HTTP/shell boundary for data already available in-process via `ctx` (V2ToolContext), and `CoordinatorDeps` lacks the sub-interface structure needed to make these boundaries independently testable. The real risk: if the HTTP console is slow or unavailable, coordinator sessions degrade silently with misleading error messages.

**Anti-goals:**
- Do not audit `src/mcp/` (out of scope)
- Do not propose rewrites of coordinator logic -- only interface/wiring changes
- Do not change public CLI commands (`worktrain await` is correct for external callers)

**Primary uncertainty:** How many indirect-access sites exist beyond the two known ones (`awaitSessions`, `getAgentResult`)?

**Known approaches:**
- Replace HTTP polling in `awaitSessions` with in-process session store reads + DaemonRegistry
- Replace HTTP calls in `getAgentResult` with `projectNodeOutputsV2` projection on the session store
- Introduce a `SessionStatusPort` interface so coordinators can inject a fake for testing

**Path recommendation:** `landscape_first` -- the landscape (dep-by-dep analysis of what each function actually does) is the dominant need. The solution direction is already known; what's missing is the complete catalog of all anti-patterns and the exact recommended interface designs.

---

## Artifact Strategy

This document is the human-readable output of the audit. It is NOT execution truth for the workflow -- notes and context variables in the WorkRail session are the durable record. If the session is rewound, this file may be stale; regenerate from notes.

**Capabilities available:**
- Delegation: YES (mcp__nested-subagent__Task available)
- Web browsing: Not needed (codebase-only audit)
- File reads: YES (main agent reads source files directly)

---

## Landscape Packet

*(Populated during research phase)*

---

## Problem Frame Packet

*(Populated during analysis phase)*

---

## Candidate Directions

*(Populated during design phase)*

---

## Final Summary

*(Populated when audit is complete)*
