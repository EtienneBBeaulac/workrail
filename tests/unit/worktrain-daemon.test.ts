/**
 * Tests for worktrain daemon (bare start, --install, --uninstall, --status)
 *
 * All I/O is exercised via injected fakes. No real filesystem, no real
 * launchctl. This makes the tests fast, deterministic, and macOS-agnostic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeWorktrainDaemonCommand,
  parseDotEnv,
  type WorktrainDaemonCommandDeps,
} from '../../src/cli/commands/worktrain-daemon.js';
import { loadDaemonEnv, type LoadDaemonEnvDeps } from '../../src/daemon/daemon-env.js';

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
  chmodCalls: Array<{ path: string; mode: number }>;
} {
  const files = new Map<string, FakeFile>();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const printed: string[] = [];
  const chmodCalls: Array<{ path: string; mode: number }> = [];

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
    chmodCalls: Array<{ path: string; mode: number }>;
  } = {
    files,
    execCalls,
    printed,
    chmodCalls,

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
    chmod: async (p, mode) => {
      chmodCalls.push({ path: p, mode });
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
    // Default: health endpoint responds 200 immediately.
    // Override in specific tests to simulate timeout (return null) or custom port checks.
    httpGet: async (_url: string): Promise<number | null> => 200,

    ...overrides,
  };

  return deps;
}

const PLIST_PATH = '/Users/test/Library/LaunchAgents/io.worktrain.daemon.plist';

// ═══════════════════════════════════════════════════════════════════════════
// bare invocation (no flags) -- daemon start
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon (no flags)', () => {
  it('calls startDaemon when provided and no flags are given', async () => {
    let started = false;
    const deps = buildFakeDeps({
      startDaemon: async () => { started = true; },
    });
    const result = await executeWorktrainDaemonCommand(deps, {});

    expect(started).toBe(true);
    expect(result.kind).toBe('success');
  });

  it('returns misuse when no flags and startDaemon is absent', async () => {
    const deps = buildFakeDeps();
    // No startDaemon in overrides -- falls through to usage error.
    const result = await executeWorktrainDaemonCommand(deps, {});

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('--install');
    }
  });

  it('platform guard does not apply to bare daemon start', async () => {
    // Even on linux, startDaemon should be called (the daemon itself is not macOS-only).
    let started = false;
    const deps = buildFakeDeps({
      platform: 'linux',
      startDaemon: async () => { started = true; },
    });
    const result = await executeWorktrainDaemonCommand(deps, {});

    expect(started).toBe(true);
    expect(result.kind).toBe('success');
  });
});

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

  it('succeeds even when no LLM credentials in env (secrets go in ~/.workrail/.env)', async () => {
    // Credentials are no longer required at install time -- they go in
    // ~/.workrail/.env and are loaded by loadDaemonEnv() at daemon startup.
    const deps = buildFakeDeps({
      env: { HOME: '/Users/test', PATH: '/usr/bin' },
    });
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('success');
  });

  it('writes the plist file to ~/Library/LaunchAgents/', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('success');
    expect(deps.files.has(PLIST_PATH)).toBe(true);
  });

  it('sets plist permissions to 0o600 after writing', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const chmodCall = deps.chmodCalls.find((c) => c.path === PLIST_PATH);
    expect(chmodCall).toBeDefined();
    expect(chmodCall?.mode).toBe(0o600);
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

  it('plist contains WorkingDirectory set to homedir', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/Users/test</string>');
  });

  it('plist contains WORKRAIL_TRIGGERS_ENABLED', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    expect(plist).toContain('WORKRAIL_TRIGGERS_ENABLED');
  });

  it('plist does NOT contain RunAtLoad or KeepAlive (operator must start explicitly)', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });

    const plist = deps.files.get(PLIST_PATH)?.content ?? '';
    // WHY: auto-start at login and auto-restart on crash means WorkTrain acts
    // autonomously in repos without deliberate operator action. The operator
    // must explicitly run `worktrain daemon --start` to begin autonomous work.
    expect(plist).not.toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('<key>KeepAlive</key>');
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

  it('returns success with --start instruction (install no longer auto-starts)', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { install: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('--start');
    }
  });

  it('output tells operator to run --start after install', async () => {
    const deps = buildFakeDeps();
    await executeWorktrainDaemonCommand(deps, { install: true });
    const output = deps.printed.join('\n');
    expect(output).toContain('--start');
    expect(output).not.toContain('running (PID');
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

  it('overrides WORKRAIL_TRIGGERS_ENABLED to true when set to false and emits warning', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const deps = buildFakeDeps({
        env: {
          AWS_PROFILE: 'test-profile',
          WORKRAIL_TRIGGERS_ENABLED: 'false',
          HOME: '/Users/test',
          PATH: '/usr/bin',
        },
      });
      await executeWorktrainDaemonCommand(deps, { install: true });

      const plist = deps.files.get(PLIST_PATH)?.content ?? '';
      // The plist must have the flag set to true regardless of the env value.
      expect(plist).toContain('WORKRAIL_TRIGGERS_ENABLED');
      expect(plist).toContain('<string>true</string>');
      // A warning must have been emitted.
      expect(warnings.some((w) => w.includes('WORKRAIL_TRIGGERS_ENABLED'))).toBe(true);
      expect(warnings.some((w) => w.includes("'false'"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
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
// --start
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --start', () => {
  it('returns failure when plist is not installed', async () => {
    const deps = buildFakeDeps();
    // No plist in files -- not installed
    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('not installed');
    }
  });

  it('calls launchctl start with the service label', async () => {
    const deps = buildFakeDeps();
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    const startCall = deps.execCalls.find(
      (c) => c.command === 'launchctl' && c.args[0] === 'start',
    );
    expect(startCall).toBeDefined();
    expect(startCall?.args[1]).toBe('io.worktrain.daemon');
  });

  it('returns success when health endpoint responds 200', async () => {
    const deps = buildFakeDeps();
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('Daemon started successfully');
    }
  });

  it('returns failure when launchctl start fails', async () => {
    const deps = buildFakeDeps({
      exec: async (command, args) => {
        if (command === 'launchctl' && args[0] === 'start') {
          return { stdout: '', stderr: 'service not loaded', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    expect(result.kind).toBe('failure');
  });

  it('returns failure on non-darwin platform', async () => {
    const deps = buildFakeDeps({ platform: 'linux' });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('macOS');
    }
  });

  it('returns failure when health endpoint never responds (daemon crashed)', async () => {
    // Simulate daemon crash: httpGet always returns null (connection refused).
    const deps = buildFakeDeps({
      httpGet: async (_url: string): Promise<number | null> => null,
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      // Should mention the log path so operator knows where to look.
      expect(result.output.message).toContain('5 seconds');
    }
  });

  it('uses WORKRAIL_TRIGGER_PORT env var for health endpoint URL', async () => {
    const capturedUrls: string[] = [];
    const deps = buildFakeDeps({
      env: {
        ...{
          AWS_PROFILE: 'test-profile',
          WORKRAIL_TRIGGERS_ENABLED: 'true',
          HOME: '/Users/test',
          PATH: '/usr/local/bin:/usr/bin:/bin',
        },
        WORKRAIL_TRIGGER_PORT: '9999',
      },
      httpGet: async (url: string): Promise<number | null> => {
        capturedUrls.push(url);
        return 200;
      },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    expect(capturedUrls.some((url) => url.includes(':9999'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// --stop
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --stop', () => {
  it('calls launchctl stop with the service label', async () => {
    const deps = buildFakeDeps();

    await executeWorktrainDaemonCommand(deps, { stop: true });

    const stopCall = deps.execCalls.find(
      (c) => c.command === 'launchctl' && c.args[0] === 'stop',
    );
    expect(stopCall).toBeDefined();
    expect(stopCall?.args[1]).toBe('io.worktrain.daemon');
  });

  it('returns success when launchctl stop succeeds', async () => {
    const deps = buildFakeDeps();
    const result = await executeWorktrainDaemonCommand(deps, { stop: true });

    expect(result.kind).toBe('success');
  });

  it('returns success with "not running" message when service is already stopped', async () => {
    const deps = buildFakeDeps({
      exec: async (command, args) => {
        if (command === 'launchctl' && args[0] === 'stop') {
          return { stdout: '', stderr: 'no such process', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await executeWorktrainDaemonCommand(deps, { stop: true });

    // Already stopped is not an error -- it's the desired end state
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.output?.message).toContain('not running');
    }
  });

  it('returns failure on non-darwin platform', async () => {
    const deps = buildFakeDeps({ platform: 'linux' });

    const result = await executeWorktrainDaemonCommand(deps, { stop: true });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('macOS');
    }
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
  it('returns misuse when no flag is provided and startDaemon is absent', async () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// loadDaemonEnv
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tests for loadDaemonEnv().
 *
 * loadDaemonEnv reads ~/.workrail/.env and sets env vars in process.env.
 * Shell env always wins: existing keys are never overwritten.
 * Missing .env file is silently ignored.
 *
 * WHY injected deps: ESM module namespace exports cannot be spied on in Vitest
 * (vi.spyOn on os.homedir fails with "cannot redefine property"). Using injected
 * deps avoids module mocking entirely and follows the repo's DI philosophy.
 */
