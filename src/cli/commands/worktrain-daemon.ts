/**
 * WorkTrain Daemon Command
 *
 * Manages the WorkRail daemon as a macOS launchd service so it runs outside
 * Claude Code's process tree and survives MCP server reconnects.
 *
 * Invocation modes:
 *   worktrain daemon             Start the trigger listener (launchd entry point)
 *   worktrain daemon --install   Create plist + load service + verify running
 *   worktrain daemon --uninstall Unload service + remove plist
 *   worktrain daemon --status    Check whether the launchd service is running
 *
 * WHY launchd: When the daemon runs as a child of the MCP server process, any
 * Claude Code reconnect spawns a new MCP server and displaces the running daemon.
 * A launchd service runs as a sibling process of all Claude Code sessions, not
 * as a child of any of them. It also restarts automatically after crashes.
 *
 * WHY bare invocation starts the daemon: the plist ProgramArguments is
 * [node, worktrainBinPath, 'daemon'] with no extra flags. launchd calls
 * `worktrain daemon` directly, so the no-flags path must be the actual
 * daemon startup -- not a usage error. Without this, KeepAlive causes a
 * crash loop (launchd restarts every 10 s after the non-zero exit).
 *
 * Design invariants:
 * - All I/O is injected via WorktrainDaemonCommandDeps. No direct fs/child_process.
 * - Errors are returned as CliResult failure variants -- never thrown.
 * - The plist is only written when --install is requested (not on every run).
 * - Only recognized env vars are captured -- avoids leaking unrelated secrets.
 * - Idempotent: --install on an already-installed service unloads and reloads.
 * - macOS only: --install/--uninstall/--status return an explicit error on non-darwin.
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
 * Non-secret env vars captured from the current process into the plist.
 *
 * WHY a fixed allowlist: we do not snapshot all of process.env -- that would
 * bake unrelated secrets into a file that persists on disk indefinitely.
 *
 * WHY secrets are excluded: API keys and tokens must NOT be baked into the
 * plist. The plist is stored at ~/Library/LaunchAgents/ (mode 600) but
 * persists across machine backups, Time Machine, etc. Instead, put secrets in
 * ~/.workrail/.env -- the daemon loads that file at startup via loadDaemonEnv().
 *
 * Secrets to put in ~/.workrail/.env (NOT in the plist):
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   GITHUB_TOKEN=ghp_...
 *   GITLAB_TOKEN=glpat-...
 *   AWS_ACCESS_KEY_ID=...
 *   AWS_SECRET_ACCESS_KEY=...
 *   AWS_SESSION_TOKEN=...
 *   WORKTRAIN_BOT_TOKEN=...
 */
const CAPTURED_ENV_VARS = [
  // AWS profile name only (not the actual credentials -- those go in ~/.workrail/.env)
  'AWS_PROFILE',

  // Daemon feature flags
  'WORKRAIL_TRIGGERS_ENABLED',

  // Workspace default (also readable from config.json, but plist wins for
  // daemons that start before any user shell is active)
  'WORKRAIL_DEFAULT_WORKSPACE',

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
  /** Set file permissions (octal mode). */
  readonly chmod: (path: string, mode: number) => Promise<void>;
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
  /**
   * Start the trigger listener daemon process. Called when `worktrain daemon`
   * is invoked with no flags -- the launchd entry point.
   *
   * WHY a callback here: the startup logic requires the DI container and
   * several heavy imports (trigger-listener, daemon-console, etc.). Injecting
   * it as a callback keeps this module free of those dependencies and lets
   * tests stub out the entire startup with a simple function.
   *
   * If absent, the no-flags path falls back to a usage error (useful in
   * contexts where daemon start is not supported).
   */
  readonly startDaemon?: () => Promise<void>;
}

