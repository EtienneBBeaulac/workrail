# OpenClaw Deep Dive: Architecture Extraction for WorkRail Auto

**Date:** 2026-04-14
**Workflow:** wr.discovery (landscape_first path)
**Goal:** Extract concrete architectural patterns from OpenClaw for WorkRail Auto's daemon design
**Confidence band:** HIGH on code-verified patterns, MEDIUM on inferred integration behavior

---

## Context / Ask

WorkRail Auto is an autonomous agent daemon that runs 24/7, uses pi-mono's Agent class as the loop, and needs to wire up GitLab/GitHub, Jira, Slack, and other integrations. OpenClaw (357k stars, MIT, TypeScript) is the most architecturally mature example of this pattern in the open-source world.

Six dimensions to extract:
1. Channel/integration architecture -- how 20+ channels are wired cleanly
2. Skill system -- discovery, loading, invocation
3. Session persistence model -- AcpSessionStore + session-logs + SessionManager
4. Notification/delivery system -- completed task result routed back to origin channel
5. Auth/credential model -- per-channel credential storage and injection
6. DaemonRegistry equivalent -- tracking what's running

---

## Path Recommendation

**`landscape_first`** -- the problem is well-framed, the six dimensions are known, and the dominant need is current-state understanding of what OpenClaw actually built. No framing risk that warrants `full_spectrum` or `design_first`.

---

## Landscape Packet

### Current State Summary

OpenClaw is a personal AI assistant daemon running as a background service (launchd on macOS, systemd on Linux, schtasks on Windows). It:
- Listens on 20+ messaging channels (the channel catalog is runtime-populated, not a hardcoded list)
- Runs agent sessions autonomously via ACP (Agent Control Protocol)
- Uses `@mariozechner/pi-agent-core` and `@mariozechner/pi-coding-agent` as the LLM loop (confirmed in `src/agents/pi-embedded-runner/run/attempt.ts`)
- Persists tasks in SQLite (`task-flow-registry.store.sqlite.ts`)
- Delivers results back to origin channels via a session-binding + delivery-queue system
- Stores credentials via a multi-provider secret resolution system (`src/secrets/resolve.ts`)

**Key finding:** OpenClaw is itself built ON pi-mono. It is not an alternative to pi-mono -- it is pi-mono + 80 modules of channel infrastructure, auth rotation, session management, compaction hooks, and delivery routing. This confirms the backlog analysis: WorkRail should use pi-mono directly, not OpenClaw.

### Architecture Layers (verified from source)

```
OpenClaw
├── Daemon service (launchd/systemd/schtasks) -- src/daemon/
├── Gateway -- single process entrypoint, routes inbound messages
├── Channel plugins -- src/channels/plugins/ -- the abstraction unit
│   └── ChannelPlugin<ResolvedAccount> -- one interface, 20+ implementations
├── ACP (Agent Control Protocol) -- src/acp/
│   ├── AcpSessionStore -- in-memory, LRU, 24h TTL
│   ├── SessionActorQueue -- per-session serialization
│   ├── AcpSessionManager (singleton) -- lifecycle
│   ├── RuntimeCache -- in-flight session state (the DaemonRegistry)
│   └── Policy system -- isAcpEnabledByPolicy(), allowedAgents allowlist
├── Agent runner -- src/agents/pi-embedded-runner/
│   └── Uses createAgentSession, SessionManager from @mariozechner/pi-coding-agent
├── Task system -- src/tasks/
│   ├── task-registry.store.sqlite.ts -- SQLite persistence
│   ├── task-flow-registry.ts -- workflow chaining
│   └── task-registry.types.ts -- typed state machine
├── Delivery system -- src/infra/outbound/
│   ├── SessionBindingService -- maps sessions to channels
│   ├── DeliveryQueue -- durable, reconnect-resilient
│   └── deliver.ts -- channel-aware chunking + formatting
└── Secrets -- src/secrets/
    ├── resolve.ts -- multi-provider resolution (file, exec, env)
    └── channel-secret-basic-runtime.ts -- per-channel account injection
```

### Existing Approaches and Precedents

- **pi-mono** (35k stars) -- the LLM loop layer that OpenClaw wraps
- **nexus-core** (internal) -- advisory-only, no enforcement, no daemon
- **ruflo** (31.8k) -- multi-agent swarm, no workflow enforcement
- **oh-my-claudecode** (28.8k) -- teams multi-agent, no durability

