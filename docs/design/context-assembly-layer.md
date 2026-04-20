# Context Assembly Layer -- Discovery

**Status:** Discovery complete (wr.discovery workflow)
**Date:** 2026-04-19
**Workspace scope:** WorkTrain ONLY (`src/daemon/`, `src/trigger/`, `src/coordinators/`, `src/cli/`). NOT the WorkRail MCP server (`src/mcp/`).

---

## Context / Ask

### Stated goal (original framing)

Design the context assembly layer for WorkTrain -- the missing abstraction between the trigger/dispatch layer and the orchestration (coordinator) layer.

### Problem statement (reframed)

WorkTrain sessions start with insufficient context: a raw goal string plus sparse payload fields from `contextMapping` dot-path extraction. Agents repeatedly rediscover information that is statically knowable before spawning -- repo conventions (`CLAUDE.md`/`AGENTS.md`), upstream specs (pitch/PRD/BRD), affected files (git diff), and prior session outcomes -- wasting turns, missing conventions, and ignoring prior work.

### Desired outcome

A concrete design for a `ContextAssembler` abstraction that:
1. Can be called before spawning any WorkTrain session
2. Returns a typed context bundle consumable by multiple coordinators
3. Plugs into the existing `WorkflowTrigger` / `CoordinatorDeps` architecture without breaking existing code
4. Is concrete enough to feed directly into wr.shaping

### What is NOT in scope

- WorkRail MCP server changes (`src/mcp/`)
- Any changes to the workflow engine (`src/v2/durable-core/`)
- Production implementation (this is discovery/design only)
- Knowledge graph implementation (deferred until this design is complete, per Apr 19 backlog decision)

---

## Path Recommendation

**Selected path:** `full_spectrum`

**Rationale:** The goal was a solution statement (pre-framed as "context assembly layer"). `design_first` would risk designing an abstraction in isolation from the actual landscape. `landscape_first` alone would miss the reframing work. `full_spectrum` grounds the design in the existing codebase structure, validates the proposed abstraction against alternatives, and produces a concrete enough design to hand to wr.shaping.

The stated solution (context assembly layer) is likely the right answer for the god-class / separation-of-concerns problem, but the interface shape, integration point, and v1 source set are genuinely uncertain and require landscape work.

---

## Constraints / Anti-goals

### Hard constraints

- Must not require changes to the WorkRail engine or MCP server
- Must be injectable via `CoordinatorDeps` pattern (no direct I/O in coordinator core)
- Must not add `ts-morph` or DuckDB to production build in v1 (knowledge graph is a v2 source)
- Must be usable by `pr-review.ts` coordinator without breaking its existing `CoordinatorDeps` interface

### Anti-goals

- Do NOT add context-gathering logic directly to `pr-review.ts` or any other coordinator script (the god-class anti-pattern)
- Do NOT require a new daemon process or network service for context assembly
- Do NOT couple the assembler to a specific trigger type (it must work for webhook triggers and polling triggers)
- Do NOT implement context window trimming/prioritization in v1 (200K context window is not the binding constraint)

---

## Landscape Packet

### Current state: what WorkTrain sessions receive today

The `WorkflowTrigger` interface (`src/daemon/workflow-runner.ts`):
```typescript
export interface WorkflowTrigger {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath: string;
  readonly context?: Readonly<Record<string, unknown>>;  // from contextMapping dot-paths
  readonly referenceUrls?: readonly string[];             // static URLs -> system prompt
  readonly agentConfig?: { model?, maxSessionMinutes?, maxTurns?, maxSubagentDepth? };
  readonly soulFile?: string;
}
```

### What the daemon already does at session startup

Critically, `workflow-runner.ts` already performs context loading before the first LLM turn:

1. **CLAUDE.md / AGENTS.md** -- `loadWorkspaceContext(workspacePath)` scans for `.claude/CLAUDE.md`, `CLAUDE.md`, `AGENTS.md`, `.github/AGENTS.md` in order and injects them into the system prompt under `## Workspace Context`. Cap: 32 KB combined. This runs for EVERY session automatically.
2. **Soul file** -- `loadDaemonSoul(trigger.soulFile)` loads the daemon's persona/rules. Cascade: trigger YAML soulFile -> workspace soulFile -> global `~/.workrail/daemon-soul.md`.
3. **Prior step notes (same session)** -- `loadSessionNotes(startContinueToken)` reads step notes from the CURRENT session. For fresh sessions, returns `[]`. For checkpoint-resumed sessions, provides continuity notes.
4. **referenceUrls** -- static URLs from `TriggerDefinition.referenceUrls` are appended to the system prompt as a "Before starting, fetch these documents" instruction.

These are all loaded in parallel (`Promise.all`) before the `Agent` is constructed.

