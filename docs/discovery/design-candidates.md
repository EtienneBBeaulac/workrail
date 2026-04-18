# Design Candidates: wr.discovery Goal Reframing

**Status:** Candidate generation complete -- for main agent review  
**Date:** 2026-04-18  
**Session:** wr.discovery (improving goal reframing)

---

## Problem Understanding

### Core tensions

**T1: Early interrogation vs late-discovered context**  
Goal interrogation in Phase 0 happens before any landscape work. Some hidden assumptions only become visible after reading the codebase. An early interrogation catches structural goal-type issues (solution-framed vs problem-framed) but misses context-dependent assumptions. Phase 1g retriage catches these later -- but only if the agent explicitly sets `retriageNeeded = true`.

**T2: Non-interactive constraint vs interrogation quality**  
The best reframing comes from dialogue. Daemon sessions have no human. Non-interactive interrogation means the agent interrogates itself, which risks circular reasoning (surfacing expected assumptions rather than genuinely hidden ones).

**T3: Overhead for well-framed goals**  
Any mandatory goal-challenge step adds overhead to every session, including correctly-framed ones. The mechanism must be lightweight for good goals, substantial for misframed ones.

**T4: Workflow enforcement vs agent judgment**  
The workflow can instruct the agent to classify a goal, but the classification itself is still LLM output. A `runCondition` on `goalType = solution_framed` is structural, but the `goalType` value is agent judgment. There is no escape from this.

### Likely seam

Phase 0's `procedure` block -- specifically the `Capture` step that lists context variables and the path selection logic. This is where goal misframing has the highest downstream impact (wrong `pathRecommendation` propagates through all subsequent steps).

### What makes this hard

1. The agent interrogates itself -- self-adversarial reasoning is weaker than adversarial reasoning against a well-defined artifact
2. Solution-framed goals can look like problem-framed goals ('improve discovery' looks like a problem frame but contains hidden assumptions)
3. Adding required output fields to Phase 0 means sessions starting mid-workflow (without Phase 0 context) need graceful fallback

---

## Philosophy Constraints

| Principle | Constraint |
|---|---|
| Validate at boundaries, trust inside | Phase 0 is the input boundary; it must validate goal framing |
| Make illegal states unrepresentable | Solution-framed goal processed without interrogation should not be a valid state |
| YAGNI with discipline | The mechanism must add near-zero cost for well-framed goals |
| Architectural fixes over patches | The fix should change structural invariants, not add 'be careful' reminders |
| Determinism over cleverness | Same goalType -> same downstream path bias |

**Philosophy conflict:** 'Make illegal states unrepresentable' conflicts with 'YAGNI with discipline' when it comes to adding a mandatory interrogation step. A mandatory step is more enforceable but adds overhead for every session.

---

## Impact Surface

| Surface | Must stay consistent |
|---|---|
| `pathRecommendation` context variable | Set by Phase 0; used by all phase-1 `runCondition` gates |
| `problemStatement` context variable | Should reflect the actual problem, not the stated solution |
| `designDocPath` content | Problem framing section becomes misleading if it reflects a solution-framed goal verbatim |
| Phase 1g `retriageNeeded` trigger | If retriage condition changes, existing sessions may behave differently |
| Daemon sessions | Cannot be blocked on interactive responses |

---

## Candidates

### Candidate 1: Minimal -- Extend Phase 0 `Capture` with `goalType` and `impliedProblem`

**Summary:** Add `goalType` (4-value closed enum: `solution_framed | problem_framed | opportunity_framed | decision_framed`) and `impliedProblem` to the Phase 0 `Capture` step. Add a procedure instruction: classify first, derive `impliedProblem` when `solution_framed`, then select path with `goalType` awareness.

**Tensions resolved:** T3 (near-zero overhead for well-framed goals -- classification is lightweight), T4 partially (structural variable exists)  
**Tensions accepted:** T1 (pre-context), T2 (self-interrogation), T4 fully (goalType is still agent judgment)

**Boundary:** Phase 0 `Capture` list and `procedure` text

