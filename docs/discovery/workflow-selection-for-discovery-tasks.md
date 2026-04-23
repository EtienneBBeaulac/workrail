# Workflow Selection for Discovery-Only Tasks

**Status:** Discovery in progress  
**Session:** wr.discovery  
**Date:** 2026-04-17

**Artifact strategy:** This document is for human reading. Execution truth (context variables, step notes) lives in WorkRail session state, not here. This doc is updated at each phase but is not the primary memory -- it can be reconstructed from notes if lost.

---

## Context / Ask

A daemon session was dispatched using `wr.coding-task` with a goal that said "Discovery only -- Do NOT write any code". The session ran 11 advances, produced good design candidate notes, stopped at event 74 with no `run_completed`, and the later advances had no note output (likely conditional skips).

The question: for a discovery-only task (no code, just a design document), should we use `wr.coding-task` or `wr.discovery`? And can `wr.coding-task` be trusted to stay in discovery mode when the goal explicitly says no code?

---

## Path Recommendation

**Path:** `landscape_first`

**Rationale:** The dominant need here is to understand the current structure of two specific workflows and compare their fitness for a known task class (discovery-only). The answer is primarily a landscape/comparison problem, not an ambiguous framing problem. `landscape_first` is the right fit. `full_spectrum` is not needed because we are not uncertain about what the problem is -- we have a concrete incident and two concrete artifacts. `design_first` would be appropriate only if we suspected the stated problem was the wrong problem, and we do not.

---

## Constraints / Anti-goals

**Constraints:**
- We have two concrete workflow JSON files to analyze
- We have a concrete triggers.yml with one `workflowId` configured
- The daemon session behavior is a real observed incident, not a hypothesis

**Anti-goals:**
- Do not redesign either workflow
- Do not recommend changes to workflow step content
- Do not propose a new workflow; only decide which existing one to use

---

## Landscape Packet

### Current state summary

`wr.coding-task` (lean v2, v1.1.0) is a full implementation lifecycle workflow. Its `about` field says: "Use this to implement a software feature or task." Its preconditions include "A deterministic validation path exists (tests, build, or an explicit verification strategy)." It explicitly describes what it produces: `implementation_plan.md`, `spec.md`, code slices, and a PR-ready handoff with commit JSON.

`wr.discovery` (v3.1.0) is a structured thinking/design workflow. Its `about` field says: "Use this to explore and think through a problem end-to-end." Its metaGuidance explicitly states: "Boundary: this workflow can end with a recommendation memo, prototype or test plan, or a research-informed direction. It should not implement production code."

### Step structure analysis: wr.coding-task

| Step | Condition | Discovery-relevant? |
|------|-----------|---------------------|
| phase-0: Understand & Classify | always runs | Yes -- classifies complexity/rigor |
| phase-1a: State Hypothesis | `taskComplexity != Small AND rigorMode != QUICK` | Yes |
| phase-1b-design-quick: Lightweight Design | `taskComplexity != Small AND rigorMode == QUICK` | Yes |
| phase-1b-design-deep: Tension-Driven Design | `taskComplexity != Small AND rigorMode != QUICK` | Yes |
| phase-1c: Challenge and Select | `taskComplexity != Small` | Yes |
| phase-2: Design Review loop | `taskComplexity != Small` | Yes |
| phase-3: Slice, Plan, and Test Design | `taskComplexity != Small` | Implementation planning |
| phase-3b: Spec (Observable Behavior) | `taskComplexity != Small AND (Large OR High risk)` | Implementation planning |
| phase-4: Plan Audit loop | `taskComplexity != Small AND rigorMode != QUICK` | Implementation planning |
| phase-5: Small Task Fast Path | `taskComplexity == Small` | Implementation (code required) |
| phase-6: Implement Slice-by-Slice loop | `taskComplexity != Small` | **Code writing** |
| phase-7: Final Verification loop | `taskComplexity != Small` | **Code verification** |

**Key finding:** For a task classified as `Small`, the workflow skips phases 1a, 1b, 1c, 2, 3, 3b, 4, 6, 7 and runs only phase-0 and phase-5. Phase-5 (Small Task Fast Path) **explicitly requires writing code** and producing a handoff JSON block with `filesChanged`. There is no "Small + discovery only" path.

For Medium/Large tasks, the workflow runs the full design pipeline (phases 0-4) which produces `design-candidates.md` -- but it then continues directly into implementation (phases 6-7). There is no early exit after design.

**Does wr.coding-task have a "discovery only" mode?** No. It has no `runCondition` or context variable that would stop before implementation when a goal says "no code". The only escape hatch would be the agent choosing to stop itself based on the goal text -- which is an honor-system trust, not a structural guarantee.

### What phases run for Small vs Medium/Large

