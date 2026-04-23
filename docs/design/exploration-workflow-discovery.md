# Discovery: What to Do About the Missing Exploration Workflow

*This document is a human-facing artifact only -- for people to read. Durable execution truth lives in workflow step notes (notesMarkdown) and explicit context variables. This doc is NOT required memory; if a chat rewind occurs, notes and context variables survive, this file may not.*

---

## Context / Ask

**Original stated goal (statedGoal):** Modernize `exploration-workflow.json` to current v2/lean authoring patterns -- add `metaGuidance`, `recommendedPreferences`, `references`, `templateCall`/routine injection, and tighter loop-control wording.

**Reframed problem:** Agents using the exploration workflow may not produce reliably high-quality exploration artifacts, and the workflow is harder to maintain than it should be -- the correct intervention should be diagnosed from actual usage and output quality, not assumed to be a v2 migration.

**Critical finding from Phase 0:** `exploration-workflow.json` does NOT exist in `workflows/` on disk. It was referenced in roadmap/tickets but is absent.

**Critical finding from Phase 0b (git history):** The file was intentionally DELETED in commit `a0ddaaac` (Mar 29, 2026) as part of a deliberate consolidation: `exploration-workflow.json`, `design-thinking-workflow.json`, and `design-thinking-workflow-autonomous.agentic.json` were all merged into `wr.discovery.json`. The commit message explicitly states: "Unify the overlapping exploration and design-thinking workflows into a single discovery workflow." The roadmap item is stale -- it refers to a workflow that has already been superseded and intentionally removed.

**Additional context:** 30+ open CI failure issues (Apr 18-21) suggest the project may have higher-priority concerns than workflow modernization right now.

---

## Path Recommendation

**Recommended path: `design_first`**

Rationale:
- `goalWasSolutionStatement = true`: the stated goal prescribed a specific migration approach
- The underlying problem (high-quality exploration artifacts) is not answered by "migrate the file" when the file doesn't exist
- The dominant risk is solving the wrong problem: creating a new exploration workflow when `wr.discovery` already exists and may already cover the use case
- `landscape_first` would be appropriate if we were comparing workflow tools; `full_spectrum` if we needed both landscape and reframing -- but here the dominant risk is framing: should this workflow even be created?

**Why not landscape_first:** We don't primarily need to understand the landscape of exploration workflow tools; we need to understand whether a new workflow is warranted at all.

**Why not full_spectrum:** The reframing work already done in Phase 0 is sufficient to ground the design work. The open question is not "what does the landscape look like?" but "what problem is a new exploration workflow solving that wr.discovery doesn't?"

---

## Constraints / Anti-goals

**Constraints:**
- Must not create a workflow that duplicates `wr.discovery.json` functionality without clear differentiation
- Must not introduce a new workflow that would fail the `bundled-workflow-smoke.test.ts` smoke test
- Must not commit `.md` documentation files without explicit human authorization
- Changes to protected files (`src/daemon/`, `src/v2/`, `src/trigger/`) are out of scope

**Anti-goals:**
- Do NOT mechanically create a `.v2` file just because the roadmap said so
- Do NOT modernize structure for its own sake without improving agent outcomes
- Do NOT create a workflow for a use case that `wr.discovery` already handles well
- Do NOT displace the CI failure investigation as a higher-priority concern

---

## Landscape Packet

**Populated in Phase 0b from git history and codebase inspection:**

- `exploration-workflow.json` v2.0.0 existed with these properties: structured exploration (understand ask, gather context, generate materially different approaches, evaluate, challenge front-runner, deliver recommendation with bounded uncertainty). It had `metaGuidance`, `recommendedPreferences`, `preconditions`, and notes-first durability rules.
- It was deleted in commit `a0ddaaac` (Mar 29, 2026) and replaced by `wr.discovery.json` v3.2.0, which covers the same domain with deeper step structure (22 steps vs the older format), path branching (landscape_first / full_spectrum / design_first), subagent guidance, and modern `wr.features.*` declarations.
- `wr.discovery.json` IS the exploration workflow -- just modern, well-structured, and feature-complete.
- No gap was identified in Phase 0b between what the old `exploration-workflow.json` did and what `wr.discovery.json` now does.

**Additional landscape finding from Phase 1c (pinned sessions):**

