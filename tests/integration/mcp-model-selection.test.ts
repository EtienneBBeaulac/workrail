import { it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { composeServer } from '../../src/mcp/server.js';
import { resetContainer } from '../../src/di/container.js';

it.each([true, false].flatMap(withConfig => [true, false].map(cleanFormat => ({ withConfig, cleanFormat }))))('preserves MCP policy across cold recovery and advance: %j', async ({ withConfig, cleanFormat }) => {
  const root = await mkdtemp(join(tmpdir(), 'workrail-model-wire-'));
  const previous = { ...process.env };
  process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT = String(cleanFormat);
  let close: (() => Promise<void>) | undefined;
  try {
    const workflows = join(root, 'workflows');
    await mkdir(workflows);
    await writeFile(join(workflows, 'model-parent.json'), JSON.stringify({
      id: 'model-parent', name: 'Model parent', description: 'Model selection wire fixture', version: '1.0.0', modelTier: 'lightweight',
      steps: [
        { id: 'spawn', title: 'Spawn reviews', type: 'parallel', parallelDelegations: [
          { workflowId: 'model-child', modelTier: 'lightweight', args: { deliverableName: 'review.md' }, allowedTools: ['read_file'] },
          { workflowId: 'model-child', modelTier: 'heavy' },
          { workflowId: 'model-child' },
        ] },
        { id: 'synthesize', title: 'Synthesize', modelTier: 'mid', prompt: 'Read child findings.', notesOptional: true },
      ],
    }));
    await writeFile(join(workflows, 'model-child.json'), JSON.stringify({
      id: 'model-child', name: 'Model child', description: 'Child policy lookup fixture', version: '1.0.0', modelTier: 'heavy',
      steps: [{ id: 'review', title: 'Review', prompt: 'Return a bounded review.', notesOptional: true }],
    }));
    process.env.WORKRAIL_DATA_DIR = root;
    process.env.WORKFLOW_STORAGE_PATH = workflows;
    process.env.WORKRAIL_ENABLE_V2_TOOLS = 'true';
    process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false';
    const boot = async () => {
      resetContainer();
      const { server, closeDomain } = await composeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    close = async () => { await closeDomain(new AbortController().signal); await transport.close(); };
    await server.connect(transport);
    let id = 0;
    const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id;
      let buffer = '';
      const receive = (chunk: Buffer) => {
        buffer += chunk.toString();
        for (const line of buffer.split('\n').slice(0, -1)) {
          try {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              output.off('data', receive);
              if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response.result);
            }
          } catch (error) { output.off('data', receive); reject(error); }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      };
      output.on('data', receive);
      input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
      return call;
    };
    let call = await boot();
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'model-wire-proof', version: '1' } });
    const tools = (await call('tools/list', {})).tools;
    expect(tools.find((tool: any) => tool.name === 'start_workflow').inputSchema.properties.modelRouting).toBeDefined();
    const runTool = async (name: string, args: unknown) => {
      const response = await call('tools/call', { name, arguments: args });
      expect(response.isError).not.toBe(true);
      return response;
    };
    const inspect = await runTool('inspect_workflow', { workflowId: 'model-child', workspacePath: root, mode: 'metadata' });
    expect(JSON.parse(inspect.content[0].text).initialModelRequest).toEqual({ kind: 'tier', tier: 'heavy', source: 'workflow' });
    const routing = withConfig ? { lightweight: { kind: 'model', modelId: 'gpt-6-luna' } } : undefined;
    const tokenFrom = (response: any) => response.content.map((item: any) => item.text).join('\n').match(/(?:"continueToken":\s*"|Token: )(ct_[A-Za-z0-9_-]+)/)?.[1];
    let started = await runTool('start_workflow', { workflowId: 'model-parent', workspacePath: root, goal: 'Check model handoffs', ...(withConfig ? { modelTier: 'heavy', modelRouting: routing } : {}) });
    expect(started.structuredContent?.pending?.stepId).toBe('wr-system-onboarding');
    started = await runTool('continue_workflow', { continueToken: tokenFrom(started), intent: 'advance', workspacePath: root, output: { notesMarkdown: 'Acknowledged the workflow protocol.' } });
    expect(started.structuredContent?.pending).toBeDefined();
    const pending = started.structuredContent.pending;
    expect(pending.stepId).toBe('spawn');
    expect(pending.modelTier).toBe(withConfig ? 'heavy' : 'lightweight');
    expect(pending.modelSelection.request.source).toBe(withConfig ? 'session' : 'workflow');
    expect(started.content.map((item: any) => item.text).join('\n')).toContain(
      withConfig ? 'Requested tier: heavy (session)' : 'Requested tier: lightweight (workflow)');
    if (routing) expect(pending.delegations[0].modelSelection.target).toEqual(routing.lightweight);
    else expect(pending.delegations[0].modelSelection.kind).toBe('unresolved');
    expect(pending.delegations[0]).toMatchObject({ workflowId: 'model-child', inputs: { deliverableName: 'review.md' }, allowedTools: ['read_file'] });
    expect(pending.delegations[0].goal).toEqual(expect.any(String));
    expect(pending.delegations[1].modelSelection.request).toEqual({ kind: 'tier', tier: 'heavy', source: 'delegation' });
    expect(started.content.map((item: any) => item.text).join('\n')).toContain('heavy');
    expect(pending.delegations[2].modelSelection).toEqual({ kind: 'workflow_lookup', workflowId: 'model-child' });
    if (withConfig) expect(started.content.map((item: any) => item.text).join('\n')).toContain('gpt-6-luna');

    const token = tokenFrom(started);
    expect(token).toBeTruthy();
    await close?.();
    call = await boot();
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'model-wire-proof-cold', version: '1' } });
    const rehydrated = await runTool('continue_workflow', { continueToken: token, intent: 'rehydrate', workspacePath: root });
    expect(rehydrated.structuredContent.pending.modelRouting).toEqual(routing);
    expect(rehydrated.structuredContent.pending.modelTier).toBe(withConfig ? 'heavy' : 'lightweight');
    const advanced = await runTool('continue_workflow', { continueToken: tokenFrom(rehydrated), intent: 'advance', workspacePath: root,
      context: { modelTier: 'lightweight', modelRouting: { heavy: { kind: 'model', modelId: 'wrong' } } },
      output: { notesMarkdown: 'Wire proof only: no agents were launched. Proceed to inspect immutable configuration.' } });
    if (withConfig) {
      expect(advanced.structuredContent.pending.modelTier).toBe('heavy');
      expect(advanced.structuredContent.pending.modelRouting).toEqual(routing);
    } else {
      expect(advanced.content.map((item: any) => item.text).join('\n')).not.toContain('wrong');
      expect(advanced.structuredContent?.pending?.modelTier).toBe('mid');
      expect(advanced.structuredContent?.pending?.modelSelection.request.source).toBe('step');
    }
  } finally {
    await close?.();
    resetContainer();
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
