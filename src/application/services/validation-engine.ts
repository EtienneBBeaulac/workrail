import { singleton, inject } from 'tsyringe';
import { ValidationError } from '../../core/error-handler';
import { evaluateCondition, ConditionContext } from '../../utils/condition-evaluator';
import Ajv from 'ajv';
import type {
  WorkflowStepDefinition,
  LoopStepDefinition,
  FunctionDefinition,
  FunctionParameter,
} from '../../types/workflow-definition';
import { isLoopStepDefinition } from '../../types/workflow-definition';
import type { Workflow } from '../../types/workflow';
import { 
  ValidationRule, 
  ValidationComposition, 
  ValidationCriteria,
  ValidationResult 
} from '../../types/validation';
import { EnhancedLoopValidator } from './enhanced-loop-validator';

/**
 * ValidationEngine handles step output validation with support for
 * multiple validation rule types. This engine is responsible for
 * evaluating validation criteria against step outputs.
 */
@singleton()
export class ValidationEngine {
  private ajv: Ajv;
  private schemaCache = new Map<string, any>();
  private enhancedLoopValidator: EnhancedLoopValidator;
  
  constructor(@inject(EnhancedLoopValidator) enhancedLoopValidator: EnhancedLoopValidator) {
    this.ajv = new Ajv({ allErrors: true });
    this.enhancedLoopValidator = enhancedLoopValidator;
  }

  /**
   * Compiles a JSON schema with caching for performance.
   * 
   * @param schema - The JSON schema to compile
   * @returns Compiled schema validator function
   */
  private compileSchema(schema: Record<string, any>): any {
    const schemaKey = JSON.stringify(schema);
    
    if (this.schemaCache.has(schemaKey)) {
      return this.schemaCache.get(schemaKey);
    }
    
    try {
      const compiledSchema = this.ajv.compile(schema);
      this.schemaCache.set(schemaKey, compiledSchema);
      return compiledSchema;
    } catch (error) {
      throw new ValidationError(`Invalid JSON schema: ${error}`);
    }
  }

