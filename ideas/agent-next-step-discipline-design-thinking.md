# Design Thinking: Agent “Next Step” Speculation + Tool-Call Discipline (WorkRail v2)

## Context / Problem
Agents executing WorkRail workflows often do not know the next step (by design). This has two observable failure modes:

- **Narrative drift**: agents speculate about what comes next (e.g., “after this I’ll begin implementation”), even when the workflow’s actual next step is unrelated.
- **Protocol drift**: agents sometimes **skip calling** `workflow_next` (v1) / `continue_workflow` (v2) when they believe they already know what the next step will be.

Concrete v1 example (symptom):
- Tool returned `pendingStep=phase-5-plan-iteration-init` with prompt: “Set `continuePlanning = true` … max 3 iterations.”
- Agent then produced a long “Plan Artifact” and ended with “If you’re good with this plan artifact, I’ll start implementing Slice 1…”
  - The agent both **misrepresented what’s next** and **implicitly tried to advance outside the tool boundary**.

Why this matters:
- It breaks the “engine owns control flow” contract that makes WorkRail rewind-safe and deterministic.
- It trains users to expect behavior not aligned to the workflow (loss of trust, miscoordination).

## Persona
- **Operator (primary)**: runs workflows via a chat-based agent; expects the agent to stay aligned with workflow steps and to always re-fetch the next step.
- **Workflow author (secondary)**: wants workflows to be resilient to model variability without bespoke prompt babysitting.
- **System constraints**: chat rewinds; lossy agents; tool discovery bounded; WorkRail can’t read the transcript or push UI actions.

## POV + HMW
### POV
Operators need agents to reliably execute “one step at a time” and avoid promising or doing work beyond the current `pending` instruction, because the next step is intentionally unknown until WorkRail returns it.

### HMW
- How might we prevent agents from claiming they know the next step while keeping engine internals hidden?
- How might we increase the probability that the agent calls `workflow_next`/`continue_workflow` at the right boundaries (even when confident)?
- How might we make “don’t speculate, re-fetch” behavior feel natural and non-naggy?

## Success criteria
- **Reduced speculative narration**: fewer statements like “after this I’ll implement …” unless the workflow explicitly instructs it.
- **Higher tool-call compliance**: fewer cases where agents proceed without calling `workflow_next` when a new `pending` step should be fetched.
- **Preserved core principle**: no general next-step introspection that leaks branching logic or engine internals.
- **Low friction**: changes shouldn’t feel like constant nagging; ideally they’re embedded into existing workflow guidance patterns.

---

## Empathize (Phase 1)

## Persona card (primary)
- **Name**: “Rewind-aware operator”
- **Context**: Running WorkRail workflows through a chat agent where rewinds happen and are used as a control mechanism to correct drift quickly.
- **Goals**:
  - Keep the agent strictly aligned to the workflow’s *actual* next instruction.
  - Avoid doing expensive/irreversible work (e.g., implementation) before required review/gates.
  - Maintain high-signal progress in a way that survives rewinds.
- **Pains**:
  - The agent “sounds confident” and narrates a next step that is *not* the workflow’s next step.
  - It’s easy to miss subtle protocol drift until damage is done (starting implementation too early).
  - Catching it often requires an immediate rewind, losing chat context unless the system captures durable progress.
- **Constraints**:
  - WorkRail cannot read the transcript; the agent must fetch authoritative next steps via tools.
  - The system *intentionally* withholds full “what’s next” because control flow can branch; this is central to v2 correctness.
  - We only want to address this in v2 (no new v1 behavior changes beyond bug fixes).
- **Quotes/observations (from evidence we have)**:
  - “It’s very easy to miss… I’m happy I caught it… otherwise it would have started implementation before doing a critical review of the plan.”
  - “It caught many potential issues and gaps thanks to that step.” (re: the critical review gate)

## Journey map (lightweight)
- **Step** | **Pain** | **Opportunity**
- Run a workflow step | Agent produces a plausible “next” narrative that diverges from workflow | Add a strong, consistent “do not predict; fetch next step” discipline
- Finish a planning artifact | Agent suggests beginning implementation | Encode a *workflow-owned gate* that explicitly prohibits early implementation commitments
- Operator catches drift | Operator rewinds immediately | Make rehydrate and durable recaps smooth so rewinds don’t feel costly
- Continue workflow | Next step is a critical review / audit | Make the agent’s “what’s next” language reflect “unknown until fetched” rather than “implementation soon”

## Observations (5)
- **O1**: Agents sometimes narrate future actions (“after this I’ll implement…”) even when the current pending step is about planning/loop init.
- **O2**: The operator can catch and correct this behavior via immediate rewind, but it’s easy to miss.
- **O3**: The “critical review of the plan” step has real value (it found issues/gaps), so skipping/deferring it is high-risk.
- **O4**: The system design goal is that agents **must not know the next step** until WorkRail returns it (central to determinism/branching).
- **O5**: The operator explicitly wants this fixed in **v2 only** (no v1 behavior work beyond bug fixes).

## Insights (5)
- **I1 (from O1, O4)**: The agent is filling an information gap (next-step uncertainty) with a default conversational pattern (“preview the plan”), which conflicts with WorkRail’s intentional opacity.
- **I2 (from O2, O3)**: The cost of missing this issue is high because it can bypass valuable gates (plan review/audits) and start irreversible work prematurely.
- **I3 (from O2)**: Rewind is currently the operator’s safety valve, but rewinds are disruptive; v2 should reduce reliance on “human catches it in time.”
- **I4 (from O4)**: Any solution that “shows the next step” broadly risks undermining v2’s core correctness model; we need mechanisms that steer behavior without leaking internals.
- **I5 (from O5)**: The design should be framed as a v2 contract/engine capability (prompt shaping / response structure / invariants), not as workflow-specific prompt tweaks in v1.

## Evidence
- **Facts we have**:
  - Real-world incident where the agent indicated it would start implementation before a critical review step.
  - Operator explicitly rewound to prevent premature implementation.
  - Operator believes the critical review step prevented issues by catching gaps.
- **Evidence gaps**:
  - No captured snippet of the agent fully skipping a `workflow_next` call (rewind removed it).
  - Unknown frequency across models/IDEs and which phrasing patterns correlate with the drift.

## Constraints (environment/tooling/model)
- Chat rewinds/editing are common and delete context without warning.
- Agent behavior is variable and sometimes overconfident; it may “optimize for helpful narration.”
- Tool discovery is bounded; we can’t rely on a dynamic tutorial mid-chat.
- v2 must preserve token-based opacity and determinism; avoid “peek ahead” primitives that become de facto engine-state APIs.

## Observed pain themes (5–10)
- “Next step” speculation as a default conversational habit
- Overconfidence language (“I’ll begin implementation”) creating false expectations
- Gate-skipping risk (audits/reviews are valuable but easy to bypass accidentally)
- Rewind as manual safety net (effective but costly)
- Hard to detect missed tool calls in real time (no transcript introspection)
- Need for low-friction guardrails that don’t feel like nagging

## Unknowns (explicit list)
- How often does this happen per workflow type (planning-heavy vs linear)?
- Which phrasing is most predictive (“after this” / “next” / “I’ll start implementing”)?
- Are there other behaviors besides narration (e.g., the agent actually starts edits without advancing the workflow)?
- What is the minimal “behavior shaping” that works across weaker/stronger models?

## Interpretation risks (3)
- We may be over-generalizing from a single caught incident; the core issue might be rare, model-specific, or workflow-specific.
- The agent may already be calling `workflow_next` correctly most of the time; the primary harm may be *narration*, not *control flow*.
- Some “future intent” language may be benign in certain steps; we must avoid over-correcting and making the agent unhelpfully terse.

---

## Define (Phase 2)

## POV (Point of View)
- The rewind-aware operator needs the agent to **treat the next step as unknown until fetched** and to **always re-fetch the authoritative next instruction** (even when confident), because speculative narration and tool-call skipping can bypass critical gates and break the determinism/rewind-safety model.

