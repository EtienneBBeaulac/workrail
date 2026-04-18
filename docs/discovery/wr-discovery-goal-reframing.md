# Discovery: Improving wr.discovery Goal Reframing

**Status:** Discovery in progress
**Session:** wr.discovery (Phase 1 -- diagnosis)
**Date:** 2026-04-18

**Artifact strategy:** This document is for human reading. Execution truth (context variables, step notes) lives in WorkRail session state. This doc is updated at each phase.

---

## Context / Ask

The `wr.discovery` workflow (v3.1.0) takes the stated goal at face value. Users often state solutions instead of problems, carry faulty assumptions into the brief, or do not actually know what they want. The goal of this discovery is to diagnose what is specifically weak about the current workflow and identify improvement directions -- not to design the final solution.

---

## Path Recommendation

**Path:** `design_first`

**Rationale:** The dominant risk here is solving the wrong problem. "Make discovery better" is ambiguous. The brief itself suggests one diagnosis (takes requests at face value) but that framing may itself be incomplete -- the problem could be about *when* reframing happens, *how* it happens, *what triggers* it, or something else entirely (e.g., the problem is that the workflow is too sequential rather than too credulous). `design_first` is the right path because the framing is genuinely uncertain and jumping to "add a reframe step" risks solving a surface symptom. A `landscape_first` path would just survey other discovery frameworks -- interesting but not the center of gravity. `full_spectrum` would work but would diffuse effort equally on landscape and framing when framing is the real bottleneck.

**Why not landscape_first:** The landscape (design thinking, Jobs-to-be-Done, 5 Whys, pre-mortem, etc.) is well-known and would mostly confirm what we already know. The interesting question is not "what frameworks exist" but "what structural change to this specific workflow would make it genuinely better."

---

## Constraints / Anti-goals

**Constraints:**
- The improved workflow must remain usable in automated (daemon) contexts where no human is present to answer follow-up questions
- Changes to `wr.discovery.json` must follow the v2 workflow authoring format
- The workflow already has a path-selection mechanism (phase-0); any improvement should integrate with or extend this, not duplicate it
- Must not break existing sessions mid-flight

**Anti-goals:**
- Do not add interactive Q&A that assumes a human will respond (daemon contexts have no human)
- Do not make the workflow so heavy that it becomes a therapy session before doing any actual work
- Do not import external frameworks wholesale -- extract principles, do not copy playbooks
- Do not redesign the full workflow structure -- focus on the goal-reframing problem specifically

---

## Landscape Packet

### Current state summary

`wr.discovery` v3.1.0 has a Phase 0 that:
1. Captures `problemStatement`, `desiredOutcome`, `coreConstraints`, `antiGoals`, `primaryUncertainty`, `knownApproaches`
2. Selects a path: `landscape_first`, `full_spectrum`, `design_first`
3. Creates a design doc

**What Phase 0 does NOT do:**
- It does not challenge or probe the stated goal
- It does not distinguish between "user stated a problem" vs "user stated a solution"
- It does not surface faulty assumptions in the goal itself
- It does not ask "is this the real problem or is it a symptom?"
- The path selection criteria are about *emphasis* (landscape vs framing), not about *goal validity*

The workflow does have a `design_first` path choice and a "what would make this framing wrong" element in the problemFrameTemplate -- but these apply after the goal is accepted, not before.

### Existing approaches / precedents

**1. Design Thinking (IDEO/Stanford d.school):** "Empathize" phase is explicitly about setting aside your solution hypothesis and observing real user behavior. Pre-work question: "Are we solving the right problem?" The structural insight: problem reframing is not a step *in* the process -- it is a prerequisite to starting the process.

**2. Jobs-to-be-Done (Christensen):** When a user states "I want a faster horse," the JTBD practitioner asks "What job are you trying to get done?" The goal is to surface the functional, emotional, and social dimensions of the actual outcome -- not the solution form. Structured probe: "What were you doing before? What did you try? What would success look like even if our solution didn't exist?"

**3. 5 Whys (Toyota):** Sequential causal probing. "Why do you want X?" -> "Because Y." "Why Y?" -> "Because Z." Three to five levels of probing reveals whether the stated goal is a root cause or a symptom. Works well for problem goals; less well for opportunity goals.

**4. Pre-mortem (Gary Klein):** "Imagine we did exactly what you asked and it failed. What went wrong?" Forces the requester to articulate hidden assumptions. Particularly effective at surfacing: wrong success criteria, ignored stakeholders, underestimated constraints.

