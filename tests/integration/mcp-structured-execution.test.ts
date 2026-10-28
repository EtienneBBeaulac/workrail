import { it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

it.each(['classic', 'clean', 'json'] as const)(
  'a structured-only MCP consumer recovers, retries and completes (%s)',
  async mode => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-structured-'));
    const previous = { ...process.env };
    let close: (() => Promise<void>) | undefined;
    let reset: (() => void) | undefined;
    try {
      const workflows = join(root, 'workflows');
      await mkdir(workflows);
      await writeFile(join(root, 'spec.md'), 'The required result contains accepted.');
      await writeFile(join(workflows, 'structured.json'), JSON.stringify({
        id: 'structured', name: 'Structured', description: 'Structured consumer lifecycle', version: '1.0.0',
        references: [{ id: 'spec', title: 'Spec', source: './spec.md', purpose: 'Acceptance rule', authoritative: true }],
        steps: [
          { id: 'first', title: 'First', prompt: 'Return accepted.', modelTier: 'lightweight',
            validationCriteria: [{ type: 'contains', value: 'accepted', message: 'Include accepted.' }] },
          { id: 'last', title: 'Last', prompt: 'Finish.', notesOptional: true },
        ],
      }));
      Object.assign(process.env, {
        WORKRAIL_DATA_DIR: join(root, 'data'), WORKRAIL_KEYS_DIR: join(root, 'data', 'keys'),
        WORKFLOW_STORAGE_PATH: workflows, WORKRAIL_DEFAULT_WORKSPACE: root,
        WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false',
        WORKRAIL_AGENT_PROFILE: 'legacy', WORKRAIL_FORCE_HARNESS: 'mcp',
        WORKRAIL_CLEAN_RESPONSE_FORMAT: String(mode === 'clean'),
        WORKRAIL_JSON_RESPONSES: String(mode === 'json'), WORKRAIL_LOG_LEVEL: 'SILENT',
      });
      vi.resetModules();
      const { composeServer } = await import('../../src/mcp/server.js');
      const { resetContainer } = await import('../../src/di/container.js');
      reset = resetContainer;
      const boot = async () => {
        resetContainer();
        const { server, closeDomain } = await composeServer();
        const input = new PassThrough();
        const output = new PassThrough();
        const transport = new StdioServerTransport(input, output);
        await server.connect(transport);
        close = async () => {
          await closeDomain(new AbortController().signal);
          await server.close();
          await transport.close();
        };
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
              if (response.id !== requestId) continue;
              clearTimeout(timer);
              output.off('data', receive);
              response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result);
            }
          };
          const timer = setTimeout(() => {
            output.off('data', receive);
            reject(new Error('MCP response deadline exceeded'));
          }, 10000);
          output.on('data', receive);
          input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
        });
        await call('initialize', { protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'structured-only-consumer', version: '1' } });
        return call;
      };
      let call = await boot();
      const tools = (await call('tools/list', {})).tools;
      const schemas = new Map<string, ReturnType<Ajv['compile']>>();
      const run = async (name: string, args: unknown) => {
        const result = await call('tools/call', { name, arguments: args });
        expect(result.isError).not.toBe(true);
        const payload = result.structuredContent;
        expect(payload).toBeDefined();
        expect('nextCall' in payload || payload.kind === 'gate_checkpoint').toBe(true);
        if (payload.pending) expect(payload.continueToken, 'Structured continuation authority is required').toBeTruthy();
        if (!schemas.has(name)) {
          const schema = tools.find((tool: { name: string }) => tool.name === name)?.outputSchema;
          expect(schema, 'Execution tools advertise their complete output contract').toBeDefined();
          schemas.set(name, new Ajv({ strict: false }).compile(schema));
        }
        const validate = schemas.get(name)!;
        expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
        return payload;
      };
      const advance = (payload: any, notesMarkdown: string) => {
        expect(payload.nextCall?.tool).toBe('continue_workflow');
        return run(payload.nextCall.tool, { ...payload.nextCall.params, workspacePath: root, output: { notesMarkdown } });
      };
      let response = await run('start_workflow', { workflowId: 'structured', workspacePath: root, goal: 'Complete through structured content' });
      expect(response.pending.stepId).toBe('wr-system-onboarding');
      expect(response.checkpointToken).toBeTruthy();
      expect(response.references[0]).toMatchObject({ id: 'spec', status: 'resolved', resolvedPath: join(root, 'spec.md') });
      expect(response.supplements?.map((s: { kind: string }) => s.kind) ?? []).toEqual(mode === 'clean'
        ? ['executor_directive', 'authority_context', 'notes_guidance', 'subagent_guidance'] : []);
      await close?.();
      call = await boot();
      response = await run('continue_workflow', { continueToken: response.continueToken, intent: 'rehydrate', workspacePath: root });
      expect(response.pending.stepId).toBe('wr-system-onboarding');
      expect(response.nextIntent).toBe('rehydrate_only');
      expect(response.references[0]).toMatchObject({ id: 'spec', status: 'resolved', resolvedPath: join(root, 'spec.md') });
      response = await advance(response, 'Protocol acknowledged.');
      expect(response.pending.stepId).toBe('first');
      expect(response.pending.modelTier).toBe('lightweight');
      expect(response.pending.modelSelection.request).toMatchObject({ kind: 'tier', tier: 'lightweight' });
      response = await advance(response, 'Missing required result.');
      expect(response.kind).toBe('blocked');
      expect(response.retryable).toBe(true);
      expect(response.blockers.blockers.length).toBeGreaterThan(0);
      expect(response.validation.issues.length).toBeGreaterThan(0);
      expect(response.nextCall.params.continueToken).toBe(response.retryContinueToken);
      await close?.();
      call = await boot();
      response = await run('continue_workflow', { continueToken: response.continueToken, intent: 'rehydrate', workspacePath: root });
      expect(response.kind).toBe('blocked');
      expect(response.validation.issues.length).toBeGreaterThan(0);
      response = await advance(response, 'accepted');
      expect(response.pending.stepId).toBe('last');
      response = await advance(response, 'Finished.');
      expect(response).toMatchObject({ kind: 'ok', isComplete: true, pending: null, nextIntent: 'complete', nextCall: null });
      const invalid = await call('tools/call', { name: 'continue_workflow', arguments: { continueToken: 'invalid' } });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();
    } finally {
      await close?.();
      reset?.();
      process.env = previous;
      await rm(root, { recursive: true, force: true });
    }
  }, 45000,
);