**Why best fit:** Phase 0 already captures 12+ context variables. Adding `goalType` and `impliedProblem` follows the established pattern. No new step IDs, no new `runCondition` chains, fully backward compatible.

**Failure mode:** Agent classifies a solution-framed goal as `opportunity_framed`, skipping `impliedProblem` derivation. No structural enforcement prevents this.

**Repo pattern:** Follows the existing 'Phase 0 captures context variables for downstream use' pattern.

**Gains:** Zero new steps. Backward compatible. `goalType` available for all downstream phases.  
**Gives up:** No enforcement that classification happens before path selection. Still relies on procedure text instructions, not structural ordering.

**Scope judgment: best-fit as a minimal change.** Not too narrow (introduces the structural signal). Not too broad (no new steps).

**Philosophy:** Honors 'YAGNI', 'Determinism'. Conflicts with 'Make illegal states unrepresentable' (misframings are still structurally possible).

---

### Candidate 2: Structural -- New mandatory Phase 0a before current Phase 0

**Summary:** Add a new step `phase-0a-goal-interrogation` that runs before the current Phase 0. Always runs. Required outputs: `goalType` (4-value enum), `impliedProblem` (string, required when `solution_framed`), `hiddenAssumptions` (array, min 1 when `goalType != problem_framed`), `alternativeFraming` (string, optional). Phase 0 then reads `goalType` from context rather than deriving it.

**Tensions resolved:** T3 partially (well-framed goals produce trivial Phase 0a output fast), T4 (structural enforcement -- path selection cannot happen without Phase 0a having run)  
**Tensions accepted:** T1 (still pre-landscape), T2 (self-interrogation)

**Boundary:** A new step with ID `phase-0a-goal-interrogation`, inserted as the first step of the workflow. Phase 0 becomes a consumer of `goalType` rather than its producer.

**Why best fit:** True structural enforcement. Phase 0a is a required step. The interrogation runs before path selection by design, not by instruction. Mirrors the existing `phase-0b-capability-setup` pattern (a pre-phase setup step before the main classification phase).

**Failure mode:** For well-framed goals, Phase 0a adds overhead. More importantly: Phase 0a and Phase 0 can produce contradictory conclusions if the agent reconsiders its interpretation between steps.

**Repo pattern:** Adapts the `phase-0b-capability-setup` pattern. Departs in that Phase 0a runs before Phase 0 (changes existing step order).

**Gains:** True enforcement. `hiddenAssumptions` and `alternativeFraming` become required outputs with engine validation. Sets a seam for a future reusable `routine-goal-interrogation`.  
**Gives up:** Adds a step to every session (overhead for well-framed goals). Changes step order (Phase 0 is no longer the first step).

**Scope judgment: best-fit for structural correctness, slightly overbroad for immediate need.** The structural separation is the correct long-term architecture.

**Philosophy:** Honors 'Architectural fixes over patches', 'Make illegal states unrepresentable', 'Validate at boundaries'. Conflicts with 'YAGNI with discipline'.

---

### Candidate 3: Distributed -- Three targeted strengthening changes to existing steps

**Summary:** No new steps. Three changes: (1) add `goalType` classification + `impliedProblem` to Phase 0 procedure (same as C1). (2) Make `problemFrameTemplate`'s 'What would make this framing wrong' field a required non-empty output contract in Phase 1e/1f steps. (3) Change Phase 1g `runCondition` from `retriageNeeded = true` to `pathRecommendation == design_first || pathRecommendation == full_spectrum` (retriage always runs for these paths).

**Tensions resolved:** T1 (distributed checkpoints catch both pre-context issues at Phase 0 and post-landscape issues at Phase 1g), T3 (no new steps)  
**Tensions accepted:** T2 (self-interrogation at all checkpoints), T4 partially

**Boundary:** Three existing steps: Phase 0 (procedure text), Phase 1e/1f (output contract), Phase 1g (runCondition).

**Why best fit:** Fixes the three specific weak points in the existing design without adding new steps. Distributed checkpoints catch more than a single-point interrogation.

