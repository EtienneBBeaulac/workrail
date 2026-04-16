/**
 * Unit tests for executeWorktrainInitCommand
 *
 * Uses fake deps (pre-canned answers array, in-memory file system state).
 * No vi.mock() -- follows repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  executeWorktrainInitCommand,
  type WorktrainInitCommandDeps,
  type WorktrainInitCommandOpts,
} from '../../src/cli/commands/worktrain-init.js';
import { DAEMON_SOUL_TEMPLATE } from '../../src/daemon/soul-template.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface FakeFsState {
  files: Map<string, string>;
  existingPaths: Set<string>;
}

function makeTestDeps(
  answers: string[],
  fsState: FakeFsState,
  overrides: Partial<WorktrainInitCommandDeps> = {},
  envOverrides: Record<string, string | undefined> = {},
): WorktrainInitCommandDeps {
  let answerIdx = 0;

  return {
    prompt: async (_question: string, defaultValue?: string): Promise<string> => {
      const answer = answers[answerIdx++];
      // If no more answers, return defaultValue or empty string
      return answer ?? defaultValue ?? '';
    },
    mkdir: async (): Promise<string | undefined> => {
      return undefined;
    },
    readFile: async (filePath: string): Promise<string> => {
      const content = fsState.files.get(filePath);
      if (content === undefined) {
        const err = Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
        throw err;
      }
      return content;
    },
    writeFile: async (filePath: string, content: string): Promise<void> => {
      fsState.files.set(filePath, content);
      fsState.existingPaths.add(filePath);
    },
    exists: async (checkPath: string): Promise<boolean> => {
      return fsState.existingPaths.has(checkPath);
    },
    homedir: () => '/home/testuser',
    cwd: () => '/fake/cwd',
    joinPath: path.join,
    runSmoke: async () => ({ ok: true, output: 'my-workflow (1.0.0)' }),
    print: () => undefined,
    env: { ...envOverrides },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainInitCommand', () => {
  let fsState: FakeFsState;

  beforeEach(() => {
    fsState = {
      files: new Map(),
      existingPaths: new Set(),
    };
  });

  // ── Full happy path ─────────────────────────────────────────────────────

  it('full happy path: runs all 6 sections and returns success', async () => {
    const answers = [
      '2',                          // credentials: choice 2 = Anthropic
      '/home/testuser/my-repo',     // workspace path
      '',                           // SCM token: Enter = skip
    ];
    const deps = makeTestDeps(answers, fsState);
    const result = await executeWorktrainInitCommand(deps);

    expect(result.kind).toBe('success');
  });

  it('full happy path: writes config.json with WORKRAIL_DEFAULT_WORKSPACE', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState);
    await executeWorktrainInitCommand(deps);

    const configPath = path.join('/home/testuser', '.workrail', 'config.json');
    const configContent = fsState.files.get(configPath);
    expect(configContent).toBeDefined();

    const parsed = JSON.parse(configContent!) as Record<string, unknown>;
    expect(parsed['WORKRAIL_DEFAULT_WORKSPACE']).toBe('/home/testuser/my-repo');
  });

  it('full happy path: writes daemon-soul.md with correct content', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState);
    await executeWorktrainInitCommand(deps);

    const soulPath = path.join('/home/testuser', '.workrail', 'daemon-soul.md');
    const soulContent = fsState.files.get(soulPath);
    expect(soulContent).toBe(DAEMON_SOUL_TEMPLATE);
  });

  it('full happy path: writes triggers.yml in workspace', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState);
    await executeWorktrainInitCommand(deps);

    const triggersPath = path.join('/home/testuser/my-repo', 'triggers.yml');
    const triggersContent = fsState.files.get(triggersPath);
    expect(triggersContent).toBeDefined();
    expect(triggersContent).toContain('provider: generic');
    expect(triggersContent).toContain('workspacePath: /home/testuser/my-repo');
    expect(triggersContent).toContain('workflowId: coding-task-workflow-agentic');
  });

  // ── Credentials section ─────────────────────────────────────────────────

  it('credentials: skips when AWS_PROFILE is set', async () => {
    const printed: string[] = [];
    const answers = ['/home/testuser/my-repo', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      { print: (l) => printed.push(l) },
      { AWS_PROFILE: 'my-sso-profile' },
    );
    await executeWorktrainInitCommand(deps);

    const credLine = printed.find((l) => l.includes('Bedrock credentials detected'));
    expect(credLine).toBeDefined();
  });

  it('credentials: skips when ANTHROPIC_API_KEY is set', async () => {
    const printed: string[] = [];
    const answers = ['/home/testuser/my-repo', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      { print: (l) => printed.push(l) },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );
    await executeWorktrainInitCommand(deps);

    const credLine = printed.find((l) => l.includes('Anthropic API key detected'));
    expect(credLine).toBeDefined();
  });

  it('credentials: prints Bedrock instructions when choice is 1', async () => {
    const printed: string[] = [];
    const answers = [
      '1',                          // choose Bedrock
      '/home/testuser/my-repo',
      '',
    ];
    const deps = makeTestDeps(answers, fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps);

    const bedrockLine = printed.find((l) => l.includes('AWS_PROFILE'));
    expect(bedrockLine).toBeDefined();
  });

  it('credentials: prints Anthropic instructions when choice is 2', async () => {
    const printed: string[] = [];
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps);

    const anthropicLine = printed.find((l) => l.includes('ANTHROPIC_API_KEY'));
    expect(anthropicLine).toBeDefined();
  });

  // ── --yes mode ──────────────────────────────────────────────────────────

  it('--yes mode: runs without any prompts', async () => {
    let promptCalled = false;
    const deps = makeTestDeps(
      [],
      fsState,
      { prompt: async () => { promptCalled = true; return ''; } },
    );
    const opts: WorktrainInitCommandOpts = { yes: true };
    const result = await executeWorktrainInitCommand(deps, opts);

    expect(result.kind).toBe('success');
    expect(promptCalled).toBe(false);
  });

  it('--yes mode: writes config.json with process.cwd() as workspace', async () => {
    const deps = makeTestDeps([], fsState, {}, {});
    await executeWorktrainInitCommand(deps, { yes: true });

    const configPath = path.join('/home/testuser', '.workrail', 'config.json');
    const config = JSON.parse(fsState.files.get(configPath) ?? '{}') as Record<string, unknown>;
    // Default workspace in --yes mode must be cwd (not homedir) so triggers.yml
    // lands in the project root, not the user's home directory.
    expect(config['WORKRAIL_DEFAULT_WORKSPACE']).toBe('/fake/cwd');
  });

  it('--yes mode: skips SCM token section', async () => {
    const printed: string[] = [];
    const deps = makeTestDeps([], fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps, { yes: true });

    const scmLine = printed.find((l) => l.includes('SCM token setup skipped'));
    expect(scmLine).toBeDefined();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────

  it('skips daemon-soul.md if it already exists', async () => {
    const soulPath = path.join('/home/testuser', '.workrail', 'daemon-soul.md');
    fsState.existingPaths.add(soulPath);
    fsState.files.set(soulPath, '# custom soul');

    const printed: string[] = [];
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps);

    // Confirm the file was NOT overwritten
    expect(fsState.files.get(soulPath)).toBe('# custom soul');
    const skipLine = printed.find((l) => l.includes('already exists') && l.includes('daemon-soul.md'));
    expect(skipLine).toBeDefined();
  });

  it('skips triggers.yml if it already exists', async () => {
    const triggersPath = path.join('/home/testuser/my-repo', 'triggers.yml');
    fsState.existingPaths.add(triggersPath);
    fsState.files.set(triggersPath, '# existing triggers');

    const printed: string[] = [];
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps);

    // Confirm the file was NOT overwritten
    expect(fsState.files.get(triggersPath)).toBe('# existing triggers');
  });

  it('merges into existing config.json without clobbering other keys', async () => {
    const configPath = path.join('/home/testuser', '.workrail', 'config.json');
    const existingConfig = { CACHE_TTL: '0', WORKRAIL_VERBOSE_LOGGING: 'false' };
    fsState.files.set(configPath, JSON.stringify(existingConfig));

    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState);
    await executeWorktrainInitCommand(deps);

    const merged = JSON.parse(fsState.files.get(configPath) ?? '{}') as Record<string, unknown>;
    expect(merged['CACHE_TTL']).toBe('0');
    expect(merged['WORKRAIL_VERBOSE_LOGGING']).toBe('false');
    expect(merged['WORKRAIL_DEFAULT_WORKSPACE']).toBe('/home/testuser/my-repo');
  });

  // ── Workspace path validation ───────────────────────────────────────────

  it('warns when workspace path does not exist but continues', async () => {
    const printed: string[] = [];
    const answers = ['2', '/nonexistent/path', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      { print: (l) => printed.push(l) },
    );
    const result = await executeWorktrainInitCommand(deps);

    expect(result.kind).toBe('success');
    const warningLine = printed.find((l) => l.includes('Directory not found'));
    expect(warningLine).toBeDefined();
  });

  // ── Smoke test ──────────────────────────────────────────────────────────

  it('smoke test: reports success when workrail list succeeds', async () => {
    const printed: string[] = [];
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      {
        print: (l) => printed.push(l),
        runSmoke: async () => ({ ok: true, output: 'workflow-1 (1.0.0)\nworkflow-2 (2.0.0)' }),
      },
    );
    await executeWorktrainInitCommand(deps);

    const smokeLine = printed.find((l) => l.includes('workrail list succeeded'));
    expect(smokeLine).toBeDefined();
  });

  it('smoke test: command still succeeds even when workrail list fails', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      {
        runSmoke: async () => ({ ok: false, output: 'workrail: command not found' }),
      },
    );
    const result = await executeWorktrainInitCommand(deps);

    // Smoke test failure is a warning, not a fatal error
    expect(result.kind).toBe('success');
  });

  // ── SCM token ───────────────────────────────────────────────────────────

  it('SCM token: prints export instructions when token is provided', async () => {
    const printed: string[] = [];
    const answers = [
      '2',                                          // credentials
      '/home/testuser/my-repo',                     // workspace
      'ghp_test_token_12345',                       // SCM token
    ];
    const deps = makeTestDeps(answers, fsState, { print: (l) => printed.push(l) });
    await executeWorktrainInitCommand(deps);

    const tokenLine = printed.find((l) => l.includes('GITHUB_TOKEN=ghp_test_token_12345'));
    expect(tokenLine).toBeDefined();

    // Confirm token was NOT written to any file
    for (const content of fsState.files.values()) {
      expect(content).not.toContain('ghp_test_token_12345');
    }
  });

  it('SCM token: skips when GITHUB_TOKEN is already set in env', async () => {
    const printed: string[] = [];
    const answers = ['2', '/home/testuser/my-repo'];
    const deps = makeTestDeps(
      answers,
      fsState,
      { print: (l) => printed.push(l) },
      { GITHUB_TOKEN: 'existing-token' },
    );
    await executeWorktrainInitCommand(deps);

    const skipLine = printed.find((l) => l.includes('GITHUB_TOKEN already set'));
    expect(skipLine).toBeDefined();
  });

  // ── Config write failure ────────────────────────────────────────────────

  it('returns failure when config.json write fails', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(
      answers,
      fsState,
      {
        writeFile: async (filePath: string) => {
          if (filePath.includes('config.json')) {
            throw new Error('Permission denied');
          }
        },
      },
    );
    const result = await executeWorktrainInitCommand(deps);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('Failed to write config.json');
    }
  });

  // ── triggers.yml content validates against trigger-store ───────────────

  it('triggers.yml template uses provider: generic and has all required fields', async () => {
    const answers = ['2', '/home/testuser/my-repo', ''];
    const deps = makeTestDeps(answers, fsState);
    await executeWorktrainInitCommand(deps);

    const triggersPath = path.join('/home/testuser/my-repo', 'triggers.yml');
    const content = fsState.files.get(triggersPath)!;

    expect(content).toContain('provider: generic');
    expect(content).toContain('workflowId: coding-task-workflow-agentic');
    expect(content).toContain('workspacePath: /home/testuser/my-repo');
    expect(content).toContain('goal:');
    expect(content).toContain('id: my-first-trigger');
  });
});