### Option Categories

For each of the six research dimensions, WorkRail can:
- **Adopt** the pattern directly (copy the abstraction)
- **Adapt** the pattern (take the shape, change the implementation)
- **Skip** (WorkRail already has a better version)

---

## Problem Frame Packet

- **Primary users:** WorkRail daemon engineers building the `src/daemon/` module
- **Jobs/goals:** Wire up GitLab/GitHub/Jira/Slack without building a new abstraction system each time; understand what's proven to work at scale
- **Pains/tensions:** Building channel infrastructure from scratch is months of work that OpenClaw has already done; but we cannot just import OpenClaw as a dependency -- it's 80 modules of a personal assistant daemon, not a library
- **Success criteria:** Six concrete architectural patterns extracted with enough specificity to write TypeScript interfaces from them, not just describe them
- **Key assumption:** OpenClaw is mature enough at 357k stars + MIT to trust its patterns. Its code quality is high (extensive tests, typed interfaces, subsystem logging).
- **Framing risk:** The goal is pattern extraction, not feature extraction. WorkRail should not try to import or fork OpenClaw modules -- just learn from them.

---

## Dimension-by-Dimension Findings

### 1. Channel/Integration Architecture

**How OpenClaw wires 20+ channels cleanly:**

The core abstraction is `ChannelPlugin<ResolvedAccount>` in `src/channels/plugins/types.plugin.ts`. It is a single interface with ~25 optional adapter slots:

```typescript
type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter<ResolvedAccount>;    // required
  setup?: ChannelSetupAdapter;
  auth?: ChannelAuthAdapter;
  outbound?: ChannelOutboundAdapter;                // required for delivery
  secrets?: ChannelSecretsAdapter;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  messaging?: ChannelMessagingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
  // ... 15+ more optional adapters
};
```

Every channel is just a `ChannelPlugin` implementation. Channels are:
- **Lazily loaded** -- the registry does NOT import channel plugins eagerly (to avoid loading WhatsApp monitor code when only Telegram is configured). `bundled.ts` uses `loadChannelPluginModule()` which is a dynamic import.
- **Discovered at runtime** -- `getChannelPlugin(id)` checks the loaded plugin registry first, then falls back to bundled plugins. External plugins can register themselves via `registerAcpRuntimeBackend()`.
- **Identified by string ID** -- `ChannelId = string`, normalized to lowercase. Aliases supported (`telegram` = `tg`).

**The `agentTools` slot is the integration point WorkRail needs:** channels can register their own MCP-compatible tools (`AgentTool<TSchema>` from pi-mono). When the agent runs, it gets tools from all configured channels automatically.

**WorkRail Auto adoption -- concrete:**

```typescript
// WorkRail integration plugin interface (simplified from OpenClaw's ChannelPlugin)
type WorkRailIntegration<TConfig = unknown> = {
  id: string;
  meta: { label: string; blurb: string };
  config: {
    listAccountIds: (cfg: WorkRailConfig) => string[];
    resolveAccount: (cfg: WorkRailConfig, accountId?: string) => TConfig;
  };
  outbound?: {
    sendText: (ctx: DeliveryContext, text: string) => Promise<void>;
    sendMarkdown?: (ctx: DeliveryContext, markdown: string) => Promise<void>;
  };
  tools?: AgentTool[];          // GitLab MR tools, Jira ticket tools, etc.
  triggers?: TriggerAdapter;    // webhook receiver, cron, etc.
  secrets?: {
    collectRequiredRefs: (cfg: WorkRailConfig) => SecretRef[];
  };
};
```

The key insight: **one interface, all integrations**. GitLab, Jira, Slack, Notion -- each is just a `WorkRailIntegration` implementation. The daemon core has zero knowledge of any specific integration.

---

### 2. Skill System

**How OpenClaw discovers and loads skills:**

OpenClaw's "skills" are not a separate primitive -- they are surfaced via two mechanisms:

1. **`agentTools` on ChannelPlugin** -- channels register `AgentTool<TSchema>[]` (pi-mono typed tools). These are injected into the agent's tool set when a session starts. Example: the GitHub channel contributes `create_pr`, `list_issues` tools.

