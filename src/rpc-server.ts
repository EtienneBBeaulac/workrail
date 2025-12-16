#!/usr/bin/env node

/**
 * Traditional JSON-RPC server entry point for contract testing.
 * This provides a pure JSON-RPC interface (not MCP tools/call pattern).
 */

import 'reflect-metadata';
import { bootstrap, container } from './di/container.js';
import { DI } from './di/tokens.js';
import { WorkflowService } from './application/services/workflow-service.js';
import { createWorkflowLookupServer } from './infrastructure/rpc/server.js';
import type { ShutdownEvents } from './runtime/ports/shutdown-events.js';
import type { ProcessSignals } from './runtime/ports/process-signals.js';
import type { ProcessTerminator } from './runtime/ports/process-terminator.js';

async function main() {
  // Initialize DI container
  await bootstrap({ runtimeMode: { kind: 'rpc' } });
  
  // Resolve workflow service
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
  
  // Create and start the RPC server
  const server = createWorkflowLookupServer(workflowService);
  await server.start();
  
  console.error('Workflow Orchestration MCP Server running on stdio');
  
  // Composition-root shutdown handling (explicit + typed)
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const processSignals = container.resolve<ProcessSignals>(DI.Runtime.ProcessSignals);
  const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

  processSignals.on('SIGINT', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' }));
  processSignals.on('SIGTERM', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' }));
  processSignals.on('SIGHUP', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' }));

  let shutdownStarted = false;
  shutdownEvents.onShutdown((_event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    void (async () => {
      try {
        await server.stop();
        terminator.terminate({ kind: 'success' });
      } catch (err) {
        console.error('[Shutdown] Error while stopping RPC server:', err);
        terminator.terminate({ kind: 'failure' });
      }
    })();
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
