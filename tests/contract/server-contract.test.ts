// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { RpcClient } from '../helpers/rpc-client';
import { responseValidator } from '../../src/validation/response-validator';

describe('MCP Server JSON-RPC contract', () => {
  // Use RPC server (traditional JSON-RPC) instead of MCP server (tools/call pattern)
  const SERVER_PATH = path.resolve(__dirname, '../../src/rpc-server.ts');
  const SAMPLE_ID = 'coding-task-workflow-with-loops';

  let client: RpcClient;

  beforeAll(() => {
    client = new RpcClient(SERVER_PATH);
  });

  afterAll(async () => {
    await client.close();
  });

  it('responds to workflow_list', async () => {
    const res = await client.send('workflow_list');
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result).toBeDefined();
    try {
      responseValidator.validate('workflow_list', res.result);
    } catch (err) {
      // Debug print to understand schema mismatch
      console.error('workflow_list result (debug):', JSON.stringify(res.result, null, 2));
      throw err;
    }
    expect(Array.isArray(res.result.workflows)).toBe(true);
  });

  it('returns a workflow with workflow_get', async () => {
    const res = await client.send('workflow_get', { id: SAMPLE_ID });
    expect(res.result).toBeDefined();
    expect(res.result.id).toBe(SAMPLE_ID);
    responseValidator.validate('workflow_get', res.result);
  });

  it('gives next step via workflow_next', async () => {
    const res = await client.send('workflow_next', { workflowId: SAMPLE_ID, completedSteps: [] });
    responseValidator.validate('workflow_next', res.result);
    expect(res.result.step).not.toBeNull();
    expect(res.result.isComplete).toBe(false);
  });

  it('returns METHOD_NOT_FOUND error for unknown method', async () => {
    const res = await client.send('unknown_method');
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
  });

  it('returns INVALID_PARAMS for bad params', async () => {
    const res = await client.send('workflow_get', {});
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
  });

  it('handles initialize handshake', async () => {
    const res = await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    expect(res.result.serverInfo).toBeDefined();
    expect(res.result.serverInfo.name).toBeDefined();
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.capabilities.tools.listChanged).toBe(false);
  });

  it('rejects unsupported protocol version', async () => {
    const res = await client.send('initialize', { protocolVersion: '1.0', capabilities: {} });
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32000);
    expect(res.error.message).toBe('Unsupported protocol version');
    expect(res.error.data.supportedVersions).toEqual(['2024-11-05']);
  });

  it('rejects initialize with missing protocolVersion', async () => {
    const res = await client.send('initialize', { capabilities: {} });
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toBe('Invalid params: protocolVersion is required');
  });

  it('shutdown returns null', async () => {
    const res = await client.send('shutdown', {});
    expect(res.result).toBeNull();
  });

  describe('workflow_validate endpoint', () => {
    it('validates valid step output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: 'I have analyzed the current authentication setup and found no existing authentication implementation.'
      });
      
      expect(res.jsonrpc).toBe('2.0');
      expect(res.result).toBeDefined();
      responseValidator.validate('workflow_validate', res.result);
      expect(typeof res.result.valid).toBe('boolean');
      // Issues and suggestions can be undefined or empty arrays
      if (res.result.issues !== undefined) {
        expect(Array.isArray(res.result.issues)).toBe(true);
      }
      if (res.result.suggestions !== undefined) {
        expect(Array.isArray(res.result.suggestions)).toBe(true);
      }
    });

    it('validates step output with issues', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: 'I created a simple function'
      });
      
      expect(res.jsonrpc).toBe('2.0');
      expect(res.result).toBeDefined();
      responseValidator.validate('workflow_validate', res.result);
      expect(typeof res.result.valid).toBe('boolean');
      if (res.result.issues) {
        expect(Array.isArray(res.result.issues)).toBe(true);
      }
      if (res.result.suggestions) {
        expect(Array.isArray(res.result.suggestions)).toBe(true);
      }
    });

    it('validates comprehensive step output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: 'I implemented a POST /auth/login endpoint that accepts email and password, validates credentials using bcrypt, queries the user from the database, and returns a JWT token signed with the secret from environment variables.'
      });
      
      expect(res.jsonrpc).toBe('2.0');
      expect(res.result).toBeDefined();
      responseValidator.validate('workflow_validate', res.result);
      expect(typeof res.result.valid).toBe('boolean');
    });

    it('returns INVALID_PARAMS for missing workflowId', async () => {
      const res = await client.send('workflow_validate', {
        stepId: 'phase-0-intelligent-triage',
        output: 'Some output'
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('returns INVALID_PARAMS for missing stepId', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        output: 'Some output'
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('returns INVALID_PARAMS for missing output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage'
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('returns INVALID_PARAMS for invalid workflowId format', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'invalid@workflow!id',
        stepId: 'phase-0-intelligent-triage',
        output: 'Some output'
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('returns INVALID_PARAMS for invalid stepId format', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'invalid@step!id',
        output: 'Some output'
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('returns INVALID_PARAMS for output exceeding maxLength', async () => {
      const longOutput = 'a'.repeat(10001); // Exceeds 10000 char limit
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: longOutput
      });
      
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toBe('Invalid params');
    });

    it('handles non-existent workflow gracefully', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'non-existent-workflow',
        stepId: 'some-step',
        output: 'Some output'
      });
      
      // Should return a proper response, not an error
      expect(res.jsonrpc).toBe('2.0');
      if (res.result) {
        responseValidator.validate('workflow_validate', res.result);
      }
    });

    it('handles non-existent step gracefully', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'non-existent-step',
        output: 'Some output'
      });
      
      // Should return a proper response, not an error
      expect(res.jsonrpc).toBe('2.0');
      if (res.result) {
        responseValidator.validate('workflow_validate', res.result);
      }
    });

    it('handles empty output string', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: ''
      });
      
      expect(res.jsonrpc).toBe('2.0');
      expect(res.result).toBeDefined();
      responseValidator.validate('workflow_validate', res.result);
      expect(typeof res.result.valid).toBe('boolean');
    });

    it('handles whitespace-only output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: SAMPLE_ID,
        stepId: 'phase-0-intelligent-triage',
        output: '   \n\t  '
      });
      
      expect(res.jsonrpc).toBe('2.0');
      expect(res.result).toBeDefined();
      responseValidator.validate('workflow_validate', res.result);
      expect(typeof res.result.valid).toBe('boolean');
    });
  });
}); 