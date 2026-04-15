# Ideas Backlog

Workflow and feature ideas that are worth capturing but not yet planned or designed.

---

## Research Notes: Autonomous Platform Vision (Apr 14, 2026)

### Common-Ground relationship + cross-repo execution model

**Common-Ground stays separate -- WorkRail wraps it.**

Common-Ground and WorkRail solve different problems at different layers:
- Common-Ground: "what does this agent know about this codebase and team?" (context distribution)
- WorkRail: "what should this agent do next, and did it actually do it?" (workflow enforcement)

Merging them would make WorkRail opinionated about team structure, IDE configs, AGENTS.md formats, and org-specific conventions -- breaking WorkRail's portability. `npx -y @exaudeus/workrail` works for any engineer anywhere with zero config. That's a feature to protect.

**The right relationship:** Common-Ground distributes WorkRail as part of the team toolchain (already true via `[[workflow_repos]]` in `team.toml`). WorkRail stays generic. Common-Ground stays org-specific. They're friends, not merged.

**WorkRail bootstraps Common-Ground (tentative idea, low priority):**

> ⚠️ Tentative -- not committed. Needs more thought before pursuing.

WorkRail could be the *setup layer* for Common-Ground -- a guided `workrail init` workflow that generates a Common-Ground config, runs `make sync`, and registers workflow directories as managed sources. Would make Common-Ground configurations shareable as WorkRail workflows.

Also tentative: Common-Ground's `make sync` triggering a WorkRail daemon session to validate the distributed configuration. Interesting but not a near-term priority.

---

**Cross-repo execution model -- HIGH IMPORTANCE, post-MVP:** ⭐

WorkRail must handle any environment. Not MVP, but a must-have before WorkRail can be called a general-purpose platform.

WorkRail currently assumes a single repo. The autonomous daemon breaks this assumption -- a coding task may touch Android, iOS, and a GraphQL backend simultaneously. An investigation may span 5 services.

**Workspace manifest** -- sessions declare which repos they need:
```json
{
  "context": {
    "repos": [
      { "name": "android", "path": "~/git/zillow/zillow-android-2" },
      { "name": "ios", "path": "~/git/zillow/ZillowMap" },
      { "name": "backend", "path": "~/git/zillow/mercury-graphql" }
    ]
  }
}
```

**Scoped tools** -- `BashInRepo`, `ReadRepo`, `WriteRepo` that route to the correct working directory:
```
BashInRepo(repo: "android", command: "gradle test")
ReadRepo(repo: "ios", path: "Sources/Messaging/ZIMGallery.swift")
```

**Dynamic repo provisioning** -- the daemon resolves repos at session start:
- If the repo is already cloned locally, use it
- If declared as a remote URL, clone to `~/.workrail/repos/<name>/` (same pattern as Common-Ground's `[[workflow_repos]]`)
- Workflow authors declare repo requirements; WorkRail ensures they're available

**Why this matters:** This is what Common-Ground's `make scan` does manually today -- finds repos, injects context. WorkRail's daemon does it dynamically, driven by workflow declarations. Any environment, any combination of repos, any org -- zero manual setup.

**Cross-repo is the feature that makes WorkRail truly freestanding.** A developer anywhere can point WorkRail at their repos, declare a workspace manifest in their workflow, and get the same autonomous multi-repo execution that Mercury Mobile gets -- without Common-Ground, without Zillow infrastructure, without anything except WorkRail.

---

### Core architectural principle: WorkRail drives itself

**The daemon doesn't bypass WorkRail -- it IS WorkRail.**

The autonomous engine uses WorkRail's own MCP tools (`start_workflow`, `continue_workflow`) internally, from inside the same process. When running as MCP server, Claude Code calls these tools over the wire. When running as daemon, WorkRail calls them itself. The session engine, token protocol, step sequencer, and workflow registry are shared -- identical in both modes.

**The workflow is the interface between the two modes.** A workflow has no knowledge of whether it's being driven by a human through Claude Code or by WorkRail's autonomous daemon. Zero changes to existing workflows required -- every workflow in the library today runs in autonomous mode tomorrow.

```
WorkRail Core (shared)
├── Session engine (durable store, HMAC token protocol, step sequencer)
├── Workflow registry (bundled + user + managed sources)
└── Console (DAG visualization, live session view)

WorkRail MCP Server (existing entry point)
└── Claude Code / Cursor / Firebender call start_workflow, continue_workflow externally

WorkRail Daemon (new entry point -- same core, different driver)
├── Trigger listener (webhooks, cron, CLI, REST)
├── Agent loop (pi-mono's agentLoop calling WorkRail's own MCP tools internally)
└── Tool execution (Bash, Read, Write -- same tools Claude Code uses)
```

**Why this matters:**
- No duplicate session logic, no duplicate workflow format, no duplicate enforcement
- WorkRail can autonomously improve itself -- the daemon runs `workflow-for-workflows` to author new workflows, which then run in both modes
- Users who start with Claude Code MCP get autonomous mode for free -- same config, same workflows, second entry point
- The enforcement guarantee is identical: whether a human or the daemon is driving, the agent cannot skip steps

**The single-process model:** The daemon entry point is a new `src/daemon/` module that imports and calls the same handlers as the MCP server -- `executeStartWorkflow`, `executeContinueWorkflow` -- directly, without HTTP overhead. The session store, pinned workflow store, and all other ports are shared DI singletons. MCP server and daemon can run simultaneously in the same process.

---

### The four reference architectures: synthesis

**The vision:** WorkRail as the next evolution -- open source, freestanding autonomous agent platform with cryptographic workflow enforcement, durable sessions, full observability, and first-class Anthropic API integration.

| Source | Stars | What to take | What WorkRail already does better |
|--------|-------|-------------|----------------------------------|
| **OpenClaw** | 357k | ACP session store pattern, task flow chaining, policy system, spawn interface, freestanding daemon architecture | Durable disk sessions, cryptographic enforcement, checkpoint/resume tokens, DAG visualization |
| **Claude Code** (leaked) | - | Compaction hooks (inject WorkRail notes into session memory before compaction), session runner pattern for programmatic Claude API calls, coordinator/subagent model, `PreToolUse`/`PostToolUse` hooks for evidence collection | Everything -- WorkRail is the enforcement layer above Claude Code |
| **nexus-core** | 11 (internal) | Org profile system concept, skills-as-slash-commands UX, per-repo context injection, multi-model routing hints | Structural enforcement (nexus: advisory prompts; WorkRail: HMAC-gated tokens), cross-session durability, portability |
| **pi-mono** | 35k | `@mariozechner/pi-ai` unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.), `agentLoop`/`agentLoopContinue` pattern, `ToolExecutionMode` (sequential/parallel), `BeforeToolCallResult`/`AfterToolCallResult` hooks, `EventStream<AgentEvent>` for streaming agent events, `mom` (Slack bot) as the simplest possible channel integration reference | N/A -- pi-mono is libraries, not a workflow engine |

**pi-mono specifically:** 35k stars, MIT, TypeScript monorepo by Mario Zechner (badlogic). The most architecturally clean of the four:
- `packages/ai` -- `streamSimple`, `complete`, `stream` over a unified `Model<TApi>` abstraction covering OpenAI, Anthropic, Google, Bedrock. This is WorkRail's LLM call layer for autonomous mode.
- `packages/agent` -- `agentLoop(prompts, context, config, signal?)` returns `EventStream<AgentEvent, AgentMessage[]>`. Clean separation: the loop manages tool calls and context; the caller manages state. `ToolExecutionMode`: "sequential" vs "parallel" tool execution. `BeforeToolCallResult` (can block a tool call with a reason) + `AfterToolCallResult` (can override tool result content). These are the hooks WorkRail needs to observe and gate tool calls.
- `packages/mom` -- Slack bot that runs an agent per channel, persists MEMORY.md per workspace, loads skills from directory. The simplest reference for "daemon receives message → runs agent → responds." WorkRail's daemon follows this exact pattern.
- `packages/coding-agent` -- `SessionManager`, `AgentSession`, skill loading from directory. Session/skill abstractions WorkRail's daemon needs.

**The synthesis -- what WorkRail becomes:**

```
WorkRail Autonomous Platform
├── Workflow Engine (existing -- keep as-is)
│   ├── Durable session store (append-only event log)
│   ├── HMAC token protocol (cryptographic enforcement)
│   ├── Workflow format (JSON, loops, conditionals, routines)
│   └── Console + DAG visualization
│
├── Daemon (new -- build from pi-mono + OpenClaw patterns)
│   ├── Trigger system (GitLab/GitHub webhooks, Jira, cron, CLI)
│   │   └── Pattern: OpenClaw's block/trigger architecture
│   ├── LLM call layer (pi-mono's pi-ai unified API)
│   ├── Agent loop (pi-mono's agentLoop/agentLoopContinue)
│   ├── Session management (OpenClaw's AcpSessionStore pattern)
│   ├── Task flow chaining (OpenClaw's task-flow-registry pattern)
│   └── Tool observation (Claude Code's PreToolUse hooks → evidence gating)
│
├── Context survival (new -- from Claude Code compaction research)
│   ├── WorkRail step notes injected into session memory pre-compaction
│   ├── Session notes survive context resets as structured memory
│   └── WorkRail session store = ground truth across all compactions
│
└── Integration layer (optional extensions)
    ├── Slack bot (pi-mono's mom pattern)
    ├── OpenClaw skill (optional, not a dependency)
    └── REST API / CLI triggers
```

**Build order for MVP:**
1. `pi-ai` integration -- WorkRail daemon calls Claude API directly via pi-mono's unified API
2. `agentLoop` wrapper -- WorkRail drives agent steps using pi-mono's loop, advancing its own session
3. Single trigger: GitLab MR webhook → `coding-task-workflow` → autonomous execution
4. Evidence collection: `BeforeToolCallResult` hook intercepts tool calls, WorkRail gates continue token on required evidence
5. Console live view: active daemon sessions visible in existing console
6. Task flow chaining: completed workflow A triggers workflow B

**What this surpasses:**
- nexus-core: autonomous (not human-initiated), durable, enforced, observable
- OpenClaw: workflow-enforced (not just skill-prompted), cryptographically gated, full audit trail
- ruflo/oh-my-claudecode: not a black box -- every step is visible, pauseable, resumeable
- Devin/GitHub Copilot Workspace: open source, self-hosted, works with any LLM, enforcement-first

---

### Claude Code source reference

The leaked Claude Code source is at `https://github.com/Archie818/Claude-Code` (also mirrored at `ai-tpstudio/claude-code-haha`). Key files to study before designing WorkRail's autonomous mode:

| File | What to learn |
|------|---------------|
| `src/commands/compact/compact.ts` | How compaction works: `trySessionMemoryCompaction` first, then `compactConversation`, then `microcompactMessages`. Session memory compaction is separate from conversation compaction -- two different mechanisms. Pre-compact hooks (`executePreCompactHooks`) run before compaction, giving WorkRail an integration point to inject its session notes before context is summarized. |
| `src/services/compact/sessionMemoryCompact.ts` | Session memory as a durable store that survives compaction -- this is the pattern WorkRail should adopt: inject WorkRail step notes into session memory so they survive context resets |
| `src/assistant/sessionHistory.ts` | Paginated session event log via API (`/v1/sessions/{id}/events`). WorkRail already has this pattern in its own session store -- the key insight is that Claude Code stores events server-side and fetches them page by page, not just in the context window |
| `src/commands/agents/agents.tsx` + `src/components/CoordinatorAgentStatus.tsx` | Subagent coordination model -- coordinator agent dispatches to worker agents, each with their own tool permission context |
| `src/commands/hooks/hooks.tsx` | Hook system: `PreToolUse`, `PostToolUse`, `Stop` hooks. WorkRail can write these via `setup-hooks.sh` to observe agent actions and gate continue tokens on required evidence |
| `src/bridge/sessionRunner.ts` | How sessions are initiated and run programmatically -- key for WorkRail's autonomous daemon mode |
| `src/components/CompactSummary.tsx` | What survives compaction as visible summary -- informs what WorkRail should inject into the summary to preserve workflow state |

### OpenClaw architecture deep-dive

**Repo:** `https://github.com/openclaw/openclaw` -- 357k stars, MIT, TypeScript, sponsored by OpenAI + GitHub + NVIDIA. The real one. Created Nov 2025, actively maintained Apr 2026.

**What OpenClaw is:** A personal AI assistant daemon ("the lobster way 🦞") that runs 24/7 on your machine, listens on 20+ messaging channels (WhatsApp, Telegram, Slack, Discord, iMessage, etc.), and executes tasks autonomously. It's the architecture blueprint for WorkRail's autonomous mode.

**Key architectural concepts:**

**ACP (Agent Control Protocol)** -- OpenClaw's core protocol for managing autonomous agent sessions:
- `src/acp/session.ts` -- `AcpSessionStore` with in-memory session management (up to 5,000 sessions, 24h idle TTL, LRU eviction). Clean interface: `createSession`, `setActiveRun`, `cancelActiveRun`, `clearActiveRun`. Uses `AbortController` for cancellation. **WorkRail already has a superior version of this** -- durable disk-persisted sessions vs OpenClaw's in-memory store.
- `src/acp/policy.ts` -- `AcpDispatchPolicyState` ("enabled" | "acp_disabled" | "dispatch_disabled"), per-agent allowlist via `cfg.acp.allowedAgents`. Clean policy separation. WorkRail should adopt the same `isXxxEnabledByPolicy(cfg)` pattern for its daemon config.
- `src/acp/control-plane/` -- `manager.ts` (session lifecycle), `spawn.ts` (session creation), `session-actor-queue.ts` (serialized per-session message processing), `runtime-cache.ts` (in-flight session cache)
- `src/agents/acp-spawn.ts` -- `SpawnAcpParams` (`task`, `label`, `agentId`, `resumeSessionId`, `cwd`, `mode`, `thread`, `sandbox`, `streamTo`). This is the entry point for spawning an autonomous agent session. Key insight: `resumeSessionId` enables resuming a previous session -- WorkRail's checkpoint token is the superior version of this.

