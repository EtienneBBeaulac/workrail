/**
 * Type safety tests - proving branded types prevent misuse.
 *
 * These tests use TypeScript's type system to ensure:
 * - SessionId cannot be used where RunId expected
 * - Raw strings cannot be used where branded types expected
 * - Compile-time errors prevent runtime type confusion
 *
 * Note: These tests use @ts-expect-error to verify compile-time failures.
 * If the @ts-expect-error lines DON'T fail, the test fails (proving types work).
 */
import { describe, it, expect } from 'vitest';
import type { SessionId, RunId, NodeId, WorkflowHashRef, AttemptId } from '../../../src/v2/durable-core/ids/index.js';
import { asSessionId, asRunId, asNodeId, asWorkflowHashRef, asAttemptId } from '../../../src/v2/durable-core/ids/index.js';
import type { StateTokenPayloadV1, AckTokenPayloadV1 } from '../../../src/v2/durable-core/tokens/payloads.js';

describe('Type safety - branded IDs', () => {
  it('branded types are assignable to themselves', () => {
    const sessionId: SessionId = asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const runId: RunId = asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const nodeId: NodeId = asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const wfRef: WorkflowHashRef = asWorkflowHashRef('wf_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    
    // These should all compile (same type assignments)
    const s2: SessionId = sessionId;
    const r2: RunId = runId;
    const n2: NodeId = nodeId;
    const w2: WorkflowHashRef = wfRef;
    
    expect(s2).toBe(sessionId);
    expect(r2).toBe(runId);
    expect(n2).toBe(nodeId);
    expect(w2).toBe(wfRef);
  });

  it('SessionId cannot be assigned where RunId expected', () => {
    const sessionId = asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    
    // This line should cause a compile error (enforced by branded types)
    // @ts-expect-error - SessionId not assignable to RunId
    const runId: RunId = sessionId;
    
    // At runtime, brands don't exist (both are strings), but compile-time prevents the error
    // The test proves the @ts-expect-error is needed (types are incompatible)
    expect(runId).toBeDefined();
  });

  it('raw string cannot be assigned where SessionId expected', () => {
    const rawString = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    
    // This should cause a compile error
    // @ts-expect-error - string not assignable to SessionId
    const sessionId: SessionId = rawString;
    
    // Must use type constructor
    const correctSessionId: SessionId = asSessionId(rawString);
    expect(correctSessionId).toBeDefined();
  });

  it('payload type checking prevents ID type confusion', () => {
    const sessionId = asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const runId = asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const nodeId = asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const wfRef = asWorkflowHashRef('wf_aaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Correct usage compiles
    const validPayload: StateTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId,
      runId,
      nodeId,
      workflowHashRef: wfRef,
    };

    expect(validPayload).toBeDefined();

    // Wrong field types should fail at compile time
    // @ts-expect-error - SessionId where RunId expected
    const invalidPayload1: StateTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId,
      runId: sessionId, // Wrong type!
      nodeId,
      workflowHashRef: wfRef,
    };

    expect(invalidPayload1).toBeDefined(); // Runtime still works (same underlying type)
  });

  it('AttemptId and WorkflowHashRef are not interchangeable', () => {
    const attemptId = asAttemptId('attempt_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const wfRef = asWorkflowHashRef('wf_aaaaaaaaaaaaaaaaaaaaaaaaaa');

    // State token needs WorkflowHashRef
    // @ts-expect-error - AttemptId where WorkflowHashRef expected
    const statePayload: StateTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runId: asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      nodeId: asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      workflowHashRef: attemptId, // Wrong type!
    };

    // Ack token needs AttemptId
    // @ts-expect-error - WorkflowHashRef where AttemptId expected
    const ackPayload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      runId: asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      nodeId: asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
      attemptId: wfRef, // Wrong type!
    };

    expect(statePayload).toBeDefined();
    expect(ackPayload).toBeDefined();
  });
});
