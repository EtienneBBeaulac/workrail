#!/usr/bin/env node
/**
 * WorkTrain CLI - Composition Root
 *
 * Entry point for the `worktrain` binary. Thin composition root:
 * 1. Wires dependencies for each command
 * 2. Interprets CliResult into process termination
 * 3. Contains NO business logic
 *
 * All business logic lives in src/cli/commands/worktrain-*.ts
 *
 * Process lifecycle note:
 * readline.createInterface() keeps the Node.js event loop alive until rl.close()
 * is called. The try/finally block below guarantees closure even on errors, so
 * the process exits cleanly after the command completes.
 */

import { Command, Option } from 'commander';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output, env } from 'process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

import { interpretCliResultWithoutDI } from './cli/interpret-result.js';
import { loadDaemonEnv } from './daemon/daemon-env.js';
import { createContextAssembler } from './context-assembly/index.js';
import { createListRecentSessions } from './context-assembly/infra.js';
import {
  executeWorktrainInitCommand,
  executeWorktrainTellCommand,
  executeWorktrainInboxCommand,
  executeWorktrainSpawnCommand,
  executeWorktrainAwaitCommand,
  executeWorktrainDaemonCommand,
  executeWorktrainOverviewCommand,
  executeWorktrainTriggerTestCommand,
  executeWorktrainTriggerValidateCommand,
  buildConsoleServiceFromDataDir,
  type Priority,
} from './cli/commands/index.js';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name('worktrain')
  .description('WorkTrain daemon management')
  .version('0.0.3');

