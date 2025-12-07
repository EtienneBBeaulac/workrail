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
import type { ILoggerFactory } from './core/logging/index.js';

async function main() {
  // Initialize DI container
  await bootstrap();
  
  // Resolve dependencies
  const workflowService = container.resolve<WorkflowService>(DI.Services.Workflow);
  const loggerFactory = container.resolve<ILoggerFactory>(DI.Logging.Factory);
  const logger = loggerFactory.create('RpcServer');
  
  // Create and start the RPC server
  const server = createWorkflowLookupServer(workflowService);
  await server.start();
  
  logger.info('Workflow Orchestration MCP Server running on stdio');
  
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
  // Use bootstrap logger since DI may not be initialized
  const { getBootstrapLogger } = require('./core/logging/index.js');
  const logger = getBootstrapLogger();
  logger.fatal({ err: error }, 'Failed to start server');
  process.exit(1);
});
