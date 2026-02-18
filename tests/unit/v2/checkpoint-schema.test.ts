/**
 * Checkpoint Schema Tests
 *
 * Tests that:
 * - V2CheckpointWorkflowOutputSchema validates correct shapes
 * - V2ContinueWorkflowOutputSchema accepts checkpointToken
 * - V2StartWorkflowOutputSchema accepts checkpointToken
 */

import { describe, it, expect } from 'vitest';
import {
  V2CheckpointWorkflowOutputSchema,
  V2ContinueWorkflowOutputSchema,
  V2StartWorkflowOutputSchema,
} from '../../../src/mcp/output-schemas.js';

// Use valid bech32m-charset tokens for schema tests
const VALID_STATE = 'st1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_ACK = 'ack1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_CHK = 'chk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

describe('V2CheckpointWorkflowOutputSchema', () => {
  it('accepts valid checkpoint output', () => {
    const result = V2CheckpointWorkflowOutputSchema.safeParse({
      checkpointNodeId: 'chk-node-001',
      stateToken: VALID_STATE,
      nextCall: { tool: 'continue_workflow', params: { intent: 'rehydrate', stateToken: VALID_STATE } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing checkpointNodeId', () => {
    const result = V2CheckpointWorkflowOutputSchema.safeParse({
      stateToken: VALID_STATE,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing stateToken', () => {
    const result = V2CheckpointWorkflowOutputSchema.safeParse({
      checkpointNodeId: 'chk-node-001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid stateToken format', () => {
    const result = V2CheckpointWorkflowOutputSchema.safeParse({
      checkpointNodeId: 'chk-node-001',
      stateToken: 'invalid-format',
    });
    expect(result.success).toBe(false);
  });
});

describe('checkpointToken in continue_workflow output', () => {
  const validBase = {
    kind: 'ok' as const,
    stateToken: VALID_STATE,
    isComplete: false,
    pending: { stepId: 'step-1', title: 'Step 1', prompt: 'Do stuff' },
    ackToken: VALID_ACK,
    preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
    nextIntent: 'perform_pending_then_continue',
    nextCall: {
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: VALID_STATE, ackToken: VALID_ACK },
    },
  };

  it('accepts response with checkpointToken', () => {
    const result = V2ContinueWorkflowOutputSchema.safeParse({
      ...validBase,
      checkpointToken: VALID_CHK,
    });
    expect(result.success).toBe(true);
  });

  it('accepts response without checkpointToken (backward compatible)', () => {
    const result = V2ContinueWorkflowOutputSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('rejects invalid checkpointToken format', () => {
    const result = V2ContinueWorkflowOutputSchema.safeParse({
      ...validBase,
      checkpointToken: 'invalid-format',
    });
    expect(result.success).toBe(false);
  });
});

describe('checkpointToken in start_workflow output', () => {
  const validBase = {
    stateToken: VALID_STATE,
    ackToken: VALID_ACK,
    isComplete: false,
    pending: { stepId: 'step-1', title: 'Step 1', prompt: 'Do stuff' },
    preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
    nextIntent: 'perform_pending_then_continue',
    nextCall: {
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: VALID_STATE, ackToken: VALID_ACK },
    },
  };

  it('accepts response with checkpointToken', () => {
    const result = V2StartWorkflowOutputSchema.safeParse({
      ...validBase,
      checkpointToken: VALID_CHK,
    });
    expect(result.success).toBe(true);
  });

  it('accepts response without checkpointToken (backward compatible)', () => {
    const result = V2StartWorkflowOutputSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});
