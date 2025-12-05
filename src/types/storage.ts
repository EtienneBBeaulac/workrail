// =============================================================================
// WORKFLOW STORAGE INTERFACES
// =============================================================================

import { Workflow, WorkflowSummary } from './mcp-types';

/**
 * Generic interface for any workflow storage backend.
 * The default implementation uses the local filesystem, but additional
 * backends (e.g., in-memory, database, remote) can implement this contract.
 */
export interface IWorkflowStorage {
  /**
   * Load and return all workflows available in this storage backend.
   */
  loadAllWorkflows(): Promise<Workflow[]>;

  /**
   * Retrieve a single workflow by its unique identifier.
   * @param id The workflow `id` field.
   */
  getWorkflowById(id: string): Promise<Workflow | null>;

  /**
   * Return lightweight summaries for all workflows (used by `workflow_list`).
   */
  listWorkflowSummaries(): Promise<WorkflowSummary[]>;

  /**
   * (Optional) Persist or update a workflow definition.
   * Not used by the current read-only MVP but included for future parity.
   */
  save?(workflow: Workflow): Promise<void>;
} 