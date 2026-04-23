# Discovery: Workflow Modernization Backlog Audit

*Session artifact -- human-readable summary. Durable truth lives in session notes and context.*

**Artifact strategy:** This document is for human readers only. It does not need to be complete or current for the session to function correctly. If a chat rewind occurs, the session's `notesMarkdown` and context variables are the authoritative record -- this file may be stale or absent. Do not treat this doc as a checkpoint or source of truth for workflow execution.

**Capability summary:**
- Web browsing: AVAILABLE (curl probe confirmed reachable) -- but NOT needed; all required information is local
- Delegation (spawn_agent): AVAILABLE (tool present in session, spawn depth < 3) -- deferred to candidate-generation phase where parallel cognitive lenses add value; not useful for local file reading
- GitHub CLI: AVAILABLE (`gh` confirmed working)
- Local session store: AVAILABLE and queried (`~/.workrail/data/sessions` yielded real usage counts)

---

## Context / Ask

**Stated goal (original):** Modernize `workflows/exploration-workflow.json` to current v2/lean authoring patterns. This is the highest-priority candidate among the unmodernized workflows.

**Statedgoal classification:** `solution_statement` -- names a specific file and solution, not an outcome.

**Reframed problem:** Some bundled workflows still in use provide lower-quality agent guidance than the current authoring standard allows, and the planning documents tracking this work reference files that no longer exist -- making it impossible to execute the stated backlog without first auditing what actually exists and what is worth keeping.

---

## Critical Finding: Planning Docs Are Stale

**`exploration-workflow.json` does not exist.** It was:
1. Modernized in PR #158 (March 27, 2026, commit `edbc3161`)
2. Deleted and consolidated into `workflows/wr.discovery.json` (commit `a582e1a1`)

All 10 filenames in the primary modernization list are missing from the repo. The planning documents (`now-next-later.md`, `open-work-inventory.md`, `tickets/next-up.md`) all reference stale filenames.

**The stated backlog cannot be executed as written.** A real audit of existing files against actual usage is the prerequisite.

---

## Path Recommendation

**Path: `landscape_first`**

The dominant need is understanding the current state -- what workflows exist, which are actively used, what modernization gaps each actually has. The goal was stated as a solution (file + technique), but the underlying problem is best served by first establishing a correct, usage-ranked picture of the real modernization backlog.

**Why not `design_first`?** The modernization technique itself is not in question -- the authoring guide is clear, the spec is versioned, the target state is known. The risk is not solving the wrong problem; it is executing against a stale and incorrect task list.

**Why not `full_spectrum`?** This is not an ambiguous problem requiring deep reframing. It is an operational audit problem: match current reality to the planning system, then execute in priority order.

---

## Constraints / Anti-goals

**Constraints:**
- Do not modify protected files (`src/daemon/`, `src/trigger/`, `src/v2/`, `triggers.yml`)
- All changes must pass `npx vitest run`
- Never modernize in a way that breaks existing session behavior (no step ID renames on active workflows)

**Anti-goals:**
- Do not mechanically rename files to `.v2` or `.lean` -- that is cargo-cult modernization
- Do not add `metaGuidance` fields just to clear a checklist item if the content is empty or generic
- Do not modernize workflows that are effectively retired (near-zero usage and no unique value)
- Do not update planning docs to be accurate only to immediately make them stale again -- the audit output should drive concrete, executable ticket updates

---

## Landscape Packet

### Usage-ranked workflow inventory (actual, as of this session)

