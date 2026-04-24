# Workflow Modernization Design

**Status:** Active  
**Created:** 2026-04-20  
**Updated:** 2026-04-23 (Phase 0 third run -- repo state re-verified; no material changes since second run)  
**Owner:** WorkTrain daemon session (shaping)

---

## Artifact Strategy

**This document is for human readability only.** It is NOT required workflow memory. If a chat rewind occurs, the durable record lives in:
- WorkRail step notes (notesMarkdown in each `complete_step` call)
- Explicit context variables passed between steps

Do not treat this file as the source of truth for what step the session is on, what decisions have been made, or what constraints apply. Those live in the session notes.

This file is maintained alongside the session as a readable summary of findings and decisions. It may lag behind the session notes slightly.

### Capability status (re-verified Phase 0b, third session, 2026-04-23)

| Capability | Available | How verified | Notes |
|---|:---:|---|---|
| Web browsing | YES | `curl https://example.com` returned HTML (5s timeout) | Confirmed each session. Available via curl; no dedicated browser tool needed |
| Delegation (spawn_agent) | YES | `spawn_agent` with `wr.classify-task` returned `{childSessionId: "sess_3x6t6lyz...", outcome: "success"}` -- mechanism confirmed again this session | `wr.classify-task` is the correct probe (1 step, always completes). Child classified the task as Small/Low-risk/investigation correctly. |
| Git / GitHub CLI | YES | `gh pr list`, `git log`, `gh issue view 174` working throughout session | No issues |

**Capability decisions:**
- **Web browsing:** Available but not needed. All evidence for this task is in-repo (workflow files, schema, planning docs, session store usage data). No external references needed. Fallback to in-repo data is fully sufficient.
- **Delegation:** Mechanism is confirmed available (wr.classify-task probe succeeded, childSessionId: sess_3x6t6lyz, outcome: success). Whether to use it is a per-step judgment. For design/synthesis work (Phase 0/0b), delegation adds overhead without benefit -- the main agent owns synthesis by rule. For independent parallel audits in later phases (e.g. gap-scoring multiple workflows simultaneously), delegation reduces latency and is appropriate. Decision deferred to per-step judgment in downstream phases.

---

## Context / Ask

**Stated goal (original):** "Legacy workflow modernization -- `exploration-workflow.json` is the highest-priority candidate."

**Why this was a solution statement, not a problem statement:**
The original framing prescribes the fix (modernize specific files) and even names the approach (migrate to v2/lean patterns). It does not describe what is wrong with agent outputs or why those outputs are suboptimal.

**Critical factual finding from goal challenge:**
The stated #1 candidate (`workflows/exploration-workflow.json`) no longer exists. It was modernized in commit `f27507f4` (Mar 27) and then consolidated into `wr.discovery.json` in commit `a0ddaaac` (Mar 29). The planning docs (`docs/tickets/next-up.md`, `docs/roadmap/open-work-inventory.md`) were not updated and are stale.

**Reframed problem statement:**
Agents running several bundled workflows produce lower-quality outputs than they should because those workflows lack structural features (loop-control, evidence-gating, notes-first durability, assessment gates) that the current engine supports -- and the planning documents pointing to this work are themselves stale and misdirected.

---

## Path Recommendation

**Chosen path: `design_first`**

Rationale (justified against alternatives):
- **vs. `landscape_first`:** Landscape data was already available in-repo (workflow files, gap scores in prior session notes). Running a landscape-first pass would re-derive what we already have. The dominant risk is NOT "we don't know what's out there" -- it is "we pick the wrong candidates or wrong unit of work."
- **vs. `full_spectrum`:** Full spectrum adds reframing work on top of landscape + design. The reframing was already done in the goal-challenge step (`goalWasSolutionStatement = true`, reframed problem captured). No additional reframing needed; the design question is sharp enough.
- **`design_first` is correct because:** the primary decision to resolve is: (A) which candidates deserve assessment-gate redesign vs. cosmetic migration, and (B) whether planning doc correction is a prerequisite gate or can be done in parallel with workflow work. These are design/sequencing questions, not landscape gaps.
- The existing `docs/plans/workflow-modernization-design.md` (this file) from the prior session provides the landscape packet already. Phase 0's job is to correct errors in that packet, finalize the path, and set up the direction decision for Phase 1.

---

## Constraints / Anti-goals

**Core constraints:**
- Do not modify `src/daemon/`, `src/trigger/`, `src/v2/`, `triggers.yml`, or `~/.workrail/daemon-soul.md`
- All workflow changes must pass `npx vitest run tests/lifecycle/bundled-workflow-smoke.test.ts` (currently 37/37)
- All workflows must validate via `npm run validate:registry` (no structural regressions)
- No new markdown documentation files unless explicitly authorized
- Each modernized workflow needs a GitHub issue before implementation begins
- Never push directly to main -- branch + PR

**Anti-goals:**
- Do NOT treat stamping (`npm run stamp-workflow`) as a proxy for behavioral improvement
- Do NOT modernize workflows that are currently working well enough and rarely used (unknown usage data)
- Do NOT scope-creep into engine changes or authoring-spec changes during workflow migration
- Do NOT treat `recommendedPreferences` and `features` field addition as sufficient for "done"
- Do NOT preserve legacy step structures that are architecturally wrong -- if a workflow needs redesign, name it as redesign not modernization

---

## Landscape Packet

### Current workflow inventory (corrected -- Phase 1c, 2026-04-21)