## Problem statement (2–4 lines)
- In v2, the agent intentionally cannot know the next step until WorkRail returns it, but agents often fill this gap with “helpful” speculation and future-intent narration.
- That speculation can (a) mislead the user about what’s next and (b) reduce the likelihood the agent calls `continue_workflow` at the correct boundary, risking gate bypass and off-rails execution.

## Alternative framings (2)
- **If we’re wrong about the core problem**: This is not “next-step uncertainty” but a generic **overconfidence / verbosity** trait. Even with a perfect protocol, some agents will narrate future work; the right fix may be purely stylistic guidance and/or UI education.
- **Radically simpler interpretation**: The system lacks a clear, consistent **boundary marker** that says “stop; do not proceed; fetch next step.” If we provide a deterministic marker + a compact behavioral rule, the issue mostly disappears without any lookahead features.

## How might we… (3–7)
- How might we make “**don’t predict; fetch**” a default, low-friction behavior that is hard to forget?
- How might we reduce both **narrative drift** (false “what’s next” statements) and **protocol drift** (skipping `continue_workflow`) without revealing engine internals?
- How might we make step boundaries feel “complete” so agents don’t continue with speculative next actions by conversational habit?
- How might we ensure full-auto modes remain fast while still honoring “next step unknown until fetched”?
- How might we detect and correct this behavior in a rewind-safe way (i.e., without transcript dependence)?

## Success criteria (measurable where possible)
- Agents rarely state concrete future actions beyond the current step (e.g., “I’ll begin implementation next”) unless the current `pending` instruction explicitly includes it.
- Agents consistently treat step boundaries as “**call `continue_workflow` to proceed**,” including in full-auto modes.
- In workflows with critical gates (reviews/audits), those gates are not bypassed due to assumption-driven narration.
- Any new affordance remains compatible with v2 principles (opaque internals, deterministic replay, small MCP surface).

## Key tensions / tradeoffs
- **Preventing speculation vs feeling natural**: too strict can feel robotic; too loose regresses into drift.
- **Adding protocol fields vs preserving minimalism**: a structured “boundary marker” may help, but adding “next step previews” risks leaking branching logic.
- **Full-auto speed vs discipline**: full-auto should not become naggy, but also must not let the agent “run ahead” without fetching authoritative pending steps.

## Assumptions
- The narration drift and tool-call drift are related and can be addressed with a shared mechanism (boundary discipline).
- A deterministic, repeated instruction pattern can reshape agent behavior across models enough to be worth doing.
- We can address this without revealing the next step (no general lookahead).

## Riskiest assumption (pick one)
- A compact boundary discipline (instruction + minimal structured marker) will be sufficient across model variability; otherwise, we may need stronger enforcement mechanics that risk adding friction or surface area.

## What would change our mind?
- Evidence that agents almost never skip tool calls (protocol drift is negligible), and the harm is primarily superficial narration.
- Evidence that even with strong boundary markers and consistent guidance, agents still frequently promise future steps (suggesting model-level limitations).

## Out-of-scope
- General “peek next N steps” APIs or exposing branch/condition logic to the agent.
- v1 behavior changes beyond bug fixes.
- Solving all forms of agent overpromising outside workflow execution (keep scope to v2 workflow step boundaries).

### Proceeding to Ideation (readiness check)
- We have enough to proceed: we have a concrete incident, clear constraints, and a tight hypothesis that the fix is “boundary discipline without lookahead.”
- Evidence gap remains (no preserved skip-call snippet), but we can design prototypes that specifically test for that behavior.

## Idea Backlog (append-only)
<!-- Add DT-### entries here. Do not rewrite past entries; append only. -->

### Idea Backlog (Round 1)

Idea entry template (local, for this doc):
- **DT-### — Name (Category)**:
  - **What**: …
  - **Why it helps**: …
  - **How it fits v2**: …
  - **Tradeoffs / risks**: …
  - **Notes**: …

- **DT-001 — Deterministic “Boundary Footer” in `pending.prompt` (Prompt rendering / UX)**:
  - **What**: Append a deterministic footer to every rendered `pending.prompt`: “Do not describe or commit to work beyond this step. When done, call `continue_workflow` to fetch the next step.”
  - **Why it helps**: Reduces speculative “after this…” narration by providing a consistent script at the exact point agents read.
  - **How it fits v2**: No lookahead; purely a rendering rule (deterministic, replay-safe).
  - **Tradeoffs / risks**: Can feel repetitive; needs careful brevity.
  - **Notes**: Make it mode-aware: in full-auto, “Proceed by calling `continue_workflow` now” (still no promises).

- **DT-002 — Structured `pending.boundary` hint (Response schema)**:
  - **What**: Add a small structured field like `pending.boundary = { kind: "must_fetch_next" }` or `pending.nextAction = "call_continue_workflow"`.
  - **Why it helps**: Gives models a stable structured cue; avoids relying on prose-only guidance.
  - **How it fits v2**: Doesn’t reveal next step; only clarifies the boundary behavior (engine-owned, closed set).
  - **Tradeoffs / risks**: Adds surface area; needs closed-set semantics and tests.

- **DT-003 — “No future commitments” contract pack (Output contract / enforcement)**:
  - **What**: Introduce an optional contract pack that requires the agent to include a short `output.notesMarkdown` statement: “Completed `<stepId>`. Next: fetch next step via `continue_workflow`.” (validated format).
  - **Why it helps**: Creates a consistent end-of-step acknowledgement format and reduces “I’ll implement next” language.
  - **How it fits v2**: Contracts are already a v2 primitive; this uses enforcement rather than introspection.
  - **Tradeoffs / risks**: Slightly more friction; must be compatible with `full_auto_never_stop` (gap instead of block).

- **DT-004 — “Phase taxonomy” for steps (Authoring + prompt shaping)**:
  - **What**: Add an optional closed-set `phase` for steps (e.g., `planning | review | implementation | verification | meta`). Compiler injects a one-line “phase expectation” guideline.
  - **Why it helps**: Gives the agent a better default narrative anchor than guessing “implementation next.”
  - **How it fits v2**: Authoring-level metadata; doesn’t leak runtime decisions.
  - **Tradeoffs / risks**: Authors must label steps; wrong labels harm more than help.

- **DT-005 — “Gates as first-class steps” guidance (Workflow authoring practice)**:
  - **What**: Standardize a v2 builtin template for “gate/review step” that explicitly forbids downstream work until the gate is advanced.
  - **Why it helps**: Makes “critical review” steps harder to bypass by conversational habit.
  - **How it fits v2**: Template-injected discipline; deterministic and reusable.
  - **Tradeoffs / risks**: Still relies on compliance; may need pairing with other mechanisms.

- **DT-006 — Protocol-level “Stop reason” marker when `requireConfirmation=true` (Response shaping)**:
  - **What**: When `pending.requireConfirmation=true`, add a deterministic marker like `pending.confirmationPurpose: "gate"` and a “Stop here” header.
  - **Why it helps**: Makes it clear the current step is a boundary and prevents “continue narrating.”
  - **How it fits v2**: Doesn’t reveal next steps; clarifies that advancement is gated.
  - **Tradeoffs / risks**: Requires consistent use of `requireConfirmation` semantics in workflows.

- **DT-007 — “Advance intent” explicitness (Ack ergonomics)**:
  - **What**: Make `ackToken` semantics more explicit in the rendered prompt: “Only by providing `ackToken` do you advance.”
  - **Why it helps**: Reduces accidental “I can just keep going” behavior.
  - **How it fits v2**: Reinforces existing contract; no new API.
  - **Tradeoffs / risks**: Still prose-based unless combined with DT-002.

- **DT-008 — “Auto-continue” mode becomes “call-loop” (Full-auto ergonomics)**:
  - **What**: In full-auto modes, encourage an execution pattern of immediate tool calls rather than conversational narration between steps (“call `continue_workflow` again now to fetch next”).
  - **Why it helps**: Removes idle time where the agent fills gaps with speculative plans.
  - **How it fits v2**: Mode-specific guidance; no lookahead.
  - **Tradeoffs / risks**: Increases tool-call density; must stay within reasonable budgets.