2. **`agentPrompt` on ChannelPlugin** -- channels can inject prompt fragments into the system prompt. Used for channel-specific instructions ("when using WhatsApp, keep messages under 4096 chars").

3. **AGENTS.md / SKILL.md files** -- loaded by `@mariozechner/pi-coding-agent`'s `SessionManager` / `DefaultResourceLoader`. Skills-as-markdown-files is the pi-mono pattern, not OpenClaw's invention.

**Discovery flow:**
```
configuredChannels
  → loadChannelPlugin(id) for each
  → plugin.agentTools (factory or array)
  → inject into agent session tools list
  → agent runs with all configured channel tools available
```

**WorkRail Auto adoption:**

WorkRail doesn't need a separate skill system. Integration tools (GitLab's `create_mr`, Jira's `transition_ticket`) are declared on each `WorkRailIntegration` as `tools: AgentTool[]`. The daemon injects all configured integration tools at session start. Workflow steps can then call them like any other tool.

For workflow-as-skill: a WorkRail workflow IS the skill. The daemon's `start_workflow()` + `continue_workflow()` calls are the enforcement layer on top of the agent's tool calls.

---

### 3. Session Persistence Model

**AcpSessionStore -- what it actually is:**

```typescript
// src/acp/session.ts -- the full store API
type AcpSessionStore = {
  createSession: (params: { sessionKey: string; cwd: string; sessionId?: string }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
};

type AcpSession = {
  sessionId: string;
  sessionKey: string;    // the human-readable name (e.g., "telegram/user123")
  cwd: string;           // working directory for this session
  createdAt: number;
  lastTouchedAt: number;
  activeRunId: string | null;
  abortController: AbortController | null;
};
```

**Key facts:**
- **In-memory only.** `createInMemorySessionStore()` is the only implementation. `defaultAcpSessionStore` is a module-level singleton.
- **LRU eviction** at 5,000 sessions.
- **24h idle TTL** -- inactive sessions are reaped.
- **No durability.** Sessions vanish on restart.
- **AbortController is the cancellation primitive.** `cancelActiveRun()` calls `abortController.abort()`.

**The gap OpenClaw accepts:** A session interrupted by a crash is lost. The user must restart the task. This is acceptable for a personal assistant (WhatsApp chat resumes naturally), but unacceptable for autonomous coding tasks.

**WorkRail already has the better version:** The WorkRail session store is append-only, disk-persisted, and provides signed checkpoint tokens. A crashed session resumes from its last checkpoint. This is the critical differentiator.

**What WorkRail should take from AcpSessionStore:**

The interface shape is clean and worth copying directly:
```typescript
// WorkRail DaemonSessionStore (proposed)
type DaemonSessionStore = {
  createSession: (params: { workflowId: string; goal: string; triggerSource: TriggerSource }) => DaemonSession;
  getSession: (sessionId: string) => DaemonSession | undefined;
  getSessionByWorkflowRunId: (runId: string) => DaemonSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  // WorkRail additions:
  persistCheckpointToken: (sessionId: string, token: string) => void;  // atomic write to ~/.workrail/daemon-state.json
  getContinueToken: (sessionId: string) => string | undefined;
};
```

**What's different:** WorkRail's version adds `persistCheckpointToken()` -- every `continue_workflow` call writes its token to disk before the next step. Crash = resume from last persisted token. This is the feature that makes autonomous mode actually reliable.

**Regarding the session-logs skill:** OpenClaw's `session-logs` skill is an AGENTS.md-based skill that tells the agent how to use the `session_logs` gateway method. It's not a persistence mechanism -- it's a way for the agent to read historical session data. WorkRail's console session view already does this better.

---

### 4. Notification/Delivery System

**How OpenClaw routes completed task results back to the right channel:**

The delivery system has three layers:

**Layer 1: SessionBindingService** (`src/infra/outbound/session-binding-service.ts`)
Maps session keys to `ConversationRef` records (channel + accountId + threadId). When a task completes, the system looks up where this session is bound and delivers there.

```typescript
type ConversationRef = {
  channel: string;        // "telegram", "slack", etc.
  accountId: string;
  conversationId?: string;
  threadId?: string | number;
};

type SessionBindingService = {
  bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};
```

**Layer 2: DeliveryQueue** (`src/infra/outbound/delivery-queue.ts`)
Durable (disk-backed) queue that survives brief disconnects. Messages enqueued during offline periods are delivered on reconnect. This is the resilience primitive.

**Layer 3: deliver.ts** (`src/infra/outbound/deliver.ts`)
Channel-aware sending. Knows that Telegram needs chunking at 4096 chars, Slack needs markdown, iMessage needs plain text. Gets the `ChannelOutboundAdapter` from the channel plugin and calls the right send method.

```typescript
type ChannelHandler = {
  chunker: Chunker | null;
  textChunkLimit?: number;
  supportsMedia: boolean;
  sendText: (text, overrides?) => Promise<OutboundDeliveryResult>;
  sendMedia?: (caption, mediaUrl, overrides?) => Promise<OutboundDeliveryResult>;
};
```

**The binding lifecycle:** When a user sends a message on Telegram, OpenClaw:
1. Receives the inbound message via the Telegram gateway adapter
2. Calls `recordInboundSession()` which records the `sessionKey` + channel + conversation
3. Spawns an ACP session with the `sessionKey` as identity
4. When the agent responds, `SessionBindingService.resolveByConversation()` finds where to send
5. `deliver.ts` uses the Telegram `ChannelOutboundAdapter` to chunk + send

**WorkRail Auto adoption:**

WorkRail doesn't have 20 channels -- it has 3-4 integrations for MVP (GitLab, Jira, Slack, console). The delivery model is simpler:

```typescript
// WorkRail TriggerSource -- where did this workflow start?
type TriggerSource =
  | { kind: 'gitlab_webhook'; mrIid: number; projectId: string; noteId?: number }
  | { kind: 'jira_webhook'; issueKey: string; transitionId: string }
  | { kind: 'slack_slash_command'; channelId: string; userId: string; threadTs?: string }
  | { kind: 'cron'; scheduleName: string }
  | { kind: 'console'; sessionId: string };

// WorkRail daemon stores TriggerSource with each session
// When workflow completes, DeliveryRouter resolves output target from TriggerSource
```

The key insight from OpenClaw: **bind the delivery target at spawn time, not at completion time.** The daemon records where the task came from (MR iid, Jira issue key, Slack thread) when it starts the session. When it completes, it already knows where to send results. This is simpler than OpenClaw's general session-binding model because WorkRail's trigger sources are more constrained.

**For task-flow chaining:** OpenClaw's `TaskFlowRecord.requesterOrigin: DeliveryContext` carries the original requester context through multi-step flows. WorkRail's equivalent: pass the `triggerSource` through the workflow context so chained workflows can still deliver back to the right place.

---

### 5. Auth/Credential Model

**How OpenClaw stores and injects per-channel credentials:**

**Storage model:** `openclaw.json` + `auth-profiles.json`. The config file holds channel configurations:
```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "token": { "$secret": "file:~/.config/openclaw/secrets/telegram-token" }
        }
      }
    }
  }
}
```

**Secret providers** (`src/secrets/resolve.ts`):
- `file:` -- read from file path (supports `~` expansion, permission checks)
- `exec:` -- run a command, use stdout as the secret (supports 1Password CLI, keychain helpers, etc.)
- Env var inline (direct in config, not recommended)

**Resolution flow:**
```
cfg.channels.telegram.accounts.default.token
  → { "$secret": "file:~/.config/openclaw/secrets/telegram-token" }
  → SecretRef { provider: "file", refId: "~/.config/.../telegram-token" }
  → resolve.ts reads file, returns value
  → injected into channel config before session starts
```

**Concurrency:** Up to 4 providers resolved concurrently (`DEFAULT_PROVIDER_CONCURRENCY = 4`), max 512 refs per provider, max 256KB batch.

**Per-channel injection:** `channel-secret-basic-runtime.ts` resolves the channel config, calls `resolveAccount()` (which expands any `$secret` refs), and returns the hydrated account object. The channel plugin receives its account with secrets already resolved -- it never handles raw `$secret` refs.

**WorkRail Auto adoption:**

This is the cleanest model to adopt directly. WorkRail's daemon config:

```json
{
  "integrations": {
    "gitlab": {
      "url": "https://gitlab.example.com",
      "token": { "$secret": "exec:op read op://Private/GitLab/token" }
    },
    "jira": {
      "url": "https://jira.example.com",
      "email": "etienne@example.com",
      "apiToken": { "$secret": "file:~/.workrail/secrets/jira-token" }
    }
  }
}
```

