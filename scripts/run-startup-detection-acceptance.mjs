import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Fresh Node processes exercise composition, stdio dispatch and durable recovery.
// No LLM handshake, model request or client context is supplied by this fixture.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = fileURLToPath(import.meta.url);
const [phase, dataRoot] = process.argv.slice(2);
const markerKeys = ['WORKRAIL_FORCE_HARNESS', 'CLAUDE_CODE', 'CLAUDE_CLI', 'CURSOR_APP',
  'WORKRAIL_IS_DAEMON', 'TERM_PROGRAM', 'WORKRAIL_MODEL_ID', 'WORKRAIL_ACTIVE_MODEL'];
const workflowId = 'startup-detection-acceptance';
const save = (name, value) => writeFile(resolve(dataRoot, name), JSON.stringify(value), { mode: 0o600 });
const load = async name => JSON.parse(await readFile(resolve(dataRoot, name), 'utf8'));
function deadline(promise, label, milliseconds = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function responseData(response) {
  assert.equal(response.isError, undefined, 'MCP tool must succeed');
  const text = response.content?.find(item => item.type === 'text' && item.text.trim().startsWith('{'));
  assert.ok(text, 'MCP must return its actual JSON payload');
  return JSON.parse(text.text);
}
function continuation(response) {
  const data = responseData(response);
  const token = data.nextCall?.params?.continueToken ?? data.continueToken;
  assert.equal(typeof token, 'string', 'MCP must return an opaque continuation token');
  return token;
}
// Ignore opaque transport tokens when comparing replay's public semantic output.
function semanticResponse(value) {
  if (Array.isArray(value)) return value.map(semanticResponse);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token$/i.test(key))
    .map(([key, item]) => [key, semanticResponse(item)]));
}

