# OpenClaw Deep Dive: WorkRail Auto Architecture Extraction

**Date:** 2026-04-14  
**Purpose:** Human-readable reference document for the WorkRail Auto daemon implementation team. Summarizes what WorkRail Auto should adopt, adapt, or skip from OpenClaw based on direct code reading.

**What this document is:** A decision record and implementation guide for the 6 concrete adoption patterns extracted from OpenClaw's codebase. Read this to understand what to build and why.

**What this document is not:** Workflow execution state. The durable execution record lives in WorkRail's session notes and context variables, not here. If this file is missing or changed, the session can recover from its notes.

**Scope:** Channel architecture, skill system, session persistence, notification/delivery, auth/credential model, DaemonRegistry equivalent.

**Capability notes:**
- Delegation (subagent): available via mcp__nested-subagent__Task
- Web browsing: not available -- all research done via gh api direct file reads
- No capability-dependent paths taken: all findings from direct openclaw repo reads

---

## Context / Ask

WorkRail Auto is an autonomous agent platform that runs 24/7 as a daemon, uses pi-mono's Agent class as the loop, connects to GitLab/GitHub/Jira/Slack/docs, can be self-hosted or cloud-hosted, uses WorkRail's cryptographic step enforcement, has mobile monitoring via responsive console + push notifications, and will eventually support cross-repo execution.

**Goal:** Determine what WorkRail Auto can concretely adopt from OpenClaw, what to adapt, and what to skip.

**Path recommendation:** `landscape_first` -- the dominant need is understanding OpenClaw's actual implemented architecture. The backlog already has high-level synthesis; this is about going one level deeper into the code.

**Rationale:** We already have a working design direction. The risk is not "solving the wrong problem" (design_first) and we don't need full-spectrum reframing. We need concrete code-level findings to inform implementation decisions in the daemon build.

---

## Path Recommendation: landscape_first

Justified over alternatives:
- `full_spectrum` -- overkill; the problem is well-framed. WorkRail Auto's goal is clear.
- `design_first` -- wrong mode; we are not at risk of building the wrong thing. We need implementation detail, not conceptual reframing.
- `landscape_first` -- correct. Map what OpenClaw actually built, then extract what maps to WorkRail Auto's architecture.

---

## Constraints / Anti-goals

- **Anti-goal:** Do not make WorkRail dependent on OpenClaw. The daemon must work completely independently.
- **Anti-goal:** Do not import OpenClaw code. Extract patterns only.
- **Constraint:** Only extract what is relevant to WorkRail Auto's MVP scope (daemon loop, session serialization, credential model, trigger system, DaemonRegistry).
- **Constraint:** WorkRail's existing durable session store + HMAC token protocol are superior to OpenClaw equivalents -- do not regress.

---

## Landscape Packet

### Current-State Summary

OpenClaw (357k stars, MIT, TypeScript, created Nov 2025, actively maintained Apr 2026) is a personal AI assistant daemon that listens on 20+ messaging channels and executes tasks autonomously. It is the architecture blueprint closest to WorkRail Auto's daemon ambitions.

**Key current-state observations from direct code reading:**
- OpenClaw is built on `@mariozechner/pi-agent-core` (pi-mono) for its agent loop. The `src/agents/pi-embedded-runner/run/attempt.ts` imports both `@mariozechner/pi-agent-core` and `@mariozechner/pi-coding-agent` directly. This confirms WorkRail's agent loop decision.
- In-memory ACP session store (5,000 sessions, 24h TTL, LRU eviction) -- no disk persistence for session state. WorkRail's durable append-only event log is strictly superior.
- Task persistence uses SQLite via `node:sqlite` (task-flow-registry.store.sqlite.ts) -- Node.js 22.5+ built-in, no external dependency.
- Channel plugins are dynamically loaded via `jiti` TypeScript-at-runtime loader with `openBoundaryFileSync` security (symlink rejection, path escape prevention).
- Credential system (`types.secrets.ts`) uses a three-source model: env/file/exec. Each source has a typed `SecretRef` object with `provider` and `id`.
- `SessionActorQueue` wraps `KeyedAsyncQueue` from plugin-sdk to serialize concurrent per-session operations. This is ~30 LOC.
- Task delivery state machine: `TaskNotifyPolicy` (done_only/state_changes/silent), `TaskDeliveryStatus` (pending/delivered/session_queued/failed/parent_missing/not_applicable), `TaskTerminalOutcome` (succeeded/blocked).
- `RuntimeCache` tracks in-flight sessions by actorKey with `lastTouchedAt`, `collectIdleCandidates`, and `snapshot()`.

