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

### Long-term vision: WorkTrain as a general engine, domain packs as configuration (Apr 15, 2026)

WorkTrain is not just a coding tool. The underlying engine -- session management, workflow enforcement, daemon, agent loop, knowledge graph, context bundle assembly -- is domain-agnostic. What makes it a "coding tool" today is entirely configuration: the workflows, the graph schema, the context bundle queries, the trigger definitions.

**Domain packs** are the abstraction that makes this general:

A domain pack is a self-contained configuration bundle that specializes WorkTrain for a specific problem domain:
- a set of workflows (the step structure and agent instructions for that domain)
- a knowledge graph schema (the node and edge types relevant to that domain)
- context bundle query definitions (what "give me everything relevant to X" means in that domain)
- trigger definitions (what events kick off work in that domain)
- a daemon soul template (default agent persona and principles for that domain)

**Examples of domain packs:**
- `worktrain-coding` -- software engineering (the current default)
- `worktrain-research` -- literature review, synthesis, citation tracking
- `worktrain-creative` -- narrative generation, continuity tracking, style enforcement
- `worktrain-ops` -- incident response, runbook execution, alert-to-action
- `worktrain-data` -- pipeline validation, schema monitoring, anomaly investigation

**The core engine is shared across all of them.** A domain pack author writes workflows, a graph schema, and context bundle queries -- they don't reimplement session management, token protocols, daemon loops, or the console.

**Why this matters for WorkTrain's positioning:** most autonomous agent platforms are either too generic (the user has to build everything) or too specific (locked to one use case). Domain packs give WorkTrain a middle path: powerful enough to be opinionated about engineering workflows today, open enough to run any structured agentic domain tomorrow. New domains get the session durability, enforcement, observability, and knowledge graph for free.

**What to build first:** nothing new for now. The architecture already supports this -- the domain pack concept is latent in the current design. The right time to make it explicit is when a second domain (creative writing, ops, research) is ready to be added. At that point, extract the coding-specific pieces into `worktrain-coding` and establish the domain pack contract.

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

### Console interactivity and liveliness

- **Status**: idea
- **Summary**: Make the console feel more alive and interactive -- currently it is largely a static visualization layer. Key areas: DAG node hover effects, micro-animations, click-to-inspect affordances, and overall responsiveness to user input.
- **Concrete starting points**:
  - **DAG node hover effects** -- nodes in `RunLineageDag` should have visible hover states: border brightens, subtle background glow, cursor changes to pointer. Currently nodes are clickable but give no visual feedback until clicked. This is the single highest-impact item.
  - **Node selection highlight** -- the selected node should pulse or glow in a way that draws the eye, rather than just a static border change.
  - **Transition animations** -- when the node detail panel slides in, the selected node in the DAG should subtly indicate the connection (e.g. a brief highlight flash).
  - **Live session pulse** -- sessions with `status: in_progress` could have a subtle periodic animation (not just a static badge) to reinforce that something is actively running.
  - **Tooltip polish** -- the current tooltip (delayed 300ms, no animation) could fade in/out rather than appearing instantly.
- **Design constraint**: the console already has a strong aesthetic (dark navy, amber accent, cyberpunk adjacent). Interactivity additions should reinforce this language, not contradict it. See `docs/design/console-cyberpunk-ui-discovery.md` for the ranked visual language list.
- **Where to start**: DAG node hover is in `console/src/components/RunLineageDag.tsx`. ReactFlow nodes use custom node type components -- hover state can be managed via React state or CSS. The tooltip pattern (`handleNodeMouseEnter`/`handleNodeMouseLeave`) already exists; a hover glow is a natural peer addition.
- **Related**: `docs/design/console-cyberpunk-ui-discovery.md` (ranked list of visual polish items), `docs/design/console-ui-backlog.md`

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

- **Context survival**: ~~3-line deletion in `prompt-renderer.ts`~~ **CORRECTED** -- injecting ancestry recap on every normal step advance is wrong. The agent completing step 4 already has steps 1-4 in context -- injecting the recap would be noise and token waste. The correct approach: the **daemon** injects the ancestry recap into the system prompt when initializing a fresh Claude API session via pi-mono's `Agent`. Engine code untouched. The existing `intent: "rehydrate"` path is already correct for human-driven sessions. This is a daemon feature, not a prompt-renderer change.
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

---

### Remote access: connect to local WorkRail from phone (post-MVP)

**Goal:** Access and control a WorkRail session running on your laptop from your phone, even behind NAT/VPN.

**The problem:** Laptop is behind NAT. Corporate VPN routes all traffic, blocking direct connections. Phone needs to reach the WorkRail console without port forwarding or IT involvement.

**Options to explore:**

1. **`workrail tunnel` command** -- WorkRail opens an outbound authenticated tunnel (Cloudflare Tunnel or similar) from the laptop and prints a URL. Phone opens the URL, gets the live console. Works behind any NAT/VPN since the connection is outbound from the laptop. Auth via WorkRail keyring token. Most WorkRail-native story.

2. **Tailscale integration** -- document Tailscale as the recommended setup. Zero WorkRail code needed. WorkRail console becomes accessible at a stable Tailscale address. Handles NAT and coexists with most corporate VPNs via split-tunneling.

3. **Cloud session sync** -- daemon pushes session events to a configured cloud store (S3, Cloudflare R2). Mobile reads from there. Most robust, works offline and behind any firewall, but adds complexity and a cloud dependency.

**VPN note:** Tailscale handles most corporate VPN conflicts. `workrail tunnel` sidesteps VPN entirely since it's outbound-only from the laptop. Either approach is better than trying to punch through corporate firewalls.

**Priority:** Post-MVP. Design the REST control plane and console with this in mind -- clean JSON API, no server-side rendering assumptions, authentication token model that works over tunnels.

---

### WorkRail Auto: cloud-hosted autonomous platform (long-term vision) ⭐⭐

**Goal:** WorkRail Auto runs on a server 24/7, connected to your engineering ecosystem, working autonomously without a laptop open.

**What this enables:**
- GitLab opens an MR → WorkRail reviews it, posts comment, done. Laptop closed.
- Jira ticket moves to In Progress → WorkRail starts coding task, pushes branch, opens draft MR. Review it in the morning.
- PagerDuty fires → WorkRail runs incident investigation workflow, posts findings to Slack.
- Scheduled: nightly test suite run, auto-filed bugs for new failures.
- Docs updated → WorkRail triggers documentation review workflow.

**Integrations needed (not exhaustive):**
- **Triggers:** GitLab/GitHub webhooks, Jira webhooks, Linear, PagerDuty, Slack slash commands, cron
- **Actions:** GitLab/GitHub API (MR comments, branch creation, commits), Jira (transition tickets, add comments), Slack (post messages, threads), Confluence/Notion (read docs), email
- **Auth:** Per-org credential vault (Jira token, GitLab token, Slack token, etc.)

**Architecture implications for hosted:**
- Multi-tenancy: multiple users/orgs, isolated session stores, isolated credential vaults
- The tunnel problem disappears -- server has a public IP, webhooks just work
- Credential vaulting: secrets stored encrypted per org, injected at session start
- Horizontal scaling: multiple daemon instances consuming from a shared trigger queue
- Rate limiting per org, per integration

**Relationship to self-hosted:**
- Self-hosted (local) is always free, always open source, always works offline
- Hosted WorkRail Auto is the natural SaaS layer -- same engine, same workflows, managed infrastructure
- Workflows written for self-hosted run unchanged on hosted (this is the portability guarantee)

