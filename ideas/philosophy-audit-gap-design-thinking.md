# Design Thinking: Philosophy Audit Gap in Coding Workflow

## Context / Problem

The agentic coding workflow's audit phase (plan-analysis, hypothesis-challenge, execution-simulation) only validates **correctness** — will it compile, wire, flow correctly. It never evaluates **design quality** — is this the right abstraction, does it follow the user's coding philosophy principles.

Evidence: a real ACEI-1875 session caught 2 red violations and 3 yellow violations only when the user manually invoked `/philosophy` *after* the workflow's audit phase was complete.

Two distinct sub-problems:
1. **Missing philosophy/design-quality lens** in the audit phase
2. **Cross-iteration regression** in the plan iteration loop — resolved findings from iteration N can be silently un-resolved in iteration N+1

### Constraints
- **Hard**: Must work within existing workflow JSON schema (steps, routines, loops, runConditions)
- **Hard**: Must not degrade existing correctness audits
- **Hard**: Must support both solo self-audit and subagent delegation
- **Soft**: Should integrate into existing `phase-5b-plan-audit` delegation slot
- **Soft**: Should not significantly increase token usage for QUICK/STANDARD modes

### Anti-goals
- Not redesigning the entire coding workflow
- Not building a generic "philosophy engine"
- Not changing the workrail v2 runtime/token/event system

## Persona

**Etienne** — Senior Android Engineer who uses workrail's agentic coding workflow for non-trivial tasks. Has a well-defined coding philosophy (immutability, errors-as-data, fakes-over-mocks, YAGNI, exhaustive unions, etc.) that applies consistently across projects.

## Phase 2: Define

### POV (Point of View)

**Etienne** needs the coding workflow's audit phase to evaluate design quality against his coding philosophy — not just correctness — because philosophy violations caught after plan solidification require expensive rework and indicate the audit was structurally incomplete.

### Problem Statement

The agentic coding workflow's plan audit (Phase 5b) runs three focused correctness routines but has no mechanism for evaluating whether the plan adheres to the user's design principles. This structural gap means design quality violations are only discovered through manual intervention after the workflow considers its audit complete. Additionally, the plan iteration loop lacks a verification ledger, allowing resolved findings to silently regress across iterations.

### Alternative Framings

1. **"The problem isn't a missing routine — it's that userRules aren't being used effectively."** The user's philosophy IS already captured in `userRules` (Phase 0c). Maybe the existing routines just need better filtering/prompting to surface philosophy-relevant findings. The `routine-plan-analysis` "Pattern Compliance" step could be enhanced with a philosophy sub-check. This would mean no new routine, just better utilization of existing infrastructure.