| Usage | Workflow ID | File | Spec Stamp | Gaps |
|------:|-------------|------|-----------|------|
| 910 | wr.coding-task | coding-task-workflow-agentic.json | unstamped | features, stamp |
| 606 | wr.mr-review | mr-review-workflow.agentic.v2.json | unstamped | stamp only |
| 461 | wr.discovery | wr.discovery.json | v3 (current) | MODERN |
| 125 | wr.production-readiness-audit | production-readiness-audit.json | unstamped | stamp only |
| 74 | wr.bug-investigation | bug-investigation.agentic.v2.json | unstamped | features, stamp |
| 64 | wr.architecture-scalability-audit | architecture-scalability-audit.json | unstamped | stamp only |
| 51 | wr.ui-ux-design | ui-ux-design-workflow.json | v3 (current) | MODERN |
| 39 | wr.diagnose-environment | workflow-diagnose-environment.json | unstamped | meta, recs, features, stamp |
| 39 | wr.shaping | wr.shaping.json | unstamped | features, stamp |
| 33 | wr.workflow-for-workflows | workflow-for-workflows.json | v3 (current) | MODERN |
| 7 | wr.documentation-update | documentation-update-workflow.json | unstamped | recs, features, stamp |
| 5 | wr.document-creation | document-creation-workflow.json | unstamped | recs, features, stamp |
| 4 | wr.scoped-documentation | scoped-documentation-workflow.json | unstamped | recs, features, stamp |
| 4 | wr.cross-platform-code-conversion | cross-platform-code-conversion.v2.json | unstamped | features, stamp |
| 3 | wr.adaptive-ticket-creation | adaptive-ticket-creation.json | unstamped | recs, features, stamp |
| 2 | wr.relocation-us | relocation-workflow-us.json | unstamped | features, stamp |
| 0 | wr.intelligent-test-case-generation | intelligent-test-case-generation.json | unstamped | recs, features, stamp |
| 0 | wr.personal-learning-course-design | learner-centered-course-workflow.json | unstamped | recs, features, stamp |
| 0 | wr.personal-learning-materials | personal-learning-materials-creation-branched.json | unstamped | recs, features, stamp |
| 0 | wr.presentation-creation | presentation-creation.json | unstamped | recs, features, stamp |
| 0 | wr.classify-task | classify-task-workflow.json | v3 (current) | MODERN (but 0 usage) |

### Modernization depth classification

| Level | Description | Count | Workflows |
|-------|-------------|-------|-----------|
| L0 | MODERN -- no action needed | 4 | wr.discovery, wr.ui-ux-design, wr.workflow-for-workflows, wr.classify-task |
| L1 | Stamp only | 2 | wr.production-readiness-audit, wr.architecture-scalability-audit |
| L2 | Stamp + features declaration | 0 | (none -- all that need features also need raw->promptBlocks migration) |
| L3 | Raw prompt -> promptBlocks migration + features | 6 | wr.coding-task(910), wr.mr-review(606), wr.bug-investigation(74), wr.shaping(39), wr.cross-platform-code-conversion(4), wr.relocation-us(2) |
| L4 | Missing basics (no recs, raw prompts, no features) | 9 | wr.documentation-update(7), wr.document-creation(5), wr.scoped-documentation(4), wr.adaptive-ticket-creation(3), wr.intelligent-test-case-generation(0), wr.personal-learning-course-design(0), wr.personal-learning-materials(0), wr.presentation-creation(0), wr.diagnose-environment(39) |

### Critical architectural finding: features only work with promptBlocks

**Features injection (`wr.features.capabilities`, `wr.features.subagent_guidance`) only applies to steps using `promptBlocks`.** Raw `prompt` field steps are explicitly skipped by the compiler (`src/application/services/compiler/resolve-features.ts`, line 62: `if (!step.promptBlocks || features.length === 0) return step;`).

This means:
- `wr.coding-task` (910 uses, ALL 9 steps are raw prompt) -- declaring `features` in the header has **zero runtime effect** until steps are migrated to `promptBlocks`
- `wr.bug-investigation` (74 uses, ALL 8 steps are raw prompt) -- same
- `wr.shaping` (39 uses, ALL 8 steps are raw prompt) -- same
- `wr.mr-review` (606 uses, 3 of 6 steps are raw prompt) -- features only inject into the 3 promptBlocks steps

**Raw prompt → promptBlocks migration is a prerequisite for features to matter.** This is a deeper migration than just adding a features declaration.

### Modern workflows (no modernization needed)
- `wr.discovery` (v3.2.0, stamped, full features, all promptBlocks)
- `wr.ui-ux-design` (v3 stamped, features declared, all promptBlocks)
- `wr.workflow-for-workflows` (v3 stamped, references, features, all promptBlocks)
- `wr.classify-task` (v3 stamped -- but 0 usage, may need visibility review)

### Contradictions in prior understanding

**[C1] HIGH -- Planning docs name 10 files, all missing**
All 10 filenames in the primary modernization list (`now-next-later.md`, `open-work-inventory.md`, `tickets/next-up.md`) do not exist on disk. They were renamed, merged, or deleted in March 2026 during a workflow consolidation sprint.

**[C2] HIGH -- Adding `wr.features` to `wr.coding-task` would have zero runtime effect**
`wr.coding-task` has 9 raw `prompt` steps and 0 `promptBlocks` steps. The compiler explicitly skips feature injection for raw prompt steps. The "missing features" gap reported for this workflow is not a simple header field addition -- it requires a full step structure migration first.

**[C3] MEDIUM -- `wr.mr-review` has a deeper gap than "stamp only"**
Earlier assessment said stamp was the only gap. Actually, 3 of 6 steps use raw prompt and would not receive feature injections. The stamp gap is real, but the structural gap is also real.

