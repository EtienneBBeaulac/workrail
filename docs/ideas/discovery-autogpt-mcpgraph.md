# Discovery: AutoGPT and mcp-graph -- WorkRail Auto Design Intelligence

**Date:** 2026-04-14
**Workflow:** wr.discovery (landscape_first, rigorMode: THOROUGH)
**Status:** Complete

---

## Context / Ask

Deep dive on two external projects relevant to WorkRail Auto's autonomous platform vision:

1. **AutoGPT** (183k stars, Python, MIT) -- focus on block/trigger system, credential system, execution model, multi-tenancy
2. **mcp-graph** (29 stars, TypeScript, MIT) -- identified as closest external WorkRail analog; focus on step sequencing, SQLite persistence, and comparative analysis

Goal: actionable design intelligence with concrete code evidence.

## Path Recommendation

**`landscape_first`** -- the vision is clear in the backlog. This is external grounding research. The dominant need is understanding how these two specific systems have solved the exact problems WorkRail Auto needs to solve, with actual code.

**rigorMode: THOROUGH**

## Constraints / Anti-goals

- Anti-goal: do not redesign WorkRail. Extract patterns and evidence only.
- Anti-goal: do not study AutoGPT's full scope. Focus on the four specified subsystems.
- Anti-goal: do not propose implementation. Surface evidence for future design decisions.

---

## Landscape Packet

### Project 1: AutoGPT

**Repo:** `Significant-Gravitas/AutoGPT` -- 183k stars, Python, MIT.

#### 1. Block/Trigger System

AutoGPT's trigger abstraction is built on two cooperating patterns: `Block` + `BlockWebhookConfig`.

**The base trigger class** (`autogpt_platform/backend/backend/blocks/github/triggers.py`):

```python
class GitHubTriggerBase:
    class Input(BlockSchemaInput):
        credentials: GithubCredentialsInput = GithubCredentialsField("repo")
        repo: str = SchemaField(...)
        payload: dict = SchemaField(hidden=True, default_factory=dict)

    class Output(BlockSchemaOutput):
        payload: dict
        triggered_by_user: dict
        error: str
```

The `payload` field is the bridge: it's hidden from the UI but auto-populated by the webhook system when an event fires. The block just reads it as normal input.

**Webhook configuration declaration** (`_base.py`):

```python
class BlockManualWebhookConfig(BaseModel):
    provider: ProviderName
    webhook_type: str
    event_filter_input: str = ""   # name of the bool-field filter on Input
    event_format: str = "{event}"  # e.g. "pull_request.{event}"

class BlockWebhookConfig(BlockManualWebhookConfig):
    resource_format: str  # e.g. "{repo}" -- auto-registers webhook at provider
```

The distinction between `BlockManualWebhookConfig` and `BlockWebhookConfig` is key: auto-setup blocks get the webhook registered for them; manual blocks require the user to configure the webhook URL at the provider side.

**How a trigger block is declared** (`GithubPullRequestTriggerBlock.__init__`):

```python
super().__init__(
    id="6c60ec01-8128-419e-988f-96a063ee2fea",
    block_type=BlockType.WEBHOOK,  # set automatically when webhook_config is present
    webhook_config=BlockWebhookConfig(
        provider=ProviderName.GITHUB,
        webhook_type=GithubWebhookType.REPO,
        resource_format="{repo}",
        event_filter_input="events",
        event_format="pull_request.{event}",
    ),
)
```

**Event filter pattern** -- the events field is a typed Pydantic model with bool fields:

```python
class EventsFilter(BaseModel):
    opened: bool = False
    closed: bool = False
    synchronize: bool = False
    # ... etc.
```

The `event_filter_input = "events"` tells the webhook system which field to read to filter which event types the block subscribes to. This is elegant: event subscription is statically typed but dynamically composed.

**Generic webhook trigger** (`generic_webhook/triggers.py`) -- the escape hatch:

```python
class GenericWebhookTriggerBlock(Block):
    class Input(BlockSchemaInput):
        payload: dict = SchemaField(hidden=True, default_factory=dict)
        constants: dict = SchemaField(...)  # user-defined constants set at graph authoring time

    def __init__(self):
        super().__init__(
            webhook_config=BlockManualWebhookConfig(  # manual (not auto-setup)
                provider=ProviderName(generic_webhook.name),
                webhook_type=GenericWebhookType.PLAIN,
            ),
        )

    async def run(self, input_data: Input, **kwargs) -> BlockOutput:
        yield "constants", input_data.constants
        yield "payload", input_data.payload
```

**Webhook manager** (`webhooks/_base.py`):

