# WorkRail Library Extraction Plan

## Goal

Expose WorkRail's v2 workflow engine as an in-process library callable without MCP, transport, or tool abstractions. The first consumer is etienne-clone (MR review bot), but the API should be generic enough for any system that embeds workflow execution.

## Non-goals

- No workflow redesign
- No context injection / prompt templating
- No parallel steps
- No new workflow schema features
- No removal of the existing MCP surface (it stays, built on top of the same engine)

## Current architecture

```
MCP client (agent)
    |
    v
MCP JSON-RPC transport (stdio / HTTP)
    |
    v
Tool registry (tool-registry.ts) — routes tool calls
    |
    v
MCP handler layer (v2-execution/index.ts)
  - handleV2StartWorkflow(input, ctx: ToolContext) → ToolResult
  - handleV2ContinueWorkflow(input, ctx: ToolContext) → ToolResult
  - handleV2CheckpointWorkflow(input, ctx: ToolContext) → ToolResult
  - handleV2ResumeSession(input, ctx: ToolContext) → ToolResult
    |
    v
Execution functions (pure logic, returns ResultAsync)
  - executeStartWorkflow(input, ctx: V2ToolContext) → ResultAsync<Output, Error>
  - executeContinueWorkflow(input, ctx: V2ToolContext) → ResultAsync<Output, Error>
  - executeCheckpoint(input, ctx: V2ToolContext) → ResultAsync<Output, Error>
    |
    v
Engine internals (prompt-renderer, blocking-decision, durable-core, tokens, etc.)
```

### Key observation

The execution functions (`executeStartWorkflow`, etc.) are already decoupled from MCP. They take typed inputs and a `V2ToolContext`, return `ResultAsync`. The MCP handler layer is a thin adapter that:
1. Calls `requireV2Context(ctx)` to narrow the type
2. Calls the execution function
3. Maps the result to `ToolResult` (success/error)

The library extraction targets the execution function layer, bypassing the MCP handler and tool registry entirely.

## What a library consumer calls today (via MCP)

```
bot → HTTP → MCP JSON-RPC → tool handler → executeStartWorkflow(input, V2ToolContext)
```

## What a library consumer would call

```
bot → engine.startWorkflow(workflowId) → typed result
```

No HTTP. No JSON-RPC. No tool routing. No ToolResult wrapping.

## Integration points verified

### Inputs to execution functions

| Function | Input type | Fields |
|----------|-----------|--------|
| `executeStartWorkflow` | `V2StartWorkflowInput` | `workflowId: string`, `workspacePath?: string` |
| `executeContinueWorkflow` | `V2ContinueWorkflowInput` | `stateToken`, `ackToken?`, `intent`, `context?`, `output?` |
| `handleV2CheckpointWorkflow` | `V2CheckpointWorkflowInput` | `checkpointToken: string` |
| `handleV2ResumeSession` | `V2ResumeSessionInput` | `query?`, `gitBranch?`, `gitHeadSha?`, `workspacePath?` |

### Dependencies (V2ToolContext)

`V2ToolContext` = `ToolContext` narrowed to guarantee `v2: V2Dependencies` is non-null.

**ToolContext fields:**
- `workflowService: WorkflowService` — used by `executeStartWorkflow` to load workflows
- `featureFlags: IFeatureFlagProvider` — checked at boundary (not in execution functions)
- `sessionManager` / `httpServer` — not used by v2 execution functions
- `v2: V2Dependencies` — the core engine dependency bag

**V2Dependencies fields (all required for execution):**
- `gate: ExecutionSessionGateV2` — session locking
- `sessionStore` — append-only event log (read + write)
- `snapshotStore` — execution snapshots
- `pinnedStore` — content-addressed workflow snapshots
- `sha256` / `crypto` — hashing
- `idFactory` — ID generation (session, run, node, event IDs)
- `tokenCodecPorts` — token encode/decode/sign/verify (grouped: keyring, hmac, base64url, base32, bech32m)
- `validationPipelineDeps` — Phase 1a validation (schema, structural, compilation, normalization)