- **DT-009 — Studio/Console “Step boundary education” panel (UX)**:
  - **What**: In Studio, show a short explanation: “Agents never know the next step; they must fetch it. Don’t trust ‘after this…’ statements.”
  - **Why it helps**: Aligns operator expectations and encourages quick correction.
  - **How it fits v2**: UI-only; doesn’t affect protocol correctness.
  - **Tradeoffs / risks**: Doesn’t fix behavior; mitigates impact.

- **DT-010 — “Promise budget” guidance injected into prompts (Prompt pattern)**:
  - **What**: Add a short invariant line: “Do not describe future steps beyond ‘I will fetch the next step’.”
  - **Why it helps**: Directly targets the harmful phrase pattern.
  - **How it fits v2**: Pure prompt content injection; deterministic.
  - **Tradeoffs / risks**: Could reduce helpful high-level summaries; must be phrased to still allow “today’s plan within this step.”

- **DT-011 — “Plan preview” allowed only as conditional language (Language constraint)**:
  - **What**: Allow only non-committal statements: “Next, I’ll fetch the next instruction; it may be X or Y depending on the workflow.”
  - **Why it helps**: Retains conversational helpfulness while avoiding false certainty.
  - **How it fits v2**: Doesn’t reveal internals; just constrains phrasing.
  - **Tradeoffs / risks**: Still adds extra words; could be annoying if overused.

- **DT-012 — Deterministic “Next call template” in responses (Self-correcting protocol)**:
  - **What**: Include a copy/paste JSON template snippet in `text` for the next tool call (using placeholders) whenever a step completes.
  - **Why it helps**: Makes the “correct next move” frictionless; reduces temptation to proceed without calling tools.
  - **How it fits v2**: Mirrors the v1 “copy-pasteable templates” success; deterministic response shaping.
  - **Tradeoffs / risks**: Tool-call templates can be noisy; must be compact and mode-aware.

- **DT-013 — “No-work-until-advance” sentinel for gates (Engine-meaningful concept, no transcript)**:
  - **What**: Represent gates as step kinds with a deterministic “must advance before any other work” instruction injected by engine.
  - **Why it helps**: Makes gate behavior consistent across workflows; reduces chance agents interpret gates as optional.
  - **How it fits v2**: Authoring-level metadata + compiler injection; no peek.
  - **Tradeoffs / risks**: Adds authoring concepts; must stay closed set.

- **DT-014 — “Step completion rubric” section (PromptBlocks)**:
  - **What**: Add/standardize a `promptBlocks.verify` or `promptBlocks.outputRequired` line that ends with: “Completion rubric: you are done when …; then fetch next step.”
  - **Why it helps**: Eliminates the ambiguous “now what?” gap that invites speculative narration.
  - **How it fits v2**: Aligns with PromptBlocks; deterministic compilation.
  - **Tradeoffs / risks**: Adds authoring burden unless injected via templates/features.

- **DT-015 — “Action boundary” as a first-class event in the run log (Auditability)**:
  - **What**: When producing a pending step, record a small durable marker that the next correct action is “advance via `continue_workflow` only.”
  - **Why it helps**: Supports Console explanations and debugging (“why did it go off rails?”) without transcript.
  - **How it fits v2**: Append-only truth; supports auditability.
  - **Tradeoffs / risks**: Might be redundant; avoid bloating event log.

- **DT-016 — “Agent role: protocol discipline” injected at workflow start (Role shaping)**:
  - **What**: At `start_workflow`, inject an agentRole snippet: “You do not know next steps; never promise them; always fetch.”
  - **Why it helps**: Sets global stance early.
  - **How it fits v2**: Uses existing agentRole mechanism; deterministic injection.
  - **Tradeoffs / risks**: Global instructions can be ignored; needs reinforcement per step.

- **DT-017 — “Step boundary lint” in workflow authoring (Static analysis)**:
  - **What**: Validate workflows for missing explicit gate/verify sections and recommend templates/features (e.g., if a workflow has “implementation” steps, ensure a “review gate” step precedes).
  - **Why it helps**: Prevents authoring patterns that invite premature implementation.
  - **How it fits v2**: Studio validation + suggestions; no runtime introspection.
  - **Tradeoffs / risks**: Heuristics can be noisy; must be careful about false positives.

- **DT-018 — “Non-authoritative next-step hint” only when provably static (Selective affordance)**:
  - **What**: When the engine can prove the next step is unconditional (no branching between current and next), return `pending.upcoming = { kind: "static", stepId, title }`; otherwise omit.
  - **Why it helps**: Reduces the information gap in safe cases, preventing speculation.
  - **How it fits v2**: Avoids leaking branching; only reveals when there is no branching possibility.
  - **Tradeoffs / risks**: “Slippery slope” toward lookahead; must be explicitly limited and tested.

- **DT-019 — “Block on missing advance” isn’t possible; simulate via workflow structure (Design stance)**:
  - **What**: Accept that we cannot enforce “agent must call tools” directly; instead, design the protocol to minimize between-step narration (DT-008/DT-012) and to strongly mark boundaries (DT-001/DT-002).
  - **Why it helps**: Keeps us honest about constraints.
  - **How it fits v2**: Aligns with MCP reality (no transcript, no push).
  - **Tradeoffs / risks**: Residual failures remain; must be mitigated via UX and strong defaults.

- **DT-020 — “Completion marker” required on ack (Contract pack)**:
  - **What**: Require a small structured artifact on every advance: `{ kind: "wr.step_completed", stepId, summary }`.
  - **Why it helps**: Forces the agent to explicitly anchor its output to the step it just completed and discourages drift into future-step narration.
  - **How it fits v2**: Uses contract packs; enforcement is mode-aware (block vs gap).
  - **Tradeoffs / risks**: Adds overhead to every step; must stay extremely lightweight.

### Idea Backlog (Round 2)

- **DT-021 — “Compiler as conductor” analogy: emit a single “NEXT = CALL_CONTINUE” instruction token (Compiler / Rendering)**:
  - **What**: Treat the engine like a compiler emitting an explicit “next instruction pointer” token in both text + a structured field; the only valid next action is the tool call.
  - **Why it helps**: Reframes “what’s next?” as an explicit opcode; reduces conversational improvisation.
  - **How it fits v2**: Still no step peek—just a deterministic “instruction pointer” shape.
  - **Tradeoffs / risks**: Adds protocol semantics; must stay minimal.

- **DT-022 — Aviation checklist analogy: mandatory “Before advancing” checklist line (Prompt discipline)**:
  - **What**: Add a one-line checklist before any future intent: “Before advancing: 1) ensure this step’s rubric satisfied 2) call `continue_workflow` 3) follow returned prompt.”
  - **Why it helps**: Turns boundary crossing into a ritualized checklist; reduces “I’ll now implement…”
  - **How it fits v2**: Pure deterministic text injection.
  - **Tradeoffs / risks**: Repetition; keep to ≤1–2 lines.

- **DT-023 — Game design “turn-based” framing: explicitly label steps as turns (UX wording)**:
  - **What**: In response text, label each pending instruction as “Turn N”; end with “End Turn → call `continue_workflow`.”
  - **Why it helps**: Many models naturally respect turn-taking metaphors; reduces “skip ahead.”
  - **How it fits v2**: No lookahead; just reframes step boundaries.
  - **Tradeoffs / risks**: Style preference; might feel cute if overdone.

- **DT-024 — Finance “two-man rule” for gates: require confirmation on review gates by default (Authoring + Defaults)**:
  - **What**: Provide a builtin “gate step” template that always sets `requireConfirmation=true` and includes a hard “no downstream work” clause.
  - **Why it helps**: Makes review steps explicitly frictionful to bypass.
  - **How it fits v2**: Existing `requireConfirmation` + templates; deterministic.
  - **Tradeoffs / risks**: Adds friction; must be used only for truly critical gates.

