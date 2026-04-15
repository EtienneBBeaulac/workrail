# LangGraph Deep Dive: Discovery Notes for WorkRail Auto

**Date:** Apr 14, 2026
**Source:** `https://github.com/langchain-ai/langgraph` (Python + JS, 12k+ stars)
**Scope:** Five areas directly relevant to WorkRail Auto's autonomous platform design.

---

## 1. Persistence and Checkpointing Model

### How it works

LangGraph's persistence is built around a `BaseCheckpointSaver` abstract class. The concrete implementations are `InMemorySaver`, `AsyncPostgresSaver` (checkpoint-postgres), and `AsyncSqliteSaver` (checkpoint-sqlite). The saver is passed at graph compile time via `graph.compile(checkpointer=...)`.

The core data structure is `Checkpoint` (a TypedDict):

```python
class Checkpoint(TypedDict):
    v: int                           # schema version, currently 1
    id: str                          # monotonically increasing UUID6 - sortable
    ts: str                          # ISO 8601 timestamp
    channel_values: dict[str, Any]   # full state snapshot per channel
    channel_versions: ChannelVersions  # monotonic version string per channel
    versions_seen: dict[str, ChannelVersions]  # per-node: which versions it's seen
    updated_channels: list[str] | None  # channels updated in this checkpoint
```

Every checkpoint is wrapped in a `CheckpointTuple` that bundles it with config, metadata, parent config reference, and pending writes:

```python
class CheckpointTuple(NamedTuple):
    config: RunnableConfig          # includes thread_id, checkpoint_id, checkpoint_ns
    checkpoint: Checkpoint
    metadata: CheckpointMetadata    # source, step number, parent IDs, run_id
    parent_config: RunnableConfig | None
    pending_writes: list[PendingWrite] | None
```

The `thread_id` is the primary isolation key -- it lives inside `config["configurable"]["thread_id"]` and is the join key for all checkpoint lookups. It is **user-supplied**, not system-generated, which is the key multi-tenancy seam (the caller is responsible for making thread IDs unique per user/org).

Checkpoints are **always full state snapshots**, not diffs. Every superstep produces a new checkpoint via `_put_checkpoint()`. The `versions_seen` map tracks which channels each node has processed, enabling the engine to determine exactly which nodes to trigger next on resume.

The `CheckpointMetadata.source` field distinguishes how a checkpoint was created:
- `"input"` -- from initial invocation
- `"loop"` -- end of a normal superstep
- `"update"` -- from a manual `update_state()` call
- `"fork"` -- from a time-travel fork

Resumption requires a checkpointer **and** passing the same `thread_id` back. LangGraph infers resumption from the input: `None` input = resume after interrupt, `Command(resume=...)` input = resume with human value, same `run_id` = reconnect to ongoing run.

### Durability modes

LangGraph 0.6+ added a `Durability` enum (`"sync"`, `"async"`, `"exit"`):
- `"sync"`: checkpoint written before next step starts (safest, slowest)
- `"async"`: checkpoint written while next step executes (default)
- `"exit"`: checkpoint written only at graph exit (highest throughput, weakest durability)

### Serialization

The serde layer (`langgraph/checkpoint/serde/`) handles serialization. Default is `JsonPlusSerializer` (JSON with type annotations for non-standard types). There is also a `MsgpackSerializer` and an `EncryptedSerializer` wrapper for at-rest encryption of checkpoint data.

### Comparison to WorkRail

| Dimension | LangGraph | WorkRail |
|-----------|-----------|---------|
| Checkpoint format | Full state snapshot per superstep | Append-only event log, not snapshots |
| Resume mechanism | `thread_id` + same config | HMAC-signed `continueToken` / `checkpointToken` |
| Enforcement | None -- checkpointer stores state but doesn't enforce steps | HMAC token gates every advance -- token is cryptographically bound to session + step |
| Portability | Thread IDs must be managed by the caller | Token is self-describing and portable |
| Time travel | Yes -- re-invoke with an older `checkpoint_id` | Not supported yet |
| Storage backends | In-memory, Postgres, SQLite, Redis (cache) | Single disk-persisted append-only log |
| Schema versioning | `checkpoint["v"]` field for format version | `workrailVersion` in workflow schema (planned) |

