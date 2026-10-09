import { it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReceipt } from '../../../scripts/verify-model-selection-native.mjs';

const proofRoot = join(tmpdir(), 'model-selection-proof-fixture');
const nonce = 'bounded-test-nonce';
const target = { kind: 'model', modelId: 'gpt-6-luna' };
const receipt = { version: 1, implementationHash: 'source-hash', runtimeBuildHash: 'build-hash', buildCallId: 'build-call', startupCallId: 'startup-call', proofDataRoot: proofRoot, target, runNonce: nonce,
  nativeTaskName: '/root/acceptance', nativeCallId: 'native-call', nativeCompletionCallId: 'completion-call' };
const startup = { kind: 'branch_mcp_started', modulePath: '/repo/dist/mcp/server.js', transport: 'stdio', dataRoot: proofRoot, runNonce: nonce, implementationHash: 'source-hash', runtimeBuildHash: 'build-hash' };
const transcript = [
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'build-call', name: 'exec', input: 'npm run build' } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'build-call', output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'source-hash build-hash' }) }] } },
  { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'startup-call', name: 'exec', input: `node scripts/run-model-selection-acceptance.mjs prepare ${proofRoot}` } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'startup-call', output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, output: JSON.stringify({ startup }) }) }] } },
  { type: 'response_item', payload: { type: 'function_call', call_id: 'native-call', name: 'spawn_agent', namespace: 'collaboration',
    arguments: JSON.stringify({ task_name: 'acceptance', model: target.modelId, fork_turns: 'none', message: nonce }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'native-call', output: '/root/acceptance' } },
  { type: 'response_item', payload: { type: 'function_call', call_id: 'completion-call', name: 'list_agents', namespace: 'collaboration', arguments: '{}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'completion-call', output: JSON.stringify({ agents: [{ agent_name: '/root/acceptance', agent_status: { completed: nonce + ' session-proof' } }] }) } },
];
const fixture = { implementationHash: 'source-hash', runtimeBuildHash: 'build-hash', sessionId: 'session-proof', runId: 'run-proof', runNonce: nonce, kind: 'completed', resourcesClosed: true,
  workflowId: 'model-selection-acceptance-child', result: 'model-routing-fixture-complete' };
const handoff = { startup, implementationHash: 'source-hash', runtimeBuildHash: 'build-hash', structuredContent: { pending: { delegations: [{ workflowId: fixture.workflowId,
  inputs: { runNonce: nonce }, modelSelection: { kind: 'resolved', target } }] } } };
const events = [
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'run_started', data: { workflowId: fixture.workflowId } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'context_set', data: { context: { runNonce: nonce } } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'node_output_appended', data: { payload: { payloadKind: 'notes', notesMarkdown: 'model-routing-fixture-complete ' + nonce } } },
  { sessionId: fixture.sessionId, scope: { runId: fixture.runId }, kind: 'run_completed', data: {} },
];

it('accepts linked launch and durable completion evidence while leaving provider identity unknown', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, events, 'build-hash')).toEqual({
    ok: true, evidence: 'native_launch_accepted_and_child_completed', actualProviderModel: 'not_independently_observed',
  });
});
it('rejects a completion JSON without durable child execution evidence', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, [], 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript.slice(0, 6), 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(false);
});
it('rejects absent or mismatched handoffs and incomplete child sessions', () => {
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, undefined, events, 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture,
    { ...handoff, structuredContent: { pending: { delegations: [{ ...handoff.structuredContent.pending.delegations[0], inputs: { runNonce: 'other' } }] } } }, events, 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, events.slice(0, -1), 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', fixture, handoff, events, 'different-build').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript.filter(item => item.payload.call_id !== 'startup-call'), 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript.slice(2), 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'source-hash', { ...fixture, resourcesClosed: false }, handoff, events, 'build-hash').ok).toBe(false);
  expect(verifyReceipt(receipt, transcript, 'different-source', fixture, handoff, events, 'build-hash').ok).toBe(false);
});

it('rejects receipts whose events cannot form a causal execution chain', () => {
  const completionBeforeLaunch = [...transcript.slice(0, 4), ...transcript.slice(6), ...transcript.slice(4, 6)];
  for (const reordered of [completionBeforeLaunch, [...transcript].reverse(),
    [transcript[1], transcript[0], ...transcript.slice(2)],
    [...transcript, transcript[0]]]) {
    expect(verifyReceipt(receipt, reordered, 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(false);
  }
});

it('binds encrypted native context through a nonce-bearing task identity', () => {
  const taskName = 'native_model_' + nonce.replaceAll('-', '_');
  const task = '/root/' + taskName;
  const privateTranscript = transcript.map(item => {
    if (item.payload.call_id === 'native-call' && item.payload.type === 'function_call') return {
      ...item, payload: { ...item.payload, arguments: JSON.stringify({ task_name: taskName,
        model: target.modelId, fork_turns: 'none', message: '<encrypted-at-rest>' }) },
    };
    if (item.payload.call_id === 'native-call') return { ...item, payload: { ...item.payload, output: task } };
    if (item.payload.call_id === 'completion-call' && item.payload.type === 'function_call_output') return {
      ...item, payload: { ...item.payload, output: JSON.stringify({ agents: [{ agent_name: task,
        agent_status: { completed: nonce + ' session-proof' } }] }) },
    };
    return item;
  });
  expect(verifyReceipt({ ...receipt, nativeTaskName: task }, privateTranscript, 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(true);
  const wrongTask = privateTranscript.map(item => item.payload.call_id === 'native-call' && item.payload.type === 'function_call'
    ? { ...item, payload: { ...item.payload, arguments: JSON.stringify({ task_name: 'unbound', model: target.modelId,
      fork_turns: 'none', message: '<encrypted-at-rest>' }) } } : item);
  expect(verifyReceipt({ ...receipt, nativeTaskName: task }, wrongTask, 'source-hash', fixture, handoff, events, 'build-hash').ok).toBe(false);
});
