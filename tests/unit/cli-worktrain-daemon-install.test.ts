/**
 * Unit tests for executeWorktrainDaemonInstallCommand and
 * executeWorktrainDaemonUninstallCommand.
 *
 * Uses fake deps (in-memory file system state, injectable execLaunchctl).
 * No vi.mock() -- follows repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  executeWorktrainDaemonInstallCommand,
  executeWorktrainDaemonUninstallCommand,
  buildPlistContent,
  type WorktrainDaemonInstallCommandDeps,
} from '../../src/cli/commands/worktrain-daemon-install.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface FakeFsState {
  files: Map<string, string>;
  existingPaths: Set<string>;
  deletedPaths: Set<string>;
}

interface FakeLaunchctlCall {
  args: readonly string[];
}

function makeTestDeps(
  fsState: FakeFsState,
  launchctlCalls: FakeLaunchctlCall[],
  overrides: Partial<WorktrainDaemonInstallCommandDeps> = {},
  envOverrides: Record<string, string | undefined> = {},
): WorktrainDaemonInstallCommandDeps {
  return {
    mkdir: async (): Promise<void> => undefined,
    writeFile: async (filePath: string, content: string): Promise<void> => {
      fsState.files.set(filePath, content);
      fsState.existingPaths.add(filePath);
    },
    readFile: async (filePath: string): Promise<string> => {
      const content = fsState.files.get(filePath);
      if (content === undefined) {
        const err = Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
        throw err;
      }
      return content;
    },
    unlink: async (filePath: string): Promise<void> => {
      fsState.files.delete(filePath);
      fsState.existingPaths.delete(filePath);
      fsState.deletedPaths.add(filePath);
    },
    exists: async (checkPath: string): Promise<boolean> => {
      return fsState.existingPaths.has(checkPath);
    },
    homedir: () => '/home/testuser',
    joinPath: path.join,
    resolveCliScript: () => '/fake/dist/cli.js',
    nodeExecPath: () => '/fake/node',
    execLaunchctl: async (args: readonly string[]): Promise<{ ok: boolean; stderr: string }> => {
      launchctlCalls.push({ args });
      return { ok: true, stderr: '' };
    },
    platform: 'darwin',
    env: { ...envOverrides },
    print: () => undefined,
    ...overrides,
  };
}

function makeDefaultFsState(): FakeFsState {
  return {
    files: new Map(),
    existingPaths: new Set(),
    deletedPaths: new Set(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// buildPlistContent tests (pure function)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlistContent', () => {
  it('includes node exec path and cli script path in ProgramArguments', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/usr/local/lib/workrail/dist/cli.js',
      workspacePath: '/home/user/projects/myapp',
      homeDir: '/home/user',
      envVars: {},
    });

    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/lib/workrail/dist/cli.js</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>--workspace</string>');
    expect(plist).toContain('<string>/home/user/projects/myapp</string>');
  });

  it('does not contain tilde (~) in any <string> path value', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/usr/local/lib/workrail/dist/cli.js',
      workspacePath: '/home/user/projects/myapp',
      homeDir: '/home/user',
      envVars: {},
    });

    // launchd does not expand ~ -- ensure no tilde paths are baked into <string> values.
    // (Comments may contain ~ in prose; we only care about plist value strings.)
    const stringValues = plist.match(/<string>[^<]*<\/string>/g) ?? [];
    for (const val of stringValues) {
      expect(val).not.toContain('~');
    }
  });

  it('sets KeepAlive=true and ThrottleInterval=30', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/path/to/cli.js',
      workspacePath: '/workspace',
      homeDir: '/home/user',
      envVars: {},
    });

    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>30</integer>');
  });

  it('sets the service label to io.worktrain.daemon', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/path/to/cli.js',
      workspacePath: '/workspace',
      homeDir: '/home/user',
      envVars: {},
    });

    expect(plist).toContain('<string>io.worktrain.daemon</string>');
  });

  it('includes env vars in EnvironmentVariables dict when present', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/path/to/cli.js',
      workspacePath: '/workspace',
      homeDir: '/home/user',
      envVars: {
        ANTHROPIC_API_KEY: 'sk-ant-test',
        WORKRAIL_TRIGGERS_ENABLED: 'true',
      },
    });

    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>ANTHROPIC_API_KEY</key>');
    expect(plist).toContain('<string>sk-ant-test</string>');
    expect(plist).toContain('<key>WORKRAIL_TRIGGERS_ENABLED</key>');
  });

  it('omits EnvironmentVariables section when no env vars are present', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/path/to/cli.js',
      workspacePath: '/workspace',
      homeDir: '/home/user',
      envVars: {},
    });

    expect(plist).not.toContain('<key>EnvironmentVariables</key>');
  });

  it('uses absolute log paths derived from homeDir', () => {
    const plist = buildPlistContent({
      nodeExecPath: '/usr/local/bin/node',
      cliScriptPath: '/path/to/cli.js',
      workspacePath: '/workspace',
      homeDir: '/home/user',
      envVars: {},
    });

    expect(plist).toContain('/home/user/.workrail/logs/daemon.stdout.log');
    expect(plist).toContain('/home/user/.workrail/logs/daemon.stderr.log');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// executeWorktrainDaemonInstallCommand tests
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainDaemonInstallCommand', () => {
  let fsState: FakeFsState;
  let launchctlCalls: FakeLaunchctlCall[];

  beforeEach(() => {
    fsState = makeDefaultFsState();
    launchctlCalls = [];
  });

  it('returns failure on non-macOS platform', async () => {
    const deps = makeTestDeps(fsState, launchctlCalls, { platform: 'linux' });
    const result = await executeWorktrainDaemonInstallCommand(deps, { workspace: '/fake/workspace' });

    expect(result.kind).toBe('failure');
    expect(result.kind === 'failure' && result.output.message).toContain('macOS only');
    expect(launchctlCalls).toHaveLength(0);
    // No files should be written
    expect(fsState.files.size).toBe(0);
  });

  it('returns failure when no workspace is configured', async () => {
    const deps = makeTestDeps(fsState, launchctlCalls);
    // No workspace flag, no config.json
    const result = await executeWorktrainDaemonInstallCommand(deps, {});

    expect(result.kind).toBe('failure');
    expect(result.kind === 'failure' && result.output.message).toContain('No workspace configured');
  });

  it('resolves workspace from config.json when no --workspace flag', async () => {
    const configPath = path.join('/home/testuser', '.workrail', 'config.json');
    fsState.files.set(configPath, JSON.stringify({ WORKRAIL_DEFAULT_WORKSPACE: '/configured/workspace' }));
    fsState.existingPaths.add(configPath);

    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {},
      { ANTHROPIC_API_KEY: 'sk-test', WORKRAIL_TRIGGERS_ENABLED: 'true' },
    );
    const result = await executeWorktrainDaemonInstallCommand(deps, {});

    expect(result.kind).toBe('success');
    // Plist should contain the configured workspace
    const plistPath = path.join('/home/testuser', 'Library', 'LaunchAgents', 'io.worktrain.daemon.plist');
    const plistContent = fsState.files.get(plistPath);
    expect(plistContent).toBeDefined();
    expect(plistContent).toContain('/configured/workspace');
  });

  it('installs successfully with --workspace flag and credentials', async () => {
    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {},
      { ANTHROPIC_API_KEY: 'sk-ant-test123', WORKRAIL_TRIGGERS_ENABLED: 'true' },
    );
    const result = await executeWorktrainDaemonInstallCommand(deps, { workspace: '/my/workspace' });

    expect(result.kind).toBe('success');

    // Plist should be written to the correct path
    const plistPath = path.join('/home/testuser', 'Library', 'LaunchAgents', 'io.worktrain.daemon.plist');
    expect(fsState.files.has(plistPath)).toBe(true);

    const plistContent = fsState.files.get(plistPath)!;
    expect(plistContent).toContain('io.worktrain.daemon');
    expect(plistContent).toContain('/my/workspace');
    expect(plistContent).toContain('/fake/node');
    expect(plistContent).toContain('/fake/dist/cli.js');
  });

  it('calls launchctl unload before load (idempotency)', async () => {
    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {},
      { ANTHROPIC_API_KEY: 'sk-test', WORKRAIL_TRIGGERS_ENABLED: 'true' },
    );
    await executeWorktrainDaemonInstallCommand(deps, { workspace: '/my/workspace' });

    // launchctl unload must come before launchctl load
    expect(launchctlCalls.length).toBeGreaterThanOrEqual(2);
    const unloadCall = launchctlCalls.find((c) => c.args[0] === 'unload');
    const loadCall = launchctlCalls.find((c) => c.args[0] === 'load');
    expect(unloadCall).toBeDefined();
    expect(loadCall).toBeDefined();

    const unloadIdx = launchctlCalls.indexOf(unloadCall!);
    const loadIdx = launchctlCalls.indexOf(loadCall!);
    expect(unloadIdx).toBeLessThan(loadIdx);
  });

  it('returns success with warning when no credentials in env', async () => {
    // No AWS_PROFILE, AWS_ACCESS_KEY_ID, or ANTHROPIC_API_KEY
    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {},
      { WORKRAIL_TRIGGERS_ENABLED: 'true' },
    );
    const result = await executeWorktrainDaemonInstallCommand(deps, { workspace: '/my/workspace' });

    // Should succeed but with a warning about missing credentials
    expect(result.kind).toBe('success');
    // The details should contain 'warning'
    expect(result.kind === 'success' && result.output?.details?.join(' ')).toContain('warning');
  });

  it('returns failure when launchctl load fails', async () => {
    let callCount = 0;
    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {
        execLaunchctl: async (args: readonly string[]): Promise<{ ok: boolean; stderr: string }> => {
          launchctlCalls.push({ args });
          callCount++;
          // First call (unload) succeeds, second call (load) fails
          if (args[0] === 'load') {
            return { ok: false, stderr: 'operation not permitted' };
          }
          return { ok: true, stderr: '' };
        },
      },
      { ANTHROPIC_API_KEY: 'sk-test', WORKRAIL_TRIGGERS_ENABLED: 'true' },
    );

    const result = await executeWorktrainDaemonInstallCommand(deps, { workspace: '/my/workspace' });

    expect(result.kind).toBe('failure');
    expect(result.kind === 'failure' && result.output.message).toContain('launchctl load failed');
    expect(result.kind === 'failure' && result.output.message).toContain('operation not permitted');
    void callCount;
  });

  it('only bakes env vars that are present in the environment', async () => {
    const deps = makeTestDeps(
      fsState,
      launchctlCalls,
      {},
      {
        AWS_PROFILE: 'my-sso-profile',
        // ANTHROPIC_API_KEY is absent
        WORKRAIL_TRIGGERS_ENABLED: 'true',
      },
    );
    await executeWorktrainDaemonInstallCommand(deps, { workspace: '/my/workspace' });

    const plistPath = path.join('/home/testuser', 'Library', 'LaunchAgents', 'io.worktrain.daemon.plist');
    const plistContent = fsState.files.get(plistPath)!;

    expect(plistContent).toContain('AWS_PROFILE');
    expect(plistContent).toContain('my-sso-profile');
    expect(plistContent).not.toContain('ANTHROPIC_API_KEY');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// executeWorktrainDaemonUninstallCommand tests
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainDaemonUninstallCommand', () => {
  let fsState: FakeFsState;
  let launchctlCalls: FakeLaunchctlCall[];

  beforeEach(() => {
    fsState = makeDefaultFsState();
    launchctlCalls = [];
  });

  it('returns failure on non-macOS platform', async () => {
    const deps = makeTestDeps(fsState, launchctlCalls, { platform: 'linux' });
    const result = await executeWorktrainDaemonUninstallCommand(deps, {});

    expect(result.kind).toBe('failure');
    expect(result.kind === 'failure' && result.output.message).toContain('macOS only');
  });

  it('returns success (skipped) when plist does not exist', async () => {
    const deps = makeTestDeps(fsState, launchctlCalls);
    // No plist in the fake fs -- not installed
    const result = await executeWorktrainDaemonUninstallCommand(deps, {});

    expect(result.kind).toBe('success');
    expect(launchctlCalls).toHaveLength(0); // no launchctl calls if plist absent
  });

  it('unloads service and deletes plist when installed', async () => {
    const plistPath = path.join('/home/testuser', 'Library', 'LaunchAgents', 'io.worktrain.daemon.plist');
    fsState.files.set(plistPath, '<plist/>');
    fsState.existingPaths.add(plistPath);

    const deps = makeTestDeps(fsState, launchctlCalls);
    const result = await executeWorktrainDaemonUninstallCommand(deps, {});

    expect(result.kind).toBe('success');

    // Plist should be deleted
    expect(fsState.files.has(plistPath)).toBe(false);
    expect(fsState.deletedPaths.has(plistPath)).toBe(true);

    // launchctl unload should be called
    const unloadCall = launchctlCalls.find((c) => c.args[0] === 'unload');
    expect(unloadCall).toBeDefined();
    expect(unloadCall!.args).toContain(plistPath);
  });

  it('succeeds even if launchctl unload returns an error (service not loaded)', async () => {
    const plistPath = path.join('/home/testuser', 'Library', 'LaunchAgents', 'io.worktrain.daemon.plist');
    fsState.files.set(plistPath, '<plist/>');
    fsState.existingPaths.add(plistPath);

    const deps = makeTestDeps(fsState, launchctlCalls, {
      execLaunchctl: async (args: readonly string[]): Promise<{ ok: boolean; stderr: string }> => {
        launchctlCalls.push({ args });
        // launchctl unload fails (service was not loaded)
        return { ok: false, stderr: 'Could not find specified service' };
      },
    });

    const result = await executeWorktrainDaemonUninstallCommand(deps, {});

    // Should still succeed -- unload failure is expected when service is not running
    expect(result.kind).toBe('success');
    // Plist should still be deleted
    expect(fsState.files.has(plistPath)).toBe(false);
  });
});