### Current injection points in `TriggerDefinition` (trigger-level config)

1. **`referenceUrls`** -- STATIC URL list baked into triggers.yml at configure time. Agent is instructed to fetch them. Covers: known-ahead-of-time upstream docs. Does NOT cover: dynamic URLs from the webhook payload (e.g. PR description body may link to a design doc).
2. **`contextMapping`** -- dot-path extraction from webhook payload at dispatch time. Maps payload fields to workflow context variables (accessible as `context.mrTitle`, `context.prNumber`, etc. in the goal template). Covers: PR metadata. Does NOT cover: repo state or cross-session history.
3. **`goalTemplate`** -- Mustache substitution into the goal string. Covers: specific goal wording. Does NOT cover: structured context injection.

### Current coordinator: what `pr-review.ts` spawns

`runPrReviewCoordinator` -> `spawnSession(workflowId, goal, workspace)` where:
- `workflowId`: `'mr-review-workflow-agentic'`
- `goal`: `'Review PR #N "title" before merge'`
- `workspace`: absolute path

The review agent gets: goal string, workspace path, CLAUDE.md injection (automatic), referenceUrls (if configured in triggers.yml). It does NOT get: the PR diff, the PR description body, affected file list, or prior review sessions for the same PR.

### What is actually missing (revised after code reading)

CLAUDE.md injection was listed as a gap in the problem statement -- this was WRONG. The daemon already handles it. The real gaps are:

1. **Git state (per-task)** -- no diff summary, no affected file list, no branch/commit context. This is dynamic: different PRs have different diffs. Cannot be baked into triggers.yml.
2. **Dynamic upstream docs** -- referenceUrls in triggers.yml are static. If a GitHub issue body links to a design doc, the agent does not see it. The link exists in the webhook payload but contextMapping cannot fetch and embed document content.
3. **Cross-session prior notes** -- `loadSessionNotes` loads prior notes for the SAME session (checkpoint resume). It does NOT load notes from PRIOR sessions on the same workspace/task (e.g., a previous review of the same PR). A second review starts completely cold.
4. **Structured task metadata** -- the goal string is free-form text. There is no typed struct for "this is a PR review for PR #42, branch feature/foo, by author alice, with 3 affected files". Agents parse the goal string rather than reading typed fields.
5. **No coordinator reuse** -- if two coordinators both need "git diff summary for the workspace" before spawning, each must independently implement the I/O. No shared assembly layer exists.

### What the knowledge graph spike produced

`src/knowledge-graph/` exists (DuckDB in-memory + ts-morph indexer). NOT wired to any tool. ts-morph is in devDependencies. This is the future dynamic source for "what files import the file being changed" -- NOT a v1 source.

### Session summary provider: the prior-session lookup infrastructure

`src/v2/infra/local/session-summary-provider/index.ts` implements `LocalSessionSummaryProviderV2`. It:
- Enumerates sessions from disk (most-recently-modified first)
- Projects health, run DAG, recap snippets, workspace observations (git branch/SHA)
- Returns typed `HealthySessionSummary[]` with `recapSnippet`, `sessionTitle`, `observations.gitBranch`

This infrastructure exists and is used by the MCP server (resume_session, session listing in console). It is NOT currently used by coordinators or by the context assembly layer. The data needed for "prior session notes for this workspace" already exists -- it just isn't wired to the dispatch path.

### TriggerRouter dispatch flow

`route(event)` in `trigger-router.ts`:
1. Look up trigger by ID
2. Validate HMAC
3. Apply `contextMapping` (dot-path extract from payload -> `workflowContext`)
4. Interpolate `goalTemplate` (or use static `goal`)
5. Build `WorkflowTrigger` = `{ workflowId, goal, workspacePath, context: workflowContext, referenceUrls, agentConfig, soulFile }`
6. Enqueue `runWorkflowFn(workflowTrigger, ...)` asynchronously

Context assembly would fit between steps 4 and 5 -- after goal and payload are known, before `WorkflowTrigger` is built. This is the natural integration point.

---

## Problem Frame Packet

### Root cause analysis

The gap is not "agents lack context" generically. The specific root cause is:

**WorkTrain's dispatch path builds `WorkflowTrigger` from a static trigger config plus a webhook payload, but has no mechanism to enrich it with runtime workspace state.**

The trigger system is designed to be stateless and fast (it must return 202 immediately). Context assembly is inherently stateful (reads disk, runs git commands, queries session store). These two concerns must be decoupled: the trigger system dispatches, a separate assembler enriches.

### Forces at play

