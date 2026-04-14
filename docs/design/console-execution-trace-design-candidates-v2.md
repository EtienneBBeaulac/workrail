# Design Candidates: Console Execution-Trace Explainability

> Temporary workflow artifact for the wr.discovery run. Not canonical state -- all findings live in workflow notes/context.

## Problem Understanding

### Core Tensions

1. **Topology vs causality gap**: The DAG correctly shows *what* ran, but not *why*. A 2-node run for a 10-step workflow is correct behavior (fast path via `runCondition`s) but reads as broken without routing context. The engine records causal explanation events (`decision_trace_appended`) but the console renders only structural events (`node_created`, `edge_created`).

2. **Completeness vs cognitive overload**: A fully explained run could have 50+ events. The user needs enough context to understand the run, not a raw event log replay. The right design surfaces explanatory data contextually (collapsed by default, as the design locks already suggest for `decision_trace_appended`).

3. **Domain specificity vs generic rendering**: The console must explain concepts (runCondition, assessmentGate, loopIteration) that are workflow-specific but must be rendered generically by the console layer. The event types are already typed and closed-set -- this is workable.

### Likely Seam

The real seam is the rendering layer's distinction between:
- **(a) Structural events**: what ran (`node_created`, `edge_created`) -- currently shown
- **(b) Routing events**: why/why-not (`evaluated_condition`, `selected_next_step` in `decision_trace_appended`) -- not surfaced
- **(c) Quality events**: how well (`assessments` in `stepContext`) -- not surfaced
- **(d) Health events**: what went wrong or was skipped (`gap_recorded`, `blocked_attempt`, `capability_observed`) -- partially surfaced (blocked_attempt node exists but is undifferentiated)

### What Makes This Hard

The user's mental model is "what did the workflow do?" but the event log answers "what transitions occurred?" These are different questions. A `runCondition` evaluation that returns false is invisible in the node/edge graph but is the most important fact for understanding why a phase didn't run.

---

## Philosophy Constraints

- **Make illegal states unrepresentable**: a user seeing a 2-node DAG and concluding "the run broke" is a representable invalid conclusion in the current design. The console should structurally prevent this misread.
- **Exhaustiveness everywhere**: the question list must be complete, not a representative sample. Missing a real user question is a failure mode.
- **Explicit domain types over primitives**: questions reference typed concepts (runCondition, assessmentGate, loopIteration) not generic "data."
- **Surface information, don't hide it**: if something unexpected is discovered, surface it immediately.

---

## Impact Surface

Any console surface that renders run state must stay consistent with:
- `decision_trace_appended` entries: `selected_next_step`, `evaluated_condition`, `entered_loop`, `exited_loop`, `detected_non_tip_advance`
- Assessment dimension levels and rationale in `stepContext.assessments`
- `gap_recorded` severity/reason/resolution model
- `capability_observed` provenance (strong vs weak enforcement grade)
- `blocked_attempt` nodeKind distinction from `step`
- Effective preference snapshot per node (autonomy, riskPolicy)

---

## Candidates (Grouping Strategies)

### Candidate 1: Five-category grouping per the design brief (recommended)

**Summary**: Use the five categories from the brief (structural/navigation, decision/routing, quality/assessment, iteration/loop, outcome/result).

**Tensions resolved**: Completeness vs cognitive overload -- categories create natural reading order. Directly answers the brief.

**Boundary**: Seam is user mental model, not engine internals. Maps naturally to how users investigate a run.

**Failure mode**: Questions that span categories (e.g., "did the loop run or was it skipped by a runCondition?" touches both routing and iteration). Mitigated by placing cross-cutting questions in the category where the user would first look.

**Scope**: Best-fit. Exactly what the brief asks for.

**Philosophy**: Honors exhaustiveness. Clean mapping to explicit domain types.

---

### Candidate 2: User-journey temporal order

**Summary**: Reorder the five categories by when the question arises in a typical console session: structural first, then routing, then iteration, then quality, then outcome.

**Tensions resolved**: Maps to user's discovery sequence in a console session.

**Failure mode**: Users debugging a specific problem may jump directly to assessment or loop questions.

**Scope**: Slightly broad -- adds UX framing the brief doesn't request.

---

### Candidate 3: Data-source anchored grouping

**Summary**: Group by event type: `decision_trace` questions, `gap_recorded` questions, assessment questions, loop trace questions, `runCondition` questions.

**Tensions resolved**: Makes the data source explicit, most useful for engineers implementing the console.

**Failure mode**: Users don't think in terms of event types. Hard to use in a design initiative.

**Scope**: Too narrow for the stated goal.

---

## Comparison and Recommendation

**Recommendation: Candidate 1**

All three candidates cover the same underlying 30+ questions. Candidate 1 uses the brief's grouping, is most actionable for the console design team, and maps directly to user mental models. Candidate 2 adds temporal ordering the brief doesn't ask for (useful later in a UX design pass). Candidate 3 is for the implementation phase, not the discovery phase.

---

## Self-Critique

**Strongest counter-argument**: Candidate 2's temporal ordering might be more intuitive for a user reading the output. Counter: the brief explicitly specifies the five categories, and temporal order can be derived from the list by the design team.

**Pivot condition**: If the design team finds the list hard to prioritize, Candidate 2's temporal order becomes relevant. But that's a presentation decision, not a content decision.

**What assumption would invalidate this**: If the five categories themselves are wrong. They're grounded in the brief's concrete scenarios -- they're not invented.

---

## Open Questions for the Main Agent

1. Are there question categories beyond the five in the brief? (Cross-run comparison, session identity, export/sharing context -- likely lower priority but real.)
2. Should questions about "what the agent actually did in this step" (step notes/output) be in a sixth category, or does it fit under outcome/result?
