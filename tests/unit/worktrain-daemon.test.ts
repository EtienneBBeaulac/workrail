/**
 * Tests for worktrain daemon --install / --uninstall / --status
 *
 * All I/O is exercised via injected fakes. No real filesystem, no real
 * launchctl. This makes the tests fast, deterministic, and macOS-agnostic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeWorktrainDaemonCommand,
  type WorktrainDaemonCommandDeps,
  type WorktrainDaemonCommandOpts,
} from '../../src/cli/commands/worktrain-daemon.js';

// ═══════════════════════════════════════════════════════════════════════════
// FAKE BUILDER
// ═══════════════════════════════════════════════════════════════════════════

interface FakeFile {
  content: string;
}

type ExecFakeResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Build a minimal set of fakes for the daemon command.
 *
 * Callers can override individual fields to inject specific behavior.
 */
function buildFakeDeps(overrides: Partial<WorktrainDaemonCommandDeps> = {}): WorktrainDaemonCommandDeps & {
  files: Map<string, FakeFile>;
  execCalls: Array<{ command: string; args: string[] }>;
  printed: string[];
} {
  const files = new Map<string, FakeFile>();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const printed: string[] = [];

  // Default exec: returns success for all commands, returning a valid
  // launchctl list JSON for the LAUNCHD_LABEL.
  const defaultExec = async (
    command: string,
    args: string[],
  ): Promise<ExecFakeResult> => {
    execCalls.push({ command, args });
    if (command === 'launchctl' && args[0] === 'list') {
      return {
        stdout: JSON.stringify({ PID: 42, Status: 0, Label: 'io.worktrain.daemon' }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const deps: WorktrainDaemonCommandDeps & {
    files: Map<string, FakeFile>;
    execCalls: Array<{ command: string; args: string[] }>;
    printed: string[];
  } = {
    files,
    execCalls,
    printed,

    env: {
      AWS_PROFILE: 'test-profile',
      WORKRAIL_TRIGGERS_ENABLED: 'true',
      HOME: '/Users/test',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    platform: 'darwin',
    worktrainBinPath: '/usr/local/bin/worktrain',
    nodeBinPath: '/usr/local/bin/node',
    homedir: () => '/Users/test',
    joinPath: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    mkdir: async () => undefined,
    writeFile: async (p, content) => {
      files.set(p, { content });
    },
    readFile: async (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return f.content;
    },
    removeFile: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      files.delete(p);
    },
    exists: async (p) => files.has(p),
    exec: defaultExec,
    print: (line) => printed.push(line),
    sleep: async () => undefined,

    ...overrides,
  };

  return deps;
}

const PLIST_PATH = '/Users/test/Library/LaunchAgents/io.worktrain.daemon.plist';

// ═══════════════════════════════════════════════════════════════════════════
// --install
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --install', () => {
  it('returns failure on non-darwin platform', async () => {
    const deps = buildFakeDeps({ platform: 'linux' });
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('macOS');
    }
  });

  it('returns failure when no LLM credentials are present', async () => {
    const deps = buildFakeDeps({
      env: { HOME: '/Users/test', PATH: '/usr/bin' },
    });
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('LLM credentials');
    }
  });

  it('writes the plist file to ~/Library/LaunchAgents/', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('success');
    expect(deps.files.has(PLIST_PATH)).toBe(true);
  });

  it('plist contains the worktrain binary path', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('/usr/local/bin/worktrain');
  });

  it('plist contains the node binary path', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('/usr/local/bin/node');
  });

  it('plist contains WORKRAIL_TRIGGERS_ENABLED', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('WORKRAIL_TRIGGERS_ENABLED');
  });

  it('plist contains RunAtLoad and KeepAlive', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('calls launchctl load with the plist path', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const loadCall = deps.execCalls.find(
      (c) => c.command === 'launchctl' && c.args[0] === 'load',
    );
    expect(loadCall).toBeDefined();
    expect(loadCall?.args[1]).toBe(PLIST_PATH);
  });

  it('returns success with running PID when launchctl list shows PID', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('PID 42');
    }
  });

  it('unloads existing service before reinstalling', async () => {
    const deps = buildFakeDeps();
    // Pre-populate the plist to simulate an existing install.
    deps.files.set(PLIST_PATH, { content: '<existing>' });

    await executeWorktrainDaemonCommand(deps, { install: true });

    const unloadCall = deps.execCalls.find(
      (c) => c.command === 'launchctl' && c.args[0] === 'unload',
    );
    expect(unloadCall).toBeDefined();
  });

  it('returns failure when launchctl load fails', async () => {
    const deps = buildFakeDeps({
      exec: async (command, args) => {
        if (command === 'launchctl' && args[0] === 'load') {
          return { stdout: '', stderr: 'plist parse error', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('launchctl load failed');
    }
  });

  it('injects WORKRAIL_TRIGGERS_ENABLED=true when not present in env', async () => {
    const deps = buildFakeDeps({
      env: {
        AWS_PROFILE: 'test-profile',
        HOME: '/Users/test',
        PATH: '/usr/bin',
        // WORKRAIL_TRIGGERS_ENABLED intentionally absent
      },
    });
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('WORKRAIL_TRIGGERS_ENABLED');
    expect(plist).toContain('<string>true</string>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// --uninstall
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --uninstall', () => {
  it('returns failure when plist does not exist', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { uninstall: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('not installed');
    }
  });

  it('calls launchctl unload and removes plist when installed', async () => {
    const deps = buildFakeDeps();
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { uninstall: true });

    expect(result.kind).toBe('success');
    expect(deps.files.has(PLIST_PATH)).toBe(false);

    const unloadCall = deps.execCalls.find(
      (c) => c.command === 'launchctl' && c.args[0] === 'unload',
    );
    expect(unloadCall).toBeDefined();
  });

  it('still removes plist even when launchctl unload returns non-zero', async () => {
    const deps = buildFakeDeps({
      exec: async (command, args) => {
        if (command === 'launchctl' && args[0] === 'unload') {
          return { stdout: '', stderr: 'not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { uninstall: true });

    // Non-fatal: plist should still be removed and result should be success.
    expect(result.kind).toBe('success');
    expect(deps.files.has(PLIST_PATH)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// --status
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --status', () => {
  it('reports not installed when plist is absent and launchctl list fails', async () => {
    const deps = buildFakeDeps({
      exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    });

    const result = await executeWorktrainDaemonCommand(deps, { status: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('not installed');
    }
  });

  it('reports running with PID when launchctl list returns PID', async () => {
    const deps = buildFakeDeps();
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { status: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('PID 42');
    }
  });

  it('reports installed but not running when launchctl list has no PID', async () => {
    const deps = buildFakeDeps({
      exec: async (command, args) => {
        if (command === 'launchctl' && args[0] === 'list') {
          return {
            stdout: JSON.stringify({ Status: 0, Label: 'io.worktrain.daemon' }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { status: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('not running');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon -- flag validation', () => {
  it('returns misuse when no flag is provided', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, {});

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('--install');
    }
  });

  it('returns misuse when multiple flags are provided', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { install: true, uninstall: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('mutually exclusive');
    }
  });
});