**Key insight:** LangGraph's checkpoint is a full state snapshot that enables bidirectional time travel. WorkRail's event log is forward-only but is a better audit trail. For WorkRail Auto's long-running autonomous sessions, time travel (rewinding to a checkpoint before a bad tool call) could be extremely valuable. This maps to the "workflow rewind" backlog idea -- the event log already has everything needed; what's missing is the ability to `fork` from an earlier point.

**Actionable:** LangGraph's `CheckpointMetadata.source = "fork"` + the ability to re-invoke with an older `checkpoint_id` is the exact mechanism needed for WorkRail's workflow rewind feature. The implementation pattern is: store the `checkpointToken` at each step (WorkRail already does this in daemon state), allow the console to select an earlier step, and resume from it. The event log becomes a fork tree, not a linear sequence.

---

## 2. The `interrupt()` Mechanism (Human-in-the-Loop)

### How it works

LangGraph's `interrupt()` is a regular Python function that a node calls mid-execution. The mechanism has two layers:

**Layer 1 -- the `interrupt()` call site:**

```python
def interrupt(value: Any) -> Any:
    conf = get_config()["configurable"]
    scratchpad = conf[CONFIG_KEY_SCRATCHPAD]
    idx = scratchpad.interrupt_counter()
    # If we already have a resume value for this index, return it directly
    if scratchpad.resume:
        if idx < len(scratchpad.resume):
            conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
            return scratchpad.resume[idx]
    # No resume value - raise GraphInterrupt to halt execution
    raise GraphInterrupt(
        (Interrupt.from_ns(value=value, ns=conf[CONFIG_KEY_CHECKPOINT_NS]),)
    )
```

On first call: raises `GraphInterrupt` exception, which bubbles up through the pregel loop, halting the superstep. The interrupt value is stored as a `PendingWrite` in the checkpoint with type `INTERRUPT`.

On resume: the caller passes `Command(resume=<value>)` as input. The `scratchpad.resume` list is pre-populated with the resume value. When `interrupt()` executes again (the node re-runs from the start), it finds the existing resume value at index `idx` and returns it immediately instead of raising.

**Key design decision:** The node re-executes from its beginning. All code before `interrupt()` runs again. This is by design -- LangGraph's nodes are expected to be idempotent up to the interrupt point.

**Layer 2 -- the pregel loop:**

In `PregelLoop.tick()`:
```python
# interrupt_before and interrupt_after are node name lists
if self.interrupt_before and should_interrupt(
    self.checkpoint, self.interrupt_before, self.tasks.values()
):
    self.status = "interrupt_before"
    raise GraphInterrupt()
```

There are two interrupt styles:
1. **Declarative interrupts** (`interrupt_before`/`interrupt_after` at compile time): halt before/after specific named nodes. Used for approval workflows where you want to pause before a specific node regardless of its internal logic.
2. **Programmatic interrupts** (`interrupt()` function inside a node): halt from within arbitrary node logic. Used for dynamic human-input needs.

**Multiple interrupts in one node:** LangGraph supports multiple `interrupt()` calls within a single node. Resume values are matched by order. If there are 3 `interrupt()` calls and the user resumes with `Command(resume={"<interrupt_id>": value})`, LangGraph matches by interrupt ID (an xxh3 hash of the checkpoint namespace).

**Status values the loop emits:**
- `"interrupt_before"` -- paused before a node
- `"interrupt_after"` -- paused after a node
- `"done"` -- completed
- `"out_of_steps"` -- hit step limit
- `"input"` / `"pending"` -- normal execution states

### `Command` type for resume