// ═══════════════════════════════════════════════════════════════════════════
// INIT COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('init')
  .description('Guided setup for WorkTrain daemon: credentials, workspace, triggers.yml, daemon-soul.md, smoke test')
  .option('-y, --yes', 'Skip interactive prompts and use safe defaults (for CI / non-TTY use)')
  .action(async (options: { yes?: boolean }) => {
    // Warn when running non-interactively without --yes
    if (!options.yes && !input.isTTY) {
      console.warn(
        'Warning: stdin is not a TTY. Interactive prompts may not work as expected.\n' +
        'Run with --yes to use safe defaults without prompting.',
      );
    }

    const rl = createInterface({ input, output, terminal: true });

    try {
      const result = await executeWorktrainInitCommand(
        {
          prompt: async (question: string, defaultValue?: string): Promise<string> => {
            if (options.yes) {
              return defaultValue ?? '';
            }
            const answer = await rl.question(question);
            return answer.trim() || (defaultValue ?? '');
          },
          mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
          readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
          writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
          exists: async (p: string) => {
            try {
              await fs.promises.access(p);
              return true;
            } catch {
              return false;
            }
          },
          homedir: os.homedir,
          cwd: process.cwd,
          joinPath: path.join,
          runSmoke: async () => {
            try {
              const { stdout } = await execFileAsync('workrail', ['list'], {
                timeout: 10_000,
              });
              return { ok: true, output: stdout.trim() };
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : String(err);
              return { ok: false, output: message };
            }
          },
          print: (line: string) => console.log(line),
          env,
        },
        { yes: options.yes },
      );

      interpretCliResultWithoutDI(result);
    } finally {
      rl.close();
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// TELL COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('tell <message>')
  .description('Queue an async message for the WorkTrain daemon (~/.workrail/message-queue.jsonl)')
  .option('-w, --workspace <name>', 'Workspace hint for the daemon (optional)')
  .addOption(
    new Option('-p, --priority <level>', 'Message priority: high, normal, or low')
      .choices(['high', 'normal', 'low'])
      .default('normal'),
  )
  .action(async (message: string, options: { workspace?: string; priority?: string }) => {
    const result = await executeWorktrainTellCommand(
      message,
      {
        appendFile: (p: string, content: string) =>
          fs.promises.appendFile(p, content, 'utf-8'),
        mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
        homedir: os.homedir,
        joinPath: path.join,
        print: (line: string) => console.log(line),
        now: () => new Date().toISOString(),
        generateId: () => randomUUID(),
      },
      {
        workspace: options.workspace,
        priority: (options.priority ?? 'normal') as Priority,
      },
    );
    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// INBOX COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('inbox')
  .description('Read unread messages from the WorkTrain daemon (~/.workrail/outbox.jsonl)')
  .option('-w, --watch', 'Watch for new messages in real time (not yet implemented)')
  .action(async (options: { watch?: boolean }) => {
    const result = await executeWorktrainInboxCommand(
      {
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
        mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
        homedir: os.homedir,
        joinPath: path.join,
        print: (line: string) => console.log(line),
      },
      { watch: options.watch },
    );
    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// SPAWN COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('spawn')
  .description('Start a workflow session non-interactively. Prints session handle to stdout.')
  .requiredOption('-w, --workflow <id>', 'Workflow ID to run')
  .requiredOption('-g, --goal <text>', 'One-sentence goal for the workflow session')
  .requiredOption('-W, --workspace <path>', 'Absolute path to the workspace directory')
  .option('-p, --port <n>', 'Console HTTP server port (default: auto-discover from lock file, then 3456)', parseInt)
  .action(async (options: { workflow: string; goal: string; workspace: string; port?: number }) => {
    const result = await executeWorktrainSpawnCommand(
      {
        fetch: (url, opts) => globalThis.fetch(url, opts),
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        stdout: (line: string) => process.stdout.write(line + '\n'),
        stderr: (line: string) => process.stderr.write(line + '\n'),
        homedir: os.homedir,
        joinPath: path.join,
        pathIsAbsolute: path.isAbsolute,
        statPath: (p: string) => fs.promises.stat(p),
      },
      {
        workflow: options.workflow,
        goal: options.goal,
        workspace: options.workspace,
        port: options.port,
      },
    );

    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// AWAIT COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('await')
  .description('Block until workflow sessions complete. Prints JSON results to stdout.')
  .requiredOption('-s, --sessions <handles>', 'Comma-separated list of session handles to wait for')
  .option('-m, --mode <mode>', "Wait mode: 'all' (default) or 'any'", 'all')
  .option('-t, --timeout <duration>', 'Timeout (e.g. "30m", "1h", "90s"). Default: 30m', '30m')
  .option('-p, --port <n>', 'Console HTTP server port (default: auto-discover from lock file, then 3456)', parseInt)
  .action(async (options: { sessions: string; mode?: string; timeout?: string; port?: number }) => {
    const mode = options.mode === 'any' ? 'any' : 'all';

    const result = await executeWorktrainAwaitCommand(
      {
        fetch: (url: string) => globalThis.fetch(url),
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        stdout: (line: string) => process.stdout.write(line + '\n'),
        stderr: (line: string) => process.stderr.write(line + '\n'),
        homedir: os.homedir,
        joinPath: path.join,
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      },
      {
        sessions: options.sessions,
        mode,
        timeout: options.timeout,
        port: options.port,
      },
    );

    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// CONSOLE COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('console')
  .description('Start the WorkRail console UI (reads session files directly, no daemon required)')
  .option('-p, --port <n>', 'Port to bind the console server (default: 3456)', parseInt)
  .option('-w, --workspace <path>', 'Workspace path (reserved for future scoped view)')
  .action(async (options: { port?: number; workspace?: string }) => {
    const { startStandaloneConsole } = await import('./console/standalone-console.js');

    const result = await startStandaloneConsole({
      port: options.port,
    });

    if (result.kind === 'port_conflict') {
      process.stderr.write(
        `[Console] Port ${result.port} is already in use. ` +
        `Use --port to choose a different port, or stop the process holding port ${result.port}.\n`,
      );
      process.exit(1);
    }

    if (result.kind === 'io_error') {
      process.stderr.write(`[Console] Failed to start: ${result.message}\n`);
      process.exit(1);
    }

    // Print the banner after the server is confirmed listening.
    const line = '='.repeat(60);
    process.stdout.write(`\n${line}\n`);
    process.stdout.write(`WorkRail Console\n`);
    process.stdout.write(`${line}\n`);
    process.stdout.write(`Console:  http://localhost:${result.port}/console\n`);
    process.stdout.write(`Sessions: ${path.join(os.homedir(), '.workrail', 'data', 'sessions')}\n`);
    process.stdout.write(`${line}\n\n`);
    process.stdout.write(`Press Ctrl+C to stop.\n`);

    // Keep the process alive until SIGINT or SIGTERM.
    const shutdown = async () => {
      process.stdout.write('\n[Console] Shutting down...\n');
      await result.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  });

// ═══════════════════════════════════════════════════════════════════════════
// DAEMON COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('daemon')
  .description('Start the WorkTrain daemon, or manage it as a macOS launchd service')
  .option('--install', 'Create the launchd plist and start the daemon service')
  .option('--uninstall', 'Stop the daemon service and remove the launchd plist')
  .option('--status', 'Show the current status of the daemon service')
  .action(async (options: { install?: boolean; uninstall?: boolean; status?: boolean }) => {
    // Load ~/.workrail/.env before anything else so secrets are available both
    // for daemon startup (startDaemon path) and for plist construction (--install path).
    await loadDaemonEnv();

    const { execFile: execFileRaw } = await import('child_process');
    const execFilePromise = promisify(execFileRaw);

    const result = await executeWorktrainDaemonCommand(
      {
        env,
        platform: process.platform,
        // Use the resolved path of the current worktrain binary so the plist
        // always points to the installed binary, not a symlink or npx wrapper.
        worktrainBinPath: process.argv[1],
        nodeBinPath: process.execPath,
        homedir: os.homedir,
        joinPath: path.join,
        mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
        writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
        chmod: (p: string, mode: number) => fs.promises.chmod(p, mode),
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        removeFile: (p: string) => fs.promises.unlink(p),
        exists: async (p: string) => {
          try {
            await fs.promises.access(p);
            return true;
          } catch {
            return false;
          }
        },
        exec: async (command: string, args: string[]) => {
          try {
            const { stdout, stderr } = await execFilePromise(command, args, { encoding: 'utf-8' });
            return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
          } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; code?: number };
            return {
              stdout: e.stdout ?? '',
              stderr: e.stderr ?? '',
              exitCode: typeof e.code === 'number' ? e.code : 1,
            };
          }
        },
        print: (line: string) => console.log(line),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        startDaemon: async () => {
          // Load .env again as defense-in-depth: this callback may be invoked
          // from paths other than the daemon action handler in the future.
          await loadDaemonEnv();

          // This is the launchd entry point: `worktrain daemon` with no flags.
          // Run the same startup logic as `workrail daemon`.
          const { startTriggerListener } = await import('./trigger/trigger-listener.js');
          const { DaemonEventEmitter } = await import('./daemon/daemon-events.js');
          const { initializeContainer } = await import('./di/container.js');

          await initializeContainer({ runtimeMode: { kind: 'cli' } });
          const { createToolContext } = await import('./mcp/server.js');
          const { requireV2Context } = await import('./mcp/types.js');
          const rawCtx = await createToolContext();
          const v2Guard = requireV2Context(rawCtx);
          if (!v2Guard.ok) {
            console.error('v2 engine not available -- ensure WorkRail is fully initialized');
            process.exit(1);
          }
          const ctx = v2Guard.ctx;

          const { loadWorkrailConfigFile } = await import('./config/config-file.js');

          // Resolve workspace: WORKRAIL_DEFAULT_WORKSPACE in config > cwd (home
          // dir when launched by launchd, since WorkingDirectory is set to homedir).
          const configResult = loadWorkrailConfigFile();
          const configWorkspace =
            configResult.kind === 'ok' ? configResult.value['WORKRAIL_DEFAULT_WORKSPACE'] : undefined;
          const workspacePath = configWorkspace?.trim() || process.cwd();

          const usesBedrock = !!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID'];
          const apiKey = process.env['ANTHROPIC_API_KEY'];
          if (!usesBedrock && !apiKey) {
            console.error('No LLM credentials found. Set AWS_PROFILE (Bedrock) or ANTHROPIC_API_KEY.');
            process.exit(1);
          }

          const emitter = new DaemonEventEmitter();

          const handle = await startTriggerListener(ctx, {
            workspacePath,
            apiKey: apiKey,
            env: process.env,
            emitter,
          });

          if (handle === null) {
            console.error('Daemon is disabled. Set WORKRAIL_TRIGGERS_ENABLED=true to enable.');
            process.exit(1);
          }
          if ('_kind' in handle) {
            console.error('Failed to start daemon:', handle.error);
            process.exit(1);
          }

          console.log(`WorkRail daemon running on port ${handle.port}`);
          console.log(`Workspace: ${workspacePath}`);
          console.log('Waiting for webhook triggers...');
          console.log("[Daemon] Run 'worktrain console' to start the dashboard");

          // Keep alive until SIGINT/SIGTERM.
          await new Promise<void>((resolve) => {
            // Start periodic heartbeat. Emits daemon_heartbeat every 30s so
            // `worktrain status` can determine whether the daemon is alive.
            // WHY 30s: frequent enough to detect a crash within 90s (3x interval),
            // cheap enough to not impact I/O (fire-and-forget JSONL append).
            const heartbeatInterval = setInterval(() => {
              const sessionsDir = path.join(os.homedir(), '.workrail', 'daemon-sessions');
              // Count active sessions from the daemon-sessions dir. Best-effort:
              // if the dir is unavailable, activeSessions defaults to 0.
              fs.promises.readdir(sessionsDir)
                .then((files) => files.filter((f) => f.endsWith('.json')).length)
                .catch(() => 0)
                .then((activeSessions) => {
                  emitter.emit({ kind: 'daemon_heartbeat', activeSessions, ts: Date.now() });
                });
            }, 30_000);

            // Best-effort crash event. Emitted when an uncaught exception reaches
            // the process boundary. fire-and-forget -- the async write may not
            // complete before process.exit(1), but this is explicitly acceptable:
            // observability must never delay crash recovery.
            // WHY process.on (not process.once): want to catch any uncaught exception,
            // not only the first one. process.exit(1) after the emit prevents loops.
            // WHY not re-throw: re-throwing after this handler fires will crash without
            // the emit having a chance to initiate. Direct exit is more predictable.
            process.on('uncaughtException', (err) => {
              console.error('[WorkTrain] Uncaught exception -- daemon shutting down:', err);
              emitter.emit({ kind: 'daemon_stopped', reason: 'crash', ts: Date.now() });
              process.exit(1);
            });

            const shutdown = async () => {
              console.log('\nShutting down daemon...');
              // Clear heartbeat before stopping -- prevents timer from firing after
              // the process is in teardown state.
              clearInterval(heartbeatInterval);
              // WHY emit session_aborted before handle.stop(): in-flight sessions have
              // their agent loops killed by handle.stop() but never emit session_completed.
              // Without these events the JSONL log shows them as RUNNING forever, making
              // `worktrain health` and `worktrain status` untrustworthy after restart.
              // steerRegistry keys are workrailSessionIds of sessions currently in the
              // agent loop. Emit before handle.stop() while I/O is still active.
              for (const workrailSessionId of handle.steerRegistry.keys()) {
                emitter.emit({
                  kind: 'session_aborted',
                  sessionId: workrailSessionId,
                  workrailSessionId,
                  reason: 'daemon_shutdown',
                  ts: Date.now(),
                });
              }
              emitter.emit({ kind: 'daemon_stopped', reason: 'graceful', ts: Date.now() });
              await handle.stop();
              resolve();
            };
            process.once('SIGINT', () => void shutdown());
            process.once('SIGTERM', () => void shutdown());
          });
        },
      },
      {
        install: options.install,
        uninstall: options.uninstall,
        status: options.status,
      },
    );

    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// LOGS COMMAND
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a single DaemonEvent JSONL line for human-readable output.
 *
 * WHY inline: the logs command is the only consumer of this formatting.
 * Keeping it here avoids creating a module for a single 30-line function.
 */
function formatDaemonEventLine(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // Skip malformed lines silently.
  }

  const ts = typeof obj['ts'] === 'number'
    ? new Date(obj['ts']).toISOString().replace('T', ' ').slice(0, 23)
    : '?';
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : 'unknown';
  const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'].slice(0, 8) : null;
  const prefix = sessionId ? `[${ts}] [${sessionId}] ${kind}` : `[${ts}] ${kind}`;

  switch (kind) {
    case 'agent_stuck':
      // WHY prominent label: stuck sessions need to be immediately visible in the log.
      // The STUCK prefix and reason/detail make it scannable at a glance.
      return `${prefix}  *** STUCK: ${obj['reason'] ?? '?'} -- ${String(obj['detail'] ?? '').slice(0, 100)}`;
    case 'llm_turn_started':
      return `${prefix}  msgs=${obj['messageCount'] ?? '?'}`;
    case 'llm_turn_completed':
      return `${prefix}  stop=${obj['stopReason'] ?? '?'} in=${obj['inputTokens'] ?? '?'} out=${obj['outputTokens'] ?? '?'} tools=[${Array.isArray(obj['toolNamesRequested']) ? (obj['toolNamesRequested'] as string[]).join(',') : ''}]`;
    case 'tool_call_started':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} args=${String(obj['argsSummary'] ?? '').slice(0, 80)}`;
    case 'tool_call_completed':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['durationMs'] ?? '?'}ms result=${String(obj['resultSummary'] ?? '').slice(0, 60)}`;
    case 'tool_call_failed':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['durationMs'] ?? '?'}ms err=${String(obj['errorMessage'] ?? '').slice(0, 80)}`;
    case 'tool_called':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['summary'] ? String(obj['summary']).slice(0, 80) : ''}`;
    case 'tool_error':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} err=${String(obj['error'] ?? '').slice(0, 80)}`;
    case 'session_started':
      return `${prefix}  workflow=${obj['workflowId'] ?? '?'} workspace=${obj['workspacePath'] ?? '?'}`;
    case 'session_completed': {
      // WHY distinct labels per outcome: success/error/timeout are actionable states.
      // A human scanning logs can see at a glance what happened.
      const outcome = obj['outcome'];
      const detail = obj['detail'] ? ` (${obj['detail']})` : '';
      if (outcome === 'success') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session complete${detail}`;
      } else if (outcome === 'error') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session FAILED${detail}`;
      } else if (outcome === 'timeout') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session TIMEOUT${detail}`;
      }
      return `${prefix}  workflow=${obj['workflowId'] ?? '?'} outcome=${outcome ?? '?'}${detail}`;
    }
    case 'session_aborted':
      return `${prefix}  reason=${obj['reason'] ?? '?'}`;
    case 'step_advanced':
      return `${prefix}  -> step advanced`;
    case 'issue_reported': {
      // WHY severity-differentiated labels: fatal and error issues need to stand out.
      const severity = obj['severity'];
      const summary = String(obj['summary'] ?? '').slice(0, 100);
      if (severity === 'fatal') {
        return `${prefix}  FATAL: ${summary}`;
      } else if (severity === 'error') {
        return `${prefix}  ERROR: ${summary}`;
      }
      return `${prefix}  severity=${severity ?? '?'} ${summary}`;
    }
    default:
      return `${prefix}  ${JSON.stringify(obj).slice(0, 120)}`;
  }
}

/**
 * Normalize a ts field to Unix ms for sorting.
 *
 * WHY needed: daemon events use ts as a Unix ms number; queue poll events use ts as an
 * ISO 8601 string (from new Date().toISOString()). One-shot mode needs a unified
 * comparator. Check number first (daemon) because typeof === 'number' is O(1) and
 * the majority of lines in a busy log are daemon events.
 */
function tsToMs(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (!isNaN(parsed)) return parsed;
  }
  return 0; // Fallback: sort unknowns to the beginning.
}

/**
 * Format a single queue-poll JSONL line for human-readable output.
 *
 * WHY inline: the logs command is the only consumer.
 * Queue poll events use `event` (not `kind`) and an ISO 8601 `ts`.
 * Supported events: task_selected, task_skipped, poll_cycle_complete.
 */
function formatQueuePollLine(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // Skip malformed lines silently.
  }

  const tsRaw = obj['ts'];
  // WHY slice(11, 19): ISO 8601 is "YYYY-MM-DDTHH:MM:SSZ"; characters 11-19 are HH:MM:SS.
  const time = typeof tsRaw === 'string' && tsRaw.length >= 19
    ? tsRaw.slice(11, 19)
    : '?';

  const event = typeof obj['event'] === 'string' ? obj['event'] : 'unknown';

  switch (event) {
    case 'task_selected': {
      const num = obj['issueNumber'] ?? '?';
      const title = String(obj['title'] ?? '').slice(0, 80);
      const maturity = obj['maturity'] ?? '?';
      return `[${time}] queue_poll selected #${num} "${title}" maturity=${maturity}`;
    }
    case 'task_skipped': {
      const num = obj['issueNumber'] ?? '?';
      const title = String(obj['title'] ?? '').slice(0, 80);
      const reason = obj['reason'] ?? '?';
      return `[${time}] queue_poll skipped #${num} "${title}" reason=${reason}`;
    }
    case 'poll_cycle_complete': {
      const selected = obj['selected'] ?? '?';
      const skipped = obj['skipped'] ?? '?';
      const elapsed = obj['elapsed'];
      const elapsedStr = typeof elapsed === 'number' ? `${elapsed}ms` : '?';
      return `[${time}] queue_poll cycle_complete selected=${selected} skipped=${skipped} elapsed=${elapsedStr}`;
    }
    default:
      return `[${time}] queue_poll ${event} ${JSON.stringify(obj).slice(0, 100)}`;
  }
}

/**
 * Decide whether a stderr line should be shown in the unified log.
 *
 * WHY two-stage filter:
 * 1. Suppress routine startup noise (prefix match) regardless of content.
 *    These lines are always safe to hide: [WorkRail] config, [DI], [FeatureFlags],
 *    [Console], [DaemonConsole].
 * 2. Show only lines that signal actionable state: error, WARN, failed, stuck, crash,
 *    adaptive-pipeline.
 */
function shouldShowStderrLine(line: string): boolean {
  // Stage 1: suppress known-noisy prefixes.
  // WHY these specific prefixes: they are routine startup/config log lines that
  // produce many lines on every daemon start with no diagnostic value in a unified log.
  const NOISE_PREFIXES = [
    '[WorkRail] config',
    '[DI]',
    '[FeatureFlags]',
    '[Console]',
    '[DaemonConsole]',
  ];
  for (const prefix of NOISE_PREFIXES) {
    if (line.includes(prefix)) return false;
  }

  // Stage 2: show only lines that signal problems or noteworthy events.
  // WHY keyword list: these are the actionable signals a developer needs to see
  // without tailing the full stderr log.
  return (
    line.includes('error') ||
    line.includes('Error') ||
    line.includes('WARN') ||
    line.includes('failed') ||
    line.includes('stuck') ||
    line.includes('crash') ||
    line.includes('adaptive-pipeline')
  );
}

program
  .command('logs')
  .description('Read and display the WorkRail daemon event log. Use --follow to stream new events in real time.')
  .option('--follow', 'Continuously poll the log file for new events (like tail -f)')
  .option('--session <id>', 'Filter events by sessionId (UUID prefix) or workrailSessionId (sess_xxx prefix)')
  .action(async (options: { follow?: boolean; session?: string }) => {
    const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');

    // WHY constants: queue-poll uses size-based rotation (not date-based); stderr does not rotate.
    // Only the daemon event file uses todayFilePath() to handle midnight rotation.
    const queuePollPath = path.join(os.homedir(), '.workrail', 'queue-poll.jsonl');
    const stderrPath = path.join(os.homedir(), '.workrail', 'logs', 'daemon.stderr.log');

    /**
     * Compute today's log file path.
     * Recomputed on each poll iteration so --follow handles midnight rotation.
     */
    function todayFilePath(): string {
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      return path.join(eventsDir, `${date}.jsonl`);
    }

    /**
     * Read lines from a file starting at byte offset, return lines and new offset.
     * Returns null if the file does not exist.
     */
    function readNewLines(filePath: string, fromOffset: number): { lines: string[]; newOffset: number } | null {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null; // File doesn't exist yet.
      }

      if (stat.size <= fromOffset) {
        return { lines: [], newOffset: fromOffset }; // No new bytes.
      }

      const fd = fs.openSync(filePath, 'r');
      try {
        const len = stat.size - fromOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, fromOffset);
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        return { lines, newOffset: stat.size };
      } finally {
        fs.closeSync(fd);
      }
    }

    /**
     * Print daemon event JSONL lines, applying the session filter if set.
     */
    function printDaemonLines(lines: string[]): void {
      for (const line of lines) {
        // Apply session filter if --session was provided.
        if (options.session) {
          // Filter by sessionId (UUID) prefix/exact OR workrailSessionId (sess_xxx) prefix/exact.
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const sid = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : '';
            const wrid = typeof obj['workrailSessionId'] === 'string' ? obj['workrailSessionId'] : '';
            const matchesSession = sid.startsWith(options.session) || sid === options.session ||
              wrid.startsWith(options.session) || wrid === options.session;
            if (!matchesSession) continue;
          } catch {
            continue; // Skip malformed lines when filtering.
          }
        }

        const formatted = formatDaemonEventLine(line);
        if (formatted !== null) {
          process.stdout.write(formatted + '\n');
        }
      }
    }

    /**
     * Print queue poll JSONL lines.
     * WHY no session filter: queue poll events have no sessionId field.
     * They always pass through regardless of --session flag.
     */
    function printQueuePollLines(lines: string[]): void {
      for (const line of lines) {
        const formatted = formatQueuePollLine(line);
        if (formatted !== null) {
          process.stdout.write(formatted + '\n');
        }
      }
    }

    /**
     * Print stderr lines that pass the shouldShowStderrLine filter.
     */
    function printStderrLines(lines: string[]): void {
      for (const line of lines) {
        if (shouldShowStderrLine(line)) {
          process.stdout.write(`[stderr] ${line}\n`);
        }
      }
    }

    const filePath = todayFilePath();

    if (!options.follow) {
      // One-shot: read all three files, sort by timestamp, print in order.
      type TaggedLine = { ts: number; line: string; source: 'daemon' | 'queue_poll' | 'stderr' };
      const tagged: TaggedLine[] = [];

      // Daemon events
      const daemonResult = readNewLines(filePath, 0);
      if (daemonResult !== null) {
        for (const line of daemonResult.lines) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            tagged.push({ ts: tsToMs(obj['ts']), line, source: 'daemon' });
          } catch {
            tagged.push({ ts: 0, line, source: 'daemon' });
          }
        }
      }

      // Queue poll events
      const queueResult = readNewLines(queuePollPath, 0);
      if (queueResult !== null) {
        for (const line of queueResult.lines) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            tagged.push({ ts: tsToMs(obj['ts']), line, source: 'queue_poll' });
          } catch {
            tagged.push({ ts: 0, line, source: 'queue_poll' });
          }
        }
      }

      // Stderr lines (no structured ts -- use 0 to sort to the beginning)
      const stderrResult = readNewLines(stderrPath, 0);
      if (stderrResult !== null) {
        for (const line of stderrResult.lines) {
          tagged.push({ ts: 0, line, source: 'stderr' });
        }
      }

      if (tagged.length === 0) {
        process.stdout.write(`No events yet. Is the daemon running? (Expected: ${filePath})\n`);
        return;
      }

      // Sort by timestamp ascending (stable sort: same-ts lines stay in file order).
      tagged.sort((a, b) => a.ts - b.ts);

      for (const { line, source } of tagged) {
        if (source === 'daemon') {
          // Apply session filter for daemon lines
          if (options.session) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              const sid = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : '';
              const wrid = typeof obj['workrailSessionId'] === 'string' ? obj['workrailSessionId'] : '';
              const matchesSession = sid.startsWith(options.session) || sid === options.session ||
                wrid.startsWith(options.session) || wrid === options.session;
              if (!matchesSession) continue;
            } catch {
              continue;
            }
          }
          const formatted = formatDaemonEventLine(line);
          if (formatted !== null) process.stdout.write(formatted + '\n');
        } else if (source === 'queue_poll') {
          const formatted = formatQueuePollLine(line);
          if (formatted !== null) process.stdout.write(formatted + '\n');
        } else {
          // stderr
          if (shouldShowStderrLine(line)) {
            process.stdout.write(`[stderr] ${line}\n`);
          }
        }
      }
      return;
    }

    // --follow mode: print existing lines then poll for new ones.
    // Start at offset 0 to show all existing events, then track the byte position.
    // WHY explicit SIGINT handler: makes Ctrl-C clean exit explicit rather than
    // relying on Node's default SIGINT behavior inside the polling loop.
    process.once('SIGINT', () => process.exit(0));

    let currentFilePath = filePath;
    let offset = 0;
    let queuePollOffset = 0;
    let stderrOffset = 0;

    // Print all existing lines first (all three sources).
    const initial = readNewLines(currentFilePath, 0);
    if (initial !== null) {
      printDaemonLines(initial.lines);
      offset = initial.newOffset;
    } else {
      process.stdout.write(`Waiting for events... (${currentFilePath})\n`);
    }

    const initialQueue = readNewLines(queuePollPath, 0);
    if (initialQueue !== null) {
      printQueuePollLines(initialQueue.lines);
      queuePollOffset = initialQueue.newOffset;
    }

    const initialStderr = readNewLines(stderrPath, 0);
    if (initialStderr !== null) {
      printStderrLines(initialStderr.lines);
      stderrOffset = initialStderr.newOffset;
    }

    // Poll every 500ms for new lines from all three sources.
    // WHY midnight rotation only on daemon file: queue-poll.jsonl uses size-based rotation
    // (handled below with shrink detection); daemon.stderr.log does not rotate.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Daemon file with midnight rotation.
      const newFilePath = todayFilePath();
      if (newFilePath !== currentFilePath) {
        // Day rolled over -- switch to the new file from the beginning.
        currentFilePath = newFilePath;
        offset = 0;
      }

      const daemonPoll = readNewLines(currentFilePath, offset);
      if (daemonPoll !== null && daemonPoll.lines.length > 0) {
        printDaemonLines(daemonPoll.lines);
        offset = daemonPoll.newOffset;
      } else if (daemonPoll !== null) {
        offset = daemonPoll.newOffset;
      }

      // Queue poll file: size-based rotation. Detect shrinkage (file was rotated)
      // and reset offset to read from the beginning of the new file. Without this,
      // the stale offset causes readNewLines to see size <= offset and permanently
      // stop yielding new events after a rotation.
      try {
        const queueStat = fs.statSync(queuePollPath);
        if (queueStat.size < queuePollOffset) {
          queuePollOffset = 0; // File was rotated; read from the new file's start.
        }
      } catch {
        // File does not exist yet -- nothing to reset.
      }
      const queuePoll = readNewLines(queuePollPath, queuePollOffset);
      if (queuePoll !== null && queuePoll.lines.length > 0) {
        printQueuePollLines(queuePoll.lines);
        queuePollOffset = queuePoll.newOffset;
      } else if (queuePoll !== null) {
        queuePollOffset = queuePoll.newOffset;
      }

      // Stderr file (permanent path, no rotation).
      const stderrPoll = readNewLines(stderrPath, stderrOffset);
      if (stderrPoll !== null && stderrPoll.lines.length > 0) {
        printStderrLines(stderrPoll.lines);
        stderrOffset = stderrPoll.newOffset;
      } else if (stderrPoll !== null) {
        stderrOffset = stderrPoll.newOffset;
      }
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH COMMAND (renamed from `status <sessionId>`)
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('health <sessionId>')
  .description('Print a health summary for a daemon session. Accepts sessionId (UUID prefix) or workrailSessionId (sess_xxx).')
  .action((sessionId: string) => {
    // WHY warn on short IDs: the startsWith() filter in runHealthSummary aggregates
    // events from ALL sessions sharing the same prefix, silently producing a wrong summary.
    // Full sess_ IDs are ~31 chars; 20 chars is a safe threshold that warns on
    // short prefixes without triggering on any valid full session ID.
    if (sessionId.length < 20) {
      process.stderr.write(
        `Warning: session ID "${sessionId}" is shorter than 20 characters -- ` +
        `provide more characters to avoid matching multiple sessions.\n`,
      );
    }

    const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(eventsDir, `${date}.jsonl`);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      process.stdout.write(`No events today. Is the daemon running? (Expected: ${filePath})\n`);
      return;
    }

    runHealthSummary(sessionId, raw);
  });