  /**
   * Evaluates validation criteria (either array or composition format).
   * 
   * @param output - The step output to validate
   * @param criteria - Validation criteria to evaluate
   * @param context - Execution context for conditional validation
   * @returns ValidationResult with validation status and issues
   */
  private evaluateCriteria(
    output: string,
    criteria: ValidationCriteria,
    context: ConditionContext
  ): ValidationResult {
    try {
      // Handle array format (backward compatibility)
      if (Array.isArray(criteria)) {
        return this.evaluateRuleArray(output, criteria, context);
      }

      // Handle composition format
      if (this.isValidationComposition(criteria)) {
        const compositionResult = this.evaluateComposition(output, criteria, context);
        return {
          valid: compositionResult,
          issues: compositionResult ? [] : ['Validation composition failed'],
          suggestions: compositionResult ? [] : ['Review validation criteria and adjust output accordingly.']
        };
      }

      // Invalid criteria format
      throw new ValidationError('Invalid validation criteria format');
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Error evaluating validation criteria: ${error}`);
    }
  }

  /**
   * Evaluates an array of validation rules (legacy format).
   * 
   * @param output - The step output to validate
   * @param rules - Array of validation rules to apply
   * @param context - Execution context for conditional validation
   * @returns ValidationResult with validation status and issues
   */
  private evaluateRuleArray(
    output: string,
    rules: readonly ValidationRule[],
    context: ConditionContext
  ): ValidationResult {
    const issues: string[] = [];

    // Process each validation rule
    for (const rule of rules) {
      try {
        // Check if rule condition is met (if condition exists)
        if (rule.condition && !evaluateCondition(rule.condition, context)) {
          // Skip this rule if condition is not met
          continue;
        }
        
        this.evaluateRule(output, rule, issues);
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }
        throw new ValidationError(`Error evaluating validation rule: ${error}`);
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      suggestions: issues.length > 0 ? ['Review validation criteria and adjust output accordingly.'] : []
    };
  }

  /**
   * Evaluates a validation composition with logical operators.
   * 
   * @param output - The step output to validate
   * @param composition - The validation composition to evaluate
   * @param context - Execution context for conditional validation
   * @returns Boolean indicating if the composition is valid
   */
  private evaluateComposition(
    output: string,
    composition: ValidationComposition,
    context: ConditionContext
  ): boolean {
    // Handle AND operator
    if (composition.and) {
      return composition.and.every(criteria => 
        this.evaluateSingleCriteria(output, criteria, context)
      );
    }

    // Handle OR operator
    if (composition.or) {
      return composition.or.some(criteria => 
        this.evaluateSingleCriteria(output, criteria, context)
      );
    }

    // Handle NOT operator
    if (composition.not) {
      return !this.evaluateSingleCriteria(output, composition.not, context);
    }

    // Empty composition is considered valid
    return true;
  }

  /**
   * Evaluates a single validation criteria (rule or composition).
   * 
   * @param output - The step output to validate
   * @param criteria - Single validation criteria to evaluate
   * @param context - Execution context for conditional validation
   * @returns Boolean indicating if the criteria is valid
   */
  private evaluateSingleCriteria(
    output: string,
    criteria: ValidationCriteria,
    context: ConditionContext
  ): boolean {
    if (this.isValidationRule(criteria)) {
      // Check if rule condition is met (if condition exists)
      if (criteria.condition && !evaluateCondition(criteria.condition, context)) {
        // Skip this rule if condition is not met (consider as valid)
        return true;
      }

      const issues: string[] = [];
      this.evaluateRule(output, criteria, issues);
      return issues.length === 0;
    }

    if (this.isValidationComposition(criteria)) {
      return this.evaluateComposition(output, criteria, context);
    }

    throw new ValidationError('Invalid validation criteria type');
  }

  /**
   * Type guard to check if criteria is a ValidationRule.
   */
  private isValidationRule(criteria: ValidationCriteria): criteria is ValidationRule {
    return typeof criteria === 'object' && 'type' in criteria;
  }

  /**
   * Type guard to check if criteria is a ValidationComposition.
   */
  private isValidationComposition(criteria: ValidationCriteria): criteria is ValidationComposition {
    return typeof criteria === 'object' && 
           !('type' in criteria) &&
           (Object.keys(criteria).length === 0 || 
            'and' in criteria || 'or' in criteria || 'not' in criteria);
  }
  
  /**
   * Validates a step output against validation criteria.
   * 
   * @param output - The step output to validate
   * @param criteria - Array of validation rules or composition object to apply
   * @param context - Optional context for context-aware validation
   * @returns ValidationResult with validation status and any issues
   */
  async validate(
    output: string,
    criteria: ValidationCriteria,
    context?: ConditionContext
  ): Promise<ValidationResult> {
    const issues: string[] = [];

    // Handle empty or invalid criteria
    if (!criteria || (Array.isArray(criteria) && criteria.length === 0)) {
      // Fallback basic validation - output should not be empty
      if (typeof output !== 'string' || output.trim().length === 0) {
        issues.push('Output is empty or invalid.');
      }
      return {
        valid: issues.length === 0,
        issues,
        suggestions: issues.length > 0 ? ['Provide valid output content.'] : []
      };
    }

    // Evaluate criteria (either array format or composition format)
    const isValid = this.evaluateCriteria(output, criteria, context || {});
    
    if (!isValid.valid) {
      issues.push(...isValid.issues);
    }

    const valid = issues.length === 0;
    return {
      valid,
      issues,
      suggestions: valid ? [] : ['Review validation criteria and adjust output accordingly.']
    };
  }

  /**
   * Evaluates a single validation rule against the output.
   * 
   * @param output - The step output to validate
   * @param rule - The validation rule to apply
   * @param issues - Array to collect validation issues
   */
  private evaluateRule(output: string, rule: ValidationRule, issues: string[]): void {
    // Handle legacy string-based rules for backward compatibility
    if (typeof rule === 'string') {
      const re = new RegExp(rule);
      if (!re.test(output)) {
        issues.push(`Output does not match pattern: ${rule}`);
      }
      return;
    }

    // Handle object-based rules
    if (rule && typeof rule === 'object') {
      switch (rule.type) {
        case 'contains': {
          const value = rule.value as string;
          if (typeof value !== 'string' || !output.includes(value)) {
            issues.push(rule.message || `Output must include "${value}"`);
          }
          break;
        }
        case 'regex': {
          try {
            const re = new RegExp(rule.pattern!, rule.flags || undefined);
            if (!re.test(output)) {
              issues.push(rule.message || `Pattern mismatch: ${rule.pattern}`);
            }
          } catch {
            throw new ValidationError(`Invalid regex pattern in validationCriteria: ${rule.pattern}`);
          }
          break;
        }
        case 'length': {
          const { min, max } = rule;
          if (typeof min === 'number' && output.length < min) {
            issues.push(rule.message || `Output shorter than minimum length ${min}`);
          }
          if (typeof max === 'number' && output.length > max) {
            issues.push(rule.message || `Output exceeds maximum length ${max}`);
          }
          break;
        }
        case 'schema': {
          if (!rule.schema) {
            issues.push(rule.message || 'Schema validation rule requires a schema property');
            break;
          }
          
          try {
            // Parse the output as JSON
            let parsedOutput;
            try {
              parsedOutput = JSON.parse(output);
            } catch (parseError: any) {
              issues.push(rule.message || 'Output is not valid JSON for schema validation');
              break;
            }
            
            // Compile and validate against the schema
            const validate = this.compileSchema(rule.schema);
            const isValid = validate(parsedOutput);
            
            if (!isValid) {
              // Format AJV errors for better readability
              const errorMessages = validate.errors?.map((error: any) => 
                `Validation Error at '${error.instancePath}': ${error.message}`
              ) || ['Schema validation failed'];
              
              issues.push(rule.message || errorMessages.join('; '));
            }
          } catch (error: any) {
            // Handle schema compilation errors
            if (error instanceof ValidationError) {
              throw error;
            }
            throw new ValidationError(`Schema validation error: ${error}`);
          }
          break;
        }
        default:
          throw new ValidationError(`Unsupported validation rule type: ${(rule as any).type}`);
      }
      return;
    }

    // Unknown rule format
    throw new ValidationError('Invalid validationCriteria format.');
  }

  /**
   * Validates a loop step configuration
   * @param step - The loop step to validate
   * @param workflow - The workflow containing the step
   * @returns ValidationResult with validation status and issues
   */
  validateLoopStep(step: LoopStepDefinition, workflow: Workflow): ValidationResult {
    // Run enhanced validation first
    const enhancedResult = this.enhancedLoopValidator.validateLoopStep(step);
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Validate loop type
    const validTypes = ['while', 'until', 'for', 'forEach'];
    if (!validTypes.includes(step.loop.type)) {
      issues.push(`Invalid loop type '${step.loop.type}'. Must be one of: ${validTypes.join(', ')}`);
    }

    // Validate maxIterations
    if (typeof step.loop.maxIterations !== 'number' || step.loop.maxIterations <= 0) {
      issues.push(`maxIterations must be a positive number`);
      suggestions.push('Set maxIterations to a reasonable limit (e.g., 100) to prevent infinite loops');
    } else if (step.loop.maxIterations > 1000) {
      issues.push(`maxIterations (${step.loop.maxIterations}) exceeds safety limit of 1000`);
      suggestions.push('Consider reducing maxIterations or breaking the loop into smaller chunks');
    }

    // Type-specific validation
    switch (step.loop.type) {
      case 'while':
      case 'until':
        if (!step.loop.condition) {
          issues.push(`${step.loop.type} loop requires a condition`);
          suggestions.push(`Add a condition that evaluates to false (for while) or true (for until) to exit the loop`);
        }
        break;

      case 'for':
        if (step.loop.count === undefined) {
          issues.push(`for loop requires a count`);
          suggestions.push('Set count to a number or context variable name');
        } else if (typeof step.loop.count === 'string') {
          // It's a context variable reference - valid
        } else if (typeof step.loop.count !== 'number' || step.loop.count <= 0) {
          issues.push(`for loop count must be a positive number or context variable name`);
        }
        break;

      case 'forEach':
        if (!step.loop.items) {
          issues.push(`forEach loop requires items`);
          suggestions.push('Set items to a context variable name containing an array');
        } else if (typeof step.loop.items !== 'string') {
          issues.push(`forEach loop items must be a context variable name`);
        }
        break;
    }

    // Validate body reference
    if (!step.body) {
      issues.push(`Loop step must have a body`);
      suggestions.push('Set body to a step ID or array of step IDs');
    } else {
      // Handle both string references and inline step arrays
      if (typeof step.body === 'string') {
        // Validate single step reference
        const bodyStep = workflow.definition.steps.find(s => s.id === step.body);
        if (!bodyStep) {
          issues.push(`Loop body references non-existent step '${step.body}'`);
          suggestions.push(`Create a step with ID '${step.body}' or update the body reference`);
        } else if (isLoopStepDefinition(bodyStep as any)) {
          issues.push(`Nested loops are not currently supported. Step '${step.body}' is a loop`);
          suggestions.push('Refactor to avoid nested loops or use sequential loops');
        }
      } else if (Array.isArray(step.body)) {
        // Validate inline step array
        if (step.body.length === 0) {
          issues.push(`Loop body array cannot be empty`);
          suggestions.push('Add at least one step to the loop body');
        }
        
        // Validate each inline step
        const stepIds = new Set<string>();
        for (const inlineStep of step.body) {
          if (!inlineStep.id) {
            issues.push(`Inline step in loop body must have an ID`);
            suggestions.push('Add an ID to all inline steps');
          } else if (stepIds.has(inlineStep.id)) {
            issues.push(`Duplicate step ID '${inlineStep.id}' in loop body`);
            suggestions.push('Use unique IDs for each inline step');
          } else {
            stepIds.add(inlineStep.id);
          }
          
          if (!inlineStep.title) {
            issues.push(`Inline step '${inlineStep.id || 'unknown'}' must have a title`);
            suggestions.push('Add a title to all inline steps');
          }
          
          if (!inlineStep.prompt) {
            issues.push(`Inline step '${inlineStep.id || 'unknown'}' must have a prompt`);
            suggestions.push('Add a prompt to all inline steps');
          }
          
          // Check for nested loops
          if (isLoopStepDefinition(inlineStep as any)) {
            issues.push(`Nested loops are not currently supported. Inline step '${inlineStep.id}' is a loop`);
            suggestions.push('Refactor to avoid nested loops');
          }

          // Validate function calls for inline steps using workflow + loop + step scopes
          const callValidation = this.validateStepFunctionCalls(
            inlineStep as WorkflowStepDefinition,
            workflow.definition.functionDefinitions || [],
            step.functionDefinitions || []
          );
          if (!callValidation.valid) {
            issues.push(...callValidation.issues.map(i => `Step '${inlineStep.id}': ${i}`));
            if (callValidation.suggestions) suggestions.push(...callValidation.suggestions);
          }
        }
      }
    }

    // Validate variable names
    if (step.loop.iterationVar && !this.isValidVariableName(step.loop.iterationVar)) {
      issues.push(`Invalid iteration variable name '${step.loop.iterationVar}'`);
      suggestions.push('Use a valid JavaScript variable name (alphanumeric, _, $)');
    }

    if (step.loop.itemVar && !this.isValidVariableName(step.loop.itemVar)) {
      issues.push(`Invalid item variable name '${step.loop.itemVar}'`);
      suggestions.push('Use a valid JavaScript variable name');
    }

    if (step.loop.indexVar && !this.isValidVariableName(step.loop.indexVar)) {
      issues.push(`Invalid index variable name '${step.loop.indexVar}'`);
      suggestions.push('Use a valid JavaScript variable name');
    }

    // Merge enhanced validation results
    const allWarnings = [...(enhancedResult.warnings || [])];
    const allSuggestions = [...suggestions, ...(enhancedResult.suggestions || [])];
    const allInfo = [...(enhancedResult.info || [])];

    return {
      valid: issues.length === 0,
      issues,
      suggestions: allSuggestions,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
      info: allInfo.length > 0 ? allInfo : undefined
    };
  }

  /**
   * Validates a complete workflow including loop steps
   * @param workflow - The workflow to validate
   * @returns ValidationResult with validation status and issues
   */
  validateWorkflow(workflow: Workflow): ValidationResult {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const warnings: string[] = [];
    const info: string[] = [];

    // Check for duplicate step IDs
    const stepIds = new Set<string>();
    for (const step of workflow.definition.steps) {
      if (stepIds.has(step.id)) {
        issues.push(`Duplicate step ID '${step.id}'`);
        suggestions.push('Ensure all step IDs are unique');
      }
      stepIds.add(step.id);
    }

    // Validate each step
    for (const step of workflow.definition.steps) {
      if (isLoopStepDefinition(step)) {
        const loopResult = this.validateLoopStep(step, workflow);
        issues.push(...loopResult.issues.map(issue => `Step '${step.id}': ${issue}`));
        suggestions.push(...loopResult.suggestions);
        if (loopResult.warnings) {
          warnings.push(...loopResult.warnings.map(warning => `Step '${step.id}': ${warning}`));
        }
        if (loopResult.info) {
          info.push(...loopResult.info.map(i => `Step '${step.id}': ${i}`));
        }
      } else {
        // Basic step validation
        if (!step.id) {
          issues.push('Step missing required ID');
        }
        if (!step.title) {
          issues.push(`Step '${step.id}' missing required title`);
        }
        if (!step.prompt) {
          issues.push(`Step '${step.id}' missing required prompt`);
        }

        // Validate function calls for standard steps using workflow + step scopes
        const callValidation = this.validateStepFunctionCalls(
          step as WorkflowStepDefinition,
          workflow.definition.functionDefinitions || []
        );
        if (!callValidation.valid) {
          issues.push(...callValidation.issues.map(i => `Step '${step.id}': ${i}`));
          if (callValidation.suggestions) suggestions.push(...callValidation.suggestions);
        }
      }
    }

    // Check for orphaned loop body steps
    const loopBodySteps = new Set<string>();
    for (const step of workflow.definition.steps) {
      if (isLoopStepDefinition(step)) {
        if (typeof step.body === 'string') {
          loopBodySteps.add(step.body);
        } else if (Array.isArray(step.body)) {
          for (const inlineStep of step.body) {
            if (inlineStep?.id) loopBodySteps.add(inlineStep.id);
          }
        }
      }
    }

    // Warn about steps that are only reachable through loops
    for (const step of workflow.definition.steps) {
      if (loopBodySteps.has(step.id) && step.runCondition) {
        issues.push(`Step '${step.id}' is a loop body but has runCondition - this may cause conflicts`);
        suggestions.push('Remove runCondition from loop body steps as they are controlled by the loop');
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      suggestions,
      warnings: warnings.length > 0 ? warnings : undefined,
      info: info.length > 0 ? info : undefined
    };
  }

  /**
   * Checks if a string is a valid JavaScript variable name
   * @param name - The variable name to check
   * @returns true if valid
   */
  private isValidVariableName(name: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
  }

  /**
   * Validates step.functionCalls against available function definitions.
   * availableScopes: workflow-level defs (required), plus optionally loop/step-level defs.
   */
  private validateStepFunctionCalls(
    step: WorkflowStepDefinition,
    workflowDefs: readonly FunctionDefinition[],
    loopDefs: readonly FunctionDefinition[] = []
  ): ValidationResult {
    const allDefs: Record<string, FunctionDefinition> = {};
    const addDefs = (defs?: readonly FunctionDefinition[]) => {
      (defs || []).forEach(d => { allDefs[d.name] = d; });
    };
    addDefs(workflowDefs);
    addDefs(loopDefs);
    addDefs(step.functionDefinitions);

    const issues: string[] = [];
    const suggestions: string[] = [];

    const calls = (step as any).functionCalls as Array<{ name: string; args: Record<string, unknown> }> | undefined;
    if (!calls || calls.length === 0) {
      return { valid: true, issues: [], suggestions: [] };
    }

    for (const call of calls) {
      const def = allDefs[call.name];
      if (!def) {
        issues.push(`Unknown function '${call.name}' in functionCalls`);
        continue;
      }
      if (def.parameters && def.parameters.length > 0) {
        // Validate required params
        const args = call.args || {};
        for (const param of def.parameters) {
          if (param.required && !(param.name in args)) {
            issues.push(`Missing required parameter '${param.name}' for function '${call.name}'`);
          }
        }
        // Validate argument types and enums
        for (const [argName, argValue] of Object.entries(args)) {
          const spec = def.parameters.find(p => p.name === argName);
          if (!spec) {
            suggestions.push(`Unknown argument '${argName}' for function '${call.name}'`);
            continue;
          }
          if (!this.isArgTypeValid(argValue, spec)) {
            issues.push(`Invalid type for '${call.name}.${argName}': expected ${spec.type}`);
          }
          if (spec.enum && !spec.enum.includes(argValue as any)) {
            issues.push(`Invalid value for '${call.name}.${argName}': must be one of ${spec.enum.join(', ')}`);
          }
        }
      }
    }

    return { valid: issues.length === 0, issues, suggestions };
  }

  private isArgTypeValid(value: unknown, spec: FunctionParameter): boolean {
    switch (spec.type) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && Number.isFinite(value as number);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
      default: return true;
    }
  }
} 