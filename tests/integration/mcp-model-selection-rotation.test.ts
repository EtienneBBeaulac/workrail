import { it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { composeServer } from '../../src/mcp/server.js';
import { container, resetContainer } from '../../src/di/container.js';
import { DI } from '../../src/di/tokens.js';
import type { KeyringPortV2 } from '../../src/v2/ports/keyring.port.js';

it('advances an active MCP session across successive key rotations and cold restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workrail-model-rotation-'));
  const previous = { ...process.env };
  let close: (() => Promise<void>) | undefined;
  try {
    const workflows = join(root, 'workflows');
    await mkdir(workflows);
    await writeFile(join(workflows, 'rotation.json'), JSON.stringify({
      id: 'rotation', name: 'Rotation', description: 'Attestation renewal lifecycle', version: '1.0.0',
      steps: ['first', 'second'].map(id => ({ id, title: id, prompt: 'Return a note.', notesOptional: true })),
    }));
    Object.assign(process.env, {
      WORKRAIL_DATA_DIR: root, WORKFLOW_STORAGE_PATH: workflows, WORKRAIL_KEYS_DIR: join(root, 'keys'),
      WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false',
      WORKRAIL_JSON_RESPONSES: 'true', WORKRAIL_AGENT_PROFILE: 'legacy', WORKRAIL_FORCE_HARNESS: 'mcp',
    });
    const boot = async () => {
      resetContainer();
      const { server, closeDomain } = await composeServer();
      const input = new PassThrough();
      const output = new PassThrough();
      const transport = new StdioServerTransport(input, output);
      await server.connect(transport);
      close = async () => { await closeDomain(new AbortController().signal); await server.close(); await transport.close(); };
      let id = 0;
      const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const requestId = ++id;
        let buffer = '';
        const receive = (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              output.off('data', receive);
              if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response.result);
            }
          }
        };
        output.on('data', receive);
        input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'model-rotation-test', version: '1' } });
      return async (name: string, args: unknown) => {
        const response = await call('tools/call', { name, arguments: args });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        return response;
      };
    };
    const token = (response: any): string => {
      const match = response.content.map((item: any) => item.text).join('\n')
        .match(/(?:"continueToken":\s*"|Token: )(ct_[A-Za-z0-9_-]+)/);
      expect(match, 'Continuation must be present in the MCP response').not.toBeNull();
      return match![1]!;
    };
    let tool = await boot();
    let response = await tool('start_workflow', { workflowId: 'rotation', workspacePath: root, goal: 'Check renewal' });
    for (const expectedStep of ['first', 'second']) {
      const rotated = await container.resolve<KeyringPortV2>(DI.V2.Keyring).rotate();
      expect(rotated.isOk()).toBe(true);
      await close?.();
      tool = await boot();
      response = await tool('continue_workflow', { continueToken: token(response), intent: 'rehydrate', workspacePath: root });
      response = await tool('continue_workflow', { continueToken: token(response), intent: 'advance', workspacePath: root,
        output: { notesMarkdown: 'Completed under a newly rotated key.' } });
      expect(response.structuredContent.pending.stepId).toBe(expectedStep);
    }
  } finally {
    await close?.();
    resetContainer();
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
