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
import {
  executeWorktrainInitCommand,
  executeWorktrainTellCommand,
  executeWorktrainInboxCommand,
  executeWorktrainSpawnCommand,
  executeWorktrainAwaitCommand,
  executeWorktrainDaemonCommand,
  executeWorktrainOverviewCommand,
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
          // This is the launchd entry point: `worktrain daemon` with no flags.
          // Run the same startup logic as `workrail daemon`.
          const { startTriggerListener } = await import('./trigger/trigger-listener.js');
          const { startDaemonConsole } = await import('./trigger/daemon-console.js');
          const { DaemonEventEmitter } = await import('./daemon/daemon-events.js');
          const { initializeContainer, container } = await import('./di/container.js');
          const { DI } = await import('./di/tokens.js');

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

          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const pkg = require('../package.json') as { version: string };

          // Resolve workflowService from the DI container.
          type WorkflowService = import('./application/services/workflow-service.js').WorkflowService;
          const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);

          const consoleResult = await startDaemonConsole(ctx, {
            triggerRouter: handle.router,
            serverVersion: pkg.version,
            workflowService,
          });

          let consoleHandle: import('./trigger/daemon-console.js').DaemonConsoleHandle | null = null;
          if (consoleResult.kind === 'ok') {
            consoleHandle = consoleResult.value;
          } else if (consoleResult.error.kind === 'port_conflict') {
            console.warn(
              `[DaemonConsole] Port ${consoleResult.error.port} is already held. ` +
              `The daemon is running but the console is unavailable.`,
            );
          } else {
            console.warn(`[DaemonConsole] Could not start console: ${consoleResult.error.message}`);
          }

          // Keep alive until SIGINT/SIGTERM.
          await new Promise<void>((resolve) => {
            const shutdown = async () => {
              console.log('\nShutting down daemon...');
              if (consoleHandle) {
                await consoleHandle.stop();
              }
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

program
  .command('logs')
  .description('Read and display the WorkRail daemon event log. Use --follow to stream new events in real time.')
  .option('--follow', 'Continuously poll the log file for new events (like tail -f)')
  .option('--session <id>', 'Filter events by sessionId (UUID prefix) or workrailSessionId (sess_xxx prefix)')
  .action(async (options: { follow?: boolean; session?: string }) => {
    const eventsDir = path.join(os.homedir(), '.workrail', 'events', 'daemon');

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
     * Print a set of raw JSONL lines, applying the session filter if set.
     */
    function printLines(lines: string[]): void {
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

    const filePath = todayFilePath();

    if (!options.follow) {
      // One-shot: read the file and exit.
      const result = readNewLines(filePath, 0);
      if (result === null) {
        process.stdout.write(`No events yet. Is the daemon running? (Expected: ${filePath})\n`);
        return;
      }
      printLines(result.lines);
      return;
    }

    // --follow mode: print existing lines then poll for new ones.
    // Start at offset 0 to show all existing events, then track the byte position.
    // WHY explicit SIGINT handler: makes Ctrl-C clean exit explicit rather than
    // relying on Node's default SIGINT behavior inside the polling loop.
    process.once('SIGINT', () => process.exit(0));

    let currentFilePath = filePath;
    let offset = 0;

    // Print all existing lines first.
    const initial = readNewLines(currentFilePath, 0);
    if (initial !== null) {
      printLines(initial.lines);
      offset = initial.newOffset;
    } else {
      process.stdout.write(`Waiting for events... (${currentFilePath})\n`);
    }

    // Poll every 500ms for new lines.
    // Handles midnight rotation: recompute file path on each iteration.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      const newFilePath = todayFilePath();
      if (newFilePath !== currentFilePath) {
        // Day rolled over -- switch to the new file from the beginning.
        currentFilePath = newFilePath;
        offset = 0;
      }

      const result = readNewLines(currentFilePath, offset);
      if (result !== null && result.lines.length > 0) {
        printLines(result.lines);
        offset = result.newOffset;
      } else if (result !== null) {
        offset = result.newOffset; // Update offset even if no new lines.
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

      // Delegate to the same inline logic as the health command.
      // WHY duplicate instead of extract: the health command body is intentionally
      // inline in this composition root. Extracting for one shim would be premature.
      // The shim is expected to be removed once all callers migrate to `health`.
      process.stdout.write(`\nNote: This is the old \`worktrain status <id>\` output. Use \`worktrain health <id>\` instead.\n\n`);

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
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
