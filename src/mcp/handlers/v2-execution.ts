import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ToolContext, ToolResult } from '../types.js';
import { error, success, errNotRetryable, errRetryableAfterMs, detailsSessionHealth } from '../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../v2/tools.js';
import { V2ContinueWorkflowOutputSchema, V2StartWorkflowOutputSchema } from '../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1, EngineStateV1, LoopPathFrameV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asDelimiterSafeIdV1, stepInstanceKeyFromParts } from '../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import {
  assertTokenScopeMatchesState,
  parseTokenV1,
  verifyTokenSignatureV1,
  type ParsedTokenV1,
} from '../../v2/durable-core/tokens/index.js';
import { encodeTokenPayloadV1, signTokenV1 } from '../../v2/durable-core/tokens/index.js';
import { createWorkflow, getStepById } from '../../types/workflow.js';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../v2/ports/pinned-workflow-store.port.js';
import type { HmacSha256PortV2 } from '../../v2/ports/hmac-sha256.port.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import { compileV1WorkflowToPinnedSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';
import { createBundledSource } from '../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import { WorkflowCompiler } from '../../application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../application/services/workflow-interpreter.js';
import type { ExecutionState, LoopFrame } from '../../domain/execution/state.js';
import type { WorkflowEvent } from '../../domain/execution/event.js';
import type { StepInstanceId } from '../../domain/execution/ids.js';

/**
 * v2 Slice 3: token orchestration (`start_workflow` / `continue_workflow`).
 *
 * Locks (see `docs/design/v2-core-design-locks.md`):
 * - Token validation errors use the closed `TOKEN_*` set.
 * - Rehydrate is side-effect-free.
 * - Advance is idempotent and append-capable only under a witness.
 * - Replay is fact-returning (no recompute) and fail-closed on missing recorded facts.
 */

function normalizeTokenErrorMessage(message: string): string {
  // Keep errors deterministic and compact; avoid leaking environment-specific file paths.
  // NOTE: avoid String.prototype.replaceAll to keep compatibility with older TS lib targets.
  return message.split(os.homedir()).join('~');
}

const MAX_CONTEXT_BYTES_V2 = 256 * 1024;

type ContextValidationIssue =
  | { readonly kind: 'not_an_object' }
  | { readonly kind: 'unsupported_value'; readonly path: string; readonly valueType: string }
  | { readonly kind: 'non_finite_number'; readonly path: string; readonly value: string }
  | { readonly kind: 'circular_reference'; readonly path: string }
  | { readonly kind: 'too_deep'; readonly path: string; readonly maxDepth: number };

function validateJsonValueOrIssue(value: unknown, path: string, depth: number, seen: WeakSet<object>): ContextValidationIssue | null {
  if (depth > 64) return { kind: 'too_deep', path, maxDepth: 64 };

  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return null;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      return { kind: 'non_finite_number', path, value: String(value) };
    }
    return null;
  }

  if (t === 'object') {
    if (Array.isArray(value)) {
      if (seen.has(value)) return { kind: 'circular_reference', path };
      seen.add(value);
      for (let i = 0; i < value.length; i++) {
        const child = validateJsonValueOrIssue(value[i], `${path}[${i}]`, depth + 1, seen);
        if (child) return child;
      }
      return null;
    }

    // Plain object
    if (seen.has(value as object)) return { kind: 'circular_reference', path };
    seen.add(value as object);

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = validateJsonValueOrIssue(v, path === '$' ? `$.${k}` : `${path}.${k}`, depth + 1, seen);
      if (child) return child;
    }

    return null;
  }

  return { kind: 'unsupported_value', path, valueType: t };
}

function validateContextBudgetOrError(args: {
  readonly tool: 'start_workflow' | 'continue_workflow';
  readonly context: unknown;
}): ToolFailure | null {
  if (args.context === undefined) return null;

  if (typeof args.context !== 'object' || args.context === null || Array.isArray(args.context)) {
    return errNotRetryable('VALIDATION_ERROR', `context must be a JSON object for ${args.tool}.`, {
      suggestion:
        'Pass context as an object of external inputs (e.g., {"ticketId":"...","repoPath":"..."}). Do not pass arrays or primitives.',
      details: {
        kind: 'context_invalid_shape',
        tool: args.tool,
        expected: 'object',
      },
    }) as ToolFailure;
  }

  const issue = validateJsonValueOrIssue(args.context, '$', 0, new WeakSet());
  if (issue) {
    const detail: JsonValue =
      issue.kind === 'unsupported_value'
        ? { kind: 'context_unsupported_value', tool: args.tool, path: issue.path, valueType: issue.valueType }
        : issue.kind === 'non_finite_number'
          ? { kind: 'context_non_finite_number', tool: args.tool, path: issue.path, value: issue.value }
          : issue.kind === 'circular_reference'
            ? { kind: 'context_circular_reference', tool: args.tool, path: issue.path }
            : issue.kind === 'too_deep'
              ? { kind: 'context_too_deep', tool: args.tool, path: issue.path, maxDepth: issue.maxDepth }
              : { kind: 'context_invalid_shape', tool: args.tool, expected: 'object' };

    return errNotRetryable(
      'VALIDATION_ERROR',
      normalizeTokenErrorMessage(`context is not JSON-serializable for ${args.tool} (see details).`),
      {
        suggestion:
          'Remove non-JSON values (undefined/functions/symbols), circular references, and non-finite numbers. Keep context to plain JSON objects/arrays/primitives only.',
        details: detail,
      }
    ) as ToolFailure;
  }

  const canonicalRes = toCanonicalBytes(args.context as JsonValue);
  if (canonicalRes.isErr()) {
    return errNotRetryable(
      'VALIDATION_ERROR',
      normalizeTokenErrorMessage(`context cannot be canonicalized for ${args.tool}: ${canonicalRes.error.code}`),
      {
        suggestion:
          canonicalRes.error.code === 'CANONICAL_JSON_NON_FINITE_NUMBER'
            ? 'Remove NaN/Infinity/-Infinity from context. Canonical JSON forbids non-finite numbers.'
            : 'Ensure context contains only JSON primitives, arrays, and objects (no undefined/functions/symbols).',
        details: {
          kind: 'context_not_canonical_json',
          tool: args.tool,
          measuredAs: 'jcs_utf8_bytes',
          code: canonicalRes.error.code,
          message: canonicalRes.error.message,
        },
      }
    ) as ToolFailure;
  }

  const measuredBytes = (canonicalRes.value as unknown as Uint8Array).length;
  if (measuredBytes > MAX_CONTEXT_BYTES_V2) {
    return errNotRetryable(
      'VALIDATION_ERROR',
      `context is too large for ${args.tool}: ${measuredBytes} bytes (max ${MAX_CONTEXT_BYTES_V2}). Size is measured as UTF-8 bytes of RFC 8785 (JCS) canonical JSON.`,
      {
        suggestion:
          'Remove large blobs from context (docs/logs/diffs). Pass references instead (file paths, IDs, hashes). If you must include text, include only the minimal excerpt, then retry.',
        details: {
          kind: 'context_budget_exceeded',
          tool: args.tool,
          measuredBytes,
          maxBytes: MAX_CONTEXT_BYTES_V2,
          measuredAs: 'jcs_utf8_bytes',
        },
      }
    ) as ToolFailure;
  }

  return null;
}

