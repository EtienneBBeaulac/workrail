# Workflow Modernization Design

**Status:** Active  
**Created:** 2026-04-20  
**Updated:** 2026-04-21 (Phase 0 complete -- goal challenged, path set, context populated)  
**Owner:** WorkTrain daemon session (shaping)

---

## Artifact Strategy

**This document is for human readability only.** It is NOT required workflow memory. If a chat rewind occurs, the durable record lives in:
- WorkRail step notes (notesMarkdown in each `complete_step` call)
- Explicit context variables passed between steps

Do not treat this file as the source of truth for what step the session is on, what decisions have been made, or what constraints apply. Those live in the session notes.

This file is maintained alongside the session as a readable summary of findings and decisions. It may lag behind the session notes slightly.

### Capability status (verified Phase 0b, 2026-04-21)

| Capability | Available | How verified | Notes |
|---|:---:|---|---|
| Web browsing | YES | `curl https://example.com` returned HTML (5s timeout) | Available via curl; no dedicated browser tool needed |
| Delegation (spawn_agent) | YES | `spawn_agent` with `wr.discovery` returned `{childSessionId, outcome: "stuck"}` -- mechanism works | `wr.discovery` is a multi-step workflow, unsuitable as a trivial probe; stuck on internal heuristic. Spawn mechanism itself is functional. |
| Git / GitHub CLI | YES | `gh pr list`, `git log` working throughout session | No issues |

**Capability decisions:**
- **Web browsing:** Available but not needed. All evidence for this task is in-repo (workflow files, schema, planning docs). No external references needed. Skipping -- fallback to in-repo data is fully sufficient.
- **Delegation:** Mechanism is available. Whether to use it is a per-step judgment. For design/synthesis work (this phase), delegation adds overhead without benefit -- the main agent owns synthesis by rule. For independent parallel audits (e.g. gap-scoring multiple workflows simultaneously), delegation could reduce latency. Decision will be made per step.

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
| `wr.workflow-for-workflows.json` | Y | Y | Y | Y | Y | Y | 10 |
| `wr.workflow-for-workflows.v2.json` | Y | Y | Y | Y | Y | **Y** | 10 |
| `wr.discovery.json` | Y | Y | Y | N | Y | N | 22 |
| `wr.shaping.json` | Y | Y | N | N | N | **Y** | 9 |

**Working examples for assessment gate patterns:**
- `wr.shaping.json` -- cleanest: 1 dimension per assessment, `low`/`high` levels, `require_followup` on `low`
- `wr.coding-task.json` -- multi-assessment per step, loop-body refs
- `mr-review-workflow.agentic.v2.json` -- 3 refs on a single final validation step
- `bug-investigation.agentic.v2.json` -- single gate on diagnosis validation

**Current smoke test baseline:** 37/37 (verified 2026-04-21)

### Key landscape observations (corrected Phase 1c, 2026-04-21)

1. **Two prompt formats coexist:** `promptBlocks` (structured object with goal/constraints/procedure/verify) and raw `prompt` string. The authoring spec recommends `promptBlocks`. Not all "modern" workflows use it consistently.

2. **`exploration-workflow.json` is gone:** Absorbed into `wr.discovery.json`. Planning docs must be corrected before any implementation work begins.

3. **Several "candidates" from open-work-inventory also no longer exist:** `mr-review-workflow.json`, `bug-investigation.json`, `design-thinking-workflow.json` -- all absorbed or renamed. The list in `open-work-inventory.md` is materially stale.

4. **Assessment gates are the biggest behavioral differentiator:** 7/24 workflows have functional assessment gates. The 17 without them have no engine-enforced quality checkpoints -- all validation is prose-only.

5. **`wfw.v2.json` DOES have functional assessment gates** -- the prior session's "orphaned assessments" finding was wrong. The gates live in loop body steps (`phase-6a`, `phase-6b`, `phase-6c`). All 4 declared gates are referenced and wired. Prior design doc contained a material error on this point.

6. **`recommendedPreferences` is a common gap:** 11/24 workflows are missing it. Easy to add, genuine behavioral improvement.

7. **`references` is almost universally missing:** Only 3 workflows have it (`wfw`, `wfw.v2`, `wr.production-readiness-audit`). This is cosmetic for most workflows -- references are informational, not enforced.

