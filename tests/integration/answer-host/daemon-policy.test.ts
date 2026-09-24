import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { decodeDaemonExecutionPolicy } from '../../../src/answer-v1/daemon-policy.js';

const fixture = () => ({
  formatVersion: 1, profile: 'daemon_answers_v1',
  model: { provider: 'amazon_bedrock', modelId: 'pinned-model-id', region: 'us-east-1' },
  systemPrompt: 'Retained exact instructions',
  limits: { expiresAtMs: 100000, maxModelCalls: 10, maxOutputTokens: 1024, stallTimeoutMs: 100, callTimeoutMs: 80 },
  workspace: { kind: 'worktree', repositoryPath: resolve('repo'), workspacePath: resolve('worktree'),
    checkout: { kind: 'branch', name: 'review', commit: { algorithm: 'sha1', value: 'a'.repeat(40) } } },
  delivery: { kind: 'none' }, restart: { kind: 'requires_explicit_reconciliation' },
});

it('retains resolved values without defaults, isolates caller input and freezes nested policy', () => {
  const input = fixture();
  const decoded = decodeDaemonExecutionPolicy(input);
  expect(decoded.kind).toBe('validated');
  if (decoded.kind !== 'validated') throw new Error('fixture refused');
  expect(decoded.policy).toEqual(input);
  expect(Object.isFrozen(decoded.policy.limits)).toBe(true);
  expect(Object.isFrozen(decoded.policy.model)).toBe(true);
  if (decoded.policy.workspace.kind === 'worktree') {
    expect(Object.isFrozen(decoded.policy.workspace.checkout.commit)).toBe(true);
  }
  input.limits.maxModelCalls = 100;
  expect(decoded.policy.limits.maxModelCalls).toBe(10);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('refuses invalid numeric budget %s', value => {
  for (const key of Object.keys(fixture().limits)) {
    const input = fixture();
    Reflect.set(input.limits, key, value);
    expect(decodeDaemonExecutionPolicy(input)).toEqual({ kind: 'refused', reason: 'invalid_policy' });
  }
});

it('distinguishes future versions and refuses missing policy fields', () => {
  expect(decodeDaemonExecutionPolicy({ ...fixture(), formatVersion: 2 }))
    .toEqual({ kind: 'refused', reason: 'unsupported_version' });
  for (const key of Object.keys(fixture())) {
    const input = fixture(); Reflect.deleteProperty(input, key);
    expect(decodeDaemonExecutionPolicy(input)).toEqual({ kind: 'refused', reason: 'invalid_policy' });
  }
});

it('rejects secrets and unknown fields at every nested boundary without echoing input', () => {
  for (const select of [
    (x: ReturnType<typeof fixture>) => x, (x: ReturnType<typeof fixture>) => x.model,
    (x: ReturnType<typeof fixture>) => x.limits, (x: ReturnType<typeof fixture>) => x.workspace,
    (x: ReturnType<typeof fixture>) => x.workspace.checkout, (x: ReturnType<typeof fixture>) => x.workspace.checkout.commit,
    (x: ReturnType<typeof fixture>) => x.delivery, (x: ReturnType<typeof fixture>) => x.restart,
  ]) {
    const input = fixture(); Reflect.set(select(input), 'token', 'secret-must-not-appear');
    expect(decodeDaemonExecutionPolicy(input)).toEqual({ kind: 'refused', reason: 'invalid_policy' });
  }
});

it('refuses unpinned new worktree plans and relative workspaces and automatic restart authority', () => {
  const cases = [
    { ...fixture(), workspace: { kind: 'existing', workspacePath: 'relative' } },
    { ...fixture(), workspace: { ...fixture().workspace, checkout: { kind: 'detached', ref: 'main' } } },
    { ...fixture(), restart: { kind: 'automatic' } },
    { ...fixture(), delivery: { kind: 'cli_inbox' } },
    { ...fixture(), model: { provider: 'unknown', modelId: 'model' } },
  ];
  for (const input of cases) expect(decodeDaemonExecutionPolicy(input)).toEqual({ kind: 'refused', reason: 'invalid_policy' });
});

it('bounds retained prompt UTF-8 bytes without truncation', () => {
  expect(decodeDaemonExecutionPolicy({ ...fixture(), systemPrompt: 'x'.repeat(256 * 1024) }).kind).toBe('validated');
  expect(decodeDaemonExecutionPolicy({ ...fixture(), systemPrompt: 'é'.repeat(256 * 1024) }))
    .toEqual({ kind: 'refused', reason: 'invalid_policy' });
});

it('accepts each supported provider and workspace variant without changing the supplied policy', () => {
  const policies = [
    { ...fixture(), model: { provider: 'anthropic', modelId: 'explicit-model' },
      workspace: { kind: 'existing', workspacePath: resolve('existing') } },
    { ...fixture(), workspace: { ...fixture().workspace,
      checkout: { kind: 'detached', commit: { algorithm: 'sha256', value: 'b'.repeat(64) } } } },
  ];
  for (const policy of policies) {
    const decoded = decodeDaemonExecutionPolicy(policy);
    expect(decoded).toEqual({ kind: 'validated', policy });
  }
});

it('refuses impossible worktree structure and unsafe branch spellings', () => {
  const base = fixture();
  expect(decodeDaemonExecutionPolicy({ ...base, workspace: { ...base.workspace, workspacePath: base.workspace.repositoryPath } }).kind).toBe('refused');
  for (const name of ['HEAD', '--orphan', ' ', 'a..b', 'a//b', 'a/', 'a\n']) {
    expect(decodeDaemonExecutionPolicy({ ...base, workspace: { ...base.workspace,
      checkout: { ...base.workspace.checkout, name } } }).kind).toBe('refused');
  }
  for (const [algorithm, length] of [['sha1', 40], ['sha256', 64]] as const) {
    expect(decodeDaemonExecutionPolicy({ ...base, workspace: { ...base.workspace,
      checkout: { kind: 'detached', commit: { algorithm, value: '0'.repeat(length) } } } }).kind).toBe('refused');
  }
});

it('does not default missing nested limits or checkout identity', () => {
  for (const key of Object.keys(fixture().limits)) {
    const input = fixture(); Reflect.deleteProperty(input.limits, key);
    expect(decodeDaemonExecutionPolicy(input).kind).toBe('refused');
  }
  const input = fixture(); Reflect.deleteProperty(input.workspace.checkout.commit, 'value');
  expect(decodeDaemonExecutionPolicy(input).kind).toBe('refused');
});