### Existing Approaches / Precedents

| Pattern | OpenClaw location | WorkRail parallel |
|---------|------------------|-------------------|
| Session serialization queue | `SessionActorQueue` wraps `KeyedAsyncQueue` | Not yet built -- needed for daemon |
| Credential injection | `SecretRef` (env/file/exec) | Not yet built |
| Integration plugin contract | `ChannelPlugin<ResolvedAccount>` type | Not yet built |
| Task delivery routing | `TaskNotifyPolicy` + `deliveryContext` + `sendMessage` | Not yet built |
| In-flight session registry | `RuntimeCache` | Not yet built (planned as `DaemonRegistry`) |
| Session persistence | In-memory with disk session store | WorkRail has durable append-only event log (better) |
| Agent loop | `@mariozechner/pi-agent-core` (pi-mono) | Decided: use pi-mono |

### Notable Contradictions

1. **Contradiction:** OpenClaw's `AcpSessionStore` is in-memory (SessionActorQueue + RuntimeCache) while its disk store (`src/config/sessions/store.ts`) is a separate file-per-session JSON system. These two persistence layers are not the same thing and serve different purposes. WorkRail should NOT conflate them. The in-memory RuntimeCache is the "what's running now" registry; the disk store is the "what happened" history.

2. **Contradiction:** The backlog says "reimplement `KeyedAsyncQueue` (~30 LOC)." The actual source is in `packages/plugin-sdk/src/` and is not yet readable. The 30 LOC estimate is based on the `SessionActorQueue` wrapper being small. The underlying `KeyedAsyncQueue` implementation may be larger. However, the concept is simple enough to reimplement independently: a Map of Promise chains, one per key.

### Strong Constraints

- WorkRail must not import OpenClaw. MIT license technically allows it, but the dependency would couple WorkRail's release to OpenClaw's release cadence -- unacceptable for a platform claiming portability.
- The daemon's session isolation must use WorkRail's existing `LocalSessionLockV2` (with the workerId fix from the backlog) -- not OpenClaw's lock model.
- `KeyedAsyncQueue` must be reimplemented, not imported from `openclaw/plugin-sdk/keyed-async-queue`.

### Evidence Gaps

1. **Gap:** Did not read `KeyedAsyncQueue` implementation source. The `packages/plugin-sdk/src/` directory does not contain it explicitly -- it may be in a compiled dist or internal package. The reimplement-from-scratch approach sidesteps this gap.
2. **Gap:** Did not read `src/infra/outbound/message.js` -- the actual message delivery implementation. The delivery routing pattern is inferred from the type system and task registry, not from the outbound implementation.
3. **Gap:** Did not read the notification/push mechanism. OpenClaw may use Slack/Telegram for task completion notifications -- this is relevant for WorkRail's mobile monitoring feature but was not directly read.

### Gap Count: 3 | Contradiction Count: 2 | Precedent Count: 7

### 1. Channel/Integration Architecture

**The core abstraction:** `ChannelPlugin<ResolvedAccount, Probe, Audit>` in `src/channels/plugins/types.plugin.ts`

Every channel is a plugin implementing a typed interface with optional adapter slots:
- `id: ChannelId` -- normalized string identifier
- `meta: ChannelMeta` -- user-facing label, blurb, docs path, aliases
- `capabilities: ChannelCapabilities` -- what the channel supports (polls, reactions, threads, etc.)
- `config: ChannelConfigAdapter` -- resolves per-channel account config + credentials
- `outbound?: ChannelOutboundAdapter` -- how to send messages
- `lifecycle?: ChannelLifecycleAdapter` -- start/stop hooks
- `secrets?: ChannelSecretsAdapter` -- per-channel credential injection
- `actions?: ChannelMessageActionAdapter` -- the shared `message` tool's channel-specific handler

**Channel discovery:** `src/channels/plugins/module-loader.ts` -- dynamic module loading via `jiti` (TypeScript-at-runtime loader). Channels are discovered as modules under a plugin root directory. Security: `openBoundaryFileSync` rejects symlinks and path escapes.

