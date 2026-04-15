# WorkRail Auto: Trigger System Design

**Status:** Design complete, not yet implemented.
**Workflow:** wr.discovery (completed Apr 15, 2026)
**Confidence:** High -- based on full source reading of AutoGPT and mcp-graph-workflow.

---

## Context / Ask

WorkRail Auto (the autonomous daemon) needs a trigger system: a way to start workflow sessions in response to external events (GitLab MR opened, Jira ticket moved to In Progress, cron schedule, etc.) without human intervention.

Two external systems were studied:
1. **AutoGPT** (183k stars, Python, production) -- the closest reference for a production-grade trigger/block system
2. **mcp-graph-workflow** (DiegoNogueiraDev, 29 stars, TypeScript) -- identified in the backlog as "closest external WorkRail analog," assessed here against the actual source

---

## AutoGPT Trigger Architecture

AutoGPT's trigger model is three layers:

### Layer 1: Declaration (BlockWebhookConfig)

```python
@dataclass
class BlockManualWebhookConfig:
    provider: ProviderName      # "github", "gitlab", "generic_webhook", etc.
    webhook_type: str           # "repo" (GitHub repo-level) vs "org"
    event_filter_input: str     # name of block input holding event selector
    event_format: str           # "pull_request.{event}" -> "pull_request.opened"

@dataclass
class BlockWebhookConfig(BlockManualWebhookConfig):
    resource_format: str        # "{owner}/{repo}" -- resolved from block inputs at registration
    # Auto-setup: platform registers webhook via provider API using credentials
```

**Key distinctions:**
- `BlockManualWebhookConfig` = user sets up the webhook themselves at the provider
- `BlockWebhookConfig` = platform auto-registers the webhook via provider API (requires credentials field on block input schema)
- Platform disables webhook blocks entirely if `platform_base_url` is not set -- no URL, no webhooks

**Event filter**: A `BaseModel` subclass where all fields are booleans (`opened: bool = False`, `closed: bool = False`, etc.). Validated at `Block.__init__` time. Example: `GithubPullRequestTriggerBlock.Input.EventsFilter` has 20+ boolean flags for PR events.

**BlockType enum** includes: `WEBHOOK` (auto-setup), `WEBHOOK_MANUAL` (user-setup), `AGENT`, `MCP_TOOL`, `HUMAN_IN_THE_LOOP`.

### Layer 2: Registration (WebhooksManager)

Per-provider class that handles:
- `register(trigger, webhookUrl, credentials)` → registers with provider API (e.g., GitHub Webhooks API)
- `deregister(handle, credentials)` → removes the webhook at the provider
- Manual registrars: just display the webhook URL for the user to configure themselves

### Layer 3: Execution (Block.run())

```python
async def run(self, input_data: Input, **kwargs) -> BlockOutput:
    yield "payload", input_data.payload                     # raw webhook payload
    yield "triggered_by_user", input_data.payload["sender"]
    yield "event", input_data.payload["action"]
    # etc.
```

The trigger block is stateless: raw payload in, structured output out. Output routes to the next block in the graph. The block has a hidden `payload` input that the platform injects with the webhook payload when the event arrives.

### Credential System

AutoGPT separates credential types (OAuth2, API key, bearer token, etc.) per provider. Blocks declare required credentials with typed fields (`GithubCredentialsField`, etc.). The platform manages credential storage; blocks only declare what they need. Credentials are never embedded in block definitions -- they're resolved at runtime from the platform's credential service.

### Multi-Tenancy