**V2Dependencies fields (optional, used by resume/workspace):**
- `resolvedRootUris?` — MCP client roots (not needed for library)
- `workspaceResolver?` — workspace identity (git branch/SHA detection)
- `dataDir?` / `directoryListing?` — session enumeration for resume
- `sessionSummaryProvider?` — resume session ranking

### DI construction graph

The V2Dependencies bag is constructed in `server.ts:createToolContext()` using the DI container. The container registers ~20 services across 3 levels:

**Level 1 (primitives, no deps):**
- `LocalDataDirV2(process.env)` — resolves `~/.workrail/v2`
- `NodeFileSystemV2()` — fs read/write
- `NodeSha256V2()`, `NodeCryptoV2()`, `NodeHmacSha256V2()` — crypto
- `NodeBase64UrlV2()`, `Base32AdapterV2()`, `Bech32mAdapterV2()` — encoding
- `NodeRandomEntropyV2()`, `NodeTimeClockV2()` — randomness, time
- `IdFactoryV2(entropy)` — ID minting

**Level 2 (stores, depend on Level 1):**
- `LocalKeyringV2(dataDir, fs, base64url, entropy)` — HMAC key management
- `LocalSessionEventLogStoreV2(dataDir, fs, sha256)` — session event log
- `LocalSnapshotStoreV2(dataDir, fs, crypto)` — execution snapshots
- `LocalPinnedWorkflowStoreV2(dataDir, fs)` — pinned workflow definitions
- `LocalSessionLockV2(dataDir, fs, clock)` — session locking

**Level 3 (orchestration):**
- `ExecutionSessionGateV2(lock, store)` — health-checked session access

**WorkflowService deps (separate from V2):**
- `WorkflowService` depends on storage (Primary), `ValidationEngine`, `WorkflowCompiler`, `WorkflowInterpreter`
- Storage is a 3-layer chain: `EnhancedMultiSourceWorkflowStorage` → `SchemaValidatingWorkflowStorage` → `CachingWorkflowStorage`

**Validation pipeline deps (subset used by start_workflow):**
- `schemaValidate` — AJV schema validator
- `structuralValidate` — `ValidationEngine.validateWorkflowStructureOnly()`
- `compiler` — `WorkflowCompiler` instance
- `normalizeToExecutable` — `normalizeV1WorkflowToPinnedSnapshot` function

### Token codec construction

Tokens require a loaded keyring. The keyring is loaded once at startup (`keyringPort.loadOrCreate()`), then the `unsafeTokenCodecPorts()` factory groups all encoding ports:

```typescript
const tokenCodecPorts = unsafeTokenCodecPorts({
  keyring: keyringResult.value,  // loaded HMAC keys
  hmac,          // NodeHmacSha256V2
  base64url,     // NodeBase64UrlV2
  base32,        // Base32AdapterV2
  bech32m,       // Bech32mAdapterV2
});
```

## agentRole enhancement

`agentRole` is defined on `WorkflowStepDefinition` and available in `prompt-renderer.ts` via `getStepById()`. Currently not returned in the response.

### Changes needed

1. `StepMetadata` in `prompt-renderer.ts` (line 319): add `readonly agentRole?: string`
2. `renderPendingPrompt()` (line 451, 457, 481, 489): include `agentRole: step.agentRole` in return value
3. `V2PendingStepSchema` in `output-schemas.ts` (line 102): add `agentRole: z.string().optional()`
4. Response construction — 5 sites that build `pending` from `meta`:
   - `start.ts:448` — `const pending = { stepId: meta.stepId, title: meta.title, prompt: meta.prompt }`
   - `continue-rehydrate.ts:185` — same pattern
   - `replay.ts:91, 213, 253` — same pattern (3 sites)
5. Contract tests — update schema expectations for `agentRole` optional field

This is a ~15 line change across 4 files + contract tests. Note: `continue-advance.ts` delegates to `replay.ts`, so it doesn't need direct changes.

## etienne-clone compatibility (verified)

