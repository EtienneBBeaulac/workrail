import { WorkflowLookupServer } from '../../types/server';
import { WorkflowService } from '../../application/services/workflow-service';
import { buildWorkflowApplication } from '../../application/app';
import { requestValidator } from '../../validation/request-validator';
import { RpcHandler } from './handler';

export function createWorkflowLookupServer(
  workflowService: WorkflowService
): WorkflowLookupServer {
  let rpcHandler: RpcHandler | null = null;
  let running = false;

  return {
    start: async () => {
      if (running) return;
      console.log('Initializing Workflow Lookup MCP Server...');

      // Build mediator with current validator and services
      const mediator = buildWorkflowApplication(workflowService, requestValidator);

      // Create RPC handler bound to mediator.execute
      rpcHandler = new RpcHandler((method, params, _id) => mediator.execute(method, params));

      if (process.env['NODE_ENV'] !== 'test') {
        rpcHandler.start();
      }

      running = true;
      console.log('Server ready to accept JSON-RPC requests');
    },
    stop: async () => {
      if (!running) {
        console.log('Shutdown requested, but server is not running.');
        return;
      }
      console.log('Shutting down Workflow Lookup MCP Server...');
      if (rpcHandler) {
        rpcHandler.stop();
        rpcHandler = null;
      }
      running = false;
      console.log('Server stopped');
    }
  };
} 