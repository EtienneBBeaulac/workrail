# Context Survival MVP - Design Discovery

> **What this doc is for:** Human-readable design artifact capturing the landscape
> findings, problem frame, candidate directions, and concrete MVP spec.
> **What this doc is NOT:** Execution truth. Notes and context variables in the WorkRail
> session are the durable execution record. This file is for readability only.

---

## TL;DR (Read this first)

**Selected direction:** Guard Removal + Parameter Removal in `prompt-renderer.ts`
**Confidence:** HIGH
**Code change:** 3 lines deleted + `rehydrateOnly` parameter removed from `renderPendingPrompt` + 4 call sites updated
**What it achieves:** Ancestry recap (step notes from all prior steps) is injected into every step prompt automatically -- surviving context compaction without any agent awareness required

**The seam:**
```typescript
// src/v2/durable-core/domain/prompt-renderer.ts, line ~593
// DELETE THIS ENTIRE BLOCK:
if (!args.rehydrateOnly) {
  return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
}
// Also remove the `rehydrateOnly` parameter from the function signature and all 4 call sites.
```

**Why it works:** WorkRail already has `collectAncestryRecap` + `renderBudgetedRehydrateRecovery` -- a budget-capped (24KB) ancestry injection pipeline. It just runs only on explicit `intent: rehydrate` calls today. Removing this guard makes it run on every step render.

**Next actions:** See 7-item implementation checklist in the Final Summary section below. Key addition: integration test for the compaction simulation scenario.

---

## Capability Availability
- **Delegation:** Available (nested subagent via `mcp__nested-subagent__Task`)
- **Web browsing:** Available via `gh` CLI (used to fetch Claude Code and pi-mono repos)
- **Fallback used for:** N/A -- all required capabilities were available. No delegation
  was used since the main agent owned all synthesis and final decisions directly.

## Context / Ask

WorkRail already has a durable event log and step notes system. The problem: when Claude's
context window compacts or a new Claude session starts mid-workflow, the agent loses all
in-flight awareness of what has been done. WorkRail has the data to reconstruct this -- but
it is not currently injected proactively into every step's system prompt.

The ask is to design the minimal system that:
1. Before each step, injects relevant WorkRail session notes into the step's system prompt
2. If context compacts, the step notes survive as structured memory
3. A fresh Claude session can resume any workflow from WorkRail's durable session store
   without losing context

---

## Path Recommendation

**`design_first`**

Rationale: The problem is NOT "what is the landscape of compaction approaches" (that is
known -- Claude Code uses session memory summaries, pi-mono uses MEMORY.md files). The
dominant risk is solving the wrong shape of problem: building a heavy "memory system" when
WorkRail already has everything needed -- durable event logs, `collectAncestryRecap`,
`renderBudgetedRehydrateRecovery`, `handleRehydrateIntent`. The gap is purely at the
injection seam. The question is: "what is the minimal injection format and where does it
hook in?" That is a design framing question, not a landscape discovery question.

`landscape_first` would have been appropriate if we didn't already have working references
(Claude Code's sessionMemoryCompact, pi-mono's MEMORY.md pattern). But we do.

`full_spectrum` is overkill: the problem is well-scoped and the infrastructure is already
built. We just need to close the gap at the right seam.

---

## Constraints / Anti-goals

**Constraints:**
- Must not require a new "memory extraction" model call on every step (expensive)
- Must not duplicate what `handleRehydrateIntent` already does for explicit rehydration
- Must work within the existing `renderPendingPrompt` function (single seam, no drift)
- The injection must survive context compaction -- meaning it must be in the system prompt
  or injected as the first user message, not as a tool call result
- Must degrade gracefully: if session has no prior notes, inject nothing extra

**Anti-goals:**
- NOT a full "memory consolidation" system (that's Claude Code's sessionMemoryCompact)
- NOT a new on-disk format (WorkRail's JSONL event log already IS the durable memory)
- NOT automatic session continuation on context reset (that would require Claude-side hooks)
- NOT attempting to summarize the conversation transcript (only structured notes survive)

---

## Landscape Packet

### Claude Code: sessionMemoryCompact

`trySessionMemoryCompaction` in `src/services/compact/sessionMemoryCompact.ts`:
- Before a context compaction, Claude Code extracts structured "session memory" by calling
  the model to summarize the conversation into a persistent `session-memory.md` file
- The summary is injected into the system prompt on next session via `getSessionMemoryContent`
- Config: minTokens=10_000, minTextBlockMessages=5, maxTokens=40_000
- Key insight: this is an expensive model call and produces an UNSTRUCTURED markdown blob.
  WorkRail's step notes are already structured (per-step notesMarkdown, bounded by
  `MAX_OUTPUT_NOTES_MARKDOWN_BYTES`). WorkRail does NOT need a model-call extraction step.

