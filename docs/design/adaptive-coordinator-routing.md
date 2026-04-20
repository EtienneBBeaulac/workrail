# Adaptive Coordinator Routing -- Discovery Design Document

**Status:** COMPLETE (wr.discovery workflow, 2026-04-19)
**Date:** 2026-04-19
**Author:** WorkTrain autonomous session

---

## Context / Ask

**Statedgoal (original framing):** Design the routing/classification layer of an adaptive WorkTrain pipeline coordinator -- one that looks at an incoming task and decides which phases to run.

**Reframed problem:** WorkTrain has no way to dispatch the right workflow sequence for a task without a human deciding which coordinator to invoke -- every task type today needs a bespoke hardcoded coordinator script.

**Scope:** `src/coordinators/`, `src/trigger/`, `src/cli/`. NOT `src/mcp/`.

**Coordination artifact:** This doc captures routing/classification design decisions. A parallel discovery agent is designing inter-phase context passing in `docs/design/adaptive-coordinator-context.md`.

---

## Path Recommendation

**Chosen path:** `design_first`

**Rationale:** The goal was stated as a solution (a coordinator with a routing/classification layer). The risk is designing the wrong routing mechanism. The landscape is well-understood from existing code (`pr-review.ts`, `classify-task-workflow.json`). The dominant risk is not lack of knowledge -- it is solving the wrong subproblem (e.g., treating all routing as LLM classification when static heuristics cover most cases, or treating one monolithic script as the right shape when decomposition into per-mode coordinators may be cleaner).

---

## Constraints / Anti-goals

**Constraints:**
- Must follow `CoordinatorDeps` injection pattern from `pr-review.ts`
- Must not design for `src/mcp/`
- Must use `spawnSession`/`awaitSessions` for workflow session dispatch
- Failure policy: escalate with structured reason, never silently substitute a different pipeline
- TypeScript script, not a workflow JSON

**Anti-goals:**
- Do not design an orchestration workflow (JSON-defined pipeline) -- this is a coordinator script
- Do not require the daemon to know about pipeline modes -- the coordinator owns routing
- Do not add `pipelineMode` to `TriggerDefinition` unless there is no better option
- Do not couple the adaptive coordinator to `src/mcp/`

---

## Artifact Strategy

This document is a **human-readable artifact only**. It is not workflow execution truth.
Workflow execution truth lives in WorkRail step notes and context variables.

If a chat rewind occurs: the notes and context variables survive; this file may not. Do not rely on this file as the sole record of design decisions -- always cross-check with WorkRail session notes.

---

## Landscape Packet

### Current state (as of Apr 19, 2026)

**What exists:**
- `src/coordinators/pr-review.ts` -- 1462-line hardcoded coordinator for PR review. Establishes the `CoordinatorDeps` injectable interface (16 methods), `spawnSession`/`awaitSessions`/`getAgentResult` pattern, fix-agent loop with escalation-first failure policy.
- `workflows/classify-task-workflow.json` -- EXISTS as of v3.40.0 (contrary to Apr 15 backlog entry that listed it as missing). Single LLM step, no tools, outputs 7 variables including `recommendedPipeline` (ordered workflow ID array with decision rules already encoded).
- `src/cli-worktrain.ts` -- wires `worktrain run pr-review` subcommand. No `worktrain run pipeline` or adaptive coordinator command exists yet.
- `src/trigger/types.ts` -- `TriggerDefinition` has `workflowId`, `goal`, `goalTemplate`, `contextMapping`, `agentConfig`. No `pipelineMode` field.
- Three-Workflow Pipeline decision (Apr 18): `wr.discovery -> wr.shaping -> coding-task-workflow-agentic`. Phase 0.5 in coding-task detects pitch.md and sets `solutionFixed=true` to skip design phases.
- `wr.shaping` and `wr.discovery` workflows both exist as of v3.40.0.
- `coding-task-workflow-agentic` Phase 0.5 detects upstream context (pitch.md, BRD, PRD, etc.).

**The Apr 15 backlog full pipeline DAG** (still relevant design intent):
```
trigger
  -> [always] classify-task (outputs: taskComplexity, riskLevel, hasUI, touchesArchitecture)
  -> [if taskComplexity != Small] discovery
  -> [if hasUI] ux-design
  -> [if touchesArchitecture OR riskLevel=High] architecture-design + arch-review
  -> [always] coding-task
  -> [always] mr-review -> (clean: merge | minor: fix-agent-loop | blocking: escalate)
  -> [if riskLevel=High] prod-risk-audit
```

**What is NOT yet built:**
- `src/coordinators/adaptive-pipeline.ts` (the target of this design)
- `worktrain run pipeline` CLI command
- Pipeline-mode routing logic of any kind

### Hard constraints

1. Coordinator is a TypeScript script, not a workflow JSON -- it calls `spawnSession`/`awaitSessions`.
2. Failure policy from `pr-review.ts` is canonical: escalate with structured reason, never silently substitute a different pipeline.
3. `CoordinatorDeps` injection pattern must be followed (testability requirement).
4. Scope: `src/coordinators/`, `src/trigger/`, `src/cli/` only.

### Contradictions and tensions

- **classify-task-workflow is listed as NOT YET BUILT in the Apr 15 backlog** but the file `workflows/classify-task-workflow.json` exists today (v3.40.0, Apr 19). This is resolved: it was built between Apr 15 and Apr 19.
- **"Always run classify-task first"** (Apr 15 backlog) vs. **"Static heuristics for well-known cases"** (primary uncertainty). The Apr 15 backlog says "always" but this was written before Phase 0.5 upstream context detection was built. With Phase 0.5, many routing decisions can be made statically.
- **`recommendedPipeline` from classify-task** includes `wr.discovery` for Medium/Large tasks, but the Three-Workflow Pipeline decision treats `wr.discovery` as optional. The coordinator must decide: use classify-task's `recommendedPipeline` verbatim, or treat it as a hint that can be overridden by static signals (e.g., pitch.md already present = skip discovery even if classify says Medium)?

### Evidence gaps

