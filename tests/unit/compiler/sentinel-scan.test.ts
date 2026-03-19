/**
 * Tests for sentinelScanPass
 *
 * Verifies the defense-in-depth scan that catches surviving {{wr.*}} tokens
 * in compiled step prompts.
 */
import { describe, it, expect } from 'vitest';
import { sentinelScanPass } from '../../../src/application/services/compiler/sentinel-scan.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string, prompt?: string): WorkflowStepDefinition {
  return { id, title: id, ...(prompt !== undefined ? { prompt } : {}) } as WorkflowStepDefinition;
}

// ---------------------------------------------------------------------------
// Clean prompts — no false positives
// ---------------------------------------------------------------------------

describe('sentinelScanPass — clean prompts', () => {
  it('returns ok for a step with no tokens', () => {
    const result = sentinelScanPass([makeStep('s1', 'No tokens here.')]);
    expect(result.isOk()).toBe(true);
  });

  it('returns ok for an empty steps array', () => {
    const result = sentinelScanPass([]);
    expect(result.isOk()).toBe(true);
  });

  it('does not false-positive on JSON single braces', () => {
    const step = makeStep('s1', '{"kind": "wr.loop_control", "decision": "stop"}');
    expect(sentinelScanPass([step]).isOk()).toBe(true);
  });

  it('does not false-positive on generic Mustache {{variableName}}', () => {
    const step = makeStep('s1', 'Use {{variableName}} for your answer.');
    expect(sentinelScanPass([step]).isOk()).toBe(true);
  });

  it('does not false-positive on {{wr without a dot', () => {
    const step = makeStep('s1', '{{wrapping}} is important here.');
    expect(sentinelScanPass([step]).isOk()).toBe(true);
  });

  it('loop container with no prompt is handled gracefully', () => {
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: [makeStep('body-step', 'Clean body prompt.')],
    };
    expect(sentinelScanPass([loopStep]).isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error cases — surviving tokens
// ---------------------------------------------------------------------------

describe('sentinelScanPass — unresolved tokens', () => {
  it('catches surviving {{wr.bindings.*}} in top-level step prompt', () => {
    const step = makeStep('s1', 'Delegate to {{wr.bindings.design_review}}.');
    const result = sentinelScanPass([step]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe('UNRESOLVED_TOKEN');
    expect(e.stepId).toBe('s1');
    expect(e.token).toBe('{{wr.bindings.design_review}}');
  });

  it('catches surviving {{wr.refs.*}} in top-level step prompt', () => {
    const step = makeStep('s1', 'Use {{wr.refs.memory_usage}} here.');
    const result = sentinelScanPass([step]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNRESOLVED_TOKEN');
  });

  it('catches surviving token in inline loop body step', () => {
    const bodyStep = makeStep('body-step', 'Delegate to {{wr.bindings.final_verification}}.');
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: [bodyStep],
    };
    const result = sentinelScanPass([loopStep]);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe('UNRESOLVED_TOKEN');
    expect(e.stepId).toBe('body-step');
  });

  it('does not catch loop body token in string-body form (that step is in top-level)', () => {
    // String-body loops reference a step in the top-level array — the sentinel
    // catches it via the top-level scan, not via loop traversal.
    const step = makeStep('ref-step', 'Delegate to {{wr.bindings.design_review}}.');
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 3 },
      body: 'ref-step', // string body — ref-step is in the top-level array
    };
    const result = sentinelScanPass([step, loopStep]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().stepId).toBe('ref-step');
  });

  it('returns ok for steps that have no prompt property', () => {
    const stepNoPrompt = makeStep('s-no-prompt');
    expect(sentinelScanPass([stepNoPrompt]).isOk()).toBe(true);
  });
});