> **CRITICAL CORRECTION FROM PRIOR VERSION:** The prior landscape incorrectly identified `wfw.v2.json` and `coding-task` as having orphaned (unused) assessment gates. The orphan check did not recurse into loop body steps. A recursive check confirms ALL declared assessments in ALL workflows are properly wired. There are ZERO orphaned assessment gates in the repo.

> **Phase 1c scan methodology:** Full recursive walk of steps + loop bodies. Fields checked: `metaGuidance`, `recommendedPreferences`, `features`, `references`, `validatedAgainstSpecVersion`, and functional assessment gates (declared + referenced without broken refs). Loop body assessment refs counted correctly.

**Summary counts:**
- Workflows WITH functional assessment gates: **7** (bug-investigation, coding-task, mr-review, test-artifact-loop-control, wfw, wfw.v2, wr.shaping)
- Workflows WITHOUT functional assessment gates: **17**
- Missing `recommendedPreferences`: **11**
- Missing `references`: **21** (all but wfw, wfw.v2, wr.production-readiness-audit)
- Missing `validatedAgainstSpecVersion`: **19**

| Workflow | MG | RP | Feat | Refs | Stamp | Gates | Steps |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `wr.adaptive-ticket-creation.json` | Y | N | N | N | N | **N** | 8 |
| `wr.architecture-scalability-audit.json` | Y | Y | Y | N | N | **N** | 7 |
| `bug-investigation.agentic.v2.json` | Y | Y | N | N | N | **Y** | 9 |
| `wr.classify-task.json` | Y | Y | N | N | Y | N | 1 |
| `wr.coding-task.json` | Y | Y | N | N | N | **Y** | 14 |
| `wr.cross-platform-code-conversion.v2.json` | Y | Y | N | N | N | N | 14 |
| `wr.document-creation.json` | Y | N | N | N | N | **N** | 8 |
| `wr.documentation-update.json` | Y | N | N | N | N | **N** | 6 |
| `wr.intelligent-test-case-generation.json` | Y | N | N | N | N | **N** | 6 |
| `learner-centered-course-workflow.json` | Y | N | N | N | N | N | 11 |
| `mr-review-workflow.agentic.v2.json` | Y | Y | Y | N | N | **Y** | 7 |
| `wr.personal-learning-materials.json` | Y | N | N | N | N | N | 6 |
| `wr.presentation-creation.json` | Y | N | N | N | N | N | 5 |
| `wr.production-readiness-audit.json` | Y | Y | Y | Y | N | **N** | 7 |
| `wr.relocation-us.json` | Y | Y | N | N | N | N | 9 |
| `wr.scoped-documentation.json` | Y | N | N | N | N | N | 5 |
| `test-artifact-loop-control.json` | Y | N | N | N | N | Y | 3 |
| `test-session-persistence.json` | N | N | N | N | N | N | 5 |
| `wr.ui-ux-design.json` | Y | Y | Y | N | Y | N | 8 |
| `wr.diagnose-environment.json` | N | N | N | N | N | N | 2 |
| `wr.workflow-for-workflows.json` | Y | Y | Y | Y | Y | **Y (3 in body)** | 11 |
| `wr.discovery.json` | Y | Y | Y | N | Y | N | 22 |
| `wr.shaping.json` | Y | Y | N | N | N | **Y** | 9 |

**Working examples for assessment gate patterns:**
- `wr.shaping.json` -- cleanest: 1 dimension per assessment, `low`/`high` levels, `require_followup` on `low`; uses top-level `assessments` + step `assessmentRefs` + `assessmentConsequences`
- `wr.coding-task.json` -- 3 gated steps (design, plan, verification), multi-assessment per step, gates in loop `body` steps
- `mr-review-workflow.agentic.v2.json` -- 3 refs on a single final validation step with `require_followup`
- `wr.workflow-for-workflows.json` -- gates in loop `body` field (not `loop.steps`); correct pattern for loop-body gates

**Current smoke test baseline:** 36/36 (re-verified 2026-04-23 third session)

### Key landscape observations (corrected Phase 1c third session, 2026-04-23)

> **CRITICAL CORRECTION (third session):** All prior landscape scans used `loop.steps` to find loop body steps. The correct field in the current schema is `body` (not `loop.steps`). Every workflow with loops uses `body`. This means prior gate counts for workflows with loops were undercounted. Corrected counts:
> - `wr.workflow-for-workflows.json`: **3 steps** with assessment refs (in `body` of `phase-6-quality-gate-loop`) -- not 0
> - `wr.coding-task.json`: **3 steps** with assessment refs (in `body`) -- not 2
> - All other workflows: corrected counts verified below

**Corrected gate step counts (using `body` field correctly):**

| Workflow | Gate steps | Gate step IDs |
|---|:---:|---|
| `wr.adaptive-ticket-creation` | 1 | phase-5-batch-tickets |
| `wr.bug-investigation` | 1 | phase-5-diagnosis-validation |
| `wr.coding-task` | **3** | phase-1c-challenge-and-select, phase-3-plan-and-test-design, phase-7b-fix-and-summarize |
| `wr.mr-review` | 1 | phase-5-final-validation (3 refs) |
| `wr.shaping` | 2 | frame-gate, breadboard-and-elements |
| `wr.workflow-for-workflows` | **3** | phase-6a-state-economy-audit, phase-6b-execution-simulation, phase-6c-adversarial-quality-review |
| `test-artifact-loop-control` | 1 | complete |
| All others | 0 | -- |