```python
Command(
    resume="human approval value",  # resume value
    # OR for multiple simultaneous interrupts:
    resume={"<interrupt_id_hash>": "value1", "<interrupt_id_hash>": "value2"}
)
```

The `Command` type can also carry `goto` (send to a specific node) and `update` (mutate state directly), making it a general-purpose control primitive for human-in-the-loop interactions.

### Comparison to WorkRail

| Dimension | LangGraph | WorkRail |
|-----------|-----------|---------|
| Pause mechanism | `interrupt()` raises exception, stored as PendingWrite | Step with `notesRequired: true`, token not issued until notes provided |
| Resume mechanism | Re-invoke graph with `Command(resume=...)` + same thread_id | Call `continue_workflow` with valid `continueToken` |
| Enforcement | Prompt-based: LangGraph can't prevent the node from being called without human input if the caller chooses to skip | Token-gated: `continue_workflow` won't advance without a valid token |
| Node re-execution on resume | Yes - node runs from start, `interrupt()` returns cached value | No - step advances to next step, no re-execution |
| Multiple interrupts per step | Yes - tracked by index in scratchpad | No - one gate per step |

**Key insight for WorkRail Auto:** LangGraph's `interrupt_before`/`interrupt_after` pattern is exactly what WorkRail needs for its approval-gate design in the autonomous daemon. A workflow step with `requiresApproval: true` should work like LangGraph's `interrupt_after` -- the daemon runs the step, then pauses and waits for console approval before advancing.

**The critical difference:** LangGraph's interrupt is prompt-based enforcement. The graph stores the interrupt state in the checkpoint, but nothing prevents a caller from supplying a synthetic `Command(resume="approved")` without any human ever seeing it. WorkRail's token protocol is structural enforcement -- the `continueToken` for the approval step can only be issued by a human action in the console, not synthesized by the daemon itself.

**Actionable design for WorkRail Auto's approval gate:**

```typescript
// Daemon sees step with requiresApproval: true
// 1. Execute the step normally
// 2. Write step notes and request a "approval_token" instead of continueToken
// 3. REST endpoint: POST /api/v2/sessions/:id/approve
//    - Validates human auth (console session token)
//    - Emits "approved" event to session
//    - Daemon's approval_wait channel receives the event
//    - Daemon calls continue_workflow with the now-available continueToken
```

This is architecturally cleaner than LangGraph's `interrupt()` because the approval requirement is declared in the workflow schema, not scattered across node implementations.

---

## 3. Streaming Model

### LangGraph's streaming design

LangGraph has seven stream modes, each serving a different consumer:

| Mode | What it emits | When |
|------|--------------|------|
| `"values"` | Full state snapshot | After every superstep (including interrupts) |
| `"updates"` | `{node_name: updates_dict}` | After each node completes within a superstep |
| `"messages"` | `(token, metadata)` tuples | Token-by-token as LLM generates |
| `"custom"` | Any value via `StreamWriter` | When node explicitly calls `stream_writer(data)` |
| `"checkpoints"` | Full `StateSnapshot` | When checkpoint is saved |
| `"tasks"` | `TaskPayload` / `TaskResultPayload` | Task start and finish |
| `"debug"` | Same as checkpoints + tasks | Combined, for debugging |

Multiple modes can be requested simultaneously -- the output becomes `(mode, data)` tuples.

**Transport layer:** `stream()` uses a `SyncQueue` internally. The pregel loop's `_emit()` method writes to this queue. The outer `stream()` function yields from it. For async, there is `astream()` with an `AsyncQueue`.

**Subgraph streaming:** Controlled by `subgraphs=True`. When enabled, stream chunks become `(namespace_tuple, data)` where `namespace_tuple` traces the path to the nested subgraph. This allows a console to show streaming events from deeply nested subgraphs.

**Messages mode detail:** Uses a `StreamMessagesHandler` that hooks into LangChain's callback system. When any LLM inside any node generates tokens, those tokens are captured and emitted on the stream. The metadata includes the run ID, tags, and the node name. This enables streaming LLM output even when the graph doesn't explicitly yield it.

