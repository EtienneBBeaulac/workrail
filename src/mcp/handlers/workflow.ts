/**
 * Workflow Tool Handlers
 *
 * Pure functions that handle workflow tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 */

import type { ToolContext, ToolResult } from '../types.js';
import { success, error } from '../types.js';
import type {
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
} from '../tools.js';

// -----------------------------------------------------------------------------
// Output Types
// -----------------------------------------------------------------------------

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  version: string;
}

export interface WorkflowListOutput {
  workflows: WorkflowSummary[];
}

export interface WorkflowGetOutput {
  workflow: unknown;
}

export interface WorkflowNextOutput {
  step: unknown | null;
  isComplete: boolean;
  completedSteps?: string[];
}

export interface WorkflowValidateJsonOutput {
  valid: boolean;
  errors?: Array<{ message: string; path?: string }>;
  suggestions?: string[];
}

export interface WorkflowGetSchemaOutput {
  schema: unknown;
  metadata: {
    version: string;
    description: string;
    usage: string;
    schemaPath: string;
  };
  commonPatterns: {
    basicWorkflow: Record<string, string>;
    stepStructure: Record<string, string>;
  };
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Run an async operation with a timeout.
 */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]);
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

export async function handleWorkflowList(
  _input: WorkflowListInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowListOutput>> {
  try {
    const workflows = await withTimeout(
      ctx.workflowService.listWorkflowSummaries(),
      TIMEOUT_MS,
      'workflow_list'
    );

    return success({ workflows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error('INTERNAL_ERROR', message);
  }
}

export async function handleWorkflowGet(
  input: WorkflowGetInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowGetOutput>> {
  try {
    // Dynamic import to avoid circular dependencies
    const { createGetWorkflow } = await import('../../application/use-cases/get-workflow.js');
    const getWorkflowUseCase = createGetWorkflow(ctx.workflowService);

    const workflow = await withTimeout(
      getWorkflowUseCase(input.id, input.mode),
      TIMEOUT_MS,
      'workflow_get'
    );

    return success({ workflow });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Check for not found errors - provide AI-friendly suggestions
    if (message.toLowerCase().includes('not found')) {
      // Get suggestions from repository if available
      const suggestions = await ctx.workflowService.listWorkflowSummaries()
        .then(wfs => wfs.slice(0, 5).map(w => `"${w.id}"`).join(', '))
        .catch(() => '');
      
      const hint = suggestions 
        ? `Available workflows: ${suggestions}. Use workflow_list to see all.`
        : 'Check available workflows with workflow_list';
      
      return error('NOT_FOUND', message, hint);
    }

    return error('INTERNAL_ERROR', message);
  }
}

export async function handleWorkflowNext(
  input: WorkflowNextInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowNextOutput>> {
  const startTime = Date.now();
  const logger = ctx.logger.child({ tool: 'workflow_next' });

  try {
    logger.debug({
      workflowId: input.workflowId,
      completedSteps: input.completedSteps,
      contextKeys: Object.keys(input.context ?? {}),
    }, 'Starting workflow_next');

    const result = await withTimeout(
      ctx.workflowService.getNextStep(
        input.workflowId,
        input.completedSteps,
        input.context
      ),
      TIMEOUT_MS,
      'workflow_next'
    );

    logger.debug({
      elapsed: Date.now() - startTime,
      stepId: result.step?.id ?? null,
    }, 'Completed workflow_next');

    return success(result);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    logger.error({ err, elapsed }, 'Failed workflow_next');

    if (message.includes('timed out')) {
      return error('TIMEOUT', message, 'Try breaking down the workflow into smaller steps or simplifying context data');
    }

    // Provide AI-friendly error with suggestions
    if (message.toLowerCase().includes('not found')) {
      const suggestions = await ctx.workflowService.listWorkflowSummaries()
        .then(wfs => wfs.slice(0, 5).map(w => `"${w.id}"`).join(', '))
        .catch(() => '');
      
      const hint = suggestions 
        ? `Workflow "${input.workflowId}" not found. Available: ${suggestions}. Use workflow_list to see all.`
        : `Workflow "${input.workflowId}" not found. Use workflow_list to see available workflows.`;
      
      return error('NOT_FOUND', message, hint);
    }

    // Context size errors
    if (message.toLowerCase().includes('context size')) {
      return error('INVALID_PARAMS', message, 'Reduce context data size or use workflow variables more efficiently');
    }

    // Max iterations errors  
    if (message.toLowerCase().includes('max iterations') || message.toLowerCase().includes('infinite loop')) {
      return error('INTERNAL_ERROR', message, 'Check workflow for infinite loop conditions or excessive step counts');
    }

    return error('INTERNAL_ERROR', message);
  }
}

export async function handleWorkflowValidateJson(
  input: WorkflowValidateJsonInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowValidateJsonOutput>> {
  // Suppress unused variable warning - ctx reserved for future use
  void ctx;

  try {
    // Dynamic import to avoid circular dependencies
    const { createValidateWorkflowJson } = await import('../../application/use-cases/validate-workflow-json.js');
    const validateWorkflowJsonUseCase = createValidateWorkflowJson();

    const result = await validateWorkflowJsonUseCase(input.workflowJson);

    return success(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error('INTERNAL_ERROR', message);
  }
}

export async function handleWorkflowGetSchema(
  _input: WorkflowGetSchemaInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowGetSchemaOutput>> {
  // Suppress unused variable warning - ctx reserved for future use
  void ctx;

  try {
    const fs = await import('fs');
    const path = await import('path');

    // Load the workflow schema (relative to dist/mcp/handlers/)
    const schemaPath = path.resolve(__dirname, '../../../spec/workflow.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);

    const result: WorkflowGetSchemaOutput = {
      schema,
      metadata: {
        version: '1.0.0',
        description: 'Complete JSON schema for workflow files',
        usage: 'This schema defines the structure, required fields, and validation rules for workflow JSON files',
        schemaPath: 'spec/workflow.schema.json',
      },
      commonPatterns: {
        basicWorkflow: {
          id: 'string (required): Unique identifier using lowercase letters, numbers, and hyphens',
          name: 'string (required): Human-readable workflow name',
          description: 'string (required): Detailed description of the workflow purpose',
          version: 'string (required): Semantic version (e.g., "1.0.0")',
          steps: 'array (required): List of workflow steps, minimum 1 item',
        },
        stepStructure: {
          id: 'string (required): Unique step identifier',
          title: 'string (required): Human-readable step title',
          prompt: 'string (required): Instructions for the step',
          agentRole: 'string (required): Role description for the agent',
          validationCriteria: 'array (optional): Validation rules for step output',
        },
      },
    };

    return success(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return error(
      'INTERNAL_ERROR',
      message,
      'Ensure the workflow schema file exists at spec/workflow.schema.json'
    );
  }
}