**Priority:** Long-term. Design the local daemon with multi-tenancy seams in mind from the start (don't hardcode single-user assumptions), but don't build the hosted layer until the local daemon is proven.

**Reference:** OpenClaw's channel/extension architecture is the best existing model for multi-integration connectivity. AutoGPT's block/trigger system is the best model for declarative integration configuration.

---

### Business model (tentative)

Three tiers:

| Tier | Who | Price | Notes |
|------|-----|-------|-------|
| **Personal / OSS** | Individual devs, open-source projects, non-commercial | Free forever | Builds community, reputation, workflow library. Never charge for this. |
| **Corporate self-hosted** | Companies running WorkRail on their own infrastructure | Paid license | Data never leaves their VPC. Enterprise buyers pay well for data sovereignty + compliance. Priced per seat or per org. |
| **WorkRail Auto (cloud)** | Anyone who wants managed, zero-ops | Paid subscription | Higher price, lower friction. Pre-configured integrations. |

**License model options:**
- **Dual-license:** AGPL for open-source use (anyone can use but must open-source modifications), commercial license for everyone else who doesn't want AGPL obligations. Clean legal distinction.
- **BSL-style:** Core is source-available, commercial use requires a license after some threshold (employees, revenue, or deployment count). HashiCorp's original model before the community backlash -- careful with this one.
- **MIT core + paid features:** Core engine stays MIT forever, advanced features (hosted dashboard, enterprise SSO, multi-tenant credential vault, audit logs) are paid. Keeps the community trust, monetizes the enterprise layer.

**The corporate self-hosted market is often the most lucrative.** Enterprises pay well for "runs in our VPC, vendor can't see our code." GitLab, Grafana, Jira -- all built significant businesses on self-hosted enterprise licenses before or alongside their cloud offerings.

**What NOT to do:** Don't charge for the workflow library or the core MCP protocol. Those are the commons that make WorkRail valuable. Charge for the infrastructure layer, not the knowledge layer.

**Priority:** Don't worry about this until there are users. Get the product right first.

---

### Competitive landscape findings (Apr 14, 2026)

**WorkRail occupies a nearly empty quadrant:** durable session state + cryptographic step enforcement + MCP-native. No other tool currently has all three.

```
                   ENFORCEMENT STRENGTH
                   Weak (Prompt)         Strong (Structural)
                ┌─────────────────────┬──────────────────────────┐
          Yes   │  nexus-core          │  WorkRail ← HERE         │
DURABLE         │  LangGraph+LangSmith │  Temporal.io (not MCP)   │
STATE           │  CIAME contracts     │  mcp-graph (closest)     │
                ├─────────────────────┼──────────────────────────┤
          No    │  CLAUDE.md files     │  CrewAI, AutoGen         │
                │  maestro, ADbS       │  LangGraph (standalone)  │
                └─────────────────────┴──────────────────────────┘
```

**Key findings:**

- **mcp-graph** (DiegoNogueiraDev) -- SQLite-backed MCP server with graph-based step locking. Closest external analog. Not cryptographic enforcement but worth watching.
- **LangGraph + LangSmith** -- Durable (thread-IDs + Postgres) but prompt-based enforcement. Top-left quadrant, not top-right. **Watch condition:** if LangGraph adds MCP-server exposure, the MCP-native moat shrinks. Response: lean harder on JSON-authored + token-gated.
- **Temporal.io** -- Different domain (code-defined workflows, Go), different users. Low competitive concern but high architectural learning value for event-sourcing and crash recovery. Study it.
- **CrewAI / AutoGen / nexus-core** -- No durability, no structural enforcement. Not in the same quadrant.

**Internal finding -- most actionable:**
The **CIAME team** (Samuel Pérez, `samuelpe@`) is building WorkRail's exact problem manually in markdown (`rs-sdk-agent-execution-contract.md` -- execution contracts for AI agents). Most concrete internal adoption candidate. Direct cold share hook: "you're building this by hand, here's the tool."

**Positioning anchor:** "If you know Temporal.io, WorkRail is Temporal for AI agent process governance via MCP."

**Two immediate internal actions:**
1. List WorkRail in the Zodiac AI Marketplace + ZG AI Tools Catalog
2. DM Samuel Pérez (CIAME team) -- strongest cold share candidate alongside Peter Yao

---

### Deep dive findings: all reference architectures (Apr 14-15, 2026)

Research complete on all reference projects. Design docs written to `docs/design/` and `docs/ideas/`. Key findings per source:

---

#### OpenClaw findings (design-openclaw-deep-dive.md)

**Channel abstraction:** `ChannelPlugin<ResolvedAccount>` -- one TypeScript interface, ~25 optional adapter slots, lazily loaded. WorkRail equivalent: `WorkRailIntegration<TConfig>`. Integration-agnostic daemon core.

**Skills:** Not a separate primitive -- `agentTools` slot on ChannelPlugin injects pi-mono typed tools at session start. **WorkRail workflows ARE the skill layer.** No separate skill system needed.

**Session persistence:** `AcpSessionStore` confirmed in-memory only (LRU, 5k sessions, 24h TTL, vanishes on crash). WorkRail's disk-persisted append-only store is strictly better.

**Delivery binding:** Bind the delivery target (MR iid, Jira key, Slack thread) at spawn time, not completion time. `DeliveryRouter.resolve(triggerSource)` at completion. WorkRail: store `TriggerSource` when session starts.

**Credential model:** `$secret` refs with `file:path`, `exec:command` (enables 1Password CLI, Bitwarden, Keychain), env var. Adopt nearly verbatim.

**DaemonRegistry shape:** `RuntimeCache` (`Map<actorKey, {runtime, handle, lastTouchedAt}>`) + `RunStateMachine` for heartbeat. Extend with `continueToken` + `checkpointToken` + `persistTokens()` for WorkRail.

---

#### nexus-core findings

**Org profile system:** `configs/profiles/zillow.yaml` declares CLI tool bindings (glab vs gh, acli vs jira-cli). WorkRail: `workrail profile apply <org>` writes `~/.workrail/config.json` with active integration bindings.

**Skill loading:** Three-mirror layout (`.claude/skills/`, `skills/`, `.agents/skills/`) with symlink-based plugin discovery. Core always wins. WorkRail: `~/.workrail/plugins/` with `workrail-plugin.yaml` manifest.

**SOUL.md:** Behavioral principles injected into agent system prompts. WorkRail Auto should ship a `SOUL.md` equivalent in daemon session system prompts -- agent character beyond workflow steps. "Evidence before assertion" = WorkRail's enforcement principle as a behavioral norm.

**Session lifecycle hooks:** JSON stdin/stdout protocol (`{session_id, reason, transcript_path}`). Maps to WorkRail daemon: init (inject ancestry, register in DaemonRegistry, acquire lock) → end (write checkpointToken atomically, release lock, post results to trigger source).

**Knowledge injection:** `inject-knowledge.sh` -- before Claude API call, inject: ancestry recap + `~/.workrail/knowledge/` + repo-specific `.workrail/context.md`. Cap at N lines (200 default). SHORT_NAME matching for repo-relevant selection.

**Skill-as-git-history:** Each skill evolves through atomic commits traceable to session context. WorkRail: session notes improve workflows via `workflow-for-workflows`.

---

#### pi-mono findings (docs/design/pi-mono-integration-discovery.md)

**`agent.state` returns a snapshot, not live reference.** Must reassign: `agent.state.messages = [...agent.state.messages, newMsg]`.

**Tools must throw on failure** -- never encode errors in content. LLM sees and can retry.

**`agent.followUp()` is the termination pattern** -- `continue_workflow` tool calls `agent.followUp(buildStepPrompt(result.step, continueToken))`. `isComplete` captured in closure drives `getFollowUpMessages` returning `[]` to exit naturally.

**Token persistence via `afterToolCall`** -- write `continueToken` + `checkpointToken` to `~/.workrail/daemon-state.json` atomically before returning tool result.

**Console streaming:** Subscribe to `message_update` events where `assistantMessageEvent.type === "text_delta"`. Push over SSE/WebSocket. `tool_execution_start/end` drive tool progress indicators.

**`mom` dispatch model:** One `Agent` instance per session (not per trigger). `ChannelQueue` (KeyedAsyncQueue) serializes messages per channel. WorkRail: one `Agent` per daemon session, reconstructed from WorkRail event log on each run.

Full tool registration TypeScript in design doc.

---

#### LangGraph findings (docs/ideas/langgraph-discovery.md)

**Time-travel checkpointing:** `CheckpointMetadata.source = "fork"` enables re-invoking from any historical `checkpoint_id`. This is the implementation pattern for WorkRail's "workflow rewind" backlog feature. WorkRail's event log already stores enough -- what's missing is branch-from-earlier-point API.

**`interrupt()` is a function, not middleware** -- raises `GraphInterrupt`, node re-runs from scratch on resume (requires idempotency). WorkRail's design is cleaner -- step advances, doesn't re-execute. WorkRail's HMAC token can't be faked; LangGraph's interrupt can be bypassed.

**Streaming is a `(namespace, mode, data)` triple** -- includes subgraph namespace path. Right format for WorkRail Auto's console SSE events. pi-mono's `agent.subscribe()` is the direct equivalent.

**Multi-tenancy is soft** -- metadata-filter-based, no per-tenant schema isolation. A bug in an auth handler leaks cross-tenant data. **WorkRail's opportunity: structural per-org storage roots from day one.**

**`Workflow + Session + Run` hierarchy confirmed at scale** -- right entity model for WorkRail Auto cloud.

---

#### Temporal.io findings

**Event-sourcing model:** Temporal workflows replay event history deterministically on each activation. `DeterminismViolationError` when code changes break replay compatibility. WorkRail already has this pattern in its event log + `replay.ts`. Key addition: Temporal's `Worker.runReplayHistories()` for batch testing workflow code changes against production history before deploying.

**Activity/workflow separation:** Workflows = deterministic orchestration (no side effects, must be pure). Activities = side-effectful work (API calls, file I/O, non-deterministic ops). WorkRail's current design conflates these -- workflow steps can have side effects. For WorkRail Auto, this distinction matters: the daemon's `runWorkflow()` loop is the "workflow" (deterministic step sequencer), and each tool execution is an "activity" (side-effectful). Not a blocking design change, but a useful mental model.

**Worker polling vs webhook push:** Temporal workers poll a task queue; WorkRail uses webhook push. Both are valid. Worker polling is better for cloud/multi-tenant (workers can scale independently, no direct webhook routing needed). WorkRail Auto local: webhooks are simpler. WorkRail Auto cloud: task queue model worth adopting.

**Workflow versioning:** `patched()` / `deprecatePatch()` pattern for evolving running workflows. WorkRail has no equivalent. Minimal needed: workflow definition hash pinning (already done via `workflowHash`), plus a mechanism to continue old sessions on old workflow versions while new sessions use new versions. Not MVP but important for production.

**Namespace isolation:** Per-org Temporal namespaces with separate history and quota. WorkRail Auto cloud: per-org data dirs (`~/.workrail/orgs/<orgId>/`) from day one. No shared state between orgs.

**Schedule client:** Temporal's `ScheduleClient` has `ScheduleOverlapPolicy` (SKIP, BUFFER_ONE, BUFFER_ALL, CANCEL_OTHER, ALLOW_ALL). WorkRail's cron trigger needs the same overlap policy -- what happens if a scheduled run is still running when the next one fires?

---

#### AutoGPT findings

**Block abstraction:** `BlockType` enum includes `WEBHOOK`, `HUMAN_IN_THE_LOOP`, `MCP_TOOL`, `AGENT`, `AI`. Each block has typed `Input`/`Output` schemas (Pydantic). `BlockWebhookConfig` for trigger blocks. This is the right abstraction for WorkRail Auto's integration layer -- every integration (GitHub trigger, Jira action, Slack message) is a typed `WorkRailBlock<TInput, TOutput>`.

**`HUMAN_IN_THE_LOOP` block type:** AutoGPT has this as a first-class concept. Directly maps to WorkRail Auto's approval-gate feature -- workflow steps that pause for human confirmation before proceeding.

**mcp-graph:** Repo not found at `DiegoNogueiraDev/mcp-graph` -- may have been deleted or renamed. The competitive scan agent may have surfaced a different project. Not a concern -- WorkRail has no close competitors in its quadrant.

---

#### Key synthesis: what to build vs import

| Component | Decision | Source |
|-----------|----------|--------|
| Agent loop | Import `@mariozechner/pi-agent-core` | pi-mono |
| LLM providers | Import `@mariozechner/pi-ai` | pi-mono |
| Channel abstraction | Build `WorkRailIntegration<TConfig>` | OpenClaw pattern |
| Credential system | Build `$secret` resolver | OpenClaw pattern |
| Delivery binding | Build `TriggerSource` + `DeliveryRouter` | OpenClaw pattern |
| DaemonRegistry | Build `RuntimeCache` shape | OpenClaw pattern |
| Session lifecycle | Build `session-init` / `session-end` hooks | nexus-core pattern |
| Knowledge injection | Build `buildDaemonSystemPrompt()` | nexus-core pattern |
| SOUL.md | Build daemon behavioral principles | nexus-core pattern |
| Console streaming | Build SSE with `(namespace, mode, data)` triple | LangGraph pattern |
| Approval gates | Build `HUMAN_IN_THE_LOOP` block type | AutoGPT pattern |
| Overlap policy | Build cron trigger overlap config | Temporal pattern |
| Namespace isolation | Build per-org storage roots | Temporal + LangGraph |
| Workflow versioning | Defer -- hash pinning sufficient for MVP | Temporal insight |
| Activity/workflow split | Defer -- useful mental model, not blocking | Temporal insight |
| Time-travel rewind | Defer -- fork-from-checkpoint API | LangGraph insight |

**AutoGPT + mcp-graph-workflow additional findings (from design agent):**

**AutoGPT trigger declaration pattern:** Three-layer design: block declares schema + `webhook_config`; `WebhooksManager` handles registration + payload validation; payload flows in as hidden `Input.payload` field. Distinction between auto-register (`BlockWebhookConfig`) and user-configured (`BlockManualWebhookConfig`) is exactly the pattern WorkRail's trigger system needs.

**Fernet credential encryption:** `encrypt(data: dict) -> str` / `decrypt(str) -> dict` using symmetric key. 40 lines. WorkRail's `CredentialStore` should be a direct port.

**Acquire-at-execution injection:** Credentials fetched just before step execution, injected as typed objects, held under lock for duration, released in `finally`. Acquire-inject-release contract for WorkRail's step runner.

**`SecretStr` type enforcement:** Wrap secrets in an opaque type (branded type or `class Secret<T>` in TypeScript) that prevents accidental logging.

**mcp-graph-workflow `resource_locks` SQLite table:** `leaseToken + agentId + expiresAt + TTL auto-expiry`. Upgrade `LocalSessionLockV2` from PID-file to SQLite lock table. Adds multi-process safety without Redis. Directly addresses the workerId bug already fixed on `feat/session-lock-worker-id`.

**`leaseToken` for subagent step claiming:** `start_task` returns `leaseToken`; `finish_task` requires it. WorkRail subagent delegation: coordinator passes leaseToken, subagent includes in `continue_workflow` context, engine validates.

**`nextAction` in every tool response:** mcp-graph appends `_lifecycle.nextAction` to every MCP response. WorkRail: add typed `nextAction` field to `continue_workflow` responses (parsed step summary, suggested tool, context keys) -- complement to HMAC enforcement.

**mcp-graph-workflow vs WorkRail honest comparison:** mcp-graph has SQLite persistence, lifecycle phases, gate checks, multi-agent task claiming, RAG, knowledge store. It's in "durable + advisory enforcement" quadrant. WorkRail's moat: cryptographic enforcement (mcp-graph is advisory -- agents CAN call tools out of sequence), checkpoint/resume tokens, workflow composition DSL, DAG visualization. Not marginal differences.

**Temporal/Prefect/Dagster additional findings (full discovery agent):**

**Central insight -- Temporal's replay model is NOT applicable to WorkRail.** Temporal's event-sourcing depends on deterministic code. AI agent tool calls are inherently non-deterministic. WorkRail's checkpoint token + append-only session store is already the right architecture. "Temporal for AI agent process governance" is valid as an analogy -- take Temporal's invariants, not its mechanisms.

**Workflow versioning is already solved.** `PinnedWorkflowStorePortV2` + `workflowHash` verified in `src/mcp/handlers/v2-advance-core/outcome-success.ts` (line 57) and `src/mcp/handlers/v2-workflow.ts` (lines 460-463). Deploy-safe in-flight sessions are fully handled. No new code needed.

**Trigger system from Dagster sensor cursor model (~200 LOC):** `TriggerSourcePortV2<TEvent, TCursor>` port + `TriggerCursorStore` + `CronTrigger` + `GitLabMRTrigger`. Trigger event ID used as workflowId for idempotency (Dagster's `run_key` pattern -- prevents double-fire after daemon restarts). Prefect's lookahead pre-insertion: `CronTrigger.poll()` computes all missed ticks since last cursor and fires them as separate sessions.

**Human approval gates (post-daemon-MVP, ~200 LOC + schema):** Three new typed domain events (`step_approval_pending/received/timeout`) + REST endpoint with HMAC-signed approval token. Requires workflow schema change. Build after autonomous daemon is proven.

**Daemon crash recovery (~80 LOC, build first):** `DaemonStateStore` port -- atomic write of `{ sessionId, continueToken, stepIndex, approvalGate? }` to `~/.workrail/daemon-state.json` before every `continue_workflow`. Follows existing temp→fsync→rename pattern from session store. Out-of-band from session lock by design.

**Temporal-to-WorkRail mapping confirmed:**
- Event history → append-only session event log ✅ (exists)
- Workflow task token → `ct_`/`st_` checkpoint token ✅ (exists)
- `condition(fn, timeout)` human gate → `approvalGate` step + REST resume (to design)
- Activity heartbeat → `requiredEvidence` field (to implement)
- Deployment versioning → `PinnedWorkflowStorePortV2` + `workflowHash` ✅ (verified)
- Namespace → `orgId` prefix in `dataDir` + credential vault (cloud tier)
- Worker long-polling → direct in-process engine calls ✅ (daemon model)

**Temporal additional findings (third agent, deepest source read):**

**WorkRail's JSON model eliminates Temporal's entire determinism complexity class.** Temporal's VM isolation, `DeterminismViolationError`, `patched()`, and replay machinery exist because Temporal workflows are user TypeScript code. WorkRail workflows are JSON interpreted by the engine -- no determinism problem. Genuine architectural advantage, not a gap.

**Minimum additions to WorkRail schema:**
- `versioningBehavior: "PINNED" | "AUTO_UPGRADE"` -- PINNED keeps in-flight sessions on current workflow version; AUTO_UPGRADE migrates to latest on next continue_workflow
- `orgId` in session store paths: `~/.workrail/sessions/<orgId>/` with startup migration (needed for multi-tenancy from day one)

**Human-in-loop signal pattern:** Temporal's `setHandler(signal, handler)` + `condition(fn)` is the right mental model for WorkRail's approval gates. Buffer incoming signals (approval/rejection), `condition()` unblocks when buffer has a matching signal. Translate to WorkRail: daemon emits `step_approval_pending` event, REST endpoint receives approval, emits `step_approval_received`, daemon's `condition()` equivalent unblocks `continue_workflow`.

**Triggers in workflow schema (dedicated sprint):** `triggers: DeploymentTrigger[]` inline in workflow JSON with `posture: "reactive" | "proactive"` + optional `schedule_after` delay. Prefect's `automations.py` deployment trigger pattern. Not MVP.

**Worker polling seam:** Design the trigger port with `poll()` interface now even though self-hosted uses webhooks. Cloud deployment uses long-poll task queue without architectural changes.

**AutoGPT + mcp-graph-workflow CORRECTION (deepest agent, read actual source):**

**mcp-graph-workflow is NOT a close WorkRail analog.** Earlier characterization was wrong. It's a local-first SQLite-backed MCP server that converts PRD docs into execution graphs with a fixed 9-phase lifecycle. Its gates are advisory and bypassable (`force:true` parameter). WorkRail's HMAC tokens are cryptographic and unbypassable. Different quadrants, different trust models.

**mcp-graph does better that's worth watching:** Local RAG context compression (70-85% via BM25 + ONNX embeddings, zero cloud) -- relevant to WorkRail's future context survival. AST code intelligence (out of scope but useful for coding-task workflows).

**Concrete WorkRail Auto trigger system design (from AutoGPT + validation):**

Three-layer model: declare → register → execute.

```typescript
interface TriggerDefinition {
  id: string;
  provider: string;           // "github" | "gitlab" | "jira" | "cron" | "generic"
  triggerType: string;        // provider-specific
  resourceTemplate: string;  // "{owner}/{repo}"
  eventFilter: Record<string, boolean>;
  credentialRef?: string;     // keyring named ref -- never plaintext
  workflowId: string;
  contextMapping?: ContextMapping;  // optional JSONPath payload → workflow context
}
```

**The generic provider alone is a complete MVP.** Any system that can send HTTP POST can trigger a WorkRail workflow. GitLab, Jira, Slack, PagerDuty all work without provider-specific code. Auto-registration is post-MVP.

**Port:** 3200 (separate from MCP 3100). **Feature flag:** `wr.features.triggers`.

**MVP build order:** `trigger-store.ts` → `trigger-listener.ts` → `trigger-router.ts` → `providers/generic.ts` → `providers/cron.ts` → MCP CRUD tools.

**Credential model:** keyring-based named refs. Two backends: OS keychain (dev) + encrypted env-file (Docker/CI/headless). Never plaintext in trigger definitions.

Full design at: `docs/design/workrail-auto-trigger-system.md`

**CORRECTION: pi-mono termination bridge (third agent, deepest read):**

**`getFollowUpMessages()` is the WRONG termination bridge.** Earlier finding was incorrect. Correct approach:

- Use `agent.steer()` for step injection -- fires after each tool batch, inside the inner loop
- `followUp()` only fires when agent would otherwise stop -- adds an unnecessary extra LLM turn per workflow step
- **Termination:** simply don't call `steer()` when workflow is complete. Agent stops naturally.

**Correct daemon runner pattern (from mom's `createRunner()`):**
- Subscribe to agent once at daemon session creation
- Mutable `runState` reset per run (in closure)
- `agent.steer()` injects next step after each tool batch
- When `isComplete=true` from `continue_workflow`, stop calling `steer()` -- agent exits cleanly

**`abort()` is best-effort** for synchronous engine operations (SQLite/HMAC can't be interrupted). Don't rely on it for immediate cancellation.

**Claude Code deep dive -- THREE CORRECTIONS to backlog (deepest source read, 11 files):**

**Correction 1: Session memory injection does NOT work for daemon mode.** The session memory file is Claude Code-internal, at a path only Claude Code controls. WorkRail's daemon calls Anthropic API directly via pi-mono -- there is no Claude Code session memory file. **Daemon mode must use system prompt injection:** prepend `<workrail_session_state>` XML block to system prompt before each `agentLoop()` call (last 3 step note summaries, ~200 tokens each).

**Correction 2: PreCompact hooks do NOT fire for Tier 1 (Session Memory Compaction).** `trySessionMemoryCompaction()` runs before hooks are invoked. When Tier 1 succeeds, PreCompact hooks are never called. Hooks only cover Tier 2 (legacy/reactive) compaction.

**Correction 3: `sessionRunner.ts` is NOT the daemon pattern.** It's Claude.ai web UI's bridge for controlling a local Claude CLI subprocess. WorkRail's daemon calls Anthropic API directly.

**Correct integration architecture:**

For **human-driven sessions (Claude Code + WorkRail MCP):**
```
PreCompact hook → output step notes as custom compaction instructions
PostToolUse hook (Bash|Write|Edit) → log tool calls to evidence NDJSON file
PreToolUse hook (continue_workflow) → check evidence log; deny if required evidence missing
```
Evidence gate is fail-open when log missing.

For **daemon mode (WorkRail daemon + pi-mono):**
```
Before each agentLoop() call: prepend <workrail_session_state> XML to system prompt
Evidence gate: in-process check before executeContinueWorkflow() -- reads tool_call_observed
events from session store (stronger than hook-based, no subprocess reliability concern)
```

In-process evidence gate is architecturally superior for daemon mode -- direct session store reads, no subprocess IPC.

**OpenClaw final findings (deepest agent, 15+ source files):**

**`KeyedAsyncQueue` is FIRST prerequisite -- build before daemon runner.** Prevents token corruption when multiple triggers fire concurrently. 30-80 LOC to reimplement from `src/acp/control-plane/session-actor-queue.ts`.

**`TriggerPlugin<TConfig, TCredentials>` interface:** Phase 1 MVP -- typed interface + `TRIGGER_REGISTRY = new Map<TriggerId, TriggerPlugin>` + factory credential resolution. ~300 LOC. DI injection deferred to Phase 2 when test coverage needed. Use branded `TriggerId` string type (not closed union) -- extensible without recompile.

**`deliveryContext` persistence (~20 LOC):** Store routing info (MR iid, Jira key, Slack thread) at session creation in session store. Crash recovery: on restart, `DeliveryRouter.resolve(deliveryContext)` knows where to post results.

**`TaskNotifyPolicy` enum:** `done_only` / `state_changes` / `silent` -- 5 LOC, adopt verbatim for trigger notification behavior config.

**`DaemonRegistry.snapshot()`:** `RuntimeCache` equivalent (~50 LOC) feeding console live view API. `snapshot()` returns current running sessions; `collectIdleCandidates()` for GC.

**Pre-implementation checklist before any trigger code:**
1. `KeyedAsyncQueue` (prerequisite, ~50 LOC)
2. Branded `TriggerId` type
3. `never` branch in startup switch over `TriggerInboundAdapter.kind`
4. `deliveryContext` stored at session start

---

## Ultimate MVP -- non-blocking build order

Everything researched. Build order that ships fastest without blocking future:

**Step 1 ✅ DONE:** `LocalSessionLockV2` workerId + instanceId fix (merged to main)

**Step 2: `KeyedAsyncQueue` (~50 LOC)**
Concurrent session serialization. Prerequisite for daemon safety. Prevents token corruption. Re-implement from OpenClaw pattern, don't import.

**Step 3: `src/daemon/workflow-runner.ts` (~150 LOC)**
- `runWorkflow(trigger, apiKey)` calls engine directly (in-process, shared DI)
- `@mariozechner/pi-agent-core` `Agent` class as the loop
- `agent.steer()` for step injection after each tool batch (NOT `followUp()`)
- Persist `continueToken` + `checkpointToken` to `~/.workrail/daemon-state.json` atomically before each step
- `isComplete=true` → stop calling `steer()` → agent exits naturally
- Register `start_workflow`, `continue_workflow`, `Bash`, `Read`, `Write` as `AgentTool<T>` with TypeBox schemas
- Inject `<workrail_session_state>` XML block in system prompt (last 3 step note summaries, ~200 tokens each)

**Step 4: Trigger webhook server (~300 LOC)**
- `TriggerPlugin<TConfig, TCredentials>` interface + `TRIGGER_REGISTRY` Map
- `POST /webhook/generic` -- accepts any JSON payload on port 3200
- `triggers.yml` config: `workflowId`, optional `contextMapping` (JSONPath payload → context)
- HMAC signature verification, async queue, 202 response
- Feature flag: `wr.features.triggers`
- Generic provider works for ALL integrations out of the box

**Step 5: Console live view (~3 files, no new routes)**
- `context_set(is_autonomous: true)` event at session start
- Ephemeral `DaemonRegistry` with `lastHeartbeatMs`
- `[ LIVE ]` pulsing badge in session list

**What stays non-blocking:**
- In-process daemon → cloud HTTP client is a transport swap, not a rewrite
- `TriggerSourcePortV2` has `poll()` interface → worker polling for cloud is config, not code
- Per-org session paths (`~/.workrail/sessions/default/`) → adding orgId prefix later is migration
- Feature flags on everything → merge incrementally
- Generic webhook → all integrations (GitLab, Jira, Slack) via config, zero code per integration

---

### Daemon context customization (implemented Apr 15, 2026)

**`~/.workrail/daemon-soul.md`** -- operator-customizable agent rules injected into every daemon session system prompt. Analogous to nexus-core's `SOUL.md` and Common-Ground's `AGENTS.md`. Default created on first run with commented instructions. Override per-workspace or globally.

**Auto-inject `AGENTS.md` / `CLAUDE.md`** -- daemon scans `workspacePath` for `.claude/CLAUDE.md`, `CLAUDE.md`, `AGENTS.md`, `.github/AGENTS.md` (in priority order) and injects into system prompt under `## Workspace Context`. Combined 32KB limit, truncated with notice if over. Enables the daemon to adapt to different repos' coding standards and conventions automatically -- same as how Claude Code uses these files.

**Daemon calls `start_workflow` directly** -- removes the "Call the start_workflow tool now" LLM indirection. Daemon calls `executeStartWorkflow()` directly, gets step 1, passes it as the initial prompt. More reliable, cheaper (one fewer LLM turn), and the agent starts working immediately instead of being told to call a tool.

---

### WorkTrain onboarding: `worktrain init` guided setup (high priority, post-MVP)

**Goal:** A guided CLI onboarding that sets up everything WorkTrain needs to work well, asked once, never asked again.

**What it configures (in order):**

1. **LLM provider** -- Bedrock (AWS SSO profile) or direct Anthropic API key. Validates the credentials actually work before proceeding.
2. **Workspace** -- default workspacePath for daemon sessions. Offer to auto-detect from git repos in common locations.
3. **Daemon soul** -- create `~/.workrail/daemon-soul.md` interactively. Ask: "What language/framework does your main project use? Any coding conventions the agent should follow? Commit style?" Write the soul file from answers.
4. **Trigger configuration** -- set up the first trigger. Ask: what workflow? (list available) what webhook source? (GitHub/GitLab/Jira/manual) Configure `triggers.yml`.
5. **Common-Ground** -- if detected, offer to sync the team's AGENTS.md and workflows.
6. **Notification** -- optional Slack/Telegram webhook for session completion/failure notifications.
7. **Verification** -- fire a smoke-test workflow (cheap, non-destructive) to confirm end-to-end works. Show the result.

**Design principles:**
- Skip sections that are already configured (idempotent)
- `--reconfigure <section>` to re-run a specific section
- All answers stored in `~/.workrail/config.json` (already exists) + `daemon-soul.md` + `triggers.yml`
- Should complete in under 5 minutes for a typical setup
- The soul questionnaire is the most important part -- a well-written soul dramatically improves output quality

**Longer term:** A WorkTrain hosted onboarding that teams can share via a URL (`worktrain init --from https://worktrain.io/teams/mercury-mobile`) -- imports team-specific soul, triggers, and workflow config in one command.

---

### Post-update onboarding: contextual feature announcements

**Goal:** When WorkTrain updates to a new version with significant new capabilities, it prompts the user to configure the new feature -- once, the first time they run after updating.

**How it works:**

Each significant feature ships with a `migration step` keyed to a minimum version:
```json
// ~/.workrail/config.json
{
  "onboardingCompleted": "3.17.0",
  "featureStepsCompleted": ["daemon-soul", "bedrock-setup", "triggers-v2"]
}
```

On startup, WorkTrain checks: current version > `onboardingCompleted`? Any new `featureSteps` not in `featureStepsCompleted`? If yes, run those steps interactively before continuing.

**What triggers a feature onboarding step:**
- New capability that requires user configuration to activate (e.g. daemon soul file, Bedrock credentials, new trigger source)
- Breaking change to config format that needs migration (e.g. triggers.yml schema v2)
- Feature that's opt-in and valuable but off by default (e.g. AGENTS.md auto-injection)

**What does NOT trigger it:**
- Bug fixes and performance improvements
- New workflows added to the library
- Any change that works without user input

**Tone:** Brief, useful, never annoying. Each step should take < 60 seconds. Show what changed, ask what's needed, confirm it works. Skip if already configured.

**Example:**
```
WorkTrain updated to v4.1.0 ✦ One new capability to configure:

  Workspace Context Injection
  WorkTrain can now automatically read AGENTS.md and CLAUDE.md from
  your repos and inject them into every agent session.

  → Your workspaces will be scanned automatically. No action needed.
  → To add custom rules for all sessions: ~/.workrail/daemon-soul.md
     (run: workrail init --section soul)

  Press Enter to continue, or 's' to skip this setup.
```

---

### Multi-agent support: concurrent sessions + agent collaboration (high importance, post-MVP)

**Concurrent sessions (near-term):**
WorkTrain should run multiple workflows in parallel -- different agents on different repos or different tasks simultaneously. The current architecture supports this (per-session state files, `KeyedAsyncQueue` serializes per trigger ID), but the global concurrency cap from the arch audit needs implementing:
- `maxConcurrentSessions: N` config in `~/.workrail/config.json`
- Global semaphore in `TriggerRouter` -- queues new dispatches when at capacity
- Console shows all concurrent sessions in QueuePane
- Mobile monitoring shows live count

**Agent collaboration on a single task (longer-term):**
Multiple agents coordinating on one task. Two patterns:

1. **Coordinator + worker subagents** -- already possible today via WorkRail's existing `mcp__nested-subagent__Task` delegation in workflow steps. A coordinator workflow spawns subagents with scoped tasks (e.g. one agent writes Android code, another writes iOS). Each subagent has its own WorkRail session and reports back to the coordinator.

2. **Parallel agent teams** -- multiple agents working independently on separate parts of a task (e.g. separate feature branches) with a final merge/review step. Requires cross-repo execution and a workflow that understands how to partition and recombine work.

**MVP path:** Concurrent sessions with `maxConcurrentSessions` first (small change). Coordinator + subagent delegation second (already works, just needs workflow authoring). Full parallel teams is the longer-term investment.

---

### Core daemon design principle: scripts over agent (permanent)

**The agent is expensive, inconsistent, and slow. Scripts are free, deterministic, and instant.**

Any operation the daemon can perform with a shell script, git command, or API call should be done that way -- not delegated to the LLM. The agent's job is cognition: understanding the task, making decisions, writing code. Everything else is mechanical work that scripts do better.

**Concrete rule:** if an operation is deterministic and has no ambiguity, it is a script. Examples:

- `git add -A && git commit -m "..."` -- script (daemon reads the handoff artifact the agent produced and runs this itself)
- `gh pr create --title "..." --body "..."` -- script (daemon reads PR title/body from the agent's handoff note)
- running the build (`npm run build`, `gradle assembleDebug`) -- script
- running tests (`npm test`, `./gradlew test`) -- script
- reading a file to check if it exists -- script (use Read tool, not ask the agent)
- detecting which workflow to run for a given trigger -- script (workflowId is in `triggers.yml`)
- formatting output, writing JSON state files, sending HTTP requests -- scripts

**The agent only does what requires judgment:**

- understanding what files need to change and how
- evaluating whether an approach matches the repo's patterns
- generating commit messages and PR descriptions (because those require understanding the change)
- deciding whether a test failure is a real issue or a flaky test
- making tradeoff decisions when there are competing valid approaches

**Auto-commit and auto-PR design (near-term daemon work):**

The workflow's final step produces a structured handoff artifact with `commitType`, `commitScope`, `commitSubject`, `prTitle`, `prBody`, and `filesChanged`. The daemon reads this artifact after the workflow completes and runs git commands directly:

```typescript
// After runWorkflow() resolves successfully:
const handoff = extractHandoffArtifact(result); // parse notes for the structured block
if (handoff && triggerConfig.autoCommit) {
  await execa('git', ['add', ...handoff.filesChanged], { cwd: workspacePath });
  await execa('git', ['commit', '-m', handoff.commitMessage], { cwd: workspacePath });
}
if (handoff && triggerConfig.autoOpenPR) {
  await execa('gh', ['pr', 'create', '--title', handoff.prTitle, '--body', handoff.prBody], { cwd: workspacePath });
}
```

`autoCommit` and `autoOpenPR` are opt-in flags in `triggers.yml`. Default off. The daemon never commits without explicit config.

**Why this matters for quality:** LLM-run git commands have non-deterministic output, can hallucinate flags, and burn tokens on mechanical work. A script-run commit is always correct, always fast, always auditable. The agent writes the message; the daemon runs the command. That split is the right architecture.

**Key open question:** When two agents work on the same repo concurrently, file conflicts are possible. The right answer is git worktrees -- each agent gets its own worktree, merges at the end. This is what the `cw` command does for human developers. WorkTrain should do the same autonomously.

---

### Workflow complexity routing: fast-path thoroughness and subagent offloading (design questions, Apr 15, 2026)

Three open questions that should be resolved before the lean.v2 workflow is considered stable for autonomous use:

---

**Q1: Is one step enough for Small tasks?**

Currently: Small tasks take one step (phase-5-small-task-fast-path). That step now requires wiring verification, build, tests, and a handoff artifact. But it is still one LLM context doing everything.

The real risk is not the number of steps -- it is context overload within that one step. If the task is genuinely small (add a CLI flag, fix a one-line bug), one focused context is fine and lower cost. But if "Small" is being misclassified -- or if the task is technically small but requires non-obvious wiring across several files -- a single context is likely to miss things.

**Tentative answer:** the classification is the real gate, not the step count. The fix is making Phase 0 classify more conservatively and making it easier to reclassify upward after the fast path discovers unexpected scope. A `reclassifyToMedium` escape hatch in the fast path step (sets a context var that routes to phase-3 planning) would cover the "started small, turned out bigger" case without forcing every Small task through the full path.

---

**Q2: Should Medium tasks get a dedicated path?**

Currently: Medium falls into the same non-Small path as Large, which includes the full design review, plan audit, and final verification loops. For genuinely Medium tasks (well-understood, moderate scope, low architectural uncertainty), that path is too heavy.

**Tentative answer:** add a QUICK rigor path for Medium. The existing `rigorMode=QUICK` conditions already skip the hypothesis, deep design, and plan audit steps -- so Medium+QUICK already produces a lighter path. The issue is that the workflow doesn't explicitly name "Medium fast path" anywhere. Document that `taskComplexity=Medium + rigorMode=QUICK` is the intended Medium track. No new steps needed -- just make the intended routing explicit in Phase 0 guidance.

---

**Q3: Subagent offloading for classification and context gathering**

The main agent's context is expensive and degrades as it fills up. The right architecture is:

- **Phase 0 (classify)**: delegate to a cheap subagent. It reads the task description, scans relevant files, and returns: `taskComplexity`, `riskLevel`, `rigorMode`, `candidateFiles`, `invariants`. Main agent reviews and accepts/overrides. Cost: one cheap context instead of part of the main context.

- **Context gathering (phase-1)**: already delegates to `routine-context-gathering` subagents. That's the right model. The question is whether those subagents share results via a persistent layer (knowledge graph) or repeat sweeps every session.

- **Design review, plan audit, final verification**: already delegate to routine subagents. Good.

The main agent should own: decisions, synthesis, and implementation. Everything else should be offloaded.

**Dependency:** subagent offloading at scale requires a reliable handoff/knowledge-sharing system. Right now subagent results live in step notes and context variables -- ephemeral, per-session. If agents are going to stop repeating repo sweeps, something needs to persist knowledge between sessions.

---

### Knowledge graph for agent context (high importance, research needed, Apr 15, 2026)

**The problem:** every session starts with a full repo sweep. Context gathering subagents re-read the same files, re-trace the same call chains, re-identify the same invariants. This is expensive, slow, and scales badly as the codebase and team grow. The same problem appears in Storyforge (see `~/git/personal/storyforge/docs/architecture/design-notes/graph-memory-mcp.md`).

**The idea:** a persistent, derived knowledge graph that agents build incrementally and query instead of sweeping. Key properties from Storyforge's design thinking that apply directly to WorkRail:

- **Derived, not authoritative.** Source files are ground truth. The graph is a compiled/indexed view with provenance pointers back to source. Graph state never silently outranks a file read.
- **Context bundles, not raw queries.** An agent doesn't query individual nodes -- it requests a context bundle: "give me everything relevant to `src/trigger/trigger-router.ts` for a bug investigation." The graph assembles and returns one scoped bundle.
- **Provenance on every fact.** Every node/edge records: which file it came from, which session created it, which agent, when. Stale facts are detectable.
- **Incremental, session-driven updates.** After each session completes, the daemon updates the graph with what the agent learned (new files read, new relationships traced, new invariants recorded). The graph grows session by session without requiring a full sweep.

**Node types for a code knowledge graph:**
- `file` (path, language, last_modified, last_indexed)
- `symbol` (function, class, type, constant -- with file + line)
- `call_edge` (caller -> callee with file/line provenance)
- `invariant` (named constraint with the files it spans)
- `workflow_session` (what task was done, which files changed, what was found)
- `dependency` (npm/gradle package with version)
- `test` (test file -> symbols under test)

**Edge types:**
- `imports`, `calls`, `exports`, `implements`, `extends`
- `tested_by`, `modified_in_session`, `invariant_spans`
- `depends_on`, `registered_in` (DI container, CLI map, router)

**What this solves for WorkRail:**
- Context gathering drops from "sweep 200 files" to "query the graph for the relevant subgraph + fetch the 5-10 source files that are actually going to change"
- Agents can ask "what other files import `trigger-router.ts`?" in one graph query instead of a grep sweep
- The wiring check in the fast path becomes: "query the graph for all registrations of type `CliCommand`, confirm the new command is in the set" -- not "read index.ts, cli.ts, and hope you find all the entry points"
- Session history is queryable: "what sessions touched `session-lock` in the last 30 days?" -- useful for debugging and for not re-investigating known issues

**The target architecture: vector + graph hybrid (not just a relational index)**

The knowledge graph vision is more than a queryable symbol index. The real goal is a system where an agent asks "give me everything related to trigger-router.ts" and the system surfaces things that are *semantically relevant* -- not just things explicitly linked by import edges, but files that implement the same pattern, functions with similar signatures, sessions that touched related concepts. This is closer to a neural network for knowledge than to a SQL database.

This requires two complementary layers:

**Layer 1: Structural graph (hard edges, deterministic)**
Built by parsing the codebase. Captures known, explicit relationships:
- `imports`, `calls`, `exports`, `implements`, `extends`
- `registers_in` (DI container, CLI command map, router)
- `tested_by`, `modified_in_session`

This layer answers precise questions with certainty: "what imports trigger-router.ts?", "what CLI commands are registered?", "what did session X touch?" Built by scripts (ts-morph for TypeScript, equivalent parsers for other languages), never by an LLM. Fast, deterministic, always correct.

**Layer 2: Vector similarity (soft weights, semantic)**
Every node in the structural graph also gets an **embedding** -- a vector encoding its semantic meaning (function name + signature + docstring + surrounding context). Nodes that are semantically similar end up geometrically close in vector space, regardless of whether they have an explicit edge between them.

This layer answers fuzzy questions: "what is conceptually related to this?", "what files implement patterns similar to this one?", "what past sessions are relevant to this bug?" It surfaces things the agent didn't know to look for.

**Together:** the structural graph provides the skeleton; the vector layer provides the connective tissue. An agent query resolves both: exact structural neighbors first, semantically similar nodes ranked by distance second. Per-repo and per-module scoping is handled naturally -- intra-repo edges are hard structural links, cross-repo relevance falls back to vector similarity.

**Technology layers:**

| Layer | Technology | Role |
|-------|-----------|------|
| Structural parsing | ts-morph (TypeScript), tree-sitter (other langs) | Extract hard edges deterministically |
| Structural storage + traversal | DuckDB | Store nodes/edges, recursive reachability queries |
| Vector embeddings | Local embedding model (e.g. `nomic-embed-text` via Ollama, or `@xenova/transformers`) | Encode every node as a vector |
| Vector storage + similarity search | LanceDB (embedded, TypeScript-native) or Qdrant (self-hosted) | ANN search over embeddings |
| Unified query layer | WorkTrain MCP tool | Single `query_knowledge_graph(intent)` call returns merged structural + semantic results |

LanceDB is the strongest fit for the vector layer: embedded (no server process), TypeScript-native, local-first, co-locates vector and metadata in the same store. It pairs cleanly with DuckDB handling the structural/relational queries.

**Build order (spike first, hybrid later):**

The structural layer (ts-morph + DuckDB) is the right first spike because:
1. It answers the immediately valuable questions (wiring checks, import graphs, CLI registration)
2. It produces the nodes that the vector layer will embed -- you can't embed nothing
3. It proves the foundation before adding semantic complexity

Once the structural spike works, add the vector layer: embed each node's name + context, store in LanceDB, expose a similarity query alongside the structural query. The two layers are additive -- the structural layer doesn't get replaced, it gets augmented.

**Per-repo and per-module scoping:**
Each repo gets its own structural graph partition and its own vector namespace. Cross-repo queries join partitions explicitly (structural) or search across namespaces with a distance penalty (semantic). The system handles this automatically once the partition boundaries are defined at index time. Finer-grained module-level scoping falls out naturally from the structural graph -- the subgraph rooted at a module's entry point is the module's partition.

**WorkRail fits:** the graph becomes a new WorkRail source -- `graphSource` alongside `bundledSource`, `userSource`, and `managedSource`. The MCP server exposes `query_knowledge_graph(intent)`. Workflow steps call it instead of running file sweeps. The daemon runs the indexer post-session as a script (structural layer: re-index changed files; vector layer: re-embed changed nodes).

**Cross-project note:** the same architecture applies to any domain pack. Storyforge's graph has narrative nodes (characters, promises, locations) instead of code nodes, and a different parser (YAML/markdown instead of ts-morph), but the same two-layer design -- structural edges + vector embeddings -- gives it both "what chapters does this character appear in?" (structural) and "what story elements are thematically related to this scene?" (semantic).

---

### Knowledge graph candidate research findings (Apr 15, 2026)

Four discovery subagents evaluated Cognee, GraphRAG, LightRAG, Mem0, Zep, Sourcegraph, LSP, ctags, tree-sitter, ts-morph, and DuckDB against a pure relational/structural framing. Findings below, updated with the corrected hybrid architecture understanding.

**Structural layer decision: ts-morph + DuckDB for the spike.**

- **ts-morph**: wraps the real TypeScript Compiler API, not a generic parser. Extracts exports, imports, call sites, class implementations, DI `.bind()` patterns, CLI registration maps. In-process, zero external dependencies. Strictly better than tree-sitter for a TypeScript codebase.
- **DuckDB**: embedded SQL with recursive CTEs. Handles structural reachability queries. No server process. A 1-day spike, not a 2-week project.
- **LSP**: correct answers but requires managing a long-running server process -- wrong operational model.
- **ctags**: definitions only, no call edges. Too shallow.
- **Sourcegraph**: right idea, enterprise weight. Overkill for local daemon use.

**Vector layer decision: LanceDB (deferred to post-spike).**

- **LanceDB**: embedded, TypeScript-native, local-first. Best fit for the vector layer alongside DuckDB.
- **Qdrant**: self-hosted, strong ANN performance. Good alternative if LanceDB proves insufficient at scale.
- **Weaviate**: vector + graph hybrid in one system. Worth revisiting if maintaining two separate stores becomes painful -- it does both layers but is heavier to self-host.

**Why GraphRAG/Cognee/LightRAG don't fit (even with the hybrid architecture):**
These tools use LLMs to *build* the graph -- entity extraction, relationship identification, summarization all require LLM calls during indexing. That violates the scripts-over-agent principle. The structural layer must be deterministic (parser-built); the vector layer uses an embedding model (deterministic given the same input), not a generative LLM. GraphRAG's semantic richness is real but the wrong tradeoff for a system that needs to re-index after every session without burning tokens.

**The spike (structural layer, build now):**
1. `npm install ts-morph @duckdb/node-api`
2. 50-line indexer: `project.getSourceFiles()` → walk exports, imports, call expressions → rows into DuckDB nodes/edges tables
3. One MCP tool: `query_knowledge_graph(query: string)` running SQL, returning a context bundle
4. Validation: "what imports trigger-router.ts?" and "what CLI commands are registered?" must return correct answers

**Post-spike (vector layer):**
1. `npm install vectordb` (LanceDB) + local embedding model via Ollama or `@xenova/transformers`
2. After each structural node is created, embed `name + file + context snippet` → store vector alongside node ID in LanceDB
3. Extend `query_knowledge_graph` to merge: structural neighbors (DuckDB) + semantic neighbors (LanceDB ANN search) → unified ranked context bundle
4. Validate: "what is related to trigger-router.ts?" should surface files not directly imported but implementing the same webhook/routing pattern

**Incremental update model:**
After each daemon session completes, re-index only files in the handoff artifact's `filesChanged` list (structural: ts-morph re-parse; vector: re-embed changed nodes). Full rebuild only on first run or schema changes. Script, not agent.

---

### Polling trigger model: zero-external-config integrations (Apr 15, 2026)

**Problem with webhooks:** GitLab/GitHub webhooks require admin access to the project, a publicly reachable URL, and per-project setup. Three friction points that break the freestanding, zero-config philosophy.

**Solution: polling triggers.** WorkTrain polls external APIs on a schedule instead of waiting for pushes. No external system configuration required -- just a token.

```yaml
# triggers.yml example
triggers:
  - id: new-mrs
    type: gitlab_poll
    source:
      baseUrl: https://gitlab.com
      projectId: 12345
      token: $GITLAB_TOKEN
      events: [merge_request.opened, merge_request.updated]
      pollIntervalSeconds: 60
    workflowId: mr-review-workflow-agentic
    goalTemplate: "Review MR !{{$.iid}}: {{$.title}}"
    workspacePath: ~/git/my-project
```

**What to build:**
1. `PollingTriggerSource` -- new source type alongside existing `generic` (webhook). Fields: `pollIntervalSeconds`, `token`, `baseUrl`, `projectId`, `events`.
2. `PolledEventStore` -- lightweight local state file (`~/.workrail/polled-events.json`) tracking which event IDs have been processed. Prevents re-firing after restart.
3. Polling scheduler in the daemon -- calls `TriggerRouter.dispatch()` directly when a new event is detected. Clean integration, no new routing plumbing.

**Generalizes to all sources without external config:**
- GitHub: poll `/repos/:owner/:repo/pulls`
- Jira: poll `/rest/api/3/search?jql=...`
- Linear: poll GraphQL for new issues
- Slack: poll conversations for pattern matches

**This is the preferred trigger model for external integrations.** Webhooks remain available for high-volume or latency-sensitive use cases, but polling is the default for everything else -- it works behind firewalls, requires no admin access, and fits `worktrain init` naturally (just ask for a token).

**Tradeoff:** up to `pollIntervalSeconds` latency (60s default). Acceptable for MR reviews and most agentic tasks. Not acceptable for real-time chat bots.

**Market research needed before building:**
Several tools in this space worth evaluating before building from scratch:

- **CodeGraph / Tree-sitter based indexes** -- open source, parse-based symbol graphs. Fast to build, no LLM required, but only structural (no semantic edges).
- **Sourcegraph** -- enterprise code search + graph. Well-proven at scale. Question: does it expose an API suitable for agent context bundle queries? Overkill for solo/small team.
- **Microsoft GraphRAG** -- LLM-built knowledge graphs with community detection. Research project, but directly relevant architecture. Slower to build (LLM-driven), richer semantic edges.
- **Cognee** -- open source knowledge graph + RAG, designed for agent workflows. Active project, worth a close look.
- **Mem0** -- agent memory layer with graph backend. Simpler than Cognee but less code-specific.
- **tree-sitter + DuckDB** -- build-it-yourself option: tree-sitter parses symbols + call graph, DuckDB stores and queries. Full control, no external dependency, fits WorkRail's freestanding philosophy.

**Recommended approach:** research Cognee and tree-sitter+DuckDB first. Cognee may already solve 80% of this. If not, tree-sitter+DuckDB is the build path -- it fits the "scripts over agent" principle (the graph is built by a deterministic parser, not by asking an LLM to summarize files).

**WorkRail fits:** the graph is a new WorkRail source -- `graphSource` alongside `bundledSource`, `userSource`, and `managedSource`. The MCP server exposes `query_knowledge_graph` and `update_knowledge_graph` tools. Workflow steps call those tools instead of running file sweeps. The daemon updates the graph after each session completes (script, not agent).

**Cross-project note:** Storyforge will likely need the same graph layer. Worth building it once in WorkRail and making it available to both -- the node/edge schema is different (code vs narrative) but the architecture (derived layer, provenance, context bundles, session-driven updates) is identical.

---

### Knowledge graph candidate research findings (Apr 15, 2026)

Four discovery subagents evaluated Cognee, GraphRAG, LightRAG, Mem0, Zep, Sourcegraph, LSP, ctags, tree-sitter, ts-morph, and DuckDB. Findings were unanimous.

**Decision: ts-morph + DuckDB. Spike it now.**

**Why the others lost:**

- **Cognee**: Python-only SDK, no TypeScript client, no code-aware indexing primitives. Built for document RAG not code graphs. Watch list only.
- **GraphRAG / LightRAG**: Use LLMs to build the graph -- violates the "scripts over agent" principle. Non-deterministic output, expensive, no TypeScript client. Skip.
- **Mem0 / Zep**: Conversational/session memory, not code graphs. Orthogonal problem. Skip for this use case.
- **Sourcegraph**: Enterprise-scale, heavy Docker infrastructure. Overkill for local daemon use. Skip.
- **LSP (typescript-language-server)**: Queryable from Node.js but requires managing a separate long-running process with stdio IPC. Correct answers, wrong operational model for a daemon.
- **universal-ctags**: Definitions only, no call edges or cross-file references. Too shallow.
- **tree-sitter**: Generic parser, good but requires custom TypeScript-specific traversal logic. ts-morph is strictly better for a TypeScript codebase because it uses the real TypeScript compiler.

**Why ts-morph + DuckDB wins:**

- **ts-morph** wraps the TypeScript Compiler API directly -- it understands TypeScript semantics, types, and scopes, not just syntax. Extracts exports, imports, call sites, class implementations, DI `.bind()` patterns, and CLI registration maps out of the box. Runs in-process, zero external dependencies.
- **DuckDB** is embedded SQL with recursive CTE support. Graph reachability queries work today with `WITH RECURSIVE`. Fast, local, no server process.
- Combined: a 1-day spike, not a 2-week project.

**Schema (from subagent):**
```sql
nodes  (id, file, name, kind, scope)
  -- kind: "function" | "class" | "interface" | "constant" | "export" | "di_binding" | "cli_command"

edges  (from_id, to_id, kind, line)
  -- kind: "calls" | "imports" | "exports" | "registers_in" | "provides"

provenance  (node_id, source_file, source_line, session_id, indexed_at)
```

**Reachability query example:**
```sql
WITH RECURSIVE reachable AS (
  SELECT id FROM nodes WHERE name = 'executeVersionCommand'
  UNION ALL
  SELECT e.to_id FROM edges e JOIN reachable r ON e.from_id = r.id
)
SELECT n.* FROM nodes n WHERE n.id IN (SELECT id FROM reachable);
```

**The spike (what to build first):**
1. `npm install ts-morph @duckdb/node-api` -- both are available today
2. Write a 50-line indexer: `project.getSourceFiles()` → walk exports, imports, and call expressions → emit rows to DuckDB nodes/edges tables
3. Write one MCP tool: `query_knowledge_graph(query: string)` that runs SQL and returns a context bundle
4. Test it against the WorkRail `src/` directory: can it answer "what imports trigger-router.ts?" and "what CLI commands are registered?"

If the spike answers those two questions correctly, the foundation is proven and we build out incrementally from there.

**Incremental update model (post-spike):**
After each daemon session completes, run the indexer only on files that appear in the session's `filesChanged` list (from the handoff artifact). Full re-index only on first run or when the schema changes. This is a script the daemon runs post-workflow, not an agent task.

---

### Dynamic pipeline composition: task maturity determines the workflow mix (Apr 15, 2026)

**The insight:** not all tasks are equal in how much work is needed before implementation. A raw idea needs a completely different pipeline than a fully-specced ticket with BRD and designs. WorkTrain should compose the pipeline dynamically based on what already exists, not always run the same fixed set of phases.

**The maturity spectrum:**

```
Raw idea                                                    Fully specced
    │                                                              │
    ▼                                                              ▼
"it would be nice if..."        "here's the BRD, designs,    "fix this bug in
                                 acceptance criteria, and     file X, line Y"
                                 ticket with all context"
```

**What changes at each maturity level:**

| What exists | Pipeline additions |
|-------------|-------------------|
| Nothing -- just an idea | ideation → market research → feasibility → scope definition → spec authoring → design → ticket creation → then all of implementation phases |
| Rough spec or ticket | clarify requirements → design → then implementation |
| BRD + designs | architecture review → implementation |
| BRD + designs + arch decision | implementation only |
| Fully specced + arch decided | coding → review → audit → verify |
| Code written, needs validation | review → audit → test → verify |

**How classify-task-workflow learns maturity:**
The classify step doesn't just classify complexity and risk -- it also assesses maturity:
- `taskMaturity`: idea / rough / specced / ready / code-complete
- `existingArtifacts`: which of [brd, designs, arch-decision, acceptance-criteria, ticket, implementation] exist
- `missingArtifacts`: what needs to be created before implementation can begin

The coordinator script uses `taskMaturity` and `missingArtifacts` to prepend the right phases to the pipeline.

**New workflows needed for the early phases:**

| Workflow | Purpose |
|----------|---------|
| `ideation-workflow` | Expand a raw idea into a structured opportunity: problem statement, user value, rough scope, open questions |
| `market-research-workflow` | Research whether this problem is solved elsewhere, what competitors do, what patterns exist |
| `spec-authoring-workflow` | Author a BRD/PRD from scratch: user stories, acceptance criteria, non-goals, success metrics |
| `ticket-creation-workflow` | Break a spec into actionable tickets with proper sizing and dependencies |
| `grooming-workflow` | Review a spec or ticket for completeness, edge cases, and implementation readiness |

**The full lifecycle pipeline for a raw idea:**
```
idea → ideation → market research → spec authoring → grooming/validation
     → design (if hasUI) → architecture → ticket creation
     → for each ticket: implementation pipeline
     → integration testing → production audit → ship
```

**The key design:** the coordinator script drives all of this. It checks what artifacts exist, decides which phases to run, spawns workers for each phase in the right order, and gates on artifacts before proceeding. No human needed to manage the pipeline -- the maturity assessment tells the coordinator exactly what to do.

**Context from today's session as evidence:** we've been doing exactly this manually -- ideas emerged in conversation (coordinator sessions, message queue, knowledge graph), we groomed them into backlog items, the backlog items have varying levels of completeness, and different agents are running different phases based on where each item is in the lifecycle. WorkTrain should own this entire flow.

---

### Verification and proof as first-class citizens (Apr 15, 2026)

**The problem:** today there's no single place that tells you "here's everything that was done to verify this feature is correct." Tests pass, a review ran, an audit happened -- but it's scattered across session notes, PR descriptions, CI logs, and half-remembered conversations. No verification chain.

**The vision:** every shipped change has a **proof record** -- a structured document that answers: what was built, how was it verified, by whom (which agents), and what was the verdict at each gate. Not a summary for humans -- a queryable record that the coordinator and watchdog can use to enforce quality gates and answer questions like "has this module been production-audited in the last 30 days?"

**What a proof record contains:**

```json
{
  "prNumber": 402,
  "goal": "auto-commit and auto-PR daemon feature",
  "verificationChain": [
    {
      "kind": "unit_tests",
      "outcome": "pass",
      "coverage": "14 tests, delivery-action.ts covered",
      "sessionId": "sess_abc123",
      "timestamp": "2026-04-15T22:00:00Z"
    },
    {
      "kind": "mr_review",
      "outcome": "request_changes",
      "findings": [{ "severity": "Major", "id": "F1", "description": "shell injection via exec()" }],
      "sessionId": "sess_def456",
      "timestamp": "2026-04-15T22:10:00Z"
    },
    {
      "kind": "mr_review",
      "outcome": "approve",
      "findings": [],
      "sessionId": "sess_ghi789",
      "timestamp": "2026-04-15T23:00:00Z"
    },
    {
      "kind": "production_audit",
      "outcome": "pass",
      "sessionId": "sess_jkl012",
      "timestamp": "2026-04-15T23:05:00Z"
    }
  ],
  "gates": {
    "unit_tests": "pass",
    "mr_review": "approved",
    "production_audit": "pass",
    "architecture_audit": "skipped (riskLevel=Medium)"
  },
  "overallVerdict": "verified",
  "mergedAt": "2026-04-15T23:15:00Z"
}
```

**Verification gates the coordinator enforces:**

| Gate | Required for | Trigger |
|------|-------------|---------|
| Unit tests pass | All changes | After coding, before review |
| MR review approved (no Critical/Major) | All changes | After unit tests |
| Architecture audit | `touchesArchitecture=true` or `riskLevel=High` | Before coding |
| Production audit | `riskLevel=High` or affects prod paths | After coding |
| Integration tests | `taskComplexity=Large` | After all slices |
| Performance audit | touches hot paths | After coding |
| Security audit | touches auth/input/external | After coding |

No PR merges without passing all required gates for its classification. The coordinator enforces this -- not as a suggestion, but as a hard gate in the script.

**Visibility surfaces:**

1. **Console PR view** -- shows the full verification chain for any merged or open PR. Expandable: click any gate to see the session notes from that review.

2. **Module health dashboard** -- per module (e.g. `src/trigger/`, `src/daemon/`), shows: last MR review date, last production audit date, test coverage, open findings. Answers "is this module production-ready right now?"

3. **`worktrain verify <pr-number>`** -- command that checks whether a PR has passed all required gates for its classification. Output: pass/fail per gate, with session links.

4. **Proof record in every PR description** -- auto-generated section: "Verification chain: ✅ 14 unit tests | ✅ MR review (0 findings) | ✅ Production audit | ⏭ Architecture audit (skipped: riskLevel=Low)"

**Why this matters:**
Right now, "has this been reviewed and audited?" is a question that requires reading through PRs and session notes. With proof records, it's a query: `SELECT * FROM proof_records WHERE module='src/trigger/' AND kind='production_audit' AND outcome='pass' AND timestamp > NOW()-30days`. The knowledge graph stores these records. The watchdog checks them on a schedule. The coordinator gates on them before merging. Verification becomes infrastructure, not process.
---

### Scripts-first coordinator: avoid the main agent wherever possible (Apr 15, 2026)

**The insight:** In the coordinator workflow we built manually today, the main agent spent most of its time on mechanical work -- reading PR lists, checking CI status, deciding whether findings are blocking, sequencing merges. That's all deterministic logic. An LLM is expensive, slow, and inconsistent for deterministic work.

**The principle extended to coordinators:** the scripts-over-agent rule applies at the coordinator level too. The coordinator's job is to drive a DAG of child sessions. The DAG structure, routing decisions, and termination conditions should be scripts, not LLM reasoning.

**What this means concretely:**

Instead of a coordinator *agent* that reads MR review findings and decides what to do, use a **coordinator script** that:
1. Calls `gh pr list` → list of PRs (script)
2. For each PR, calls `spawn_session(mr-review-workflow-agentic)` → session handles (script)
3. Calls `await_sessions(handles)` → structured findings (script waits)
4. Parses the findings JSON block from each session's output (script)
5. Routes: clean → merge queue, minor → spawn fix agent, blocking → escalate (script decision tree)
6. Calls `spawn_session(coding-task-workflow-agentic, fix: <finding>)` for each fix needed (script)
7. Awaits fix agents, re-queues for re-review (script loop)
8. Executes merge sequence when queue is empty (script)

The agent is only invoked for the *leaf work* -- the actual MR review, the actual coding fix. All coordination, routing, sequencing, and decision-making is a script.

**What the coordinator workflow looks like under this model:**

Not a workflow that a single LLM session runs end-to-end. Instead, a **script-driven workflow** where each step is a shell/TypeScript script that calls WorkTrain's API to spawn/await child sessions and route based on their structured outputs. WorkTrain provides:
- `worktrain spawn --workflow <id> --goal <text>` → prints sessionHandle
- `worktrain await --sessions <handle1,handle2>` → prints structured results JSON
- `worktrain merge --pr <number>` → runs the merge sequence

The coordinator "workflow" is then a shell script or TypeScript file that composes these commands. Fully deterministic, fully auditable, no tokens burned on routing decisions.

**Why this is better than a coordinator agent:**
- Zero LLM cost for coordination -- only leaf sessions burn tokens
- Fully deterministic routing -- the same PR list always produces the same execution plan
- Trivially auditable -- `set -x` on the shell script shows every decision
- Trivially testable -- mock `worktrain spawn` and `worktrain await`, test the routing logic in isolation
- Reusable across teams -- share the script, not the prompt

**Build order for this model:**
1. `worktrain spawn` / `worktrain await` CLI commands that wrap the session engine
2. Structured output format for leaf sessions (the handoff artifact JSON block already exists)
3. A reference `coordinator-groom-prs.sh` (or `.ts`) as the first coordinator template
4. Console DAG view updated to show coordinator-script-spawned sessions with parent-child relationships

**The long-term vision:** WorkTrain workflows handle the hard cognitive work. WorkTrain scripts handle orchestration, routing, and sequencing. Together they make the system fully autonomous with full observability and zero wasted tokens.

---

### Full development pipeline: coordinator scripts drive multi-phase autonomous work (Apr 15, 2026)

The coordinator isn't just for review → fix → merge. The full pipeline we run manually covers every phase of software development, with different phases triggered based on task classification.

**Full pipeline DAG:**

```
trigger: "implement feature X"
  │
  ├── [always] classify-task
  │     outputs: taskComplexity, riskLevel, hasUI, touchesArchitecture
  │
  ├── [if taskComplexity != Small] discovery
  │     workflow: routine-context-gathering (COMPLETENESS + DEPTH in parallel)
  │     outputs: context bundle, candidate files, invariants
  │
  ├── [if hasUI] ux-design
  │     workflow: ux-design-workflow (mockups, component spec, interaction model)
  │     outputs: design-spec.md, component-list
  │
  ├── [if touchesArchitecture] architecture-design
  │     workflow: coding-task-workflow-agentic (design phases only)
  │     outputs: design-candidates.md, selected approach
  │     └── arch-review (parallel, 2 auditors)
  │           workflow: routine-hypothesis-challenge + routine-philosophy-alignment
  │           outputs: findings → revise design if RED/ORANGE
  │
  ├── [always] coding-task
  │     workflow: coding-task-workflow-agentic
  │     inputs: context bundle + design spec + arch decision
  │     outputs: implementation + handoff artifact (commitType, prTitle, filesChanged)
  │
  ├── [always] mr-review
  │     workflow: mr-review-workflow-agentic
  │     outputs: findings with severity
  │     ├── [if clean] → auto-commit → auto-pr → merge
  │     ├── [if Minor/Nit] → spawn fix agent → re-review (max 3 passes)
  │     └── [if Critical/Major] → escalate to human (Slack/GitLab comment)
  │
  ├── [if riskLevel == High] prod-risk-audit
  │     workflow: production-risk-audit-workflow
  │     outputs: go / no-go + risk register
  │     └── [if no-go] → escalate, block merge
  │
  └── [if merged] notify
        script: post summary to Slack/GitLab with session DAG link
```

**The key insight:** the coordinator script reads the `taskComplexity`, `riskLevel`, `hasUI`, and `touchesArchitecture` flags from the classify step's output and uses them to decide which phases to spawn. A one-line bug fix runs: classify → coding-task → mr-review. A new UI feature runs everything. The same coordinator script handles both -- the DAG is dynamic, driven by structured outputs.

**Workflow library needed (not all exist yet):**

| Workflow | Status |
|----------|--------|
| `coding-task-workflow-agentic` | ✅ `coding-task-workflow-agentic.lean.v2.json` |
| `mr-review-workflow-agentic` | ✅ `mr-review-workflow.agentic.v2.json` |
| `routine-context-gathering` | ✅ `routines/` |
| `routine-hypothesis-challenge` | ✅ `routines/` |
| `routine-philosophy-alignment` | ✅ `routines/` |
| `ux-design-workflow` | ✅ `ui-ux-design-workflow.json` |
| `production-risk-audit-workflow` | ✅ `production-readiness-audit.json` |
| `architecture-review-workflow` | ✅ `architecture-scalability-audit.json` |
| `bug-investigation-workflow` | ✅ `bug-investigation.agentic.v2.json` |
| `discovery-workflow` | ✅ `wr.discovery.json` |
| `classify-task-workflow` | ❌ needs authoring -- fast, 1-step, outputs taskComplexity/riskLevel/hasUI/touchesArchitecture |

**The classify step is the gate.** A cheap, fast workflow that takes a task description and returns structured vars. This is where the coordinator decides what to run. It's the single most important missing workflow -- without it, the coordinator has to spawn everything for every task, which is wasteful.

**The coordinator script for this pipeline:**
```typescript
// coordinator-implement-feature.ts
const { taskComplexity, riskLevel, hasUI, touchesArchitecture } =
  await runWorkflow('classify-task-workflow', { goal: taskDescription });

const contextHandle = taskComplexity !== 'Small'
  ? spawnSession('routine-context-gathering', { goal: taskDescription })
  : null;

const uxHandle = hasUI
  ? spawnSession('ux-design-workflow', { goal: taskDescription })
  : null;

const [context, uxSpec] = await awaitSessions([contextHandle, uxHandle]);

// ... arch design if needed, then coding, then review, then audit
```

Zero coordinator LLM calls. Every decision is a script condition on structured output.

**Audit workflows the coordinator can chain:**
Beyond MR review, the same pattern applies to any quality gate:
- **Production risk audit** -- scans for: exposed secrets, missing rate limits, no-rollback schema changes, unguarded env vars
- **Architecture audit** -- scans for: coupling violations, missing abstractions, incorrect layer dependencies
- **Test coverage audit** -- identifies untested paths on changed files
- **Performance audit** -- scans for N+1 queries, missing indexes, unbounded loops on hot paths
- **Security audit** -- OWASP top 10 scan on changed surfaces

Each is a workflow. The coordinator decides which to run based on `riskLevel`, what files changed, and what domain the task touches. All feed findings back to the coordinator script which routes: fix, skip, or escalate.

---

### Additional coordinator pipeline templates (Apr 15, 2026)

Beyond the feature implementation pipeline, three more coordinator templates are high value:

---

#### Backlog grooming coordinator

```
trigger: "groom backlog" (cron: weekly, or manual dispatch)
  │
  ├── [for each open issue] classify-issue
  │     outputs: issueType (bug/feature/tech-debt/question), priority, complexity, stale?
  │
  ├── [for stale issues > 90 days with no activity] auto-close-or-ping
  │     script: post "Still relevant?" comment, label as stale
  │
  ├── [for unclassified issues] label-and-size
  │     script: apply labels (bug/enhancement/question), size estimate (XS/S/M/L)
  │
  ├── [for duplicate issues] detect-duplicates
  │     workflow: semantic search over existing issues, flag likely dupes
  │     script: comment "possible duplicate of #X", label as needs-triage
  │
  ├── [for high-priority bugs with no assignee] suggest-fix-approach
  │     workflow: bug-investigation-agentic (surface root cause + candidate fix)
  │     outputs: investigation summary posted as issue comment
  │
  └── produce grooming summary
        script: post weekly digest to Slack -- issues triaged, dupes found, investigations run
```

No human needed for any of this. The coordinator classifies, labels, pings stale items, and runs investigations on the important ones. The human reviews the digest and acts on what needs judgment.

---

#### Bug investigation + fix coordinator

```
trigger: new issue labeled "bug" OR incident alert from monitoring
  │
  ├── bug-investigation-agentic
  │     outputs: root cause hypothesis, affected files, severity, reproduction steps
  │
  ├── [if severity == Critical] page-oncall
  │     script: post to Slack #incidents with investigation summary + session link
  │
  ├── [if severity <= High and hypothesis_confidence >= 0.8] attempt-fix
  │     workflow: coding-task-workflow-agentic (targeted fix)
  │     inputs: investigation findings, affected files, reproduction steps
  │     outputs: implementation + handoff artifact
  │     │
  │     ├── mr-review
  │     │     └── [if clean] auto-commit → auto-pr
  │     │
  │     └── regression-test
  │           script: run test suite against affected paths
  │           outputs: pass/fail
  │
  ├── [if severity == Critical OR hypothesis_confidence < 0.8] escalate
  │     script: post investigation summary to issue + tag team lead
  │
  └── close-or-update-issue
        script: if fix merged → close with "Fixed in PR #X". if escalated → update with findings.
```

The daemon can go from "bug filed" to "fix merged" with zero human involvement for well-understood bugs with high-confidence hypotheses. Critical bugs and uncertain root causes always escalate to a human -- the investigation is done for them, not by them.

**What makes this work:**
- `bug-investigation-agentic` already exists and produces structured findings
- The `hypothesis_confidence` output from the investigation gates the auto-fix attempt
- The coordinator script decides: high confidence + not critical = try to fix autonomously
- The circuit breaker (max 3 fix attempts) prevents infinite loops on hard bugs
- The human always gets the investigation findings, whether the fix succeeded or not

---

#### Incident monitoring coordinator

```
trigger: monitoring alert (CPU spike, error rate increase, latency P99 > threshold)
  │
  ├── triage-alert
  │     workflow: classify if real incident vs noise (check recent deploys, known issues)
  │     outputs: isRealIncident, likelyCause, affectedServices
  │
  ├── [if isRealIncident] investigate
  │     workflow: bug-investigation-agentic (logs, traces, recent changes)
  │     outputs: root cause, blast radius, mitigation options
  │
  ├── [if mitigation is config change or rollback] auto-mitigate
  │     script: execute safe mitigations (feature flag flip, config change)
  │     -- NEVER auto-rollback code without human approval
  │
  ├── page-oncall
  │     script: post to Slack #incidents with full context + session DAG link
  │     content: what fired, what was found, what was auto-mitigated, what needs human action
  │
  └── follow-up
        cron: 30 min later → check if resolved, post update
```

The operator gets paged with a complete picture: what happened, likely why, what was already done automatically, and exactly what decision they need to make. No more waking up to an alert with no context.

---

### Interactive ideation: WorkTrain as a thinking partner with full project context (Apr 15, 2026)

**What this is:** The ability to have a conversation with WorkTrain the way we've been talking today -- bouncing ideas, asking "what if", surfacing tradeoffs, refining designs -- and have WorkTrain respond with full awareness of what's been built, what's in flight, what's in the backlog, and what decisions were made and why.

Today this requires a human (Claude Code + a long conversation) to maintain context across everything. WorkTrain should be able to do this natively because it already has:
- The session store (every step note from every session ever run)
- The knowledge graph (structural understanding of the codebase)
- The backlog (design decisions, research findings, priorities)
- In-flight agent state (what's running, what's been found)

**The gap:** there's no conversational interface that pulls all of this together. The console shows sessions. The backlog is a markdown file. There's no "talk to WorkTrain about the project" entry point.

**What it needs:**

1. **A "talk" command** -- `worktrain talk` opens an interactive session that starts with a synthesized context bundle: recent session outcomes, open PRs, backlog top items, any findings from in-flight agents. The user types naturally; WorkTrain responds with awareness of all of it.

2. **Project memory** -- WorkTrain maintains a synthesized "project state" that's updated after each coordinator run or major session batch. Answers questions like: "what did we build today?", "why did we choose polling triggers over webhooks?", "what's the biggest gap right now?", "what would happen if we removed pi-mono?" without requiring the user to re-explain context.

3. **Idea capture** -- when the conversation surfaces something new (a gap, an architectural insight, a design decision), WorkTrain should offer to record it to the backlog or open a GitHub issue immediately, right from the conversation.

4. **Context awareness** -- WorkTrain knows which agents are running, what they've found so far, and can report on it during a conversation: "the #400 review just came back with a fetch timeout blocker -- want me to queue a fix agent?"

**What makes this different from just using Claude Code:** Claude Code has no persistent project context -- every conversation starts from scratch. WorkTrain's ideation session starts with everything loaded: session history, knowledge graph results for relevant files, backlog items, open PRs. The conversation is grounded in the actual project state, not just what the user remembers to paste in.

**Architecture:** this is a new `talk` workflow -- a conversational loop workflow with no fixed step count. The agent has access to `query_knowledge_graph`, `read_session_notes`, `read_backlog`, `list_in_flight_agents`, and `append_to_backlog` as tools. It maintains the conversation as a standard message history. The session never "completes" -- it ends when the user exits.

---

### Automatic gap and improvement detection: proactive WorkTrain (Apr 15, 2026)

**What this is:** WorkTrain notices things without being asked. After a batch of work lands, it scans for gaps, inconsistencies, missed connections, and improvement opportunities -- and surfaces them proactively.

**Examples of what it would have caught today without human prompting:**
- "PR #400 delivery client has no fetch timeout -- delivery could hang indefinitely" (caught by MR review, but WorkTrain could catch this pre-review)
- "PR #391 picked up GAP-1 crash recovery code it shouldn't have -- scope leak" (caught by the reviewer)
- "The backlog says knowledge graph should be persistent but the spike uses in-memory DuckDB" (gap between spec and impl)
- "Three open PRs all modify workflow-runner.ts -- they're going to conflict when merged sequentially"
- "Issue #393 filed for loadSessionNotes coverage -- this is related to the GAP-2 PR that's open, might as well fix both together"
- "The classify-task-workflow was just authored but it's not referenced in the coordinator spec yet"

**Two modes:**

**1. Event-triggered scans** -- fires after significant events:
- After a batch of PRs merge: scan for spec/impl gaps, check if any backlog items are now addressable
- After a new workflow is authored: check if it should be added to the coordinator pipeline
- After a bug is filed: check if any recent changes are likely culprits
- After a coordinator run: check if findings surfaced any architectural concerns not in the backlog

**2. Periodic health checks** -- runs on a schedule (e.g. weekly):
- Are there backlog items that have all their prerequisites met but haven't been started?
- Are there open issues that are actually already fixed by merged PRs?
- Are there PRs that have been approved but not merged for more than N days?
- Is the knowledge graph stale (files changed since last index)?
- Are any daemon sessions orphaned (in daemon-sessions/ but older than 24h)?

**Architecture:** a `watchdog` workflow that runs on a cron trigger. It queries the knowledge graph, reads recent session notes, lists open PRs and issues, reads the backlog priorities, and produces a `gap-report.md` with actionable findings. Each finding is either: auto-actionable (spawn a fix agent), conversation-worthy (add to the ideation queue), or escalation-worthy (post to Slack/file a GitHub issue).

**The key difference from the coordinator:** the coordinator executes a known plan. The watchdog discovers things that aren't in any plan yet. It's the system's immune response -- continuously scanning for drift between intention and reality.

**What makes this tractable:** WorkTrain already has all the inputs. The knowledge graph has the structural state. The session store has the history. The backlog has the intentions. The gap detection is the synthesis layer that connects them -- "what was planned" vs "what was built" vs "what's in flight". This is exactly the kind of thing an LLM is good at: cross-referencing multiple sources and identifying inconsistencies.

---

### Dynamic model selection: right model for the right task (Apr 15, 2026)

**The principle:** not every task needs Sonnet 4.6. Not every task should be locked to Anthropic. The coordinator and the task classifier should be able to select the model dynamically based on what the task actually needs.

**Why this matters:**
- **Cost**: classification, simple routing decisions, and status checks don't need a frontier model. A fast cheap model (Haiku) costs ~20x less and is fast enough for deterministic tasks.
- **Quality ceiling**: some tasks (complex architecture decisions, multi-file refactors) benefit from the best available model regardless of cost.
- **Provider flexibility**: Anthropic goes down, pricing changes, a new provider releases a better model. Being locked to one provider is an operational risk and a competitive disadvantage.
- **Specialization**: some models are better at specific tasks -- code generation, reasoning, multimodal (if designs/screenshots are involved).

**Model selection in triggers.yml:**
```yaml
triggers:
  - id: mr-review
    workflowId: mr-review-workflow.agentic.v2
    agentConfig:
      model: claude-sonnet-4-6          # explicit override
      provider: anthropic               # or: amazon-bedrock, openai, gemini

  - id: classify-task
    workflowId: classify-task-workflow
    agentConfig:
      model: claude-haiku-4-5           # fast + cheap for classification
      provider: amazon-bedrock

  - id: architecture-design
    workflowId: architecture-scalability-audit
    agentConfig:
      model: claude-opus-4-6            # best available for high-stakes design
      provider: anthropic
```

**Model selection in the classifier output:**
The classify-task-workflow can output a `recommendedModel` var alongside the pipeline:
- `Small + Low` → Haiku (fast, cheap)
- `Medium + Medium` → Sonnet (balanced)
- `Large + High` or `touchesArchitecture=true` → Opus (best quality)

The coordinator script reads `recommendedModel` from the classifier and passes it as `agentConfig` when spawning child sessions.

**Provider abstraction (already partially built):**
The Bedrock integration (`src/daemon/pi-mono-loader.ts` / first-party agent loop in progress) already handles Anthropic vs Bedrock. The abstraction needs to extend to:
- **OpenAI** -- GPT-4o, o3 (useful for reasoning-heavy tasks)
- **Google Gemini** -- Gemini 1.5 Pro (strong at long-context, multimodal)
- **Ollama** -- local models (air-gapped environments, cost-zero for classification tasks)
- **Any OpenAI-compatible API** -- covers most new providers automatically

**Implementation path:**
The first-party agent loop (in progress, PR TBD) is the right place to implement the provider abstraction. Instead of hardcoding the Anthropic SDK, it accepts a provider client that conforms to the Anthropic messages API format (which most providers support via compatibility layers). The `agentConfig.provider` and `agentConfig.model` fields are already in `TriggerDefinition` (added in GAP-8 / PR #397) -- the loop just needs to instantiate the right client.

**Cost optimization opportunity:**
With model routing, a full development pipeline becomes significantly cheaper:
- classify-task: Haiku (~$0.002)
- discovery: Sonnet (~$0.05)
- coding: Sonnet (~$0.20)
- mr-review: Sonnet (~$0.10)
- production-audit: Sonnet (~$0.08)
- architecture (if needed): Opus (~$0.50)

vs today where everything runs on Sonnet by default. For a typical Medium task, model routing saves ~60% cost with no quality loss on the lightweight phases.

---

### Native multi-agent orchestration: coordinator sessions + session DAG (HIGH PRIORITY, Apr 15, 2026)

**The problem:** Everything we can do manually today -- spawn parallel agents, chain discovery→implement→review→fix, react to findings, merge when clean -- WorkTrain should be able to do natively, fully autonomously, with full observability, and without any user feedback.

Today this requires a human (or Claude Code) to:
- Read completion notifications
- Interpret findings
- Decide what follow-up agents to spawn
- Track which PRs are clean vs need fixes
- Trigger the merge sequence when everything is ready

None of that should require a human. It's all policy that belongs in a coordinator workflow.

---

#### New primitives required

**`spawn_session` tool** (available inside workflow steps)
Starts a child session with a given workflowId + goal. Non-blocking -- returns a `sessionHandle` immediately. The coordinator continues executing the current step.

```typescript
spawn_session({
  workflowId: 'mr-review-workflow-agentic',
  goal: `Review PR #${prNumber}: ${prTitle}`,
  workspacePath: '/path/to/repo',
  context: { prNumber, prTitle, prDiff }
}) → { sessionHandle: 'sess_abc123' }
```

**`await_sessions` tool** (available inside workflow steps)
Blocks until one or all of a set of session handles complete. Returns their results and output artifacts (notes, handoff artifacts, MR review findings).

```typescript
await_sessions({
  handles: ['sess_abc123', 'sess_def456'],
  mode: 'all'  // or 'any'
}) → [{ handle, result, outputs: { notes, findings, artifacts } }]
```

**Coordinator session type**
A session that owns child sessions. Parent-child relationship stored in the session store. Killing a coordinator kills all its children. The console DAG view shows the full tree.

**Result routing**
Child session outputs are automatically available when `await_sessions` resolves -- the coordinator doesn't manually query the session store.

---

#### Coordinator workflow pattern

A coordinator workflow uses a `while` loop step with `spawn_session` + `await_sessions` to drive a dynamic DAG:

```
Phase 1: Gather work items (e.g. open PRs, open issues, failing tests)
Phase 2: Spawn workers in parallel (one per work item)
Phase 3: Await all workers
Phase 4: Classify results
  - Clean items: queue for merge/close
  - Items with findings: spawn fix agents
  - Items with blockers: escalate to human (fire onComplete notification)
Phase 5: Await fix agents, re-review if needed (circuit breaker: max 3 attempts)
Phase 6: Execute final action (merge sequence, create summary, post to Slack)
```

This is what we did manually all day. It should be a workflow anyone can run with a single trigger.

---

#### Observability: session DAG view in console

The QueuePane shows a flat list today. For coordinator workflows it must show a tree:

```
● coordinator: groom and fix all PRs          [running, 47 min]
  ├── ✓ sess_abc: GAP-1 implement             [merged, 18 min]
  ├── ✓ sess_def: GAP-1 MR review             [approved, 4 min]
  ├── ✓ sess_ghi: GAP-6 implement             [merged, 12 min]
  ├── ● sess_jkl: GAP-6 MR review fix         [running, 3 min]
  │     └── ✓ sess_mno: GAP-6 findings fix    [complete, 8 min]
  └── ✓ sess_pqr: TS6 tsconfig fix            [merged, 6 min]
```

Each node: status icon, workflow type, goal snippet, duration. Expand to see step notes. Parent-child edges visible. Critical path highlighted.

---

#### No-user-feedback policy logic

The coordinator workflow encodes the policy as workflow step instructions:

- **Critical/Major finding** → block merge, spawn fix agent, re-review (max 3 passes), escalate if still failing
- **Minor finding** → spawn fix agent if auto-fixable, else log and proceed
- **Nit** → log, proceed without fix
- **Clean** → queue for merge
- **Merge sequence** → serial (one at a time, pull before each merge to avoid conflicts)
- **Circuit breaker** → after 3 failed fix attempts on same finding, post to Slack/GitLab and pause

This policy lives in the coordinator workflow, not in the daemon code. Different teams can have different policies by using different coordinator workflows.

---

#### What this unlocks

A single trigger fires the entire development cycle autonomously:

```yaml
# triggers.yml
- id: daily-grooming
  type: cron
  schedule: "0 9 * * 1-5"   # 9am weekdays
  workflowId: coordinator-groom-and-ship
  goal: "Review all open PRs, fix findings, merge clean PRs, file issues for blockers"
  workspacePath: ~/git/my-project
  autoCommit: true
  autoOpenPR: true
```

WorkTrain wakes up at 9am, reviews every open PR, fixes everything it can, merges what's clean, posts a summary to Slack, and files GitHub issues for anything that needs human judgment. No human involved unless the circuit breaker fires.

---

#### Build order

1. **`spawn_session` + `await_sessions` tools** -- the core primitives. These are new MCP tools exposed to workflow steps, backed by a new `SpawnedSessionRegistry` in the DI container.
2. **Parent-child session relationship in session store** -- `parentSessionId` field on session creation event.
3. **Console DAG view** -- new `CoordinatorView` component that renders the session tree from the parent-child graph.
4. **Coordinator workflow templates** -- `coordinator-groom-and-ship`, `coordinator-review-all-prs`, `coordinator-investigate-and-fix` as bundled workflows.
5. **No-feedback policy encoding** -- document the MR review finding classification schema so coordinator workflows can reliably parse and act on it.

**This is the most important architectural work remaining in WorkTrain.** Everything else -- polling triggers, onboarding, knowledge graph -- makes WorkTrain better. This makes it genuinely autonomous.

---

### Message queue: async communication with WorkTrain from anywhere (Apr 15, 2026)

**The problem:** working with WorkTrain today requires you to be in the terminal, watching notifications, responding in real time. But the most valuable moments are often asynchronous -- you have a thought at 2am, want to redirect a running agent from your phone, or want to queue a direction before the current batch finishes.

**The design:** a persistent message queue that decouples when you send a message from when WorkTrain acts on it.

```bash
worktrain tell "skip the architecture review for the polling triggers PR, it's low risk"
worktrain tell "add knowledge graph vector layer to next sprint"
worktrain tell "stop the worktrain-init agent, I changed my mind on the UX"
```

Each command appends to `~/.workrail/message-queue.jsonl` (append-only, one JSON line per message). The daemon drains the queue between agent completions -- never mid-run, always at a natural break point. Messages are delivered in order and never lost across restarts.

**What the queue enables:**

- **Direction changes while agents run** -- "actually, use polling not webhooks" can be queued while 6 agents are running; the coordinator picks it up before spawning the next batch
- **Mobile input** -- a mobile app (or simple HTTP endpoint) writes to the queue; WorkTrain processes when ready
- **Async ideation** -- thoughts queued whenever they occur, not forced into a synchronous conversation window
- **Stop/pause signals** -- `worktrain tell "pause after current batch"` is queue-delivered; coordinator checks for pause signals before each spawn
- **Priority override** -- `worktrain tell "prioritize the shell injection fix, it's blocking"` bumps a task to the front of the coordinator's work list

**Outbox (WorkTrain → user):**
The same pattern in reverse. WorkTrain appends notifications to `~/.workrail/outbox.jsonl` -- agent completions, findings that need human judgment, questions that require a decision. A mobile client polls this file (or an HTTP SSE endpoint wraps it) and pushes to the user's phone. The user reads the notification, taps a response, it goes into the message queue. Full async loop with no real-time presence required.

**Architecture:**
- `~/.workrail/message-queue.jsonl` -- inbound, append-only, drained in order
- `~/.workrail/outbox.jsonl` -- outbound, append-only, read by clients
- `worktrain tell <message>` CLI command -- appends to message-queue
- `worktrain inbox` CLI command -- reads unread outbox items
- Coordinator loop checks message-queue at the start of each cycle before spawning new agents
- The `talk` session (interactive ideation) consumes from the same queue -- seamless transition between async messages and live conversation

**This is the foundation for mobile monitoring.** The mobile app is just a client that reads outbox and writes to message-queue. No new daemon capability needed -- just a thin client over these two files.

---

### Autonomous merge: WorkTrain approves and merges its own PRs after full vetting (Apr 15, 2026)

**The idea:** after the full verification chain passes (unit tests, MR review clean, all required audits green), WorkTrain runs `gh pr review --approve && gh pr merge --squash` itself. No human needed in the loop for PRs that pass all gates.

**This is already mostly built.** The coordinator script already calls `gh pr merge` -- we've been doing it today. The gap is formalizing the policy that makes auto-merge safe: what gates must pass, what findings are acceptable, and what always requires a human.

---

#### The auto-merge policy (what makes it safe)

**Auto-merge allowed when ALL of:**
- All required verification gates pass (defined by task classification)
- MR review: 0 Critical, 0 Major findings
- If `riskLevel=High`: production audit also passes
- If `touchesArchitecture=true`: architecture audit also passes
- CI is green (all required checks pass)
- No `needs-human-review` label on the PR
- The PR is not to a protected branch that requires human approval (configurable)

**Auto-merge blocked when ANY of:**
- Any Critical or Major finding in any review/audit
- CI is failing
- The PR was authored by a human (WorkTrain only auto-merges its own PRs)
- The PR touches security-sensitive paths (auth, credentials, network exposure) -- configurable blocklist
- Circuit breaker has fired (3+ fix attempts on same finding = escalate to human)
- `riskLevel=Critical` (always human approval for highest-risk changes)

**Human always required for:**
- Schema changes (breaking changes to public API contracts)
- Dependency upgrades (major version)
- Infrastructure/CI/CD changes
- Changes to WorkTrain's own merge policy
- Anything the watchdog flags as a drift-from-spec

---

#### Implementation

This is a coordinator script policy, not a new capability. The required pieces:

1. **Proof record gates** (in progress -- verification chain spec) -- the coordinator checks the proof record before calling merge
2. **`--admin` merge bypass for CI false positives** -- already used today; coordinator should note when it uses `--admin` and why
3. **`needs-human-review` label escape hatch** -- any human can block auto-merge by adding this label; WorkTrain respects it
4. **Merge audit log** -- every auto-merge appended to `~/.workrail/merge-log.jsonl`: which PR, which gates passed, which were skipped and why, timestamp. The watchdog checks this log.

**The coordinator script merge gate:**
```typescript
const proofRecord = await getProofRecord(prNumber);
const canAutoMerge =
  proofRecord.gates.unit_tests === 'pass' &&
  proofRecord.gates.mr_review === 'approved_clean' &&  // 0 Critical, 0 Major
  (riskLevel !== 'High' || proofRecord.gates.production_audit === 'pass') &&
  (touchesArchitecture !== true || proofRecord.gates.architecture_audit === 'pass') &&
  !prLabels.includes('needs-human-review') &&
  prAuthor.startsWith('worktrain-');  // only merge own PRs

if (canAutoMerge) {
  await exec(`gh pr merge ${prNumber} --squash`);
  appendMergeLog({ prNumber, gates: proofRecord.gates, timestamp: new Date() });
} else {
  await notifyHuman(prNumber, proofRecord);  // post to Slack with what's blocking
}
```

**The trust boundary is the proof record.** WorkTrain doesn't decide "this looks fine" -- it checks whether each required gate has a recorded pass. The merge decision is deterministic. A human can always override by adding `needs-human-review`. The audit log makes every auto-merge traceable.

**Why this is safe even though it sounds scary:**
The risk of auto-merge is "something bad gets into main." The mitigations are: the review agent is adversarial (actively looks for problems), the production audit checks for runtime risks, CI validates behavior, and the proof record is the immutable record of what was checked. A human reviewing the PR manually doesn't add much signal beyond what 3 specialized audit agents already found. The real human value is in edge cases -- which is exactly what `needs-human-review` and the `riskLevel=Critical` block handle.

**Near-term:** WorkTrain already merges in the coordinator script (we've done it today). Formalizing the policy above just makes it explicit and auditable rather than ad-hoc.

---

### Periodic analysis agents: continuous project health scanning (Apr 15, 2026)

**The idea:** WorkTrain runs agents on a schedule to proactively identify issues, gaps, improvement opportunities, and ideas -- without being asked. The watchdog (already spec'd) handles drift detection. These are deeper, domain-specific scans that run weekly or monthly.

**The agent zoo:**

**Weekly: Code health scan**
Runs `architecture-scalability-audit` on modules that haven't been audited in 30 days. Scans for: coupling violations, growing complexity hotspots (files with most churn), missing abstractions that are emerging across multiple recent PRs, performance anti-patterns introduced in the last sprint. Output: `code-health-report.md` + GitHub issues filed for actionable findings.

**Weekly: Test coverage scan**
Identifies files modified in the last 30 days with zero or low test coverage. Files with new exported symbols that have no tests. Critical paths (error handling, auth, external API boundaries) with only happy-path tests. Output: files a missing test coverage filed as GitHub issues with suggested test scenarios.

**Weekly: Documentation drift scan**
Checks if recently merged PRs changed behavior that's described in docs. Identifies code that lacks inline documentation for non-obvious logic. Finds CLAUDE.md / AGENTS.md that haven't been updated to reflect new modules or conventions. Output: `doc-drift-report.md` + PRs to fix the most important gaps.

**Monthly: Dependency health scan**
Goes beyond just "is it outdated?" -- assesses: are there known CVEs? are there active forks or replacements? are there lighter alternatives for heavy dependencies? is pi-mono still the right choice or should it be replaced? Output: `dependency-health-report.md` with recommendations ranked by impact.

**Monthly: Performance baseline**
Runs a set of benchmark scenarios: startup time, first workflow step latency, session store read/write throughput, knowledge graph query time on a real repo. Compares against the previous month's baseline. Flags regressions > 10%. Output: `performance-baseline-YYYY-MM.md` + issues for regressions.

**Continuous: Security scan**
On every PR merge: scan changed files for OWASP top 10 patterns -- hardcoded secrets, command injection vectors (like the `exec()` issue we found in #402), missing input validation at boundaries, unsafe deserialization. Output: findings posted as PR comments before merge if not already reviewed.

**Monthly: Ideas generation**
The most interesting one. Runs `wr.discovery` on the current state of the codebase + backlog + recent session history and asks: "what's the most impactful thing we could build next that we haven't thought of yet?" Cross-references with competitor landscape (GraphRAG, LangGraph, nexus-core updates), recent AI research, and user pain points in the session notes. Output: `ideas-YYYY-MM.md` -- a list of concrete improvement opportunities with rough effort estimates. The best ideas get promoted to the backlog by the watchdog.

**How this works with the coordinator:**
All of these are just cron triggers in `triggers.yml`. The coordinator script for each runs the appropriate workflow, reads the output, files GitHub issues for actionable findings, and posts a summary to Slack. No human needed to kick them off -- they just run.

```yaml
triggers:
  - id: weekly-code-health
    type: cron
    schedule: "0 8 * * 1"   # Monday 8am
    workflowId: architecture-scalability-audit
    goal: "Weekly code health scan: identify coupling violations, complexity hotspots, missing abstractions"
    workspacePath: ~/git/personal/workrail
    agentConfig:
      model: claude-sonnet-4-6
    callbackUrl: http://localhost:3200/internal/file-issues

  - id: monthly-ideas
    type: cron
    schedule: "0 9 1 * *"   # 1st of every month
    workflowId: wr.discovery
    goal: "Monthly ideas generation: what's the most impactful improvement we haven't thought of yet?"
    workspacePath: ~/git/personal/workrail
```

**The meta-point:** WorkTrain running these agents on the WorkRail/WorkTrain repo means the product improves itself on a schedule. Every Monday it finds its own architectural problems. Every month it generates ideas for its own improvement. Every PR gets a security scan before it merges. The codebase gets continuously healthier without anyone managing it.

---

### Monitoring, analytics, and autonomous remediation (Apr 15, 2026)

**The idea:** WorkTrain watches your application's health metrics in real time, identifies anomalies, investigates root causes, and resolves what it can -- automatically. This closes the full loop from "something went wrong" to "it's fixed and here's why."

---

#### What WorkTrain monitors

**Application metrics (via polling or push):**
- Error rate (Sentry, Datadog, CloudWatch, custom endpoint)
- Latency P50/P95/P99 (per endpoint, per workflow step)
- Memory and CPU usage of the daemon itself
- Session success/failure rate (from the daemon's own session store)
- Workflow completion time trends (are sessions getting slower?)
- Queue depth (are triggers backing up?)

**Codebase health metrics (derived from WorkTrain's own data):**
- Test coverage trends (going up or down over time?)
- Build time trends
- PR cycle time (time from open to merge)
- Number of open findings by severity across all open PRs
- Number of sessions that ended in `_tag: 'error'` vs `'success'` in the last 7 days
- Workflow steps most likely to fail (from session store analysis)

**Custom metrics (user-defined):**
```yaml
# triggers.yml
monitoring:
  - id: session-error-rate
    type: metric_threshold
    source: daemon_sessions    # reads from ~/.workrail/data/sessions/
    query: "error_rate_7d > 0.15"   # >15% session failure rate
    workflowId: bug-investigation.agentic.v2
    goal: "Investigate high daemon session error rate: {{$.error_rate}}% failures in last 7 days"
    workspacePath: ~/git/personal/workrail

  - id: sentry-errors
    type: sentry_poll
    project: workrail
    token: $SENTRY_TOKEN
    threshold: new_error_rate_1h > 5
    workflowId: bug-investigation.agentic.v2
    goalTemplate: "Investigate Sentry error spike: {{$.error.type}} -- {{$.error.message}}"
```

---

#### The monitoring loop

```
monitor: detect anomaly
  │
  ├── classify severity (script -- based on threshold breach magnitude)
  │     Critical: > 3x normal, affects production users
  │     High: > 2x normal, degraded but functional
  │     Low: trending bad but within bounds
  │
  ├── [if Critical] page immediately
  │     script: post to Slack #incidents with metric data + session link
  │
  ├── investigate
  │     workflow: bug-investigation.agentic.v2
  │     inputs: metric data, recent commits, error logs, affected code paths
  │     outputs: root cause hypothesis, affected files, confidence score
  │
  ├── [if confidence >= 0.8 AND severity <= High] attempt auto-remediation
  │     ├── [if config/feature-flag fix] flip flag (script, instant)
  │     ├── [if code fix, well-understood] spawn coding-task → review → merge
  │     └── [if rollback needed] create rollback PR → review → merge
  │
  ├── [if confidence < 0.8 OR severity == Critical] escalate
  │     script: post full investigation findings to Slack + file GitHub issue
  │
  └── follow-up check
        cron: 30 min later → has the metric recovered? post update.
```

---

#### WorkTrain analytics dashboard

Beyond alerting, WorkTrain maintains a persistent analytics layer that answers questions like:

- "What's our average PR cycle time this month vs last month?"
- "Which workflow steps fail most often?"
- "How much did autonomous sessions cost in tokens this week?"
- "What percentage of bugs were auto-fixed vs escalated?"
- "Which modules have the most open findings from MR reviews?"
- "How many sessions ran today / this week / this month?"

This data lives in the knowledge graph (structured, queryable) and is visualized in the console. The `worktrain talk` interface can answer these questions conversationally: "how are we doing this week?" → pulls the analytics and gives a natural language summary.

---

#### Self-monitoring: WorkTrain watching itself

The most immediately useful instance is WorkTrain monitoring its own daemon:

- Session error rate rising → investigate what kinds of tasks are failing
- Queue depth growing → daemon may be overloaded → reduce poll frequency or spawn fewer concurrent sessions
- Session duration outliers → some sessions are running way too long → investigate which workflow step is stuck
- Memory leak → daemon process growing unbounded → restart + file bug
- Disk usage → session store growing too large → prune old sessions

These are all monitorable from `~/.workrail/data/sessions/` with no external dependency. WorkTrain can watch itself with zero additional infrastructure.

---

#### Implementation path

**Now (no new features needed):** cron trigger → `wr.discovery` workflow that reads session store metrics → posts summary to Slack. This gives analytics immediately.

**Near-term (needs `metric_threshold` trigger type):** new `PollingMonitorSource` that evaluates a metric expression on a schedule and fires only when threshold breaches. Same polling infrastructure as `gitlab_poll`.

**Medium-term:** Sentry/Datadog/CloudWatch adapters as polling sources. Same pattern as GitLab -- poll the API, deduplicate events, dispatch workflow.

**Long-term:** real-time metric ingestion (push rather than pull), time-series storage in DuckDB alongside the knowledge graph, analytics dashboard in the console.

---

### Per-workspace work queue: proactive task drain instead of pure event-driven (Apr 15, 2026)

**The insight:** triggers make WorkTrain reactive (something happens, WorkTrain responds). A work queue makes WorkTrain proactive -- it pulls the next item when capacity is available, works it to completion, pulls the next. This is how a real development team operates: you have a sprint board you drain, not just a webhook listener.

**The queue is the backlog made executable.** Every item in the backlog, every GitHub issue labeled for autonomous work, every `worktrain enqueue "..."` from the terminal -- all normalized into one ordered list per workspace that WorkTrain drains continuously.

---

#### How it works

**Internal queue format:** `~/.workrail/workspaces/<name>/queue.jsonl` -- append-only, one item per line. The daemon's coordinator loop checks this file between sessions and pulls the next item when under `maxConcurrentSessions`. Items are consumed in priority order, then FIFO.

```jsonl
{"id":"q_001","goal":"implement maxConcurrentSessions global semaphore","priority":"high","source":"manual","createdAt":"2026-04-15T22:00:00Z","workflow":null,"status":"pending"}
{"id":"q_002","goal":"add GitHub polling adapter","priority":"medium","source":"github_issue","issueNumber":410,"createdAt":"2026-04-15T22:01:00Z","workflow":null,"status":"pending"}
{"id":"q_003","goal":"investigate flaky timing test in console-service-dormancy","priority":"low","source":"manual","createdAt":"2026-04-15T22:02:00Z","workflow":"bug-investigation.agentic.v2","status":"pending"}
```

**CLI interface:**
```bash
worktrain enqueue "implement X" --workspace workrail --priority high
worktrain enqueue "investigate this bug" --workspace workrail --workflow bug-investigation.agentic.v2
worktrain queue list --workspace workrail          # show pending items
worktrain queue pause --workspace workrail         # stop draining
worktrain queue resume --workspace workrail        # resume draining
worktrain queue remove <id> --workspace workrail   # remove an item
```

**External pull sources (normalized into the internal queue):**
```yaml
workspaces:
  workrail:
    path: ~/git/personal/workrail
    queue:
      maxConcurrentSessions: 3
      sources:
        - type: github_issues
          integration: github
          filter: 'label:worktrain-queue'
          priority:
            - label: 'priority:high'   → high
            - label: 'priority:medium' → medium
            - default:                 → low
        - type: internal              # always included
```

When a GitHub issue is labeled `worktrain-queue`, a poll cycle picks it up and normalizes it into the internal queue. When WorkTrain completes the work, it removes the label (or transitions status) and closes the issue. The team uses GitHub issues as their task interface; WorkTrain drains them autonomously.

**Supported external sources:**
- GitHub issues (label filter)
- GitLab issues (label filter)
- Jira sprint board (active sprint items assigned to worktrain user)
- Linear (triage queue or assignee filter)
- Internal queue.jsonl (always available, zero config)

---

#### Queue + message queue + talk: the full interface

Three modes, all async-safe, all persisted:

| Interface | Use case | Latency |
|-----------|----------|---------|
| **Work queue** | "do this when you have capacity" | Whenever a slot is free |
| **Message queue** (`worktrain tell`) | "do this now, between current sessions" | End of current batch |
| **Talk** (`worktrain talk`) | "let's discuss and decide together" | Interactive |

You can send a thought from your phone at 2am via `worktrain tell`, and separately have a queue of 10 backlog items WorkTrain is draining during the day. The talk session can inspect the queue, reorder items, and add new ones -- all from natural conversation.

---

#### Queue-aware coordinator loop

The coordinator's main loop becomes:

```typescript
while (daemon.running) {
  // 1. Drain message queue (direction changes, questions)
  const messages = await readMessageQueue();
  for (const msg of messages) await handleMessage(msg);

  // 2. Pull next queue items up to maxConcurrentSessions
  const active = await getActiveSessions();
  const slots = maxConcurrentSessions - active.length;
  if (slots > 0) {
    const items = await dequeueItems(slots);
    for (const item of items) {
      const pipeline = await classifyAndBuildPipeline(item.goal);
      await spawnCoordinatorSession(pipeline, item);
    }
  }

  // 3. Check external pull sources for new items
  await syncExternalSources();

  await sleep(5_000);  // 5s coordinator tick
}
```

The queue is the thing that makes WorkTrain feel like a teammate rather than a service -- it has its own work to do, it makes progress autonomously, and you can check in on it rather than having to drive every task manually.

---

#### Queue visibility in the console

The console adds a **Queue tab** (alongside Sessions and AUTO):
- Pending items (ordered by priority, FIFO within priority)
- Active items (with live session link)
- Completed items (with outcome, duration, PR link if applicable)
- Paused/blocked items (with reason)

Drag-to-reorder for priority. Click to expand and see the full pipeline plan. Button to pause/resume the queue. "Add item" form that goes to `worktrain enqueue`.

---

#### Relationship to worktrain spawn/await

`worktrain spawn` / `worktrain await` are for coordinator *scripts* -- explicit programmatic orchestration. The work queue is for *ambient* drain -- WorkTrain autonomously pulls items when capacity is free. Both use the same underlying session engine. The difference is who's driving: a script (spawn/await) or the queue drain loop. They compose naturally: a queue item might be a coordinator script that spawns its own child sessions via spawn/await.

---

### Work queue refinements: filtering, catch-all mode, and deadline-aware prioritization (Apr 15, 2026)

#### Issue/ticket filtering

The external pull sources need richer filtering than just a label. Real teams organize work by project, team, component, sprint, and assignee -- all of these should be filterable:

```yaml
workspaces:
  workrail:
    queue:
      sources:
        - type: github_issues
          integration: github
          filter:
            labels: ['worktrain-queue']     # optional -- if omitted, pulls all open issues
            milestone: 'Sprint 12'          # optional
            assignee: 'worktrain-bot'       # optional -- only issues assigned to WorkTrain
            notLabels: ['needs-human', 'blocked', 'wontfix']  # always exclude these

        - type: jira
          integration: jira
          filter:
            project: ENG                    # required -- scope to one project
            sprint: active                  # 'active', 'backlog', or sprint name
            assignee: worktrain             # Jira user
            issueTypes: ['Bug', 'Task']     # not Stories/Epics
            notStatuses: ['Done', 'Closed']

        - type: linear
          integration: linear
          filter:
            team: platform                  # Linear team slug
            state: triage                   # pull from triage queue
            priority: [urgent, high]        # only urgent and high priority
```

**Catch-all mode:** if `filter` is omitted entirely, WorkTrain pulls everything open and unassigned in the project/repo. This is the "let WorkTrain go find work" mode -- useful for batch grooming sessions but should require explicit opt-in (`catchAll: true`) since it could pull thousands of items.

```yaml
- type: github_issues
  integration: github
  catchAll: true                # pulls ALL open issues, no label required
  filter:
    notLabels: ['needs-human', 'wontfix']
  maxItemsPerCycle: 5           # drain slowly, not everything at once
```

---

#### Deadline-aware prioritization

WorkTrain should be able to determine priority not just from labels, but from deadlines it finds anywhere:

**Sources WorkTrain reads for deadline context:**
- Issue/ticket due dates (Jira, Linear, GitHub milestones)
- Epic end dates (Jira epics, Linear projects)
- Sprint end date (current active sprint)
- Release/milestone dates from the repo
- Calendar events (via Glean or Google Calendar integration)
- Confluence/Notion pages that mention deadlines
- Docs in the repo (`ROADMAP.md`, `docs/milestones.md`, etc.)

**What WorkTrain does with deadlines:**
The classify-task-workflow (or a new `prioritize-queue` workflow) reads the deadline context and produces an adjusted priority score:

```
base_priority = from label/assignee (low/medium/high)
deadline_urgency = days_until_deadline:
  < 2 days  → +3 (critical)
  < 7 days  → +2 (high)
  < 14 days → +1 (medium)
  > 14 days → +0 (no adjustment)
  past due  → +4 (overdue, surface immediately)

adjusted_priority = base_priority + deadline_urgency
```

Items are queued in adjusted_priority order, not just the label order. A medium-priority task due tomorrow beats a high-priority task due in 3 months.

**Glean integration for deadline discovery:**
Glean indexes everything -- Jira, Confluence, Google Docs, Slack, emails. WorkTrain can query Glean: "what are the deadlines affecting the workrail project this month?" and get a synthesized view across all systems. This is especially powerful for deadline context that lives in documents rather than tickets (e.g. a Confluence roadmap page that says "feature X must ship by Q2").

```yaml
workspaces:
  workrail:
    queue:
      deadlineContext:
        sources:
          - type: glean
            query: "workrail deadlines milestones due dates"
            maxResults: 10
          - type: github_milestones
            integration: github
          - type: jira_epics
            integration: jira
            project: ENG
        refreshInterval: 3600   # re-fetch deadline context every hour
```

**The prioritize-queue routine:**
A cheap, fast routine (one step, Haiku model) that runs after each external sync and re-scores the queue. Reads: current queue items + deadline context. Outputs: reordered queue with deadline annotations. The coordinator's drain loop always reads the latest ordering.

```
Input: queue items + deadline context
Output: same items reordered, each with:
  - adjustedPriority (critical/high/medium/low)
  - deadlineReason: "Sprint 12 ends in 3 days" or "Epic ENG-200 due June 1"
  - deadlineSource: URL or doc reference
```

**Escalation when deadlines are at risk:**
If a queue item has a deadline within 48 hours and hasn't been started yet, the watchdog notifies: "WORKRAIL-410 (GitHub polling adapter) is due in 2 days and hasn't been started. Current queue position: 8. Bumping to position 1." Posts to Slack + the message outbox. The user can override via message queue if they disagree.

**Why this is powerful:**
WorkTrain effectively becomes your sprint manager. It knows what's due, in what order things need to happen, and it works the highest-urgency items first -- without anyone having to manually reorder a board. The deadline context is always fresh (re-fetched every hour), so if a Confluence page updates the roadmap, the queue re-prioritizes automatically.

---

### Workspace pipeline policy: artifact gates vs autonomous decomposition (Apr 15, 2026)

**The core tension:** some workspaces have rigorous pre-implementation processes (BRD required, design approved, shapeup doc reviewed). Others are solo/small-team projects where you figure it out as you go. WorkTrain should respect both -- waiting patiently in governed workspaces, doing the work itself in autonomous workspaces.

---

#### Two workspace modes

**Governed mode** -- for projects with existing process gates:

```yaml
workspaces:
  my-work-project:
    path: ~/git/work/my-project
    pipelinePolicy:
      mode: governed
      requiredArtifacts:
        - type: brd                    # Business Requirements Document
          sources: [confluence, jira_epic, google_docs]
          searchQuery: "BRD {{ticket.key}}"
        - type: design                 # UI/UX designs
          sources: [figma, confluence]
          searchQuery: "designs {{ticket.key}}"
        - type: shapeup                # Shape Up pitch/bet
          sources: [notion, confluence]
      onMissingArtifacts: wait         # 'wait', 'skip', or 'escalate'
      waitCheckInterval: 3600          # re-check every hour
      waitTimeout: 168h                # escalate after 7 days of waiting
      escalationMessage: "Ticket {{ticket.key}} has been waiting for required artifacts for {{wait_duration}}. Manual review needed."
```

When WorkTrain picks up a ticket in governed mode, it first searches for the required artifacts using the configured sources and search queries. If they're not found:
- `wait`: holds the ticket in a "waiting" state, re-checks every hour, notifies when artifacts appear
- `skip`: moves to the next ticket, re-queues this one later
- `escalate`: posts to Slack + blocks the ticket, requires human to resolve

When artifacts are found, WorkTrain automatically extracts context from them, attaches them as `referenceUrls` to the session, and proceeds with implementation -- skipping the discovery/design phases since those artifacts already contain the answer.

**Autonomous mode** -- for projects without pre-existing process:

```yaml
workspaces:
  workrail:
    path: ~/git/personal/workrail
    pipelinePolicy:
      mode: autonomous
      # No required artifacts -- WorkTrain does its own discovery and design
      # Uses the full pipeline: classify → discovery → design → arch review → implement → review
      decompositionEnabled: true       # can break large tasks into sub-tickets
      decompositionThreshold: Large    # tasks classified Large get decomposed
```

In autonomous mode, WorkTrain runs the full pipeline including discovery, UX design (if `hasUI`), architecture review (if `touchesArchitecture`), and implementation. It doesn't wait for external artifacts because there are none -- it generates them itself.

---

#### Automatic task decomposition

When a task is classified as `Large` (or Medium with high complexity), WorkTrain decomposes it into sub-tickets before starting implementation. The sub-tickets go into the workspace queue and are worked in order.

**Decomposition workflow** (new, needs authoring):
```
Input: task description + context from discovery
Output: ordered list of sub-tickets, each with:
  - title (imperative, specific)
  - goal (1-2 sentence description)
  - estimatedComplexity (Small/Medium)
  - dependencies (which sub-tickets must complete first)
  - workflowId (which workflow to use)
```

**Example:** task "implement polling triggers system"
```
Decomposed into:
  1. [Small] Add PollingTriggerSource type to TriggerDefinition   → depends: none
  2. [Small] Implement PolledEventStore with atomic persistence    → depends: 1
  3. [Small] Implement GitLab MR polling adapter                  → depends: 2
  4. [Small] Implement PollingScheduler with setInterval          → depends: 2,3
  5. [Small] Wire PollingScheduler into TriggerListener           → depends: 4
  6. [Small] Add unit tests for all new modules                   → depends: 1-5
```

Each sub-ticket is Small or Medium -- never Large. If a sub-ticket comes out Large during decomposition, it gets recursively decomposed. The decomposition agent enforces this invariant.

Sub-tickets are added to the queue with:
- `parentTicketId` linking back to the original task
- `dependsOn` list preventing out-of-order execution
- Same priority as the parent ticket
- Auto-label so they're visually grouped in GitHub/Jira

**Queue behavior with dependencies:**
The queue drain loop respects `dependsOn` -- a sub-ticket is only picked up when all its dependencies are completed. The coordinator naturally serializes dependent work and parallelizes independent work (sub-tickets with no shared dependencies can run concurrently).

---

#### Hybrid: governed workspace with autonomous decomposition

Some workspaces need both -- a BRD required before implementation starts, but the implementation itself gets decomposed autonomously:

```yaml
workspaces:
  my-work-project:
    pipelinePolicy:
      mode: governed
      requiredArtifacts:
        - type: brd
          onMissingArtifacts: wait
      decompositionEnabled: true       # once BRD is found, decompose into sub-tickets
      decompositionThreshold: Medium   # decompose Medium and Large tasks
```

Flow: ticket filed → WorkTrain finds BRD → reads BRD for context → classifies task → if Medium/Large decomposes into sub-tickets → works sub-tickets in order. The BRD gates the start; decomposition handles the execution.

---

#### The "patiently waiting" UX

In the console Queue tab, tickets waiting for artifacts show a distinct state:

```
⏳ WORKRAIL-410: Implement new auth flow        [waiting for: BRD, designs]
   Waiting 2d 4h · Last checked: 5 min ago · Artifacts: 0/2 found
   
   → Found: none
   → Searched: Confluence ("BRD WORKRAIL-410"), Figma ("WORKRAIL-410 designs")
```

WorkTrain posts a Slack message when it starts waiting: "I picked up WORKRAIL-410 but it's missing required artifacts (BRD, designs). I'll check hourly and start automatically when they're ready." Then posts again when artifacts are found: "Found BRD and designs for WORKRAIL-410. Starting implementation now."

The team doesn't have to remember to trigger WorkTrain -- they just do their normal process (write the BRD, create the designs) and WorkTrain starts automatically.

---

#### Why this matters

- **Governed projects**: WorkTrain integrates with existing process rather than bypassing it. PMs and designers work normally; WorkTrain picks up when the handoff is ready. No one has to remember to trigger it.
- **Autonomous projects**: WorkTrain is a full solo developer -- it discovers, designs, decomposes, implements, reviews, and ships. The only human touchpoint is approving the final PR (or enabling auto-merge for fully vetted changes).
- **The queue is the unifying interface**: both modes feed the same queue. The pipeline policy determines what happens when an item is picked up.

---

### Templates, living docs, and external workflow ingestion (Apr 15, 2026)

---

#### Templates: consistent output formatting across all systems

WorkTrain should know the templates used in each workspace and apply them automatically when creating artifacts. No more agents writing PRs in inconsistent formats or Jira tickets missing required fields.

**Template types:**

```yaml
workspaces:
  my-work-project:
    templates:
      pullRequest:
        source: .github/pull_request_template.md   # repo-local
      mergeRequest:
        source: .gitlab/merge_request_templates/default.md
      jiraTicket:
        source: confluence://ENG/ticket-template   # from Confluence
        requiredFields: [summary, description, acceptanceCriteria, storyPoints, component]
      jiraBug:
        source: confluence://ENG/bug-template
        requiredFields: [summary, description, stepsToReproduce, expectedVsActual, severity]
      shapeup:
        source: notion://templates/shapeup-pitch
      brd:
        source: confluence://templates/brd-template
      designSpec:
        source: notion://templates/design-spec
      incidentPostmortem:
        source: confluence://templates/postmortem
```

When WorkTrain creates a PR, it reads the PR template and structures its output to match. When it files a Jira bug from an investigation, it reads the bug template and fills every required field. When it writes a BRD in autonomous mode, it uses the BRD template so the output looks like what the team expects.

Templates are resolved at session start and injected as context. The agent is told: "When creating a [type], use this template structure exactly." The handoff artifact for the auto-commit/PR path includes the PR body pre-formatted to match the template.

**Template sources:**
- Local files in the repo (`.github/`, `.gitlab/`, `docs/templates/`)
- Confluence pages
- Notion databases/templates
- Google Docs
- Inline in `triggers.yml`

---

#### Living docs: on-demand generation and continuous updates

WorkTrain maintains documentation as a first-class output, not an afterthought. Docs can be generated on-demand and kept current automatically.

**On-demand doc generation:**

```bash
worktrain doc generate --type architecture-overview --workspace workrail
worktrain doc generate --type api-reference --workspace workrail
worktrain doc generate --type runbook "How to debug a stuck daemon session"
worktrain doc generate --type adr "Why we replaced pi-mono with a first-party agent loop"
```

Each generates a doc by pulling from all available sources:
- Knowledge graph (structural understanding of the codebase)
- Session store (recent decisions and findings)
- Backlog (design decisions and rationale)
- GitHub PRs (what changed and why -- from PR descriptions)
- Confluence/Notion (existing docs to extend, not duplicate)

**Continuous doc updates:**
When code changes, affected docs are flagged for update. WorkTrain runs a `doc-drift-scan` (part of the periodic analysis agents) that identifies docs whose described behavior no longer matches the code. When drift is detected, a queue item is created: "Update architecture-overview.md -- AgentLoop class was added, pi-mono removed."

```yaml
workspaces:
  workrail:
    docs:
      autoUpdate: true
      docPaths:
        - docs/architecture/
        - docs/design/
        - README.md
      driftCheck:
        schedule: "0 8 * * 1"    # Monday morning
        onDrift: queue            # or: pr, notify, ignore
```

**Doc sources it pulls from:**

| Source | What it provides |
|--------|-----------------|
| Knowledge graph | Symbol relationships, module structure, call paths |
| Session store | Recent decisions, investigation findings, design rationale |
| Backlog | Why things were built the way they were |
| Git log | What changed, when, linked PRs |
| Confluence/Notion | Existing team knowledge to incorporate |
| Glean | Cross-system knowledge synthesis |
| Code comments and JSDoc | Inline documentation |

**Doc formats it produces:**
- Architecture overview (modules, dependencies, data flow)
- API reference (from TypeScript types + JSDoc)
- Runbook (operational procedures)
- ADR (Architecture Decision Record -- from backlog decisions)
- Postmortem (from incident investigation sessions)
- Sprint recap (from completed queue items)
- Onboarding guide (from architecture + setup docs)

---

#### External workflow ingestion

WorkTrain can already discover and run workflows from external repos via managed sources (`[[workflow_repos]]` in Common-Ground config). This should be a first-class feature, not just a Common-Ground integration.

**How it works today (via managed sources):**
Any workflow JSON file in a configured directory or git repo is automatically available. `workrail list` shows all workflows from all sources.

**What to add:**

**1. Workflow registry / marketplace:**
A curated list of community workflows that WorkTrain can pull from. `worktrain workflow install <id>` fetches a workflow from the registry and adds it to the user's workflow library.

```bash
worktrain workflow install community/postgres-migration-workflow
worktrain workflow install company/my-company-mr-review      # private org registry
worktrain workflow install ./local-custom-workflow.json      # local file
```

**2. Workflow composition:**
A workflow that calls another workflow as a step (already possible via `templateCall`, extend to full `workflowCall`). A coordinator workflow can invoke specialized workflows as phases:

```json
{
  "id": "full-feature-pipeline",
  "steps": [
    { "workflowCall": { "workflowId": "classify-task-workflow" } },
    { "workflowCall": { "workflowId": "wr.discovery", "when": "taskComplexity != Small" } },
    { "workflowCall": { "workflowId": "coding-task-workflow-agentic" } },
    { "workflowCall": { "workflowId": "mr-review-workflow.agentic.v2" } }
  ]
}
```

**3. Workflow sharing between workspaces:**
A workflow authored for workrail can be shared to storyforge without copying it. Workflows are linked by reference, not copied. Updates to the source propagate automatically (or on explicit sync).

**4. Org-level workflow libraries:**
Teams publish their workflow libraries to a git repo. WorkTrain pulls from it. Every team member's WorkTrain automatically gets the team's curated workflow set. This is exactly what Common-Ground's `[[workflow_repos]]` does today -- make it a first-class WorkTrain config option without requiring Common-Ground.

```yaml
workspaces:
  my-work-project:
    workflowSources:
      - type: git
        url: https://github.com/mycompany/worktrain-workflows
        branch: main
        syncInterval: 3600
      - type: local
        path: ~/git/personal/workrail/workflows
```

---

### Workflow effectiveness assessment and self-improvement proposals (Apr 15, 2026)

**The idea:** WorkTrain runs workflows hundreds of times. It accumulates more data about workflow effectiveness than any human author ever could. It should use that data to propose improvements back -- to the workflow library, to the workflow authors, and to the community.

This closes the self-improvement loop: WorkTrain uses workflows → measures outcomes → proposes improvements → workflows get better → WorkTrain produces better results.

---

#### What WorkTrain measures per workflow run

Every session already stores rich data in the session store. From this, WorkTrain can derive:

**Efficiency metrics:**
- Steps skipped (condition gates that always skip for a given workflow type) → candidate for removal or restructuring
- Steps that consistently take the most tokens/time → candidates for subagent offloading or simplification
- Steps where the agent calls `continue_workflow` immediately with minimal work → the step prompt may be too vague or redundant
- Steps where the agent hits `requireConfirmation` and always gets the same response → the gate is unnecessary for autonomous use

**Quality metrics:**
- Sessions that produced PRs: how many had MR review findings? How severe?
- Sessions where findings required multiple fix passes → the workflow may not be thorough enough in those areas
- Sessions where the final output was rejected or required manual correction → workflow produced low-quality output
- Verification gate pass rate (build_correctness, invariant_preservation) → how often does the workflow produce code that actually works?

**Completion metrics:**
- Sessions that completed vs hit max_turns or timeout → workflow may be too long for the given task type
- Steps where the agent loops unexpectedly (loop_control: continue more than expected) → loop exit conditions may be wrong
- Steps with unusually high token consumption → prompt may be bloated

---

#### The assessment workflow

A new `workflow-effectiveness-assessment` workflow (or routine) that:

1. Reads session store history for a given workflowId (last N sessions)
2. Computes the metrics above
3. Identifies the top 3-5 issues with evidence (specific sessions, specific steps)
4. Proposes concrete changes:
   - "Step `phase-1b-design-quick` was skipped in 87% of sessions because `rigorMode != QUICK`. Consider making this condition more permissive or removing the step."
   - "Step `phase-4-plan-audit` consumed an average of 4,200 tokens per session. The loop runs 1.8 times on average. Consider reducing `maxIterations` from 2 to 1 for QUICK rigor mode."
   - "3 of the last 8 `coding-task-workflow-agentic` sessions produced PRs with Critical MR review findings. The workflow's verification step may not be catching these issues."

5. Outputs a structured proposal:

```json
{
  "workflowId": "coding-task-workflow-agentic.lean.v2",
  "assessmentPeriod": "last 30 sessions",
  "proposedChanges": [
    {
      "stepId": "phase-1b-design-quick",
      "issue": "Skipped in 87% of sessions",
      "evidence": ["sess_abc", "sess_def", "sess_ghi"],
      "proposedChange": "Remove or restructure -- not exercised enough to justify its existence",
      "confidence": 0.85,
      "impactEstimate": "Saves ~200 tokens per session, no quality impact"
    }
  ],
  "overallHealthScore": 0.72,
  "recommendation": "Run workflow-for-workflows on this workflow with assessment findings attached"
}
```

---

#### How proposals flow back

**To WorkRail (the open-source project):**
WorkTrain creates a GitHub issue on `EtienneBBeaulac/workrail` with the assessment findings and proposed changes. The issue includes:
- The assessment data (anonymized session stats, no content)
- The proposed changes with rationale
- Label: `workflow-improvement-proposal`

Any WorkTrain user can contribute workflow improvements back to the community just by running WorkTrain and enabling assessments.

**To workflow authors (for non-bundled workflows):**
If the workflow came from an org workflow library (`workflowSources: git`), WorkTrain opens a PR against that repo with the proposed changes. The workflow author reviews and merges.

**To the local workflow library:**
WorkTrain can automatically apply low-risk changes (reordering steps, updating prompt text) to the user's local workflow copy. High-risk changes (removing steps, changing conditions) require human review. Same governed/autonomous split as everywhere else.

---

#### Continuous improvement loop

```
WorkTrain runs workflows
  → session store accumulates data
  → weekly: assessment routine analyzes patterns
  → proposals generated per workflow
  → low-confidence proposals: GitHub issue for human review
  → high-confidence, low-risk proposals: auto-applied to local copy + PR to community
  → workflow gets better
  → WorkTrain produces better results
  → loop repeats
```

**The compounding effect:** every WorkTrain instance that runs assessments contributes signal. A workflow used by 100 teams accumulates 10x the data of a workflow used by 10 teams. The more WorkTrain is used, the better its workflows get -- for everyone. This is the flywheel that makes WorkTrain's workflow library genuinely better than hand-authored alternatives over time.

**What makes this different from manual workflow improvement:**
Humans improve workflows based on intuition and memorable failures. WorkTrain improves workflows based on statistical patterns across hundreds of runs. It finds issues that no human would notice -- like a step that's almost always skipped, or a loop that almost always terminates on the first pass, or a prompt fragment that correlates with lower-quality output.

**Integration with `workflow-for-workflows`:**
The assessment output is designed to feed directly into `workflow-for-workflows`. Assessment findings become the context for authoring improved workflow versions. WorkTrain literally uses its own meta-workflow to improve its own workflows, informed by real execution data.


**The problem with polling-only:** the queue is as fresh as the last poll cycle. A critical bug filed in Jira might not appear in the queue for 5 minutes. A deadline that just moved to tomorrow might not re-prioritize for an hour. The work queue should feel live -- changes in external systems should surface in the queue within seconds, not minutes.

**Two mechanisms for live updates:**

**1. Push sources (webhooks from external systems)**
When an external system supports webhooks, WorkTrain should register a receiver and process events immediately -- no polling lag.

```yaml
workspaces:
  workrail:
    queue:
      sources:
        - type: github_issues
          integration: github
          mode: push              # vs poll -- receives webhook, processes immediately
          webhookSecret: $GITHUB_WEBHOOK_SECRET
          filter:
            labels: ['worktrain-queue']

        - type: jira
          integration: jira
          mode: push              # Jira webhook on issue create/update/transition
          webhookSecret: $JIRA_WEBHOOK_SECRET
          filter:
            project: ENG
```

A new GitHub issue labeled `worktrain-queue` fires a webhook → WorkTrain adds it to the queue within milliseconds. A Jira ticket assigned to WorkTrain → in the queue before the assignee closes the tab.

**2. The message queue as live input**
`worktrain tell "add X to the queue"` is already instantaneous -- it appends to `message-queue.jsonl` which the daemon drains between sessions. This is the live grooming path for manual items. It's also how you reorder, prioritize, remove, or modify queue items in real time:

```bash
worktrain tell "move the GitHub polling adapter to the top of the queue"
worktrain tell "remove the documentation update task -- no longer needed"
worktrain tell "bump the maxConcurrentSessions task to high priority, we need it for the demo"
```

The daemon's coordinator loop reads these messages, interprets them as queue operations, and applies them immediately.

**3. Live re-prioritization via deadline watcher**
The deadline context refresh (already spec'd) runs every hour. For live grooming, the deadline watcher should also subscribe to calendar/milestone change events via webhook where available:
- GitHub milestone due date changed → immediate re-prioritization
- Jira sprint end date changed → immediate re-scoring
- Google Calendar event added/moved → immediate re-scoring

**The live queue architecture:**

```
External events (webhooks) ──→ POST /webhook/queue-push
                                │
                                ▼
                          QueueEventProcessor
                                │
                          ┌─────┴──────┐
                          │            │
                    Add to queue   Re-prioritize
                    immediately    affected items
                          │            │
                          └─────┬──────┘
                                ▼
                          queue.jsonl updated
                                │
                                ▼
                    Console Queue tab refreshes (SSE)
                    Coordinator picks up next item
```

**The queue tab in the console is live:**
The console Queue tab streams updates via SSE (same pattern as the live session badge already implemented). When a new item is added via webhook or message queue, it appears in the tab within milliseconds -- no page refresh needed. When re-prioritization happens, items smoothly reorder. This is the always-on view of what WorkTrain is working on and what's coming next.

**Grooming operations the live queue supports:**

| Operation | How |
|-----------|-----|
| Add item | `worktrain tell`, webhook, `worktrain enqueue` |
| Remove item | `worktrain tell "remove X"`, `worktrain queue remove <id>` |
| Reprioritize | `worktrain tell "prioritize X"`, deadline watcher, manual drag in console |
| Pause item | `worktrain queue pause <id>` -- holds in place, not worked until resumed |
| Block item | System-set when dependencies not met (auto-resolves when deps complete) |
| Split item | `worktrain tell "split X into smaller tasks"` → runs decomposition workflow |
| Merge items | `worktrain tell "X and Y are the same thing, merge them"` |
| Add context | `worktrain tell "for X, the BRD is at <url>"` → attaches to queue item |

**Why this changes the interaction model:**
With polling-only queues, you have to trust that WorkTrain will eventually see the work. With live queuing, WorkTrain is always current. You file a critical bug at 11pm, the webhook fires, it's at the top of the queue, and WorkTrain starts investigating within seconds. You push a doc link into `worktrain tell`, the queue item gets the context immediately. The queue feels like a shared workspace, not a batch job.

---

### Live status briefings: WorkTrain narrates its own work in human terms (Apr 15, 2026)

**The problem:** WorkTrain is doing a lot. Sessions are running, PRs are open, the queue has items. But the raw view -- session IDs, PR numbers, branch names -- is only meaningful to someone who's been following along. A user who checks in after a few hours needs a human-readable briefing, not a list of `sess_abc123` entries.

**The vision:** WorkTrain can produce a live status briefing at any time -- a clear, plain-language summary of what's happening, why, and what comes next. Like a teammate giving you a standup.

---

#### The `worktrain status` command

```bash
worktrain status --workspace workrail
```

Example output:
```
WorkTrain — workrail workspace  [16 Apr 2026, 14:32]

ACTIVE (3 sessions running)
  ● Implementing GitHub polling adapter
    → Adding support for GitHub Issues/PRs without requiring webhooks
    → Step 4 of 8: writing the polling scheduler integration tests
    → Running ~22 min, estimated 15 min remaining

  ● Reviewing PR #406: first-party agent loop
    → Critical dependency removal: eliminates private npm package blocking public install
    → Step 2 of 6: analyzing tool schema migration
    → Running ~8 min

  ● Fixing PR #402: auto-commit shell injection
    → Security fix: replacing exec() with execFile() to prevent shell injection
    → Step 6 of 8: running verification
    → Running ~31 min

QUEUE (next 5 items)
  1. [HIGH]  Implement maxConcurrentSessions semaphore
             → Prevents token burn under high load
  2. [HIGH]  worktrain tell/inbox message queue CLI
             → Enables async communication from mobile
  3. [MED]   Proof record schema for verification chain
             → Gates the auto-merge capability
  4. [MED]   Workspace namespacing groundwork
             → Prerequisite for multi-project support
  5. [MED]   Native cron trigger provider

RECENTLY COMPLETED (last 6 hours)
  ✓ PR #403 merged  — worktrain init onboarding command (now: npm install -g + worktrain init = running)
  ✓ PR #397 merged  — Session timeout + max-turn limit (prevents runaway LLM loops)
  ✓ PR #392 merged  — Prior session context injection (agent remembers previous work)
  ✓ PR #405 merged  — classify-task workflow (coordinator can now route pipelines)

BLOCKED / WAITING
  ⏸ PR #406 review returned changes — fixing 2 issues (tsc breakage + max_tokens handling)
     Will resume automatically once fixed and re-reviewed

UPCOMING MILESTONES
  → First-party agent loop (#406) — unblocks: public npm install without private packages
  → worktrain spawn/await — unblocks: script-driven coordinator orchestration
  → Auto-merge on proof records — unblocks: fully autonomous merge without human approval
```

---

#### How it works

The briefing is assembled by a `build-status-briefing` routine (not a full workflow -- a single fast step) that reads:
- Active sessions from the session store (what's running, which step, how long)
- Queue state from `queue.jsonl`
- Recent completions from the merge audit log + session store
- Blocked/waiting items from the queue
- Milestone dependencies from the backlog (which items unblock what)

The routine summarizes each session in 2-3 plain English lines:
- What is being built (not the PR number, the capability)
- Why it matters (how it connects to the user's goals)
- Where it is (which step, estimated remaining time)

This requires WorkTrain to maintain a brief "plain English description" for each queue item and active session -- either extracted from the goal text, or generated when the item is enqueued.

---

#### Live view in the console

The console gains a **Status tab** (the default view when you open the console):

```
┌─────────────────────────────────────────────┐
│ WorkTrain — workrail                    Live │
├─────────────────────────────────────────────┤
│ ACTIVE                                    3 │
│                                             │
│ ● GitHub polling adapter          22m  ████ │
│   Step 4/8: writing tests                   │
│                                             │
│ ● PR #406 agent loop review        8m  ██   │
│   Step 2/6: schema analysis                 │
│                                             │
│ ● PR #402 shell injection fix     31m  ████ │
│   Step 6/8: verification                    │
├─────────────────────────────────────────────┤
│ QUEUE                                     8 │
│  1 ▲ maxConcurrentSessions (HIGH)           │
│  2   message queue CLI (HIGH)               │
│  3   proof record schema (MED)              │
│  4 ▼ workspace namespacing (MED)            │
├─────────────────────────────────────────────┤
│ DONE TODAY                               12 │
│  ✓ worktrain init    ✓ session timeout      │
│  ✓ classify-task     ✓ session context      │
└─────────────────────────────────────────────┘
```

Updates via SSE -- the progress bars move in real time, completed items slide up to DONE, new queue items animate in. Click any row to expand the full session detail or queue item.

---

#### Push notifications to mobile/Slack

The same briefing data drives push notifications:

**Milestone completions:**
> "WorkTrain shipped: worktrain init is live. You can now run `npm install -g @exaudeus/workrail && worktrain init` to set up a new instance in under 5 minutes. 3 more PRs in review."

**Blockers surfaced:**
> "PR #406 (first-party agent loop) came back with 2 issues -- one causes tsc to fail on clean install. Fixing automatically, estimated 20 min."

**Daily digest (optional, configurable):**
> "WorkTrain daily summary — 6 sessions completed, 3 PRs merged, 2 in review. Top priority tomorrow: spawn/await CLI (unblocks coordinator scripts). Queue has 8 items, 3 high priority."

The briefing is generated by a fast, cheap routine (Haiku model) that translates raw state into the right level of detail for the audience. Technical details available on request; the default is executive summary.

---

#### Context-aware summarization

The briefing adapts to who's asking and what they know:

- **Owner/developer** (you): full detail -- PR numbers, session steps, technical blockers
- **Stakeholder** (PM, manager): capability level -- "implementing X which enables Y, shipping this week"
- **External** (customer, blog post): outcome level -- "automated code review is live, auto-merge coming next sprint"

`worktrain status --audience stakeholder` generates the right level of detail automatically. The underlying data is the same; the presentation layer changes.

This is also what the `worktrain talk` session uses as its opening context -- before any conversation, WorkTrain gives itself a briefing on the current state so it can answer questions accurately.

---

### WorkTrain analytics: stats, time saved, and quality metrics (Apr 15, 2026)

**The principle:** WorkTrain should be accountable. Not just "it did work" but "did it do good work?" Stats without quality metrics are vanity. Quality metrics without stats lack context. Both together tell you whether WorkTrain is actually worth running.

---

#### Volume stats (what got done)

Derived from session store + merge audit log + GitHub/Jira API:

```
WorkTrain — workrail workspace  [last 30 days]

VOLUME
  PRs opened:          23   (18 merged, 3 in review, 2 closed)
  PRs reviewed:        31   (autonomous MR review sessions)
  Bugs investigated:    8   (bug-investigation workflow runs)
  Tasks completed:     19   (coding-task workflow runs → merged PRs)
  Discoveries run:     12   (wr.discovery workflow runs)
  Issues filed:         6   (by WorkTrain based on findings)
  Issues resolved:      4   (WorkTrain opened and closed)

QUEUE THROUGHPUT
  Items added:         34
  Items completed:     27
  Items in progress:    4
  Items deferred:       3
  Average queue time:  2.4h  (enqueue → session start)
```

---

#### Time saved estimates

"Time saved" is directionally useful but must be honest about what it's estimating. WorkTrain shouldn't claim 40 hours saved if a human would have done the same work in 30 minutes.

**Estimation model:**

Each workflow type has a calibrated human-equivalent time estimate, validated against real data where possible:

| Workflow | Human equivalent | Basis |
|----------|-----------------|-------|
| MR review (STANDARD) | 25 min | Industry average for 200-line diff |
| MR review (THOROUGH) | 45 min | Complex architectural changes |
| Bug investigation | 60 min | Triage + root cause hypothesis |
| Coding task (Small) | 30 min | Estimate based on task complexity |
| Coding task (Medium) | 2h | |
| Coding task (Large) | 6h | |
| Discovery run | 45 min | Research + synthesis |

```
TIME SAVINGS (estimated)
  MR reviews:      31 × 25 min  =  12.9h
  Bug investigation: 8 × 60 min =   8.0h
  Coding tasks:    19 tasks      =  32.5h  (mix of Small/Medium)
  Discovery:       12 × 45 min  =   9.0h
  ─────────────────────────────────────────
  Total estimate:                  62.4h  ≈ 1.5 engineer-weeks

COST
  Total LLM tokens used:   4.2M
  Estimated API cost:      $12.40
  Cost per hour saved:     $0.20/h

  NOTE: These are estimates. Actual time savings depend on task complexity
  and whether the work would otherwise have been done at all.
```

The honesty note matters. "Time saved" is only real if the work would have been done by a human. Tasks that were deprioritized indefinitely until WorkTrain did them represent more value than 25-minute estimates suggest.

---

#### Quality metrics (is WorkTrain actually doing a good job?)

This is the most important section. Volume without quality is noise.

**Output quality:**

```
QUALITY — last 30 days

MR REVIEWS
  Reviews with 0 findings:        14 / 31  (45%)  -- clean PRs, reviewed correctly
  Reviews that caught Critical:     4 / 31  (13%)  -- high-value catches
  Reviews where human disagreed:    2 / 31   (6%)  -- false positives / misses
  Review finding accuracy:         94%             -- verified against merge outcomes

CODING TASKS
  PRs merged without rework:       13 / 18  (72%)
  PRs that needed 1 fix cycle:      4 / 18  (22%)
  PRs that needed 2+ fix cycles:    1 / 18   (6%)
  PRs that were rejected/closed:    0 / 18   (0%)
  
  Post-merge bugs filed (30d):      1         -- bug traced to WorkTrain PR
  Post-merge bugs rate:           5.6%        -- 1 in 18 PRs caused a bug

BUG INVESTIGATIONS
  Correct root cause identified:    6 / 8   (75%)
  Confidence was too high:          1 / 8   (13%)  -- confidently wrong
  Insufficient context:             1 / 8   (13%)  -- escalated correctly

OVERALL QUALITY SCORE:  78 / 100
  Trend:  ↑ +6 vs last month
```

**What the failure rate means:**
A 5.6% post-merge bug rate on coding tasks means roughly 1 in 18 WorkTrain PRs introduced a bug that was later filed as an issue. That's comparable to junior developer rates (industry average ~10-15%). If it rises above 10%, there's a systemic problem to investigate -- maybe the verification step isn't thorough enough, maybe certain task types are too risky for autonomous work.

The quality score is a weighted composite:
- Review accuracy (40%)
- Coding task success rate (35%)
- Investigation accuracy (25%)

It's the single number that answers "is WorkTrain doing good work?" A score below 70 should trigger a `workflow-effectiveness-assessment` run automatically.

---

#### Quality feedback loop

WorkTrain actively solicits quality signals:

1. **Post-merge outcome tracking:** when a PR merged by WorkTrain has a bug filed against it within 30 days, the session that produced that PR is flagged. The bug filing creates a data point that reduces the quality score.

2. **MR review validation:** when WorkTrain reviews a PR and the PR author disputes a finding (e.g. closes without fixing what WorkTrain flagged, or fixes something WorkTrain missed), that's a signal. WorkTrain tracks these via webhook: if a PR that WorkTrain reviewed APPROVE ships a Critical bug, that review retroactively becomes a miss.

3. **Human override tracking:** when a human changes a WorkTrain decision (reorders the queue, rejects a proposed change, overrides an auto-merge), those are signals that WorkTrain got something wrong. Each override is logged with a reason (if provided) and fed into the quality model.

4. **Explicit feedback:** `worktrain feedback "the PR #402 review missed the temp file cleanup issue"` appends to a feedback log. The workflow effectiveness assessment picks these up.

---

#### The quality dashboard (console Analytics tab)

```
┌─────────────────────────────────────────────────────┐
│ WorkTrain Analytics — workrail          Last 30 days │
├─────────────────────────────────────────────────────┤
│ QUALITY SCORE    78/100  ↑+6       COST  $12.40     │
│ ████████████████░░░░                                 │
├─────────────────────────────────────────────────────┤
│ VOLUME                    QUALITY                   │
│ PRs opened:    23         Merge success:   94%      │
│ PRs reviewed:  31         Review accuracy: 94%      │
│ Tasks done:    19         Post-merge bugs:  5.6%    │
│ Bugs found:     8         Bug investigation: 75%    │
├─────────────────────────────────────────────────────┤
│ TIME SAVED (estimated)                              │
│ Total: ~62h  Cost/hour: $0.20                       │
│ ████████████████████████████░░░ (62/80h budget)     │
├─────────────────────────────────────────────────────┤
│ TREND  ──────────────────────────────────           │
│ Quality score by week:                              │
│  W1: 68  W2: 71  W3: 74  W4: 78  ↑ improving       │
│                                                     │
│ Post-merge bug rate by workflow:                    │
│  coding-task (Small): 0%  (Medium): 8%  (Large): 0%│
│  → Medium tasks have highest bug rate, investigate  │
└─────────────────────────────────────────────────────┘
```

The "investigate" callout in the trend section is important -- the analytics dashboard doesn't just show numbers, it flags anomalies and links to the `workflow-effectiveness-assessment` that would address them. Stats → insight → action is the full loop.

---

### Pattern and architecture validation: WorkTrain enforces team conventions (Apr 15, 2026)

**The idea:** beyond just reviewing code for bugs, WorkTrain validates that the code matches the patterns and architecture the team expects. Not "does it work?" but "does it fit?"

**Two levels:**

**1. Philosophy lens (already partially built)**
The coding-task workflow already applies the user's coding philosophy as a review lens -- flagging violations by principle name. This needs to be extended to be:
- **Per-workspace configurable** -- different projects have different conventions
- **Machine-checkable** -- some patterns can be verified structurally (no direct db access outside the repository layer, no console.log in production code, no any types) rather than relying on the LLM to catch them

**2. Architectural invariant checking (new)**
Explicit rules about what the codebase's structure must look like:

```yaml
workspaces:
  workrail:
    architectureRules:
      # Layer boundaries
      - id: no-daemon-imports-from-mcp
        rule: "src/daemon/** must not import from src/mcp/**"
        type: import_boundary
        severity: error

      - id: no-di-calls-in-daemon
        rule: "src/daemon/** must not call initializeContainer() or container.resolve()"
        type: forbidden_call
        severity: error

      # Pattern enforcement
      - id: errors-as-data
        rule: "No throw statements in src/daemon/**, src/trigger/** -- use Result types"
        type: no_throw
        severity: warning
        exceptions: ["constructor", "assertExhaustive"]

      - id: no-exec-shell
        rule: "No child_process.exec() -- use execFile() with args array"
        type: forbidden_call
        severity: error

      - id: no-hardcoded-tmp
        rule: "No '/tmp/' string literals -- use os.tmpdir()"
        type: forbidden_literal
        severity: warning
```

These rules run as scripts (static analysis, not LLM) -- fast, deterministic, zero tokens. They're checked:
- During the coding-task workflow (before the agent commits anything)
- As part of the CI gate (same `posix_tmp_literal` rule we fixed in PR #390 -- this is exactly that pattern generalized)
- By the periodic architecture scan

**What this enables combined with quality metrics:**
If WorkTrain's coding tasks have a 5.6% post-merge bug rate AND those bugs consistently violate the same architectural rule, the pattern validation catches it before merge next time. Quality metrics identify the problem; architecture rules prevent recurrence. The self-improvement loop: bugs found → rule added → violations caught earlier → bug rate drops.

**The self-improvement connection:**
When the `workflow-effectiveness-assessment` runs and finds that a certain class of bug appears repeatedly in WorkTrain's output (e.g. "3 of the last 5 coding tasks had shell injection risks"), it can propose a new architecture rule (`no-exec-shell`) that prevents the pattern going forward. Rules start as soft warnings, graduate to errors after being validated. WorkTrain learns from its own failure patterns and codifies them as invariants.

---

### Resource management: preventing agent congestion under high concurrency (Apr 15, 2026)

**Observed problem:** running 10 simultaneous agents bogs down the system -- API rate limits, token exhaustion, context degradation from too many concurrent Bedrock/Anthropic calls, and the host machine running hot. The `maxConcurrentSessions` semaphore addresses the daemon-level cap, but the broader resource management problem has several dimensions.

**The dimensions:**

**1. API rate limits**
Anthropic and Bedrock both have tokens-per-minute limits. 10 concurrent agents each hitting the API at once creates bursts that exceed the limit, causing retries and backpressure. The daemon needs a token-bucket rate limiter shared across all sessions: before each LLM call, acquire a slot from the bucket. If the bucket is empty, wait.

**2. Host machine resources**
Each agent loop runs in-process, consuming RAM and CPU. Node.js is single-threaded but I/O is concurrent -- 10 agents making parallel API calls is fine until they all get responses simultaneously and saturate the JS event loop with JSON parsing and session store writes. The right limit is not "10 sessions" but "N sessions where N is calibrated to the host's memory and the model's response size."

**3. Tiered concurrency by task type**
Not all sessions are equal. A `wr.discovery` session is cheap (mostly reads, fast). A `coding-task-workflow-agentic` session is expensive (many tool calls, long responses). Running 10 coding tasks simultaneously is very different from running 10 discovery sessions.

```yaml
workspaces:
  workrail:
    concurrency:
      maxTotal: 6                  # global cap
      perWorkflowType:
        coding-task-workflow-agentic: 2    # expensive, cap low
        mr-review-workflow.agentic.v2: 3   # medium cost
        wr.discovery: 5                    # cheap, allow more
        bug-investigation.agentic.v2: 2
```

**4. Queue-aware throttling**
When the queue has a mix of high-priority and low-priority items, WorkTrain should prefer starting high-priority items even if slots are available for low-priority ones. If all slots are taken by low-priority work, high-priority items wait unnecessarily.

**5. Graceful degradation**
When the system is under load, WorkTrain should degrade gracefully rather than failing hard. Options:
- Slow down polling intervals (less frequent API calls)
- Prefer fast/cheap workflows over slow/expensive ones
- Pause the queue drain and process the backlog sequentially

**Build order:**
1. `maxConcurrentSessions` semaphore (in flight -- simple global cap)
2. Token-bucket rate limiter in the agent loop (prevents API bursts)
3. Per-workflow-type concurrency limits (tiered caps)
4. Queue-aware slot allocation (high-priority first)
5. Adaptive throttling based on observed latency (automatic backpressure)

**The meta-point:** WorkTrain running at full capacity on itself is the best stress test for these constraints. Every day we run 10 simultaneous agents, we discover the edges of what the system can handle. Those discoveries should directly inform the resource management implementation.


---

### Universal integration layer: WorkTrain interfaces with everything (Apr 15, 2026)

**The principle:** WorkTrain is not opinionated about your stack. It works with whatever version control, project management, communication, monitoring, and documentation systems you use -- cloud or self-hosted, SaaS or on-prem. The integration layer is the boundary where WorkTrain connects to the outside world.

---

#### Integration categories

**Version control**
| System | Interface | Notes |
|--------|-----------|-------|
| GitHub (cloud) | REST API + polling | Primary target, already designed |
| GitLab (cloud + self-hosted) | REST API + polling | Already in polling triggers |
| Bitbucket | REST API + polling | Same pattern as GitLab |
| Azure DevOps | REST API + polling | Large enterprise share |
| Gitea / Forgejo | REST API + polling | Self-hosted open source |
| Gerrit | REST API | Google's code review system |
| Raw git | git CLI + filesystem | No API needed -- just a remote |

All VCS integrations share the same polling adapter pattern. The difference is the API schema -- the `GitLabPoller` becomes a template: implement `fetchEvents(since: Date): Event[]` and WorkTrain handles the rest.

**Project management / ticketing**
| System | Interface | Notes |
|--------|-----------|-------|
| GitHub Issues | REST API (same token as VCS) | Zero extra config for GitHub users |
| GitLab Issues | REST API (same token as VCS) | Zero extra config for GitLab users |
| Jira (Cloud + Server + Data Center) | REST API + polling | Dominant enterprise tracker |
| Linear | GraphQL API | Dominant startup tracker |
| Asana | REST API | Common in non-engineering teams |
| Notion | REST API | Database + docs hybrid |
| Monday.com | REST API | Common in agencies/SMB |
| Azure Boards | REST API | Azure ecosystem |
| Shortcut (formerly Clubhouse) | REST API | Engineering-focused |

WorkTrain reads tickets to understand context, writes comments/status updates when work completes, creates new tickets when investigations surface issues, and transitions ticket status when PRs merge.

**Communication / notifications**
| System | Interface | Notes |
|--------|-----------|-------|
| Slack | Incoming webhooks + Bot API | Most common dev team chat |
| Microsoft Teams | Incoming webhooks + Graph API | Enterprise dominant |
| Discord | Webhooks + Bot API | Common in open source |
| Telegram | Bot API | Common for personal/small team |
| Email | SMTP | Universal fallback |
| PagerDuty | Events API | Incident escalation |
| OpsGenie | REST API | Alerting + on-call |
| Webhook (generic) | HTTP POST | Any system that accepts webhooks |

WorkTrain posts to the right channel based on the event type: PR review findings → the team's dev channel, critical incidents → #incidents + on-call, weekly health summary → #engineering, ideas → #product.

**Monitoring / observability**
| System | Interface | Notes |
|--------|-----------|-------|
| Sentry | REST API + polling | Error tracking |
| Datadog | REST API + polling | Metrics, traces, logs |
| New Relic | REST API | APM |
| Grafana / Prometheus | HTTP API | Self-hosted metrics |
| PagerDuty | Events API | Incident triggers |
| CloudWatch | AWS SDK | AWS-native |
| Custom HTTP endpoint | HTTP GET/POST | Any system with an API |

WorkTrain polls for threshold breaches (same `PollingTriggerSource` pattern as VCS), investigates anomalies, and posts findings back.

**Documentation**
| System | Interface | Notes |
|--------|-----------|-------|
| Confluence (Cloud + Server) | REST API | Most common enterprise wiki |
| Notion | REST API | Also a project management system |
| Google Docs / Drive | Google API | Common in startups |
| Markdown in repo | git + filesystem | Zero extra config |
| ReadTheDocs / Sphinx | Filesystem | Generated docs |
| Docusaurus | Filesystem | Modern static docs |

WorkTrain reads doc systems as reference context for agents (same as `referenceUrls` today). It writes back when documentation needs updating after code changes.

---

#### The integration architecture

**Three integration modes:**

1. **Polling source** (already built for GitLab) -- WorkTrain calls the external API on a schedule, deduplicates events, dispatches workflows. Works for: VCS (new PRs/issues), ticketing (new tickets), monitoring (threshold breaches).

2. **Delivery target** (already built for `callbackUrl`) -- WorkTrain POSTs results to an external system when a workflow completes. Works for: Slack/Teams/Discord notifications, Jira status updates, GitLab MR comments, PagerDuty incident resolution.

3. **Reference context** (already built for `referenceUrls`) -- WorkTrain fetches external documents and injects them into the agent's context. Works for: Confluence pages, Google Docs, Notion databases, external API docs.

**The integration manifest in triggers.yml:**
```yaml
integrations:
  github:
    token: $GITHUB_TOKEN
    baseUrl: https://api.github.com    # override for GitHub Enterprise
  
  jira:
    token: $JIRA_TOKEN
    baseUrl: https://mycompany.atlassian.net
    projectKey: ENG
  
  slack:
    webhookUrl: $SLACK_WEBHOOK_URL
    channels:
      reviews: "#code-review"
      incidents: "#incidents"
      weekly: "#engineering"
  
  datadog:
    apiKey: $DATADOG_API_KEY
    appKey: $DATADOG_APP_KEY

triggers:
  - id: new-jira-bug
    type: jira_poll
    source:
      integration: jira
      jql: "project = ENG AND issuetype = Bug AND status = Open AND created >= -1h"
      pollIntervalSeconds: 300
    workflowId: bug-investigation.agentic.v2
    goalTemplate: "Investigate Jira bug {{$.key}}: {{$.fields.summary}}"
    callbackUrl: "{{jira.baseUrl}}/rest/api/3/issue/{{$.key}}/comment"
```

**The adapter pattern:**
Each integration is a standalone adapter module in `src/trigger/adapters/`:
- `github-poller.ts` -- `fetchEvents(since): GitHubEvent[]`
- `gitlab-poller.ts` -- (already exists) `fetchEvents(since): GitLabMR[]`
- `jira-poller.ts` -- `fetchEvents(since): JiraIssue[]`
- `linear-poller.ts` -- `fetchEvents(since): LinearIssue[]`
- `sentry-poller.ts` -- `fetchEvents(since): SentryError[]`
- `datadog-poller.ts` -- `fetchEvents(since): DatadogAlert[]`

Each adapter implements the same interface. The `PollingScheduler` doesn't know which adapter it's running -- it just calls `fetchEvents()` and dispatches. Adding a new integration is: implement the adapter, add a type to `TriggerDefinition`, handle it in `trigger-store.ts`. No changes to the scheduler or router.

**Delivery adapters** follow the same pattern for writing back:
- `slack-delivery.ts` -- formats and POSTs to Slack webhook
- `jira-delivery.ts` -- adds comment to Jira issue, transitions status
- `github-delivery.ts` -- posts PR review comment, creates issue
- `pagerduty-delivery.ts` -- resolves or escalates incident

**The `callbackUrl` field becomes `deliveryTarget`** with a richer schema:
```yaml
deliveryTarget:
  type: slack           # or: jira, github, gitlab, pagerduty, webhook
  integration: slack    # reference to integrations block
  channel: "#code-review"
  # OR for generic webhook:
  url: https://hooks.example.com/worktrain
```

---

#### What this enables

A fully connected WorkTrain for a typical engineering team:

```
New Jira bug filed
  → WorkTrain investigates → posts findings as Jira comment
  → if auto-fixable → opens GitHub PR → reviews it → merges
  → transitions Jira ticket to "In Review" / "Done"
  → posts to #engineering: "Fixed JIRA-1234 autonomously -- PR #456"

Datadog alert fires
  → WorkTrain investigates logs + recent commits
  → posts to #incidents with root cause + affected files
  → if config fix → deploys fix → resolves PagerDuty incident
  → updates Confluence runbook with new pattern

Weekly
  → WorkTrain posts health summary to #engineering
  → files Linear tickets for technical debt items found in audit
  → updates Google Doc "Architecture Notes" with recent decisions
```

Zero humans needed unless the circuit breaker fires.

---

#### Build order

**Now (already works):** generic `callbackUrl` (HTTP POST to any endpoint). Any system that accepts webhooks works immediately.

**Near-term:** GitHub polling adapter (same as GitLab, already written as template), Slack delivery adapter (format + post to webhook).

**Medium-term:** Jira polling + delivery (high enterprise value), Linear polling (high startup value), PagerDuty delivery (incident escalation).

**Long-term:** the full matrix above. Each adapter is a bounded, testable, independently shippable unit. The architecture supports adding them without touching the core engine.

---



---

### Multi-project WorkTrain: workspace isolation vs cross-project knowledge (to investigate, Apr 15, 2026)

**The problem:** WorkTrain needs to handle multiple completely unrelated projects simultaneously, but some projects are related and need to share knowledge. These are contradictory requirements if handled naively.

**Three axes of tension:**

1. **Isolation vs shared context** -- project A's TypeScript symbols should never pollute project B's Python context. But if A and B share architectural patterns (both use WorkTrain, both follow the same auth pattern), that shared knowledge is valuable.

2. **Independent execution vs cross-project tasks** -- most tasks are scoped to one project. But some tasks span projects: "update the mobile app AND the backend API for this feature", "apply the same refactor pattern we used in workrail to storyforge".

3. **One daemon vs many** -- one daemon is easier to manage (one config, one console, one binary). Multiple daemons give true blast-radius isolation. The right answer is probably workspace namespacing inside one process, but with cross-namespace knowledge queries for when projects are related.

**The cross-project knowledge requirement:**
When two projects are related (share patterns, have a dependency relationship, or are being worked on together), the knowledge graph should be queryable across project boundaries -- but opt-in, not default. A session working on project A can explicitly query "what's the equivalent pattern in project B?" but never sees project B's context by default.

**Proposed model:** workspace namespacing with explicit cross-workspace links

```yaml
workspaces:
  workrail:
    path: ~/git/personal/workrail
    soul: ~/.workrail/souls/workrail.md
    knowledgeGraph: ~/.workrail/graphs/workrail.db
    maxConcurrentSessions: 3
    relatedWorkspaces: [storyforge]   # can query storyforge graph when explicitly needed
    
  storyforge:
    path: ~/git/personal/storyforge
    soul: ~/.workrail/souls/storyforge.md
    knowledgeGraph: ~/.workrail/graphs/storyforge.db
    maxConcurrentSessions: 1
    relatedWorkspaces: [workrail]
```

A session in `workrail` gets `workrail` context by default. If it calls `query_knowledge_graph(workspace: 'storyforge', ...)`, it gets storyforge context explicitly. The coordinator script can spawn workers in multiple workspaces for cross-project tasks.

**Investigation needed (discovery agent running):**
- Is workspace namespacing inside one process the right architecture, or should each project run a separate daemon?
- What exactly needs to be workspace-scoped vs globally shared?
- How do cross-project coordinator tasks work? (spawn worker in workspace A, spawn worker in workspace B, coordinator synthesizes)
- What's the knowledge graph query interface for cross-workspace queries?
- How does the console show multi-workspace activity without being overwhelming?
- What's the blast radius if one workspace's agent goes rogue?

**What CAN be shared globally (no namespace needed):**
- The WorkTrain binary and workflow library
- Token usage / billing tracking
- The message queue (`~/.workrail/message-queue.jsonl`)
- The merge audit log
- The outbox (notifications to the user)
- The `worktrain talk` session (can discuss any workspace)

**What MUST be workspace-scoped:**
- Knowledge graph (symbols from different codebases must not mix)
- daemon-soul.md (different stacks need different principles)
- Session store (project A's sessions should not appear in project B's console view by default)
- Concurrency limits (project A should not starve project B)
- Triggers and polling sources (each workspace has its own event sources)

---



---

### Never worktree main: branch safety rules for WorkTrain (Apr 16, 2026)

**Critical invariant:** WorkTrain must never check out `main` or `master` into a worktree. Locking main in a worktree blocks all other agents from checking out main and prevents fast-forward merges.

**The rule:**
- All agent worktrees must use feature branches, never `main` or `master` or any protected branch
- When creating a worktree for a task, WorkTrain always creates a new branch: `git worktree add <path> -b <branch-name>`
- If an agent needs to read main's state, it uses `git show origin/main:<file>` without checking out the branch
- Stale worktrees (branches that have been merged) must be cleaned up automatically after session completion

**How it breaks today:**
The `--isolation worktree` flag on subagents creates a worktree. If the agent's task involves reading and committing to main directly (e.g. a merge task), it can end up with main locked. This happened during today's session.

**The fix (two parts):**

1. **In the daemon worktree creation code:** before creating a worktree, check if the requested branch is `main`, `master`, or any branch in a configurable `protectedBranches` list. If so, create a new branch from it instead.

2. **In the daemon-soul.md:** add explicit rule:
```
## Branch Safety
- NEVER check out main, master, or any protected branch into a worktree
- NEVER use 'git checkout main' -- always work on a feature branch
- When merging to main, use 'gh pr merge' (via PR), never direct git push
- After a PR merges, immediately clean up the local worktree
```

3. **Automatic stale worktree cleanup:** after each session completes (success or failure), the daemon should run `git worktree prune` and remove any worktrees whose branches have been merged to main.


---


---

### Communication agent: Slack monitoring, email management, and suggested responses (Apr 16, 2026)

**The idea:** WorkTrain monitors your communication channels, understands context, and either responds on your behalf or prepares vetted drafts for you to send.

**Slack:**
- Monitor specified channels and DMs for messages that mention you, reference your projects, or require a response
- Understand context: "who is asking, what do they need, what's the relevant project state?"
- Options: auto-respond for routine questions ("what's the status of X?" → WorkTrain knows), draft a response for you to review and send, or surface with a notification "someone needs your input on Y"
- Configurable per-channel: some channels auto-respond, some always require your review
- Filter noise: identify which Slack threads are actually important vs chatter

**Email:**
- Same pattern as Slack -- monitor inbox, understand context, draft responses
- Suggest email filters, folder rules, and unsubscribe candidates based on patterns WorkTrain observes
- "You've received 47 newsletters this month from 12 senders and never opened them -- want me to unsubscribe?"
- Priority surfacing: "3 emails in your inbox need a response, here are the drafts"

**Important constraint:** WorkTrain never sends on your behalf without explicit approval for anything that goes to other people. Auto-respond is opt-in per-channel, with a review window before sending. You always see what was sent and can recall/edit.

---



---

### Local file organization and maintenance (Apr 16, 2026)

- WorkTrain scans specified directories for stale, duplicate, and disorganized files
- Suggests folder structures based on file content and usage patterns
- Identifies documents that are out of date and offers to update them
- Keeps project-related files in sync with the repo (e.g. local design files linked to Figma specs, local notes linked to Confluence pages)
- "~/Downloads has 847 files, most untouched for 6 months -- here's what's safe to delete and what should be archived"
- Connects to the knowledge graph: files that reference code or projects get indexed alongside the code

---



---

### Git worktrees and branch management as a first-class capability (Apr 16, 2026)

**Critical for parallel work.** WorkTrain needs native, sophisticated git management -- not just running git commands but understanding the full branching topology and managing it intelligently.

**What this means:**

**Worktree management:**
- Create, list, switch between, and clean up worktrees automatically
- Each concurrent task gets its own worktree (WorkTrain already does this via `.claude/worktrees/`)
- Detect and warn about stale worktrees (branches that have been merged or abandoned)
- The `cw <branch>` command pattern already exists -- WorkTrain should be able to invoke it for any task that needs isolation

**Branch lifecycle:**
- Know which branches are: active (being worked on), stale (no commits in N days), merged (on main), or orphaned (created but abandoned)
- Automatic cleanup proposals: "14 branches are merged and safe to delete, 3 are stale, 2 have uncommitted work"
- Rebase management: when main advances, WorkTrain knows which in-flight branches need rebasing and does it automatically (or queues it)
- Conflict detection: before spawning a new session, check if any in-flight branch would conflict with the planned changes

**Parallel work coordination:**
- When multiple tasks touch the same files, WorkTrain detects potential conflicts before they happen
- Sequences tasks that would conflict, parallelizes those that won't
- Maintains a "file lock" mental model: this file is being modified by session A, session B should wait or work on a different scope
- When a feature branch is ready, WorkTrain handles the full merge/rebase/PR creation flow

**Branch naming and organization:**
- Enforces consistent branch naming conventions (already partially done via daemon soul)
- Groups related branches: `feat/github-polling-*` are all part of the same epic
- Links branches to tickets/queue items: opening a PR creates the Jira transition, closing a PR cleans up the branch

**The `worktrain worktree` command family:**
```bash
worktrain worktree list                    # all worktrees and their status
worktrain worktree clean                   # remove merged/stale worktrees
worktrain worktree new <branch> [--task]   # create worktree + optionally link to queue item
worktrain worktree status                  # which files are locked by active sessions
```

This is especially critical when WorkTrain is managing 10 concurrent sessions -- without explicit worktree management, two sessions could clobber each other's changes on the same branch.

---


---

### Thin spots: ideas that need fuller spec (Apr 16, 2026)

These were mentioned and partially captured but need more detail when the time comes:

**`worktrain feedback` command:**
Explicit quality feedback loop. `worktrain feedback "the PR #402 review missed the temp file cleanup issue"` appends to `~/.workrail/feedback.jsonl`. The workflow-effectiveness-assessment picks these up alongside statistical patterns. User feedback is weighted higher than inferred signals.

**`worktrain idea` command:**
Lightweight idea capture without interrupting active work. `worktrain idea "nested subagents up to N depth"` appends to `~/.workrail/ideas-buffer.jsonl`. The `worktrain talk` session reviews the buffer at conversation start and decides what to groom into the backlog. Prevents good ideas from getting lost when 10 agents are running.

**Audience-aware status briefings (`--audience` flag):**
`worktrain status --audience owner` (full technical detail, default) vs `--audience stakeholder` (capability level, no PR numbers) vs `--audience external` (outcome level, no internal terminology). Same underlying data, different presentation layer. The Haiku-level routine adjusts verbosity and replaces technical terms with plain language.

**`worktrain queue` CLI commands:**
```bash
worktrain queue list [--workspace <name>]    # show queue with priorities and status
worktrain queue pause [--workspace <name>]   # stop draining
worktrain queue resume [--workspace <name>]  # resume draining
worktrain queue remove <id>                  # remove item
worktrain queue bump <id>                    # move to top
worktrain queue show <id>                    # full item details + pipeline plan
```

**Workspace-scoped soul and config:**
Each workspace has its own `daemon-soul.md` at a configurable path. Soul resolution cascade: trigger-level override → workspace soul → global `~/.workrail/daemon-soul.md` → built-in default. Enables TypeScript and Python workspaces to have different behavioral profiles on the same WorkTrain instance.

**Automatic worktree cleanup:**
After any session completes (success or failure), the daemon automatically runs `git worktree prune` and removes any worktrees whose branches are merged to main. Prevents the main-worktree-lock issue encountered today.

---

### The single-conversation problem: WorkTrain needs multi-threaded interaction (Apr 16, 2026)

A single chat where everything is happening at the same time is not ideal. When WorkTrain is managing 10 concurrent agents, it becomes impossible to know what's been captured vs what's floating, follow any one thread, or distinguish "in progress" from "needs a decision."

**Threaded conversations per work group:**
Each active work group gets its own conversation thread. You can follow the polling-triggers work in thread A without seeing the spawn/await implementation in thread B. Threads are persistent -- come back 2 hours later and pick up exactly where you left off.

**`worktrain talk` shows a thread list:**
```
Threads:
  ● WorkRail development     [3 active agents, 2 waiting]
  ● Storyforge chapter work  [idle]
  → Select thread or type to start a new one
```

**`worktrain idea` for mid-conversation capture:**
When a new idea comes up while 10 agents are running, `worktrain idea "..."` appends to an ideas buffer without interrupting active work. The talk session reviews the buffer at the start of each conversation.

**Build order:** thread model → thread list console view → cross-thread notifications → idea capture buffer.

---

### Nested subagent depth: configurable delegation chains (Apr 16, 2026)

WorkTrain should support nested subagents -- an agent spawning a subagent, which spawns its own -- up to a configurable depth limit.

```yaml
workspaces:
  workrail:
    agentDefaults:
      maxSubagentDepth: 3     # coordinator=0, worker=1, subagent=2, sub-subagent=3
      maxTotalAgentsPerTask: 10  # hard cap across all depths for a single task
```

**Depth semantics:**
- Depth 0: coordinator script (no LLM, pure script)
- Depth 1: main worker (coding-task, mr-review)
- Depth 2: subagent from workflow step (routine-context-gathering, etc.)
- Depth 3: sub-subagent (rare, deep investigation chains)
- Depth 4+: almost certainly a bug or runaway loop

**The `maxTotalAgentsPerTask` budget** prevents exponential explosion -- a depth-3 tree with 3 agents per node = 27 concurrent agents without this cap.

**Console DAG view** shows nesting depth as indentation. Makes over-delegation immediately visible.

---

### WorkTrain attribution and acting as the user (Apr 16, 2026)

**Attribution / signing:**
1. **Commit signatures:** commits made by WorkTrain include `Co-Authored-By: WorkTrain <worktrain@etienneb.dev>`. The configured `worktrain-bot` identity is consistent across all workspaces.
2. **PR/MR description footer:** `---\n🤖 Implemented by WorkTrain · Session: sess_abc123 · Workflows run: coding-task, mr-review`. Links to session for full audit trail.
3. **Issue/comment attribution:** WorkTrain comments include "WorkTrain investigation" with session link. Clearly not a human.

**Value:** audit trail, trust calibration for reviewers, "how much of our code was WorkTrain-authored?" becomes queryable, open-source visibility.

**Acting as the user:**
WorkTrain uses the user's git identity and GitHub account (via user's token) to act as them. PRs appear from @EtienneBBeaulac, commits show as Etienne Beaulac.

**Why useful:** normal PR approval flows, no bot account permissions needed, personal git history stays personal even for WorkTrain-authored work.

**Trust guardrails:** `actAsUser: true` explicit opt-in, only for commits/PRs (never emails or Slack without additional permission), PR description always notes "Created by WorkTrain," full audit log in `~/.workrail/actions-as-user.jsonl`.

---

### Console session detail: more than the DAG when running standalone (Apr 16, 2026)

**The gap:** the session DAG shows structure (steps, edges, progress) but not meaning. When you're watching a session run in the console without being in Claude Code, you want to know what the agent is *actually doing* -- not just which step it's on.

**What's missing from the current DAG view:**
- The latest step output note, rendered inline and updating as it streams (not hidden behind a click)
- A plain-English summary of what the agent is doing right now ("Analyzing the diff for shell injection risks")
- Current step prompt visible on demand (so you know what the agent was asked to do)
- Token count and cost estimate for the session so far
- Time elapsed + estimated time remaining based on step history
- A live feed of tool calls as they happen ("Reading trigger-router.ts", "Running npm test")

**The streaming step output** is the most valuable addition. Right now the DAG shows a step as "in progress" with a spinner. It should show the last few lines of the step's output note as it's being written, similar to how a terminal streams command output.

**Build order:**
1. Inline latest step output in the session detail panel (read from session store, poll every 2s)
2. Live tool call feed alongside the DAG (SSE from the daemon, log each tool call as it fires)
3. Token/cost counter (daemon tracks tokens per session, expose via GET /api/v2/sessions/:id)
4. Plain-English status line ("Step 3/8: analyzing diff" vs just a spinner)

This makes the console genuinely useful as a standalone monitoring surface -- not just for developers who understand the DAG topology, but for anyone who wants to know if WorkTrain is doing useful work or spinning.

---

### Orphaned daemon session state: smarter recovery (Apr 16, 2026)

**The problem:** When the daemon is killed mid-session, the session's in-process `KeyedAsyncQueue` promise chain is lost. On restart, the startup recovery reads orphaned session files and clears them from disk -- but the `serial` concurrency queue key based on `trigger.id` is an in-memory construct. Any external state (e.g. a lock file, a flag in the session store) that was tied to the queue is now inconsistent.

More critically: if a session is restarted by the daemon but then stalls (Bedrock call hangs, exception suppressed), the daemon log shows nothing after "Injecting workspace context" -- no error, no completion. The session is in limbo.

**What needs to happen:**

1. **Startup recovery should also clear any pending queue slots.** If a session file exists in `~/.workrail/daemon-sessions/` at startup, that trigger's queue key should be treated as free -- no prior promise is alive.

2. **Session liveness detection.** If a session has been `in_progress` for more than N minutes with no `advance_recorded` events, the daemon watchdog should log a warning and optionally abort the session. Currently a hung session is invisible.

3. **Orphaned session cleanup should be user-facing.** `worktrain cleanup` or `worktrain status` should surface orphaned sessions with their age and offer to clear them. Right now they silently accumulate.

4. **Better logging when runWorkflow() swallows errors.** The `void runWorkflow(...)` pattern in `console-routes.ts` and `trigger-router.ts` drops errors silently. Every path that ends in silence (no log, no session advance, no error) should at minimum log `[WorkflowRunner] Session died silently` with the session ID.

---

### Observability and logging as first-class citizens (Apr 17, 2026)

**The principle:** WorkTrain should never be a black box. Every action, decision, failure, and state transition should be traceable after the fact -- by a human, by another agent, or by a coordinator script. Logging and observability are not afterthoughts; they are core infrastructure.

**What "first-class" means:**

1. **Structured, not prose.** Every log line should be machine-parseable. Use consistent prefixes (`[WorkflowRunner]`, `[TriggerRouter]`, `[DaemonConsole]`), consistent key=value pairs, and structured JSON for rich payloads. No freeform strings that require regex to parse.

2. **Levels matter.** INFO for normal operations, WARN for recoverable anomalies, ERROR for failures that need attention. Silence = actively working, not unknown. A session that produces no logs for 5+ minutes should emit a heartbeat.

3. **Every state transition logged.** Session start, step advance, tool call, tool result (including errors), session end (success/timeout/error). No silent gaps. The daemon observability logs (#442) are a start -- extend this everywhere.

4. **Errors always include context.** Not just the message -- which session, which tool, which step, which trigger, how long it had been running, what the last successful action was. Enough to diagnose without re-running.

5. **Correlation IDs.** Every session has a `sessionId`. Every tool call has a `toolCallId`. Log entries should include the relevant ID so you can filter across a full session's history. Today the daemon logs include `sessionId` -- extend this to trigger IDs, workflow IDs, and step IDs.

6. **Log destinations are configurable.** Today: stdout → daemon.log file via redirect. Long-term: structured JSON to a log aggregator (Datadog, CloudWatch, file), separate log files per workspace, log rotation. The daemon should accept a `--log-level` flag and a `--log-format json|human` flag.

7. **The session store IS the audit log.** Every `advance_recorded`, `node_output_appended`, `validation_performed` event is a durable structured record. The session store should be queryable as a post-mortem tool. `worktrain session logs <id>` should reconstruct the full story of what happened.

**Specific gaps to close:**

- `continue_workflow` tool: log the step ID and notes length being submitted, not just "continue_workflow called"
- `makeBashTool`: log exit code and output length in addition to the command
- `makeReadTool` / `makeWriteTool`: log file path and bytes
- `AgentLoop`: log each LLM turn (turn number, stop reason, tool count) -- today nothing is logged between tool calls
- `TriggerRouter`: log when a session is queued (semaphore at capacity) and when it dequeues
- `PollingScheduler`: log each poll cycle result (N events found, N new, N dispatched)
- `DeliveryClient`: log delivery attempt, HTTP status, response time
- `DaemonConsole`: log when the console HTTP server starts, stops, or fails a request

**The `worktrain logs` command:**
```bash
worktrain logs                          # tail daemon.log
worktrain logs --session sess_abc123    # replay full session from event store
worktrain logs --trigger test-task      # all sessions for this trigger
worktrain logs --level error            # only errors across all sources
worktrain logs --since 1h               # last hour
worktrain logs --format json            # machine-readable output
```

**Self-healing dependency:** The automatic gap detection, WORKTRAIN_STUCK routing, and coordinator self-healing patterns all depend on logs being structured and complete. You can't auto-fix what you can't observe. Logging quality is a prerequisite for autonomous operation at scale.

---

### Event sourcing for orchestration: extend the session store to daemon and coordinator events (Apr 17, 2026)

**The decision:** extend the existing WorkRail event store infrastructure to cover orchestration-level events, not build a separate system. The session store is already append-only, crash-safe, content-addressed, and queryable -- rebuilding those properties would be wasteful.

**The model: multiple event streams, same infrastructure**

```
~/.workrail/events/
  sessions/          ← already exists (per-session workflow events)
  daemon/            ← new: lifecycle, triggers, delivery, errors
  triggers/          ← new: per-trigger poll history and outcomes
  coordinator/       ← future: coordinator script decisions and routing
```

Each stream is append-only JSONL with the same segment/manifest pattern as the session store. The `worktrain logs` command queries across streams. Watchdog and coordinator scripts subscribe to streams.

**Daemon event stream: what gets recorded**

Every significant daemon action becomes a structured event:

```jsonl
{"ts":"2026-04-17T...","kind":"daemon_started","port":3200,"workspacePath":"...","version":"3.31.0"}
{"ts":"...","kind":"trigger_fired","triggerId":"test-task","workflowId":"coding-task-workflow-agentic"}
{"ts":"...","kind":"session_queued","sessionId":"sess_abc","triggerId":"test-task","queueDepth":0}
{"ts":"...","kind":"session_started","sessionId":"sess_abc","workflowId":"coding-task-workflow-agentic","modelId":"..."}
{"ts":"...","kind":"tool_called","sessionId":"sess_abc","tool":"Bash","command":"ls docs/ | grep trigger"}
{"ts":"...","kind":"tool_error","sessionId":"sess_abc","tool":"Bash","error":"exit 1","isError":true}
{"ts":"...","kind":"step_advanced","sessionId":"sess_abc","stepId":"phase-0-triage-and-mode","advance":1}
{"ts":"...","kind":"session_completed","sessionId":"sess_abc","stopReason":"stop","durationMs":1847000}
{"ts":"...","kind":"delivery_attempted","sessionId":"sess_abc","callbackUrl":"https://...","status":200}
{"ts":"...","kind":"poll_cycle","triggerId":"pr-review","eventsFound":3,"newEvents":1,"dispatched":1}
```

**`DaemonEventEmitter`:** thin wrapper around the event store, called from TriggerRouter, workflow-runner, delivery-client, and polling-scheduler. Each call appends one event to `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`. Zero overhead when nothing is listening.

**`worktrain logs` CLI:** reads from both session store and daemon event stream, correlates by `sessionId`, presents a unified timeline:

```
worktrain logs                          # tail current daemon events
worktrain logs --session sess_abc123    # full timeline: trigger → steps → delivery
worktrain logs --trigger test-task      # all sessions for this trigger  
worktrain logs --level error            # only errors across all streams
worktrain logs --since 1h               # last hour of activity
worktrain logs --format json            # machine-readable for scripts
```

**SSE extension:** the console already streams session events via SSE. Extend to also stream daemon events so the console live feed shows everything: trigger fires, tool calls, delivery attempts, errors -- not just step advances. This is the "more than just the DAG" console improvement.

**Why this matters for self-healing:** The coordinator self-healing pattern requires the coordinator to observe what happened. Today it reads `lastStepNotes` and session store snapshots -- both batch reads after the fact. With a subscribable daemon event stream, the coordinator can react in real time: "tool_error event for session X → spawn diagnostic sub-session now" rather than "check for WORKTRAIN_STUCK markers after the fact."

**Build order:**
1. `DaemonEventEmitter` + daemon event stream file (append-only JSONL, no fancy infra needed to start)
2. Wire emitter calls into TriggerRouter, workflow-runner, delivery-client
3. `worktrain logs` CLI commands (reads files, correlates by sessionId)
4. SSE extension in DaemonConsole for live event streaming
5. Coordinator script subscription to event streams (replaces polling session store)

---

### Subagent context packaging: the main agent assumes too much (Apr 17, 2026)

**The problem:** When a main agent spawns a subagent, the work package it creates is usually too thin. The main agent has rich context from the full conversation -- why this task matters, what was already tried, what constraints were discovered -- but it packages the subagent task as if that context is shared. The subagent gets a one-liner and has to rediscover everything from scratch.

This is the same problem as a developer handing a junior a vague JIRA ticket instead of a proper brief. The subagent wastes tokens re-deriving what the main agent already knows, or worse, makes wrong assumptions.

**Where this manifests:**
- Coding task subagents that don't know why a specific approach was chosen
- MR review subagents that don't know what invariants matter for this codebase
- Discovery subagents that re-read files the main agent just read
- Fix subagents that don't know what was already tried and failed

**Three solution directions:**

**Option A: Better instructions to the main agent (prompt engineering)**
Add explicit guidance to the WorkTrain system prompt: "When spawning a subagent, include: (1) what you already know that the subagent won't, (2) what was already tried, (3) why this specific approach was chosen, (4) what constraints or invariants matter, (5) what 'done' looks like." This is the cheapest fix but depends on the main agent reliably following it.

**Option B: Platform-assisted package creation (structured)**
The `worktrain spawn` command (or the `spawn_session` tool) takes a structured work package:
```typescript
spawnSession({
  workflowId: 'coding-task-workflow-agentic',
  goal: '...',
  context: {
    whyThisApproach: '...',        // what the main agent knows about the decision
    alreadyTried: [...],           // what failed
    knownConstraints: [...],       // invariants the subagent must respect
    relevantFiles: [...],          // files the main agent already read
    completionCriteria: '...'      // what done actually looks like
  }
})
```
The platform validates that the package is complete before spawning -- missing fields emit a warning or block the spawn. The subagent's system prompt is enriched with this context automatically, without the main agent having to think about how to format it.

**Option C: Platform-mediated context transfer (autonomous)**
The platform automatically packages context from the spawning session into the child session. When the main agent calls `spawn_session`, the platform reads the current session's step notes and recent advances, synthesizes a context bundle, and injects it into the child's system prompt. No explicit packaging required from the main agent.

This is the most powerful but also the most complex -- requires the platform to understand what's relevant, not just what's recent.

**Recommended approach: B + A**
Option B (structured work package with validation) as the primary mechanism. Option A (better main agent instructions) as a fallback. Option C as a long-term goal once the knowledge graph and session event stream are queryable enough to synthesize context automatically.

**The `context` field in the structured package is the key addition.** Today `worktrain spawn` takes `goal`, `workflowId`, `workspacePath`. Adding a structured `context` object that the platform validates and injects gives subagents the brief they need without depending on the main agent to remember to include it.

**Connection to knowledge graph:** Once the structural knowledge graph is built, `relevantFiles` can be auto-populated from a graph query rather than requiring the main agent to list them. The platform asks "what files are relevant to this goal?" and includes them automatically. This is how the context packaging problem gets solved at scale -- the platform knows what the subagent needs without the main agent having to enumerate it.

**Session knowledge log (extends Option B):**
As the main agent progresses, it continuously appends to a structured `session-knowledge.jsonl` for the session. Not step notes (those are workflow artifacts) -- this is a running record of things that would matter to any agent picking up this work:

```jsonl
{"kind":"decision","summary":"Using execFile not exec for all subprocess calls","reason":"Shell injection risk with user-controlled content","ts":1234567890}
{"kind":"user_pushback","summary":"User rejected the polling approach","detail":"Wants webhook-based solution instead","ts":...}
{"kind":"relevant_file","path":"src/trigger/trigger-router.ts","why":"Core routing logic, all trigger changes flow through here","ts":...}
{"kind":"constraint","summary":"Never modify triggers.yml autonomously","source":"daemon-soul.md","ts":...}
{"kind":"tried_and_failed","summary":"Tried npx approach, got version mismatch","detail":"Local build is different from installed package","ts":...}
{"kind":"external_ref","url":"https://github.com/...","why":"Design doc for the delivery pattern","ts":...}
{"kind":"plan","path":"implementation_plan.md","summary":"3-slice plan for the feature","ts":...}
```

When spawning a subagent, the platform automatically includes the session knowledge log in the work package. The subagent gets the full brief without the main agent having to reconstruct it.

**Blank subagents (intentionally uncontextualized):**
Sometimes you explicitly DON'T want context from the main session -- fresh eyes are the point. A hypothesis challenge subagent should challenge the leading hypothesis, not be anchored to it. An adversarial reviewer should find problems without knowing the main agent thinks the approach is sound.

The `spawn_session` call should have an explicit `context: 'inherit' | 'blank' | 'custom'` field:
- `inherit` -- auto-package from session knowledge log (default for most tasks)
- `blank` -- no session context injected, subagent starts fresh (for adversarial roles)
- `custom` -- explicit structured package (for precise control)

**Subagent types with specialized system prompts and tools:**

Different tasks need different cognitive profiles. A subagent type bundles: system prompt, available tools, and context mode:

| Type | System prompt focus | Tools | Context |
|------|---------------------|-------|---------|
| `researcher` | Thorough, neutral, evidence-first | Read, Bash (read-only), Glob, Grep | inherit |
| `challenger` | Adversarial, finds holes, challenges assumptions | Read, Bash | blank (intentionally unanchored) |
| `implementer` | Precise, follows plans, no improvisation | Read, Write, Bash, continue_workflow | inherit |
| `reviewer` | Finds bugs, security issues, philosophy violations | Read, Bash | blank |
| `verifier` | Confirms claims with evidence, runs commands | Read, Bash | inherit |
| `coordinator` | Routes work, reads event streams, dispatches | worktrain_spawn, worktrain_await | inherit |

The type determines the system prompt variant, not just the tools. A `challenger` gets a system prompt that explicitly says "your job is to find problems, not solve them -- do not offer solutions." A `verifier` gets "do not trust claims without running the commands yourself."

This is the WorkTrain equivalent of cognitive specialization -- different agents for different modes of thought, not just different tasks. The workflow step can specify which subagent type to spawn: `spawn_session({ type: 'challenger', goal: '...' })`.

---

### Workflow-scoped system prompts for subagents (Apr 17, 2026)

**The idea:** Workflows (and individual steps within them) can declare a `systemPrompt` field that gets injected into subagent sessions spawned by that workflow step. The workflow author encodes the cognitive mode directly rather than describing it in step prose that the agent has to interpret.

**Why this is the right layer:**
The workflow already controls: what steps run, what tools are available, what the output contract is, what assessments are required. The cognitive mode -- how the agent should think -- is a natural extension of that. A workflow that says "run as adversarial challenger" should be able to enforce that at the platform level, not just suggest it in a prompt.

**Two levels:**

**1. Workflow-level `systemPrompt`** -- applies to all subagents spawned by this workflow:
```json
{
  "id": "mr-review-workflow.agentic.v2",
  "systemPrompt": "You are an adversarial code reviewer. Your job is to find problems, not validate the approach. Do not offer solutions -- only surface issues with evidence. Treat every claim as unproven until you verify it yourself.",
  "steps": [...]
}
```

**2. Step-level `systemPrompt`** -- overrides the workflow-level prompt for a specific step:
```json
{
  "id": "phase-hypothesis-challenge",
  "systemPrompt": "You are a devil's advocate. For every assumption in the hypothesis, find the strongest counterargument. Do not be balanced -- be adversarial.",
  "prompt": "Challenge the leading hypothesis..."
}
```

**How it composes with the base system prompt:**
The final subagent system prompt is assembled in layers:
1. WorkTrain base prompt (execution contract, oracle priority, tools)
2. Workflow-level `systemPrompt` (cognitive mode for this workflow)
3. Step-level `systemPrompt` (cognitive override for this step)
4. Soul file (operator behavioral rules)
5. AGENTS.md / workspace context
6. Session knowledge log (inherited context, if `context: 'inherit'`)
7. Step prompt (the actual work instruction)

The workflow author controls layers 2-3. The operator controls layer 4. The platform assembles 1 and 5-7 automatically. Clear separation of concerns.

**This also enables the subagent type system** (from the previous backlog entry) to be workflow-driven rather than call-site-driven. Instead of `spawn_session({ type: 'challenger' })`, the workflow step that spawns a challenger simply declares `systemPrompt: "you are adversarial..."` -- the cognitive mode travels with the workflow definition, not the spawn call.

**Schema addition:**
```typescript
interface WorkflowDefinition {
  systemPrompt?: string;  // workflow-level, injected into all subagent sessions
  steps: WorkflowStep[];
}

interface WorkflowStep {
  systemPrompt?: string;  // step-level, overrides workflow-level for this step
  prompt: string;
  // ...existing fields
}
```

**Authoring implication:** The `workflow-for-workflows` meta-workflow should guide authors to write cognitive mode as `systemPrompt` rather than embedding it in `prompt` prose. "What mode should the agent be in?" is a structural question, not a content question.

---

### Console as the unified WorkRail dashboard -- standalone, file-reading, zero coupling (Apr 18, 2026)

**The insight:** The console is the unified view of all WorkRail activity -- whether sessions were started by the autonomous daemon or by a human working interactively through the MCP server. It doesn't care how a session was created. It reads the same session store either way.

The console doesn't need a live connection to either the daemon or the MCP server. It reads files. The current architecture where the console is owned by whichever process wins a port election is wrong -- it's a legacy of when the MCP server was the only long-running process.

**Target architecture -- zero coupling:**

```
Daemon          → writes ~/.workrail/data/sessions/
                → writes ~/.workrail/events/daemon/
                → serves :3200 (webhooks only)

MCP server      → reads/writes session store (same files as daemon)
                → serves :3100 (Claude Code bridge only)

Console         → reads ~/.workrail/data/sessions/ (file watch, not HTTP)
                → reads ~/.workrail/events/daemon/ (file watch)
                → reads git for PR/commit context
                → serves :3456 (browser UI only)
                → `worktrain console` -- fully standalone binary
```

**No startup coordination. No lock files. No port election. No coupling.**

The console works whether the daemon is running or not, whether the MCP server is running or not. Start it once, leave it running permanently. It shows whatever is in the files.

**How it gets live updates without HTTP:** FSEvents (macOS) / inotify (Linux) file watching on the session store and daemon event stream. When a new event is appended, the console picks it up within milliseconds and pushes to the browser via SSE -- same latency as today, no polling, no HTTP connection to the daemon required.

**The `worktrain console` command:**
```bash
worktrain console              # start on default port 3456
worktrain console --port 4000  # custom port
worktrain console --workspace ~/git/myproject  # workspace-scoped view
```

**Migration:** Remove console startup from both the daemon command and the MCP server startup. The primary election logic (`DashboardLock`, `bindWithPortFallback`) becomes unnecessary. The `DaemonConsole` module in `src/trigger/daemon-console.ts` becomes `src/console/standalone-console.ts` with a simpler interface.

**Why this matters:** Today the console goes down whenever the MCP server crashes. With this architecture, the console is as stable as the filesystem. The daemon crashing doesn't affect the console. The MCP server crashing doesn't affect the console. The only thing that can take down the console is killing the `worktrain console` process itself.

---

## WorkTrain sprint: Apr 17-18, 2026 -- shipped and current state

### What shipped (Apr 17-18)

**Daemon stabilization:**
- ✅ `report_issue` tool -- agents call this instead of dying silently; structured JSON written to `~/.workrail/issues/<sessionId>.jsonl`, event emitted to daemon stream, WORKTRAIN_STUCK marker in `WorkflowRunResult`
- ✅ Richer `BASE_SYSTEM_PROMPT` -- baked-in behavioral principles (oracle hierarchy, self-directed reasoning, workflow-as-contract, silent failure policy) rather than relying on soul file alone
- ✅ `/bin/bash` for Bash tool -- process substitution `<(...)` and other bash-specific syntax now works
- ✅ `DaemonEventEmitter` -- structured event stream at `~/.workrail/events/daemon/YYYY-MM-DD.jsonl`
- ✅ Self-configuration -- `triggers.yml`, upgraded `daemon-soul.md` (WorkRail-specific rules + coding philosophy), `AGENTS.md` WorkTrain section

**Workflow library:**
- ✅ mr-review v2.6 -- `philosophy_alignment` reviewer family; scoped philosophy extraction in fact packet; 7th coverage domain; "is this the right design?" framing
- ✅ wfw v2.5 -- phases 2 and 3 split into dedicated prep-step design steps (2a/2b, 3a/3b); principle: assessments need dedicated prep steps, not on-the-fly evidence gathering
- ✅ Clean workflow display names across library (removed `v2 •`, `Lean •`, etc.)
- ✅ `philosophy.mdc` created at `~/.firebender/commands/philosophy.mdc` -- MR review subagents now evaluate findings against coding philosophy

**Integrations and infrastructure:**
- ✅ GitLab polling triggers fully merged (#404) -- zero-webhook MR polling
- ✅ TS6 forward-compat tsconfig fixes (#401) -- unblocks TypeScript 6 dep bumps
- ✅ Standalone console spec -- `worktrain console` as independent file-reading binary, zero coupling to daemon or MCP server

---

### Current state (Apr 18, 2026)

**What works:**
- Daemon runs autonomously on webhook triggers
- Sessions advance through full workflow steps
- Console at `:3456` when daemon starts before MCP server
- Daemon event stream logging every tool call
- GitLab + GitHub polling (no webhooks needed)
- Philosophy-aligned MR reviews
- `report_issue` tool available to agents

**Known issues / active bugs:**

1. **Daemon killed by MCP server reconnects** (CRITICAL) -- the daemon and MCP server share process infrastructure via the bridge mechanism. When Claude Code reconnects and a new MCP server process starts, it displaces the running daemon. The daemon must be run from a separate terminal or as a `launchd` service to survive MCP reconnects. Root fix: decouple daemon from the MCP server process tree entirely.

2. **Console unstable** -- the console port (3456) is contested between daemon and MCP server. Whoever starts first wins. When the MCP server reconnects, it takes the port and the daemon console goes down. Root fix: standalone `worktrain console` binary (spec in backlog).

3. **`workflow_not_found` on first test** -- trigger used `coding-task-workflow-agentic.lean.v2` (filename) instead of `coding-task-workflow-agentic` (workflow ID). Fixed in triggers.yml. Symptom of workflow ID vs filename confusion -- worth a validator that catches this at `worktrain daemon` startup.

4. **Session advances 0 when daemon crashes** -- if daemon dies mid-Phase-0 (before any `continue_workflow` call), the session is orphaned at `observation_recorded(8)` with 0 advances and no output. No automatic recovery. Crash recovery reads the daemon-session token file but can't resume a session that never advanced. No fix yet.

---

### Next priorities (groomed Apr 18)

**Tier 1 -- Must fix for reliable autonomous operation:**
1. **Daemon as a launchd service** -- run daemon outside Claude Code's process tree so MCP reconnects can't kill it. `worktrain daemon --install` creates a launchd plist and starts it.
2. **Standalone `worktrain console`** -- file-watching binary independent of daemon/MCP. Zero coupling. Spec in backlog.
3. **Workflow ID validation at startup** -- `workrail daemon` should validate that all `workflowId` values in triggers.yml resolve to real workflows before starting, not fail silently at dispatch time.

**Tier 2 -- Workflow quality:**
4. **mr-review prep steps** -- the audit identified missing dedicated prep steps for philosophy extraction, pattern baseline, and design decision reconstruction. These are described in the backlog but not yet in the workflow JSON. wfw v2.5 guides new workflows to add them; the mr-review workflow itself still needs a v2.7 pass to implement them.
5. **Autonomous workflow variants** -- audit `requireConfirmation` gates across all workflows; confirm daemon's `autonomy: full` setting correctly bypasses the right ones.

**Tier 3 -- Features:**
6. **`worktrain spawn` / `worktrain await`** -- already merged, needs real-world test
7. **Auto-commit from handoff artifact** -- merged but untested end-to-end
8. **Session knowledge log** -- continuous context accumulation for subagent packaging
9. **TypeScript 6 dep bump** -- tsconfig fixes are in (#401), unblocks #244 and #231

**Open PRs (only dep bumps remain):**
- #330, #287, #288 -- vitest 4 + vite 8 (major version, needs testing)
- #244, #231 -- TypeScript 6.0.2 (now unblocked by #401)

---

### Duplicate task detection: prevent agents from doing the same work twice (Apr 18, 2026)

**The problem:** with multiple agents running concurrently and a persistent work queue, it's easy to accidentally start two agents on the same task -- especially when the queue drains items from external sources (GitHub issues, Jira) that may be added again after a sync. Today, two agents can independently pick up the same issue, do the same investigation, and open duplicate PRs.

**Detection sources:**
1. **Open PRs**: before starting any coding task, check `gh pr list --state open` -- if a PR already exists that addresses the same issue/goal, skip it
2. **Active sessions**: the session store knows which workflows are currently running and what their goals are; a new dispatch can check for semantic overlap before starting
3. **Queue deduplication**: the work queue should deduplicate by external item ID (GitHub issue number, Jira ticket key) so the same item can't be enqueued twice
4. **Session history**: before starting an investigation, check recent session notes for the same workflowId + goal combination -- if it was completed in the last 24 hours with a successful result, skip or ask the user

**Implementation approach:**
- Queue-level dedup is the simplest and most reliable: each queue item from an external source carries its `sourceId` (e.g. `github:EtienneBBeaulac/workrail:issues:123`). On enqueue, check if `sourceId` already exists in the queue (pending or active) -- if so, skip with a log.
- PR-level dedup: before `worktrain spawn` dispatches a coding task, run `gh pr list --search "<issue title keywords>"` and check for matches. If found, add to outbox ("task already in progress as PR #X") and skip.
- Session-level dedup: the coordinator script checks active session goals before spawning a new one with the same goal text.

**The classify-task-workflow role:** when a task is classified, it can also output a `deduplicationKey` (e.g. `fix:trigger-store:error-kind-consistency`) that is stored with the queue item. Queue items with the same key are considered duplicates.

**What makes this hard:** semantic dedup (two tasks described differently but solving the same problem) requires embedding-based similarity, not exact match. For MVP, exact `sourceId` match + approximate PR title search is sufficient. Semantic dedup is a post-knowledge-graph feature.

---

### Agent actions as first-class events in the session event log (Apr 18, 2026)

**The vision:** the console should be able to reconstruct exactly what an agent did in a session -- every tool call, every argument, every result, every decision -- by reading the event log alone. No log files, no stdout parsing, no separate monitoring infrastructure. The session event store IS the audit trail.

**What's already in the event log:**
- `session_created`, `run_started`, `run_completed`
- `node_created`, `edge_created`, `advance_recorded`
- `node_output_appended` (step notes)
- `preferences_changed`, `context_set`, `observation_recorded`

**What's missing -- agent-level actions:**
- `tool_call_started` -- which tool was called, with what arguments, at what timestamp
- `tool_call_completed` -- result (truncated), duration, success/error
- `llm_turn_started` -- model, token count estimate, step context
- `llm_turn_completed` -- stop reason, output tokens, whether steer() was injected
- `steer_injected` -- what context was injected and why (session recap, workspace context)
- `report_issue_recorded` -- the structured issue from the `report_issue` tool
- `worktrain_stuck` -- when WORKTRAIN_STUCK marker is emitted

**Why this matters:**
Today the `DaemonEventEmitter` writes to `~/.workrail/events/daemon/YYYY-MM-DD.jsonl` separately from the session store. That's two places to look -- and they're not correlated to specific sessions. Putting agent actions into the session event log means:
- Console can show a session timeline: "Phase 0: called `bash` 3 times (12ms, 8ms, 45ms) → called `read` 2 times → advanced to Phase 1"
- The proof record (verification chain spec) can link specific tool calls to assessment gate evidence
- Crash recovery knows exactly where in the agent's execution it died
- The knowledge graph can be updated from session events without re-reading step notes

**The event schema (additions to the existing event store format):**

```typescript
// Tool call lifecycle
{ kind: 'tool_call_started', tool: 'bash', args: { command: 'git status' }, nodeId, ts }
{ kind: 'tool_call_completed', tool: 'bash', durationMs: 45, exitCode: 0, resultSummary: '...', nodeId, ts }
{ kind: 'tool_call_failed', tool: 'bash', durationMs: 45, error: 'ENOENT', nodeId, ts }

// LLM turn lifecycle  
{ kind: 'llm_turn_started', model: 'claude-sonnet-4-6', inputTokens: 12000, nodeId, ts }
{ kind: 'llm_turn_completed', stopReason: 'tool_use', outputTokens: 450, toolsRequested: ['bash'], nodeId, ts }

// Steer injection
{ kind: 'steer_injected', reason: 'session_recap', contentLength: 800, nodeId, ts }

// Agent self-reporting
{ kind: 'report_issue_recorded', severity: 'warning', summary: '...', sessionId, ts }
```

**Where to emit them:**
- In `src/daemon/agent-loop.ts` -- before and after each `tool.execute()` call, before and after each LLM call
- In `src/daemon/workflow-runner.ts` -- for steer injection and report_issue recording
- Use the existing `V2ToolContext` session store to append events (same mechanism as `continue_workflow` and `start_workflow`)

**Console rendering:**
Each session detail view gets a "Timeline" tab alongside "Steps" and "Notes":
```
Phase 0: Understand & Classify         [2m 14s]
  ├── llm_turn              450 tokens → 3 tool calls
  ├── bash: git status                    45ms ✓
  ├── bash: gh pr list                   180ms ✓  
  ├── read: AGENTS.md                      8ms ✓
  └── llm_turn              280 tokens → advance
Phase 1a: State Hypothesis              [0m 38s]
  ├── llm_turn              310 tokens → advance
  ...
```

**Relationship to DaemonEventEmitter:**
The existing `DaemonEventEmitter` (written in #498) writes to a separate daily log file. Once agent actions are first-class session events, the daemon event emitter can be simplified or removed -- the session event log is the canonical record. The console reads session events, not daemon event files.

**Build order:**
1. Add `tool_call_started`/`tool_call_completed` events to `agent-loop.ts` -- smallest change, highest value
2. Add `llm_turn_started`/`llm_turn_completed` events
3. Console Timeline tab reads and renders the new event kinds
4. Wire `report_issue_recorded` and `steer_injected` events
5. Deprecate `DaemonEventEmitter` once console reads from session events

---

### FatalToolError: distinguish recoverable from non-recoverable tool failures (follow-up from PR #523)
The blanket try/catch in AgentLoop._executeTools() converts ALL tool throws to isError tool_results. This is correct for Bash/Read/Write (LLM can see and retry), but potentially wrong for continue_workflow failures (LLM retrying with a broken token loops). The discovery agent proposed a FatalToolError subclass: tools throw FatalToolError for non-recoverable errors (session corruption, bad tokens), plain Error for recoverable failures. _executeTools catches plain Error and returns isError; FatalToolError propagates and kills the session. Combined with the DEFAULT_MAX_TURNS cap (PR followup), this provides defense-in-depth.

---

### Worktree lifecycle management: automatic cleanup and inventory (Apr 18, 2026)

**The problem:** every WorkTrain agent that uses `--isolation worktree` leaves a worktree on disk after completion. With 10 concurrent agents running all day, this accumulated to 69 worktrees in `.claude/worktrees/`, triggering hundreds of simultaneous `git status` processes that saturated the CPU.

**What's needed:**

1. **Automatic cleanup on session end** -- when a WorkTrain session completes (success or failure), the daemon automatically runs `git worktree remove <path> --force` for the session's worktree. If the branch is already merged to main, also delete the local branch ref.

2. **Startup pruning** -- `workrail daemon` startup runs `git worktree prune` in each configured workspace before starting the trigger listener.

3. **`worktrain worktree list`** -- shows all WorkTrain-managed worktrees: path, branch, session ID, age, whether the branch is merged.

4. **`worktrain worktree clean`** -- removes all worktrees whose branches are merged to main, or older than N days. Dry-run mode by default.

5. **`worktrain worktree status`** -- summary: how many worktrees, total disk usage, any stale ones.

6. **Never use main as a worktree** (already in backlog) -- enforced at worktree creation time, not just as a rule.

**Root cause of the CPU spike:** 69 worktrees × repeated `git status --short` from tools/IDE plugins = hundreds of concurrent git processes. Each `git status` on a large repo with many untracked files is CPU-intensive.

**Mitigation already in place:** `--isolation worktree` creates branches named `worktree-agent-<id>` -- these are identifiable and bulk-deletable. The daemon's `runStartupRecovery()` could also prune them.

**Build order:** startup pruning (trivial, high value) → automatic cleanup on session end → `worktrain worktree` CLI commands.

---

### Simplify MCP server: remove primary election, bridge, and HTTP serving (architectural cleanup)

**The core insight:** the bridge/primary-election system exists solely to solve "only one process should serve the console UI on port 3456." Now that `worktrain console` is a standalone file-watching binary (PR #512), that problem is already solved. The entire bridge/election system can be removed.

**What "allow multiple MCP processes" means in practice:**
- Each Claude Code window gets its own MCP server -- no port contention, no primary election, no bridge reconnect cycles
- MCP server becomes pure stdio: starts, handles tools, exits. Nothing async needs to write after the pipe closes -- EPIPE is irrelevant.
- Session store is append-only JSONL per-session -- multiple processes writing different sessions cannot corrupt each other
- `worktrain console` aggregates all sessions from the file store regardless of how many MCP servers ran

**What to remove:**
- `DashboardLock` / `tryBecomePrimary()` / `bindWithPortFallback()` -- the entire primary election system
- `bridge-entry.ts` -- the bridge, spawn storm, and reconnect drama are gone
- `HttpServer` starting as part of the MCP server -- console owns HTTP, not MCP

**What remains for the MCP server:** pure stdio MCP protocol + session engine. No HTTP, no port binding, no lock files. Starts instantly, exits cleanly.

**Why this is safe:**
- Tokens are session-scoped UUIDs -- two servers cannot share a session
- Append-only JSONL has no exclusive file locks
- ~50MB per process × 3 Claude Code windows = 150MB -- acceptable

**The bridge complexity was always a band-aid.** It was the right solution when the MCP server also owned the console UI. With the standalone console, the band-aid can come off and the system becomes dramatically simpler and more reliable.

**Build order:** extract `worktrain console` fully (done) → remove HttpServer from MCP startup → remove bridge → remove DashboardLock/primary election → MCP server is pure stdio.

---

### Agent-engine communication: first principles design (Apr 18, 2026)

**The setup for this conversation:**

Three discovery agents investigated whether the daemon should continue using MCP-style tool calls for workflow control (`continue_workflow`). Their findings:

- **Discovery 1**: Tool calls are fine; enrich `continue_workflow` with `artifacts` now, explore structured output hybrid later pending Bedrock verification. ~225 tokens/request saved with hybrid.
- **Discovery 2**: `complete_step` tool -- daemon owns transitions, continueToken hidden from LLM, notes required at type level. Cleaner DX without paradigm shift.
- **Discovery 3**: The field has converged on tool calls. OpenAI Agents SDK, LangGraph, Temporal, Vercel AI SDK all use tool calls for workflow control. WorkRail's `continue_workflow` with HMAC tokens is already field-standard or better.

**User's response to "the field has converged on tool calls":**

> "Right, but do we want industry standards? Aren't we trying to build something special? What if there is better?"

This is the right question. "Field convergence" is a description of where everyone ended up starting from the MCP/function-calling paradigm -- not proof that it's optimal. Every system surveyed treats the workflow engine as external infrastructure the agent calls into. WorkRail is different: **the daemon IS the workflow engine**. The agent loop and the step sequencer run in the same process, sharing the same DI container. Tool calls are a network-origin concept -- they exist because there's an LLM over there and an executor over here. WorkRail doesn't have that constraint.

---

#### First-principles alternatives (unexplored territory)

These were not in any of the discovery agents' outputs -- they emerge from the insight that WorkRail owns both sides of the conversation:

**1. Structured response parsing (no tool call for workflow control)**
The agent outputs a structured response at the end of each turn. The daemon parses it. The LLM never "calls a tool" to advance -- it produces a well-structured output and the daemon acts on it. The continueToken and workflow machinery are completely invisible to the LLM. Example: agent outputs `{"step_complete": true, "notes": "...", "artifacts": [...]}` as its final text, daemon detects this and advances.

**2. Implicit advancement (criteria-based)**
The daemon watches what the agent produces (file writes, bash outcomes, notes) and decides when to advance -- the agent never explicitly signals "I'm done." The workflow step has completion criteria, and the daemon evaluates them against the agent's cumulative output. More like a CI pipeline (tests pass = done) than an API call. The agent just works; the daemon decides when the step is complete.

**3. Declarative intent + daemon execution**
The agent outputs what it *wants* to happen: "I want to commit these files with this message and advance to the next step." The daemon executes. Same as the scripts-over-agent principle applied to the agent's own workflow control -- the agent declares intent, scripts execute. No tool call for the mechanical parts.

**4. Streaming judgment**
The daemon reads the agent's streaming response in real-time, extracts notes and artifacts as they appear, and makes the advance decision before the agent "finishes." No explicit signal from the agent. The daemon monitors and decides.

**5. Separation of concerns: tools for world, declaration for workflow**
Keep tool calls for external actions (Bash, Read, Write) -- these genuinely need interleaved execution and result reasoning. But workflow control (advance, submit artifacts, set context) uses a different mechanism entirely: structured response, implicit detection, or a single lightweight declaration. The protocol distinction: tools are for I/O, declarations are for state.

---

#### What makes this hard

These alternatives trade off in important ways:
- **Structured response parsing**: requires reliable structured output from the LLM, which can fail without explicit enforcement
- **Implicit advancement**: requires the daemon to correctly evaluate completion criteria -- complex for open-ended steps
- **Declarative intent**: still needs some kind of output format; essentially moves the "tool call" into the response text
- **Streaming judgment**: hardest to implement correctly; requires the daemon to parse partial responses reliably

The current tool-call approach works precisely because it's explicit: the agent signals intent exactly once, the daemon acts on it. The alternatives are more elegant but less reliable.

---

#### What to actually investigate

Before committing to any alternative, these questions need answers:

1. **Does Bedrock support `response_format + tools` simultaneously?** A 10-line test call resolves this. If yes, hybrid structured output is immediately viable for workflow control.
2. **What does implicit advancement actually look like for a coding task?** Write out the completion criteria for `coding-task-workflow-agentic` phase-0 (classify). Can a daemon reliably detect "Phase 0 is done" without an explicit signal?
3. **What is the actual failure mode of structured response parsing?** How often does Claude 4.6 Sonnet fail to produce valid JSON when asked to end its turn with a structured summary? Under what conditions?
4. **What did nexus-core do?** The backlog notes nexus-core as a more advanced system -- how does it handle agent-step transitions?

These are prototype questions, not design questions. Build the smallest possible test for each before committing to any direction.

---

### Bundled trigger templates: zero-config workflow automation via worktrain init (Apr 18, 2026)

**Problem:** Every user has to write their own triggers.yml manually. Wrong workflow IDs, missing required fields, wrong workspace paths -- all common mistakes (we hit all three today). There's no "just works" path to workflow automation.

**Solution:** Ship common trigger templates bundled with WorkTrain. `worktrain init` presents a menu and generates a pre-filled triggers.yml.

**Bundled templates to ship:**

```yaml
# Template: mr-review
- id: mr-review
  workflowId: mr-review-workflow-agentic
  goal: "Review the PR specified in the webhook payload goal field"
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 30 }

# Template: coding-task  
- id: coding-task
  workflowId: coding-task-workflow-agentic
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 60 }

# Template: discovery-task
- id: discovery-task
  workflowId: wr.discovery
  concurrencyMode: parallel
  autoCommit: false
  agentConfig: { maxSessionMinutes: 60 }

# Template: bug-investigation
- id: bug-investigation
  workflowId: bug-investigation.agentic.v2
  agentConfig: { maxSessionMinutes: 45 }

# Template: weekly-health-scan (cron, when native cron trigger ships)
# - id: weekly-health-scan
#   type: cron
#   schedule: "0 9 * * 0"
#   workflowId: architecture-scalability-audit
```

**`worktrain init` flow:**
1. "Which workflows do you want to run automatically?" (checkbox menu)
2. For each selected: set `workspacePath` to current directory (overridable)
3. Generate `triggers.yml` in the workspace root
4. Validate workflow IDs exist before writing (use the startup validator)
5. Tell the user how to fire each trigger: `curl -X POST http://localhost:3200/webhook/<id> ...`

**Why this matters:** The difference between WorkTrain being usable by anyone vs only by engineers who read the source code. A new user should be able to go from `worktrain init` to their first automated workflow in under 5 minutes.

**Also needed:** `worktrain trigger add <template-name>` to add a single trigger to an existing triggers.yml without re-running init.

---

### Coordinator context injection standard: agents start informed, not discovering (Apr 18, 2026)

**The problem:** subagents spawned by a coordinator are completely blind. They know nothing of prior conversations, existing docs, the pipeline, or what's already been tried. The workflows compensate by spending 3-5 turns on "Phase 0: context gathering" every session -- expensive in tokens, time, and LLM turns -- just to get oriented before work starts.

**The root cause:** the coordinator spawns agents with task descriptions but not context. "Fix the Windows CI failures" is a task. "The Windows CI failures are in `workflow-runner-bash-tool.test.ts` because `node -e` isn't in PATH on Windows -- the fix is to use `process.execPath` instead of `node`, which is the established pattern in this codebase" is context. The difference is 0 discovery turns vs 5.

**The standard to establish:**

Every coordinator-spawned agent gets a pre-packaged context bundle. The coordinator assembles it before calling `worktrain spawn`. The bundle includes:

1. **Prior session findings** -- what relevant sessions discovered (from session store query)
2. **Established patterns** -- the specific invariants and patterns the agent needs (from knowledge graph or AGENTS.md)
3. **What NOT to discover** -- explicit list of things already known so the agent doesn't waste turns
4. **Failure history** -- what's been tried and didn't work (prevents re-exploring dead ends)

**Format:** ~2000 tokens max, injected as a `<context>` block before the task description. Structured so the agent can skip Phase 0 context gathering entirely when the bundle is complete.

**Build order:**
1. Write the standard as a prompt template for coordinator scripts (`worktrain spawn` calls)
2. The knowledge graph provides the infrastructure for querying relevant context automatically
3. Eventually: `worktrain spawn` reads the context bundle from the graph + session store automatically, coordinator doesn't have to assemble it manually

**Why this is high priority:** every agent spawned today without proper context is burning tokens on discovery that should have been provided upfront. At 10 concurrent agents, that's 10x the waste. With proper context injection, Phase 0 becomes 1 turn instead of 5, and output quality improves because the agent starts with the right mental model.

---

### Context budget per spawned agent: capped, structured, queryable (Apr 18, 2026)

**The companion spec to context injection:**

Rather than hoping agents discover the right context, the coordinator guarantees a minimum context budget: a pre-packaged bundle of ~2000 tokens that every agent starts with. The knowledge graph is what makes this scalable -- without it, the coordinator has to manually assemble context from files, which is itself expensive.

**Bundle contents (structured):**
- `<relevant_files>` -- paths + key excerpts from files the agent will likely touch (from KG query)
- `<prior_sessions>` -- summaries of the last 3 sessions that touched related code (from session store)
- `<established_patterns>` -- specific patterns the agent must follow (e.g. "use `tmpPath()` not `/tmp/`")
- `<known_facts>` -- things already proven true (e.g. "semantic-release runs automatically after CI, not before")
- `<do_not_explore>` -- explicit list of dead ends and already-tried approaches

**How the knowledge graph enables this:**
- `relevant_files`: KG query "what files are related to the goal?" returns the structural subgraph
- `prior_sessions`: session store query "what sessions touched these files in the last 7 days?"
- `established_patterns`: AGENTS.md + KG pattern nodes
- `known_facts` and `do_not_explore`: built by the coordinator from prior session outputs

**Without the KG (today):** the coordinator manually includes key context in the prompt. Better than nothing, but requires the coordinator to know what's relevant.
**With the KG (future):** `worktrain spawn --workflow X --goal "..."` automatically queries the KG and assembles the context bundle. Coordinator just provides the goal.

---

### Decouple goal from trigger definition -- late-bound goals for daemon sessions (Apr 18, 2026)

**The problem:** `goal` is currently required at trigger-definition time (in triggers.yml). For triggers like `mr-review`, the goal is inherently dynamic -- it's the PR title and description, known only when the webhook fires, not when the trigger is configured.

The current workaround: `goalTemplate: "{{$.goal}}"` with the caller passing `{"goal": "Review PR #123..."}` in the webhook payload. This works but is awkward -- the caller must know the payload field convention, and it's not obvious from the trigger definition.

**The right model:** separate "which workflow" (trigger definition) from "what to do" (dispatch-time goal).

```yaml
# Trigger definition -- no goal required
triggers:
  - id: mr-review
    workflowId: mr-review-workflow-agentic
    workspacePath: ~/git/myproject
    # No goal here -- goal comes from dispatch context
```

```bash
# Dispatch with goal at call time
curl -X POST http://localhost:3200/webhook/mr-review \
  -d '{"goal": "Review PR #123: fix authentication bug"}'

# Or via worktrain spawn
worktrain spawn --trigger mr-review --goal "Review PR #123: fix authentication bug"
```

**Implementation options:**

1. **goalTemplate with `$.goal` as the default** -- if no `goal` is set in the trigger and no `goalTemplate` is set, default to `goalTemplate: "{{$.goal}}"`. The webhook payload's `goal` field becomes the canonical way to pass a dynamic goal. Zero breaking changes.

2. **Late-bound goal field on WorkflowTrigger** -- `executeStartWorkflow` accepts `goal` as a separate parameter. The trigger provides everything except the goal; the dispatcher (TriggerRouter) resolves the goal from the webhook payload or a default. This makes the separation explicit at the type level.

3. **Prompt injection** -- the workflow's first step can read `context.goal` which is injected from the webhook payload. The trigger has a static placeholder; the real goal comes through as a context variable. This is how it currently half-works but without the clean API.

**Preferred: Option 1 (default goalTemplate)** -- minimal change, backward compatible, works immediately. If `goal` is absent from the trigger and the webhook payload contains `{"goal": "..."}`, use it. Document this as the standard pattern for dynamic-goal triggers.

**Also needed:** the `worktrain spawn` CLI command should accept `--goal` as a first-class flag (already partially implemented) so coordinator scripts can pass goals without knowing the webhook payload format.

**Why this matters for WorkTrain being production-ready:** most real-world triggers (PR review, issue investigation, incident response) have dynamic goals that depend on what just happened. Static goals in triggers.yml only work for scheduled/cron tasks. Late-bound goals make the whole trigger system composable with external events.

---

### Session identity: a unit of work is one session, not many (Apr 18, 2026)

**The problem:** WorkTrain creates a separate WorkRail session for every workflow run. A task that involves discovery + design + implementation + review + re-review appears as 5 unrelated sessions in the console. There's no way to know they belong together without reading the goals. The user sees 50 flat sessions instead of 10 units of work.

**The correct model:** a session is a unit of work, not a workflow run. "Review PR #559" is one session. It might internally run 3 workflow sessions (context gathering, review, re-review) but the user sees one thing with one identity.

**What's needed:**

**1. Parent-child session relationships**
`session_created` in the session store gets an optional `parentSessionId` field. When a coordinator spawns a child via `worktrain spawn`, the child carries the parent's ID. The session store becomes a tree.

```typescript
// session_created event
{
  kind: 'session_created',
  sessionId: 'sess_abc123',
  parentSessionId: 'sess_root456',  // NEW -- absent for root sessions
  workflowId: 'wr.discovery',
  goal: '...'
}
```

**2. Root session as the identity**
The root session is what the user sees. It represents the unit of work ("Review PR #559", "Implement GitHub polling adapter"). Child sessions are implementation details -- they may be visible on drill-down but not in the top-level list.

**3. Console session DAG view**
The console shows root sessions, each expandable to show the tree of child sessions:
```
● Review PR #559                    [3 sessions, 22 min]
  ├── wr.discovery (context)        [completed, 8 min]
  ├── mr-review-workflow-agentic    [completed, 11 min]  
  └── coding-task (fix findings)    [running, 3 min...]
```

**4. Session identity propagated through coordinator**
`worktrain spawn` accepts `--parent-session <id>` to link child sessions. The coordinator script passes this when spawning each phase of a pipeline. When spawning via the daemon trigger, the trigger's initial session becomes the root.

**Relationship to coordinator sessions spec:**
The coordinator sessions spec (`spawn_session` + `await_sessions` tools) handles the orchestration. This spec handles the identity and visibility. They're complementary: coordinator scripts drive the work, session identity makes the work visible as a coherent unit.

**Why this matters:**
- Today: user sees "what are all these sessions?" -- has to read goals to understand grouping
- With this: user sees "here are my 5 units of work today" -- each one tells a coherent story
- The console becomes a work log, not a session log

**Build order:**
1. Add `parentSessionId` to `session_created` event schema (small, additive)
2. `worktrain spawn --parent-session <id>` flag (wires through TriggerRouter dispatch)
3. Console aggregates sessions by root and shows tree on expand
4. Dashboard "work sessions" view replaces flat session list as default

---

### Trigger-derived tool availability and knowledge configuration (Apr 18, 2026, to investigate)

**Observation:** the trigger already declares what external system matters. A `gitlab_poll` trigger means the agent will be working on GitLab content. A `jira_poll` trigger means Jira. WorkTrain should use this declaration to automatically configure what tools and knowledge sources the agent gets -- no manual per-trigger MCP configuration.

**Idea 1: Implicit tool availability from trigger source**
If `provider: gitlab_poll` → agent automatically gets GitLab MCP tools.
If `provider: github_poll` → agent gets GitHub tools.
If `provider: jira_poll` → agent gets Jira tools.
The trigger source is a declaration of intent -- WorkTrain infers the tool environment from it. No extra config needed for the common case.

**Idea 2: Trigger as knowledge configuration**
The trigger could declare where the agent gets different kinds of knowledge:

```yaml
- id: jira-bug-fix
  provider: jira_poll
  knowledge:
    general:   [glean, confluence]         # background org knowledge
    codebase:  [github, local-kg]           # structural code knowledge  
    task:      [jira-ticket, related-prs]   # what this specific task is about
    style:     [team-conventions, agents-md] # how to do the work
```

The daemon assembles a pre-packaged context bundle from these sources before the agent starts. The agent skips Phase 0 discovery entirely for the declared knowledge domains.

**Why this is interesting:**
- Closes the loop between "what triggers the work" and "what context the agent needs"
- The trigger author knows better than anyone what knowledge sources are relevant
- Eliminates redundant context gathering across sessions for the same trigger type
- Natural fit with workspace-scoped MCP config and the knowledge graph

**What needs investigating:**
- Is the trigger → tool mapping always 1:1 (gitlab_poll → gitlab MCP) or does it need explicit override?
- What are the right "knowledge categories"? (general, codebase, task, style seem like a reasonable starting set)
- How does this interact with the knowledge graph? (local-kg is already planned as a knowledge source)
- Can this be inferred automatically or does it always need explicit declaration?
- How do you handle a trigger that spans multiple systems (e.g. a Jira ticket about a GitHub PR)?

**This is a design-first item** -- the ideas are promising but the right shape isn't obvious. Needs a discovery pass before any implementation.

---

### Rethinking the subagent loop from first principles (Apr 18, 2026)

**Step back from all assumptions.** The current design assumes subagent spawning works like Claude Code's `mcp__nested-subagent__Task` -- the LLM decides when to spawn, what to give it, and handles the result. That's not the only model, and it might not be the best one for WorkTrain.

---

#### The current assumption (inherited from Claude Code)

```
Agent decides → calls spawn_agent tool → subagent runs → agent gets result → agent continues
```

The LLM is the orchestrator. It decides when parallelism is needed, what context to pass, how to handle results.

**Problems with this:**
- LLMs are bad at orchestration decisions -- they sometimes delegate when they shouldn't, sometimes don't when they should
- Context passing is lossy -- the LLM decides what to include, which is usually insufficient
- Subagent output competes with everything else in the parent's context window
- The LLM has to reason about the subagent's output before continuing -- burns context and turns
- No enforcement -- the LLM can skip delegation entirely and just do the work itself (often wrong)

---

#### Alternative model: workflow-declared parallelism, daemon-enforced

**The workflow spec is the orchestration. The daemon is the orchestrator. The LLM is the executor.**

```yaml
# Workflow step definition
- id: parallel-review
  type: parallel
  agents:
    - workflow: routine-correctness-review
      contextFrom: [phase-3-output, candidateFiles]
    - workflow: routine-philosophy-alignment  
      contextFrom: [phase-0-output, philosophySources]
    - workflow: routine-hypothesis-challenge
      contextFrom: [phase-2-output, selectedApproach]
  synthesisStep: synthesize-parallel-review
```

The daemon sees this step definition and:
1. Automatically spawns 3 child sessions with specified workflows
2. Injects the declared context bundles (from prior step outputs) into each child
3. Waits for all 3 to complete
4. Passes all 3 results to a synthesis step
5. Injects the synthesis into the parent agent's next turn

**The parent LLM never decides to spawn anything.** It just does its part. The workflow declares the orchestration pattern. The daemon enforces it.

---

#### What this changes about the agent's job

Today: "Do this work, and decide when to delegate parts of it to subagents."

New model: "Do this bounded cognitive task. The daemon handles everything else."

The agent's job becomes strictly about the cognitive work -- reasoning, writing, deciding within a defined scope. Orchestration, parallelism, context packaging, result synthesis -- all daemon responsibilities defined by the workflow spec.

---

#### The agent gives context to the daemon, not to subagents directly

Instead of the LLM calling `spawn_agent({ goal: "...", context: {...} })`, the workflow step has:

```yaml
- id: context-gathering
  output:
    contextFor:
      - step: parallel-review
        keys: [candidateFiles, invariants, philosophySources]
```

The agent writes outputs as structured artifacts. The daemon routes those artifacts to the right child agents at the right time. The LLM never packages context for a subagent -- it just produces outputs, and the workflow spec declares where those outputs go.

**This is the shift:** from "agent as orchestrator" to "workflow as orchestrator, daemon as executor, agent as cognitive unit."

---

#### What the subagent loop might look like

```
Parent workflow step completes
  ↓ Daemon reads step output artifacts
  ↓ Daemon checks workflow spec for parallel/sequential children
  ↓ Daemon spawns child sessions with structured context bundles
  ↓ Children run their bounded tasks
  ↓ Daemon collects child outputs
  ↓ Daemon passes synthesized context to parent's next step
  ↓ Parent continues with full context
```

No LLM orchestration. No token-burning context packaging decisions. No "did I remember to delegate this?" uncertainty.

---

#### What needs to be designed (don't implement yet)

1. **Workflow step schema for parallelism** -- how does the workflow spec declare parallel agents, sequential chains, fan-out/fan-in patterns?
2. **Context routing spec** -- how does a step's output get routed to specific child agents? What's the schema for `contextFor`?
3. **Synthesis patterns** -- how do multiple child outputs get combined? (concatenate? LLM synthesis step? structured merge?)
4. **Failure handling** -- if one child fails, what happens? (fail-fast? continue with partial results? retry?)
5. **Depth limits** -- same constraints as native agent spawning, but enforced at the workflow level not tool level
6. **Backward compatibility** -- workflows that currently use `mcp__nested-subagent__Task` can be migrated incrementally

**This is a design-first item.** Run a discovery session to explore the design space before any implementation. The current assumptions about subagent loops may be entirely wrong.

---

### Workflow runtime adapter: one spec, two runtimes (Apr 18, 2026)

**The core insight:** as workflows evolve (potentially morphing significantly once the subagent loop is rethought), the workflow JSON becomes the canonical spec for *what work needs to happen*. How that spec gets executed depends on the runtime. A single adapter layer translates the canonical spec to runtime-specific execution plans.

**Two runtimes, one spec:**

```
workflows/mr-review-workflow-agentic.json  ← canonical spec (unchanged)
         ↓
WorkflowAdapter.forRuntime('mcp')          ← MCP runtime interpretation
WorkflowAdapter.forRuntime('daemon')       ← Daemon runtime interpretation
```

**What each adapter does:**

MCP adapter (human-in-the-loop):
- Preserves `requireConfirmation` gates
- Presents `continue_workflow` tool call interface
- LLM drives subagent spawning manually via `mcp__nested-subagent__Task`
- Maintains backward compat with all existing Claude Code usage

Daemon adapter (fully autonomous):
- Removes or auto-bypasses `requireConfirmation` gates
- Replaces `continue_workflow` with `complete_step` (daemon manages tokens)
- Converts workflow-declared parallelism into automatic child session spawning
- Routes step outputs to child agents per workflow spec
- Enforces output contracts at step boundaries

**Why this matters as workflows evolve:**

Once the subagent loop is rethought (workflow-as-orchestrator model), workflow steps will likely declare parallelism, context routing, and synthesis patterns explicitly. These declarations make no sense to the MCP runtime (a human is already deciding this in real-time). The adapter translates them:

```yaml
# Workflow spec (future shape)
- id: parallel-review
  type: parallel
  agents: [correctness, philosophy, hypothesis-challenge]
  contextFrom: [phase-3-output]
```

MCP adapter sees this → renders as: "You should spawn 3 reviewer subagents now. Here's a template..."
Daemon adapter sees this → actually spawns 3 child sessions automatically

The workflow spec describes the intent. The adapter knows how each runtime fulfills it.

**Key guarantee:** workflow improvements automatically benefit both runtimes. Improving `mr-review-workflow-agentic`'s philosophy alignment step shows up whether a human runs it through Claude Code or WorkTrain runs it autonomously. No dual maintenance.

**Also eliminates "autonomous workflow variants":** the backlog had a separate item for autonomous variants of workflows. With the adapter, the canonical workflow spec is the only version -- the daemon adapter handles what "autonomy: full" means in practice. No parallel workflow files.

**Build order:**
1. Define the canonical workflow spec surface (what can be declared)
2. MCP adapter (largely a no-op -- existing behavior, but formally defined)
3. Daemon adapter (the interesting one -- translates declarations to daemon execution)
4. Converter for upgrading existing workflow JSONs to the new canonical spec if the schema evolves

**Dependencies:** requires the subagent loop rethinking to be resolved first -- the adapter can't be designed until we know what the workflow spec will declare.

---

### User notifications when daemon starts and finishes work (Apr 18, 2026)

**The problem:** the daemon silently starts and finishes sessions. Unless you're watching the console or tailing the log, you have no idea work happened or completed. For autonomous sessions that run over minutes or hours, this is a significant UX gap.

**What users need to know:**
- Session started: "WorkTrain started reviewing PR #566" (with a link)
- Session completed: "WorkTrain finished reviewing PR #566 -- APPROVED, no findings" (with session link)
- Session failed/stuck: "WorkTrain got stuck on PR #566 after 15 turns -- needs attention" (with details)

**Notification channels -- anything the user wants:**

The notification system should be open-ended. Any channel that accepts a webhook or has an API should be configurable. The architecture is: `DaemonEventEmitter` → `NotificationRouter` → one or more configured channels.

Short-term (easiest to ship):
- **Outbox.jsonl** -- already spec'd. `worktrain inbox` reads it, mobile client polls it. Works everywhere, zero config.
- **Generic webhook** -- HTTP POST to any URL. Covers Slack, Discord, Teams, PagerDuty, Zapier, IFTTT, and anything else that accepts webhooks. One implementation, infinite integrations.
- **macOS notification** -- `osascript` on Mac. Useful for local dev awareness.
- **Linux/Windows notification** -- `notify-send` on Linux, Windows Toast via PowerShell.

Medium-term (first-class integrations):
- **Slack** (direct API, not just webhook -- enables threading, reactions, rich formatting)
- **Discord** (webhook, then bot for richer interactions)
- **Microsoft Teams** (Adaptive Cards)
- **Telegram** (popular for personal automation)
- **Email** (SMTP for async, digest mode)

Long-term (when mobile exists):
- **Mobile push notifications** -- the mobile app (spec'd in backlog) receives push notifications directly. When the app exists, this becomes the primary channel -- native push is better than any polling-based alternative.
- **Desktop app** -- if WorkTrain ever has a desktop app, native notifications from there.

**The outbox is the universal foundation.** Every notification goes through `~/.workrail/outbox.jsonl` first. Channel-specific delivery (webhook, Slack, push) is a fan-out from the outbox. This means: a mobile app polling the outbox gets ALL notifications regardless of which other channels are configured.

**Config:**
```json
// ~/.workrail/config.json
{
  "notifications": {
    "onSessionComplete": true,
    "onSessionFailed": true,
    "onStuck": true,
    "onSessionStart": false,
    "channels": [
      { "type": "webhook", "url": "$SLACK_WEBHOOK_URL" },
      { "type": "webhook", "url": "$DISCORD_WEBHOOK_URL" },
      { "type": "macos" },
      { "type": "outbox" }
    ]
  }
}
```

**Build order:** outbox.jsonl integration (foundation, works everywhere) → generic webhook (covers Slack/Discord/Teams/anything) → platform notifications (macOS/Linux/Windows) → mobile app push (when mobile exists).

---

## 🎉 WorkTrain first confirmed end-to-end autonomous session (Apr 18, 2026)

**Timestamp:** 2026-04-18T15:09:49Z  
**Commit:** `473f4bd0` (main)  
**npm version:** v3.34.1 (published, installable by anyone)  
**What happened:** A real MR review workflow (`mr-review-workflow-agentic`) ran completely autonomously via webhook trigger, advanced through all phases (context gathering, review, synthesis, validation, handoff), self-validated, and produced a structured finding set. 8 step advances, `outcome: success`.

**Trigger:** `POST /webhook/mr-review {"goal": "Review PR #566: fix two minor bugs..."}`  
**Session:** `sess_3bmjuzf7l2vrqynjtleg5iskm4`  
**Result:** APPROVE with High confidence. 3 Minor findings, 1 Informational. Correctly decided not to delegate since no Critical/Major issues.

---

### What works at this commit

- ✅ Daemon accepts webhooks, starts sessions, runs workflows end-to-end
- ✅ Sessions advance through all workflow phases autonomously
- ✅ `mr-review-workflow-agentic` v2.6 runs fully -- context gathering, review phases, synthesis loop, validation, handoff
- ✅ `wr.discovery` v3.2.0 runs fully -- with new phase-0-reframe (goal reframing before research)
- ✅ Console shows live sessions via event log (no daemon connection required)
- ✅ MCP server is stable (bridge removed, EPIPE fixed, v3.34.1 published)
- ✅ GitHub + GitLab polling triggers (no webhooks needed)
- ✅ `worktrain init`, `tell`, `inbox`, `spawn`, `await` CLI commands
- ✅ Stuck detection + visibility (`worktrain status`, `worktrain logs --follow`)
- ✅ `complete_step` tool -- daemon manages continueToken, LLM never handles it
- ✅ Assessment gate circuit breaker (stops at 3 blocked attempts, shows artifact format)
- ✅ `worktrain daemon --install` creates launchd service (daemon survives MCP reconnects)
- ✅ Self-configuration (`triggers.yml`, `daemon-soul.md`, `AGENTS.md` for workrail repo)

### Current limitations at this commit

**Blocking reliable complex workflows:**
1. **`complete_step` not yet tested in production** -- just merged, daemon still using `continue_workflow` in running sessions. Needs daemon restart to take effect.
2. **Assessment gates still unreliable** -- `complete_step` fixes the token issue; the `artifacts` field (#557) fixes the submission issue. But `coding-task-workflow-agentic` phases with quality gates haven't been tested end-to-end yet.
3. **Native `spawn_agent` not yet merged** -- implementation in progress. Until it lands, all subagent delegation is via `mcp__nested-subagent__Task` (invisible black box).
4. **No session identity (parentSessionId)** -- multi-phase work appears as unrelated flat sessions in the console.

**Architecture not yet realized:**
5. **Coordinator scripts don't exist** -- `worktrain spawn/await` is there but no templates.
6. **Subagent loop not rethought** -- LLM still decides when to delegate; workflow-as-orchestrator model is spec'd but not built.
7. **Workflow runtime adapter not built** -- workflows run in daemon mode as-is; no MCP vs daemon adaptation layer.
8. **Knowledge graph not built** -- context gathering still sweeps files on every session.
9. **MCP simplification PR-B not done** -- HttpServer still starts with MCP server.

**Missing for production autonomy:**
10. **No notifications** -- daemon completes work silently. Users have no awareness unless watching console/logs.
11. **No auto-commit from handoff artifact** -- merged but untested end-to-end.
12. **Late-bound goals not implemented** -- triggers require static goals; dynamic goals (like PR reviews) need `goalTemplate: "{{$.goal}}"` as default.
13. **No coordinator script template** -- the multi-phase autonomous pipeline exists as primitives but not as a usable script.

---

### Artifacts as first-class citizens: explorable, accessible, out of the repo (Apr 18, 2026)

**The current mess:** every autonomous session dumps `design-candidates.md`, `implementation_plan.md`, `design-review-findings.md`, `mr-review.md` etc. as files in the repo root or worktrees. They are:
- Not indexed or searchable
- Not visible in the console
- Not accessible to other sessions (agent B can't read agent A's handoff without knowing the exact file path)
- Polluting the repo with ephemeral working documents
- Lost when worktrees are cleaned up
- Scattered across the filesystem with no structure

**The right model:** artifacts are WorkTrain data, not filesystem files.

---

#### What an artifact is

Any structured output from a session that has value beyond the session itself:
- **Handoff docs** -- what one session produces for the next to consume
- **Design candidates** -- research output with tradeoffs and recommendation
- **Implementation plans** -- what to build, how, in what order
- **Review findings** -- MR review output with findings, severity, recommendation
- **Spec files** -- behavioral specs, acceptance criteria, API contracts
- **Investigation summaries** -- bug investigation root cause and reproduction
- **Context bundles** -- pre-packaged knowledge for subagent consumption

**NOT artifacts:** step notes (stay in WorkRail session store), event logs (stay in daemon events), source code (stays in repo).

---

#### Where artifacts live

`~/.workrail/artifacts/<sessionId>/<artifact-type>-<timestamp>.json`

Structured JSON, not markdown. The display layer (console, `worktrain artifacts`) renders them as human-readable. Other agents query them as structured data.

**Why JSON not markdown:**
- Queryable by other agents (what are the findings with severity=critical?)
- Renderable by the console with proper formatting, filtering, search
- Versionable and diffable in the artifact store
- Accessible via the knowledge graph (artifacts become nodes with typed edges)

---

#### Console integration

The console session detail view gets an "Artifacts" tab alongside "Steps" and "Notes":

```
Session: sess_3bmj...  [MR Review: PR #566]
├── Steps (8)
├── Notes
└── Artifacts (3)
    ├── 📋 review-findings.json    "APPROVE -- 3 Minor, 1 Info"
    ├── 📄 context-bundle.json     "12 files read, 4 patterns identified"  
    └── 🔍 investigation-notes.json "Signal 3 dead code in max_turns path"
```

Click an artifact → full rendered view in the console.

---

#### Accessibility to other agents

Agents can query artifacts from prior sessions via a new tool:

```
read_artifact({ sessionId: 'sess_3bmj...', type: 'review-findings' })
→ { verdict: 'APPROVE', findings: [...], recommendation: '...' }

search_artifacts({ type: 'implementation-plan', workflowId: 'coding-task-workflow-agentic', since: '7d' })
→ [{ sessionId, summary, createdAt }, ...]
```

This replaces the current pattern where agents `cat design-candidates.md` from a known path -- fragile, path-dependent, breaks across worktrees.

---

#### Workflow integration

Workflow steps declare their artifact output type:

```json
{
  "id": "phase-1c-challenge-and-select",
  "output": {
    "artifact": "design-candidates",
    "schema": "wr.artifacts.design-candidates.v1"
  }
}
```

**Both the daemon AND the MCP server** store step artifacts automatically. The artifact store is a WorkRail data layer feature, not daemon-specific. A human using Claude Code with the MCP produces the same artifacts in the same store as an autonomous daemon session. The console shows them for both. Other sessions (human-driven or autonomous) can query them either way.

In MCP mode, the human can explicitly commit an artifact to the repo if desired (e.g. a final spec becomes `docs/specs/feature-x.md`). But the default is the artifact store -- repo is opt-in. The `NEVER COMMIT MARKDOWN FILES` rule in workflow metaGuidance exists because the artifact store doesn't exist yet. Once it does, that rule becomes unnecessary for all runtimes.

---

#### What stays in the repo

Almost nothing from WorkTrain sessions. The only things that belong in the repo:
- Source code changes (committed via auto-commit or human review)
- Long-lived spec files that are part of the product (e.g. `docs/ideas/backlog.md`)
- Workflow definitions (`workflows/*.json`)

Everything else -- design docs, review findings, investigation notes, implementation plans -- lives in `~/.workrail/artifacts/`. If you want a design doc in the repo, you explicitly commit it. The default is: it lives in WorkTrain's data layer.

---

#### Build order

1. **Artifact store** -- `~/.workrail/artifacts/<sessionId>/` directory structure, JSON schema for common types
2. **Daemon writes artifacts** -- workflow steps with `output.artifact` declaration write to the artifact store automatically
3. **`worktrain artifacts` CLI** -- list, read, search artifacts by session, type, date
4. **Console artifacts tab** -- render artifacts in session detail view
5. **`read_artifact` / `search_artifacts` tools** -- agents can query the artifact store
6. **Knowledge graph integration** -- artifacts become nodes, sessions link to their artifacts

**The `NEVER COMMIT MARKDOWN FILES` rule in metaGuidance is a symptom of this missing feature.** The rule exists because agents keep dumping files in the wrong place. With a proper artifact store, the rule becomes unnecessary -- artifacts have nowhere to go except the artifact store.

---

### "Add to repo" button in console for artifacts (Apr 18, 2026)

Instead of workflow steps declaring upfront whether an artifact goes to the repo, the human makes that decision after seeing the content -- via a button in the console.

**The flow:**
1. Agent produces artifact → stored automatically in `~/.workrail/artifacts/`
2. Human opens it in the console Artifacts tab
3. Sees action buttons: **📁 Add to repo** | **📋 Copy** | **🔗 Share link**
4. Clicks "Add to repo" → console prompts: "Save as: `docs/design/design-candidates-<name>.md`" (editable path with sensible default)
5. Console commits the artifact as markdown to the repo at that path, with a commit message like `docs: add design candidates for <workflow-goal>`

**Why this is better than workflow-level declaration:**
- Agent doesn't need to know at step time whether output will be repo-worthy
- Human decides after seeing actual content quality
- Ephemeral working artifacts stay ephemeral; only promoted ones go to the repo
- No "NEVER COMMIT MARKDOWN FILES" rule needed -- agents just produce artifacts, humans decide what's repo-worthy

**Button options:**
- **📁 Add to repo** -- renders artifact as markdown, commits to repo at specified path
- **📋 Copy** -- copies rendered markdown to clipboard
- **🔗 Share link** -- generates a URL that opens the artifact in the console. ⚠️ Local-only: only works on the same machine or with shared filesystem access. Requires cloud hosting for true team sharing (see cloud hosting spec in backlog)
- **📤 Export** -- save to arbitrary filesystem path outside the repo

**The commit WorkTrain creates:**
```
docs(design): add design candidates for MCP simplification

Source: WorkTrain session sess_3bmj... (mr-review-workflow-agentic)
Artifact: design-candidates-stdio-simplification-2026-04-18.md
```

**Also useful for:** implementation plans the team wants to track, spec files that belong in the repo permanently, investigation summaries that become part of incident post-mortems.

---

## Current state update (Apr 18, 2026 -- later)

**npm version: v3.35.1** (auto-released after spawn_agent merged)

### What additionally shipped since the milestone (commit 473f4bd0)

- ✅ **`complete_step` tool** (#569) -- daemon manages continueToken internally, LLM never handles it. Notes required (min 50 chars). `continue_workflow` deprecated.
- ✅ **`spawn_agent` tool** (#573) -- native in-process child session spawning. parentSessionId in session_created event. Depth enforcement. Semaphore bypass. All 4 WorkflowRunResult variants handled.
- ✅ **`complete_step` description fix** (#575) -- removed token-seeking language from deprecated continue_workflow description that would have triggered the LLM to seek a token.
- ✅ **Discovery ran before both implementations** -- wr.discovery validated complete_step approach (found 1 merge blocker fixed), designed spawn_agent architecture (found semaphore deadlock risk avoided).

### Updated limitations

**Still open from previous list:**
1. ~~complete_step just merged, untested~~ → ✅ merged, description fixed, discovery validated
2. ~~spawn_agent not merged~~ → ✅ merged as #573
3. **No session identity in console UI** -- parentSessionId is NOW in the event store (schema extended in #573) but console doesn't show the tree yet. Data is there; visualization is not.
4. **No coordinator scripts** -- spawn_agent exists, coordinator templates don't.
5. **Subagent loop still LLM-driven** -- workflow-as-orchestrator model spec'd but not built.
6. **Workflow runtime adapter not built** -- one spec, two runtimes model spec'd but not built.
7. **Knowledge graph not built** -- context still sweeps files every session.
8. **Artifacts not first-class** -- agents still dump markdown files in repo. Artifact store spec'd but not built.
9. **No notifications** -- daemon completes silently.
10. **MCP simplification PR-B** -- HttpServer still starts with MCP server.

### What's now possible that wasn't before

With `complete_step` + `spawn_agent`:
- Agents can advance workflows without ever touching a token (removes the #1 session failure cause)
- Workflows can declare delegation and the daemon spawns proper child sessions (all visible in event log)
- Multi-phase work has a path to becoming a coherent work unit (parentSessionId in data, UI visualization next)

### Next priorities

1. **Console session tree view** -- parentSessionId data is in the store. Build the UI to show it.
2. **First coordinator script template** -- `coordinator-mr-review.sh` that spawns: discovery → review → (conditional) fix → re-review. Proves the spawn/await loop works end-to-end.
3. **Notifications** -- macOS notification + generic webhook. ~30 min implementation.
4. **Late-bound goals** -- default `goalTemplate: "{{$.goal}}"` when no static goal. 10-line fix in trigger-store.ts.
5. **Artifacts store foundation** -- `~/.workrail/artifacts/` directory structure. Step 1 of the first-class artifacts vision.

---

## What WorkTrain is currently capable of (as of v3.36.0, Apr 18, 2026)

Tested empirically today. This is what actually works, not what's specced.

---

### Autonomous workflow execution

**Confirmed working:**
- Accepts webhook triggers and dispatches workflow sessions autonomously
- `mr-review-workflow-agentic` v2.6 runs end-to-end: context gathering, parallel reviewer phases, synthesis loop, validation, structured handoff. **Confirmed today** (sess_3bmj..., APPROVE verdict).
- `coding-task-workflow-agentic` (lean v2) runs end-to-end for Small tasks. **Confirmed today** (evidenceFrom field implementation, completed successfully).
- `wr.discovery` v3.2.0 runs with goal reframing. **Confirmed today** (spawn_agent architecture discovery).
- Sessions advance through 8+ workflow steps autonomously (36 step advances today across 6 sessions).
- 402 LLM turns + 660 tool calls executed autonomously today.

**Known reliability issues:**
- `wr.discovery` hit timeout once today -- multi-step discovery workflows can run long and hit the 60-min limit
- One coding task failed (error) -- assessment gate or tool issue, still being investigated
- One MR review timed out -- complex PRs need more time than the configured limit

---

### Trigger system

**Confirmed working:**
- Generic webhook trigger (fire-and-forget via `POST /webhook/<id>`)
- GitHub Issues polling (no webhook registration needed)
- GitLab MR polling (no webhook registration needed)
- Multiple triggers in one triggers.yml
- WorkflowId validation at startup (wrong IDs caught before traffic arrives)
- `goalTemplate` interpolation from webhook payload

**Not yet working:**
- Native cron trigger (requires OS crontab workaround)
- Late-bound goals (static goal required in triggers.yml, dynamic goal via payload requires `goalTemplate`)

---

### Agent capabilities inside sessions

**Confirmed working:**
- Bash (read files, run commands, git, gh CLI)
- Read (read files)
- Write (write files -- used by coding tasks)
- `complete_step` (daemon-managed token, LLM never handles continueToken)
- `continue_workflow` (deprecated but functional for backward compat)
- `report_issue` (agents call this when stuck, logged to `~/.workrail/issues/`)
- `spawn_agent` (spawns child WorkRail sessions in-process, v3.35.1+)
- Assessment artifact submission (`artifacts` field in complete_step)

**Not yet working in production:**
- `spawn_agent` just shipped (v3.35.1) -- untested in real workflows yet
- `complete_step` just shipped (v3.34.1) -- daemon now using it but not yet validated end-to-end through full assessment-gate workflow

---

### Observability

**Confirmed working:**
- Daemon event log (`~/.workrail/events/daemon/YYYY-MM-DD.jsonl`) -- every LLM turn, tool call, session lifecycle event
- `worktrain logs --follow` -- real-time event stream
- `worktrain status <sessionId>` -- session health summary with stuck detection
- Console (`http://localhost:3456/console`) -- live sessions, step notes, repoRoot grouping, `isLive` from event log
- Stuck detection -- `agent_stuck` events emitted for repeated tool calls, no-progress, timeout imminent
- `issue_reported` events when agents hit walls

**Known gaps:**
- Console shows flat session list, not work-unit tree (parentSessionId data exists, visualization not built)
- `isLive` only covers today's event log (cross-midnight limitation)
- No push notifications when daemon completes work

---

### Infrastructure

**Confirmed working:**
- MCP server stable (v3.36.0, bridge removed, EPIPE fixed)
- `worktrain daemon --install` creates launchd service (daemon survives MCP reconnects)
- `worktrain console` standalone (independent of daemon and MCP server)
- `worktrain init` guided onboarding
- `worktrain tell` / `worktrain inbox` message queue
- `worktrain spawn` / `worktrain await` CLI (primitives exist, no coordinator templates yet)
- Crash recovery (orphaned sessions detected and cleared on startup)
- Workspace context injection (CLAUDE.md, AGENTS.md, daemon-soul.md)
- maxConcurrentSessions semaphore (default 3)
- Per-trigger timeout + max-turn limits

---

### What WorkTrain cannot do yet (key gaps for autonomous production use)

1. **Multi-phase work is invisible** -- sessions are flat in console. A 5-session MR review pipeline looks like 5 unrelated sessions.
2. **No coordinator scripts** -- spawn_agent and spawn/await exist but there's no coordinator template to run a full pipeline.
3. **No auto-commit** -- agents write code but don't commit or open PRs autonomously (merge workflow exists in spec, not in production use).
4. **No notifications** -- daemon completes work silently.
5. **Assessment gates unreliable** -- complete_step fixes the token issue but full assessment-gate workflows not yet validated end-to-end.
6. **Subagent delegation invisible** -- spawn_agent creates proper child sessions, but workflows still use mcp__nested-subagent__Task for most delegation (invisible black box).
7. **No artifact store** -- agents dump markdown in the repo as a workaround.
8. **Context poverty** -- each session starts from scratch, no persistent knowledge graph.

---

### WorkTrain benchmarking: prove it's better, publish the results (Apr 18, 2026)

**The opportunity:** if WorkTrain can demonstrably outperform one-shot LLM calls and human-in-the-loop for specific task types, with reproducible benchmarks published in GitHub and visible in the console, that's the killer adoption argument. Not "trust us, it's better" -- actual numbers.

**What to benchmark:**

| Dimension | WorkTrain | One-shot | Human-in-loop |
|-----------|-----------|----------|---------------|
| MR review finding rate (Critical/Major caught) | ? | ? | ? |
| False positive rate (findings that were wrong) | ? | ? | ? |
| Coding task correctness (builds + tests pass) | ? | ? | ? |
| Coding task completeness (wiring, exports, tests) | ? | ? | ? |
| Bug investigation accuracy (correct root cause) | ? | ? | ? |
| Time to complete | ? | ? | ? |
| Token cost per task | ? | ? | ? |

**Model comparison within WorkTrain:**
- Haiku (fast, cheap) vs Sonnet (balanced) vs Opus (best) for each task type
- Other providers: GPT-4o, Gemini 1.5 Pro, Llama 3 (via Ollama) -- can WorkTrain run on any model?
- Does the workflow structure make Haiku competitive with Sonnet one-shot? (hypothesis: yes, for structured tasks)

**The benchmark suite:**

1. **MR review benchmark** -- 50 PRs with known ground truth (bugs that were later filed, correct implementations that had no bugs). Score: recall (caught real issues) + precision (didn't flag non-issues).
2. **Coding task benchmark** -- 50 tasks with objective completion criteria (build passes, tests pass, correct wiring). Score: % completing correctly on first autonomous run.
3. **Bug investigation benchmark** -- 30 real bugs with known root causes. Score: % identifying correct root cause.
4. **Discovery quality benchmark** -- 20 design questions with expert-evaluated answers. Score: coverage of key tradeoffs, identification of non-obvious alternatives.

**How to publish:**

- `docs/benchmarks/` directory in the repo -- YAML results files, one per benchmark run
- GitHub Actions CI job that runs the benchmark suite on each release and commits results
- Console "Benchmarks" tab showing historical performance by model and workflow version
- Public benchmark page (once cloud hosting exists) showing WorkTrain vs alternatives
- Badge in README: "MR review recall: 87% (Sonnet 4.6, v3.36.0)"

**Why this matters for adoption:**
- Developers are skeptical of autonomous agents -- "it probably makes stuff up"
- Hard numbers cut through skepticism instantly
- Showing WorkTrain with Haiku beating one-shot Opus on structured tasks is a compelling cost argument
- Showing improvement over workflow versions gives teams confidence the system is getting better
- The benchmark suite is also a regression test -- if a workflow change degrades performance, CI catches it

**What makes this hard:**
- Ground truth is expensive to establish (need expert-labeled evaluation sets)
- Some tasks are inherently subjective (discovery quality)
- Benchmarks can be gamed (optimize for the benchmark, not real performance)
- Need enough volume to be statistically meaningful

**Starting point:** the mr-review workflow is the easiest to benchmark objectively. Start with 20 PRs where bugs were later discovered and 20 PRs that shipped cleanly. Run each through `mr-review-workflow-agentic` on several model tiers. Measure recall and precision. That's a publishable result with one weekend of work.

---

### Autonomous feature development: scope → breakdown → parallel execution → merge (Apr 18, 2026)

**The vision:** give WorkTrain a feature scope -- from a vague idea to a fully groomed ticket -- and it figures out the rest. Discovery if needed, design if needed, breakdown into parallel slices, execution across worktrees, context management across agents, bringing it all back together.

**The four pillars the user cares about:**
1. **Autonomy** -- WorkTrain takes a scope and figures out the work breakdown without hand-holding
2. **Quality** -- comes FROM autonomy + workflow enforcement + coordination. Each slice goes through the right phases.
3. **Throughput** -- parallel slices across worktrees simultaneously. N agents working while you focus elsewhere.
4. **Visibility** -- one coherent work unit you can track at a glance, not N unrelated sessions in a flat list.

**The pipeline for a scope:**

```
Input: "add GitHub polling support" (any level of definition -- idea to full spec)
  │
  ├── [if vague] ideation + spec authoring → output: BRD / acceptance criteria
  ├── classify-task → taskComplexity, hasUI, touchesArchitecture, taskMaturity
  ├── [if Medium/Large] discovery → context bundle, invariants, candidate files
  ├── [if touchesArchitecture] design → candidates, review, selected approach
  ├── breakdown → parallel slices with dependency graph
  │     ├── Slice 1: types + schema         (worktree A)
  │     ├── Slice 2: polling adapter        (worktree B, depends: 1)
  │     ├── Slice 3: scheduler integration  (worktree C, depends: 2)
  │     └── Slice 4: tests                 (worktree D, depends: 1-3)
  ├── [parallel execution] each slice: implement → review → (fix if needed) → approved
  ├── [serial integration] merge slices in dependency order, verify after each
  └── [final] integration test → PR created → notification to user
```

**Context management across agents:**
- Coordinator maintains a "work unit manifest": current phase, slice status, shared invariants, decisions made in design phase
- Each spawned agent receives a context bundle: relevant portion of the manifest + files it needs + decisions from upstream phases
- Agents don't rediscover what the coordinator already knows
- After each agent completes, its findings update the manifest (new invariants found, scope changes, follow-up tickets)

**Worktree coordination:**
- Each slice gets its own worktree (already done via `--isolation worktree`)
- Coordinator tracks which files each slice touches -- detects conflicts before they happen
- Independent slices run in parallel; dependent slices queue automatically
- Merge order follows the dependency graph, not wall-clock completion time

**Knowing when to spawn a new main agent:**
- When a slice is too large or discovers unexpected scope, it requests a breakdown from the coordinator
- When a review finds a Critical finding, the coordinator spawns a dedicated fix agent with the finding + relevant context
- When integration reveals a regression, coordinator spawns an investigation agent before retrying the merge

**The coordinator's job (what stays in scripts, not LLM):**
- Maintain the manifest (JSON file, append-only)
- Compute the dependency graph
- Decide parallelism vs serialization
- Route: clean → merge, minor findings → fix agent, critical → escalate
- Track worktrees, detect conflicts
- Sequence the merge order

**What requires LLM cognition:**
- Discovery (what are the invariants, which files matter)
- Design (which approach, what tradeoffs)
- Implementation (write the code)
- Review (is this correct and complete)
- Breakdown (what are the right slice boundaries)

**The minimum viable version:**
A coordinator that handles a Medium/Small scoped task (already classified, no need for ideation or design). Takes 2-4 parallel slices, runs them, reviews each, merges when clean. No escalation handling in v1 -- if anything fails, notify the user.

This is the thing that makes WorkTrain feel like a senior engineer taking ownership of a task, not a tool you have to supervise step by step.

---

### Coordinator design decision: MVP-first, generalize after (Apr 18, 2026)

**Decision:** Build the first coordinator as a PR review-specific script. Generalize to a reusable coordinator framework after proving it works end-to-end.

**Rationale:** Three discovery runs all converged on the architecture (TypeScript script, `CoordinatorDeps` interface, 2-call HTTP for notes). The risk is over-engineering for hypothetical pipelines before validating the real one. PR review is the highest-value first use case with a clear success criterion.

**The generic coordinator architecture is already designed** (see `docs/discovery/coordinator-script-design.md`). The `CoordinatorDeps` interface and `AgentResult` bridge type make migration to a generic coordinator trivial -- the PR review script uses these types, so generalizing is additive, not a rewrite.

**Migration path:** once PR review coordinator is proven in production, extract the routing logic (`parseFindings`, `routeByFindings`) and `CoordinatorDeps` interface into `src/coordinators/base.ts`. The PR review coordinator becomes one implementation of the base pattern.

---

### Architecture decisions from Apr 17-18 sessions (to record before files are cleaned up)

**Decision 1: Structured output + tool calls can coexist (Apr 18)**
Validated empirically via integration test. The beta API (`client.beta.messages.create()`) supports both JSON schema enforcement AND tool calls in the same request. Schema enforcement applies at `end_turn` only. Bedrock is more consistent than direct Anthropic API for system-prompt fallback behavior. This opens a future path for replacing `complete_step` with structured output, but `complete_step` remains the chosen primitive for now.

**Decision 2: `complete_step` is the preferred daemon workflow-control primitive (Apr 18)**
PR #569 merged. The daemon holds the continueToken in a closure; LLM calls `complete_step(notes)` and never handles the token directly. Structured output (`beta.messages.create` with JSON schema) was evaluated as an alternative and deferred -- it's a viable migration path for a future version but adds API complexity today. Follow-up: track a structured output migration as a future improvement, not a current priority.

**Decision 3: AgentLoop error handling contract -- FatalToolError (Apr 16)**
`FatalToolError` subclass selected for distinguishing recoverable from non-recoverable tool failures in the AgentLoop. The contract: user-facing tools (Bash, Read, Write) catch failures and return `isError: true` in the tool_result (loop continues, LLM can retry). Coordination tools with unrecoverable failures (session store corruption, token decode failure) throw `FatalToolError` -- `_executeTools` instanceof-checks this and kills the session rather than surfacing a confusing error to the LLM. This contract is part of the AgentLoop architecture and must be followed by any new tool implementations.

**Decision 4: Use `wr.discovery` for discovery-only tasks, not `coding-task-workflow-agentic` (Apr 17)**
Discovered from a broken session: `coding-task-workflow-agentic` dispatched with "do discovery only, no code" ran 11 step advances then stopped without `run_completed`. The workflow's implementation phases fired even with explicit instructions not to code. Lesson: when a trigger or coordinator wants pure discovery/research, use `wr.discovery` as the workflowId. `coding-task-workflow-agentic` should only be dispatched when implementation is the actual goal.

**Decision 5: Bug -- MCP server EPIPE crash (Apr 18)**
Root cause confirmed with 15 production crash log entries: `process.stderr` is missing an `'error'` event handler in `registerFatalHandlers()`. When an MCP client disconnects, Node.js emits `EPIPE` on stderr which crashes the process with an unhandled error. `process.stdout` already has equivalent protection via `wireStdoutShutdown()`. Fix: mirror the stdout protection for stderr. One-line fix being implemented in PR `fix/mcp-stderr-epipe-crash`.

---

### worktrain status → console integration (Apr 18, 2026)

The `worktrain status` CLI command is Phase 1. Phase 2: the same data and rendering lives inside the console as the default landing view when you open it -- not the sessions list, the overview. Same `StatusDataPacket` type, two surfaces. The console overview replaces the need to run a CLI command; it auto-refreshes and stays live.

---

### WorkTrain as a native macOS app (Apr 18, 2026)

Long-term vision: WorkTrain becomes a full native Mac app -- not just a CLI + web console, but a proper macOS application with a menubar icon, system notifications, windows, and native UX.

**What this unlocks:**
- Always-on menubar presence showing daemon status at a glance
- Native macOS notifications (already built via osascript -- the app version uses UserNotifications framework directly)
- The `worktrain status` overview as a native window, not a browser tab
- Message queue and inbox as a native interface (type a message from anywhere on your Mac, not just the terminal)
- Background daemon management -- start/stop/restart from the menubar without terminal
- Deep system integration: file system events, calendar, Contacts, native share sheet

**Tech stack options:**
- Swift/SwiftUI: full native, best macOS integration, steeper learning curve from TypeScript
- Electron + existing console UI: fastest path, same TypeScript codebase, but heavy
- Tauri: Rust core + existing web frontend, lighter than Electron, good macOS support
- React Native macOS: reuses React knowledge, not quite native feel

**Recommended path:** Tauri wrapping the existing console UI. The console is already a React/Vite app. Tauri gives native menubar, notifications, and system APIs without rewriting the frontend. The WorkTrain daemon stays as a separate process managed by the app.

**This is a post-v1 platform decision** -- not a near-term priority, but worth designing toward. Don't make architectural decisions that would make the Tauri wrapper hard later.

---

### Long-running sessions: stay open across agent handoffs (Apr 18, 2026)

**The problem:** today when an MR review session completes, it writes its findings and exits. If the findings require fixes, a new fix agent starts from scratch with no shared context. When the fix is done, a new re-review agent also starts from scratch. Three sessions that are logically one unit of work are isolated from each other.

**The vision:** a session can stay open and wait -- dormant but alive -- while another agent does work. When that work completes, the waiting session resumes with full context continuity.

**The MR review example:**

```
[MR review session]  finds: 2 critical, 3 minor
  → stays open, waiting for fixes
  
  [Fix agent session]  addresses all 5 findings
    → completes, signals "fixes ready"
  
[MR review session resumes]  re-reads the diff, re-evaluates
  → all 5 verified fixed, 0 new findings
  → completes with APPROVE verdict
```

The same session that found the issues verifies the fixes. No context reconstruction. No risk of re-review missing something the original reviewer knew.

**Other use cases for waiting sessions:**

- **Architecture review waiting for approval:** architect session identifies a design gap, waits for the human to decide on direction, resumes when the decision is recorded
- **Discovery session waiting for data:** a research session identifies that it needs a specific file or API response, signals "blocked on: fetch X", waits for a retrieval agent to deliver it, resumes with the data injected
- **Coordinator waiting on child completion:** instead of a coordinator script polling `worktrain await`, the coordinator session can yield and be resumed by the daemon when child sessions complete -- same session, same context, no polling overhead
- **Spec authoring waiting for stakeholder input:** a spec session writes a draft, flags "needs: human review of acceptance criteria", waits, resumes when the human adds a comment
- **Integration test waiting for deployment:** a test coordination session waits for a deploy to complete before running integration tests

**The key insight: the LLM doesn't experience waiting.**

LLMs have no concept of time. Between one turn and the next, zero time passes from the agent's perspective. This means "waiting" is not a thing that happens to the agent -- it just doesn't receive its next turn until the coordinator has something to give it.

The session is paused at the engine level (DAG holds at a node, no new turns issued). The agent submitted its output and simply hasn't received a response yet. When the coordinator is ready -- fix agent completed, human reviewed, deployment finished -- it advances the session with a turn that contains the new context. From the agent's perspective: it submitted findings and immediately received "here are the fixes, verify them."

**No `wait_for` primitive needed at the workflow level.** The coordinator is the timing mechanism. This is the coordinator's job: know when each session is ready for its next input, and deliver that input at the right time.

```
Coordinator logic:

1. Advance review session to "findings complete" node
2. Read findings from session output
3. Spawn fix agent with those findings
4. Wait for fix agent to complete (worktrain await)
5. Inject fix summary into review session's next turn
6. Advance review session: "Here are the fixes. Verify them."
   → LLM receives this as the natural next step, no time gap perceived
```

**Why this is more powerful than re-running a fresh session:**

- **Context continuity:** the reviewer remembers what it found, why it flagged it, what invariants it was checking. A fresh session has to re-discover all of that.
- **Relational memory:** "does this fix address the root cause I identified, or just the symptom?" -- only the original session knows the root cause reasoning.
- **Efficiency:** no redundant context gathering. The resumed session picks up exactly where it left off.
- **The agent doesn't know it's coordinating:** from the agent's view, it's a continuous workflow. The coordinator manages the timing externally.

**Implementation path:**

- Phase 1: coordinator scripts withhold `complete_step` advancement until the condition is met. This already works today -- the coordinator just doesn't advance the session until the fix agent is done.
- Phase 2: the coordinator passes structured context when advancing: `complete_step(session, { injectedContext: fixSummary })`. The session receives it as part of the next step's prompt.
- Phase 3: declarative pipelines -- workflow JSON declares that step N waits for an external condition before proceeding. The coordinator reads this and manages the timing automatically. No hand-coded coordinator script needed for common patterns.

---

### Coordinatable workflow steps: confirmation points the coordinator can satisfy (needs discovery, Apr 18, 2026)

⚠️ **Needs discovery before implementation. The questions below are open, not answered.**

**The insight:** workflows already have `requireConfirmation: true` on certain steps -- these are natural coordination points. Right now they pause for a human. The idea is to make them also pausable-for-a-coordinator, so a coordinator (or another agent) can be the one that responds instead of a human.

**The vision:**
A workflow reaches a `requireConfirmation` step. In MCP mode (human-driven), it behaves exactly as today -- pauses and waits. In daemon/coordinator mode, instead of blocking forever, the coordinator can:
- Inject a synthesized answer based on external work it just did ("architecture review found X, proceed with approach A")
- Spawn another agent to generate the answer and inject its output
- Ask a discovery agent to weigh in and forward the result
- Simply forward a human's message from the message queue

The original session never knows whether a human or a coordinator satisfied the confirmation. It just receives the next turn with context.

**Why this is powerful:**
Today the coordinator is external to the workflow -- it orchestrates sessions from outside. This makes the workflow itself coordinatable from within, so multi-agent collaboration can be declared in the workflow spec rather than bolted on in coordinator scripts.

**What's unknown and needs discovery:**
1. **Mechanism:** is this an enriched `requireConfirmation` (add a `coordinatable: true` flag?), a new step type (`requireCoordinatorInput`?), or something at the engine level? Tradeoffs between each.
2. **What gets injected:** always a structured decision ("proceed/revise/abort + findings"), or also data injection ("here are the file contents", "here's what the API returned")? How does the step receive it -- as a new tool call result, as a steer, as part of the step prompt?
3. **Coordinator discovery:** how does the coordinator know a step is waiting for it vs waiting for a human? Does it poll the session state? Does the session emit a `coordinator_gate_pending` event? (This connects to the `waitForCoordinator` spec in this backlog.)
4. **Timeout/fallback:** if the coordinator never responds, what happens? Fall back to human? Error? Configurable?
5. **MCP invariant:** must behave identically to today in MCP/human-driven mode. The coordinator path is additive, not a behavior change for existing users.

**Relationship to other specs:**
- "Long-running sessions: stay open across agent handoffs" -- the session pauses at the confirmation point, coordinator acts, session resumes
- "POST /api/v2/sessions/:id/steer" -- this might be the injection mechanism
- `signal_coordinator` tool -- the session might signal the coordinator instead of blocking
- `waitForCoordinator` step flag (already in this backlog) -- same underlying need, different framing
- "Coordinator review mode: self-healing vs comment-and-wait" -- confirmation points are where that routing decision gets expressed

---

## Architecture Decision: Three-Workflow Pipeline (Apr 18, 2026)

### Decision

The canonical WorkRail workflow pipeline for new features is:

```
wr.discovery (optional) → wr.shaping (optional) → coding-task-workflow-agentic
```

Each workflow is independently useful. The pipeline is an optional chain, not a required sequence.

### Rationale

**wr.discovery** produces a direction -- what problem is worth solving. Output: structured discovery notes at `.workrail/discovery/`.

**wr.shaping** produces a bounded pitch -- what specifically to build and explicitly NOT build, at a product level. Output: `.workrail/current-pitch.md`. Faithful Shape Up methodology. Tech-agnostic. No code-level content.

**coding-task-workflow-agentic** produces running code -- engineering approach, sliced implementation, verification. When pitch.md exists (Phase 0.5), it skips design ideation and translates the pitch directly into an engineering approach. The pitch's no-gos and appetite are binding constraints.

### No TechSpec workflow needed

The coding workflow already does everything a TechSpec workflow would do: Phase 1b generates design candidates, Phase 1c selects and challenges the approach, Phase 3 writes the spec and implementation plan. Adding a separate TechSpec workflow would duplicate this and create a question of which is canonical. The coding workflow is the engineering planning layer.

**The split that matters is product vs engineering:**
- Product decisions (what to build, for whom, within what time) → wr.shaping
- Engineering decisions (how to build it, which interfaces, which tests) → coding workflow

### When to skip shaping

- Task is small, concrete, and clearly scoped → go straight to coding workflow
- Discovery already produced a bounded, implementable direction
- You have a pre-written ticket or spec that already defines what to build

### Faithful Shape Up constraint

wr.shaping is tech-agnostic. A pitch for a Kotlin Android app and a pitch for a Python API service look structurally identical. No file paths, no function signatures, no implementation details. This makes pitches usable by human engineering teams at companies using Shape Up, not just WorkRail's coding workflow.

### Phase 0.5 mechanics

When `coding-task-workflow-agentic` finds `.workrail/current-pitch.md`:
1. Reads all five pitch sections (Problem, Appetite, Solution/Elements, Rabbit Holes, No-Gos)
2. Sets `shapedInputDetected=true`
3. Skips phases 1a-1c (hypothesis, design generation, challenge-and-select)
4. Phase 1d translates pitch elements/invariants/no-gos into an engineering approach
5. Plan audit (Phase 4) checks for drift against the pitch
6. Appetite is a hard ceiling -- oversized engineering work becomes follow-up tickets


---

## Idea: `context-gather` Step Type (Apr 19, 2026)

### Problem

Phase 0.5 in the coding workflow currently looks for a shaped pitch by checking a local path. This doesn't handle: coordinator-injected context, manually written docs (GDoc, Confluence, Notion), Glean-indexed artifacts, or URLs embedded in the task description. The search logic is duplicated if other workflows need the same document.

### Proposed primitive

A new engine-level step type `context-gather` that resolves a named context artifact from ordered sources:

```json
{
  "type": "context-gather",
  "id": "gather-pitch",
  "contextType": "shaped-pitch",
  "outputVar": "shapedInput",
  "optional": true,
  "sources": ["coordinator-injected", "local-paths", "task-url", "glean"]
}
```

**Source resolution order (stops at first hit):**
1. `coordinator-injected` -- coordinator already attached context of this type to the session (most common in autonomous mode)
2. `local-paths` -- check `.workrail/current-pitch.md`, `pitch.md`, `PRD.md`, `.workrail/pitches/` (most recent)
3. `task-url` -- extract any URL from the task description and fetch via WebFetch or matching MCP (GDoc, Confluence, Notion)
4. `glean` -- search Glean for recent docs matching the task keywords and `contextType`; opt-in only (risk of false positives silently constraining wrong scope)

If `optional: true` and no source resolves: `outputVar = null`, workflow continues normally.

### Why engine-level, not a routine

- Coordinator intercept requires the engine to check "has this type already been provided?" before running any search -- a routine can't express that
- `contextType` is a declared intent multiple workflows can share (`wr.shaping`, `coding-task-workflow`, `wr.discovery`) without duplicating resolver logic
- New sources (Linear, Jira, Notion) get added to the engine once, immediately available to all workflows

### Relationship to existing work

- Replaces/supersedes Phase 0.5's current local-path check in `coding-task-workflow-agentic`
- Coordinator PR-review flow would inject `shaped-pitch` context before spawning the coding session
- Any workflow that needs "find the spec/pitch/PRD for this task" uses the same step type

### Open questions

- How does the coordinator inject context into a session? Via a session variable set before `start_workflow`, or a new `inject_context` call?
- How does `task-url` distinguish a GDoc URL from a Confluence URL from a Notion URL? MCP routing by domain?
- What is the `contextType` vocabulary? Start with `shaped-pitch` -- what else? (`discovery-notes`, `design-spec`, `api-contract`?)
- Glean false-positive risk: wrong document fed as shaped input silently constrains wrong scope. Needs confidence threshold or explicit user confirmation when Glean is the only hit.


---

## Completed (Apr 19, 2026)

### wr.shaping -- Faithful Shape Up shaping workflow

Created `workflows/wr.shaping.json`. Faithful Shape Up methodology, tech-agnostic, produces `.workrail/current-pitch.md` only. Nine steps: ingest → frame gate → diverge (6 shapes, Verbalized Sampling) → converge → breadboard + elements → rabbit holes + no-gos → draft/critique loop → approval gate → write pitch.md. Two human gates with autonomous fallback. Appetite is calendar-time only (xs/s/m/l/xl). No code-level content -- a pitch for a Kotlin app and a pitch for a Python service look structurally identical.

### coding-task-workflow-agentic -- Upstream context Phase 0.5

Added Phase 0.5 "Locate Upstream Context" to `coding-task-workflow-agentic.json`. Format-agnostic: the agent uses whatever tools are available (repo search, WebFetch, Confluence/Notion/Glean MCPs, etc.) to find any upstream document -- pitch, PRD, BRD, RFC, design doc, user story, Jira epic, etc. Sets `upstreamSpecDetected` + `solutionFixed` flags. When `solutionFixed=true`, design ideation phases (1a-1c) are skipped and Phase 1d translates upstream constraints directly into an engineering approach. Plan audit (Phase 4) checks for drift against `upstreamBoundaries` whenever an upstream document was found.

Also consolidated from three workflow variants to one canonical file.

