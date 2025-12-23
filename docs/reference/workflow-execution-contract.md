# Workflow Execution Contract (Token-Based)

This document describes the proposed “token-based” workflow execution tools intended to be **agent-first**, **rewind/fork safe**, and **idempotent**.

Decision record: `docs/adrs/005-agent-first-workflow-execution-tokens.md`

## Normative vs illustrative (how to read this doc)
Sections explicitly labeled **(normative)** define binding protocol semantics. Examples and appendices are illustrative and must not be treated as authoritative when they conflict with normative sections or the code-canonical schemas referenced by v2 locks.

## Recorded decisions (from design discussions)

- **Text rendering template versioning (internal-only)**: we may version the deterministic `text` template for testing and export stability, but we do **not** expose the template version to the agent as part of the MCP contract.
- **Text-first scope**: “text-first + JSON backbone” is **required for execution outputs** (e.g., `start_workflow`, `continue_workflow`, and `checkpoint_workflow` when present). It is optional for discovery/inspection tools (`list_workflows`, `inspect_workflow`).
- **AC/REJECT usage**: the detailed acceptance criteria and rejection triggers are treated as **non-normative guardrails** (test targets / design constraints). The contract remains defined by the normative sections in this document.

## MCP platform constraints

This contract is shaped by constraints of the stdio MCP environment (no server push, no transcript access, lossy agents, etc.). The full list is recorded in:

- `docs/reference/mcp-platform-constraints.md`

## Shared locks (authoritative references)

To prevent drift between MCP/CLI/Studio and keep error handling deterministic:

- **Unified error envelope** (including the closed-set `retry` union): `docs/design/v2-core-design-locks.md` (Section 12)
- **Corruption/salvage gating** (including `SessionHealth` and execution-vs-read-only tool gating): `docs/design/v2-core-design-locks.md` (Operational envelope: Corruption handling)

## Goals

- Provide a minimal, primitives-only MCP contract that agents can use reliably.
- Support rewinds/forks/parallel runs naturally (chat UIs are not monotonic).
- Keep the workflow engine internal; avoid leaking execution internals to clients.
- Treat errors as data (structured error payloads; no throwing across boundaries).
- Preserve high-signal progress even when work happens outside a workflow step loop (rewinds can delete chat context without warning).

## Error handling (normative)

- Tool handlers MUST return errors as data using the unified error envelope shape (see v2 locks).
- Retryability MUST be conveyed via the closed-set `retry` union (do not encode retry semantics in free-form prose).

## Non-Goals

- Automatically infer structured output semantics from workflow prompts.
- Require the agent to manage dashboard sessions explicitly.

## Tool Set

These tool names are chosen to make the workflow lifecycle explicit, reduce agent confusion, and keep durable state inside WorkRail:

- **Inspect**: read-only discovery and preview (never mutates execution)
- **Start**: begins a new run and returns the first pending step
- **Advance**: progresses an existing run from opaque tokens (or rehydrates/resumes a pending step)

### `list_workflows`

Lists available workflows.

### `inspect_workflow`

Read-only retrieval of workflow metadata and/or a preview to help select a workflow.

### `start_workflow`

Starts a new workflow run and returns the first pending step plus opaque tokens.

### `continue_workflow`

Continues an existing workflow run.

- If `ackToken` is provided: acknowledge completion of the pending step for the given snapshot (idempotent).
- If `ackToken` is omitted: rehydrate/resume the pending step for the given snapshot (**no advancement and no durable mutation**).

**Rehydrate-only is side-effect-free (normative):**
- Calling `continue_workflow` without `ackToken` MUST NOT create nodes, edges, outputs, gaps, observations, or any other durable events.
- It exists solely to recover a lost pending prompt/recap after rewinds, restarts, or long chats.

### `checkpoint_workflow` (optional / experimental)

Record durable “work progress” without advancing workflow state. This exists because meaningful work often happens outside a workflow step loop, and rewinds can delete chat context without warning.

This tool can be gated behind a feature flag while it is validated in real usage.

To keep WorkRail opt-in and avoid “checkpointing every chat”, `checkpoint_workflow` should require an existing workflow run handle (`stateToken`) and a WorkRail-minted `checkpointToken` unless checkpoint-only sessions are explicitly enabled.

Idempotency (required for rewind-safe correctness):
- `checkpoint_workflow` MUST be idempotent under retries/replays.
- WorkRail achieves this by minting a `checkpointToken` (opaque, scoped, replay-safe) alongside `stateToken`/`ackToken` in `start_workflow`/`continue_workflow` responses.
- Callers MUST round-trip `checkpointToken` unchanged when invoking `checkpoint_workflow`.

If checkpoint-only sessions (no workflow has started) are desired later, introduce a `start_session` tool behind a separate feature flag and extend `checkpoint_workflow` to accept `sessionToken`. Until then, checkpointing outside workflows is intentionally unsupported.

### `start_session` (optional / feature-flagged)

Create a session handle for checkpoint-only workflows (no active run). This tool exists to reduce friction in “brand new chat” scenarios where a user wants durable notes without starting a workflow run.

