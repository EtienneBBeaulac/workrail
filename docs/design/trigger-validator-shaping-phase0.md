# Phase 0: Understand and Path Recommendation -- WorkTrain Trigger Validator

**Generated:** 2026-04-20 | **Workflow:** wr.shaping | **Session:** sess_d47ycoddoji3ml5dl5qib2ag7u  
**Status:** Phase 0b complete -- capabilities confirmed, artifact strategy recorded

---

## Artifact Strategy

**This document is human-readable reference only.** It is NOT execution truth.

- Execution truth lives in WorkRail session notes and context variables
- If a chat rewind occurs, notes and context variables survive; this file may not
- Do not treat this file as a source of truth for what was decided -- check the session context

**What this doc is for:** A human reading back through the design history, or a coding agent needing to understand why certain decisions were made.

**What this doc is NOT for:** Recovering session state after a rewind. That comes from session notes.

---

## Capability Observations (Phase 0b)

| Capability | Available | Evidence | Used Here |
|---|---|---|---|
| Web browsing (curl/HTTP) | Yes | `curl https://example.com` returned HTTP 200 | No -- no external research needed; all context is local |
| Structured web research (MCP browser tool) | Not observed | No browser MCP tool in session context | N/A |
| Delegation (spawn_agent) | Yes | Tool is defined in session | No -- setup step; delegation adds overhead without benefit |
| `worktrain` CLI (local dist) | Yes | `node dist/cli-worktrain.js --version` → `0.0.3` | N/A -- validate subcommand not yet built |
| `worktrain trigger validate` | Not yet available | `trigger --help` shows only `test` subcommand | Will exist after Phase 4 is implemented |

**Web browsing fallback:** Network is reachable, but no structured web research tool is available. All required context for this shaping task exists locally (design docs, codebase, existing pitch). Web research is not needed and was not used.

**Delegation fallback:** `spawn_agent` is available but was not used in Phases 0-0b. These phases are sequential analytical work where parallelism adds no value. Delegation will be considered in later phases (e.g., parallel assumption challenges in Step 3) if independent cognitive perspectives would improve output quality.

**Retriage needed:** No. Path recommendation (`design_first`) is confirmed by capability assessment -- there are no external sources that would change the design direction, and the local codebase state is the authoritative landscape.

---

---

## Context / Ask

### Stated Goal (original -- solution-framed)

> Produce a pitch at .workrail/current-pitch.md for the WorkTrain trigger validator (Candidate B two-layer validation + CLI subcommand), covering all 4 implementation phases with concrete implementation details

**This is a `solution_statement`, not a `problem_statement`.** It names a specific output, prescribes a design candidate, and asks for "concrete implementation details" -- language that the wr.shaping metaGuidance explicitly prohibits in a pitch.

### Reframed Problem Statement

When an operator adds or modifies a trigger in `triggers.yml`, they have no way to detect dangerous or confusing misconfiguration before deploying, so production incidents are their first signal that the config was wrong.

---

## Critical Finding: Landscape Has Changed Since the Pitch Was Written

**The existing pitch (`2026-04-19-worktrain-trigger-validator.md`) is partially obsolete.** Phase 1 is already implemented.

### What the pitch specified vs. current codebase state (Apr 20, 2026):

| Phase 1 item | Pitch says | Codebase now |
|---|---|---|
| `autoOpenPR + !autoCommit` → hard error | Upgrade from warning | **DONE** (lines 941-947) |
| `autoCommit + branchStrategy absent/none` → hard error | New hard error | **DONE** (lines 977-987) |
| Startup hint mentioning `worktrain trigger validate` | Add to `loadTriggerConfig()` | **DONE** (3 references in trigger-store.ts) |

**Phase 1 is fully implemented in the current codebase. Phases 2, 3, and 4 are not.**

### What still needs to be built:

| Phase | Item | Status |
|---|---|---|
| Phase 2 | `TriggerValidationIssue` interface in `types.ts` | **Missing** |
| Phase 2 | `validateTriggerStrict()` export in `trigger-store.ts` | **Missing** |
| Phase 2 | `validateAllTriggers()` export in `trigger-store.ts` | **Missing** |
| Phase 3 | `src/cli/commands/worktrain-trigger-validate.ts` new file | **Missing** |
| Phase 4 | `worktrain trigger validate` CLI subcommand in `cli-worktrain.ts` | **Missing** |

---

## Path Recommendation

**Recommended path: `design_first`**

### Justification

**Why not `landscape_first`:** The landscape is now fully known from code inspection. trigger-store.ts is readable, the design docs are complete, and Phase 1 implementation is already in the codebase. There is no landscape knowledge gap to fill.