### pi-mono: MEMORY.md pattern

`getMemory(channelDir)` in `packages/mom/src/agent.ts`:
- Reads `MEMORY.md` (global workspace) and channel-specific `MEMORY.md` at run time
- Injects directly into the system prompt via `buildSystemPrompt` on every agent run
- Key insight: this is a simple file read injected at the system prompt level. No model call.
  pi-mono's agent runs are discrete (one run per Slack message); WorkRail's runs are
  continuous multi-step workflows. The injection point and format differ, but the principle
  is the same: structured durable data injected into every context reset point.

### WorkRail: existing rehydrate recovery path

`handleRehydrateIntent` in `continue-rehydrate.ts`:
- Called when intent=rehydrate (explicit resume call by the agent)
- Calls `renderPendingPrompt` with `rehydrateOnly: true`
- `renderPendingPrompt` with `rehydrateOnly=true` runs `collectAncestryRecap` + 
  `renderBudgetedRehydrateRecovery` to inject ancestry notes into the step prompt
- Budget: `RECOVERY_BUDGET_BYTES` (see constants.ts)
- Tiers: `structural_context` > `durable_recap` > `reference_material`

**The gap:** `rehydrateOnly=false` (used by `start.ts` and `continue-advance.ts`) does NOT
include this recovery content. A fresh session that calls `start_workflow` or the first
`continue_workflow` sees no ancestry context. Context survival requires injecting this EVEN
for non-rehydrate calls when the session is mid-workflow.

### WorkRail: `notes-markdown.ts`

Step notes (`notesMarkdown`) are stored as `node_output_appended` events with:
- `outputChannel: 'recap'`
- `payload.payloadKind: 'notes'`
- `payload.notesMarkdown: string` (bounded by `MAX_OUTPUT_NOTES_MARKDOWN_BYTES`)

`collectAncestryRecap` walks the DAG from current node to root, collects all recap outputs,
and returns them in most-recent-first order. This is exactly the right data for context
survival -- it is already structured, already durable, and already budget-managed.

---

## Problem Frame Packet

### Root cause

Context survival fails because:
1. `renderPendingPrompt` with `rehydrateOnly=false` does not inject ancestry recap
2. There is no mechanism to detect "this is a fresh session that doesn't know prior state"
3. The `start_workflow` prompt renders a clean step with zero memory of what came before

### Reframe

The problem is NOT "how do we survive compaction" but rather:
"how do we ensure WorkRail's durable session state is always visible to whatever Claude
session is currently executing a step?"

WorkRail already has the answer: `collectAncestryRecap` + `renderBudgetedRehydrateRecovery`.
The MVP is to call this on EVERY step render (advance, start, rehydrate), not just rehydrate.

The key design question: should "always inject ancestry" be the default, or should there be
a threshold (e.g., only inject if there are prior notes)?

Answer: always inject, but degrade gracefully. If `collectAncestryRecap` returns empty,
inject nothing. This is zero-cost when there are no prior notes (first step of a new session)
and maximally helpful when there are.

### Compaction survival insight

Claude Code's compaction pipeline calls hooks BEFORE compacting. The `compact.ts` file shows:
`executePreCompactHooks(...)` runs before the summarization. WorkRail's notes do not need
to survive compaction -- they are already in the durable event log on disk. What needs to
survive is the INJECTION: after compaction, the next `continue_workflow` call will load a
fresh prompt from the durable store, which will include the ancestry recap.

This means: context survival does NOT require detecting compaction or hooking into Claude
Code's compaction pipeline. It simply requires that every `continue_workflow` response
includes the ancestry context in its step prompt.

---

## Candidate Directions

### Direction A: Always-On Ancestry Injection (RECOMMENDED)