This tool is intentionally narrow and should not reintroduce session CRUD surfaces.

### `resume_session` (optional / feature-flagged)

Read-only lookup for resuming work in a brand new chat. Supports queries like “resume my session about xyz” and returns **tip-only** resume targets (latest branch tip by deterministic policy), plus small snippets for disambiguation.

## End-to-End Flows

### Basic flow (single workflow)

1. Call `list_workflows` and `inspect_workflow` to select a workflow (read-only).
2. Call `start_workflow` to begin execution.
3. Repeat:
   - Follow `pending.prompt`
   - Call `continue_workflow` with the returned `stateToken` and `ackToken` to advance (or call without `ackToken` to rehydrate a pending step)
4. Stop when `isComplete == true` (and `pending == null`).

#### Full-auto execution (modes)

WorkRail supports “full-auto” execution as a first-class behavior. In full-auto modes, the agent must play the role of both the agent and the user: it does not silently skip user-directed prompts. Instead, it resolves them via best-effort context gathering and explicit assumptions.

Two full-auto variants are intentionally supported:

- **`full_auto_never_stop`**: never returns `blocked`. When required user input is unavailable, the agent continues by gathering context elsewhere, making explicit assumptions, or skipping steps, while recording durable warnings and gaps.
- **`full_auto_stop_on_user_deps`**: blocks only for formalized user-only dependencies (see below).

### Off-workflow work (checkpoint)

When the agent is doing substantial work outside a workflow step loop (implementation, iteration, tuning output, etc.), it should call `checkpoint_workflow` to persist a short recap. This reduces the cost of rewinds and long chats by moving durable memory into the session store.

### Rewind/fork behavior (chat UIs)

If the user rewinds conversation history, the agent may repeat a prior call sequence and reuse an older `stateToken`.

This is expected and correct:

- An older `stateToken` represents an older snapshot.
- Advancing from that token creates a new branch in the run's lineage.
- The dashboard should render forks rather than treating this as “desync”.

### Multiple workflows (sequential, parallel, nested)

Agents may run multiple workflows in a single chat:

- **Sequential**: finish workflow A, then start workflow B.
- **Parallel/interleaved**: keep multiple `{stateToken, ackToken}` pairs and advance any run in any order.
- **Nested**: run workflow B “inside” a step of workflow A by:
  - starting and advancing B separately
  - writing B’s results into A via `context` or step output

No special “nesting API” is required for correctness; it is an orchestration choice.

## Core Concepts

### `stateToken` (opaque snapshot)

- **Minted by WorkRail**.
- Encodes (internally): `workflowId`, `workflowHash`, `runId`, and execution snapshot data.
- Must be **opaque** to clients: clients round-trip it without modification.
- Must be **validated** by WorkRail (version + signature/HMAC) to prevent tampering.

### `workflowHash` (pinned workflow identity)

Runs are pinned to a specific workflow definition at `start_workflow` time to avoid “live” behavior changes when workflow files evolve.

- WorkRail computes `workflowHash` from a normalized (or compiled) workflow definition.
- The hash is embedded into `stateToken` so future calls are deterministic.
- WorkRail persists a workflow snapshot keyed by `workflowHash` in the session store (required for export/import and for continuing runs when the workflow file changes or disappears).

### `ackToken` (opaque completion acknowledgement)

- **Minted by WorkRail** per pending step and per `stateToken`.
- Represents “the client completed the pending step instruction returned with this snapshot”.
- Must be **idempotent**:
  - Replaying the same `(stateToken, ackToken)` returns the same response payload.
  - Replaying does not advance the run twice.
- **Idempotency must not be implemented via recompute (normative):**
  - When replaying the same `(stateToken, ackToken)`, WorkRail MUST return from durable recorded facts keyed by the attempt identity (see v2 locks `advance_recorded`) and MUST NOT re-run step selection, contract validation, or other execution logic that could drift.
- Must be **scoped**:
  - An `ackToken` from run A must not be usable on run B.
  - An `ackToken` from snapshot X must not be usable on snapshot Y.

#### Branching and “attempt acks” (normative)

Rewinds and replays are expected. The system must support **branching** from the same snapshot (older `stateToken`) without requiring the agent to construct identifiers.

To enable branching, WorkRail must be able to mint a **fresh attempt acknowledgement** for the same snapshot when the agent wants to intentionally fork (or when a replay is detected).

Idempotency is keyed to the server-minted ack capability (replay of the same `ackToken` is a no-op returning the same response).

### `checkpointToken` (opaque checkpoint acknowledgement)

- **Minted by WorkRail** for checkpointing against a specific `stateToken` snapshot/node.
- Represents “the client wants to append a checkpoint at this node”.
- Must be **idempotent**:
  - Replaying the same `(stateToken, checkpointToken)` MUST NOT create duplicate checkpoint nodes/edges/outputs.
  - Replaying returns the same response deterministically.
- Must be **scoped**:
  - A `checkpointToken` from run A must not be usable on run B.
  - A `checkpointToken` from snapshot X must not be usable on snapshot Y.

### `context` (external inputs)

`context` carries external facts that can influence conditions and loop inputs, e.g.:

- identifiers: ticket id, repo path, branch
- workflow parameters: `quantity`, `deliverable`
- constraints: “don’t run detekt”, “no network”, etc.

Do not place workflow progress state in `context`.

## Preferences & modes (normative)

WorkRail v2 supports user-selectable execution behavior (e.g., guided vs full-auto) without expanding the MCP boundary or leaking engine internals.

### Preferences (closed set)

Preferences are a **WorkRail-defined closed set** of typed values (enums / discriminated unions). They are not arbitrary key/value bags.

- Workflows may **recommend** preferences (or presets), but they do not invent new preference keys.
- Preferences influence execution behavior, but correctness remains token-driven (`stateToken`, `ackToken`).

### Modes (presets)

“Modes” are **display-friendly presets** (Studio/UX-facing) that map to one or more preference values. WorkRail owns the preset set and labels so the UX can stay simple without sacrificing determinism.

### Scopes and precedence

Preferences exist at multiple scopes:

- **Global**: developer defaults.
- **Session**: defaults for a workstream; override global.

Global preferences are treated as defaults only: they are copied into a session baseline at the start of work, so future global changes do not retroactively affect past runs.

### Node-attached effective preferences

WorkRail must evaluate each next-step decision against the **effective preference snapshot** and record it durably as part of the run graph (e.g., stored on the node or via append-only events).

That snapshot applies to descendant nodes until another preference change occurs. This makes preference-driven behavior rewind-safe and export/import safe: replaying an older `stateToken` replays with the preference state that was effective at that node, not “whatever is configured today”.

## Optional capabilities (normative)

Some workflows can optionally leverage enhanced agent capabilities (e.g., delegation/subagents or web browsing). WorkRail cannot introspect what tools an agentic IDE provides, so capability availability must be learned through explicit, durable observations rather than assumed or inferred.

### Capabilities (closed set)

Capabilities are a WorkRail-defined closed set. For v2 we explicitly plan for:

- `delegation` (subagents / parallel delegation)
- `web_browsing` (external knowledge lookup via agent tooling)

### Desired vs observed

Workflows may declare whether a capability is:

- **required**: the workflow is not meaningfully executable without it.
- **preferred**: use it when available; otherwise degrade.

WorkRail does not attempt to enumerate or model “baseline” agent tools (file read/write, grep, terminal, etc.). Capabilities are only for optional enhancements that materially change how a workflow is executed or whether it can run at all.

Capability requirements are part of the workflow’s compiled behavior (they change prompts, probing steps, and fallback paths) and must therefore be included in the compiled workflow that is hashed into `workflowHash`.

WorkRail tracks the observed status per run/branch:

- `unknown` (default)
- `available` (observed working)
- `unavailable` (observed failing / not supported)

Observed status must be recorded durably (node-attached or via append-only events) so resumption and export/import do not depend on ambient IDE configuration.

### Probing and degradation

Because capability status is learned, workflows must specify how to discover it:

- If `web_browsing` is **required**, probe early so blocking modes can fail fast with an actionable recommendation (e.g., “install a web browsing MCP” or provide the needed source material manually).
- If `delegation` is **preferred**, probing can be lazy: attempt when needed and fall back to a sequential approach if unavailable.

When a preferred capability is unavailable, WorkRail should degrade gracefully and surface a Studio warning (and/or durable notes) that the enhanced path was not applied.

### Recording capability observations (recommended)

Observed capability status should be recorded as durable data associated with the current node (or as an append-only event). Because WorkRail cannot introspect the agent environment, this observation must come from explicit agent-reported results (e.g., a probe step that attempts to use the capability).

Where structured artifacts are used, WorkRail should provide a small, closed-set artifact kind for capability observations so Studio can render consistent warnings and history.

### Example patterns (recommended)

#### Web browsing required: injected early probe

If a workflow requires `web_browsing`, the compiled workflow should include an early, injected probe step (collapsed by default for agent UX) whose purpose is to determine observed capability status.

Behavior:

- The probe step instructs the agent to attempt a minimal web-browsing action (e.g., fetch any short page or search query).
- On acknowledgement, the agent reports a durable capability observation (e.g., `capability=web_browsing`, `status=available|unavailable`, optional remediation).
- If the agent attempts to advance without providing the required observation, WorkRail returns `blocked` with a structured “missing required output” reason and an example payload.

This enables:

- `full_auto_stop_on_user_deps` (or guided) to fail fast when web browsing is required but unavailable.
- `full_auto_never_stop` to continue while recording a critical gap when web browsing is required but unavailable.

#### Delegation preferred: lazy attempt + sequential fallback

If a workflow prefers `delegation`, it should not require an upfront probe. Instead:

- At steps that can benefit from parallelism, the prompt instructs the agent to attempt delegation/subagents when available.
- If delegation is unavailable, the agent executes the sequential alternative and records a durable capability observation indicating `delegation` is unavailable.
- Studio surfaces a warning that the delegated path was not applied, but the workflow continues normally.

## Durable outputs (`output` envelope)

WorkRail needs durable memory outside the chat transcript. To keep the system simple for agents, there should be a **single write path** for durable updates:

- Use `output` for durable summaries and structured artifacts that should appear in the session/dashboard and survive rewinds.
- Use `context` only for external inputs that influence execution (conditions, loops, parameters), not for durable notes.

## Resumption vs rewind behavior (normative)

WorkRail cannot read the chat transcript. It must infer “resume” vs “fork” from the durable run graph.

- **Resumption (tip node)**:
  - When the provided snapshot is the latest tip of its branch, WorkRail should return a durable recap (“rehydration”) up to the pending step to help agents recover from lost chat context.

- **Rewind/fork (non-tip node)**:
  - When the provided snapshot already has children (advancing would create a new sibling branch), WorkRail should:
    - return branch-focused information (existing children summaries)
    - automatically fork (no user confirmation required)
    - return branch context the agent likely lost (including a bounded “downstream recap” for the preferred/latest branch), while still avoiding an unbounded full-history dump (“confusing soup”)

### Recap budgets and truncation (normative)

WorkRail should return the **full recap when it is small**, and a **deterministically truncated recap** when it would exceed reasonable payload budgets.

- **Budgeting rule**:
  - Prefer byte-based budgets (most deterministic across models/clients).
  - Include as many most-recent recap entries as fit within the budget, preserving deterministic ordering.

- **Truncation marker**:
  - When truncating, include an explicit marker in both `text` and structured fields indicating:
    - that the recap was truncated
    - how many entries were omitted (when known)
    - the policy used (e.g., “kept most recent entries”)

This keeps the “rewind resilience” promise without turning every response into an unbounded history dump.

## User-only dependencies (normative)

WorkRail should treat “user-only dependencies” as a **closed set of reasons** that can justify returning `kind: "blocked"` (e.g., a required design doc that only the user can supply).

The behavior depends on the effective full-auto preference:

- Under **`full_auto_stop_on_user_deps`**, WorkRail returns `blocked` with structured reasons and next-input guidance.
- Under **`full_auto_never_stop`**, WorkRail never blocks. User-only dependency reasons must be converted into structured warnings plus durable disclosure (“gaps”) while execution continues.

The exact enum set for user-only dependency reasons is intentionally deferred (see Open items).

## Blocked vs gaps (mode-driven, drift prevention) (recommended)
To keep behavior deterministic across modes and prevent semantic drift, treat “blocked” (control flow) and “gaps” (durable disclosure) as two views over the same underlying closed-set reasons.

Recommended rules:
- In blocking modes (`guided`, `full_auto_stop_on_user_deps`), eligible reasons return `kind:"blocked"` with structured blockers.
- In `full_auto_never_stop`, the engine must not return `blocked`; instead it records critical gaps and continues, while still disclosing the same underlying reason.

Additional recommendation:
- Blockers should use a closed-set `code` enum and deterministic ordering, and include a typed pointer so Studio can render actionable unblock guidance without reading chat history.

## `blocked.blockers[]` schema (normative)
When WorkRail returns `kind:"blocked"`, the `blockers[]` payload MUST conform to a closed, deterministic shape so clients do not infer meaning from prose.

Locks:
- `blockers` is a non-empty list.
- `blockers` MUST be deterministically ordered by `(code, pointer.kind, pointer.* stable fields)` ascending.
- Each blocker MUST include: `code`, `pointer`, `message`. `suggestedFix` is optional but strongly recommended.
- Payloads are bounded:
  - max blockers: 10
  - max `message` bytes: 512 (UTF-8)
  - max `suggestedFix` bytes: 1024 (UTF-8)

`blockers[].code` (closed set, initial):
- `USER_ONLY_DEPENDENCY`
- `MISSING_REQUIRED_OUTPUT`
- `INVALID_REQUIRED_OUTPUT`
- `REQUIRED_CAPABILITY_UNKNOWN`
- `REQUIRED_CAPABILITY_UNAVAILABLE`
- `INVARIANT_VIOLATION`
- `STORAGE_CORRUPTION_DETECTED`

`blockers[].pointer` (closed set, initial):
- `{ "kind": "context_key", "key": "..." }`
- `{ "kind": "output_contract", "contractRef": "..." }`
- `{ "kind": "capability", "capability": "delegation" | "web_browsing" }`
- `{ "kind": "workflow_step", "stepId": "..." }`

## Durable accounting for outcomes (normative, drift-prevention)

Because chat transcripts are not reliable storage, WorkRail should not require Studio/exports to infer what happened from transient tool responses.

Locks:
- WorkRail MUST persist a durable, node-scoped record of each attempted `continue_workflow` **ack** intent (advancement attempt) and its outcome (blocked | advanced) as append-only truth (see v2 lock: `advance_recorded`).
- Replay MUST be derived from this durable record (fact-returning); replays MUST NOT recompute outcomes.
- Dedupe/idempotency MUST be first-class: retries must not create duplicate “attempt” records, but legitimate evolution (e.g., a later unblock with a new attempt) must remain appendable.

## Mode safety, warnings, and recommendations (normative)

WorkRail must never hard-block a user-selected mode. Instead:

- Workflows may declare a **recommended maximum automation** (a suggested preset).
- If the user selects a more aggressive mode, WorkRail returns structured warnings and recommends the highest automation combination it considers safe for that workflow.

## Brand new chat resumption (normative)

Because WorkRail cannot access chat history, a brand new chat must either:

- supply an existing handle (e.g., a `stateToken` or a short `resumeRef`), or
- use `resume_session` (when enabled) to find the correct session/run tip.

`resume_session` should use a layered search strategy:

1. session keys/titles/tags and obvious identifiers (high precision)
2. durable notes (`output.notesMarkdown`) and small artifact previews on run tips
3. deep search across durable outputs as a last resort (bounded)

Results should be **tip-only** and deterministically ranked.

### Minimal `output` shape (recommended)

- `output.notesMarkdown` (optional but strongly encouraged): short recap (≤10 lines) of what happened and what’s next.
- `output.artifacts[]` (optional): small structured payloads, used only when you have concrete structured results.

Artifact kinds should be from a closed set (examples):

- `mr_review.changed_files`
- `mr_review.findings`
- `working_agreement_patch` (rare; only derived from explicit user preferences)

The exact allowed artifact kinds and schemas can be workflow-specific via explicit output contracts.

## Workflow pinning and evolution

### Workflow identity and namespaces (normative)

WorkRail v2 adopts a **namespaced workflow ID format** for clarity, organization, and protection of core workflows.

**ID format:**
- `namespace.name` with **exactly one dot**
- Both `namespace` and `name` segments use: `[a-z][a-z0-9_-]*` (lowercase, alphanumeric, hyphens, underscores)
- Examples: `wr.bug_investigation`, `project.auth_review`, `team.onboarding`

**Reserved namespace:**
- The `wr.*` namespace is **reserved exclusively for bundled/core workflows**.
- Non-core sources (user, project, git, remote, plugin) must not define workflows with IDs starting with `wr.*`.
- WorkRail must reject such definitions at load/validate time with an actionable error.

**Legacy IDs (no dot):**
- Workflows with legacy IDs (e.g., `bug-investigation`) remain **runnable** for backward compatibility.
- Creating or saving new workflows with legacy IDs is **rejected**.
- Usage/inspection of legacy workflows must emit **structured warnings** with suggested namespaced renames based on the workflow's source:
  - User directory → `user.<id>`
  - Project directory → `project.<id>`
  - Git/remote/plugin → `repo.<id>` or `team.<id>` (deterministic suggestion)

**Discovery behavior:**
- `list_workflows` returns both workflows and routines, including:
  - `kind: "workflow" | "routine"`
  - `idStatus: "legacy" | "namespaced"`
- Deterministic sort order: **namespace → kind (workflow first) → name/id**

### Pinning policy (normative)

- `start_workflow` MUST compute a `workflowHash` and pin the run to it.
- The `workflowHash` is computed from the **fully expanded compiled workflow**, including:
  - the workflow definition (with namespaced ID)
  - all builtin template expansions
  - all feature applications
  - all selected contract packs
- Subsequent `continue_workflow` calls MUST execute against the pinned workflow snapshot identified by the `workflowHash` embedded in `stateToken`.

### Workflow changes on disk (recommended behavior)

If the workflow file at `workflowId` changes after a run is started:

- WorkRail should continue using the pinned snapshot for that run.
- WorkRail should surface a structured warning (as data) that the on-disk workflow differs from the pinned snapshot.

Explicit “migration” of a run to a new workflow version is a separate, opt-in feature.

## What the Agent Must and Must Not Do

- **MUST**:
  - Treat `stateToken`, `ackToken`, and `checkpointToken` as opaque values.
  - Round-trip all tokens exactly as returned.
  - Only advance the workflow by calling `continue_workflow` with the current tokens (`stateToken` + `ackToken`).
  - Only record a checkpoint by calling `checkpoint_workflow` with the current `stateToken` and `checkpointToken`.
  - In full-auto modes, resolve user-directed prompts by best-effort context gathering and explicit assumptions rather than silently skipping questions.
  - Disclose assumptions, skips, and missing inputs via durable `output` so progress survives rewinds.
- **MUST NOT**:
  - Construct or mutate workflow execution state (completed steps, loop stacks, etc.).
  - Guess tool payload shapes beyond what the tool schema and examples provide.

## Request/Response Shapes

### `start_workflow` request

```json
{
  "workflowId": "mr-review-workflow",
  "context": {
    "ticketId": "AUTH-1234",
    "complexity": "Standard"
  }
}
```

### `start_workflow` response (example)

```json
{
  "stateToken": "st.v1....",
  "pending": {
    "stepId": "phase-0-triage",
    "title": "Phase 0: Triage & Review Focus",
    "prompt": "…",
    "requireConfirmation": true
  },
  "ackToken": "ack.v1....",
  "checkpointToken": "chk.v1....",
  "isComplete": false,
  "session": {
    "sessionId": "AUTH-1234",
    "runId": "run_01JFD..."
  },
  "preferences": {
    "autonomy": "guided",
    "riskPolicy": "conservative"
  }
}
```