1. Does `spawn_agent` (the in-workflow tool) return the `recommendedPipeline` output variable from `classify-task-workflow`? The backlog note says `spawn_agent` currently does NOT return `artifacts` (limitation #5 in v3.40.0 current state). This means the coordinator script cannot use `spawn_agent` to run classify-task and read output -- it must use `spawnSession` + `getAgentResult` + parse the notes, just as `pr-review.ts` does for verdict artifacts.
2. No existing test harness for a multi-mode coordinator. `pr-review.ts` tests exist but only cover the review pipeline.
3. The `worktrain-spawn.ts` CLI wiring for `spawnSession` is the only proven path to dispatch sessions from a coordinator script. No other dispatch mechanism has been tested.

---

## Problem Frame Packet

### Users and stakeholders

| User | Job | Pain | What success looks like |
|------|-----|------|------------------------|
| Developer triggering tasks via CLI | Run the right pipeline without knowing pipeline internals | Has to manually pick the right coordinator command per task type | Types `worktrain run pipeline --task "..."` and the right phases run |
| Trigger operator (triggers.yml author) | Configure automatic response to webhooks/PRs | Must hardcode a single workflowId per trigger -- no pipeline awareness | Can configure a trigger that routes to the right pipeline mode dynamically |
| WorkTrain developer extending coordinator | Add a new pipeline mode | Must read 1462 lines of pr-review.ts to understand the pattern, then duplicate the structure | New mode is a named, documented, testable function following a clear interface |
| WorkTrain runtime (daemon) | Dispatch the right coordinator | Knows nothing about pipeline modes -- just spawns what it's told | Coordinator handles all pipeline routing; daemon stays generic |

### Key tensions

1. **LLM accuracy vs dispatch latency**: always-classify gives accurate routing but adds a full LLM turn (classification cost: ~$0.002 on Haiku, but latency is ~5-15 seconds) before any real work starts. Static heuristics are instant but fail on ambiguous tasks.

2. **Flexibility vs explicit configuration**: static heuristics are implicit and may surprise users ("why did it skip discovery?"). Explicit `pipelineMode` on the trigger is transparent but requires more config. The ideal is: explicit where the user knows the mode, heuristic where they don't.

3. **Single coordinator file vs per-mode decomposition**: `pr-review.ts` is 1462 lines for one mode. A monolithic adaptive coordinator handling all modes risks becoming unmaintainable. Per-mode coordinator functions (each independently testable) with a thin routing dispatcher is a cleaner architecture -- but introduces coordination between files.

4. **`recommendedPipeline` verbatim vs as a hint**: classify-task-workflow encodes pipeline selection rules. If the coordinator uses these verbatim, it cannot apply static overrides (e.g., pitch.md present -> skip discovery). If it treats them as hints, it re-implements routing logic and classify-task's rules become advisory only.

5. **Phase 0.5 vs coordinator routing for upstream context**: coding-task already auto-detects pitch.md. So the coordinator's routing decision for "skip wr.shaping?" partially duplicates Phase 0.5's detection. The coordinator should route based on what phases to _spawn_, not what the coding workflow will internally skip -- but these can diverge (coordinator spawns shaping but coding-task's Phase 0.5 would have skipped it anyway).

### Success criteria (observable)

- [ ] A `worktrain run pipeline --task "fix the race condition in auth.ts"` command routes to the correct pipeline mode and logs the routing decision before spawning any sessions
- [ ] A task with `#123` or `PR #123` in the goal routes to REVIEW_ONLY without spawning discovery or shaping sessions
- [ ] A task with `pitch.md` present in the workspace routes to IMPLEMENT (coding-task-workflow-agentic only)
- [ ] An ambiguous task (no static signal) routes to classify-task-workflow session, parses `recommendedPipeline`, and executes that pipeline
- [ ] A `dep bump` or `chore:` task routes to QUICK_REVIEW (mr-review only, no arch audit) based on goal text heuristics
- [ ] Any phase failure produces a `PipelineOutcome` with `escalated: true` and a structured `escalationReason` -- no silent substitution
- [ ] The `CoordinatorDeps` interface for the adaptive coordinator extends or reuses the existing `CoordinatorDeps` pattern from `pr-review.ts`
- [ ] A developer reading the coordinator code can identify which pipeline mode a given task will route to by reading a single routing function

### Assumptions not yet verified

1. `classify-task-workflow` can be invoked via `spawnSession` + `awaitSessions` + `getAgentResult` with note parsing (same as pr-review reads verdict artifacts) -- this is assumed based on the spawn_agent artifact limitation
2. The `recommendedPipeline` text can be reliably parsed from classify-task-workflow's note output using a regex or structured block parser
3. A new CLI subcommand `worktrain run pipeline` can be added following the same pattern as `worktrain run pr-review` in `src/cli-worktrain.ts`
4. Pipeline modes can be named and bounded at design time (not open-ended)

### Primary framing risk

**The framing assumes that "which phases to run" is the right decomposition.** If the real problem is "how to pass context between phases so each phase doesn't re-discover what the previous phase already found", then a routing/classification layer solves the wrong problem -- the bottleneck is inter-phase context, not phase selection. Evidence that would confirm this risk: if a parallel discovery session produces `docs/design/adaptive-coordinator-context.md` showing that context passing is the dominant complexity, the routing layer design should be subordinate to that.

### HMW (How Might We) reframes

- HMW make the pipeline mode explicit in the trigger config so routing is never ambiguous, while still supporting dynamic routing for ad-hoc CLI invocations?
- HMW use classify-task-workflow's `recommendedPipeline` as the default while allowing static overrides to be applied on top, treating classification as advisory rather than authoritative?

### Primary uncertainty (updated)

Can classify-task-workflow's `recommendedPipeline` output be used as the canonical routing source, with static overrides applied on top for well-known signal patterns (PR number, pitch.md, dep-bump keywords) -- rather than choosing between LLM and heuristics as mutually exclusive?

### Known approaches

1. **classify-task-workflow first** -- always spawn a classification session, parse `recommendedPipeline`, then execute the pipeline. LLM-accurate, adds latency and cost per dispatch.
2. **Static heuristics** -- parse goal text and trigger metadata (PR number present, labels, pitch.md present, explicit pipelineMode flag on trigger). Zero LLM cost, covers well-defined cases.
3. **Hybrid** -- static heuristics handle high-confidence cases; LLM classification handles ambiguous tasks. `classify-task-workflow` is an optional fast path, not always required.
4. **Explicit `pipelineMode` on trigger** -- add a `pipelineMode` field to `TriggerDefinition` (or as a context variable). Users/triggers declare mode explicitly. Removes ambiguity but requires configuration overhead.
5. **classify-task advisory + static overrides** -- run classify-task first (small cost, accurate), then apply static override rules on top of `recommendedPipeline` to handle well-known signals. Classify sets the baseline; static rules correct known exceptions.

---

## Candidate Generation Expectations

**Path:** `design_first`, rigor: `thorough`

**Requirements for the candidate set:**
1. At least one candidate must meaningfully reframe the problem (not just package obvious LLM-vs-heuristics variants)
2. At least one candidate must address the monolithic-vs-decomposition tension directly (architecture of the coordinator script itself, not just routing logic)
3. At least one candidate must be more conservative -- building only what is needed for the immediate use cases without speculative generality
4. Candidates must collectively span the full design space: pure static, pure LLM-classify, hybrid, advisory+overrides, and at least one unexpected direction
5. Every candidate must address failure handling explicitly (not leave it open)
6. Extra push required: if the 5 candidates feel clustered around "hybrid LLM+heuristics", force a 6th that radically simplifies or radically separates concerns

**Anti-criteria (eliminate these):**
- Candidates that require new engine primitives (context-gather step type, new daemon features) -- out of scope for this coordinator design
- Candidates that route through `src/mcp/` -- explicitly out of scope
- Candidates that do not follow `CoordinatorDeps` injection pattern

## Candidate Directions

### Cross-check with context-passing agent

`docs/design/adaptive-coordinator-context.md` exists and was read before generating candidates. Key finding: the context-passing agent confirms that file-based handoff (pitch.md) already covers Shaping->Coding, and the dominant context gap is Discovery->Shaping. The routing design must account for:
- Discovery writes a design doc to a path (e.g., `.workrail/current-discovery.md`) if the file convention is adopted
- Shaping session needs this path injected as `assembledContextSummary` at spawn time
- The coordinator is the bridging layer -- it reads `lastStepNotes` from the Discovery session and injects context for the Shaping spawn

---

### Candidate A: Pure static routing with named pipeline modes (simplest, YAGNI)

**One-sentence summary:** A `routeTask()` function applies prioritized static rules against the goal string and workspace filesystem to select one of 5 named `PipelineMode` variants; no LLM classification step.

**Pipeline modes:**
- `REVIEW_ONLY` -- triggered by: goal contains PR/MR number (`#\d+`, `PR #\d+`, `MR \d+`) or explicit `review:` prefix
- `QUICK_REVIEW` -- triggered by: goal contains dep-bump keywords (`bump`, `chore:`, `dependabot`, `dependency upgrade`) AND contains PR/MR number
- `IMPLEMENT` -- triggered by: `.workrail/current-pitch.md` exists in workspace (Phase 0.5 will auto-detect it)
- `FULL` -- default: none of the above static signals present
- `ESCALATE` -- triggered by: static routing fails with a structural error (workspace not found, etc.)

**Routing function shape:**
```typescript
type PipelineMode =
  | { kind: 'REVIEW_ONLY'; prNumbers: readonly number[] }
  | { kind: 'QUICK_REVIEW'; prNumbers: readonly number[] }
  | { kind: 'IMPLEMENT'; pitchPath: string }
  | { kind: 'FULL'; goal: string }
  | { kind: 'ESCALATE'; reason: string };

function routeTask(goal: string, workspace: string): PipelineMode
```

**Per-mode pipeline sequences:**
- `REVIEW_ONLY`: `mr-review-workflow.agentic.v2` -> route by verdict (clean: merge, minor: fix-agent-loop, blocking: escalate)
- `QUICK_REVIEW`: same as REVIEW_ONLY but `agentConfig: { model: 'haiku-light' }`, no arch audit even if touched
- `IMPLEMENT`: `coding-task-workflow-agentic` (Phase 0.5 finds pitch.md) -> `mr-review-workflow.agentic.v2` -> merge
- `FULL`: `wr.discovery` -> `wr.shaping` -> `coding-task-workflow-agentic` -> PR -> `mr-review-workflow.agentic.v2` -> merge

**Failure handling:** each phase failure returns a `PipelineOutcome` with `escalated: true` and `escalationReason`. No fallback to simpler pipeline. Same pattern as `PrOutcome` in pr-review.ts.

**Tensions resolved:** determinism (pure function), YAGNI (no LLM cost), CoordinatorDeps (routing pure, execution injected).
**Tensions accepted:** routing is heuristic, not intelligent -- a PR-based task with a pitch in the repo would route to REVIEW_ONLY and skip the IMPLEMENT mode.
**Failure mode to watch:** edge cases where static signals conflict (PR number AND pitch.md both present). Disambiguation rule needed: REVIEW_ONLY wins over IMPLEMENT.
**Follows:** CoordinatorDeps injection pattern, pr-review.ts discriminated union approach.
**Gain:** Zero dispatch latency for routing; fully deterministic; easy to test.
**Give up:** Cannot handle ambiguous tasks. Any task not matching a static signal falls into FULL.
**Impact surface:** CLI `worktrain run pipeline`; trigger.yml operators who rely on goal text format.
**Scope judgment:** Best-fit for the immediate 4-5 use cases named in the problem statement.
**Philosophy:** Honors immutability, exhaustiveness, determinism-over-cleverness, YAGNI. Conflicts with nothing.

---

### Candidate B: classify-task-workflow as authoritative source (pure LLM routing)

**One-sentence summary:** The coordinator always spawns a `classify-task-workflow` session first, parses the `recommendedPipeline` output from step notes, and executes the pipeline that workflow specifies -- the coordinator script is a runner for whatever classify-task returns.

**Architecture:**
```typescript
async function routeTask(goal, workspace, deps): Promise<Result<readonly string[], string>> {
  const handle = await deps.spawnSession('classify-task-workflow', goal, workspace);
  const result = await deps.awaitSessions([handle], CLASSIFY_TIMEOUT_MS);
  const notes = await deps.getAgentResult(handle);
  return parseRecommendedPipeline(notes.recapMarkdown); // pure function, text block parser
}
// Then: for workflowId of recommendedPipeline, spawn in sequence
```

`parseRecommendedPipeline` is a pure function that extracts the `recommendedPipeline: ["...", "..."]` line from the structured text block, following `parseFindingsFromNotes` two-tier strategy: JSON block first, text regex fallback.

**Pipeline modes:** not named at the coordinator level -- the pipeline IS whatever classify-task returns. The coordinator just runs the sequence.

**Failure handling:** if `parseRecommendedPipeline` fails (LLM deviated from format), default to `['wr.discovery', 'coding-task-workflow-agentic', 'mr-review-workflow.agentic.v2']`. Any spawned phase failure escalates with structured reason.

**Tensions resolved:** intelligent routing for ambiguous tasks; single source of truth for pipeline selection rules (the workflow, not the coordinator).
**Tensions accepted:** non-deterministic (same task may classify differently); adds 5-15 second LLM latency per dispatch; `recommendedPipeline` is a string array of workflow IDs, not a typed discriminated union.
**Failure mode to watch:** coordinator runs `wr.discovery` unnecessarily for PR-only tasks if classify-task misclassifies them. Recovery: add static pre-check before spawning classify-task.
**Follows:** classify-task-workflow's existing decision rules are already correct; this candidate delegates trust to them.
**Gain:** routing rules live in the workflow, not the coordinator -- can be updated without code changes.
**Give up:** determinism, routing transparency (routing reason requires parsing LLM output), typed pipeline modes.
**Impact surface:** classify-task-workflow becomes a critical dependency -- format changes break coordinator.
**Scope judgment:** Best-fit for teams that want routing rules to evolve without code deployment.
**Philosophy:** Honors dependency injection (classify-task as a boundary). Conflicts with determinism-over-cleverness (LLM routing is clever but non-deterministic).

---

### Candidate C: static-first with LLM fallback (hybrid, recommended)

**One-sentence summary:** A two-tier `routeTask()` applies static rules first (fast, deterministic, covers 80% of cases), then falls back to classify-task-workflow only for ambiguous tasks where no static signal fires.

**Architecture:**
```typescript
type PipelineMode =
  | { kind: 'REVIEW_ONLY'; prNumbers: readonly number[] }
  | { kind: 'QUICK_REVIEW'; prNumbers: readonly number[] }
  | { kind: 'IMPLEMENT'; pitchPath: string }
  | { kind: 'FULL'; goal: string }
  | { kind: 'CLASSIFY_AND_RUN'; classifiedPipeline: readonly string[] }
  | { kind: 'ESCALATE'; reason: string };

async function routeTask(goal, workspace, deps): Promise<Result<PipelineMode, string>> {
  // Tier 1: static signals (pure, no I/O)
  const staticResult = applyStaticRules(goal, workspace);
  if (staticResult !== null) return ok(staticResult);
  // Tier 2: LLM classification
  const classified = await runClassification(goal, workspace, deps);
  return classified.kind === 'ok'
    ? ok({ kind: 'CLASSIFY_AND_RUN', classifiedPipeline: classified.value })
    : err(classified.error);
}
```

`CLASSIFY_AND_RUN` mode executes the `recommendedPipeline` array as a sequential phase list. `REVIEW_ONLY`/`QUICK_REVIEW`/`IMPLEMENT`/`FULL` have hardcoded phase sequences in the coordinator.

**Per-mode sequences:**
- `REVIEW_ONLY`: same as Candidate A
- `QUICK_REVIEW`: same as Candidate A
- `IMPLEMENT`: same as Candidate A
- `FULL`: `wr.discovery` -> `wr.shaping` -> `coding-task-workflow-agentic` -> PR -> review -> merge
- `CLASSIFY_AND_RUN`: execute phases from classify-task output in order; unknown workflow IDs escalate

**Failure handling:** escalation-first, same as pr-review.ts. The routing failure (classify-task parse failure) produces ESCALATE mode with reason.

**Tensions resolved:** determinism for well-known cases (static tier); intelligence for ambiguous cases (LLM fallback); no LLM latency for 80% of cases.
**Tensions accepted:** two-tier routing is more complex than either pure approach; `CLASSIFY_AND_RUN` mode is less typed than named modes.
**Failure mode to watch:** static rules and LLM classification disagree. Resolution: static always wins. If a developer adds a new static rule that catches cases formerly handled by classify-task, behavior changes silently.
**Follows:** parseFindingsFromNotes two-tier strategy pattern. CoordinatorDeps injection for the LLM fallback path.
**Gain:** fast for common cases, intelligent for ambiguous cases, deterministic for all named modes.
**Give up:** complexity of two tiers; CLASSIFY_AND_RUN mode is not a named type with typed data.
**Impact surface:** same as Candidate A plus classify-task-workflow dependency.
**Scope judgment:** Best-fit -- covers all named use cases efficiently. YAGNI risk is low because the LLM fallback adds ~30 lines of code, not a new architecture.
**Philosophy:** Honors immutability, exhaustiveness (switch on PipelineMode is exhaustive), determinism-over-cleverness (static tier is deterministic, LLM is bounded fallback), errors-as-data.

---

### Candidate D: explicit pipelineMode in trigger config + CLI flag (configuration-driven)

**One-sentence summary:** Add an optional `pipelineMode: 'review_only' | 'quick_review' | 'implement' | 'full' | 'auto'` field to `TriggerDefinition` and `worktrain run pipeline --mode <mode>` CLI flag; `auto` falls back to Candidate C's hybrid routing.

**Architecture:**
```typescript
// In TriggerDefinition (new optional field)
readonly pipelineMode?: 'review_only' | 'quick_review' | 'implement' | 'full' | 'auto';

// In coordinator: read from opts or trigger config
const mode = opts.pipelineMode ?? 'auto';
if (mode !== 'auto') return ok(toPipelineMode(mode, goal, workspace));
// Else: Candidate C hybrid routing
```

**Trigger config example:**
```yaml
triggers:
  - id: github-prs
    workflowId: adaptive-pipeline
    pipelineMode: review_only  # explicit: always run review pipeline for PR events
  - id: backlog-implement
    workflowId: adaptive-pipeline
    pipelineMode: full  # explicit: always run full pipeline for backlog tasks
```

**Failure handling:** same escalation-first policy. `pipelineMode` validation at trigger load time catches invalid values.

**Tensions resolved:** eliminates routing ambiguity for trigger operators (explicit config is authoritative); removes LLM classification cost for well-configured triggers.
**Tensions accepted:** requires configuration overhead; trigger.yml changes needed for each new use case; `auto` mode still requires Candidate C's complexity.
**Failure mode to watch:** trigger operator forgets to set `pipelineMode` and gets unexpected routing from `auto` fallback.
**Follows / departs:** departs from `TriggerDefinition` design (adds a new field); follows the principle of explicit > implicit.
**Gain:** total routing clarity for trigger-based pipelines; observable in trigger.yml config without reading coordinator code.
**Give up:** adds a field to `TriggerDefinition` (src/trigger/types.ts change); configuration overhead.
**Impact surface:** `TriggerDefinition`, trigger-store.ts validation, CLI `worktrain run pipeline` opts.
**Scope judgment:** Slightly broad for an initial coordinator design -- the `TriggerDefinition` change is a schema change with broader impact. But it resolves the root tension between implicit and explicit routing.
**Philosophy:** Honors explicit-over-implicit (not named in CLAUDE.md but consistent with the spirit of 'make illegal states unrepresentable'). Minor conflict with YAGNI (schema change is speculative for users who only use CLI).

---

### Candidate E: per-mode coordinator files with thin dispatcher (architectural decomposition)

**One-sentence summary:** Instead of one adaptive coordinator file, each pipeline mode is a separate coordinator function in its own file, mirroring the `pr-review.ts` pattern; a thin `dispatch.ts` reads the routing result and calls the right coordinator function.

**Architecture:**
```
src/coordinators/
  dispatch.ts         <- thin router: calls routeTask(), dispatches to mode coordinator
  modes/
    review-only.ts    <- runReviewOnlyPipeline(deps, opts)
    quick-review.ts   <- runQuickReviewPipeline(deps, opts)
    implement.ts      <- runImplementPipeline(deps, opts)
    full-pipeline.ts  <- runFullPipeline(deps, opts)
  routing/
    route-task.ts     <- routeTask() pure function (Candidate A's static rules)
    classify.ts       <- runClassification() -- LLM fallback
```

**dispatch.ts:**
```typescript
const mode = await routeTask(goal, workspace, deps);
switch (mode.kind) {
  case 'REVIEW_ONLY': return runReviewOnlyPipeline(deps, opts, mode);
  case 'QUICK_REVIEW': return runQuickReviewPipeline(deps, opts, mode);
  case 'IMPLEMENT': return runImplementPipeline(deps, opts, mode);
  case 'FULL': return runFullPipeline(deps, opts, mode);
  case 'ESCALATE': return err(mode.reason);
  default: return assertNever(mode);
}
```

Each mode coordinator is ~300-600 lines, fully independently testable. No mode-specific logic bleeds into other modes.

**Failure handling:** each mode coordinator has its own escalation policy appropriate to that mode. Full pipeline might have shaping-failure escalation logic. Review-only mirrors pr-review.ts.

**Tensions resolved:** monolithic-vs-decomposition tension (fully decomposed); each mode independently testable; adding a new mode is additive, not modification of existing code.
**Tensions accepted:** more files to navigate; routing layer is separate from execution, which is the right seam but adds indirection.
**Failure mode to watch:** mode coordinator interfaces diverge over time (each team member adds different fields to their mode's `Opts` type).
**Follows:** directly extends the `pr-review.ts` single-mode pattern -- this is N instances of that pattern.
**Gain:** each mode coordinator is small, focused, testable in isolation. Open/closed principle: adding a new mode does not touch existing files.
**Give up:** more files; thin dispatcher adds a layer.
**Impact surface:** CLI wiring, each mode coordinator's test suite.
**Scope judgment:** Best-fit for a growing coordinator surface. The decomposition is the right architecture for 5+ modes.
**Philosophy:** Honors YAGNI (each mode file is exactly what that mode needs), exhaustiveness (switch in dispatch.ts), compose-with-small-pure-functions.

---

## Challenge Notes

### Comparison matrix

| Tension | A (static) | B (LLM-only) | C (hybrid) | D (config) | E (decomposed) |
|---------|-----------|-------------|-----------|-----------|---------------|
| LLM accuracy vs dispatch latency | A wins: zero latency, no accuracy | B wins accuracy, loses latency | C wins both for common cases | D wins for configured triggers | neutral |
| Flexibility vs explicit configuration | A: implicit heuristics | B: implicit LLM | C: implicit hybrid | D: explicit config (best) | neutral |
| Monolithic vs decomposition | all except E are monolithic routing | same | same | same | E wins |
| recommendedPipeline verbatim vs advisory | A: ignores it entirely | B: verbatim | C: advisory for static cases, verbatim for classify | D: bypassed by config | neutral |
| Phase 0.5 vs coordinator routing | A: delegates to Phase 0.5 | B: may duplicate Phase 0.5 | C: static pitch.md check before Phase 0.5 | D: config resolves it | neutral |

### Recommendation: C + E (Candidate C routing mechanism, Candidate E file architecture)

**The routing mechanism decision (C):** Two-tier routing is the best-fit. Static rules cover the 4 well-defined cases (PR number, dep-bump, pitch.md, vague idea) without LLM cost. `CLASSIFY_AND_RUN` as the 5th mode handles genuinely ambiguous tasks via classify-task-workflow. This follows the `parseFindingsFromNotes` precedent in pr-review.ts (two-tier: structured first, fallback second).

**The architecture decision (E):** Per-mode coordinator files with a thin dispatcher is the correct architecture for 5 modes. Each mode file follows pr-review.ts independently. The dispatcher is the only code that changes when a new mode is added. This is how the codebase is already structured (pr-review.ts is one mode file) -- Candidate E just makes the pattern explicit.

**Combined:** the routing logic lives in `src/coordinators/routing/route-task.ts` and `routing/classify.ts`. The dispatcher lives in `src/coordinators/adaptive-pipeline.ts` (thin). The mode executors live in `src/coordinators/modes/`.

### Candidate C alone handles the routing; Candidate E handles the architecture; D is additive

Candidate D (pipelineMode in TriggerDefinition) is not mutually exclusive with C+E. It can be added as a later optimization -- the CLI `--mode` flag gives explicit override without requiring a schema change in TriggerDefinition. Start with `--mode` CLI flag; add TriggerDefinition field later if trigger operators need it.

### Strongest argument against C+E

**Against C (static rules):** The static rules are heuristics. A task `"fix the BLOCKING issue in PR #47"` contains both a blocking keyword (from review vocabulary) and a PR number. It routes to REVIEW_ONLY but the user may intend to implement a fix. The ambiguity is real. Counter: the routing decision is logged with reason before any spawn. Users who see an unexpected routing can add `--mode full` as an override.

**Against E (decomposition):** More files means more navigation overhead and more risk of interface divergence between mode coordinators. Counter: the shared `CoordinatorDeps` interface is the contract; mode-specific opts types can extend a base type. The decomposition is justified by the maintenance benefit at 5+ modes.

### Narrower option that loses: Candidate A (pure static)

Candidate A loses because tasks that don't match any static signal fall to FULL (run all phases). This is wasteful for Medium complexity tasks that don't need full discovery. Classify-task-workflow covers these for ~$0.002 and 5-15 seconds. The cost/benefit favors the hybrid over pure static.

### Broader option that might be justified: Candidate D

Candidate D (pipelineMode in TriggerDefinition) would be justified if trigger operators need deterministic routing for automated workflows (e.g., a GitHub PR webhook should ALWAYS route to REVIEW_ONLY, regardless of goal text). Evidence required: at least one trigger configuration where heuristic routing produces wrong results and explicit config is the only safe option. Start without it; add it if this evidence appears.

### Pivot conditions

- If `classify-task-workflow` note parsing proves unreliable (format drift), pivot to pure static (Candidate A) and accept that ambiguous tasks run FULL
- If `TriggerDefinition` change is needed for automated workflows, add Candidate D's pipelineMode field
- If context-passing agent's design shows that the coordinator must inject structured context at spawn time, the mode coordinator files must include context injection logic -- this is implementation detail, not a routing design change

---

## Resolution Notes

### Selected direction: C (routing) + E (architecture)

**Winner:** Candidate C two-tier routing + Candidate E per-mode file decomposition.

**Runner-up:** Candidate A (pure static routing). The challenge revealed that Candidate A covers all 5 stated use cases. It is a legitimate MVP starting point. C adds value for future Medium-complexity tasks not in the stated use cases. Both are correct -- choose based on timeline.

**Challenge findings:**

1. **CLASSIFY_AND_RUN seam crack (genuine weakness, not blocking):** C's CLASSIFY_AND_RUN mode creates a typed/untyped seam in the dispatcher. Mitigation: CLASSIFY_AND_RUN fires only for tasks with no static signal; the dispatcher handles it with a dedicated `runClassifyAndRunPipeline` function that is documented as the "catch-all" path. Alternatively: fold CLASSIFY_AND_RUN into FULL (just run the three-workflow pipeline for all ambiguous tasks) and remove the LLM fallback entirely. This would make C = A for ambiguous tasks, simplifying the design.
   - **Final decision: simplify C by removing CLASSIFY_AND_RUN. Ambiguous tasks (no static signal) default to FULL. This gives Candidate A's simplicity with Candidate C's structure.**

2. **A is sufficient for MVP:** Challenge confirmed that Candidate A covers all 5 stated use cases. C adds value for future Medium tasks. For an MVP, A is correct. The recommended design IS essentially Candidate A + Candidate E architecture. No classify-task-workflow dependency at all for the initial implementation.

### Final simplified design (A + E, not C + E)

**Routing (revised -- effectively A):**
```typescript
type PipelineMode =
  | { kind: 'REVIEW_ONLY'; prNumbers: readonly number[] }
  | { kind: 'QUICK_REVIEW'; prNumbers: readonly number[] }
  | { kind: 'IMPLEMENT'; pitchPath: string }
  | { kind: 'FULL'; goal: string }
  | { kind: 'ESCALATE'; reason: string };

function routeTask(goal: string, workspace: string): Result<PipelineMode, string>
// Pure function. No LLM. No async.
```

Static rules (prioritized):
1. goal matches dep-bump keywords AND PR/MR number -> `QUICK_REVIEW`
2. goal matches PR/MR number (`#\d+`, `PR #\d+`, `MR !?\d+`) -> `REVIEW_ONLY`
3. `.workrail/current-pitch.md` exists -> `IMPLEMENT`
4. else -> `FULL`

**Why remove CLASSIFY_AND_RUN:** classify-task-workflow adds latency, non-determinism, and format-parsing fragility for no concrete benefit over FULL for the stated use cases. The "YAGNI with discipline" principle wins. If Medium tasks turn out to be wasteful with FULL, add classify-task as a future enhancement with a typed artifact (not text parsing).

**Architecture (E as designed):**
```
src/coordinators/
  adaptive-pipeline.ts     <- thin entry point
  routing/
    route-task.ts          <- routeTask() pure function
  modes/
    review-only.ts         <- runReviewOnlyPipeline()
    quick-review.ts        <- runQuickReviewPipeline()
    implement.ts           <- runImplementPipeline()
    full-pipeline.ts       <- runFullPipeline()
```

### Accepted tradeoffs

1. All tasks without static signals run FULL (discovery + shaping + coding). This is correct for vague ideas; slightly wasteful for "refactor X" tasks that might skip discovery. Accepted: correctness matters more than cost optimization at MVP stage.
2. `routeTask()` is a pure function -- the only I/O is `fs.existsSync('.workrail/current-pitch.md')`. This filesystem check must be injectable via `AdaptiveCoordinatorDeps` for testability.
3. QUICK_REVIEW and REVIEW_ONLY are structurally similar; QUICK_REVIEW just passes a lighter model hint. They could be merged into one mode with an `isLight` flag, but discriminated union with two variants is cleaner.

### Identified failure modes

1. **PR number in a non-review task**: `"refactor PR #47 related auth code"` contains `#47` and routes to REVIEW_ONLY incorrectly. Mitigation: the routing decision is logged before any spawn; users see the unexpected routing and can use `--mode full` override.
2. **pitch.md stale**: `.workrail/current-pitch.md` exists from a previous task and routes a new task to IMPLEMENT incorrectly. Mitigation: document that pitch.md is consumed (moved/deleted) after the coding task completes. This is a Phase 0.5 / wr.shaping convention issue, not a routing design issue.
3. **FULL pipeline timeout**: wr.discovery + wr.shaping + coding is potentially 90+ minutes. The coordinator must enforce a wall-clock cutoff (same pattern as pr-review.ts COORDINATOR_SPAWN_CUTOFF_MS). Each phase gets a hardcoded timeout: discovery 30 min, shaping 30 min, coding 60 min.

### Switch triggers

- If `routeTask()` produces wrong routing more than 5% of the time in real use -> add classify-task as Tier 2 fallback (upgrade to C)
- If trigger operators need deterministic routing without static signals -> add Candidate D's `pipelineMode` field to TriggerDefinition
- If wr.discovery produces a standardized file at `.workrail/current-discovery.md` -> add a static rule to detect it and route to a IMPLEMENT_FROM_DISCOVERY mode

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-19 | Path: design_first | Goal was solution-stated; dominant risk is wrong routing mechanism design, not lack of landscape knowledge |
| 2026-04-19 | Routing mechanism: pure static (A), not hybrid (C) | Challenge revealed Candidate A covers all 5 stated use cases. CLASSIFY_AND_RUN adds non-determinism and format-parsing risk for no concrete MVP benefit. YAGNI wins. |
| 2026-04-19 | Architecture: per-mode files + thin dispatcher (E) | pr-review.ts is 1462 lines for one mode. Five modes in one file would be unmanageable. Decomposition is required, not premature. |
| 2026-04-19 | Candidate D (TriggerDefinition pipelineMode field) deferred | CLI --mode flag is sufficient. Schema change not justified until evidence of trigger-operator need. |
| 2026-04-19 | REVIEW_ONLY/QUICK_REVIEW delegate to pr-review coordinator | Review finding: reimplementing fix-agent loop would duplicate pr-review.ts logic. Delegation keeps behavior consistent. |
| 2026-04-19 | Per-phase timeouts required in implementation (R1 from review) | Discovery 30min, Shaping 30min, Coding 60min, Review 20min, FULL_MAX 160min, SPAWN_CUTOFF 130min -- hardcoded, never LLM-computed. |
| 2026-04-19 | PR number regex must be context-sensitive (O1 from review) | Bare `#\d+` produces false positives. Use `\bPR\s*#\d+\b` or `\bMR\s*!?\d+\b` patterns with verb context check. |
| 2026-04-19 | pitch.md must be archived after IMPLEMENT mode (O2 from review) | runImplementPipeline() archives .workrail/current-pitch.md to .workrail/pitches/[timestamp]-pitch.md after coding succeeds. Prevents stale routing. |
| 2026-04-19 | Timing constants specified explicitly | Review finding O1: FULL pipeline is 4x longer than pr-review.ts; pr-review.ts constants were wrong. New constants: discovery 35min, shaping 35min, coding 65min, cutoff 100min, max 120min. |
| 2026-04-19 | Pitch.md lifecycle invariant documented | Review finding O2: stale pitch.md silently misroutes future tasks. IMPLEMENT mode executor must archive pitch.md after completion. |

---

## Assumptions for the Context-Passing Agent

**Note:** `docs/design/adaptive-coordinator-context.md` did not exist at the time of this session's finalization. The following assumptions are based on what the routing design implies for inter-phase context passing. The context-passing agent should verify or challenge these.

### Assumptions the context-passing agent must know about:

1. **Routing determines spawn order, not context shape.** The routing layer (`routeTask()`) produces a `PipelineMode` variant. It does NOT know what context to pass to each spawned session. Context injection is entirely the responsibility of each mode coordinator (full-pipeline.ts, implement.ts, etc.), not the routing layer.

2. **FULL pipeline phase order is: `wr.discovery` -> `wr.shaping` -> `coding-task-workflow-agentic` -> review -> merge.** If the context-passing agent's design changes this order (e.g., by making shaping optional based on discovery findings), the `runFullPipeline()` function must be updated accordingly. The routing layer itself does not need to change.

3. **pitch.md is the canonical Shaping->Coding handoff.** The `IMPLEMENT` mode routes directly to coding because `current-pitch.md` already exists. The coding-task Phase 0.5 detects it and uses it. If the context-passing agent introduces a different handoff mechanism (e.g., coordinator-injected context instead of a file), the `IMPLEMENT` mode coordinator needs to inject that context at spawn time rather than relying on Phase 0.5 file detection.

4. **Discovery->Shaping context passing is not yet solved.** The `FULL` pipeline currently spawns `wr.discovery` then `wr.shaping` without passing discovery findings to shaping. The coordinator must bridge this gap by reading discovery's final step notes and injecting them as `assembledContextSummary` for the shaping spawn. This is an implementation detail inside `full-pipeline.ts` but the context-passing agent's design will determine exactly what to inject.

5. **The routing layer has no opinion on context.** The `PipelineMode` discriminated union does NOT carry context bundles. Context assembly and injection is done at spawn time within each mode coordinator, not in `routeTask()` or `adaptive-pipeline.ts`. If the context-passing agent's design needs the routing decision to carry context, this is a new requirement that changes the `PipelineMode` type shape.

6. **ESCALATE mode carries no phases.** If `routeTask()` returns `ESCALATE`, no sessions are spawned. The context-passing agent does not need to handle this case.

---

## Final Summary

### The routing/classification design for WorkTrain's adaptive pipeline coordinator

**What was decided:**

The adaptive coordinator uses **pure static routing with per-mode file decomposition** (Candidate A routing + Candidate E architecture).

**Routing mechanism:** `routeTask(goal: string, workspace: string): Result<PipelineMode, string>` is a pure function with no I/O (filesystem check for pitch.md is injectable via deps). It applies static rules in priority order:

1. Dep-bump keywords AND PR/MR number in goal → `QUICK_REVIEW`
2. PR/MR number in goal OR `github_prs_poll` trigger provider → `REVIEW_ONLY`
3. `.workrail/current-pitch.md` exists in workspace → `IMPLEMENT`
4. Default → `FULL` (conservative)

**Named pipeline modes with step sequences:**

| Mode | Step sequence |
|------|---------------|
| `REVIEW_ONLY` | `mr-review-workflow.agentic.v2` → verdict routing (clean: merge, minor: fix-loop, blocking: escalate) |
| `QUICK_REVIEW` | same as REVIEW_ONLY with lighter model config |
| `IMPLEMENT` | `coding-task-workflow-agentic` (Phase 0.5 reads pitch.md) → PR → `mr-review-workflow.agentic.v2` → merge |
| `FULL` | `wr.discovery` → `wr.shaping` → `coding-task-workflow-agentic` → PR → `mr-review-workflow.agentic.v2` → merge |

**File architecture (Candidate E):**
```
src/coordinators/
  adaptive-pipeline.ts       -- thin entry point + AdaptiveCoordinatorDeps wiring
  routing/
    route-task.ts            -- routeTask() pure function + applyStaticRules()
  modes/
    review-only.ts           -- runReviewOnlyPipeline()
    quick-review.ts          -- runQuickReviewPipeline()
    implement.ts             -- runImplementPipeline()
    full-pipeline.ts         -- runFullPipeline()
```

**Entry point:** `worktrain run pipeline --task "..." [--mode FULL|IMPLEMENT|REVIEW_ONLY|QUICK_REVIEW]` CLI command. The `--mode` flag provides explicit override for all routing decisions.

**REVIEW_ONLY and QUICK_REVIEW delegate to existing pr-review coordinator:**
The `modes/review-only.ts` and `modes/quick-review.ts` executors should delegate to the existing `runPrReviewCoordinator()` from `src/coordinators/pr-review.ts` rather than reimplementing the fix-agent loop. This avoids duplicating the verdict parsing, fix-agent loop, and merge logic. The only difference is the goal string passed to the review session.

**Timing constants (hardcoded, never LLM-computed -- robustness rule from pr-review.ts):**
```typescript
const DISCOVERY_TIMEOUT_MS = 35 * 60 * 1000;    // 35 minutes
const SHAPING_TIMEOUT_MS = 35 * 60 * 1000;       // 35 minutes
const CODING_TIMEOUT_MS = 65 * 60 * 1000;        // 65 minutes
const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;        // 25 minutes (child session)
const COORDINATOR_SPAWN_CUTOFF_MS = 100 * 60 * 1000; // 100 min (refuse new spawns after)
const COORDINATOR_MAX_MS = 120 * 60 * 1000;      // 120 min total coordinator wall-clock
```

**Pitch.md lifecycle invariant:**
`IMPLEMENT` mode routes to coding because `.workrail/current-pitch.md` exists. After the coding session completes (success OR failure), the mode executor must archive the pitch:
- Archive path: `.workrail/used-pitches/pitch-{ISO-timestamp}.md`
- This prevents stale pitch.md from incorrectly routing future tasks to IMPLEMENT mode

**AdaptiveCoordinatorDeps new methods (beyond pr-review.ts CoordinatorDeps):**
- `fileExists(path: string): Promise<boolean>` -- for pitch.md detection in routeTask()
- All other methods: same as `CoordinatorDeps` (copied, not inherited -- separate interface avoids forced coupling to pr-review.ts)

**QUICK_REVIEW goal string template:**
```
[DEP BUMP] Review PR #${prNumber}: ${prTitle} -- skip architecture audit, verify version compatibility and test coverage only
```

**Failure handling:**
- Any phase failure produces a `PipelineOutcome` with `escalated: true` and structured `escalationReason: { phase: string, reason: string }`
- No silent substitution (e.g., shaping failure does not fall back to a simplified pipeline)
- Routing decision is logged as traceability JSON before any session spawn
- FULL pipeline: each phase is an independent escalation point (discovery-fail, shaping-fail, coding-fail each escalate independently)

**Why LLM classification (classify-task-workflow) was excluded:**

After adversarial challenge, CLASSIFY_AND_RUN mode was removed. The LLM classification path adds non-determinism and format-parsing fragility (notes parsing vs typed artifact) for no concrete MVP benefit. All 5 stated use cases are covered by static rules. The upgrade path to add classify-task as a Tier 2 fallback exists when evidence shows >5% misrouting in production.

**Deferred:** Candidate D's `pipelineMode` field in `TriggerDefinition`. CLI `--mode` flag is sufficient. Schema change deferred until trigger operators demonstrate need for deterministic routing without static signals.

**Switch triggers for the context-passing agent:**
- If context-passing design requires the routing decision to carry a context bundle → `PipelineMode` type changes to include context
- If discovery->shaping handoff uses a new file convention → routing logic may gain a new static signal (detect `.workrail/current-discovery.md`)
- If pitch.md handoff is replaced by coordinator-injected context → `IMPLEMENT` mode routing condition changes

---

### Confidence and residual risks

**Confidence band: HIGH**

**Residual risks (non-blocking):**
1. wr.discovery runtime > 35 minutes would bust the FULL pipeline timing budget. Mitigation: per-phase timeout constants are hardcoded and will surface the issue as a timeout escalation.
2. `parseRecommendedPipeline()` pure function not yet written. Should be written at implementation time as upgrade-path preparation (does not block MVP).
3. REVIEW_ONLY delegation to `runPrReviewCoordinator()` -- the delegation API (how `modes/review-only.ts` calls into pr-review.ts) needs to be designed at implementation time. This is a clean internal API design question, not a routing design question.

**What would change the design:**
- >5% misrouting rate in real use → upgrade to hybrid C (add classify-task as Tier 2 fallback)
- Trigger operators need deterministic routing without goal-text signals → add Candidate D's `pipelineMode` to TriggerDefinition