- **DT-025 — “Latched intent” model: the engine declares the allowed action set (Response schema)**:
  - **What**: Add `allowedActions: ["ack_and_continue"] | ["rehydrate_only"] | ...` as a closed set in responses.
  - **Why it helps**: Models respond well to explicit affordances; reduces improvisation.
  - **How it fits v2**: Closed set, engine-owned; no step peek.
  - **Tradeoffs / risks**: Increases schema surface; must stay tiny.

- **DT-026 — Constraint inversion (assume no state): “Stateless agent contract” enforcement via minimal outputs (Policy)**:
  - **What**: Assume the agent has zero memory between tool calls; require outputs to be strictly scoped to “what I did in this step” and “fetch next.”
  - **Why it helps**: Eliminates narrative planning between steps as an anti-pattern.
  - **How it fits v2**: Matches rewind reality; encourages rehydrate/recap reliance.
  - **Tradeoffs / risks**: Less conversational continuity; relies on durable recaps.

- **DT-027 — Constraint inversion (assume no JSON): “Text-only discipline” marker (Renderer)**:
  - **What**: In the `text` response, include a deterministic “NEXT INPUT” block that is purely natural language but unambiguous: “Call `continue_workflow` now.”
  - **Why it helps**: Works even when structured fields are ignored; combats model variability.
  - **How it fits v2**: v2 is text-first; this is aligned.
  - **Tradeoffs / risks**: Prose-only is weaker; pair with a structured cue when available.

- **DT-028 — Constraint inversion (assume only files): “Sticky boundary banner” as a pinned snippet (Refs)**:
  - **What**: Use `wr.refs.boundary_discipline` injected into every promptBlocks template as a canonical snippet.
  - **Why it helps**: Guarantees consistency across workflows and reduces author drift.
  - **How it fits v2**: Prompt refs are compile-time, hashed, deterministic.
  - **Tradeoffs / risks**: Must be short; too long becomes prompt bloat.

- **DT-029 — Constraint inversion (assume only events): “Between-step narration discouraged by event-driven cadence” (Execution cadence)**:
  - **What**: Encourage a pattern where the agent calls `continue_workflow` immediately after producing required output; treat extra narration as optional and secondary.
  - **Why it helps**: Less time for speculative talk; more “fetch next” momentum.
  - **How it fits v2**: Full-auto naturally supports chaining; guided can still do it post-confirmation.
  - **Tradeoffs / risks**: Tool-call density; needs budgeting.

- **DT-030 — “Socratic uncertainty” phrase constraint (Language policy)**:
  - **What**: Explicitly ban phrases like “after this I will…” unless followed by “after fetching the next step…”.
  - **Why it helps**: Targets the harmful pattern directly.
  - **How it fits v2**: Fits the goal of preventing assumed next steps.
  - **Tradeoffs / risks**: Enforcement is hard; best as guidance + lint, not runtime policing.

- **DT-031 — “Plan within the step only” rubric (PromptBlocks)**:
  - **What**: Add a rule: planning language must be scoped to actions inside the current step; anything beyond must be “pending next fetch.”
  - **Why it helps**: Lets agents still be helpful without promising the next step.
  - **How it fits v2**: Aligns with per-step determinism.
  - **Tradeoffs / risks**: Subtle; needs crisp phrasing.

- **DT-032 — “Tool-call guardrail” as a test harness rule (Determinism suite)**:
  - **What**: Add a v2 determinism test: if the agent tries to proceed without `continue_workflow`, it’s not detectable at runtime—but we can at least ensure the prompts strongly instruct it and that examples always show the tool call.
  - **Why it helps**: Forces us to keep the boundary discipline present and stable.
  - **How it fits v2**: Treats behavior shaping as part of contract quality.
  - **Tradeoffs / risks**: Tests text, not behavior; still valuable as drift prevention.

- **DT-033 — “One-line recap only, then fetch” default (Response formatting)**:
  - **What**: In full-auto defaults, prefer: (a) 1-line recap for the step, (b) immediate `continue_workflow` call, (c) richer summary only at checkpoints.
  - **Why it helps**: Reduces chatter between steps, which is where assumptions creep in.
  - **How it fits v2**: Complements checkpointing as durable memory.
  - **Tradeoffs / risks**: Users may want richer narrative; compensate with periodic checkpoints.

- **DT-034 — “Gate-first preset” recommendation (Mode guidance)**:
  - **What**: Workflows can recommend a mode/preset emphasizing gate compliance (“stop on gates / confirmations”) when critical review steps exist.
  - **Why it helps**: Protects against early implementation by making review gates explicit stops.
  - **How it fits v2**: Mode recommendations already exist; no hard blocks.
  - **Tradeoffs / risks**: Still relies on user selecting/accepting recommended mode.

- **DT-035 — “Explicitly unknown next step” is a first-class UI label (Studio)**:
  - **What**: Show “Next step is unknown until fetched” near the pending step in Console, plus a warning badge if the agent claims otherwise (manual user interpretation).
  - **Why it helps**: Aligns expectations and encourages operator skepticism of “after this…”
  - **How it fits v2**: UI-only; respects constraints.
  - **Tradeoffs / risks**: Doesn’t change agent behavior.

- **DT-036 — “RequireConfirmation means ‘stop talking’” convention (Renderer)**:
  - **What**: When `requireConfirmation=true`, render a minimal prompt that ends with a hard stop and no “what’s next” encouragement.
  - **Why it helps**: Prevents the agent from filling the pause with speculative narration.
  - **How it fits v2**: Deterministic rendering; no new surface.
  - **Tradeoffs / risks**: Might reduce helpfulness if confirmation steps need context.

- **DT-037 — “Checkpoint replaces forward promises” norm (Workflow guidance)**:
  - **What**: If the agent wants to convey “what I’ll do next,” instruct it to write a durable checkpoint summary of the current state instead, and then fetch next step.
  - **Why it helps**: Converts risky future intent into durable present-state memory.
  - **How it fits v2**: Aligns with checkpointing rationale.
  - **Tradeoffs / risks**: Requires checkpoint tool unflagging; or only applies when enabled.

- **DT-038 — “Non-work simulation” anti-pattern warning (Prompt)**:
  - **What**: Add a warning line: “Do not simulate future steps; do not start work not requested in this step.”
  - **Why it helps**: Directly addresses the skip-ahead temptation.
  - **How it fits v2**: Strongly aligned to engine-owned control flow.
  - **Tradeoffs / risks**: Strong language; keep it short.

- **DT-039 — “Protocol witness for humans” (Explainability)**:
  - **What**: Include a tiny “Protocol status” line in text: “Pending: <stepId>. Next: call `continue_workflow` (no other step is known).”
  - **Why it helps**: Reinforces correctness for both agent and operator.
  - **How it fits v2**: Text-first, deterministic.
  - **Tradeoffs / risks**: Repetition; keep very compact.

- **DT-040 — “Absolutely no lookahead” as a hard stance (Policy)**:
  - **What**: Explicitly reject any `pending.upcoming`/preview fields (including provably-static) to avoid slippery slope and to preserve the “one step at a time” discipline.
  - **Why it helps**: Keeps the boundary crisp: the only way to know what’s next is to call `continue_workflow`.
  - **How it fits v2**: Maximally aligned with the purpose you stated.
  - **Tradeoffs / risks**: Leaves some uncertainty gap; must compensate with boundary discipline and cadence.

### Derived ideas (Round 3)

- **DT-041 — “Boundary Discipline” as a v2 builtin feature pack (Feature / default-on candidate)**:
  - **What**: A single feature (e.g., `wr.features.boundary_discipline`) that injects: boundary footer (DT-001), phrase constraints (DT-010/DT-030), and next-call template (DT-012).
  - **Why it helps**: Centralizes the behavior; prevents per-workflow drift; makes it “just happen.”
  - **How it fits v2**: Features are WorkRail-owned, deterministic middleware; perfect for cross-cutting behavioral shaping.
  - **Tradeoffs / risks**: Needs careful default posture (on by default vs recommended).