**5. AI-specific: Prompt interrogation patterns:** The "goal elicitation" pattern in agentic AI systems (e.g., AutoGPT system prompts, OpenAI alignment research) distinguishes between *stated objectives* and *intended objectives*. The typical mechanism: present a synthetic interpretation back to the user and ask for confirmation or correction.

**6. Consulting intake (McKinsey, IDEO, etc.):** A structured discovery brief usually has: "What decision do you need to make?" + "What would change if you had the answer?" + "Who else has thought about this?" + "What have you already tried?" The intake is not about validating the solution -- it is about understanding the decision context.

### Option categories

1. **Pre-step interrogation:** Add a Phase -1 (before path selection) that explicitly challenges the goal statement
2. **Integrated reframing in Phase 0:** Extend Phase 0 to include goal challenge as part of classification
3. **Adversarial dual-track:** Run two interpretations in parallel -- "take it literally" vs "reframe it" -- and let synthesis surface the gap
4. **Progressive commitment:** Start with minimal goal acceptance, revisit the framing after each major phase, make reframing explicit at retriage points
5. **Structural annotation:** Add a `goalType` classification (solution-framed, problem-framed, opportunity-framed, decision-framed) that changes how Phase 0 proceeds

### Contradictions / disagreements

- The workflow already has `design_first` as a path and says "Choose `design_first` when the dominant risk is solving the wrong problem" -- but the path selection itself uses the stated goal as input. If the goal is wrong, the path selection can still be wrong.
- Phase 1g (re-triage) exists for course correction after landscape and framing work -- but it triggers on `retriageNeeded` being explicitly set, which assumes the agent identifies the need. A goal stated as a solution could pass through path selection and Phase 1 without triggering retriage.
- The metaGuidance says "Anti-anchoring: do not let the first framing or favorite option dominate the work" -- but this applies to *candidate generation*, not to goal framing. The stated goal is not challenged by this guidance.

### Evidence gaps

- No direct data on how often real discovery sessions start with solution-framed goals vs problem-framed goals
- No post-hoc analysis of sessions where the stated goal turned out to be wrong
- The two specific examples from the brief (MCP simplification, structured output) are known anecdotally but not documented

### Why this matters for path selection

The current workflow's structure means the *path selection step* inherits any misframing in the goal. A solution-framed goal can be classified as `landscape_first` when it should be `design_first`. The goal challenge needs to happen *before* path selection, or path selection needs to be goal-type-aware.

---

## Problem Frame Packet

### Users / stakeholders

- **Primary:** User (human or daemon) submitting a goal to `wr.discovery`
- **Secondary:** Etienne (workflow author) -- wants the workflow to produce genuinely surprising insights, not just organize what was already stated
- **Tertiary:** Downstream consumers of the design document

### Jobs / goals / outcomes

- **Actual job:** "Help me think through this problem so I reach the best decision, even if I described the problem wrong"
- **Stated job:** "Help me with [stated goal]"
- **The gap:** These are often not the same. The user often does not know the gap exists.

### Pains / tensions / constraints

- **T1: Goal credulous processing:** Phase 0 processes the stated goal as if it is valid. A solution-framed goal ("build X") is treated as if "X is the right solution" is not an assumption.
- **T2: Daemon context constraint:** A daemon session has no human to answer follow-up questions. Any interactive "is this really what you want?" loop requires a human. Daemon sessions must use a non-interactive reframing strategy.
- **T3: Overhead vs signal ratio:** Heavy interrogation adds steps. If the goal is correctly framed (which it often is), the extra steps are pure overhead. The mechanism must be lightweight and skip gracefully when the goal is already well-framed.
- **T4: Reframing is hard to automate:** The AI cannot know what the user "really" wants -- it can only identify structural signals of a poorly-framed goal (solution-framing, missing success criteria, absent alternatives, hidden assumptions).

### Success criteria

1. The workflow identifies solution-framed goals and surfaces the implicit problem before generating candidates
2. The workflow works in daemon contexts (no interactive questioning required)
3. The overhead for a well-framed goal is minimal (a few structural notes, not a full reframing ceremony)
4. The output of a reframed session differs meaningfully from the output of a non-reframed session for the same goal

### Assumptions

- The goal text itself contains structural signals that distinguish "stated solution" from "stated problem" (e.g., "implement X" vs "improve Y" vs "decide between A and B")
- Surfacing the implicit problem does not require user confirmation -- it can be done by the agent itself as a reasoning step
- The most important case is solution-framed goals -- a user who says "add a reframe step to wr.discovery" is actually asking about "how to make discovery better" (this very brief is an example)

### Reframes / HMW questions