8. **The "unstamped" list from `validate:registry` is cosmetic advisory only** -- it names 17 unstamped workflows but stamping alone is not a quality improvement goal.

9. **`wr.production-readiness-audit.json` has no assessment gates** -- despite being a review workflow with a clear audit focus, it uses no `assessmentRefs`. This is a behavioral gap on a high-value workflow.

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

From `triggers.yml` and `src/coordinators/modes/`:
1. **`wr.discovery`** (full-pipeline mode, step 1) -- already validated (v3), has promptFragments and routines. No assessment gates -- but discovery is a research step, gates may not be appropriate here.
2. **`wr.shaping`** (full-pipeline mode, step 3) -- has functional assessment gates on `frame-gate` and `breadboard-and-elements`. Not validated (`validatedAgainstSpecVersion` missing).
3. **`wr.coding-task`** (full-pipeline + implement mode, step 5) -- has functional assessment gates (8 of them). Not validated. This is the highest-stakes workflow: it writes code.
4. **`wr.mr-review`** (full-pipeline + implement mode, final step) -- has functional assessment gates (3 of them). Not validated. Issue #174 (add assessment gate) is OPEN but appears already done -- commit c83aa180 marked it done.

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
- Running `wr.workflow-for-workflows.v2.json` on a workflow is the intended process to earn the stamp.
- But running `wr.workflow-for-workflows.v2.json` takes significant agent time and may find things to fix, making the "just stamp it" shortcut dishonest.

