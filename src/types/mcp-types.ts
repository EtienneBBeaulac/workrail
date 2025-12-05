// MCP Protocol Type Definitions
// Model Context Protocol (MCP) specification types

// =============================================================================
// JSON-RPC 2.0 BASE TYPES
// =============================================================================

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: any;
}

// =============================================================================
// MCP PROTOCOL TYPES
// =============================================================================

export interface MCPInitializeRequest extends JSONRPCRequest {
  method: "initialize";
  params: {
    protocolVersion: string;
    capabilities: {
      tools?: Record<string, any>;
      resources?: Record<string, any>;
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
  inputSchema: Record<string, any>;
  outputSchema?: Record<string, any>;
  examples?: {
    request: Record<string, any>;
    response: Record<string, any>;
  };
}

export interface MCPToolsListResponse extends JSONRPCResponse {
  result: {
    tools: MCPTool[];
  };
}

export interface MCPToolCallRequest extends JSONRPCRequest {
  method: string; // Tool name
  params: Record<string, any>;
}

export interface MCPToolCallResponse extends JSONRPCResponse {
  result: any;
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
  // Standard JSON-RPC 2.0 error codes
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  
  // MCP-specific error codes (-32000 to -32099)
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
// WORKFLOW ORCHESTRATION SPECIFIC TYPES
// =============================================================================

export interface WorkflowListRequest extends MCPToolCallRequest {
  method: "workflow_list";
  params: Record<string, never>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
}

export interface WorkflowListResponse extends MCPToolCallResponse {
  result: {
    workflows: WorkflowSummary[];
  };
}

export interface WorkflowGetRequest extends MCPToolCallRequest {
  method: "workflow_get";
  params: {
    id: string;
  };
}

export interface FunctionParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
}

export interface FunctionDefinition {
  name: string;
  definition: string;
  parameters?: FunctionParameter[];
  scope?: 'workflow' | 'loop' | 'step';
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface WorkflowStep {
  id: string;
  title: string;
  prompt: string;
  agentRole?: string;
  guidance?: string[];
  askForFiles?: boolean;
  requireConfirmation?: boolean;
  runCondition?: object;
  functionDefinitions?: FunctionDefinition[];
  functionCalls?: FunctionCall[];
  functionReferences?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  version: string;
  preconditions?: string[];
  clarificationPrompts?: string[];
  steps: WorkflowStep[];
  metaGuidance?: string[];
  functionDefinitions?: FunctionDefinition[];
}

export interface WorkflowGetResponse extends MCPToolCallResponse {
  result: Workflow;
}

export interface WorkflowNextRequest extends MCPToolCallRequest {
  method: "workflow_next";
  params: {
    workflowId: string;
    currentStep?: string;
    completedSteps: string[];
    context?: Record<string, any>;
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
    step: WorkflowStep | null;
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
  context: Record<string, any>;
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

export interface ValidationRule {
  type: 'required' | 'pattern' | 'length' | 'custom';
  field: string;
  message: string;
  validator?: (value: any) => boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

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
  context?: Record<string, any>;
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