A "Comprehensive Adaptive Exploration Workflow" (v0.1.0, `schemaVersion: 1`) exists in the user's pinned workflow store at `~/.workrail/data/workflows/pinned/`. This is a community/third-party workflow, NOT a bundled workflow. It is a fundamentally different design philosophy vs the lean v2.0.0:
- v1 schema (old schema format), 18+ steps
- Enterprise-grade: 5-phase research loops with saturation detection, divergent/convergent separation, RAND-scale evidence grading, 5-type forced solution generation (Quick/Thorough/Creative/Optimal/Contrarian)
- Requires confirmation gates, automation level setting, complexity triage
- Creates `EXPLORATION_CONTEXT.md` handoff docs (anti-pattern per current authoring guide)

This pinned workflow is usage evidence: someone wanted MORE structured exploration than the lean v2.0.0 provided. However, it's also wildly over-engineered and uses deprecated patterns (file-based memory, requireConfirmation everywhere, v1 schema).

**Landscape summary:**
- 3 precedents identified: lean v2.0.0 (deleted), wr.discovery v3.2.0 (current), Comprehensive Adaptive v0.1.0 (user-pinned, community, v1 schema)
- 2 contradictions: (1) roadmap says modernize a file that was intentionally deleted; (2) pinned community workflow shows appetite for deeper structure but uses anti-patterns
- 1 evidence gap: no data on whether wr.discovery satisfies actual user needs for codebase-level technical exploration (different from problem-space discovery)

**Capability check (Phase 0b):**
- Web browsing: available (curl probe to example.com succeeded)
- Delegation (spawn_agent): tool is present in session tool set -- confirmed available. Not needed for this work; the dominant task is codebase analysis and design synthesis, done directly by main agent. rigorMode = STANDARD, so parallel delegation would add overhead with no quality benefit.
- Decision: no delegation will be used. Fallback (direct main-agent analysis) is fully sufficient and produces better synthesis control.

---

## Problem Frame Packet

### Stakeholders

| Stakeholder | Job / Outcome | Pain / Tension |
|---|---|---|
| Project owner (etienneb) | Maintain a clean, modern, well-scoped bundle of workflows | Stale roadmap pointing at deleted file creates false work inventory |
| Daemon session agents | Invoke exploration-type workflows for autonomous work | wr.discovery already serves this; "exploration-workflow" by name returns not-found |
| Human WorkRail MCP users | "I want to think through problem X" | If they ask for "exploration-workflow" by name, they get a not-found error instead of wr.discovery |
| Developers doing codebase archaeology | "I want to understand this unfamiliar codebase systematically" | No bundled workflow explicitly covers this -- distinct job from problem-space discovery |
| External WorkRail adopters | Find the right workflow in the bundle | "discovery" name may not signal "exploration" to new users |

### Tensions (4)

1. **"Exploration" vs. "Discovery" naming**: The old workflow was action-oriented ("exploration-workflow"). The new one is product-branded ("wr.discovery"). Users searching for "exploration" won't find it by name. Real discoverability gap.

2. **Lean vs. comprehensive depth**: 7-step lean v2.0.0 vs. 18+-step community Comprehensive Adaptive. Appetite for different depth levels is real. wr.discovery addresses this via path branching (landscape_first/full_spectrum/design_first), which is the right mechanism -- but the branching may not be obvious to first-time users.

3. **Problem-space exploration vs. codebase exploration**: wr.discovery is explicitly positioned for "ambiguous problems, opportunities, or decisions." Its examples are all strategic/decision-oriented. Developers wanting to methodically map an unfamiliar codebase have a different job with different tools (Grep, Read, Bash, not design docs). No bundled workflow serves this.

4. **Roadmap currency**: Planning docs list exploration-workflow.json as the #1 modernization priority -- but it was deleted months ago. Misleads agents and creates false work inventory.

### Assumptions (explicit)

- **CONFIRMED**: "wr.discovery covers what exploration-workflow used to do" -- wr.discovery's own metaGuidance states it is "the canonical successor to the old exploration and design-thinking workflows"
- **UNCONFIRMED**: "there is no distinct codebase-exploration use case needing a separate bundled workflow" -- wr.discovery examples are all strategic; technical codebase archaeology is arguably a different job
- **PROBABLY TRUE**: "the roadmap item should be closed as superseded" -- but depends on project owner's view of whether codebase archaeology deserves a new workflow