**[C4] MEDIUM -- `wr.coding-task` already has substantive delegation/parallelism guidance in metaGuidance**
`wr.coding-task` has 11 `metaGuidance` items including explicit ownership, delegation, and parallelism rules. The `wr.features.subagent_guidance` would inject similar content via promptBlocks, potentially duplicating what already exists in metaGuidance prose. This needs de-duplication thinking, not blind injection.

### Evidence gaps

- Usage telemetry uses all-time counts including old deleted workflow IDs (`exploration-workflow: 19`, `design-thinking-workflow: 42`). Recent counts would be more actionable.
- No before/after session quality comparison for any modernization -- whether promptBlocks migration produces measurably better sessions is assumed but unvalidated.
- Unknown: why `wr.coding-task` and `wr.bug-investigation` use raw prompts (intentional choice? legacy carryover? waiting for migration tooling?).
- Unknown: whether any zero-usage workflows are referenced in external team configs that would make them important to keep despite 0 local sessions.

### What "unstamped" actually means
17 of 21 workflows lack `validatedAgainstSpecVersion`. This is advisory-only (no CI failure), but signals they haven't been reviewed against spec v3. The `stamp-workflow` script resolves this after running `workflow-for-workflows` on them.

### Key gap: `wr.features` adoption
Most workflows do not declare `wr.features.capabilities` or `wr.features.subagent_guidance`. These inject concrete constraints and procedure items into every step at compile time -- they are not cosmetic. High-usage workflows missing them: `wr.coding-task` (910 uses), `wr.bug-investigation` (74), `wr.shaping` (39).

### What the planning docs say vs. reality
The planning docs reference all of:
- `exploration-workflow.json` -- DELETED, replaced by wr.discovery
- `wr.adaptive-ticket-creation.json` -- exists but as `adaptive-ticket-creation.json`
- `mr-review-workflow.json` -- DELETED, v2 is `mr-review-workflow.agentic.v2.json`
- `mr-review-workflow.agentic.json` -- DELETED
- `bug-investigation.json` -- DELETED, v2 is `bug-investigation.agentic.v2.json`
- `bug-investigation.agentic.json` -- DELETED
- `design-thinking-workflow.json` -- DELETED, merged into wr.discovery
- `design-thinking-workflow-autonomous.agentic.json` -- DELETED
- `wr.documentation-update.json` -- exists as `documentation-update-workflow.json`
- `wr.document-creation.json` -- exists as `document-creation-workflow.json`

---

## Problem Frame Packet

### Users / Stakeholders

1. **Daemon sessions as consumers** (primary): autonomous agents running inside `wr.coding-task`, `wr.mr-review`, `wr.bug-investigation` etc. receive the workflow step prompts. These are the actual beneficiaries of better guidance -- 910 runs of wr.coding-task alone.
2. **Workflow authors** (secondary): developers writing and maintaining workflow JSON. They need planning docs that reflect reality, and a modernization approach that doesn't require heroic manual effort.
3. **Project owner** (decision authority): decides what merges, what gets prioritized, and what gets retired. Needs a clear prioritized plan, not an open-ended backlog.

### Jobs, Goals, Outcomes

- Agents should receive step prompts that reinforce behavioral constraints (durability, delegation, synthesis ownership) without relying on the agent to have read and retained `metaGuidance` at inspection time.
- Workflow authors should be able to trust that planning docs reflect actual file paths and current priorities.
- The CI staleness advisory should shrink -- it currently fires for 17/21 workflows, creating noise.

### Pains / Tensions

- **Pain 1 (high):** `metaGuidance` is inspection-time-only -- it shows when an agent calls `inspect_workflow` but does NOT inject into per-step prompts. For high-usage workflows like `wr.coding-task`, behavioral constraints only appear at inspection time, not at each step where they are most needed. Feature injection via `promptBlocks` is the per-step mechanism, but it requires step migration first.
- **Pain 2 (high):** Planning docs are stale -- all 10 filenames in the primary modernization list don't exist. Backlog cannot be executed as written.
- **Pain 3 (medium):** The modernization approach (add features field) has zero runtime effect on workflows still using raw `prompt` steps. The real fix (raw→promptBlocks migration) is 10x the effort of adding a header field.
- **Tension 1:** Modernizing `wr.coding-task` (910 uses, 14 steps, all raw prompt) is the highest-impact action, but also the riskiest -- changing the step structure of a heavily used workflow could break in-flight sessions or degrade guidance quality if done carelessly.
- **Tension 2:** Stamp-only passes are fast and reduce advisory noise, but they falsely signal "reviewed against spec v3" when the content has not actually changed.