1. **Two prompt formats coexist:** `promptBlocks` (structured object with goal/constraints/procedure/verify) and raw `prompt` string. The authoring spec recommends `promptBlocks`. Not all "modern" workflows use it consistently.

2. **`exploration-workflow.json` is gone:** Absorbed into `wr.discovery.json`. Planning docs must be corrected before any implementation work begins.

3. **Several "candidates" from open-work-inventory also no longer exist:** `mr-review-workflow.json`, `bug-investigation.json`, `design-thinking-workflow.json` -- all absorbed or renamed. The list in `open-work-inventory.md` is materially stale.

4. **Assessment gates are the biggest behavioral differentiator:** 7 workflows have functional assessment gates (6 production-relevant + 1 test). The rest have no engine-enforced quality checkpoints.

5. **`wr.workflow-for-workflows.json` DOES have functional assessment gates** -- 3 steps in the loop body (`phase-6a`, `phase-6b`, `phase-6c`) carry assessment refs. All 4 declared gates are referenced and wired. Prior scan missed these because it looked for `loop.steps` instead of `body`.

6. **`recommendedPreferences` is a common gap:** ~11 workflows are missing it. Easy to add, genuine behavioral improvement.

7. **`references` is almost universally missing:** Only a few workflows have it. This is cosmetic -- references are informational, not enforced.

8. **The "unstamped" list from `validate:registry` is cosmetic advisory only** -- names 14 unstamped workflows; stamping alone is not a quality improvement goal.

9. **`wr.production-readiness-audit.json` has no assessment gates** -- despite being a review workflow with a clear audit focus (`phase-5-final-validation` exists), it declares no `assessments` and no `assessmentRefs`. This is a confirmed behavioral gap on a high-value workflow.

10. **`wr.coding-task` has 3 gated steps across the lifecycle (design, plan, and verification)** -- not 2 as prior scans reported. This is a richer quality-gate structure than previously understood.

### Phase 1c hard-constraint findings (engine/schema reality checks)

**Assessment gate mechanism (confirmed from schema + engine source):**
- Schema: `assessments` is a top-level array on the workflow; each entry has `id` and `dimensions[]`
- Step field: `assessmentRefs` (plural array of assessment IDs) + optional `assessmentConsequences` (at most one per step)
- Engine: `require_followup` consequence is genuinely enforced -- `assessment-consequence-event-builder.ts` emits a blocking event
- Rule `assessment-v1-constraints` (required level): a step MAY have multiple assessmentRefs; at most one assessmentConsequences; trigger uses `anyEqualsLevel`
- Rule `assessment-use-for-bounded-judgment` (recommended level): use when step needs bounded judgment before workflow can safely advance
- **IMPORTANT:** `assessmentRefs` is defined ONLY on `standardStep` (not `loopStep`). Loop body steps ARE standard steps and CAN have assessmentRefs. Only the loop container step itself cannot.

**Valid `recommendedPreferences` values (from schema enum):**
- `recommendedAutonomy`: `guided` | `full_auto_stop_on_user_deps` | `full_auto_never_stop`
- `recommendedRiskPolicy`: `conservative` | `balanced` | `aggressive`
- Pattern for review/audit workflows: `guided` + `conservative`

**Valid `features` values (closed set, from feature-registry.ts):**
- `wr.features.memory_context`
- `wr.features.capabilities`
- `wr.features.subagent_guidance`
- Only `wr.features.subagent_guidance` is used by modern baselines; only declare when actually applicable

**Precedent patterns from working examples (`wr.shaping.json` is the cleanest):**
- Declare assessment at workflow level: `{ id: "frame-soundness", dimensions: [{ id: "frame_soundness", ... }] }`
- Reference from step: `assessmentRefs: ["frame-soundness"]`
- Add consequence: `assessmentConsequences: [{ when: { anyEqualsLevel: "low" }, effect: { kind: "require_followup", guidance: "..." } }]`
- Each assessment has one dimension in the clean examples; multiple dimensions are valid but must be orthogonal

---

## Problem Frame Packet

### Stakeholders and jobs

**Stakeholder 1: Project owner (Etienne)**
- *Job to be done:* Maintain a catalog of reliable, high-quality bundled workflows that make autonomous daemon sessions (full-pipeline, implement, mr-review) produce better outputs with less rework.
- *Pain:* Planning docs reference deleted files. "Modernization" tasks are in the queue but it's unclear which ones are worth doing vs. which are documentation hygiene.
- *Constraint:* Active focus is on engine/daemon/console layer (recent commits). Workflow authoring work competes for bandwidth.

**Stakeholder 2: Autonomous agents (daemon sessions)**
- *Job to be done:* Complete coding tasks, reviews, discovery, and shaping with high output quality and minimal wasted iterations.
- *Pain:* Workflows with no assessment gates have no engine-enforced quality checkpoints. All verification is prose-only -- the engine cannot block advancement on poor outputs.
- *Constraint:* Agents only run the workflows they're spawned with. The 4 production workflows are what matter.

**Stakeholder 3: Future workflow authors**
- *Job to be done:* Write new workflows modeled on existing bundled ones. Bad exemplars get copied.
- *Pain:* The "lower priority" workflows in the catalog (document-creation, adaptive-ticket, documentation-update) have no assessment gates -- if authors copy these as templates, the pattern propagates.
- *Constraint:* No authoring enforcement beyond what `validate:registry` catches.

