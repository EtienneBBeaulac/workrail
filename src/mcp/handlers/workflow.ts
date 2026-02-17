/**
 * Workflow Tool Handlers
 *
 * Pure functions that handle workflow tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 */

import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable } from '../types.js';
import {
  WorkflowGetOutputSchema,
  WorkflowGetSchemaOutputSchema,
  WorkflowListOutputSchema,
  WorkflowNextOutputSchema,
  WorkflowValidateJsonOutputSchema,
} from '../output-schemas.js';
import { mapDomainErrorToToolError, mapUnknownErrorToToolError } from '../error-mapper.js';
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
  workflows: readonly WorkflowSummary[];
}

export interface WorkflowGetOutput {
  workflow: unknown;
}

export interface WorkflowNextOutput {
  state: unknown;
  next: unknown | null;
  isComplete: boolean;
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

import { withTimeout } from './shared/with-timeout.js';

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

    const payload = WorkflowListOutputSchema.parse({ workflows });
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
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

    const result = await withTimeout(
      getWorkflowUseCase(input.workflowId, input.mode),
      TIMEOUT_MS,
      'workflow_get'
    );

    if (result.isErr()) {
      const mapped = mapDomainErrorToToolError(result.error);
      return mapped;
    }

    const payload = WorkflowGetOutputSchema.parse({ workflow: result.value });
    return success(payload);
  } catch (err) {
    // Check for timeout errors via structured error type (not string matching)
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        type: 'error',
        code: 'TIMEOUT',
        message: err.message,
        retry: { kind: 'retryable_immediate' },
      };
    }

    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
  }
}

export async function handleWorkflowNext(
  input: WorkflowNextInput,
  ctx: ToolContext
): Promise<ToolResult<WorkflowNextOutput>> {
  const startTime = Date.now();

  try {
    console.error(
      `[workflow_next] Starting with workflowId=${input.workflowId}, ` +
      `stateKind=${(input.state as any).kind}, ` +
      `eventKind=${(input.event as any)?.kind ?? 'none'}, ` +
      `contextKeys=${Object.keys(input.context ?? {})}`
    );

    const result = await withTimeout(
      ctx.workflowService.getNextStep(input.workflowId, input.state, input.event, input.context),
      TIMEOUT_MS,
      'workflow_next'
    );

    console.error(
      `[workflow_next] Completed in ${Date.now() - startTime}ms, ` +
      `returned=${result.isOk() ? 'ok' : 'err'}`
    );

    if (result.isErr()) {
      const mapped = mapDomainErrorToToolError(result.error);
      return mapped;
    }

    const payload = WorkflowNextOutputSchema.parse(result.value);
    return success(payload);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    console.error(`[workflow_next] Failed after ${elapsed}ms: ${message}`);

    // Check for timeout errors via structured error type (not string matching)
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        type: 'error',
        code: 'TIMEOUT',
        message: err.message,
        retry: { kind: 'retryable_immediate' },
      };
    }

    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
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

    const payload = WorkflowValidateJsonOutputSchema.parse(result);
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
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

    const payload = WorkflowGetSchemaOutputSchema.parse(result);
    return success(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errNotRetryable(
      'INTERNAL_ERROR',
      message,
      { suggestion: 'Ensure the workflow schema file exists at spec/workflow.schema.json' }
    );
  }
}