**Channel registry:** `src/channels/registry.ts` wraps `getActivePluginChannelRegistryFromState()` (runtime plugin registry). Channels register by ID and can have aliases.

**Key insight for WorkRail Auto:**
The `ChannelPlugin` type is the "integration plugin contract." WorkRail Auto needs something similar for its trigger sources (GitLab, GitHub, Jira, Slack, cron). The OpenClaw pattern:

```typescript
// OpenClaw pattern
type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;      // resolves credentials
  outbound?: ChannelOutboundAdapter; // send results back
  lifecycle?: ChannelLifecycleAdapter; // start/stop
};

// WorkRail Auto equivalent
type TriggerPlugin = {
  id: TriggerId;                      // 'gitlab', 'github', 'jira', 'cron'
  meta: TriggerMeta;
  config: TriggerConfigAdapter;       // resolves per-source credentials
  inbound?: TriggerInboundAdapter;    // webhook handler / cron schedule
  outbound?: TriggerOutboundAdapter;  // post results back (MR comment, Jira comment)
};
```

**What to adopt:** The typed optional-adapter pattern for trigger plugins. Each integration (GitLab, Jira, etc.) implements the interface, providing what it can. Core does not know about channel specifics.

**What to NOT adopt:** The `jiti` dynamic TypeScript loader (over-engineered for WorkRail's initial set of built-in integrations). Start with static imports; make the interface pluggable later.

---

### 2. Skill System

**Discovery and loading:**
- Skills live in directories (one per skill, named by skill ID)
- Each skill directory contains a `SKILL.md` file with YAML frontmatter
- `src/agents/skills/local-loader.ts:loadSingleSkillDirectory()` reads `SKILL.md`, parses frontmatter, extracts `name` and `description`
- `src/agents/skills/workspace.ts:loadWorkspaceSkillEntries()` scans multiple source directories: bundled skills, managed skills, workspace-local skills, plugin skills
- Skills are filtered by config (`shouldIncludeSkill`), by agent ID (`resolveEffectiveAgentSkillFilter`), and by explicit skill filter list

**Skill invocation:**
- Skills have an `invocationPolicy` from frontmatter -- can be set to `disableModelInvocation` to prevent the model from calling them directly
- Skills with `requires.bins` are checked for binary availability before inclusion
- Skills with `install` specs can be auto-installed

**Skill composition:**
- `buildWorkspaceSkillsPrompt()` formats all eligible skills into a system prompt block
- `resolveSkillsPromptForRun()` is the top-level function that composes the full skills section

**Key insight for WorkRail Auto:**
WorkRail's "skill" concept is a WorkRail workflow. The daemon already knows how to start/continue workflows. OpenClaw's skill system is the reference for how to make those workflows discoverable and injectable into agent context.

However, WorkRail's approach is different: instead of injecting SKILL.md content into the system prompt, WorkRail injects the workflow as step prompts via `start_workflow`/`continue_workflow`. The skill concept maps to "what trigger context to inject into the system prompt at daemon session start."

**What to adopt:**
- The `SKILL.md` pattern for human-readable capability documentation (WorkRail can use `WORKFLOW.md` or just workflow descriptions)
- The `requires.bins` binary availability check pattern for verifying tool availability before starting a workflow that needs them
- The multi-source discovery pattern: bundled workflows + workspace-local workflows + managed remote workflows (already partially built in WorkRail)

**What to NOT adopt:**
- The `jiti` loader (unnecessary)
- Dynamic skill loading via frontmatter (WorkRail workflows are JSON, already structured)

---

### 3. Session Persistence Model

**OpenClaw's model:**

Two separate persistence layers:

**Layer 1 -- In-memory session store (`src/acp/session.ts:createInMemorySessionStore`):**
- Pure in-memory, up to 5,000 sessions, 24h idle TTL, LRU eviction
- Clean interface: `createSession`, `setActiveRun`, `cancelActiveRun`, `clearActiveRun`
- `AbortController` per session for cancellation
- `runId → sessionId` lookup map for reverse lookup
- **Critical gap:** no disk persistence. Process restart = all session state lost.

**Layer 2 -- Disk session store (`src/config/sessions/store.ts`):**
- File-backed JSON store per session key
- Uses `acquireSessionWriteLock` for safe concurrent writes
- Atomic writes via `writeTextAtomic`
- Has disk budget enforcement and stale entry pruning
- Session entries have `deliveryContext` (who to reply to) persisted alongside the session

**Persistence pattern:**
OpenClaw persists two things per session:
1. The conversation history/transcript (via `src/config/sessions/transcript.ts`)
2. The delivery context -- where to send the result when done (channel, account, thread, user)

The delivery context is key: when an ACP session finishes, it knows exactly where to route the result because it was stored at session creation time.

**Key insight for WorkRail Auto:**
WorkRail already has a superior session persistence model (durable disk-persisted append-only event log). The key insight from OpenClaw is the **delivery context pattern**: when the daemon starts a session from a GitLab webhook, it should persist the delivery context (MR URL, project, author) so that when the workflow completes, the result can be routed back to the right place without the daemon needing to remember it in memory.

```typescript
// WorkRail daemon session context -- modeled on OpenClaw's deliveryContext
type DaemonSessionContext = {
  triggerSource: 'gitlab_mr' | 'jira_ticket' | 'cron' | 'cli';
  deliveryContext: {
    // Where to route the result
    gitlab?: { projectId: string; mrIid: number; authorId: string };
    jira?: { issueKey: string; projectKey: string };
    slack?: { channel: string; threadTs: string };
  };
  workflowId: string;
  goal: string;
  checkpointToken?: string; // written before each step, crash recovery
};
```

This context should be written to disk (alongside the WorkRail session event log) before each step advance, so crash recovery can route results correctly.

**What to adopt:**
- The `deliveryContext` persistence pattern -- store routing info at session creation, use it at completion
- The `AbortController` per-session pattern for clean cancellation (maps to `agent.abort()` in pi-mono)

**What WorkRail already does better:**
- Durable disk session (OpenClaw: in-memory with 24h TTL)
- HMAC checkpoint tokens (OpenClaw: `resumeSessionId` with no cryptographic binding)
- Append-only event log (OpenClaw: mutable JSON files)

---

### 4. Notification / Delivery System

**OpenClaw's pattern:**

Delivery is handled through `TaskDeliveryStatus` and `TaskNotifyPolicy`:

```typescript
type TaskDeliveryStatus = 'pending' | 'delivered' | 'session_queued' | 'failed' | 'parent_missing' | 'not_applicable';
type TaskNotifyPolicy = 'done_only' | 'state_changes' | 'silent';
```

The flow:
1. Task is created with a `requesterOrigin` (the delivery context -- who asked for the task and where to send results)
2. Task runs, updating `progressSummary` and emitting progress events
3. On completion, `TaskRegistry` fires observers and the delivery runtime routes the result to `requesterOrigin` via `sendMessage()`
4. `TaskDeliveryStatus` tracks whether the result was actually delivered

**Completion routing:** `src/tasks/task-registry-delivery-runtime.ts` exports `sendMessage` from `src/infra/outbound/message.js` -- the unified outbound message sender that routes through the channel system back to the requester.

**Progress delivery:**
- `progressSummary` is updated during the task run (max 240 chars)
- `notifyPolicy: 'state_changes'` triggers intermediate notifications
- The ACP manager updates `progressSummary` as it receives streaming output from the agent

**Key insight for WorkRail Auto:**
WorkRail's daemon needs a delivery system that mirrors this pattern. When a workflow completes, the daemon routes the result to the right integration:
- GitLab MR: post as MR comment via GitLab API
- Jira ticket: post as Jira comment via Jira API
- Slack: post as Slack message

The OpenClaw pattern maps cleanly:
- `requesterOrigin` = WorkRail's `DaemonSessionContext.deliveryContext`
- `TaskNotifyPolicy` = WorkRail's session `notifyPolicy` (should be configurable per trigger)
- `sendMessage` = WorkRail's `IntegrationOutbound.post(deliveryContext, result)`

**What to adopt:**
- The `TaskNotifyPolicy` enum (`done_only` | `state_changes` | `silent`) -- adopt verbatim
- The `deliveryStatus` state machine -- track whether the result was successfully posted back
- The `progressSummary` pattern -- keep a rolling 240-char summary of what the agent is doing for live console view

---

### 5. Auth / Credential Model

**OpenClaw's pattern (`src/config/types.secrets.ts`):**

Three-source secret resolution system:
```typescript
type SecretRefSource = 'env' | 'file' | 'exec';
type SecretRef = { source: SecretRefSource; provider: string; id: string; };
type SecretInput = string | SecretRef;
```

- `env` source: `{ source: 'env', provider: 'default', id: 'OPENAI_API_KEY' }` -- reads from environment variable
- `file` source: `{ source: 'file', provider: 'mounted-json', id: '/providers/openai/apiKey' }` -- reads from a file, rejects symlinks, enforces max size (16KB), handles TOCTOU via `openVerifiedFileSync`
- `exec` source: `{ source: 'exec', provider: 'vault', id: 'openai/api-key' }` -- executes a command to get the secret (for vault integrations)

**Security implementation (`src/infra/secret-file.ts`):**
- `loadSecretFileSync` / `readSecretFileSync` -- use `openVerifiedFileSync` (file descriptor opened atomically, symlink rejection, size enforcement)
- Returns `Result` type (`{ ok: true, secret }` | `{ ok: false, message }`)
- No secrets are logged or included in error messages beyond the label

**Per-channel credential injection:**
Credentials are declared in config (e.g., `SlackConfig` has `token: SecretInput`). When a channel starts, it resolves credentials at runtime via the `SecretRef` system. The `tokenSource` field in `ChannelAccountSnapshot` shows where the token came from.

**Key insight for WorkRail Auto:**
This is exactly the credential model WorkRail Auto needs. Each integration (GitLab, Jira, Slack) has per-account credentials resolved at session start. The three-source model is clean and handles the main cases:
- Local dev: env vars
- Self-hosted production: file-based secrets (mapped volumes, Docker secrets)
- Cloud: exec-based vault integration

**What to adopt verbatim:**
```typescript
// WorkRail Auto credential model -- adopted from OpenClaw
type SecretRefSource = 'env' | 'file' | 'exec';
type SecretRef = { source: SecretRefSource; provider: string; id: string };
type SecretInput = string | SecretRef;  // plain string = literal value for dev only

// Per-integration credential config
type GitLabCredentials = {
  token: SecretInput;  // 'glpat-xxx' | { source: 'env', id: 'GITLAB_TOKEN' } | { source: 'file', id: '/run/secrets/gitlab-token' }
  baseUrl?: string;
};
```

The `readSecretFileSync` implementation should be directly adapted (not just inspired by). It correctly handles all the TOCTOU/symlink/size edge cases that matter for production credential files.

---

### 6. DaemonRegistry Equivalent (RuntimeCache)

**OpenClaw's pattern (`src/acp/control-plane/runtime-cache.ts`):**

`RuntimeCache` is a pure in-memory Map<actorKey, RuntimeCacheEntry>:
- `actorKey` is the session key (normalized string)
- Each entry has the live `AcpRuntime` handle + `AcpRuntimeHandle` + `lastTouchedAt`
- `collectIdleCandidates(maxIdleMs)` finds sessions idle longer than a threshold for cleanup
- `snapshot()` returns all current runtime states for observability

`CachedRuntimeState`:
```typescript
type CachedRuntimeState = {
  runtime: AcpRuntime;      // the live agent session object
  handle: AcpRuntimeHandle; // cancellation + control handle
  backend: string;          // which LLM provider
  agent: string;            // agent ID
  mode: AcpRuntimeSessionMode;
  cwd?: string;
};
```

**The session manager (`src/acp/control-plane/manager.core.ts`):**
- Singleton `AcpSessionManager` manages all active sessions
- Uses `SessionActorQueue` to serialize concurrent operations per session key
- `RuntimeCache` holds in-flight sessions; completed sessions are removed
- On startup, reconciles identity (re-attaches to sessions that survived restart)

**`SessionActorQueue` (`src/acp/control-plane/session-actor-queue.ts`):**
```typescript
// Wraps KeyedAsyncQueue for per-session serialization
class SessionActorQueue {
  async run<T>(actorKey: string, op: () => Promise<T>): Promise<T>
}
```
`KeyedAsyncQueue` (from plugin-sdk) serializes operations per key: if two messages arrive for the same session simultaneously, the second queues behind the first.

**Key insight for WorkRail Auto:**
WorkRail's `DaemonRegistry` needs the same structure as `RuntimeCache` but with WorkRail-specific fields:

```typescript
// WorkRail DaemonRegistry entry -- modeled on OpenClaw's RuntimeCache
type DaemonSessionEntry = {
  sessionId: string;
  workflowId: string;
  continueToken: string;        // written here AND to daemon-state.json
  checkpointToken: string;      // for crash recovery
  agentAbortController: AbortController;
  triggerSource: string;
  startedAt: number;
  lastActivityAt: number;
  isAutonomous: true;           // marks sessions as daemon-initiated (for console [ LIVE ] badge)
};

class DaemonRegistry {
  private sessions = new Map<string, DaemonSessionEntry>();
  
  register(entry: DaemonSessionEntry): void;
  unregister(sessionId: string): void;
  getActive(): DaemonSessionEntry[];
  snapshot(): DaemonSessionSnapshot[];  // for console API
}
```

The `KeyedAsyncQueue` pattern (~30 lines, from the backlog notes) prevents two daemon runners from advancing the same session concurrently. This is the most important pattern to implement before anything else -- it's the safety gate that prevents token corruption.

**What to adopt:**
- `KeyedAsyncQueue` pattern (~30 lines) -- reimplement, not import
- `collectIdleCandidates` pattern for cleanup of abandoned sessions
- `snapshot()` method for the console live view API

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Adopt `ChannelPlugin` interface pattern as `TriggerPlugin` | Same structural need: typed adapter slots, optional capabilities per integration |
| Adopt `SecretRef` three-source credential model verbatim | Handles all production deployment patterns cleanly; security properties are correct |
| Adopt `TaskNotifyPolicy` enum verbatim | Maps exactly to daemon delivery behavior: done_only / state_changes / silent |
| Adopt `deliveryContext` persistence pattern | Required for crash recovery to route results correctly |
| Adopt `KeyedAsyncQueue` pattern (reimplement ~30 LOC) | Prevents concurrent session modification; critical safety primitive |
| Adopt `RuntimeCache.snapshot()` pattern for DaemonRegistry | Enables console live view without coupling to internal runtime details |
| Skip `jiti` dynamic TypeScript loader | Over-engineered for WorkRail's static integration set |
| Skip `AcpSessionStore` in-memory model | WorkRail's durable disk sessions are strictly superior |
| Skip OpenClaw's skill frontmatter system | WorkRail workflows are JSON; existing workflow registry is the equivalent |
| OpenClaw as optional distribution channel only | Daemon must be freestanding; OpenClaw integration is opt-in add-on |

---

## Final Summary

**The six concrete adoptions for WorkRail Auto (priority order):**

1. **`KeyedAsyncQueue` pattern** (~30 LOC) -- reimplement this first. Prevents two concurrent daemon runners from corrupting the same session. The `SessionActorQueue` wrapper is the right interface: `queue.run(sessionId, async () => { ... })`.

2. **`SecretRef` credential model** -- adopt verbatim as WorkRail's integration credential system. Three sources: `env`, `file`, `exec`. The `readSecretFileSync` security implementation handles TOCTOU correctly.

3. **`TriggerPlugin` interface** -- modeled on `ChannelPlugin` but for trigger sources. Each integration (GitLab, Jira, cron, Slack) implements: `id`, `meta`, `config` (credential resolution), `inbound` (webhook handler), `outbound` (result delivery).

4. **`deliveryContext` persistence** -- store routing info at daemon session creation so crash recovery can route results. Field set: `{ triggerSource, deliveryContext, workflowId, goal, checkpointToken }`.

5. **`TaskNotifyPolicy` enum** -- `done_only` | `state_changes` | `silent`. Per-trigger-source configuration. Drives when the daemon posts intermediate progress vs. only the final result.

6. **`DaemonRegistry` with `snapshot()`** -- in-memory Map of active daemon sessions with `lastActivityAt` and `isAutonomous` flag. `snapshot()` feeds the console live view API. `collectIdleCandidates` drives timeout cleanup.

**What WorkRail already does better (do not regress):**
- Session durability (OpenClaw: in-memory 24h TTL)
- Cryptographic step enforcement (OpenClaw: none)
- HMAC checkpoint tokens (OpenClaw: `resumeSessionId`, no crypto binding)
- Append-only event log (OpenClaw: mutable JSON files)
- DAG visualization (OpenClaw: none)

**What OpenClaw does that WorkRail does not need to replicate:**
- 20+ channel integrations (WorkRail targets 3-4 integrations at MVP)
- `jiti` dynamic TypeScript module loading (complexity not justified)
- Pairing/QR code channel setup flows (not relevant to WorkRail Auto)
- Provider failover and auth rotation (deferred to post-MVP)

---

## Problem Frame Packet

### Primary Stakeholders / Users

| Stakeholder | Job / Outcome | Pain / Tension |
|-------------|---------------|----------------|
| **WorkRail daemon implementer** (Etienne, current) | Build a working autonomous daemon that uses pi-mono's Agent loop, WorkRail session engine, and 3-4 integrations (GitLab, Jira, Slack, cron) | Risk: building the wrong abstraction layer (too much like OpenClaw vs too little). Risk: premature plugin system complexity before we have 3 working integrations. |
| **WorkRail self-hosted user** | Run automated MR reviews, Jira triage, standups without a laptop open | Pain: credential management complexity -- env vars are insufficient for production; file-based secrets are clunky without good documentation |
| **Future WorkRail Auto cloud user** | Zero-ops autonomous agent, no credentials to manage | Tension: the self-hosted credential model and the cloud credential model are different beasts -- designing the local model must leave seams for multi-tenancy without overbuilding now |

### Core Tension

**Build order vs. architecture quality.** The daemon MVP is 6 sequential components (lock fix, context survival, daemon runtime, evidence gate, trigger system, console live view). Adding a full TriggerPlugin interface system at step 3 vs. a simpler hardcoded GitLab + Jira integration has a real tradeoff: clean architecture now = slower first integration; pragmatic hardcoding = faster demo but refactor cost later.

**OpenClaw's ChannelPlugin type is clean because they have 20+ channels.** With 3 integrations, the full plugin interface is speculative generalization. The right call for WorkRail MVP: define the `TriggerPlugin` interface in types but implement it inline for GitLab, Jira, cron -- don't build the dynamic loader.

### Success Criteria

1. A developer reading `docs/ideas/openclaw-deep-dive.md` can identify the 6 adoption patterns and understand the implementation path for each in under 15 minutes.
2. The daemon's `KeyedAsyncQueue` implementation prevents concurrent token corruption (measurable: no duplicate session advance errors under concurrent load test).
3. The `SecretRef` credential model works for all three sources (env/file/exec) with correct security properties (no TOCTOU, no symlink, no logging of secret values).
4. The `TriggerPlugin` interface is in the codebase and GitLab + cron implement it -- even if Jira and Slack are stubs.
5. The `DaemonRegistry.snapshot()` API feeds the console `/api/v2/daemon/sessions` endpoint.

### Assumptions That Could Be Wrong

1. **Assumption:** The `KeyedAsyncQueue` reimplement is ~30 LOC. **Risk:** the actual implementation may have more edge cases (Promise rejection propagation, backpressure, cancellation). If it's 150 LOC to get right, that changes the "ship it in an afternoon" estimate.
2. **Assumption:** WorkRail's existing `LocalSessionLockV2` + workerId fix handles all the daemon/MCP server coexistence scenarios. **Risk:** the backlog notes this fix prevents crashes but doesn't model the case where the daemon is mid-step and MCP server tries to advance the same session. `KeyedAsyncQueue` at the daemon layer prevents this -- but only if MCP calls also go through the queue, which they won't in the same-process model unless we route them explicitly.
3. **Assumption:** SQLite via `node:sqlite` (Node 22.5+) is available in WorkRail's runtime environment. **Risk:** if users run Node 20 LTS, `node:sqlite` is unavailable. Current task registry doesn't use it, but any future task/flow registry adoption from OpenClaw patterns would require it.

### HMW Reframes

1. **HMW make WorkRail Auto's integration model as clean as OpenClaw's channel system without the jiti dynamic loader?** Answer: static imports + typed interface. Define `TriggerPlugin` as a TypeScript interface; each integration is a file that exports a `const plugin: TriggerPlugin`. The "registry" is just an array of imported plugins. No dynamic loading needed for 3-4 integrations.

2. **HMW ensure the credential model works correctly for both developer (env vars) and production (file secrets) without requiring documentation nobody reads?** Answer: validate `SecretRef` at daemon startup and emit a clear diagnostic. If `{ source: 'file', id: '/run/secrets/gitlab-token' }` fails to read, fail fast with a human-readable message pointing to the config guide.

### Framing Risks

1. **Risk:** Treating this as "learn from OpenClaw" could lead to over-indexing on OpenClaw patterns that aren't suited to WorkRail's architecture. Mitigation: every adoption decision in this doc is explicit about what to take vs. what to skip and why.
2. **Risk:** The landscape_first path may miss an important reframe: maybe the right framing is not "what can we adopt from OpenClaw?" but "what's the simplest daemon that works?" OpenClaw patterns add complexity; working code first is faster. Counter: the 6 adoptions are all about making the daemon safer and more maintainable, not just architectural elegance.

---

## Candidate Generation Setup

### Path-specific expectations for candidate generation (landscape_first)

The candidate set must:
1. **Reflect the landscape precedents directly** -- each candidate should map to actual OpenClaw patterns found in the codebase, not free-invented approaches. Candidates that ignore the landscape findings are invalid.
2. **Represent the real option space** -- the genuine option space is the TriggerPlugin interface structure. The 5 other adoption patterns (KeyedAsyncQueue, SecretRef, deliveryContext, TaskNotifyPolicy, DaemonRegistry.snapshot) have no real alternatives; they should be taken as-is. Only the integration contract design is a genuine multi-option decision.
3. **Spread across abstraction levels** -- one pragmatic (minimum viable, hardcoded), one aligned with OpenClaw pattern (typed interface, static imports), one ambitious (full dynamic plugin system). Must not cluster around one abstraction level.
4. **Name tradeoffs explicitly** -- each candidate must state what it costs and what it gives. "Faster first integration" vs. "easier 10th integration" is the core tradeoff.
5. **Not drift into free invention** -- no candidates that abandon the OpenClaw pattern analysis entirely. The research was done; the candidates should use it.

### THOROUGH mode expectation
If the first spread of 3 candidates feels clustered (e.g., all three are just "typed interface with varying complexity"), push for a fourth candidate that represents a genuinely different structural philosophy (e.g., "no abstraction at all, just functions in a module").

---

## Decision Log

### Winner: Candidate B (TriggerPlugin interface + static array + DI CredentialPort)

**Why B won:**
- Follows WorkRail's existing port/adapter pattern from src/v2/ports/ exactly
- Provides compile-time enforcement that Candidates A and D lack
- Uses WorkRail's established neverthrow ResultAsync pattern for credential reads
- Adapts OpenClaw's ChannelPlugin structure (the best existing model) to WorkRail's DI
- Costs ~150-500 LOC (interface definitions + 3 implementations) -- all at the correct abstraction level
- No philosophy conflicts; honors YAGNI (no dynamic loader), type safety, DI, errors as data, immutability

**Why D (runner-up) lost:**
- No compile-time enforcement of integration contract
- No DI boundary for credential injection -- violates "dependency injection for boundaries"
- Saves ~100 LOC vs. B but loses all architecture benefits
- Convention drift failure mode materializes at integration 3, not never

**Challenge pressure that was tested and failed to break B:**
1. "DI container may not be available at daemon startup" -- does not break B. Fallback: explicit constructor parameter injection. Interface stays the same, DI wiring is optional.
2. "Single-kind discriminated union forces webhook OR schedule, not both" -- edge case, not a structural flaw. For integrations needing both: register two TriggerPlugin instances with distinct IDs.
3. "150 LOC underestimates real cost" -- true, it's more like 500 LOC including implementations. Acceptable for a platform-level seam.

**Accepted tradeoffs:**
- ~500 LOC upfront vs. starting minimal (Candidate D)
- Interface may grow too complex if > 8 optional adapter slots are added -- watch at integration 4
- inversify DI wiring may need a daemon-specific context -- straightforward to set up

**Identified failure modes:**
1. Interface growth beyond ~8 methods -- monitor, use routine-hypothesis-challenge at integration 4
2. DI container initialization timing with daemon startup -- resolvable via daemon-specific DI context
3. TriggerId as closed enum -- becomes a constraint if external contributors want custom triggers before the dynamic loader is built

**Switch trigger:** If inversify DI proves incompatible with daemon process model AND explicit constructor injection creates a worse API, consider switching to Candidate D with the explicit understanding that DI boundaries will be retrofitted at integration 4.
