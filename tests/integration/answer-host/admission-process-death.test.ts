import { it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { composeAnswerEngine } from '../../../src/answer-v1/engine-composition.js';
import { recoverHostAdmission } from '../../../src/answer-v1/host-admission.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

const require = createRequire(join(process.cwd(), 'package.json'));
const boundarySchema = z.object({ boundary: z.enum(['published', 'locked', 'appended']), sessionId: z.string(),
  expected: z.object({ operationId: z.string().uuid(), request: z.object({ workflowId: z.string(), goal: z.string(), workspacePath: z.string() }) }) });

it.skipIf(process.platform === 'win32').each(['published', 'locked', 'appended'] as const)(
  'recovers the original admission after SIGKILL at %s boundary', async boundary => {
    const root = await mkdtemp(join(tmpdir(), 'admission-process-death-'));
    const child = fork(require.resolve('vite-node/vite-node.mjs'), [
      '--config', 'tests/integration/answer-host/fixtures/admission-crash.config.mjs',
      'tests/integration/answer-host/fixtures/admission-crash.ts', root, boundary,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    let diagnostics = '';
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    child.stdout?.resume();
    const exited = once(child, 'exit');
    try {
      const message = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Admission boundary deadline: ${diagnostics}`)), 7000);
        child.once('message', value => { clearTimeout(timer); resolve(value); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`Early fixture exit: ${diagnostics}`)); });
      });
      const reached = boundarySchema.parse(message);
      expect(reached.boundary).toBe(boundary);
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual([null, 'SIGKILL']);
      const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'source') };
      const engine = await composeAnswerEngine(config);
      if (engine.kind !== 'ready') throw new Error(engine.kind);
      if (boundary !== 'published') {
        const lock = JSON.parse(await readFile(join(root, 'sessions', reached.sessionId, '.lock'), 'utf8'));
        expect(lock.pid).toBe(child.pid);
      }
      const before = await engine.sessionStore.load(asSessionId(reached.sessionId));
      if (before.isErr()) throw new Error(before.error.code);
      expect(before.value.events.length > 0).toBe(boundary === 'appended');
      const result = await recoverHostAdmission(engine, root, reached.expected, new AbortController().signal);
      expect(result.kind).toBe('admitted');
      if (result.kind !== 'admitted') throw new Error(result.kind);
      expect(result.pointer.executionId).toBe(reached.sessionId);
      const truth = await engine.sessionStore.load(asSessionId(reached.sessionId));
      if (truth.isErr()) throw new Error(truth.error.code);
      expect(truth.value.events.filter(event => event.kind === 'run_started')).toHaveLength(1);
      expect(truth.value.events.filter(event => event.kind === 'answer_host_recorded').map(event => event.data.kind)).toEqual(['enrolled']);
      if (boundary === 'appended') expect(truth).toEqual(before);
      expect(await recoverHostAdmission(engine, root, reached.expected, new AbortController().signal)).toEqual(result);
      expect(await engine.sessionStore.load(asSessionId(reached.sessionId))).toEqual(truth);
      expect((await readdir(root)).filter(name => name.endsWith('.json'))).toEqual([`${reached.expected.operationId}.json`]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });
