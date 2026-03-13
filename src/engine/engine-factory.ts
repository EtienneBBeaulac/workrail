/**
 * WorkRail Library Engine Factory
 *
 * Creates an in-process WorkRail engine without MCP transport.
 * Uses the DI container in library mode (no signal handlers, no HTTP, no MCP).
 *
 * Returns EngineResult — never throws. Keyring init failure is a typed error.
 */

import 'reflect-metadata';
import { initializeContainer, container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { WorkflowService } from '../application/services/workflow-service.js';
import type { WorkflowCompiler } from '../application/services/workflow-compiler.js';
import type { ValidationEngine } from '../application/services/validation-engine.js';
import { unsafeTokenCodecPorts } from '../v2/durable-core/tokens/token-codec-ports.js';
import { validateWorkflowSchema } from '../application/validation.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../v2/read-only/v1-to-v2-shim.js';
import type { V2Dependencies } from '../mcp/types.js';
import type { ToolContext } from '../mcp/types.js';
import { StaticFeatureFlagProvider } from '../config/feature-flags.js';

import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import { executeCheckpoint, type CheckpointError } from '../mcp/handlers/v2-checkpoint.js';

import type { StartWorkflowError, ContinueWorkflowError } from '../mcp/handlers/v2-execution-helpers.js';

import type {
  EngineConfig,
  EngineResult,
  WorkRailEngine,
  StepResponse,
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
} from './types.js';

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
      return { kind: 'validation_failed', message: 'Workflow failed validation' };
    case 'keyring_load_failed':
      return { kind: 'internal_error', message: `Keyring error: ${e.cause.code}` };
    case 'hash_computation_failed':
      return { kind: 'internal_error', message: e.message };
    case 'pinned_workflow_store_failed':
      return { kind: 'storage_error', message: `Pinned store error: ${e.cause.code}` };
    case 'snapshot_creation_failed':
      return { kind: 'storage_error', message: `Snapshot error: ${e.cause.code}` };
    case 'session_append_failed':
      return { kind: 'session_error', message: `Session append error: ${e.cause.code}` };
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
      return { kind: 'validation_failed', message: 'Validation failed' };
    case 'token_decode_failed':
      return { kind: 'token_invalid', message: `Token decode: ${e.cause.code}` };
    case 'token_verify_failed':
      return { kind: 'token_invalid', message: `Token verify: ${e.cause.code}` };
    case 'keyring_load_failed':
      return { kind: 'internal_error', message: `Keyring error: ${e.cause.code}` };
    case 'session_load_failed':
      return { kind: 'session_error', message: `Session load: ${e.cause.code}` };
    case 'snapshot_load_failed':
      return { kind: 'storage_error', message: `Snapshot load: ${e.cause.code}` };
    case 'pinned_workflow_store_failed':
      return { kind: 'storage_error', message: `Pinned store: ${e.cause.code}` };
    case 'pinned_workflow_missing':
      return { kind: 'storage_error', message: `Pinned workflow missing: ${e.workflowHash}` };
    case 'token_signing_failed':
      return { kind: 'token_signing_failed', message: String(e.cause) };
    case 'advance_execution_failed':
      return { kind: 'session_error', message: `Advance failed: ${e.cause.code}` };
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
      return { kind: 'validation_failed', message: 'Checkpoint validation failed' };
    case 'missing_node_or_run':
      return { kind: 'session_error', message: 'Node or run not found in session events' };
    case 'event_schema_invalid':
      return { kind: 'internal_error', message: `Event schema invalid: ${e.issues}` };
    case 'gate_failed':
      return { kind: 'session_error', message: `Gate error: ${e.cause.code}` };
    case 'store_failed':
      return { kind: 'storage_error', message: `Store error: ${e.cause.code}` };
  }
}

// ---------------------------------------------------------------------------
// Response mapping — from MCP output to library types
// ---------------------------------------------------------------------------

