/**
 * MCP Tool Types
 *
 * Defines the core types for tool handlers:
 * - ToolResult<T>: Discriminated union for handler returns
 * - ErrorCode: Categorized error types
 * - ToolContext: Dependencies injected into handlers
 */

import type { WorkflowService } from '../application/services/workflow-service.js';
import type { IFeatureFlagProvider } from '../config/feature-flags.js';
import type { SessionManager } from '../infrastructure/session/SessionManager.js';
import type { HttpServer } from '../infrastructure/session/HttpServer.js';
import type { SessionHealthV2 } from '../v2/durable-core/schemas/session/session-health.js';
import type { ExecutionSessionGateV2 } from '../v2/usecases/execution-session-gate.js';
import type { 
  SessionEventLogAppendStorePortV2,
  SessionEventLogReadonlyStorePortV2 
} from '../v2/ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2 } from '../v2/ports/pinned-workflow-store.port.js';
import type { KeyringV1 } from '../v2/ports/keyring.port.js';

// -----------------------------------------------------------------------------
// JSON-safe details payload (prevents undefined / functions leaking across boundary)
// -----------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Session health details for SESSION_NOT_HEALTHY errors.
 * Contains comprehensive health classification and reason codes.
 */
export interface SessionHealthDetails {
  readonly health: SessionHealthV2;
}

// -----------------------------------------------------------------------------
// Error Codes
// -----------------------------------------------------------------------------

/**
 * Categorized error codes for tool failures.
 * Used for logging, metrics, and client-side error handling.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'     // Bad input from client
  | 'NOT_FOUND'            // Requested resource doesn't exist
  | 'PRECONDITION_FAILED'  // Feature disabled, missing dependency, etc.
  | 'TIMEOUT'              // Operation timed out
  | 'INTERNAL_ERROR'       // Unexpected failure
  // v2 execution (locked token error codes)
  | 'TOKEN_INVALID_FORMAT'
  | 'TOKEN_UNSUPPORTED_VERSION'
  | 'TOKEN_BAD_SIGNATURE'
  | 'TOKEN_SCOPE_MISMATCH'
  | 'TOKEN_UNKNOWN_NODE'
  | 'TOKEN_WORKFLOW_HASH_MISMATCH'
  | 'TOKEN_SESSION_LOCKED'
  | 'SESSION_NOT_HEALTHY';

export type ToolRetry =
  | { readonly kind: 'not_retryable' }
  | { readonly kind: 'retryable_immediate' }
  | { readonly kind: 'retryable_after_ms'; readonly afterMs: number };

// -----------------------------------------------------------------------------
// Tool Result
// -----------------------------------------------------------------------------

/**
 * Success result from a tool handler.
 */
export interface ToolSuccess<T> {
  readonly type: 'success';
  readonly data: T;
}

/**
 * Error result from a tool handler.
 */
export interface ToolError {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
  readonly suggestion?: string;
  readonly retry: ToolRetry;
  readonly details?: JsonValue;
}

/**
 * Discriminated union for tool handler results.
 *
 * Handlers return this type, and the boundary layer converts to MCP format.
 * This keeps handlers pure and testable without MCP SDK dependencies.
 */
export type ToolResult<T> = ToolSuccess<T> | ToolError;

// -----------------------------------------------------------------------------
// Result Constructors
// -----------------------------------------------------------------------------

/**
 * Create a success result.
 */
export const success = <T>(data: T): ToolResult<T> => ({
  type: 'success',
  data,
});

/**
 * Create an error result.
 */
export const error = (
  code: ErrorCode,
  message: string,
  suggestion?: string,
  retry?: ToolRetry,
  details?: JsonValue
): ToolResult<never> => ({
  type: 'error',
  code,
  message,
  suggestion,
  retry: retry ?? { kind: 'not_retryable' },
  ...(details !== undefined ? { details } : {}),
});

export type ToolErrorOptions = Readonly<{
  suggestion?: string;
  details?: JsonValue;
}>;

export function errNotRetryable(
  code: ErrorCode,
  message: string,
  options?: ToolErrorOptions
): ToolResult<never> {
  return error(code, message, options?.suggestion, { kind: 'not_retryable' }, options?.details);
}

export function errRetryableImmediate(
  code: ErrorCode,
  message: string,
  options?: ToolErrorOptions
): ToolResult<never> {
  return error(code, message, options?.suggestion, { kind: 'retryable_immediate' }, options?.details);
}

export function errRetryableAfterMs(
  code: ErrorCode,
  message: string,
  afterMs: number,
  options?: ToolErrorOptions
): ToolResult<never> {
  return error(code, message, options?.suggestion, { kind: 'retryable_after_ms', afterMs }, options?.details);
}

/**
 * Create SessionHealthDetails for SESSION_NOT_HEALTHY errors.
 */
export function detailsSessionHealth(health: SessionHealthV2): SessionHealthDetails {
  return { health };
}

// -----------------------------------------------------------------------------
// V2 Dependencies (bounded context for append-only truth + token execution)
// -----------------------------------------------------------------------------

/**
 * v2 bounded context dependencies (injected when v2Tools flag is enabled).
 * 
 * v2 represents WorkRail's rewrite to make workflows deterministic and rewind-safe
 * via append-only event logs, opaque token-based execution, and pinned workflow snapshots.
 */
export interface V2Dependencies {
  readonly gate: ExecutionSessionGateV2;
  readonly sessionStore: SessionEventLogAppendStorePortV2 & SessionEventLogReadonlyStorePortV2;
  readonly snapshotStore: SnapshotStorePortV2;
  readonly pinnedStore: PinnedWorkflowStorePortV2;
  readonly keyring: KeyringV1;
}

// -----------------------------------------------------------------------------
// Tool Context
// -----------------------------------------------------------------------------

/**
 * Dependencies injected into tool handlers.
 *
 * Handlers receive this context instead of accessing globals or DI directly.
 * This makes handlers pure functions that are easy to test.
 */
export interface ToolContext {
  readonly workflowService: WorkflowService;
  readonly featureFlags: IFeatureFlagProvider;
  // Session-related dependencies are null when session tools are disabled
  readonly sessionManager: SessionManager | null;
  readonly httpServer: HttpServer | null;
  // v2 dependencies are null when v2Tools flag is disabled
  readonly v2: V2Dependencies | null;
}

// -----------------------------------------------------------------------------
// Handler Type
// -----------------------------------------------------------------------------

/**
 * Type for a tool handler function.
 *
 * Takes typed input and context, returns a ToolResult.
 * Handlers should be pure functions with no side effects beyond the result.
 */
export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  ctx: ToolContext
) => Promise<ToolResult<TOutput>>;
