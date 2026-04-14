/**
 * Unit tests for workflows-use-cases.ts pure functions.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows console-workspace-types.test.ts.
 *
 * Covers:
 *   - getAvailableTags: sorted unique non-routines tags
 *   - getAvailableSources: unique source options
 *   - filterWorkflows: tag + source filtering
 *   - flattenWorkflows: flat list for keyboard navigation
 */
import { describe, it, expect } from 'vitest';
import {
  getAvailableTags,
  getAvailableSources,
  filterWorkflows,
  flattenWorkflows,
} from '../../console/src/views/workflows-use-cases';
import type { ConsoleWorkflowSummary } from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

let idCounter = 0;

// Reset before each test so IDs are deterministic regardless of test order.
beforeEach(() => { idCounter = 0; });

function makeWorkflow(overrides: Partial<ConsoleWorkflowSummary> = {}): ConsoleWorkflowSummary {
  idCounter += 1;
  return {
    id: `wf-${idCounter}`,
    name: `Workflow ${idCounter}`,
    description: `Description ${idCounter}`,
    version: '1.0.0',
    tags: [],
    source: { kind: 'bundled', displayName: 'Bundled' },
    stepCount: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getAvailableTags
// ---------------------------------------------------------------------------

describe('getAvailableTags', () => {
  it('returns empty array for empty workflow list', () => {
    expect(getAvailableTags([])).toEqual([]);
  });

  it('excludes the routines tag', () => {
    const workflows = [makeWorkflow({ tags: ['routines', 'coding'] })];
    const tags = getAvailableTags(workflows);
    expect(tags).not.toContain('routines');
    expect(tags).toContain('coding');
  });

  it('returns unique tags (deduplication)', () => {
    const workflows = [
      makeWorkflow({ tags: ['coding'] }),
      makeWorkflow({ tags: ['coding', 'design'] }),
    ];
    const tags = getAvailableTags(workflows);
    expect(tags.filter((t) => t === 'coding')).toHaveLength(1);
    expect(tags).toContain('design');
  });

  it('follows CATALOG_TAGS order for known tags', () => {
    // coding comes before design in CATALOG_TAGS
    const workflows = [
      makeWorkflow({ tags: ['design'] }),
      makeWorkflow({ tags: ['coding'] }),
    ];
    const tags = getAvailableTags(workflows);
    const codingIndex = tags.indexOf('coding');
    const designIndex = tags.indexOf('design');
    expect(codingIndex).toBeLessThan(designIndex);
  });

  it('places unknown tags alphabetically after known tags', () => {
    const workflows = [
      makeWorkflow({ tags: ['coding'] }),
      makeWorkflow({ tags: ['zzz-unknown'] }),
    ];
    const tags = getAvailableTags(workflows);
    const codingIndex = tags.indexOf('coding');
    const unknownIndex = tags.indexOf('zzz-unknown');
    expect(codingIndex).toBeLessThan(unknownIndex);
  });

  it('returns only tags present in the workflow list', () => {
    const workflows = [makeWorkflow({ tags: ['coding'] })];
    const tags = getAvailableTags(workflows);
    expect(tags).not.toContain('design');
    expect(tags).not.toContain('investigation');
  });
});

// ---------------------------------------------------------------------------
// getAvailableSources
// ---------------------------------------------------------------------------

describe('getAvailableSources', () => {
  it('returns empty array for empty workflow list', () => {
    expect(getAvailableSources([])).toEqual([]);
  });

  it('returns unique sources by kind', () => {
    const workflows = [
      makeWorkflow({ source: { kind: 'bundled', displayName: 'Bundled' } }),
      makeWorkflow({ source: { kind: 'bundled', displayName: 'Bundled' } }),
      makeWorkflow({ source: { kind: 'user', displayName: 'User' } }),
    ];
    const sources = getAvailableSources(workflows);
    expect(sources).toHaveLength(2);
  });

  it('uses kind as id and displayName from the workflow', () => {
    const workflows = [
      makeWorkflow({ source: { kind: 'user', displayName: 'My Custom Workflows' } }),
    ];
    const sources = getAvailableSources(workflows);
    expect(sources[0]).toEqual({ id: 'user', displayName: 'My Custom Workflows' });
  });

  it('preserves first-seen order', () => {
    const workflows = [
      makeWorkflow({ source: { kind: 'user', displayName: 'User' } }),
      makeWorkflow({ source: { kind: 'bundled', displayName: 'Bundled' } }),
    ];
    const sources = getAvailableSources(workflows);
    expect(sources[0]!.id).toBe('user');
    expect(sources[1]!.id).toBe('bundled');
  });
});

// ---------------------------------------------------------------------------
// filterWorkflows
// ---------------------------------------------------------------------------

describe('filterWorkflows', () => {
  const bundledWorkflow = makeWorkflow({
    tags: ['coding'],
    source: { kind: 'bundled', displayName: 'Bundled' },
  });
  const userWorkflow = makeWorkflow({
    tags: ['design'],
    source: { kind: 'user', displayName: 'Custom' },
  });
  const untaggedWorkflow = makeWorkflow({
    tags: [],
    source: { kind: 'bundled', displayName: 'Bundled' },
  });

  const allWorkflows = [bundledWorkflow, userWorkflow, untaggedWorkflow];

  it('returns all workflows when tag and source are null', () => {
    const result = filterWorkflows(allWorkflows, null, null);
    expect(result).toHaveLength(3);
  });

  it('filters by tag', () => {
    const result = filterWorkflows(allWorkflows, 'coding', null);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(bundledWorkflow.id);
  });

  it('filters by __other__ (no known catalog tag)', () => {
    // untaggedWorkflow has no known tags, bundledWorkflow has 'coding' (known), userWorkflow has 'design' (known)
    const result = filterWorkflows(allWorkflows, '__other__', null);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(untaggedWorkflow.id);
  });

  it('filters by source displayName', () => {
    const result = filterWorkflows(allWorkflows, null, 'Custom');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(userWorkflow.id);
  });

  it('combines tag and source filters (AND logic)', () => {
    // coding + Bundled -> bundledWorkflow only
    const result = filterWorkflows(allWorkflows, 'coding', 'Bundled');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(bundledWorkflow.id);
  });

  it('returns empty array when no workflows match', () => {
    const result = filterWorkflows(allWorkflows, 'coding', 'Custom');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterWorkflows([], 'coding', null)).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const input = [...allWorkflows];
    const originalLength = input.length;
    filterWorkflows(input, 'coding', null);
    expect(input).toHaveLength(originalLength);
  });
});

// ---------------------------------------------------------------------------
// flattenWorkflows
// ---------------------------------------------------------------------------

describe('flattenWorkflows', () => {
  it('returns filtered list as-is when selectedTag is non-null', () => {
    const wf1 = makeWorkflow({ tags: ['coding'] });
    const wf2 = makeWorkflow({ tags: ['coding'] });
    const result = flattenWorkflows([wf1, wf2], 'coding');
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(wf1.id);
    expect(result[1]!.id).toBe(wf2.id);
  });

  it('returns empty array for empty input', () => {
    expect(flattenWorkflows([], null)).toHaveLength(0);
    expect(flattenWorkflows([], 'coding')).toHaveLength(0);
  });

  it('when selectedTag is null, orders by CATALOG_TAGS group order', () => {
    // coding comes before design in CATALOG_TAGS
    const designWorkflow = makeWorkflow({ tags: ['design'] });
    const codingWorkflow = makeWorkflow({ tags: ['coding'] });
    // Pass in design first, expect coding first in output
    const result = flattenWorkflows([designWorkflow, codingWorkflow], null);
    expect(result[0]!.id).toBe(codingWorkflow.id);
    expect(result[1]!.id).toBe(designWorkflow.id);
  });

  it('when selectedTag is null, places untagged workflows at the end', () => {
    const codingWorkflow = makeWorkflow({ tags: ['coding'] });
    const untaggedWorkflow = makeWorkflow({ tags: [] });
    const result = flattenWorkflows([untaggedWorkflow, codingWorkflow], null);
    expect(result[0]!.id).toBe(codingWorkflow.id);
    expect(result[1]!.id).toBe(untaggedWorkflow.id);
  });

  it('when selectedTag is null, preserves order within each group', () => {
    const coding1 = makeWorkflow({ tags: ['coding'] });
    const coding2 = makeWorkflow({ tags: ['coding'] });
    const result = flattenWorkflows([coding1, coding2], null);
    expect(result[0]!.id).toBe(coding1.id);
    expect(result[1]!.id).toBe(coding2.id);
  });

  it('when selectedTag is null with __other__ tag, places in other group at end', () => {
    // __other__ as selectedTag is handled by filterWorkflows, not flattenWorkflows.
    // flattenWorkflows only groups by CATALOG_TAGS -- unknown-tag workflows go at end.
    const codingWorkflow = makeWorkflow({ tags: ['coding'] });
    const unknownTagWorkflow = makeWorkflow({ tags: ['some-unknown-tag'] });
    const result = flattenWorkflows([unknownTagWorkflow, codingWorkflow], null);
    expect(result[0]!.id).toBe(codingWorkflow.id);
    expect(result[1]!.id).toBe(unknownTagWorkflow.id);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeWorkflow({ tags: ['design'] }),
      makeWorkflow({ tags: ['coding'] }),
    ];
    const originalOrder = input.map((w) => w.id);
    flattenWorkflows(input, null);
    expect(input.map((w) => w.id)).toEqual(originalOrder);
  });
});