- HMW: How might we detect when a stated goal is a solution hypothesis rather than a problem statement -- without requiring human confirmation?
- HMW: How might we ensure the workflow explores the problem space *before* accepting the stated goal's framing?
- HMW: How might we make goal reframing something the agent does *for itself* rather than a ceremony it performs *for the user*?

### What would make this framing wrong

- If the agent model is already good enough at implicit reframing (without explicit prompting), the structural change adds ceremony without value
- If daemon sessions are a small minority of `wr.discovery` uses, an interactive probe could work for the majority case
- If the real problem is not "goal acceptance" but "insufficient candidate diversity" -- i.e., the workflow accepts the goal but generates too-narrow candidates -- then the fix belongs in Phase 3, not Phase 0

---

## Candidate Generation Expectations (design_first)

Because this is a `design_first` pass:
- At least one direction must meaningfully reframe the problem, not just add a "challenge" step
- The candidate set must address the daemon constraint directly -- solutions that require human interaction are non-starters
- Include the simplest change that could work alongside more structural alternatives

---

## Candidate Directions

### Direction A: Goal-type classification in Phase 0 (minimal change)

**Summary:** Extend Phase 0 to classify the stated goal into one of four structural types: `solution_framed` ("build/add/implement X"), `problem_framed` ("improve/fix/reduce Y"), `opportunity_framed` ("explore/understand Z"), `decision_framed` ("choose between A and B"). When the goal is `solution_framed`, Phase 0 must explicitly surface the implicit problem statement before proceeding.

**Mechanism:** Add a `goalType` context variable and a procedure step: "Before selecting a path, classify the goal as `solution_framed`, `problem_framed`, `opportunity_framed`, or `decision_framed`. If `solution_framed`, produce an explicit `impliedProblem` statement: 'The stated goal implies this underlying problem: [X]. Confirm this is correct or surface a different problem frame before proceeding.'"

**Why it fits:** Minimal change. Works in daemon context (no human confirmation needed -- the agent surfaces the implication and continues). Does not add steps; extends Phase 0. The goalType classification is cheap and structural.

**Strongest evidence for it:** The brief itself is a perfect example: "improve wr.discovery goal reframing" is opportunity-framed, but the actual problem statement needs to be made explicit ("the workflow accepts stated goals uncritically"). Phase 0 in the current workflow would process this as landscape/full_spectrum without ever articulating the underlying mechanism.

**Strongest risk against it:** The four-category taxonomy may be too rigid. Many goals are mixed (e.g., "decide whether to build X or Y" is both decision-framed and solution-framed). Also, the agent may classify incorrectly, and without human confirmation in daemon mode, the wrong classification goes uncorrected.

**When it should win:** When the change must be minimal, backward-compatible, and immediately implementable without restructuring the workflow.

---

### Direction B: Adversarial goal interrogation as a distinct Phase 0b step

**Summary:** Add a new Phase 0b (between goal capture and path selection) that runs a structured adversarial interrogation of the stated goal. The step always runs and produces: the `impliedProblem`, the `hiddenAssumptions`, and at least one `alternativeFraming`. Path selection happens *after* this step, using the enriched understanding rather than the raw goal.

**Mechanism:** Phase 0b procedure: "(1) Restate the goal as a problem: what must be true for this goal to be the right thing to do? (2) List the 2-3 hidden assumptions the goal takes for granted. (3) Generate one alternative framing: if the stated goal is wrong, what would a better goal be? (4) Decide: is the original framing correct as-stated, or does the workflow proceed under the reframed problem? Set `goalValidated`, `impliedProblem`, `hiddenAssumptions`, `alternativeFraming` in context."

**Why it fits:** Makes reframing structural and always-on rather than path-dependent. The adversarial lens is familiar in WorkRail (adversarial challenge is already used in Phase 3d). This is the same discipline applied earlier in the process. Works in daemon context -- no human response needed, the agent conducts the interrogation with itself.

**Strongest evidence for it:** The two examples in the brief: (1) MCP simplification -- the discovery produced design candidates but missed that the immediate fix was just `artifacts` -- this is a case where the stated goal ("how do we simplify?") was accepted when the real problem was narrower ("what's the cheapest fix right now?"). (2) Structured output -- started with the wrong assumption about mixing `response_format + tools`, which Phase 0 would have surfaced if it asked "what assumptions does this goal take for granted?"

**Strongest risk against it:** Adds a mandatory step. For well-framed goals, the step is overhead with no signal. Also, the agent interrogating its own goal with itself may produce circular reasoning -- it surfaces the assumptions it already expects, not genuinely hidden ones.

**When it should win:** When the problem of goal acceptance is systematic and the overhead of an extra step is acceptable. This is the more thorough solution.