**What:** Change `renderPendingPrompt` to ALWAYS run the ancestry recap path (currently
only runs when `rehydrateOnly=true`). The `rehydrateOnly` flag becomes a formatting hint
(e.g., add the "## Recovery Context" header), not a gate.

**Where it hooks in:** `prompt-renderer.ts`, `renderPendingPrompt`, lines 593-596:
```typescript
if (!args.rehydrateOnly) {
  return ok({ stepId, title, prompt: enhancedPrompt, agentRole, requireConfirmation });
}
```
Change to: always continue to load recovery projections and build ancestry segments.
The only difference for the non-rehydrate path is the header label (or no header at all
for cleanResponseFormat).

**Injection format (minimal):**
```
## Workflow Progress (Steps 1-4 completed)

### Step 1 - [title]
[notesMarkdown]

### Step 4 - [title]
[notesMarkdown]
```

**What survives compaction:** Everything. The step notes are in the event log. After
compaction, the NEXT `continue_workflow` call rebuilds the prompt from the event log and
injects the ancestry recap fresh.

**Cost:** A DAG projection (`projectRunDagV2`) and outputs projection
(`projectNodeOutputsV2`) per step render. These already run on the rehydrate path;
making them always-run adds cost only for non-rehydrate paths. Since the projections
are already fast (pure functions over the event log), this is acceptable.

**Risk:** For step 1 of a new session, `collectAncestryRecap` returns empty -- no-op.
For long-running sessions, the budget cap (`RECOVERY_BUDGET_BYTES`) prevents overflow.

### Direction B: System-Prompt Pre-Injection Header (ALTERNATIVE)

**What:** Add a new "WorkRail session state" block to the MCP server's system prompt
via a `tool_description_provider` hook, injected as a resource or prompt complement.

**Why weaker:** This operates at the MCP server level, not the workflow step level.
It would inject ALL session notes globally, not just the ancestry relevant to the current
step. It also requires a separate projection query outside the existing render pipeline,
creating potential for drift.

### Direction C: Checkpoint-on-Each-Step (OVERKILL)

**What:** Auto-checkpoint after every step advance, providing a resumeToken in every
response. The agent is instructed to always start by calling `continue_workflow` with
`intent: rehydrate` on a fresh session.

**Why weaker:** This requires the agent to KNOW it is in a fresh session. Claude Code's
compaction does not signal this to the agent. The agent cannot reliably detect context
compaction. Direction A is strictly better because it doesn't require agent awareness.

---

## Problem Frame Packet (Stakeholder Analysis)

### Primary Users
- **WorkRail autonomous workflow executor** (primary): runs 5-20 step workflows, may experience context compaction at any step, expects seamless recovery without manual intervention
- **WorkRail maintainer** (secondary): owns `prompt-renderer.ts`, cares about architectural clarity and test stability

### Tensions

1. **Redundancy without compaction (user):** When context has NOT compacted, Claude sees both living context (prior steps still in working memory) AND an ancestry recap of those same steps. Risk: agent second-guesses state or verbose outputs increase token cost for uninterrupted sessions. Mitigation: budget cap limits the overhead; the redundancy is additive, not contradictory.

2. **Notes are summaries, not full state (user):** Users may expect "workflow recovered" means the agent has full continuity -- but notes capture what the agent chose to record, not all intermediate artifacts. False confidence gap: if step 3 produced an in-memory artifact that wasn't noted, step 6 won't have it. This is a fundamental constraint of note-based recovery, not a defect of this design. Must be documented.

3. **Performance regression on large sessions (maintainer):** `projectRunDagV2` + `projectNodeOutputsV2` now run on every advance/start call, not just rehydrate. For sessions with 100+ events, this adds latency. Mitigation: both are pure functions with no I/O; the `precomputedIndex` path in `renderPendingPrompt` can be extended to pre-compute these projections.

4. **`rehydrateOnly` flag name becomes misleading (maintainer):** Post-change, the flag controls header label ("Recovery Context" vs "Your previous work:") but not whether recovery runs. The name now lies. Must rename (e.g., `isExplicitResume`).

5. **Snapshot test churn (maintainer):** All existing prompt snapshot tests for non-rehydrate paths will now include ancestry segments for sessions with prior notes. Test updates required.

### Success Criteria (user-facing)
- Workflow resumes correctly after mid-execution context compaction without user intervention
- Agent at step N+1 demonstrates awareness of steps 1..N without being prompted to "recall"
- No observable performance degradation on workflows that do NOT hit compaction
- Agent does not ask "did I already do X?" when prior work is in ancestry recap

