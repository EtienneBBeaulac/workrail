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
 *
 * The index Maps are built eagerly by createWorkflow() to enable O(1) lookups
 * for hot-path operations (step lookup, parent loop resolution, loop lookup).
 * Object.freeze is shallow, so the Map references are pointer-immutable; the
 * ReadonlyMap type enforces content immutability at compile time.
 */
export interface Workflow {
  /** The workflow definition (from JSON file) */
  readonly definition: WorkflowDefinition;

  /** Where this workflow was loaded from */
  readonly source: WorkflowSource;

  // ==========================================================================
  // PRE-BUILT INDICES (O(1) lookups -- built eagerly at createWorkflow() time)
  // ==========================================================================

  /**
   * All steps (top-level and loop-body) indexed by step ID.
   * Enables O(1) replacement of the linear scan in getStepById.
   */
  readonly stepById: ReadonlyMap<string, WorkflowStepDefinition | LoopStepDefinition>;

  /**
   * Maps each loop-body step ID to its parent LoopStepDefinition.
   * Top-level steps are absent (not present in the map).
   * Enables O(1) replacement of the double-nested scan in resolveParentLoopStep.
   */
  readonly parentLoopByStepId: ReadonlyMap<string, LoopStepDefinition>;

  /**
   * Maps loop step IDs to their LoopStepDefinition.
   * Enables O(1) replacement of the recursive findLoopById scan.
   */
  readonly loopById: ReadonlyMap<string, LoopStepDefinition>;

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
 * Build the three pre-built index Maps for a workflow definition.
 * Called once at createWorkflow() time -- O(n) upfront, O(1) per lookup thereafter.
 */
function buildWorkflowIndices(definition: WorkflowDefinition): {
  readonly stepById: ReadonlyMap<string, WorkflowStepDefinition | LoopStepDefinition>;
  readonly parentLoopByStepId: ReadonlyMap<string, LoopStepDefinition>;
  readonly loopById: ReadonlyMap<string, LoopStepDefinition>;
} {
  const stepById = new Map<string, WorkflowStepDefinition | LoopStepDefinition>();
  const parentLoopByStepId = new Map<string, LoopStepDefinition>();
  const loopById = new Map<string, LoopStepDefinition>();

  function indexSteps(
    steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
    parentLoop: LoopStepDefinition | null
  ): void {
    for (const step of steps) {
      stepById.set(step.id, step);

      if (parentLoop !== null) {
        parentLoopByStepId.set(step.id, parentLoop);
      }

      if ('type' in step && step.type === 'loop') {
        loopById.set(step.id, step);

        if (Array.isArray(step.body)) {
          indexSteps(step.body, step);
        }
      }
    }
  }

  // Guard: definition.steps may be absent when createWorkflow is called with a
  // partially-constructed definition (e.g. during JSON validation flows).
  indexSteps(definition.steps ?? [], null);

  return { stepById, parentLoopByStepId, loopById };
}

/**
 * Create an immutable Workflow from definition and source.
 * Eagerly builds O(1) lookup indices for hot-path operations.
 */
export function createWorkflow(
  definition: WorkflowDefinition,
  source: WorkflowSource
): Workflow {
  const { stepById, parentLoopByStepId, loopById } = buildWorkflowIndices(definition);
  return Object.freeze({
    definition,
    source,
    stepById,
    parentLoopByStepId,
    loopById,
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
 * O(1) lookup via the pre-built stepById index (built at createWorkflow() time).
 */
export function getStepById(
  workflow: Workflow,
  stepId: string
): WorkflowStepDefinition | LoopStepDefinition | null {
  return workflow.stepById.get(stepId) ?? null;
}

/**
 * Get all step IDs from a workflow (including loop body steps).
 * Uses the pre-built stepById index for consistency with other accessors.
 */
export function getAllStepIds(workflow: Workflow): readonly string[] {
  return Object.freeze([...workflow.stepById.keys()]);
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
    'stepById' in candidate &&
    'parentLoopByStepId' in candidate &&
    'loopById' in candidate &&
    candidate['definition'] !== null &&
    typeof candidate['definition'] === 'object' &&
    candidate['source'] !== null &&
    typeof candidate['source'] === 'object' &&
    candidate['stepById'] instanceof Map &&
    candidate['parentLoopByStepId'] instanceof Map &&
    candidate['loopById'] instanceof Map
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
} from './workflow-source';
