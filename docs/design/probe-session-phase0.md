# Design Session: Capability Probe (Phase 0)

> **Note (updated):** This doc has been updated by a second session triggered by the same probe pattern. Prior session findings are preserved below. New session additions are marked with `[Session 2]`.

## Context / Ask

This session was initiated as a **capability probe** (`probeOnly: true`). The trigger instruction was:

> "This is a delegation capability probe. Complete immediately. Return 'delegation_confirmed' in your step notes."

The workflow advanced past the probe step into Phase 0. Since no real human goal was provided, Phase 0 is documenting the probe outcome and the most natural candidate goal given current project state.

**Stated goal (trigger, Session 1):** Confirm WorkRail Executor delegation is available.
**Stated goal (trigger, Session 2):** Same probe pattern, different phrasing -- "delegation_confirmed" string required.

**Reframed problem (Session 1):** The WorkRail project's highest-priority unstarted work is legacy workflow modernization (`exploration-workflow.json` and peers). The probe was a prerequisite check to determine whether parallel delegation could accelerate that work.

**Reframed problem (Session 2, from Phase -1 challenge step):** Before committing to a multi-step research path that may rely on optional runtime capabilities, determine which capabilities are actually available in this session so the execution path can be appropriately scoped or degraded without silent failure.

---

## Path Recommendation

**`design_first`** -- because the trigger was a `solution_statement` (probe a specific capability) and the real underlying need (modernize legacy workflows efficiently) requires first confirming what tools are available and how they affect approach.

**Why not `landscape_first`:** The landscape (current workflow inventory, modernization criteria) is already well-documented in `docs/tickets/next-up.md` and `docs/roadmap/open-work-inventory.md`. We don't need another survey.

**Why not `full_spectrum`:** The problem definition is clear; the uncertainty is execution strategy (with vs. without delegation).

---

## Constraints / Anti-goals

**Constraints:**
- No `wr.executor` workflow exists -- delegation is unavailable
- All synthesis must remain with the main agent
- Protected files (`src/daemon/`, `src/v2/`, etc.) must not be touched
- Must not push directly to main

**Anti-goals:**
- Do not confabulate a problem to fill the workflow's structure
- Do not pretend delegation is available when it is not

---

## Capability Probe Results

| Capability | Status | Evidence | Session |
|---|---|---|---|
| `wr.executor` delegation | **UNAVAILABLE** | `spawn_agent` returned `workflow_not_found: wr.executor` | Session 1 |
| Web browsing tool | **UNAVAILABLE** | No web browsing MCP tool in agent tool set (Bash/Read/Write/Edit/Glob/Grep/spawn_agent/signal_coordinator/complete_step/report_issue only) | Session 1 |
| `wr.executor` delegation | **UNAVAILABLE** | Session 2 live probe: `spawn_agent(workflowId: "wr.executor")` returned `outcome: "error"`, `notes: "workflow_not_found -- wr.executor"` | Session 2 |
| Network reachability | **AVAILABLE** | `curl https://example.com` succeeded within 5s | Session 2 |
| Web browsing tool | **UNAVAILABLE** | No structured web tool (WebFetch, BrowseWeb, etc.) in Session 2 tool set; network is up but no tool bridges it | Session 2 |

**Fallback path (both sessions):** Main-agent-only execution, codebase-only research. All analysis, synthesis, and writing handled inline using local file tools and Bash.

**Limitations:** No independent parallel cognitive perspectives from subagents; no external research beyond repository contents.

**`retriageNeeded`:** `false` -- prior session findings + Session 2 live probes confirm same capability state. Path recommendation (`design_first`) and rigor mode (`STANDARD`) remain valid. No path change needed.

---

## Artifact Strategy

This design doc (`docs/design/probe-session-phase0.md`) is a **human-readable artifact only**. It is not workflow memory.

| What | Where | Durable across rewind? |
|---|---|---|
| Execution truth (decisions, findings, rationale) | Step notes + context variables | Yes |
| Path state (goalType, reframedProblem, capabilities) | Context variables | Yes |
| Human-readable synthesis, design reasoning | This doc | No (sidecar -- may not survive rewind) |
| GitHub tickets / PR references | `gh` CLI + issue numbers in notes | Yes (external system) |

**What this doc is for:** Human review, design reasoning legibility, optional reference by the project owner.

**What this doc is NOT:** Required for the workflow to continue correctly. If this file is lost or diverges, the session notes and context variables are the authoritative source. The doc is reconstructable from step notes if needed.

**Update discipline:** Update this doc at each phase boundary. Do not let it get more than one step out of date. If a chat rewind occurs and the doc is stale, trust the step notes over the doc.

---

## Landscape Packet

> **[Session 2 update]:** Fresh scan confirms prior session findings. New findings added below with `[NEW]` markers.

### Current state summary

WorkRail has ~24 bundled workflows. All are unstamped (spec v3 staleness advisory fires for all of them -- `validate:registry` confirms). The registry validates (5 variants pass). No workflow named `exploration-workflow.json` exists on disk -- that ticket is stale.

**[NEW] `wr.shaping` itself is unstamped.** This workflow (the one currently running) is listed in the unstamped advisory output. This is not a blocker but is worth noting for planning hygiene.

### Modernization scoring (modern-feature markers out of 5)

| Score | Workflows |
|---|---|
| 0/5 | `test-session-persistence`, `wr.diagnose-environment` |
| 1/5 | `wr.adaptive-ticket-creation`, `wr.document-creation`, `wr.documentation-update`, `wr.intelligent-test-case-generation`, `learner-centered-course-workflow`, `wr.personal-learning-materials`, `wr.presentation-creation`, `wr.scoped-documentation`, `test-artifact-loop-control` |
| 2/5 | `bug-investigation`, `wr.classify-task`, `wr.coding-task`, `wr.cross-platform-code-conversion`, `wr.relocation-us`, `wr.shaping` |
| 3/5 | `wr.architecture-scalability-audit`, `mr-review-workflow`, `wr.ui-ux-design`, `wr.discovery` |
| 4/5 | `wr.production-readiness-audit`, `wr.workflow-for-workflows`, `wr.workflow-for-workflows.v2` |

Modern markers checked: `metaGuidance`, `references`, `features`, `recommendedPreferences`, `templateCalls`.

### Hard constraints

1. Protected files: `src/daemon/`, `src/v2/`, `src/trigger/`, `docs/ideas/backlog.md` -- cannot be touched
2. No push to main -- feature branch + PR required
3. Stamp a workflow only after running `wr.workflow-for-workflows` on it
4. Commit message format enforced by pre-commit hook

### Main existing approaches

- **`wr.workflow-for-workflows.v2.json`**: the canonical tool for modernizing other workflows; drives the authoring QA pass
- **`docs/authoring-v2.md` + `docs/authoring.md`**: authoritative references for what "modern" means
- **`stamp-workflow` script**: marks a workflow as conformant after modernization

### Obvious contradictions / gaps

1. **`exploration-workflow.json` referenced in tickets but was already shipped.** Git history confirms: it was modernized in #158 (Mar 27) and then consolidated into `wr.discovery.json` (Mar 29). The ticket in `docs/tickets/next-up.md` is stale -- the work is already done. The next modernization candidates are the score 1/5 workflows.
2. **`wr.executor` delegation referenced by 7 workflow files but the workflow doesn't exist.** Session 2 confirmed: `grep "WorkRail Executor" workflows/**` returns 7 files (ui-ux, mr-review x4, production-readiness x3, bug-investigation x5, coding-task, wr.architecture-scalability-audit, wr.discovery x6). All these references are in workflow step prompts -- not engine/daemon code. The gap is at the authoring layer, not the runtime layer. `spawn_agent` in `src/daemon/workflow-runner.ts` correctly returns `workflow_not_found` -- no silent failure at the engine level.
3. **[NEW] Graceful degradation is already built into most affected workflows.** `wr.discovery.json` has 14 references to `delegationAvailable` checks. `mr-review`, `wr.production-readiness-audit`, `bug-investigation` all have explicit fallback language. The workflows are already designed to degrade gracefully -- the gap is about *quality ceiling* (parallel perspectives unavailable in daemon mode), not about broken behavior.
4. **[NEW] No GitHub ticket tracks the `wr.executor` gap or the delegation contract question.** `gh issue list --search "executor delegation moderniz"` returns no matches. This is a known gap without any tracked resolution path.

### Evidence gaps

- `exploration-workflow.json`: resolved -- was consolidated into `wr.discovery.json` in commit a0ddaaac (Mar 29). Ticket in `docs/tickets/next-up.md` is stale.
- `wr.executor` gap: still untracked. No GitHub issue. No design doc section beyond this one.
- **[NEW] Gap closed:** Whether graceful degradation is already implemented. Confirmed: it is, in all 7 affected workflows.
- `wr.executor` daemon gap: not tracked as a known issue in any doc or GitHub ticket found. New finding.

---

## Problem Frame Packet

> **[Session 2 update]:** Deep framing pass. Prior session frame preserved; Session 2 additions in `[Session 2]` blocks.

### Primary stakeholder

**Project owner (etienneb)** -- sole developer and operator. Uses WorkRail both as a user (runs workflows to do engineering work) and as the author/maintainer (writes and ships workflows, maintains the daemon). Both roles are affected by the `wr.executor` gap.

**[Session 2] Two-role stakeholder model (prior session collapsed these):**

| Role | Job | Pain from delegation gap | Pain from stale planning |
|---|---|---|---|
| **Platform builder** | Publish workflows that work correctly for external users across all execution contexts (MCP + daemon) | External users who run bundled workflows in daemon sessions get lower-quality outputs without knowing why -- broken promise as product publisher | External users cannot rely on ticket queue or docs to understand what's current |
| **Internal operator** | Run daemon sessions for their own engineering work (coding tasks, MR reviews, investigation) | Daemon sessions on high-value workflows (mr-review, wr.production-readiness-audit) systematically lack parallel reviewer families -- THOROUGH rigor degrades to STANDARD quality | Stale tickets confuse future agent sessions reading the work queue |

**Secondary stakeholders:** external users who import bundled workflows via workflow repos and attempt daemon-mode operation.

### Jobs / outcomes the stakeholder cares about

1. **Run high-quality autonomous sessions** -- when the daemon runs, it should produce correct output without silent capability gaps. A workflow that says "spawn WorkRail Executors" but can't actually do it is a broken promise.
2. **Maintain an accurate work queue** -- tickets should reflect real remaining work, not work already done. Stale tickets waste planning attention.
3. **Ship modernized workflows** -- the 9 score-1/5 workflows represent real user-facing debt; agents running them get worse guidance than agents running the score-3/5+ workflows.

### Pains / tensions

**Tension 1: Daemon and MCP delegation are architecturally incompatible, but workflows don't distinguish them.**
- In Claude Code (MCP mode): "WorkRail Executor" = Task tool with `subagent_type: workrail-executor`. This runs a sub-agent inside the same Claude session. No workflow registry lookup happens.
- In the daemon: "WorkRail Executor" = `spawn_agent(workflowId: "wr.executor")`. This requires a workflow to exist in the registry.
- Current `wr.discovery.json` and `wr.shaping.json` use delegation language ("spawn TWO WorkRail Executors") written for the MCP/Claude Code mental model. When run as a daemon session, this instruction fails silently or falls back -- the agent just records `delegationAvailable: false` and proceeds solo.
- **Pain:** delegation-conditional quality improvements (parallel perspectives, hypothesis challengers) are systematically unavailable in daemon mode.

**[Session 2] Tension 1 deeper layer: the graceful degradation already works, but the quality ceiling is invisible.**
- All 7 affected workflows already check `delegationAvailable` before spawning. `wr.discovery.json` has 14 such checks. The daemon-mode behavior is "do the passes yourself in sequence" (from `metaGuidance`). This is implemented and functional.
- But: users (human and agent) running THOROUGH rigor in daemon mode cannot tell they are getting structurally lower-quality output than MCP mode. There is no signal, no badge, no warning. The gap is *invisible*. This is a different problem from "it doesn't work" -- it's "the quality degradation is silent."
- **Reframe:** the pain isn't `workflow_not_found` failures (those are already caught and degraded gracefully); the pain is that THOROUGH-mode quality in daemon is structurally capped without disclosure.

**Tension 2: Planning docs lag behind shipped code.**
- `docs/tickets/next-up.md` Ticket 2 says "exploration-workflow.json is the highest-priority candidate" -- but this was shipped 3+ weeks ago (consolidated into wr.discovery.json). The ticket is zombie work.
- Planning rot compounds: developers (human or agent) reading the ticket queue will repeat work or be confused about status.

**[Session 2] Tension 2 deeper layer: this isn't just one stale ticket -- it's a signal about the planning system's feedback loop.**
- The planning system (`now-next-later.md`, `open-work-inventory.md`, `tickets/next-up.md`) is designed to be updated as work ships. The AGENTS.md says "When completing a feature: mark it done, update status, note what was delivered." This process did not happen for `exploration-workflow.json` consolidation.
- The gap is at the process level: there's no lightweight mechanism that automatically prompts "a thing you tracked got done -- go mark it." The only enforcement is the human/agent reading the doc and noticing.
- **Risk:** if multiple daemon sessions are running and none updates the planning docs, the docs drift increasingly far from reality.

**Tension 3: Modernization scoring has no agreed definition of "done".**
- Score 4/5 workflows (`wr.production-readiness-audit`, `wr.workflow-for-workflows`) aren't at 5/5 because no workflow has `templateCalls`. It's unclear whether `templateCalls` is aspirational or required for "modern." The spec says "prefer templateCall when the goal is reusable inline routine structure" -- it's advisory, not required.
- **Pain:** if "done" isn't defined concretely, modernization work can balloon or under-deliver.

**[Session 2] Tension 4 (new): `wr.executor` creation may be premature given the Phase 2 composition roadmap.**
- `docs/plans/agentic-orchestration-roadmap.md` documents "Phase 2: Composition & Middleware Engine" which would include **auto-injection** of capability-checking steps: "If workflow `requires: ['subagents']`, automatically prepend `routine-environment-handshake`." This auto-injection model would replace the current manual `delegationAvailable` pattern in every workflow.
- If Phase 2 ever ships, manually creating `wr.executor` now to enable `spawn_agent` would be thrown away -- the whole delegation vocabulary would change. Creating `wr.executor` is work that bets against the roadmap direction.
- **Pain:** investing in `wr.executor` may produce throwaway work if Phase 2 composition is the actual intended architecture.

### Constraints that matter in lived use

1. All fixes must be workflow files or documentation -- no protected-file changes (`src/daemon/`, `src/v2/`, etc.)
2. No `wr.executor` workflow means no delegation; any solution that requires delegation to work is circular
3. Phase 2 composition roadmap is unimplemented -- cannot rely on auto-injection today
4. The daemon soul rules cannot be modified autonomously
5. `automationLevel: recommendation_only` -- this session should produce a decision frame for human approval, not autonomous implementation

### Success criteria (observable)

1. **Daemon sessions that invoke `spawn_agent` do not get `workflow_not_found`** -- either `wr.executor` workflow exists and routes correctly, or workflows authored for daemon sessions explicitly skip delegation steps rather than failing
2. **`docs/tickets/next-up.md` Ticket 2 is marked done or replaced** with an accurate next-up candidate (score-1/5 workflow list)
3. **`validate:registry` staleness advisory shrinks** -- at least 3 workflows move from unstamped to stamped after modernization passes
4. **A modernized score-1/5 workflow passes `wr.workflow-for-workflows` audit** without major revision requests
5. **[Session 2 addition] Daemon-mode quality degradation is disclosed** -- workflows running in daemon mode where delegation is unavailable either disclose the quality ceiling to the user or route to a structurally equivalent path. "Silent degradation" is eliminated.