```typescript
// WorkRail secret provider interface (adapted from OpenClaw)
type SecretProviderConfig =
  | { type: 'file'; path: string }
  | { type: 'exec'; command: string; args?: string[] }
  | { type: 'env'; varName: string };

type SecretRef = { $secret: string };  // "file:path" | "exec:cmd" | "env:VAR"

// resolveSecrets(cfg) returns cfg with all $secret refs hydrated
// Call this once at session start before passing config to integration plugins
```

The `exec:` provider is the critical one: it enables 1Password, Bitwarden, macOS Keychain, and any other credential manager without WorkRail needing to natively support each. The daemon never stores plaintext secrets.

**What to skip from OpenClaw's model:** The `credential-matrix.ts` and `target-registry.ts` are complex machinery for auditing which credentials are user-supplied vs runtime-managed. WorkRail Auto doesn't need this for MVP -- all credentials are user-supplied.

---

### 6. DaemonRegistry Equivalent

**What OpenClaw uses instead of a DaemonRegistry:**

Three overlapping structures:

**1. `RuntimeCache`** (`src/acp/control-plane/runtime-cache.ts`) -- The in-flight session tracking:
```typescript
class RuntimeCache {
  private cache = new Map<string, RuntimeCacheEntry>();
  // actorKey -> { runtime, handle, backend, agent, mode, lastTouchedAt }
  
  set(actorKey: string, state: CachedRuntimeState): void
  get(actorKey: string, { touch?: boolean }): CachedRuntimeState | null
  collectIdleCandidates({ maxIdleMs }): CachedRuntimeSnapshot[]
  snapshot(): CachedRuntimeSnapshot[]  // observability
}
```

This IS the DaemonRegistry. It tracks every active ACP session with its runtime handle, backend, agent identity, and last-activity timestamp. `snapshot()` provides observability. `collectIdleCandidates()` enables idle session cleanup.

**2. `RunStateMachine`** (`src/channels/run-state-machine.ts`) -- Per-channel activity tracking:
```typescript
// Tracks busy/idle state per channel, enables heartbeat broadcasting
const machine = createRunStateMachine({ setStatus, abortSignal, heartbeatMs: 60_000 });
machine.trackRun(async () => { /* agent work */ });
// Broadcasts busy:true on run start, busy:false on run end
// Emits heartbeat every 60s while active (for console live view equivalent)
```

**3. `AcpSessionManager` singleton** -- Lifecycle manager for the full session pool.

**WorkRail's DaemonRegistry (proposed):**

```typescript
// Adapted from RuntimeCache, extended for WorkRail needs
type DaemonSessionState = {
  sessionId: string;
  workflowId: string;
  goal: string;
  triggerSource: TriggerSource;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  currentStepId: string;
  continueToken: string;       // persisted; enables crash recovery
  checkpointToken: string;     // persisted; enables pause/resume
  startedAt: number;
  lastActivityAt: number;
  abortController: AbortController | null;
};

class DaemonRegistry {
  private sessions = new Map<string, DaemonSessionState>();
  
  register(state: DaemonSessionState): void
  get(sessionId: string): DaemonSessionState | null
  cancel(sessionId: string): boolean  // calls abortController.abort()
  snapshot(): DaemonSessionState[]    // for console live view
  collectIdleSessions(maxIdleMs: number): DaemonSessionState[]
  
  // WorkRail-specific:
  persistTokens(sessionId: string, continueToken: string, checkpointToken: string): void
  // Atomic write to ~/.workrail/daemon-state.json before every step
  // This is the crash-recovery primitive OpenClaw lacks
}
```

**Key difference from RuntimeCache:** WorkRail's registry tracks `continueToken` and `checkpointToken` and persists them to disk after every step. OpenClaw's RuntimeCache is in-memory only -- crash = lost session. WorkRail's DaemonRegistry is crash-safe because the tokens survive.

The `RunStateMachine` pattern (heartbeat while busy) maps directly to the `[ LIVE ]` badge design in the backlog: emit a heartbeat event every 60s while a session is active, which the console polls to show live status.

---

## Synthesized Patterns for WorkRail Auto