function tokenDecodeErrorToToolError(e: { readonly code: string; readonly message: string }): ToolResult<never> {
  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return error(
        'TOKEN_INVALID_FORMAT',
        normalizeTokenErrorMessage(e.message),
        'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.'
      );
    case 'TOKEN_UNSUPPORTED_VERSION':
      return error(
        'TOKEN_UNSUPPORTED_VERSION',
        normalizeTokenErrorMessage(e.message),
        'Update WorkRail to a version that supports this token format.'
      );
    case 'TOKEN_BAD_SIGNATURE':
      return error(
        'TOKEN_BAD_SIGNATURE',
        normalizeTokenErrorMessage(e.message),
        'Token signature verification failed. Use the exact tokens returned by WorkRail.'
      );
    case 'TOKEN_SCOPE_MISMATCH':
      return error(
        'TOKEN_SCOPE_MISMATCH',
        normalizeTokenErrorMessage(e.message),
        'Tokens must come from the same WorkRail response. Do not mix tokens from different runs or nodes.'
      );
    default:
      return error('TOKEN_INVALID_FORMAT', normalizeTokenErrorMessage(e.message), 'Use the exact tokens returned by WorkRail.');
  }
}

type ToolFailure = Extract<ToolResult<unknown>, { readonly type: 'error' }>;

// Typed error discriminators for internal flow control (not exposed to users)
type InternalError = 
  | { readonly kind: 'missing_node_or_run' }
  | { readonly kind: 'workflow_hash_mismatch' }
  | { readonly kind: 'missing_snapshot' }
  | { readonly kind: 'no_pending_step' }
  | { readonly kind: 'advance_apply_failed'; readonly message: string }
  | { readonly kind: 'advance_next_failed'; readonly message: string };

/**
 * Type guard for InternalError discriminated union.
 * Returns true only if `e` is a valid InternalError with known kind.
 */
function isInternalError(e: unknown): e is InternalError {
  if (typeof e !== 'object' || e === null || !('kind' in e)) return false;
  const kind = (e as { kind: unknown }).kind;
  return (
    kind === 'missing_node_or_run' ||
    kind === 'workflow_hash_mismatch' ||
    kind === 'missing_snapshot' ||
    kind === 'no_pending_step' ||
    kind === 'advance_apply_failed' ||
    kind === 'advance_next_failed'
  );
}

/**
 * Map InternalError to ToolError using exhaustive switch.
 * Compile error if new InternalError kind added without handler.
 */
function mapInternalErrorToToolError(e: InternalError): ToolFailure {
  switch (e.kind) {
    case 'missing_node_or_run':
      return errNotRetryable(
        'PRECONDITION_FAILED',
        'No durable run/node state was found for this stateToken. Advancement cannot be recorded.',
        { suggestion: 'Use a stateToken returned by WorkRail for an existing run/node.' }
      ) as ToolFailure;
    case 'workflow_hash_mismatch':
      return errNotRetryable(
        'TOKEN_WORKFLOW_HASH_MISMATCH',
        'workflowHash mismatch for this node.',
        { suggestion: 'Use the stateToken returned by WorkRail for this node.' }
      ) as ToolFailure;
    case 'missing_snapshot':
    case 'no_pending_step':
      return internalError('Incomplete execution state.', 'Retry; if this persists, treat as invariant violation.');
    case 'advance_apply_failed':
    case 'advance_next_failed':
      return internalError(normalizeTokenErrorMessage(e.message), 'Retry; if this persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown internal error kind', 'Treat as invariant violation.');
  }
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}

/**
 * Extract step metadata (title, prompt) from a workflow step with type-safe property access.
 * Returns sealed StepMetadata with guaranteed non-empty strings.
 *
 * @param workflow - The workflow instance
 * @param stepId - The step ID to extract metadata for (can be null for optional cases)
 * @param options - Optional { defaultTitle, defaultPrompt } for fallback values
 */
interface StepMetadata {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
}

