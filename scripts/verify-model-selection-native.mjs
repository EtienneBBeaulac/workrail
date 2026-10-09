import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This proves a native launch request was accepted, not provider model attestation.
export function implementationHash(root) {
  const files = [
    'src/mcp/handler-factory.ts', 'src/mcp/handlers/v2-execution/continue-advance.ts',
    'src/mcp/handlers/v2-workflow.ts', 'src/mcp/output-schemas.ts',
    'src/mcp/step-content-envelope.ts', 'src/mcp/v2/tools.ts',
    'src/v2/durable-core/domain/model-selection.ts',
    'src/v2/durable-core/domain/prompt-renderer.ts',
    'src/v2/durable-core/schemas/session/events.ts',
    'src/v2/projections/session-metrics.ts', 'src/v2/usecases/start-workflow.ts',
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(resolve(root, file)));
  return hash.digest('hex');
}

export function verifyReceipt(receipt, transcript, currentHash, fixture, handoff, events) {
  if (receipt?.version !== 1 || receipt.implementationHash !== currentHash) return { ok: false, reason: 'Receipt is absent or belongs to a different implementation' };
  if (receipt.target?.kind !== 'model' || receipt.target.modelId !== 'gpt-6-luna') return { ok: false, reason: 'Receipt does not use the operator-selected binding' };
  const call = transcript.find(item => item.type === 'response_item' && item.payload?.type === 'function_call' && item.payload.call_id === receipt.nativeCallId);
  if (!call || !['collaboration.spawn_agent', 'functions.collaboration.spawn_agent'].includes(call.payload.name)) return { ok: false, reason: 'Native spawn call not found' };
  let args;
  try { args = JSON.parse(call.payload.arguments); } catch { return { ok: false, reason: 'Native call arguments are invalid' }; }
  if (typeof receipt.runNonce !== 'string' || receipt.runNonce.length === 0 || !String(args.message).includes(receipt.runNonce)) return { ok: false, reason: 'Native call is not bound to this proof run' };
  if (receipt.nativeTaskName !== '/root/' + args.task_name) return { ok: false, reason: 'Native task identity does not match the request' };
  if (args.model !== receipt.target.modelId || args.fork_turns !== 'none') return { ok: false, reason: 'Native request did not apply the selected model with fresh context' };
  const response = transcript.find(item => item.type === 'response_item' && item.payload?.type === 'function_call_output' && item.payload.call_id === receipt.nativeCallId);
  if (!response || !String(response.payload.output).includes(receipt.nativeTaskName)) return { ok: false, reason: 'Native launch acceptance was not recorded' };
  const completionCall = transcript.find(item => item.type === 'response_item' && item.payload?.type === 'function_call' && item.payload.call_id === receipt.nativeCompletionCallId);
  const completionResponse = transcript.find(item => item.type === 'response_item' && item.payload?.type === 'function_call_output' && item.payload.call_id === receipt.nativeCompletionCallId);
  if (!completionCall || !['collaboration.list_agents', 'functions.collaboration.list_agents'].includes(completionCall.payload.name) || !completionResponse) return { ok: false, reason: 'Native child completion receipt is absent' };
  let agents;
  try { agents = JSON.parse(completionResponse.payload.output).agents; } catch { return { ok: false, reason: 'Native completion receipt is invalid' }; }
  const completedChild = agents?.find(agent => agent.agent_name === receipt.nativeTaskName)?.agent_status?.completed;
  if (typeof completedChild !== 'string' || !completedChild.includes(receipt.runNonce) || !fixture?.sessionId || !completedChild.includes(fixture.sessionId)) return { ok: false, reason: 'Native child did not complete with this WorkRail session' };
  const delegation = handoff?.structuredContent?.pending?.delegations?.find(item => item.workflowId === 'model-selection-acceptance-child');
  if (delegation?.modelSelection?.kind !== 'resolved' || delegation.modelSelection.target?.kind !== 'model' || delegation.modelSelection.target.modelId !== receipt.target.modelId || delegation.inputs?.runNonce !== receipt.runNonce) return { ok: false, reason: 'Returned MCP handoff does not match the native launch' };
  if (!Array.isArray(events) || !fixture?.sessionId || !fixture?.runId) return { ok: false, reason: 'Durable child execution evidence is absent' };
  const runEvents = events.filter(event => event.sessionId === fixture.sessionId && event.scope?.runId === fixture.runId);
  if (!runEvents.some(event => event.kind === 'run_started' && event.data?.workflowId === delegation.workflowId) ||
      !runEvents.some(event => event.kind === 'context_set' && event.data?.context?.runNonce === receipt.runNonce) ||
      !runEvents.some(event => event.kind === 'node_output_appended' && event.data?.payload?.payloadKind === 'notes' && event.data.payload.notesMarkdown === 'model-routing-fixture-complete ' + receipt.runNonce) ||
      !runEvents.some(event => event.kind === 'run_completed')) return { ok: false, reason: 'Durable child session lacks the bound start, output or completion' };
  if (fixture?.runNonce !== receipt.runNonce) return { ok: false, reason: 'Child result belongs to another proof run' };
  if (fixture?.kind !== 'completed' || fixture?.workflowId !== 'model-selection-acceptance-child' || fixture?.result !== 'model-routing-fixture-complete') return { ok: false, reason: 'The bounded WorkRail child did not complete' };
  return { ok: true, evidence: 'native_launch_accepted_and_child_completed', actualProviderModel: 'not_independently_observed' };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const root = process.cwd();
    const receipt = JSON.parse(readFileSync(resolve(root, '.workrail/model-selection-proof/native-receipt.json'), 'utf8'));
    const transcript = readFileSync(receipt.rootTranscriptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const fixture = JSON.parse(readFileSync(receipt.fixtureReceiptPath, 'utf8'));
    const handoff = JSON.parse(readFileSync(receipt.handoffReceiptPath, 'utf8'));
    const events = JSON.parse(readFileSync(receipt.childEventsPath, 'utf8'));
    const { DomainEventV1Schema } = await import('../dist/v2/durable-core/schemas/session/index.js');
    for (const event of events) DomainEventV1Schema.parse(event);
    const result = verifyReceipt(receipt, transcript, implementationHash(root), fixture, handoff, events);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write('Native acceptance evidence is unavailable: ' + String(error) + '\n');
    process.exitCode = 1;
  }
}