Notes:
- `session` is **informational** and for dashboard UX only. Correctness is driven by tokens.
- `preferences` is **informational** for UX/debugging; it does not replace the durable run graph as source of truth.

### `continue_workflow` request

```json
{
  "stateToken": "st.v1....",
  "ackToken": "ack.v1....",
  "context": {
    "ticketId": "AUTH-1234",
    "complexity": "Standard"
  },
  "output": {
    "notesMarkdown": "Completed phase 0. MR is Standard complexity; focus on DI wiring and tool contract correctness."
  }
}
```

### `continue_workflow` response (example)

```json
{
  "stateToken": "st.v1.next....",
  "pending": {
    "stepId": "phase-1-context",
    "title": "Phase 1: Contextual Understanding & Confirmation",
    "prompt": "…",
    "requireConfirmation": true
  },
  "ackToken": "ack.v1.next....",
  "checkpointToken": "chk.v1.next....",
  "isComplete": false,
  "session": {
    "sessionId": "AUTH-1234",
    "runId": "run_01JFD..."
  },
  "preferences": {
    "autonomy": "full_auto_stop_on_user_deps",
    "riskPolicy": "balanced"
  }
}
```

### `checkpoint_workflow` request (example)

```json
{
  "stateToken": "st.v1....",
  "checkpointToken": "chk.v1....",
  "output": {
    "notesMarkdown": "Implemented token-based description updates. Next: update tool naming to `start_workflow`/`continue_workflow` and add checkpoint tool behind flag."
  }
}
```

Notes:
- For now, `checkpoint_workflow` requires `stateToken` and `checkpointToken` (attach to a specific workflow node). Session-only checkpointing is a future feature behind `start_session`.

## Dashboard / Sessions (UX Projection)

Sessions are a UX layer that should be updated **natively** as a side effect of `start_workflow`/`continue_workflow`:

- A single **session** represents a single workstream (ticket/PR/chat) and may contain **multiple workflow runs**.
- Each **run** corresponds to a single workflow execution and has its own branching token lineage.

### Persistence model (recommended)

Use an **append-only event log as the source of truth**, stored per session.

Storage invariants (segmentation, crash-safe append, integrity/recovery, snapshot identity/layout, etc.) are consolidated and locked in:
- `docs/design/v2-core-design-locks.md`

- Events drive the dashboard; projections are derived (pure functions).
- Token lineage is derived from durable node and edge events. At minimum:
  - advancing a step creates an edge (`edgeKind=acked_step`) from parent snapshot to child snapshot
  - checkpointing creates a node snapshot **and** an edge (`edgeKind=checkpoint`) from parent snapshot to checkpoint snapshot (no advancement)
- Nodes represent durable snapshots. For Studio, it is useful to treat node kinds as a closed set, e.g.:
  - `nodeKind=step` (created by `continue_workflow` advancement)
  - `nodeKind=checkpoint` (created by `checkpoint_workflow`)
- Rewinds naturally create branches (multiple children for the same parent) instead of “desync”.
- Session pointers (like “latest”) are derived views, not authoritative state.

### Preferences, capabilities, and divergence (recommended)

Studio-visible signals should be recorded as durable data attached to the node where they occurred, for example:

- effective preferences (and preference-change markers)
- capability observations (requested vs observed)
- divergence markers (when the agent intentionally deviates from step instructions)

### Environment observations (recommended)

Record high-signal local observations (e.g., git branch name and HEAD SHA) as append-only events. Use these observations to improve resume ranking and session identification in `resume_session`.

### UI guidance (avoid “confusing soup”)

If a session contains multiple workflow runs, the UI MUST make boundaries explicit.

Recommended baseline UI:

- **Runs sidebar**: list runs with `workflowId` + human title + status (Running/Complete) + branch count.
- **Single active run view**: render one run at a time (its branch graph + steps + artifacts) to avoid mixing content.
- **Session Notes**: a session-level notes area for global context and “between workflows” summaries.

Advanced view (optional):

- **Session Timeline**: a chronological timeline view with lanes per run (color-coded), plus an optional session-level lane for global checkpoints. This makes multi-workflow sessions understandable without intermixing details in the default view.

### Local-only dashboard and sharing

The dashboard is local-only. Sharing is achieved via explicit export/import:

- Export session bundle (versioned) for another developer to import into their local dashboard.
- Export rendered views (e.g., Markdown, optionally PDF) as projections of stored session artifacts.

Retention/expiration (TTL) should be configurable; a reasonable default is 30–90 days.

## Export/import bundles (resumable) (normative)

WorkRail must support **resumable** export/import of stored sessions. After import, an agent should be able to use `resume_session` and `continue_workflow` to proceed deterministically.

### Bundle format (recommended)

- A single, versioned bundle file (e.g., JSON). Zip/folder formats can be added later, but the bundle must remain self-describing and deterministic.
- The bundle MUST include a `bundleSchemaVersion` so imports can fail fast (or migrate explicitly).

### Required bundle contents (normative)

To be resumable, a bundle MUST include:

- **Session metadata** used for lookup/ranking and timestamps (when present). v2 does not require mutable session-level fields; lookup/ranking may be derived from durable observations and outputs.
- **Observations** (e.g., git branch name + HEAD SHA) as append-only data for better resume ranking
- **Runs** (0..N) and their run DAG (nodes + edges), including stable identifiers
- **Portable node snapshots** sufficient to rehydrate execution deterministically on another machine
- **Durable outputs** (`output.notesMarkdown` and artifacts/previews) attached to nodes for recap/search
- **Pinned workflow snapshots by `workflowHash`**, where `workflowHash` is computed from the **fully expanded compiled workflow**

Tokens (`stateToken`, `ackToken`) are not portable and must not be relied upon across export/import. On import, WorkRail re-mints new tokens from stored node snapshots.

### Integrity and conflicts (recommended behavior)

- Include a manifest of digests (hashes) to detect bundle corruption and surface an actionable error.
- If importing a bundle collides with an existing session identifier, default to importing as a **new** session (no implicit merges). Merge can be an explicit, opt-in feature later.

## Replacing File-Based Docs with Dashboard Artifacts (Optional)

Some workflows currently instruct the agent to write markdown files. The token-based contract can support dashboard-native documents by allowing an optional, step-defined `output` payload in `continue_workflow`:

- Default: accept `output.notesMarkdown` and render it per step.
- For workflows that need structured dashboards: steps should explicitly define an output contract (schema + example) to avoid inference.

### Defaults for legacy workflows (no output contract)

If a workflow has not been updated to include an explicit output contract, WorkRail can still provide a usable dashboard without guessing semantics:

- Render a per-step “Notes” artifact from `output.notesMarkdown`.
- Show token lineage, pending step metadata, and completion timestamps.

This is intentionally generic. Structured artifacts (tables, findings, MR comments, etc.) require explicit contracts.

### How explicit output contracts can work

Two compatible approaches:

1. **In-workflow contract**: each step includes an output schema + example (kept small).
2. **Server-side registry**: the workflow references a named output contract, and WorkRail provides the schema and example.

Either way, the workflow (not heuristics) is authoritative.

This approach keeps the agent interaction primitive and moves deterministic “doc updates” into server-side reducers.

### Appendix A: Example dashboard artifacts for `mr-review-workflow` (illustrative)

This appendix illustrates the *shape* of what an agent might send and what the dashboard might render. It is intentionally small and primitives-only for the agent. The exact schema should be declared explicitly by the workflow (or by a referenced contract registry).

#### Example: `continue_workflow` with structured `output`

```json
{
  "stateToken": "st.v1....",
  "ackToken": "ack.v1....",
  "context": {
    "ticketId": "AUTH-1234",
    "complexity": "Standard"
  },
  "output": {
    "kind": "mr_review.phase_0_triage",
    "review": {
      "mrTitle": "fix(di): explicitly wire MCP description provider",
      "classification": "Standard",
      "focusAreas": ["tool contract correctness", "DI wiring", "agent usability"]
    },
    "revisionLogEntry": "Triage completed; created review session and established focus areas."
  }
}
```

WorkRail would store this as dashboard artifacts (example conceptual mapping):

- `review.header`: `mrTitle`, `classification`, `focusAreas`
- `review.revisionLog[]`: append entry

#### Example: changed files table rows (Phase 1)

```json
{
  "kind": "mr_review.changed_files",
  "changedFiles": [
    {
      "path": "src/mcp/tool-description-provider.ts",
      "summary": "Remove debug log; ensure provider wiring is explicit",
      "risk": "L"
    },
    {
      "path": "src/di/container.ts",
      "summary": "Wire description provider in composition root",
      "risk": "M"
    }
  ]
}
```

Dashboard render intent:

- a “Changed Files” table rendered from `changedFiles[]` with deterministic ordering and dedupe keyed by `path`.

#### Example: findings and copy-ready MR comments (Phase 2+)

```json
{
  "kind": "mr_review.findings",
  "findings": [
    {
      "severity": "Major",
      "location": { "file": "src/mcp/tool-descriptions.ts", "line": 79 },
      "title": "Tool description drift: mentions workflow_next/completedSteps but contract uses start_workflow/continue_workflow tokens",
      "rationale": "Agents will send the wrong shape and fail the tool boundary contract.",
      "suggestion": "Update authoritative and standard descriptions to match the current schema."
    }
  ],
  "mrComments": [
    {
      "location": { "file": "src/mcp/tool-descriptions.ts", "line": 79 },
      "title": "Fix workflow tool description drift",
      "body": "The description references older workflow_next/completedSteps terminology, but the current v2 contract uses start_workflow/continue_workflow with stateToken/ackToken. This mismatch will cause agent misuse; please update descriptions to match the current contract."
    }
  ]
}
```

Notes:
- The workflow can keep using its rich prompts (and “functionReferences” in the workflow definition) while the dashboard replaces file I/O by treating these outputs as structured artifacts.
- If a workflow does not provide an output contract, WorkRail should fall back to the generic per-step notes dashboard (no inference).

## Output contracts & enforcement (normative)

WorkRail v2 enables workflows to declare **required structured outputs** via contract packs, and enforces these requirements (or records gaps) based on the effective mode.

