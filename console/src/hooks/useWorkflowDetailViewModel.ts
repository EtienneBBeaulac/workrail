/**
 * ViewModel hook for WorkflowDetail.
 *
 * Orchestrates the repository layer into a single WorkflowDetailViewState
 * discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via useWorkflowDetailRepository)
 * - Adjacent workflow list for prev/next navigation (via useWorkflowsRepository)
 * - Optimistic partial header data while detail loads (from workflows list cache)
 * - Keyboard navigation: ArrowLeft/ArrowRight for prev/next workflow
 *   (document-level listener, only installed when kind === 'ready')
 * - Derived display data: name, description, tags, source, activeTagLabel
 *
 * Does NOT own:
 * - URL navigation (injected via onBack and onNavigateToWorkflow callbacks)
 * - JSX rendering
 */
import { useMemo, useEffect, useRef } from 'react';
import { useWorkflowDetailRepository } from './useWorkflowDetailRepository';
import { useWorkflowsRepository } from './useWorkflowsRepository';
import { getAdjacentWorkflows } from '../views/workflow-detail-use-cases';
import type { ConsoleWorkflowDetail, ConsoleWorkflowSummary, ConsoleWorkflowSourceInfo } from '../api/types';
import { TAG_DISPLAY } from '../config/tags';

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type WorkflowDetailViewState =
  | {
      readonly kind: 'loading';
      /**
       * Optimistic partial data from the cached workflow list.
       * Present when the list cache is warm -- allows the view to render the
       * header (name, tags, source) while the detail fetch is still in-flight.
       * Absent during a cold load with no cached data.
       */
      readonly cached: ConsoleWorkflowSummary | null;
      readonly activeTagLabel: string | null;
      readonly onBack: () => void;
    }
  | { readonly kind: 'not_found'; readonly onBack: () => void }
  | { readonly kind: 'error'; readonly message: string; readonly onBack: () => void; readonly onRetry: () => void }
  | {
      readonly kind: 'ready';
      readonly workflow: ConsoleWorkflowDetail;
      readonly name: string;
      readonly description: string | null;
      readonly tags: readonly string[];
      readonly source: ConsoleWorkflowSourceInfo | null;
      readonly activeTagLabel: string | null;
      readonly adjacentWorkflows: readonly ConsoleWorkflowSummary[];
      /** Null when this is the first workflow in the adjacent list. */
      readonly onPrev: (() => void) | null;
      /** Null when this is the last workflow in the adjacent list. */
      readonly onNext: (() => void) | null;
      readonly onBack: () => void;
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UseWorkflowDetailViewModelResult {
  readonly state: WorkflowDetailViewState;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface UseWorkflowDetailViewModelParams {
  /**
   * The workflow to display. Pass null or empty string when no workflow is
   * selected -- the query is disabled and the state stays at 'loading'.
   */
  readonly workflowId: string | null;
  /** Active tag filter from the URL, used to derive the breadcrumb label. */
  readonly activeTag?: string | null;
  /** Navigate back to the workflows list (preserving tag filter). */
  readonly onBack: () => void;
  /** Navigate to an adjacent workflow detail page. */
  readonly onNavigateToWorkflow: (id: string) => void;
}

// ---------------------------------------------------------------------------
// ViewModel hook
// ---------------------------------------------------------------------------

export function useWorkflowDetailViewModel({
  workflowId,
  activeTag,
  onBack,
  onNavigateToWorkflow,
}: UseWorkflowDetailViewModelParams): UseWorkflowDetailViewModelResult {
  const repo = useWorkflowDetailRepository(workflowId);

  // useWorkflowsRepository provides the full non-routines workflow list.
  // Used for two purposes:
  //   1. Adjacent workflow list to derive onPrev / onNext
  //   2. Optimistic partial data (cached list entry) to show header fields
  //      while the detail fetch is still in-flight.
  const listRepo = useWorkflowsRepository();
  const workflows = listRepo.workflows;

  // Refs for keyboard handler -- updated each render so the handler always
  // calls the latest callbacks without needing to reinstall.
  const onPrevRef = useRef<(() => void) | null>(null);
  const onNextRef = useRef<(() => void) | null>(null);
  const onNavigateToWorkflowRef = useRef(onNavigateToWorkflow);
  onNavigateToWorkflowRef.current = onNavigateToWorkflow;

  // Derive adjacent navigation via pure use case. adjacentWorkflows is the
  // full non-routines list in catalog order (no tag filter applied -- navigate
  // across all workflows, not just the current tag filter).
  const adjacentWorkflows: readonly ConsoleWorkflowSummary[] = workflows ?? [];
  const { prevWorkflow, nextWorkflow } = useMemo(
    () => getAdjacentWorkflows(workflowId, adjacentWorkflows),
    [workflowId, adjacentWorkflows],
  );

  const onPrev = prevWorkflow
    ? (): void => onNavigateToWorkflowRef.current(prevWorkflow.id)
    : null;
  const onNext = nextWorkflow
    ? (): void => onNavigateToWorkflowRef.current(nextWorkflow.id)
    : null;

  // Keep refs current so the keyboard handler always calls the latest callbacks.
  onPrevRef.current = onPrev;
  onNextRef.current = onNext;

  // Document-level keyboard handler: ArrowLeft / ArrowRight navigate to
  // prev / next workflow. Installed only when state is 'ready'.
  // Uses a single stable effect with refs to prevent stale closures.
  const isReady = repo.kind === 'ready';
  useEffect(() => {
    if (!isReady) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPrevRef.current?.();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNextRef.current?.();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isReady]);

  const state = useMemo((): WorkflowDetailViewState => {
    // Optimistic partial data from the cached workflow list. Used to populate
    // header fields (name, description, tags, source) while the detail fetch
    // is still loading, giving the user immediate visual feedback.
    const cachedPartial = workflows?.find((w) => w.id === workflowId) ?? undefined;

    const activeTagLabel = activeTag ? (TAG_DISPLAY[activeTag] ?? activeTag) : null;

    if (repo.kind === 'not_found') return { kind: 'not_found', onBack };
    if (repo.kind === 'error') return { kind: 'error', message: repo.message, onBack, onRetry: repo.refetch };

    if (repo.kind === 'ready') {
      const detail = repo.detail;

      // Derive display fields with detail as primary source and cached partial
      // as fallback. Both should have the same values once detail loads, but
      // the fallback prevents a flash of missing data during the fetch.
      const name = detail.name ?? cachedPartial?.name ?? workflowId ?? '';
      const description = detail.description ?? cachedPartial?.description ?? null;
      const tags = detail.tags ?? cachedPartial?.tags ?? [];
      const source = detail.source ?? cachedPartial?.source ?? null;

      return {
        kind: 'ready',
        workflow: detail,
        name,
        description,
        tags,
        source,
        activeTagLabel,
        adjacentWorkflows,
        onPrev,
        onNext,
        onBack,
      };
    }

    // kind === 'loading': include cached partial data so the view can render
    // the header optimistically while the detail fetch is still in-flight.
    return { kind: 'loading', cached: cachedPartial ?? null, activeTagLabel, onBack };
  }, [repo, workflows, workflowId, activeTag, adjacentWorkflows, onPrev, onNext, onBack]);

  return { state };
}