etienne-clone already has a `WorkRailClient` interface in `src/clients/workrail.ts` that matches almost exactly what the library API should expose:

```typescript
// etienne-clone's existing interface (clients/workrail.ts)
interface WorkRailClient {
  readonly startWorkflow: (workflowId: string) => Promise<Result<WorkflowStepResponse, WorkRailError>>;
  readonly continueWorkflow: (stateToken, ackToken, output) => Promise<Result<WorkflowStepResponse, WorkRailError>>;
  readonly listWorkflows: () => Promise<Result<WorkflowListResponse, WorkRailError>>;
}
```

The library API should match this shape so etienne-clone can swap `createWorkRailClient(config)` (HTTP) for `createWorkRailEngine(config)` (in-process) with minimal changes. The main difference: `WorkRailError` becomes `EngineError` (no `connection_failed`, `timeout`, `session_expired` — those are transport errors).

The `PendingStep` type in etienne-clone is `{ stepId, title, prompt }` — once `agentRole` ships, the bot can use it as the LLM's system prompt per step, rather than using a static system prompt for the whole review.

## Library API design

### Entry point

```typescript
// src/engine/index.ts (new file, library entry point)
export { createWorkRailEngine } from './engine-factory.js';
export type { WorkRailEngine, EngineConfig } from './types.js';
```

### Config

```typescript
interface EngineConfig {
  // Where to store durable state (sessions, snapshots, keyring)
  // Default: ~/.workrail/v2
  readonly dataDir?: string;
  
  // Workflow sources (bundled, filesystem, git, etc.)
  // Default: bundled workflows only
  readonly workflowSources?: readonly WorkflowSource[];
}
```

### Engine interface

```typescript
interface WorkRailEngine {
  // Start a workflow, get the first step
  readonly startWorkflow: (workflowId: string) => Promise<EngineResult<StepResponse>>;
  
  // Advance to next step (ackToken present) or rehydrate (ackToken absent)
  readonly continueWorkflow: (
    stateToken: string,
    ackToken: string | null,
    output?: { notesMarkdown?: string; artifacts?: unknown[] },
  ) => Promise<EngineResult<StepResponse>>;
  
  // Checkpoint without advancing
  readonly checkpointWorkflow: (checkpointToken: string) => Promise<EngineResult<CheckpointResponse>>;
  
  // List available workflows
  readonly listWorkflows: () => Promise<EngineResult<WorkflowListResponse>>;
}
```

### Response types

```typescript
// Branded token types — compile-time safety against token misuse
type StateToken = string & { readonly [StateTokenBrand]: never };
type AckToken = string & { readonly [AckTokenBrand]: never };
type CheckpointToken = string & { readonly [CheckpointTokenBrand]: never };

// Discriminated union: ok | blocked (illegal states unrepresentable)
type StepResponse = StepResponseOk | StepResponseBlocked;

interface StepResponseOk extends StepResponseBase {
  readonly kind: 'ok';
  readonly pending: PendingStep | null;
}

interface StepResponseBlocked extends StepResponseBase {
  readonly kind: 'blocked';
  readonly pending: PendingStep | null;
  readonly blockers: readonly Blocker[];
  readonly retryable: boolean;
  readonly retryAckToken: AckToken | null;
}

// Typed error variants with domain-specific payloads (errors as data)
type EngineError =
  | { readonly kind: 'workflow_not_found'; readonly workflowId: string }
  | { readonly kind: 'workflow_has_no_steps'; readonly workflowId: string }
  | { readonly kind: 'workflow_compile_failed'; readonly message: string }
  | { readonly kind: 'validation_failed'; readonly message: string }
  | { readonly kind: 'token_invalid'; readonly message: string }
  | { readonly kind: 'token_signing_failed'; readonly message: string }
  | { readonly kind: 'session_error'; readonly message: string }
  | { readonly kind: 'storage_error'; readonly message: string }
  | { readonly kind: 'prompt_render_failed'; readonly message: string }
  | { readonly kind: 'precondition_failed'; readonly message: string }
  | { readonly kind: 'internal_error'; readonly message: string };

type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineError };
```