- **DT-042 — Pair structured + text cues as one primitive (DT-001 + DT-002)**:
  - **What**: Treat “boundary discipline” as requiring both a minimal structured cue (`allowedActions`) and a short deterministic text footer.
  - **Why it helps**: Resilient across model variability; either channel may be ignored, but rarely both.
  - **How it fits v2**: Keeps opacity; adds a closed-set field rather than arbitrary metadata.
  - **Tradeoffs / risks**: Slight schema growth; must stay tiny and stable.

- **DT-043 — “AllowedActions” generalizes confirmation + rehydrate (DT-025 + DT-036)**:
  - **What**: Make `allowedActions` cover key boundary cases: `rehydrate_only`, `ack_required`, `call_continue_to_fetch`, `stop_for_confirmation`.
  - **Why it helps**: One uniform, closed-set affordance models understand, instead of scattered prose flags.
  - **How it fits v2**: A closed-set affordance fits the “correctness-by-construction” philosophy.
  - **Tradeoffs / risks**: Must be designed carefully to avoid becoming an engine-state API.

- **DT-044 — “Gate step kit” = template + defaults + renderer styling (DT-024 + DT-006)**:
  - **What**: Provide a builtin gate template that:
    - sets `requireConfirmation=true`
    - includes a “no downstream work” clause
    - triggers a minimal “STOP HERE” renderer style
  - **Why it helps**: Protects high-value review steps specifically (where harm is biggest).
  - **How it fits v2**: Uses existing step metadata; deterministic rendering; no lookahead.
  - **Tradeoffs / risks**: Requires authors to opt into the template (or compiler heuristics, which we should avoid).

- **DT-045 — “Turn-based” presentation mode as optional renderer (DT-023)**:
  - **What**: Add an internal renderer option (not MCP-exposed) that labels steps as turns and ends prompts with “End turn → call continue.”
  - **Why it helps**: Strong behavioral metaphor that discourages skipping.
  - **How it fits v2**: Renderer versioning is already contemplated as internal-only.
  - **Tradeoffs / risks**: Style taste; might be polarizing.

- **DT-046 — “Between-step silence” default in full-auto (DT-033 + DT-029)**:
  - **What**: In full-auto modes, the recommended pattern is:
    - produce minimal required output
    - immediately call `continue_workflow`
    - do richer narration only via periodic checkpoints
  - **Why it helps**: Removes the gap where the agent invents “what’s next.”
  - **How it fits v2**: Aligns with checkpointing and “durable outputs.”
  - **Tradeoffs / risks**: Increases tool call frequency; must be budgeted.

- **DT-047 — “Static lookahead” as a strictly limited affordance (DT-018, but guarded)**:
  - **What**: Permit a `pending.upcoming` only when the engine can prove there is no branching possibility between now and next (e.g., linear immediate successor).
  - **Why it helps**: Eliminates uncertainty in safe cases, reducing speculation pressure.
  - **How it fits v2**: Still engine-owned; still deterministic; still avoids branching leaks.
  - **Tradeoffs / risks**: Slippery slope; must be explicitly limited and used rarely.

- **DT-048 — “No future commitments” as a lint + suggested edit (DT-017 + DT-030)**:
  - **What**: Studio validation suggests enabling `boundary_discipline` and using gate templates when it detects gate-shaped steps.
  - **Why it helps**: Prevents drift at authoring time; nudges towards best practice.
  - **How it fits v2**: Studio is explicitly about discoverability + validation suggestions.
  - **Tradeoffs / risks**: Heuristics can be noisy; keep as suggestion, not block.

- **DT-049 — Normalize “what’s next” into present tense (Language constraint)**:
  - **What**: Guidance: replace “After this I’ll do X” with “Once this step is complete, I’ll fetch the next instruction.”
  - **Why it helps**: Preserves helpfulness while removing false certainty.
  - **How it fits v2**: Behavioral shaping; no new protocol.
  - **Tradeoffs / risks**: Easy to ignore; best paired with DT-041/DT-042.

- **DT-050 — “Step boundary as a closed-set narrative slot” (PromptBlocks)**:
  - **What**: Standardize a `promptBlocks.outputRequired.next` slot that always renders as “Next: fetch next instruction via continue_workflow” (no other content allowed).
  - **Why it helps**: Gives the agent a consistent place to put “what’s next” without inventing.
  - **How it fits v2**: PromptBlocks are deterministic; features can inject the block.
  - **Tradeoffs / risks**: Adds structure; but still optional / injected.

- **DT-051 — “Critical gate detected” → structured warning when mode too aggressive (mode safety)**:
  - **What**: If a workflow declares gates, WorkRail recommends safer presets and emits warnings if user selects aggressive mode.
  - **Why it helps**: Reduces chance the agent runs ahead in full-auto without appropriate stops.
  - **How it fits v2**: “Never hard-block a user-selected mode” but warn loudly is a v2 lock.
  - **Tradeoffs / risks**: Only advisory; still needs boundary discipline.

- **DT-052 — “Protocol status line” as a single terse invariant (DT-039 distilled)**:
  - **What**: Always include a 1-line invariant: `Pending=<stepId>. NextAction=CALL_CONTINUE (unknown until fetched).`
  - **Why it helps**: Compact, repeatable, low-nag reinforcement.
  - **How it fits v2**: Text-first; deterministic; no step peek.
  - **Tradeoffs / risks**: Repetition; but minimal.

- **DT-053 — “Acknowledgement rubric” ensures step-anchoring (DT-020 but lighter)**:
  - **What**: Instead of requiring an artifact every time, require a fixed prefix line in notes: “Completed: <stepId>” (validated only when a workflow opts in).
  - **Why it helps**: Anchors the agent output to the actual step and reduces drift into future.
  - **How it fits v2**: Contract packs can validate lightweight formats.
  - **Tradeoffs / risks**: Still overhead; ensure optional.

- **DT-054 — “Stop speaking at boundaries” as a renderer policy for confirm steps (DT-036 generalized)**:
  - **What**: When `requireConfirmation=true`, the renderer produces minimal text, ending with a hard boundary and no “future intent” space.
  - **Why it helps**: Eliminates the idle narrative gap where speculation shows up.
  - **How it fits v2**: Deterministic renderer; respects existing step flags.
  - **Tradeoffs / risks**: Must ensure the step still includes enough context to be actionable.

- **DT-055 — Synthesis stance: default v2 choice = “Boundary Discipline Package” (Recommendation framing)**:
  - **What**: Recommend a default package combining DT-041 + DT-042 + DT-046 + DT-044, with DT-047 as a guarded optional add-on.
  - **Why it helps**: Tackles both narration and skip-ahead with minimal new surface area.
  - **How it fits v2**: Strongly aligns with opacity and determinism; uses features/templates/renderer rather than introspection.
  - **Tradeoffs / risks**: Needs careful copy/wording to avoid feeling naggy.
## Clusters
### Phase 4: Synthesize (Clusters + Candidate directions + Shortlist)

## Clusters (7)
- **Theme name: Boundary cues (text + structured)**  
  - **Why these ideas belong together (1 line)**: Make “don’t predict; fetch next” the path of least resistance via deterministic rendering plus a tiny closed-set affordance.  
  - **Member idea IDs**: DT-001, DT-002, DT-007, DT-010, DT-012, DT-016, DT-021, DT-025, DT-042, DT-043, DT-049, DT-052, DT-063, DT-065  
  - **What it enables**: Agents stop inventing “what’s next” and instead treat the next action as “call `continue_workflow`.”  
  - **Biggest risk/unknown**: Any added schema field must remain tiny and not become a de facto engine-state API.

- **Theme name: Gate hardening (review steps are sacred)**  
  - **Why these ideas belong together (1 line)**: Prevent bypassing high-value gates by making them explicit stops with consistent styling and semantics.  
  - **Member idea IDs**: DT-006, DT-024, DT-034, DT-044, DT-051, DT-054, DT-058  
  - **What it enables**: Review/audit steps become harder to “talk past,” reducing premature implementation risk.  
  - **Biggest risk/unknown**: Added friction in workflows that overuse gates.

