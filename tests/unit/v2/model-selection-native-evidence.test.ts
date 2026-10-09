import { it, expect } from 'vitest';
import { verifyReceipt } from '../../../scripts/verify-model-selection-native.mjs';

const nonce = 'bounded-test-nonce';
const target = { kind: 'model', modelId: 'gpt-6-luna' };
const receipt = { version: 1, implementationHash: 'source-hash', target, runNonce: nonce,
  nativeTaskName: '/root/acceptance', nativeCallId: 'native-call' };
const transcript = [
  { type: 'response_item', payload: { type: 'function_call', call_id: 'native-call', name: 'collaboration.spawn_agent',
    arguments: JSON.stringify({ task_name: 'acceptance', model: target.modelId, fork_turns: 'none', message: nonce }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'native-call', output: '/root/acceptance' } },
];
const fixture = { sessionId: 'session-proof', runId: 'run-proof', runNonce: nonce, kind: 'completed',
  workflowId: 'model-selection-acceptance-child', result: 'model-routing-fixture-complete' };
const handoff = { structuredContent: { pending: { delegations: [{ workflowId: fixture.workflowId,
  inputs: { runNonce: nonce }, modelSelection: { kind: 'resolved', target } }] } } };
const events = [
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'run_started', data: { workflowId: fixture.workflowId } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'context_set', data: { context: { runNonce: nonce } } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'node_output_appended', data: { payload: { payloadKind: 'notes', notesMarkdown: 'model-routing-fixture-complete ' + nonce } } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'run_completed', data: {} },
];

it('accepts linked launch and durable completion evidence while leaving provider identity unknown', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, events)).toEqual({
    ok: true, evidence: 'native_launch_accepted_and_child_completed', actualProviderModel: 'not_independently_observed',
  });
});
it('rejects a completion JSON without durable child execution evidence', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, []).ok).toBe(false);
});
it('rejects absent or mismatched handoffs and incomplete child sessions', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, undefined, events).ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture,
    { structuredContent: { pending: { delegations: [{ ...handoff.structuredContent.pending.delegations[0], inputs: { runNonce: 'other' } }] } } }, events).ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, events.slice(0, -1)).ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'different-source', fixture, handoff, events).ok).toBe(false);
});
