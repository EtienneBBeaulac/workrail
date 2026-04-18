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
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