**Small task path:**
- phase-0 (classify)
- phase-5 (fast path -- writes code, produces commit JSON)
- All other phases skipped via `runCondition: taskComplexity == Small` or `taskComplexity != Small`

**Medium/Large task path:**
- phase-0 (classify)
- phase-1a/1b/1c (design candidates)
- phase-2 (design review loop)
- phase-3 (implementation plan)
- phase-3b (spec, if Large or High risk)
- phase-4 (plan audit loop)
- phase-6 (implement slice loop -- **writes code**)
- phase-7 (final verification loop)

The daemon session ran 11 advances and stopped at event 74. Given the step structure, for a Medium/Large non-QUICK classification, 11 advances would likely cover phases 0-4 (design + planning), stopping before phase-6 (implementation). This means the session exhausted the design pipeline but never reached code-writing -- not because the workflow has a discovery mode, but because the agent stopped before phase-6, possibly because:
1. The goal text said "no code" and the agent respected it
2. A loop condition evaluation or `requireConfirmation` gate paused/stopped execution
3. The session timed out or the MCP connection dropped before the loop started

The "no note output on later advances" is consistent with conditional steps being skipped (e.g., phase-3b skipped because not Large/High-risk, or loop steps stopping early).

### wr.discovery landscape

`wr.discovery` runs: path selection -> capability setup -> landscape understanding -> problem framing -> re-triage (conditional) -> synthesis -> candidate generation -> challenge/selection -> direction review loop -> uncertainty resolution (direct recommendation / research loop / prototype loop) -> final validation -> handoff.

It explicitly cannot produce production code. It always ends with a design document, recommendation memo, or prototype spec. There is no implementation path in the workflow.

### Option categories

1. **Use wr.discovery** for discovery tasks, `wr.coding-task` for implementation tasks
2. **Use wr.coding-task for everything**, trusting the agent to stop early when goal says "no code"
3. **Add a discovery-mode flag** to `wr.coding-task` via a `runCondition` on phases 6-7
4. **Use separate triggers** in triggers.yml with different `workflowId` per task type

### Contradictions / disagreements

- The daemon session with `wr.coding-task` produced "good design candidates notes" -- so the workflow does good design work even though it is intended for implementation. The design pipeline (phases 1-4) is legitimate and high quality.
- The risk is not that `wr.coding-task` does bad design work. The risk is that (a) it might not stop before phase-6 reliably, and (b) it carries implementation framing (slices, spec, PR handoff) that pollutes a pure discovery context.

### Evidence gaps

- We do not know the exact event log from the stopped daemon session -- we cannot confirm whether it stopped naturally or by connection drop
- We do not know whether the agent in that session reached phase-6 or stopped before it
- We cannot test "honor system" reliability without more session data

---

## Problem Frame Packet

### Users / stakeholders

- Daemon dispatcher: needs to select the right `workflowId` in triggers.yml
- Agent executing the session: needs structural guarantees, not honor-system constraints
- Developer (you): needs the design document output to be pure and trustworthy

### Jobs / goals / outcomes

- Dispatch a session that produces a design document and nothing else
- Know with certainty that no code will be written, regardless of agent judgment
- Get a high-quality, structured design output comparable to what wr.coding-task's design phases produce

### Pains / tensions / constraints

- The daemon currently has ONE `workflowId` in triggers.yml -- no per-task routing
- `wr.coding-task` is trusted for design quality but is not structurally bounded to stop before code
- `wr.discovery` is structurally bounded to no-code but may produce different design output depth

### Success criteria

1. A discovery-only task produces only a design document, never code or a PR
2. The selection is structural (a wrong `workflowId` cannot accidentally write code), not honor-system
3. The design quality is not degraded by switching to `wr.discovery`

### Assumptions

- The daemon reads `workflowId` directly from triggers.yml and cannot dynamically select based on goal text
- `wr.discovery` produces design candidates comparable in quality to what phases 1-4 of `wr.coding-task` produce
- triggers.yml supports multiple trigger entries with different `workflowId` values

### Reframes / HMW questions

- HMW: How might we route discovery tasks to `wr.discovery` and implementation tasks to `wr.coding-task` at the dispatcher level instead of relying on agent judgment?
- HMW: How might we make "discovery only" a structural guarantee rather than a goal-text instruction?

### What would make this framing wrong

- If the daemon cannot support multiple triggers, option 4 (separate triggers) is blocked
- If `wr.discovery` produces materially weaker design output for technical workflow questions, the quality tradeoff matters

---

## Candidate Generation Expectations (landscape_first)

Because this is a `landscape_first` path, the candidate set must:
- Clearly reflect the landscape findings (the actual step structure of both workflows, the triggers.yml constraint)
- Not invent options that contradict what was observed in the workflow files
- Include at least one option that uses existing structure without any modification
- Include the runner-up option that would feel like a real alternative, not just a straw man