### How contracts are declared

Steps (and templates) may declare output requirements via an `output` object:

- `output.contractRef` (optional): references a WorkRail-owned closed-set contract pack (e.g., `wr.contracts.capability_observation`).
- `output.hints` (optional): non-enforced guidance for the agent (e.g., "≤10 lines").

Template calls may **automatically imply a contractRef** without the author specifying it (e.g., `wr.templates.capability_probe` implies `wr.contracts.capability_observation`).

### Enforcement on `continue_workflow`

When a step declares `output.contractRef`, WorkRail validates the contract output before advancing:

- **Blocking modes (guided / full_auto_stop_on_user_deps)**: if required output is missing or invalid, return `kind: "blocked"` with structured "missing required output" reason, example payload, and the same pending step.
- **Never-stop mode**: if required output is missing or invalid, record a **critical gap** and continue.

This enables the self-correcting loop: step tells the agent what to fill out; the next `continue_workflow` verifies it.

### Contract pack versioning

Contract packs are referenced by ID only. Versioning is implicit: the pinned compiled workflow snapshot carries the exact contract pack schemas resolved at compile time.

## PromptBlocks & rendered prompts (normative)

Workflows may author steps with **structured `promptBlocks`** rather than a single `prompt` string. WorkRail compiles `promptBlocks` into a deterministic, text-first `pending.prompt`.

Canonical block set: `goal`, `constraints`, `procedure`, `outputRequired`, `verify`.

Blocks are **optional**; plain `prompt` strings are still allowed.

## AgentRole (normative clarification)

WorkRail **cannot control the agent's system prompt**. The `agentRole` field is workflow/step-scoped stance text injected into the rendered prompt. Workflow-level applies to all steps; step-level overrides.

## Divergence markers (normative)

Agents may report `workflow_divergence` artifacts when intentionally deviating from step instructions. Structure: `reason` (closed set), `summary`, optional `relatedStepId`. Studio badges these nodes. Enforcement: optional unless a step explicitly requires it.

## FAQ

### How is `stateToken` “opaque”?

Opaque means clients treat it as an uninterpreted string. WorkRail is free to encode internal state however it wants (and change that encoding over time) as long as it can validate and decode it server-side.

In practice, WorkRail should make tokens tamper-evident (e.g., signature/HMAC) and versioned (e.g., `st.v1...`, `st.v2...`) to support safe evolution.

### Are tokens portable across export/import?

Tokens are handles, not durable truth. Exports/imports must be **resumable**, which implies:

- the durable store must persist portable run graph nodes and pinned workflow snapshots
- on import, WorkRail re-mints new tokens from stored node snapshots

See ADR 006 and ADR 007.

### Is `ackToken` enough? What about loops and confirmations?

Yes. Loops, confirmations, and other control structures are internal workflow mechanics represented in the snapshot behind `stateToken`. The public contract is simply:

- WorkRail tells the agent what to do next (`pending`).
- The agent completes it.
- The agent acknowledges completion using the `ackToken` issued for that snapshot.

### Do we need `workflowId` on `continue_workflow`?

No. `workflowId` can be embedded into `stateToken`. Keep `workflowId` only on `start_workflow` (because there is no token yet). Optionally return `workflowId` in responses as informational metadata for the dashboard.

### If sessions are “demoted”, do we still need session tools?

Sessions become a UX projection, so session creation and updates should happen as a side effect of `start_workflow`/`continue_workflow` without broad agent-facing session CRUD tools.

If checkpoint-only sessions are desired later, add a narrowly-scoped `start_session` tool behind a feature flag. For brand new chat resumption without token copy/paste, use a read-only `resume_session` lookup tool behind a feature flag.

### Why do we need `checkpoint_workflow` at all?

Because rewinds are external to the workflow engine. If meaningful work happens outside a workflow step loop and the user rewinds without warning, that progress is lost unless WorkRail has already recorded a durable recap in the session store.

## Open items (non-normative)

- Finalize the closed set of user-only dependency reasons (for structured `blocked` and warning payloads).
- Finalize the closed set of preference keys and enum values, including display-friendly labels and descriptions for Studio.
- Define a standard “gaps” shape for `full_auto_never_stop` so Studio can surface incomplete/missing inputs without blocking execution.
- Define initial contract packs (capability_observation, workflow_divergence, gaps) and their schemas.
- Define minimal metadata schema for builtins so Studio's generated catalog can render/autocomplete/insert.
- Decide whitelist of configurable features and their config schemas.
- Decide whether promptBlocks becomes required or remains optional (current direction: optional).
- Define closed set of divergence reasons enum.
- Finalize "preferred tip" policy for resume and default Studio view.

## Related

- MCP constraints: `docs/reference/mcp-platform-constraints.md`
- ADR 005 (opaque tokens): `docs/adrs/005-agent-first-workflow-execution-tokens.md`
- ADR 006 (append-only session/run log): `docs/adrs/006-append-only-session-run-event-log.md`
- ADR 007 (resume + checkpoint-only sessions): `docs/adrs/007-resume-and-checkpoint-only-sessions.md`