```python
class BaseWebhooksManager(ABC, Generic[WT]):
    PROVIDER_NAME: ClassVar[ProviderName]

    async def get_suitable_auto_webhook(self, user_id, credentials, webhook_type, resource, events):
        # Find existing webhook with same creds/resource/events, or create new one
        if webhook := await integrations.find_webhook_by_credentials_and_props(...):
            return webhook
        return await self._create_webhook(...)

    @classmethod
    @abstractmethod
    async def validate_payload(cls, webhook, request, credentials) -> tuple[dict, str]:
        # Must return (payload_dict, event_type_string)
        ...
```

**Key design insight for WorkRail Auto:** AutoGPT's trigger abstraction is three-layer: (1) the Block declares its event schema and webhook config; (2) the WebhooksManager handles provider registration and payload validation; (3) the payload flows into the block as hidden input. WorkRail's trigger system should follow the same separation. The WorkRail trigger equivalent:
- Trigger declares: `provider`, `event_type`, `resource_format`, `event_filter_schema`
- TriggerManager: registers webhook, validates HMAC, routes payload to correct workflow
- Payload flows into `workflow.context` as the trigger input

#### 2. Credential System

**Model layer** (`backend/data/model.py`):

```python
class _BaseCredentials(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    provider: str
    title: Optional[str] = None
    is_managed: bool = False

    @field_serializer("*")
    def dump_secret_strings(value: Any, _info):
        if isinstance(value, SecretStr):
            return value.get_secret_value()
        return value

class APIKeyCredentials(_BaseCredentials):
    type: Literal["api_key"] = "api_key"
    api_key: SecretStr  # pydantic SecretStr -- never logged, masked in repr
    expires_at: Optional[int] = None

class OAuth2Credentials(_BaseCredentials):
    type: Literal["oauth2"] = "oauth2"
    access_token: SecretStr
    refresh_token: Optional[SecretStr] = None
    scopes: list[str]
```

`SecretStr` is used throughout -- the type system enforces that secret values can't be accidentally logged or serialized as plaintext.

**Storage layer** (`backend/data/user.py` + `backend/util/encryption.py`):

```python
class JSONCryptor:
    def __init__(self, key: Optional[str] = None):
        self.fernet = Fernet(ENCRYPTION_KEY)  # symmetric Fernet (AES-128-CBC + HMAC)

    def encrypt(self, data: dict) -> str:
        return self.fernet.encrypt(json.dumps(data).encode()).decode()

    def decrypt(self, encrypted_str: str) -> dict:
        return json.loads(self.fernet.decrypt(encrypted_str.encode()).decode())

async def get_user_integrations(user_id: str) -> UserIntegrations:
    user = await PrismaUser.prisma().find_unique_or_raise(where={"id": user_id})
    return UserIntegrations.model_validate(
        JSONCryptor().decrypt(user.integrations)  # single encrypted blob per user
    )

async def update_user_integrations(user_id: str, data: UserIntegrations):
    encrypted_data = JSONCryptor().encrypt(data.model_dump(exclude_none=True))
    await PrismaUser.prisma().update(where={"id": user_id}, data={"integrations": encrypted_data})
```

All per-user credentials are stored as a **single Fernet-encrypted JSON blob** in the `User.integrations` column (PostgreSQL, managed via Prisma). The blob contains the full `UserIntegrations` model: credentials list + OAuth states + managed credentials.

**Credential injection into blocks** (`executor/manager.py`, `execute_node`):

```python
# Last-minute fetch credentials + acquire system-wide read-write lock
creds_locks: list[AsyncRedisLock] = []
for field_name, input_type in input_model.get_credentials_fields().items():
    credentials_meta = input_type(**field_value)
    credentials, lock = await creds_manager.acquire(user_id, credentials_meta.id)
    # lock = Redis distributed lock held for duration of block execution
    creds_locks.append(lock)
    extra_exec_kwargs[field_name] = credentials  # injected as kwargs to block.run()

try:
    async for output_name, output_data in node_block.execute(input_data, **extra_exec_kwargs):
        yield output_name, output_data
finally:
    for creds_lock in creds_locks:
        await creds_lock.release()  # always released, even on exception
```

Credentials are fetched just before block execution, held under a Redis lock for the duration (preventing concurrent refresh/invalidation), and injected directly as kwargs. The block receives the `Credentials` object, not just a token -- it can call `.auth_header()` directly.

**Managed credentials** (`integrations/managed_credentials.py`):

```python
class ManagedCredentialProvider(ABC):
    provider_name: str

    @abstractmethod
    async def is_available(self) -> bool: ...
    @abstractmethod
    async def provision(self, user_id: str) -> Credentials: ...
    @abstractmethod
    async def deprovision(self, user_id: str, credential: Credentials) -> None: ...
```

Platform-managed credentials (e.g. an AgentMail API key auto-provisioned per user) use a distributed Redis lock to prevent duplicate provisioning across workers:

```python
async with locks.locked(key):
    if await store.has_managed_credential(user_id, name):
        return True  # already exists
    credential = await provider.provision(user_id)
    await store.add_managed_credential(user_id, credential)
```

**Key design insights for WorkRail Auto:**
- Credential storage model: Fernet-encrypted JSON blob per user. Simple, auditable, no column-per-field sprawl. WorkRail daemon can use the same pattern with a simpler key store (file-based for self-hosted, encrypted store for cloud).
- Injection pattern: credentials fetched at execution time (not at workflow start), injected as typed objects (not raw strings), held under lock for duration. This prevents stale token use.
- Managed credentials: platform auto-provisions per-user service credentials. WorkRail's daemon could auto-provision a service API key for each user/org at first use.
- `SecretStr` throughout: secrets should never appear in logs or serialization by default -- enforce this at the type level.

#### 3. Execution Model

**ExecutionManager** (`executor/manager.py`):

```python
class ExecutionManager(AppProcess):
    def __init__(self):
        self.pool_size = settings.config.num_graph_workers
        self.active_graph_runs: dict[str, tuple[Future, threading.Event]] = {}
        self._executor = None  # ThreadPoolExecutor, lazy-init

    @property
    def executor(self) -> ThreadPoolExecutor:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(
                max_workers=self.pool_size,
                initializer=init_worker,  # creates ExecutionProcessor per thread
            )
        return self._executor

    def run(self):
        self.cancel_thread.start()  # consumes from RabbitMQ cancel queue
        self.run_thread.start()     # consumes from RabbitMQ run queue
        while True:
            time.sleep(1e5)         # main thread just keeps process alive
```

Thread-local `ExecutionProcessor` instances -- each worker thread gets its own instance initialized once at thread start:

```python
_tls = threading.local()

def init_worker():
    _tls.processor = ExecutionProcessor()
    _tls.processor.on_graph_executor_start()

def execute_graph(graph_exec_entry, cancel_event, cluster_lock):
    processor: ExecutionProcessor = _tls.processor
    return processor.on_graph_execution(graph_exec_entry, cancel_event, cluster_lock)
```

**Graph execution queue** -- RabbitMQ-based:

```python
run_channel.basic_qos(prefetch_count=self.pool_size)
run_channel.basic_consume(
    queue=GRAPH_EXECUTION_QUEUE_NAME,
    on_message_callback=self._handle_run_message,
    auto_ack=False,  # ACK only after successful execution
)
```

`prefetch_count = pool_size` means the worker never takes more messages than it can process concurrently. `auto_ack=False` means if the worker crashes mid-execution, the message returns to the queue for another worker.

**Distributed lock per graph execution** (`executor/cluster_lock.py`):

```python
class ClusterLock:
    def try_acquire(self) -> str | None:
        success = self.redis.set(self.key, self.owner_id, nx=True, ex=self.timeout)
        if success:
            return self.owner_id
        return self.redis.get(self.key)  # returns current owner

    def refresh(self) -> bool:
        # Rate-limited TTL extension (at most once per timeout/10 seconds)
        if self.redis.expire(self.key, self.timeout):
            return True
        return False  # lost the lock
```

Each `executor_id` (UUID assigned at pod start) is the lock owner. Prevents two pods from executing the same graph run simultaneously.

**Concurrent node execution within a graph**: nodes within a single graph execution can run concurrently. The execution queue tracks which nodes have all inputs ready, and multiple can be running simultaneously:

```python
execution_context = execution_context.model_copy(
    update={"node_id": node_id, "node_exec_id": node_exec_id}
)
# Node-specific copy prevents concurrent nodes from mutating shared state
```

**Key design insights for WorkRail Auto:**
- Message queue pattern: RabbitMQ as the dispatch layer between trigger → execution. WorkRail's daemon could use the same pattern with Redis pub/sub or a simpler in-process queue for self-hosted.
- Thread pool + thread-local state: per-thread ExecutionProcessor avoids shared mutable state across concurrent graph executions.
- Distributed locking for idempotency: Redis lock per execution ensures exactly-one execution across pods -- the exact same pattern WorkRail's `LocalSessionLockV2` implements locally.
- `prefetch_count = pool_size`: backpressure is built into the queue consumer, not managed manually.

#### 4. Multi-Tenancy

AutoGPT's multi-tenancy is purely data-layer isolation -- no process-level isolation:

- **User ID flows everywhere**: `user_id` is threaded through `GraphExecutionEntry`, `NodeExecutionEntry`, `execute_node`, credentials acquisition, credit tracking. Every DB query includes `user_id` in the WHERE clause.
- **Credentials are per-user encrypted blobs**: each user's `integrations` column contains only their credentials, Fernet-encrypted.
- **Per-user credit tracking** in Redis: `r.incr(f"uec:{user_id}")` -- execution counters keyed by user_id.
- **Per-user webhook ownership**: the `AgentWebhook` model has a `credentialsId` linking it to a specific user's credential, and a `userId` on the parent graph.
- **No cross-user data leakage guards** beyond the ORM: isolation relies on always passing `user_id` to queries. There's no row-level security layer. The comment `# sentry tracking nonsense to get user counts for blocks because isolation scopes don't work :(` reveals that even Sentry per-user attribution is duct-taped on.
- **Graph-level execution isolation**: each graph execution gets a `graph_exec_id`. Nodes within a graph share a `graph_exec_id` but are isolated from other users' graph executions by the thread pool.

**Key design insight for WorkRail Auto:**
- Multi-tenancy via `user_id` parameter threading is pragmatic but relies entirely on the dev always using it. WorkRail's hosted tier should do better -- per-tenant session stores (separate SQLite files or schema-per-tenant in PostgreSQL) eliminate the possibility of cross-tenant data leakage.
- AutoGPT has no WorkRail equivalent of HMAC-gated tokens -- there's nothing cryptographically preventing a user from querying another user's execution data if they bypass the application layer.

---

### Project 2: mcp-graph-workflow

**Repo:** `DiegoNogueiraDev/mcp-graph-workflow` -- 29 stars, TypeScript, MIT. Published as `@mcp-graph-workflow/mcp-graph` on npm. Updated as recently as 2026-04-14 (today).

**Description:** "MCP local-first CLI tool that converts PRD text files into persistent execution graphs (SQLite) for structured agentic workflows."

#### 1. What it does / Step sequencing

mcp-graph enforces a **9-phase lifecycle**: ANALYZE → DESIGN → PLAN → IMPLEMENT → VALIDATE → REVIEW → HANDOFF → DEPLOY → LISTENING.

Phase detection is **state-driven from the graph**, not token-gated. The engine reads task statuses from SQLite and infers the current phase:

```typescript
export function detectCurrentPhase(doc: GraphDocument, options?: PhaseDetectionOptions): LifecyclePhase {
  if (nodes.length === 0) return "ANALYZE";

  const inProgress = tasks.filter(n => n.status === "in_progress");
  if (inProgress.length > 0) return "IMPLEMENT";

  if (hasOnlyDesignNodes || tasks.length === 0) return "DESIGN";

  const doneTasks = tasks.filter(n => n.status === "done");
  if (doneTasks.length === tasks.length && tasks.length > 0) {
    if (hasNewFeedbackNodes(nodes, doneTasks)) return "LISTENING";
    if (options?.hasSnapshots) return "HANDOFF";
    return "REVIEW";
  }
  if (!hasSprints) return "PLAN";
  if (doneTasks.length >= tasks.length * 0.5) return "VALIDATE";
  return "IMPLEMENT";
}
```

Phase **gates** block invalid transitions via `PHASE_GATES`:

```typescript
const PHASE_GATES: Partial<Record<`${LifecyclePhase}_to_${LifecyclePhase}`, PhaseGateCheck>> = {
  PLAN_to_IMPLEMENT: (doc) => {
    const tasks = doc.nodes.filter(n => TASK_TYPES.has(n.type));
    const hasSprints = tasks.some(n => n.sprint != null);
    return {
      allowed: hasSprints,
      reason: hasSprints ? null : "Nenhuma task com sprint atribuído",
      unmetConditions: hasSprints ? [] : ["Atribuir sprint a pelo menos 1 task"],
    };
  },
  IMPLEMENT_to_VALIDATE: (doc) => {
    const report = checkValidationReadiness(doc);
    return { allowed: report.ready, ... };
  },
  // etc.
};
```

Every MCP tool response includes a `_lifecycle` block injected by the **Unified Gate** (`src/mcp/unified-gate.ts`):

```typescript
export function buildLifecycleBlock(doc: GraphDocument, options?: LifecycleBlockOptions): LifecycleBlock {
  const phase = detectCurrentPhase(doc, ...);
  const guidance = getPhaseGuidance(phase);
  return {
    phase,
    reminder: guidance.reminder,         // e.g. "IMPLEMENT: TDD Red→Green→Refactor"
    suggestedNext: guidance.suggestedTools,
    principles: guidance.principles,
    warnings: detectWarnings(doc, phase, options.toolName),
    nextAction: computeNextAction(doc, phase),
  };
}
```

The agent is never told "you cannot do this." Instead, every response tells the agent: "you're in IMPLEMENT phase, here's what to do next, here are the principles, here are warnings." It's **advisory, not blocking**.

**Task locking for `start_task`** (`src/core/store/lock-manager.ts`):

```typescript
export class LockManager {
  acquire(resourceId: string, agentId: string, ttlSeconds: number = 300): LockResult {
    this._cleanExpired(now);
    const existing = this.db.prepare("SELECT * FROM resource_locks WHERE resource_id = ?").get(resourceId);
    if (existing) {
      if (existing.agent_id !== agentId) throw new LockConflictError(...);
      // Same agent -- upgrade TTL + return new leaseToken
    } else {
      this.db.prepare(`INSERT INTO resource_locks (resource_id, resource_type, agent_id, lease_token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(...);
    }
    return { resourceId, agentId, leaseToken: randomUUID(), acquiredAt, expiresAt };
  }
}
```

`start_task` acquires an exclusive TTL-based lock on the task; `finish_task` verifies the `leaseToken`. In `teamTask` mode, multiple Claude Code terminals can work on the same graph without conflicting.

**The `start_task` → `finish_task` pipeline** (`src/mcp/tools/start-task.ts`):

```typescript
// start_task: all-in-one -- find next task + load RAG context + mark in_progress
const result = startTask(store, { nodeId, contextDetail, ragBudget, autoStart, agentId, lockManager });
return mcpText({
  node: result.task.task.node,
  tddHints: result.tddHints,
  context: result.context,
  ragContext: result.ragContext,
  leaseToken: result.leaseToken,  // needed to finish_task
});

// finish_task: DoD check + AC validation + mark done + next task
const result = finishTask(store, nodeId, { rationale, testFiles, agentId, leaseToken, lockManager });
return mcpText({
  dodReport: { score, grade, checks },  // 9 DoD checks
  blockers,
  nextTask,  // auto-returns next recommended task
});
```

#### 2. SQLite Persistence

**SQLite schema** (`src/core/store/sqlite-store.ts`):

Uses `better-sqlite3` (synchronous SQLite). Key tables:

- `projects` -- project metadata (id, name, fs_path)
- `nodes` -- graph nodes (tasks, requirements, milestones, etc.) with full state
- `edges` -- relationships between nodes (depends_on, blocks, parent_of, etc.)
- `snapshots` -- periodic graph snapshots for HANDOFF gate
- `knowledge_documents` -- RAG corpus
- `resource_locks` -- TTL-based agent task locks
- `tool_token_usage` -- token tracking per MCP tool call
- `session_chunks` -- context window tracking
- `event_queue` -- cross-terminal event propagation (v9.1 teamTask mode)

SQLite is synchronous, single-writer. The `better-sqlite3` library uses WAL mode for concurrent reads + single writer:

```typescript
export const STORE_DIR = ".mcp-graph";
export const DB_FILE = "graph.db";
// Stored at project root: .mcp-graph/graph.db
```

Compared to WorkRail's event log: mcp-graph uses a **mutable state model** (UPDATE nodes SET status = 'done'), while WorkRail uses an **append-only event log** (event sourcing). mcp-graph can query "current state" directly; WorkRail reconstructs state by replaying events.

#### 3. What mcp-graph does better / worse than WorkRail

**What mcp-graph does better:**

1. **Rich semantic graph model**: the graph structure (nodes, edges, types, relations) is genuinely useful for project planning. WorkRail's session is a linear step sequence. mcp-graph can answer "what's blocked by this task" or "show me the implementation graph for this epic" -- WorkRail can't.

2. **`_lifecycle.nextAction` in every response**: every tool response tells the agent exactly what to do next. WorkRail requires the agent to call `continue_workflow` which returns the next step. mcp-graph embeds guidance in every response, reducing round trips.

3. **Harness engineering score** (7 dimensions of AI-readiness): a measurable quality metric for the codebase that's embedded in the lifecycle guidance. WorkRail has no equivalent.

4. **RAG + knowledge store**: built-in semantic search over project context. WorkRail has no knowledge persistence across sessions beyond step notes.

5. **Multi-terminal task claiming with `leaseToken`**: explicit multi-agent support for parallelism. WorkRail's delegation is to subagents (same session), not parallel independent agents.

6. **Spec-driven development** (constitution + plugins + presets): governance layer that treats project rules as code. WorkRail has no equivalent.

7. **Zero LLM dependency**: all 45 tools are deterministic (SQL + heuristics). WorkRail's workflow steps are LLM-driven by design -- that's the point, but mcp-graph proves you can do a lot without LLM calls.

**What WorkRail does better:**

1. **Cryptographic step enforcement**: WorkRail's HMAC token protocol makes it impossible to skip steps -- an agent that attempts `continue_workflow` without completing step N will get a rejection. mcp-graph's phase guidance is advisory: the agent can call any tool at any time in any order. Nothing stops an agent from calling `finish_task` without calling `start_task`, or skipping from PLAN to DEPLOY.

2. **Durable session state across compaction**: WorkRail's append-only event log survives context window resets. Each step's notes are durable. mcp-graph's session state lives in the LLM's context -- once compacted, the guidance metadata is gone.

3. **Checkpoint/resume tokens**: WorkRail can cryptographically resume any session across chat restarts. mcp-graph has no equivalent -- each Claude Code session is independent.

4. **Workflow composition** (loops, conditionals, routines, templateCall): WorkRail has a full workflow DSL. mcp-graph has phases but no composable workflow format -- you can't author "if condition X, run routine Y."

5. **Execution trace + DAG visualization**: WorkRail's console shows the full execution graph with step status. mcp-graph has no session-level trace or visualization.

6. **Human-in-the-loop control**: WorkRail can pause at any step for confirmation. mcp-graph has no equivalent -- it's continuous guidance, not a gated protocol.

7. **Portability**: WorkRail works with any workflow, any codebase, any context. mcp-graph is tightly coupled to the 9-phase PRD-to-deploy lifecycle.

#### 4. What's worth taking from mcp-graph

**High value, take directly:**

1. **`_lifecycle.nextAction` embedded in every MCP response**: WorkRail's `continue_workflow` response already includes the next step content, but `nextAction` is a more structured artifact that WorkRail's console and autonomous daemon can parse. WorkRail should add a typed `nextAction` field to `continue_workflow` responses.

2. **`leaseToken` pattern for multi-agent parallelism**: WorkRail's routine delegation already uses subagents, but the explicit leaseToken + agentId pattern is cleaner for multi-terminal concurrent work. WorkRail's `checkpoint_workflow` token is the analog -- but an explicit "I own this step" token that can be passed between agents would enable coordinated parallel work.

3. **`detectCurrentPhase` from graph state**: WorkRail knows its current step from the session state. But the idea of inferring "where am I" from observable state (rather than requiring the agent to track it) is useful for WorkRail's daemon: the daemon can inspect the session's event log to determine current step without needing the agent to report it.

4. **`resource_locks` table pattern**: SQLite-backed TTL locks with `leaseToken`, `agentId`, `expiresAt`. WorkRail's `LocalSessionLockV2` uses PID-file locking; the SQLite lock table is more robust for multi-process scenarios (the daemon architecture). This is directly relevant to the `LocalSessionLockV2` workerId fix in the backlog.

5. **Harness engineering concept**: the idea of measuring "how AI-ready is this codebase" (7 dimensions, composite score) is a genuinely useful product feature for WorkRail. A `wr.harness-audit` workflow using WorkRail's existing evidence-gathering patterns would be a strong differentiator.

**Interesting but not to take directly:**

- The 9-phase lifecycle as a structure: WorkRail's generic workflow format is more powerful, but mcp-graph's opinionated lifecycle could inspire a bundled `wr.dev-lifecycle` workflow that mirrors the ANALYZE→DEPLOY cycle.
- The constitution/plugins/presets governance layer: interesting but too coupled to their specific project structure.
- The RAG pipeline: WorkRail's context-gathering routines serve a similar purpose. Structured knowledge persistence is worth exploring but isn't MVP.

---

## Problem Frame Packet

**Primary users/stakeholders:**
- WorkRail daemon designer (Etienne) -- needs to choose the right patterns before building
- Future WorkRail users who need autonomous workflow execution with audit guarantees
- Enterprise buyers who need multi-tenancy, credential vaulting, and audit trails

**Core tensions:**
- AutoGPT's advisory enforcement (credentials, phase guidance) vs WorkRail's cryptographic enforcement. WorkRail's model is stronger but higher friction. AutoGPT's model is more flexible but trust-dependent.
- mcp-graph's advisory lifecycle vs WorkRail's HMAC gates. Same tension.
- Single-user (self-hosted) simplicity vs multi-tenant (cloud) complexity. AutoGPT is already multi-tenant (Fernet per-user, Redis credit tracking). mcp-graph is single-user.

**Success criteria for this discovery:**
- Concrete decision: which AutoGPT patterns to adopt for WorkRail Auto's trigger system, credential system, and execution model.
- Concrete decision: what mcp-graph reveals about the competitive gap and what design moves are worth taking.

**What could make this framing wrong:**
- AutoGPT's patterns are built for a Python microservices architecture; WorkRail is TypeScript monolith. Some patterns don't translate directly.
- mcp-graph has 29 stars and may not be a reliable signal of what "the market" wants.

---

## Candidate Directions

*This is a landscape research exercise, not a design choice problem. The "candidate directions" are actionable synthesis decisions.*

### Direction A: Take AutoGPT patterns wholesale (maximal adoption)

- Adopt Fernet-encrypted per-user credential blob
- Adopt RabbitMQ-based execution queue
- Adopt Redis distributed locking (cluster-wide)
- Adopt `creds_manager.acquire()` injection at execution time

**Risk:** Over-engineering for a self-hosted daemon. RabbitMQ is a large dependency for what could be an in-process queue. Fernet + PostgreSQL is overkill for file-based self-hosted.

### Direction B: Adopt AutoGPT's design patterns, implement with simpler dependencies (recommended)

- Fernet encryption for credential storage: yes -- but stored in WorkRail's existing SQLite/file store, not PostgreSQL. ENCRYPTION_KEY from keychain.
- Redis locking: no for self-hosted (use the SQLite `resource_locks` pattern from mcp-graph); yes for cloud-hosted.
- RabbitMQ queue: no for self-hosted (use in-process queue or Redis Streams); yes for cloud-hosted.
- Credential injection pattern (acquire-at-execution, typed objects, always-release): **take directly** -- this is clean and implementation-independent.
- `BlockWebhookConfig` pattern: **take directly** -- trigger declaration is a clean three-layer design that WorkRail's trigger system should match.

### Direction C: Build WorkRail-native patterns from scratch

- Ignore AutoGPT and mcp-graph, design for WorkRail's specific needs.

**Risk:** Reinvents patterns that already work. The wheel-reinvention cost is real.

**Selected: Direction B.** AutoGPT has already solved the hard problems (credential encryption, injection, locking). The patterns are sound; adapt to WorkRail's stack.

---

## Challenge Notes

**Strongest argument against Direction B:**
AutoGPT's credential system is designed for a cloud multi-tenant platform with PostgreSQL + Redis + Supabase Auth. WorkRail's self-hosted daemon has none of these. Adapting "the patterns" while swapping all the infrastructure means the risk of incorrect port is high -- you might end up with something that looks like AutoGPT's patterns but behaves differently in edge cases.

**Counter:** The patterns that matter are (1) `SecretStr` type enforcement, (2) Fernet symmetric encryption, (3) acquire-at-execution credential injection, (4) distributed lock. None of these require specific infrastructure. (1) and (2) are pure libraries. (3) and (4) can be implemented with SQLite and the `resource_locks` table. The WorkRail daemon needs all four regardless of whether it's self-hosted or cloud-hosted.

**Does mcp-graph falsify the "WorkRail is unique" claim?**
Partially. mcp-graph has lifecycle enforcement (advisory), SQLite persistence, and TypeScript MCP implementation -- all WorkRail features. But the gap is real: mcp-graph cannot prevent step skipping, has no HMAC protocol, no checkpoint/resume tokens, and no workflow DSL. WorkRail's enforcement guarantee remains genuinely differentiated. mcp-graph occupies the "left half" of the quadrant -- durable but prompt-enforced, not structurally enforced.

---

## Resolution Notes

**Resolution mode: `direct_recommendation`** -- confidence is sufficient from the landscape research.

---

## Decision Log

1. **Path: landscape_first** -- correct. The goal was external grounding, not internal design ambiguity.
2. **mcp-graph is `mcp-graph-workflow`** (DiegoNogueiraDev/mcp-graph-workflow), not `mcp-graph`. 29 stars, active development (updated today). More ambitious than expected.
3. **AutoGPT credential encryption**: Fernet symmetric encryption, single blob per user, stored in DB. Not per-field encryption. Simple and clean.
4. **AutoGPT execution concurrency**: ThreadPoolExecutor + RabbitMQ + Redis distributed locks. This is the right pattern for cloud-scale but overkill for self-hosted.
5. **mcp-graph enforcement gap**: advisory, not cryptographic. Every response includes `_lifecycle` guidance but nothing prevents skipping. WorkRail's HMAC enforcement is genuinely superior.
6. **mcp-graph's `resource_locks` table**: this is the right model for WorkRail's `LocalSessionLockV2` upgrade (workerId + SQLite persistence replaces PID-file approach for multi-process scenarios).
7. **mcp-graph's `leaseToken`**: directly applicable to WorkRail's multi-agent delegation. The `start_task` leaseToken + `finish_task` verification pattern should inform WorkRail's subagent task claiming.

---

## Final Summary

### Selected Path: landscape_first
### Problem Framing: "What patterns from AutoGPT and mcp-graph should WorkRail Auto adopt?"

### Chosen Direction: Adopt design patterns, adapt to WorkRail's stack (Direction B)

**AutoGPT -- 4 patterns to take:**

1. **Trigger declaration pattern** (`BlockWebhookConfig`): three-layer design (trigger block declares schema + webhook_config; WebhooksManager handles registration + validation; payload flows in as hidden input). WorkRail's `src/trigger/` should mirror: `TriggerDeclaration` (schema + webhook_config) + `TriggerManager` (register + validate) + context injection.

2. **Fernet credential encryption** (`JSONCryptor`): symmetric encryption of per-user credential blobs. WorkRail keyring already exists; extend it with a `CredentialStore` that Fernet-encrypts per-org/per-user credential JSON. Simple 40-line implementation. Key from WorkRail keychain.

3. **Acquire-at-execution credential injection** (`creds_manager.acquire()`): credentials fetched just before step execution, injected as typed objects, held under lock for duration, always released in `finally`. WorkRail daemon's step runner should follow this exactly: acquire creds for the step's declared credential inputs before calling the LLM, release after step completes.

4. **Thread-local ExecutionProcessor per worker**: for cloud-hosted WorkRail with concurrent daemon sessions, thread-local session processors avoid shared mutable state. Self-hosted can use single-process with the existing `KeyedAsyncQueue` pattern.

**mcp-graph -- 4 patterns to take:**

1. **`resource_locks` SQLite table** (leaseToken + agentId + TTL): upgrade `LocalSessionLockV2` from PID-file to SQLite lock table. Add `workerId` (from the backlog fix) and `leaseToken`. Enables multi-process daemon + MCP server coexistence without the PID-collision bug.

2. **`leaseToken` for multi-agent task claiming**: when WorkRail's daemon spawns a subagent for a delegated step, the subagent receives a `leaseToken` proving it owns that step. The coordinator verifies the token before accepting the subagent's output. Tighter than the current "subagent just reports back" model.

3. **Embedded `nextAction` in tool responses**: add a typed `nextAction` field to `continue_workflow` responses. Currently the next step content IS the next action, but a structured `nextAction` would let the console and daemon parse it without re-reading the step content.

4. **`_lifecycle` advisory guidance independent of enforcement**: mcp-graph's approach of providing rich advisory guidance (current phase, suggested tools, principles, warnings) without blocking is complementary to WorkRail's enforcement. WorkRail should do both: HMAC-gate enforcement + rich advisory guidance in the step prompt.

### Why the winner won

Direction B (adopt patterns, adapt stack) beats A (wholesale adoption) because WorkRail's self-hosted use case requires SQLite + file-based, not Redis + PostgreSQL + RabbitMQ. It beats C (build from scratch) because AutoGPT has already proven these patterns in production at scale.

### Strongest alternative (Direction C -- build from scratch)

Direction C would be justified if: AutoGPT's patterns are so coupled to Python/PostgreSQL that TypeScript ports are error-prone; or if WorkRail's enforcement model (HMAC token) creates fundamentally different requirements from AutoGPT's advisory model. The counter is that the specific patterns selected (Fernet encryption, credential injection, lock table, leaseToken) are infrastructure-independent.

### Confidence band: HIGH

Both codebases were read directly (not summarized). The patterns are concrete and well-evidenced. The main uncertainty is whether AutoGPT's credential injection pattern (acquire lock → inject as kwargs → release in finally) translates cleanly to WorkRail's TypeScript step runner. The pattern is sound but the implementation port carries medium risk.

### Residual risks:

1. **Fernet key management for self-hosted**: where does the encryption key live? WorkRail's keychain is the right answer but needs to be designed (key rotation, initial setup). Medium risk.
2. **RabbitMQ vs in-process queue for self-hosted**: cloud WorkRail should use a real message queue (Redis Streams or RabbitMQ). Self-hosted should use in-process. The design needs a pluggable transport layer from day one, not bolted on after.
3. **mcp-graph's phase detection from graph state**: the idea of inferring current state from observable graph facts is clean, but WorkRail's event log already captures all state. The daemon can read the event log directly -- no need to add a parallel state-inference layer.

### Next actions:

1. **Implement `LocalSessionLockV2` upgrade** with workerId (already in backlog, now has concrete model from mcp-graph's `resource_locks` table)
2. **Design `CredentialStore`**: Fernet-encrypted per-user/per-org credential blob in WorkRail's SQLite store. 40 lines. Dependency: decide on ENCRYPTION_KEY source (keychain entry, env var, or both).
3. **Design trigger declaration schema**: model `TriggerDeclaration` after AutoGPT's `BlockWebhookConfig`. Define `resource_format`, `event_filter_schema`, `event_format`. Separate auto-register from manual.
4. **Add `leaseToken` to subagent delegation**: when coordinator spawns subagent via `mcp__nested-subagent__Task`, pass a leaseToken. Subagent includes it in `continue_workflow` context. Engine validates ownership.

### Design doc location: `/Users/etienneb/git/personal/workrail/docs/ideas/discovery-autogpt-mcpgraph.md`