**Tension 3: Documentation rot creates misdirected work**
- The open-work-inventory and tickets/next-up.md reference deleted files and closed work (issue #174, exploration-workflow.json).
- If these docs are used to prioritize work, they'll produce the wrong priorities.
- Fixing the docs first is cheap but it's not "shipping workflow improvements."

**Tension 4: Active focus is elsewhere**
- Recent commits (Apr 20-21) are all engine/daemon/console: trigger fixes, coordinator crashes, console bugs.
- The project owner's actual momentum is on infrastructure, not workflow authoring.
- Starting a workflow modernization project now means context-switching from hot infrastructure work.

### Success criteria (observable)

1. The 4 production daemon workflows (`wr.discovery`, `wr.shaping`, `coding-task`, `mr-review`) all have `validatedAgainstSpecVersion: 3` after genuine review via `wr.workflow-for-workflows.v2.json`
2. Planning docs (`open-work-inventory.md`, `tickets/next-up.md`) reference only files that exist in the repo, and issue #174 is closed if it's actually done
3. At least one non-production workflow with a review/audit purpose (`wr.production-readiness-audit.json` or `wr.adaptive-ticket-creation.json`) gains functional assessment gates
4. `npx vitest run` passes (37/37 minimum) before and after any changes

### Reframes and HMW questions

**Reframe 1: "Modernization" is actually two separate projects**
- Project A: Fix documentation rot (cheap, prerequisite, no workflow changes)
- Project B: Validate + stamp the 4 production workflows (high value, expensive, requires running quality gate)

**Reframe 2: The daemon doesn't need modernization -- it needs validation**
The autonomous pipeline workflows already use assessment gates. What they're missing is the formal `validatedAgainstSpecVersion` stamp, which is earned by running them through `wr.workflow-for-workflows.v2.json`. The work is validation, not "modernization."

**HMW 1:** How might we get the 4 production workflows stamped without the full 10-step `wr.workflow-for-workflows.v2.json` process for each?

**HMW 2:** How might we prioritize the non-production workflows without session outcome data to guide us?

### Primary framing risk

**The specific condition that would make this framing wrong:**

If `wr.discovery.json`, `wr.shaping.json`, `wr.coding-task.json`, or `mr-review-workflow.agentic.v2.json` actually have material quality problems that assessment gates don't catch (e.g., poorly structured prompts, missing output contracts, wrong loop structure), then the framing "production workflows are fine, legacy workflows need work" is wrong. The production workflows might need behavioral redesign, not just stamping. This would only be discoverable by actually running `wr.workflow-for-workflows.v2.json` on each of them and seeing what quality gate failures come back.

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

### Required properties of the candidate set

Per the `design_first` path contract, the 3 candidates must satisfy:

1. **At least one reframe candidate:** One candidate must challenge whether the two work streams (docs fix + production workflow validation) are the right investment at all. The obvious directions are "clean up docs" and "run quality gate on production workflows." The reframe asks: what if neither is the best use of the same effort right now? A valid reframe might be: retire low-value workflows from the catalog, invest in lint tooling that prevents future regression, or defer workflow work entirely in favor of the active engine/daemon/console work.

2. **Meaningful differentiation:** Candidates must differ in their primary bet, not just in ordering or scope. Minor variations on "do A then B in different order" do not count as distinct candidates.

3. **Ground in the 5 decision criteria:** Each candidate must be evaluable against: sequencing discipline, empirical-before-prescriptive, production-first value, no cosmetic compliance, incremental shippability. A candidate that violates decision criterion 4 (cosmetic compliance) is disqualified.

4. **Prototype-learning uncertainty honored:** At least one candidate must explicitly account for the unknown scope of Stream B (what the quality gate finds) rather than assuming it away.

### Bias to guard against

Because the two streams are well-defined, generation will be pulled toward micro-variations: "do A then B1 only," "do A then B1 and B2," "do A then B3." This is the clustering failure. Each of the 3 candidates must be defendable as the *right* strategy in some scenario, not just the same strategy with different scope.

### Anti-candidates (explicitly ruled out by decision criteria)

- Any candidate that adds `validatedAgainstSpecVersion` without running `wr.workflow-for-workflows.v2.json` -- violates criterion 4
- Any candidate that prioritizes legacy catalog workflows (adaptive-ticket, document-creation, etc.) over production pipeline workflows -- violates criterion 3 unless it argues from the reframe position that this is intentionally the right bet

---

## Candidate Directions

### Direction A: Docs-first + empirical production validation (recommended)

**Core bet:** Fix the documentation foundation first, then run `wr.workflow-for-workflows.v2.json` on `wr.coding-task.json` as a probe -- let that run's findings determine the scope of remaining work.

**What:**
1. Update `open-work-inventory.md` and `tickets/next-up.md` to remove 7 stale file references
2. Close GitHub issue #174 (assessment-gate adoption in MR review is already done per commit c83aa180)
3. Run `wr.workflow-for-workflows.v2.json` on `wr.coding-task.json` at STANDARD depth
4. If quality gate finds only minor issues: stamp it, then repeat for `wr.shaping.json`
5. If quality gate finds significant issues: create a focused GitHub issue for the specific fixes, do NOT stamp until fixed

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

**Phase 0 (2026-04-21):** Path confirmed as `design_first`. Context fully populated for downstream steps. Key new finding from this session: the prior design doc (2026-04-20) was not committed to git and is an untracked sidecar -- this is correct per the artifact strategy. No engine changes since the prior session that affect workflow schema (the `findingCategory` addition in #644 is schema/engine but only adds a new field to review-verdict findings; it does not change the assessment gate contract). Smoke test baseline confirmed: 37/37 still passing. Open GitHub issues: only #174 ("Adopt assessment-gate follow-up in MR review") is directly related.

---

## Decision Log

| Decision | Rationale | Date |
|---|---|---|
| path = `design_first` | Goal was solution-statement; primary risk is wrong candidates/wrong unit of work | 2026-04-20 |
| No subagent delegation in Phase 0 | All data available in-repo via Bash/Read tools; synthesis task is single-thread | 2026-04-20 |
| Prior landscape corrected | assessmentRef (singular) vs assessmentRefs (plural) error fixed; modern baselines re-verified | 2026-04-20 |
| `wr.workflow-for-workflows.v2.json` added to HIGH-priority list | It is the quality gate workflow but lacks assessmentRefs at step level -- ironic and high-value fix | 2026-04-20 |
| Stale planning docs identified as prerequisite gate | Must correct docs before implementation begins -- they reference deleted targets | 2026-04-20 |
| Delegation: mechanism available, not used for design work | spawn_agent returned childSessionId on probe (outcome: "stuck" because wr.discovery is multi-step, not because spawn is broken). Not used for Phase 0 design/synthesis -- main agent owns synthesis by rule. Will use for independent parallel audits if latency matters in later phases. | 2026-04-20/21 |
| Web browsing: available via curl | curl to example.com returned HTML -- network reachable; no web browsing needed for this task (all data is in-repo) | 2026-04-20/21 |
| Artifact strategy: doc is readable summary only | Execution truth lives in step notes + context variables; design doc is for human reference only | 2026-04-20 |

---

## Final Summary

*(to be filled in at end of shaping session)*
