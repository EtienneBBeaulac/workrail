/** Replay retained test-owned fixtures on the actual pre-change compiled server. */
import { PassThrough } from 'node:stream';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
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
  const root = await mkdtemp('/tmp/workrail-historical-prior-probe-');
  await cp(join(destination, variant), root, { recursive: true });
  const workflows = join(root, 'workflows');
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
    const retained = JSON.parse(await readFile(join(root, 'responses.json'), 'utf8'));
    const recovered = await call('tools/call', { name: 'continue_workflow', arguments: { continueToken: retained.continueToken, intent: 'rehydrate', workspacePath: root } });
    const advanced = await call('tools/call', { name: 'continue_workflow', arguments: { continueToken: tokenFrom(recovered), intent: 'advance', workspacePath: root, output: { notesMarkdown: 'Probe actual previous implementation on retained session.' } } });
    console.log(JSON.stringify({ variant, recovered: !recovered.isError, advanced: !advanced.isError, advancedCode: advanced.isError ? JSON.parse(advanced.content[0].text).code : undefined }));
  } finally { await closeDomain(new AbortController().signal); await transport.close(); resetContainer(); await rm(root, { recursive: true, force: true }); }
}