- **Theme name: Cadence + checkpointing (reduce between-step chatter)**  
  - **Why these ideas belong together (1 line)**: Remove the idle space where speculation happens by chaining tool calls and moving richer narration into checkpoints.  
  - **Member idea IDs**: DT-029, DT-033, DT-037, DT-046  
  - **What it enables**: Full-auto feels fast while staying step-accurate; fewer “after this…” opportunities.  
  - **Biggest risk/unknown**: Tool-call density and budgets; needs disciplined truncation and checkpoint cadence.

- **Theme name: Authoring-time scope & structure**  
  - **Why these ideas belong together (1 line)**: Give workflows a way to constrain allowable work and provide consistent “what done looks like” rubrics without runtime peeking.  
  - **Member idea IDs**: DT-004, DT-014, DT-028, DT-031, DT-050, DT-056  
  - **What it enables**: Steps can say “this is a review step, do not write code,” which directly addresses premature implementation.  
  - **Biggest risk/unknown**: Authoring burden and mislabeling; needs good defaults and lint/suggestions.

- **Theme name: Auditability & operator awareness**  
  - **Why these ideas belong together (1 line)**: Make skip-ahead visible and explainable without relying on transcript access.  
  - **Member idea IDs**: DT-009, DT-015, DT-035, DT-057, DT-059  
  - **What it enables**: Console can surface “agent went off-script” and why, helping trust and debugging.  
  - **Biggest risk/unknown**: Visibility without enforcement may not reduce frequency; treat as secondary mitigation.

- **Theme name: Anti-drift + budgets**  
  - **Why these ideas belong together (1 line)**: Ensure the boundary discipline does not silently disappear or balloon over time.  
  - **Member idea IDs**: DT-032, DT-060, DT-061, DT-062, DT-064  
  - **What it enables**: Deterministic regression checks for the discipline, with strict prompt-budget hygiene.  
  - **Biggest risk/unknown**: Snapshot tests can be brittle; keep the surface very small.

- **Theme name: Lookahead policy (guardrails)**  
  - **Why these ideas belong together (1 line)**: Decide whether any limited lookahead is allowed, and if so, keep it tightly constrained.  
  - **Member idea IDs**: DT-018, DT-047, DT-040  
  - **What it enables**: A controlled escape hatch if boundary cues aren’t sufficient.  
  - **Biggest risk/unknown**: Slippery slope toward peeking; must remain optional and rare.

## Candidate directions (5)
- **Direction 1 — Boundary Discipline Primitive (recommended #1)**  
  - **North Star (1–2 sentences)**: Make “next step unknown until fetched” explicit in both text and a tiny closed-set field, so the agent’s default is to call `continue_workflow` rather than speculate.  
  - **Summary**: Highest leverage, smallest conceptual surface; directly addresses both narration drift and skip-ahead behavior with minimal new primitives.  
  - **Scoring (1–5)**:
    - **Impact**: 5 — targets the root failure mode across workflows.
    - **Confidence**: 4 — robust to model variability when both text + structured cues exist.
    - **Migration cost**: 2 — mostly engine-side; workflows can opt into richer behavior later.
    - **Model-robustness**: 5 — redundancy (text + structure) is resilient.
    - **Time-to-value**: 4 — implementable early in v2 protocol work.

- **Direction 2 — Gate Hardening Kit (recommended #2)**  
  - **North Star (1–2 sentences)**: Make review/audit gates first-class and unskippable “stops,” with consistent renderer formatting and mode recommendations.  
  - **Summary**: Addresses the highest-risk consequence (premature implementation) by strengthening the semantics of gates.  
  - **Scoring (1–5)**:
    - **Impact**: 4
    - **Confidence**: 4
    - **Migration cost**: 3 — requires authors to use gate templates/metadata.
    - **Model-robustness**: 4
    - **Time-to-value**: 3

- **Direction 3 — Full-auto Cadence + Checkpointing (recommended add-on)**  
  - **North Star (1–2 sentences)**: Reduce between-step narration by defaulting full-auto to immediate tool-call chaining, and shift richer “what happened” into checkpoints.  
  - **Summary**: Tackles the *mechanism* by which speculation arises (idle narration time) rather than relying purely on admonitions.  
  - **Scoring (1–5)**:
    - **Impact**: 3
    - **Confidence**: 3 — depends on good budgets and checkpoint ergonomics.
    - **Migration cost**: 2
    - **Model-robustness**: 4
    - **Time-to-value**: 3

- **Direction 4 — Authoring “Work Scope” Metadata (optional)**  
  - **North Star (1–2 sentences)**: Let authors say “this step is review-only / write-code,” and have the renderer inject “do not do work outside this scope.”  
  - **Summary**: Directly prevents “started implementation early” for workflows that opt in.  
  - **Scoring (1–5)**:
    - **Impact**: 3
    - **Confidence**: 3 — depends on correct labeling.
    - **Migration cost**: 3
    - **Model-robustness**: 4
    - **Time-to-value**: 3

- **Direction 5 — Guarded Static Lookahead (escape hatch only)**  
  - **North Star (1–2 sentences)**: Only when provably safe, show the immediate next step ID/title to reduce the agent’s speculation pressure.  
  - **Summary**: Can reduce uncertainty in a subset of cases, but carries a slippery-slope risk; keep off by default.  
  - **Scoring (1–5)**:
    - **Impact**: 2
    - **Confidence**: 2
    - **Migration cost**: 3
    - **Model-robustness**: 2
    - **Time-to-value**: 2

## Shortlist (3)
- **Shortlist A**: Direction 1 (Boundary Discipline Primitive)
- **Shortlist B**: Direction 2 (Gate Hardening Kit)
- **Shortlist C**: Direction 3 (Full-auto Cadence + Checkpointing)

Reflection prompts (brief):
- **What would falsify the top direction?** If agents still frequently promise future actions or skip tool calls even when every prompt ends with a deterministic “NextAction=CALL_CONTINUE (unknown until fetched)” and a structured `allowedActions` cue.
- **Most dangerous second-order effect**: making prompts too repetitive/bloated, reducing overall model performance and causing “instruction fatigue.”

Adversarial challenge (brief):
- **Why Direction 1 might be wrong**: It’s still “guidance,” not enforcement; if the model ignores it, nothing stops skip-ahead.
- **Strongest alternative and why it might win**: Direction 4 (Work Scope metadata) could win for high-risk workflows because it names “don’t implement” directly and ties it to step intent.

Decision Gate (needs your confirmation):
- Proceed with **Direction 1 + Direction 2 + Direction 3** as the primary v2 design, keeping Direction 5 as a guarded escape hatch.

## Decision Log (append-only)
### 2025-12-23 — Adopt “Boundary Discipline Primitive” as v2 default direction
- **Decision**: Proceed with **Direction 1 + Direction 2 + Direction 3** as the primary v2 design for the “agent assumes next step” problem.
- **Why**: This addresses both narration drift and skip-ahead risk without violating v2’s opacity principle (no general step peek). It matches MCP reality: lossy agents require redundant cues, and the engine cannot inspect transcript behavior.
- **Anchors**: Direction 1–3, Packages A–C, DT-001/DT-012/DT-042/DT-044/DT-046.

### 2025-12-23 — Prefer `nextIntent` (scalar) over `allowedActions` (list)
- **Decision**: Use a single closed-set **`nextIntent`** as the structured boundary cue, paired with a deterministic 1–2 line boundary footer in `pending.prompt`.
- **Why**:
  - Scalar intent is harder for models to misinterpret and easier to keep tiny/closed.
  - Lists can invite improvisation (“optional” thinking) and drift into a dumping ground.
  - Both channels are required (some models ignore structure; others ignore prose).
- **Anchors**: DT-042/DT-043/DT-052/DT-063/DT-061.

## Prototype Spec
### Phase 4A: Synthesis Quality Gate

Checklist:
- ✅ POV statement is present
- ✅ 3–7 HMW questions are present
- ✅ Success criteria are present (measurable where possible)
- ✅ Key tensions/tradeoffs are present
- ✅ Idea Backlog has meaningful breadth (protocol/UX/authoring/observability/reliability/tooling/packaging at least once each, where applicable)
- ✅ Shortlist (2–3) exists with risks and migration cost noted
- ✅ The top direction has at least one falsifiable learning question

Result: **PASS**

### Phase 4B: Pre-mortem & Falsification

## Pre-mortem (top 5)
- **Failure mode**: Boundary cues become verbose and are ignored (“instruction fatigue”)  
  - **Why it happens**: Footer grows over time; multiple contributors add “one more line.”  
  - **Mitigation**: Hard byte budget + golden renderer tests + single owning feature (`wr.features.boundary_discipline`).
- **Failure mode**: Structured cue drifts into an engine-state API  
  - **Why it happens**: “Just add another enum value” for each edge case.  
  - **Mitigation**: Strict closed set + explicit versioning; require design review for any new enum value.
- **Failure mode**: Gate steps aren’t authored consistently → premature implementation risk remains  
  - **Why it happens**: Authors skip templates/metadata; “it’s obvious” assumptions.  
  - **Mitigation**: Provide a gate template + Studio suggestions; make “gate hardening” easy and discoverable.
- **Failure mode**: Full-auto cadence increases tool-call volume and harms budgets/usability  
  - **Why it happens**: Auto-chaining increases calls; recaps inflate.  
  - **Mitigation**: One-line between-step recaps + periodic checkpoints + deterministic truncation budgets.
- **Failure mode**: Works for strong models but not weaker models  
  - **Why it happens**: Weaker models ignore the footer or misread structure.  
  - **Mitigation**: Redundant cues (text + `nextIntent`), minimalism, and explicit next-call templates.

## Falsification criteria (1–3)
- If, during dogfood, “premature next-step commitment” remains >20% of step completions **despite** `nextIntent` + boundary footer, we will iterate on the cue design (shorter, more explicit) or consider guarded static lookahead (escape hatch) for provably-linear steps.
- If we observe any gate bypass in critical-gate workflows, we will strengthen gate semantics (template + STOP styling + mode recommendations) before shipping broadly.
- If boundary guidance materially harms prompt budgets (or correlates with worse compliance), we will reduce footer verbosity and rely more on structured `nextIntent`.

### Phase 5: Prototype (Learning Artifact)

## Goal
Prove that a **tiny structured boundary cue** plus a **deterministic prompt footer** reduces:
1) speculative “what’s next” narration, and
2) skip-ahead behavior (failing to fetch the next step).