The three candidates (A, B, C) below were derived directly from the landscape analysis, not from free invention.

---

## Candidate Directions

### Direction A: Use wr.discovery for discovery tasks (structural routing)

Configure a second trigger entry in triggers.yml with `workflowId: wr.discovery` for discovery-only goals. The structural guarantee is that `wr.discovery` cannot write code -- it does not have those steps. The daemon would need to support routing (two triggers, each with a matching rule or explicit goal flag).

**Why it fits:** Structural guarantee. `wr.discovery` was explicitly designed for this use case. Its metaGuidance says "should not implement production code."

**Strongest evidence for it:** The session incident shows the risk of relying on honor-system stop behavior in `wr.coding-task`. Structural routing removes the risk entirely.

**Strongest risk against it:** triggers.yml currently supports one trigger per session. If it cannot support multiple triggers with per-task routing, this requires daemon work. Also, `wr.discovery` produces a recommendation memo/design doc, not the same `design-candidates.md` artifact shape that `wr.coding-task` phases 1-4 produce.

**When it should win:** Always, for any task where the desired output is a design document and there is no intent to implement code in the same session.

---

### Direction B: Trust wr.coding-task with honor-system stop

Keep triggers.yml as-is. Rely on the goal text ("Discovery only -- Do NOT write any code") to instruct the agent to stop before phase-6.

**Why it fits (weakly):** The prior session actually did produce design candidates and apparently stopped before code. It worked once.

**Strongest evidence for it:** The 11-advance session with good design notes suggests the agent did respect the goal text.

**Strongest risk against it:** The workflow has no structural stop before phase-6. A future session could classify the task differently, run through phases 0-4 faster, and reach phase-6 before the session ends. Phase-6 will attempt to implement code. The only protection is the agent re-reading the goal and choosing not to implement -- which is fragile under long sessions, context window pressure, or agent model changes.

**When it should win:** Never for production use. Acceptable as a short-term workaround only.

---

### Direction C: Add discoveryMode flag to wr.coding-task

Modify `wr.coding-task` to support a `discoveryMode` context variable. Add `runCondition: { var: "discoveryMode", not_equals: true }` to phases 6 and 7. Pass `discoveryMode: true` via the goal or a trigger-level context override.

**Why it fits:** Preserves the high-quality design pipeline of `wr.coding-task` while adding a structural stop before implementation.

**Strongest evidence for it:** The design phases (1-4) of `wr.coding-task` are well-designed and familiar. Reusing them avoids duplication.

**Strongest risk against it:** This requires modifying a core workflow file. It adds complexity to a workflow that was designed for a different purpose. It creates a hybrid that does neither thing cleanly. And triggers.yml still only has one trigger, so the `discoveryMode` value must come from somewhere (goal text parse? trigger-level context?).

**When it should win:** If modifying `wr.discovery` or the daemon is unavailable, and modifying `wr.coding-task` is cheap and acceptable.

---

## Challenge Notes

**Against Direction A (wr.discovery):** The design output format differs. `wr.coding-task` produces `design-candidates.md` via the `tension-driven-design` routine, followed by a `design-review-findings.md` and a full `implementation_plan.md`. `wr.discovery` produces a design doc with Candidate Directions and a recommendation. For a technical question about workflow architecture, the `wr.discovery` output (a recommendation memo) is actually _more_ appropriate than `implementation_plan.md`. The format difference is not a disadvantage.

**Against Direction B:** The incident already showed the risk. The session stopped at event 74 with no `run_completed`. We do not know if it stopped intentionally or by timeout/connection drop. If it stopped by timeout, the next session might not stop in the same place. Structural guarantees are always preferred over honor-system constraints when the downside (code written to a wrong branch) is recoverable but costly.

**Against Direction C:** Modifying `wr.coding-task` for a use case it was not designed for violates the "make illegal states unrepresentable" principle. It is better to use the right tool than to add a mode switch to the wrong tool.

---

## Resolution Notes

**Direction A wins.** `wr.discovery` is the right workflow for discovery-only tasks. The structural guarantee -- no implementation steps exist in the workflow -- is strictly better than an honor-system stop. The triggers.yml configuration needs to evolve to support per-task workflow routing.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| `landscape_first` path chosen | We have two concrete artifacts to compare; this is a comparison/routing question, not an ambiguous framing problem |
| Direction A selected | Structural guarantees are always preferred over honor-system constraints; `wr.discovery` was built for this |
| Direction B rejected | Honor-system stop is fragile; the incident confirmed the risk |
| Direction C rejected | Adding a mode switch to the wrong tool is worse than using the right tool |
| Multiple triggers confirmed | Read `src/trigger/trigger-store.ts` and `src/trigger/trigger-router.ts`. `loadTriggerConfig()` loads all entries; `buildTriggerIndex()` maps by unique `id`; `route()` dispatches by `triggerId`. A second trigger entry with `workflowId: wr.discovery` works today with zero code changes. |