**Why not `full_spectrum`:** The problem framing was already done rigorously in the prior `wr.discovery` session (`trigger-validator.md`). Candidate B was selected after a full three-candidate evaluation and design review. The candidates are not open questions.

**Why `design_first`:** The stated goal has a specific framing distortion that needs resolution before any artifacts are produced:
1. The goal asks for "concrete implementation details" in a pitch -- which violates wr.shaping's own metaGuidance
2. The existing pitch already contains implementation-level detail (function signatures, TypeScript types, specific line numbers) making it closer to an engineering spec than a product pitch
3. Phase 1 is already implemented, which changes what the pitch needs to say about the problem's solved/unsolved state
4. Three prior coding sessions (`sess_5fk`, `sess_ntum`, `sess_v6r`) were started with implementation-level goals and appear to have stalled -- suggesting the problem may be that the "pitch" is being used as the context bundle for a coding agent, which is an architectural misuse of the shaping workflow

**The core design question to resolve:** Should this workflow produce a product-level pitch (as wr.shaping intends) OR a coding-task context bundle (what the goal actually requests)? These are different artifacts with different shapes and different downstream uses. Producing the wrong one wastes work or sends a coding agent in the wrong direction.

---

## Constraints / Anti-Goals

### Constraints (from design history + AGENTS.md)

- Scope: only `src/trigger/trigger-store.ts`, `src/trigger/types.ts`, `src/cli-worktrain.ts` + new `src/cli/commands/worktrain-trigger-validate.ts`
- No `src/mcp/` changes
- No `src/trigger/trigger-listener.ts` changes (hard errors propagate automatically)
- No external dependencies for the validator
- `loadTriggerConfig()` public signature must not change
- Result types, not exceptions -- consistent with TriggerStoreError pattern

### Anti-Goals

- Do not produce implementation-level detail (function signatures, line numbers, test code) in the pitch portion
- Do not re-design what Phase 1 already implemented
- Do not add a `--strict` flag to daemon config (introduces hidden behavior)
- Do not build a general-purpose YAML schema validator
- Do not auto-fix config files

---

## Landscape Packet

### Current State: trigger-store.ts validation after PR 685 (Apr 20, 2026)

| Check | Behavior | Source |
|---|---|---|
| `autoOpenPR: true` without `autoCommit: true` | **Hard error** | lines 941-947 |
| `autoCommit: true` + `branchStrategy` absent or `'none'` | **Hard error** | lines 977-987 |
| `branchStrategy` invalid value | **Hard error** | lines 969-975 |
| Startup hint: "Run 'worktrain trigger validate'" | **Logged** | ~line 940, 979, 1333 |

### What is still missing (Phases 2-4)

| What | Why it matters |
|---|---|
| `TriggerValidationIssue` interface | Enables structured reporting; named rule IDs for programmatic use |
| `validateTriggerStrict()` | Pure function for semantic validation; required by CLI |
| `validateAllTriggers()` | Applies validateTriggerStrict across a full TriggerConfig |
| `worktrain trigger validate` CLI | Pre-deploy observability; surfaces warnings before production |

### Prior Coding Sessions

Three coding sessions (`sess_5fk`, `sess_ntum`, `sess_v6r`) were started with detailed implementation goals. Session `sess_5fk` reached the implementation plan phase (event index 120) but shows no `run_completed` event -- suggesting it stalled or timed out. None produced a merged PR for the validator. The blocker appears to be that coding sessions were started without a clean context bundle, leading to repeated discovery work.

---

## Problem Frame Packet

### The Real Problem Behind the Goal

The goal asks for a pitch. But three prior coding sessions were started with the implementation-level goals derived from that pitch and appear to have stalled. The real problem is not "we don't have a pitch" -- it is "we don't have a clean, current, executable context bundle that a coding agent can run against without rediscovering the landscape."

The pitch at `2026-04-19-worktrain-trigger-validator.md` covers all 4 phases including concrete types and function signatures -- it is already functioning as a context bundle. Its one gap: it was written before Phase 1 was implemented, so it describes Phase 1 as work to do (which would cause a coding agent to try to re-implement it and fail or conflict).

### The Core Tension

The wr.shaping workflow is designed to produce a **product-level pitch** (user story, appetite, breadboard, rabbit holes). The goal asks it to produce a **coding context bundle** (function signatures, test cases, file paths, phase sequencing). These are different artifacts:

| Product Pitch | Coding Context Bundle |
|---|---|
| What the feature does for users | What files to change and how |
| Appetite in calendar days | Phase breakdown in LOC |
| Breadboard in words/arrows | Function signatures in TypeScript |
| Rabbit holes at product level | Implementation risks with line numbers |
| No-gos as user-visible exclusions | No-gos as explicit non-goals |

**Resolution path:** The wr.shaping workflow should produce a product-level pitch (what it is designed for). The implementation detail from the existing pitch should be preserved in the design docs (`docs/design/trigger-validator.md`), which already contains it. The coding agent should be pointed at the design doc, not at the pitch.

### Challenge Notes (from Step 1)

**A1:** A pitch is the right output -- *challenged*. The existing pitch is already complete and marked ready for implementation. The work may be as small as updating `current-pitch.md` with Phase 1's done status.

**A2:** Concrete implementation details belong in the pitch -- *challenged*. The wr.shaping metaGuidance explicitly prohibits this. The goal misuses the shaping workflow as an engineering spec generator.

**A3:** The existing pitch is insufficient -- *challenged*. Its only gap is that it describes Phase 1 as pending when Phase 1 is already implemented. A targeted update addresses this without a full re-shape.

---

## Candidate Directions

### Direction 1: Update the existing pitch to reflect current state (RECOMMENDED)

Update `2026-04-19-worktrain-trigger-validator.md` (or produce a revised `current-pitch.md`) with:
- Phase 1 marked as **IMPLEMENTED** (not pending)
- The remaining work clearly labeled as Phases 2-4
- Problem statement updated to reflect that the two most dangerous safety violations are now caught at startup
- Appetite revised: the remaining work is smaller than the original `m` estimate (only Phases 2-4, ~200 LOC, 3 files not 4)

**Pros:** Respects the existing design work. Accurate about what's done. Gives a coding agent a true picture.  
**Cons:** This is not the "full shaping run" the goal asks for.

### Direction 2: Full wr.shaping re-run with a corrected problem framing

Run the full shaping workflow (Steps 1-9) but with the reframed problem statement (not the solution-framed original), producing a genuine product-level pitch that:
- Treats Phase 1 as already solved context (background)
- Focuses the shaped solution on Phases 2-4 (the observability layer + CLI)
- Produces a pitch that is actually product-level (not an engineering spec)

**Pros:** Produces a clean, product-level document following wr.shaping's intended output contract.  
**Cons:** Loses the implementation detail that the existing pitch already contains and that a coding agent needs. May be solving a solved problem.

### Direction 3: Produce a coding task context bundle directly (bypass wr.shaping intent)

Acknowledge that the real need is a coding context bundle (not a product pitch), and produce the right artifact directly: a context bundle for `wr.coding-task` that:
- States the current codebase state (Phase 1 done)
- Specifies the 9 rules with exact names and severities
- Lists the 3 remaining files and exact changes needed
- Provides test requirements

**Pros:** Most directly addresses what the three stalled coding sessions needed.  
**Cons:** Bypasses the wr.shaping workflow's output contract. Produces something that is not a pitch.

---

## Resolution Notes

**Chosen path: Direction 2 (full re-shape with corrected framing), with Direction 1 elements preserved.**

**Rationale:**
- The goal explicitly asks for a pitch at `current-pitch.md`. The workflow should produce what it is designed for.
- The reframed problem is the right framing: the problem is now "operators have no pre-deploy observability tool" (Phase 1 solved the dangerous silent default; Phase 2-4 solve the observability gap).
- The existing design docs (`trigger-validator.md`, `trigger-validator-candidates.md`, `trigger-validator-review.md`) contain the full implementation detail a coding agent needs. The pitch should reference them, not reproduce them.
- The pitch should be accurate about what has already been shipped (Phase 1) and what remains (Phases 2-4).

**Path to pitch:** The shaping should reframe from "add validator + CLI" to "add pre-deploy observability for trigger configurations." Phase 1 is already solved and becomes background. The shaped solution is the observability layer: `validateTriggerStrict`, `validateAllTriggers`, and `worktrain trigger validate`.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-20 | `goalWasSolutionStatement: true` | Goal names specific design candidate, output path, and asks for implementation detail |
| 2026-04-20 | `pathRecommendation: design_first` | Framing distortion requires design-level correction before artifact production |
| 2026-04-20 | Phase 1 is already implemented | Code inspection confirmed all Phase 1 items in trigger-store.ts post PR 685 |
| 2026-04-20 | Direction 2 chosen | Produce a clean product-level pitch focused on Phases 2-4, with Phase 1 as background |
| 2026-04-20 | Capability assessment: no delegation needed | All required context is in local files; analytical work only |
