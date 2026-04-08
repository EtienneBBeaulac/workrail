import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UseGridKeyNavOptions {
  /** Total number of navigable items. */
  readonly count: number;
  /**
   * Number of columns for up/down navigation.
   *
   * - A positive integer uses a fixed column count.
   * - `'auto'` detects columns from the DOM at key-press time by grouping item
   *   refs with matching Y offsets. Falls back to 1 if fewer than two refs are
   *   available.
   */
  readonly cols?: number | 'auto';
  /**
   * Called when the focused item is activated via Enter or Space.
   * The native click event still fires separately; this callback lets parent
   * components trigger the same action from keyboard-only paths.
   */
  readonly onActivate?: (index: number) => void;
  /**
   * When true (the default), navigation wraps around at list edges.
   * Disable to create a hard stop at the first and last items.
   */
  readonly loop?: boolean;
}

export interface UseGridKeyNavResult {
  /** The index of the currently focused item, or null when no item is focused. */
  readonly focusedIndex: number | null;
  /** Programmatically move focus to a specific index (or clear it with null). */
  readonly setFocusedIndex: (i: number | null) => void;
  /**
   * Returns props to spread onto each navigable item element.
   *
   * @example
   * ```tsx
   * {items.map((item, i) => (
   *   <button key={item.id} {...getItemProps(i)} onClick={() => select(item)}>
   *     {item.label}
   *   </button>
   * ))}
   * ```
   */
  readonly getItemProps: (index: number) => {
    tabIndex: number;
    onKeyDown: (e: KeyboardEvent) => void;
    onFocus: () => void;
    ref: (el: HTMLElement | null) => void;
  };
  /** Props to spread onto the container element. */
  readonly containerProps: {
    role: string;
  };
}

// ---------------------------------------------------------------------------
// Pure navigation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Compute the number of columns in a grid by grouping item elements that share
 * the same rounded Y offset. Returns 1 if fewer than two elements are present.
 */
export function computeColsFromRefs(refs: ReadonlyMap<number, HTMLElement>): number {
  if (refs.size < 2) return 1;

  // Collect all Y offsets present in the ref map.
  const yOffsets = new Set<number>();
  for (const el of refs.values()) {
    yOffsets.add(Math.round(el.getBoundingClientRect().top));
  }

  if (yOffsets.size < 2) {
    // All items on one row -- count how many share the first Y.
    const firstY = Math.round(refs.get(0)?.getBoundingClientRect().top ?? 0);
    let count = 0;
    for (const el of refs.values()) {
      if (Math.round(el.getBoundingClientRect().top) === firstY) count++;
    }
    return Math.max(1, count);
  }

  // Count items that share the same Y as the first item.
  const firstY = Math.round(refs.get(0)?.getBoundingClientRect().top ?? 0);
  let cols = 0;
  for (const el of refs.values()) {
    if (Math.round(el.getBoundingClientRect().top) === firstY) cols++;
  }
  return Math.max(1, cols);
}

/**
 * Navigate to the next index given direction and grid geometry.
 *
 * @param current  - Current focused index (or null for no selection)
 * @param delta    - Steps to move (positive = forward, negative = backward)
 * @param count    - Total item count
 * @param loop     - Whether to wrap at edges
 */
export function navigateLinear(
  current: number | null,
  delta: number,
  count: number,
  loop: boolean,
): number {
  if (count === 0) return 0;
  const from = current ?? (delta > 0 ? -1 : count);
  const next = from + delta;
  if (loop) return ((next % count) + count) % count;
  return Math.max(0, Math.min(count - 1, next));
}

/**
 * Navigate by rows (up/down) given a grid with a fixed column count.
 */