---

## Final Summary

### Selected direction: Direction A -- use wr.discovery for discovery-only tasks

**Confidence band: High**

#### Recommendation

For a discovery-only task (no code, just a design document):
- **Use `wr.discovery`**, not `wr.coding-task`
- Add a second trigger entry to `triggers.yml` with a unique `id` and `workflowId: wr.discovery`
- The daemon's trigger-store.ts and trigger-router.ts already support multiple triggers with different workflowIds -- no code change required

#### Example triggers.yml configuration

```yaml
triggers:
  - id: test-task
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /Users/etienneb/git/personal/workrail
    goal: "Add the evidenceFrom field to AssessmentDimension..."
    concurrencyMode: parallel
    autoCommit: false
    agentConfig:
      maxSessionMinutes: 60

  - id: discovery-task
    provider: generic
    workflowId: wr.discovery
    workspacePath: /Users/etienneb/git/personal/workrail
    goal: "Discovery only: ..."
    concurrencyMode: parallel
    autoCommit: false
    agentConfig:
      maxSessionMinutes: 60
```

The caller must send the correct `triggerId` (`discovery-task` vs `test-task`) when firing the webhook.

#### Why wr.coding-task cannot be trusted in discovery mode

`wr.coding-task` has no structural stop before phase-6 (Implement Slice-by-Slice). For Small tasks, phase-5 (Small Task Fast Path) explicitly requires writing code. For Medium/Large tasks, the design pipeline (phases 0-4) produces good design work, then phase-6 writes code. The only protection against code-writing is the agent choosing to stop based on goal text -- an honor-system constraint that can fail under context window pressure.

The prior session stopped at event 74 (likely after phase-4, before phase-6) -- but we cannot confirm whether this was agent judgment or a connection drop. With `wr.discovery`, the question is irrelevant: there are no phases 6-7 to reach.

#### What phases wr.coding-task skips for Small tasks

- Skips: phase-1a (hypothesis), phase-1b (design), phase-1c (challenge), phase-2 (design review), phase-3 (plan), phase-3b (spec), phase-4 (plan audit), phase-6 (implementation), phase-7 (verification)
- Runs: phase-0 (classify) and phase-5 (Small Task Fast Path -- **writes code**)

For Medium/Large tasks, all phases run in sequence, including phase-6 (implementation).

#### Would wr.discovery have been a better choice?

Yes, without qualification. `wr.discovery` was designed for exactly this use case. Its metaGuidance states: "should not implement production code." All paths end with a recommendation memo, prototype spec, or research plan. It uses the same `tension-driven-design` routine as `wr.coding-task` phases 1b, so design quality is equivalent.

#### How to configure triggers.yml for discovery vs implementation

- **Implementation tasks**: `workflowId: wr.coding-task` -- use the existing `test-task` trigger or rename it
- **Discovery tasks**: `workflowId: wr.discovery` -- add a new trigger entry (e.g., `id: discovery-task`)
- Route by sending the correct `triggerId` in the webhook

#### Workflow selection strategy when the daemon has ONE workflowId configured

The current `test-task` trigger always dispatches to `wr.coding-task`. For discovery tasks, either:
1. Add a second trigger entry (preferred -- structural routing, zero code change)
2. Temporarily change the trigger's `workflowId` to `wr.discovery` for discovery sessions, then change it back (workable but manual and error-prone)
3. Use console AUTO dispatch and set `workflowId: wr.discovery` explicitly in the dispatch request (for console-dispatched sessions only)

Option 1 is the right answer.

### Strongest alternative: Direction C (add discoveryMode flag to wr.coding-task)

If the two-trigger routing were unavailable (it is not), adding `runCondition: { var: "discoveryMode", not_equals: true }` to phases 6-7 would also provide structural enforcement. Loses: workflow cleanliness, YAGNI compliance, reversibility. Not recommended when Direction A is available.

### Residual risks

1. **Console dispatch scope boundary** (Yellow): console AUTO dispatch uses `workflowId` directly, not `triggerId`. For console-dispatched discovery sessions, the caller must explicitly set `workflowId: wr.discovery`. The two-trigger triggers.yml setup covers webhook-triggered sessions only.

2. **Prior session at event 74**: stop reason unknown. If it was a connection drop, the design pipeline output may be incomplete. Review the session artifacts before using them. Direction A eliminates this risk for future sessions.

### Next actions

1. Add a second trigger entry to `triggers.yml` with `id: discovery-task` and `workflowId: wr.discovery`
2. Route discovery-only goals to the `discovery-task` trigger ID when firing webhooks
3. Review the prior session's design artifacts for completeness
