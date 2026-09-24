import { it, expect } from 'vitest';
import { observeScratchResource } from '../../src/daemon/runner/linux-scratch/observation.js';
import { scratchContainerName } from '../../src/daemon/runner/linux-scratch/identity.js';
import type { SupervisorState } from '../../src/answer-v1/supervisor-state.js';
import type { DockerReply } from '../../src/daemon/runner/linux-scratch/docker-cli.js';

const supervisor = 'evt_original';
const cid = 'a'.repeat(64);
const intent = { kind: 'supervisor_create_intended' as const, supervisor, epoch: '1', configurationDigest: 'b'.repeat(64), daemon: 'original' };
const pending: SupervisorState = { kind: 'create_pending', intent };
const bound: SupervisorState = { kind: 'running', intent, binding: { daemon: 'original', environment: cid } };
const completed = (value: unknown): DockerReply => ({ kind: 'completed', bytes: Buffer.from(JSON.stringify(value)) });
class DockerFake {
  readonly calls: string[][] = [];
  infoCount = 0;
  constructor(readonly scenario: string) {}
  async run(args: readonly string[]): Promise<DockerReply> {
    this.calls.push([...args]);
    switch (args[0]) {
      case 'info':
        this.infoCount++;
        return completed({ ID: this.scenario === 'wrong_daemon' || (this.scenario === 'changed_daemon' && this.infoCount === 2) ? 'replacement' : 'original', OSType: 'linux' });
      case 'ps':
        if (this.scenario === 'list_failure') return { kind: 'unknown' };
        if (this.scenario === 'absent') return { kind: 'completed', bytes: Buffer.from('') };
        if (this.scenario === 'malformed') return { kind: 'completed', bytes: Buffer.from('not-json') };
        if (this.scenario === 'ambiguous') return { kind: 'completed', bytes: Buffer.from(JSON.stringify(cid) + '\n' + JSON.stringify('c'.repeat(64))) };
        return completed(this.scenario === 'orphan' && args.some(arg => arg.startsWith('label=')) ? 'c'.repeat(64) : cid);
      case 'inspect':
        if (this.scenario === 'inspect_failure') return { kind: 'unknown' };
        return completed([{ Id: this.scenario === 'wrong_id' ? 'c'.repeat(64) : cid,
          Name: this.scenario === 'wrong_name' ? '/other' : '/' + scratchContainerName(supervisor),
          State: { Running: this.scenario !== 'stopped' }, Config: { Labels: { 'workrail.linux-scratch': this.scenario === 'wrong_label' ? 'another' : supervisor } } }]);
      default: throw new Error('Mutation or execution command forbidden: ' + args[0]);
    }
  }
}
it.each(['pending', 'bound'] as const)('observes %s identity without granting cleanup or execution', async kind => {
  const docker = new DockerFake('present');
  expect(await observeScratchResource(kind === 'pending' ? pending : bound, docker, new AbortController().signal))
    .toEqual({ kind: 'present', daemon: 'original', supervisor, container: cid, phase: 'running' });
  expect(docker.calls.map(c => c[0])).toEqual(kind === 'pending' ? ['info', 'ps', 'ps', 'inspect', 'info'] : ['info', 'ps', 'ps', 'ps', 'inspect', 'info']);
  expect(docker.calls[1]).toContain('label=workrail.linux-scratch=' + supervisor);
  if (kind === 'bound') expect(docker.calls[3]).toContain('id=' + cid);
});
it.each([
  ['absent', 'absent_at_observation'], ['list_failure', 'unavailable'], ['inspect_failure', 'unavailable'],
  ['malformed', 'unavailable'], ['orphan', 'identity_mismatch'], ['ambiguous', 'identity_mismatch'], ['wrong_daemon', 'identity_mismatch'],
  ['changed_daemon', 'identity_mismatch'], ['wrong_id', 'identity_mismatch'], ['wrong_name', 'identity_mismatch'], ['wrong_label', 'identity_mismatch'],
] as const)('classifies %s as %s without confusing failed inspection with absence', async (scenario, kind) => {
  const docker = new DockerFake(scenario);
  expect(await observeScratchResource(pending, docker, new AbortController().signal)).toMatchObject({ kind });
  expect(docker.calls.every(c => ['info', 'ps', 'inspect'].includes(c[0]!))).toBe(true);
});
it('does not invent missing historical identity or issue I/O when cancelled', async () => {
  const docker = new DockerFake('present');
  const { daemon: _daemon, ...legacy } = intent;
  expect(await observeScratchResource({ kind: 'create_pending', intent: legacy }, docker, new AbortController().signal)).toEqual({ kind: 'missing_daemon_identity' });
  expect(await observeScratchResource({ kind: 'absent' }, docker, new AbortController().signal)).toEqual({ kind: 'no_intent' });
  expect(await observeScratchResource(pending, docker, AbortSignal.abort())).toEqual({ kind: 'unavailable' });
  expect(docker.calls).toEqual([]);
});
it('preserves stopped observation as distinct from absent or removed', async () => {
  const docker = new DockerFake('stopped');
  expect(await observeScratchResource(bound, docker, new AbortController().signal)).toMatchObject({ kind: 'present', phase: 'stopped' });
});
