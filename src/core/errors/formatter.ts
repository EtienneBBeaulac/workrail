/**
 * Error Formatting for AI and Logs
 */

import type { AppError } from './app-error.js';
import { assertNever } from './type-guards.js';

export interface FormattedError {
  readonly error: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly suggestions?: readonly string[];
  readonly actionable: string;
}

export function formatErrorForAI(error: AppError): FormattedError {
  switch (error._tag) {
    case 'WorkflowNotFound':
      return {
        error: error._tag,
        message: error.message,
        details: {
          workflowId: error.workflowId,
          availableCount: error.availableCount,
          topWorkflows: error.topWorkflows,
        },
        suggestions: error.suggestions,
        actionable: error.suggestions.length > 0
          ? `Try: ${error.suggestions.slice(0, 3).map(s => `"${s}"`).join(', ')}`
          : `Use workflow_list to see all ${error.availableCount} workflows`,
      };
      
    case 'StepNotFound':
      return {
        error: error._tag,
        message: error.message,
        details: {
          stepId: error.stepId,
          workflowId: error.workflowId,
          availableSteps: error.availableSteps,
        },
        suggestions: error.availableSteps.slice(0, 5),
        actionable: `Available steps: ${error.availableSteps.join(', ')}`,
      };
      
    case 'SessionNotFound':
      return {
        error: error._tag,
        message: error.message,
        details: {
          sessionId: error.sessionId,
          workflowId: error.workflowId,
          recentSessions: error.recentSessions,
        },
        suggestions: error.recentSessions,
        actionable: error.recentSessions.length > 0
          ? `Recent sessions: ${error.recentSessions.join(', ')}`
          : 'Create new session with workrail_create_session',
      };
      
    case 'ValidationFailed':
      return {
        error: error._tag,
        message: error.message,
        details: {
          field: error.field,
          value: error.value,
          issues: error.issues,
          expected: error.expected,
        },
        actionable: error.expected
          ? `The ${error.field} should be: ${error.expected}`
          : `Fix ${error.field}: ${error.issues}`,
      };
      
    case 'ParseFailed':
      return {
        error: error._tag,
        message: error.message,
        details: {
          source: error.source,
          format: error.format,
          line: error.line,
          column: error.column,
        },
        actionable: error.line
          ? `Check ${error.source} at line ${error.line}`
          : `Fix ${error.format} syntax in ${error.source}`,
      };
      
    case 'SchemaViolation':
      return {
        error: error._tag,
        message: error.message,
        details: {
          path: error.path,
          expected: error.expected,
          actual: error.actual,
        },
        actionable: `Fix ${error.path}: expected ${error.expected}`,
      };
      
    case 'ConfigInvalid':
      return {
        error: error._tag,
        message: error.message,
        details: { issues: error.issues },
        actionable: `Fix configuration:\n${error.issues.map(i => `  - ${i}`).join('\n')}`,
      };
      
    case 'StartupFailed':
      return {
        error: error._tag,
        message: error.message,
        details: {
          phase: error.phase,
          details: error.details,
        },
        actionable: `Startup failed during ${error.phase}. Check configuration and restart.`,
      };
      
    case 'UnexpectedError':
      return {
        error: error._tag,
        message: error.message,
        details: { operation: error.operation },
        actionable: 'Check server logs for details',
      };
      
    case 'ContextSizeExceeded':
      return {
        error: error._tag,
        message: error.message,
        details: {
          sizeKB: error.sizeKB,
          maxKB: error.maxKB,
          operation: error.operation,
        },
        actionable: `Reduce context size. Current: ${error.sizeKB}KB, Max: ${error.maxKB}KB`,
      };
      
    case 'LoopStackCorruption':
      return {
        error: error._tag,
        message: error.message,
        details: {
          loopId: error.loopId,
          details: error.details,
        },
        actionable: 'This is a bug. Please report with reproduction steps.',
      };
      
    case 'MaxIterationsExceeded':
      return {
        error: error._tag,
        message: error.message,
        details: {
          workflowId: error.workflowId,
          iterations: error.iterations,
          loopIds: error.loopIds,
        },
        actionable: `Workflow has infinite loop. Check: ${error.loopIds.join(', ')}`,
      };
      
    default:
      return assertNever(error);
  }
}

export function formatErrorForLogs(error: AppError): Record<string, unknown> {
  const base: Record<string, unknown> = {
    errorTag: error._tag,
    message: error.message,
  };
  
  for (const [key, value] of Object.entries(error)) {
    if (key !== '_tag' && key !== 'message') {
      base[key] = value;
    }
  }
  
  return base;
}
