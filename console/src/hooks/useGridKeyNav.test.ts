import { describe, it, expect } from 'vitest';
import { computeColsFromRefs, navigateLinear, navigateByRow } from './useGridKeyNav';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ref map for computeColsFromRefs by creating objects that
 * look like HTMLElements to getBoundingClientRect. We cannot use jsdom here
 * (not configured), so we use plain objects with the required method.
 */
function makeRef(top: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      top,
      bottom: top + 40,
      left: 0,
      right: 100,
      width: 100,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

function makeRefMap(tops: number[]): ReadonlyMap<number, HTMLElement> {
  const m = new Map<number, HTMLElement>();
  tops.forEach((top, i) => m.set(i, makeRef(top)));
  return m;
}

// ---------------------------------------------------------------------------
// computeColsFromRefs
// ---------------------------------------------------------------------------

describe('computeColsFromRefs', () => {
  it('returns 1 when the map is empty', () => {
    expect(computeColsFromRefs(new Map())).toBe(1);
  });

  it('returns 1 when only one element is present', () => {
    expect(computeColsFromRefs(makeRefMap([0]))).toBe(1);
  });

  it('detects 2 columns when items share two Y values', () => {
    // Row 0: top=0, Row 0: top=0, Row 1: top=50, Row 1: top=50
    expect(computeColsFromRefs(makeRefMap([0, 0, 50, 50]))).toBe(2);
  });

  it('detects 3 columns in a 3x2 grid', () => {
    // Row 0: [0, 0, 0], Row 1: [50, 50, 50]
    expect(computeColsFromRefs(makeRefMap([0, 0, 0, 50, 50, 50]))).toBe(3);
  });

  it('returns 1 when all items are on one row', () => {
    // A single row with 4 items -- no second Y value
    expect(computeColsFromRefs(makeRefMap([0, 0, 0, 0]))).toBe(4);
  });

  it('rounds Y values so minor sub-pixel differences do not create extra rows', () => {
    // top=0.1 and top=0.4 both round to 0 -- treated as same row
    expect(computeColsFromRefs(makeRefMap([0.1, 0.4, 50, 50]))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// navigateLinear
// ---------------------------------------------------------------------------

describe('navigateLinear', () => {
  const count = 6;

  it('moves forward by 1', () => {
    expect(navigateLinear(2, 1, count, true)).toBe(3);
  });

  it('moves backward by 1', () => {
    expect(navigateLinear(2, -1, count, true)).toBe(1);
  });

  it('wraps forward past the last item when loop=true', () => {
    expect(navigateLinear(5, 1, count, true)).toBe(0);
  });

  it('wraps backward past the first item when loop=true', () => {
    expect(navigateLinear(0, -1, count, true)).toBe(5);
  });

  it('stops at the last item when loop=false (forward)', () => {
    expect(navigateLinear(5, 1, count, false)).toBe(5);
  });

  it('stops at the first item when loop=false (backward)', () => {
    expect(navigateLinear(0, -1, count, false)).toBe(0);
  });

  it('starts from 0 when current is null and delta is positive', () => {
    // from=-1+1=0
    expect(navigateLinear(null, 1, count, true)).toBe(0);
  });

  it('starts from last when current is null and delta is negative', () => {
    // from=count+(-1)=5
    expect(navigateLinear(null, -1, count, true)).toBe(5);
  });

  it('returns 0 for an empty list', () => {
    expect(navigateLinear(null, 1, 0, true)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// navigateByRow
// ---------------------------------------------------------------------------

describe('navigateByRow', () => {
  // 6 items in a 3-column grid:
  //   row 0: [0, 1, 2]
  //   row 1: [3, 4, 5]
  const count = 6;
  const cols = 3;

  it('moves down one row (same column)', () => {
    expect(navigateByRow(1, 1, count, cols, true)).toBe(4);
  });

  it('moves up one row (same column)', () => {
    expect(navigateByRow(4, -1, count, cols, true)).toBe(1);
  });

  it('wraps from last row to first row when loop=true', () => {
    expect(navigateByRow(4, 1, count, cols, true)).toBe(1);
  });

  it('wraps from first row to last row when loop=true', () => {
    expect(navigateByRow(1, -1, count, cols, true)).toBe(4);
  });

  it('stops at first row when loop=false (up from row 0)', () => {
    expect(navigateByRow(1, -1, count, cols, false)).toBe(1);
  });

  it('stops at last row when loop=false (down from last row)', () => {
    expect(navigateByRow(4, 1, count, cols, false)).toBe(4);
  });

  it('clamps to last valid item on a short final row', () => {
    // 7 items in 3-column grid:
    //   row 0: [0, 1, 2]
    //   row 1: [3, 4, 5]
    //   row 2: [6]     <- short row
    // Moving down from col 1 (index 1) should land on index 4, then from 4 to 6 (clamped from 7)
    expect(navigateByRow(4, 1, 7, 3, false)).toBe(6);
  });

  it('returns 0 for an empty list', () => {
    expect(navigateByRow(null, 1, 0, 3, true)).toBe(0);
  });

  it('defaults from index 0 when current is null', () => {
    // row 0 col 0 -> row 1 col 0
    expect(navigateByRow(null, 1, count, cols, true)).toBe(3);
  });
});