## Non-goals
- Not implementing v2 execution end-to-end; this is a contract/renderer prototype.
- Not implementing broad “peek next steps.”

## Prototype learning question
Does adding `nextIntent` + a 1–2 line boundary footer cause agents (across models) to:
- avoid promising specific next work, and
- consistently call `continue_workflow` to fetch the next instruction?

## Prototype artifact (API sketch)

### Proposed response shape (illustrative)
When there is a pending step:
- `nextIntent = "perform_pending_then_continue"` (closed set)
- `pending.prompt` ends with a deterministic boundary footer

Example:

```json
{
  "stateToken": "st.v1.…",
  "ackToken": "ack.v1.…",
  "checkpointToken": "chk.v1.…",
  "pending": {
    "stepId": "phase-5-plan-iteration-init",
    "title": "Phase 5: Plan Iteration Init",
    "prompt": "Initialize a bounded plan-iteration loop.\n\nSet: continuePlanning = true.\nRule: max 3 iterations.\n\nProtocol: Pending=phase-5-plan-iteration-init. NextAction=CALL_CONTINUE (unknown until fetched).\nBoundary: Do not commit to future work. When done, call continue_workflow to fetch the next instruction."
  },
  "nextIntent": "perform_pending_then_continue",
  "isComplete": false
}
```

For confirmation gates:
- `nextIntent = "await_user_confirmation"`
- renderer ends with a hard stop: “STOP: Await confirmation → then call continue_workflow.”

### Proposed closed set (initial)
- `perform_pending_then_continue`
- `await_user_confirmation`
- `rehydrate_only`
- `complete`

## Invariants
- `nextIntent` never reveals next step content; it only describes the correct next action.
- Footer is deterministic and byte-budgeted; it never becomes a prose blob.
- Full-auto cadence encourages immediate `continue_workflow` chaining; rich narration moves to checkpoints.

## Migration strategy
- Add `nextIntent` as additive to v2 response schema; keep existing fields (`requireConfirmation`, etc.) initially.
- Consider later consolidation where appropriate (DT-065) to reduce redundant flags.

## Pre-mortem (how this fails)
If models ignore both channels, we’ll need stronger authoring patterns (gate templates, work scope rubrics) and potentially a guarded static lookahead escape hatch for provably-linear steps.

## Test plan
See “Phase 6: Test Plan” below.

## Test Plan
### Phase 6: Test Plan (Dogfood + Validation)

## Scenarios to run
- **S1 — Planning workflow with a critical review gate**: verify the agent avoids promising implementation before the review gate is advanced.
- **S2 — Full-auto cadence**: run 10+ consecutive steps in full-auto; verify tool-call chaining and minimal between-step narration.
- **S3 — Rehydrate**: simulate rewind/long chat; rehydrate and confirm the agent resumes without inventing what’s next.

## Agents/models/IDEs to test
- One strong model (e.g., Claude)
- One weaker model (e.g., a smaller GPT/Gemini/Grok config)
- At least two different agentic IDE environments when possible

## Pass/fail metrics
- **P1 (behavior)**: ≤5% of step completions contain concrete promises about a specific next step (human-coded).
- **P2 (protocol)**: ≥95% of step boundaries result in a `continue_workflow` call to fetch the next pending step (tool-call log).
- **P3 (gates)**: 0 gate bypass incidents in the tested scenarios.
- **P4 (budget)**: boundary footer adds ≤200 bytes to `pending.prompt` (initial target; tune with evidence).

## Instrumentation needed
- Tool-call logs per run (`start_workflow`/`continue_workflow`, rehydrate vs ack).
- Marker for gate steps (template/metadata) so runs can be segmented.
- Manual coding sheet for P1 (WorkRail cannot access transcript).

## Rollback/contingency
- If footer harms model performance, shorten it further and rely more on `nextIntent`.
- If `nextIntent` value set starts to sprawl, freeze it and add guidance elsewhere; do not expand into a “policy bag.”

## Iteration Notes
### Phase 7: Iterate (Test → Learn → Refine)

#### Iteration 1: Test & Capture Feedback (thought experiment + adversarial critique)
## What we tried
- Simulated a workflow run where the default assistant habit is to narrate future plans.
- Applied the prototype: `nextIntent` + boundary footer + STOP styling for confirmation gates.

## What worked
- The agent has a safe, consistent phrase to use (“I’ll fetch the next instruction”), reducing speculation pressure.
- Scalar `nextIntent` provides a single “correct next move” anchor.

## What failed
- Risk: repetition becomes background noise; requires strict budgeting and stable formatting.

## Confusions / friction
- Potential overlap between `requireConfirmation` and `nextIntent` semantics (needs clear mapping).

## New insights
- The key is not lookahead; it’s removing the conversational vacuum between steps.

## Updated assumptions (confirmed/invalidated)
- Confirmed: narration drift and skip-ahead are coupled and can be addressed by one boundary discipline primitive.

## Candidate changes
- Consider eventual simplification: fold `requireConfirmation` into intent semantics (DT-065), but keep v2 rollout additive first.

#### Iteration 1: Updates
## Changes made
- Prototype: clarified `nextIntent` closed set and STOP styling for gates.

## Rationale
- Reduce ambiguity while keeping schema surface minimal and closed-set.

#### Iteration 2: Test & Capture Feedback (dogfood plan stub)
## What we tried
- Planned S1–S3 runs across two models and tracked P1–P4.

## What worked
- N/A (pending dogfood)

## What failed
- N/A (pending dogfood)

## Confusions / friction
- Need a lightweight manual coding process for P1 since WorkRail can’t access transcript.

