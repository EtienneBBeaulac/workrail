# Agent Behavior Patterns: pi-mono, pi-ai, nexus-core, and WorkRail

**Status:** Complete  
**Date:** 2026-04-16  
**Goal:** Find system prompts and agent behavior instructions from pi-mono, pi-ai, and other autonomous agent frameworks referenced in the workrail codebase

> **Artifact strategy:** This document is a human-readable summary for review. Execution truth (decisions, findings) lives in WorkRail session notes and context variables. This file may be out of date if the session was rewound.

---

## Context / Ask

The user wants to understand:
1. What patterns pi-mono, pi-ai, nexus-core, and other autonomous agent frameworks use for structuring agent behavior
2. Any actual system prompt / behavioral instruction text found in the WorkRail codebase
3. How WorkRail adopted, adapted, and in some cases superseded these frameworks

---

## Evidence Sources

All findings are from local WorkRail codebase sources. No remote repos were cloned.

| Source | Path | Type |
|--------|------|------|
| Soul template | `src/daemon/soul-template.ts` | Actual prompt text |
| System prompt assembly | `src/daemon/workflow-runner.ts` lines 1080-1137 | Actual prompt code |
| pi-mono tombstone | `src/daemon/pi-mono-loader.ts` | Deprecation note |
| First-party agent loop | `src/daemon/agent-loop.ts` | Implementation |
| pi-mono findings | `docs/ideas/backlog.md` lines 136-184 | Prior-art analysis |
| nexus-core findings | `docs/ideas/backlog.md` lines 940-953 | Prior-art analysis |
| pi-mono loop decision | `docs/ideas/backlog.md` lines 755-784 | Decision record |
| Execution engine discovery | `docs/design/daemon-execution-engine-discovery.md` | Architecture analysis |
| MVP autonomous platform | `docs/design/autonomous-platform-mvp-discovery.md` | Design doc |

---

## Landscape Packet

### 1. pi-mono (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`)

**Source:** Mario Zechner (badlogic), 35k stars, MIT, TypeScript monorepo.  
**Status in WorkRail:** Was selected as the daemon loop foundation (Apr 14, 2026), then replaced by WorkRail's first-party `AgentLoop` because `pi-agent-core` is a private npm package inaccessible to open-source users.

**Architecture pattern: stateless functional loop**

```
agentLoop(prompts, context, config, signal?) -> EventStream<AgentEvent, AgentMessage[]>
```

- No singletons, no global state, no DI container
- The loop manages tool calls and context; the caller manages state
- `ToolExecutionMode`: sequential vs. parallel tool execution
- `BeforeToolCallResult` -- can block a tool call with a reason (used as evidence gate analog)
- `AfterToolCallResult` -- can override tool result content
- `agent.subscribe()` -- observability without modifying the loop
- `agent.abort()` -- cancellation via AbortController threaded through every async boundary
- `getFollowUpMessages` -- termination hook: return `[]` to signal completion
- `agent.steer()` -- queue-based message injection, fired after each tool batch before next LLM call

**Key packages:**
- `packages/ai` (`@mariozechner/pi-ai`) -- unified multi-provider LLM API: OpenAI, Anthropic, Google, Bedrock
- `packages/agent` (`@mariozechner/pi-agent-core`) -- `agentLoop`/`agentLoopContinue` + event stream
- `packages/mom` -- Slack bot: one agent per channel, MEMORY.md per workspace, skills from directory
- `packages/coding-agent` -- `SessionManager`, `AgentSession`, skill loading from directory

**Behavioral instruction mechanism:** None built-in. The `prompts` parameter accepts a system prompt string. Agent character comes from what the caller passes as the system prompt -- no framework-level soul/rules file. This is the key architectural difference from nexus-core.

**Non-obvious implementation detail (from WorkRail research):** pi-mono terminates structurally (no tool calls + empty follow-up queue), not semantically. WorkRail bridges `isComplete` from `continue_workflow` into `getFollowUpMessages` returning `[]`.

---

### 2. nexus-core (Peter Yao, internal Zillow tool, 11 stars)

**Status in WorkRail:** Prior-art reference. Not imported. WorkRail's soul + knowledge injection system is modeled on nexus-core's patterns but with structural enforcement added.

**Architecture pattern: per-repo context injection with behavioral soul**

nexus-core organizes agent behavior into three layers:

**Layer 1: SOUL.md -- behavioral principles injected into system prompt**

> "Behavioral principles injected into agent system prompts. WorkRail Auto should ship a `SOUL.md` equivalent in daemon session system prompts -- agent character beyond workflow steps. 'Evidence before assertion' = WorkRail's enforcement principle as a behavioral norm."

The SOUL.md file is the behavioral backbone: a markdown document that defines how the agent should think and act, independent of any particular task. It is analogous to a character sheet -- not instructions for a task, but principles for decision-making.