export function navigateByRow(
  current: number | null,
  rowDelta: number,
  count: number,
  cols: number,
  loop: boolean,
): number {
  if (count === 0) return 0;
  const from = current ?? 0;
  const col = from % cols;
  const row = Math.floor(from / cols);
  const totalRows = Math.ceil(count / cols);
  let nextRow = row + rowDelta;

  if (loop) {
    nextRow = ((nextRow % totalRows) + totalRows) % totalRows;
  } else {
    nextRow = Math.max(0, Math.min(totalRows - 1, nextRow));
  }

  // Clamp to valid index on the last (possibly short) row.
  const candidate = nextRow * cols + col;
  return Math.min(candidate, count - 1);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Reusable keyboard grid (or list) navigation hook.
 *
 * Provides roving tabindex behaviour so only the focused item is in the natural
 * tab sequence. Arrow keys (and WASD) move focus within the grid. Enter/Space
 * call `onActivate`. Home/End jump to the first and last items.
 *
 * ## Usage
 *
 * ```tsx
 * const { getItemProps, containerProps } = useGridKeyNav({
 *   count: items.length,
 *   cols: 'auto',           // detect columns from DOM
 *   onActivate: (i) => openItem(items[i]),
 * });
 *
 * return (
 *   <div {...containerProps}>
 *     {items.map((item, i) => (
 *       <button key={item.id} {...getItemProps(i)} onClick={() => openItem(item)}>
 *         {item.label}
 *       </button>
 *     ))}
 *   </div>
 * );
 * ```
 *
 * ## Why roving tabindex?
 *
 * A flat `tabIndex={0}` on every card creates an O(n) tab stop sequence that is
 * tedious to navigate. Roving tabindex keeps exactly one item in the tab order
 * at a time, so Tab/Shift-Tab move between logical sections while arrow keys
 * navigate within the grid.
 *
 * @see https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_roving_tabindex
 */
export function useGridKeyNav({
  count,
  cols = 'auto',
  onActivate,
  loop = true,
}: UseGridKeyNavOptions): UseGridKeyNavResult {
  const [focusedIndex, setFocusedIndexState] = useState<number | null>(null);
  const itemRefs = useRef<Map<number, HTMLElement>>(new Map());

  const setFocusedIndex = useCallback((i: number | null) => {
    setFocusedIndexState(i);
    if (i !== null) {
      const el = itemRefs.current.get(i);
      el?.focus();
    }
  }, []);

  const resolvedCols = useCallback((): number => {
    if (cols === 'auto') return computeColsFromRefs(itemRefs.current);
    return Math.max(1, cols);
  }, [cols]);

  const getItemProps = useCallback((index: number) => {
    return {
      tabIndex: focusedIndex === null ? (index === 0 ? 0 : -1) : (focusedIndex === index ? 0 : -1),
      onFocus: () => {
        setFocusedIndexState(index);
      },
      onKeyDown: (e: KeyboardEvent) => {
        const c = resolvedCols();

        let next: number | null = null;

        switch (e.key) {
          case 'ArrowRight':
          case 'd':
          case 'D':
            next = navigateLinear(index, 1, count, loop);
            break;
          case 'ArrowLeft':
          case 'a':
          case 'A':
            next = navigateLinear(index, -1, count, loop);
            break;
          case 'ArrowDown':
          case 's':
          case 'S':
            next = navigateByRow(index, 1, count, c, loop);
            break;
          case 'ArrowUp':
          case 'w':
          case 'W':
            next = navigateByRow(index, -1, count, c, loop);
            break;
          case 'Home':
            next = 0;
            break;
          case 'End':
            next = count - 1;
            break;
          case 'Enter':
          case ' ':
            // Prevent page scroll on Space; call onActivate in addition to the
            // native click that the browser will fire.
            e.preventDefault();
            onActivate?.(index);
            return;
          default:
            return;
        }

        if (next !== null) {
          e.preventDefault();
          setFocusedIndex(next);
        }
      },
      ref: (el: HTMLElement | null) => {
        if (el) {
          itemRefs.current.set(index, el);
        } else {
          itemRefs.current.delete(index);
        }
      },
    };
  }, [focusedIndex, count, loop, resolvedCols, onActivate, setFocusedIndex]);

  return {
    focusedIndex,
    setFocusedIndex,
    getItemProps,
    containerProps: { role: 'grid' },
  };
}