**Custom mode:** Any node can call `stream_writer(data)` to push arbitrary data to the stream. This is the "fire and forget" progress reporting pattern.

**The `StreamChunk` type:** Every event on the stream is a `(namespace_tuple, mode_string, data)` triple. The namespace identifies which graph/subgraph the event originated from.

**Durability and streaming interaction:** The `durability` parameter affects when checkpoints (and thus `"checkpoints"` stream events) are written. `"async"` durability means checkpoint events may arrive slightly after the `"updates"` event for the same step.

### What WorkRail Auto needs

WorkRail Auto's console live view needs three things:
1. **Step-level progress**: which step is currently executing (maps to LangGraph's `"tasks"` mode -- `TaskPayload.name`)
2. **LLM token streaming**: token-by-token for steps with LLM calls (maps to `"messages"` mode)
3. **Tool call visibility**: which tools are being called with what arguments (maps to `"tasks"` + `"debug"` modes -- `TaskResultPayload.result` contains tool write results)

**LangGraph's streaming architecture for WorkRail:**

The `_emit()` internal method pattern is worth copying directly:

```typescript
// WorkRail daemon equivalent
function emitStepEvent(mode: 'step_start' | 'step_end' | 'token' | 'tool_call', data: any) {
    // Writes to: (a) daemon registry for console SSE, (b) session event log
    daemonRegistry.broadcast(sessionId, { mode, data });
    sessionStore.appendEvent(sessionId, { type: 'stream_event', mode, data });
}
```

The key architectural insight: LangGraph separates the _emission mechanism_ (writing to a queue) from the _delivery mechanism_ (who consumes the queue). WorkRail's daemon should do the same -- pi-mono's `agent.subscribe()` provides the emission hook; the daemon broadcasts to the `DaemonRegistry` (for console SSE) as a side effect.

**Actionable:** pi-mono's `agent.subscribe()` is the direct equivalent of LangGraph's `StreamMessagesHandler`. The `AgentEvent` stream already contains token events and tool call events. WorkRail's daemon can subscribe to this stream and:
1. Forward token events to console via SSE
2. Record tool call events as evidence in the session store
3. Advance a step-progress indicator in the console

---

## 4. Subgraph and Parallel Execution

### How parallel execution works

LangGraph's parallel execution is built into the Pregel superstep model. In a single `tick()`, `prepare_next_tasks()` returns **all tasks that are ready to execute simultaneously**. These tasks are all dispatched at once to `BackgroundExecutor` (thread pool for sync) or `AsyncBackgroundExecutor` (asyncio tasks for async).

The task preparation logic in `_algo.py`:
1. Consumes "PUSH" tasks first -- these are `Send` objects (explicit messages to nodes)
2. Evaluates "PULL" triggers -- nodes whose input channels have new versions they haven't seen

A node runs in parallel with other nodes automatically if they don't share a dependency (no shared trigger channel). There is no explicit parallelism declaration -- it emerges from the graph topology.

**The `Send` primitive:** `Send(node="some_node", arg={...})` allows a node to explicitly dispatch work to another node with custom state. Multiple `Send`s to the same or different nodes in one step creates fan-out parallelism. The results are collected before the next superstep.

**Subgraphs:** A subgraph is a compiled `StateGraph` assigned as the value of a node. It has its own checkpoint namespace (appended to parent namespace with `NS_SEP`), optionally its own checkpointer (can be `True` for inherited, `False` for none, or a specific saver). The subgraph streams events back to the parent via `DuplexStream` when `subgraphs=True`.

**The `_executor.py` pattern:** `BackgroundExecutor` uses Python's `concurrent.futures.ThreadPoolExecutor` (via LangChain's `get_executor_for_config`). The `max_concurrency` config field sets the semaphore limit for async execution. Every submitted task is wrapped with `copy_context()` to preserve Python context vars across threads.