1. **Coordinator specificity** -- `pr-review.ts` knows it's reviewing a PR and could in principle run `gh pr view --json body,diff` before spawning. But this would be coordinator-specific assembly that duplicates when a coding coordinator also needs git state.
2. **Dependency direction** -- coordinators currently live above the dispatch layer. Context assembly must live at the same level or below so coordinators can delegate to it without knowing its implementation.
3. **Failure isolation** -- context assembly failure (e.g., git command fails, session store unavailable) must never block session dispatch. The session should start with partial context rather than not starting at all.
4. **Testability** -- coordinators already use `CoordinatorDeps` for DI. Context assembly must follow the same pattern or it becomes untestable.

### The integration point question (primary uncertainty)

Three candidate integration points:

**Option A: In `TriggerRouter.route()` before building `WorkflowTrigger`**
- Pros: centralised; all workflows get enriched context automatically; no per-coordinator work
- Cons: `route()` must return 202 immediately; async context assembly would delay the response; context assembly for a PR trigger is useless for a generic webhook trigger that runs a different kind of task

**Option B: In each coordinator before `spawnSession()`**
- Pros: coordinator knows the task type and can request the right context; assembly is per-task
- Cons: assembly logic would be duplicated across coordinators if not extracted

**Option C: As a `ContextAssembler` service injected into coordinator deps**
- Pros: decoupled (coordinator calls `assembleContext(task, workspace)` and gets a bundle); reusable across coordinators; testable with fakes
- Cons: requires adding `assembleContext` to `CoordinatorDeps` or as a separate injectable

**Verdict:** Option C. The coordinator calls `assembleContext(task, workspace, triggerMetadata)` and receives a typed bundle. This keeps the TriggerRouter fast (no I/O delay) while making assembly reusable and testable.

### Stakeholders / users

| Stakeholder | Job to be done | Pain today |
|---|---|---|
| pr-review coordinator | Start a review session with enough context that the agent reviews intelligently | Agent re-reads the PR description from GitHub, missing context from issue body; first review turn is setup |
| Future coding coordinator | Start a coding session with file-level context so the agent starts on the right files | Agent runs `find` and `grep` for the first 3-5 turns to discover where code lives |
| WorkTrain operator (Etienne) | Configure once, get useful sessions consistently | Must manually put every relevant URL into triggers.yml referenceUrls |
| WorkTrain daemon | Build `WorkflowTrigger` with enriched context without I/O blocking | No mechanism for per-dispatch enrichment today |

### Pains and tensions

1. **Tension: coordinator knows task type vs. generic assembly** -- A PR review coordinator knows it can run `gh pr view --json body,diff`. A generic `assembleContext()` doesn't know what sources are relevant. Resolution: typed `AssemblyTask` input discriminated by task kind.
2. **Tension: failure isolation vs. completeness** -- Assembly that partially fails (git command unavailable, session store offline) must not block dispatch. But partial context may be worse than no context if the agent is misled by stale data.
3. **Pain: `referenceUrls` are configure-time only** -- dynamic upstream docs (PR issue body, linked design doc) require fetching at dispatch time. Static config cannot cover this.
4. **Pain: cross-session memory is invisible** -- If PR #42 was reviewed last week and found 3 issues, the next review session has no idea. The session summary infrastructure exists but isn't wired to dispatch.

### HMW questions

1. **HMW make context assembly a first-class step in the coordinator pipeline** without requiring every coordinator to independently implement I/O?
2. **HMW express task type (PR review vs. coding task vs. issue triage) as a typed input** to assembly so the assembler knows which sources to query?

### Primary framing risk

**The framing assumes agents are context-starved because the assembler doesn't exist.** The specific condition that would make this framing wrong: if an audit of live session logs shows that WorkTrain agents for the current pr-review workflow already spend fewer than 2 turns on setup (because CLAUDE.md is injected and referenceUrls covers the relevant docs), then the gap is primarily limited to cross-session memory -- and the right solution is a lightweight "prior session notes" injection rather than a full context assembly layer with typed task sources. In that case, a much simpler `PriorSessionContext` struct injected via `WorkflowTrigger.context['priorSessionNotes']` would suffice.

---

## Candidate Directions

### Problem Understanding (tensions, seam, what makes it hard)

**Core tensions:**
1. Generic interface vs. task-specific sources -- `assembleContext()` needs to know what to fetch, but only the coordinator knows the task type. Typed `AssemblyTask` discriminated union resolves this.
2. Failure isolation vs. typed bundle -- a single `Result<ContextBundle, Error>` fails entirely if any source fails. Per-field `Result<T, string>` is correct but verbose.
3. WorkflowTrigger injection boundary -- assembled bundle must reach `buildSystemPrompt()` in the daemon without changing the engine. Options: new optional field on WorkflowTrigger (cleanest), string in context map (no schema change), or append to goal string (ugliest).
4. YAGNI vs. extensibility -- philosophy demands no speculation, but the backlog explicitly names knowledge graph as a v2 plugin. The interface must have a clear extension point without implementing v2.