### Success Criteria (3)

1. The stale roadmap item for exploration-workflow.json is explicitly resolved: closed as superseded, or converted to a correctly-scoped new ticket
2. The naming/discoverability gap is addressed: users who ask for "exploration" find wr.discovery
3. If codebase-level technical exploration is a legitimate unmet need, it is scoped as a NEW distinct workflow (`wr.explore` or equivalent) -- not confused with the migration task

### HMW Questions (2)

1. **HMW**: How might we ensure that someone looking for "exploration workflow" discovers `wr.discovery` without hitting a not-found error, without renaming wr.discovery?
2. **HMW**: How might we serve developers who need to methodically explore an unfamiliar codebase -- a job that is distinct from problem-space decision-making -- without duplicating wr.discovery's function?

### Primary Framing Risk

**Specific condition that would make this framing wrong:**

> If session data showed that `wr.discovery` is started frequently but abandoned early for technical codebase exploration tasks (distinct from strategic decision tasks) -- specifically if there were evidence that agents invoke wr.discovery for "understand this codebase" work and find it mis-shaped for that job -- then the correct outcome is NOT merely "close the stale roadmap item" but "create a narrow-scope `wr.explore` workflow for codebase archaeology." This would change the primary recommendation from a roadmap housekeeping action to a new workflow creation.
>
> Observable signal: examine session completions for wr.discovery -- if the majority of abandonment comes from early steps where the problem is "technical codebase exploration" rather than "decision or design problem," the framing changes. No such session data was available for this analysis.

---

## Synthesis (Phase 2)

### Opportunity

Clean up a stale roadmap item and surface two real remaining questions:
1. How do we address the naming/discoverability gap (users asking for "exploration-workflow" hit not-found)?
2. Is there a distinct codebase-archaeology use case that warrants a new bundled workflow?

This is NOT a "build a workflow" decision. It's a "decide what to retire, what to clarify, and what new scope (if any) to add" decision.

### Decision Criteria (4)

1. **Does the direction resolve the stale roadmap item without losing work the project owner may have intended?** Closing blindly risks premature closure of a deliberate future intention.
2. **Does the direction address the naming/discoverability gap?** Users asking for "exploration-workflow" by name currently get not-found. This is a real friction point regardless of what else is decided.
3. **Does the direction correctly scope any new workflow work to a distinct, non-duplicative use case?** A new workflow must serve a job wr.discovery doesn't serve, not just give the same job a different name.
4. **Is the direction executable without unavailable data?** Can't require session completion analytics that don't exist. Recommendation must be actionable with available evidence.

### Remaining Uncertainty

**Type: Recommendation uncertainty (bounded)**
- Primary recommendation (roadmap housekeeping): HIGH confidence. Evidence is clear and convergent.
- Sub-question (codebase archaeology): MEDIUM confidence. No session data available. Scoped as a follow-on decision item, not blocking the primary recommendation.

### Hypothesis Challenge Results (Phase 2 adversarial pass)

*Delegation attempt made -- spawn_agent returned outcome=stuck (repeated_tool_call heuristic). Adversarial challenge run by main agent using wr.routine-hypothesis-challenge structure.*

**Target claim challenged:** "The roadmap item should be closed as superseded; wr.discovery is the canonical replacement."

**Verdict: REVISE (not Close, not Reject)**

The "close as superseded" framing is too confident. Key challenge findings:
- The metaGuidance self-identification as "canonical successor" was co-authored by an AI session (Firebender), not a direct project owner statement of intent. This weakens its authority.
- The roadmap item may have represented *two* intents: (a) replace overlapping old workflows (done via wr.discovery), AND (b) create a new explicitly-named exploration workflow with narrower scope. These are different jobs that shouldn't be collapsed.
- Closing the item risks naming debt: the discoverability gap (exploration-workflow → not-found) is never fixed.
- The codebase-archaeology gap would become untracked with no backlog item.

**Revised framing:** Convert the roadmap item -- don't close it. Split into: (1) acknowledge wr.discovery as canonical for problem-space exploration, (2) create a new, correctly-scoped item for whether a `wr.explore` or equivalent lightweight codebase-archaeology workflow is warranted.

