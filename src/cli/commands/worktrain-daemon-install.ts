/**
 * WorkTrain Daemon Install / Uninstall Command
 *
 * Manages the WorkTrain daemon as a macOS launchd service so it runs outside
 * Claude Code's process tree. Without this, a Claude Code reconnect that starts
 * a new MCP server process can kill the running daemon.
 *
 * WHY launchd: launchd is the macOS system-level service manager. A service
 * registered under ~/Library/LaunchAgents/ is owned by the login session, not
 * by any IDE or terminal. Claude Code reconnects cannot touch it.
 *
 * macOS ONLY. Linux/systemd is a non-goal for this implementation.
 *
 * Design invariants:
 * - All I/O is injected via WorktrainDaemonInstallCommandDeps. Zero direct fs/os/exec imports.
 * - No throws. Every failure path returns a CliResult failure variant.
 * - The plist must never contain `~` paths -- launchd does not expand tilde.
 * - The workrail CLI script path is resolved via __dirname from the composition root
 *   (symlink-independent; both cli.js and cli-worktrain.js are co-located in dist/).
 * - ThrottleInterval=30 prevents launchd from spinning in a tight restart loop
 *   if the service exits immediately (e.g., no credentials at startup).
 * - Install is idempotent: unload first (ignore error if not loaded), overwrite plist, load.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** The launchd label for the WorkTrain daemon service. */
const SERVICE_LABEL = 'io.worktrain.daemon';

/** The plist file path relative to ~/Library/LaunchAgents/. */
const PLIST_FILENAME = `${SERVICE_LABEL}.plist`;

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCY INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All I/O operations required by the install/uninstall commands.
 * Inject real implementations in the composition root; inject fakes in tests.
 */
export interface WorktrainDaemonInstallCommandDeps {
  /** Create directory (recursive: true = mkdir -p). */
  readonly mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
  /** Write UTF-8 string to file. */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** Read file contents as UTF-8 string. Throws on ENOENT. */
  readonly readFile: (path: string) => Promise<string>;
  /** Delete a file. Does NOT throw on ENOENT. */
  readonly unlink: (path: string) => Promise<void>;
  /** Return true if the path exists. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Return the user's home directory. */
  readonly homedir: () => string;
  /** Join path segments (same semantics as node:path join). */
  readonly joinPath: (...paths: string[]) => string;
  /**
   * Return the absolute path to the workrail CLI script (cli.js).
   * In the real composition root: path.resolve(__dirname, 'cli.js').
   * WHY __dirname: both cli.js and cli-worktrain.js are co-located in dist/.
   * This is symlink-independent and deterministic.
   */
  readonly resolveCliScript: () => string;
  /**
   * Return the absolute path to the Node.js binary.
   * In the real composition root: process.execPath.
   * Injected so tests can use a fake path.
   */
  readonly nodeExecPath: () => string;
  /**
   * Run a launchctl command. Returns ok=true on exit code 0.
   * The callee MUST use execFile (not exec) to avoid shell injection.
   */
  readonly execLaunchctl: (args: readonly string[]) => Promise<{ readonly ok: boolean; readonly stderr: string }>;
  /** The OS platform string. In the real composition root: process.platform. */
  readonly platform: string;
  /** Current process environment. Used to bake credentials into the plist. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Print a line to stdout. */
  readonly print: (line: string) => void;
}

/**
 * Options for the daemon install command.
 */
export interface WorktrainDaemonInstallCommandOpts {
  /** Workspace path. Overrides config.json default when provided. */
  readonly workspace?: string;
}

/**
 * Options for the daemon uninstall command (no workspace needed).
 */
export interface WorktrainDaemonUninstallCommandOpts {
  // Intentionally empty -- uninstall does not need a workspace.
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION RESULT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a single install step.
 * Discriminated union -- errors-as-data per repo philosophy.
 */
type SectionResult =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'configured'; readonly summary: string }
  | { readonly kind: 'warning'; readonly summary: string; readonly warning: string }
  | { readonly kind: 'error'; readonly message: string };

