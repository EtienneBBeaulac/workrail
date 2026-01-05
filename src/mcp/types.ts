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
import type { Sha256PortV2 } from '../v2/ports/sha256.port.js';
import type { CryptoPortV2 } from '../v2/durable-core/canonical/hashing.js';
import type { HmacSha256PortV2 } from '../v2/ports/hmac-sha256.port.js';
import type { Base64UrlPortV2 } from '../v2/ports/base64url.port.js';
import type { IdFactoryV2 } from '../v2/infra/local/id-factory/index.js';
import type { JsonValue } from './output-schemas.js';

// Note: JsonValue type is imported from output-schemas.js above

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
 * 
 * Unified envelope (v2 lock compliance):
 * - code: closed-set error code
 * - message: human-readable description
 * - retry: always present; indicates retryability
 * - details: optional structured data (validation errors, templates, etc.)
 */
export interface ToolError {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
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
 * Create a non-retryable error.
 */
export const errNotRetryable = (
  code: ErrorCode,
  message: string,
  details?: JsonValue
): ToolError => ({
  type: 'error',
  code,
  message,
  retry: { kind: 'not_retryable' },
  details,
});

/**
 * Create a retryable error with delay.
 */
export const errRetryAfterMs = (
  code: ErrorCode,
  message: string,
  afterMs: number,
  details?: JsonValue
): ToolError => ({
  type: 'error',
  code,
  message,
  retry: { kind: 'retryable_after_ms', afterMs },
  details,
});

/**
 * Create an immediately retryable error.
 */
export const errRetryImmediate = (
  code: ErrorCode,
  message: string,
  details?: JsonValue
): ToolError => ({
  type: 'error',
  code,
  message,
  retry: { kind: 'retryable_immediate' },
  details,
});

/**
 * Create an error result.
 * 
 * @deprecated Use errNotRetryable, errRetryAfterMs, or errRetryImmediate for explicit retry semantics.
 */
export const error = (
  code: ErrorCode,
  message: string,
  suggestion?: string,
  retry?: ToolRetry
): ToolError => ({
  type: 'error',
  code,
  message,
  retry: retry ?? { kind: 'not_retryable' },
  details: suggestion ? { suggestion } : undefined,
});

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
  readonly sha256: Sha256PortV2;
  readonly crypto: CryptoPortV2;
  readonly hmac: HmacSha256PortV2;
  readonly base64url: Base64UrlPortV2;
  readonly base32: import('../v2/ports/base32.port.js').Base32PortV2;
  readonly bech32m: import('../v2/ports/bech32m.port.js').Bech32mPortV2;
  readonly idFactory: IdFactoryV2;
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
