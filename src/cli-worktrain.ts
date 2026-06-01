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
import {
  executeWorktrainInitCommand,
  executeWorktrainTellCommand,
  executeWorktrainInboxCommand,
  executeWorktrainDaemonCommand,
  executeWorktrainTriggerTestCommand,
  executeWorktrainTriggerValidateCommand,
  type Priority,
} from './cli/commands/index.js';
import { writeStatsSummary } from './daemon/stats-summary.js';
import {
  parseDaemonEvents,
  analyzeFleet,
  formatDiagnosticCard,
  formatDiagnosticJson,
  formatFleetSummary,
} from './cli/commands/worktrain-diagnose.js';
import { parseSessionEvents, formatSessionEvents } from './cli/commands/worktrain-session-log.js';

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
    // Non-TTY without --yes: fail fast rather than hanging on prompts.
    if (!options.yes && !input.isTTY) {
      process.stderr.write(
        'Error: stdin is not a TTY. Run with --yes for non-interactive mode.\n' +
        'Example: worktrain init --yes\n',
      );
      process.exit(1);
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
  .description('Queue an async message for the WorkTrain daemon, or steer a specific running session.')
  .option('-w, --workspace <name>', 'Workspace hint for the daemon (optional)')
  .option('--session <id>', 'Send directly to a specific running session via the steer endpoint')
  .option('--port <n>', 'Override daemon HTTP port for --session (default: 3200)', parseInt)
  .addOption(
    new Option('--priority <level>', 'Message priority: high, normal, or low')
      .choices(['high', 'normal', 'low'])
      .default('normal'),
  )
  .action(async (message: string, options: { workspace?: string; session?: string; port?: number; priority?: string }) => {
    // --session: route directly to running session via steer endpoint
    if (options.session) {
      const port = options.port ?? 3200;
      const url = `http://127.0.0.1:${port}/sessions/${options.session}/steer`;
      try {
        const response = await globalThis.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          const err = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
          if (response.status === 404) {
            process.stderr.write(`Session not found: ${options.session}\n`);
          } else {
            process.stderr.write(`Steer failed: ${err}\n`);
          }
          process.exit(1);
        }
        console.log(`Message sent to session ${options.session}.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          process.stderr.write(`Daemon is not running on port ${port}. Start it with: worktrain daemon start\n`);
        } else {
          process.stderr.write(`Steer request failed: ${msg}\n`);
        }
        process.exit(1);
      }
      return;
    }

    // Default: queue to message-queue.jsonl
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
  .option('--json', 'Output unread messages as a JSON array')
  .action(async (options: { watch?: boolean; json?: boolean }) => {
    const result = await executeWorktrainInboxCommand(
      {
        readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
        writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
        mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
        homedir: os.homedir,
        joinPath: path.join,
        print: (line: string) => console.log(line),
      },
      { watch: options.watch, json: options.json },
    );
    interpretCliResultWithoutDI(result);
  });

// Migration shims for removed commands: spawn, await.
// WHY hidden: these print a helpful error pointing to the replacement;
// they must not appear in --help.
program.addCommand(
  new Command('spawn')
    .description('(removed)')
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(
        '\'worktrain spawn\' was removed. Use \'worktrain dispatch\' to start a session.\n' +
        'Example: worktrain dispatch "task description" -w /path/to/workspace\n',
      );
      process.exit(1);
    }),
  { hidden: true },
);

program.addCommand(
  new Command('await')
    .description('(removed)')
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(
        '\'worktrain await\' was removed. Use \'worktrain dispatch --wait\' to block until completion.\n',
      );
      process.exit(1);
    }),
  { hidden: true },
);

// Hidden `run` parent + subcommand shims for removed `run pipeline` / `run pr-review`.
// WHY keep `run` as a hidden registered command: Commander resolves commands left-to-right.
// Without a registered `run`, `worktrain run pipeline` fails at `run` with a generic
// "unknown command" error before the subcommand name is even seen.
{
  const runShim = new Command('run').description('(removed)').allowUnknownOption(true);
  runShim.addCommand(
    new Command('pipeline').description('(removed)').allowUnknownOption(true).action(() => {
      process.stderr.write(
        "'worktrain run pipeline' was removed. Use 'worktrain dispatch \"<task>\" -w <workspace>' instead.\n",
      );
      process.exit(1);
    }),
    { hidden: true },
  );
  runShim.addCommand(
    new Command('pr-review').description('(removed)').allowUnknownOption(true).action(() => {
      process.stderr.write(
        "'worktrain run pr-review' was removed. Use 'worktrain dispatch --pr <n> -w <workspace>' instead.\n",
      );
      process.exit(1);
    }),
    { hidden: true },
  );
  runShim.action(() => {
    process.stderr.write("'worktrain run' was removed. Use 'worktrain dispatch' instead.\n");
    process.exit(1);
  });
  program.addCommand(runShim, { hidden: true });
}

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
  .description('Start the WorkTrain daemon, or manage it as a macOS launchd service.\nSubcommands: start, stop, status, install, uninstall');

// ---------------------------------------------------------------------------
// Shared daemon deps factory
// WHY a module-level async function: all daemon subcommands need identical
// deps. Extracting avoids duplicating 60+ lines across 5 action handlers.
// ---------------------------------------------------------------------------

async function buildDaemonDeps(): Promise<import('./cli/commands/worktrain-daemon.js').WorktrainDaemonCommandDeps> {
  const { execFile: execFileRaw } = await import('child_process');
  const execFilePromise = promisify(execFileRaw);

  const startDaemon = async (): Promise<void> => {
    // Load .env again as defense-in-depth.
    await loadDaemonEnv();

    // This is the launchd entry point: `worktrain daemon` with no subcommand.
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
        const statsDir = path.join(os.homedir(), '.workrail', 'data');
        // Count active sessions from the daemon-sessions dir. Best-effort:
        // if the dir is unavailable, activeSessions defaults to 0.
        fs.promises.readdir(sessionsDir)
          .then((files) => files.filter((f) => f.endsWith('.json')).length)
          .catch(() => 0)
          .then((activeSessions) => {
            emitter.emit({ kind: 'daemon_heartbeat', activeSessions, ts: Date.now() });
          });
        // Update stats-summary.json as a safety net. Covers sessions whose post-session
        // write failed (e.g. daemon restart mid-write). Fire-and-forget.
        writeStatsSummary(statsDir).catch(() => {});
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

        // 1. Emit session_aborted for all in-flight sessions before aborting,
        // so the event log shows terminal state (not RUNNING forever after restart).
        for (const sh of handle.activeSessionSet.handles()) {
          emitter.emit({
            kind: 'session_aborted',
            sessionId: sh.sessionId,
            ...(sh.workrailSessionId !== null ? { workrailSessionId: sh.workrailSessionId } : {}),
            reason: 'daemon_shutdown',
            ts: Date.now(),
          });
        }
        emitter.emit({ kind: 'daemon_stopped', reason: 'graceful', ts: Date.now() });

        // 2. Abort all in-flight AgentLoop instances simultaneously.
        handle.activeSessionSet.abortAll();

        // 3. Drain window: give sessions up to 5s to finish cleanup after abort.
        // Sessions call handle.dispose() in their finally blocks which decrements size.
        if (handle.activeSessionSet.size > 0) {
          await Promise.race([
            new Promise<void>(r => setTimeout(r, 5000)),
            new Promise<void>(r => {
              const check = setInterval(() => {
                if (handle.activeSessionSet.size === 0) { clearInterval(check); r(); }
              }, 100);
            }),
          ]);
        }

        // 4. Stop HTTP server and polling loop.
        // WHY after abort+drain: ensures abort() is called before the HTTP server
        // closes. If handle.stop() were called first, active sessions would have
        // no way to complete their final continue_workflow calls.
        await handle.stop();
        resolve();
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
    });
  };

  return {
    env,
    platform: process.platform,
    // Use the resolved path of the current worktrain binary so the plist
    // always points to the installed binary, not a symlink or npx wrapper.
    worktrainBinPath: process.argv[1] ?? 'worktrain',
    nodeBinPath: process.execPath,
    homedir: os.homedir,
    joinPath: path.join,
    mkdir: (p: string, opts: { recursive: boolean }) => fs.promises.mkdir(p, opts),
    writeFile: (p: string, content: string) => fs.promises.writeFile(p, content, 'utf-8'),
    chmod: (p: string, mode: number) => fs.promises.chmod(p, mode),
    readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
    removeFile: (p: string) => fs.promises.unlink(p),
    exists: async (p: string) => {
      try { await fs.promises.access(p); return true; } catch { return false; }
    },
    exec: async (command: string, args: string[]) => {
      try {
        const { stdout, stderr } = await execFilePromise(command, args, { encoding: 'utf-8' });
        return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: typeof e.code === 'number' ? e.code : 1 };
      }
    },
    print: (line: string) => console.log(line),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    httpGet: async (url: string): Promise<number | null> => {
      const { get } = await import('http');
      return new Promise((resolve) => {
        const req = get(url, { timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode ?? null); });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    },
    startDaemon,
  };
}

// ---------------------------------------------------------------------------
// daemon subcommands: start, stop, status, install, uninstall
// Parent action (no subcommand) = launchd entry point, starts daemon process.
// WHY parent action preserved: launchd plist calls `worktrain daemon` with no
// args. Commander fires the parent action when no subcommand is given.
// ---------------------------------------------------------------------------

{
  const daemonCmd = program.commands.find((c) => c.name() === 'daemon')!;

  // Bare invocation: launchd entry point. Must start the daemon process.
  daemonCmd.action(async () => {
    await loadDaemonEnv();
    const deps = await buildDaemonDeps();
    const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'run' } });
    interpretCliResultWithoutDI(result);
  });

  daemonCmd
    .command('start')
    .description('Start the daemon via launchctl (must be installed first)')
    .action(async () => {
      await loadDaemonEnv();
      const deps = await buildDaemonDeps();
      const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'start' } });
      interpretCliResultWithoutDI(result);
    });

  daemonCmd
    .command('stop')
    .description('Stop the running daemon via launchctl')
    .action(async () => {
      await loadDaemonEnv();
      const deps = await buildDaemonDeps();
      const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'stop' } });
      interpretCliResultWithoutDI(result);
    });

  daemonCmd
    .command('status')
    .description('Show the current status of the daemon service')
    .option('--json', 'Machine-readable output: {"running": bool, "installed": bool}')
    .action(async (options: { json?: boolean }) => {
      await loadDaemonEnv();
      const deps = await buildDaemonDeps();
      const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'status', json: options.json } });
      interpretCliResultWithoutDI(result);
    });

  daemonCmd
    .command('install')
    .description('Register the daemon as a launchd service (does not auto-start)')
    .action(async () => {
      await loadDaemonEnv();
      const deps = await buildDaemonDeps();
      const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'install' } });
      interpretCliResultWithoutDI(result);
    });

  daemonCmd
    .command('uninstall')
    .description('Unregister the daemon from launchd and remove the plist')
    .action(async () => {
      await loadDaemonEnv();
      const deps = await buildDaemonDeps();
      const result = await executeWorktrainDaemonCommand(deps, { subcommand: { kind: 'uninstall' } });
      interpretCliResultWithoutDI(result);
    });

  // WHY no flag-form shims: Commander does not route `--`-prefixed tokens as
  // subcommand names -- they are parsed as unknown options and produce Commander's
  // own "unknown option" error before any action() can fire. The shims would be
  // dead code. Commander's built-in error is acceptable migration UX here.
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGS COMMAND
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a single DaemonEvent JSONL line for human-readable output.
 *
 * WHY inline: the logs command is the only consumer of this formatting.
 * Keeping it here avoids creating a module for a single 30-line function.
 */
/**
 * Parse a timeout duration string like "30m", "1h", "90s" into milliseconds.
 * Returns DEFAULT_DISPATCH_TIMEOUT_MS on unrecognized input.
 */
function parseTimeoutDuration(input: string): number {
  const DEFAULT_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;
  const trimmed = input.trim().toLowerCase();
  const num = parseFloat(trimmed);
  if (isNaN(num) || num <= 0) return DEFAULT_DISPATCH_TIMEOUT_MS;
  if (trimmed.endsWith('h')) return num * 60 * 60 * 1000;
  if (trimmed.endsWith('m')) return num * 60 * 1000;
  if (trimmed.endsWith('s')) return num * 1000;
  return DEFAULT_DISPATCH_TIMEOUT_MS;
}

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
  .option('--json', 'Output raw newline-delimited JSON events instead of formatted text')
  .action(async (options: { follow?: boolean; session?: string; json?: boolean }) => {
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

        if (options.json) {
          // Raw JSONL passthrough for machine-readable output.
          process.stdout.write(line + '\n');
        } else {
          const formatted = formatDaemonEventLine(line);
          if (formatted !== null) {
            process.stdout.write(formatted + '\n');
          }
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
          if (options.json) {
            process.stdout.write(line + '\n');
          } else {
            const formatted = formatDaemonEventLine(line);
            if (formatted !== null) process.stdout.write(formatted + '\n');
          }
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
// DIAGNOSE COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('diagnose [sessionId]')
  .description(
    'Session diagnostics. No args: fleet summary with step bottleneck analysis and token burn. ' +
    'Pass a sessionId for a per-session failure card with evidence and suggested fix. ' +
    'Searches the last 7 days of daemon event logs. Works without the daemon running.',
  )
  .option('--workflow <id>', 'Filter fleet view by workflow ID (e.g. wr.discovery)')
  .option('--json', 'Output machine-readable JSON (per-session only)')
  .option('--ascii', 'Use ASCII-only output (no Unicode glyphs)')
  .action((sessionId: string | undefined, options: { workflow?: string; json?: boolean; ascii?: boolean }) => {
    const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');
    const readFile = (filePath: string): string | null => {
      try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
    };

    if (sessionId !== undefined) {
      // Per-session failure card
      const result = parseDaemonEvents(sessionId, eventsDir, 7, readFile);
      if (options.json) {
        process.stdout.write(formatDiagnosticJson(result) + '\n');
      } else {
        process.stdout.write(formatDiagnosticCard(result, { ascii: options.ascii ?? false }) + '\n');
      }
    } else {
      // Fleet summary
      const readDir = (dir: string): readonly string[] | null => {
        try { return fs.readdirSync(dir); } catch { return null; }
      };
      const analysis = analyzeFleet(readDir, readFile, eventsDir, options.workflow);
      process.stdout.write(formatFleetSummary(analysis, { ascii: options.ascii ?? false }) + '\n');
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// SESSION NAMESPACE: events, kill, resume, retry
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('session')
  .description('Inspect and control individual daemon sessions.\nSubcommands: events, kill, resume, retry');

{
  const sessionCmd = program.commands.find((c) => c.name() === 'session')!;

  sessionCmd
    .command('events <sessionId>')
    .description(
      'Print a time-annotated turn-by-turn replay of a daemon session. ' +
      'Shows LLM calls, tool executions with durations, step advances, and the final outcome. ' +
      'Accepts a full session ID or a prefix. Searches the last 7 days of daemon event logs.',
    )
    .action((sessionId: string) => {
      const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');
      const readFile = (filePath: string): string | null => {
        try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
      };
      const result = parseSessionEvents(sessionId, eventsDir, 7, readFile);
      process.stdout.write(formatSessionEvents(result) + '\n');
    });

  sessionCmd
    .command('kill <sessionId>')
    .description('Abort a running session. Requires --force or confirmation prompt.')
    .option('--force', 'Skip confirmation prompt')
    .action(async (sessionId: string, options: { force?: boolean }) => {
      const { executeWorktrainSessionKillCommand } = await import('./cli/commands/worktrain-session-kill.js');
      const result = await executeWorktrainSessionKillCommand({ sessionId, force: options.force });
      interpretCliResultWithoutDI(result);
    });

  sessionCmd
    .command('resume <sessionId>')
    .description('Re-fire an orphaned session that crash recovery did not restart.')
    .action(async (sessionId: string) => {
      const { executeWorktrainSessionResumeCommand } = await import('./cli/commands/worktrain-session-resume.js');
      const result = await executeWorktrainSessionResumeCommand({ sessionId });
      interpretCliResultWithoutDI(result);
    });

  sessionCmd
    .command('retry <sessionId>')
    .description('Re-run a session from scratch with the same goal and context. Requires --force or confirmation prompt.')
    .option('--force', 'Skip confirmation prompt')
    .action(async (sessionId: string, options: { force?: boolean }) => {
      const { executeWorktrainSessionRetryCommand } = await import('./cli/commands/worktrain-session-retry.js');
      const result = await executeWorktrainSessionRetryCommand({ sessionId, force: options.force });
      interpretCliResultWithoutDI(result);
    });

  // Hidden migration shim for old `session-log` command.
  sessionCmd.addCommand(
    new Command('log')
      .description('(removed)')
      .argument('<sessionId>', 'session ID')
      .action(() => {
        process.stderr.write(
          '\'worktrain session-log\' was renamed. Use: worktrain session events <sessionId>\n',
        );
        process.exit(1);
      }),
    { hidden: true },
  );
}

// Hidden migration shim for the old top-level `session-log` command.
program.addCommand(
  new Command('session-log')
    .description('(removed)')
    .argument('<sessionId>', 'session ID')
    .action(() => {
      process.stderr.write(
        '\'worktrain session-log\' was renamed. Use: worktrain session events <sessionId>\n',
      );
      process.exit(1);
    }),
  { hidden: true },
);

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('dispatch [task]')
  .description(
    'Dispatch a workflow session via the running daemon.\n' +
    'Routes adaptively unless --workflow or --pr is specified.\n' +
    'Requires the daemon to be running (worktrain daemon start).',
  )
  .option('-w, --workspace <path>', 'Absolute path to the workspace directory')
  .option('--workflow <id>', 'Workflow ID to run (overrides adaptive routing)')
  .option('--pr <n>', 'PR number to review (dispatches wr.mr-review)', (v) => parseInt(v, 10))
  .option('--wait', 'Block until session completes. Exit 0=success, 1=failure, 2=timeout')
  .option('--json', 'Machine-readable JSON output (session ID, outcome when --wait)')
  .option('--timeout <duration>', 'Wait timeout, e.g. "30m", "1h". Default: 30m', '30m')
  .option('-p, --port <n>', 'Override daemon HTTP port', parseInt)
  .action(async (task: string | undefined, options: { workspace?: string; workflow?: string; pr?: number; wait?: boolean; json?: boolean; timeout?: string; port?: number }) => {
    const { executeWorktrainDispatchCommand } = await import('./cli/commands/worktrain-dispatch.js');

    if (!options.workspace) {
      process.stderr.write('Error: -w/--workspace is required\n');
      process.exit(1);
    }

    const timeoutMs = parseTimeoutDuration(options.timeout ?? '30m');

    const result = await executeWorktrainDispatchCommand(
      {
        fetch: (url, opts) => globalThis.fetch(url, opts) as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
        readFile: async (p: string) => { try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; } },
        stdout: (line: string) => process.stdout.write(line + '\n'),
        stderr: (line: string) => process.stderr.write(line + '\n'),
        homedir: os.homedir,
        joinPath: path.join,
        pathIsAbsolute: path.isAbsolute,
        statPath: (p: string) => fs.promises.stat(p),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      {
        task,
        workflow: options.workflow,
        pr: options.pr,
        workspace: options.workspace,
        wait: options.wait,
        json: options.json,
        port: options.port,
        timeoutMs,
      },
    );

    // Handle exit 2 for --wait timeout (session timed out waiting for terminal event).
    // WHY special-case: CliResult has no exit-code field; the __exit2__ sentinel is the
    // minimal way to distinguish "session failed" (exit 1) from "gave up waiting" (exit 2).
    if (result.kind === 'failure' && typeof result.output?.message === 'string' && result.output.message.startsWith('__exit2__')) {
      process.stderr.write(result.output.message.replace('__exit2__ ', '') + '\n');
      process.exit(2);
    }
    interpretCliResultWithoutDI(result);
  });

// Migration shims for removed health and status commands.
// Both now point to `worktrain diagnose` which absorbs their functionality.
program.addCommand(
  new Command('health')
    .description('(removed)')
    .argument('<sessionId>', 'session ID')
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(
        "'worktrain health' was removed. Use 'worktrain diagnose <sessionId>' instead.\n" +
        'Example: worktrain diagnose abc123\n',
      );
      process.exit(1);
    }),
  { hidden: true },
);

program.addCommand(
  new Command('status')
    .description('(removed)')
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(
        "'worktrain status' was removed. Use 'worktrain diagnose' for fleet summary or 'worktrain diagnose <id>' for a specific session.\n",
      );
      process.exit(1);
    }),
  { hidden: true },
);

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
// REPORT COMMAND
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('report')
  .description(
    'Generate a machine-readable JSON report of session history and metrics.\n' +
    'All progress goes to stderr. stdout is always valid JSON.\n' +
    'Covers at most 500 most-recently-modified sessions.\n' +
    'Use --schedule daily|weekly to install an automatic recurring report.',
  )
  .option('--days <n>', 'Sessions modified in the last N days (default: 30)', parseInt)
  .option('--since <date>', 'Override start date (YYYY-MM-DD)')
  .option('--until <date>', 'Override end date (YYYY-MM-DD, default: today)')
  .option('--out <file>', 'Write output to this file instead of stdout')
  .addOption(
    new Option('--format <fmt>', 'Output format (default: ndjson)')
      .choices(['ndjson', 'json', 'summary', 'csv'])
      .default('ndjson'),
  )
  .addOption(
    new Option('--schedule <frequency>', 'Install a recurring schedule (mutually exclusive with report output)')
      .choices(['daily', 'weekly']),
  )
  .action(async (options: { days?: number; since?: string; until?: string; out?: string; format?: string; schedule?: string }) => {
    // --schedule mode: install launchd plist or crontab, then exit.
    // Mutually exclusive with JSON report output.
    if (options.schedule !== undefined) {
      const { installReportSchedule } = await import('./cli/commands/worktrain-report-schedule.js');
      const frequency = options.schedule as 'daily' | 'weekly';

      const result = await installReportSchedule(
        {
          platform: process.platform,
          worktrainBinPath: process.argv[1] ?? 'worktrain',
          nodeBinPath: process.execPath,
          homedir: os.homedir,
          joinPath: path.join,
          writeFile: async (filePath: string, content: string) => {
            await fs.promises.writeFile(filePath, content, 'utf-8');
          },
          mkdir: async (dirPath: string) => {
            await fs.promises.mkdir(dirPath, { recursive: true });
          },
          exec: async (command: string, args: string[]) => {
            try {
              const { stdout, stderr } = await execFileAsync(command, args, { encoding: 'utf-8' });
              return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
            } catch (err: unknown) {
              const e = err as { stdout?: string; stderr?: string; code?: number };
              return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: typeof e.code === 'number' ? e.code : 1 };
            }
          },
          print: (line: string) => process.stdout.write(line + '\n'),
          printErr: (line: string) => process.stderr.write(line + '\n'),
        },
        frequency,
      );

      if (result.kind === 'ok') {
        process.stdout.write(result.detail + '\n');
      } else {
        process.stderr.write(`[report] Schedule install failed: ${result.message}\n`);
        process.exit(1);
      }
      return;
    }

    // Report mode: generate JSON.
    const { executeWorktrainReportCommand, buildWorktrainReportCommandDeps } =
      await import('./cli/commands/worktrain-report.js');

    const deps = buildWorktrainReportCommandDeps();
    await executeWorktrainReportCommand(deps, {
      days: options.days,
      since: options.since,
      until: options.until,
      out: options.out,
      format: options.format as import('./cli/commands/worktrain-report.js').ReportFormat | undefined,
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
