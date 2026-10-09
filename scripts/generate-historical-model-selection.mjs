/** Generate test-owned fixtures using the compiled, immutable fde6133c source. */
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const baseline = resolve(process.argv[2]);
const destination = resolve(process.argv[3] ?? 'tests/fixtures/historical-model-selection');
const expected = 'fde6133cbfd281e01520fab73b20061d783f4ddd';
if (execFileSync('git', ['rev-parse', 'fde6133c'], { encoding: 'utf8' }).trim() !== expected) throw Error('Baseline identity changed');
// Archive provenance is verified against git source before importing the build.
for (const file of ['src/v2/usecases/start-workflow.ts', 'src/mcp/handlers/v2-execution/continue-advance.ts']) {
  if (await readFile(join(baseline, file), 'utf8') !== execFileSync('git', ['show', `${expected}:${file}`], { encoding: 'utf8' })) throw Error(`Baseline mismatch: ${file}`);
}
const { composeServer } = await import(pathToFileURL(join(baseline, 'dist/mcp/server.js')));
const { resetContainer } = await import(pathToFileURL(join(baseline, 'dist/di/container.js')));
const tokenFrom = response => response.content.map(item => item.text ?? '').join('\n').match(/"continueToken":\s*"([^"]+)"/)?.[1];
for (const variant of ['unchanged', 'tier-drift']) {
  const root = join(destination, variant);
  try { if ((await readdir(root)).length) throw Error('Refuse to append into existing historical fixture'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const workflows = join(root, 'workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(join(workflows, 'historical-model.json'), JSON.stringify({ id: 'historical-model', name: 'Historical model', description: 'Prior-version compatibility fixture', version: '1.0.0', steps: [
    { id: 'first', title: 'First', prompt: 'Historical first step.', notesOptional: true },
    { id: 'second', title: 'Second', modelTier: 'mid', prompt: 'Historical second step.', notesOptional: true },
  ] }));
  for (const key of ['WORKRAIL_FORCE_MODEL', 'WORKRAIL_ACTIVE_MODEL', 'WORKRAIL_MODEL', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'CLAUDE_CODE', 'CLAUDE_CLI', 'CURSOR_APP', 'WORKRAIL_IS_DAEMON']) delete process.env[key];
  Object.assign(process.env, { WORKRAIL_DATA_DIR: root, WORKFLOW_STORAGE_PATH: workflows, WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_FORCE_HARNESS: 'mcp', WORKRAIL_CLEAN_RESPONSE_FORMAT: 'false', WORKRAIL_DEV: '0' });
  resetContainer();
  const { server, closeDomain } = await composeServer();
  const input = new PassThrough(); const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  await server.connect(transport);
  let id = 0;
  const call = (method, params) => new Promise((resolveCall, reject) => {
    const requestId = ++id; let buffer = '';
    const timer = setTimeout(() => { output.off('data', receive); reject(Error('MCP response deadline exceeded')); }, 20000);
    const receive = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const response = JSON.parse(line);
        if (response.id === requestId) { clearTimeout(timer); output.off('data', receive); response.error ? reject(Error(JSON.stringify(response.error))) : resolveCall(response.result); }
      }
    };
    output.on('data', receive); input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'historical-fixture-generator', version: '1' } });
    const started = await call('tools/call', { name: 'start_workflow', arguments: { workflowId: 'historical-model', workspacePath: root, goal: 'Historical compatibility', ...(variant === 'tier-drift' ? { modelTier: 'heavy' } : {}) } });
    if (started.isError || !tokenFrom(started)) throw Error('Baseline start failed');
    const pending = await call('tools/call', { name: 'continue_workflow', arguments: { continueToken: tokenFrom(started), intent: 'advance', workspacePath: root, output: { notesMarkdown: 'Prior-version onboarding completed by fixture generator.' } } });
    if (pending.isError || !tokenFrom(pending)) throw Error('Baseline onboarding advance failed');
    await writeFile(join(root, 'responses.json'), JSON.stringify({ started, pending, continueToken: tokenFrom(pending) }, null, 2));
  } finally { await closeDomain(new AbortController().signal); await transport.close(); resetContainer(); }
}
const artifactSha256 = {};
for (const file of await readdir(destination, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const absolute = join(file.parentPath, file.name);
  artifactSha256[absolute.slice(destination.length + 1)] = createHash('sha256').update(await readFile(absolute)).digest('hex');
}
await writeFile(join(destination, 'provenance.json'), JSON.stringify({ baselineCommit: expected, artifactSha256, generation: 'git archive, tsc tsconfig.build.json, actual composeServer over StdioServerTransport', signingMaterial: 'Generated within fixture WORKRAIL_DATA_DIR; test-owned, not production', variants: { unchanged: 'Default start identity; onboarding advanced', 'tier-drift': 'modelTier heavy at start; baseline default identity on onboarding advance induces genuine drift refresh' }, tokens: 'Original returned opaque continue tokens retained without decoding' }, null, 2));
