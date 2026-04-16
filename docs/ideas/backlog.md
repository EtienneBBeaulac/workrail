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
