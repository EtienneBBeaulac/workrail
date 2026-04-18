/**
 * WorkTrain Daemon Install Command
 *
 * Manages the WorkRail daemon as a macOS launchd service so it runs outside
 * Claude Code's process tree and survives MCP server reconnects.
 *
 * Subcommands (mutually exclusive flags):
 *   worktrain daemon --install    Create plist + load service + verify running
 *   worktrain daemon --uninstall  Unload service + remove plist
 *   worktrain daemon --status     Check whether the launchd service is running
 *
 * WHY launchd: When the daemon runs as a child of the MCP server process, any
 * Claude Code reconnect spawns a new MCP server and displaces the running daemon.
 * A launchd service runs as a sibling process of all Claude Code sessions, not
 * as a child of any of them. It also restarts automatically after crashes.
 *
 * Design invariants:
 * - All I/O is injected via WorktrainDaemonCommandDeps. No direct fs/child_process.
 * - Errors are returned as CliResult failure variants -- never thrown.
 * - The plist is only written when --install is requested (not on every run).
 * - Only recognized env vars are captured -- avoids leaking unrelated secrets.
 * - Idempotent: --install on an already-installed service unloads and reloads.
 * - macOS only: returns an explicit error on non-darwin platforms.
 */

import type { CliResult } from '../types/cli-result.js';
import { success, failure, misuse } from '../types/cli-result.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The launchd service label. Must match the Label key in the plist.
 * WHY io.worktrain.daemon (reverse domain): follows Apple's convention for
 * user-installed services. Apple reserves the com.apple.* namespace; third-party
 * services should use io.*, com.company.* etc.
 */
const LAUNCHD_LABEL = 'io.worktrain.daemon';

/** Plist filename under ~/Library/LaunchAgents/. */
const PLIST_FILENAME = `${LAUNCHD_LABEL}.plist`;

/**
 * Env vars captured from the current process at install time.
 *
 * WHY a fixed list: we do not want to snapshot the full process.env into the
 * plist (that would capture unrelated secrets). Only the vars that the daemon
 * actually reads are included.
 */
