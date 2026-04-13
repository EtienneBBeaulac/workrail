/**
 * ViewModel hook for SessionDetail.
 *
 * Orchestrates the repository layer into a single SessionDetailViewState
 * discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via useSessionDetailRepository)
 * - UI interaction state (selectedNode toggle via useState)
 * - Derived display data (selectedRun lookup via useMemo)
 * - Interaction handlers (onSelectNode, onCloseNode)
 *
 * Does NOT own:
 * - Any JSX rendering
 * - API hooks directly (accessed via repository only)
 *
 * No reducer needed: the only interaction state is a single selectedNode
 * toggle with no multi-event state machine. useState is sufficient.
 */
import { useState, useCallback, useMemo } from 'react';
import { useSessionDetailRepository } from './useSessionDetailRepository';
import type { ConsoleSessionDetail, ConsoleDagRun } from '../api/types';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface SelectedNode {
  readonly runId: string;
  readonly nodeId: string;
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type SessionDetailViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      /** The session ID, always available for child components like NodeDetailSection. */
      readonly sessionId: string;
      /** Full session detail data. */
      readonly data: ConsoleSessionDetail;
      /** Currently selected node, or null if none is selected. */
      readonly selectedNode: SelectedNode | null;
      /**
       * The run containing the selected node, or null if no node is selected
       * or the run cannot be found.
       */
      readonly selectedRun: ConsoleDagRun | null;
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UseSessionDetailViewModelResult {
  readonly state: SessionDetailViewState;
  /**
   * Select or deselect a node. Calling with the currently selected runId+nodeId
   * toggles it off (deselects). Calling with a different node selects it.
   */
  readonly onSelectNode: (runId: string, nodeId: string) => void;
  /** Explicitly close the node detail panel (sets selectedNode to null). */
  readonly onCloseNode: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionDetailViewModel(sessionId: string): UseSessionDetailViewModelResult {
  const repo = useSessionDetailRepository(sessionId);
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);

  const onSelectNode = useCallback((runId: string, nodeId: string) => {
    setSelectedNode((prev) =>
      prev?.runId === runId && prev?.nodeId === nodeId ? null : { runId, nodeId },
    );
  }, []);

  const onCloseNode = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Derive selectedRun from selectedNode + data.runs
  const { isLoading, error, data } = repo;

  const selectedRun = useMemo((): ConsoleDagRun | null => {
    if (!data || !selectedNode) return null;
    return data.runs.find((r) => r.runId === selectedNode.runId) ?? null;
  }, [data, selectedNode]);

  const state = useMemo((): SessionDetailViewState => {
    if (isLoading) return { kind: 'loading' };
    if (error) return { kind: 'error', message: error.message };
    if (!data) return { kind: 'loading' };

    return {
      kind: 'ready',
      sessionId,
      data,
      selectedNode,
      selectedRun,
    };
  }, [isLoading, error, data, sessionId, selectedNode, selectedRun]);

  return { state, onSelectNode, onCloseNode };
}