// ═══════════════════════════════════════════════════════════════════════════
// PLIST TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Environment variable names that should be baked into the plist if present.
 *
 * WHY these keys:
 * - AWS_PROFILE / AWS_ACCESS_KEY_ID: needed for Bedrock LLM access.
 * - ANTHROPIC_API_KEY: needed for direct Anthropic access.
 * - WORKRAIL_TRIGGERS_ENABLED: the daemon guard; without this the daemon exits immediately.
 *
 * WHY only profile name, not STS tokens: the AWS SDK auto-refreshes STS credentials
 * at runtime using the profile name. Baking STS tokens would create a 1-hour expiry cliff.
 */
const ENV_VARS_TO_BAKE = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'ANTHROPIC_API_KEY',
  'WORKRAIL_TRIGGERS_ENABLED',
] as const;

/**
 * Build the launchd plist XML for the WorkTrain daemon service.
 *
 * All paths in the plist are absolute -- launchd does not expand `~`.
 * ThrottleInterval=30 prevents launchd from spinning in a tight restart loop
 * when the daemon exits immediately (e.g., missing credentials).
 */
export function buildPlistContent(opts: {
  readonly nodeExecPath: string;
  readonly cliScriptPath: string;
  readonly workspacePath: string;
  readonly homeDir: string;
  readonly envVars: Readonly<Record<string, string>>;
}): string {
  const { nodeExecPath, cliScriptPath, workspacePath, homeDir, envVars } = opts;

  const logDir = `${homeDir}/.workrail/logs`;

  // Build EnvironmentVariables dict XML -- only inject vars that are present.
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join('\n');

  const envSection =
    Object.keys(envVars).length > 0
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>

  <!--
    ProgramArguments: absolute paths only. launchd does not expand ~ or use PATH.
    WHY node + script (not shebang): launchd's minimal launch environment may not
    include the user's PATH, so #!/usr/bin/env node resolution can fail.
    Using the absolute node binary from process.execPath at install time is deterministic.
    If you upgrade Node via nvm after installing, re-run: worktrain daemon --install
  -->
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExecPath}</string>
    <string>${cliScriptPath}</string>
    <string>daemon</string>
    <string>--workspace</string>
    <string>${workspacePath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${workspacePath}</string>

  <!-- Start the service automatically at login. -->
  <key>RunAtLoad</key>
  <true/>

  <!--
    KeepAlive=true: launchd restarts the daemon if it exits for any reason.
    This is the root fix: the daemon survives MCP server reconnects because it
    is owned by launchd, not by any IDE process tree.
  -->
  <key>KeepAlive</key>
  <true/>

  <!--
    ThrottleInterval: minimum seconds between restarts.
    WHY 30s: prevents launchd from spinning in a tight restart loop if the daemon
    exits immediately (e.g., missing credentials or bad workspace path).
  -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${logDir}/daemon.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.stderr.log</string>

${envSection}</dict>
</plist>
`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the workspace path with the following precedence:
 *   1. --workspace flag (explicit user choice)
 *   2. WORKRAIL_DEFAULT_WORKSPACE from ~/.workrail/config.json
 *   3. Error (no silent cwd default for a long-lived installed service)
 *
 * WHY no cwd fallback for install (unlike `workrail daemon`):
 * An installed service must be reproducible across reboots. The cwd at install
 * time has no meaning after a reboot. Requiring an explicit workspace prevents
 * silent misconfiguration.
 */
async function resolveWorkspace(
  deps: WorktrainDaemonInstallCommandDeps,
  opts: WorktrainDaemonInstallCommandOpts,
): Promise<{ readonly workspacePath: string } | { readonly error: string }> {
  if (opts.workspace) {
    return { workspacePath: opts.workspace };
  }

  // Try config.json
  const configPath = deps.joinPath(deps.homedir(), '.workrail', 'config.json');
  try {
    const raw = await deps.readFile(configPath);
    const config = JSON.parse(raw) as Record<string, unknown>;
    const configured = config['WORKRAIL_DEFAULT_WORKSPACE'];
    if (typeof configured === 'string' && configured.trim() !== '') {
      return { workspacePath: configured.trim() };
    }
  } catch {
    // Config file missing or invalid -- fall through to error
  }

  return {
    error:
      'No workspace configured. Provide --workspace <path> or run `worktrain init` first.',
  };
}

/**
 * Collect the environment variables to bake into the plist.
 * Only injects variables that are currently set in the environment.
 */
function collectEnvVars(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ENV_VARS_TO_BAKE) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build and write the plist, then load the launchd service.
 * Unloads any existing instance first (idempotency).
 */
async function runInstallSection(
  deps: WorktrainDaemonInstallCommandDeps,
  workspacePath: string,
): Promise<SectionResult> {
  const homeDir = deps.homedir();
  const plistDir = deps.joinPath(homeDir, 'Library', 'LaunchAgents');
  const plistPath = deps.joinPath(plistDir, PLIST_FILENAME);
  const logDir = deps.joinPath(homeDir, '.workrail', 'logs');

  // Collect credentials to bake in
  const envVars = collectEnvVars(deps.env);
  const hasCredentials =
    !!envVars['AWS_PROFILE'] ||
    !!envVars['AWS_ACCESS_KEY_ID'] ||
    !!envVars['ANTHROPIC_API_KEY'];

  // Ensure log directory exists
  try {
    await deps.mkdir(logDir, { recursive: true });
  } catch (err) {
    return {
      kind: 'error',
      message: `Failed to create log directory ${logDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Ensure LaunchAgents directory exists
  try {
    await deps.mkdir(plistDir, { recursive: true });
  } catch (err) {
    return {
      kind: 'error',
      message: `Failed to create LaunchAgents directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build plist content
  const nodeExecPath = deps.nodeExecPath();
  const cliScriptPath = deps.resolveCliScript();

  const plistContent = buildPlistContent({
    nodeExecPath,
    cliScriptPath,
    workspacePath,
    homeDir,
    envVars,
  });

  // Unload existing instance first (idempotency -- ignore error if not loaded)
  await deps.execLaunchctl(['unload', '-w', plistPath]);

  // Write the plist
  try {
    await deps.writeFile(plistPath, plistContent);
  } catch (err) {
    return {
      kind: 'error',
      message: `Failed to write plist to ${plistPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Load the service
  const loadResult = await deps.execLaunchctl(['load', '-w', plistPath]);
  if (!loadResult.ok) {
    return {
      kind: 'error',
      message:
        `launchctl load failed: ${loadResult.stderr.trim() || '(no stderr output)'}. ` +
        `Plist written to ${plistPath} but service was not started.`,
    };
  }

  if (!hasCredentials) {
    return {
      kind: 'warning',
      summary: `Service installed at ${plistPath} and loaded.`,
      warning:
        'No LLM credentials found in current environment. The service will fail to start ' +
        'until you set AWS_PROFILE (Bedrock) or ANTHROPIC_API_KEY (Anthropic) and re-run: ' +
        'worktrain daemon --install',
    };
  }

  return {
    kind: 'configured',
    summary: `Service installed at ${plistPath} and loaded. Node: ${nodeExecPath}. Script: ${cliScriptPath}.`,
  };
}

/**
 * Unload and delete the launchd service plist.
 */
async function runUninstallSection(
  deps: WorktrainDaemonInstallCommandDeps,
): Promise<SectionResult> {
  const plistPath = deps.joinPath(
    deps.homedir(),
    'Library',
    'LaunchAgents',
    PLIST_FILENAME,
  );

  const plistExists = await deps.exists(plistPath);
  if (!plistExists) {
    return { kind: 'skipped', reason: `No plist found at ${plistPath} (service was not installed)` };
  }

  // Unload the service (ignore error if not currently loaded)
  await deps.execLaunchctl(['unload', '-w', plistPath]);

  // Delete the plist
  try {
    await deps.unlink(plistPath);
  } catch (err) {
    return {
      kind: 'error',
      message: `Failed to delete plist at ${plistPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    kind: 'configured',
    summary: `Service unloaded and plist removed: ${plistPath}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute `worktrain daemon --install`.
 *
 * Creates a launchd plist at ~/Library/LaunchAgents/io.worktrain.daemon.plist,
 * then loads it with launchctl. The daemon will start at login and restart on crash.
 *
 * Idempotent: calling --install when the service is already running unloads it first,
 * overwrites the plist (useful to update workspace or credentials), then reloads.
 *
 * macOS only.
 */
export async function executeWorktrainDaemonInstallCommand(
  deps: WorktrainDaemonInstallCommandDeps,
  opts: WorktrainDaemonInstallCommandOpts = {},
): Promise<CliResult> {
  // Guard: macOS only
  if (deps.platform !== 'darwin') {
    return failure(
      `worktrain daemon --install is macOS only (detected platform: ${deps.platform}). ` +
        'Linux/systemd support is not yet implemented.',
      { suggestions: ['On Linux, start the daemon manually: workrail daemon --workspace <path>'] },
    );
  }

  deps.print('');
  deps.print('WorkTrain Daemon Install');
  deps.print('════════════════════════════════════════');
  deps.print('');

  // Resolve workspace
  const workspaceResult = await resolveWorkspace(deps, opts);
  if ('error' in workspaceResult) {
    return failure(workspaceResult.error, {
      suggestions: ['Run `worktrain init` to configure a default workspace, or pass --workspace <path>'],
    });
  }
  const { workspacePath } = workspaceResult;

  deps.print(`[ 1/1 ] Install launchd service`);
  deps.print(`  Workspace: ${workspacePath}`);

  const installResult = await runInstallSection(deps, workspacePath);
  printSectionResult(deps, installResult);

  if (installResult.kind === 'error') {
    return failure(installResult.message, {
      suggestions: [
        'Check that ~/Library/LaunchAgents/ is writable.',
        'Check that launchctl is available (macOS only).',
      ],
    });
  }

  deps.print('');
  deps.print('Service is running. To verify:');
  deps.print(`  launchctl list ${SERVICE_LABEL}`);
  deps.print('');
  deps.print('Logs:');
  deps.print(`  tail -f ~/.workrail/logs/daemon.stdout.log`);
  deps.print(`  tail -f ~/.workrail/logs/daemon.stderr.log`);
  deps.print('');
  deps.print('Credential note:');
  deps.print('  LLM credentials (AWS_PROFILE or ANTHROPIC_API_KEY) are baked into the');
  deps.print('  plist at install time. Re-run --install after changing credentials.');
  deps.print('  AWS SSO: the profile name is baked in, not STS tokens -- the SDK');
  deps.print('  auto-refreshes tokens at runtime. Run `aws sso login` when the session expires.');
  deps.print('');
  deps.print('To uninstall: worktrain daemon --uninstall');

  const detailLine =
    installResult.kind === 'warning'
      ? `warning: ${installResult.summary} -- ${installResult.warning}`
      : installResult.kind === 'configured'
        ? `configured: ${installResult.summary}`
        : `done`;

  return success({
    message: 'WorkTrain daemon installed as a launchd service',
    details: [detailLine],
  });
}

/**
 * Execute `worktrain daemon --uninstall`.
 *
 * Unloads the launchd service and removes the plist file.
 * Idempotent: calling --uninstall when the service is not installed succeeds cleanly.
 *
 * macOS only.
 */
export async function executeWorktrainDaemonUninstallCommand(
  deps: WorktrainDaemonInstallCommandDeps,
  _opts: WorktrainDaemonUninstallCommandOpts = {},
): Promise<CliResult> {
  // Guard: macOS only
  if (deps.platform !== 'darwin') {
    return failure(
      `worktrain daemon --uninstall is macOS only (detected platform: ${deps.platform}).`,
    );
  }

  deps.print('');
  deps.print('WorkTrain Daemon Uninstall');
  deps.print('════════════════════════════════════════');
  deps.print('');
  deps.print('[ 1/1 ] Remove launchd service');

  const uninstallResult = await runUninstallSection(deps);
  printSectionResult(deps, uninstallResult);

  if (uninstallResult.kind === 'error') {
    return failure(uninstallResult.message);
  }

  deps.print('');
  deps.print('To reinstall: worktrain daemon --install');

  return success({
    message:
      uninstallResult.kind === 'skipped'
        ? 'WorkTrain daemon service was not installed (nothing to remove)'
        : 'WorkTrain daemon uninstalled',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function printSectionResult(
  deps: WorktrainDaemonInstallCommandDeps,
  result: SectionResult,
): void {
  switch (result.kind) {
    case 'skipped':
      deps.print(`  Skipped: ${result.reason}`);
      break;
    case 'configured':
      deps.print(`  Done: ${result.summary}`);
      break;
    case 'warning':
      deps.print(`  Done: ${result.summary}`);
      deps.print(`  Warning: ${result.warning}`);
      break;
    case 'error':
      deps.print(`  Error: ${result.message}`);
      break;
  }
  deps.print('');
}
