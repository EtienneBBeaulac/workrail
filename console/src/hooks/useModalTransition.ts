/**
 * Hook that encapsulates all CRT/glitch animation state for the workflow modal.
 *
 * Extracted from WorkflowsView to separate pure visual effects from data state.
 * The hook owns: scanlineKey, crtOffset, glitchY, glitchY2, glitchW, glitchW2,
 * contentAnimClass, borderFlashing, and the transition timing logic.
 *
 * The caller owns: selectedWorkflowId (data state), flatWorkflows (derived data).
 * The hook never reads workflow data -- it only receives callbacks from the caller.
 */
import { useState, useRef, type RefObject } from 'react';
import type { ConsoleWorkflowSummary } from '../api/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModalScanlineProps {
  /** Increments on each transition; used as React key to remount the scanline element. */
  readonly key: number;
  readonly crtOffset: number;
  readonly glitchY: number;
  readonly glitchY2: number;
  readonly glitchW: number;
  readonly glitchW2: number;
}

export interface ModalTransitionState {
  /** True during an active transition animation. */
  readonly isAnimating: boolean;
  /** CSS class applied to the modal content area for enter/exit animations. */
  readonly contentAnimClass: string;
  /** True briefly during a transition for the border flash effect. */
  readonly borderFlashing: boolean;
  /**
   * Scanline overlay props. null when no transition has fired yet (key=0).
   * The scanline element is only rendered when key > 0.
   */
  readonly scanline: ModalScanlineProps | null;
}