### Constraints That Matter in Lived Use

- `wr.features` injection is compile-time -- changing a workflow file is immediately effective for NEW sessions; in-flight sessions use the pinned version
- Step IDs must not be renamed on widely-used workflows (session continuity depends on stable step IDs in active sessions)
- Any change must pass `npx vitest run` -- the bundled workflow smoke test covers all workflows automatically

### Success Criteria (observable and falsifiable)

1. `now-next-later.md`, `open-work-inventory.md`, `tickets/next-up.md` reference only filenames that exist in `workflows/` (checkable with `ls`)
2. `wr.production-readiness-audit` and `wr.architecture-scalability-audit` have `validatedAgainstSpecVersion: 3` after stamp
3. At least one high-usage L3 workflow (e.g. `wr.shaping`, 39 uses, 8 raw steps) has been fully migrated to `promptBlocks` and declares `wr.features.capabilities` -- can be verified by checking the JSON and running the compiler
4. `npx vitest run` passes after all changes
5. The staleness advisory list shrinks by at least 2 entries (the L1 stamps)

### Assumptions Still Active

- **A1:** Migrating `wr.coding-task` raw prompts to `promptBlocks` is safe without breaking the existing step logic. (Unvalidated -- needs careful review of each step's prompt content vs. promptBlocks rendering)
- **A2:** `metaGuidance` at inspection time is insufficient for behavioral reinforcement in long sessions. (Structurally supported but empirically unvalidated)
- **A3:** Zero-usage workflows (presentation-creation, personal-learning-materials etc.) are safe to deprioritize indefinitely. (May be used by external teams not captured in local session store)

### What Would Make This Framing Wrong

- If agents reliably call `inspect_workflow` before each session and retain `metaGuidance` throughout, the per-step injection via promptBlocks may be redundant overhead. (Unlikely given how daemon sessions work -- they receive step prompts directly without prior inspection)
- If wr.coding-task raw prompts were authored this way intentionally (as a v1-style "trust the agent" design), migrating them would work against the author's intent. (Git history shows no explicit reasoning for the choice -- likely legacy carryover from before promptBlocks existed)

### HMW Reframes

1. **HMW ensure behavioral constraints reach agents at the moment they need them (per step), not just at inspection time?** -- This reframe surfaces promptBlocks migration as the core action, not just field additions.
2. **HMW reduce the gap between what planning docs say and what the repo actually contains?** -- This reframe surfaces that planning doc accuracy is itself a product quality issue, separate from workflow file quality.

### Framing Risk

The biggest framing risk: treating this as "modernization work" (cosmetic checklist) when the real problem is "per-step behavioral guidance is not reaching agents reliably." A stamp pass or features header addition would satisfy the planning doc metric while doing nothing for the agents that run these workflows 910 times.

---

## Opportunity Synthesis

Two problems to solve in sequence:

**Problem 1 (prerequisite): Planning system is stale.** All 10 named files in the modernization backlog are deleted. No execution can proceed against the current plan.

**Problem 2 (the real work): High-usage workflows lack per-step behavioral guidance.** `metaGuidance` is inspection-time-only and not surfaced to daemon sessions. `wr.features` injection (the per-step path) requires `promptBlocks` steps, but `wr.coding-task` (910 runs), `wr.bug-investigation` (74 runs), and `wr.shaping` (39 runs) are entirely raw-prompt. Declaring features without migrating steps has zero runtime effect.

**Self-challenge results (5 challenges conducted):**
- Challenge 1: metaGuidance inspection-time claim confirmed by source code -- absent from start_workflow, continue_workflow, and daemon workflow-runner
- Challenge 2: features-requires-promptBlocks confirmed by `resolve-features.ts` line 62 -- intentional design decision
- Challenge 3: **FRAMING CORRECTION** -- wr.coding-task should NOT be the first L3 migration target. wr.shaping (39 uses, 8 steps) is the risk-appropriate starting point. Validate the migration pattern there before attempting the 910-run workflow.
- Challenge 4: planning doc staleness is a genuine prerequisite, not a side issue
- Challenge 5: stamp-only is honest for L1 workflows (already modern); dishonest for L4 without prior review

**Riskiest assumption:** That migrating wr.coding-task's 9 raw prompt steps to promptBlocks will preserve the semantic quality of the existing prompts without fragmenting or diluting the guidance. Mitigation: validate on wr.shaping first.

## Decision Criteria

A valid direction must satisfy all of the following:
1. Step IDs not renamed on active high-usage workflows (session continuity)
2. `npx vitest run` passes after each change
3. Planning docs reference only existing filenames after update
4. Modernization order follows usage-ranked priority, not arbitrary list order
5. Stamp follows genuine review (not precedes it) -- at minimum for L1 workflows

## Candidate Directions

**Direction A (Recommended): Fix planning docs + stamp L1 + migrate wr.shaping as first L3 target**
- Update planning docs to correct filenames and usage-ranked priority
- Review + stamp `wr.production-readiness-audit` and `wr.architecture-scalability-audit` (L1 -- already modern)
- Migrate `wr.shaping` (39 uses, 8 raw steps) to full promptBlocks + features as the risk-appropriate first L3 migration
- Defer wr.coding-task until wr.shaping validates the migration pattern
- Ship as one PR (planning doc changes + stamp + first L3 migration)

**Direction B: Fix planning docs only, output a usage-ranked ticket**
- Update the three planning docs to reflect real filenames and real usage order
- Create a GitHub issue with the correct prioritized modernization backlog
- No workflow file changes in this PR -- separate concerns, minimize blast radius
- Pro: cleanest separation; Con: defers the actual guidance quality fix

**Direction C: Stamp-only pass on L1 + planning doc fixes, defer all L3 migration**
- Fix planning docs
- Review + stamp wr.production-readiness-audit and wr.architecture-scalability-audit
- Explicitly defer all raw→promptBlocks migration to a future PR
- Pro: very low risk; Con: doesn't address the per-step guidance gap at all

**Direction D: Fix planning docs + full L3 migration of wr.shaping + wr.coding-task in one PR**
- Aggressive scope: modernize two L3 workflows in a single PR
- High impact but also high review burden; wr.coding-task is 14 steps
- Pro: maximum value delivered; Con: risky, large diff, hard to review carefully

---

## Candidate Generation Requirements (landscape_first path)

The following expectations apply to the next candidate generation pass. They are recorded here so the synthesis step can judge whether the candidates met the bar.

### What the candidate set must reflect (landscape_first constraints)

1. **Grounded in actual usage data.** Candidates must reflect the usage-ranked inventory (wr.coding-task: 910, wr.mr-review: 606, etc.) -- not an alphabetical or arbitrary ordering. Any direction that does not prioritize by usage fails this criterion.

2. **Must account for the architectural constraint.** Candidates cannot treat "declare wr.features in the header" as meaningful for workflows that are entirely raw-prompt. The only valid modernization path for L3 workflows is raw→promptBlocks migration. Directions that skip this constraint are disqualified.

3. **Must address both problems (planning docs AND workflow quality).** A direction that only fixes planning docs without any workflow quality improvement is incomplete. A direction that modernizes workflows without fixing planning docs first is unorderable (can't find the files). Both problems must appear in every viable direction.

4. **Must not invent a third problem.** The scope is: fix planning system accuracy AND improve per-step guidance delivery for high-usage workflows. Candidates that reframe toward "build a migration tooling layer" or "redesign the features system" are out of scope -- those are good ideas but belong in the backlog, not in this decision.

5. **Must include at least one direction that explicitly scopes OUT wr.coding-task.** The riskiest assumption is that wr.coding-task can be migrated without quality degradation. At least one candidate must treat wr.shaping as the only L3 migration target in the first PR, deferring wr.coding-task to a follow-on.

6. **Must include at least one direction that includes wr.coding-task.** The counterpoint must also exist -- the highest-usage workflow deserves a candidate that argues for tackling it now.

### What would disqualify a candidate

- Proposes "stamp first, review later" for L4 workflows
- Ignores the raw→promptBlocks prerequisite
- Treats planning doc fixes as optional
- Proposes step ID renames on active workflows
- Requires changes to protected files (src/daemon/, src/trigger/, src/v2/)

---

## Decision Log

- **2026-04-28**: Discovered `exploration-workflow.json` does not exist -- it was deleted in March 2026. Planning docs are stale. Path selection shifted to `landscape_first`.
- **Capability check**: No web access needed -- all data is local (repo files, session store). Web browsing available but not used.
- **Delegation**: Not used for file reading/analysis. Delegation deferred to candidate generation; decision at phase 3b was to use self-generation given STANDARD rigor and well-evidenced context.
- **Self-challenge (Phase 2)**: 5 challenges conducted. Key correction: wr.shaping (not wr.coding-task) is the risk-appropriate first L3 migration target. Stamp is honest for L1, dishonest for L4 without prior review.

---

## Challenge Notes

*(to be populated after direction challenge in phase 3d)*

---

## Resolution Notes

*(to be populated at phase 5)*

---

## Final Summary

*(to be populated at handoff)*