**What makes it hard:**
- `buildSystemPrompt()` in `workflow-runner.ts` currently takes `workspaceContext: string | null`. Injecting structured context requires either changing this signature (engine boundary) or serializing the bundle to string before crossing.
- `CoordinatorDeps.spawnSession` is a narrow 3-argument interface. Passing richer context requires either extending it or encoding the bundle into existing fields.
- Per-source failure tracking with readonly field types is verbose but necessary for type safety.

**Real seam:** Between coordinator's `spawnSession()` call and the daemon's `buildSystemPrompt()`. Context must be assembled by the coordinator (it knows the task), passed through WorkflowTrigger, and consumed by the daemon.

---

### Candidate A: Minimal enriched WorkflowTrigger fields

**Summary:** Add one optional `assembledContext` field to `WorkflowTrigger`; populate it in the coordinator via a single `assembleTaskContext` injectable function in `CoordinatorDeps`; `buildSystemPrompt()` adds one new section.

```typescript
// Addition to WorkflowTrigger in workflow-runner.ts
interface WorkflowTrigger {
  // ... existing fields ...
  readonly assembledContext?: {
    readonly gitDiff?: string;
    readonly priorSessionNotes?: readonly string[];
    readonly dynamicReferenceUrls?: readonly string[];
    readonly sourceErrors?: Readonly<Record<string, string>>; // source -> error message
  };
}

// Addition to CoordinatorDeps
interface CoordinatorDeps {
  // ... existing deps ...
  readonly assembleTaskContext: (opts: {
    readonly workspacePath: string;
    readonly prNumber?: number;
    readonly payloadBody?: string;
  }) => Promise<WorkflowTrigger['assembledContext']>;
}
```

**Tensions resolved:** Failure isolation (sourceErrors map), WorkflowTrigger injection (new optional field), minimal code.
**Tensions accepted:** Multi-coordinator reuse (assembleTaskContext is per-coordinator unless extracted manually), task-type routing (opts struct is not discriminated -- coordinator still decides what to request).
**Failure mode to watch:** `buildSystemPrompt()` grows ad-hoc injection blocks as sources expand.
**Repo-pattern relationship:** Follows existing WorkflowTrigger optional field pattern (soulFile, agentConfig). Adapts CoordinatorDeps.
**Gains:** Minimal code, no new module, backward-compatible.
**Losses:** sourceErrors is stringly-typed (key names are unchecked). Not a reusable service.
**Scope judgment:** Best-fit for v1 with single coordinator. Too narrow once a second coordinator needs the same sources.
**Philosophy fit:** Honors YAGNI, DI. Conflicts with 'make illegal states unrepresentable' (sourceErrors Record is stringly typed).

---

### Candidate B: ContextAssembler service with typed AssemblyTask input (RECOMMENDED)

**Summary:** A `ContextAssembler` service lives in `src/context-assembly/`; accepts a typed `AssemblyTask` discriminated union; returns a `ContextBundle` with per-field `Result` values; injected into `CoordinatorDeps`; bundle is serialized to a context summary string and passed via `WorkflowTrigger.context['assembledContextSummary']`; `buildSystemPrompt()` is NOT changed.

```typescript
// src/context-assembly/types.ts

export type AssemblyTask =
  | { readonly kind: 'pr_review'; readonly prNumber: number; readonly workspacePath: string; readonly payloadBody?: string }
  | { readonly kind: 'coding_task'; readonly issueNumber?: number; readonly workspacePath: string; readonly payloadBody?: string };

export interface ContextBundle {
  readonly task: AssemblyTask;
  readonly gitDiff: Result<string, string>;
  readonly priorSessionNotes: Result<readonly string[], string>;
  readonly dynamicReferenceUrls: Result<readonly string[], string>;
  readonly assembledAt: string; // ISO timestamp
}

export interface ContextAssembler {
  assemble(task: AssemblyTask): Promise<ContextBundle>;
}

// src/context-assembly/deps.ts
export interface ContextAssemblerDeps {
  readonly execGit: (args: readonly string[], cwd: string) => Promise<Result<string, string>>;
  readonly listRecentSessions: (workspacePath: string, limit: number) => Promise<Result<readonly SessionNote[], string>>;
  readonly extractUrlsFromText: (text: string) => readonly string[];
}

// src/context-assembly/index.ts
export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssembler;

// Pure rendering function
export function renderContextBundle(bundle: ContextBundle): string;
// -> produces markdown string injected into WorkflowTrigger.context['assembledContextSummary']
```