### The 4 production workflows (what actually runs in the daemon pipeline)

From `triggers.yml` and `src/coordinators/modes/full-pipeline.ts` (re-verified 2026-04-23):
1. **`wr.discovery`** (full-pipeline mode, step 1 via `coordinators/modes/full-pipeline.ts`) -- stamped v3. Has 3 `while` loops with `artifact_contract` conditionSources and `maxIterations` backstops (2, 3, 3). No assessment gates. Research step -- gates may not be appropriate here.
2. **`wr.shaping`** (full-pipeline mode, step 2) -- has 2 assessment gates, 1 `while` loop with `artifact_contract` conditionSource and `maxIterations: 2`. NOT stamped.
3. **`wr.coding-task`** (direct `triggers.yml` trigger + implement mode) -- has 2 gate steps (each with `require_followup`), 4 loops (3 `while` with `artifact_contract`, 1 `forEach`). NOT stamped. Highest-stakes: writes code.
4. **`wr.mr-review`** (direct `triggers.yml` trigger `mr-review`) -- has 3 assessment gates on final-validation step with `require_followup`, 1 `while` loop with `artifact_contract` conditionSource and `maxIterations: 4`. NOT stamped. Issue #174 still open but gates are already wired.

**Loop structure verdict (verified):** All production workflows use `conditionSource.kind = "artifact_contract"` with `maxIterations` backstops. Loop control is sound. No missing termination conditions. This is a significant quality signal -- these loops will not run forever.

**Key tension**: The 4 production workflows already have assessment gates. The "legacy" workflows that don't have gates (`wr.adaptive-ticket-creation`, `wr.documentation-update`, `wr.production-readiness-audit`, etc.) are NOT used in the autonomous pipeline -- they're human-triggered workflows.

### The real problem, decomposed

**Layer 1 (surface):** Planning docs reference workflows that no longer exist (`exploration-workflow.json`, etc.). Issue #174 is open but appears closed in practice.

**Layer 2 (operational):** The 4 production daemon workflows are missing `validatedAgainstSpecVersion` stamps. This is the most meaningful "modernization" gap for the actual production system -- not adding gates (they have them) but formally validating them against the current spec.

**Layer 3 (quality catalog):** Human-triggered workflows (`wr.adaptive-ticket-creation`, `wr.documentation-update`, `wr.production-readiness-audit`) lack assessment gates. These workflows run when humans explicitly invoke them. Adding gates here improves quality for human-driven sessions, not daemon sessions.

**Layer 4 (strategic):** "Modernization" as a concept conflates two different operations:
  - **Cosmetic migration:** add schema fields, update prompt format, stamp the workflow
  - **Behavioral redesign:** add assessment gates, restructure loops, tighten output contracts

### Tensions

**Tension 1: Production value vs. legacy catalog**
- The 4 production workflows already have gates. Modernizing legacy workflows (document-creation, ticket-creation, etc.) helps human-driven sessions but doesn't improve the autonomous pipeline.
- *Implication:* "modernization for the daemon" is mostly done. "Modernization for human users" is the real remaining work.

**Tension 2: Stamping vs. behavioral improvement**
- `validatedAgainstSpecVersion` is a stamp that says "this workflow was reviewed against the current authoring spec." Most production workflows are missing this stamp.
- Running `wr.workflow-for-workflows.json` on a workflow is the intended process to earn the stamp.
- But running `wr.workflow-for-workflows.json` takes significant agent time and may find things to fix, making the "just stamp it" shortcut dishonest.