### Candidate Count Target

3 candidates (STANDARD path)

## Candidate Directions

### Generation Expectations (Phase 3b setup — design_first path)

**What the candidate set must satisfy:**

- **At least one direction must meaningfully reframe the problem** — not just "do the obvious thing" (close the roadmap item, or create a new workflow). The reframe should surface a constraint or tension that the obvious directions ignore.
- **The directions must be materially different from each other** — not variations of "close vs. close with a note." They should differ in what problem they solve and what they leave unsolved.
- **Each direction must pass the four decision criteria:** (1) resolves roadmap item without losing intent, (2) addresses naming/discoverability gap, (3) scopes any new workflow distinctly, (4) actionable without session analytics.
- **The codebase-archaeology question must be handled explicitly** — not deferred silently. Each direction should take a clear stance on it.
- **No direction should create wr.discovery v2** — the scope is NOT to redesign wr.discovery.

**Anti-clustering guard:** If all 3 candidates converge on "close the item + maybe create something later," they are too clustered. At least one candidate must take a meaningfully different position on the naming gap or the codebase-archaeology question.

**Reframe requirement (design_first):** At least one candidate must question whether the decision unit is correct — i.e., challenge whether fixing the roadmap item is the right first action, or whether the discoverability gap should be addressed at the engine/registry level rather than by creating a new workflow.

### Candidate A: Minimal housekeeping — update planning docs only

**Summary:** Update 3 stale planning docs to record that `exploration-workflow.json` was superseded by `wr.discovery.json`, and open 2 new GitHub issues: one for the discoverability/naming hard-error and one for the codebase-archaeology scope question.

**Tensions resolved / accepted:**
- Resolves: Tension 2 (planning doc currency)
- Accepts: Tension 1 (naming hard error stays live — `WorkflowNotFoundError` still fires)
- Accepts: Tension 3 (discoverability pain deferred to new issue)

**Boundary:** `docs/roadmap/now-next-later.md`, `docs/roadmap/open-work-inventory.md`, `docs/tickets/next-up.md`. No workflow files, no source code, no schema.

**Specific failure mode:** New GitHub issues get opened but never prioritized. The hard error path persists indefinitely. Agents that read the trigger system's startup validation pattern (`trigger-listener.ts:293`) and then hit `WorkflowNotFoundError` for `exploration-workflow` get no helpful guidance.

**Repo pattern relationship:** Directly follows AGENTS.md completion-update pattern. No new pattern.

**Gain / give up:** Gain: zero blast radius, fast, planning docs become truthful. Give up: the hard `WorkflowNotFoundError` stays live; the discoverability gap is not fixed.

**Impact surface:** 3 planning docs + 2 new GitHub issues.

**Scope judgment: Too narrow.** The `WorkflowNotFoundError` for `exploration-workflow` is a real recurring failure mode. The trigger system validates workflow IDs at startup explicitly to prevent silent failures — this team treats `workflow_not_found` as serious. Leaving the hard error live while calling the work "done" contradicts that philosophy.