export interface WorktrainDaemonCommandOpts {
  /** Create and load the launchd service. Mutually exclusive with other flags. */
  readonly install?: boolean;
  /** Unload and remove the launchd service. Mutually exclusive with other flags. */
  readonly uninstall?: boolean;
  /** Report the current service status. Mutually exclusive with other flags. */
  readonly status?: boolean;
  /**
   * Start the daemon via launchctl (service must be installed first).
   * Does NOT auto-start on login -- operator must explicitly call this.
   */
  readonly start?: boolean;
  /** Stop the running daemon via launchctl. Does not uninstall the service. */
  readonly stop?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLIST GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the launchd plist XML for the WorkTrain daemon.
 *
 * WHY no RunAtLoad or KeepAlive: the daemon must be started explicitly by the
 * operator (`worktrain daemon --start`). Auto-starting at login and auto-restarting
 * on crash means WorkTrain autonomously works in your repos without any deliberate
 * operator action -- which is unsafe, especially when the daemon has bugs or the
 * operator hasn't reviewed what triggers are configured. The operator decides when
 * WorkTrain runs; launchd just provides the process management scaffolding.
 *
 * To start the daemon: `worktrain daemon --start`
 * To stop the daemon:  `worktrain daemon --stop`
 *
 * WHY WorkingDirectory is set to homedir: without it launchd sets cwd to '/'.
 * The daemon falls back to process.cwd() when WORKRAIL_DEFAULT_WORKSPACE is
 * unset, so it would silently treat '/' as the workspace. The user's home
 * directory is a safe default; they can override via WORKRAIL_DEFAULT_WORKSPACE.
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
  homeDir: string,
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