### Factory implementation strategy — DECIDED

**Chosen: DI container with library runtime mode.** The services used by execution functions use `@singleton()` and `@inject()` decorators from `tsyringe`, which require `reflect-metadata` and the global container. Manual wiring is not viable without decoupling the services from decorators first.

The factory calls `initializeContainer({ runtimeMode: { kind: 'library' } })` which:
- Skips signal handlers and process lifecycle management
- Uses `ThrowingProcessTerminator` (same as test mode)
- Registers all storage, services, and v2 primitives identically to production
- Does NOT start HTTP server, MCP transport, or session tools

Long-term: DI-free service wrappers remain the ideal (no global state, no reflect-metadata) but require a larger refactor that shouldn't block library v1.

## Implementation slices

### Slice 1: agentRole in step responses (smallest, immediate value) — DONE

**Files changed:**
- `src/v2/durable-core/domain/prompt-renderer.ts` — added `agentRole` to `StepMetadata`, threaded through all 4 return sites
- `src/mcp/output-schemas.ts` — added `agentRole` to `V2PendingStepSchema`, extracted `toPendingStep()` helper
- `src/mcp/handlers/v2-execution/start.ts` — uses `toPendingStep(meta)` instead of inline construction
- `src/mcp/handlers/v2-execution/continue-rehydrate.ts` — same
- `src/mcp/handlers/v2-execution/replay.ts` — same (3 sites)
- Note: `continue-advance.ts` delegates to `replay.ts`, no direct changes needed

**Risk:** Low. Additive, backward-compatible (optional field). All 62 contract tests pass.

### Slice 2+3: Engine types + factory — DONE

**New files:**
- `src/engine/types.ts` — branded tokens, discriminated union `StepResponse`, typed `EngineError` variants, `WorkRailEngine` interface with `close()`
- `src/engine/engine-factory.ts` — `createWorkRailEngine(config)` returns `EngineResult<WorkRailEngine>`, uses DI container in `library` runtime mode
- `src/engine/index.ts` — public exports

**Also changed:**
- `src/runtime/runtime-mode.ts` — added `library` variant
- `src/di/container.ts` — `library` mode uses no signal handlers, ThrowingProcessTerminator
- `src/mcp/handlers/v2-execution/index.ts` — exported `executeContinueWorkflow`
- `src/mcp/handlers/v2-checkpoint.ts` — exported `executeCheckpoint` and `CheckpointError`

### Slice 4: Package export — DONE

- `package.json` — added `exports` field with `./engine` sub-path for `@exaudeus/workrail/engine`

### Slice 5: Integration test — DONE

- `tests/integration/engine-library.test.ts` — 7 tests: factory init, list, start, rehydrate, advance, typed error (not found), typed error (invalid token)

## What the factory does NOT include

- MCP transport or tool registry
- Feature flag checking (v2 is always on)
- Session tools (create/update/read session)
- HTTP server or dashboard
- Signal handling or process lifecycle
- `resolvedRootUris` (MCP-specific)
- `workspaceResolver` (can be added later if needed)

## Testing strategy

1. **Existing tests pass** — the agentRole change must not break any existing tests
2. **Engine integration test** — start + advance + complete a workflow via library API
3. **Output parity** — verify that `engine.startWorkflow(id)` returns equivalent data to `executeStartWorkflow(input, ctx)` (minus MCP wrapping)
4. **Keyring lifecycle** — verify the engine creates/loads keyring correctly on first run and subsequent runs

## Design decisions (resolved)

1. **Engine has `close()` method** — required for resource lifecycle. Currently a no-op since keyring is in-memory and locks are per-operation, but the contract exists for future resource management.
2. **Custom storage adapters** — deferred. The port interfaces exist but the factory doesn't expose them yet. Add when a consumer needs in-memory stores for testing.
3. **`nextCall` excluded from library responses** — it's an MCP agent concept (`{ tool: 'continue_workflow', params: {...} }`). Library consumers call engine methods directly; they don't need tool call templates.
