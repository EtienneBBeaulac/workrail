import { validateWorkflowSchema } from '../validation.js';
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a, type ValidationOutcomePhase1a } from '../services/workflow-validation-pipeline.js';
import { ValidationEngine } from '../services/validation-engine.js';
import { EnhancedLoopValidator } from '../services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../services/workflow-compiler.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { createWorkflow } from '../../types/workflow.js';
import { createBundledSource } from '../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';

/**
 * Enhanced validation result interface that matches other use cases.
 */
export interface WorkflowJsonValidationResult {
  valid: boolean;
  issues: string[];
  suggestions: string[];
}

/**
 * Build default pipeline deps for standalone use.
 * Same construction as the CI script — no DI container needed.
 */
function buildDefaultPipelineDeps(): ValidationPipelineDepsPhase1a {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();

  return {
    schemaValidate: validateWorkflowSchema,
    structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler,
    normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
  };
}

/**
 * Map a pipeline outcome to the user-facing result format.
 * Preserves backward compatibility with existing MCP handler consumers.
 */
function mapOutcomeToResult(outcome: ValidationOutcomePhase1a): WorkflowJsonValidationResult {
  switch (outcome.kind) {
    case 'schema_failed':
      return {
        valid: false,
        issues: outcome.errors.map(e => e.message ?? e.keyword ?? 'Schema validation error').filter(Boolean) as string[],
        suggestions: generateSuggestions(outcome.errors.map(e => e.message ?? '').filter(Boolean) as string[]),
      };
    case 'structural_failed':
      return {
        valid: false,
        issues: outcome.issues.slice(),
        suggestions: generateSuggestions(outcome.issues.slice()),
      };
    case 'v1_compilation_failed':
      return {
        valid: false,
        issues: [`Compilation error: ${outcome.cause.message}`],
        suggestions: ['Check step references, loop definitions, and prompt sources.'],
      };
    case 'normalization_failed':
      return {
        valid: false,
        issues: [`Normalization error: ${outcome.cause.message}`],
        suggestions: ['Check templateCall references, promptBlocks, and step definitions.'],
      };
    case 'executable_compilation_failed':
      return {
        valid: false,
        issues: [`Executable compilation error: ${outcome.cause.message}`],
        suggestions: ['The normalized workflow has an internal conflict. Check that steps use exactly one of prompt, promptBlocks, or templateCall.'],
      };
    case 'phase1a_valid':
      return { valid: true, issues: [], suggestions: [] };
  }
}

/**
 * Factory function that creates a pure use-case for validating workflow JSON.
 *
 * Uses the same validation pipeline as the registry validator (Phase 1a):
 * schema → structural → v1 compilation → normalization.
 *
 * Dependencies can be injected for testing; defaults are constructed internally.
 */
export function createValidateWorkflowJson(deps?: ValidationPipelineDepsPhase1a) {
  const pipelineDeps = deps ?? buildDefaultPipelineDeps();

  return async (
    workflowJson: string
  ): Promise<WorkflowJsonValidationResult> => {
    // Handle null, undefined, or non-string input
    if (workflowJson === null || workflowJson === undefined || typeof workflowJson !== 'string') {
      return {
        valid: false,
        issues: ['Workflow JSON content is required and must be a string.'],
        suggestions: ['Provide valid JSON content for the workflow.']
      };
    }

    // Handle empty string after trimming
    const trimmedJson = workflowJson.trim();
    if (trimmedJson.length === 0) {
      return {
        valid: false,
        issues: ['Workflow JSON content is empty.'],
        suggestions: ['Provide valid JSON content for the workflow.']
      };
    }

    // Parse JSON with detailed error handling
    let parsedWorkflow: unknown;
    try {
      parsedWorkflow = JSON.parse(trimmedJson);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown JSON parsing error';
      return {
        valid: false,
        issues: [`Invalid JSON syntax: ${errorMessage}`],
        suggestions: [
          'Check for missing quotes, commas, or brackets in the JSON.',
          'Ensure all strings are properly quoted.',
          'Verify that brackets and braces are properly matched.',
          'Use a JSON formatter or validator to identify syntax errors.'
        ]
      };
    }

    // Loose shape check — must be a non-null object to proceed.
    // The pipeline's schema validator (AJV) handles detailed field validation.
    if (typeof parsedWorkflow !== 'object' || parsedWorkflow === null || Array.isArray(parsedWorkflow)) {
      return {
        valid: false,
        issues: ['Workflow JSON must be an object, not a primitive or array.'],
        suggestions: ['Provide a JSON object with fields: id, name, description, version, steps.'],
      };
    }

    // Construct a Workflow wrapper for the pipeline.
    // If the definition is missing fields (id, name, etc.), the schema validator
    // will catch them with specific AJV error messages.
    const definition = parsedWorkflow as WorkflowDefinition;
    const workflow = createWorkflow(definition, createBundledSource());
    const outcome = validateWorkflowPhase1a(workflow, pipelineDeps);
    return mapOutcomeToResult(outcome);
  };
}

/**
 * Generate actionable suggestions based on validation errors.
 */
function generateSuggestions(errors: string[]): string[] {
  const suggestions: string[] = [];
  const errorText = errors.join(' ').toLowerCase();

  if (errorText.includes('id')) {
    suggestions.push('Ensure the workflow ID follows the pattern: lowercase letters, numbers, and hyphens only.');
  }

  if (errorText.includes('name')) {
    suggestions.push('Provide a clear, descriptive name for the workflow.');
  }

  if (errorText.includes('description')) {
    suggestions.push('Add a meaningful description explaining what the workflow accomplishes.');
  }

  if (errorText.includes('version')) {
    suggestions.push('Use semantic versioning format (e.g., "0.0.1", "1.0.0").');
  }

  if (errorText.includes('steps')) {
    suggestions.push('Ensure the workflow has at least one step with id, title, and either prompt or promptBlocks.');
  }

  if (errorText.includes('step')) {
    suggestions.push('Check that all steps have required fields: id, title, and either prompt or promptBlocks.');
  }

  if (errorText.includes('pattern')) {
    suggestions.push('Review the workflow schema documentation for correct field formats.');
  }

  if (suggestions.length === 0) {
    suggestions.push('Review the workflow schema documentation for correct structure and formatting.');
    suggestions.push('Check that all required fields are present and properly formatted.');
  }

  return suggestions;
}

/**
 * @deprecated Use createValidateWorkflowJson factory function instead.
 * Legacy export for backward compatibility.
 */
export async function validateWorkflowJson(
  workflowJson: string
): Promise<WorkflowJsonValidationResult> {
  return createValidateWorkflowJson()(workflowJson);
}