// ═══════════════════════════════════════════════════════════════════════════
// STATUS COMMAND (overview, no args)
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('status [sessionId]')
  .description(
    'Print an overview of active and recently completed sessions (no args), ' +
    'or a session health summary when a sessionId is provided (deprecated: use `worktrain health <id>`).',
  )
  .option('--json', 'Output machine-readable JSON packet')
  .option('-w, --workspace <path>', 'Filter sessions by workspace (reserved for future use)')
  .action(async (sessionId: string | undefined, options: { json?: boolean; workspace?: string }) => {
    // Backward-compat shim: if a sessionId argument is provided, route to the
    // health command logic with a deprecation notice.
    if (sessionId !== undefined) {
      process.stderr.write(
        `Deprecation notice: \`worktrain status <sessionId>\` has been renamed to \`worktrain health <sessionId>\`.\n` +
        `Please update your scripts to use \`worktrain health ${sessionId}\`.\n\n`,
      );

      // WHY warn on short IDs: same rationale as the health command below.
      if (sessionId.length < 20) {
        process.stderr.write(
          `Warning: session ID "${sessionId}" is shorter than 20 characters -- ` +
          `provide more characters to avoid matching multiple sessions.\n`,
        );
      }

      const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = path.join(eventsDir, `${date}.jsonl`);

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        process.stdout.write(`No events today. Is the daemon running? (Expected: ${filePath})\n`);
        return;
      }

      // WHY this shim block is inline: it is a temporary backward-compat bridge
      // that routes legacy `worktrain status <id>` calls to runHealthSummary.
      // It is kept inline because it is expected to be removed once all callers
      // migrate to `worktrain health <id>` -- extracting it would be premature.
      process.stderr.write(`\nNote: This is the old \`worktrain status <id>\` output. Use \`worktrain health <id>\` instead.\n\n`);

      // Re-run the health summary logic (same code as the health command below).
      runHealthSummary(sessionId, raw);
      return;
    }

    // No sessionId: new overview mode.
    await executeWorktrainOverviewCommand(
      {
        now: () => Date.now(),
        buildConsoleService: buildConsoleServiceFromDataDir,
        homedir: os.homedir,
        joinPath: path.join,
        print: (line: string) => process.stdout.write(line + '\n'),
        getDataDirEnv: () => process.env['WORKRAIL_DATA_DIR'],
        readEventLog: (p: string) => fs.promises.readFile(p, 'utf-8').catch(() => ''),
      },
      {
        json: options.json,
        workspace: options.workspace,
      },
    );
  });