**Philosophy:** Honors YAGNI. Conflicts with "structure earns its place" (preventing a real recurring failure mode earns its keep, but this candidate doesn't).

---

### Candidate B: Best-fit — thin redirect stub + planning doc updates + new codebase-archaeology issue

**Summary:** Create a minimal `workflows/exploration-workflow.json` stub (3 fields: `id`, `name`, `description`) that immediately redirects users to `wr.discovery` via its `about` field and a single-step prompt saying "this workflow was renamed -- use `wr.discovery` instead." Update 3 planning docs. Open one GitHub issue for codebase-archaeology scope.

**Stub specification:** A single-step workflow with `id: "exploration-workflow"`, `name: "Exploration Workflow (→ wr.discovery)"`, `description: "This workflow ID has moved. Use 'wr.discovery' instead."`, one step with a prompt that tells the agent: "This workflow was renamed to `wr.discovery`. Please restart with `start_workflow wr.discovery`." No loops, no branches, no schema additions required. Uses existing v2 workflow schema (`additionalProperties: false` is satisfied by using only declared fields).

**Why this boundary works:** The workflow schema already supports single-step workflows. No new schema fields needed. The storage layer resolves by exact ID — adding a file with `id: "exploration-workflow"` immediately resolves the `WorkflowNotFoundError`. The engine handles it as a normal workflow with one step.

**Tensions resolved / accepted:**
- Resolves: Tension 1 (naming hard error is fixed — `exploration-workflow` resolves to the stub, which tells users to use `wr.discovery`)
- Resolves: Tension 2 (planning docs updated)
- Accepts: Tension 3 (codebase-archaeology question deferred to new issue, but now explicitly tracked)

**Specific failure mode:** The stub stays in the bundle indefinitely and accumulates technical debt. If `list_workflows` surfaces it, users see two confusingly related workflows. The stub is never removed even after the discoverability problem is addressed properly.

**Repo pattern relationship:** Adapts existing pattern — the bundle already has `test-session-persistence.json` and `test-artifact-loop-control.json` as minimal workflow files. A redirect stub is a new pattern but not alien to the codebase.

**Gain / give up:** Gain: the hard `WorkflowNotFoundError` is fixed immediately with zero engine changes; planning docs become truthful; codebase-archaeology is explicitly scoped. Give up: a stub file in `workflows/` that isn't a "real" workflow; the stub may cause confusion in `list_workflows` output.

**Impact surface:** 1 new stub workflow file + 3 planning docs + 1 new GitHub issue. No source code changes.

**Scope judgment: Best-fit.** Fixes the real failure mode (hard error) with the smallest possible change to workflow files. No engine changes required. The schema supports it today. The stub is explicit and self-documenting. The remaining open question (codebase archaeology) gets a correctly-scoped new item.

**Philosophy:** Honors "structure earns its place" (stub prevents real recurring failure mode). Honors YAGNI (no new full workflow created). Minor conflict with "architectural fixes over patches" — the alias mechanism in the engine would be cleaner, but it's a much larger scope that requires touching protected areas.

---

### Candidate C: Reframe — treat the discoverability gap as an engine feature, not a workflow problem

**Summary:** Do NOT create a stub or alias in the workflow files. Instead, update planning docs AND open a correctly-scoped GitHub issue proposing `aliases: string[]` as a new field in `spec/workflow.schema.json` with corresponding lookup logic in `src/infrastructure/storage/file-workflow-storage.ts` — treating the naming gap as evidence for a general engine feature, not a one-off fix.

**Feature specification:** Add `aliases?: readonly string[]` to `spec/workflow.schema.json` as an optional field. In `getWorkflowById` (`src/infrastructure/storage/file-workflow-storage.ts:254`), when `indexEntry` is null for the primary ID, try a secondary lookup against an alias-to-canonical-id map built during index construction. `wr.discovery.json` would then declare `aliases: ["exploration-workflow", "design-thinking-workflow"]`. The alias map is maintained by workflow authors in workflow files; queried at lookup time; two-pass index build (primary IDs first, then alias expansion).

**Why this boundary:** The engine already indexes workflows by ID at startup. Extending the index to include aliases is a bounded, additive change to `file-workflow-storage.ts` — not a rewrite. The schema change is additive (new optional field). No protected `src/v2/durable-core/` code is touched.

**Tensions resolved / accepted:**
- Resolves: Tension 1 (naming gap fixed architecturally — `exploration-workflow` resolves to `wr.discovery` via the alias map)
- Resolves: Tension 3 (YAGNI pressure is addressed — the alias mechanism is general and handles future renames/consolidations)
- Accepts: Tension 2 (planning docs updated, but the core work is the engine feature, not the doc update)
- Accepts: Tension 3 partially (codebase-archaeology still a separate open question)

**Specific failure mode:** Alias cycles or duplicate aliases across workflows cause index build errors. The `getWorkflowById` secondary lookup adds latency on cache miss for every not-found lookup. Implementation scope expands: schema validator must enforce alias uniqueness, tests must cover alias resolution paths.

**Repo pattern relationship:** Departs from existing pattern — no alias mechanism exists today. Creates a new pattern. Requires schema change + storage layer change + tests.

**Gain / give up:** Gain: architecturally correct fix; solves future renames cleanly; no dead stub files in the bundle; `wr.discovery` self-documents its predecessors. Give up: substantially larger scope; touches schema and storage layer; requires new tests; slower to ship than Candidate B.

**Impact surface:** `spec/workflow.schema.json` (new field), `src/infrastructure/storage/file-workflow-storage.ts` (alias index), `workflows/wr.discovery.json` (aliases field populated), 3 planning docs, test coverage.

**Scope judgment: Too broad** for the immediate problem. The naming gap affects one workflow. Building a general alias mechanism to solve one rename is YAGNI violation. The correct trigger for this feature would be: two or more workflows need aliases, OR the team explicitly decides alias support is a product feature. Neither condition is confirmed today.

**Philosophy:** Honors "architectural fixes over patches." Honors "structure earns its place" (alias mechanism prevents a class of failure modes). Conflicts with YAGNI — no evidence that a general alias mechanism is needed beyond this one case.

---

### Convergence signal

Candidates B and C converge on fixing the naming hard error as the right thing to do. Candidate A is too narrow by the project's own stated philosophy. The divergence is WHERE to fix it: stub file (B) vs. engine feature (C). Both are correct in different circumstances — B is right now (one workflow, YAGNI), C is right if two or more workflows need aliases. The tiebreaker is scope evidence: one confirmed rename vs. speculative future renames. B wins on current evidence.

---

## Recommendation

**Recommended direction: Candidate B — thin redirect stub + planning doc updates + new codebase-archaeology issue**

### Decision criteria verdict

| Criterion | Candidate A | Candidate B | Candidate C |
|---|---|---|---|
| Resolve roadmap item without losing intent | ✓ | ✓ | ✓ |
| Address naming/discoverability gap | ✗ | ✓ | ✓ |
| Scope new work to distinct non-duplicative use case | ~ (deferred) | ✓ (new issue) | ~ (deferred) |
| Actionable without unavailable session analytics | ✓ | ✓ | ✓ |

Candidate B is the only candidate that satisfies all 4 decision criteria.

### Pivot conditions

| Condition | Action |
|---|---|
| `bundled-workflow-smoke.test.ts` rejects redirect stubs | Fall back to Candidate A, escalate Candidate C as scoped feature |
| Project owner confirms codebase archaeology is priority | Add new `wr.explore.json` scoped to codebase mapping (distinct from wr.discovery) |
| Second workflow consolidation creates another naming hard error | Trigger Candidate C (engine alias feature) |
| `list_workflows` confusion with stub reported | Add `hidden`/`deprecated` schema field (small new scope) |

---

## Challenge Notes

**Three key challenged assumptions (from Phase 0):**
1. Content soundness: file doesn't exist, so there's nothing to assess as sound or unsound
2. v2 features as bottleneck: structural polish is not quality; prompt content matters more
3. Priority staleness: roadmap was set before 30+ CI failures and before `wr.discovery` was mature

---

## Resolution Notes

*(To be populated when a recommendation is finalized)*

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| Phase 0 | Classified goal as solution_statement | Named specific migration steps, not an outcome |
| Phase 0 | Identified exploration-workflow.json as missing | File search confirmed absence in workflows/ |
| Phase 0 | Recommended design_first path | Dominant risk is wrong problem, not missing information |
| Phase 0 | Set rigorMode to STANDARD | This is a workflow design decision, not a security or engine change |
| Phase 0b | Confirmed exploration-workflow.json was intentionally deleted | git log --diff-filter=D confirmed deletion in a0ddaaac with explicit consolidation commit message |
| Phase 0b | Confirmed wr.discovery.json is the canonical replacement | Commit message: "Unify the overlapping exploration and design-thinking workflows into a single discovery workflow" |
| Phase 0b | delegationAvailable = true, not used | spawn_agent tool present in tool set; not needed -- analysis is codebase-local |
| Phase 0b | webBrowsingAvailable = true, not used | curl probe succeeded; no external research needed for this determination |
| Phase 0b | retriageNeeded = true | The roadmap item is stale; wr.discovery IS the exploration workflow; may recommend closing the ticket |
| Phase 1c | Identified 3 precedents in landscape | lean v2.0.0 (deleted), wr.discovery v3.2.0 (current), Comprehensive Adaptive v0.1.0 (user-pinned community, v1 schema) |
| Phase 1c | Identified 2 contradictions | (1) stale roadmap vs. intentional deletion; (2) pinned community workflow shows appetite for depth but uses deprecated patterns |
| Phase 1c | Identified 1 evidence gap | No data on whether wr.discovery covers codebase-level technical exploration (distinct from problem-space discovery) |
| Phase 1c | No delegation used | rigorMode = STANDARD; all evidence is codebase-local; direct analysis is sufficient |
| Phase 1f | Identified 4 tensions | naming/discoverability, lean vs. depth, problem-space vs. codebase exploration, roadmap currency |
| Phase 1f | Confirmed primary framing risk | If wr.discovery is systematically abandoned for codebase-archaeology tasks, a new narrow workflow is needed |
| Phase 1f | wr.discovery explicitly self-identifies as successor | metaGuidance: "canonical successor to the old exploration and design-thinking workflows. If I ask for either of those by name, this is the workflow I mean." |
| Phase 1f | No delegation used | rigorMode = STANDARD; parallel stakeholder lenses would not add information beyond what codebase analysis surfaces |
| Phase 3d | Selected Candidate B (redirect stub) | Fixes hard WorkflowNotFoundError at minimum surface; smoke test verified safe (checks compile+steps+render, not output quality); stub content must preserve codebase-archaeology nuance |
| Phase 3d | Runner-up: Candidate C (engine alias) | Architecturally correct but premature -- one confirmed rename, no second case; YAGNI violation |
| Phase 3d | Candidate A eliminated | Strictly dominated by B; leaves hard error live with no additional benefit |
| Phase 3d | Challenge run by main agent | Prior spawn attempt returned stuck (wr.discovery workflow repeated_tool_call heuristic); second attempt avoided to prevent same outcome; challenge quality adequate for STANDARD rigor |
| Phase 3d | Stub content modification from challenge | Prompt must mention codebase-archaeology is a different job not covered by wr.discovery -- avoids encoding wrong assumption permanently |
| Direction review | No direction change | ORANGE findings are implementation requirements (spec correction + required prompt wording), not structural flaws. YELLOW findings already incorporated in hybrid. No RED findings. Direction confirmed: hybrid Candidate B. |
| Direction review | Hybrid additions confirmed | (1) Corrected stub spec with title field + codebase-archaeology prompt; (2) wr.discovery description update naming predecessors; (3) 3 planning doc updates; (4) new GitHub issue with Candidate C pivot condition |
| Direction review | Residual concern elevated | Consolidation commit was AI-authored -- project owner should independently verify wr.discovery fully covers exploration use case before roadmap item is closed. Human-gate, not technical blocker. |

---

## Final Summary

### Recommendation (HIGH confidence)

**Do: Hybrid Candidate B — 4 deliverables, no source code changes, no schema changes**

This recommendation is supported by convergent evidence from git history, schema inspection, storage layer inspection, smoke test inspection, and multiple adversarial challenge passes. No structural flaw was found.

---

### Deliverable 1: `workflows/exploration-workflow.json` (new file)

```json
{
  "id": "exploration-workflow",
  "name": "Exploration Workflow [deprecated — use wr.discovery]",
  "version": "3.0.0",
  "description": "This workflow ID has moved. The exploration and design-thinking workflows were consolidated into wr.discovery (Discovery Workflow) in March 2026. Temporary redirect stub — replace with engine-level alias support if a second workflow rename creates another WorkflowNotFoundError.",
  "steps": [
    {
      "id": "redirect",
      "title": "This workflow has moved",
      "prompt": "This workflow has been renamed and restructured as 'wr.discovery' (Discovery Workflow).\n\nFor problem-space exploration, decision-making, design thinking, or comparing approaches to an ambiguous problem: start a new session with start_workflow using id 'wr.discovery'.\n\nImportant distinction: if your goal is to systematically map or understand an unfamiliar codebase -- tracing architecture, call stacks, data flows, or module structure -- that is a different job from problem-space exploration. No dedicated bundled workflow covers it yet. Use your standard code investigation tools (Grep, Read, Bash) directly for that task."
    }
  ]
}
```

*Why this works:* The storage layer (`file-workflow-storage.ts:254`) does exact-ID lookup. Adding a file with `id: "exploration-workflow"` immediately resolves `WorkflowNotFoundError` to this stub. The stub's single step provides explicit guidance. Schema validation: all required fields satisfied (`id` ≥3 chars, `name` ≥1, `description` ≥1, `version` string, `steps` minItems 1; step has `id` and `title`). Smoke test: checks compile+render, not output substance — stub passes.

---

### Deliverable 2: `workflows/wr.discovery.json` description update (one sentence)

Change the current description from:

> "Use this to explore and think through a problem end-to-end. Moves between landscape exploration, problem framing, candidate generation, adversarial challenge, and uncertainty resolution."

To:

> "Use this to explore and think through a problem end-to-end. Moves between landscape exploration, problem framing, candidate generation, adversarial challenge, and uncertainty resolution. This is the canonical successor to exploration-workflow and design-thinking-workflow -- if you are looking for either of those by name, this is the right workflow."

*Why:* Makes the predecessor relationship discoverable from the canonical workflow file itself. Survives stub deletion. Zero schema changes (description is an existing required string field).

---

### Deliverable 3: Planning doc updates (3 files)

**`docs/roadmap/now-next-later.md`** (Next section) -- replace the exploration-workflow.json item:
- Remove: "`exploration-workflow.json` is the highest-priority candidate."
- Replace with: "`exploration-workflow.json` was superseded by `wr.discovery` v3.2.0 (commit `a0ddaaac`, Mar 2026). A redirect stub was added at `workflows/exploration-workflow.json`. The open question -- whether codebase-archaeology tasks warrant a dedicated `wr.explore` workflow -- is tracked separately."

**`docs/roadmap/open-work-inventory.md`** (Legacy workflow modernization section) -- update `exploration-workflow.json` status to: complete/superseded. `wr.discovery` v3.2.0 is the replacement. Redirect stub added. Remaining modernization candidates: `mr-review-workflow.json`, `bug-investigation.json`, etc.

**`docs/tickets/next-up.md`** (Ticket 2) -- retitle or replace: "Legacy workflow modernization -- exploration-workflow.json" → point to the new GitHub issue for codebase-archaeology scope. Note the supersession.

---

### Deliverable 4: New GitHub issue

**Title:** `feat(workflows): decide whether codebase-archaeology exploration warrants a new wr.explore workflow`

**Labels:** `feature`, `next`

**Body (summary):**
- Problem: `wr.discovery` is shaped for problem-space exploration and strategic decision-making. Systematic codebase mapping (architecture, call stacks, data flows) is a different job with different tools. No bundled workflow explicitly covers it.
- Evidence gap: no session data confirming this gap causes real pain vs. being hypothetical.
- Acceptance criteria: investigate whether agents invoke `wr.discovery` for codebase-archaeology tasks and find it mis-shaped; if confirmed, create `wr.explore.json` scoped to codebase mapping only.
- **Pivot condition for engine alias feature (Candidate C):** if a SECOND workflow rename creates another `WorkflowNotFoundError`, escalate this issue to include adding `aliases?: string[]` to `spec/workflow.schema.json` and secondary alias lookup to `src/infrastructure/storage/file-workflow-storage.ts`.

---

### Strongest alternative (runner-up)

**Candidate C — engine alias feature:** Add `aliases?: readonly string[]` to `spec/workflow.schema.json`; extend `getWorkflowById` for secondary alias lookup; populate `wr.discovery.json` aliases. This is the architecturally correct fix. It loses to Candidate B today because YAGNI: one confirmed rename does not justify a general feature. The pivot condition is explicit: second rename confirmed OR project owner explicitly ships alias support as a product feature.

---

### Confidence band: HIGH

All technical claims verified analytically (storage layer, schema, smoke test). Adversarial challenge found only bounded implementation requirements, no structural flaws. Direction review confirmed no change needed.

**One human-gate residual risk:** The consolidation commit (`a0ddaaac`) was AI-authored (Firebender co-author). The "canonical successor" metaGuidance claim in `wr.discovery.json` was written by that session. The project owner should independently verify that `wr.discovery` fully covers their intended exploration use case before the roadmap item is formally closed. If the project owner has a different intent, the GitHub issue (Deliverable 4) should be converted to a new workflow creation ticket rather than a scope-decision ticket.

---

### What this does NOT do

- Does NOT touch `src/v2/durable-core/` (protected)
- Does NOT change `spec/workflow.schema.json`
- Does NOT create a new exploration workflow
- Does NOT pretend the codebase-archaeology gap doesn't exist
- Does NOT require session analytics data to implement
