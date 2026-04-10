import { singleton, inject } from 'tsyringe';
import { evaluateCondition, ConditionContext } from '../../utils/condition-evaluator';
import Ajv from 'ajv';
import { err, ok, type Result } from 'neverthrow';
import type {
  WorkflowStepDefinition,
  LoopStepDefinition,
  FunctionDefinition,
  FunctionParameter,
} from '../../types/workflow-definition';
import { isLoopStepDefinition, stepHasPromptSource } from '../../types/workflow-definition';
import type { Workflow } from '../../types/workflow';
import { BINDING_TOKEN_RE } from './compiler/resolve-bindings';
import { 
  ValidationRule, 
  ValidationComposition, 
  ValidationCriteria,
  ValidationResult 
} from '../../types/validation';
import { EnhancedLoopValidator } from './enhanced-loop-validator';
import { decodeForSchemaValidation } from './step-output-decoder';

export type ValidationEngineError =
  | { readonly kind: 'schema_compilation_failed'; readonly message: string; readonly details?: unknown }
  | { readonly kind: 'invalid_criteria_format'; readonly message: string; readonly details?: unknown }
  | { readonly kind: 'evaluation_threw'; readonly message: string; readonly details?: unknown };

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
  private static readonly DEFAULT_FAILURE_SUGGESTION = 'Review validation criteria and adjust output accordingly.';
  private static readonly JSON_OBJECT_NOT_STRING_SUGGESTION =
    'If you are returning JSON, return an object/array directly (not a JSON-encoded string). Do not wrap it in quotes or escape quotes.';
  private static readonly JSON_STRING_CONTAINS_JSON_SUGGESTION =
    'It looks like you returned a JSON string that itself contains JSON. Remove the outer quotes and return the JSON object/array directly.';
  
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
  private compileSchema(schema: Record<string, any>): Result<any, ValidationEngineError> {
    const schemaKey = JSON.stringify(schema);
    
    if (this.schemaCache.has(schemaKey)) {
      return ok(this.schemaCache.get(schemaKey));
    }
    
    try {
      const compiledSchema = this.ajv.compile(schema);
      this.schemaCache.set(schemaKey, compiledSchema);
      return ok(compiledSchema);
    } catch (error) {
      return err({
        kind: 'schema_compilation_failed',
        message: 'Invalid JSON schema',
        details: { error: String(error) },
      });
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
  ): Result<ValidationResult, ValidationEngineError> {
    try {
      // Handle array format (backward compatibility)
      if (Array.isArray(criteria)) {
        return this.evaluateRuleArray(output, criteria, context);
      }

      // Handle composition format
      if (this.isValidationComposition(criteria)) {
        const compositionResult = this.evaluateComposition(output, criteria, context);
        return compositionResult.map((okRes) => ({
          valid: okRes,
          issues: okRes ? [] : ['Validation composition failed'],
          suggestions: okRes ? [] : ['Review validation criteria and adjust output accordingly.'],
          warnings: undefined,
        }));
      }

      // Handle single rule object (e.g. { type: 'contains', value: 'OK' }) —
      // authors often write a bare rule instead of a single-element array.
      // Treat it identically to [criteria] rather than rejecting as invalid.
      if (this.isValidationRule(criteria)) {
        return this.evaluateRuleArray(output, [criteria], context);
      }

      // Invalid criteria format
      return err({ kind: 'invalid_criteria_format', message: 'Invalid validation criteria format' });
    } catch (error) {
      return err({ kind: 'evaluation_threw', message: 'Error evaluating validation criteria', details: { error: String(error) } });
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
  ): Result<ValidationResult, ValidationEngineError> {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const warnings: string[] = [];

    // Process each validation rule
    for (const rule of rules) {
      // Check if rule condition is met (if condition exists)
      if (typeof rule === 'object' && rule && 'condition' in rule) {
        if ((rule as any).condition && !evaluateCondition((rule as any).condition, context)) {
          continue;
        }
      }

      const ruleRes = this.evaluateRule(output, rule, issues, suggestions, warnings);
      if (ruleRes.isErr()) return err(ruleRes.error);
    }

    return ok({
      valid: issues.length === 0,
      issues,
      suggestions: issues.length > 0 ? this.uniqueSuggestions([...suggestions, ValidationEngine.DEFAULT_FAILURE_SUGGESTION]) : [],
      warnings: warnings.length > 0 ? this.uniqueSuggestions(warnings) : undefined,
    });
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
  ): Result<boolean, ValidationEngineError> {
    // Handle AND operator
    if (composition.and) {
      for (const criteria of composition.and) {
        const res = this.evaluateSingleCriteria(output, criteria, context);
        if (res.isErr()) return err(res.error);
        if (!res.value) return ok(false);
      }
      return ok(true);
    }

    // Handle OR operator
    if (composition.or) {
      let sawTrue = false;
      for (const criteria of composition.or) {
        const res = this.evaluateSingleCriteria(output, criteria, context);
        if (res.isErr()) return err(res.error);
        if (res.value) {
          sawTrue = true;
          break;
        }
      }
      return ok(sawTrue);
    }

    // Handle NOT operator
    if (composition.not) {
      const res = this.evaluateSingleCriteria(output, composition.not, context);
      return res.map((v) => !v);
    }

    // Empty composition is considered valid
    return ok(true);
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
  ): Result<boolean, ValidationEngineError> {
    if (this.isValidationRule(criteria)) {
      // Check if rule condition is met (if condition exists)
      if (criteria.condition && !evaluateCondition(criteria.condition, context)) {
        // Skip this rule if condition is not met (consider as valid)
        return ok(true);
      }

      const issues: string[] = [];
      const suggestions: string[] = [];
      const warnings: string[] = [];
      const res = this.evaluateRule(output, criteria, issues, suggestions, warnings);
      if (res.isErr()) return err(res.error);
      return ok(issues.length === 0);
    }

    if (this.isValidationComposition(criteria)) {
      return this.evaluateComposition(output, criteria, context);
    }

    return err({ kind: 'invalid_criteria_format', message: 'Invalid validation criteria type' });
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
  ): Promise<Result<ValidationResult, ValidationEngineError>> {
    const issues: string[] = [];

    // Handle empty or invalid criteria
    if (!criteria || (Array.isArray(criteria) && criteria.length === 0)) {
      // Fallback basic validation - output should not be empty
      if (typeof output !== 'string' || output.trim().length === 0) {
        issues.push('Output is empty or invalid.');
      }
      return ok({
        valid: issues.length === 0,
        issues,
        suggestions: issues.length > 0 ? ['Provide valid output content.'] : []
      });
    }

    // Evaluate criteria (either array format or composition format)
    const evaluation = this.evaluateCriteria(output, criteria, context || {});
    if (evaluation.isErr()) return err(evaluation.error);

    if (!evaluation.value.valid) {
      issues.push(...evaluation.value.issues);
    }

    const valid = issues.length === 0;
    return ok({
      valid,
      issues,
      suggestions: valid ? [] : this.uniqueSuggestions([...evaluation.value.suggestions, ValidationEngine.DEFAULT_FAILURE_SUGGESTION]),
      warnings: evaluation.value.warnings,
    });
  }

  /**
   * Evaluates a single validation rule against the output.
   * 
   * @param output - The step output to validate
   * @param rule - The validation rule to apply
   * @param issues - Array to collect validation issues
   */
  private evaluateRule(
    output: string,
    rule: ValidationRule,
    issues: string[],
    suggestions: string[],
    warnings: string[]
  ): Result<void, ValidationEngineError> {
    // Handle legacy string-based rules for backward compatibility
    if (typeof rule === 'string') {
      const re = new RegExp(rule);
      if (!re.test(output)) {
        issues.push(`Output does not match pattern: ${rule}`);
      }
      return ok(undefined);
    }

    // Handle object-based rules
    if (rule && typeof rule === 'object') {
      switch (rule.type) {
        case 'contains': {
          const value = rule.value as string;
          if (typeof value !== 'string' || !output.includes(value)) {
            issues.push(rule.message || this.formatDefaultContainsMessage(value));
            if (this.looksLikeQuotedJsonSnippet(rule.message)) {
              this.maybePushJsonObjectNotStringSuggestion(suggestions);
            }
          }
          break;
        }
        case 'regex': {
          try {
            const re = new RegExp(rule.pattern!, rule.flags || undefined);
            if (!re.test(output)) {
              issues.push(rule.message || `Pattern mismatch: ${rule.pattern}`);
              if (this.looksLikeQuotedJsonSnippet(rule.message)) {
                this.maybePushJsonObjectNotStringSuggestion(suggestions);
              }
            }
          } catch (error) {
            return err({
              kind: 'invalid_criteria_format',
              message: 'Invalid regex pattern in validationCriteria',
              details: { pattern: rule.pattern, error: String(error) },
            });
          }
          break;
        }
        case 'length': {
          const { min, max } = rule;
          if (typeof min === 'number' && output.length < min) {
            issues.push(rule.message || `Output shorter than minimum length ${min}`);
            if (this.looksLikeQuotedJsonSnippet(rule.message)) {
              this.maybePushJsonObjectNotStringSuggestion(suggestions);
            }
          }
          if (typeof max === 'number' && output.length > max) {
            issues.push(rule.message || `Output exceeds maximum length ${max}`);
            if (this.looksLikeQuotedJsonSnippet(rule.message)) {
              this.maybePushJsonObjectNotStringSuggestion(suggestions);
            }
          }
          break;
        }
        case 'schema': {
          if (!rule.schema) {
            issues.push(rule.message || 'Schema validation rule requires a schema property');
            if (this.looksLikeQuotedJsonSnippet(rule.message)) {
              this.maybePushJsonObjectNotStringSuggestion(suggestions);
            }
            break;
          }
          
          try {
            const decoded = decodeForSchemaValidation(output, rule.schema);
            if (!decoded) {
              issues.push(rule.message || 'Output is not valid JSON for schema validation');
              if (this.looksLikeQuotedJsonSnippet(rule.message)) {
                this.maybePushJsonObjectNotStringSuggestion(suggestions);
              }
              break;
            }

            if (decoded.warnings.length > 0) {
              warnings.push(...decoded.warnings);
              this.maybePushJsonObjectNotStringSuggestion(suggestions);
              if (!suggestions.includes(ValidationEngine.JSON_STRING_CONTAINS_JSON_SUGGESTION)) {
                suggestions.push(ValidationEngine.JSON_STRING_CONTAINS_JSON_SUGGESTION);
              }
            }
            
            // Compile and validate against the schema
            const validateRes = this.compileSchema(rule.schema);
            if (validateRes.isErr()) return err(validateRes.error);
            const validate = validateRes.value;
            const isValid = validate(decoded.value);
            
            if (!isValid) {
              // Format AJV errors for better readability
              const errorMessages = validate.errors?.map((error: any) => 
                `Validation Error at '${error.instancePath}': ${error.message}`
              ) || ['Schema validation failed'];
              
              issues.push(rule.message || errorMessages.join('; '));
              if (this.looksLikeQuotedJsonSnippet(rule.message)) {
                this.maybePushJsonObjectNotStringSuggestion(suggestions);
              }
            }
          } catch (error: any) {
            return err({
              kind: 'evaluation_threw',
              message: 'Schema validation error',
              details: { error: String(error) },
            });
          }
          break;
        }
        default:
          return err({
            kind: 'invalid_criteria_format',
            message: `Unsupported validation rule type: ${(rule as any).type}`,
          });
      }
      return ok(undefined);
    }

    // Unknown rule format
    return err({ kind: 'invalid_criteria_format', message: 'Invalid validationCriteria format.' });
  }

  private looksLikeQuotedJsonSnippet(message: unknown): boolean {
    if (typeof message !== 'string') return false;
    const m = message.trim();
    if (m.length === 0) return false;

    // Common "please include \"{...}\"" patterns that trick agents into returning JSON-as-a-string.
    if (m.includes('\\"{') || m.includes('\\"[')) return true;
    if (m.includes('"{') || m.includes("'{" ) || m.includes('`{')) return true;
    if (m.includes('"[') || m.includes("'[") || m.includes('`[')) return true;

    // Regex fallback: quote/backtick + optional whitespace + opening brace/bracket.
    return /["'`]\s*[\[{]/.test(m);
  }

  private maybePushJsonObjectNotStringSuggestion(suggestions: string[]): void {
    if (suggestions.includes(ValidationEngine.JSON_OBJECT_NOT_STRING_SUGGESTION)) return;
    suggestions.push(ValidationEngine.JSON_OBJECT_NOT_STRING_SUGGESTION);
  }

  private uniqueSuggestions(values: readonly string[]): string[] {
    const out: string[] = [];
    for (const v of values) {
      if (!v) continue;
      if (out.includes(v)) continue;
      out.push(v);
    }
    return out;
  }

  /**
   * Default 'contains' failure message.
   *
   * Important: Avoid wrapping the expected snippet in quotes.
   * Agents frequently interpret quoted JSON-like snippets as "a JSON string to return",
   * and will escape quotes (e.g., "{\"state\":...}") instead of returning a JSON object.
   */
  private formatDefaultContainsMessage(value: unknown): string {
    if (typeof value !== 'string') {
      return 'Output must include the required substring.';
    }

    const snippet = value.trim();
    const looksJsonLike =
      snippet.startsWith('{') ||
      snippet.startsWith('[') ||
      snippet.includes('"') ||
      snippet.includes(':');

    if (looksJsonLike) {
      return `Output must include this literal JSON snippet (not a JSON-encoded string): ${snippet}`;
    }

    return `Output must include: ${snippet}`;
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
        if (!step.loop.condition && !step.loop.conditionSource) {
          issues.push(`${step.loop.type} loop requires a condition or conditionSource`);
          suggestions.push(`Add a conditionSource (preferred) or a condition field to control loop exit`);
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
          
          if (!stepHasPromptSource(inlineStep as WorkflowStepDefinition)) {
            issues.push(`Inline step '${inlineStep.id || 'unknown'}' must have prompt, promptBlocks, or templateCall`);
            suggestions.push('Add a prompt string, structured promptBlocks, or a templateCall to all inline steps');
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

    // Validate extensionPoints declarations (structural)
    const extensionPoints = workflow.definition.extensionPoints ?? [];
    if (extensionPoints.length > 0) {
      const seenSlotIds = new Set<string>();
      for (const ep of extensionPoints) {
        // Non-empty string checks
        if (!ep.slotId || typeof ep.slotId !== 'string') {
          issues.push(`extensionPoints entry has missing or empty slotId`);
          suggestions.push('Each extensionPoint must have a non-empty slotId string');
        } else if (!ep.purpose || typeof ep.purpose !== 'string') {
          issues.push(`extensionPoints[${ep.slotId}]: purpose must be a non-empty string`);
        } else if (!ep.default || typeof ep.default !== 'string') {
          issues.push(`extensionPoints[${ep.slotId}]: default must be a non-empty string`);
        }
        // Uniqueness check
        if (ep.slotId) {
          if (seenSlotIds.has(ep.slotId)) {
            issues.push(`extensionPoints has duplicate slotId '${ep.slotId}'`);
            suggestions.push('Each slotId must be unique within extensionPoints');
          }
          seenSlotIds.add(ep.slotId);
        }
      }

      // Pre-compilation cross-check: binding tokens in prompts AND promptBlocks must
      // reference declared slots. Mirrors the surface coverage of resolveBindingsPass.
      // BINDING_TOKEN_RE is imported from the compiler pass — single definition, no drift.
      const declaredSlotIds = new Set(extensionPoints.map(ep => ep.slotId).filter(Boolean));

      const checkStringForUnknownBindings = (text: string, stepId: string) => {
        BINDING_TOKEN_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = BINDING_TOKEN_RE.exec(text)) !== null) {
          const slotId = match[1]!;
          if (!declaredSlotIds.has(slotId)) {
            issues.push(
              `Step '${stepId}': binding token '{{wr.bindings.${slotId}}}' references undeclared slot. Declared slots: [${[...declaredSlotIds].join(', ')}]`
            );
            suggestions.push(`Add an extensionPoint with slotId '${slotId}' to the workflow definition`);
          }
        }
      };

      /** Scan a step's prompt string and all promptBlocks string fields. */
      const checkStepForUnknownBindings = (step: WorkflowStepDefinition, stepId: string) => {
        if (step.prompt !== undefined) {
          checkStringForUnknownBindings(step.prompt, stepId);
        }
        if (step.promptBlocks !== undefined) {
          const pb = step.promptBlocks;
          if (typeof pb.goal === 'string') checkStringForUnknownBindings(pb.goal, stepId);
          for (const v of pb.constraints ?? []) {
            if (typeof v === 'string') checkStringForUnknownBindings(v, stepId);
          }
          for (const v of pb.procedure ?? []) {
            if (typeof v === 'string') checkStringForUnknownBindings(v, stepId);
          }
          for (const v of pb.verify ?? []) {
            if (typeof v === 'string') checkStringForUnknownBindings(v, stepId);
          }
          for (const v of Object.values(pb.outputRequired ?? {})) {
            checkStringForUnknownBindings(v, stepId);
          }
        }
      };

      for (const step of workflow.definition.steps) {
        checkStepForUnknownBindings(step, step.id);
        if (isLoopStepDefinition(step) && Array.isArray(step.body)) {
          for (const inlineStep of step.body) {
            checkStepForUnknownBindings(inlineStep, inlineStep.id ?? 'unknown');
          }
        }
      }
    } else {
      // No extensionPoints declared — flag any step that uses binding tokens (prompt or promptBlocks)
      const BINDING_TOKEN_DETECT = /\{\{wr\.bindings\./;

      const stepUsesBindingToken = (step: WorkflowStepDefinition): boolean => {
        if (typeof step.prompt === 'string' && BINDING_TOKEN_DETECT.test(step.prompt)) return true;
        if (step.promptBlocks !== undefined) {
          const pb = step.promptBlocks;
          if (typeof pb.goal === 'string' && BINDING_TOKEN_DETECT.test(pb.goal)) return true;
          for (const v of [...(pb.constraints ?? []), ...(pb.procedure ?? []), ...(pb.verify ?? [])]) {
            if (typeof v === 'string' && BINDING_TOKEN_DETECT.test(v)) return true;
          }
          for (const v of Object.values(pb.outputRequired ?? {})) {
            if (BINDING_TOKEN_DETECT.test(v)) return true;
          }
        }
        return false;
      };

      for (const step of workflow.definition.steps) {
        if (stepUsesBindingToken(step)) {
          issues.push(`Step '${step.id}': uses {{wr.bindings.*}} token but workflow declares no extensionPoints`);
          suggestions.push('Add an extensionPoints array to the workflow definition');
        }
        if (isLoopStepDefinition(step) && Array.isArray(step.body)) {
          for (const inlineStep of step.body) {
            if (stepUsesBindingToken(inlineStep)) {
              issues.push(`Step '${inlineStep.id ?? 'unknown'}' (loop body): uses {{wr.bindings.*}} token but workflow declares no extensionPoints`);
              suggestions.push('Add an extensionPoints array to the workflow definition');
            }
          }
        }
      }
    }

    // Validate references (structural)
    if (workflow.definition.references !== undefined) {
      const seenRefIds = new Set<string>();
      for (const ref of workflow.definition.references) {
        if (!ref.id || typeof ref.id !== 'string') {
          issues.push(`Workflow reference has missing or empty id`);
        } else {
          if (seenRefIds.has(ref.id)) {
            issues.push(`Workflow reference has duplicate id '${ref.id}'`);
            suggestions.push('Each workflow reference id must be unique');
          }
          seenRefIds.add(ref.id);
        }
        if (!ref.title || typeof ref.title !== 'string') {
          issues.push(`Workflow reference '${ref.id ?? '(unknown)'}' has missing or empty title`);
        }
        if (!ref.source || typeof ref.source !== 'string') {
          issues.push(`Workflow reference '${ref.id ?? '(unknown)'}' has missing or empty source`);
        }
        if (!ref.purpose || typeof ref.purpose !== 'string') {
          issues.push(`Workflow reference '${ref.id ?? '(unknown)'}' has missing or empty purpose`);
        }
        if (typeof ref.authoritative !== 'boolean') {
          issues.push(`Workflow reference '${ref.id ?? '(unknown)'}' has missing or non-boolean authoritative field`);
        }
      }
    }

    // Validate assessments (structural + step reference cross-check)
    const assessments = workflow.definition.assessments ?? [];
    const declaredAssessmentIds = new Set<string>();
    if (assessments.length > 0) {
      for (const assessment of assessments) {
        if (!assessment.id || typeof assessment.id !== 'string') {
          issues.push(`Assessment definition has missing or empty id`);
          continue;
        }
        if (declaredAssessmentIds.has(assessment.id)) {
          issues.push(`assessments has duplicate id '${assessment.id}'`);
          suggestions.push('Each assessment id must be unique within assessments');
        }
        declaredAssessmentIds.add(assessment.id);

        if (!assessment.purpose || typeof assessment.purpose !== 'string') {
          issues.push(`Assessment '${assessment.id}': purpose must be a non-empty string`);
        }
        if (!Array.isArray(assessment.dimensions) || assessment.dimensions.length === 0) {
          issues.push(`Assessment '${assessment.id}': dimensions must contain at least one dimension`);
          continue;
        }

        const seenDimensionIds = new Set<string>();
        for (const dimension of assessment.dimensions) {
          if (!dimension.id || typeof dimension.id !== 'string') {
            issues.push(`Assessment '${assessment.id}': dimension has missing or empty id`);
            continue;
          }
          if (seenDimensionIds.has(dimension.id)) {
            issues.push(`Assessment '${assessment.id}': dimensions has duplicate id '${dimension.id}'`);
            suggestions.push(`Each dimension id must be unique within assessment '${assessment.id}'`);
          }
          seenDimensionIds.add(dimension.id);

          if (!dimension.purpose || typeof dimension.purpose !== 'string') {
            issues.push(`Assessment '${assessment.id}' dimension '${dimension.id}': purpose must be a non-empty string`);
          }
          if (!Array.isArray(dimension.levels) || dimension.levels.length < 2) {
            issues.push(`Assessment '${assessment.id}' dimension '${dimension.id}': levels must contain at least two values`);
            continue;
          }

          const seenLevels = new Set<string>();
          for (const level of dimension.levels) {
            if (!level || typeof level !== 'string') {
              issues.push(`Assessment '${assessment.id}' dimension '${dimension.id}': levels must be non-empty strings`);
              continue;
            }
            if (seenLevels.has(level)) {
              issues.push(`Assessment '${assessment.id}' dimension '${dimension.id}': levels has duplicate value '${level}'`);
              suggestions.push(`Each level must be unique within assessment '${assessment.id}' dimension '${dimension.id}'`);
            }
            seenLevels.add(level);
          }
        }
      }
    }

    // Check for duplicate step IDs
    const stepIds = new Set<string>();
    for (const step of workflow.definition.steps) {
      if (stepIds.has(step.id)) {
        issues.push(`Duplicate step ID '${step.id}'`);
        suggestions.push('Ensure all step IDs are unique');
      }
      stepIds.add(step.id);
    }

    const validateAssessmentRefsForStep = (step: WorkflowStepDefinition, stepLabel: string) => {
      if (step.assessmentRefs === undefined) return;

      if (step.assessmentRefs.length === 0) {
        issues.push(`${stepLabel}: assessmentRefs must not be empty when declared`);
      }

      if (declaredAssessmentIds.size === 0) {
        issues.push(`${stepLabel}: declares assessmentRefs but workflow declares no assessments`);
        suggestions.push('Add an assessments array to the workflow definition');
        return;
      }

      const seenAssessmentRefs = new Set<string>();
      for (const assessmentRef of step.assessmentRefs) {
        if (!assessmentRef || typeof assessmentRef !== 'string') {
          issues.push(`${stepLabel}: assessmentRefs must contain non-empty strings`);
          continue;
        }
        if (seenAssessmentRefs.has(assessmentRef)) {
          issues.push(`${stepLabel}: assessmentRefs has duplicate value '${assessmentRef}'`);
          suggestions.push(`Each assessmentRef must be unique within ${stepLabel}`);
        }
        seenAssessmentRefs.add(assessmentRef);

        if (!declaredAssessmentIds.has(assessmentRef)) {
          issues.push(
            `${stepLabel}: assessmentRef '${assessmentRef}' references undeclared assessment. Declared assessments: [${[...declaredAssessmentIds].join(', ')}]`
          );
          suggestions.push(`Add an assessment with id '${assessmentRef}' to the workflow definition`);
        }
      }
    };

    const validateAssessmentConsequencesForStep = (step: WorkflowStepDefinition, stepLabel: string) => {
      if (step.assessmentConsequences === undefined) return;

      if (step.assessmentConsequences.length === 0) {
        issues.push(`${stepLabel}: assessmentConsequences must not be empty when declared`);
        return;
      }

      if (!step.assessmentRefs || step.assessmentRefs.length === 0) {
        issues.push(`${stepLabel}: assessmentConsequences require at least one assessmentRef on the same step`);
        suggestions.push(`Add at least one assessmentRef to ${stepLabel} before declaring assessmentConsequences`);
        return;
      }

      if (step.assessmentConsequences.length > 1) {
        issues.push(`${stepLabel}: v1 assessment support allows exactly one assessment consequence per step`);
        suggestions.push(`Reduce assessmentConsequences on ${stepLabel} to a single declaration`);
      }

      const referencedDefinitions = assessments.filter(assessment => step.assessmentRefs!.includes(assessment.id));
      if (referencedDefinitions.length === 0) return;

      for (const consequence of step.assessmentConsequences) {
        const trigger = consequence.when;
        const effect = consequence.effect;

        const allLevels = referencedDefinitions.flatMap(def => def.dimensions.flatMap(d => d.levels));
        if (!allLevels.includes(trigger.anyEqualsLevel)) {
          issues.push(
            `${stepLabel}: assessment consequence anyEqualsLevel '${trigger.anyEqualsLevel}' is not declared in any dimension of any referenced assessment`
          );
          suggestions.push(
            `Use a level declared in one of the dimensions: ${[...new Set(allLevels)].join(', ')}`
          );
        }

        if (effect.kind !== 'require_followup') {
          issues.push(`${stepLabel}: unsupported assessment consequence effect '${String((effect as { kind?: unknown }).kind)}'`);
          suggestions.push(`Use the supported v1 effect kind 'require_followup'`);
        }

        if (!effect.guidance || typeof effect.guidance !== 'string') {
          issues.push(`${stepLabel}: assessment consequence guidance must be a non-empty string`);
        }
      }
    };

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

        // Lint loop body inline steps + loop-scoped validationCriteria (if present in body steps)
        this.collectQuotedJsonValidationMessageWarnings(step as any, `Step '${step.id}'`, warnings);
        if (Array.isArray(step.body)) {
          for (const inlineStep of step.body) {
            validateAssessmentRefsForStep(inlineStep, `Loop body step '${inlineStep.id}' in loop '${step.id}'`);
            validateAssessmentConsequencesForStep(inlineStep, `Loop body step '${inlineStep.id}' in loop '${step.id}'`);
          }
        }
      } else {
        // Basic step validation
        if (!step.id) {
          issues.push('Step missing required ID');
        }
        if (!step.title) {
          issues.push(`Step '${step.id}' missing required title`);
        }
        if (!stepHasPromptSource(step as WorkflowStepDefinition)) {
          issues.push(`Step '${step.id}' must have prompt, promptBlocks, or templateCall`);
          suggestions.push('Add a prompt string, structured promptBlocks, or a templateCall to each step');
        }

        // Enforce prompt-source XOR: exactly one of prompt, promptBlocks, templateCall
        const typedStep = step as WorkflowStepDefinition;
        const promptSourceCount =
          (typedStep.prompt ? 1 : 0) +
          ((typedStep as any).promptBlocks ? 1 : 0) +
          ((typedStep as any).templateCall ? 1 : 0);
        if (promptSourceCount > 1) {
          issues.push(`Step '${step.id}' declares multiple prompt sources (prompt, promptBlocks, templateCall) — use exactly one`);
        }

        this.collectQuotedJsonValidationMessageWarnings(step as any, `Step '${step.id}'`, warnings);

        // Validate promptFragments (structural)
        const typedStepForFragments = step as WorkflowStepDefinition;
        if (typedStepForFragments.promptFragments !== undefined) {
          const seenFragmentIds = new Set<string>();
          for (const fragment of typedStepForFragments.promptFragments) {
            if (!fragment.id || typeof fragment.id !== 'string') {
              issues.push(`Step '${step.id}': promptFragment has missing or empty id`);
            } else {
              if (seenFragmentIds.has(fragment.id)) {
                issues.push(`Step '${step.id}': promptFragments has duplicate id '${fragment.id}'`);
                suggestions.push('Each promptFragment id must be unique within a step');
              }
              seenFragmentIds.add(fragment.id);
            }
            if (!fragment.text || typeof fragment.text !== 'string') {
              issues.push(`Step '${step.id}': promptFragment '${fragment.id ?? '(unknown)'}' has missing or empty text`);
            } else if (/\{\{wr\./i.test(fragment.text)) {
              // Fragment texts bypass the compiler token resolution passes — reject WR tokens explicitly.
              issues.push(`Step '${step.id}': promptFragment '${fragment.id}' text contains '{{wr.*}}' token — fragments are raw text and do not support token resolution`);
              suggestions.push('Move {{wr.*}} tokens to the step prompt or promptBlocks where they are resolved at compile time');
            }
          }
        }

        // Validate assessmentRefs (cross-check against workflow-level declarations)
        validateAssessmentRefsForStep(typedStep, `Step '${step.id}'`);
        validateAssessmentConsequencesForStep(typedStep, `Step '${step.id}'`);

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
   * Validate workflow structure (no normalization).
   * Returns Result<Workflow, string[]> for pipeline integration.
   *
   * This is used by the Phase 1a validation pipeline to perform structural checks
   * without triggering normalization (which is handled separately in the pipeline).
   */
  validateWorkflowStructureOnly(workflow: Workflow): Result<Workflow, readonly string[]> {
    const result = this.validateWorkflow(workflow);
    if (result.valid) {
      return ok(workflow);
    }
    return err(result.issues);
  }

  private collectQuotedJsonValidationMessageWarnings(
    stepLike: { readonly validationCriteria?: ValidationCriteria } | undefined,
    prefix: string,
    warnings: string[]
  ): void {
    const criteria = stepLike?.validationCriteria;
    if (!criteria) return;

    const msgs = this.collectValidationRuleMessages(criteria);
    for (const m of msgs) {
      if (!this.looksLikeQuotedJsonSnippet(m)) continue;
      warnings.push(
        `${prefix}: validationCriteria.message appears to contain a quoted JSON snippet. ` +
          `Agents often respond with a JSON-encoded string (escaping quotes) instead of a JSON object. ` +
          `Prefer describing the required object/keys without quoting the JSON (or use schema validation).`
      );
      // One warning per step is plenty.
      return;
    }
  }

  private collectValidationRuleMessages(criteria: ValidationCriteria): string[] {
    // Array format (legacy) is handled by callers via any-cast; support it here defensively.
    if (Array.isArray(criteria)) {
      const msgs: string[] = [];
      for (const r of criteria as any[]) {
        if (r && typeof r === 'object' && typeof (r as any).message === 'string') msgs.push((r as any).message);
      }
      return msgs;
    }

    if (this.isValidationRule(criteria)) {
      return typeof (criteria as any).message === 'string' ? [String((criteria as any).message)] : [];
    }

    if (this.isValidationComposition(criteria)) {
      const msgs: string[] = [];
      const c = criteria as any;
      if (Array.isArray(c.and)) for (const child of c.and) msgs.push(...this.collectValidationRuleMessages(child));
      if (Array.isArray(c.or)) for (const child of c.or) msgs.push(...this.collectValidationRuleMessages(child));
      if (c.not) msgs.push(...this.collectValidationRuleMessages(c.not));
      return msgs;
    }

    return [];
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
