import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSessionWorkspace, rollbackPreparedWorkspace, type WorkspacePreparationEffects } from '../../src/daemon/runner/workspace-preparation.js';
import { planSessionWorkspace } from '../../src/daemon/runner/legacy-workspace-plan.js';
import { asRunId } from '../../src/daemon/daemon-events.js';
const exec = promisify(execFile);

it('borrows an inherited workspace without invoking effects, while explicit strategies retain precedence', async () => {
  const trigger = { workspacePath: '/repository' };
  const plan = planSessionWorkspace(trigger, asRunId('run'), '/worktrees', '/inherited');
  expect(plan.kind).toBe('planned');
  if (plan.kind !== 'planned') return;
  const forbidden = async () => { throw Error('borrowed workspace must not invoke effects'); };
  expect(await prepareSessionWorkspace(plan.plan, { ensureDirectory: forbidden, git: forbidden }))
    .toEqual({ kind: 'borrowed', workspacePath: '/inherited', worktreePath: '/inherited' });
  const created = planSessionWorkspace({ ...trigger, branchStrategy: 'worktree' }, asRunId('run'), '/worktrees', '/inherited');
  expect(created).toMatchObject({ kind: 'planned', plan: { kind: 'create', checkout: { kind: 'branch' } } });
  expect(planSessionWorkspace({ ...trigger, branchStrategy: 'read-only' }, asRunId('run'), '/worktrees'))
    .toMatchObject({ kind: 'failed' });
});

it('stops before creation when fetching fails, without claiming workspace ownership', async () => {
  const calls: string[] = [];
  const effects: WorkspacePreparationEffects = {
    ensureDirectory: async () => { calls.push('directory'); },
    git: async (_repo, args) => { calls.push(args[0]!); throw Error('fetch unavailable'); },
  };
  const result = await prepareSessionWorkspace({ kind: 'create', repositoryPath: '/repo', worktreePath: '/worktrees/run',
    checkout: { kind: 'branch', name: 'test', base: 'main' } }, effects);
  expect(result).toEqual({ kind: 'failed', message: 'fetch unavailable' });
  expect(calls).toEqual(['directory', 'fetch']);
});

it.each(['branch', 'detached'] as const)('creates and rolls back a real %s worktree without allocating an engine session', async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workrail-preparation-')));
  const repository = join(root, 'repo'), origin = join(root, 'origin.git'), hooks = join(root, 'hooks');
  const git = async (cwd: string, args: readonly string[]) => exec('git', ['-C', cwd, ...args]);
  try {
    await mkdir(repository); await mkdir(hooks);
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.email', 'test@example.test']);
    await git(repository, ['config', 'user.name', 'Test']);
    await git(repository, ['config', 'core.hooksPath', hooks]);
    await git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture']);
    await exec('git', ['clone', '--bare', repository, origin]);
    await git(repository, ['remote', 'add', 'origin', origin]);
    const effects: WorkspacePreparationEffects = {
      ensureDirectory: async directory => { await mkdir(directory, { recursive: true }); },
      git: async (cwd, args) => { await git(cwd, args); },
    };
    const result = await prepareSessionWorkspace({ kind: 'create', repositoryPath: repository, worktreePath: join(root, 'trees', 'run'),
      checkout: kind === 'branch' ? { kind: 'branch', name: 'test/run', base: 'main' } : { kind: 'detached', ref: 'main' } }, effects);
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect((await git(result.workspacePath, ['rev-parse', 'HEAD'])).stdout)
      .toBe((await git(repository, ['rev-parse', 'HEAD'])).stdout);
    if (kind === 'branch') expect((await git(result.workspacePath, ['branch', '--show-current'])).stdout.trim()).toBe('test/run');
    else expect((await git(result.workspacePath, ['branch', '--show-current'])).stdout.trim()).toBe('');
    expect(await rollbackPreparedWorkspace(result, effects)).toBe('removed');
    expect((await git(repository, ['worktree', 'list', '--porcelain'])).stdout.replaceAll('\\', '/'))
      .not.toContain(result.worktreePath.replaceAll('\\', '/'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