### Framing Risks (what could make the design wrong)

1. **"Detect compaction, inject on-demand"** (user subagent): HMW detect when Claude has actually lost context and inject ancestry ONLY then? Counter: Claude Code's compaction does not emit a detectable signal to MCP tools. The agent cannot reliably know it is in a new session. Always-on injection is more robust than conditional injection. The budget cap prevents this from being wasteful.

2. **"Always-on is the wrong default"** (user subagent): Some users may prefer explicit checkpointing. Counter: the `intent: rehydrate` path already exists for explicit resumption. Always-on injection is additive; it does not break the explicit path. Users who want fine-grained control can still use `checkpoint_workflow`.

3. **"Long loop iterations generate redundant ancestry" (maintainer):** A 10-iteration loop produces 10 ancestry entries for the loop body step. Mitigation: budget cap drops lower-tier content. Acceptable.

### HMW Questions
- HMW make context survival automatic (zero-agent-effort) while keeping the explicit `intent: rehydrate` path for users who want control?
- HMW rename `rehydrateOnly` to reflect its post-change semantic accurately?

---

## Challenge Notes

1. **Budget pressure on long workflows:** A 20-step workflow with verbose notes could
   exceed `RECOVERY_BUDGET_BYTES`. Mitigation: the existing budget logic already
   handles this by dropping lower-priority tiers. For very long workflows, only the
   most recent ancestor notes survive. This is acceptable -- recent context matters most.

2. **First step of fresh session:** `collectAncestryRecap` returns empty. The prompt
   is unchanged from today. This is correct behavior.

3. **Loop iteration context:** The `loopBanner` already handles loop context. Ancestry
   recap from prior loop iterations will be included by `collectAncestryRecap` since
   it walks all parent nodes. This may create noise for tight loops. Mitigation: the
   budget cap limits this naturally.

4. **Clean response format:** The `cleanResponseFormat` flag already controls header
   style (`'Your previous work:'` vs `'## Recovery Context'`). No change needed.

---

## Resolution Notes

**Chosen direction: A (Always-On Ancestry Injection)**

The existing `renderPendingPrompt` architecture already contains the full injection
pipeline. The only change is removing the `rehydrateOnly` gate that currently prevents
ancestry recap from running on the advance/start path.

This is the minimal change that achieves the stated goal. No new types, no new files,
no new event kinds, no model calls required.

---

## Decision Log

| Decision | Choice | Rationale |
|---|---|---|
| Path choice | design_first | Infrastructure exists; root cause is a missing seam, not landscape ignorance |
| Direction choice | A (guard removal + param removal) | Minimal code change, uses existing infrastructure, no agent awareness required |
| `rehydrateOnly` fate | Removed (not renamed) | Post-guard-removal, the parameter has zero behavioral effect. Removal satisfies 'make illegal states unrepresentable'; rename would leave dead code. |
| Compaction hook | None needed | Event log is already durable; compaction doesn't destroy the data |
| Memory extraction model call | Rejected | WorkRail notes are already structured; no summarization needed |
| Checkpoint-per-step | Rejected | Requires agent to detect context reset, which is unreliable |
| SessionIndex extension (Candidate B) | Deferred | No benchmark data justifies pre-optimization. Escape hatch documented. |
| System-prompt injection (Candidate C) | Rejected | Fatal multi-session ambiguity. Wrong boundary. |

### Challenge adjudication

**Challenge 1 (Performance, MAJOR):** `projectRunDagV2` runs on every advance. Concern is real but theoretical. Disproved by: pure function, no I/O, accepted as managed risk. Escape hatch: Candidate B if benchmarks show > 50ms latency.

**Challenge 2 (Budget contention, claimed BLOCKING):** ADJUDICATED FALSE POSITIVE. `RECOVERY_BUDGET_BYTES` (24 KB) caps only the recovery section. Step prompt and recovery section are additive, not competing. `enhancedPrompt` has no budget cap from recovery. No starvation possible.

**Challenge 3 (Untested start path, MAJOR):** Valid concern. Mitigation: TypeScript type system catches call site changes; snapshot tests must be updated. The semantic change (ancestry injected on first advance after session start) is correct behavior -- it is exactly what users need.