**Tension 3: Documentation rot creates misdirected work**
- The open-work-inventory and tickets/next-up.md reference deleted files and closed work (issue #174, exploration-workflow.json).
- If these docs are used to prioritize work, they'll produce the wrong priorities.
- Fixing the docs first is cheap but it's not "shipping workflow improvements."

**Tension 4: Active focus is elsewhere**
- Recent commits (Apr 20-23) are engine/daemon/console/schema: loadSessionNotes export, metricsProfile footer injection, wr.* namespace rename, console fixes, TypeScript 6 upgrade.
- The project owner's actual momentum has been on infrastructure and schema, not workflow authoring content.
- Starting a workflow modernization project now means context-switching from hot infrastructure work.
- Mitigating factor: the wr.* rename (#782) and metricsProfile additions (#779) WERE workflow file changes. The infrastructure work is now slowing; conditions may be better for workflow content work.

**Tension 5: Issue #174 is open but done (new, 2026-04-23)**
- GitHub issue #174 "Adopt assessment-gate follow-up in MR review" is labeled `feature, next` and remains open.
- But `wr.mr-review` already has 3 assessment gates with `require_followup` consequences, all properly wired.
- The issue's stated acceptance criteria ("assessment gate added to wr.mr-review") are met.
- Closing this issue is cheap cleanup but clarifies the work queue.

### Success criteria (observable)

1. The 3 unstamped production daemon workflows (`wr.shaping`, `wr.coding-task`, `wr.mr-review`) all have `validatedAgainstSpecVersion: 3` after genuine review via `wr.workflow-for-workflows.json`
2. Planning docs (`open-work-inventory.md`, `tickets/next-up.md`) reference only files that exist in the repo; issue #174 is closed
3. At least one non-production workflow with a review/audit purpose (`wr.production-readiness-audit` or `wr.adaptive-ticket-creation`) gains functional assessment gates
4. `npx vitest run tests/lifecycle/bundled-workflow-smoke.test.ts` passes (36/36 minimum) before and after any changes
5. No pre-existing test failures are introduced (perf/cli/polling failures confirmed pre-existing and not attributed to workflow changes)

### Reframes and HMW questions

**Reframe 1: "Modernization" is actually two separate projects**
- Project A: Fix documentation rot (cheap, prerequisite, no workflow changes)
- Project B: Validate + stamp the 4 production workflows (high value, expensive, requires running quality gate)

**Reframe 2: The daemon doesn't need modernization -- it needs validation**
The autonomous pipeline workflows already use assessment gates. What they're missing is the formal `validatedAgainstSpecVersion` stamp, which is earned by running them through `wr.workflow-for-workflows.json`. The work is validation, not "modernization."

**HMW 1:** How might we run the quality gate on `wr.coding-task` as a time-bounded probe to scope Stream B before committing to it?

**HMW 2:** How might we prioritize the non-production workflows without session outcome data to guide us?

### Primary framing risk (updated 2026-04-23)

**The specific condition that would make this framing wrong:**

If running `wr.workflow-for-workflows.json` on `wr.coding-task` at STANDARD depth returns `authoring-integrity-gate: low` or `outcome-effectiveness-gate: low` (the two quality gate assessment dimensions), then the framing "production workflows need stamping not redesign" is wrong. A `low` on either dimension means the workflow has structural quality problems that the gate catches -- and the `require_followup` consequence would trigger, sending the quality gate into another iteration rather than producing a stamp. This would mean the scope of work is redesign (behavioral changes), not validation (stamp-earning). The only way to resolve this uncertainty is to actually run the gate on `wr.coding-task`. Until that happens, this framing risk is unresolved.

**Why this specific risk and not a generic one:** The assessment dimensions of `wr.workflow-for-workflows.json` are `state_economy`, `simulation_outcome`, `authoring_integrity`, and `outcome_effectiveness`. A `low` on `state_economy` means the workflow is inefficient but not structurally wrong. A `low` on `authoring_integrity` or `outcome_effectiveness` means the workflow has quality problems that actively harm output. These two are the ones that would force redesign. Loop structure and gate wiring are already verified-correct -- so the remaining unknowable is prompt quality under adversarial review.

### Primary uncertainty

**What does the quality gate actually find?** We know the production workflows have assessment gates and pass the smoke test. We do NOT know whether running `wr.workflow-for-workflows.v2.json` on them at THOROUGH depth would surface material prompt quality issues. This is the single highest-uncertainty input for the design.

---

## Phase 2 Synthesis

### The opportunity

The autonomous pipeline runs on 4 workflows (`wr.discovery`, `wr.shaping`, `wr.coding-task`, `wr.mr-review`) that already have structural quality (assessment gates, loops, evidence contracts) but have never been formally validated against the current authoring spec. Closing this gap makes WorkRail's own daemon sessions exemplary examples of spec-compliant workflow execution -- which matters both for quality and for platform credibility.

At the same time, planning docs reference 7 deleted files and one open-but-done issue (#174), causing any planning effort to misdirect work. Fixing this is cheap and is a prerequisite to trustworthy prioritization.

### Decision criteria (a good direction must satisfy all 5)

1. **Sequencing discipline:** Corrects documentation rot before touching workflow JSON
2. **Empirical before prescriptive:** Runs quality gate on at least one production workflow before committing to full redesign scope
3. **Production-first value:** Prioritizes the 4 daemon pipeline workflows over the 17 ungated legacy catalog workflows
4. **No cosmetic compliance:** Does not stamp `validatedAgainstSpecVersion` without a genuine quality gate review
5. **Incremental shippability:** Each piece produces a standalone, shippable improvement

### Riskiest assumption

"The 4 production workflows have sound prompt quality and will pass the quality gate with minor fixes." If they have structural quality issues (missing output contracts, weak evidence requirements, poor loop termination), Stream B expands into redesign territory. Only testable by running the gate.

### Remaining uncertainty type

**Prototype-learning uncertainty.** We know what to do and in what order. We don't know how much work the quality gate will surface. The scope of Stream B is only knowable by doing it.

---

## Candidate Generation Setup (Phase 3b)

**Path:** `design_first`  
**candidateCountTarget:** 3  
**Updated:** 2026-04-23 (sharpened from prior session; 3 existing candidates re-evaluated below)

### Required properties of the candidate set (updated 2026-04-23)

Per the `design_first` path contract, the 3 candidates must satisfy:

1. **At least one reframe candidate:** One candidate must challenge whether docs correction + production validation is the right investment. Valid reframes: retire low-value workflows, invest in lint tooling, or defer workflow work entirely. Direction C (defer) and Direction B (tooling) serve this role.

2. **Meaningful differentiation:** Candidates must differ in their primary bet, not just ordering or scope. Direction A bets on "empirical validation of the production pipeline first." Direction B bets on "tooling over manual migration." Direction C bets on "deferral is correct given bandwidth context." These are meaningfully different bets.

3. **Grounded in the 5 decision criteria (updated):** Sequencing discipline / Empirical before prescriptive / Production-first value / No cosmetic compliance / Incremental shippability. Each candidate is evaluated against all 5 below.

4. **Prototype-learning uncertainty honored:** Direction A explicitly makes the quality gate the scope-branch point. Direction B bypasses this uncertainty by investing in tooling instead. Direction C defers it entirely. All three handle the uncertainty differently -- this is correct.

### New bias to guard against (2026-04-23 addition)

The prior session's candidates were generated when `wr.workflow-for-workflows.v2.json` was the quality gate. That file has been consolidated into `wr.workflow-for-workflows.json`. References in Direction A must use the correct current file name. This is a naming-only correction; the candidates are otherwise unchanged.

### Anti-candidates (explicitly ruled out by decision criteria)

- Any candidate that adds `validatedAgainstSpecVersion` without running `wr.workflow-for-workflows.json` -- violates criterion 4 (no cosmetic compliance)
- Any candidate that prioritizes legacy catalog workflows over production pipeline workflows -- violates criterion 3 unless making a deliberate reframe argument
- Any candidate that treats "close #174" and "stamp wr.coding-task" as equivalent work units -- they are different in kind (docs hygiene vs. genuine quality validation)

---

## Candidate Directions

### Direction A: Docs-first + empirical production validation (recommended)

**Core bet:** Fix the documentation foundation first, then run `wr.workflow-for-workflows.json` on `wr.coding-task` as a probe -- let that run's findings determine the scope of remaining work.

**What:**
1. Update `open-work-inventory.md` and `tickets/next-up.md` to remove stale file references (deleted workflows, non-existent candidates)
2. Close GitHub issue #174 (assessment-gate adoption in MR review is already done -- `wr.mr-review` has 3 gates with `require_followup`, all wired)
3. Run `wr.workflow-for-workflows.json` on `wr.coding-task` at STANDARD depth
4. If quality gate finds only minor issues (`state_economy:low` only): fix, stamp, repeat for `wr.shaping`
5. If quality gate finds structural failures (`authoring_integrity:low` or `outcome_effectiveness:low`): create a focused GitHub issue for the specific fixes, do NOT stamp until fixed

**Satisfies decision criteria:**
- ✅ Sequencing discipline (docs first)
- ✅ Empirical before prescriptive (quality gate run before scope commitment)
- ✅ Production-first value (coding-task is the highest-use production workflow)
- ✅ No cosmetic compliance (stamp only after genuine gate run)
- ✅ Incremental shippability (docs fix ships independently; each stamped workflow ships independently)

**Handles prototype-learning uncertainty:** Yes -- the quality gate finding is explicitly the branch point for scope.

**Risks:** Quality gate may find significant issues requiring more work than expected. Mitigated by treating the first gate run as a probe, not a commitment to fix everything.

---

### Direction B: Catalog pruning + tooling investment (reframe)

**Core bet:** Instead of migrating legacy workflows, retire the ones that add clutter without adding value, and invest the remaining effort in lint tooling that prevents future regression across all workflows.

**What:**
1. Audit all 24 bundled workflows for "is this worth keeping?" -- retire workflows that are low-use, domain-specific (e.g., `wr.relocation-us.json`), or fully superseded
2. For surviving non-production workflows, add a `validate:registry` rule that flags workflows lacking `recommendedPreferences` and `assessments` when they have review/validation steps
3. Skip the manual quality-gate-run process entirely -- let the linter enforce quality going forward

**The reframe argument:** "Modernization" of individual workflows is a treadmill -- as soon as you finish, new engine features exist and the catalog drifts again. Tooling that enforces quality across all current and future workflows has higher expected return than manual per-workflow migration.

**Satisfies decision criteria:**
- ✅ Sequencing discipline (retirement audit precedes tooling)
- ⚠️ Empirical before prescriptive (linting is forward-looking, not backward-empirical)
- ⚠️ Production-first value (linting helps all workflows equally, not production-first)
- ✅ No cosmetic compliance (linting catches cosmetic-only changes)
- ✅ Incremental shippability (each new lint rule ships independently)

**Fails criteria 3 if:** The production pipeline workflows are never stamped -- which this direction leaves unaddressed.

**When this is the right bet:** If the project owner's real goal is sustainable quality rather than a one-time migration.

---

### Direction C: Defer workflow work, close the open issues, nothing more

**Core bet:** Workflow quality is not the bottleneck for the autonomous pipeline today. The active momentum is on engine/daemon/console infrastructure. Switching context to workflow authoring work now has negative expected value. The right action is minimal: close #174, note the stale doc references, and return to workflow work when engine work is in a stable state.

**What:**
1. Close GitHub issue #174 (it's already done)
2. Add a comment to `open-work-inventory.md` noting that 7 file references are stale (no edits -- avoid accidental commits)
3. Stop. No workflow JSON changes. No quality gate runs.

**The reframe argument:** The project owner said "next" but the actual commit velocity and open issue set show infrastructure work is active and urgent. A half-completed workflow migration (docs fixed, one workflow stamped) is worse than a clean slate -- it creates partial work artifacts that block future context.

**Satisfies decision criteria:**
- ✅ Sequencing discipline (N/A -- nothing is done)
- N/A Empirical before prescriptive
- ✅ Production-first value (by omission -- production workflows already have gates)
- ✅ No cosmetic compliance (nothing stamped)
- ✅ Incremental shippability (single atomic action: close #174)

**When this is the right bet:** If the project owner's bandwidth is genuinely constrained by active engine work, and the workflow modernization task was added to the queue prematurely.

---

## Challenge Notes (from goal challenge step)

1. **Assumption challenged:** `exploration-workflow.json` is the top priority → **Refuted.** File does not exist.
2. **Assumption challenged:** Adding modern schema fields improves agent outcomes → **Unverified.** Fields alone don't change behavior; assessment gates do.
3. **Assumption challenged:** "Modernization" (preserve structure, upgrade syntax) is the right unit of work → **Contested.** Some workflows may need redesign, not migration.

---

## Resolution Notes

**Phase 0 (2026-04-21):** Path confirmed as `design_first`. Context fully populated for downstream steps. Smoke test baseline confirmed: 37/37 passing. Open GitHub issues: only #174 ("Adopt assessment-gate follow-up in MR review") is directly related.

**Phase 0 third run (2026-04-23, later session):** Repo state re-verified. No material changes since Phase 0 second run. Latest commit: `f0a1822a fix(engine): validate metrics_outcome enum in checkContextBudget`. Smoke test: 36/36. Issue #174: still open. No new workflow files. Open PRs: #797 (max-output-tokens feature, unrelated), #698/#330 (dependabot deps). All prior findings and direction selection remain valid. Path recommendation unchanged: `design_first`. Selected direction unchanged: Direction A (docs-first + empirical production validation). No re-analysis needed.

**Phase 0 re-run (2026-04-23, earlier session):** Two material changes since last session:
1. `feat(workflows): rename all bundled workflows to wr.* namespace (#782)` -- all workflow IDs now have `wr.` prefix; usage data in session store uses old IDs (`coding-task-workflow-agentic` = `wr.coding-task`, `mr-review-workflow-agentic` = `wr.mr-review`). Design doc table was using the old file names; corrected to `wr.*` IDs.
2. `chore(workflows): delete stale wfw copy, rename .v2.json to workflow-for-workflows.json (#780)` -- `wr.workflow-for-workflows.v2.json` absorbed into `wr.workflow-for-workflows.json`. Smoke test count is now 36/36.
All candidate directions from prior session remain valid. No engine schema changes that affect assessment gate contract. Issue #174 still open.

---

## Decision Log

| Decision | Rationale | Date |
|---|---|---|
| path = `design_first` | Goal was solution-statement; primary risk is wrong candidates/wrong unit of work | 2026-04-20 |
| No subagent delegation in Phase 0 | All data available in-repo via Bash/Read tools; synthesis task is single-thread | 2026-04-20 |
| Prior landscape corrected | assessmentRef (singular) vs assessmentRefs (plural) error fixed; modern baselines re-verified | 2026-04-20 |
| Stale planning docs identified as prerequisite gate | Must correct docs before implementation begins -- they reference deleted targets | 2026-04-20 |
| Delegation: mechanism available, not used for design work | spawn_agent with wr.classify-task returned success. Not used for design/synthesis -- main agent owns synthesis by rule. Used for parallel audits only when latency benefit is clear. | 2026-04-20/23 |
| Web browsing: available via curl | curl to example.com returned HTML -- network reachable; not needed (all data is in-repo) | 2026-04-20/23 |
| Artifact strategy: doc is readable summary only | Execution truth lives in step notes + context variables; design doc is for human reference only | 2026-04-20 |
| **Selected direction: Candidate 2 (quality gate probe)** | Satisfies all 5 decision criteria; only candidate that answers "are production workflows sound?"; failure mode bounded by explicit branch condition; philosophy aligned | 2026-04-23 |
| "Follows existing repo pattern" rationale corrected | Git history shows all 4 stamped workflows were stamped during authoring commits, not after quality gate runs. Corrected rationale: "exceeds current practice; justified by philosophy + wr.coding-task 85-session stakes." | 2026-04-23 |
| Runner-up bonus PR: wr.production-readiness-audit gate | Standalone, independent of quality gate sessions, delivers user-facing behavioral improvement, follows wr.shaping gate pattern exactly | 2026-04-23 |
| Candidate 3 lint rule left out of scope | YAGNI after wr.production-readiness-audit bonus PR fixes the most obvious ungated audit workflow; heuristic maintenance burden outweighs value | 2026-04-23 |
| Candidate 1 (mechanical stamp) disqualified | Fails decision criteria 2 (empirical) and 4 (no cosmetic compliance); corrupts stamp meaning | 2026-04-23 |

---

## Final Summary

**Recommendation:** Quality gate probe on `wr.coding-task` + docs hygiene + `wr.production-readiness-audit` gate addition

**Confidence band:** Medium-high

The "medium" component comes entirely from one unresolved prototype-learning uncertainty: what does running `wr.workflow-for-workflows.json` on `wr.coding-task` actually find? This is not resolvable by analysis -- it's resolved by doing the work. The direction is correct in both outcomes (minor findings → stamp; structural findings → scoped redesign issue). The confidence in the direction is high; the confidence in the scope is medium.

---

### The problem (reframed)

The stated goal ("modernize `exploration-workflow.json`") was a solution statement pointing at a file that no longer exists. The real problem has two layers:

**Layer 1 (cheap, ~30 min):** Planning docs and issue queue are stale -- they reference deleted workflows and an already-completed issue (#174). Any work started from them is misdirected.

**Layer 2 (high value, scope-uncertain):** The 3 most-used production pipeline workflows (`wr.coding-task` at 85 sessions, `wr.mr-review` at 65, `wr.shaping`) are structurally sound (correct loop control, working assessment gates, `artifact_contract` conditionSources) but have never been run through the project's quality gate. They lack `validatedAgainstSpecVersion: 3`.

---

### Selected direction: three independent work units

**PR 1 -- Docs hygiene (independent, no dependencies, ~30 min)**
- Update `docs/roadmap/open-work-inventory.md`: remove references to deleted workflows (`exploration-workflow.json`, `mr-review-workflow.json`, `bug-investigation.json`, `design-thinking-workflow.json`, `wr.workflow-for-workflows.v2.json`, and other stale entries)
- Update `docs/tickets/next-up.md`: remove stale "Ticket 2: Legacy workflow modernization -- exploration-workflow.json" entry
- Close GitHub issue #174 with comment: "Adopting assessment-gate follow-up in MR review is complete. Step `phase-5-final-validation` in `wr.mr-review` already has `assessmentRefs: [\"evidence-quality-gate\", \"coverage-completeness-gate\", \"contradiction-resolution-gate\"]` with `assessmentConsequences` triggering `require_followup` when any dimension scores `low`. Three gates, all wired, no further action needed."
- Pre-PR validation: `grep -E "exploration-workflow|mr-review-workflow\.json|bug-investigation\.json|design-thinking-workflow|workflow-for-workflows\.v2" docs/roadmap/open-work-inventory.md docs/tickets/next-up.md` must return no output

**PR 2 -- `wr.production-readiness-audit` assessment gate (independent, no dependencies, ~1 hr)**
- Add to `workflows/production-readiness-audit.json`:
  - Top-level `assessments`: `[{ "id": "readiness-verdict", "purpose": "The readiness verdict is evidence-grounded and calibrated -- not optimistic or based on absence of red flags", "dimensions": [{ "id": "readiness_confidence", "purpose": "Verdict is supported by specific evidence items tied to concrete system behaviors, not general impressions", "levels": ["low", "high"] }] }]`
  - On the final verdict step: `"assessmentRefs": ["readiness-verdict"]` + `"assessmentConsequences": [{ "when": { "anyEqualsLevel": "low" }, "effect": { "kind": "require_followup", "guidance": "Readiness confidence is low. Return to Phase 3 evidence collection: identify which readiness dimensions lack specific behavioral evidence, gather it, and re-run the verdict." } }]`
- Create a GitHub issue for this work before implementation
- Smoke test must pass (36/36) after the change
- Pattern reference: `wr.shaping.json` `frame-soundness` gate is the cleanest example to follow

**Stream B -- Quality gate probe on `wr.coding-task` (independent, time-bounded, scope-uncertain)**
1. Create GitHub issue: "Validate and stamp wr.coding-task via quality gate" with acceptance criteria: run `wr.workflow-for-workflows.json` at STANDARD depth; stamp only if no `authoring_integrity:low` or `outcome_effectiveness:low`
2. Run `wr.workflow-for-workflows.json` on `wr.coding-task` at STANDARD depth in a daemon session
3. Branch on gate findings:
   - `state_economy:low` only → fix in-session (inefficiency, not structural failure), stamp, PR
   - `simulation_outcome:low` with narrow fix → fix in-session, stamp, PR
   - `authoring_integrity:low` or `outcome_effectiveness:low` → stop, create "wr.coding-task quality improvements" issue with specific findings, do NOT stamp until fixed
4. If wr.coding-task stamps cleanly: repeat for `wr.shaping` (same pattern)

**Minimum viable delivery:** PR 1 alone (docs hygiene). Already worth doing independently of everything else.
**Standard delivery:** PR 1 + Stream B (wr.coding-task stamped or scoped redesign issue created).
**Full delivery:** PR 1 + PR 2 + Stream B (all 3 unstamped production workflows stamped, wr.production-readiness-audit gated).

---

### Strongest alternative

**Candidate 3 (tooling investment over quality gate sessions):** Add `validate:registry` advisory rule for "audit step without gate," add `wr.production-readiness-audit` gate, skip quality gate sessions entirely.

Switch to this if: Stream B's gate run finds structural failures in `wr.coding-task` AND the resulting redesign issue is deprioritized. At that point, the production stamp is deferred anyway, and tooling investment has better expected return than waiting for redesign.

---

### Residual risks

1. **Quality gate findings expand scope significantly.** The gate may find `authoring_integrity:low` or `outcome_effectiveness:low` for `wr.coding-task`, triggering redesign territory. Managed: explicit branch condition. Risk level: medium (unknown until run).

2. **Quality gate validity for coding-task-style workflows.** `wr.workflow-for-workflows.json` has not been run on a production pipeline workflow before. Its assessment dimensions may produce noisy or off-target findings for a coding workflow. Risk level: low (dimensions are general; gate was "exercised extensively" per commit dc4624dc).

3. **Production workflow stamps remain deferred if Stream B is deprioritized.** PR 1 and PR 2 ship regardless, but if Stream B doesn't happen, `wr.coding-task` and `wr.shaping` stay unstamped. Risk level: low for functionality (stamps are dev-only signals), medium for internal quality discipline.

---

### What changed from the stated goal

| Stated goal | Actual recommendation |
|---|---|
| "Modernize `exploration-workflow.json`" | That file no longer exists; `wr.discovery` is already modern (v3.2.0, stamped, routines, assessment-contract loops) |
| Modernize specific files by adding schema fields | Run the quality gate (genuine review) before stamping; field additions alone are cosmetic |
| Focus on legacy catalog workflows | Focus on the 3 production pipeline workflows actually used in 85+ daemon sessions |
| Planning docs as priority guide | Planning docs are stale; usage data from session store is the correct priority guide |