**Task system** (`src/tasks/`) -- Full task registry with SQLite persistence:
- `task-registry.store.sqlite.ts` -- SQLite-backed task store (vs WorkRail's append-only event log)
- `task-executor.ts` -- `createRunningTaskRun`, `TaskRuntime` ("acp" | "subagent"), `TaskScopeKind` ("session"), `TaskFlowRecord` for chained task flows
- `task-flow-registry.ts` -- Task flow registry for chaining workflows -- `createTaskFlowForTask`, `linkTaskToFlowById`. This is the workflow chaining primitive WorkRail needs for its autonomous mode.
- `TaskNotifyPolicy`, `TaskDeliveryStatus`, `TaskTerminalOutcome` -- clean typed state machine for task lifecycle

**Channel system** (`src/channels/`) + **Skills** (`skills/`) -- 50+ integrations as installable skills:
- Each skill is a `SKILL.md` declaring what the skill does and how the agent should use it
- Channels (WhatsApp, Telegram, Slack, etc.) are separate extensions in `extensions/`
- For WorkRail: the `skills/github/`, `skills/slack/`, `skills/taskflow/`, `skills/session-logs/` skills are directly relevant

**What WorkRail should take from OpenClaw (architectural patterns, not code):**

1. **`session-actor-queue.ts` pattern** -- serialize messages per session to prevent concurrent modification. WorkRail's gate/lock system already does this but the OpenClaw pattern is simpler for the daemon use case.

2. **`SpawnAcpParams` interface** -- the minimal interface for spawning an autonomous task. WorkRail's equivalent: `{ workflowId, goal, context, triggerSource, resumeCheckpointToken? }`.

3. **Task flow chaining** -- `createTaskFlowForTask` + `linkTaskToFlowById` is the pattern for chaining workflows. WorkRail's version: final step of Workflow A produces a `{kind: "wr.chain", workflowId, context}` artifact that the daemon picks up and starts Workflow B with.

4. **Policy system** -- `isAcpEnabledByPolicy(cfg)` pattern for feature flags and agent allowlists in daemon config. WorkRail daemon config should follow this.

5. **`TaskRuntime` enum** -- distinguishing "acp" (full autonomous session) vs "subagent" (delegated sub-task). WorkRail has the same distinction in its workflow format; the daemon should surface it the same way.

**What WorkRail does BETTER than OpenClaw:**
- Durable disk-persisted sessions (OpenClaw: in-memory, 24h TTL)
- Cryptographic step enforcement (OpenClaw: none -- tasks can be abandoned or skipped)
- Full execution trace + DAG visualization (OpenClaw: none)
- Checkpoint/resume with signed portable tokens (OpenClaw: `resumeSessionId` but no cryptographic binding)
- Workflow composition with loops, conditionals, typed context (OpenClaw: free-form task strings)

**The integration play (optional, not a dependency):** OpenClaw's channel system is the input layer; WorkRail's workflow engine is the execution layer. A WorkRail skill for OpenClaw could be: "when you receive a task that matches a WorkRail workflow, dispatch it to the WorkRail daemon and report back results." OpenClaw handles the messaging; WorkRail handles the enforcement.

**However: WorkRail should be freestanding.** The autonomous daemon must work completely independently -- no OpenClaw required. Triggers come from webhooks (GitLab, Jira, GitHub), cron schedules, CLI invocations, and the console UI. The OpenClaw integration is an optional add-on for users who want channel-based interaction (Slack, Telegram, etc.), not a prerequisite. WorkRail's value proposition is enforcement + durability + observability; those are fully available without OpenClaw. Build the daemon first as a self-contained system; consider an OpenClaw skill as a future distribution channel, not a core dependency.

**Key compaction insight for WorkRail:** Claude Code has three compaction tiers: (1) session memory compaction (preferred, uses durable server-side memory), (2) full conversation compaction (summarize everything into one message), (3) microcompaction (emergency, minimal). WorkRail's step notes should be injected into tier 1 (session memory) so they survive all three tiers. The `preCompactHooks` integration point is where WorkRail can do this injection.

### Competitive landscape: autonomous agent platforms

| Project | Stars | What it is | WorkRail's advantage |
|---------|-------|------------|---------------------|
| **ruflo** (ruvnet/ruflo) | 31.8k | "Leading agent orchestration platform for Claude" -- multi-agent swarms, RAG, distributed intelligence | No workflow enforcement -- agents can drift or skip. No session durability. WorkRail's token protocol means steps can't be skipped even in long autonomous runs |
| **oh-my-claudecode** (Yeachan-Heo) | 28.8k | Teams-first multi-agent orchestration for Claude Code | Orchestration without enforcement. No auditability. WorkRail has a full session history and DAG visualization |
| **AionUi / OpenClaw** (iOfficeAI) | 21.8k | 24/7 cowork app supporting multiple CLI agents (Claude Code, Gemini CLI, Codex, etc.) | Interface/UI layer -- not a workflow engine. No step enforcement or session state |
| **OpenClaw core** (clawdkit) | ~1 | Language-agnostic autonomous agent runtime | Very early / minimal. No workflow composition, no enforcement, no console |
| **nexus-core** (Peter Yao, internal) | 11 (internal) | Full-lifecycle AI dev workflow for Zillow engineers | No autonomous mode (human-initiated only). No session durability. No cryptographic enforcement |

**The gap WorkRail fills:** Every existing autonomous agent platform is a black box -- you can't see what the agent did, you can't enforce that it followed a process, and you can't resume a session that was interrupted. WorkRail's autonomous mode would be the first open-source platform that combines:
1. Autonomous execution (daemon, triggers, API calls)
2. Cryptographic step enforcement (cannot skip)
3. Full session observability (DAG, execution trace)
4. Durable cross-session state (survives restarts, compaction)
5. Human-in-the-loop control plane (console approvals, pause/resume)

### Workflow chaining + compaction design sketch

When WorkRail chains workflows autonomously:
1. Workflow A completes -- final step output becomes context for Workflow B
2. Before starting Workflow B, WorkRail injects relevant step notes from Workflow A's session into Claude's session memory (via pre-compact hook or explicit system prompt injection)
3. If context compacts during Workflow B, the session memory contains WorkRail's structured notes -- nothing important is lost
4. WorkRail's own session store has the complete history regardless of what happens to Claude's context window -- it's the ground truth

This means WorkRail's session store is not just a log -- it's the **memory that survives compaction**. Every piece of information in a step note is recoverable even if Claude's context window is completely reset.

### Subagent design sketch

WorkRail autonomous sessions can spawn subagents for parallel work:
- Coordinator session holds the main workflow state and continue token
- Subagent sessions each run a delegated routine (already supported in WorkRail's workflow format via `mcp__nested-subagent__Task`)
- In autonomous mode, subagents are separate Claude API calls managed by WorkRail's daemon
- Each subagent reports back to the coordinator via WorkRail's session store, not via in-context communication
- This is more robust than nexus-core's Opus/Sonnet/Haiku orchestration pattern which depends on context not degrading across the delegation boundary

---

## Workflow ideas

### Standup Status Generator

- **Status**: idea
- **Summary**: A workflow that automatically generates a daily standup status by aggregating activity across the user's tools since the last standup.
- **Data sources** (adaptive based on what the user has available):
  - Git history (commits, branches, PRs/MRs)
  - GitLab (merge requests, comments, reviews)
  - Jira (ticket transitions, comments, new assignments)
  - Other issue trackers or project management tools the user configures
- **Key behavior**:
  - Detect the last standup date (stored in session or inferred from history)
  - Aggregate activity since that date across all configured sources
  - Categorize into "what I did", "what I'm doing today", and "blockers"
  - Generate a concise, human-readable standup message
- **Design considerations**:
  - Should be tool-agnostic: detect available integrations and adapt
  - Could leverage MCP tool discovery to find available data sources at runtime
  - Needs a lightweight persistence mechanism for last-standup timestamp
  - Output format should be configurable (Slack message, plain text, structured JSON)

## Feature ideas

### Autonomous background agent platform ⭐ HIGH PRIORITY

- **Status**: idea -- high priority, not yet designed
- **Summary**: Transform WorkRail from an MCP server that responds to agent calls into a persistent background daemon that initiates workflows autonomously, integrates with external systems (Jira, GitLab, Slack), and uses the console as a control plane rather than a passive visualization tool.
- **The shift**: today WorkRail waits for an agent to call it. In this model, WorkRail *initiates* -- it listens for triggers, calls the Claude API directly, manages conversations, advances its own sessions, and surfaces results through the console. Humans interact via the console or via external system integrations, not necessarily via an AI coding session.
- **Core capabilities**:
  - **Triggers** -- Jira webhook when a ticket moves to "In Progress," GitLab webhook when an MR is opened, cron schedule, Slack message, manual console dispatch. WorkRail selects the right workflow and starts a session automatically.
  - **Autonomous execution** -- WorkRail spawns a Claude API session (not Claude Code -- direct Anthropic API), passes the workflow step by step, collects tool call results, advances without a human in the loop unless a step requires approval.
  - **Integration layer** -- first-class tools for Jira (read ticket, post comment, transition status), GitLab (read MR, post review comment, approve/request changes), Slack (send message, read channel), PagerDuty (acknowledge alert). These are just tools workflows can call.
  - **Console as mission control** -- live running sessions visible in the console, not just history. Pause a session, inject context, approve a step, redirect. Think Temporal's UI but for AI workflows.
  - **Evidence collection** -- hooks into Claude Code's `PreToolUse`/`PostToolUse` events to observe what the agent actually did, not just what it reported. Required evidence declared in workflow steps; token gated on observed evidence, not agent claims.
- **Why WorkRail's existing architecture already points here**:
  - Durable session store is append-only -- exactly right for long-running background jobs
  - Token protocol handles resumption -- a background job that gets interrupted can resume via checkpoint token
  - DAG console already visualizes session state -- one step from making it live
  - Workflow composition (templateCall, routines, loops) already supports complex orchestration
- **Concrete first use cases** (Zillow/Mercury Mobile):
  - Auto-review every incoming MR using `mr-review-workflow` -- post findings as GitLab comment
  - Auto-triage new Jira tickets assigned to Mercury Mobile -- classify, estimate, link to related work
  - Daily async standup summary -- aggregate team activity, post to Slack channel
  - Auto-run `goals-update-workflow` before every 1:1 based on calendar trigger
- **What's genuinely hard**:
  - MCP transport assumption breaks -- WorkRail needs to *initiate* Claude API calls, not wait for them
  - Credential management -- background process needs Claude API key, Jira token, GitLab token; secrets model needs design
  - Concurrency and resource limits -- multiple simultaneous autonomous sessions need guardrails
  - Human-in-the-loop design -- some steps should pause and wait for human approval before proceeding
- **Why this surpasses nexus-core**:
  - nexus-core is fundamentally human-initiated -- you run `/flow`, it works because you're there. It cannot run autonomously while you sleep. It's a plugin, not a daemon.
  - WorkRail's durable session model is already designed for this. nexus-core would need a full architectural rewrite.
- **Why this is differentiated in the broader market**:
  - Devin, GitHub Copilot Workspace, etc. are autonomous coding agents but are black boxes -- no enforcement, no auditability, no human control plane
  - WorkRail's autonomous mode retains cryptographic step enforcement and full session observability -- you can see exactly what it did and why, pause it, resume it, roll back to a checkpoint
- **Design questions**:
  - Should the daemon run as a separate process from the MCP server, or share the same process with different entry points?
  - How does the console authenticate to the daemon for live session control?
  - What is the minimal trigger/integration surface for v1 -- just GitLab MR webhooks + Jira ticket webhooks?
  - How do we handle workflows that require human approval mid-step in an otherwise autonomous session?
  - Should WorkRail ship integration adapters, or define an integration contract that external adapters implement?
- **Related**:
  - `docs/design/console-ui-backlog.md` -- console evolution
  - `docs/roadmap/open-work-inventory.md` -- platform vision
  - Discovery notes: `~/git/zillow/etienne-2026-goals/goals/2026/discovery-notes-apr-2026.md`

---

### Forever backward compatibility via engine version declaration

- **Status**: high importance, not yet properly thought through -- the solution sketched here is tentative and needs real design work before implementation
- **Summary**: Every workflow declares the WorkRail engine version it was written against (`workrailVersion: "1.4.0"`). The engine maintains compatibility adapters for all previous declared versions -- old workflows run forever without author intervention. The engine adapts; authors never migrate. **This is one rough idea; the right solution may look completely different after proper design.**
- **Design direction**:
  - Add `workrailVersion` as a top-level required field in `workflow.schema.json`. Validated at load time; workflows without it default to `"1.0.0"` (the oldest supported version).
  - The engine has a `WorkflowVersionAdapter` layer that normalizes old workflow shapes into the current internal representation before execution. Branching paths in the compiler/executor handle version-specific semantics.
  - New fields are always additive and optional with sensible defaults -- never remove a field, only deprecate with a redirect.
  - When a workflow is loaded, the engine resolves its declared version and selects the appropriate normalization path. `workrailVersion` is recorded in `run_started` events for diagnostic traceability.
  - The validation pipeline (`npm run validate:registry`) runs all bundled workflows through all adapters in CI to catch regressions before release.
- **The web model**: this is how browsers handle HTML from 1995. A `<marquee>` tag still renders because the browser adapts, not because the author rewrote their page. WorkRail should make the same guarantee to workflow authors.
- **Engineering implication**: this is a permanent commitment. Once a version adapter is shipped, it cannot be removed. The tradeoff is real but the alternative (expecting external authors to track WorkRail releases and migrate) breaks the platform trust model.
- **What this does NOT mean**:
  - Authors still benefit from upgrading -- newer versions get access to new primitives (assessment gates, loop control, references, etc.)
  - The engine only adapts the schema and execution semantics, not the runtime environment (MCP tools, context variables, file system)
  - "Forever" means "as long as WorkRail is maintained" -- version adapters would only be removed with a major breaking release and explicit migration announcement
- **Implementation sketch**:
  - Phase 1: Add `workrailVersion` field to schema. Default to `"1.0.0"` for existing workflows. Record in run events.
  - Phase 2: Introduce the first adapter when the first schema-breaking change is needed. The adapter normalizes the old shape to the current internal representation.
  - Phase 3: Build a compatibility test harness that runs representative old-version workflows against the current engine in CI.
- **Related**:
  - `docs/design/v2-core-design-locks.md` -- existing invariants (must not conflict)
  - `docs/reference/workflow-execution-contract.md` -- execution contract
  - `src/v2/read-only/v1-to-v2-shim.ts` -- existing precedent for version adaptation

---

### Remote references (URLs, GDocs, Confluence, etc.)

- **Status**: idea
- **Summary**: Extend the workflow `references` system to support remote sources (HTTP URLs, Google Docs, Confluence pages, etc.) in addition to local file paths. WorkRail remains a pointer system — it resolves and delivers reference metadata, and the agent does the actual fetching using whatever tools it has available. Auth is entirely delegated to the agent.
- **Core design principle**: same model as today, extended to remote sources. WorkRail validates that a reference declaration is well-formed, delivers the pointer to the agent at workflow start, and the agent fetches the content with its own HTTP or integration tools. If the agent lacks access, it surfaces that to the user — which is the right failure mode. WorkRail does not need to store credentials or act as a fetch proxy.
- **Why this matters**: teams keep their authoritative docs (architecture decisions, coding standards, runbooks, API contracts) in external systems. Remote refs let workflows point at those docs directly without requiring anyone to maintain a local copy.
- **Incremental path**:
  - Phase 1: public HTTP URLs. `resolveFrom: "url"`. WorkRail delivers the URL as a reference pointer. Agent fetches using HTTP tools. No auth surface in WorkRail.
  - Phase 2: workspace-configured bearer tokens in `.workrail/config.json` keyed by domain. Covers most internal tools (Confluence API tokens, private wikis, etc.) without native integrations.
  - Phase 3: named integrations (GDocs, Confluence, Notion) as first-class configured sources — the full platform play, only if Phase 1/2 prove insufficient.
- **Reachability validation**: soft check or skippable at start time. A URL being reachable during validation doesn't guarantee the agent can authenticate at runtime, and a failed ping shouldn't block the workflow from starting.
- **Design questions**:
  - Should WorkRail attempt a reachability check at start time, or skip entirely for remote refs?
  - How should remote refs appear in `workflowHash`? The declaration is stable but content is not — may need content-hashing at fetch time or explicit versioned URLs for determinism.
  - Should the `references` schema add a `kind` field (`local` vs `remote`) or infer from the `source` value?
- **Risks / tradeoffs**:
  - Agent-side fetching means the workflow only works if the agent has appropriate tools — acceptable tradeoff, explicitly the user's responsibility
  - Remote content can change between runs, weakening the determinism guarantee that local refs provide

### Declarative workflow composition engine

- **Status**: idea
- **Summary**: Instead of authoring full workflow JSON for every use case, users or agents fill out a declarative spec (dimensions, scope, rigor level, etc.) and the WorkRail engine assembles a workflow automatically from a library of pre-validated routines and step templates. The agent is a form-filler, not an architect - the composition logic lives in the engine.
- **Why this is different from agent-generated workflows**:
  - Agent-generated workflows have no quality gate - you're trusting the agent's judgment on structure, which is exactly what workflow-for-workflows exists to prevent
  - Engine-composed workflows are assembled from pre-reviewed building blocks using deterministic rules - same spec always produces the same workflow shape
  - Trustworthy because composition logic is owned by WorkRail, not improvised at runtime
- **How it would work**:
  - A composable routine library with well-defined inputs, outputs, and composition contracts
  - A spec format that captures user intent declaratively (e.g. workflow type, dimensions to cover, scope, rigor mode)
  - A composition engine that selects and wires the right routines based on the spec
  - The assembled workflow is fully inspectable before execution - no black box
- **Relationship to current authoring**:
  - Full workflow JSON authoring remains the escape hatch for workflows that need custom shapes the composition engine can't express
  - Composition covers the common cases; manual authoring covers the edge cases
  - Routines built for composition also remain usable as standalone delegatable units in manually authored workflows
- **Good early use cases**:
  - Audit-style workflows (scalability audit, readiness audit, tech debt audit) - user picks dimensions, engine assembles the right auditor steps
  - Review workflows - user picks scope and rigor, engine assembles reviewer family + synthesis
  - Investigation workflows - user picks investigation type, engine assembles the right hypothesis + evidence + validation path
- **Design questions**:
  - What is the right spec format? Enums + variables + a workflow type identifier? A richer DSL?
  - How does the engine handle dependencies between composed steps (context flow, artifact ownership)?
  - Should composition happen at session-start time (assembled once, then executed) or be fully static (compiled to workflow JSON)?
  - How does the console/dashboard show a composed workflow's structure vs a manually authored one?
  - What is the governance model for the composable routine library - who can add to it, and what quality bar do new routines need to meet?
- **Risks / tradeoffs**:
  - A composition engine is a significant investment - the routine library needs enough coverage before composition is useful
  - Composition rules can become their own form of complexity if not kept simple
  - Need a clear story for when manual authoring is the right choice vs composition, so authors don't fight the system

### Dashboard artifacts (replace file-based docs)

- **Status**: designed, not yet implemented
- **Summary**: Instead of having agents write markdown files into the working repo, agents would submit structured artifacts through `continue_workflow` output payloads. Artifacts are stored per-session and rendered in the console/dashboard. Eliminates repo pollution and gives users a single place to see all workflow outputs.
- **Key dependencies**: console/dashboard UI (does not exist yet), server-side artifact storage
- **Design doc**: `docs/reference/workflow-execution-contract.md` (section "Replacing File-Based Docs with Dashboard Artifacts")

### Derived / overlay workflows for bundled workflow specialization

- **Status**: parked idea
- **Note**: see `docs/roadmap/open-work-inventory.md` for details

### Workflow categories and category-first discovery

- **Status**: idea
- **Summary**: Improve workflow discovery by organizing bundled workflows into categories and teaching `list_workflows` to support a category-first exploration path instead of always returning one large flat list.
- **Why this seems useful**:
  - the workflow catalog is getting large enough that flat discovery is becoming noisy
  - agents often do not know the exact workflow ID they want, but they may know the task family (coding, review, docs, investigation, planning, learning)
  - category-first discovery could reduce prompt overload and make workflow selection feel more guided
- **Possible phase 1 shape**:
  - add workflow categories as metadata on workflow definitions or a registry-side mapping
  - extend `list_workflows` with an optional category-style input
  - if no category is passed, return:
    - category names
    - workflow count per category
    - a few representative workflow titles per category
    - guidance telling the agent to call `list_workflows` again with the category it wants
  - if a category is passed, return the full workflows for that category with names, descriptions, IDs, and hashes
- **Possible phase 2 shape**:
  - support multiple discovery views such as grouped-by-category, grouped-by-source, or full flat list
  - add filtering by category + source + maybe keywords
  - align category discovery with future platform / multi-root discovery work
- **Design questions**:
  - should categories live in workflow JSON, in a registry overlay, or be inferred from directory / naming conventions?
  - should `list_workflows` become polymorphic, or should category discovery be a separate read-only tool / mode?
  - how much summary content should the uncategorized response include before it becomes too verbose again?
  - how do categories interact with routines, examples, project workflows, and external workflow repositories?
- **Risks / tradeoffs**:
  - changing `list_workflows` is a real tool contract and output-schema change, not just a UI tweak
  - overloading one tool with too many discovery modes could make the contract less predictable
  - static categories can drift unless there is a clear ownership model
- **Related docs / context**:
  - `docs/plans/workrail-platform-vision.md` (already discusses grouped discovery by source)
  - `docs/roadmap/open-work-inventory.md` (legacy workflow modernization increases the need for better discovery)
  - current implementation: `src/mcp/handlers/v2-workflow.ts`, `src/mcp/v2/tools.ts`, `src/mcp/output-schemas.ts`

### Multi-root workflow discovery and setup UX

- **Status**: designing
- **Summary**: Simplify third-party and team workflow hookup by requiring explicit `workspacePath`, silently remembering repo roots in user-level `~/.workrail/config.json`, recursively discovering team/module `.workrail/workflows/` folders under remembered roots, and improving grouped source visibility / precedence explanations. Use workspace-aware ranking, cross-repo surfacing, and later console integration as the control plane for inspecting remembered roots, discovered workflow sources, and precedence. For remote repositories, prefer **managed sync by default** so users experience remote workflow repos as connected and kept current while WorkRail still reasons over a local effective state. Avoid trusting MCP roots and avoid requiring workflow config to live at the main repo root.
- **Current recommendation**:
  - phase 1: `Rooted Team Sharing + minimal Source Control Tower`
  - require explicit workspace identity
  - silently persist repo roots at the user level
  - support cross-repo workflows from remembered roots
  - make remote repos default to managed-sync mode rather than pinned snapshots or live-remote behavior
  - treat Slack/chat/file/zip sharing as an ingestion path that classifies into repo, file, pack, or snippet flows
  - design the backend so the console can eventually manage and explain the remembered/discovered source model
- **Additional idea**:
  - explore enterprise auth / SSO integration for private repo access, such as Okta-backed flows for GitHub Enterprise, GitLab, or other self-hosted providers
  - likely shape: WorkRail detects that a private repo uses org-managed auth and guides the user through the right browser/device-code/credential flow instead of assuming raw personal-access-token setup
  - main question: should WorkRail integrate directly with identity providers like Okta, or should it integrate one layer lower with Git hosts / credential helpers that are already SSO-aware?
- **Design doc**: `docs/ideas/third-party-workflow-setup-design-thinking.md`

### Workflow rewind / re-scope support

- **Status**: idea
- **Summary**: Allow an in-progress workflow session to go back to an earlier point when new information changes scope understanding, invalidates assumptions, or reveals that the current execution path is wrong.
- **Why this seems useful**:
  - agents and users often learn important scope information only after work has already started
  - current step-by-step enforcement is strong, but it can feel rigid if the original framing turns out to be wrong
  - a first-class rewind / re-scope mechanism could make workflows feel safer and more adaptable without abandoning structure
- **Possible phase 1 shape**:
  - allow rewind to a prior checkpoint or earlier decision node with an explicit reason
  - record a short “why we rewound” note in session history
  - make the resumed path visible in the console/session timeline
- **Possible phase 2 shape**:
  - support scope-change prompts like:
    - “our understanding changed”
    - “the task is broader/narrower than we thought”
    - “we need to revisit planning before implementation”
  - let workflows declare safe rewind points or re-scope checkpoints explicitly
  - support branch-aware comparison between abandoned and current paths
- **Design questions**:
  - should rewind be limited to explicit checkpoints, or should WorkRail support arbitrary node-level rewind?
  - how should the system preserve durable notes and outputs from abandoned paths?
  - should some workflow steps be marked as non-rewindable once external side effects have happened?
  - how should the agent explain to the user what changed and why a rewind is appropriate?
- **Risks / tradeoffs**:
  - rewind power could make workflows feel less deterministic if used too casually
  - durable session history gets more complex when abandoned paths and resumed paths coexist
  - workflows with real-world side effects may need stricter rollback / compensation rules

### Assessment-gate follow-up tiers beyond v1

- **Status**: idea
- **Summary**: Capture the likely progression of assessment-triggered redo / follow-up behavior so the engine can grow beyond the narrow v1 same-step follow-up model without losing the conceptual roadmap.
- **Why this seems useful**:
  - assessment-triggered follow-up is likely to want richer behavior over time
  - the v1 consequence model is intentionally narrow, but the design pressure already points toward stronger redo semantics
  - writing the tiers down now reduces the chance that future work jumps straight to a subflow design without acknowledging the intermediate options
- **Tier 1: same-step follow-up retry**
  - consequence keeps the same step pending
  - engine returns semantic follow-up guidance
  - agent retries the same step after improving its work / evidence
  - this is the current intended v1 behavior
- **Tier 2: structured redo recipe on the same step**
  - same step still remains the logical unit of work
  - engine can surface a bounded checklist or structured follow-up actions
  - no new DAG nodes or true subflow yet
  - likely useful if “retry” is too vague but full subflow control flow would be too heavy
- **Tier 3: assessment-triggered redo subflow**
  - matched assessment consequence routes into an explicit sequence of follow-up steps
  - subflow has its own durable progress and then returns to the original step or onward path
  - this is a significantly larger feature because it introduces assessment-driven control-flow behavior rather than just a blocked follow-up requirement
- **Design questions**:
  - when does Tier 2 become necessary instead of plain semantic retry guidance?
  - what durable model would Tier 3 need for entering, progressing through, and returning from a redo subflow?
  - how should the engine distinguish “redo the same step better” from “enter a dedicated recovery path”?
  - can Tier 3 reuse existing workflow / routine primitives, or would it need dedicated assessment-triggered topology support?
- **Risks / tradeoffs**:
  - jumping straight from Tier 1 to Tier 3 could create a hidden mini control-flow DSL
  - Tier 2 may be enough for many real cases and should not be skipped without evidence
  - Tier 3 likely changes authoring, durability, replay, and console explainability at the same time

### Console engine-trace visibility and phase UX

- **Status**: idea
- **Summary**: Evolve the console from a node-only DAG viewer into an execution-aware surface that shows both created nodes and the engine decisions that explain how the run got there. This should make fast paths, skipped phases, condition evaluation, loop entry/exit, and branch selection legible instead of looking like missing DAG nodes or broken rendering.
- **Why this seems useful**:
  - users currently see only `node_created` / `edge_created`, which makes legitimate engine behavior look like missing workflow phases
  - workflows use authoring concepts like phases, fast paths, run conditions, and loop gates, but the console does not show those decisions today
  - sessions like small-task fast paths can appear to “jump” from phase 0 to phase 5 even when the engine is behaving correctly
- **Current gap**:
  - engine event log records `decision_trace_appended`, `context_set`, and related runtime decisions
  - console DTOs expose only run status plus DAG nodes/edges and node detail
  - there is no first-class UI for “why the engine chose this path”
- **Recommended direction**:
  - keep phases as authoring / workflow-organization concepts
  - stop treating the rendered DAG as the whole execution story
  - add an engine-trace / decision layer that can show:
    - selected next step
    - evaluated conditions
    - entered/exited loops
    - important run context variables such as `taskComplexity`
    - skipped / bypassed planning paths such as small-task fast paths
- **Possible phase 1 shape**:
  - extend console service / DTOs with a run-scoped execution-trace summary
  - show a compact “engine decisions” strip or timeline above the DAG
  - annotate jumps such as “small-task fast path selected” so sparse DAGs do not look broken
- **Possible phase 2 shape**:
  - richer explainability timeline with branches, skipped authoring phases, and condition results
  - allow toggling between “execution DAG” and “engine trace” views, or combine them in one unified run narrative
  - surface effective run context and selected branch/loop decisions in node detail or run detail
- **Design questions**:
  - should the console continue using phase-oriented labels in the primary UI, or should it prefer step titles / execution narrative labels?
  - should trace events appear as first-class timeline items, DAG annotations, or a separate run-explanation panel?
  - what subset of run context variables is useful enough to surface without becoming noisy?
  - how do we distinguish authoring structure from runtime execution structure cleanly in the UX?
- **Risks / tradeoffs**:
  - exposing too much raw engine state could make the console noisier and harder to scan
  - mixing authoring structure and runtime trace without clear separation could create more confusion, not less
  - DTO growth needs care so the console does not become tightly coupled to every low-level event detail
- **Related docs / context**:
  - `docs/reference/workflow-execution-contract.md`
  - `docs/design/v2-core-design-locks.md`
  - `docs/plans/workrail-platform-vision.md`
  - current implementation: `src/v2/usecases/console-service.ts`, `src/v2/projections/run-context.ts`, `console/src/api/types.ts`

### Workflow previewer for compiled and runtime behavior

- **Status**: idea
- **Summary**: Add a workflow previewer for the `workflows/` directory that shows what a workflow actually compiles to and how the engine can traverse it at runtime.
- **Why this seems useful**:
  - authors currently have to mentally reconstruct branching, loops, blocked-node behavior, and other runtime structure from authored JSON plus tests
  - advanced workflow authoring gets much easier when the compiled DAG and runtime edges are visible
  - it would help explain engine behavior to both contributors and workflow authors
- **What it should show**:
  - the compiled step graph / DAG
  - branch points and condition-driven paths
  - loop structure and loop-control edges
  - blocked / resumed / checkpoint-related node shapes where applicable
  - template/routine expansion boundaries or provenance
  - the gap between authored JSON structure and runtime execution structure
- **Initial scope**:
  - start as a read-only preview for bundled workflows
  - optimize for accuracy over polish
  - do not require full execution simulation in phase 1
- **Design questions**:
  - should this live in the existing Console, as a dev-only page, or as a local authoring utility?
  - should it show only the compiled DAG, or also annotate likely runtime transitions such as blocked attempts, rewinds, and loop continuations?
  - how much provenance should it expose for injected routines/templates?

### Native assessment / decision gates for workflows

- **Status**: idea
- **Summary**: Add a first-class workflow primitive for structured assessments that can drive routing. The agent would assess a small set of named dimensions, give short rationales, and let the engine use explicit aggregation / gate rules to influence continuation, follow-up, branching, or final confidence.
- **Why this seems useful**:
  - some workflow decisions are clearer and more auditable as small assessment matrices than as long prompt prose
  - confidence computation is a strong example: workflows may want to derive final confidence from dimensions like boundary, intent, evidence, coverage, and disagreement
  - explicit assessment gates would let the engine drive loops/branches without relying entirely on prose interpretation
- **Near-term shape**:
  - keep the reasoning with the agent, but let the workflow declare named assessment dimensions and allowed levels such as `High | Medium | Low`
  - let the agent provide one short rationale per dimension
  - let the engine compute caps / next actions / routing outcomes from explicit gate rules
- **Ownership split**:
  - the **agent** assesses each dimension and gives the short rationale
  - the **engine** applies declared gate rules such as caps, routing outcomes, or follow-up triggers
- **Longer-term shape**:
  - add a first-class authoring primitive such as `assessmentGate`, `assessmentRef`, or similar
  - optionally allow reusable built-in or repo-owned assessment schemas/matrices
  - optionally validate assessment shape against WorkRail-owned schemas
- **Good early use cases**:
  - MR review confidence assessment
  - planning readiness / confidence gates
  - debugging confidence and next-step routing
  - block-vs-continue / revisit-earlier-step decisions
- **Design questions**:
  - should this be a narrow `assessmentGate` primitive or a more generic structured decision-table feature?
  - should reusable matrices be inline first, or backed by repo-owned refs from the start?
  - how much aggregation logic should the engine support directly versus leaving to workflow-defined rules?
  - how should assessment provenance and rationales appear in compiled/runtime traces?

### Engine-injected note scaffolding

- **Status**: related follow-on idea
- **Summary**: Add an opt-in execution-contract or note-structure feature that helps agents produce compact notes useful to both humans and future resume agents.
- **Why it may matter**:
  - some workflows want notes to consistently capture current understanding, key findings, decisions, uncertainties, and next-step implications
  - this is related to assessment-driven routing, but it is a different product concern
- **Open question**:
  - should note scaffolding live as a separate execution-contract feature, or share any underlying primitives with assessment gates?

---

### Daemon architecture decision -- findings and direction (Apr 14, 2026)

**Status:** Research complete, direction chosen, not yet implemented.

**The question:** Should the autonomous daemon be (A) same-process calling the engine directly, (B) a separate process connecting to WorkRail's MCP server as an HTTP client, or (C) a composite same-process model with direct engine calls + REST control plane?

**What the research found:**

Two discovery agents independently reached opposite conclusions:

- Agent 1 (correctness focus): **Option B** -- separate process. Two hard bugs in same-process: (1) `LocalSessionLockV2.clearIfStaleLock()` uses `process.kill(pid, 0)` -- same PID for daemon + MCP server means a crashed daemon permanently locks sessions with no recovery; (2) `engineActive` guard in `engine-factory.ts` explicitly blocks a second engine instance per process.

- Agent 2 (vision focus): **Option C** composite -- same process, direct engine calls, REST control plane. `V2Dependencies` is already concurrent-safe (stateless, per-session locking). `engineActive` guard is about DI initialization, not concurrent handler safety. Self-referential workflows (coordinator spawning sub-workflows) work immediately via existing delegation.

**Settling the disagreement -- the lock code:**

Read `src/v2/infra/local/session-lock/index.ts` directly. Line 45 confirms Agent 1's bug is real: `process.kill(pid, 0)` -- if daemon + MCP server share a PID and the daemon crashes mid-step, the lock file's PID check returns "process alive" forever. The session is permanently locked until the process restarts. No recovery path. Hard bug.

**Direction: Option C (in-process composite) -- but fix the lock first.**

Option C is the right 12-month architecture:
- No transport overhead (MCP HTTP adds ~1ms+ per step, meaningless in human sessions, significant in tight autonomous loops)
- Shared session store, DI, keyring -- no sync issues
- Self-referential workflows work immediately -- coordinator spawns sub-workflows via existing delegation
- REST control plane on existing Express server -- 4 routes, no new process
- MCP + daemon in same binary, same deployment, same config

**The prerequisite: fix `LocalSessionLockV2`**

Replace PID-only staleness with PID + workerId:
```json
{ "pid": 1234, "workerId": "mcp-server", "sessionId": "sess_abc" }
```

Staleness logic:
- Same PID + same workerId → I own this, proceed
- Same PID + different workerId → not stale, return SESSION_LOCK_BUSY
- Different PID, process alive → SESSION_LOCK_BUSY
- Different PID, process dead → stale, clear it

`workerId` injected at construction: `new LocalSessionLockV2(dataDir, fs, clock, workerId)`. MCP server passes `"mcp-server"`, daemon passes `"daemon"`. ~50-60 lines across `session-lock/index.ts` + `session-lock.port.ts`. Zero behavior change for existing single-process case.

Also add `isHeldByMe(sessionId)` to the lock port for clean "pause after current step" support.

**Other architecture decisions from the 5 MVP discovery agents:**

- **Context survival**: 3-line deletion in `prompt-renderer.ts` -- remove the `rehydrateOnly` guard that blocks ancestry injection on non-rehydrate paths. Already works, just gated off.
- **Evidence gate**: `requiredEvidence` field + `record_evidence` MCP tool + gate check in `detectBlockingReasonsV1`. MVP = assertion gate; push-hook upgrade = zero schema changes later.
- **Trigger system**: Standalone `src/trigger/` process (~600 LOC). GitLab MR webhook → `start_workflow` → loop `continue_workflow` → post MR comment.
- **Console live view**: `is_autonomous: true` context_set event + ephemeral `DaemonRegistry` for heartbeat + `[ LIVE ]` badge. Session lock held during steps prevents timer-based heartbeats -- hybrid model required.
- **Token persistence**: Daemon must write `continueToken` + `checkpointToken` to `~/.workrail/daemon-state.json` (atomic write) before each step. Crash without this = unrecoverable sessions.

**Build order (tentative):**

1. Fix `LocalSessionLockV2` with workerId (prerequisite for in-process model)
2. Context survival fix (3-line deletion -- ship immediately, it's almost free)
3. Daemon runtime: `src/daemon/` with `runWorkflow()` calling engine directly
4. Evidence gate: `requiredEvidence` + `record_evidence` tool
5. Trigger system: `src/trigger/` webhook server
6. Console live view: `DaemonRegistry` + `[ LIVE ]` badge

**Reference for loop implementation:** pi-mono `agentLoop` vs OpenClaw `session-actor-queue` -- comparison agent running, results pending.

---

### Agent loop decision: pi-mono wins (Apr 14, 2026)

**Use `@mariozechner/pi-agent-core` (pi-mono) as the daemon loop foundation.** Pinned at 0.67.2, MIT, 246kB, 1 dependency, published on npm.

**Key finding:** OpenClaw's runner wraps pi-mono's `Agent` class internally (`src/agents/pi-embedded-runner/run/attempt.ts` imports `@mariozechner/pi-agent-core` directly). OpenClaw adds auth rotation, provider failover, and preemptive compaction -- none needed at MVP. Comparison was always pi-mono vs "pi-mono + 80 internal modules." Easy call.

**What to take from pi-mono:**
- `Agent` class -- the multi-turn LLM + tool call loop
- `AgentTool<TParameters>` with TypeBox schemas -- define `start_workflow`, `continue_workflow`, `Bash`, `Read`, `Write`
- `getFollowUpMessages` -- termination hook: return `[]` when `isComplete=true` from `continue_workflow`
- `agent.abort()` -- cancellation threaded through every async boundary
- `agent.subscribe()` -- observability without modifying the loop

**What to reimplement from OpenClaw (not import):**
- `KeyedAsyncQueue` pattern (~30 lines) -- serializes concurrent runs against same session ID
- Retry wrapper with backoff on `stopReason === 'error'`

**Non-obvious implementation detail:** pi-mono terminates structurally (no tool calls + no follow-ups), not semantically. Bridge `isComplete` from `continue_workflow` into `getFollowUpMessages` returning `[]`. Use `createDaemonLoopConfig()` factory per run -- no shared state across concurrent sessions.

**Typed discriminant for continue_workflow result:**
```typescript
type WorkflowContinueResult =
  | { _tag: 'advance'; step: PendingStep; continueToken: string }
  | { _tag: 'complete'; finalNotes: string }
  | { _tag: 'error'; message: string };
```

**Pre-production (not MVP blocking):** Add `agent.abort()` after wall-clock limit + max-turn counter via `getSteeringMessages`. No built-in timeout in pi-mono's loop.

---

### Mobile monitoring + control (post-MVP) ⭐

**Goal:** Control and monitor autonomous WorkRail sessions from a phone.

**What's needed:**

1. **Mobile-responsive console** -- existing React console needs touch-friendly layout, readable on small screens, tap to pause/resume/cancel sessions. The DAG is probably too complex for mobile; a linear step-by-step log view is better for quick checks.

2. **Push notifications** -- phone notified when a session completes, fails, or hits a human-approval gate. Simplest path: Slack/Telegram notification via configured channel (OpenClaw's channel system is the reference). No native app required for MVP of this feature.

3. **Human-in-the-loop approval on mobile** -- workflow steps that require sign-off before proceeding ("about to merge this MR, confirm?") send a push notification with Approve/Reject. Maps to REST control plane: `POST /api/v2/sessions/:id/resume` from a mobile tap.

4. **Session log view** -- scroll through what the daemon did while you were away. Linear timeline, not DAG.

**Simplest implementation path:** Make console responsive + add Slack/Telegram notification on session completion/failure/approval-needed. OpenClaw's 20+ channel integrations are the reference -- WorkRail doesn't need to build a native app, just configure an output channel.

**Priority:** Post-MVP, but design the REST control plane with mobile in mind from the start (clean JSON responses, no server-side rendering assumptions).