### Pattern 1: Plugin-interface-first integration architecture
**From:** `ChannelPlugin<ResolvedAccount>`
**WorkRail version:** `WorkRailIntegration<TConfig>` -- one interface, all integrations. GitLab, Jira, Slack each implement it. The daemon core has zero knowledge of any specific integration.

### Pattern 2: KeyedAsyncQueue for per-session serialization
**From:** `SessionActorQueue` wrapping `KeyedAsyncQueue`
**WorkRail version:** ~30 lines. `queue.enqueue(sessionId, async () => { /* step logic */ })`. Prevents concurrent modification of the same session. This is the concurrency safety primitive.

### Pattern 3: TriggerSource-at-spawn-time delivery binding
**From:** `recordInboundSession()` + `SessionBindingService`
**WorkRail version:** Record the `triggerSource` (MR iid, Jira key, Slack thread) when the session is created. `DeliveryRouter.resolve(triggerSource)` at completion knows exactly where to post results. No session-to-channel binding lookup needed.

### Pattern 4: Multi-provider secret resolution
**From:** `src/secrets/resolve.ts` -- `file:`, `exec:`, env providers
**WorkRail version:** Adopt nearly verbatim. The `exec:` provider enables every credential manager without native support. Concurrency limit of 4 providers, batching, structured error types.

### Pattern 5: isXxxEnabledByPolicy() config gating
**From:** `src/acp/policy.ts` -- `isAcpEnabledByPolicy()`, `resolveAcpDispatchPolicyState()`
**WorkRail version:** Every daemon feature flag follows this pattern:
```typescript
export function isDaemonEnabledByPolicy(cfg: WorkRailConfig): boolean
export function isGitLabTriggerEnabledByPolicy(cfg: WorkRailConfig): boolean
export function resolveWorkflowRuntimePolicyError(cfg, workflowId): WorkRailError | null
```
Clean, testable, composable. No inline `if (cfg.daemon?.enabled === false)` spread through the codebase.

### Pattern 6: RuntimeCache as DaemonRegistry
**From:** `RuntimeCache.snapshot()` + `collectIdleCandidates()`
**WorkRail version:** `DaemonRegistry` with the same Map + lastTouchedAt pattern, extended with persisted token fields and `persistTokens()` for crash recovery.

### Pattern 7: RunStateMachine for heartbeat
**From:** `createRunStateMachine({ setStatus, heartbeatMs: 60_000 })`
**WorkRail version:** `trackRun()` wrapper around each daemon step. Emits heartbeat events while active. Console polls these for `[ LIVE ]` badge.

---

## What OpenClaw Does That WorkRail Auto Should NOT Copy

1. **`AcpSessionStore` in-memory implementation** -- WorkRail has a better version (disk-persisted, HMAC-token-gated). Don't replace it.

2. **Channel plugin's `setupWizard`** -- Complex multi-step setup UI for configuring WhatsApp, iMessage pairings, etc. WorkRail's integrations are simpler (API tokens, not phone pairing).

3. **`bundled-channel-catalog-read.ts` dynamic loading** -- Lazy loading 20+ channels is needed for a personal assistant that might use any of them. WorkRail Auto has 4 integrations at MVP; eager loading is fine.

4. **`delivery-queue.ts` disk-backed queue** -- Needed when Telegram might be offline for hours. WorkRail's integrations (GitLab API, Jira API) are either up or failing; a simple retry with backoff is sufficient for MVP.

5. **Auth rotation and provider failover** -- OpenClaw rotates API keys under load and has multi-provider failover. WorkRail Auto at MVP has one Claude API key per deployment. Post-MVP concern.

---

## What WorkRail Does Better Than OpenClaw

| OpenClaw | WorkRail |
|----------|----------|
| In-memory AcpSessionStore, 24h TTL, vanishes on crash | Disk-persisted append-only session store, HMAC tokens, crash-safe |
| No step enforcement -- agent can skip or abandon | Cryptographic step gating -- every step must be completed before the next is unlocked |
| No session audit trail | Full DAG visualization, decision trace, execution log |
| resumeSessionId for continuation but no cryptographic binding | Signed checkpoint tokens -- portable, tamper-evident, carry full session context |
| Workflow chaining via TaskFlowRecord but no workflow composition | WorkRail's workflow format supports loops, conditionals, templateCall, routines |
| Freestanding daemon for one user | WorkRail daemon designed from the start for multi-tenant seams |

