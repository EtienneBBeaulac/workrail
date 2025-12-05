/**
 * Workflow Tool Handlers
 *
 * Pure functions that handle workflow tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 *
 * Implementation pending Phase 3.
 */

import type {
  ToolContext,
  ToolResult,
} from '../types.js';
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
  workflow: unknown; // Full workflow or metadata based on mode
}

export interface WorkflowNextOutput {
  step: unknown | null;
  isComplete: boolean;
  completedSteps: string[];
}

export interface WorkflowValidateJsonOutput {
  valid: boolean;
  errors?: string[];
  suggestions?: string[];
}

export interface WorkflowGetSchemaOutput {
  schema: unknown;
  metadata: {
    version: string;
    description: string;
    schemaPath: string;
  };
}

// -----------------------------------------------------------------------------
// Handlers (Implementation in Phase 3)
// -----------------------------------------------------------------------------

export async function handleWorkflowList(
  _input: WorkflowListInput,
  _ctx: ToolContext
): Promise<ToolResult<WorkflowListOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleWorkflowGet(
  _input: WorkflowGetInput,
  _ctx: ToolContext
): Promise<ToolResult<WorkflowGetOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleWorkflowNext(
  _input: WorkflowNextInput,
  _ctx: ToolContext
): Promise<ToolResult<WorkflowNextOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleWorkflowValidateJson(
  _input: WorkflowValidateJsonInput,
  _ctx: ToolContext
): Promise<ToolResult<WorkflowValidateJsonOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleWorkflowGetSchema(
  _input: WorkflowGetSchemaInput,
  _ctx: ToolContext
): Promise<ToolResult<WorkflowGetSchemaOutput>> {
  throw new Error('Not implemented - Phase 3');
}
