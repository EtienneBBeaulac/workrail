/**
 * WorkRail Library Engine Factory
 *
 * Creates an in-process WorkRail engine without MCP transport.
 * Uses the DI container in library mode:
 * - No signal handlers (ThrowingProcessTerminator — embedded library must not kill host process)
 * - No HTTP server or session tools
 * - No MCP tool registry or transport
 *
 * Returns EngineResult — never throws. Keyring init failure is a typed error.
 */

import 'reflect-metadata';
import { initializeContainer, resetContainer, container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { WorkflowService } from '../application/services/workflow-service.js';
import type { WorkflowCompiler } from '../application/services/workflow-compiler.js';
import type { ValidationEngine } from '../application/services/validation-engine.js';
import { unsafeTokenCodecPorts } from '../v2/durable-core/tokens/token-codec-ports.js';
import { validateWorkflowSchema } from '../application/validation.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../v2/read-only/v1-to-v2-shim.js';
import type { V2Dependencies, V2ToolContext } from '../mcp/types.js';
import type { ToolContext } from '../mcp/types.js';
import { StaticFeatureFlagProvider } from '../config/feature-flags.js';
import { LocalDataDirV2 } from '../v2/infra/local/data-dir/index.js';

import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import { executeCheckpoint, type CheckpointError } from '../mcp/handlers/v2-checkpoint.js';

import type { StartWorkflowError, ContinueWorkflowError } from '../mcp/handlers/v2-execution-helpers.js';

import type { z } from 'zod';
import type { V2StartWorkflowOutputSchema, V2ContinueWorkflowOutputSchema } from '../mcp/output-schemas.js';

import type {
  EngineConfig,
  EngineResult,
  WorkRailEngine,
  StepResponse,
  StepResponseOk,
  StepResponseBlocked,
  PendingStep,
  BlockerCode,
  CheckpointResponse,
  WorkflowListResponse,
  StateToken,
  AckToken,
  CheckpointToken,
  EngineError,
} from './types.js';

import {
  engineOk,
  engineErr,
  asStateToken,
  asAckToken,
  asCheckpointToken,
  unwrapToken,
} from './types.js';

// ---------------------------------------------------------------------------
// Safe async boundary — converts thrown exceptions to EngineResult
// ---------------------------------------------------------------------------

/** Wrap a promise that may throw (legacy pre-ResultAsync APIs) into EngineResult. */
async function safeAsync<T>(fn: () => Promise<T>): Promise<EngineResult<T>> {
  try {
    return engineOk(await fn());
  } catch (e) {
    return engineErr({
      kind: 'storage_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Error mapping — from internal handler errors to library EngineError
// ---------------------------------------------------------------------------

function mapStartError(e: StartWorkflowError): EngineError {
  switch (e.kind) {
    case 'workflow_not_found':
      return { kind: 'workflow_not_found', workflowId: e.workflowId };
    case 'workflow_has_no_steps':
      return { kind: 'workflow_has_no_steps', workflowId: e.workflowId };
    case 'workflow_compile_failed':
      return { kind: 'workflow_compile_failed', message: e.message };
    case 'token_signing_failed':
      return { kind: 'token_signing_failed', message: String(e.cause) };
    case 'prompt_render_failed':
      return { kind: 'prompt_render_failed', message: e.message };
    case 'precondition_failed':
      return { kind: 'precondition_failed', message: e.message };
    case 'invariant_violation':
      return { kind: 'internal_error', message: e.message };
    case 'validation_failed':
      return { kind: 'validation_failed', message: e.failure.message };
    case 'keyring_load_failed':
      return { kind: 'internal_error', message: e.cause.message, code: e.cause.code };
    case 'hash_computation_failed':
      return { kind: 'internal_error', message: e.message };
    case 'pinned_workflow_store_failed':
      return { kind: 'storage_error', message: e.cause.message, code: e.cause.code };
    case 'snapshot_creation_failed':
      return { kind: 'storage_error', message: e.cause.message, code: e.cause.code };
    case 'session_append_failed':
      return { kind: 'session_error', message: e.cause.message, code: e.cause.code };
    case 'reference_resolution_failed':
      return { kind: 'internal_error', message: 'WorkRail could not resolve workflow references.' };
  }
}

function mapContinueError(e: ContinueWorkflowError): EngineError {
  switch (e.kind) {
    case 'precondition_failed':
      return { kind: 'precondition_failed', message: e.message };
    case 'token_unknown_node':
      return { kind: 'token_invalid', message: e.message };
    case 'invariant_violation':
      return { kind: 'internal_error', message: e.message };
    case 'validation_failed':
      return { kind: 'validation_failed', message: e.failure.message };
    case 'token_decode_failed':
      return { kind: 'token_invalid', message: e.cause.message, code: e.cause.code };
    case 'token_verify_failed':
      return { kind: 'token_invalid', message: e.cause.message, code: e.cause.code };
    case 'keyring_load_failed':
      return { kind: 'internal_error', message: e.cause.message, code: e.cause.code };
    case 'session_load_failed':
      return { kind: 'session_error', message: e.cause.message, code: e.cause.code };
    case 'snapshot_load_failed':
      return { kind: 'storage_error', message: e.cause.message, code: e.cause.code };
    case 'pinned_workflow_store_failed':
      return { kind: 'storage_error', message: e.cause.message, code: e.cause.code };
    case 'pinned_workflow_missing':
      return { kind: 'storage_error', message: `Pinned workflow missing: ${e.workflowHash}` };
    case 'token_signing_failed':
      return { kind: 'token_signing_failed', message: String(e.cause) };
    case 'advance_execution_failed':
      return { kind: 'session_error', message: e.cause.message, code: e.cause.code };
    case 'prompt_render_failed':
      return { kind: 'prompt_render_failed', message: e.message };
  }
}

function mapCheckpointError(e: CheckpointError): EngineError {
  switch (e.kind) {
    case 'precondition_failed':
      return { kind: 'precondition_failed', message: e.message };
    case 'token_signing_failed':
      return { kind: 'token_signing_failed', message: String(e.cause) };
    case 'validation_failed':
      return { kind: 'validation_failed', message: e.failure.message };
    case 'missing_node_or_run':
      return { kind: 'session_error', message: 'Node or run not found in session events' };
    case 'event_schema_invalid':
      return { kind: 'internal_error', message: `Event schema invalid: ${e.issues}` };
    case 'gate_failed':
      return { kind: 'session_error', message: e.cause.message, code: e.cause.code };
    case 'store_failed':
      return { kind: 'storage_error', message: e.cause.message, code: e.cause.code };
  }
}

// ---------------------------------------------------------------------------
// Response mapping — typed mappers from Zod-validated outputs to library types
// ---------------------------------------------------------------------------

// Zod-inferred output types from the execution functions
type StartOutput = z.infer<typeof V2StartWorkflowOutputSchema>;
type ContinueOutput = z.infer<typeof V2ContinueWorkflowOutputSchema>;

/** Map the pending step shape (shared between start and continue outputs). */
function mapPending(raw: { stepId: string; title: string; prompt: string; agentRole?: string } | null): PendingStep | null {
  if (!raw) return null;
  return {
    stepId: raw.stepId,
    title: raw.title,
    prompt: raw.prompt,
    ...(raw.agentRole ? { agentRole: raw.agentRole } : {}),
  };
}

/** Map start_workflow output (always 'ok' — start cannot produce 'blocked'). */
function mapStartOutput(out: StartOutput): StepResponseOk {
  // The engine library exposes stateToken + ackToken for backward compat.
  // Both map to continueToken under the one-token protocol.
  const ct = out.continueToken ?? '';
  return {
    kind: 'ok',
    stateToken: asStateToken(ct),
    ackToken: asAckToken(ct),
    checkpointToken: out.checkpointToken ? asCheckpointToken(out.checkpointToken) : null,
    isComplete: out.isComplete,
    pending: mapPending(out.pending),
    preferences: out.preferences,
    nextIntent: out.nextIntent,
  };
}

/** Map continue_workflow output (discriminated union: 'ok' | 'blocked'). */
function mapContinueOutput(out: ContinueOutput): StepResponse {
  const ct = out.continueToken ?? '';
  const base = {
    stateToken: asStateToken(ct),
    ackToken: asAckToken(ct),
    checkpointToken: out.checkpointToken ? asCheckpointToken(out.checkpointToken) : null,
    isComplete: out.isComplete,
    pending: mapPending(out.pending),
    preferences: out.preferences,
    nextIntent: out.nextIntent,
  };

  if (out.kind === 'blocked') {
    const blocked: StepResponseBlocked = {
      kind: 'blocked',
      ...base,
      blockers: out.blockers.blockers.map(b => ({
        code: b.code as BlockerCode,
        message: b.message,
        ...(b.suggestedFix ? { suggestedFix: b.suggestedFix } : {}),
      })),
      retryable: out.retryable ?? false,
      retryAckToken: out.retryContinueToken ? asAckToken(out.retryContinueToken) : null,
    };
    return blocked;
  }

  return { kind: 'ok', ...base };
}

// ---------------------------------------------------------------------------
// Singleton guard — one engine per process
// ---------------------------------------------------------------------------

let engineActive = false;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WorkRail engine for in-process use.
 *
 * Returns a typed Result — keyring init failure is reported as an error, not thrown.
 * The caller is responsible for calling engine.close() when done.
 *
 * Constraint: **one engine per process.** The DI container is a global singleton.
 * Creating a second engine without closing the first returns a typed error.
 * Call engine.close() before creating another instance.
 *
 * Error mapping: EngineError collapses internal infrastructure errors into broader
 * categories (storage_error, session_error, internal_error) while preserving the
 * original error `code` for programmatic matching.
 *
 * Library mode behavior:
 * - ThrowingProcessTerminator: prevents embedded library from killing the host process.
 *   If an invariant violation triggers process.exit(), it throws instead — the host
 *   process catches the error rather than dying.
 * - No signal handlers installed (SIGINT/SIGTERM are the host's responsibility).
 * - No HTTP server, no MCP transport, no session tools.
 */
export async function createWorkRailEngine(
  config: EngineConfig = {},
): Promise<EngineResult<WorkRailEngine>> {
  // Guard: only one engine instance at a time (DI container is a global singleton)
  if (engineActive) {
    return engineErr({
      kind: 'precondition_failed',
      message: 'An engine is already active. Call engine.close() before creating another instance.',
    });
  }

  // Initialize container in library mode (no signals, no HTTP)
  await initializeContainer({ runtimeMode: { kind: 'library' } });

  // Override dataDir if custom path provided.
  //
  // Why this is safe: registerV2Services() registers DI.V2.DataDir with
  // instanceCachingFactory (lazy — caches on first resolve, not on register).
  // Re-registering here replaces the factory before anything resolves DataDir.
  // All downstream services (Keyring, SessionStore, SnapshotStore, etc.) resolve
  // DataDir lazily inside their own instanceCachingFactory, so the override
  // propagates to every consumer.
  //
  // Invariant: no code between initializeContainer() and the first
  // container.resolve() below may trigger a transitive DataDir resolve.
  // If that invariant breaks, the override would be silently ignored.
  if (config.dataDir) {
    const customEnv = { ...process.env, WORKRAIL_DATA_DIR: config.dataDir };
    container.register(DI.V2.DataDir, { useValue: new LocalDataDirV2(customEnv) });
  }

  // Resolve core dependencies
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);

  // Build V2Dependencies (same as server.ts createToolContext, minus MCP-specific concerns)
  const gate = container.resolve<any>(DI.V2.ExecutionGate);
  const sessionStore = container.resolve<any>(DI.V2.SessionStore);
  const snapshotStore = container.resolve<any>(DI.V2.SnapshotStore);
  const pinnedStore = container.resolve<any>(DI.V2.PinnedWorkflowStore);
  const keyringPort = container.resolve<any>(DI.V2.Keyring);

  // Keyring init — fail-fast with typed error.
  // On failure, reset the container so the caller can retry.
  const keyringResult = await keyringPort.loadOrCreate();
  if (keyringResult.isErr()) {
    resetContainer();
    return engineErr({
      kind: 'internal_error',
      message: keyringResult.error.message,
      code: keyringResult.error.code,
    });
  }

  const sha256 = container.resolve<any>(DI.V2.Sha256);
  const crypto = container.resolve<any>(DI.V2.Crypto);
  const entropy = container.resolve<any>(DI.V2.RandomEntropy);
  const hmac = container.resolve<any>(DI.V2.HmacSha256);
  const base64url = container.resolve<any>(DI.V2.Base64Url);
  const base32 = container.resolve<any>(DI.V2.Base32);
  const bech32m = container.resolve<any>(DI.V2.Bech32m);
  const idFactory = container.resolve<any>(DI.V2.IdFactory);

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringResult.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

  const validationEngine = container.resolve<ValidationEngine>(DI.Infra.ValidationEngine);
  const compiler = container.resolve<WorkflowCompiler>(DI.Services.WorkflowCompiler);
  const validationPipelineDeps = {
    schemaValidate: validateWorkflowSchema,
    structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler,
    normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
  };

  // Only populate the fields the library execution path actually uses.
  // MCP-only fields (workspaceResolver, directoryListing, sessionSummaryProvider)
  // are omitted — they're optional in V2Dependencies and unused by start/continue/checkpoint.
  const dataDir = container.resolve<any>(DI.V2.DataDir);

  // Resolve the token alias store from DI (same instance as the rest of the container).
  const tokenAliasStore = container.resolve<any>(DI.V2.TokenAliasStore);
  const rememberedRootsStore = container.resolve<any>(DI.V2.RememberedRootsStore);
  const aliasLoadResult = await tokenAliasStore.loadIndex();
  if (aliasLoadResult.isErr()) {
    // Non-fatal: treat as empty index (fresh install, or index file doesn't exist yet).
    // Individual token lookups will simply return null for unknown nonces.
    console.error(`[engine-factory] Token alias index load warning: ${aliasLoadResult.error.message}`);
  }

  const v2: V2Dependencies = {
    gate,
    sessionStore,
    snapshotStore,
    pinnedStore,
    sha256,
    crypto,
    entropy,
    idFactory,
    tokenCodecPorts,
    tokenAliasStore,
    rememberedRootsStore,
    validationPipelineDeps,
    resolvedRootUris: [],
    dataDir,
  };

  const featureFlags = new StaticFeatureFlagProvider({ v2Tools: true });

  const ctx: ToolContext = {
    workflowService,
    featureFlags,
    sessionManager: null,
    httpServer: null,
    v2,
  };

  // Narrow to V2ToolContext — v2 is guaranteed present (just constructed above).
  const v2Ctx = ctx as V2ToolContext;

  engineActive = true;

  const engine: WorkRailEngine = {
    async startWorkflow(workflowId: string): Promise<EngineResult<StepResponse>> {
      const workspacePath = process.cwd();
      const result = await executeStartWorkflow({ workflowId, workspacePath }, v2Ctx);
      if (result.isErr()) {
        return engineErr(mapStartError(result.error));
      }
      return engineOk(mapStartOutput(result.value.response));
    },

    async continueWorkflow(
      stateToken: StateToken,
      ackToken: AckToken | null,
      output?: {
        readonly notesMarkdown?: string;
        readonly artifacts?: readonly unknown[];
      },
      context?: Readonly<Record<string, unknown>>,
    ): Promise<EngineResult<StepResponse>> {
      // The engine layer maps stateToken → continueToken (the branded StateToken
      // now wraps a continue token string from the one-token protocol)
      const intent = ackToken ? 'advance' : 'rehydrate';
      const workspacePath = process.cwd();
      const input = {
        continueToken: unwrapToken(stateToken),
        intent: intent as 'advance' | 'rehydrate',
        ...(intent === 'rehydrate' ? { workspacePath } : {}),
        ...(output ? {
          output: {
            notesMarkdown: output.notesMarkdown,
            ...(output.artifacts?.length ? { artifacts: [...output.artifacts] } : {}),
          },
        } : {}),
        ...(context ? { context } : {}),
      };

      const result = await executeContinueWorkflow(input, v2Ctx);
      if (result.isErr()) {
        return engineErr(mapContinueError(result.error));
      }
      return engineOk(mapContinueOutput(result.value.response));
    },

    async checkpointWorkflow(
      checkpointToken: CheckpointToken,
    ): Promise<EngineResult<CheckpointResponse>> {
      const result = await executeCheckpoint(
        { checkpointToken: unwrapToken(checkpointToken) },
        v2Ctx,
      );
      if (result.isErr()) {
        return engineErr(mapCheckpointError(result.error));
      }
      return engineOk({
        checkpointNodeId: result.value.checkpointNodeId,
        stateToken: asStateToken(result.value.resumeToken),
      });
    },

    async listWorkflows(): Promise<EngineResult<WorkflowListResponse>> {
      // WorkflowService.listWorkflowSummaries() predates the ResultAsync pattern
      // and can throw on corrupt workflow files or filesystem errors.
      // safeAsync converts thrown exceptions to typed EngineResult.
      const result = await safeAsync(() => workflowService.listWorkflowSummaries());
      if (!result.ok) return result;
      return engineOk({
        workflows: result.value.map((s) => ({
          workflowId: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
        })),
      });
    },

    async close(): Promise<void> {
      // Reset the DI container so a subsequent createWorkRailEngine() call
      // gets fresh state (new dataDir, new keyring, etc.).
      // Without this, the global container singleton would be reused,
      // silently ignoring config changes on the next create call.
      resetContainer();
      engineActive = false;
    },
  };

  return engineOk(engine);
}