/**
 * Print a health summary for a single session from its raw JSONL event log.
 *
 * WHY extracted as a function: shared between the `health` command and the
 * backward-compat shim in `status [sessionId]`. Keeps the logic in one place.
 */
function runHealthSummary(sessionId: string, raw: string): void {
  let workflowId: string | null = null;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let llmTurns = 0;
  let stepAdvances = 0;
  let totalToolCalls = 0;
  let failedToolCalls = 0;
  let fatalIssues = 0;
  let errorIssues = 0;
  let warnIssues = 0;
  let sessionOutcome: string | null = null;
  let lastToolName: string | null = null;
  let lastToolArgs: string | null = null;
  let stuckCount = 0;
  let isLive = true;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sid = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : '';
    const wrid = typeof obj['workrailSessionId'] === 'string' ? obj['workrailSessionId'] : '';
    const matches = sid.startsWith(sessionId) || sid === sessionId ||
      wrid.startsWith(sessionId) || wrid === sessionId;
    if (!matches) continue;

    const ts = typeof obj['ts'] === 'number' ? obj['ts'] : null;
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }

    const kind = typeof obj['kind'] === 'string' ? obj['kind'] : '';
    switch (kind) {
      case 'session_started':
        workflowId = typeof obj['workflowId'] === 'string' ? obj['workflowId'] : null;
        break;
      case 'llm_turn_completed':
        llmTurns++;
        break;
      case 'step_advanced':
        stepAdvances++;
        break;
      case 'tool_call_started':
        totalToolCalls++;
        lastToolName = typeof obj['toolName'] === 'string' ? obj['toolName'] : null;
        lastToolArgs = typeof obj['argsSummary'] === 'string' ? String(obj['argsSummary']).slice(0, 60) : null;
        break;
      case 'tool_call_failed':
        failedToolCalls++;
        break;
      case 'issue_reported': {
        const severity = obj['severity'];
        if (severity === 'fatal') fatalIssues++;
        else if (severity === 'error') errorIssues++;
        else if (severity === 'warn') warnIssues++;
        break;
      }
      case 'agent_stuck':
        stuckCount++;
        break;
      case 'session_completed':
        sessionOutcome = typeof obj['outcome'] === 'string' ? obj['outcome'] : null;
        isLive = false;
        break;
      case 'session_aborted':
        // WHY treat session_aborted as a terminal state: the daemon was stopped before
        // the session completed. This is not a failure, but the session is definitively
        // no longer running. Show ABORTED in the status line rather than RUNNING.
        sessionOutcome = 'aborted';
        isLive = false;
        break;
    }
  }

  if (firstTs === null) {
    process.stdout.write(`No events found for session: ${sessionId}\n`);
    return;
  }

  const durationMs = (lastTs ?? firstTs) - firstTs;
  const durationSec = Math.floor(durationMs / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;
  const durationStr = durationMin > 0
    ? `${durationMin}m ${durationRemSec}s`
    : `${durationSec}s`;

  const avgTurnSec = llmTurns > 0 ? (durationMs / llmTurns / 1000).toFixed(1) : '?';
  const failRate = totalToolCalls > 0 ? ((failedToolCalls / totalToolCalls) * 100).toFixed(1) : '0';
  const sessionStatus = sessionOutcome !== null
    ? sessionOutcome.toUpperCase()
    : (isLive ? 'RUNNING' : 'UNKNOWN');

  const issueStr = (fatalIssues + errorIssues + warnIssues) > 0
    ? `${fatalIssues + errorIssues + warnIssues} (${fatalIssues} fatal, ${errorIssues} error, ${warnIssues} warn)`
    : '0';

  const lastActivityStr = lastTs !== null
    ? `${lastToolName ?? 'unknown'} ${lastToolArgs ? `"${lastToolArgs}"` : ''} ${Math.round((Date.now() - lastTs) / 1000)}s ago`
    : 'unknown';

  process.stdout.write(`\nSession: ${sessionId}    [${sessionStatus}]\n`);
  if (workflowId) process.stdout.write(`Workflow: ${workflowId}\n`);
  process.stdout.write(`Duration: ${durationStr}\n`);
  process.stdout.write(`LLM turns: ${llmTurns}${llmTurns > 0 ? ` (avg ${avgTurnSec}s each)` : ''}\n`);
  process.stdout.write(`Step advances: ${stepAdvances}\n`);
  process.stdout.write(`Tool calls: ${totalToolCalls} (${failedToolCalls} failed, ${failRate}% failure rate)\n`);
  process.stdout.write(`Issues reported: ${issueStr}\n`);
  process.stdout.write(`Last activity: ${lastActivityStr}\n`);

  if (stuckCount > 0) {
    process.stdout.write(`*** WARNING: ${stuckCount} stuck signal(s) detected\n`);
  }
  if (fatalIssues > 0) {
    process.stdout.write(`*** WARNING: ${fatalIssues} FATAL issue(s) reported\n`);
  }
  if (llmTurns >= 10 && stepAdvances === 0) {
    process.stdout.write(`*** WARNING: ${llmTurns} turns with 0 step advances (possible stuck)\n`);
  }

  process.stdout.write('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN COMMAND
// ═══════════════════════════════════════════════════════════════════════════

/**
 * worktrain run pr-review
 *
 * Autonomous PR review coordinator. Dispatches mr-review-workflow-agentic sessions
 * for open PRs, waits for results, and routes by severity: clean -> merge,
 * minor -> fix-agent loop, blocking/unknown -> escalate.
 *
 * Requires the WorkTrain daemon to be running: worktrain daemon
 */
const runCommand = program
  .command('run')
  .description('Run a coordinator script');

runCommand
  .command('pr-review')
  .description('Review open PRs autonomously: dispatch review sessions, route by findings, merge or escalate')
  .requiredOption('-W, --workspace <path>', 'Absolute path to the git workspace')
  .option('-r, --pr <number>', 'Review a specific PR number (repeatable)', (val, prev: number[]) => [...prev, parseInt(val, 10)], [] as number[])
  .option('--dry-run', 'Print actions without dispatching sessions or merging')
  .option('-p, --port <n>', 'Console HTTP server port (default: auto-discover from lock file, then 3456)', parseInt)
  .action(async (options: { workspace: string; pr: number[]; dryRun?: boolean; port?: number }) => {
    const {
      runPrReviewCoordinator,
      discoverConsolePort,
    } = await import('./coordinators/pr-review.js');
    const { execFile: execFileRaw } = await import('child_process');
    const execFilePromise = promisify(execFileRaw);

    // Validate workspace at the CLI boundary
    if (!path.isAbsolute(options.workspace)) {
      process.stderr.write(`Error: --workspace must be an absolute path, got: ${options.workspace}\n`);
      process.exit(1);
    }
    try {
      const stat = await fs.promises.stat(options.workspace);
      if (!stat.isDirectory()) {
        process.stderr.write(`Error: --workspace must be an existing directory: ${options.workspace}\n`);
        process.exit(1);
      }
    } catch {
      process.stderr.write(`Error: --workspace does not exist: ${options.workspace}\n`);
      process.exit(1);
    }

    // Discover console port
    const port = await discoverConsolePort(
      {
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        homedir: os.homedir,
        joinPath: path.join,
      },
      options.port,
    );

    // Build real CoordinatorDeps
    const deps = {
      spawnSession: async (
        workflowId: string,
        goal: string,
        workspace: string,
        context?: Readonly<Record<string, unknown>>,
      ) => {
        const url = `http://127.0.0.1:${port}/api/v2/auto/dispatch`;
        try {
          const response = await globalThis.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workflowId,
              goal,
              workspacePath: workspace,
              ...(context !== undefined ? { context } : {}),
            }),
            signal: AbortSignal.timeout(30_000),
          });
          const body = await response.json() as Record<string, unknown>;
          if (!response.ok) {
            const errMsg = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
            if (response.status === 503) {
              return { kind: 'err' as const, error: `WorkTrain daemon is not ready: ${errMsg}` };
            }
            return { kind: 'err' as const, error: `Dispatch failed: ${errMsg}` };
          }
          if (body['success'] !== true || typeof body['data'] !== 'object') {
            return { kind: 'err' as const, error: 'Unexpected response from dispatch endpoint' };
          }
          const data = body['data'] as Record<string, unknown>;
          const handle = typeof data['sessionHandle'] === 'string' ? data['sessionHandle'] : '';
          if (!handle) {
            return { kind: 'err' as const, error: 'Dispatch succeeded but no session handle returned' };
          }
          return { kind: 'ok' as const, value: handle };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed');
          if (isConnRefused) {
            return { kind: 'err' as const, error: `Could not connect to WorkTrain daemon on port ${port}. Ensure the daemon is running with: worktrain daemon` };
          }
          if (e instanceof Error && e.name === 'TimeoutError') {
            return { kind: 'err' as const, error: `Daemon request timed out after 30s` };
          }
          return { kind: 'err' as const, error: `Dispatch request failed: ${msg}` };
        }
      },

      contextAssembler: createContextAssembler({
        execGit: async (args: readonly string[], cwd: string) => {
          try {
            const { stdout } = await execFileAsync('git', [...args], { cwd });
            return { kind: 'ok' as const, value: stdout };
          } catch (e) {
            return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
          }
        },
        execGh: async (args: readonly string[], cwd: string) => {
          try {
            const { stdout } = await execFileAsync('gh', [...args], { cwd });
            return { kind: 'ok' as const, value: stdout };
          } catch (e) {
            return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
          }
        },
        listRecentSessions: createListRecentSessions(),
        nowIso: () => new Date().toISOString(),
      }),

      awaitSessions: async (handles: readonly string[], timeoutMs: number) => {
        const { executeWorktrainAwaitCommand } = await import('./cli/commands/worktrain-await.js');
        let resolvedResult: import('./cli/commands/worktrain-await.js').AwaitResult | null = null;

        await executeWorktrainAwaitCommand(
          {
            fetch: (url: string) => globalThis.fetch(url),
            readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
            stdout: (line: string) => {
              try { resolvedResult = JSON.parse(line) as import('./cli/commands/worktrain-await.js').AwaitResult; } catch { /* ignore */ }
            },
            stderr: (line: string) => process.stderr.write(line + '\n'),
            homedir: os.homedir,
            joinPath: path.join,
            sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
            now: () => Date.now(),
          },
          {
            sessions: [...handles].join(','),
            mode: 'all',
            timeout: `${Math.round(timeoutMs / 1000)}s`,
            port,
          },
        );

        if (resolvedResult === null) {
          process.stderr.write(
            `[WARN coord:reason=await_failed] awaitSessions: could not get session results -- daemon may be unreachable or timed out. Returning all ${handles.length} session(s) as failed.\n`,
          );
        }
        return resolvedResult ?? { results: [...handles].map((h) => ({
          handle: h,
          outcome: 'failed' as const,
          status: null,
          durationMs: 0,
        })), allSucceeded: false };
      },

      getAgentResult: async (sessionHandle: string): Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }> => {
        // WHY this function returns both recapMarkdown and artifacts:
        // The coordinator uses recapMarkdown for keyword-scan fallback and artifacts for
        // typed verdict reading (readVerdictArtifact). Artifacts are aggregated from ALL
        // session nodes (not just the tip node) so a verdict emitted on any step is captured.
        // See docs/discovery/artifacts-coordinator-channel.md.
        const emptyResult = { recapMarkdown: null, artifacts: [] as readonly unknown[] };
        try {
          // Step 1: get session detail to find preferredTipNodeId and all node IDs
          const sessionUrl = `http://127.0.0.1:${port}/api/v2/sessions/${encodeURIComponent(sessionHandle)}`;
          const sessionRes = await globalThis.fetch(sessionUrl, { signal: AbortSignal.timeout(30_000) });
          if (!sessionRes.ok) {
            process.stderr.write(
              `[WARN coord:reason=http_error status=${sessionRes.status} handle=${sessionHandle.slice(0, 16)}] getAgentResult: session fetch returned HTTP ${sessionRes.status}\n`,
            );
            return emptyResult;
          }
          const sessionBody = await sessionRes.json() as Record<string, unknown>;
          if (sessionBody['success'] !== true) {
            process.stderr.write(
              `[WARN coord:reason=api_error handle=${sessionHandle.slice(0, 16)}] getAgentResult: session API returned success=false\n`,
            );
            return emptyResult;
          }

          const data = sessionBody['data'] as Record<string, unknown> | undefined;
          if (!data) {
            process.stderr.write(
              `[WARN coord:reason=no_data handle=${sessionHandle.slice(0, 16)}] getAgentResult: session response missing data field\n`,
            );
            return emptyResult;
          }
          const runs = data['runs'] as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(runs) || runs.length === 0) {
            process.stderr.write(
              `[WARN coord:reason=no_runs handle=${sessionHandle.slice(0, 16)}] getAgentResult: session has no runs\n`,
            );
            return emptyResult;
          }

          const firstRun = runs[0] as Record<string, unknown>;
          const tipNodeId = typeof firstRun['preferredTipNodeId'] === 'string'
            ? firstRun['preferredTipNodeId']
            : null;
          if (!tipNodeId) {
            process.stderr.write(
              `[WARN coord:reason=no_tip_node handle=${sessionHandle.slice(0, 16)}] getAgentResult: session run has no preferredTipNodeId\n`,
            );
            return emptyResult;
          }

          // Step 2: collect all node IDs from the session's first run.
          // WHY all nodes (not just tip): a verdict artifact may be emitted on a non-final step.
          // The tip node provides recapMarkdown; all nodes contribute to the artifacts aggregate.
          const allNodes = Array.isArray(firstRun['nodes'])
            ? (firstRun['nodes'] as Array<Record<string, unknown>>)
            : [];
          const allNodeIds = allNodes
            .map((n) => (typeof n['nodeId'] === 'string' ? n['nodeId'] : null))
            .filter((id): id is string => id !== null);

          // Ensure the tip node is included even if not in allNodeIds (defensive)
          const nodeIdsToFetch = allNodeIds.length > 0
            ? allNodeIds
            : [tipNodeId];

          // Step 3: fetch each node and aggregate artifacts + recapMarkdown.
          // WHY per-node try/catch: individual fetch failures must not abort the
          // entire aggregation. A single failed node's artifacts are skipped (WARN logged),
          // while other nodes' artifacts and the tip node's recapMarkdown are preserved.
          const baseNodeUrl = `http://127.0.0.1:${port}/api/v2/sessions/${encodeURIComponent(sessionHandle)}/nodes/`;
          let recap: string | null = null;
          const collectedArtifacts: unknown[] = [];

          for (const nodeId of nodeIdsToFetch) {
            try {
              const nodeRes = await globalThis.fetch(
                baseNodeUrl + encodeURIComponent(nodeId),
                { signal: AbortSignal.timeout(30_000) },
              );
              if (!nodeRes.ok) {
                process.stderr.write(
                  `[WARN coord:reason=node_http_error status=${nodeRes.status} handle=${sessionHandle.slice(0, 16)} node=${nodeId.slice(0, 16)}] getAgentResult: node fetch returned HTTP ${nodeRes.status}\n`,
                );
                continue;
              }
              const nodeBody = await nodeRes.json() as Record<string, unknown>;
              if (nodeBody['success'] !== true) {
                process.stderr.write(
                  `[WARN coord:reason=node_api_error handle=${sessionHandle.slice(0, 16)} node=${nodeId.slice(0, 16)}] getAgentResult: node API returned success=false\n`,
                );
                continue;
              }
              const nodeData = nodeBody['data'] as Record<string, unknown> | undefined;
              if (!nodeData) continue;

              // Collect recapMarkdown from tip node only
              if (nodeId === tipNodeId) {
                recap = typeof nodeData['recapMarkdown'] === 'string' ? nodeData['recapMarkdown'] : null;
                if (recap === null) {
                  process.stderr.write(
                    `[WARN coord:reason=no_recap handle=${sessionHandle.slice(0, 16)} node=${nodeId.slice(0, 16)}] getAgentResult: tip node has no recapMarkdown\n`,
                  );
                }
              }

              // Collect artifacts from all nodes (aggregate across the session)
              const nodeArtifacts = nodeData['artifacts'];
              if (Array.isArray(nodeArtifacts) && nodeArtifacts.length > 0) {
                collectedArtifacts.push(...nodeArtifacts);
              }
            } catch (nodeErr) {
              const msg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
              process.stderr.write(
                `[WARN coord:reason=node_exception handle=${sessionHandle.slice(0, 16)} node=${nodeId.slice(0, 16)}] getAgentResult: ${msg}\n`,
              );
              // Continue to next node -- one failed node does not abort the aggregation
            }
          }

          return { recapMarkdown: recap, artifacts: collectedArtifacts };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(
            `[WARN coord:reason=exception handle=${sessionHandle.slice(0, 16)}] getAgentResult: ${msg}\n`,
          );
          return emptyResult;
        }
      },

      listOpenPRs: async (workspace: string) => {
        try {
          const { stdout } = await execFilePromise('gh', ['pr', 'list', '--json', 'number,title,headRefName'], {
            cwd: workspace,
            timeout: 30_000,
          });
          const parsed = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string }>;
          return parsed.map((p) => ({ number: p.number, title: p.title, headRef: p.headRefName }));
        } catch {
          return [];
        }
      },

      mergePR: async (prNumber: number, workspace: string) => {
        try {
          await execFilePromise('gh', ['pr', 'merge', String(prNumber), '--squash', '--auto'], {
            cwd: workspace,
            timeout: 60_000,
          });
          return { kind: 'ok' as const, value: undefined };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { kind: 'err' as const, error: msg };
        }
      },

      writeFile: async (filePath: string, content: string) => {
        await fs.promises.writeFile(filePath, content, 'utf-8');
      },

      readFile: (filePath: string) => fs.promises.readFile(filePath, 'utf-8'),

      appendFile: (filePath: string, content: string) =>
        fs.promises.appendFile(filePath, content, 'utf-8'),

      mkdir: (dirPath: string, opts: { recursive: boolean }) =>
        fs.promises.mkdir(dirPath, opts),

      homedir: os.homedir,
      joinPath: path.join,
      nowIso: () => new Date().toISOString(),
      generateId: () => randomUUID(),

      stderr: (line: string) => process.stderr.write(line + '\n'),
      now: () => Date.now(),
      port,
    };

    const result = await runPrReviewCoordinator(deps, {
      workspace: options.workspace,
      prs: options.pr.length > 0 ? options.pr : undefined,
      dryRun: options.dryRun ?? false,
      port: options.port,
    });

    process.exit(result.hasErrors ? 1 : 0);
  });

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER COMMAND GROUP
// ═══════════════════════════════════════════════════════════════════════════

