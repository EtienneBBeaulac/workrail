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
  | 'INTERNAL_ERROR';      // Unexpected failure

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
  suggestion?: string
): ToolResult<never> => ({
  type: 'error',
  code,
  message,
  suggestion,
});

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