describe('loadDaemonEnv', () => {
  // Track keys set by each test so we can clean up after.
  const keysToClean: string[] = [];

  beforeEach(() => {
    keysToClean.length = 0;
  });

  afterEach(() => {
    // Restore process.env: delete any keys added by the test.
    for (const key of keysToClean) {
      delete process.env[key];
    }
  });

  /** Build fake deps with the given .env file content (or null for missing). */
  function fakeDeps(content: string | null): LoadDaemonEnvDeps {
    return {
      homedir: () => '/fake/home',
      readFile: async (p) => {
        if (content === null) {
          throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        }
        return content;
      },
    };
  }

  it('loads .env file and sets missing env vars', async () => {
    keysToClean.push('WORKTRAIN_BOT_TOKEN', 'ANOTHER_KEY');
    delete process.env['WORKTRAIN_BOT_TOKEN'];
    delete process.env['ANOTHER_KEY'];

    await loadDaemonEnv(fakeDeps('WORKTRAIN_BOT_TOKEN=secret-token\nANOTHER_KEY=another-value'));

    expect(process.env['WORKTRAIN_BOT_TOKEN']).toBe('secret-token');
    expect(process.env['ANOTHER_KEY']).toBe('another-value');
  });

  it('does NOT override existing env vars (shell wins)', async () => {
    process.env['EXISTING_KEY'] = 'original-shell-value';
    keysToClean.push('EXISTING_KEY');

    await loadDaemonEnv(fakeDeps('EXISTING_KEY=from-dot-env'));

    expect(process.env['EXISTING_KEY']).toBe('original-shell-value');
  });

  it('silently ignores a missing .env file', async () => {
    // Should not throw
    await expect(loadDaemonEnv(fakeDeps(null))).resolves.toBeUndefined();
  });

  it('skips comment lines and empty lines', async () => {
    keysToClean.push('ACTUAL_KEY');
    delete process.env['ACTUAL_KEY'];

    await loadDaemonEnv(fakeDeps('# this is a comment\n\nACTUAL_KEY=actual-value\n   # indented comment'));

    expect(process.env['ACTUAL_KEY']).toBe('actual-value');
  });

  it('handles values containing = (splits on first = only)', async () => {
    keysToClean.push('COMPLEX_VALUE');
    delete process.env['COMPLEX_VALUE'];

    await loadDaemonEnv(fakeDeps('COMPLEX_VALUE=value=with=equals=signs'));

    expect(process.env['COMPLEX_VALUE']).toBe('value=with=equals=signs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseDotEnv
// ═══════════════════════════════════════════════════════════════════════════

describe('parseDotEnv', () => {
  it('parses simple KEY=VALUE lines', () => {
    const result = parseDotEnv('FOO=bar\nBAZ=qux');
    expect(result['FOO']).toBe('bar');
    expect(result['BAZ']).toBe('qux');
  });

  it('ignores comment lines starting with #', () => {
    const result = parseDotEnv('# this is a comment\nFOO=bar');
    expect(Object.keys(result)).toEqual(['FOO']);
  });

  it('ignores blank lines', () => {
    const result = parseDotEnv('\n\nFOO=bar\n\n');
    expect(Object.keys(result)).toEqual(['FOO']);
  });

  it('handles value with equals signs', () => {
    const result = parseDotEnv('API_KEY=sk-ant-abc=123');
    expect(result['API_KEY']).toBe('sk-ant-abc=123');
  });

  it('returns empty object for empty content', () => {
    expect(parseDotEnv('')).toEqual({});
    expect(parseDotEnv('# only comments\n\n')).toEqual({});
  });

  it('ignores lines without equals sign', () => {
    const result = parseDotEnv('INVALID_LINE\nFOO=bar');
    expect(result['INVALID_LINE']).toBeUndefined();
    expect(result['FOO']).toBe('bar');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// --start credential warning
// ═══════════════════════════════════════════════════════════════════════════

describe('worktrain daemon --start credential check', () => {
  it('starts without warning when ANTHROPIC_API_KEY is in process env', async () => {
    const deps = buildFakeDeps({
      env: { AWS_PROFILE: undefined, ANTHROPIC_API_KEY: 'sk-ant-test', HOME: '/Users/test', PATH: '/usr/bin' },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    const output = deps.printed.join('\n');
    expect(output).not.toContain('WARNING');
  });

  it('starts without warning when AWS_PROFILE is in process env', async () => {
    const deps = buildFakeDeps({
      env: { AWS_PROFILE: 'my-profile', HOME: '/Users/test', PATH: '/usr/bin' },
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    const output = deps.printed.join('\n');
    expect(output).not.toContain('WARNING');
  });

  it('starts without warning when ANTHROPIC_API_KEY is in ~/.workrail/.env', async () => {
    const deps = buildFakeDeps({
      env: { HOME: '/Users/test', PATH: '/usr/bin' }, // no creds in env
    });
    // Put the key in the .env file
    deps.files.set('/Users/test/.workrail/.env', { content: 'ANTHROPIC_API_KEY=sk-ant-from-file' });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    const output = deps.printed.join('\n');
    expect(output).not.toContain('WARNING');
  });

  it('prints WARNING when no credentials found anywhere', async () => {
    const deps = buildFakeDeps({
      env: { HOME: '/Users/test', PATH: '/usr/bin' }, // no creds
      // readFile will throw ENOENT for .env since files map is empty
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    await executeWorktrainDaemonCommand(deps, { start: true });

    const output = deps.printed.join('\n');
    expect(output).toContain('WARNING');
    expect(output).toContain('~/.workrail/.env');
  });

  it('still starts successfully even when credentials warning fires', async () => {
    const deps = buildFakeDeps({
      env: { HOME: '/Users/test', PATH: '/usr/bin' }, // no creds
    });
    deps.files.set(PLIST_PATH, { content: '<plist />' });

    const result = await executeWorktrainDaemonCommand(deps, { start: true });

    // Warning is advisory -- start still proceeds
    expect(result.kind).toBe('success');
  });
});
