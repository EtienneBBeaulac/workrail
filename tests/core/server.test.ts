/**
 * @jest-environment node
 */
import { createWorkflowLookupServer } from '../../src/infrastructure/rpc/server';
import { WorkflowService } from '../../src/application/services/workflow-service';
import { describe, vi, it, expect, jest } from 'vitest';

describe('WorkflowLookupServer', () => {
  it('should create a server instance', () => {
    const mockService: WorkflowService = {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => ({ step: null, guidance: { prompt: '' }, isComplete: true }),
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] })
    };
    const server = createWorkflowLookupServer(mockService);
    expect(server).toBeDefined();
    expect(typeof server.start).toBe('function');
    expect(typeof server.stop).toBe('function');
  });

  it('should start and stop without errors', async () => {
    const mockService: WorkflowService = {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => ({ step: null, guidance: { prompt: '' }, isComplete: true }),
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] })
    };
    const server = createWorkflowLookupServer(mockService);
    
    // Mock console.log to avoid output during tests
    const originalLog = console.log;
    console.log = vi.fn();
    
    try {
      await server.start();
      await server.stop();
      
      expect(console.log).toHaveBeenCalledWith('Initializing Workflow Lookup MCP Server...');
      expect(console.log).toHaveBeenCalledWith('Server ready to accept JSON-RPC requests');
      expect(console.log).toHaveBeenCalledWith('Shutting down Workflow Lookup MCP Server...');
      expect(console.log).toHaveBeenCalledWith('Server stopped');
    } finally {
      console.log = originalLog;
    }
  });
}); 