function extractStepMetadata(
  workflow: ReturnType<typeof createWorkflow>,
  stepId: string | null,
  options?: { defaultTitle?: string; defaultPrompt?: string }
): StepMetadata {
  const resolvedStepId = stepId ?? '';
  const step = stepId ? getStepById(workflow, stepId) : null;

  // Type guard for object with string property
  const hasStringProp = (obj: unknown, prop: string): boolean =>
    typeof obj === 'object' &&
    obj !== null &&
    prop in obj &&
    typeof (obj as unknown as Record<string, unknown>)[prop] === 'string';

  const title = hasStringProp(step, 'title')
    ? String((step as unknown as Record<string, unknown>).title)
    : options?.defaultTitle ?? resolvedStepId;

  const prompt = hasStringProp(step, 'prompt')
    ? String((step as unknown as Record<string, unknown>).prompt)
    : options?.defaultPrompt ?? (stepId ? `Pending step: ${stepId}` : '');

  return { stepId: resolvedStepId, title, prompt };
}

function internalError(message: string, suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR', normalizeTokenErrorMessage(message), suggestion ? { suggestion } : undefined) as ToolFailure;
}

function sessionStoreErrorToToolError(e: SessionEventLogStoreError): ToolFailure {
  switch (e.code) {
    case 'SESSION_STORE_LOCK_BUSY':
      return errRetryableAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY', `Session corruption detected (${e.location}): ${e.reason.code}`, {
        suggestion: 'Execution requires a healthy session. Export salvage view, then recreate.',
        details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
      }) as ToolFailure;
    case 'SESSION_STORE_IO_ERROR':
      return internalError(e.message, 'Retry; check filesystem permissions.');
    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return internalError(e.message, 'Treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown session store error', 'Treat as invariant violation.');
  }
}

function gateErrorToToolError(e: ExecutionSessionGateErrorV2): ToolFailure {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return errRetryableAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'LOCK_RELEASE_FAILED':
      return errRetryableAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY', e.message, { suggestion: 'Execution requires healthy session.', details: detailsSessionHealth(e.health) as unknown as JsonValue }) as ToolFailure;
    case 'SESSION_LOAD_FAILED':
    case 'SESSION_LOCK_REENTRANT':
    case 'LOCK_ACQUIRE_FAILED':
    case 'GATE_CALLBACK_FAILED':
      return internalError(e.message, 'Retry; if persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown gate error', 'Treat as invariant violation.');
  }
}

function snapshotStoreErrorToToolError(e: SnapshotStoreError, suggestion?: string): ToolFailure {
  return internalError(`Snapshot store error: ${e.message}`, suggestion);
}

function pinnedWorkflowStoreErrorToToolError(e: PinnedWorkflowStoreError, suggestion?: string): ToolFailure {
  return internalError(`Pinned workflow store error: ${e.message}`, suggestion);
}

// Branded token input types (compile-time guarantee of token kind)
type StateTokenInput = ParsedTokenV1 & { readonly payload: import('../../v2/durable-core/tokens/payloads.js').StateTokenPayloadV1 };
type AckTokenInput = ParsedTokenV1 & { readonly payload: import('../../v2/durable-core/tokens/payloads.js').AckTokenPayloadV1 };

function parseStateTokenOrFail(
  raw: string,
  keyring: import('../../v2/ports/keyring.port.js').KeyringV1,
  hmac: HmacSha256PortV2
): { ok: true; token: StateTokenInput } | { ok: false; result: ToolResult<never> } {
  const parsedRes = parseTokenV1(raw);
  if (parsedRes.isErr()) {
    return { ok: false, result: tokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1(parsedRes.value, keyring, hmac);
  if (verified.isErr()) {
    return { ok: false, result: tokenDecodeErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'state') {
    return { ok: false, result: error('TOKEN_INVALID_FORMAT', 'Expected a state token (st.v1.*).', 'Use the stateToken returned by WorkRail.') };
  }

  return { ok: true, token: parsedRes.value as StateTokenInput };
}

function parseAckTokenOrFail(
  raw: string,
  keyring: import('../../v2/ports/keyring.port.js').KeyringV1,
  hmac: HmacSha256PortV2
): { ok: true; token: AckTokenInput } | { ok: false; result: ToolResult<never> } {
  const parsedRes = parseTokenV1(raw);
  if (parsedRes.isErr()) {
    return { ok: false, result: tokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1(parsedRes.value, keyring, hmac);
  if (verified.isErr()) {
    return { ok: false, result: tokenDecodeErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'ack') {
    return { ok: false, result: error('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack.v1.*).', 'Use the ackToken returned by WorkRail.') };
  }

  return { ok: true, token: parsedRes.value as AckTokenInput };
}

function newAttemptId(): string {
  return `attempt_${randomUUID()}`;
}

function attemptIdForNextNode(parentAttemptId: string): string {
  // Deterministic derivation so replay responses can re-mint the same next-node ack/checkpoint tokens.
  return `next_${parentAttemptId}`;
}

function signTokenOrErr(args: {
  unsignedPrefix: 'st.v1.' | 'ack.v1.' | 'chk.v1.';
  payload: unknown;
  keyring: import('../../v2/ports/keyring.port.js').KeyringV1;
  hmac: HmacSha256PortV2;
}): { ok: true; token: string } | { ok: false; error: ToolFailure } {
  const bytes = encodeTokenPayloadV1(args.payload as any /* TYPE SAFETY: unknown → TokenPayloadV1 validated by schema */);
  if (bytes.isErr()) {
    return { ok: false, error: internalError(`Failed to encode token payload: ${bytes.error.code}`, 'Retry; if this persists, treat as invariant violation.') };
  }
  const token = signTokenV1(args.unsignedPrefix, bytes.value as any /* TYPE SAFETY: CanonicalBytes branded type; signTokenV1 expects it */, args.keyring, args.hmac);
  if (token.isErr()) {
    return { ok: false, error: internalError(`Failed to sign token: ${token.error.code}`, 'Retry; if this persists, treat as invariant violation.') };
  }
  return { ok: true, token: String(token.value) };
}

function toV1ExecutionState(engineState: EngineStateV1): ExecutionState {
  if (engineState.kind === 'init') return { kind: 'init' as const };
  if (engineState.kind === 'complete') return { kind: 'complete' as const };

  const pendingStep =
    engineState.pending.kind === 'some'
      ? {
          stepId: String(engineState.pending.step.stepId),
          loopPath: engineState.pending.step.loopPath.map((f: LoopPathFrameV1) => ({
            loopId: String(f.loopId),
            iteration: f.iteration,
          })),
        }
      : undefined;

  return {
    kind: 'running' as const,
    completed: [...engineState.completed.values].map(String),
    loopStack: engineState.loopStack.map((f) => ({
      loopId: String(f.loopId),
      iteration: f.iteration,
      bodyIndex: f.bodyIndex,
    })),
    pendingStep,
  };
}

function convertRunningExecutionStateToEngineState(
  state: Extract<ExecutionState, { kind: 'running' }>
): Extract<EngineStateV1, { kind: 'running' }> {
  const completedArray: readonly string[] = [...state.completed].sort((a: string, b: string) =>
    a.localeCompare(b)
  );
  const completed = completedArray.map(s => stepInstanceKeyFromParts(asDelimiterSafeIdV1(s), []));

  const loopStack = state.loopStack.map((f: LoopFrame) => ({
    loopId: asDelimiterSafeIdV1(f.loopId),
    iteration: f.iteration,
    bodyIndex: f.bodyIndex,
  }));

  const pending = state.pendingStep
    ? {
        kind: 'some' as const,
        step: {
          stepId: asDelimiterSafeIdV1(state.pendingStep.stepId),
          loopPath: state.pendingStep.loopPath.map((p) => ({
            loopId: asDelimiterSafeIdV1(p.loopId),
            iteration: p.iteration,
          })),
        },
      }
    : { kind: 'none' as const };

  return {
    kind: 'running' as const,
    completed: { kind: 'set' as const, values: completed },
    loopStack,
    pending,
  };
}

function fromV1ExecutionState(state: ExecutionState): EngineStateV1 {
  if (state.kind === 'init') {
    return { kind: 'init' as const };
  }
  if (state.kind === 'complete') {
    return { kind: 'complete' as const };
  }
  return convertRunningExecutionStateToEngineState(state);
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  try {
    if (!ctx.v2) {
      return errNotRetryable('PRECONDITION_FAILED', 'v2 tools disabled', { suggestion: 'Enable v2Tools flag' });
    }

    const { gate, sessionStore, snapshotStore, pinnedStore, keyring, crypto, hmac } = ctx.v2;

    const ctxErr = validateContextBudgetOrError({ tool: 'start_workflow', context: input.context });
    if (ctxErr) return ctxErr;

    const workflow = await ctx.workflowService.getWorkflowById(input.workflowId);
    if (!workflow) {
      return error('NOT_FOUND', `Workflow not found: ${input.workflowId}`, 'Use list_workflows to discover available workflows.');
    }

    const firstStep = workflow.definition.steps[0];
    if (!firstStep) {
      return error('PRECONDITION_FAILED', 'Workflow has no steps and cannot be started.', 'Fix the workflow definition (must contain at least one step).');
    }

    // Pin the full v1 workflow definition for determinism (until v2 authoring exists).
    const compiled = compileV1WorkflowToPinnedSnapshot(workflow);
    const workflowHashRes = workflowHashForCompiledSnapshot(compiled as unknown as JsonValue, crypto);
    if (workflowHashRes.isErr()) {
      return error('INTERNAL_ERROR', workflowHashRes.error.message);
    }
    const workflowHash = workflowHashRes.value;
    const existingPinned = await pinnedStore.get(workflowHash).match((v) => v, () => null);
    if (!existingPinned) {
      const putRes = await pinnedStore.put(workflowHash, compiled);
      if (putRes.isErr()) return pinnedWorkflowStoreErrorToToolError(putRes.error, 'Retry start_workflow.');
    }

    // Phase 4 lock: render first pending from the pinned snapshot (not live source) to eliminate TOCTOU.
    const pinnedRes = await pinnedStore.get(workflowHash);
    if (pinnedRes.isErr()) return pinnedWorkflowStoreErrorToToolError(pinnedRes.error, 'Retry start_workflow.');
    const pinned = pinnedRes.value;
    if (!pinned || pinned.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.definition)) {
      return error('INTERNAL_ERROR', 'Failed to pin executable workflow snapshot.', 'Retry start_workflow.');
    }
    const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());

    // Mint identifiers (opaque; not hashed into workflowHash).
    const sessionId = `sess_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const nodeId = `node_${randomUUID()}`;

    // Store an initial execution snapshot with the first step pending.
    const snapshot: ExecutionSnapshotFileV1 = {
      v: 1 as const,
      kind: 'execution_snapshot' as const,
      enginePayload: {
        v: 1 as const,
        engineState: {
          kind: 'running' as const,
          completed: { kind: 'set' as const, values: [] },
          loopStack: [],
          pending: { kind: 'some' as const, step: { stepId: asDelimiterSafeIdV1(firstStep.id), loopPath: [] } },
        },
      },
    };
    const snapshotRefRes = await snapshotStore.putExecutionSnapshotV1(snapshot);
    if (snapshotRefRes.isErr()) return snapshotStoreErrorToToolError(snapshotRefRes.error, 'Retry start_workflow.');
    const snapshotRef = snapshotRefRes.value;

    const evtSessionCreated = `evt_${randomUUID()}`;
    const evtRunStarted = `evt_${randomUUID()}`;
    const evtNodeCreated = `evt_${randomUUID()}`;

    // Persist durable truth under a healthy lock witness.
    const appendRes = await gate
      .withHealthySessionLock(sessionId as any /* TYPE SAFETY: v1 string → v2 SessionId branded boundary */, (lock) => {
        const eventsArray: readonly DomainEventV1[] = [
          {
            v: 1,
            eventId: evtSessionCreated,
            eventIndex: 0,
            sessionId,
            kind: 'session_created' as const,
            dedupeKey: `session_created:${sessionId}`,
            data: {},
          },
          {
            v: 1,
            eventId: evtRunStarted,
            eventIndex: 1,
            sessionId,
            kind: 'run_started' as const,
            dedupeKey: `run_started:${sessionId}:${runId}`,
            scope: { runId },
            data: {
              workflowId: workflow.definition.id,
              workflowHash: String(workflowHash),
              workflowSourceKind:
                workflow.source.kind === 'bundled'
                  ? 'bundled'
                  : workflow.source.kind === 'user'
                    ? 'user'
                    : workflow.source.kind === 'project'
                      ? 'project'
                      : workflow.source.kind === 'remote'
                        ? 'remote'
                        : workflow.source.kind === 'plugin'
                          ? 'plugin'
                          : workflow.source.kind === 'git'
                            ? 'remote'
                            : 'project', // custom directory treated as project-local for v2 store schema
              workflowSourceRef:
                workflow.source.kind === 'user' || workflow.source.kind === 'project' || workflow.source.kind === 'custom'
                  ? workflow.source.directoryPath
                  : workflow.source.kind === 'git'
                    ? `${workflow.source.repositoryUrl}#${workflow.source.branch}`
                    : workflow.source.kind === 'remote'
                      ? workflow.source.registryUrl
                      : workflow.source.kind === 'plugin'
                        ? `${workflow.source.pluginName}@${workflow.source.pluginVersion}`
                        : '(bundled)',
            },
          },
          {
            v: 1,
            eventId: evtNodeCreated,
            eventIndex: 2,
            sessionId,
            kind: 'node_created' as const,
            dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
            scope: { runId, nodeId },
            data: {
              nodeKind: 'step' as const,
              parentNodeId: null,
              workflowHash: String(workflowHash),
              snapshotRef,
            },
          },
        ];
        return sessionStore.append(lock, {
          events: eventsArray,
          snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: evtNodeCreated }],
        });
      })
      .match(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, error: e })
      );
    if (!appendRes.ok) {
      const err: unknown = appendRes.error;
      if (typeof err === 'object' && err !== null && 'code' in err && (err as any /* TYPE SAFETY: runtime discriminator check before union narrowing */).code === 'SESSION_NOT_HEALTHY') {
        return gateErrorToToolError(err as ExecutionSessionGateErrorV2);
      }
      if (typeof err === 'object' && err !== null && 'code' in err) {
        return sessionStoreErrorToToolError(err as SessionEventLogStoreError);
      }
      return internalError(String(err), 'Retry; if this persists, check for filesystem errors.');
    }

    const statePayload = {
      tokenVersion: 1 as const,
      tokenKind: 'state' as const,
      sessionId,
      runId,
      nodeId,
      workflowHash: String(workflowHash),
    };
    const attemptId = newAttemptId();
    const ackPayload = {
      tokenVersion: 1 as const,
      tokenKind: 'ack' as const,
      sessionId,
      runId,
      nodeId,
      attemptId,
    };
    const checkpointPayload = {
      tokenVersion: 1 as const,
      tokenKind: 'checkpoint' as const,
      sessionId,
      runId,
      nodeId,
      attemptId,
    };

    const stateTokenRes = signTokenOrErr({ unsignedPrefix: 'st.v1.', payload: statePayload, keyring, hmac });
    if (!stateTokenRes.ok) return stateTokenRes.error;
    const stateToken = stateTokenRes.token;
    
    const ackTokenRes = signTokenOrErr({ unsignedPrefix: 'ack.v1.', payload: ackPayload, keyring, hmac });
    if (!ackTokenRes.ok) return ackTokenRes.error;
    const ackToken = ackTokenRes.token;
    
    const checkpointTokenRes = signTokenOrErr({ unsignedPrefix: 'chk.v1.', payload: checkpointPayload, keyring, hmac });
    if (!checkpointTokenRes.ok) return checkpointTokenRes.error;
    const checkpointToken = checkpointTokenRes.token;

    // Render first pending from pinned snapshot (Phase 4 lock).
    const { stepId, title, prompt } = extractStepMetadata(pinnedWorkflow, firstStep.id);
    const pending = { stepId, title, prompt };

    const payload = V2StartWorkflowOutputSchema.parse({
      stateToken,
      ackToken,
      checkpointToken,
      isComplete: false,
      pending,
    });
    return success(payload);
  } catch (e) {
    return error(
      'INTERNAL_ERROR',
      normalizeTokenErrorMessage(e instanceof Error ? e.message : String(e)),
      'Retry; if this persists, delete the WorkRail v2 data directory for this repo and retry.'
    );
  }
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  // Slice 3.2: validate tokens and scope at the boundary even before orchestration exists.
  // This prevents agents from "training" on incorrect payload shapes and catches copy/paste corruption early.
  try {
    if (!ctx.v2) {
      return errNotRetryable('PRECONDITION_FAILED', 'v2 tools disabled', { suggestion: 'Enable v2Tools flag' });
    }

    const { gate, sessionStore, snapshotStore, pinnedStore, keyring, crypto, hmac } = ctx.v2;

    const state = parseStateTokenOrFail(input.stateToken, keyring, hmac);
    if (!state.ok) return state.result;

    if (!input.ackToken) {
      // Slice 3.3: rehydrate-only path (must be side-effect-free).
      const sessionId = state.token.payload.sessionId;
      const runId = state.token.payload.runId;
      const nodeId = state.token.payload.nodeId;
      const workflowHash = state.token.payload.workflowHash;

      const truthRes = await sessionStore.load(sessionId);
      if (truthRes.isErr()) return sessionStoreErrorToToolError(truthRes.error);
      const truth = truthRes.value;

      const runStarted = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === 'run_started' && e.scope.runId === String(runId)
      );
      const workflowId = runStarted?.data.workflowId;
      if (!runStarted || typeof workflowId !== 'string' || workflowId.trim() === '') {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No durable run state was found for this stateToken (missing run_started).',
          'Use start_workflow to mint a new run, or use a stateToken returned by WorkRail for an existing run.'
        );
      }
      if (String(runStarted.data.workflowHash) !== String(workflowHash)) {
        return error(
          'TOKEN_WORKFLOW_HASH_MISMATCH',
          'workflowHash mismatch for this run.',
          'Use the stateToken returned by WorkRail for this run.'
        );
      }

      const nodeCreated = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
          e.kind === 'node_created' && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
      );
      if (!nodeCreated) {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No durable node state was found for this stateToken (missing node_created).',
          'Use a stateToken returned by WorkRail for an existing node.'
        );
      }
      if (String(nodeCreated.data.workflowHash) !== String(workflowHash)) {
        return error(
          'TOKEN_WORKFLOW_HASH_MISMATCH',
          'workflowHash mismatch for this node.',
          'Use the stateToken returned by WorkRail for this node.'
        );
      }

      const snapshotRef = nodeCreated.data.snapshotRef;
      const snapshotRes = await snapshotStore.getExecutionSnapshotV1(snapshotRef);
      if (snapshotRes.isErr()) return snapshotStoreErrorToToolError(snapshotRes.error);
      const snapshot = snapshotRes.value;
      if (!snapshot) {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No execution snapshot was found for this node.',
          'Use a stateToken returned by WorkRail for an existing node.'
        );
      }

      const engineState = snapshot.enginePayload.engineState;
      const pending = derivePendingStep(engineState);
      const isComplete = deriveIsComplete(engineState);

      const attemptId = newAttemptId();
      const ackTokenRes = signTokenOrErr({
        unsignedPrefix: 'ack.v1.',
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId, attemptId },
        keyring,
        hmac,
      });
      if (!ackTokenRes.ok) return ackTokenRes.error;
      const ackToken = ackTokenRes.token;
      
      const checkpointTokenRes = signTokenOrErr({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        keyring,
        hmac,
      });
      if (!checkpointTokenRes.ok) return checkpointTokenRes.error;
      const checkpointToken = checkpointTokenRes.token;

      if (!pending) {
        const payload = V2ContinueWorkflowOutputSchema.parse({
          kind: 'ok',
          stateToken: input.stateToken,
          ackToken,
          checkpointToken,
          isComplete,
          pending: null,
        });
        return success(payload);
      }

      const pinnedRes = await pinnedStore.get(workflowHash);
      if (pinnedRes.isErr()) return pinnedWorkflowStoreErrorToToolError(pinnedRes.error);
      const pinned = pinnedRes.value;
      if (!pinned) {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is missing for this run.', 'Re-run start_workflow or re-pin the workflow via inspect_workflow.');
      }
      if (pinned.sourceKind !== 'v1_pinned') {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.', 'Re-run start_workflow to pin an executable snapshot.');
      }
      if (!hasWorkflowDefinitionShape(pinned.definition)) {
        return error('INTERNAL_ERROR', 'Pinned workflow snapshot has an invalid workflow definition shape.', 'Re-pin the workflow.');
      }
      const wf = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());

      const { stepId, title, prompt } = extractStepMetadata(wf, String(pending.stepId));

      const payload = V2ContinueWorkflowOutputSchema.parse({
        kind: 'ok',
        stateToken: input.stateToken,
        ackToken,
        checkpointToken,
        isComplete,
        pending: {
          stepId,
          title,
          prompt,
        },
      });
      return success(payload);
    }

    // Ack-token path: Slice 3.4 (advance/replay): record an idempotent, fact-returning blocked outcome for now.
    // This is the minimal durable "advance_recorded" path that enables replay semantics without requiring full step selection yet.
    {
      const ack = parseAckTokenOrFail(input.ackToken, keyring, hmac);
      if (!ack.ok) return ack.result;

      const scope = assertTokenScopeMatchesState(state.token, ack.token);
      if (scope.isErr()) {
        return tokenDecodeErrorToToolError(scope.error);
      }

      const sessionId = state.token.payload.sessionId;
      const runId = state.token.payload.runId;
      const nodeId = state.token.payload.nodeId;
      const attemptId = ack.token.payload.attemptId;
      const workflowHash = state.token.payload.workflowHash;

      const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

      const compiled = await pinnedStore.get(workflowHash).match((v) => v, () => null);
      if (!compiled) {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is missing for this run.', 'Re-run start_workflow or re-pin via inspect_workflow.');
      }
      if (compiled.sourceKind !== 'v1_pinned') {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.', 'Re-run start_workflow to pin an executable snapshot.');
      }
      if (!hasWorkflowDefinitionShape(compiled.definition)) {
        return error('INTERNAL_ERROR', 'Pinned workflow snapshot has invalid definition shape.', 'Re-pin the workflow via start_workflow.');
      }

      const pinnedWorkflow = createWorkflow(compiled.definition as WorkflowDefinition, createBundledSource());
      const compiler = new WorkflowCompiler();
      const interpreter = new WorkflowInterpreter();
      const compiledWf = compiler.compile(pinnedWorkflow);
      if (compiledWf.isErr()) {
        return error('INTERNAL_ERROR', compiledWf.error.message);
      }

      const appendRes = await gate
        .withHealthySessionLock(sessionId, (lock) => {
          // NOTE: do all reads and "already recorded?" checks under the lock to keep behavior deterministic.
          return sessionStore.load(sessionId).andThen((truth) => {
            // Enforce invariants: do not record advance attempts for unknown nodes.
            const hasRun = truth.events.some((e) => e.kind === 'run_started' && e.scope?.runId === String(runId));
            const hasNode = truth.events.some(
              (e) => e.kind === 'node_created' && e.scope?.runId === String(runId) && e.scope?.nodeId === String(nodeId)
            );
            if (!hasRun || !hasNode) {
              // No append: treat as precondition failure.
              return errAsync({ kind: 'missing_node_or_run' } as const);
            }

            const existing = truth.events.find((e) => e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey);
            if (existing) {
              // Idempotent replay: store.append would no-op too, but we can short-circuit.
              return okAsync(undefined);
            }

            // Load current node snapshot to compute next state.
            const nodeCreated = truth.events.find(
              (e): e is Extract<DomainEventV1, { kind: 'node_created' }> => e.kind === 'node_created' && e.scope?.nodeId === String(nodeId)
            );
            if (!nodeCreated) {
              return errAsync({ kind: 'missing_node_or_run' } as const);
            }
            if (String(nodeCreated.data.workflowHash) !== String(workflowHash)) {
              return errAsync({ kind: 'workflow_hash_mismatch' } as const);
            }

            // Snapshot load is outside the append plan, but still within the lock to keep behavior coherent.
            return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef).andThen((snap) => {
              if (!snap) return errAsync({ kind: 'missing_snapshot' } as const);
              const currentState = toV1ExecutionState(snap.enginePayload.engineState);
              const pendingStep = (currentState.kind === 'running' && currentState.pendingStep) ? currentState.pendingStep : null;
              if (!pendingStep) {
                return errAsync({ kind: 'no_pending_step' } as const);
              }
              const event: WorkflowEvent = { kind: 'step_completed', stepInstanceId: pendingStep };
              const advanced = interpreter.applyEvent(currentState, event);
              if (advanced.isErr()) {
                return errAsync({ kind: 'advance_apply_failed', message: advanced.error.message } as const);
              }
              const nextRes = interpreter.next(compiledWf.value, advanced.value, input.context ?? {});
              if (nextRes.isErr()) {
                return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
              }

              const out = nextRes.value;
              const newEngineState = fromV1ExecutionState(out.state);
              const snapshotFile: ExecutionSnapshotFileV1 = {
                v: 1,
                kind: 'execution_snapshot',
                enginePayload: { v: 1, engineState: newEngineState },
              };

              return snapshotStore.putExecutionSnapshotV1(snapshotFile).andThen((newSnapshotRef) => {
                const toNodeId = `node_${randomUUID()}`;
                const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;

                const evtAdvanceRecorded = `evt_${randomUUID()}`;
                const evtNodeCreated = `evt_${randomUUID()}`;
                const evtEdgeCreated = `evt_${randomUUID()}`;

                const hasChildren = truth.events.some(
                  (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
                    e.kind === 'edge_created' && e.data.fromNodeId === String(nodeId)
                );
                const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';

                const baseEvents: readonly DomainEventV1[] = [
                  {
                    v: 1,
                    eventId: evtAdvanceRecorded,
                    eventIndex: nextEventIndex,
                    sessionId,
                    kind: 'advance_recorded' as const,
                    dedupeKey,
                    scope: { runId, nodeId },
                    data: {
                      attemptId,
                      intent: 'ack_pending' as const,
                      outcome: { kind: 'advanced' as const, toNodeId },
                    },
                  },
                  {
                    v: 1,
                    eventId: evtNodeCreated,
                    eventIndex: nextEventIndex + 1,
                    sessionId,
                    kind: 'node_created' as const,
                    dedupeKey: `node_created:${sessionId}:${runId}:${toNodeId}`,
                    scope: { runId, nodeId: toNodeId },
                    data: { nodeKind: 'step' as const, parentNodeId: String(nodeId), workflowHash: String(workflowHash), snapshotRef: newSnapshotRef },
                  },
                  {
                    v: 1,
                    eventId: evtEdgeCreated,
                    eventIndex: nextEventIndex + 2,
                    sessionId,
                    kind: 'edge_created' as const,
                    dedupeKey: `edge_created:${sessionId}:${runId}:${String(nodeId)}->${toNodeId}:acked_step`,
                    scope: { runId },
                    data: {
                      edgeKind: 'acked_step' as const,
                      fromNodeId: String(nodeId),
                      toNodeId,
                      cause: { kind: causeKind, eventId: evtAdvanceRecorded },
                    },
                  },
                ];

                // Output persistence (single durable write path): if input.output exists, append node_output_appended.
                // Lock: output is attached to the CURRENT node (nodeId), not the newly created node (toNodeId).
                // The agent provides output as part of completing the current step.
                const events: readonly DomainEventV1[] = input.output?.notesMarkdown
                  ? [
                      ...baseEvents,
                      {
                        v: 1,
                        eventId: `evt_${randomUUID()}`,
                        eventIndex: nextEventIndex + 3,
                        sessionId,
                        kind: 'node_output_appended' as const,
                        dedupeKey: `node_output_appended:${sessionId}:out_recap_${String(attemptId)}`,
                        scope: { runId, nodeId }, // CORRECTED: attach to current node, not toNodeId
                        data: {
                          outputId: `out_recap_${String(attemptId)}`,
                          outputChannel: 'recap' as const,
                          payload: {
                            payloadKind: 'notes' as const,
                            notesMarkdown: input.output.notesMarkdown.slice(0, 4096), // locked budget
                          },
                        },
                      },
                    ]
                  : baseEvents;

                return sessionStore.append(lock, {
                  events,
                  snapshotPins: [{ snapshotRef: newSnapshotRef, eventIndex: nextEventIndex + 1, createdByEventId: evtNodeCreated }],
                });
              });
            });
          });
        })
        .match(
          () => ({ ok: true as const }),
          (e) => ({ ok: false as const, error: e })
        );

      if (!appendRes.ok) {
        const err = appendRes.error;
        
        if (isInternalError(err)) {
          return mapInternalErrorToToolError(err);
        }
        if ('code' in err && err.code === 'SESSION_NOT_HEALTHY') {
          return gateErrorToToolError(err as ExecutionSessionGateErrorV2);
        }
        if ('code' in err) {
          return sessionStoreErrorToToolError(err as SessionEventLogStoreError);
        }
        
        return internalError(String(err), 'Retry; if this persists, check for another WorkRail process.');
      }

      // Fact-returning response: load recorded outcome and return from durable facts.
      const truth2Res = await sessionStore.load(sessionId);
      if (truth2Res.isErr()) return sessionStoreErrorToToolError(truth2Res.error);
      const truth2 = truth2Res.value;
      const recordedEvent = truth2.events.find((e) => e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey);
      if (!recordedEvent || recordedEvent.kind !== 'advance_recorded') {
        return error('INTERNAL_ERROR', 'Missing recorded advance outcome for ack replay.', 'Retry; if this persists, treat as invariant violation.');
      }

      const checkpointTokenRes = signTokenOrErr({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        keyring,
        hmac,
      });
      if (!checkpointTokenRes.ok) return checkpointTokenRes.error;
      const checkpointToken = checkpointTokenRes.token;

      if (recordedEvent.data.outcome.kind === 'blocked') {
        const snapNode = truth2.events.find(
          (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
            e.kind === 'node_created' && e.scope?.nodeId === String(nodeId)
        );
        const snap = snapNode
          ? await snapshotStore.getExecutionSnapshotV1(snapNode.data.snapshotRef).match((v) => v, () => null)
          : null;
        const pendingNow = snap ? derivePendingStep(snap.enginePayload.engineState) : null;
        const isCompleteNow = snap ? deriveIsComplete(snap.enginePayload.engineState) : false;
        const payload = V2ContinueWorkflowOutputSchema.parse({
          kind: 'blocked',
          stateToken: input.stateToken,
          ackToken: input.ackToken,
          checkpointToken,
          isComplete: isCompleteNow,
          pending: pendingNow ? { stepId: String(pendingNow.stepId), title: String(pendingNow.stepId), prompt: `Pending step: ${String(pendingNow.stepId)}` } : null,
          blockers: recordedEvent.data.outcome.blockers,
        });
        return success(payload);
      }

      const toNodeId = recordedEvent.data.outcome.toNodeId;
      const toNode = truth2.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
          e.kind === 'node_created' && e.scope?.nodeId === String(toNodeId)
      );
      if (!toNode) {
        return error('INTERNAL_ERROR', 'Missing node_created for advanced toNodeId.', 'Treat as invariant violation.');
      }

      const snapRes = await snapshotStore.getExecutionSnapshotV1(toNode.data.snapshotRef);
      if (snapRes.isErr()) return snapshotStoreErrorToToolError(snapRes.error);
      const snap = snapRes.value;
      if (!snap) return error('INTERNAL_ERROR', 'Missing execution snapshot for advanced node.', 'Treat as invariant violation.');

      const pending = derivePendingStep(snap.enginePayload.engineState);
      const isComplete = deriveIsComplete(snap.enginePayload.engineState);

      const nextAttemptId = attemptIdForNextNode(String(attemptId));
      const nextAckTokenRes = signTokenOrErr({
        unsignedPrefix: 'ack.v1.',
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId: toNodeId, attemptId: nextAttemptId },
        keyring,
        hmac,
      });
      if (!nextAckTokenRes.ok) return nextAckTokenRes.error;
      const nextAckToken = nextAckTokenRes.token;
      
      const nextCheckpointTokenRes = signTokenOrErr({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId: toNodeId, attemptId: nextAttemptId },
        keyring,
        hmac,
      });
      if (!nextCheckpointTokenRes.ok) return nextCheckpointTokenRes.error;
      const nextCheckpointToken = nextCheckpointTokenRes.token;
      
      const nextStateTokenRes = signTokenOrErr({
        unsignedPrefix: 'st.v1.',
        payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId: toNodeId, workflowHash: String(workflowHash) },
        keyring,
        hmac,
      });
      if (!nextStateTokenRes.ok) return nextStateTokenRes.error;
      const nextStateToken = nextStateTokenRes.token;

      const { stepId, title, prompt } = extractStepMetadata(pinnedWorkflow, pending ? String(pending.stepId) : null);

      const payload = V2ContinueWorkflowOutputSchema.parse({
        kind: 'ok',
        stateToken: nextStateToken,
        ackToken: nextAckToken,
        checkpointToken: nextCheckpointToken,
        isComplete,
        pending: stepId ? { stepId, title, prompt } : null,
      });
      return success(payload);
    }
  } catch (e) {
    return error(
      'INTERNAL_ERROR',
      normalizeTokenErrorMessage(e instanceof Error ? e.message : String(e)),
      'If this persists, delete the WorkRail v2 data directory for this repo and retry.'
    );
  }

  return error('INTERNAL_ERROR', 'Unreachable', 'Internal invariant violation');
}