- `platform_base_url` gates whether webhook features are available at all
- Credentials are user-scoped (stored per user in the platform's credential service)
- Each block instance in a graph has its own credential binding
- `resource_format` is per-instance (e.g., a specific GitHub repo)

---

## Proposed WorkRail Auto Trigger Abstraction

Directly derived from AutoGPT's three-layer model with one key substitution: **execute = startWorkflow() instead of yield-to-next-block**.

### Layer 1: TriggerDefinition

```typescript
interface TriggerDefinition {
  id: string;                           // UUID, stable across restarts
  provider: string;                     // "github" | "gitlab" | "jira" | "cron" | "generic" | string
  triggerType: string;                  // provider-specific: "repo_webhook" | "ticket" | "schedule"
  resourceTemplate: string;            // "{owner}/{repo}" | "*/5 * * * *"
  eventFilter: Record<string, boolean>; // boolean flags per event type (optional)
  eventTopicTemplate: string;          // "pull_request.{event}" | "cron"
  credentialRef?: string;              // named ref in WorkRail keyring (never plaintext)
  workflowId: string;                  // which workflow to start
  contextMapping?: ContextMapping;     // optional: map event payload → workflow context
}

interface ContextMapping {
  mappings: Array<{
    workflowContextKey: string;  // e.g. "mrTitle"
    payloadPath: string;         // JSONPath against normalized payload, e.g. "$.title"
    required?: boolean;
  }>;
}
```

**In MVP: `contextMapping` is optional.** If absent, the raw (normalized) payload is passed as `context.payload`.

### Layer 2: TriggerRegistrar (per provider)

```typescript
interface TriggerRegistrar {
  register(trigger: TriggerDefinition, webhookUrl: string, credentials: Credentials): Promise<TriggerHandle>;
  deregister(handle: TriggerHandle, credentials: Credentials): Promise<void>;
}

// null registrar = manual: user sets up webhook themselves, WorkRail displays the URL
// MVP ships null registrar only (generic + cron providers)
```

### Layer 3: TriggerRouter (execution)

```typescript
interface TriggerRouter {
  route(event: IncomingWebhookEvent): Promise<void>;
}

// Flow:
// POST /webhook/:triggerId
//   → verify HMAC signature (per provider signature scheme)
//   → lookup TriggerDefinition by triggerId
//   → normalize raw payload to canonical form (per provider normalizer)
//   → apply contextMapping (JSONPath against normalized payload)
//   → enqueue to async queue (prevent webhook delivery timeout)
//   → daemon.startWorkflow(trigger.workflowId, mappedContext)
```

**Important design choices:**
- Async queue: prevents webhook delivery timeout (providers retry if no 2xx within ~10s)
- Idempotent: dedup by event delivery ID to handle provider retries
- Signature verification: per-provider (GitHub: `X-Hub-Signature-256`, GitLab: `X-Gitlab-Token`, generic: configurable HMAC)

### Credential Model

```typescript
// Credentials stored in WorkRail keyring -- NEVER in trigger definitions or workflow files
type CredentialRef = string; // e.g. "github-personal", "gitlab-zillow-token"

interface StoredCredential {
  name: CredentialRef;
  provider: string;
  type: "api_key" | "oauth2" | "bearer" | "basic";
  // value stored encrypted, never in plaintext
}
```

**Two credential backends:**
- OS keychain via `keytar` (local development, macOS/Linux with keyring)
- Encrypted env-file (headless environments: Docker, CI, hosted WorkRail Auto)

The backend is configurable; the interface (`get(name)`, `set(name, value)`) is identical in both.

### File Structure

```
src/trigger/
├── trigger-store.ts         -- SQLite table: triggers, handles, delivery log
├── trigger-listener.ts      -- Express, separate port (default 3200)
├── trigger-router.ts        -- lookup + normalize + contextMapping + daemon.startWorkflow()
├── credential-store.ts      -- keyring abstraction (OS keychain or env-file backend)
├── providers/
│   ├── generic.ts           -- manual only: display URL, no auto-registration
│   ├── cron.ts              -- node-cron: schedule-based, no external registration
│   ├── gitlab.ts            -- (post-MVP) GitLab Webhooks API auto-registration
│   └── github.ts            -- (post-MVP) GitHub Webhooks API auto-registration
└── index.ts                 -- public API: registerTrigger, listTriggers, startListener
```

**Port:** 3200 (separate from MCP 3100 and dashboard 3456). Different security model: MCP requires session auth, webhooks require HMAC verification. Separation avoids accidental auth bypass.

**Feature flag:** `wr.features.triggers`

### Build Order (MVP)

1. `trigger-store.ts` -- SQLite schema (triggers table)
2. `trigger-listener.ts` -- Express endpoint POST /webhook/:triggerId
3. `trigger-router.ts` -- with stub DaemonInterface (testable before daemon exists)
4. `providers/generic.ts` -- manual only, any HTTP POST becomes a trigger
5. `providers/cron.ts` -- schedule-based, zero external dependencies
6. MCP tools: `create_trigger`, `list_triggers`, `delete_trigger` (feature-flagged)

**The generic provider alone is a complete MVP.** It covers any webhook from any system that can send HTTP POST. GitLab, Jira, Slack, PagerDuty -- all work with a generic trigger and manual webhook configuration. Auto-registration is a post-MVP quality-of-life improvement.

### Provider-Specific Normalizers (post-MVP)

To handle payload format changes gracefully, each provider module includes a normalizer:

```typescript
// raw webhook payload → canonical form → contextMapping runs against canonical
interface PayloadNormalizer {
  normalize(rawPayload: unknown, eventTopic: string): NormalizedPayload;
}
```

This isolates WorkRail from provider payload schema changes. The contextMapping always runs against the canonical form.

### Architecture Diagram

```
External event (GitLab MR opened)
  ↓ HTTP POST
trigger-listener (port 3200)
  ↓ verify signature
  ↓ lookup TriggerDefinition
  ↓ normalize payload (provider normalizer)
  ↓ apply contextMapping
  ↓ async queue
trigger-router
  ↓ daemon.startWorkflow(workflowId, mappedContext)
WorkRail daemon
  ↓ pi-mono agentLoop
  ↓ WorkRail session (HMAC-enforced steps)
  ↓ output (MR comment, Jira update, etc.)
```

### Key Difference from AutoGPT

| Aspect | AutoGPT | WorkRail Auto |
|--------|---------|---------------|
| Execute | yield payload to next block in graph | startWorkflow(workflowId, context) |
| Multi-step | Block is one node in a DAG | Trigger starts a full enforced workflow session |
| Enforcement | None at trigger level | WorkRail HMAC token protocol applies to started session |
| Trigger complexity | Simple (one block) | Simple (one dispatcher) |
| Execution complexity | Complex (graph traversal) | Complex (full workflow with loops/conditionals) |

WorkRail's trigger is simpler at the trigger level but more powerful at the execution level.

---

## mcp-graph-workflow Assessment

### What It Actually Is

**mcp-graph-workflow** (DiegoNogueiraDev, 29 stars, TypeScript, MIT) is a local-first MCP server that converts PRD documents into SQLite execution graphs. It structures all software development work into a fixed **9-phase lifecycle**: ANALYZE → DESIGN → PLAN → IMPLEMENT → VALIDATE → REVIEW → HANDOFF → DEPLOY → LISTENING.

It is NOT an analog to WorkRail. It is a **software development task manager** that uses MCP as its API layer.

### How It Enforces Step Sequencing

mcp-graph-workflow uses a **gate system** (not tokens):

```typescript
// unified-gate.ts: wrapToolsWithGates() wraps every MCP tool call
// 1. Read current phase from SQLite (detectCurrentPhase)
// 2. Check gate rules for this tool+phase combination
// 3. If strictness=strict AND error-severity warnings: return blocked response
// 4. If strictness=advisory: return warnings but allow tool call
// 5. force:true parameter bypasses the gate
// Every response includes _lifecycle.nextAction (guidance, not enforcement)
```

Phase detection is derived from graph state (no tokens):
- 0 nodes → ANALYZE
- Any task `in_progress` → IMPLEMENT
- All tasks `done` → REVIEW
- All tasks done + snapshots exist → HANDOFF
- ≥50% done → VALIDATE
- No sprints assigned → PLAN
- Fallback → IMPLEMENT

### mcp-graph-workflow vs WorkRail: Honest Comparison

| Dimension | mcp-graph-workflow | WorkRail |
|-----------|-------------------|----------|
| **Enforcement** | Advisory gates (bypassable: advisory mode, force:true) | HMAC-signed tokens (cryptographic, unbypassable without token) |
| **Step skipping** | Possible | Impossible without the token |
| **State** | SQLite (nodes, edges, events, RAG knowledge) | Append-only event log (disk) |
| **Workflow format** | Implicit: fixed 9-phase lifecycle always | Explicit JSON with loops, conditionals, routines |
| **Domain** | Software development only | Any domain |
| **Trigger system** | None | Planned (this document) |
| **Autonomous execution** | None (human-initiated MCP only) | Planned daemon with pi-mono agentLoop |
| **Context compression** | 70-85% via RAG (BM25 + ONNX embeddings, local) | None yet |
| **Code intelligence** | AST analysis, impact scoring, 13 languages | None |
| **Metrics** | DORA metrics (deploy freq, lead time, CFR, MTTR) | None |
| **PRD import** | .md, .txt, .pdf → task graph | None |
| **Portability** | SQLite required, local-only | Zero config, any environment |
| **Team mode** | SQLite lock + leaseToken (teamTask mode) | Nested subagents via delegation |

### What mcp-graph-workflow Does Better

1. **RAG context compression** -- 70-85% token reduction via BM25 + local ONNX embeddings. Worth studying for WorkRail's future context survival feature.
2. **Code intelligence** -- AST-based code graph with impact analysis (which symbols are affected by a change). WorkRail doesn't touch code.
3. **DORA metrics** -- deploy frequency, lead time, CFR, MTTR. WorkRail has no metrics.
4. **PRD import** -- paste a product requirements document, get a task graph. WorkRail has no equivalent.
5. **Harness Engineering** -- 7-dimension agent-readiness scoring. Unique.

### What WorkRail Does Better

1. **Cryptographic enforcement** -- HMAC token makes step skipping impossible. mcp-graph's gate can be bypassed with `force:true` or by switching to advisory mode.
2. **Domain-agnostic** -- WorkRail works for any process (coding, goals, MR review, incident response). mcp-graph is software development only.
3. **Workflow composition** -- loops, conditionals, routines, templateCall, delegation. mcp-graph has no equivalent (always the fixed 9-phase lifecycle).
4. **Portable sessions** -- checkpoint/resume with HMAC-signed tokens. mcp-graph has SQLite state but no portable resume tokens.
5. **Zero-config portability** -- `npx -y @exaudeus/workrail`. mcp-graph requires SQLite setup.
6. **Autonomous execution path** -- daemon architecture designed and partially built. mcp-graph is human-initiated only.

### Verdict: Different Quadrants, Complementary Tools

```
                   ENFORCEMENT STRENGTH
                   Advisory (Prompt/Gate)    Structural (Cryptographic)
                ┌────────────────────────┬─────────────────────────────┐
          Yes   │  mcp-graph-workflow     │  WorkRail                   │
DURABLE         │  (SQLite, phase gates,  │  (event log, HMAC tokens,   │
STATE           │  force:true bypass)     │  unbypassable)              │
                ├────────────────────────┼─────────────────────────────┤
          No    │  CLAUDE.md files        │  (empty)                    │
                │  nexus-core             │                             │
                └────────────────────────┴─────────────────────────────┘
```

mcp-graph-workflow and WorkRail do not compete. A team could use both: mcp-graph-workflow for task decomposition and code-awareness during software development, WorkRail for enforcing the governance process around each development decision. They are complementary, not substitutes.

### Backlog Correction Needed

The competitive landscape in `docs/ideas/backlog.md` currently states:
> "mcp-graph (DiegoNogueiraDev) -- SQLite-backed MCP server with graph-based step locking. Closest external analog."

This characterization is **incorrect** after reading the source. The correct description:

> "mcp-graph-workflow (DiegoNogueiraDev) -- software development task manager with advisory lifecycle phase gates (SQLite-backed, bypassable). Different quadrant from WorkRail: task management (top-left) vs process enforcement (top-right). Complementary tool, not analog. Notable: local RAG context compression (70-85% token reduction via BM25+ONNX) worth studying for WorkRail's context survival feature."

---

## Design Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture model | AutoGPT three-layer (declare+register+execute) | Validated by 183k-star production system. Clean separation. |
| Execute action | startWorkflow() not yield-to-next-block | WorkRail's unit of work is a multi-step session, not a single block |
| Credential model | Keyring named refs | Never plaintext in workflow files. Two backends for portability. |
| MVP providers | Generic (HTTP POST) + cron | Zero external dependencies. Generic covers any webhook. |
| Auto-registration | Post-MVP | MVP validates the abstraction; auto-setup is UX polish |
| Port | 3200 (separate from MCP 3100) | Different security model; separation prevents auth bypass |
| contextMapping | Optional in MVP | Reduces complexity; raw payload passthrough covers basic cases |
| Payload handling | Provider normalizers (raw→canonical) | Isolates WorkRail from provider schema changes |
| Docker/CI creds | env-file backend | OS keychain fails in headless environments |

---

## Next Actions

1. Fix `LocalSessionLockV2` with workerId (prerequisite for daemon -- see backlog.md)
2. Build daemon MVP (pi-mono `agentLoop` + `runWorkflow()`)
3. Implement `src/trigger/` with generic + cron providers
4. Wire `trigger-router.ts` to `daemon.startWorkflow()`
5. Add MCP tools: `create_trigger`, `list_triggers`, `delete_trigger` (feature flag: `wr.features.triggers`)
6. First real trigger: GitLab MR webhook → `wr.mr-review` → post MR comment
7. Correct mcp-graph-workflow description in `docs/ideas/backlog.md`