---

### Direction C: Progressive commitment -- reframing woven across phases

**Summary:** Instead of a single upfront interrogation, weave explicit "is the framing still correct?" moments at multiple points in the workflow: after landscape (Phase 1b/1c), after problem framing (Phase 1e/1f), and explicitly in re-triage (Phase 1g). The mechanism: add a `framingChallenge` requirement at each of these steps -- a single structured question ("what would have to be true for the original goal to be wrong?") rather than a separate step.

**Mechanism:** At Phase 1b (landscape), after summarizing the current state, add: "Before continuing, ask: does the landscape evidence support or challenge the original goal? If it challenges, update `retriageNeeded = true` and note the specific challenge." At Phase 1e/1f (problem framing), the existing `problemFrameTemplate` already has "What would make this framing wrong" -- make this a required non-empty output, not a soft guideline. In Phase 1g (re-triage), add explicit procedure: "Revisit the original goal statement. Is the goal still correct as-stated given what you now know?"

**Why it fits:** Does not add steps. Upgrades existing checkpoints. The re-triage step already exists for this purpose but currently triggers on a set variable rather than mandating goal challenge. Most importantly: distributed reframing is more likely to catch late-arriving information than a single upfront interrogation.

**Strongest evidence for it:** The workflow already has `anti-anchoring` guidance in metaGuidance -- "do not let the first framing or favorite option dominate." This direction makes the same principle apply to the *goal*, not just the *candidates*. It is consistent with the workflow's existing philosophy.

**Strongest risk against it:** If the original goal is wrong in a way that affects path selection itself (e.g., choosing `landscape_first` when `design_first` was needed), distributed reframing happens too late. The path is already chosen; the work is already done in the wrong direction.

**When it should win:** When the problem is primarily about insufficient rigor late in the workflow, not about path selection being skewed by a bad goal.

---

## Challenge Notes

**Against Direction A (goal-type classification):**
The four-category taxonomy solves the symptom (goal is solution-framed) but not the underlying mechanism. A goal classified as `problem_framed` ("improve Y") can still contain hidden assumptions. The classification alone is not sufficient -- it needs to be paired with explicit assumption surfacing.

**Against Direction B (adversarial Phase 0b):**
Phase 0b interrogates the goal before the agent has any landscape knowledge. This limits the quality of assumption surfacing -- the agent can only use its prior knowledge, not what it discovers in the codebase. The most surprising hidden assumptions are often ones that only become visible after seeing the actual state of the system.

**Against Direction C (progressive commitment):**
Distributed reframing is weaker than upfront reframing for the specific problem of path selection bias. If the original goal causes the wrong path to be selected, later reframing stages run within the wrong path's constraints. Retriage exists but only triggers when `retriageNeeded` is set -- and an agent anchored to the original framing may not set it.

**Synthesis:** The strongest design would combine A and B: goal-type classification *plus* an adversarial interrogation step. Direction C should also be incorporated -- make the "what would make this framing wrong" field in problemFrameTemplate mandatory and non-empty. But a minimal viable change is Direction B alone.

---

## Resolution Notes

**Primary diagnosis:**
The core weakness is that Phase 0 has no mechanism to distinguish "user stated a real problem" from "user stated a solution hypothesis." The path selection, framing, and candidate generation all downstream from this -- if the goal is wrong, the entire workflow is scaffolded on the wrong foundation.

**Secondary diagnosis:**
Even when the path is correct, the workflow has weak *mandatory* goal challenge. The `anti-anchoring` guidance in metaGuidance is for candidates, not for the original goal. The `problemFrameTemplate`'s "what would make this framing wrong" section is a soft guideline, not a required output.

**Tertiary diagnosis:**
The re-triage step (Phase 1g) is underused. It only runs when `retriageNeeded = true`, and the agent sets this variable. An anchored agent will not set it.

**Improvement directions (in priority order):**

1. **Highest priority -- Phase 0 goal interrogation:** Add a structured adversarial examination of the stated goal to Phase 0 (or as a small new step before path selection). The key outputs: `goalType`, `impliedProblem`, `hiddenAssumptions`, `alternativeFraming`. This is the primary fix.

2. **Medium priority -- Make "what would make this wrong" mandatory:** In the problemFrameTemplate, change the "What would make this framing wrong" from an optional field to a required output with at least one specific, concrete falsification condition.

3. **Medium priority -- Make re-triage always run for full_spectrum and design_first paths:** Remove the `retriageNeeded = true` condition gate on Phase 1g for these paths. For `landscape_first`, keep the gate.

