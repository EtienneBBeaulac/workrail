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

async function main() {
  // Initialize DI container
  await bootstrap();
  
  // Resolve workflow service
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
  
  // Create and start the RPC server
  const server = createWorkflowLookupServer(workflowService);
  await server.start();
  
  console.error('Workflow Orchestration MCP Server running on stdio');
  
  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