function toStepResponse(raw: Record<string, unknown>): StepResponse {
  const base = {
    stateToken: asStateToken(raw.stateToken as string),
    ackToken: raw.ackToken ? asAckToken(raw.ackToken as string) : null,
    checkpointToken: raw.checkpointToken ? asCheckpointToken(raw.checkpointToken as string) : null,
    isComplete: raw.isComplete as boolean,
    preferences: raw.preferences as StepResponse['preferences'],
    nextIntent: raw.nextIntent as StepResponse['nextIntent'],
    pending: raw.pending as StepResponse['pending'],
  };

  if ((raw as { kind?: string }).kind === 'blocked') {
    const blocked = raw as Record<string, unknown>;
    const blockerReport = blocked.blockers as { blockers: readonly { code: string; message: string; suggestedFix?: string }[] } | undefined;
    return {
      kind: 'blocked',
      ...base,
      blockers: blockerReport?.blockers ?? [],
      retryable: Boolean(blocked.retryable),
      retryAckToken: blocked.retryAckToken ? asAckToken(blocked.retryAckToken as string) : null,
    };
  }

  return { kind: 'ok', ...base };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WorkRail engine for in-process use.
 *
 * Returns a typed Result — keyring init failure is reported as an error, not thrown.
 * The caller is responsible for calling engine.close() when done.
 */
export async function createWorkRailEngine(
  config: EngineConfig = {},
): Promise<EngineResult<WorkRailEngine>> {
  // Override data dir if provided
  if (config.dataDir) {
    process.env.WORKRAIL_V2_DATA_DIR = config.dataDir;
  }

  // Initialize container in library mode (no signals, no HTTP)
  await initializeContainer({ runtimeMode: { kind: 'library' } });

  // Resolve core dependencies
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);

  // Build V2Dependencies (same as server.ts createToolContext, minus MCP-specific concerns)
  const gate = container.resolve<any>(DI.V2.ExecutionGate);
  const sessionStore = container.resolve<any>(DI.V2.SessionStore);
  const snapshotStore = container.resolve<any>(DI.V2.SnapshotStore);
  const pinnedStore = container.resolve<any>(DI.V2.PinnedWorkflowStore);
  const keyringPort = container.resolve<any>(DI.V2.Keyring);

  // Keyring init — fail-fast with typed error
  const keyringResult = await keyringPort.loadOrCreate();
  if (keyringResult.isErr()) {
    return engineErr({
      kind: 'internal_error',
      message: `Keyring initialization failed: code=${keyringResult.error.code}, message=${keyringResult.error.message}`,
    });
  }

  const sha256 = container.resolve<any>(DI.V2.Sha256);
  const crypto = container.resolve<any>(DI.V2.Crypto);
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

  const v2: V2Dependencies = {
    gate,
    sessionStore,
    snapshotStore,
    pinnedStore,
    sha256,
    crypto,
    idFactory,
    tokenCodecPorts,
    validationPipelineDeps,
    resolvedRootUris: [],
    workspaceResolver: undefined as any,
    dataDir: container.resolve<any>(DI.V2.DataDir),
    directoryListing: undefined as any,
    sessionSummaryProvider: undefined as any,
  };

  const featureFlags = new StaticFeatureFlagProvider({ v2Tools: true });

  const ctx: ToolContext = {
    workflowService,
    featureFlags,
    sessionManager: null,
    httpServer: null,
    v2,
  };

  // Narrow to V2ToolContext — we know v2 is present
  const v2Ctx = ctx as ToolContext & { v2: V2Dependencies };

  const engine: WorkRailEngine = {
    async startWorkflow(workflowId: string): Promise<EngineResult<StepResponse>> {
      const result = await executeStartWorkflow({ workflowId }, v2Ctx);
      if (result.isErr()) {
        return engineErr(mapStartError(result.error));
      }
      return engineOk(toStepResponse(result.value as unknown as Record<string, unknown>));
    },

    async continueWorkflow(
      stateToken: StateToken,
      ackToken: AckToken | null,
      output?: { readonly notesMarkdown?: string },
    ): Promise<EngineResult<StepResponse>> {
      const intent = ackToken ? 'advance' : 'rehydrate';
      const input = {
        stateToken: stateToken as string,
        ...(ackToken ? { ackToken: ackToken as string } : {}),
        intent: intent as 'advance' | 'rehydrate',
        ...(output ? { output: { notesMarkdown: output.notesMarkdown } } : {}),
      };

      const result = await executeContinueWorkflow(input, v2Ctx);
      if (result.isErr()) {
        return engineErr(mapContinueError(result.error));
      }
      return engineOk(toStepResponse(result.value as unknown as Record<string, unknown>));
    },

    async checkpointWorkflow(
      checkpointToken: CheckpointToken,
    ): Promise<EngineResult<CheckpointResponse>> {
      const result = await executeCheckpoint(
        { checkpointToken: checkpointToken as string },
        v2Ctx,
      );
      if (result.isErr()) {
        return engineErr(mapCheckpointError(result.error));
      }
      const data = result.value;
      return engineOk({
        checkpointNodeId: data.checkpointNodeId,
        stateToken: asStateToken(data.stateToken),
      });
    },

    async listWorkflows(): Promise<EngineResult<WorkflowListResponse>> {
      const summaries = await workflowService.listWorkflowSummaries();
      return engineOk({
        workflows: summaries.map((s) => ({
          workflowId: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
        })),
      });
    },

    async close(): Promise<void> {
      // No persistent resources to release in the current implementation.
      // Keyring is in-memory only after loadOrCreate.
      // Session locks are file-based and released after each operation.
    },
  };

  return engineOk(engine);
}