const triggerCommand = program
  .command('trigger')
  .description('Trigger management commands');

triggerCommand
  .command('test <triggerId>')
  .description('Dry-run the queue picker for a trigger -- shows what would dispatch without dispatching')
  .option('-p, --port <n>', 'Console server port for active session count', parseInt)
  .action(async (triggerId: string, options: { port?: number }) => {
    const { loadTriggerConfigFromFile, buildTriggerIndex } = await import('./trigger/trigger-store.js');
    const { loadQueueConfig } = await import('./trigger/github-queue-config.js');
    const { pollGitHubQueueIssues, checkIdempotency, inferMaturity } = await import('./trigger/adapters/github-queue-poller.js');

    const cwd = process.cwd();

    const result = await executeWorktrainTriggerTestCommand(
      {
        loadTriggerConfig: async () => {
          const configResult = await loadTriggerConfigFromFile(cwd, process.env);
          if (configResult.kind === 'err') {
            const e = configResult.error;
            const msg = e.kind === 'file_not_found'
              ? `triggers.yml not found at ${e.filePath}`
              : e.kind === 'io_error'
              ? `IO error reading triggers.yml: ${e.message}`
              : `Failed to parse triggers.yml: ${JSON.stringify(e)}`;
            return { kind: 'err', error: msg };
          }
          const indexResult = buildTriggerIndex(configResult.value);
          if (indexResult.kind === 'err') {
            const idxErr = indexResult.error;
            const triggerId2 = 'triggerId' in idxErr ? idxErr.triggerId : '(unknown)';
            return { kind: 'err', error: `Duplicate trigger ID: ${triggerId2}` };
          }
          return { kind: 'ok', value: indexResult.value };
        },
        loadQueueConfig: async () => {
          return loadQueueConfig();
        },
        pollGitHubQueueIssues: async (source, config) => {
          const result2 = await pollGitHubQueueIssues(source, config);
          if (result2.kind === 'err') {
            const e = result2.error;
            return { kind: 'err', error: `${e.kind}: ${(e as { message: string }).message}` };
          }
          return result2;
        },
        countActiveSessions: async () => {
          const sessionsDir = path.join(os.homedir(), '.workrail', 'daemon-sessions');
          try {
            const files = await fs.promises.readdir(sessionsDir);
            return files.filter((f) => f.endsWith('.json')).length;
          } catch {
            return 0;
          }
        },
        checkIdempotency: async (issueNumber: number) => {
          const sessionsDir = path.join(os.homedir(), '.workrail', 'daemon-sessions');
          return checkIdempotency(issueNumber, sessionsDir);
        },
        inferMaturity: (issue) => inferMaturity(issue.body),
        print: (line: string) => process.stdout.write(line + '\n'),
        stderr: (line: string) => process.stderr.write(line + '\n'),
      },
      { triggerId, port: options.port },
    );

    // WHY handle exit code directly (not via interpretCliResultWithoutDI):
    // All dry-run output is already printed via deps.print(). The CliResult.failure
    // carries an empty message to avoid the output-formatter printing a redundant
    // '❌ ...' prefix after the [DryRun] summary. We only need the exit code.
    if (result.kind === 'failure') {
      process.exit(1);
    }
  });

triggerCommand
  .command('validate')
  .description('Static analysis of triggers.yml -- reports issues without running anything. Exits 1 if any errors found.')
  .option('--config <path>', 'Path to triggers.yml (default: ~/.workrail/triggers.yml)')
  .action(async (options: { config?: string }) => {
    // Load ~/.workrail/.env so $ENV_VAR secret references in triggers.yml resolve correctly.
    await loadDaemonEnv();
    process.stdout.write('[Note: loaded ~/.workrail/.env for secret resolution]\n');

    const { loadTriggerConfigFromFile } = await import('./trigger/trigger-store.js');

    const defaultConfigFilePath = path.join(os.homedir(), '.workrail', 'triggers.yml');
    const configFilePath = options.config ?? defaultConfigFilePath;

    await executeWorktrainTriggerValidateCommand({
      loadTriggerConfigFromFile: (dirPath: string) => loadTriggerConfigFromFile(dirPath, process.env),
      stdout: process.stdout,
      stderr: process.stderr,
      exit: process.exit as (code: number) => never,
      configFilePath,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