---

## Decision Log

**Path choice:** `landscape_first` -- confirmed correct. The six dimensions were code-verified; framing was not ambiguous.

**pi-mono confirmed:** `src/agents/pi-embedded-runner/run/attempt.ts` imports `createAgentSession, SessionManager` from `@mariozechner/pi-coding-agent`. OpenClaw itself uses pi-mono as its agent loop. WorkRail using pi-mono directly is exactly right.

**OpenClaw as dependency: rejected.** OpenClaw is an application, not a library. Its 80-module surface includes WhatsApp pairing, iMessage setup wizards, audio transcription, image generation -- none relevant to WorkRail Auto. The right relationship is pattern extraction, not dependency.

**Secret resolution:** Adopting the `exec:` provider model solves credential management for self-hosted without implementing native 1Password/Keychain/Bitwarden integrations. Defer native integrations to post-MVP.

**KeyedAsyncQueue:** The backlog noted this as ~30 lines to reimplement. Confirmed correct after reading `session-actor-queue.ts` -- it's just a wrapper around a `Map<string, Promise<void>>` tail chain.

---

## Residual Risks and Gaps

1. **Evidence gap: OpenClaw extensions directory** -- The backlog mentions `extensions/` as where channel plugins like WhatsApp, Telegram live. Not found in the `src/` tree read. These may be in a separate private repo or built as separate npm packages. Gap: don't know the exact npm package naming convention for external channel plugins. **Impact on WorkRail Auto: low** -- WorkRail's integrations are built in-repo, not as external packages.

2. **Evidence gap: task delivery for async completions** -- `task-registry-delivery-runtime.ts` exports only `sendMessage`. The full delivery routing (how a completed task in `task-executor.ts` triggers a send to the origin channel) was not fully traced. The session-binding model is clear but the exact trigger hook is unclear. **Impact on WorkRail Auto: low** -- WorkRail's delivery model is simpler (store triggerSource at spawn, send to it on completion).

3. **Session persistence on restart** -- OpenClaw's `SessionManager` from pi-mono may have its own session file (MEMORY.md, transcript files). Not fully investigated. **Impact: medium** -- WorkRail daemon needs to understand what pi-mono persists natively so there's no conflict with WorkRail's session store.

---

## Final Summary

**Selected direction:** Build WorkRail Auto's daemon core using seven patterns extracted from OpenClaw:

1. `WorkRailIntegration<TConfig>` plugin interface -- one abstraction, all integrations
2. `KeyedAsyncQueue` for per-session serialization (~30 lines, reimplement)
3. `TriggerSource`-at-spawn delivery binding (simpler than OpenClaw's SessionBindingService)
4. Multi-provider secret resolution (`file:`, `exec:`, env) -- adopt nearly verbatim
5. `isXxxEnabledByPolicy()` pattern for all config gating
6. `DaemonRegistry` class (RuntimeCache shape + WorkRail token persistence extension)
7. `RunStateMachine` heartbeat pattern for console live view

**WorkRail already has the better version of:** session persistence (disk vs memory), step enforcement (HMAC vs none), audit trail (DAG vs none), checkpoint/resume (signed tokens vs raw resumeSessionId).

**pi-mono is confirmed as the right loop layer.** OpenClaw uses it internally. WorkRail should use `@mariozechner/pi-agent-core` and `@mariozechner/pi-coding-agent` directly -- not OpenClaw.

**Confidence band:** HIGH for patterns 2-7 (code-verified). MEDIUM for pattern 1 (the integration interface shape is well-founded but hasn't been exercised against real GitLab/Jira APIs yet).

**Next actions:**
1. Implement `DaemonRegistry` with token persistence (Pattern 6 -- unlocks crash recovery)
2. Design `WorkRailIntegration<TConfig>` interface with first implementation: GitLab webhook receiver (Pattern 1)
3. Implement `KeyedAsyncQueue` ~30 lines (Pattern 2 -- needed before concurrent sessions are possible)
4. Add `resolveSecrets(cfg)` using `file:` + `exec:` providers (Pattern 4 -- needed for GitLab token)
5. Wire `RunStateMachine` into daemon step loop (Pattern 7 -- console live view)

See `docs/ideas/backlog.md` for full daemon architecture context and build order.
