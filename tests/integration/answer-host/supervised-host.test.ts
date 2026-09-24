import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runSupervisedWorkflow } from '../../../src/daemon/runner/supervised-workflow.js';
import { createAnswerHost } from '../../../src/answer-v1/host.js';
import { createSupervisedAnswerHost } from '../../../src/daemon/runner/supervised-answer-host.js';
import { decodeDaemonExecutionPolicy } from '../../../src/answer-v1/daemon-policy.js';
import type { DeadlineClock } from '../../../src/answer-v1/execution-deadline.js';

it.skipIf(process.platform === 'win32').each(['unsupported', 'preflight_unknown', 'close_during_preflight', 'missing_workflow'] as const)('public supervised host preserves %s without fallback or reprovisioning', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'supervised-host-'));
  const lifetime = new AbortController();
  const dockerCalls: string[][] = [];
  let providerCalls = 0;
  let releasePreflight = () => {};
  const preflightBarrier = new Promise<void>(resolve => { releasePreflight = resolve; });
  let enteredPreflight = () => {};
  const preflightEntered = new Promise<void>(resolve => { enteredPreflight = resolve; });
  const clock: DeadlineClock = {
    read: () => ({ kind: 'reading', wallMs: 1000, monotonicMs: 0 }),
    schedule: () => ({ kind: 'scheduled', cancel() {} }),
  };
  try {
    const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', description: 'Fixture', version: '1.0.0',
      steps: [{ id: 'review', title: 'Review', prompt: 'Review fixture', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } }] }));
    const host = await createSupervisedAnswerHost({ ...config, clock, artifactDirectory: join(root, 'artifacts'),
      credentials: { provider: 'anthropic', apiKey: 'fake-key' },
      fetch: async () => { providerCalls++; throw new Error('No inference without preparation'); },
      docker: { async run(args) { dockerCalls.push([...args]); enteredPreflight(); if (scenario === 'close_during_preflight') await preflightBarrier; return { kind: 'unknown' }; }, stream() { throw new Error('No stream without preflight'); } },
    }, lifetime.signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    const decoded = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1',
      model: { provider: 'anthropic', modelId: 'fixture-model' }, systemPrompt: 'fixture',
      limits: { expiresAtMs: 1100, maxModelCalls: 5, maxOutputTokens: 100, stallTimeoutMs: 100, callTimeoutMs: 50 },
      workspace: scenario === 'unsupported' ? { kind: 'existing', workspacePath: root } : {
        kind: 'linux_scratch', image: 'python@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333', platform: 'linux/arm64',
        snapshot: { kind: 'explicit_files', description: 'Named fixture only', files: [{ path: 'fixture.txt', text: 'fixture' }] } },
      delivery: { kind: 'none' }, restart: { kind: 'requires_explicit_reconciliation' } });
    if (decoded.kind !== 'validated') throw new Error(decoded.kind);
    const operation = { operationId: randomUUID(), request: { workflowId: scenario === 'missing_workflow' ? 'missing' : 'fixture', goal: 'Review', workspacePath: root, daemonPolicy: decoded.policy } };
    const enrolling = host.scheduler.enroll(operation, new AbortController().signal);
    if (scenario === 'close_during_preflight') {
      await preflightEntered;
      expect(await host.scheduler.close(new AbortController().signal)).toMatchObject({ kind: 'incomplete', reason: 'work_in_flight' });
      releasePreflight();
    }
    const result = await enrolling;
    if (scenario === 'unsupported' || scenario === 'missing_workflow') {
      expect(result).toMatchObject({ kind: 'refused', reason: scenario === 'unsupported' ? 'unsupported_execution_policy' : 'unsupported_workflow' });
      expect(dockerCalls).toEqual([]);
      expect(await host.scheduler.close(new AbortController().signal)).toEqual({ kind: 'closed' });
    } else {
      expect(result).toMatchObject({ kind: 'preparation_result', result: { kind: 'not_prepared' } });
      if (result.kind === 'preparation_result' && result.result.kind === 'not_prepared') {
        const promptHost = await createAnswerHost({ ...config, model: { generate: async () => ({ kind: 'cancelled' }) } }, lifetime.signal);
        if (promptHost.kind !== 'created') throw new Error(promptHost.kind);
        expect(await promptHost.scheduler.releaseOwnership(result.result.enrollment, result.result.owner, new AbortController().signal))
          .toEqual({ kind: 'refused', reason: 'supervised_cleanup_required' });
        await promptHost.scheduler.close(new AbortController().signal);
      }
      expect(dockerCalls.map(args => args[0])).toEqual(['info', 'image']);
      if (scenario === 'preflight_unknown') expect(await host.scheduler.enroll(operation, new AbortController().signal)).toMatchObject({ kind: 'admission_result', result: { kind: 'existing' } });
      else expect(await host.scheduler.enroll(operation, new AbortController().signal)).toMatchObject({ kind: 'refused', reason: 'cancelled' });
      expect(dockerCalls.map(args => args[0])).toEqual(['info', 'image']);
      expect(await host.scheduler.close(new AbortController().signal)).toMatchObject({ kind: 'incomplete' });
    }
    expect(providerCalls).toBe(0);
  } finally { releasePreflight(); lifetime.abort(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each([
  { cleanup: 'removed', driving: 'manual' }, { cleanup: 'unknown', driving: 'manual' },
  { cleanup: 'removed', driving: 'automatic' }, { cleanup: 'unknown', driving: 'automatic' },
  { cleanup: 'removed', driving: 'daemon' }, { cleanup: 'unknown', driving: 'daemon' },
  { cleanup: 'create_unknown', driving: 'automatic' }, { cleanup: 'cancel_create', driving: 'automatic' },
] as const)('public host retains mixed review receipts with $cleanup cleanup via $driving driving', async ({ cleanup, driving }) => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'supervised-host-success-'));
  const lifetime = new AbortController();
  const children: import('node:child_process').ChildProcessWithoutNullStreams[] = [];
  const exits: Promise<void>[] = [];
  const commands: string[] = [];
  let label = '', running = false, calls = 0;
  const cid = 'a'.repeat(64), nonce = 'b'.repeat(64);
  const clock: DeadlineClock = { read: () => ({ kind: 'reading', wallMs: 1000, monotonicMs: 0 }), schedule: () => ({ kind: 'scheduled', cancel() {} }) };
  try {
    const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'fixture.json'), JSON.stringify({ id: 'team.fixture', name: 'Fixture', description: 'Fixture', version: '1.0.0', steps: [
      { id: 'review', title: 'Review', prompt: 'Review fixture', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } },
      { id: 'notes', title: 'Notes', prompt: 'Summarize fixture' },
    ] }));
    const host = await createSupervisedAnswerHost({ ...config, clock, artifactDirectory: join(root, 'artifacts'),
      credentials: { provider: 'anthropic', apiKey: 'fake-key' },
      fetch: async () => {
        calls++;
        const answer = calls === 1 ? { notes: 'Reviewed fixture', verdict: 'clean', confidence: 'high', findings: [], summary: 'No issues in fixture' } : { notes: 'Fixture completed' };
        return new Response(JSON.stringify({ id: `response-${calls}`, type: 'message', role: 'assistant', model: 'fixture-model',
          content: [{ type: 'tool_use', id: `call-${calls}`, name: 'answer_work', input: { answer } }], stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
      },
      docker: {
        async run(args) {
          commands.push(args[0]!);
          let value: unknown;
          switch (args[0]) {
            case 'info': value = { ID: 'fixture-daemon', OSType: 'linux' }; break;
            case 'image': value = [{ Architecture: 'arm64', Os: 'linux', Config: { Volumes: null } }]; break;
            case 'create':
              label = args[args.indexOf('--label') + 1]!.split('=')[1]!;
              if (cleanup === 'create_unknown') return { kind: 'unknown' };
              if (cleanup === 'cancel_create') lifetime.abort();
              return { kind: 'completed', bytes: Buffer.from(cid) };
            case 'start': running = true; return { kind: 'completed', bytes: Buffer.from(cid) };
            case 'inspect': value = [{ Id: cid, State: { Running: running }, Config: { Labels: { 'workrail.linux-scratch': label } } }]; break;
            case 'exec': value = { format: 'workrail-scratch-observation-v1', files: [] }; break;
            case 'stop': running = false; return { kind: 'completed', bytes: Buffer.from(cid) };
            case 'rm': return cleanup === 'unknown' ? { kind: 'unknown' } : { kind: 'completed', bytes: Buffer.from(cid) };
            default: throw new Error(`Unexpected Docker command ${args[0]}`);
          }
          return { kind: 'completed', bytes: Buffer.from(JSON.stringify(value)) };
        },
        stream() {
          const program = `const readline=require('node:readline');const nonce=${JSON.stringify(nonce)};process.stdout.write(JSON.stringify({kind:'hello',nonce})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const input=JSON.parse(line);if(input.kind!=='init')process.exit(1);process.stdout.write(JSON.stringify({kind:'ready',nonce})+'\\n');});`;
          const child = spawn(process.execPath, ['-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
          children.push(child); exits.push(new Promise(resolve => child.once('close', () => resolve()))); return child;
        },
      },
    }, lifetime.signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    const decoded = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1', model: { provider: 'anthropic', modelId: 'fixture-model' }, systemPrompt: 'fixture',
      limits: { expiresAtMs: 61000, maxModelCalls: 5, maxOutputTokens: 100, stallTimeoutMs: 1000, callTimeoutMs: 1000 },
      workspace: { kind: 'linux_scratch', image: 'python@sha256:' + 'a'.repeat(64), platform: 'linux/arm64', snapshot: { kind: 'explicit_files', description: 'Empty fixture', files: [] } },
      delivery: { kind: 'none' }, restart: { kind: 'requires_explicit_reconciliation' } });
    if (decoded.kind !== 'validated') throw new Error(decoded.kind);
    const operation = { operationId: randomUUID(), request: { workflowId: 'team.fixture', goal: 'Review', workspacePath: root, daemonPolicy: decoded.policy } };
    if (driving === 'daemon') {
      const { runWorkflow } = await import('../../../src/daemon/workflow-runner.js');
      const trigger = { workflowId: 'team.fixture', goal: 'Review', workspacePath: root };
      const legacy = new Proxy({} as import('../../../src/mcp/types.js').V2ToolContext, {
        get() { throw new Error('Supervised execution must never read legacy engine context'); },
      });
      const result = await runWorkflow(trigger, legacy, undefined, undefined, undefined, undefined, undefined, undefined,
        { kind: 'supervised', scheduler: host.scheduler, operation, signal: new AbortController().signal });
      expect(result).toMatchObject(cleanup === 'removed' ? { _tag: 'success', taskOutcome: 'unknown', lastStepNotes: 'Fixture completed', lastStepArtifacts: [] }
        : { _tag: 'recovery_pending', operationId: operation.operationId });
      expect(calls).toBe(2);
      expect(commands.filter(command => command === 'create')).toHaveLength(1);
      expect(commands.filter(command => command === 'rm')).toHaveLength(1);
      await host.scheduler.close(new AbortController().signal);
      return;
    }
    if (driving === 'automatic') {
      const result = await runSupervisedWorkflow(host.scheduler, operation, new AbortController().signal);
      if (cleanup === 'create_unknown' || cleanup === 'cancel_create') {
        expect(result).toMatchObject({ kind: 'not_started', enrollment: { kind: 'preparation_result', result: { kind: 'not_prepared', outcome: { kind: 'unknown', cleanup: 'unconfirmed' } } } });
        if (result.kind !== 'not_started' || result.enrollment.kind !== 'preparation_result' || result.enrollment.result.kind !== 'not_prepared') throw new Error('Expected retained preparation failure');
        const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
        const { readHostState } = await import('../../../src/answer-v1/host-state.js');
        const reopened = await composeAnswerEngine(config);
        if (reopened.kind !== 'ready') throw new Error(reopened.kind);
        const retained = await readHostState(reopened, result.enrollment.result.enrollment);
        if (retained.kind !== 'loaded') throw new Error(retained.kind);
        expect(retained.state.records.find(record => record.kind === 'supervisor_create_intended')).toMatchObject({ daemon: 'fixture-daemon' });
        expect(commands.filter(command => command === 'create')).toHaveLength(1);
        expect(commands).not.toContain('start');
        expect(calls).toBe(0);
        expect(await host.scheduler.close(new AbortController().signal)).toMatchObject({ kind: 'incomplete' });
        return;
      }
      expect(result).toMatchObject(cleanup === 'removed' ? { kind: 'completed', view: { kind: 'finished' }, output: { kind: 'notes', notesMarkdown: 'Fixture completed', artifacts: [] } }
        : { kind: 'suspended', outcome: { kind: 'advanced', nextView: { kind: 'finished' } }, release: { kind: 'incomplete' } });
      expect(calls).toBe(2);
      expect(commands.filter(command => command === 'create')).toHaveLength(1);
      expect(commands.filter(command => command === 'rm')).toHaveLength(1);
      expect(await host.scheduler.close(new AbortController().signal)).toMatchObject({ kind: cleanup === 'removed' ? 'closed' : 'incomplete' });
      return;
    }
    const result = await host.scheduler.enroll(operation, new AbortController().signal);
    if (result.kind !== 'preparation_result' || result.result.kind !== 'ready') throw new Error(JSON.stringify(result));
    const execution = result.result.execution;
    expect(await execution.runner.runTurn(new AbortController().signal)).toMatchObject({ kind: 'advanced', nextView: { kind: 'question' } });
    expect(commands).not.toContain('rm');
    expect(await execution.runner.runTurn(new AbortController().signal)).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
    expect(commands.filter(command => command === 'create')).toHaveLength(1);
    expect(commands.filter(command => command === 'rm')).toHaveLength(1);
    expect(calls).toBe(2);
    if (cleanup === 'removed') {
      expect(await execution.release(new AbortController().signal)).toEqual({ kind: 'released' });
      expect(await execution.release(new AbortController().signal)).toEqual({ kind: 'stale_owner' });
      expect(await host.scheduler.close(new AbortController().signal)).toEqual({ kind: 'closed' });
    } else {
      expect(await execution.release(new AbortController().signal)).toMatchObject({ kind: 'incomplete', reason: 'cleanup_failed' });
      expect(await host.scheduler.close(new AbortController().signal)).toMatchObject({ kind: 'incomplete', reason: 'cleanup_failed' });
      expect(commands.filter(command => command === 'rm')).toHaveLength(1);
    }
  } finally { lifetime.abort(); for (const child of children) child.kill('SIGKILL'); await Promise.all(exits); await rm(root, { recursive: true, force: true }); }
});
