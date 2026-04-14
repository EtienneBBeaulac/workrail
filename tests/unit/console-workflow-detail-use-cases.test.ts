/**
 * Unit tests for workflow-detail-use-cases.ts pure functions.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  getAdjacentWorkflows,
} from '../../console/src/views/workflow-detail-use-cases';
import type { ConsoleWorkflowSummary } from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkflow(id: string): ConsoleWorkflowSummary {
  return {
    id,
    name: `Workflow ${id}`,
    description: null,
    version: '1.0.0',
    tags: [],
    source: { kind: 'bundled', displayName: 'WorkRail' },
    stepCount: 1,
  };
}

const WF_A = makeWorkflow('wf-a');
const WF_B = makeWorkflow('wf-b');
const WF_C = makeWorkflow('wf-c');
const LIST = [WF_A, WF_B, WF_C] as const;

// ---------------------------------------------------------------------------
// getAdjacentWorkflows
// ---------------------------------------------------------------------------

describe('getAdjacentWorkflows', () => {
  it('returns both null for null workflowId', () => {
    const result = getAdjacentWorkflows(null, LIST);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toBeNull();
  });

  it('returns both null for empty string workflowId', () => {
    const result = getAdjacentWorkflows('', LIST);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toBeNull();
  });

  it('returns both null for workflowId not in list', () => {
    const result = getAdjacentWorkflows('wf-unknown', LIST);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toBeNull();
  });

  it('returns both null for empty workflow list', () => {
    const result = getAdjacentWorkflows('wf-a', []);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toBeNull();
  });

  it('first item has null prev and correct next', () => {
    const result = getAdjacentWorkflows('wf-a', LIST);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toEqual(WF_B);
  });

  it('middle item has correct prev and next', () => {
    const result = getAdjacentWorkflows('wf-b', LIST);
    expect(result.prevWorkflow).toEqual(WF_A);
    expect(result.nextWorkflow).toEqual(WF_C);
  });

  it('last item has correct prev and null next', () => {
    const result = getAdjacentWorkflows('wf-c', LIST);
    expect(result.prevWorkflow).toEqual(WF_B);
    expect(result.nextWorkflow).toBeNull();
  });

  it('single-item list returns both null', () => {
    const result = getAdjacentWorkflows('wf-a', [WF_A]);
    expect(result.prevWorkflow).toBeNull();
    expect(result.nextWorkflow).toBeNull();
  });

  it('is pure -- does not mutate the input list', () => {
    const input = [WF_A, WF_B, WF_C];
    const frozen = Object.freeze([...input]);
    expect(() => getAdjacentWorkflows('wf-b', frozen)).not.toThrow();
  });
});
