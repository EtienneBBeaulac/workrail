import { MCPError } from '../core/error-handler';
import { MCPErrorCodes } from '../types/mcp-types';

/**
 * Lightweight mediator that maps JSON-RPC method names to handler functions.
 * It delegates parameter validation to an injected validator and remains
 * agnostic of transport concerns.
 */
export type MethodHandler = (params: any) => Promise<any> | any;

export interface MethodValidator {
  validate(method: string, params: any): void;
}

export class ApplicationMediator {
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly validateFn: (method: string, params: any) => void;

  constructor(validator: MethodValidator) {
    this.validateFn = validator.validate.bind(validator);
  }

  register(method: string, handler: MethodHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`Method already registered: ${method}`);
    }
    this.handlers.set(method, handler);
  }

  /** Execute a method after validation. */
  async execute(method: string, params: any): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new MCPError(MCPErrorCodes.METHOD_NOT_FOUND, 'Method not found', { method });
    }
    // Perform validation once
    this.validateFn(method, params);
    const result = await handler(params);
    // Validate output if a response validator is registered
    if (this.responseValidate) {
      this.responseValidate(method, result);
    }
    return result;
  }
  // Optional response validator injection
  private responseValidate?: (method: string, result: any) => void;

  setResponseValidator(fn: (method: string, result: any) => void): void {
    this.responseValidate = fn;
  }
}

// ----------------------------------------------------------------------------
// Builder – wires core workflow tool methods into an ApplicationMediator.
// ----------------------------------------------------------------------------

import { WorkflowService } from './services/workflow-service';
import { requestValidator } from '../validation/request-validator';
import { responseValidator } from '../validation/response-validator';
import { createListWorkflows } from './use-cases/list-workflows';
import { createGetWorkflow } from './use-cases/get-workflow';
import { createGetNextStep } from './use-cases/get-next-step';
import { SimpleOutputDecorator } from './decorators/simple-output-decorator';

export const METHOD_NAMES = {
  WORKFLOW_LIST: 'workflow_list',
  WORKFLOW_GET: 'workflow_get',
  WORKFLOW_NEXT: 'workflow_next',
  INITIALIZE: 'initialize',
  TOOLS_LIST: 'tools/list',
  SHUTDOWN: 'shutdown'
} as const;

export type MethodName = typeof METHOD_NAMES[keyof typeof METHOD_NAMES];

// Create a minimal interface for what we need from ApplicationMediator
export interface IApplicationMediator {
  execute(method: string, params: any): Promise<any>;
  register(method: string, handler: any): void;
  setResponseValidator(fn: (method: string, result: any) => void): void;
}

export function buildWorkflowApplication(
  workflowService: WorkflowService,
  validator: MethodValidator = requestValidator,
  enableOutputOptimization: boolean = true
): IApplicationMediator {
  const app = new ApplicationMediator(validator);

  // Attach response validator
  app.setResponseValidator((method, result) => responseValidator.validate(method, result));

  // ------------------------------------------------------------------------
  // Create use-case instances with injected dependencies
  // ------------------------------------------------------------------------
  const listWorkflowsUseCase = createListWorkflows(workflowService);
  const getWorkflowUseCase = createGetWorkflow(workflowService);
  const getNextStepUseCase = createGetNextStep(workflowService);

  // ------------------------------------------------------------------------
  // Workflow tool methods
  // ------------------------------------------------------------------------
  app.register(METHOD_NAMES.WORKFLOW_LIST, async (_params: any) => {
    const workflows = await listWorkflowsUseCase();
    return { workflows };
  });

  app.register(METHOD_NAMES.WORKFLOW_GET, async (params: any) => {
    return getWorkflowUseCase(params.id, params.mode);
  });

  app.register(METHOD_NAMES.WORKFLOW_NEXT, async (params: any) => {
    return getNextStepUseCase(
      params.workflowId,
      params.completedSteps || [],
      params.context
    );
  });

  // ------------------------------------------------------------------------
  // System/handshake methods – dynamic imports to avoid circular deps
  // ------------------------------------------------------------------------
  app.register(METHOD_NAMES.INITIALIZE, async (params: any) => {
    const { initializeHandler } = await import('../tools/mcp_initialize');
    return (
      await initializeHandler({ id: 0, params, method: 'initialize', jsonrpc: '2.0' } as any)
    ).result;
  });

  app.register(METHOD_NAMES.TOOLS_LIST, async (params: any) => {
    const { toolsListHandler } = await import('../tools/mcp_tools_list');
    return (
      await toolsListHandler({ id: 0, params, method: 'tools/list', jsonrpc: '2.0' } as any)
    ).result;
  });

  app.register(METHOD_NAMES.SHUTDOWN, async (params: any) => {
    const { shutdownHandler } = await import('../tools/mcp_shutdown');
    return (
      await shutdownHandler({ id: 0, params, method: 'shutdown', jsonrpc: '2.0' } as any)
    ).result;
  });

  // Apply output optimization decorator if enabled
  if (enableOutputOptimization) {
    return new SimpleOutputDecorator(app);
  }

  return app;
} 