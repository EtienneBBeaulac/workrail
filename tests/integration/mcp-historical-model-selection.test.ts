import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { composeServer } from '../../src/mcp/server.js';
import { resetContainer } from '../../src/di/container.js';

const fixtures = join(import.meta.dirname, '../fixtures/historical-model-selection');
const tokenFrom = (response: any): string | undefined => response.content.map((item: any) => item.text ?? '').join('\n').match(/"continueToken":\s*"([^"]+)"/)?.[1];

// Retained source-version fixtures, not sessions produced by the implementation under test.
it.each(['unchanged', 'tier-drift'])('accepts genuine fde6133c %s sessions after cold recovery and advance', async variant => {
  const root = await mkdtemp(join(tmpdir(), 'workrail-historical-'));
  const previous = { ...process.env };
  let close: (() => Promise<void>) | undefined;
  try {
    const provenance = JSON.parse(await readFile(join(fixtures, 'provenance.json'), 'utf8'));
    expect(provenance.baselineCommit).toBe('fde6133cbfd281e01520fab73b20061d783f4ddd');
    for (const [file, hash] of Object.entries(provenance.artifactSha256)) {
      if (!file.startsWith(`${variant}/`)) continue;
      expect(createHash('sha256').update(await readFile(join(fixtures, file))).digest('hex')).toBe(hash);
    }
    await cp(join(fixtures, variant), root, { recursive: true });
    const retained = JSON.parse(await readFile(join(root, 'responses.json'), 'utf8'));
    expect(retained.continueToken).toBe(tokenFrom(retained.pending));
    const sessionDirectories = await readdir(join(root, 'sessions'));
    expect(sessionDirectories).toHaveLength(1);
    const eventsDirectory = join(root, 'sessions', sessionDirectories[0]!, 'events');
    const batches = await readdir(eventsDirectory);
    const eventText = (await Promise.all(batches.map(batch => readFile(join(eventsDirectory, batch), 'utf8')))).join('\n');
    expect(eventText).not.toContain('"modelConfig"');
    expect(eventText.includes('drift-refresh')).toBe(variant === 'tier-drift');
    for (const key of ['WORKRAIL_FORCE_MODEL', 'WORKRAIL_ACTIVE_MODEL', 'WORKRAIL_MODEL', 'CLAUDE_CODE', 'CLAUDE_CLI', 'CURSOR_APP', 'WORKRAIL_IS_DAEMON']) delete process.env[key];
    Object.assign(process.env, { WORKRAIL_DATA_DIR: root, WORKFLOW_STORAGE_PATH: join(root, 'workflows'), WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_FORCE_HARNESS: 'mcp', WORKRAIL_CLEAN_RESPONSE_FORMAT: 'false', WORKRAIL_DEV: '0' });
    resetContainer();
    const { server, closeDomain } = await composeServer();
    const input = new PassThrough(); const output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    close = async () => { await closeDomain(new AbortController().signal); await transport.close(); };
    await server.connect(transport);
    let id = 0;
    const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id; let buffer = '';
      const receive = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n'); buffer = lines.pop()!;
        for (const line of lines) {
          const response = JSON.parse(line);
          if (response.id === requestId) { clearTimeout(timer); output.off('data', receive); response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result); }
        }
      };
      const timer = setTimeout(() => { output.off('data', receive); reject(new Error('MCP response deadline exceeded')); }, 10000);
      output.on('data', receive); input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'historical-model-proof', version: '1' } });
    const run = (args: unknown) => call('tools/call', { name: 'continue_workflow', arguments: args });
    // Independent garbage token control does not alter or decode the genuine token.
    const rejected = await run({ continueToken: 'ct_historical-corruption-control', intent: 'rehydrate', workspacePath: root });
    expect(rejected.isError).toBe(true);
    const recovered = await run({ continueToken: retained.continueToken, intent: 'rehydrate', workspacePath: root });
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
    expect(recovered.structuredContent?.pending?.stepId).toBe('first');
    expect(recovered.structuredContent?.pending?.modelRouting).toBeUndefined();
    const recoveredToken = tokenFrom(recovered);
    expect(recoveredToken).toBeTruthy();
    const advanced = await run({ continueToken: recoveredToken, intent: 'advance', workspacePath: root, output: { notesMarkdown: 'Actual prior-version session accepted by current implementation.' } });
    expect(advanced.isError, JSON.stringify(advanced)).not.toBe(true);
    expect(advanced.content.map((item: any) => item.text ?? '').join('\n')).toContain('<!-- stepId: second -->');
    // Corrupt an entire test-owned event batch, not any opaque signed token's contents.
    await writeFile(join(eventsDirectory, batches[0]!), '{corrupt event batch\n');
    const corruption = await run({ continueToken: tokenFrom(advanced), intent: 'rehydrate', workspacePath: root });
    expect(corruption.isError).toBe(true);
  } finally {
    await close?.(); resetContainer(); process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