**Integration in coordinator:**
```typescript
// CoordinatorDeps gains:
readonly contextAssembler: ContextAssembler;

// Before spawnSession():
const bundle = await deps.contextAssembler.assemble({
  kind: 'pr_review',
  prNumber: pr.number,
  workspacePath: opts.workspace,
  payloadBody: pr.description,
});
const contextSummary = renderContextBundle(bundle); // pure, testable
const spawnContext = { assembledContextSummary: contextSummary };
await deps.spawnSession(workflowId, goal, opts.workspace, spawnContext);
```

**spawnSession signature extended (backward-compatible optional arg):**
```typescript
// CoordinatorDeps.spawnSession extended:
readonly spawnSession: (
  workflowId: string,
  goal: string,
  workspace: string,
  context?: Readonly<Record<string, unknown>>, // optional extra context
) => Promise<Result<string, string>>;
```

**How the context reaches the agent:** `context['assembledContextSummary']` is passed to `start_workflow` as a context variable. The WorkRail engine already stores context variables in the session; the existing `## Workspace Context` injection in `buildSystemPrompt()` is not changed. The assembled context summary is visible to the agent as a workflow context variable accessible via `{{assembledContextSummary}}` in step prompts or injected directly.

**Tensions resolved:** Multi-coordinator reuse (ContextAssembler service shared), typed task-specific routing (AssemblyTask discriminated union), per-field failure isolation (Result<T, E>), extensibility (add AssemblyTask kind or source without touching callers).
**Tensions accepted:** Context serialized to string before WorkflowTrigger boundary (loses structure at agent boundary). `buildSystemPrompt()` unchanged means assembled context is in the context map, not a dedicated system prompt section -- may be less visible to the agent.
**Failure mode to watch:** `renderContextBundle()` becomes the accumulation point for formatting decisions. If each coordinator wants different rendering, either renderContextBundle takes options or each coordinator writes its own renderer.
**Repo-pattern relationship:** Follows CoordinatorDeps DI pattern exactly. New module `src/context-assembly/` is a familiar pattern (see `src/knowledge-graph/` for precedent). AssemblyTask discriminated union follows PollingSource precedent in `trigger/types.ts`.
**Gains:** Clean separation, testable with fake deps, multi-coordinator reusable, failure-isolated, extensible for knowledge graph v2, no engine changes.
**Losses:** More code than Candidate A (~150 LOC for the module). String serialization loses type structure at agent boundary. Adding a new dep to CoordinatorDeps requires updating the composition root.
**Scope judgment:** Best-fit for the multi-coordinator goal stated in the backlog decision.
**Philosophy fit:** Honors DI, errors-as-data, immutability, exhaustiveness (discriminated union), YAGNI (only 3 v1 sources). The assembly module itself follows 'small pure functions' (renderContextBundle is pure).

---

### Candidate C: Context contributions array on spawnSession

**Summary:** Extend `CoordinatorDeps.spawnSession` to accept `readonly ContextContrib[]`; each coord fetches its own sources and packages them as labeled string blobs; daemon loops over contribs in `buildSystemPrompt()`.

```typescript
export interface ContextContrib {
  readonly sourceLabel: string;
  readonly content: string;
  readonly injectionPoint: 'system_prompt_section' | 'context_variable';
}

// CoordinatorDeps.spawnSession extended:
readonly spawnSession: (
  workflowId: string,
  goal: string,
  workspace: string,
  contribs?: readonly ContextContrib[],
) => Promise<Result<string, string>>;
```

**Tensions resolved:** Formatting stays in daemon (not coordinator). Coordinator packages sources as blobs.
**Tensions accepted:** Source-fetching still duplicated per coordinator. No typed task routing. ContextContrib.sourceLabel is unchecked string.
**Failure mode:** Contribs array grows without coordination; system prompt expands unpredictably. No failure isolation per source (coordinator must handle errors before packaging).
**Repo-pattern relationship:** Partially follows WorkflowTrigger optional fields. Introduces a new concept (contribs) not found elsewhere.
**Gains:** Formatting consolidated in daemon. Simple coordinator usage.
**Losses:** Source-fetching not reusable. No typed structure.
**Scope judgment:** Too narrow -- doesn't solve the multi-coordinator reuse problem.
**Philosophy fit:** Conflicts with 'make illegal states unrepresentable' (string labels, raw content), 'prefer explicit domain types over primitives'.

---

### Comparison and Recommendation

| Criterion | A (minimal) | B (service) | C (contribs) |
|---|---|---|---|
| Multi-coordinator reuse | Weak | Strong | Weak |
| Per-source failure isolation | Adequate | Strong | Weak |
| Typed task routing | None | Strong | None |
| Engine changes required | Yes (WorkflowTrigger) | No (uses context map) | Yes (buildSystemPrompt loop) |
| New code volume | ~50 LOC | ~150 LOC | ~50 LOC |
| Extension point for knowledge graph | Ad-hoc | Typed (new AssemblyTask kind) | Ad-hoc |
| Philosophy alignment | Good | Excellent | Poor |