4. **Lower priority -- Goal type affects path selection:** When `goalType = solution_framed`, bias toward `design_first` path selection rather than accepting the default, unless the user has explicitly confirmed that the stated solution is the correct framing.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| `design_first` path chosen | The framing of "what's wrong with wr.discovery" is itself uncertain; dominant risk is solving the wrong problem |
| Diagnosis focused on Phase 0 | Phase 0 is where goal acceptance happens; this is the root cause |
| Daemon context preserved as hard constraint | Daemon sessions are real use cases; interactive questioning is not viable |
| C1+C3 hybrid selected (not C2) | C1 extends Phase 0 with goalType/impliedProblem/hiddenAssumptions; C3 strengthens existing checkpoints. C2 (mandatory Phase 0a) is structurally stronger but adds mandatory overhead for every session. YAGNI and graceful-no-op criteria favor C1+C3. |
| 4 refinements added from review | (1) goalType examples in procedure, (2) alternativeFraming in design doc, (3) Phase 1g OR runCondition, (4) specificity instruction for framing-risk required output |
| C2 named as escalation path | If C1+C3 hybrid proves insufficient for daemon sessions, extract Phase 0a as mandatory pre-step |
| direct_recommendation resolution | Remaining gap (goalType classification reliability) is a runtime testability question, not a design gap |

---

## Final Summary

### Selected direction: C1+C3 hybrid with 4 refinements

**Confidence band: MEDIUM-HIGH**

### What changes in the workflow

**Phase 0 (phase-0-select-path):**
1. Add to `Capture` list: `goalType` (4-value enum: `solution_framed | problem_framed | opportunity_framed | decision_framed`), `impliedProblem` (required when solution_framed), `hiddenAssumptions` (min 1 when goalType != problem_framed)
2. Add to procedure: "Before selecting a path, classify the goal type using these examples: solution_framed ('add X', 'implement Y', 'build X'), problem_framed ('reduce X', 'fix Y', 'understand why Z'), opportunity_framed ('explore X', 'decide whether Y'), decision_framed ('choose between A and B'). If solution_framed, derive the implied problem and record at least 1 hidden assumption. Generate one alternative framing ('if this goal is wrong, what would a better goal be?') and record it in the design doc."
3. Add to procedure: "Let goalType influence path selection: when goalType = solution_framed, bias toward design_first unless the stated solution is clearly the correct framing."

**Phase 1e and 1f (problem framing steps):**
4. Make 'What would make this framing wrong' a required non-empty output with specificity: "Name ONE concrete falsification condition -- a specific thing that, if discovered to be true, would change the path or direction."

**Phase 1g (retriage):**
5. Change `runCondition` from `{ var: "retriageNeeded", equals: true }` to an OR: `{ or: [{ var: "retriageNeeded", equals: true }, { var: "pathRecommendation", equals: "design_first" }, { var: "pathRecommendation", equals: "full_spectrum" }] }` so retriage always runs for design_first and full_spectrum paths.

### Why this direction wins

- Addresses path-selection bias (the root cause) by making goalType available before path selection
- Works non-interactively (daemon compatible)
- Adds near-zero overhead for correctly-framed goals
- Strengthens three existing weak mechanisms rather than adding ceremony
- Fully backward compatible (new context variables default to unset in existing sessions)

### Strongest alternative: C2 (mandatory Phase 0a)

C2 is more structurally correct -- a mandatory separate step enforces that goal interrogation happens before path selection at the step-execution level. If the C1+C3 hybrid proves insufficient (tested by running a session with a known solution-framed goal), the correct escalation is to extract `phase-0a-goal-interrogation` as a mandatory pre-step before Phase 0.

### Residual risks

1. **goalType misclassification** (MEDIUM): a solution-framed goal classified as opportunity_framed bypasses the impliedProblem derivation. Mitigated by examples in procedure and Phase 1e/1f backstop. C2 is the escalation.
2. **Quality of 'what would make this framing wrong' output** (LOW-MEDIUM): required non-empty enforces form but not quality. Specificity instruction reduces formulaic responses.
3. **Phase 1g produces trivial output for well-framed sessions** (LOW): acceptable graceful no-op.

### Next actions

These findings are the input to Phase 2: the `workflow-for-workflows` workflow will design the implementation based on this diagnosis.

1. The wfw workflow should receive: the full diagnosis (Phase 0 is the root cause), the specific changes needed (5 changes listed above), the priority order (Phase 0 goalType classification is highest priority), and the decision to implement the C1+C3 hybrid, not C2.
2. After wfw produces the improved workflow, write it to `workflows/wr.discovery.json`.
3. Create PR on branch `feat/discovery-workflow-improve-goal-reframing`.