const CAPTURED_ENV_VARS = [
  // LLM credentials (one of these is required at daemon start time)
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY',

  // Daemon feature flags
  'WORKRAIL_TRIGGERS_ENABLED',

  // Workspace default (also readable from config.json, but plist wins for
  // daemons that start before any user shell is active)
  'WORKRAIL_DEFAULT_WORKSPACE',

  // SCM tokens for polling triggers
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',

  // Node.js / shell basics needed by the daemon process
  'HOME',
  'USER',
  'PATH',

  // WorkRail developer overrides (useful for local dev installs)
  'WORKRAIL_DEV',
  'WORKRAIL_LOG_LEVEL',
  'WORKRAIL_VERBOSE_LOGGING',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All I/O operations the daemon command requires.
 * Inject real implementations in the composition root; inject fakes in tests.
 */
export interface WorktrainDaemonCommandDeps {
  /** Current process environment. Used to capture env vars into the plist. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Platform identifier (process.platform). */
  readonly platform: string;
  /** Absolute path to the current worktrain executable (process.argv[1] or which worktrain). */
  readonly worktrainBinPath: string;
  /** Absolute path to the node executable (process.execPath). */
  readonly nodeBinPath: string;
  /** Return the current user's home directory. */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...paths: string[]) => string;
  /** Create a directory recursively. */
  readonly mkdir: (path: string, opts: { recursive: boolean }) => Promise<unknown>;
  /** Write UTF-8 content to a file. */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** Read file contents as UTF-8. Throws on ENOENT. */
  readonly readFile: (path: string) => Promise<string>;
  /** Delete a file. Throws on ENOENT unless swallowMissing is set. */
  readonly removeFile: (path: string) => Promise<void>;
  /** Return true if a path exists. */
  readonly exists: (path: string) => Promise<boolean>;
  /**
   * Execute a command and return stdout + exit code.
   * Never throws -- errors are represented as ExecResult with non-zero exitCode.
   */
  readonly exec: (
    command: string,
    args: string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  /** Print a line to stdout. */
  readonly print: (line: string) => void;
  /** Sleep for the given number of milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
}

export interface WorktrainDaemonCommandOpts {
  /** Create and load the launchd service. Mutually exclusive with uninstall/status. */
  readonly install?: boolean;
  /** Unload and remove the launchd service. Mutually exclusive with install/status. */
  readonly uninstall?: boolean;
  /** Report the current service status. Mutually exclusive with install/uninstall. */
  readonly status?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLIST GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the launchd plist XML for the WorkTrain daemon.
 *
 * WHY RunAtLoad + KeepAlive: RunAtLoad starts the daemon immediately when
 * launchctl loads the plist. KeepAlive restarts it automatically if it exits
 * unexpectedly, providing crash recovery without manual intervention.
 *
 * WHY stdout/stderr to ~/.workrail/logs: the daemon writes structured log lines
 * to its stdout/stderr. Redirecting through launchd means logs persist across
 * restarts and are always available without running a separate log forwarder.
 */
function buildPlist(
  nodeBinPath: string,
  worktrainBinPath: string,
  envVars: Record<string, string>,
  logDir: string,
): string {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');

  const stdoutLog = `${logDir}/daemon.stdout.log`;
  const stderrLog = `${logDir}/daemon.stderr.log`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBinPath)}</string>
    <string>${escapeXml(worktrainBinPath)}</string>
    <string>daemon</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>

  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <!--
    ThrottleInterval: minimum seconds between launchd restarts.
    WHY 30s: prevents launchd from spinning in a tight restart loop if the daemon
    exits immediately (e.g., missing credentials or invalid workspace path).
    Without this, a misconfigured service consumes CPU and spams logs.
  -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

/** Escape the five XML special characters. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect the env vars to embed in the plist from the current process env.
 *
 * WHY we always include WORKRAIL_TRIGGERS_ENABLED=true: the daemon refuses to
 * start without this flag. If the user has it set in their shell env, we capture
 * the actual value. If not, we inject it so the service starts correctly.
 */
function captureEnvVars(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const captured: Record<string, string> = {};

  for (const key of CAPTURED_ENV_VARS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      captured[key] = value;
    }
  }

  // Always ensure the daemon can start -- inject the trigger flag if missing.
  if (!captured['WORKRAIL_TRIGGERS_ENABLED']) {
    captured['WORKRAIL_TRIGGERS_ENABLED'] = 'true';
  }

  return captured;
}

/**
 * Parse the output of `launchctl list <label>` to determine if the service
 * is running and what its PID is.
 *
 * launchctl list returns JSON on success, or an error message on failure.
 * When the service is loaded but not running the JSON has no "PID" key.
 * When it is running, "PID" is a number.
 */