**Recommendation: Candidate B**

The Apr 19 backlog decision is specifically about the god-class problem and multi-coordinator reuse. Candidate B is the only design that solves both. The extra 100 LOC over Candidate A pays for itself when the second coordinator arrives.

---

### Self-Critique

**Strongest counter-argument:** If only one coordinator ever needs context assembly, Candidate A delivers 90% of the value with 30% of the code. YAGNI argues for A.

**Why B still wins:** The backlog explicitly identifies a future coding coordinator. The migration from A to B when that coordinator arrives requires refactoring inline functions to a service -- more disruptive than designing B now.

**Pivot conditions:**
- If live session audit shows < 2 setup turns today -> simplify to Candidate A (prior notes only)
- If buildSystemPrompt() cannot change -> use context map for all injection (B accommodates this)
- If knowledge graph is near-term (< 2 months) -> add `queryKnowledgeGraph` to `ContextAssemblerDeps` now

**Invalidating assumption:** If agents ignore assembled context because the system prompt is already at or near the attention threshold, the entire premise fails. Test with one source first (prior session notes) and measure whether agents cite it before wiring all three sources.

---

### Open Questions for the Main Agent

1. Should `renderContextBundle()` be a pure function or should each coordinator provide its own renderer? (Affects whether Candidate B needs a rendering strategy pattern)
2. Does `WorkflowTrigger.context['assembledContextSummary']` actually reach the agent as useful context, or does it need to be a system prompt section? (Affects whether buildSystemPrompt() must change)
3. Is `SessionNote` available from `LocalSessionSummaryProviderV2` without changes, or does the assembler need a new port? (Affects implementation scope)
4. Should `ContextAssemblerDeps.execGit` be the same as the existing `execAsync` pattern in `workflow-runner.ts`, or should it be a distinct dep? (Code reuse vs. coupling)

---

## Challenge Notes

### Assumption 1: A new architectural layer is required

**Assumption:** Context assembly needs its own layer separate from trigger and orchestration.
**Challenge:** The trigger layer already provides `referenceUrls` injected into the system prompt. Richer `goalTemplate` plus carefully structured `referenceUrls` pointing to `CLAUDE.md` and upstream docs might deliver 80% of the value without any new abstraction.
**Evidence to confirm/refute:** Audit session logs for re-discovery turns. If agents spend under 3 turns on setup when `referenceUrls` already includes `CLAUDE.md`, a new layer adds marginal value. If they still rediscover conventions, pre-assembly is justified.
**Verdict:** Partially confirmed. `referenceUrls` handles static known-at-config-time URLs. A new layer is needed for: (a) dynamic context predictable only at dispatch time (git diff, affected files), (b) cross-session history (prior session notes), and (c) multi-coordinator reuse without duplication.

### Assumption 2: Pre-fetch is better than on-demand

**Assumption:** Context should be assembled before spawning rather than fetched on demand by the agent mid-session.
**Challenge:** Pre-fetch assumes relevant context is predictable from the trigger. For open-ended coding tasks, relevant files emerge as the agent reads code. A `query_knowledge_graph` daemon tool called mid-session may be more accurate.
**Evidence to confirm/refute:** Inspect the fix-agent goal: `'Fix review findings in PR #N: finding1; finding2'`. The affected files are often implicit in the findings. Measure setup turns vs. work turns in live sessions.
**Verdict:** Pre-fetch wins for well-structured, predictable context (CLAUDE.md, git diff, PR description, prior session notes). On-demand wins for dynamic ad-hoc queries (cross-file dependency traversal). The context assembly layer should handle pre-fetch; a future daemon tool handles on-demand.

### Assumption 3: Context window budget management is a v1 concern

**Assumption:** Sessions have a context window; the assembler must decide what to include and what to trim.
**Challenge:** With 200K context windows and WorkTrain sessions targeting 30-50 turns on focused tasks, trimming is not the binding constraint for v1.
**Verdict:** Confirmed -- defer trimming to v2. V1 should inject all assembled context without a budget gate. The success criterion for v1 is "does assembly run at all and does the agent use it" rather than "does the trimmer make optimal choices."

---

## Resolution Notes

### Selected Direction: Candidate B-hybrid

**ContextAssembler service with typed AssemblyTask input + typed `assembledContext` field on WorkflowTrigger**

#### What it is

A new `src/context-assembly/` module containing:

1. **Types** (`types.ts`):
   ```typescript
   export type AssemblyTask =
     | { readonly kind: 'pr_review'; readonly prNumber: number; readonly workspacePath: string; readonly payloadBody?: string }
     | { readonly kind: 'coding_task'; readonly issueNumber?: number; readonly workspacePath: string; readonly payloadBody?: string };

   export interface SessionNote {
     readonly sessionId: string;
     readonly recapSnippet: string;
     readonly sessionTitle: string | null;
     readonly gitBranch: string | null;
     readonly lastModifiedMs: number;
   }

   export interface ContextBundle {
     readonly task: AssemblyTask;
     readonly gitDiff: Result<string, string>;                      // git diff --stat summary
     readonly priorSessionNotes: Result<readonly SessionNote[], string>;
     readonly dynamicReferenceUrls: Result<readonly string[], string>;
     readonly assembledAt: string;                                  // ISO 8601
   }

   export interface RenderOpts {
     // stub for v1; populated when coordinators need different rendering
   }
   ```

2. **Deps interface** (`deps.ts`):
   ```typescript
   export interface ContextAssemblerDeps {
     readonly execGit: (args: readonly string[], cwd: string) => Promise<Result<string, string>>;
     readonly listRecentSessions: (workspacePath: string, limit: number) => Promise<Result<readonly SessionNote[], string>>;
     readonly extractUrlsFromText: (text: string) => readonly string[];
   }
   ```

3. **Assembler factory** (`index.ts`):
   ```typescript
   export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssembler;
   export function renderContextBundle(bundle: ContextBundle, opts?: RenderOpts): string;
   ```

4. **WorkflowTrigger change** (`src/daemon/workflow-runner.ts`):
   ```typescript
   // New optional field on WorkflowTrigger
   readonly assembledContext?: import('../context-assembly/types.js').ContextBundle;
   ```

5. **buildSystemPrompt() change** (3 lines in `src/daemon/workflow-runner.ts`):
   ```typescript
   if (trigger.assembledContext) {
     const rendered = renderContextBundle(trigger.assembledContext);
     if (rendered) { lines.push('', '## Assembled Task Context', rendered); }
   }
   ```
   Position: BEFORE the referenceUrls section, AFTER the workspace context section.

6. **CoordinatorDeps change** (`src/coordinators/pr-review.ts`):
   ```typescript
   // Add to CoordinatorDeps:
   readonly contextAssembler?: ContextAssembler;  // optional in v1; undefined = no assembly

   // spawnSession gains optional 4th arg:
   readonly spawnSession: (
     workflowId: string,
     goal: string,
     workspace: string,
     assembledContext?: ContextBundle,
   ) => Promise<Result<string, string>>;
   ```

7. **Coordinator usage** (before each `spawnSession()` call in `runPrReviewCoordinator`):
   ```typescript
   const bundle = deps.contextAssembler
     ? await deps.contextAssembler.assemble({ kind: 'pr_review', prNumber: pr.number, workspacePath: opts.workspace, payloadBody: pr.description })
     : undefined;
   const spawnResult = await deps.spawnSession('mr-review-workflow-agentic', goal, opts.workspace, bundle);
   ```

#### Why this design was selected

1. **Solves the god-class problem** from the Apr 19 backlog decision: assembly logic is extracted from the coordinator into a reusable service
2. **Multi-coordinator reuse** via injectable `ContextAssembler` service
3. **Typed task routing** via `AssemblyTask` discriminated union (exhaustive switch, compile-time checked)
4. **Per-source failure isolation** via `Result<T, string>` per field
5. **Knowledge graph v2 extension** via new `AssemblyTask` kind and new `ContextAssemblerDeps` field
6. **No engine changes** -- only `workflow-runner.ts` (daemon, in scope) and `pr-review.ts` change
7. **Consistent with CoordinatorDeps DI pattern** -- injectable, testable with fakes

#### Strongest alternative (Candidate A)

Inline `assembleTaskContext` function in `CoordinatorDeps` without a service module. 50 LOC vs. 150 LOC. Sufficient if only one coordinator ever needs assembly. Preferable pivot path if second coordinator does not arrive within 6 months.

#### Confidence band: medium-high

One validation gate required before full implementation: **O1 pilot test** -- run a PR review session with only `priorSessionNotes` injected and verify the agent references it in its reasoning. If the agent ignores it, the prompt positioning needs adjustment before wiring all three sources.

#### Residual risks

