/**
 * Workflow Types
 * 
 * A workflow as it exists in our runtime system.
 * Combines the pure definition with runtime metadata.
 * 
 * This is the PRIMARY TYPE that flows through the application.
 * Add new runtime metadata fields here as needed.
 */

import { WorkflowDefinition, WorkflowStepDefinition, LoopStepDefinition } from './workflow-definition';
import { WorkflowSource, getSourceDisplayName } from './workflow-source';

// =============================================================================
// CORE WORKFLOW TYPE
// =============================================================================

/**
 * A workflow as it exists in our runtime system.
 * 
 * IMPORTANT: This is different from WorkflowDefinition.
 * - WorkflowDefinition: What's in the JSON file (pure, serializable)
 * - Workflow: Runtime representation (includes source, potentially other metadata)
 * 
 * All code that operates on "workflows" should use this type.
 * Only use WorkflowDefinition when dealing with raw file I/O.
 */
export interface Workflow {
  /** The workflow definition (from JSON file) */
  readonly definition: WorkflowDefinition;
  
  /** Where this workflow was loaded from */
  readonly source: WorkflowSource;
  
  // ==========================================================================
  // FUTURE EXTENSIBILITY - add new runtime metadata fields here:
  // ==========================================================================
  // readonly loadedAt?: Date;
  // readonly priority?: number;
  // readonly overriddenBy?: string;
  // readonly tags?: readonly string[];
}

// =============================================================================
// WORKFLOW SUMMARY (for listing)
// =============================================================================

/**
 * Lightweight summary for workflow listings.
 * Used by workflow_list tool.
 */
export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly source: WorkflowSourceInfo;
}

/**
 * Public-facing source info (sanitized for API consumers).
 * Does not expose internal paths.
 */
export interface WorkflowSourceInfo {
  readonly kind: WorkflowSource['kind'];
  readonly displayName: string;
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an immutable Workflow from definition and source.
 */
export function createWorkflow(
  definition: WorkflowDefinition,
  source: WorkflowSource
): Workflow {
  return Object.freeze({
    definition,
    source
  });
}

/**
 * Create a WorkflowSummary from a Workflow.
 * Pure function - no side effects.
 */
export function toWorkflowSummary(workflow: Workflow): WorkflowSummary {
  return Object.freeze({
    id: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    source: toWorkflowSourceInfo(workflow.source)
  });
}

/**
 * Create public-facing source info from internal source.
 * Sanitizes sensitive information like file paths.
 */
export function toWorkflowSourceInfo(source: WorkflowSource): WorkflowSourceInfo {
  return Object.freeze({
    kind: source.kind,
    displayName: getSourceDisplayName(source)
  });
}

// =============================================================================
// CONVENIENCE ACCESSORS
// =============================================================================

/**
 * Get a step from a workflow by ID.
 * Searches through all steps including loop bodies.
 */
export function getStepById(
  workflow: Workflow,
  stepId: string
): WorkflowStepDefinition | LoopStepDefinition | null {
  const steps = workflow.definition.steps;
  
  for (const step of steps) {
    if (step.id === stepId) {
      return step;
    }
    
    // Search in loop bodies
    if ('type' in step && step.type === 'loop' && Array.isArray(step.body)) {
      for (const bodyStep of step.body) {
        if (bodyStep.id === stepId) {
          return bodyStep;
        }
      }
    }
  }
  
  return null;
}

/**
 * Get all step IDs from a workflow (including loop body steps).
 */
export function getAllStepIds(workflow: Workflow): readonly string[] {
  const ids: string[] = [];
  
  for (const step of workflow.definition.steps) {
    ids.push(step.id);
    
    if ('type' in step && step.type === 'loop' && Array.isArray(step.body)) {
      for (const bodyStep of step.body) {
        ids.push(bodyStep.id);
      }
    }
  }
  
  return Object.freeze(ids);
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if an object is a Workflow (runtime representation).
 */
export function isWorkflow(obj: unknown): obj is Workflow {
  if (!obj || typeof obj !== 'object') return false;
  
  const candidate = obj as Record<string, unknown>;
  
  return (
    'definition' in candidate &&
    'source' in candidate &&
    candidate['definition'] !== null &&
    typeof candidate['definition'] === 'object' &&
    candidate['source'] !== null &&
    typeof candidate['source'] === 'object'
  );
}

/**
 * Check if an object is a WorkflowDefinition (file representation).
 * Use this when you need to distinguish between the two types.
 */
export function isWorkflowDefinition(obj: unknown): obj is WorkflowDefinition {
  if (!obj || typeof obj !== 'object') return false;
  
  const candidate = obj as Record<string, unknown>;
  
  // WorkflowDefinition has 'id' directly, Workflow has 'definition'
  return (
    'id' in candidate &&
    'name' in candidate &&
    'steps' in candidate &&
    !('definition' in candidate)
  );
}

// =============================================================================
// RE-EXPORTS for convenience
// =============================================================================

export type {
  WorkflowDefinition,
  WorkflowStepDefinition,
  LoopStepDefinition,
  LoopConfigDefinition,
  FunctionDefinition,
  FunctionParameter,
  FunctionCall
} from './workflow-definition';

export {
  isLoopStepDefinition,
  isWorkflowStepDefinition,
  hasWorkflowDefinitionShape
} from './workflow-definition';

export type {
  WorkflowSource,
  WorkflowSourceKind,
  BundledSource,
  UserDirectorySource,
  ProjectDirectorySource,
  CustomDirectorySource,
  GitRepositorySource,
  RemoteRegistrySource,
  PluginSource
} from './workflow-source';

export {
  WORKFLOW_SOURCE_KINDS,
  createBundledSource,
  createUserDirectorySource,
  createProjectDirectorySource,
  createCustomDirectorySource,
  createGitRepositorySource,
  createRemoteRegistrySource,
  createPluginSource,
  getSourceDisplayName,
  getSourcePath,
  assertNever
} from './workflow-source';