### WorkRail's approach

WorkRail already supports subagent delegation via `mcp__nested-subagent__Task`. In autonomous mode, the daemon uses pi-mono's `Agent` class. The parallel/subgraph question is: how do multiple concurrent autonomous sessions coordinate?

**LangGraph's approach:** Parallelism within a single graph execution is synchronous (within one `invoke()`/`stream()` call). The parent graph controls all subgraph execution directly.

**WorkRail's approach (from backlog):** Coordinator session holds the main workflow; subagent sessions are separate daemon invocations. Coordination happens via the session store, not in-context.

**Key difference:** LangGraph's parallel nodes share the same checkpoint and state. WorkRail's subagent sessions have isolated session stores that report back. LangGraph's model is tighter coupling; WorkRail's is more resilient (a failed subagent doesn't kill the coordinator).

**What WorkRail can adopt from LangGraph:**

1. **The `Send` primitive as a WorkRail concept:** A step could produce a "dispatch" artifact `{ kind: "wr.dispatch", targets: [{ workflowId, context }] }` that causes the daemon to spawn parallel sub-sessions. The coordinator waits for all dispatched sessions to complete (via session store polling) before the next step.

2. **Namespace hierarchy for subgraph state:** LangGraph's checkpoint namespace (`parent_graph:task_id/child_graph:task_id`) is an elegant way to partition related state. WorkRail's session IDs for subagent runs could follow the same pattern: `parent_session_id/sub_session_id`.

3. **Fan-out + fan-in pattern:** LangGraph's `Send` fan-out followed by a reducing node is directly applicable to WorkRail's multi-repo parallel execution vision. The workspace manifest declares which repos to act on; the daemon fans out to per-repo sub-sessions; a synthesis step reduces results.

**Concurrency model difference:** LangGraph nodes within a superstep run in threads (sync) or asyncio tasks (async). WorkRail sub-sessions are separate daemon invocations with their own LLM context. LangGraph's model is lower overhead; WorkRail's is more fault-tolerant and better for long-running (minutes-to-hours) parallel tasks.

---

## 5. LangGraph Platform (Cloud)

### The deployment model

LangGraph Platform is a hosted service built on top of the open-source engine. The architecture centers on three entities:

**Assistants** -- a versioned snapshot of a compiled graph with its configuration. Think of an assistant as "a deployment of a graph with a specific set of settings." Multiple assistants can point to the same graph ID with different configs. The `assistant_id` is the primary routing key.

**Threads** -- persistent conversation contexts. A thread maintains state across multiple runs. Threads have a `status` (`idle`, `busy`, `interrupted`, `error`) and are scoped per-assistant per-user via metadata.

**Runs** -- individual executions within a thread. A run = one call to `invoke()` or `stream()`. Runs have statuses (`pending`, `error`, `success`, `timeout`, `interrupted`).

There is also a **Cron** entity for scheduled execution -- `user_id` + `assistant_id` + `schedule` + metadata.

### Multi-tenancy model

LangGraph Platform's multi-tenancy is **metadata-based**, not schema-based. There is no per-tenant database or schema isolation. Instead:

1. **Authentication:** Custom `Auth` class via `langgraph.json -> auth.path`. The authenticator inspects the HTTP request (headers, token) and returns a `MinimalUserDict` with `identity` and `permissions`.

2. **Authorization via filter injection:** Authorization handlers (`@auth.on.threads`, `@auth.on.runs`, etc.) return a `FilterType` dict that is injected as a query filter for database reads:
   ```python
   @auth.on.threads.read
   async def scope_threads(ctx: AuthContext, value: Any) -> FilterType:
       return {"owner": ctx.user.identity}
   ```
   This filter `{"owner": ctx.user.identity}` is appended to every thread query for this user. The `owner` field is stored in thread `metadata`. Users can only see threads where `metadata.owner` matches their identity.

3. **Store namespace scoping:** For the long-term memory store, authorization handlers rewrite the `namespace` tuple to prepend the user's identity:
   ```python
   @auth.on.store
   async def scope_store(ctx: AuthContext, value: Any):
       namespace = tuple(value.get("namespace") or ())
       value["namespace"] = (ctx.user.identity, *namespace)
   ```
   This provides namespace-level isolation without DB-level isolation.

4. **No org-level isolation out of the box:** Multi-org isolation requires the auth handler to inject an org-level filter. The platform doesn't have a built-in "organization" concept -- it's all done through metadata filters.

**The `MiddlewareOrders` enum** (`"auth_first"` vs `"middleware_first"`) controls whether the custom auth logic runs before or after LangGraph's own middleware. This affects where rate limiting and other cross-cutting concerns apply relative to the auth check.

**TTL configuration:** Threads have a `ThreadTTLConfig` with `strategy` (`"delete"` or `"keep_latest"`), `default_ttl` (minutes), and `sweep_interval_minutes`. This is infrastructure-level resource management for cloud deployments.

### The RemoteGraph client

`RemoteGraph` in `pregel/remote.py` implements the full `PregelProtocol` interface (same interface as a local graph) but makes HTTP calls to the LangGraph Platform API. This means a subgraph can be a remote deployment, and the caller's code is identical to calling a local graph. The `assistant_id` field maps to the graph name deployed on the platform.

This pattern -- a client that implements the same interface as the server-side graph -- is directly relevant to WorkRail's cloud vision. `RemoteGraph` is LangGraph's "thin client" that lets you compose local and remote graphs transparently.

### Comparison to WorkRail Auto cloud vision

| Dimension | LangGraph Platform | WorkRail Auto (vision) |
|-----------|-------------------|------------------------|
| Isolation model | Metadata-filter-based (soft isolation) | Event log per session, per-org credential vaults |
| Auth | Custom `Auth` class per deployment | Per-org credential vault + Anthropic API key injection |
| Thread identity | User-supplied `thread_id` | WorkRail `sessionId` (system-generated, HMAC-bound) |
| Tenant isolation | No hard DB-level isolation | Needs design - opportunity to do it better |
| Cron scheduling | First-class `Cron` entity | Planned trigger system (`src/trigger/`) |
| Self-hosted parity | `langgraph dev` runs same server locally | `workrail daemon` = same engine as cloud |
| Audit trail | LangSmith integration (external) | Built-in session event log |

**Key finding:** LangGraph Platform's metadata-filter isolation is elegant but soft. If an auth handler has a bug, users can see each other's data. WorkRail's opportunity is to provide **structural isolation** -- per-org database schemas or separate storage roots at the infrastructure level.

For WorkRail Auto's cloud vision, the recommended approach (building on the competitive analysis):
- Each org gets a separate storage root: `~/.workrail/orgs/<org_id>/sessions/`
- Credential vaults are per-org, never cross-injected
- Session IDs include an org prefix: `sess_<org_id>_<uuid>`
- The `workerId` (from the lock design) includes org context: `daemon-<org_id>`

This is stronger than LangGraph's metadata filters and more aligned with what enterprise buyers expect for data sovereignty.

---

## Summary: What WorkRail Should Adopt vs. Reject

### Adopt (high confidence)

1. **Durability modes** -- LangGraph's `sync/async/exit` durability is a clean API for the daemon's checkpointing tradeoffs. WorkRail daemon's `runWorkflow()` should expose a similar parameter.

2. **`TaskPayload` + `TaskResultPayload` streaming types** -- The tuple `(namespace, mode, data)` as the universal stream chunk is clean and should be WorkRail's console SSE event format.

3. **`interrupt_before`/`interrupt_after` as workflow-level declarations** -- Declaring approval gates in the workflow schema (not scattered in node logic) is better than LangGraph's approach for WorkRail's use case. WorkRail's `requiresApproval` step field is the right direction.

4. **Assistant/Thread/Run entity hierarchy** -- For WorkRail Auto cloud: `Workflow` (like Assistant) + `Session` (like Thread) + `Run` (like Run) is a natural hierarchy. A session accumulates state across multiple runs of a workflow.

5. **Namespace-scoped subgraph checkpoints** -- `parent_session_id/sub_session_id` as the session hierarchy for subagent delegation. Already implied by the backlog design but this confirms the pattern.

6. **`FilterType` for auth** -- LangGraph's metadata-filter authorization pattern is worth implementing, but WorkRail should add structural isolation on top (separate storage roots per org).

### Reject or improve on

1. **Full-state snapshots on every superstep** -- LangGraph checkpoints the entire state graph on every step. WorkRail's append-only event log is strictly better for audit trails and more storage-efficient for long-running sessions. No change needed.

2. **Prompt-based interrupt enforcement** -- `interrupt()` can be bypassed by a caller passing `Command(resume=...)` without human action. WorkRail's HMAC token is the better primitive -- keep it.

3. **Thread-pool parallelism for nodes** -- LangGraph runs parallel nodes in threads. For WorkRail's autonomous sessions (minutes-to-hours per step), process-level or asyncio-level parallelism is more appropriate. The sub-session delegation model is better.

4. **`thread_id` as caller-managed identity** -- LangGraph puts the caller in charge of thread IDs, creating a namespace pollution risk. WorkRail's system-generated session IDs with HMAC binding are more correct.

5. **No built-in org isolation** -- LangGraph Platform's metadata-filter-only isolation is insufficient for enterprise deployments. WorkRail should design structural per-org isolation from the start.

### Gaps LangGraph has that WorkRail doesn't yet

1. **Time-travel (fork from checkpoint)** -- LangGraph can re-invoke with any historical `checkpoint_id` to explore alternate paths. WorkRail needs this for the workflow rewind feature.

2. **`Cron` scheduling primitive** -- LangGraph Platform has first-class cron jobs. WorkRail's trigger system needs this.

3. **`RemoteGraph` (local-remote parity)** -- A WorkRail client that implements the same interface as the daemon locally would let users develop locally and deploy to cloud without code changes. High value for the cloud roadmap.

4. **`interrupt()` with multiple resumable values per step** -- WorkRail only has one gate per step. LangGraph supports multiple ordered `interrupt()` calls per node. For complex approval workflows, this would be useful.

---

## Positioning Anchor (confirmed)

The backlog's competitive map is accurate:

```
                   ENFORCEMENT STRENGTH
                   Weak (Prompt)         Strong (Structural)
                ┌─────────────────────┬──────────────────────────┐
          Yes   │  LangGraph+LangSmith │  WorkRail ← HERE         │
DURABLE         │  nexus-core          │  Temporal.io (not MCP)   │
STATE           ├─────────────────────┼──────────────────────────┤
          No    │  CLAUDE.md files     │  CrewAI, AutoGen         │
                │  maestro, ADbS       │  LangGraph (standalone)  │
                └─────────────────────┴──────────────────────────┘
```

LangGraph (with LangSmith) occupies the top-left: durable state, prompt-based enforcement. WorkRail is top-right: durable state, structural (cryptographic) enforcement.

The moat to protect: if LangGraph adds an MCP server interface (making it MCP-native), and adds a structural enforcement primitive (HMAC token equivalent), WorkRail's differentiation shrinks. Current watch condition: LangGraph's `interrupt()` mechanism is increasingly capable (multiple interrupts, Command-based resume, ID-addressed resume). The gap is real today but not permanent.

**WorkRail's counter-move:** JSON-authored workflows (not code-defined graphs), cryptographic token protocol, and the upcoming evidence gate (`requiredEvidence` + `record_evidence`) are the irreducible differentiators. A LangGraph graph cannot declare "this step requires the agent to have actually called `git push` before advancing" in the graph definition itself. WorkRail can.