### Assumptions surfaced

- A: `wr.executor` was intentionally not created because daemon delegation was never designed for this pattern
- B: Workflows that say "spawn WorkRail Executors" were always intended for MCP/Claude Code context only
- C: The ticket staleness is unknown to the project owner (they may know it's done)
- **[Session 2] D: Phase 2 composition is a live roadmap item, not abandoned** -- if it's actually abandoned, the auto-injection argument against `wr.executor` creation disappears. Evidence: `docs/plans/agentic-orchestration-roadmap.md` lists it as "Next Up" but there's no GitHub issue for it and no recent commits toward it.
- **[Session 2] E: The quality degradation from daemon-mode solo execution is significant enough to matter.** If the difference between parallel reviewer families and sequential solo execution is small in practice, the whole delegation gap problem shrinks. Evidence to verify: compare a real mr-review session output in daemon mode vs. MCP mode (not done in this session).

### Reframes / HMW questions

**Reframe 1: The `wr.executor` problem isn't a missing workflow -- it's a missing contract.**
The workflow authoring language ("spawn WorkRail Executors") was designed for Claude Code / MCP context. The daemon's `spawn_agent` tool was designed for something different: structured sub-workflows with their own step sequencing. These are two different delegation models with different tradeoffs. The right question isn't "should we create `wr.executor`?" but "should daemon-mode workflows have a different delegation vocabulary from MCP-mode workflows?"

**Reframe 2: The stale ticket problem is a signal about planning hygiene, not just one stale ticket.**
If Ticket 2 is stale by 3+ weeks, the planning system isn't getting updated as work ships. The fix isn't just updating the ticket -- it's establishing a habit or automation that marks tickets done when git history shows the work landed.

**[Session 2] Reframe 3: The delegation gap is primarily a disclosure problem, not an implementation gap.**
Every affected workflow already degrades gracefully. The problem is not that daemon sessions fail -- it's that users don't know they're getting structurally lower-quality output. A one-line `metaGuidance` addition to each affected workflow ("When run in daemon mode without delegation, parallel review families are unavailable; THOROUGH rigor will run at effective STANDARD depth") would eliminate the *invisible* quality gap without creating `wr.executor` at all. This is a weaker fix than actual delegation but costs nearly zero implementation.

**[Session 2] Reframe 4: HMW keep the planning docs current without relying on agent discipline?**
The stale ticket is a symptom of a process gap, not a knowledge gap. Both agents and humans know the work is done; nobody updated the doc. How might we make the update happen automatically (trigger a planning hygiene session when a PR merges that touches tracked work)? This is a product design question, not just a ticket maintenance question.

### Primary framing risk

**[Session 1]** If `wr.executor` was intentionally left undefined because daemon sessions are _never_ supposed to use the delegation-conditional code paths in `wr.discovery.json` / `wr.shaping.json`, then the "gap" is by design and the real problem is just documentation.

**[Session 2 -- sharper version]:** The primary framing risk is that **the entire problem is already solved by the graceful degradation contract**, and this session is spending energy on a quality ceiling that the project owner has consciously accepted. Evidence that this risk is live: (a) `delegationAvailable` checks exist in all affected workflows; (b) the `metaGuidance` says "If delegation is unavailable, do the passes yourself in sequence"; (c) no GitHub issue was ever created for this gap despite multiple sessions observing it. Three sessions have now noticed the `wr.executor` gap and none triggered a fix. This is strong evidence the owner knows and has accepted it.

**Specific condition that would make the framing wrong:** If the project owner confirms "yes, daemon-mode quality degradation is acceptable and graceful degradation is the intended contract," then there is no delegation problem to solve. The only remaining work is (a) mark Ticket 2 done and (b) modernize a score-1/5 workflow. The entire `wr.executor` discussion becomes noise.

---

## Synthesis

### The opportunity

WorkRail daemon sessions have a real capability gap: `wr.executor` doesn't exist, so every delegation-conditional workflow path silently degrades to solo execution. This isn't catastrophic (graceful fallback works), but it means THOROUGH rigor mode's parallel cognition value is entirely unavailable in daemon context. Given that the daemon is the primary autonomous execution environment, this is a meaningful gap.

Simultaneously, planning hygiene has drifted: the highest-priority modernization ticket references work completed weeks ago, and modernization "done" criteria are fuzzy.

The real opportunity is: clarify what daemon-mode delegation should look like, close the ticket hygiene gap, and pick the right first workflow to actually modernize — in that order.

### Decision criteria (what any good direction must satisfy)

1. **Does not introduce implementation scope that violates protected-file boundaries** -- `src/daemon/` is protected; any fix must be a workflow file or documentation change only
2. **Resolves whether `wr.executor` should be created or declared out-of-scope** -- a concrete yes/no answer, not "it depends"
3. **Leaves the planning queue in a state an agent or human can act on** -- Ticket 2 marked done, next candidate identified
4. **Defines modernization "done" concretely enough that the first score-1/5 candidate can be scoped** -- not perfect, but workable
5. **Is executable without delegation** -- since `wr.executor` is unavailable, the direction cannot require it to function

### Riskiest assumption

**That creating `wr.executor` is the right fix for the daemon delegation gap.** The alternative -- that the right fix is to annotate workflows as "MCP-preferred for delegation features" and accept graceful degradation as the daemon behavior -- requires zero implementation and is already mostly done (the `delegationAvailable` fallback works correctly). Creating `wr.executor` is only better if there's clear value in running an actual structured sub-workflow rather than just a free-form sub-agent. That value case hasn't been made yet.

### Remaining uncertainty type

**Recommendation uncertainty** -- not research uncertainty or prototype-learning uncertainty. All facts are known. The uncertainty is which of two coherent framings is right: (a) implement `wr.executor` as a real workflow to enable structured delegation, or (b) treat graceful degradation as the intended daemon behavior and document it as such. These lead to materially different next actions.

### Strongest challenge against the framing

The entire framing was derived from incidental observations made during a capability probe session that was explicitly told to "complete step 1 and stop." The owner triggered this to check a prerequisite, not to commission a design study. The "problems" identified (`wr.executor` gap, stale ticket, fuzzy modernization criteria) are real but may be at the wrong priority level relative to what the owner actually cares about right now. The framing implicitly promotes these observations to "work that should be done next" -- but the `now-next-later.md` says "nothing actively in progress" and the groomed ticket queue points to workflow modernization, not delegation infrastructure. **The framing may be solving problems the owner hasn't asked to solve and wouldn't prioritize if asked.** The safest output of this session is a clear memo of findings + recommendations, not a commitment to implement `wr.executor`.

**Resolution:** This challenge is valid and shapes the candidate directions. Any direction that involves implementing `wr.executor` should be framed as a recommendation for human approval, not autonomous execution. The design-first path is justified -- but the output should be a decision frame, not a build plan.

---

## Candidate Generation Expectations (set before generation runs)

**Path:** `design_first` | **Rigor:** STANDARD | **Target count:** 3

> **[Session 2 update]:** Expectations sharpened after Phase 1f deep framing and Phase 2 synthesis. The problem has *narrowed* -- `wr.executor` creation is off the table as a candidate direction for this session (out of scope, owner hasn't asked, `automationLevel: recommendation_only`). The candidate spread must reflect the smaller, more focused work set.

### [Session 1] Required emphases (preserved)

1. **At least one candidate must meaningfully reframe the problem** -- not just "create wr.executor" (obvious solution) but a direction that challenges the assumption that new implementation is needed at all. The framing challenge from Phase 2 is live: graceful degradation may already be the right behavior.

2. **At least one candidate must address the full problem space** -- the `wr.executor` gap, the stale ticket, and the fuzzy modernization "done" criteria are three separate tensions. At least one direction should treat them as a coherent system rather than independent fixes.

3. **Candidates must respect the protected-file constraint** -- no candidate should require touching `src/daemon/`, `src/v2/`, `src/trigger/`. All directions must be workflow-file or documentation changes only.

4. **Candidates must be scoped for human-approval output** -- per the Phase 2 framing challenge resolution, no candidate should be a build plan for autonomous execution. All candidates produce a recommendation memo or decision artifact, not shipped code.

5. **Candidates must diverge meaningfully** -- if all 3-4 candidates are variants of "create wr.executor with slightly different scopes," the spread is too narrow. There must be at least one direction that does NOT involve creating `wr.executor`.

### [Session 2] Updated emphases (override Session 1 where they conflict)

1. **Target count is 3, not 3-4.** Problem has narrowed; 3 meaningfully divergent directions is the right spread. A fourth direction would need to justify itself against the narrowing.

2. **`wr.executor` creation is NOT a candidate direction.** Phase 1f/2 challenge resolved: creating `wr.executor` is out of scope for this session (`automationLevel: recommendation_only`, owner hasn't asked, protected files involved). The candidates live in the space of hygiene, disclosure, and decision-framing -- not implementation.

3. **The genuine reframe requirement is now about scope, not solution type.** For `design_first`, at least one direction must challenge the assumption that all three tensions (delegation gap, stale ticket, modernization "done") need addressing in the same session. One candidate may argue: "only do the hygiene work; the delegation question belongs in a separate conversation."

4. **At least one direction must produce something executable in this session.** The output cannot be entirely deferred. At minimum, one candidate should result in a concrete artifact (updated ticket, named next candidate, or disclosure line) that can be produced and shipped as a PR without human approval first.

5. **At least one direction must include the structured owner decision frame on `wr.executor`.** Even though autonomous implementation is off the table, the question itself needs to be framed clearly enough that the owner can decide in a single reading. One candidate must include this framing.

6. **No candidate may require `wr.executor` to function.** All three directions must be fully executable in the current session without any delegation capability.

### Pre-shaped direction sketches (from Phase 2 synthesis)

These sketches are starting points for the generation routine, not final candidates:

- **Direction A: Minimal hygiene** -- close stale Ticket 2, name the first score-1/5 modernization candidate, produce no `wr.executor` framing. Argument: respects the owner's existing priority queue.
- **Direction B: Hygiene + disclosure** -- A, plus add a one-line delegation disclosure to `metaGuidance` of the 7 affected workflows. Argument: eliminates invisible quality ceiling at near-zero cost.
- **Direction C: Hygiene + disclosure + decision frame** -- B, plus produce a structured yes/no question for the owner on `wr.executor` architecture. Argument: makes the implicit accepted state explicit and gives the owner a clean trigger to revisit if priorities change.

### What the later synthesis will check

- Does the candidate set include a genuine reframe (scope challenge, not just solution re-packaging)?
- Are all three candidates executable without delegation and without `wr.executor`?
- Does no candidate require protected-file changes?
- Does at least one candidate produce something shippable in this session?
- Does at least one candidate include the structured owner decision frame?
- Is the spread wide enough to represent a real choice -- not just "how much to do"?

## Candidate Directions

> [Session 2 — generated in Step 3 of injected tension-driven-design routine]

---

### Candidate 1: Planning Hygiene Only (Simplest sufficient change)

**Summary:** Update `docs/tickets/next-up.md` to close stale Ticket 2, name the first concrete score-1/5 modernization candidate, and stop. Do not touch workflow files, delegation, or `wr.executor`.

**Tensions resolved:**
- Tension 3 (planning docs lag shipped code): fully resolved — Ticket 2 marked done, accurate next candidate named

**Tensions accepted (not resolved):**
- Tension 1 (single vocabulary, two environments): accepted as-is — no disclosure added
- Tension 2 (graceful degradation quality ceiling is invisible): accepted — quality ceiling stays silent
- Tension 4 (YAGNI vs. leaving gap undocumented): partially accepted — no permanent ADR, but the design doc here serves as a soft record

**Boundary solved at:** Planning/documentation layer only. No workflow files modified. No PR touches any `workflows/` or `src/` file.

**Specific failure mode:** Future daemon sessions (or human developers) read the corrected ticket queue, start modernizing a score-1/5 workflow, and when they encounter the delegation-unavailable situation they spin up their own analysis all over again — because there's no discovery path to this design doc. The planning hygiene improvement is real but doesn't prevent re-analysis waste.

**Relation to existing patterns:** Follows AGENTS.md exactly: "When completing a feature: mark it done, update status, note what was delivered." This is the explicitly prescribed behavior for completed work. No departure.

**What you gain:** Minimal scope, no risk of touching workflow files incorrectly, respects the owner's groomed priority queue exactly. One PR, one file change.

**What you give up:** The invisible quality ceiling remains. The architectural decision about MCP-vs-daemon delegation stays implicit. Every future session will re-discover it.

**Impact surface:** `docs/tickets/next-up.md` only. Zero impact on workflow behavior, engine behavior, or any user-visible surface.

**Scope judgment:** `too narrow` — it solves the most obvious hygiene problem but leaves both the observability gap and the architectural decision undocumented. The cost of addressing those is low (see Candidates 2 and 3), so stopping here wastes available opportunity.

**Philosophy principles honored:** YAGNI with discipline (does only what is explicitly prescribed), Prefer atomicity for correctness (one coherent doc update), Document "why" not "what" (updates the ticket with what shipped).

**Philosophy principles conflicted:** Observability as a constraint (quality ceiling stays invisible), Document "why" not "what" (the decision NOT to build `wr.executor` stays implicit).

---

### Candidate 2: Hygiene + Authoring-Layer Disclosure Patch (Repo pattern adaptation)

**Summary:** Close Ticket 2 (as Candidate 1), then add a single concise `metaGuidance` entry to the 7 affected workflows stating that parallel WorkRail Executor invocations require MCP/Claude Code context — making the quality ceiling visible at session start and resume.

**Concrete specification:**
- File changes: `docs/tickets/next-up.md` + 7 workflow JSON files: `wr.discovery.json`, `mr-review-workflow.agentic.v2.json`, `wr.production-readiness-audit.json`, `bug-investigation.agentic.v2.json`, `wr.coding-task.json`, `wr.architecture-scalability-audit.json`, `wr.ui-ux-design.json`
- Entry added to each: a single string ≤256 chars (schema constraint), appended to `metaGuidance` array
- Example text: `"WorkRail Executor delegation requires MCP/Claude Code context. In daemon mode, delegationAvailable=false; proceed solo and note that parallel reviewer families are unavailable."`
- Character count of example: 185 chars (within 256-char limit)
- Surface: `metaGuidance` is surfaced at session start and resume only (NOT repeated on every step advance) — confirmed from schema: "Persistent behavioral rules surfaced on start and resume."

**Tensions resolved:**
- Tension 2 (quality ceiling invisible): resolved — the quality ceiling is disclosed at session start and every resume
- Tension 3 (planning docs lag): resolved — Ticket 2 updated
- Tension 4 (YAGNI vs. leaving gap undocumented): partially resolved — the disclosure text serves as an in-band record of the delegation contract

**Tensions accepted (not resolved):**
- Tension 1 (single vocabulary, two environments): accepted — no schema-level distinction between MCP and daemon execution contexts; the disclosure is a patch, not an architectural fix

**Boundary solved at:** Workflow authoring layer. `metaGuidance` is the established mechanism for ambient behavioral rules — confirmed in `src/types/workflow-definition.ts` comments and `src/application/services/compiler/template-registry.ts` (routine `metaGuidance` injected as step-level guidance). This is exactly the right surface for this kind of rule.

**Specific failure mode:** An author adds a new high-value workflow with delegation instructions but forgets to add the disclosure `metaGuidance` entry. The disclosure coverage is only as good as authoring discipline. No enforcement mechanism exists.

**Relation to existing patterns:** Directly adapts the existing `metaGuidance` pattern. All 7 affected workflows already use `metaGuidance` for behavioral rules. Adding one more entry follows the established authoring pattern exactly. No new mechanisms invented.

**What you gain:** The quality ceiling becomes visible to agents and users at session start. Authoring discipline is the only new requirement. Zero engine changes. Schema-compliant. Shippable in one PR.

**What you give up:** `Make illegal states unrepresentable` is still violated — a workflow with delegation instructions can be run in daemon mode without any compile-time or startup warning. The disclosure is runtime advisory, not structural enforcement. Also: 7 workflow files touched means 7 files that could accidentally introduce JSON errors.

**Impact surface:** 7 workflow JSON files + 1 planning doc. The disclosure text affects what agents see at session start when running these workflows in any environment (including MCP, where delegation IS available — in that case the disclosure is technically misleading unless phrased conditionally). Must phrase carefully: not "delegation is unavailable" but "delegation requires MCP/Claude Code context; check `delegationAvailable` before spawning."

**Scope judgment:** `best-fit` — resolves the two concrete observable problems (invisible quality ceiling, stale ticket) without touching protected files or over-investing in an architectural solution the owner hasn't requested.

**Philosophy principles honored:** Observability as a constraint (quality ceiling now disclosed), Validate at boundaries trust inside (disclosure at session-start boundary), Document "why" not "what" (explains the MCP-vs-daemon split), YAGNI with discipline (no speculative `wr.executor` creation).

**Philosophy principles conflicted:** Architectural fixes over patches (this is explicitly a patch — `metaGuidance` is a localized special-case, not a structural invariant change), Make illegal states unrepresentable (the illegal state — running a delegation-expecting workflow in daemon mode — remains representable).

---

### Candidate 3: Hygiene + ADR documenting the MCP/Daemon delegation contract (Different mechanism, different tension target)

**Summary:** Close Ticket 2 (as Candidate 1), then author ADR 011 in `docs/adrs/` formally recording the architectural decision that WorkRail workflows use a single vocabulary for two incompatible delegation models, with the MCP model primary and daemon graceful degradation as the explicitly accepted behavior — creating a permanent, discoverable decision record that prevents future re-analysis.

**Concrete specification:**
- File changes: `docs/tickets/next-up.md` + `docs/adrs/011-mcp-daemon-delegation-vocabulary.md`
- ADR structure follows existing pattern (ADRs 001–010): Status, Date, Context, Decision, Consequences
- Status: `Accepted`
- Decision content: (a) WorkRail daemon `spawn_agent` targets workflow IDs; (b) `wr.executor` workflow does not exist and will not be created until a concrete use case justifies structured delegation; (c) workflows authored with "spawn WorkRail Executors" language are MCP-context-primary; (d) daemon-mode graceful degradation (check `delegationAvailable`, proceed solo) is the explicitly accepted behavior; (e) this decision should be revisited when Phase 2 composition engine is designed
- Does NOT add `metaGuidance` entries to workflow files (leaves that as a follow-up if the owner wants it)

**Tensions resolved:**
- Tension 4 (YAGNI vs. leaving gap undocumented): fully resolved — the decision NOT to build `wr.executor` is permanently recorded with rationale; future sessions find the ADR before re-deriving the analysis
- Tension 3 (planning docs lag): resolved — Ticket 2 updated
- Tension 1 (single vocabulary, two environments): explicitly accepted and documented as a deliberate decision, not an oversight

**Tensions accepted (not resolved):**
- Tension 2 (quality ceiling invisible): accepted — no runtime disclosure added; the ADR is for human and agent developers reading architecture docs, not for end-users at session start

**Boundary solved at:** Architecture decision record layer. An ADR is the right boundary for "this architectural question was considered and decided" — it creates a discoverable stop-point for future agents and human developers. `docs/adrs/` is an established, actively-maintained location (10 existing ADRs with clear format).

**Specific failure mode:** The ADR is only useful if future sessions (or humans) find it. There is no mechanism that says "before asking about `wr.executor`, read ADR 011." A daemon session given a task that involves delegation will not automatically look for ADRs unless the AGENTS.md or soul rules mention it. The ADR is discoverable via `grep` and `ls docs/adrs/` but not enforced.

**Relation to existing patterns:** Directly follows the existing ADR pattern. `docs/adrs/001-010` establishes the format: Status, Date, Context, Decision, Consequences. This would be ADR 011 with the same structure. No new mechanisms. The most recent ADR (010) is from 2026-04-xx (release pipeline), so the pattern is actively maintained.

**What you gain:** A permanent, versioned, discoverable architectural decision record. Future sessions running `ls docs/adrs/` or `grep "executor\|delegation" docs/adrs/` will find the decision. The analysis done across three sessions is captured once, permanently, in the canonical location for architectural decisions.

**What you give up:** The quality ceiling stays invisible to runtime agents — no `metaGuidance` disclosure. An agent running a daemon session won't see the ADR unless they explicitly look for architecture docs. The ADR serves human developers and future planning sessions, not live execution agents.

**Impact surface:** `docs/adrs/011-mcp-daemon-delegation-vocabulary.md` + `docs/tickets/next-up.md`. Zero impact on workflow behavior or engine behavior.

**Scope judgment:** `best-fit` (for a different audience than Candidate 2) — Candidate 2 serves live agents; Candidate 3 serves future architects and planning sessions. Both are appropriate but serve different primary tensions.

**Philosophy principles honored:** Document "why" not "what" (ADR explains the architectural decision and rationale, not just the state), YAGNI with discipline (explicitly records NOT building `wr.executor` as a conscious decision with clear conditions for revisiting), Architectural fixes over patches (an ADR is not a patch — it changes the constraint/invariant by making it explicit and discoverable).

**Philosophy principles conflicted:** Observability as a constraint (quality ceiling still invisible to runtime agents), Make illegal states unrepresentable (still violated at schema level).

---

### Convergence check (honest assessment)

All three candidates share: close Ticket 2, identify score-1/5 next modernization candidate. They diverge on how to handle the delegation architecture tension:

| Candidate | Primary tension addressed | Mechanism | Audience |
|---|---|---|---|
| 1 | Planning hygiene only | Doc update | Planning |
| 2 | Runtime observability | `metaGuidance` disclosure | Live agents |
| 3 | Architectural record | ADR | Future developers/agents |

**Candidates 2 and 3 are genuinely different** — different mechanisms, different audiences, different tensions resolved. They are also **combinable** (both could be done together), which is itself a signal: neither is mutually exclusive. A combined Direction 2+3 would be the most complete resolution of all four tensions, at a cost of slightly higher scope (7 workflow files + 1 ADR file + 1 planning doc).

**If forced to pick one**: Candidate 2 provides the most value for the most immediate observable problem (quality ceiling visible to live agents). Candidate 3 provides the most value for long-term architectural hygiene. Candidate 1 alone is too narrow given the available opportunity.

---

## Challenge Notes

*(integrated into Synthesis section above)*

---

## Resolution Notes

*(to be populated if workflow continues)*

---

## Decision Log

- **2026-04-xx (Session 1)**: Probe session detected. Documented capability unavailability. Recommended `design_first` path for any follow-on modernization work.
- **2026-04-21 (Session 2)**: Second probe session. Phase -1 (goal challenge) classified trigger as `solution_statement`, reframed problem as capability-scoping question. Phase 0 confirmed `design_first` path. Prior session landscape and problem-framing findings adopted as prior art -- no repeated landscape scan needed. Primary uncertainty remains: recommendation uncertainty (graceful degradation vs. implement `wr.executor`). All three tensions (delegation gap, stale ticket, fuzzy modernization "done") still live. No GitHub ticket exists for `wr.executor` gap or delegation contract clarification.
- **2026-04-21 (Session 2, Phase 3d)**: Three candidates generated (C1: hygiene only; C2: hygiene + metaGuidance disclosure; C3: hygiene + ADR). Adversarial challenge run solo (delegation unavailable). **Winner: Combined C2 + C3.** Challenge findings: (a) C2's primary beneficiary is human observers reading session logs/workflow files, not runtime agents -- existing step-level delegationAvailable checks already handle agent decisions correctly; (b) C3's discoverability value is asserted not demonstrated -- ADR helps sessions that search docs/adrs/ but no mechanism forces that search. Neither challenge kills the direction. Combined C2+C3 satisfies all 5 decision criteria; C1 fails criterion 3 (no owner decision frame). **Why C1 lost:** satisfies only T3 (planning hygiene) and leaves T2 and T4 unaddressed at minimal additional cost. **Why C2+C3 won:** non-exclusive candidates targeting different audiences (runtime observers vs. future planners); together resolve T2, T3, T4 within authoring+docs constraint. **Primary framing risk still live:** if owner confirms daemon-mode quality degradation is consciously accepted, switch to C1.

### [Session 2] Phase 0 Capture

| Field | Value |
|---|---|
| `problemStatement` | Before committing to research/execution paths that rely on optional capabilities, determine which capabilities are available and whether the project's real outstanding work (workflow modernization, delegation contract) is correctly framed |
| `desiredOutcome` | A concrete decision frame: either (a) create `wr.executor` to enable structured daemon delegation, or (b) annotate existing workflows as MCP-preferred for delegation and accept graceful degradation as the intended daemon behavior -- with planning docs updated to reflect the correct next modernization candidates |
| `coreConstraints` | Protected files (src/daemon/, src/v2/, src/trigger/) untouchable; no push to main; all work as feature branch + PR; delegation unavailable (wr.executor doesn't exist); no web access |
| `antiGoals` | Do not create implementation scope requiring protected-file changes; do not confabulate a problem; do not build `wr.executor` autonomously without human approval |
| `primaryUncertainty` | Recommendation uncertainty: graceful degradation as intended behavior vs. implement wr.executor for structured delegation -- two coherent framings with different consequences |
| `knownApproaches` | (A) Create `wr.executor` workflow; (B) Document daemon workflows as MCP-preferred and accept degradation; (C) Hybrid: add runtime context tag to workflow metadata indicating execution environment requirements |
| `importantStakeholders` | etienneb (sole developer, both user and maintainer role) |
| `rigorMode` | STANDARD |
| `automationLevel` | recommendation_only (human approval required before implementation) |
| `pathRecommendation` | design_first |
| `pathRationale` | Goal was solution_statement; landscape already known from Session 1; remaining uncertainty is recommendation uncertainty not research uncertainty; dominant risk is solving wrong problem (implementing wr.executor when graceful degradation is already correct); design_first surfaces the decision frame without committing to build |
| `designDocPath` | docs/design/probe-session-phase0.md |

---

## Final Summary

*(to be populated at workflow close)*
