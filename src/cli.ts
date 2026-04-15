#!/usr/bin/env node
/**
 * WorkRail CLI - Composition Root
 *
 * This is a thin composition root that:
 * 1. Wires dependencies for each command
 * 2. Interprets CliResult into process termination
 * 3. Contains NO business logic
 *
 * All business logic lives in src/cli/commands/*.ts
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initializeContainer, container } from './di/container.js';
import { DI } from './di/tokens.js';
import type { WorkflowService } from './application/services/workflow-service.js';
import type { ValidationEngine } from './application/services/validation-engine.js';
import type { HttpServer } from './infrastructure/session/HttpServer.js';
import type { ProcessTerminator } from './runtime/ports/process-terminator.js';
import { startStdioServer } from './mcp/transports/stdio-entry.js';
import type { WorkflowDefinition } from './types/workflow.js';
import { createWorkflow, createCustomDirectorySource } from './types/workflow.js';
import { validateWorkflow as schemaValidate, validateWorkflowSchema } from './application/validation.js';
import { createValidateWorkflowFileUseCasePipeline } from './application/use-cases/validate-workflow-file.js';
import { WorkflowCompiler } from './application/services/workflow-compiler.js';
import { normalizeV1WorkflowToPinnedSnapshot } from './v2/read-only/v1-to-v2-shim.js';

import { interpretCliResult, interpretCliResultWithoutDI } from './cli/interpret-result.js';
import { printResult } from './cli/output-formatter.js';
import {
  executeInitCommand,
  executeInitConfigCommand,
  executeSourcesCommand,
  executeListCommand,
  executeValidateCommand,
  executeStartCommand,
  executeCleanupCommand,
  executeMigrateCommand,
} from './cli/commands/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM DEFINITION
// ═══════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name('workrail')
  .description('MCP server for workflow orchestration and guidance')
  .version('0.0.3');

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS WITHOUT DI (pure filesystem operations)
// ═══════════════════════════════════════════════════════════════════════════

program
  .command('init')
  .description('Initialize user workflow directory with sample workflows')
  .option('--config', 'Write a ~/.workrail/config.json template instead of initializing workflows')
  .action(async (options: { config?: boolean }) => {
    if (options.config) {
      const result = await executeInitConfigCommand({
        mkdir: (p, opts) => fs.promises.mkdir(p, opts),
        readFile: (p) => fs.promises.readFile(p, 'utf-8'),
        writeFile: (p, content) => fs.promises.writeFile(p, content, 'utf-8'),
        homedir: os.homedir,
        joinPath: path.join,
      });
      interpretCliResultWithoutDI(result);
      return;
    }

    const result = await executeInitCommand({
      mkdir: (p, opts) => fs.promises.mkdir(p, opts),
      readdir: (p) => fs.promises.readdir(p),
      writeFile: (p, content) => fs.promises.writeFile(p, content, 'utf-8'),
      homedir: os.homedir,
      joinPath: path.join,
    });

    interpretCliResultWithoutDI(result);
  });

program
  .command('sources')
  .description('Show workflow directory sources and their status')
  .action(() => {
    const result = executeSourcesCommand({
      resolvePath: path.resolve,
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      homedir: os.homedir,
      cwd: process.cwd,
      dirname: __dirname,
      pathDelimiter: path.delimiter,
      env: process.env,
    });

    interpretCliResultWithoutDI(result);
  });

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS WITH DI (need services)
// ═════════════════════���═════════════════════════════════════════════════════

program
  .command('list')
  .description('List all available workflows from all sources')
  .option('-v, --verbose', 'Show detailed information including sources')
  .action(async (options) => {
    await initializeContainer({ runtimeMode: { kind: 'cli' } });

    const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);
    const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);

    const result = await executeListCommand(
      { listWorkflowSummaries: () => workflowService.listWorkflowSummaries() },
      { verbose: options.verbose }
    );

    interpretCliResult(result, terminator);
  });

program
  .command('validate <file>')
  .description('Validate a workflow file against the schema')
  .action(async (filePath: string) => {
    await initializeContainer({ runtimeMode: { kind: 'cli' } });

    const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);
    const validationEngine = container.resolve<ValidationEngine>(DI.Infra.ValidationEngine);

    const compiler = new WorkflowCompiler();
    const validateWorkflowFile = createValidateWorkflowFileUseCasePipeline({
      resolvePath: path.resolve,
      existsSync: fs.existsSync,
      readFileSyncUtf8: (resolvedPath: string) => fs.readFileSync(resolvedPath, 'utf-8'),
      parseJson: (content: string) => JSON.parse(content),
      schemaValidate: (definition: WorkflowDefinition) => schemaValidate(definition),
      makeRuntimeWorkflow: (definition: WorkflowDefinition, resolvedPath: string) =>
        createWorkflow(definition, createCustomDirectorySource(path.dirname(resolvedPath), 'CLI Validate')),
      validateRuntimeWorkflow: (workflow) => validationEngine.validateWorkflow(workflow),
      validationPipelineDeps: {
        schemaValidate: validateWorkflowSchema,
        structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
        compiler,
        normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
      },
    });

    const result = executeValidateCommand(filePath, { validateWorkflowFile });

    interpretCliResult(result, terminator);
  });

program
  .command('migrate <file>')
  .description('Migrate a workflow from v0.0.1 to v0.1.0')
  .option('-o, --output <path>', 'Output file path (defaults to input file)')
  .option('-d, --dry-run', 'Show what would be changed without modifying files')
  .option('-b, --backup', 'Create a backup when overwriting the input file')
  .action(async (filePath: string, options: { output?: string; dryRun?: boolean; backup?: boolean }) => {
    // Migrate command doesn't need full DI, but we use it for consistent termination
    await initializeContainer({ runtimeMode: { kind: 'cli' } });

    const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

    const result = await executeMigrateCommand(
      filePath,
      {
        output: options.output,
        dryRun: options.dryRun,
        backup: options.backup,
      },
      {
        readFile: (p) => fs.promises.readFile(p, 'utf-8'),
        writeFile: (p, content) => fs.promises.writeFile(p, content, 'utf-8'),
        copyFile: (src, dest) => fs.promises.copyFile(src, dest),
      }
    );

    interpretCliResult(result, terminator);
  });

program
  .command('start')
  .description('Start the MCP server')
  .action(async () => {
    await initializeContainer({ runtimeMode: { kind: 'cli' } });

    const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

    const result = await executeStartCommand({
      createServer: () => ({ start: () => startStdioServer() }),
    });

    // Note: In normal operation, the server keeps running and we don't reach here.
    // This only executes if the server fails to start.
    interpretCliResult(result, terminator);
  });

program
  .command('cleanup')
  .description('Clean up orphaned workrail processes and free up ports')
  .option('-f, --force', 'Force cleanup without confirmation')
  .action(async (options: { force?: boolean }) => {
    // Show warning unless force flag is set
    if (!options.force) {
      console.error('⚠️  This will terminate all workrail dashboard processes');
      console.error('   Press Ctrl+C to cancel, or wait 3 seconds to continue...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    await initializeContainer({ runtimeMode: { kind: 'cli' } });

    const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);
    const httpServer = container.resolve<HttpServer>(DI.Infra.HttpServer);

    const result = await executeCleanupCommand({
      fullCleanup: () => httpServer.fullCleanup(),
    });

    interpretCliResult(result, terminator);
  });

program
  .command('daemon')
  .description('Start the autonomous WorkRail daemon (trigger webhook server on port 3200)')
  .option('-w, --workspace <path>', 'Path to workspace containing triggers.yml', process.cwd())
  .action(async (options: { workspace: string }) => {
    const { startTriggerListener } = await import('./trigger/trigger-listener.js');

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

    const handle = await startTriggerListener(ctx, {
      workspacePath: options.workspace,
      apiKey: process.env['ANTHROPIC_API_KEY'],
      env: process.env,
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
    console.log(`Workspace: ${options.workspace}`);
    console.log('Waiting for webhook triggers...');

    // ---- Crash recovery: log any orphaned sessions from a previous daemon crash ----
    // Sessions that were in-flight when the daemon last crashed leave state files in
    // DAEMON_SESSIONS_DIR. We log their IDs here so operators can investigate.
    // Full resume is a follow-up -- the important invariant is that state is per-session
    // and not clobbered by concurrent or new sessions.
    try {
      const { readdir } = await import('node:fs/promises');
      const { DAEMON_SESSIONS_DIR } = await import('./daemon/workflow-runner.js');
      const entries = await readdir(DAEMON_SESSIONS_DIR).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [] as string[];
        throw err;
      });
      const orphanIds = entries
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .map((f) => f.slice(0, -5)); // strip .json
      if (orphanIds.length > 0) {
        console.log(
          `[Daemon] Found ${orphanIds.length} orphaned session(s) from previous run:`,
          orphanIds,
        );
        console.log('[Daemon] Full session resume is not yet implemented. These sessions did not complete.');
      }
    } catch (err) {
      // Non-fatal: crash recovery scan failure should not prevent the daemon from starting.
      console.warn('[Daemon] Could not scan for orphaned sessions:', err);
    }

    // Keep alive
    const shutdown = async () => {
      console.log('\nShutting down daemon...');
      await handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

program.parse();