2. **"The problem is actually about structured output format, not a missing lens."** The agent already knows the philosophy (it's in rules/context). The real issue might be that no audit step *requires structured philosophy-aligned output* (principle + severity + action). If the plan audit step added a mandatory "Philosophy Alignment" output section to its deliverable schema, the existing self-audit or delegated routines might naturally produce philosophy findings. This reframes the gap from "missing tool" to "missing output requirement."

### How Might We... (7)

1. HMW integrate a user's coding philosophy as a first-class audit lens without diluting the focused correctness routines?
2. HMW prevent resolved audit findings from regressing across plan iteration passes?
3. HMW scale the philosophy lens across rigor modes (QUICK/STANDARD/THOROUGH) without excessive overhead?
4. HMW make the philosophy evaluation produce structured, actionable output (not free-form prose)?
5. HMW ensure the philosophy lens works equally well in solo mode (no subagents) as in delegated mode?
6. HMW leverage the existing `userRules` infrastructure rather than creating a parallel system?
7. HMW make cross-iteration regression detectable without requiring the agent to remember previous iterations?

### Success Criteria (measurable)

- [ ] **SC-1**: Philosophy violations caught during plan audit phase (Phase 5b), not after
- [ ] **SC-2**: Existing correctness audits remain undiluted — no new concerns added to plan-analysis, hypothesis-challenge, or execution-simulation prompts
- [ ] **SC-3**: Cross-iteration regression prevented — resolved findings verified on each subsequent pass
- [ ] **SC-4**: Works in solo mode (self-audit) and delegated mode (subagent)
- [ ] **SC-5**: Token overhead: QUICK adds <5% to audit cost; STANDARD <15%; THOROUGH <25%
- [ ] **SC-6**: Findings are structured: principle name, severity (red/orange/yellow), violation description, recommended action
- [ ] **SC-7**: No changes required to workrail runtime/token/event system — workflow JSON only

### Key Tensions / Tradeoffs

1. **4th routine (clean) vs enhanced existing (cheap)**: A standalone routine preserves single responsibility but adds a 4th parallel subagent. Enhancing existing routines is cheaper but dilutes their focus.
2. **Baked-in philosophy vs parameterized input**: If the philosophy is baked into a routine, it's zero-config but inflexible. If parameterized, it's flexible but requires the user to pass principles every time.
3. **Regression ledger scope**: Should the resolved-findings ledger be a context variable pattern (workflow-level) or a workrail `feature` (runtime-level)? Context variable is simpler but depends on the agent maintaining it correctly.
4. **QUICK mode cost**: Any philosophy check in QUICK mode competes with the "skip this step" ethos. But QUICK tasks might also have design violations.

### Assumptions

1. **A1**: The user's philosophy is stable enough across projects that a routine can reference it by convention (e.g., `userRules` or a dedicated `philosophyPrinciples` context variable)
2. **A2**: The agent can reliably evaluate design principles if given structured criteria (evidence: the `/philosophy` conversation shows it can)
3. **A3**: 4 parallel subagents in THOROUGH mode is within acceptable token/latency budgets
4. **A4**: Cross-iteration regression is a real pattern, not a one-off (evidence: one confirmed case)
5. **A5**: The existing workflow JSON schema (steps, routines, loops) is expressive enough — no runtime changes needed

### Riskiest Assumption

**A4: Cross-iteration regression is a real pattern.** We have exactly one data point (the `FakeUseBackendGleamCountFeature` regression). If this was a one-off caused by an unusual iteration scope change, the regression ledger is over-engineering. We should validate this by reviewing whether the plan iteration loop's `planFindings` → amendment → re-audit cycle has structural properties that make regression likely (it does: `planFindings` is reset each pass, amendments modify the plan, and the next audit is scoped to "find new issues" not "verify old fixes").

### What Would Change Our Mind

- If philosophy violations are rare (<1 per 10 workflow runs), the ROI of a dedicated routine is low — a simple prompt addition to `phase-5b` would suffice
- If the token cost of a 4th subagent makes THOROUGH mode prohibitively expensive, we need a lighter integration
- If the `userRules` filtering in `phase-5b` already surfaces philosophy principles to subagents and the agent just isn't using them, the fix is prompt engineering not architecture
- If `planFindings` regression only happens when the plan changes structurally (not incrementally), the ledger is unnecessary for normal operation

### Out of Scope

- Redesigning the full coding workflow
- Building a generic "philosophy engine" or "design quality service"
- Changing the workrail v2 runtime/token/event system
- Fixing the specific ACEI-1875 ticket
- Philosophy evaluation during implementation (Phase 6) — plan phase only for now
- Automated philosophy principle extraction from codebase

### Reflection Prompts

- **What would change our mind?** Data showing philosophy violations are rare enough that manual `/philosophy` is adequate. Or evidence that the existing `userRules` + prompt engineering can achieve the same result without a new routine.
- **Riskiest assumption?** A4 (regression is a pattern). But structural analysis supports it: `planFindings` resets each pass, and amendments can reverse previous fixes without the audit noticing.

### Proceeding to Ideation — Readiness Check

- ✅ POV is precise and evidence-backed
- ✅ Problem statement is specific (two orthogonal sub-problems)
- ✅ 2 alternative framings produced (both plausible)
- ✅ 7 HMW statements covering both sub-problems
- ✅ 7 measurable success criteria
- ✅ Tensions, assumptions, and risks identified
- ✅ Ready for divergent ideation

### Next Input Checklist
- ✅ All evidence gathered
- ❓ **Still open**: Does philosophy differ per-project? (Will assume stable based on evidence; can revisit)

## Success Criteria

*(Moved to Phase 2 Define section above — SC-1 through SC-7)*

## Phase 1: Empathize

### Persona Card (Primary)

- **Name**: Etienne
- **Context**: Senior Android Engineer at Zillow, uses workrail's agentic coding workflow (v1.5.0) for non-trivial tasks across Android (Kotlin), iOS (Swift), and tooling (TypeScript). Runs THOROUGH mode with subagent delegation.
- **Goals**: Produce production-ready code that adheres to his well-defined coding philosophy. Wants the workflow to catch everything — correctness AND design quality — before implementation begins.
- **Pains**:
  1. Philosophy violations slip through the audit phase undetected
  2. Must manually invoke `/philosophy` after the workflow finalizes — feels like the workflow failed
  3. Cross-iteration regression: a fix in iteration 1 gets silently undone in iteration 2
  4. The "fakes over mocks" fix was caught, then lost, then re-caught — wasted cycles
  5. Dead code survives audits because it doesn't cause failures (only design smell)
- **Constraints**: Works within the workrail ecosystem; uses Firebender IDE; subagent delegation available
- **Quotes/observations**:
  - Agent: "the audit routines and the philosophy review are fundamentally different lenses"
  - Agent: "the audits explicitly confirmed this approach was correct... They were answering 'does this work?' — not 'should this exist at all?'"
  - Agent: "[FakeUseBackendGleamCountFeature] was caught. But in iteration 2... I conflated 'the factory doesn't need updating' with 'the fake is no longer needed'"
  - Agent: "The workflow ran the wrong tool as a substitute for the right one"

### Journey Map (Lightweight)

| Step | Pain | Opportunity |
|------|------|-------------|
| Phase 0: Triage | None | Could inject philosophy as constraint set here |
| Phase 0b: User Rules | Philosophy captured in `userRules` but as passive reference | Make philosophy an active, structured audit input |
| Phase 1-2: Context + Invariants | None | — |
| Phase 3-4: Ideation + Architecture | Philosophy informs decisions implicitly | Could score approaches against philosophy |
| Phase 5a: Plan Draft | Plan may contain design violations | — |
| **Phase 5b: Plan Audit** | **3 routines check correctness only; no design quality lens** | **Add philosophy alignment as 4th audit dimension** |
| Phase 5c: Refocus | Amendments from audit, but no philosophy amendments | Include philosophy findings in amendments |
| Phase 5d: Loop Exit | Resolved findings not verified on re-pass | Carry forward resolved findings as verification ledger |
| Post-workflow: Manual `/philosophy` | **All design violations caught here — too late** | Eliminate this manual step entirely |

### Observations (5)

1. **O1**: The `phase-5b-plan-audit` step spawns exactly 3 parallel subagents in THOROUGH mode: plan-analysis, hypothesis-challenge, execution-simulation. There is no 4th slot.
2. **O2**: The plan iteration loop (`phase-5-plan-iterations`) uses `planFindings` as the loop control variable. When `planFindings` is empty, the loop exits. But `planFindings` is reset each iteration — there's no "previously resolved" ledger.
3. **O3**: The `userRules` context variable is captured in Phase 0c and passed to subagents as "filtered userRules." But filtering is keyword-based ("architecture, testing, patterns") — philosophy principles aren't a keyword category.
4. **O4**: In the ACEI-1875 session, the philosophy review found 2 red (blocking), 2 orange (design quality), and 2 yellow (tension) findings — a 6-item structured table with principle name, violation, severity, and action. This output format is already well-defined by convention.
5. **O5**: The `routine-plan-analysis` has a "Pattern Compliance" step that checks "adherence to codebase patterns" — but codebase patterns and design philosophy are different things. Codebase patterns = "how code looks here." Philosophy = "how code should be designed anywhere."

### Insights (5)

1. **I1** (from O1, O5): The 3 routines form a **correctness triad** (completeness, adversarial, simulation). Philosophy is a 4th orthogonal dimension, not a subset of any of the three. Adding it to an existing routine would dilute that routine's focus.
2. **I2** (from O2): The loop exit decision checks if `planFindings` is empty on the current pass. But it doesn't check if *previously resolved* findings are still resolved. This is a **state machine gap** — the loop models "find → fix → verify" but not "verify old fixes still hold."
3. **I3** (from O3, O4): Philosophy principles are already structured in the user's practice (principle name → severity → action). The workflow just doesn't have a step that uses this structure. The format exists; the integration point doesn't.
4. **I4** (from O1, Persona quotes): The agent correctly diagnosed that the audit ran "the wrong tool as a substitute for the right one." The tool doesn't exist yet. The gap isn't a misconfiguration — it's a missing capability.
5. **I5** (from O2, Persona quotes): The FakeUseBackendGleamCountFeature regression happened because iteration 2's scope was "find what's missing" not "verify what was fixed." This is a **verification asymmetry**: the loop has an additive lens but no regression lens.

### Evidence

**Facts we have:**
- Real conversation evidence with specific violations found
- Full source of all 3 audit routines (plan-analysis, hypothesis-challenge, execution-simulation)
- Full source of the agentic coding workflow (phase-5b-plan-audit step)
- The agent's own root cause analysis of why each violation slipped through
- The structured format philosophy reviews already produce (principle, severity, action table)

**Evidence gaps:**
- No data on how often philosophy violations occur across multiple workflow runs (only 1 data point)
- No data on token cost of adding a 4th subagent in THOROUGH mode
- Unknown whether the philosophy is stable across projects or varies

### Constraints (environment/tooling/model)

- Workflow JSON schema supports arbitrary steps, loops, runConditions, and routines
- Subagent delegation via WorkRail Executor is available but adds latency + token cost
- QUICK mode should be cheap — a 4th subagent may be too heavy
- The `userRules` context variable is the existing integration surface for user preferences
- Workrail's `features` system (compiler middleware) could potentially inject philosophy content into step prompts

### Observed Pain Themes (5-10)

1. **Wrong tool for the job**: Correctness audits used as substitute for design quality review
2. **Late discovery**: Philosophy violations found post-plan, requiring expensive rework
3. **Regression blindness**: Cross-iteration regression of resolved findings
4. **Missing audit dimension**: No structured slot for design philosophy evaluation
5. **Implicit vs explicit**: Philosophy lives in `userRules` as passive text, not as an active audit constraint
6. **Filtering gap**: Keyword-based userRules filtering doesn't surface philosophy principles to subagents
7. **Scope conflation**: Agent conflated "factory doesn't need updating" with "fake is no longer needed" — different concerns, same iteration scope

### Unknowns (explicit list)

- How much token overhead does a 4th parallel subagent add in THOROUGH mode?
- Does the philosophy differ per-project? (Affects whether routine takes philosophy as input)
- Would baking philosophy into `routine-plan-analysis`'s "Pattern Compliance" step be sufficient, or does it dilute that routine?
- Is the "resolved findings ledger" a workflow-level concern or a workrail runtime concern?
- Could workrail's `features` system be used to inject philosophy content, or is that overengineering?

### Interpretation Risks (3)

1. **Over-generalizing from one data point**: We have evidence from exactly one session (ACEI-1875). The 6 violations found might be atypically high — or they might be typical. Without more data, we could be designing for an outlier.
2. **"Working as designed"**: The audit routines ARE working correctly — they find what they're designed to find. The gap is a missing capability, not a broken one. We should frame this as an addition, not a fix.
3. **Philosophy stability assumption**: If the user's philosophy evolves frequently, baking it into a routine could create maintenance burden. If it's stable, a routine is appropriate. The evidence (Firebender rules, conversation) suggests it's very stable.

### Reflection Prompts

- **Symptoms vs root causes**: "Late discovery" and "regression blindness" are symptoms. The root causes are (a) missing audit dimension and (b) no verification ledger in the loop state machine. These are the two orthogonal fixes.
- **What would disprove our top interpretations?**: If philosophy violations are rare enough that manual `/philosophy` invocation is adequate 95% of the time, the ROI of a 4th routine is low. If the loop regression only happened once and isn't reproducible, the ledger fix is over-engineering.

### Next Input Checklist
- ✅ Evidence gathered from conversation and source files
- ✅ Audit routines analyzed in detail
- ✅ Pain themes and insights documented
- ❓ **Open question**: Does your philosophy differ per-project?

## Idea Backlog (append-only)

### Round 1: General Divergence

**DT-003** — **4th Parallel Routine ("routine-philosophy-alignment")**
Standalone routine JSON alongside plan-analysis, hypothesis-challenge, execution-simulation. Takes the plan + philosophy principles as input. Produces structured findings table. Spawned as 4th parallel subagent in THOROUGH.
Category: New routine | Addresses: Philosophy lens

**DT-004** — **Philosophy as a `feature` (compiler middleware)**
Use workrail's `features` system (e.g., `wr.features.philosophy_alignment`) to inject philosophy evaluation prompts into the plan-audit step's promptBlocks at compile time. No new routine — the feature injects a section into the existing audit prompt.
Category: Workrail feature | Addresses: Philosophy lens

**DT-005** — **Mandatory output section in phase-5b**
Add a required "Philosophy Alignment" section to phase-5b's deliverable. The main agent (or subagents) must fill it out. If missing/empty, the step blocks. No new routine — just prompt engineering + output validation.
Category: Prompt engineering | Addresses: Philosophy lens

**DT-006** — **Enhanced `userRules` filtering with "philosophy" keyword category**
Add "philosophy" as a recognized keyword category in the userRules filtering logic. Subagents would then receive philosophy-relevant rules alongside their existing context. Each existing routine adds a philosophy check to its synthesis step.
Category: Existing infra enhancement | Addresses: Philosophy lens

**DT-007** — **Philosophy pre-check before plan draft (Phase 5a)**
Add a step before the plan draft that explicitly maps philosophy principles to the proposed approach. Catches violations before they're baked into the plan. Lighter than auditing a full plan.
Category: Workflow restructure | Addresses: Philosophy lens

**DT-008** — **"Resolved findings ledger" as context variable**
Maintain a `resolvedFindings` context variable (array of {finding, resolution, iteration}). Each audit pass receives it and must verify resolutions still hold. Phase-5d loop exit checks both `planFindings` empty AND `resolvedFindings` verified.
Category: Context variable pattern | Addresses: Regression ledger

**DT-009** — **Append-only `auditHistory` context variable**
Instead of resetting `planFindings` each iteration, maintain an append-only `auditHistory` where each pass adds its findings. The loop exit decision can then look at the full history for regressions.
Category: Context variable pattern | Addresses: Regression ledger

**DT-010** — **Dedicated regression check step (Phase 5b.5)**
Add a step between audit (5b) and refocus (5c) that explicitly re-checks all previously resolved findings. Runs every iteration after the first. Separate from the forward-looking audit.
Category: New step | Addresses: Regression ledger

**DT-011** — **Philosophy as an `outputContract` on the audit step**
Use workrail v2's typed artifact validation to require a philosophy-alignment artifact from the audit step. The schema would enforce the structured format (principle, severity, action). Engine blocks if missing.
Category: Output contract | Addresses: Philosophy lens

**DT-012** — **Philosophy principles as `invariants` (Phase 2)**
Capture philosophy principles as formal invariants alongside technical invariants in Phase 2. The existing plan-analysis "completeness check" would then verify them. No new routine — philosophy becomes part of the requirements.
Category: Requirements reframing | Addresses: Philosophy lens

**DT-013** — **"Devil's advocate" expansion to include philosophy**
The existing coding workflow (v0.8.0) has a "Devil's Advocate Review" step. Expand it (or the agentic workflow's equivalent) to include a philosophy adversarial lens: "Challenge the plan from the philosophy perspective."
Category: Existing step enhancement | Addresses: Philosophy lens

**DT-014** — **Philosophy scoring matrix in approach selection (Phase 3-4)**
Score each candidate approach against philosophy principles during the ideation/comparison phase. Philosophy violations get caught before the plan even exists.
Category: Earlier integration | Addresses: Philosophy lens

**DT-015** — **Regression detector as a workrail `templateCall`**
Create a compile-time template (`wr.templates.regression_check`) that expands into a verification step. Any loop body that includes it gets automatic regression checking. Reusable across workflows.
Category: Template | Addresses: Regression ledger

**DT-016** — **Philosophy routine with tiered depth**
Standalone routine with 3 depths: Skim (check top 3 principles, QUICK), Standard (check all principles, STANDARD), Deep (adversarial philosophy challenge, THOROUGH). Scales naturally with rigor mode.
Category: New routine with scaling | Addresses: Philosophy lens

**DT-017** — **"Findings checkpoint" in the plan iteration loop**
At the end of each iteration, checkpoint all findings (resolved + new) as a durable artifact in workrail's session store. Next iteration loads the checkpoint and verifies. Survives rewinds.
Category: Durable state | Addresses: Regression ledger

**DT-018** — **Philosophy as part of `routine-hypothesis-challenge` input**
Add philosophy principles to the hypothesis-challenge routine's hypotheses list: "This plan adheres to the user's design philosophy." The routine's adversarial nature naturally challenges violations. No new routine.
Category: Existing routine input | Addresses: Philosophy lens

**DT-019** — **Hybrid: philosophy pre-screen (5a.5) + regression ledger (context var)**
Combine DT-007 + DT-008. Philosophy pre-screen catches violations early; regression ledger prevents cross-iteration loss. Two small additions, no new routine.
Category: Hybrid | Addresses: Both

**DT-020** — **Philosophy as a workrail "contract pack"**
Define philosophy principles as a workrail contract pack (like artifact contracts). Steps that reference it must produce philosophy-aligned output. Machine-checkable where possible.
Category: Contract pack | Addresses: Philosophy lens

**DT-021** — **Auto-generated philosophy checklist from `userRules`**
At Phase 0c, automatically extract philosophy-relevant rules from `userRules` and generate a structured checklist. This checklist is passed to all audit steps as a mandatory section. No manual principle curation needed.
Category: Auto-extraction | Addresses: Philosophy lens

**DT-022** — **Post-audit philosophy gate (before loop exit)**
Add a dedicated philosophy gate step in the loop (between 5c-refocus and 5d-loop-exit). Runs only once (last iteration). Cheaper than running every iteration.
Category: Gate step | Addresses: Philosophy lens

**DT-023** — **`planFindings` schema change: add `resolved` and `verified` fields**
Change `planFindings` from a flat array to `{ open: [], resolved: [], verified: [] }`. The audit step must verify resolved items. The loop exit checks both open=empty and all resolved=verified.
Category: Schema change | Addresses: Regression ledger

### Emerging Patterns (5)

1. **Standalone vs integrated**: Ideas split between a new routine (DT-003, DT-016) and enhancing existing infrastructure (DT-005, DT-006, DT-012, DT-018)
2. **Timing**: Some ideas catch violations early (DT-007, DT-014) vs at audit time (DT-003, DT-005) vs as a final gate (DT-022)
3. **Workrail-native vs prompt-only**: Some leverage workrail features/contracts/templates (DT-004, DT-011, DT-015, DT-020) while others are pure prompt engineering (DT-005, DT-006)
4. **Regression approaches cluster around state shape**: Whether `planFindings` gets richer (DT-023), a parallel variable tracks history (DT-008, DT-009), or checkpointing handles it (DT-017)
5. **Scaling with rigor mode**: The tiered routine (DT-016) and the "last-iteration-only" gate (DT-022) are the most explicit about scaling

### Reflection (Round 1)

- **Underrepresented categories**: Ideas about testing/validating the philosophy lens itself are missing. Also missing: what happens when philosophy principles conflict with each other (e.g., YAGNI vs exhaustiveness)?
- **Simplest idea being dismissed**: DT-005 (mandatory output section) is dead simple and might be 80% effective with 10% of the effort. Worth not dismissing.
- **Driving assumption**: Most ideas assume a standalone philosophy evaluation is needed. The alternative framings (Phase 2) suggest the existing infrastructure might be sufficient with better prompting.

### Round 2: Orthogonal / Unrelated Inspiration

#### Analogies from other domains

**DT-024** — **Compiler lint passes (compiler analogy)**
Compilers run multiple independent passes: parsing, type checking, optimization, linting. Each pass has a single concern. The philosophy check is a "lint pass" — it doesn't affect correctness but enforces style/quality. Like ESLint running alongside tsc. Integration: a separate, lightweight pass that reads the plan and emits structured warnings.
Category: Compiler analogy | Addresses: Philosophy lens

**DT-025** — **Pre-flight checklist (aviation analogy)**
Pilots use checklists that are ALWAYS run, regardless of flight complexity. The philosophy check is a "pre-flight checklist" that runs before plan finalization (before loop exit). It's cheap (checklist, not simulation), mandatory, and structured. Integration: a non-skippable gate in the loop.
Category: Aviation analogy | Addresses: Philosophy lens

**DT-026** — **Regression test suite (testing analogy)**
In CI, regression tests run EVERY build — not just when someone remembers. The resolved-findings ledger should work like a regression test suite: automatically re-run on every iteration, not dependent on the agent remembering. Integration: the loop step automatically re-verifies all `resolvedFindings` entries.
Category: Testing analogy | Addresses: Regression ledger

**DT-027** — **Building code inspector (construction analogy)**
Building inspectors check against a code (regulations), not against "did the builder make mistakes." They have a checklist derived from the code. The philosophy principles ARE the building code. Integration: a routine that takes philosophy principles as a structured checklist and checks each one against the plan.
Category: Construction analogy | Addresses: Philosophy lens

**DT-028** — **Double-entry bookkeeping (finance analogy)**
Every transaction is recorded in two places; any discrepancy signals an error. For findings: when a finding is resolved, record both the finding AND the resolution. Each subsequent audit verifies the double-entry balance. Integration: `planFindings` tracks both sides.
Category: Finance analogy | Addresses: Regression ledger

**DT-029** — **Game design playtesting (game design analogy)**
Game designers playtest from different player archetypes (casual, competitive, explorer). Each archetype finds different issues. The philosophy review is a new "playtester archetype" — someone who plays the game from the design quality perspective. Not replacing existing testers, adding a new one.
Category: Game design analogy | Addresses: Philosophy lens

**DT-030** — **Inversion: What if the agent STARTS with the philosophy?**
Instead of checking philosophy at audit time, start the entire workflow by loading the philosophy principles and having them frame EVERY decision from the beginning. Make the philosophy the ambient context, not a checkpoint. Integration: inject philosophy as a `metaGuidance` or `feature` that colors all steps.
Category: Inversion | Addresses: Philosophy lens

**DT-031** — **Inversion: What if violations are expected and valued?**
Instead of trying to catch violations, treat them as TRADE-OFFS that must be explicitly justified. A plan that violates "fakes over mocks" is fine IF the justification is recorded. Integration: require a "Philosophy Tradeoffs" section in the plan where violations are acknowledged with rationale.
Category: Inversion | Addresses: Philosophy lens

**DT-032** — **Inversion: What if the PLAN checks itself?**
Instead of a separate auditor checking the plan, embed self-check prompts in the plan template (Phase 5a). Each section of the plan includes a "Philosophy alignment: [principle] — satisfied/violated/justified" column. The plan IS the audit.
Category: Inversion | Addresses: Philosophy lens

**DT-033** — **Inversion: What if there's NO separate regression check?**
Instead of tracking resolved findings, make the plan immutable-ish: amendments create a NEW plan version, and the audit always runs against the full plan (not the delta). The whole plan is re-audited each iteration. No regression possible because there's no "resolved" state.
Category: Inversion | Addresses: Regression ledger

#### Constraint inversions (5 ideas)

**DT-034** — **Constraint: No subagents available**
If delegation is impossible, the philosophy check must be a self-audit section within phase-5b. Solution: add a mandatory "Self-Audit: Philosophy" subsection to the phase-5b prompt, with a structured checklist the agent fills out. The agent evaluates its own plan against each principle.
Category: Constraint inversion | Addresses: Philosophy lens

**DT-035** — **Constraint: No JSON schema changes allowed**
If we can't modify the workflow JSON schema, the only lever is prompt content. Solution: add philosophy evaluation instructions to the existing phase-5b prompt text. Include the structured output template (principle | severity | action) directly in the prompt.
Category: Constraint inversion | Addresses: Philosophy lens

**DT-036** — **Constraint: Only events (no context variables)**
If we can only use workrail domain events (no context variables for state), the regression ledger must be stored as durable events. Solution: use `checkpoint_workflow` to persist a "findings snapshot" as durable notes after each iteration. The next iteration reads the checkpoint.
Category: Constraint inversion | Addresses: Regression ledger

**DT-037** — **Constraint: Philosophy principles are unknown at workflow design time**
If we can't bake in specific principles, the routine must discover them. Solution: the philosophy routine's first step reads `userRules` and Firebender rules, extracts philosophy-relevant principles, and dynamically generates its checklist. Fully adaptive.
Category: Constraint inversion | Addresses: Philosophy lens

**DT-038** — **Constraint: Token budget is zero for philosophy**
If there's no budget for philosophy evaluation, it must happen for free. Solution: reframe the existing `routine-plan-analysis` "Pattern Compliance" step to check design patterns AND design principles. Replace "codebase patterns" with "codebase patterns + design philosophy." Zero additional tokens.
Category: Constraint inversion | Addresses: Philosophy lens

### Interesting Analogies (3)

1. **Aviation pre-flight checklist** (DT-025) — The insight that philosophy evaluation should be cheap, mandatory, and structured (a checklist, not a simulation) is powerful. It doesn't need to be a heavyweight routine.
2. **Double-entry bookkeeping** (DT-028) — The two-sided recording of findings + resolutions makes regression detection automatic and structural, not dependent on agent memory.
3. **Compiler lint passes** (DT-024) — Cleanly separates the concern: correctness passes don't change, a new lint pass is added alongside. This maps perfectly to the "4th routine" model.

### Reflection (Round 2)

- **Most non-obvious leverage**: The aviation pre-flight checklist (DT-025) reframes philosophy as a lightweight checklist, not a heavyweight audit. This challenges the assumption that a 4th subagent is needed.
- **Simplest idea being dismissed**: DT-032 (plan checks itself via inline philosophy alignment columns) is almost trivially simple — just a template change to the plan artifact. Yet it might catch most violations.
- **Driving assumption**: Round 1 assumed the philosophy check happens AT AUDIT TIME. Round 2 inversions (DT-030, DT-032) suggest it could be ambient or embedded in the plan itself.

### Round 3: Build-on / Combine / Mutate

**DT-039** — **Layered philosophy: ambient + checklist + audit (DT-030 + DT-025 + DT-003)**
Three layers: (1) Philosophy injected as ambient `metaGuidance` for all steps, (2) Pre-flight checklist in plan template (Phase 5a), (3) Dedicated routine in THOROUGH audit. Each layer catches different severity: ambient catches obvious stuff, checklist catches plan-level violations, routine catches subtle design tensions. Defense in depth.
Category: Combined | Addresses: Philosophy lens

**DT-040** — **Self-checking plan + double-entry regression (DT-032 + DT-028)**
Plan template includes inline philosophy alignment columns (self-check). Findings from audit are recorded as double-entry (finding + resolution). Each iteration, the self-check columns are verified against the double-entry ledger. The plan IS the regression test.
Category: Combined | Addresses: Both

**DT-041** — **Tiered routine + auto-extracted checklist (DT-016 + DT-021)**
The tiered routine (Skim/Standard/Deep) automatically extracts philosophy principles from `userRules` at runtime. No manual principle curation. Skim checks top-3 by keyword frequency; Standard checks all; Deep does adversarial challenge per principle.
Category: Combined | Addresses: Philosophy lens

**DT-042** — **Mandatory output section + outputContract (DT-005 + DT-011)**
Combine the simple prompt-level requirement (mandatory philosophy section) with workrail's typed output contract. The audit step's outputContract requires a `wr.philosophy_alignment` artifact. Engine blocks if the artifact is malformed or missing. Self-enforcing.
Category: Combined | Addresses: Philosophy lens

**DT-043** — **Philosophy as invariants + regression test suite (DT-012 + DT-026)**
Capture top-5 philosophy principles as formal invariants in Phase 2. The regression test suite runs every iteration, verifying all invariants (both technical and philosophical) still hold. Unified model — no separate "philosophy" concept, just more invariants.
Category: Combined | Addresses: Both

**DT-044** — **Hypothesis challenge with philosophy hypotheses + findings schema change (DT-018 + DT-023)**
Add "Plan adheres to design philosophy" as a hypothesis in `routine-hypothesis-challenge`. Change `planFindings` to `{ open, resolved, verified }`. The hypothesis challenge naturally produces structured challenges; the schema prevents regression. No new routine, just enhanced input + output schema.
Category: Combined | Addresses: Both

**DT-045** — **Ambient philosophy feature + pre-flight gate (DT-004 + DT-025)**
A workrail `feature` injects philosophy principles into all step prompts (ambient). Plus a mandatory pre-flight gate (Phase 5d-adjacent) that runs a structured checklist before loop exit. The ambient layer prevents violations from forming; the gate catches anything that slipped through.
Category: Combined | Addresses: Philosophy lens

**DT-046** — **Zero-cost reframe: philosophy IS pattern compliance (DT-038 + DT-027)**
Redefine "Pattern Compliance" in `routine-plan-analysis` to include design principles alongside codebase patterns. The building code inspector checks both "local codes" (codebase patterns) and "universal codes" (philosophy). One step, two checklists.
Category: Mutation | Addresses: Philosophy lens

**DT-047** — **Checkpoint-based regression (DT-017 + DT-036)**
Use `checkpoint_workflow` to persist a "findings snapshot" as durable notes after each plan iteration. The next iteration loads the checkpoint and verifies all resolutions. Leverages workrail's existing durability system — no new context variables needed.
Category: Combined | Addresses: Regression ledger

**DT-048** — **Philosophy tradeoff register (DT-031 + DT-032)**
The plan template includes a "Philosophy Tradeoff Register" section. Each violation is listed with: principle, violation, justification, accepted/rejected status. The audit step verifies the register is complete and justified. Violations aren't always bad — unjustified violations are.
Category: Mutation | Addresses: Philosophy lens

### Candidate Concept Packages (5)

**Package A: "Lightweight Pragmatist"**
Member IDs: DT-005, DT-032, DT-023
What it enables: Minimal changes — mandatory output section in audit prompt + self-checking plan template + structured `planFindings` with resolved tracking. No new routine, no new files. Pure prompt engineering + context variable schema. Cost: ~5% token overhead.

**Package B: "Clean Separation"**
Member IDs: DT-003, DT-016, DT-008, DT-026
What it enables: Standalone `routine-philosophy-alignment` with tiered depth + resolved findings ledger as context variable with automatic regression checking. Clean single responsibility. Cost: ~20% token overhead in THOROUGH.

**Package C: "Defense in Depth"**
Member IDs: DT-039, DT-028, DT-048
What it enables: Three-layer philosophy (ambient + checklist + audit) + double-entry regression tracking + tradeoff register. Maximum coverage, heaviest. Cost: ~30% token overhead in THOROUGH, ~10% in QUICK.

**Package D: "Workrail-Native"**
Member IDs: DT-004, DT-011, DT-042, DT-047
What it enables: Uses workrail's `features` system for ambient injection + `outputContract` for enforcement + checkpoint-based regression. Maximum leverage of existing platform capabilities. Cost: requires workrail runtime awareness but no new routines.

**Package E: "Reframe & Reuse"**
Member IDs: DT-012, DT-043, DT-044, DT-046
What it enables: Philosophy principles become formal invariants + expanded pattern compliance + enhanced hypothesis challenge + unified findings schema. No new concept — philosophy is just another category of existing concerns. Cost: ~10% token overhead, minimal new code.

### Reflection (Round 3)

- **Missing primitive**: A structured "philosophy principles" input format. Most packages assume principles are extractable from `userRules`, but a canonical JSON/structured format would make all approaches more reliable.
- **Simplest idea being dismissed**: Package A ("Lightweight Pragmatist") requires zero new files and could be implemented in an hour. It won't be perfect but it's immediately deployable and might be 80% effective.
- **Driving assumption**: All packages assume the agent can reliably evaluate design philosophy IF given structured criteria. This was demonstrated in the ACEI-1875 session — but only with the full `/philosophy` command prompt. Smaller prompts might be less effective.

### Round 4: Coverage Sweep & Blind Spot Hunt

**DT-049** — **Model variability: philosophy evaluation quality across LLMs**
Different models (Claude, GPT-4, Gemini) may evaluate design philosophy with varying quality. Solution: the philosophy routine's prompt should include concrete examples of violations per principle (like the ACEI-1875 evidence) to anchor the model. Few-shot examples in the routine prompt.
Category: Model variability | Addresses: Philosophy lens reliability

**DT-050** — **Migration path: gradual rollout from THOROUGH to QUICK**
Start with philosophy audit only in THOROUGH mode (4th subagent). After validation, add to STANDARD (mandatory output section). Finally, add ambient injection for QUICK. This gives a safe migration path with early feedback.
Category: Migration/rollout | Addresses: Risk management

**DT-051** — **Testing the philosophy routine itself**
How do we validate the philosophy routine catches violations? Use the ACEI-1875 session as a golden test case: feed the plan to the routine and verify it catches the same 6 violations. Create a `tests/` fixture with the plan + expected findings.
Category: Testing strategy | Addresses: Validation

**DT-052** — **Dashboard observability: philosophy findings in Console**
If philosophy findings are stored as structured data (via `planFindings` or a dedicated artifact), the Console UI can show them in the session detail view. This makes philosophy compliance visible across workflow runs.
Category: Observability | Addresses: Long-term value

**DT-053** — **External workflow packaging: philosophy routine in `routines/`**
Package the philosophy routine as `routines/philosophy-alignment.json` alongside existing routines. Follow the same pattern as `routine-plan-analysis`. Makes it reusable across multiple workflows, not just the agentic coding workflow.
Category: Packaging | Addresses: Reusability

**DT-054** — **Compatibility: philosophy principles format versioning**
If philosophy principles are stored in a structured format, they need versioning. What happens when a principle is added/removed/modified mid-workflow? Solution: pin philosophy principles at session start (like workflowHash pins workflow definition).
Category: Compatibility | Addresses: Determinism

**DT-055** — **Performance: lazy philosophy evaluation**
Don't evaluate philosophy on every iteration — only on the LAST iteration (when `planFindings` is empty and loop is about to exit). This makes it a gate, not a recurring cost. Reduces overhead to a single evaluation per workflow run.
Category: Performance | Addresses: Token efficiency

**DT-056** — **Conflict resolution: when philosophy principles contradict each other**
What happens when "YAGNI" conflicts with "exhaustiveness"? The routine needs a conflict resolution protocol: (1) identify the tension, (2) present both sides, (3) recommend based on context, (4) mark as "tension" (yellow) not "violation" (red). The ACEI-1875 session already demonstrates this pattern.
Category: Edge cases | Addresses: Philosophy lens quality

**DT-057** — **Authoring UX: philosophy principles as a Firebender rule file**
Philosophy principles are already defined in `.firebender/` rules. Instead of extracting from `userRules`, read them directly from the Firebender config. This is the canonical source — use it.
Category: Authoring UX | Addresses: Philosophy input

**DT-058** — **Loop correctness: regression check ONLY runs on iterations 2+**
The regression check is meaningless on the first iteration (nothing to regress). Add a runCondition that skips it on iteration 1. Prevents wasted tokens and confusing "nothing to verify" output.
Category: Loop correctness | Addresses: Regression ledger

**DT-059** — **Capability negotiation: detect if philosophy evaluation is reliable**
Add a "philosophy evaluation reliability probe" — a mini-test where the routine evaluates a known-good plan against known violations. If it catches <80% of known violations, downgrade to a simpler checklist mode.
Category: Capability negotiation | Addresses: Reliability

**DT-060** — **Security/policy: philosophy principles shouldn't leak to subagents in delegated contexts**
If philosophy principles contain sensitive organizational values or trade secrets, subagent delegation should filter them. Low risk for personal use but worth noting for future enterprise use.
Category: Security | Addresses: Edge case

### Coverage Map

| Dimension | Coverage | Top DT-IDs |
|-----------|----------|-----------|
| Philosophy lens | HIGH | DT-003, DT-016, DT-039, DT-042 |
| Regression ledger | HIGH | DT-008, DT-023, DT-026, DT-028 |
| Model variability | MED | DT-049, DT-059 |
| Migration/rollout | MED | DT-050 |
| Testing strategy | MED | DT-051 |
| Observability | LOW | DT-052 |
| External packaging | MED | DT-053 |
| Compatibility | LOW | DT-054 |
| Performance | MED | DT-022, DT-055 |
| Conflict resolution | MED | DT-056 |
| Authoring UX | MED | DT-057 |
| Loop correctness | MED | DT-058 |
| Security | LOW | DT-060 |

### Reflection (Round 4)

- **Would regret not exploring**: Testing strategy (DT-051). Without a way to validate the philosophy routine catches real violations, we're shipping blind. The ACEI-1875 session is a natural golden test.
- **Avoided because "too big"**: Dashboard observability (DT-052). Showing philosophy findings in the Console would be valuable but requires Console UI changes — a separate project.
- **Driving assumption**: That the agent CAN reliably evaluate philosophy with good prompting. DT-049 and DT-059 are the only ideas that question this. We should prototype and test before committing to a package.

## Phase 4: Synthesize

### Clusters (7)

**Cluster 1: Standalone Philosophy Routine**
DT-IDs: DT-003, DT-016, DT-053, DT-041
Theme: A new `routine-philosophy-alignment.json` with tiered depth, auto-extracted principles, packaged in `routines/`.
Strength: Clean SRP, reusable across workflows. Weakness: Heaviest option, requires new file + workflow integration.

**Cluster 2: Prompt Engineering (Zero New Files)**
DT-IDs: DT-005, DT-032, DT-034, DT-035, DT-048
Theme: Add mandatory philosophy output sections and self-checking columns to existing prompts. No new routines, no new workflow schema.
Strength: Immediately deployable, minimal risk. Weakness: Relies on agent discipline, no enforcement.

**Cluster 3: Workrail-Native Enforcement**
DT-IDs: DT-004, DT-011, DT-042, DT-020
Theme: Use workrail's `features`, `outputContracts`, and `contract packs` to enforce philosophy compliance via the engine.
Strength: Machine-enforced, not agent-enforced. Weakness: Requires workrail runtime capabilities (features/contracts may not be fully shipped).

**Cluster 4: Philosophy as Invariants (Reframe)**
DT-IDs: DT-012, DT-043, DT-046, DT-044
Theme: Don't create a new concept — make philosophy principles formal invariants. The existing completeness check and hypothesis challenge naturally cover them.
Strength: Elegant reuse, minimal new concepts. Weakness: Conflates technical and design invariants; may dilute both.

**Cluster 5: Regression Prevention**
DT-IDs: DT-008, DT-023, DT-026, DT-028, DT-047, DT-058
Theme: Prevent cross-iteration regression via structured `planFindings`, double-entry tracking, checkpoint-based persistence.
Strength: Addresses sub-problem 2 directly. Weakness: Orthogonal to philosophy lens — must be combined with another cluster.

**Cluster 6: Timing / Placement**
DT-IDs: DT-007, DT-014, DT-022, DT-025, DT-030, DT-055
Theme: When does the philosophy check happen? Before plan (early), during audit (middle), before loop exit (late), or always (ambient).
Strength: Identifies the optimal integration point. Weakness: Not a solution on its own — must be combined.

**Cluster 7: Reliability & Validation**
DT-IDs: DT-049, DT-051, DT-056, DT-059
Theme: How do we validate the philosophy evaluation works? Golden tests, reliability probes, conflict resolution protocols.
Strength: Critical for confidence. Weakness: Meta-concern — doesn't directly solve the problem.

### Candidate Directions (5)

#### Direction 1: "Pragmatic Layered" (Package A + regression)
North Star: Add a mandatory philosophy alignment section to the plan audit prompt, a self-checking philosophy column in the plan template, and structured `planFindings` with resolved tracking. Zero new files, deployable today.

- **Impact**: 4/5 — catches most violations with minimal effort
- **Confidence**: 4/5 — prompt engineering is proven; the ACEI-1875 session shows agents evaluate philosophy well with clear prompts
- **Migration cost**: 1/5 — modify 2 prompts in `coding-task-workflow-agentic.json` + add `resolvedFindings` to context
- **Model-robustness**: 3/5 — depends on agent discipline; no engine enforcement
- **Time-to-value**: 5/5 — deployable in an hour
- **Total**: 17/25

#### Direction 2: "Clean Routine" (Cluster 1 + Cluster 5)
North Star: A standalone `routine-philosophy-alignment.json` with tiered depth (Skim/Standard/Deep), spawned as 4th parallel subagent in THOROUGH, self-audit in STANDARD/QUICK. Plus structured `planFindings` for regression prevention.

- **Impact**: 5/5 — dedicated routine with full coverage; clean SRP
- **Confidence**: 3/5 — new routine needs validation; 4th subagent token cost unknown
- **Migration cost**: 3/5 — new routine file + modify `phase-5b` prompt + modify `planFindings` schema
- **Model-robustness**: 4/5 — structured routine prompt with examples is more robust than ad-hoc prompt sections
- **Time-to-value**: 3/5 — needs routine authoring + testing
- **Total**: 18/25

#### Direction 3: "Philosophy as Invariants" (Cluster 4 + Cluster 5)
North Star: Capture top-5 philosophy principles as formal invariants in Phase 2. The existing plan-analysis completeness check verifies them. Enhanced hypothesis-challenge tests them. No new concept — just more invariants.

- **Impact**: 3/5 — elegant but may dilute technical invariants; limited to top-5 principles
- **Confidence**: 3/5 — untested whether mixing design and technical invariants confuses the audit
- **Migration cost**: 2/5 — modify Phase 2 prompt + modify Phase 5b subagent inputs
- **Model-robustness**: 3/5 — invariants are a familiar concept for agents; but mixing types may reduce quality
- **Time-to-value**: 4/5 — reuses existing infrastructure
- **Total**: 15/25

#### Direction 4: "Workrail-Native" (Cluster 3 + Cluster 5)
North Star: Use workrail's `features` system to inject philosophy content and `outputContract` to enforce structured philosophy artifacts. Engine blocks advancement if philosophy artifact is missing/malformed.

- **Impact**: 5/5 — machine-enforced, not agent-enforced; maximum reliability
- **Confidence**: 2/5 — depends on workrail features/contracts being fully shipped and mature
- **Migration cost**: 4/5 — requires workrail runtime capabilities + new contract pack + feature implementation
- **Model-robustness**: 5/5 — engine enforcement is model-independent
- **Time-to-value**: 2/5 — requires workrail development before workflow changes
- **Total**: 18/25

#### Direction 5: "Defense in Depth" (Package C)
North Star: Three-layer philosophy (ambient metaGuidance + self-checking plan template + dedicated routine) + double-entry regression tracking. Maximum coverage.

- **Impact**: 5/5 — catches violations at every level
- **Confidence**: 3/5 — complex; more moving parts means more failure modes
- **Migration cost**: 4/5 — modify metaGuidance + plan template + new routine + regression tracking
- **Model-robustness**: 4/5 — redundancy helps across models
- **Time-to-value**: 2/5 — most effort to implement
- **Total**: 18/25

### Shortlist (3)

1. **Direction 1: "Pragmatic Layered"** — Best time-to-value, lowest risk, 80% effective. Ship this first.
2. **Direction 2: "Clean Routine"** — Best long-term architecture. Ship this as an upgrade once Direction 1 is validated.
3. **Direction 4: "Workrail-Native"** — Best enforcement guarantees. Ship when workrail features/contracts are mature.

**Recommended approach**: **Direction 1 NOW, Direction 2 NEXT.** Start with the pragmatic prompt changes (zero risk, immediate value). Use real workflow runs to validate effectiveness. Then author the standalone routine for clean long-term architecture. Direction 4 is the north star but depends on workrail evolution.

### Adversarial Challenge

**Argue Direction 1 is wrong:** "Prompt engineering is fragile. Agents ignore mandatory sections when context is long. Without engine enforcement, the philosophy check is just a suggestion the agent can skip when it's rushing. You'll end up maintaining prompt text that agents only follow 60% of the time."

**Strongest alternative:** Direction 4 (Workrail-Native) because engine enforcement is the only way to guarantee compliance. If workrail's `outputContract` can block advancement for missing philosophy artifacts, the agent CAN'T skip it. The counter-argument is timing — Direction 4 requires workrail development that isn't ready yet.

### Decision Gate

**Recommendation**: Implement Direction 1 ("Pragmatic Layered") now. It's zero-risk, immediately deployable, and will generate real data about philosophy violation frequency and agent compliance. Use that data to decide if Direction 2 (standalone routine) is worth the investment.

**Awaiting user confirmation to proceed to Prototype.**

## Synthesis Quality Gate

- ✅ **POV statement**: Present in Phase 2 Define section
- ✅ **3-7 HMW questions**: 7 HMW questions present in Phase 2
- ✅ **Success criteria**: SC-1 through SC-7, measurable with thresholds
- ✅ **Key tensions/tradeoffs**: 4 tensions documented in Phase 2
- ✅ **Idea Backlog breadth**: 58 ideas covering philosophy lens, regression, model variability, migration, testing, observability, packaging, compatibility, performance, conflict resolution, authoring UX, loop correctness, security
- ✅ **Shortlist (2-3)**: 3 shortlisted directions with risks and migration cost scored
- ✅ **Falsifiable learning question for top direction**: "Does the agent reliably fill the mandatory philosophy alignment section in ≥80% of workflow runs?" (If <80%, Direction 1 is insufficient and Direction 4 with engine enforcement is needed)

**RESULT: PASS** — All checklist items satisfied. Ready for prototyping.

## Decision Log (append-only)

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| DT-001 | Scope: audit phase only, not full workflow redesign | Problem is localized to the audit gap; broader changes are out of scope | 2026-03-05 |
| DT-002 | Two sub-problems: philosophy lens + regression ledger | These are orthogonal issues that surfaced together but have different solutions | 2026-03-05 |
| DT-003 | Philosophy lens scope: design quality only, not plan consistency | Thought experiment showed 2/6 ACEI-1875 "missed" violations are completeness concerns | 2026-03-05 |
| DT-004 | Direction 1 (Pragmatic Layered) as base, Direction 2 as THOROUGH upgrade | Routines only run in THOROUGH mode; prompt-based covers all 3 modes | 2026-03-05 |
| DT-005 | IMPLEMENTED: 4 changes to coding-task-workflow-agentic.json | Philosophy alignment section (5b), self-check columns (5a), resolved findings ledger (5c), regression check (5b) | 2026-03-05 |

## Pre-mortem & Falsification

### Pre-mortem (Top 5)

| # | Failure Mode | Why It Happens | Mitigation |
|---|-------------|----------------|------------|
| 1 | Agent ignores mandatory philosophy section | Context window is full; agent prioritizes "real" audit over philosophy section; no engine enforcement | Keep the section short (5-10 lines required); position it as the FIRST output section (not last); add a self-check reminder |
| 2 | Philosophy findings are vague/generic ("code looks good") | Prompt doesn't provide enough structure; agent doesn't have concrete principle examples | Include 2-3 example violations from ACEI-1875 as few-shot anchors in the prompt |
| 3 | Regression ledger becomes stale/inconsistent | Agent forgets to update `resolvedFindings`; context variable exceeds size limits | Cap at 10 resolved items (FIFO); make the update explicit in the refocus step prompt |
| 4 | Philosophy evaluation adds 30+ minutes to THOROUGH audits | 4th subagent (future Direction 2) doubles the audit cost; user disables it | Start with Direction 1 (prompt-only, ~5% overhead); defer routine to validated need |
| 5 | Self-checking plan columns are always marked "satisfied" | Agent rubber-stamps its own work; self-audit has inherent conflict of interest | Track compliance rate; if >95% "satisfied" across runs, the self-check is not working — escalate to Direction 2 (independent routine) |

### Falsification Criteria (3)

1. **If the agent fills the philosophy alignment section with substantive findings in <50% of workflow runs** (measured over 5+ runs), we will **pivot to Direction 2** (standalone routine) because prompt-based requirements are insufficient for reliable compliance.

2. **If cross-iteration regression occurs again despite the `resolvedFindings` ledger** (measured over 3+ multi-iteration runs), we will **escalate to checkpoint-based regression** (DT-047) because context-variable-based tracking is unreliable.

3. **If the philosophy section catches fewer than 2 violations per 5 runs** (on plans where manual `/philosophy` would catch violations), we will **investigate whether the prompt needs few-shot examples** (DT-049) before concluding the feature is unnecessary.

### Reflection

- **Most dangerous second-order effect**: The agent starts treating the philosophy section as a checkbox to fill rather than a genuine evaluation. This creates a false sense of coverage — the user stops running manual `/philosophy` because the workflow "already does it," but the workflow's version is shallow.
- **What we'd regret not testing**: Whether the prompt-based philosophy section catches the SAME violations that manual `/philosophy` found in ACEI-1875. If it misses the red violations, it's worse than useless (false confidence).

### Proceed to Prototype: CONFIRMED

Direction 1 ("Pragmatic Layered") is ready for prototyping with clear falsification criteria.

## Prototype Spec

### Prototype type: Concierge Script (end-to-end flow)

### Learning question
"Can a mandatory prompt section + self-checking plan template + structured `planFindings` schema reliably catch philosophy violations that manual `/philosophy` would catch?"

### Falsification criteria (from Phase 4B)
1. <50% substantive fill rate over 5+ runs → pivot to Direction 2
2. Regression despite `resolvedFindings` ledger over 3+ multi-iteration runs → escalate to checkpoint-based
3. <2 violations per 5 runs where manual `/philosophy` would find them → investigate prompt quality

### Prototype artifact: 3 concrete changes to `coding-task-workflow-agentic.json`

#### Change 1: Mandatory Philosophy Alignment section in Phase 5b audit prompt

Add to the END of `phase-5b-plan-audit-mode-adaptive` prompt, before the CLEAN-SLATE CHECK:

```
---

**PHILOSOPHY ALIGNMENT CHECK (mandatory, all modes):**

Review the plan against the user's coding philosophy/design principles from `userRules`.

**Required output format** (append to planFindings):
For each violation or tension found:

| Principle | Violation | Severity | Action |
|-----------|-----------|----------|--------|
| [Principle name from userRules] | [What violates it and why] | Red (blocking) / Orange (design quality) / Yellow (tension) | [Specific fix or justification needed] |

Rules:
- Check: immutability, error handling model, test doubles strategy, dead code, naming clarity, abstraction level, type safety, exhaustiveness
- Red = must fix before implementation
- Orange = should fix; document if intentionally accepted
- Yellow = tension between principles; document the tradeoff
- If NO violations found: explicitly state "Philosophy check: no violations found" with brief evidence (e.g., "error handling uses Result<T> per philosophy; test doubles are fakes not mocks")
- Do NOT rubber-stamp. If you find zero violations on a non-trivial plan, double-check naming, dead code, and abstraction choices.

Include philosophy findings in `planFindings` alongside correctness findings.
```

#### Change 2: Self-checking philosophy column in Phase 5a plan template

Add to the "Vertical slices" section of `phase-5a-draft-implementation-plan` prompt:

```
For each slice, include:
...existing fields...
- **Philosophy alignment**: For each philosophy principle touched by this slice, note: [principle] → [satisfied/tension/violated + 1-line why]
```

#### Change 3: Structured `resolvedFindings` for regression prevention

Add to `phase-5c-refocus-and-ticket-extraction` prompt:

```
**RESOLVED FINDINGS LEDGER (required):**

When applying amendments, maintain `resolvedFindings` context variable:
- For each finding resolved in this iteration, add: { finding: "...", resolution: "...", iteration: N }
- Cap at 10 entries (FIFO if exceeded)
- This ledger carries forward to the next audit pass

Set: `resolvedFindings` (array)
```

Add to `phase-5b-plan-audit-mode-adaptive` prompt (before the main audit):

```
**REGRESSION CHECK (iteration 2+, if resolvedFindings is non-empty):**

Before running forward-looking audit, verify each item in `resolvedFindings`:
- Is the resolution still valid in the current plan?
- Has the amendment been reverted or contradicted?

If ANY regression found: add to `planFindings` with severity "Red" and note "REGRESSION: previously resolved finding reverted."
```

### Smallest shippable slice
Change 1 alone (mandatory philosophy section in audit prompt). This is a single prompt edit — ~20 lines added to one step in the workflow JSON. Zero risk, immediately testable.

### Highest-risk assumption
That the agent will fill the philosophy section with substantive, specific findings rather than rubber-stamping "no violations found." The few-shot examples and anti-rubber-stamp instruction mitigate this, but it's still the biggest risk.

### If falsification triggers
Next direction is Direction 2 ("Clean Routine") — a standalone `routine-philosophy-alignment.json` with tiered depth, spawned as a 4th subagent. This provides independent evaluation (no self-audit conflict of interest) and structured prompting.

## Test Plan

### Learning question
Does the mandatory philosophy alignment section in `phase-5b` reliably catch design quality violations that manual `/philosophy` would catch?

### Test scenarios

**T1: Golden test — replay ACEI-1875 plan**
- Feed the ACEI-1875 implementation plan through the modified workflow
- Expected: catches ≥4 of the 6 violations found by manual `/philosophy` (fakes-over-mocks, dead code, stale AC, fetchGleamCount naming, boolean routing, arch-over-patches)
- Pass criteria: ≥4/6 caught with correct principle attribution
- Model: Claude (Firebender)

**T2: Clean plan — verify no false positives**
- Run a genuinely philosophy-compliant plan through the workflow
- Expected: "Philosophy check: no violations found" with brief evidence
- Pass criteria: no phantom violations; evidence shows actual inspection
- Model: Claude (Firebender)

**T3: Multi-iteration regression test**
- Iteration 1: audit finds a violation, resolution is applied
- Iteration 2: amendment inadvertently reverts the resolution
- Expected: regression check catches the reversion and adds to `planFindings`
- Pass criteria: regression detected and marked "Red" severity
- Model: Claude (Firebender)

**T4: Cross-model robustness**
- Run T1 equivalent using a weaker model (e.g., GPT-4o or Gemini 2.0 Flash)
- Expected: catches ≥3/6 violations (lower bar for weaker model)
- Pass criteria: structured output format is maintained; findings are specific (not generic)
- Model: GPT-4o or Gemini via alternative IDE/MCP client

**T5: QUICK mode — verify minimal overhead**
- Run a simple task (Small complexity, QUICK rigor) with the modified workflow
- Expected: philosophy section is present but brief (3-5 lines); total audit time increases <10%
- Pass criteria: section is not empty; overhead is acceptable
- Model: Claude (Firebender)

### Agents/models/IDEs to test
- **Primary**: Claude Opus 4 via Firebender (this is the production environment)
- **Secondary**: GPT-4o via alternative MCP client (cross-model robustness)
- **Stretch**: Gemini 2.0 Flash (low-end model stress test)

### Success metrics (across 5+ production runs)
- **Philosophy section fill rate**: ≥80% of runs have substantive content (not just "no violations")
- **Violation detection rate**: ≥70% of violations that manual `/philosophy` would catch
- **False positive rate**: <1 false positive per run on average
- **Regression detection**: 100% of deliberate regressions caught in test scenarios
- **Overhead**: <5% token increase in QUICK, <15% in STANDARD, <25% in THOROUGH

### Failure response
- **If T1 fails** (<4/6 violations caught): Add few-shot examples from ACEI-1875 directly into the prompt. Re-test. If still failing, pivot to Direction 2 (standalone routine with dedicated, longer prompt).
- **If T3 fails** (regression not caught): Investigate whether `resolvedFindings` is being properly maintained. If context variable approach is unreliable, escalate to checkpoint-based regression (DT-047).
- **If T4 fails** (cross-model failure): The philosophy section may need more explicit structure for weaker models. Consider a numbered checklist format instead of open-ended evaluation. If still failing on weaker models, accept Claude-only for now and note as a Direction 2 motivation.
- **If T5 fails** (too much overhead in QUICK): Make the philosophy section conditional: full in STANDARD+, abbreviated (top-3 principles only) in QUICK.

### Dogfood plan
1. Apply Change 1 only to `coding-task-workflow-agentic.json`
2. Run 3 real coding tasks through the workflow (mix of Small/Medium/Large)
3. After each run, manually run `/philosophy` and compare findings
4. Record: fill rate, detection rate, false positives, overhead
5. If metrics pass: apply Changes 2 and 3
6. Run 2 more tasks with all 3 changes
7. Evaluate regression prevention specifically

## Iteration Notes

### Iteration 1: Thought Experiment + Adversarial Critique

#### Test method
Adversarial thought experiment: mentally walk through the prototype changes against a real scenario (ACEI-1875) and simulate stakeholder Q&A.

#### ACEI-1875 Replay (Thought Experiment)

**Setup**: The plan proposes `RealGleamCountRepository` with feature-flag routing between PubNub direct and backend-driven gleam count. The audit step now includes the mandatory philosophy alignment section.

**Simulated philosophy section output**:

| Principle | Violation | Severity | Action |
|-----------|-----------|----------|--------|
| Fakes over mocks | `UseBackendGleamCountFeature` needs a test double; plan implies mockk | Red | Add `FakeUseBackendGleamCountFeature` |
| YAGNI / Dead code | `RealLiveUnreadCountRepository` kept with no DI binding; dormant class | Orange | Delete it; flag-off scenarios in new repo tests cover it |
| Errors as data | `fetchGleamCount()` uses null as error channel via `getOrNull()` | Yellow | Rename to `fetchGleamCountOrNull()` for clarity |
| Exhaustiveness | Boolean flag routing in `gleamSignals()` | Yellow | Accept for 2-case; document as seam for future strategy |

**Result**: 4 of 6 violations caught (matches T1 pass threshold of ≥4/6). The 2 missed:
- **Stale AC** (line 20): This is a plan CONSISTENCY issue, not a philosophy violation. The philosophy section shouldn't be expected to catch this — it's a completeness concern (plan-analysis should catch it).
- **Arch-over-patches** (whole ticket is a workaround): This is an architectural framing issue, not a plan design violation. The philosophy section could catch it but it's context-dependent.

**Assessment**: 4/6 is realistic. The 2 misses are correctly outside the philosophy lens scope.

#### Adversarial critique

**Critic**: "The self-checking philosophy columns in the plan template (Change 2) are pure theater. The agent writing the plan is the same agent checking the plan. It will always say 'satisfied' because admitting a violation means admitting its own design is flawed."

**Response**: Fair criticism. The self-check IS weaker than independent audit. However:
1. It forces the agent to THINK about philosophy during drafting (anchoring effect)
2. The Phase 5b audit checks the self-check columns against its own evaluation (independent review of the self-check)
3. If rubber-stamping is detected (>95% "satisfied"), we escalate to Direction 2

**Critic**: "The `resolvedFindings` context variable will get corrupted. Agents will add incorrect entries, forget to update them, or the context will exceed size limits."

**Response**: Valid risk. Mitigations:
1. Cap at 10 entries (FIFO) — bounds the size
2. Explicit prompt in Phase 5c tells the agent exactly when/how to update
3. If corruption is observed, escalate to checkpoint-based regression (DT-047)

#### Stakeholder Q&A simulation

**Q (Etienne)**: "Will this make the workflow noticeably slower?"
**A**: Change 1 adds ~200 tokens to the audit prompt. The agent needs to evaluate ~10 philosophy principles against the plan. Estimated overhead: <5% in QUICK (principles skimmed), <10% in STANDARD (principles checked), <15% in THOROUGH (principles challenged). Well within SC-5 thresholds.

**Q (Etienne)**: "Does this replace the need for `/philosophy`?"
**A**: For plan-phase violations, yes. But `/philosophy` can also evaluate implementations (code), not just plans. The workflow change covers plan-time; implementation-time philosophy evaluation is a future enhancement.

**Q (Etienne)**: "What if I update my philosophy?"
**A**: Philosophy principles live in `userRules` (from Firebender rules). When you update your Firebender rules, the next workflow run automatically picks up the changes. No pinning needed for Direction 1 (unlike workflowHash pinning in v2).

#### Feedback summary

| Finding | Type | Impact | Action |
|---------|------|--------|--------|
| 4/6 violation detection in thought experiment | Positive | Meets T1 threshold | Proceed as planned |
| Self-check columns have conflict of interest | Risk | Medium | Monitor; escalate to Direction 2 if rubber-stamping detected |
| `resolvedFindings` corruption risk | Risk | Medium | Cap at 10, explicit update prompt, checkpoint fallback |
| Stale AC is a completeness issue, not philosophy | Insight | Scope clarification | Don't expect philosophy section to catch plan consistency issues |
| Overhead estimate <15% even in THOROUGH | Positive | Meets SC-5 | No changes needed |

#### Amendments to prototype
- **Amendment 1**: Add a note in the philosophy section prompt: "Philosophy alignment evaluates DESIGN QUALITY, not plan consistency. Stale ACs, missing requirements, and coverage gaps are covered by the completeness audit."
- **Amendment 2**: In the self-check columns prompt, add: "The audit step will independently verify these self-assessments. Be honest — violations caught early are cheaper than violations caught in review."

### Iteration 1: Updates (Learn & Update Artifacts)

#### Changes made
- **POV**: No change. Still valid.
- **HMW**: No change. All 7 HMW questions remain relevant.
- **Shortlist**: No change. Direction 1 remains top recommendation. The thought experiment validates it.
- **Prototype spec/artifact**:
  - **Change 1 amended**: Added scope clarification ("evaluates DESIGN QUALITY, not plan consistency")
  - **Change 2 amended**: Added honesty prompt ("audit step will independently verify")
  - **T1 threshold clarified**: 4/6 is the pass bar, with 2 misses correctly outside scope (completeness, not philosophy)

#### Rationale
- The scope clarification prevents the philosophy section from being blamed for not catching plan consistency issues (stale ACs, missing requirements). This is plan-analysis's job.
- The honesty prompt in self-check addresses the conflict-of-interest risk identified in adversarial critique. It won't eliminate rubber-stamping but creates accountability.

#### Decision Log entry
DT-003: Philosophy lens scope boundary confirmed — design quality only, not plan consistency | Thought experiment showed 2/6 "missed" violations are actually completeness concerns | 2026-03-05

#### Reflection
- **Surprised by**: The philosophy lens has a CLEAR scope boundary. It's not a catch-all quality check — it specifically evaluates design principles. Plan consistency (stale ACs), requirement coverage, and architectural framing are separate concerns handled by existing routines. This makes the integration cleaner than expected.
- **Previously believed that is now false**: Initially assumed the philosophy section should catch ALL 6 ACEI-1875 violations. In reality, 2 of the 6 belong to other audit lenses. This means 4/6 (67%) detection is actually 4/4 (100%) within scope.

#### Next Input Checklist
- ✅ Prototype validated via thought experiment
- ✅ Amendments applied
- ✅ Scope boundary documented
- Ready for loop exit decision

### Iteration 2: Blind Spot Audit (what did iteration 1 miss?)

#### Test method
Audit the prototype for what the iteration 1 thought experiment didn't test.

#### Areas audited

**1. Interaction between philosophy section and existing `planFindings`**
- In the prototype, philosophy findings flow into the existing `planFindings` variable
- Question: will this cause the loop to never exit? If philosophy always finds SOMETHING, `planFindings` is never empty
- Answer: The prompt says "If NO violations found: explicitly state 'no violations found'" — so zero-philosophy-findings produces an explicit statement, not an entry in `planFindings`. Philosophy findings that ARE present go into `planFindings` and are treated like any other finding (resolved in 5c, verified in next pass).
- Status: **No issue** — the interaction is clean

**2. Loop exit condition with philosophy findings**
- `phase-5d` exits when `planFindings` is empty
- If philosophy finds 2 yellow tensions that are "accept and document" type, do they count as `planFindings`?
- Answer: Yellow "tensions" should NOT block the loop. They're informational. Only Red/Orange should go into `planFindings`.
- **Amendment needed**: Clarify in the prompt: "Add Red and Orange violations to `planFindings`. Yellow tensions should be documented but do NOT block loop exit."

**3. STANDARD mode behavior**
- In STANDARD, the audit delegates ONCE (plan-analysis). The philosophy section is in the MAIN audit prompt, not the routine prompt.
- Question: does the single-delegation model still trigger the philosophy check?
- Answer: Yes — the philosophy section is in the phase-5b step prompt, which the MAIN agent executes. Delegation to plan-analysis is for completeness/patterns. The main agent does the philosophy check as part of its self-audit synthesis.
- Status: **No issue** — works correctly in STANDARD

**4. What if `userRules` doesn't contain philosophy principles?**
- Some users might not have philosophy rules in their Firebender config
- Answer: The prompt says "Review the plan against the user's coding philosophy/design principles from `userRules`." If `userRules` is empty or has no philosophy content, the agent should output "No philosophy principles found in userRules — skipping philosophy alignment check."
- **Amendment needed**: Add graceful degradation: "If no philosophy/design principles are found in `userRules`, skip this section and note 'No philosophy principles configured.'"

#### Feedback summary

| Finding | Type | Impact | Action |
|---------|------|--------|--------|
| Yellow tensions shouldn't block loop exit | Bug | Medium | Amend prompt: only Red/Orange go into `planFindings` |
| Missing userRules graceful degradation | Gap | Low | Amend prompt: skip if no principles found |
| planFindings interaction is clean | Positive | — | No change needed |
| STANDARD mode works correctly | Positive | — | No change needed |

#### Amendments to prototype
- **Amendment 3**: Add to philosophy section: "Add Red and Orange violations to `planFindings`. Yellow tensions: document in output but do NOT add to `planFindings` (they are informational, not blocking)."
- **Amendment 4**: Add graceful degradation: "If no philosophy/design principles are found in `userRules`, skip this section and note 'No philosophy principles configured.'"

### Iteration 2: Updates (Learn & Update Artifacts)

#### Changes made
- **POV**: No change.
- **HMW**: No change.
- **Shortlist**: No change. Direction 1 further validated — edge cases found and resolved.
- **Prototype spec/artifact**:
  - **Change 1 (philosophy section prompt)** now includes all 4 amendments:
    1. Scope: "evaluates DESIGN QUALITY, not plan consistency"
    2. Severity routing: "Red/Orange → `planFindings`; Yellow → documented only, not blocking"
    3. Graceful degradation: "skip if no philosophy principles in `userRules`"
    4. Anti-rubber-stamp honesty clause
  - **Change 2 (self-check columns)** now includes honesty prompt

#### Rationale
- Amendment 3 (Yellow not blocking) prevents infinite loop: yellow tensions are common in well-designed code (e.g., YAGNI vs exhaustiveness). If they block the loop, every run takes 5 iterations.
- Amendment 4 (graceful degradation) makes the feature safe for all users, not just those with philosophy in their rules.

#### Reflection
- **Surprised by**: The severity-routing issue (Yellow blocking the loop) would have been a real production bug. It's subtle — philosophy tensions are inherent in good design, and they'd create false positives that keep the loop running.
- **Previously believed false**: That ALL philosophy findings should go into `planFindings`. Now clear that only actionable findings (Red/Orange) should block; tensions (Yellow) are informational.

#### Next Input Checklist
- ✅ All 4 amendments integrated into prototype
- ✅ No remaining open questions
- ✅ Ready for loop exit

## Counters

- Next DT ID: DT-006