export interface UseModalTransitionResult {
  readonly state: ModalTransitionState;
  /**
   * Start a transition to the workflow at nextIndex.
   * @param nextIndex    - index into flatWorkflows
   * @param direction    - 'prev' | 'next' for enter/exit animation direction
   * @param axis         - 'horizontal' | 'vertical' for animation axis
   * @param onMidpoint   - called at 80ms midpoint with the next workflow ID; caller
   *                       should update selectedWorkflowId here
   * @param scrollRef    - ref to the scrollable container (reset to top on transition)
   * @param flatWorkflows - current workflow list (used to find the workflow ID)
   */
  readonly startTransition: (
    nextIndex: number,
    direction: 'prev' | 'next',
    axis: 'horizontal' | 'vertical',
    onMidpoint: (nextId: string) => void,
    scrollRef: RefObject<HTMLDivElement | null>,
    flatWorkflows: readonly ConsoleWorkflowSummary[],
  ) => void;
  /**
   * Navigate to the previous or next workflow in the list. Handles the
   * pending-nav queue for rapid key presses during animation.
   * @param selectedWorkflowId - current workflow ID
   * @param flatWorkflows       - current workflow list
   * @param direction           - nav direction
   * @param axis                - animation axis
   * @param onMidpoint          - called at 80ms with next workflow ID
   * @param scrollRef           - scrollable container ref
   */
  readonly navigate: (
    selectedWorkflowId: string | null,
    flatWorkflows: readonly ConsoleWorkflowSummary[],
    direction: 'prev' | 'next',
    axis: 'horizontal' | 'vertical',
    onMidpoint: (nextId: string) => void,
    scrollRef: RefObject<HTMLDivElement | null>,
  ) => void;
  /**
   * Ref that tracks the current workflow ID post-transition for use inside
   * setTimeout callbacks. Caller must keep this in sync on every ID change.
   */
  readonly selectedWorkflowIdRef: RefObject<string | null>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useModalTransition(): UseModalTransitionResult {
  const [scanlineKey, setScanlineKey] = useState(0);
  const [crtOffset, setCrtOffset] = useState(0);
  const [glitchY, setGlitchY] = useState(38);
  const [glitchY2, setGlitchY2] = useState(62);
  const [glitchW, setGlitchW] = useState(3);
  const [glitchW2, setGlitchW2] = useState(2);
  const [contentAnimClass, setContentAnimClass] = useState('');
  const [borderFlashing, setBorderFlashing] = useState(false);

  // Tracks isAnimating imperatively to avoid double-render on rapid key presses
  const isAnimatingRef = useRef(false);
  // Pending navigation index queued while an animation is in progress
  const pendingNavRef = useRef<number | null>(null);
  // Tracks the post-transition workflow ID for use in setTimeout callbacks.
  // Avoids stale closure over the selectedWorkflowId state value.
  const selectedWorkflowIdRef = useRef<string | null>(null);

  // startTransitionRef allows startTransition to call itself recursively via
  // the timeout callback without creating a stale closure.
  const startTransitionRef = useRef<UseModalTransitionResult['startTransition'] | null>(null);

  const startTransition: UseModalTransitionResult['startTransition'] = (
    nextIndex,
    direction,
    axis,
    onMidpoint,
    scrollRef,
    flatWorkflows,
  ) => {
    isAnimatingRef.current = true;
    setBorderFlashing(true);
    setScanlineKey((k: number) => k + 1);
    setCrtOffset(Math.floor(Math.random() * 4));
    setGlitchY(5 + Math.floor(Math.random() * 80));
    setGlitchY2(5 + Math.floor(Math.random() * 80));
    setGlitchW(2 + Math.floor(Math.random() * 40)); // 2-42px
    setGlitchW2(2 + Math.floor(Math.random() * 25)); // 2-27px

    const exitClass =
      axis === 'horizontal'
        ? direction === 'next'
          ? 'modal-content--exit-h-next'
          : 'modal-content--exit-h-prev'
        : direction === 'next'
        ? 'modal-content--exit-v-next'
        : 'modal-content--exit-v-prev';
    setContentAnimClass(exitClass);

    // Reset modal scroll position immediately
    if (scrollRef.current) scrollRef.current.scrollTop = 0;

    // At midpoint (80ms), swap the workflow ID and start enter animation.
    // The caller provides onMidpoint to update selectedWorkflowId.
    const nextId = flatWorkflows[nextIndex]!.id;
    setTimeout(() => {
      onMidpoint(nextId);
      const enterClass =
        axis === 'horizontal'
          ? direction === 'next'
            ? 'modal-content--enter-h-next'
            : 'modal-content--enter-h-prev'
          : direction === 'next'
          ? 'modal-content--enter-v-next'
          : 'modal-content--enter-v-prev';
      setContentAnimClass(enterClass);
      setBorderFlashing(false);
    }, 80);

    // After full animation (240ms), clear animation state and process pending nav.
    // Use selectedWorkflowIdRef (not closed-over state) for the post-transition value.
    setTimeout(() => {
      setContentAnimClass('');
      isAnimatingRef.current = false;
      if (pendingNavRef.current !== null) {
        const pending = pendingNavRef.current;
        pendingNavRef.current = null;
        const cur = flatWorkflows.findIndex((w) => w.id === selectedWorkflowIdRef.current);
        const dir = pending > cur ? 'next' : 'prev';
        startTransitionRef.current?.(pending, dir, 'horizontal', onMidpoint, scrollRef, flatWorkflows);
      }
    }, 240);
  };

  // Keep the ref in sync so the timeout callback always calls the latest version
  startTransitionRef.current = startTransition;

  const navigate: UseModalTransitionResult['navigate'] = (
    selectedWorkflowId,
    flatWorkflows,
    direction,
    axis,
    onMidpoint,
    scrollRef,
  ) => {
    if (flatWorkflows.length <= 1) return;
    const current = flatWorkflows.findIndex((w) => w.id === selectedWorkflowId);
    if (current === -1) return;

    const nextIndex =
      direction === 'next'
        ? (current + 1) % flatWorkflows.length
        : (current - 1 + flatWorkflows.length) % flatWorkflows.length;

    if (isAnimatingRef.current) {
      pendingNavRef.current = nextIndex;
      return;
    }

    startTransition(nextIndex, direction, axis, onMidpoint, scrollRef, flatWorkflows);
  };

  const state: ModalTransitionState = {
    isAnimating: isAnimatingRef.current,
    contentAnimClass,
    borderFlashing,
    scanline:
      scanlineKey > 0
        ? { key: scanlineKey, crtOffset, glitchY, glitchY2, glitchW, glitchW2 }
        : null,
  };

  return { state, startTransition, navigate, selectedWorkflowIdRef };
}
