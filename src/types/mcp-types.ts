// MCP Protocol Type Definitions
// Model Context Protocol (MCP) specification types

// =============================================================================
// RE-EXPORT WORKFLOW TYPES FROM CANONICAL SOURCE
// =============================================================================

// These are the canonical workflow types - import from here for MCP handlers
export {
  // Core types
  Workflow,
  WorkflowSummary,
  WorkflowSourceInfo,
  
  // Definition types (what's in JSON files)
  WorkflowDefinition,
  WorkflowStepDefinition,
  LoopStepDefinition,
  LoopConfigDefinition,
  FunctionDefinition,
  FunctionParameter,
  FunctionCall,
  
  // Source types
  WorkflowSource,
  WorkflowSourceKind,
  
  // Factory functions
  createWorkflow,
  toWorkflowSummary,
  toWorkflowSourceInfo,
  
  // Type guards
  isWorkflow,
  isWorkflowDefinition,
  isLoopStepDefinition,
  isWorkflowStepDefinition,
  
  // Convenience accessors
  getStepById,
  getAllStepIds
} from './workflow';

// Legacy alias for backward compatibility
export type WorkflowStep = import('./workflow').WorkflowStepDefinition;

// =============================================================================
// JSON-RPC 2.0 BASE TYPES
// =============================================================================

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

// =============================================================================
// MCP PROTOCOL TYPES
// =============================================================================

export interface MCPInitializeRequest extends JSONRPCRequest {
  method: "initialize";
  params: {
    protocolVersion: string;
    capabilities: {
      tools?: Record<string, unknown>;
      resources?: Record<string, unknown>;
    };
    clientInfo?: {
      name: string;
      version: string;
    };
  };
}

export interface MCPInitializeResponse extends JSONRPCResponse {
  result: {
    protocolVersion: string;
    capabilities: {
      tools: {
        listChanged?: boolean;
        notifyProgress?: boolean;
      };
      resources: {
        listChanged?: boolean;
      };
    };
    serverInfo: {
      name: string;
      version: string;
      description: string;
    };
  };
}

export interface MCPToolsListRequest extends JSONRPCRequest {
  method: "tools/list";
  params: Record<string, never>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  };
}

export interface MCPToolsListResponse extends JSONRPCResponse {
  result: {
    tools: MCPTool[];
  };
}

export interface MCPToolCallRequest extends JSONRPCRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface MCPToolCallResponse extends JSONRPCResponse {
  result: unknown;
}

export interface MCPShutdownRequest extends JSONRPCRequest {
  method: "shutdown";
  params: Record<string, never>;
}

export interface MCPShutdownResponse extends JSONRPCResponse {
  result: null;
}

// =============================================================================
// MCP ERROR CODES
// =============================================================================

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

// =============================================================================
// WORKFLOW ORCHESTRATION REQUEST/RESPONSE TYPES
// =============================================================================

export interface WorkflowListRequest extends MCPToolCallRequest {
  method: "workflow_list";
  params: Record<string, never>;
}

export interface WorkflowListResponse extends MCPToolCallResponse {
  result: {
    workflows: import('./workflow').WorkflowSummary[];
  };
}

export interface WorkflowGetRequest extends MCPToolCallRequest {
  method: "workflow_get";
  params: {
    id: string;
  };
}

export interface WorkflowGetResponse extends MCPToolCallResponse {
  result: import('./workflow').Workflow;
}

export interface WorkflowNextRequest extends MCPToolCallRequest {
  method: "workflow_next";
  params: {
    workflowId: string;
    currentStep?: string;
    completedSteps: string[];
    context?: Record<string, unknown>;
  };
}

export interface WorkflowGuidance {
  prompt: string;
  modelHint?: string;
  requiresConfirmation?: boolean;
  validationCriteria?: string[];
}

export interface WorkflowNextResponse extends MCPToolCallResponse {
  result: {
    step: import('./workflow').WorkflowStepDefinition | null;
    guidance: WorkflowGuidance;
    isComplete: boolean;
  };
}

export interface WorkflowValidateRequest extends MCPToolCallRequest {
  method: "workflow_validate";
  params: {
    workflowId: string;
    stepId: string;
    output: string;
  };
}

export interface WorkflowValidateResponse extends MCPToolCallResponse {
  result: {
    valid: boolean;
    issues?: string[];
    suggestions?: string[];
  };
}

// =============================================================================
// STATE MANAGEMENT TYPES
// =============================================================================

export interface WorkflowState {
  workflowId: string;
  currentStep?: string;
  completedSteps: string[];
  context: Record<string, unknown>;
  startedAt: Date;
  lastUpdated: Date;
}

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  state: WorkflowState;
  status: 'running' | 'completed' | 'failed' | 'paused';
  error?: string;
}

// =============================================================================
// VALIDATION TYPES
// =============================================================================

// Re-export validation types from domain layer
export type {
  ValidationRule,
  ValidationComposition,
  ValidationCriteria,
  ValidationResult
} from './validation';

// Legacy type (different from workflow validation - kept for MCP protocol)
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

export interface ServerConfig {
  port: number;
  host: string;
  environment: string;
  logLevel: string;
  workflowStorage: {
    type: 'file' | 'database';
    path: string;
  };
  security: {
    jwtSecret: string;
    apiKey?: string;
    maxInputSize: number;
    rateLimit: {
      windowMs: number;
      max: number;
    };
  };
  performance: {
    cacheTTL: number;
    maxConcurrentRequests: number;
    memoryLimit: string;
  };
}

// =============================================================================
// LOGGING TYPES
// =============================================================================

export interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export interface LogConfig {
  level: string;
  format: 'json' | 'text';
  destination: 'console' | 'file' | 'both';
  filePath?: string;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

export type MCPRequest = 
  | MCPInitializeRequest
  | MCPToolsListRequest
  | MCPToolCallRequest
  | MCPShutdownRequest;

export type MCPResponse = 
  | MCPInitializeResponse
  | MCPToolsListResponse
  | MCPToolCallResponse
  | MCPShutdownResponse;

export type WorkflowToolRequest = 
  | WorkflowListRequest
  | WorkflowGetRequest
  | WorkflowNextRequest
  | WorkflowValidateRequest;

export type WorkflowToolResponse = 
  | WorkflowListResponse
  | WorkflowGetResponse
  | WorkflowNextResponse
  | WorkflowValidateResponse;
