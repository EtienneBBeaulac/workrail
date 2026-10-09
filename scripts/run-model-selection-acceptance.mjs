import { PassThrough } from 'node:stream';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { implementationHash, runtimeBuildHash } from './verify-model-selection-native.mjs';

const [mode, argument] = process.argv.slice(2);
const root = process.cwd();
if (!['prepare', 'child'].includes(mode) || !argument || !isAbsolute(argument)) {
  throw new Error('Usage: node scripts/run-model-selection-acceptance.mjs <prepare|child> <absolute-proofRoot>');
}
const proofRoot = resolve(argument);
if (proofRoot === root) throw new Error('proofRoot must be an isolated directory, not the repository root');
const workflowId = 'model-selection-acceptance-child';
const parentId = 'model-selection-acceptance-parent';
const modulePath = resolve(root, 'dist/mcp/server.js');
const sourceHash = implementationHash(root);
const buildHash = runtimeBuildHash(root);
const routing = { lightweight: { kind: 'model', modelId: 'gpt-6-luna' } };
const file = name => resolve(proofRoot, name);
const save = (name, value) => writeFile(file(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const load = async name => JSON.parse(await readFile(file(name), 'utf8'));
function deadline(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function responseData(response) {
  if (response.isError) throw new Error('MCP tool failed: ' + JSON.stringify(response));
  // JSON mode exposes the validated tool payload in content. Do not synthesize
  // a missing structuredContent field: its presence is part of this acceptance.
  const json = response.content?.find(item => item.type === 'text' && item.text.trim().startsWith('{'));
  if (!json) throw new Error('Actual MCP JSON response payload is absent');
  return JSON.parse(json.text);
}
function continuation(response) {
  const data = responseData(response);
  const token = data.nextCall?.params?.continueToken ?? data.continueToken;
  if (typeof token !== 'string' || !token) throw new Error('Opaque continuation token is absent');
  return token;
}

await mkdir(proofRoot, { recursive: true });
let runNonce;
if (mode === 'prepare') {
  // A fresh nonce binds workflow arguments, handoff, native context, and output.
  // Refuse reuse of a prior proof instead of mixing receipts from different runs.
  try { await readFile(file('startup.json')); throw new Error('Existing startup receipt: use a fresh proofRoot'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  runNonce = randomUUID();
  await mkdir(file('workflows'), { recursive: true });
  await save('workflows/' + parentId + '.json', {
    id: parentId, name: 'Bounded model selection acceptance', description: 'Native model-routing handoff fixture', version: '1.0.0',
    steps: [{ id: 'spawn', title: 'Launch bounded native child', type: 'parallel', parallelDelegations: [{
      workflowId, modelTier: 'lightweight', goal: 'Complete the isolated model routing fixture ' + runNonce,
      args: { runNonce },
    }] }, { id: 'synthesize', title: 'Inspect child receipt', prompt: 'Inspect the bound child receipt. Do not launch more agents.', notesOptional: true }],
  });
  await save('workflows/' + workflowId + '.json', {
    id: workflowId, name: 'Self-sufficient model selection child', description: 'One bounded step, no child delegation', version: '1.0.0',
    steps: [{ id: 'finish', title: 'Complete bound fixture', prompt: 'Do not spawn children. Return notes exactly: model-routing-fixture-complete {{runNonce}}' }],
  });
} else {
  const handoff = await load('handoff.json');
  if (handoff.implementationHash !== sourceHash || handoff.runtimeBuildHash !== buildHash) throw new Error('Handoff belongs to another source/build');
  runNonce = handoff.runNonce;
  if (typeof runNonce !== 'string' || !runNonce) throw new Error('Handoff nonce absent');
}

// Import server only after process-local environment is isolated and JSON mode
// set. Never alter client settings or the user's production WorkRail state.
Object.assign(process.env, {
  WORKRAIL_DATA_DIR: proofRoot,
  WORKFLOW_STORAGE_PATH: file('workflows'),
  WORKRAIL_ENABLE_V2_TOOLS: 'true',
  WORKRAIL_ENABLE_SESSION_TOOLS: 'false',
  WORKRAIL_JSON_RESPONSES: 'true',
  WORKRAIL_CLEAN_RESPONSE_FORMAT: 'false',
  WORKRAIL_AGENT_PROFILE: 'legacy',
  WORKRAIL_KEYS_DIR: file('keys'),
  WORKRAIL_DEV: 'false',
});
const { composeServer } = await import(pathToFileURL(modulePath).href);
const { container, resetContainer } = await import(pathToFileURL(resolve(root, 'dist/di/container.js')).href);
const { DI } = await import(pathToFileURL(resolve(root, 'dist/di/tokens.js')).href);
const { DomainEventV1Schema } = await import(pathToFileURL(resolve(root, 'dist/v2/durable-core/schemas/session/index.js')).href);
const input = new PassThrough();
const output = new PassThrough();
const transport = new StdioServerTransport(input, output);
let composed;
const pending = new Map();
let requestId = 0;
let buffer = '';
const transcript = [];
function receive(chunk) {
  buffer += chunk.toString();
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    }
  }
}
output.on('data', receive);
async function rpc(method, params) {
  const id = ++requestId;
  const promise = new Promise((resolveResponse, reject) => pending.set(id, { resolve: resolveResponse, reject }));
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  try { return await deadline(promise, method); }
  finally { pending.delete(id); }
}
async function tool(name, args) {
  const response = await rpc('tools/call', { name, arguments: args });
  transcript.push({ name, arguments: args, response });
  await save(mode + '-rpc.json', transcript);
  responseData(response);
  return response;
}
async function acknowledge(response, context) {
  for (let count = 0; responseData(response).pending?.stepId === 'wr-system-onboarding'; count++) {
    if (count >= 3) throw new Error('Onboarding did not converge within three acknowledgements');
    response = await tool('continue_workflow', {
      continueToken: continuation(response), intent: 'advance', workspacePath: proofRoot,
      ...(context ? { context } : {}), output: { notesMarkdown: 'Acknowledged the bounded WorkRail protocol.' },
    });
  }
  return response;
}

let completedFixture;
try {
  composed = await deadline(composeServer(), 'branch server composition', 30000);
  await deadline(composed.server.connect(transport), 'stdio connection');
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'branch-model-selection-acceptance', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const startup = { kind: 'branch_mcp_started', modulePath, transport: 'stdio', dataRoot: proofRoot, runNonce, implementationHash: sourceHash, runtimeBuildHash: buildHash };
  await save(mode === 'prepare' ? 'startup.json' : 'child-startup.json', startup);
  if (mode === 'prepare') {
    const started = await tool('start_workflow', { workflowId: parentId, workspacePath: proofRoot, goal: 'Capture native handoff ' + runNonce, modelRouting: routing });
    const handoff = await acknowledge(started);
    await save('prepare-returned-handoff.json', handoff);
    const delegation = handoff.structuredContent?.pending?.delegations?.find(item => item.workflowId === workflowId);
    if (!delegation) throw new Error('RED: advance returned no structured pending delegation; raw response retained');
    if (delegation.inputs?.runNonce !== runNonce || delegation.modelSelection?.kind !== 'resolved' || delegation.modelSelection.target?.modelId !== routing.lightweight.modelId) throw new Error('Actual returned delegation does not match nonce/requested binding');
    continuation(handoff);
    await save('handoff.json', { ...handoff, startup, runNonce, implementationHash: sourceHash, runtimeBuildHash: buildHash });
    process.stdout.write(JSON.stringify({ startup, handoffReceiptPath: file('handoff.json'), target: delegation.modelSelection.target, implementationHash: sourceHash, runtimeBuildHash: buildHash }) + '\n');
  } else {
    const handoff = await load('handoff.json');
    const delegation = handoff.structuredContent?.pending?.delegations?.find(item => item.workflowId === workflowId);
    if (!delegation || delegation.inputs?.runNonce !== runNonce || delegation.modelSelection?.kind !== 'resolved') throw new Error('Bound structured child handoff absent');
    const modelRouting = handoff.structuredContent.pending.modelRouting;
    if (!modelRouting || delegation.modelSelection.request?.tier !== 'lightweight') throw new Error('Child tier/routing missing');
    const started = await tool('start_workflow', { workflowId, workspacePath: proofRoot, goal: delegation.goal, modelTier: delegation.modelSelection.request.tier, modelRouting });
    let response = await acknowledge(started, { ...delegation.inputs, runNonce });
    if (responseData(response).pending?.stepId !== 'finish') throw new Error('Child did not reach bounded finish step');
    response = await tool('continue_workflow', { continueToken: continuation(response), intent: 'advance', workspacePath: proofRoot, context: { ...delegation.inputs, runNonce }, output: { notesMarkdown: 'model-routing-fixture-complete ' + runNonce } });
    if (responseData(response).isComplete !== true) throw new Error('Bounded child did not complete');
    const dataDir = container.resolve(DI.V2.DataDir);
    const sessionsDir = dataDir.sessionsDir();
    if (relative(proofRoot, sessionsDir).startsWith('..') || isAbsolute(relative(proofRoot, sessionsDir))) throw new Error('Session store escaped isolated proof root');
    const candidates = [];
    for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const loaded = await composed.ctx.v2.sessionStore.load(entry.name);
      if (loaded.isErr()) throw new Error('Durable session integrity load failed: ' + JSON.stringify(loaded.error));
      const events = loaded.value.events.map(event => DomainEventV1Schema.parse(event));
      const run = events.find(event => event.kind === 'run_started' && event.data.workflowId === workflowId);
      if (!run || !events.some(event => event.kind === 'context_set' && event.scope?.runId === run.scope?.runId && event.data.context?.runNonce === runNonce)) continue;
      candidates.push({ run, events });
    }
    if (candidates.length !== 1) throw new Error('Expected exactly one nonce-bound durable child session');
    const { run, events } = candidates[0];
    const runEvents = events.filter(event => event.scope?.runId === run.scope.runId);
    if (!runEvents.some(event => event.kind === 'run_completed') || !runEvents.some(event => event.kind === 'node_output_appended' && event.data.payload?.payloadKind === 'notes' && event.data.payload.notesMarkdown === 'model-routing-fixture-complete ' + runNonce)) throw new Error('Durable child lacks exact bound output/completion');
    await save('child-events.json', events);
    const fixture = { kind: 'completed', sessionId: run.sessionId, runId: run.scope.runId, workflowId, result: 'model-routing-fixture-complete', runNonce, implementationHash: sourceHash, runtimeBuildHash: buildHash };
    completedFixture = fixture;
  }
} finally {
  const cleanups = [
    ['domain close', () => composed?.closeDomain(AbortSignal.timeout(5000))],
    ['server close', () => composed?.server.close()],
    ['transport close', () => transport.close()],
  ];
  const failures = [];
  for (const [label, close] of cleanups) {
    try {
      const outcome = await deadline(Promise.resolve().then(close), label, 6000);
      if (label === 'domain close' && composed && outcome !== 'closed') failures.push('domain close returned ' + String(outcome));
    } catch (error) { failures.push(String(error)); }
  }
  output.off('data', receive);
  for (const waiter of pending.values()) waiter.reject(new Error('Acceptance driver closed'));
  pending.clear(); input.destroy(); output.destroy(); resetContainer();
  if (failures.length) throw new Error('Owned resource cleanup failed: ' + failures.join('; '));
}

// Completion receipt is published only after all owned resources settled.
if (completedFixture) {
  const fixture = { ...completedFixture, resourcesClosed: true };
  await save('child-fixture.json', fixture);
  process.stdout.write(JSON.stringify(fixture) + '\n');
}
