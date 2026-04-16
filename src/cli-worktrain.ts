#!/usr/bin/env node
/**
 * WorkTrain CLI - Composition Root
 *
 * Entry point for the `worktrain` binary. Thin composition root:
 * 1. Wires dependencies for the init command
 * 2. Interprets CliResult into process termination
 * 3. Contains NO business logic
 *
 * All business logic lives in src/cli/commands/worktrain-init.ts
 *
 * Process lifecycle note:
 * readline.createInterface() keeps the Node.js event loop alive until rl.close()
 * is called. The try/finally block below guarantees closure even on errors, so
 * the process exits cleanly after the command completes.
 */

import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output, env } from 'process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { interpretCliResultWithoutDI } from './cli/interpret-result.js';
import { executeWorktainInitCommand } from './cli/commands/index.js';

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
      const result = await executeWorktainInitCommand(
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
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