  <key>WorkingDirectory</key>
  <string>${escapeXml(homeDir)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>

  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>

  <!--
    No RunAtLoad or KeepAlive: the daemon must be started explicitly with
    'worktrain daemon --start'. Auto-starting at login and auto-restarting
    on crash is unsafe -- WorkTrain acts autonomously in your repos and the
    operator must decide when it runs.

    To start:  worktrain daemon --start
    To stop:   worktrain daemon --stop
    To status: worktrain daemon --status
  -->
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
 * WHY we always ensure WORKRAIL_TRIGGERS_ENABLED=true: the daemon refuses to
 * start without this flag. If the user has it set in their shell env, we capture
 * the actual value. If not, we inject it so the service starts correctly.
 *
 * WHY we warn on override: if the user has explicitly set WORKRAIL_TRIGGERS_ENABLED
 * to something other than 'true', forcing it to 'true' in the plist may be
 * surprising. We warn so they know the override happened.
 */
function captureEnvVars(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): Record<string, string> {
  const captured: Record<string, string> = {};

  for (const key of CAPTURED_ENV_VARS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      captured[key] = value;
    }
  }

  // Always ensure the daemon can start -- inject the trigger flag if missing.
  const existing = captured['WORKRAIL_TRIGGERS_ENABLED'];
  if (!existing) {
    captured['WORKRAIL_TRIGGERS_ENABLED'] = 'true';
  } else if (existing !== 'true') {
    // The user explicitly set this to something other than 'true'. Override
    // it so the plist-launched daemon can start, but warn so they notice.
    warn(
      `[worktrain daemon --install] WORKRAIL_TRIGGERS_ENABLED is set to '${existing}' in your environment. ` +
      `The plist will override this with 'true' so the daemon can start. ` +
      `Remove WORKRAIL_TRIGGERS_ENABLED from your shell environment if you do not want this warning.`,
    );
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

  const env = deps.env;
  deps.print('Registering WorkTrain daemon with launchd...');

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
  const capturedEnv = captureEnvVars(env, (msg) => console.warn(msg));
  const plist = buildPlist(deps.nodeBinPath, deps.worktrainBinPath, capturedEnv, logDir, home);
  await deps.writeFile(plistPath, plist);

  // F4: Restrict plist to owner-only (0o600) -- it may contain API keys.
  await deps.chmod(plistPath, 0o600);
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
  deps.print('WorkTrain daemon registered with launchd.');
  deps.print('');
  deps.print('Before starting, put your secrets in ~/.workrail/.env');
  deps.print('(see docs/configuration.md for the full list):');
  deps.print('');
  deps.print('  ANTHROPIC_API_KEY=sk-ant-...');
  deps.print('  # or for AWS Bedrock: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
  deps.print('  GITHUB_TOKEN=ghp_...          # for GitHub polling triggers');
  deps.print('  WORKTRAIN_BOT_TOKEN=ghp_...   # for self-improvement queue');
  deps.print('');
  deps.print('Then start the daemon:');
  deps.print('');
  deps.print('  worktrain daemon --start     Start the daemon now');
  deps.print('  worktrain daemon --stop      Stop the daemon');
  deps.print('  worktrain daemon --status    Check if running');
  deps.print('  worktrain daemon --uninstall Remove the registration');
  deps.print('');
  deps.print(`Logs: ${logDir}/daemon.stdout.log`);
  deps.print(`      ${logDir}/daemon.stderr.log`);

  return success({
    message: 'WorkTrain daemon registered. Run: worktrain daemon --start',
    details: [
      `Plist: ${plistPath}`,
      `Start: worktrain daemon --start`,
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
// CREDENTIAL CHECK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse KEY=VALUE lines from a .env file string.
 * Lines starting with # and blank lines are ignored.
 * Exported for testing.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Check whether at least one LLM credential is available, combining the
 * current process env with keys parsed from ~/.workrail/.env.
 *
 * WHY warn not fail: the credential may be in ~/.aws/credentials (SSO) or
 * injected by the system in ways we can't detect at start time. A warning
 * surfaces the misconfiguration without blocking legitimate setups.
 *
 * Returns a warning message if no credential is found, or null if ok.
 */
async function checkCredentials(
  deps: WorktrainDaemonCommandDeps,
): Promise<string | null> {
  const home = deps.homedir();
  const envFilePath = deps.joinPath(home, '.workrail', '.env');

  // Merge process env + .env file
  const merged: Record<string, string | undefined> = { ...deps.env };
  try {
    const envContent = await deps.readFile(envFilePath);
    const parsed = parseDotEnv(envContent);
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in merged)) merged[k] = v; // .env does not override process env
    }
  } catch {
    // .env is optional -- missing is fine
  }

  const hasAnthropic = !!(merged['ANTHROPIC_API_KEY']);
  const hasBedrock = !!(merged['AWS_PROFILE'] || merged['AWS_ACCESS_KEY_ID']);

  if (!hasAnthropic && !hasBedrock) {
    return (
      'No LLM credentials found in process env or ~/.workrail/.env.\n' +
      'The daemon will fail when it tries to call the LLM.\n' +
      'Add one of the following to ~/.workrail/.env:\n' +
      '  ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  AWS_PROFILE=your-sso-profile'
    );
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// START / STOP
// ═══════════════════════════════════════════════════════════════════════════

async function runStart(deps: WorktrainDaemonCommandDeps): Promise<CliResult> {
  const home = deps.homedir();
  const plistPath = deps.joinPath(home, 'Library', 'LaunchAgents', PLIST_FILENAME);
  const logDir = deps.joinPath(home, '.workrail', 'logs');

  if (!(await deps.exists(plistPath))) {
    return failure(
      'WorkTrain daemon is not installed. Run: worktrain daemon --install',
      { suggestions: ['worktrain daemon --install'] },
    );
  }

  // Warn if no LLM credentials found -- sessions will fail without them.
  const credWarning = await checkCredentials(deps);
  if (credWarning) {
    deps.print('');
    deps.print('WARNING: ' + credWarning);
    deps.print('');
  }

  const result = await deps.exec('launchctl', ['start', LAUNCHD_LABEL]);
  if (result.exitCode !== 0) {
    return failure(
      `launchctl start failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      { suggestions: [`View logs: tail -f ${logDir}/daemon.stderr.log`] },
    );
  }

  // Brief wait then verify
  await deps.sleep(1000);
  const listResult = await deps.exec('launchctl', ['list', LAUNCHD_LABEL]);
  const status = parseLaunchctlList(listResult.stdout, listResult.exitCode);

  if (status.running) {
    deps.print(`WorkTrain daemon started (PID ${status.pid}).`);
    deps.print(`Logs: ${logDir}/daemon.stdout.log`);
    return success({ message: `WorkTrain daemon started (PID ${status.pid})` });
  }

  return failure(
    'launchctl start returned 0 but daemon does not appear to be running.',
    { suggestions: [`View logs: tail -f ${logDir}/daemon.stderr.log`] },
  );
}

async function runStop(deps: WorktrainDaemonCommandDeps): Promise<CliResult> {
  const result = await deps.exec('launchctl', ['stop', LAUNCHD_LABEL]);
  if (result.exitCode !== 0) {
    // launchctl stop exits non-zero if the service is already stopped -- not fatal
    const msg = result.stderr.trim() || result.stdout.trim();
    if (msg.toLowerCase().includes('not running') || msg.toLowerCase().includes('no such process')) {
      deps.print('WorkTrain daemon is not running.');
      return success({ message: 'WorkTrain daemon is not running.' });
    }
    return failure(
      `launchctl stop failed (exit ${result.exitCode}): ${msg}`,
    );
  }

  deps.print('WorkTrain daemon stopped.');
  return success({ message: 'WorkTrain daemon stopped.' });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMMAND
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the `worktrain daemon` command.
 *
 * When called with no flags, starts the trigger listener via deps.startDaemon().
 * This is the launchd entry point: the plist ProgramArguments is
 * [node, worktrainBinPath, 'daemon'] with no flags, so this path runs every
 * time launchd starts or restarts the service.
 *
 * When called with --install, --uninstall, or --status, manages the launchd
 * service. These paths require macOS (launchd is macOS-only).
 */
export async function executeWorktrainDaemonCommand(
  deps: WorktrainDaemonCommandDeps,
  opts: WorktrainDaemonCommandOpts,
): Promise<CliResult> {
  const flagCount = [opts.install, opts.uninstall, opts.status, opts.start, opts.stop].filter(Boolean).length;

  // No flags: this is the launchd entry point. Start the daemon process.
  if (flagCount === 0) {
    if (deps.startDaemon) {
      await deps.startDaemon();
      // startDaemon() keeps the process alive (event loop stays open).
      // It returns only when the daemon shuts down cleanly.
      return success({ message: 'WorkTrain daemon stopped.' });
    }
    return misuse(
      'Specify one of: --install, --uninstall, --start, --stop, or --status',
      [
        'worktrain daemon --install    Register as a launchd service (does not auto-start)',
        'worktrain daemon --start      Start the daemon',
        'worktrain daemon --stop       Stop the daemon',
        'worktrain daemon --status     Show service status',
        'worktrain daemon --uninstall  Remove the launchd service registration',
      ],
    );
  }

  if (flagCount > 1) {
    return misuse('--install, --uninstall, --start, --stop, and --status are mutually exclusive. Specify only one.');
  }

  // All management flags (install/uninstall/start/stop/status) require macOS (launchd).
  if (deps.platform !== 'darwin') {
    return failure(
      `worktrain daemon management flags require macOS (launchd). ` +
      `Current platform: ${deps.platform}.`,
      {
        suggestions: [
          'On Linux, use systemd: create a user service with systemctl --user.',
          'See docs/daemon-service.md for platform-specific instructions.',
        ],
      },
    );
  }

  if (opts.install) return runInstall(deps);
  if (opts.uninstall) return runUninstall(deps);
  if (opts.start) return runStart(deps);
  if (opts.stop) return runStop(deps);
  // opts.status must be true at this point.
  return runStatus(deps);
}