function parseLaunchctlList(
  stdout: string,
  exitCode: number,
): { readonly running: boolean; readonly pid: number | null; readonly loaded: boolean } {
  if (exitCode !== 0) {
    return { running: false, pid: null, loaded: false };
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const pid = typeof parsed['PID'] === 'number' ? parsed['PID'] : null;
    return { running: pid !== null, pid, loaded: true };
  } catch {
    return { running: false, pid: null, loaded: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTALL
// ═══════════════════════════════════════════════════════════════════════════

async function runInstall(
  deps: WorktrainDaemonCommandDeps,
): Promise<CliResult> {
  const home = deps.homedir();
  const plistDir = deps.joinPath(home, 'Library', 'LaunchAgents');
  const plistPath = deps.joinPath(plistDir, PLIST_FILENAME);
  const logDir = deps.joinPath(home, '.workrail', 'logs');

  // Validate that at least one LLM credential is available.
  const env = deps.env;
  const hasBedrock = !!(env['AWS_PROFILE'] || env['AWS_ACCESS_KEY_ID']);
  const hasAnthropic = !!env['ANTHROPIC_API_KEY'];
  if (!hasBedrock && !hasAnthropic) {
    return failure(
      'No LLM credentials found in the current environment. ' +
      'Set AWS_PROFILE (for Bedrock) or ANTHROPIC_API_KEY (for Anthropic) ' +
      'before running --install so the daemon can authenticate.',
      {
        suggestions: [
          'export AWS_PROFILE=your-sso-profile',
          'export ANTHROPIC_API_KEY=sk-ant-...',
        ],
      },
    );
  }

  deps.print('Installing WorkTrain daemon as a launchd service...');

  // Step 1: Create required directories.
  await deps.mkdir(plistDir, { recursive: true });
  await deps.mkdir(logDir, { recursive: true });

  // Step 2: If already installed, unload first so the reload picks up changes.
  const alreadyInstalled = await deps.exists(plistPath);
  if (alreadyInstalled) {
    deps.print('  Existing service found -- unloading before reinstall...');
    await deps.exec('launchctl', ['unload', plistPath]);
    // Ignore unload errors: the service may already be stopped.
  }

  // Step 3: Build and write plist.
  const capturedEnv = captureEnvVars(env);
  const plist = buildPlist(deps.nodeBinPath, deps.worktrainBinPath, capturedEnv, logDir);
  await deps.writeFile(plistPath, plist);
  deps.print(`  Plist written: ${plistPath}`);

  // Step 4: Load the service.
  const loadResult = await deps.exec('launchctl', ['load', plistPath]);
  if (loadResult.exitCode !== 0) {
    return failure(
      `launchctl load failed (exit ${loadResult.exitCode}): ${loadResult.stderr.trim() || loadResult.stdout.trim()}`,
      {
        suggestions: [
          `Check the plist manually: plutil -lint ${plistPath}`,
          `View daemon logs: tail -f ${logDir}/daemon.stderr.log`,
        ],
      },
    );
  }

  // Step 5: Wait briefly for launchd to start the process, then verify.
  await deps.sleep(1500);
  const listResult = await deps.exec('launchctl', ['list', LAUNCHD_LABEL]);
  const status = parseLaunchctlList(listResult.stdout, listResult.exitCode);

  if (!status.loaded) {
    return failure(
      `Service loaded but launchctl cannot find it. This may be a transient issue.`,
      {
        suggestions: [
          `Check: launchctl list ${LAUNCHD_LABEL}`,
          `View daemon logs: tail -f ${logDir}/daemon.stderr.log`,
        ],
      },
    );
  }

  deps.print('');
  if (status.running) {
    deps.print(`WorkTrain daemon installed and running (PID ${status.pid}).`);
  } else {
    deps.print(`WorkTrain daemon installed. Service loaded but not yet running.`);
    deps.print(`This may be normal if WORKRAIL_TRIGGERS_ENABLED was not set.`);
  }
  deps.print(`Logs: ${logDir}/daemon.stdout.log`);
  deps.print(`      ${logDir}/daemon.stderr.log`);

  return success({
    message: status.running
      ? `WorkTrain daemon installed and running (PID ${status.pid})`
      : 'WorkTrain daemon installed (service loaded, not yet running)',
    details: [
      `Plist: ${plistPath}`,
      `Logs:  ${logDir}/daemon.stdout.log`,
      `       ${logDir}/daemon.stderr.log`,
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UNINSTALL
// ═══════════════════════════════════════════════════════════════════════════

async function runUninstall(
  deps: WorktrainDaemonCommandDeps,
): Promise<CliResult> {
  const home = deps.homedir();
  const plistPath = deps.joinPath(home, 'Library', 'LaunchAgents', PLIST_FILENAME);

  const exists = await deps.exists(plistPath);
  if (!exists) {
    return failure(
      'WorkTrain daemon is not installed (plist not found).',
      { suggestions: [`Expected: ${plistPath}`] },
    );
  }

  deps.print('Uninstalling WorkTrain daemon...');

  // Unload first (stops the running process and removes from launchd).
  const unloadResult = await deps.exec('launchctl', ['unload', plistPath]);
  if (unloadResult.exitCode !== 0) {
    // Not fatal: the service may have already been stopped. Log and continue.
    deps.print(`  Warning: launchctl unload returned non-zero: ${unloadResult.stderr.trim()}`);
  } else {
    deps.print('  Service unloaded.');
  }

  // Remove the plist file.
  await deps.removeFile(plistPath);
  deps.print(`  Plist removed: ${plistPath}`);

  return success({ message: 'WorkTrain daemon uninstalled successfully.' });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════

async function runStatus(
  deps: WorktrainDaemonCommandDeps,
): Promise<CliResult> {
  const home = deps.homedir();
  const plistPath = deps.joinPath(home, 'Library', 'LaunchAgents', PLIST_FILENAME);
  const logDir = deps.joinPath(home, '.workrail', 'logs');

  const plistExists = await deps.exists(plistPath);
  const listResult = await deps.exec('launchctl', ['list', LAUNCHD_LABEL]);
  const status = parseLaunchctlList(listResult.stdout, listResult.exitCode);

  deps.print('');
  deps.print('WorkTrain daemon status:');
  deps.print(`  Plist installed : ${plistExists ? `yes (${plistPath})` : 'no'}`);
  deps.print(`  Service loaded  : ${status.loaded ? 'yes' : 'no'}`);
  deps.print(`  Running         : ${status.running ? `yes (PID ${status.pid})` : 'no'}`);

  if (plistExists || status.loaded) {
    deps.print(`  Logs (stdout)   : ${logDir}/daemon.stdout.log`);
    deps.print(`  Logs (stderr)   : ${logDir}/daemon.stderr.log`);
  }

  if (!plistExists && !status.loaded) {
    deps.print('');
    deps.print('Daemon is not installed. Run: worktrain daemon --install');
  } else if (plistExists && !status.running) {
    deps.print('');
    deps.print(`Daemon installed but not running. Check logs: tail -f ${logDir}/daemon.stderr.log`);
  }

  deps.print('');

  return success({
    message: status.running
      ? `WorkTrain daemon is running (PID ${status.pid})`
      : plistExists
        ? 'WorkTrain daemon is installed but not running'
        : 'WorkTrain daemon is not installed',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMMAND
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the `worktrain daemon` command.
 *
 * Exactly one of --install, --uninstall, or --status must be provided.
 * On non-macOS platforms, returns a clear error (launchd is macOS-only).
 */
export async function executeWorktrainDaemonCommand(
  deps: WorktrainDaemonCommandDeps,
  opts: WorktrainDaemonCommandOpts,
): Promise<CliResult> {
  // Platform guard: launchd is macOS-only.
  if (deps.platform !== 'darwin') {
    return failure(
      `worktrain daemon --install requires macOS (launchd). ` +
      `Current platform: ${deps.platform}.`,
      {
        suggestions: [
          'On Linux, use systemd: create a user service with systemctl --user.',
          'See docs/daemon-service.md for platform-specific instructions.',
        ],
      },
    );
  }

  const flagCount = [opts.install, opts.uninstall, opts.status].filter(Boolean).length;
  if (flagCount === 0) {
    return misuse(
      'Specify one of: --install, --uninstall, or --status',
      [
        'worktrain daemon --install    Install and start as a launchd service',
        'worktrain daemon --uninstall  Stop and remove the launchd service',
        'worktrain daemon --status     Show service status',
      ],
    );
  }
  if (flagCount > 1) {
    return misuse('--install, --uninstall, and --status are mutually exclusive. Specify only one.');
  }

  if (opts.install) return runInstall(deps);
  if (opts.uninstall) return runUninstall(deps);
  // opts.status must be true at this point.
  return runStatus(deps);
}
