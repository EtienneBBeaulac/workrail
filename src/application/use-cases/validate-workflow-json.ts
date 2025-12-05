import { validateWorkflow, WorkflowValidationResult } from '../validation';

/**
 * Enhanced validation result interface that matches other use cases
 */
export interface WorkflowJsonValidationResult {
  valid: boolean;
  issues: string[];
  suggestions: string[];
}

/**
 * Factory function that creates a pure use-case for validating workflow JSON.
 * Dependencies are injected at creation time, returning a pure function.
 */
export function createValidateWorkflowJson() {
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

    // Validate the parsed workflow using existing validation
    const validationResult: WorkflowValidationResult = validateWorkflow(parsedWorkflow);
    
    // Transform validation result to match use case interface
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (!validationResult.valid) {
      // Validation errors are already enhanced by the EnhancedErrorService
      issues.push(...validationResult.errors);

      // Add general suggestions based on common validation errors
      suggestions.push(...generateSuggestions(validationResult.errors));
    }

    return {
      valid: validationResult.valid,
      issues,
      suggestions
    };
  };
}



/**
 * Generate actionable suggestions based on validation errors
 */
function generateSuggestions(errors: string[]): string[] {
  const suggestions: string[] = [];
  const errorText = errors.join(' ').toLowerCase();

  // Add suggestions based on common error patterns
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
    suggestions.push('Ensure the workflow has at least one step with id, title, and prompt fields.');
  }

  if (errorText.includes('step')) {
    suggestions.push('Check that all steps have required fields: id, title, and prompt.');
  }

  if (errorText.includes('pattern')) {
    suggestions.push('Review the workflow schema documentation for correct field formats.');
  }

  // Add general suggestions if no specific ones were added
  if (suggestions.length === 0) {
    suggestions.push('Review the workflow schema documentation for correct structure and formatting.');
    suggestions.push('Check that all required fields are present and properly formatted.');
  }

  return suggestions;
}

/**
 * @deprecated Use createValidateWorkflowJson factory function instead
 * Legacy export for backward compatibility
 */
export async function validateWorkflowJson(
  workflowJson: string
): Promise<WorkflowJsonValidationResult> {
  return createValidateWorkflowJson()(workflowJson);
} 