**Failure mode:** An agent anchored to the original framing can produce weak 'what would make this wrong' answers -- required non-empty output enforces form but not quality. Phase 1g always-on for `design_first` runs a (potentially unnecessary) retriage step for sessions where the path was correct from the start.

**Repo pattern:** Adapts existing `outputRequired` contract pattern. Adapts `runCondition` pattern. Follows (not departs from) established mechanisms.

**Gains:** No new steps. Reinforces three existing weak mechanisms. Catches both early and late misframings.  
**Gives up:** No single strong enforcement point. Effect is diffuse. Does not fix path-selection bias (wrong path can still be chosen in Phase 0 before Phase 1g runs).

**Scope judgment: too narrow as standalone, best-fit as complement to C1 or C2.**

**Philosophy:** Honors 'YAGNI with discipline', 'Architectural fixes over patches'. Conflicts with 'Make illegal states unrepresentable' (path selection still uses raw stated goal).

---

## Comparison and Recommendation

### Tension resolution matrix

| Tension | C1 (Phase 0 extension) | C2 (new Phase 0a) | C3 (distributed) |
|---|---|---|---|
| T1: pre-context interrogation | Accepts | Accepts | Resolves (Phase 1g post-landscape) |
| T2: self-interrogation quality | Accepts (same for all) | Accepts | Accepts |
| T3: overhead for well-framed goals | **Resolves** (lightweight) | Accepts (adds step) | **Resolves** (absorbed) |
| T4: structural enforcement | Partial | **Resolves** (mandatory step) | Partial |

### Recommendation: C1 + C3 hybrid, with C2 as future evolution

**Primary (immediate):** C1 extended with procedural strength: add `goalType`, `impliedProblem`, `hiddenAssumptions` to Phase 0 Capture as required context variables. Add explicit procedure: classify goal type first, derive implied problem before path selection, let goalType influence path bias toward `design_first` for `solution_framed` goals.

**Secondary (no new steps):** Three C3 changes: (a) `goalType` in Phase 0 (same as C1), (b) make 'What would make this framing wrong' a required non-empty output in Phase 1e/1f, (c) change Phase 1g `runCondition` to always run for `design_first` and `full_spectrum` paths.

**Future evolution:** If the C1+C3 hybrid proves insufficient for daemon sessions, extract Phase 0a as a mandatory pre-step (C2).

---

## Self-Critique

**Strongest argument against this recommendation:** C1's enforcement is procedural (instructions), not structural (step ordering). A capable LLM running in QUICK mode or under context pressure can skip the classification step and proceed to path selection. C2's mandatory separate step is the only way to structurally guarantee the interrogation happened.

**Counter:** Both approaches ultimately rely on the LLM following instructions. The difference is in how much structural scaffolding supports following those instructions. C2 enforces 'the step ran' not 'the step ran well.'

**Narrower option:** Just add `goalType` to the Capture list with no procedure change. Too narrow -- introduces the variable without the interrogation mechanism.

**Broader option:** Extract a reusable `routine-goal-interrogation` callable from any workflow. Justified if pattern proves valuable in other workflows. Not warranted now.

**Assumption that would invalidate this:** Claude Sonnet already implicitly reframes solution-framed goals. Counter-evidence: two real examples (MCP simplification, structured output session) show this is not reliably true.

---

## Open Questions for the Main Agent

1. **Should `goalType` influence path selection automatically** (e.g., `solution_framed` -> force `design_first`) or **only as a soft bias**? Automatic enforcement is stronger but may override user intent for cases where the solution IS the right framing.

2. **How should `impliedProblem` flow to the design doc?** Should Phase 0 write it as the `problemStatement` in the design doc (replacing the stated goal), or record it as a separate field ('stated goal' vs 'implied problem')?

3. **Phase 1g runCondition change:** Making Phase 1g always run for `design_first` and `full_spectrum` is a behavior change for existing sessions. Is this backward compatible enough?

4. **`hiddenAssumptions` format:** Should this be a free-text field or a structured array? Free-text is easier to author; structured allows downstream steps to reference specific assumptions.