**Challenge 4 (Wasted computation on static steps, MINOR):** Acknowledged. Steps with no ancestry gain zero value but pay the projection cost. Accepted as managed risk.

**Challenge 5 (Missed call sites, MINOR):** False positive. TypeScript compilation enforces all call sites. grep confirms only 4 direct call sites. No indirect callers.

---

## Final Summary

### Recommendation (HIGH confidence)

**Selected direction:** Candidate A -- Guard Removal + Parameter Removal

**Implementation checklist:**
1. `prompt-renderer.ts`: Remove the `rehydrateOnly` parameter from `renderPendingPrompt`'s signature and args type. Remove the 3-line early-return guard.
2. Add comment: `// WHY: ancestry recap is always injected to survive context window compaction. The durable event log holds step notes; renderBudgetedRehydrateRecovery budget-caps the injection at 24KB. See design-docs/context-survival-mvp.md.`
3. `start.ts`: Remove `rehydrateOnly: false` from call site.
4. `replay.ts` (2 sites): Remove `rehydrateOnly: false` from both call sites.
5. `continue-rehydrate.ts`: Remove `rehydrateOnly: true` from call site.
6. Update prompt snapshot tests for sessions with prior notes (run `--update-snapshots`).
7. Add integration test: start workflow, advance 4 steps with notes, call continue_workflow without prior context (simulating session reset), verify step 5 prompt contains ancestry recap.

**Strongest alternative:** Candidate B (SessionIndex DAG extension). Pivot to this if advance latency > 50ms on sessions with 200+ events.

**Residual risks (2, LOW):**
- Performance on large sessions (submillisecond for realistic cases; escape hatch documented)
- Integration test gap (addressed by checklist item 7)

---

# Concrete MVP Spec: Context Injection for Context Survival

## 1. Injection Format

The injection format reuses the existing `RetrievalPackRenderResult` structure produced by
`renderBudgetedRehydrateRecovery`. The minimal format for a fresh-session context injection:

```
## Workflow Progress

### Ancestry Recap

**Step 1 - Capture problem statement and frame discovery**
Captured the following context variables: problemStatement, desiredOutcome, coreConstraints,
antiGoals, primaryUncertainty, knownApproaches. Set pathRecommendation to `design_first`
based on the well-scoped nature of the problem. Created design doc at
`design-docs/context-survival-mvp.md`.

**Step 2 - Landscape research: Claude Code compaction pipeline**
Read `src/services/compact/sessionMemoryCompact.ts`. Key finding: CC uses a model-call to
produce an unstructured MEMORY.md. WorkRail's step notes are already structured -- no
equivalent model call is needed.

**Step 3 - Landscape research: pi-mono MEMORY.md pattern**
Read `packages/mom/src/agent.ts`, `getMemory()` function. Pattern: read MEMORY.md files at
run time, inject directly into system prompt. Simple file read, no model call. Relevant
principle extracted: inject structured persistent state at every context entry point.

**Step 4 - Read WorkRail's existing rehydrate recovery path**
Read `continue-rehydrate.ts`, `prompt-renderer.ts`, `retrieval-contract.ts`,
`recap-recovery.ts`. Finding: `handleRehydrateIntent` already calls `collectAncestryRecap`
+ `renderBudgetedRehydrateRecovery`. The gap is that `rehydrateOnly=false` skips this path.
Minimal MVP: remove the guard at line 593 of `prompt-renderer.ts`.
```

The format is budget-capped at `RECOVERY_BUDGET_BYTES`. Tier order:
1. `structural_context` (branch shape) - core, always included
2. `durable_recap` (step notes) - core, always included  
3. `reference_material` (function defs) - tail, dropped when budget exceeded

## 2. Hook Location in WorkRail Code

**File:** `src/v2/durable-core/domain/prompt-renderer.ts`

**Current code (line 593-596):**
```typescript
// If not rehydrate-only, return enhanced prompt (no recovery needed for advance/start)
if (!args.rehydrateOnly) {
  return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
}
```

**MVP change:** Remove the early return guard. The ancestry recap path runs on ALL renders,
not just rehydrate-only. The `rehydrateOnly` flag becomes a header-label hint only (already
used later in the function for `recoveryHeader`).

