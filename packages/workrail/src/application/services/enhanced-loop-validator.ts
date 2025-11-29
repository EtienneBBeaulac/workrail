import { singleton } from 'tsyringe';
import { WorkflowStep } from '../../types/mcp-types';
import { LoopStep } from '../../types/workflow-types';

export interface EnhancedValidationResult {
  warnings: string[];
  suggestions: string[];
  info: string[];
}

@singleton()
export class EnhancedLoopValidator {
  private readonly PROMPT_WARNING_THRESHOLD = 1500;
  private readonly PROMPT_ERROR_THRESHOLD = 2000;
  private readonly TEMPLATE_VAR_PATTERN = /\{\{([^}]+)\}\}/g;
  private readonly TERNARY_PATTERN = /\{\{[^}]*\?[^}]*:[^}]*\}\}/;
  private readonly NESTED_TERNARY_PATTERN = /\{\{[^}]*\?[^}]*\?[^}]*:[^}]*:[^}]*\}\}/;

  /**
   * Performs enhanced validation on loop steps
   */
  validateLoopStep(step: LoopStep): EnhancedValidationResult {
    const warnings: string[] = [];
    const suggestions: string[] = [];
    const info: string[] = [];

    // Get all steps to validate
    const stepsToValidate = this.getLoopBodySteps(step);

    for (const bodyStep of stepsToValidate) {
      // Check for complex conditional logic
      this.validateConditionalLogic(bodyStep, warnings, suggestions);

      // Validate prompt length
      this.validatePromptLength(bodyStep, warnings, suggestions);

      // Validate template variable usage
      this.validateTemplateVariables(bodyStep, step, warnings, suggestions);
    }

    // Detect common patterns
    this.detectLoopPatterns(step, info, suggestions);

    // Check overall loop structure
    this.validateLoopStructure(step, warnings, suggestions);

    return { warnings, suggestions, info };
  }

  private getLoopBodySteps(step: LoopStep): WorkflowStep[] {
    if (Array.isArray(step.body)) {
      return step.body;
    }
    // For string references, we can't validate the actual steps here
    // That's handled by the main validation engine
    return [];
  }

  private validateConditionalLogic(
    step: WorkflowStep,
    warnings: string[],
    suggestions: string[]
  ): void {
    const fieldsToCheck = ['prompt', 'title', 'agentRole'];
    
    for (const field of fieldsToCheck) {
      const value = (step as any)[field];
      if (!value || typeof value !== 'string') continue;

      // Check for nested ternary operators
      if (this.NESTED_TERNARY_PATTERN.test(value)) {
        warnings.push(
          `Step '${step.id}' contains nested ternary operators in ${field}. This can be hard to read and maintain.`
        );
        suggestions.push(
          `Consider refactoring nested conditionals into separate steps with runCondition.`
        );
      } 
      // Check for any ternary operators
      else if (this.TERNARY_PATTERN.test(value)) {
        const ternaryCount = (value.match(/\?/g) || []).length;
        if (ternaryCount >= 2) {
          warnings.push(
            `Step '${step.id}' contains complex conditional logic (${ternaryCount} conditions) in ${field}.`
          );
          suggestions.push(
            `For loops with ${ternaryCount} or more conditional paths, consider using separate steps with runCondition instead of inline conditionals.`
          );
        }
      }
    }
  }

  private validatePromptLength(
    step: WorkflowStep,
    warnings: string[],
    suggestions: string[]
  ): void {
    if (!step.prompt) return;

    const promptLength = step.prompt.length;

    // Check raw prompt length
    if (promptLength > this.PROMPT_ERROR_THRESHOLD) {
      warnings.push(
        `Step '${step.id}' has a very long prompt (${promptLength} characters). This may cause issues.`
      );
      suggestions.push(
        `Consider splitting this into multiple steps or moving content to the guidance section.`
      );
    } else if (promptLength > this.PROMPT_WARNING_THRESHOLD) {
      warnings.push(
        `Step '${step.id}' has a long prompt (${promptLength} characters).`
      );
      suggestions.push(
        `For better maintainability, consider breaking this into smaller, focused steps.`
      );
    }

    // Check for conditional expansion
    const conditionalMatches = step.prompt.match(/\{\{[^}]*\?[^}]*\}\}/g);
    if (conditionalMatches) {
      // Estimate total content size when all branches are included
      let totalConditionalContent = 0;
      for (const match of conditionalMatches) {
        // Count all string literals in the conditional
        const literals = match.match(/'[^']*'|"[^"]*"/g) || [];
        for (const literal of literals) {
          totalConditionalContent += literal.length - 2; // Subtract quotes
        }
      }

      if (totalConditionalContent > this.PROMPT_ERROR_THRESHOLD) {
        warnings.push(
          `Step '${step.id}' has conditional content totaling ~${totalConditionalContent} characters when expanded.`
        );
        suggestions.push(
          `This exceeds safe limits. Use separate steps with runCondition instead of inline conditionals.`
        );
      }
    }
  }

  private validateTemplateVariables(
    step: WorkflowStep,
    loopStep: LoopStep,
    warnings: string[],
    suggestions: string[]
  ): void {
    const knownVars = this.getKnownLoopVariables(loopStep);
    const fieldsToCheck = ['prompt', 'title', 'agentRole'];

    for (const field of fieldsToCheck) {
      const value = (step as any)[field];
      if (!value || typeof value !== 'string') continue;

      const matches = value.matchAll(this.TEMPLATE_VAR_PATTERN);
      for (const match of matches) {
        const expression = match[1].trim();
        // Extract the variable name (before any operators)
        const varName = expression.split(/[^a-zA-Z0-9_$]/, 1)[0];
        
        if (varName && !knownVars.has(varName)) {
          warnings.push(
            `Step '${step.id}' references potentially undefined variable '${varName}' in ${field}.`
          );
          suggestions.push(
            `Ensure '${varName}' is defined in the context or use a known loop variable like: ${Array.from(knownVars).join(', ')}`
          );
        }
      }
    }
  }

  private getKnownLoopVariables(loopStep: LoopStep): Set<string> {
    const vars = new Set<string>();

    // Default iteration variable
    vars.add(loopStep.loop.iterationVar || 'iteration');

    // For forEach loops
    if (loopStep.loop.type === 'forEach') {
      vars.add(loopStep.loop.itemVar || 'item');
      vars.add(loopStep.loop.indexVar || 'index');
    }

    // Common context variables (these would be defined elsewhere)
    vars.add('context');
    vars.add('workflowId');
    
    return vars;
  }

  private detectLoopPatterns(
    step: LoopStep,
    info: string[],
    suggestions: string[]
  ): void {
    const bodySteps = this.getLoopBodySteps(step);
    
    // Progressive analysis pattern
    if (step.loop.type === 'for' && bodySteps.length > 0) {
      const firstStep = bodySteps[0];
      if (firstStep.prompt?.includes('analysis') || 
          firstStep.title?.toLowerCase().includes('analysis') ||
          firstStep.prompt?.includes('Step 1') ||
          firstStep.prompt?.includes('Structure')) {
        info.push('Progressive analysis pattern detected.');
        suggestions.push(
          'Consider using the multi-step pattern with separate steps and runCondition for clearer structure.'
        );
      }
    }

    // Multi-conditional pattern
    if (bodySteps.some(s => s.prompt?.includes('===') && s.prompt?.includes('?'))) {
      info.push('Multi-conditional loop pattern detected.');
      suggestions.push(
        'For loops with multiple conditional paths, the separate steps pattern is more maintainable than inline conditionals.'
      );
    }
  }

  private validateLoopStructure(
    step: LoopStep,
    warnings: string[],
    suggestions: string[]
  ): void {
    // Check if using string reference with complex patterns
    if (typeof step.body === 'string' && step.loop.type === 'for' && 
        typeof step.loop.count === 'number' && step.loop.count > 3) {
      suggestions.push(
        `For loops with ${step.loop.count} iterations, consider if each iteration truly needs different logic. ` +
        `If so, use separate steps with runCondition for better clarity.`
      );
    }

    // Validate maxIterations is reasonable
    if (step.loop.maxIterations > 100) {
      warnings.push(
        `Loop '${step.id}' has a very high maxIterations limit (${step.loop.maxIterations}). ` +
        `This could cause performance issues.`
      );
      suggestions.push(
        `Consider if you really need ${step.loop.maxIterations} iterations, or implement pagination/chunking instead.`
      );
    }
  }
}