1. **O1 (ORANGE)**: Agent may not attend to the assembled context section in a dense system prompt. Mitigation: position before referenceUrls; add one-line reference in step prompt; pilot test first.
2. **Second coordinator timeline unscheduled**: If no second coordinator within 6 months, migrate to Candidate A instead.
3. **LocalSessionSummaryProviderV2 re-wiring**: The session summary provider is wired to the MCP server/console path today. Making it available to `ContextAssemblerDeps` requires extracting its port interface. Scope this in wr.shaping.
4. **git diff strategy**: Use `git diff HEAD~1 --stat` (file names + change counts) for v1, NOT the full diff. Full diffs for large PRs could be 50-100KB.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-19 | Defer knowledge graph until context assembly is designed | Prevents god-class expansion of pr-review.ts; knowledge graph becomes a plugin source |
| 2026-04-19 | Pre-fetch over on-demand for v1 | Predictable sources (git diff, prior notes) are known at dispatch time; no agent turns wasted |
| 2026-04-19 | Defer context budget management to v2 | 200K context windows are not the binding constraint for focused WorkTrain sessions |
| 2026-04-19 | CLAUDE.md gap is not a real gap | loadWorkspaceContext() in workflow-runner.ts already injects CLAUDE.md/AGENTS.md into every session automatically |
| 2026-04-19 | Selected Candidate B-hybrid over Candidate A | B solves multi-coordinator reuse; god-class prevention requires extraction into a service, not just an inline function |
| 2026-04-19 | Typed assembledContext field on WorkflowTrigger over string-in-context-map | Type safety, self-documenting, directly available to buildSystemPrompt() without context variable lookup |
| 2026-04-19 | git diff strategy: --stat only for v1 | Full diff could be 50-100KB for large PRs; file names + change counts are sufficient for agent context |

---

## Final Summary

### Discovery path

`full_spectrum` -- goal was a solution statement (pre-framed as "context assembly layer"); needed both landscape grounding and reframing.

### Critical landscape finding

The problem statement listed CLAUDE.md injection as a gap. This was wrong. `loadWorkspaceContext()` in `src/daemon/workflow-runner.ts` already injects `.claude/CLAUDE.md`, `CLAUDE.md`, `AGENTS.md`, and `.github/AGENTS.md` into EVERY WorkTrain session's system prompt automatically before the first LLM turn (capped at 32KB). The same function was already solving this problem. This correction narrowed the design scope.

### Real gaps (revised)

Three gaps remain after the landscape correction:
1. Git state (diff, affected files) -- per-task, not known until dispatch time
2. Dynamic upstream docs from webhook payload -- `referenceUrls` in triggers.yml are static config-time URLs only
3. Cross-session prior notes -- `loadSessionNotes()` handles same-session resume only; a second review of the same PR starts cold

### Chosen direction: Candidate B-hybrid

**ContextAssembler service** (`src/context-assembly/`) with:
- `AssemblyTask` discriminated union input (`pr_review | coding_task`)
- `ContextBundle` with per-field `Result<T, string>` failure isolation
- `ContextAssemblerDeps` interface with all I/O injectable (follows CoordinatorDeps pattern exactly)
- Typed `assembledContext?: ContextBundle` field added to `WorkflowTrigger`
- `buildSystemPrompt()` gains 3 lines to inject the rendered bundle as `## Assembled Task Context`
- `CoordinatorDeps.contextAssembler?: ContextAssembler` injectable (optional, backward-compatible)

### Why it won

1. Solves the god-class / separation-of-concerns problem (Apr 19 backlog decision) by extracting assembly into a reusable service
2. Multi-coordinator reuse: both pr-review and a future coding coordinator call `assembleContext()` without duplicating I/O
3. Typed task routing via discriminated union -- exhaustive switch at compile time
4. Per-field failure isolation -- any source can fail without blocking dispatch
5. Knowledge graph v2 extension point -- add new `AssemblyTask` kind + `ContextAssemblerDeps` field

### Strongest alternative (Candidate A)

Inline `assembleTaskContext` function in `CoordinatorDeps` (~50 LOC vs. ~150 LOC for the module). Sufficient if only one coordinator ever needs assembly. Pivot to A if no second coordinator is planned within 6 months.

### Confidence band: medium-high

### Residual risks

1. **(ORANGE) O1: Agent visibility** -- assembled context section appended to system prompt may not get sufficient attention in a dense prompt. **Required pre-implementation validation**: run one PR review session with only `priorSessionNotes` injected; verify agent references it in first-turn reasoning.
2. Second coordinator timeline is unscheduled -- the multi-coordinator argument assumes the coding coordinator arrives within months
3. `LocalSessionSummaryProviderV2` re-wiring scope -- currently wired to MCP server path only; scope the port extraction during wr.shaping
4. git diff strategy: `--stat` only (file names + change counts) for v1 -- full diff too large for large PRs

### Next actions

1. **Pilot test (O1 mitigation)**: inject `priorSessionNotes` for one pr-review session; verify agent uses it
2. **wr.shaping**: scope the implementation using this design doc as input
3. **Implementation order**: prior session notes source first (lowest risk, highest value), then git diff, then dynamic URL extraction
4. **Do not implement** knowledge graph as a v1 source -- it requires `ts-morph` moving to dependencies (separate tracked backlog item)