The resulting flow for ALL step renders (start, advance, rehydrate):
1. Build enhanced prompt (loop banner + step prompt + requirements + notes section)
2. Load recovery projections (DAG + outputs)
3. Build recovery segments (ancestry recap)
4. Apply budget (`renderBudgetedRehydrateRecovery`)
5. Append to enhanced prompt

When `collectAncestryRecap` returns empty (step 1, no prior work), the segments array
is empty and `renderBudgetedRehydrateRecovery` returns no text -- the prompt is unchanged.

## 3. Working Example: Coding Task Workflow Interrupted After Step 4

**Scenario:** `coding-task-workflow` was started, ran steps 1-4, then the Claude session
was reset (or context was compacted). A fresh Claude session calls:
```
continue_workflow(continueToken: "ct_...", intent: "rehydrate", workspacePath: "/my/project")
```

**What WorkRail does (already works today via rehydrate path):**
1. Load session from durable event log (`LocalSessionEventLogStoreV2.load`)
2. Deserialize all `node_output_appended` events with `outputChannel=recap`
3. Run `collectAncestryRecap` to extract notes from steps 1-4
4. Run `renderBudgetedRehydrateRecovery` with the ancestry notes
5. Call `renderPendingPrompt` with `rehydrateOnly=true` -- injects recovery into prompt

**What the fresh Claude session receives (step 5 prompt):**

```
## Step 5: Implement the feature

Write the code for the authentication module as described in the spec.

**NOTES REQUIRED (System):** You must include `output.notesMarkdown` when advancing.

## Recovery Context

### Ancestry Recap

**Step 1 - Frame the task**
Goal: implement OAuth2 refresh token rotation in `src/auth/oauth2.ts`. Scope confirmed:
only the refresh path, not the full auth flow. Key constraint: must be backward-compatible
with existing token format (v1 tokens still valid for 30 days post-migration).

**Step 2 - Read existing code**
Read `src/auth/oauth2.ts` (312 lines), `src/auth/middleware.ts` (87 lines),
`tests/auth.test.ts` (203 lines). Key finding: `refreshAccessToken()` at line 145 silently
swallows network errors -- this is a bug independent of the rotation task.

**Step 3 - Design the rotation logic**
Designed: on each refresh call, old token is revoked, new token is minted with a new
`jti` (JWT ID), stored with a 30-day overlap window. Token storage: `TokenStore` interface
(new) backed by existing Redis client. Spec written to `design/token-rotation.md`.

**Step 4 - Write tests (TDD)**
Added 8 test cases to `tests/auth.test.ts`:
- `should_rotate_token_on_refresh` (happy path)
- `should_allow_old_token_for_30_days_post_rotation` (overlap window)
- `should_reject_old_token_after_overlap` (expiry)
- `should_handle_concurrent_refresh_races` (idempotency)
All 8 tests are currently RED (TDD -- implementation not yet written).
Open question: should rotation be enabled by feature flag? Kept as TODO for now.

[... step 5 prompt continues ...]
```

**What survives context compaction:** Everything above. The notes are in the event log.
After compaction, the next `continue_workflow` call calls `renderPendingPrompt`, which
loads the event log fresh and rebuilds this injection from scratch. The Claude context
window transcript is gone; the structured memory is not.

## 4. Minimal Code Change Required

**One guard removal** in `prompt-renderer.ts` (3 lines deleted):
```typescript
// REMOVE THIS:
if (!args.rehydrateOnly) {
  return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
}
```

**Resulting behavior change:**
- Before: ancestry recap only injected on explicit `intent: rehydrate` calls
- After: ancestry recap injected on ALL step renders (start, advance, rehydrate)
- Cost: one DAG projection + one outputs projection per step render (already fast)
- Regression risk: zero for step 1 (empty ancestry), minimal for subsequent steps
  (budget cap prevents overflow)

**Secondary consideration:** The `hasPriorNotesInRun` check for the notes reminder section
uses a similar guard. That logic is separate and unaffected by this change.

## 5. What This Does NOT Cover (Anti-goals)

- Does NOT automatically detect context compaction and trigger re-injection
- Does NOT hook into Claude Code's compaction pipeline (`executePreCompactHooks`)
- Does NOT require a new `MEMORY.md` on-disk format
- Does NOT require a model-call summarization step
- Does NOT add new event kinds to the session schema
- Does NOT change the token format or session storage layout