## Candidate changes
- If P1 fails for weaker model, tighten footer phrasing and consider adding “workScope” metadata for high-risk workflows (Direction 4).

## Counters (DT IDs)
- Next DT ID: DT-066

## Emerging patterns (Round 1)
- Strongest ideas are **boundary-marking** (DT-001/DT-002/DT-012) rather than “peek ahead.”
- Reliable behavior likely requires **both**: structured cue + deterministic prompt footer (prose-only is too weak).
- Full-auto should bias toward **tool-call chaining** to reduce the idle gap where speculation happens.
- Gate steps deserve special treatment (templates/metadata) because bypass cost is high.
- “Selective static lookahead” is tempting but must be tightly constrained to avoid undermining v2’s opacity principle.

## Interesting analogies (Round 2)
- **Compilers**: emit an instruction pointer; you don’t “guess” the next opcode—fetch it.
- **Aviation**: checklists prevent confident-but-wrong transitions between phases.
- **Turn-based games**: explicit “end turn” → “next turn” structure reduces free-form skipping.

## Candidate concept packages (Round 3)
- **Package A — Boundary Discipline (default-on candidate)** | member DT-IDs: DT-001, DT-002, DT-010, DT-012, DT-041, DT-042, DT-052 | what it enables: consistent “don’t speculate; fetch next” across workflows with minimal schema growth.
- **Package B — Gate Hardening Kit** | member DT-IDs: DT-044, DT-024, DT-006, DT-054 | what it enables: makes critical review/gate steps hard to bypass (prevents premature implementation).
- **Package C — Full-auto Cadence + Checkpointing** | member DT-IDs: DT-046, DT-033, DT-037, DT-029 | what it enables: reduces between-step chatter by chaining tool calls and moving rich narration to checkpoints.
- **Package D — Minimal Structured Affordances** | member DT-IDs: DT-025, DT-043 | what it enables: closed-set `allowedActions` cues; decreases reliance on prose.
- **Package E — Guarded Static Lookahead (optional)** | member DT-IDs: DT-047, DT-018 | what it enables: reduces uncertainty only when provably safe; constrained to avoid leaking branching.

### Additional ideas (Round 4)

- **DT-056 — Step “work scope” as a closed set (Authoring metadata)**:
  - **What**: Add optional step metadata: `workScope: "read_only" | "write_code" | "docs_only" | "meta"`. Renderer injects: “Do not perform work outside this scope.”
  - **Why it helps**: Directly combats “started implementation early” by narrowing what the agent believes it is allowed to do *in this step*.
  - **How it fits v2**: Closed set, authoring-time, compile-time injection; no runtime lookahead.
  - **Tradeoffs / risks**: Not enforceable; relies on compliance; requires authors to label.

- **DT-057 — Divergence marker for out-of-scope work (Auditability)**:
  - **What**: If the agent needs to do work not requested by the current step, require a `workflow_divergence` artifact with `reason="out_of_scope_work"`.
  - **Why it helps**: Makes “skip ahead” visible and reviewable; discourages doing it casually.
  - **How it fits v2**: Uses existing divergence markers and node-attached signals.
  - **Tradeoffs / risks**: Still not enforcement; only audit/behavior shaping.

- **DT-058 — “Gate present” → default recommended mode preset (Mode safety)**:
  - **What**: A workflow that includes gate templates gets an automatic recommendation: prefer `full_auto_stop_on_user_deps` (or `guided`) over `full_auto_never_stop`, plus explicit warnings if user chooses aggressive.
  - **Why it helps**: Protects critical review steps by making “stop points” more likely.
  - **How it fits v2**: Aligns with “warn loudly, never hard-block user choice.”
  - **Tradeoffs / risks**: Advisory only; depends on user selection.

- **DT-059 — Export/import should preserve boundary discipline artifacts (Portability)**:
  - **What**: Ensure export bundles include whatever node-attached boundary signals exist (e.g., `allowedActions`, gate markers) so resumption doesn’t regress the discipline.
  - **Why it helps**: Prevents “works locally, breaks on import” drift.
  - **How it fits v2**: v2 portability promise; stable projections.
  - **Tradeoffs / risks**: Slight bundle bloat; but bounded.

- **DT-060 — Anti-drift tests for boundary cues (Testing strategy)**:
  - **What**: Golden snapshot tests for the renderer that assert:
    - the boundary footer exists
    - the structured `allowedActions` closed set is emitted correctly
    - gate steps have the STOP styling
  - **Why it helps**: Prevents subtle regressions where the “discipline” disappears due to refactors.
  - **How it fits v2**: Determinism suite is already a lock; this extends it.
  - **Tradeoffs / risks**: Snapshot tests can be brittle; keep the surface tiny.

- **DT-061 — Performance/budget: make boundary cues 1–2 lines max (Ops/perf)**:
  - **What**: Lock a strict byte budget for boundary guidance so it doesn’t balloon prompts and harm model performance.
  - **Why it helps**: Keeps the fix from degrading overall quality by prompt bloat.
  - **How it fits v2**: v2 already budgets recaps; apply same discipline to prompts.
  - **Tradeoffs / risks**: Too short may reduce effectiveness; tune iteratively.

- **DT-062 — Compatibility: ensure v2 tools never imply “workflow knows your plan” (Doc/contract clarity)**:
  - **What**: Make the contract examples and docs consistently avoid promising future actions; teach by example.
  - **Why it helps**: The agent learns from examples; reduce accidental training of wrong behavior.
  - **How it fits v2**: Anti-drift philosophy; doc generation.
  - **Tradeoffs / risks**: Documentation-only; doesn’t fully solve behavior.

- **DT-063 — “Step boundary intent” in the response kind (Protocol shape)**:
  - **What**: Add a top-level `nextIntent` field (closed set), distinct from `pending`: e.g., `nextIntent="call_continue_workflow"` or `nextIntent="await_user_confirmation"`.
  - **Why it helps**: Gives a single place to look; avoids models guessing based on scattered flags.
  - **How it fits v2**: Closed set, tiny, doesn’t reveal next step content.
  - **Tradeoffs / risks**: Another schema field; overlap with `allowedActions` unless unified.

- **DT-064 — Security/policy: avoid parsing agent prose for enforcement (Explicit non-solution)**:
  - **What**: Explicitly reject NLP-based “did the agent promise future work?” enforcement at runtime; keep enforcement structural (contracts, closed sets, renderer invariants).
  - **Why it helps**: Prevents a fragile, model-dependent enforcement path from becoming a correctness requirement.
  - **How it fits v2**: “Errors as data” + determinism; no heuristics for truth.
  - **Tradeoffs / risks**: Leaves some behavior uncatchable; accept and mitigate via cues and cadence.

- **DT-065 — Consolidate `requireConfirmation` semantics into `allowedActions` (Simplification)**:
  - **What**: Treat `requireConfirmation` as UI sugar; the real behavioral contract is `allowedActions` (closed set) and the renderer’s STOP formatting.
  - **Why it helps**: Simplifies the agent’s decision model; fewer flags to interpret.
  - **How it fits v2**: Closed sets over ad-hoc booleans; aligns with v2 philosophy.
  - **Tradeoffs / risks**: Migration/compat within v2; needs careful design.

## Coverage map
- **Dimension** | **coverage** | **top DT-IDs**
- Protocol boundary cues | high | DT-001, DT-002, DT-012, DT-025, DT-043, DT-052, DT-063
- Authoring UX / templates | med | DT-005, DT-044, DT-024, DT-050, DT-056
- Validation / linting | med | DT-017, DT-048, DT-060
- Dashboard / observability | low-med | DT-009, DT-035, DT-057
- Model variability resilience | high | DT-001, DT-002, DT-042, DT-027, DT-052
- Modes / safety recommendations | med | DT-051, DT-034, DT-058
- Resumption / portability | low-med | DT-059, DT-037
- Loops correctness | low | (not central here; indirectly via “don’t skip gates”) DT-044
- Capability negotiation | low | (not central here)
- Performance/budgets | low-med | DT-061