**Layer 2: Session lifecycle hooks -- JSON stdin/stdout protocol**

Format: `{session_id, reason, transcript_path}` on session init and end.

Maps to WorkRail daemon:
- Init: inject ancestry, register in DaemonRegistry, acquire lock
- End: write checkpointToken atomically, release lock, post results to trigger source

**Layer 3: Knowledge injection -- `inject-knowledge.sh`**

Before each Claude API call, inject:
1. Ancestry recap (what happened in parent sessions)
2. `~/.workrail/knowledge/` global knowledge files
3. Repo-specific `.workrail/context.md`

Cap at N lines (200 default). SHORT_NAME matching for repo-relevant selection.

**Layer 4: Skills as slash commands**

Three-mirror layout: `.claude/skills/`, `skills/`, `.agents/skills/` with symlink-based plugin discovery. Core always wins. Skills are slash commands (`/fix-tests`, `/review`, etc.) -- each is a reusable agent routine.

**Layer 5: Org profile system**

`configs/profiles/zillow.yaml` declares CLI tool bindings (glab vs gh, acli vs jira-cli). Makes the agent environment-aware.

**Gap vs WorkRail:** nexus-core is fundamentally human-initiated (you run `/flow`, it works because you're there). It cannot run autonomously. No session durability. No cryptographic enforcement. It's a plugin, not a daemon.

---

### 3. OpenClaw (iOfficeAI, 21.8k+, clawdkit/OpenClaw-core)

**Status in WorkRail:** Prior-art reference. `SessionActorQueue`, `RuntimeCache`, and channel abstraction patterns adopted. Confirmed internally: OpenClaw wraps `@mariozechner/pi-agent-core` internally.

**Architecture pattern: channel plugin with injected skills**

- `ChannelPlugin<ResolvedAccount>` -- one TypeScript interface, ~25 optional adapter slots
- `agentTools` slot on ChannelPlugin injects pi-mono typed tools at session start
- **WorkRail conclusion:** "Skills are not a separate primitive -- workflows ARE the skill layer."
- `AcpSessionStore` -- in-memory only (LRU, 5k sessions, 24h TTL). WorkRail's disk-persisted store is superior.
- `DeliveryRouter.resolve(triggerSource)` -- delivery binding at spawn time, not completion time
- Policy system: `isXxxEnabledByPolicy` flags

**Behavioral instruction mechanism:** Tool injection at session start. No standalone soul file. Agent behavior comes from: (a) tools available, (b) system prompt per channel, (c) injected agentTools.

---

### 4. WorkRail's Implementation: What Was Built

#### The DAEMON_SOUL_DEFAULT (actual prompt text)

From `src/daemon/soul-template.ts`:

```
- Write code that follows the patterns already established in the codebase
- Never skip tests. Run existing tests before and after changes
- Prefer small, focused changes over large rewrites
- If a step asks you to write code, write actual code -- do not write pseudocode or placeholders
- Commit your work when you complete a logical unit
```

This is injected under the `## Agent Rules and Philosophy` section of every daemon session system prompt. It is the fallback when `~/.workrail/daemon-soul.md` is absent.

#### The full system prompt assembly (`buildSystemPrompt()`)

From `src/daemon/workflow-runner.ts` lines 1086-1136:

```
You are WorkRail Auto, an autonomous agent that executes workflows step by step.

## Your tools
- `continue_workflow`: Advance to the next step. Call this after completing each step's work.
  Always include your notes in notesMarkdown and round-trip the continueToken exactly.
- `Bash`: Run shell commands. Use for building, testing, running scripts.
- `Read`: Read files.
- `Write`: Write files.

## Execution contract
1. Read the step carefully. Do ALL the work the step asks for.
2. Call `continue_workflow` with your notes. Include the continueToken exactly.
3. Repeat until the workflow reports it is complete.
4. Do NOT skip steps. Do NOT call `continue_workflow` without completing the step's work.

<workrail_session_state>[session state recap here]</workrail_session_state>

## Agent Rules and Philosophy
[DAEMON_SOUL_DEFAULT or contents of ~/.workrail/daemon-soul.md]

## Workspace: [absolute path]

## Workspace Context (from AGENTS.md / CLAUDE.md)
[contents of CLAUDE.md, AGENTS.md, .github/AGENTS.md in priority order, capped at 32 KB]

## Reference documents
[referenceUrls from trigger definition, if any]
```

#### The soul cascade (three levels)

1. `TriggerDefinition.soulFile` -- per-trigger override in `triggers.yml`
2. `WorkspaceConfig.soulFile` -- workspace-default soul (e.g., `~/.workrail/workspaces/my-project/daemon-soul.md`)
3. `~/.workrail/daemon-soul.md` -- global fallback
4. `DAEMON_SOUL_DEFAULT` -- hardcoded constant (last resort)

Resolved at trigger parse time by `trigger-store.ts`.

#### The first-party AgentLoop

`src/daemon/agent-loop.ts` -- replaces `@mariozechner/pi-agent-core` with identical semantics:

- `systemPrompt: string` in `AgentLoopOptions` -- passed verbatim to every `client.messages.create()` call
- `steer(message)` -- queue-based injection, drained after each tool batch BEFORE the next LLM call. This is distinct from `followUp()` (pi-mono's mechanism that fires only when the agent would otherwise stop). WorkRail uses `steer()` for workflow step injection -- the next step prompt is delivered after `continue_workflow` returns, not as a terminal follow-up.
- `subscribe(listener)` -- event subscription without modifying the loop
- `abort()` -- AbortController threaded through in-flight API calls
- `AgentEvent` union: `turn_end | agent_end`
- Sequential tool execution (parallel explicitly deferred -- workflow tools have ordering requirements)

---

## Pattern Comparison

| Pattern | pi-mono | nexus-core | OpenClaw | WorkRail |
|---------|---------|------------|----------|----------|
| **Agent behavior source** | Caller-supplied system prompt | SOUL.md file (per-org) | Channel system prompt + injected tools | `daemon-soul.md` cascade + `buildSystemPrompt()` |
| **Skill/routine mechanism** | Typed `AgentTool` objects | Slash commands (file-based) | `agentTools` slot on ChannelPlugin | WorkRail workflows ARE the skill layer |
| **Knowledge injection** | None built-in | `inject-knowledge.sh` (CLAUDE.md + ancestry) | None | CLAUDE.md + AGENTS.md at session start (32 KB cap) |
| **Session lifecycle hooks** | None | JSON stdin/stdout | `SessionActorQueue` | `DaemonRegistry` + session-init context_set |
| **Termination signal** | Structural (empty follow-up queue) | N/A | N/A | `isComplete: true` from `continue_workflow` |
| **Enforcement** | None (prompt-advisory) | None (prompt-advisory) | None (prompt-advisory) | HMAC token gate (cryptographic) |
| **Durability** | None | None | In-memory LRU (24h, crashes lost) | Disk-persisted append-only event log |
| **Cancellation** | `agent.abort()` via AbortSignal | N/A | `AbortController` per session | `agent.abort()` + DaemonRegistry |

---

## Key Patterns Across All Frameworks

### Pattern 1: Soul/Character file

All three frameworks have or use a concept of "behavioral principles injected into the system prompt at session start." nexus-core calls it SOUL.md. WorkRail calls it `daemon-soul.md`. pi-mono leaves it to the caller. The pattern is the same: a markdown file that defines how the agent reasons and acts, separate from task instructions.

### Pattern 2: Knowledge injection at boundaries

nexus-core explicitly models this as `inject-knowledge.sh`. WorkRail implements it as `loadWorkspaceContext()` reading CLAUDE.md/AGENTS.md. Both inject repo-specific context before the first LLM call, capped to prevent token bloat. The nexus-core model additionally injects ancestry (prior session context), which WorkRail mirrors with `loadSessionNotes()` (last 3 step notes, 800 chars each).

### Pattern 3: Skills as reusable routines

nexus-core: file-based slash commands in `.claude/skills/`. OpenClaw: `agentTools` injected per channel. pi-mono: `AgentTool` objects passed to the loop. WorkRail's conclusion: "WorkRail workflows ARE the skill layer." No separate skill primitive needed.

### Pattern 4: Stateless, composable agent loop

pi-mono's core architectural insight: the agent loop should have no infrastructure coupling (no singletons, no DI). It takes `(prompts, context, config)` and returns an `EventStream`. WorkRail's `AgentLoop` directly mirrors this -- `AgentLoopOptions` is the config, `subscribe()` is the event stream, `steer()` is the message injection hook.

### Pattern 5: Cooperative pause / steer

All frameworks use some form of message injection after tool calls to guide the next turn. pi-mono: `getFollowUpMessages` + `agent.steer()`. WorkRail: `steer()` called from the `turn_end` subscriber in `workflow-runner.ts` to inject the next workflow step prompt after `continue_workflow` returns.

---

## Gaps and Limitations

1. **No local pi-mono source available.** WorkRail's design docs contain thorough analysis of pi-mono's API, but the actual `agentLoop` implementation was not read (private npm package, no local clone). The analysis in `backlog.md` is based on API inspection and published npm package contents.

2. **nexus-core SOUL.md text not recovered.** The backlog describes the SOUL.md pattern but does not quote its contents verbatim. Only WorkRail's `DAEMON_SOUL_DEFAULT` (the direct implementation) was found. The backlog's description is based on the WorkRail author's direct reading of the nexus-core repo (accessible internally at Zillow). The soul file lives at the root of the nexus-core project -- anyone with internal repo access can read it there.

3. **pi-ai (unified provider API) details are summary-level only.** `@mariozechner/pi-ai` unifies OpenAI/Anthropic/Google/Bedrock APIs. WorkRail replaced this with a duck-typed `AgentClientInterface` in `agent-loop.ts` that accepts both `new Anthropic()` and `new AnthropicBedrock()`.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-14 | Adopt pi-mono's `agentLoop` pattern | Cleanest stateless loop; 1 dep; MIT; pi-agent-core 0.67.2 |
| 2026-04-14 | Replace pi-mono with first-party AgentLoop | `pi-agent-core` is private npm -- inaccessible to open-source users |
| 2026-04-14 | Adopt nexus-core's SOUL.md concept | Agent character beyond workflow steps; "Evidence before assertion" as behavioral norm |
| 2026-04-14 | Adopt nexus-core's knowledge injection pattern | CLAUDE.md/AGENTS.md at session start; ancestry via session notes recap |
| 2026-04-14 | Reject nexus-core's skill system | WorkRail workflows are the skill layer; no separate skill primitive needed |

## Final Recommendation

**Confidence: HIGH**

WorkRail's daemon system prompt and behavioral instruction mechanism is a synthesis of:
- pi-mono's stateless functional loop (mechanism, no behavioral text)
- nexus-core's SOUL.md pattern (behavioral text injection, knowledge injection, lifecycle hooks)
- OpenClaw's channel abstraction (tool injection at session start)

Plus WorkRail's own addition: HMAC cryptographic enforcement that none of the three source frameworks provide.

**The actual behavioral text in use today** (`DAEMON_SOUL_DEFAULT`, `src/daemon/soul-template.ts`):
```
- Write code that follows the patterns already established in the codebase
- Never skip tests. Run existing tests before and after changes
- Prefer small, focused changes over large rewrites
- If a step asks you to write code, write actual code -- do not write pseudocode or placeholders
- Commit your work when you complete a logical unit
```

**Residual risks (LOW):**
1. nexus-core SOUL.md verbatim text not recovered -- requires internal Zillow repo access. If the verbatim text is needed, a Glean search for 'nexus-core SOUL.md' or Peter Yao's nexus-core project may surface it from the internal knowledge base.
2. pi-ai provider API summary-level only -- sufficient for pattern survey; not sufficient for API-compatibility audit
3. OpenClaw has no standalone soul file -- behavioral character comes from per-channel system prompt + injected agentTools. There is no SOUL.md analog in OpenClaw. This distinction is important: OpenClaw's behavioral mechanism is fundamentally tool-injection-based, not file-injection-based.

---

## Final Summary

**Path**: landscape_first -- empirical discovery, no reframing needed.

**Problem framing**: Etienne wanted to understand what behavioral instructions OpenClaw and nexus-core use (particularly soul files and system prompts) and how WorkRail synthesized them.

**Landscape takeaways**:
1. nexus-core uses a layered behavioral injection system: SOUL.md (behavioral principles) + knowledge injection (inject-knowledge.sh) + session lifecycle hooks + slash-command skills + org profile system. The SOUL.md is the behavioral backbone -- a markdown character sheet separate from task instructions.
2. OpenClaw uses tool injection at session start via the `agentTools` slot on `ChannelPlugin`. There is NO standalone soul file in OpenClaw -- behavioral character comes from the per-channel system prompt plus injected tools.
3. pi-mono has NO built-in behavioral text -- it provides only the loop mechanism. The caller supplies the system prompt. This is an intentional architectural decision, not a gap.
4. WorkRail synthesized all three: adopted pi-mono's stateless loop pattern, adopted nexus-core's soul file concept (as `daemon-soul.md` cascade), adopted nexus-core's knowledge injection pattern (CLAUDE.md/AGENTS.md at session start), and added its own HMAC cryptographic enforcement that none of the source frameworks provide.

**Chosen direction**: Deliver findings from local sources with explicit gaps named. Verbatim text found where available. Offer Glean search for the nexus-core SOUL.md gap if the verbatim text is specifically needed.

**Strongest alternative**: Run a Glean search to close the nexus-core SOUL.md gap. Lost because: task scope was 'local repos and design docs'; YAGNI applies; the gap is named explicitly.

**Confidence band**: HIGH -- all evidence from directly-read local files; no contradictions; 3 bounded residual risks.

**Next actions**:
- If nexus-core SOUL.md verbatim text is needed: run Glean search for 'nexus-core SOUL.md site:zillow' or search for Peter Yao's nexus-core project in Glean.
- If WorkRail's daemon soul file needs updating based on nexus-core patterns: edit `~/.workrail/daemon-soul.md` or modify `src/daemon/soul-template.ts` DAEMON_SOUL_DEFAULT.
- No code changes required for this discovery task.