if (!phase) {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'workrail-startup-acceptance-'));
  const receipts = [];
  try {
    for (const currentPhase of ['generic-start', 'daemon-start', 'recover', 'replay']) {
      const currentRoot = resolve(temporaryRoot, currentPhase === 'generic-start' ? 'generic' : 'recovery');
      await mkdir(currentRoot, { recursive: true, mode: 0o700 });
      const env = { ...process.env };
      for (const key of markerKeys) delete env[key];
      if (currentPhase === 'daemon-start') env.WORKRAIL_IS_DAEMON = 'true';
      else if (currentPhase === 'replay') env.CLAUDE_CODE = 'true';
      else env.TERM_PROGRAM = 'vscode';
      try {
        // Capture child streams privately: opaque tokens are never published.
        await promisify(execFile)(process.execPath, [script, currentPhase, currentRoot],
          { cwd: root, env, timeout: 60000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error('Acceptance process failed in ' + currentPhase + '; no receipt published');
      }
      receipts.push(JSON.parse(await readFile(resolve(currentRoot, currentPhase + '-receipt.json'), 'utf8')));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const failures = receipts.flatMap(receipt => receipt.failures);
  process.stdout.write(JSON.stringify({ transport: 'composed MCP stdio', freshProcesses: receipts.length,
    temporaryDataRemoved: true, receipts }) + '\n');
  if (failures.length) {
    process.stderr.write('RED: ' + failures.join('; ') + '\n');
    process.exitCode = 1;
  }
} else {
  assert.ok(['generic-start', 'daemon-start', 'recover', 'replay'].includes(phase), 'Known child phase required');
  assert.ok(dataRoot && isAbsolute(dataRoot) && dataRoot !== root, 'Isolated absolute data root required');
  await mkdir(resolve(dataRoot, 'workflows'), { recursive: true });
  await save('workflows/' + workflowId + '.json', {
    id: workflowId, name: 'Startup detection acceptance', description: 'Simple workflow without delegation', version: '1.0.0',
    steps: [{ id: 'first', title: 'First', prompt: 'Record the first bounded note.' },
      { id: 'second', title: 'Second', prompt: 'Record the second bounded note.' }],
  });
  Object.assign(process.env, { WORKRAIL_DATA_DIR: dataRoot, WORKFLOW_STORAGE_PATH: resolve(dataRoot, 'workflows'),
    WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_JSON_RESPONSES: 'true',
    WORKRAIL_CLEAN_RESPONSE_FORMAT: 'false', WORKRAIL_AGENT_PROFILE: 'legacy',
    WORKRAIL_KEYS_DIR: resolve(dataRoot, 'keys'), WORKRAIL_DEV: 'false' });
  const { composeServer } = await import(pathToFileURL(resolve(root, 'dist/mcp/server.js')).href);
  const { container, resetContainer } = await import(pathToFileURL(resolve(root, 'dist/di/container.js')).href);
  const { DI } = await import(pathToFileURL(resolve(root, 'dist/di/tokens.js')).href);
  const { parseEAT } = await import(pathToFileURL(resolve(root, 'dist/v2/durable-core/tokens/index.js')).href);
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const pending = new Map();
  let composed;
  let requestId = 0;
  let buffer = '';
  const failures = [];
  const check = (condition, label) => { if (!condition) failures.push(label); };
  const receive = chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        message.error ? waiter.reject(new Error('MCP RPC error')) : waiter.resolve(message.result);
      }
    }
  };
  output.on('data', receive);
  async function rpc(method, params) {
    const id = ++requestId;
    const promise = new Promise((resolveResponse, reject) => pending.set(id, { resolve: resolveResponse, reject }));
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    try { return await deadline(promise, method); } finally { pending.delete(id); }
  }
  async function tool(name, args) {
    const response = await rpc('tools/call', { name, arguments: args });
    responseData(response);
    return response;
  }
  async function durable() {
    const sessionsDir = container.resolve(DI.V2.DataDir).sessionsDir();
    const pathWithinRoot = relative(dataRoot, sessionsDir);
    assert.ok(!pathWithinRoot.startsWith('..') && !isAbsolute(pathWithinRoot), 'Store must stay isolated');
    const sessions = [];
    for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const loaded = await composed.ctx.v2.sessionStore.load(entry.name);
      assert.ok(loaded.isOk(), 'Actual durable integrity load must succeed');
      if (loaded.value.events.some(event => event.kind === 'run_started' && event.data.workflowId === workflowId)) {
        sessions.push({ sessionId: entry.name, events: loaded.value.events });
      }
    }
    assert.equal(sessions.length, 1, 'Exactly one simple fixture session required');
    return sessions[0];
  }
  function observation(state, expectedHarness) {
    const contexts = state.events.filter(event => event.kind === 'context_set').map(event => event.data.context);
    const context = contexts.at(-1);
    const attestation = parseEAT(context?.eat_token, composed.ctx.v2.tokenCodecPorts, state.sessionId);
    assert.ok(attestation.ok, 'Durable environment observation must verify its HMAC and session binding');
    check(attestation.value.payload.harness === expectedHarness, phase + ': signed harness must be ' + expectedHarness);
    check(context.metrics_harness === expectedHarness, phase + ': durable metrics harness must be ' + expectedHarness);
    check(attestation.value.payload.activeModel === '' && context.metrics_active_model === '' &&
      context.metrics_model_source === 'unknown', phase + ': sniff must not invent an active model');
    check(!state.events.some(event => event.kind === 'capability_observed'), phase + ': sniff must not grant capabilities');
    return { harness: attestation.value.payload.harness, signatureVerified: true, modelSource: context.metrics_model_source };
  }
  let receipt;
  try {
    composed = await deadline(composeServer(), 'composition', 30000);
    await composed.server.connect(transport);
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'startup-detection-acceptance', version: '1' } });
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    let evidence;
    if (phase.endsWith('start')) {
      let response = await tool('start_workflow', { workflowId, workspacePath: dataRoot, goal: 'Bounded startup fixture' });
      for (let count = 0; responseData(response).pending?.stepId === 'wr-system-onboarding'; count++) {
        assert.ok(count < 3, 'Onboarding must converge');
        response = await tool('continue_workflow', { continueToken: continuation(response), intent: 'advance',
          workspacePath: dataRoot, output: { notesMarkdown: 'Acknowledged bounded protocol.' } });
      }
      assert.equal(responseData(response).pending?.stepId, 'first', 'Simple workflow must start without handshake');
      evidence = observation(await durable(), phase === 'daemon-start' ? 'daemon' : 'mcp');
      await save('handoff.json', { continueToken: continuation(response) });
    } else if (phase === 'recover') {
      const handoff = await load('handoff.json');
      const before = await durable();
      observation(before, 'daemon');
      const rehydrated = await tool('continue_workflow', { continueToken: handoff.continueToken,
        intent: 'rehydrate', workspacePath: dataRoot });
      assert.equal(responseData(rehydrated).pending?.stepId, 'first', 'Rehydrate must return original step');
      assert.deepEqual((await durable()).events, before.events, 'Rehydrate must preserve durable events and observations');
      const args = { continueToken: continuation(rehydrated), intent: 'advance', workspacePath: dataRoot,
        output: { notesMarkdown: 'bounded-first-output' } };
      const advanced = await tool('continue_workflow', args);
      assert.equal(responseData(advanced).pending?.stepId, 'second', 'New advance must execute next step');
      const after = await durable();
      evidence = observation(after, 'mcp');
      await save('replay.json', { args, response: semanticResponse(responseData(advanced)), events: after.events });
    } else {
      const replay = await load('replay.json');
      assert.deepEqual((await durable()).events, replay.events, 'Fresh replay process must load exact prior state');
      const response = await tool('continue_workflow', replay.args);
      assert.deepEqual(semanticResponse(responseData(response)), replay.response, 'Replay must return prior semantic output');
      const state = await durable();
      assert.deepEqual(state.events, replay.events, 'Replay under changed markers must preserve all durable observations and output');
      assert.equal(state.events.filter(event => event.kind === 'node_output_appended' &&
        event.data.payload?.notesMarkdown === 'bounded-first-output').length, 1, 'Replay must not duplicate first output');
      evidence = observation(state, 'mcp');
    }
    receipt = { phase, ...evidence, failures };
  } finally {
    const cleanupFailures = [];
    for (const [label, close] of [['domain', () => composed?.closeDomain(AbortSignal.timeout(5000))],
      ['server', () => composed?.server.close()], ['transport', () => transport.close()]]) {
      try {
        const result = await deadline(Promise.resolve().then(close), label + ' close', 6000);
        if (label === 'domain' && composed && result !== 'closed') cleanupFailures.push(label);
      } catch { cleanupFailures.push(label); }
    }
    output.off('data', receive);
    input.destroy(); output.destroy(); resetContainer();
    assert.equal(cleanupFailures.length, 0, 'Every owned resource must close');
  }
  await save(phase + '-receipt.json', { ...receipt, resourcesClosed: true });
}
