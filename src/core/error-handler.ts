/**
 * Core error types used across the codebase.
 *
 * This module intentionally does NOT contain JSON-RPC response helpers.
 * Workrail is now MCP (SDK) first, and tool boundary layers should map errors
 * into the appropriate protocol shape.
 */
// -----------------------------------------------------------------------------
// Error Codes (kept for compatibility with existing error classes)
// -----------------------------------------------------------------------------

export enum MCPErrorCodes {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  SERVER_ERROR = -32000,
  WORKFLOW_NOT_FOUND = -32001,
  INVALID_WORKFLOW = -32002,
  STEP_NOT_FOUND = -32003,
  VALIDATION_ERROR = -32004,
  STATE_ERROR = -32005,
  STORAGE_ERROR = -32006,
  SECURITY_ERROR = -32007,
}

// -----------------------------------------------------------------------------
// Error Classes
// -----------------------------------------------------------------------------

export class MCPError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.data = data;
  }
}

export class WorkflowNotFoundError extends MCPError {
  constructor(workflowId: string) {
    super(MCPErrorCodes.WORKFLOW_NOT_FOUND, `Workflow with id '${workflowId}' not found`, { workflowId });
    this.name = 'WorkflowNotFoundError';
  }
}

export class InvalidWorkflowError extends MCPError {
  constructor(workflowId: string, details: string) {
    super(MCPErrorCodes.INVALID_WORKFLOW, `Invalid workflow: ${workflowId}`, { workflowId, details });
    this.name = 'InvalidWorkflowError';
  }
}

export class StepNotFoundError extends MCPError {
  constructor(stepId: string, workflowId?: string) {
    super(MCPErrorCodes.STEP_NOT_FOUND, `Step with id '${stepId}' not found in workflow`, { stepId, workflowId });
    this.name = 'StepNotFoundError';
  }
}

export class ValidationError extends MCPError {
  constructor(message: string, field?: string, details?: unknown) {
    super(MCPErrorCodes.VALIDATION_ERROR, message, { field, details });
    this.name = 'ValidationError';
  }
}

export class StateError extends MCPError {
  constructor(message: string, executionId?: string) {
    super(MCPErrorCodes.STATE_ERROR, message, { executionId });
    this.name = 'StateError';
  }
}

export class StorageError extends MCPError {
  constructor(message: string, operation?: string) {
    super(MCPErrorCodes.STORAGE_ERROR, message, { operation });
    this.name = 'StorageError';
  }
}

export class SecurityError extends MCPError {
  constructor(message: string, action?: string) {
    super(MCPErrorCodes.SECURITY_ERROR, message, { action });
    this.name = 'SecurityError';
  }
}
