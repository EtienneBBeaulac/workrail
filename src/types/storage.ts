// =============================================================================
// WORKFLOW STORAGE INTERFACES
// =============================================================================

import { 
  Workflow, 
  WorkflowSummary, 
  WorkflowDefinition,
  WorkflowSource 
} from './workflow';

/**
 * Base interface for workflow reading operations.
 * All storage implementations provide these core operations.
 * 
 * Services should depend on this interface when they only need read access.
 */
export interface IWorkflowReader {
  /**
   * Load and return all workflows available in this storage.
   * Each workflow includes the source information.
   */
  loadAllWorkflows(): Promise<readonly Workflow[]>;

  /**
   * Retrieve a single workflow by its unique identifier.
   * @param id The workflow definition's `id` field.
   * @returns The workflow with source attached, or null if not found.
   */
  getWorkflowById(id: string): Promise<Workflow | null>;

  /**
   * Return lightweight summaries for all workflows (used by `workflow_list`).
   * Summaries include source information.
   */
  listWorkflowSummaries(): Promise<readonly WorkflowSummary[]>;

  /**
   * (Optional) Persist or update a workflow definition.
   * Only the definition is saved - source is determined by storage location.
   */
  save?(definition: WorkflowDefinition): Promise<void>;
}

/**
 * Single-source workflow storage.
 * 
 * Each instance is bound to exactly one WorkflowSource, injected at construction.
 * Discriminated by the 'source' property.
 */
export interface IWorkflowStorage extends IWorkflowReader {
  /**
   * The source this storage represents.
   * Immutable, set at construction time.
   */
  readonly source: WorkflowSource;
  
  /**
   * Discriminator for type guards.
   */
  readonly kind: 'single';
}

/**
 * Multi-source composite workflow storage.
 * 
 * Composes multiple IWorkflowStorage instances with priority-based resolution.
 * Discriminated by the getSources() method.
 */
export interface ICompositeWorkflowStorage extends IWorkflowReader {
  /**
   * Discriminator for type guards.
   */
  readonly kind: 'composite';
  
  /**
   * Get information about all configured sources.
   */
  getSources(): readonly WorkflowSource[];
}

/**
 * Union type representing any workflow storage.
 * Use type guards to safely access source-specific features.
 */
export type AnyWorkflowStorage = IWorkflowStorage | ICompositeWorkflowStorage;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if storage is single-source.
 * Provides access to the 'source' property.
 */
export function isSingleSourceStorage(
  storage: AnyWorkflowStorage
): storage is IWorkflowStorage {
  return storage.kind === 'single';
}

/**
 * Type guard to check if storage is composite (multi-source).
 * Provides access to the getSources() method.
 */
export function isCompositeStorage(
  storage: AnyWorkflowStorage
): storage is ICompositeWorkflowStorage {
  return storage.kind === 'composite';
}
