import { initializeHandler } from '../../src/tools/mcp_initialize';
import { MCPErrorCodes, MCPInitializeRequest } from '../../src/types/mcp-types';
import { MCPError } from '../../src/core/error-handler';
import { describe, it, expect } from 'vitest';

describe('initializeHandler', () => {
  describe('successful initialization', () => {
    it('should return successful response with correct protocol version', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} }
        }
      };

      const response = await initializeHandler(request);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe('2024-11-05');
      expect(response.result.capabilities.tools.listChanged).toBe(false);
      expect(response.result.capabilities.tools.notifyProgress).toBe(false);
      expect(response.result.capabilities.resources.listChanged).toBe(false);
      expect(response.result.serverInfo.name).toBe('workflow-lookup');
      expect(response.result.serverInfo.version).toBe('1.0.0');
    });

    it('should accept clientInfo when provided', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      };

      const response = await initializeHandler(request);
      expect(response.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('parameter validation', () => {
    it('should throw INVALID_PARAMS when params is missing', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize'
      } as MCPInitializeRequest;

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.INVALID_PARAMS,
        message: 'Invalid params: params object is required'
      });
    });

    it('should throw INVALID_PARAMS when protocolVersion is missing', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          capabilities: { tools: {} }
        } as any
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.INVALID_PARAMS,
        message: 'Invalid params: protocolVersion is required'
      });
    });

    it('should throw INVALID_PARAMS when capabilities is missing', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05'
        } as any
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.INVALID_PARAMS,
        message: 'Invalid params: capabilities is required'
      });
    });

    it('should throw INVALID_PARAMS when protocolVersion is empty string', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '',
          capabilities: { tools: {} }
        }
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.INVALID_PARAMS,
        message: 'Invalid params: protocolVersion is required'
      });
    });
  });

  describe('protocol version validation', () => {
    it('should throw SERVER_ERROR for unsupported protocol version', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '1.0',
          capabilities: { tools: {} }
        }
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.SERVER_ERROR,
        message: 'Unsupported protocol version',
        data: {
          supportedVersions: ['2024-11-05'],
          requestedVersion: '1.0'
        }
      });
    });

    it('should throw SERVER_ERROR for future protocol version', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-01-01',
          capabilities: { tools: {} }
        }
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.SERVER_ERROR,
        message: 'Unsupported protocol version',
        data: {
          supportedVersions: ['2024-11-05'],
          requestedVersion: '2025-01-01'
        }
      });
    });

    it('should throw SERVER_ERROR for malformed protocol version', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 'invalid-version',
          capabilities: { tools: {} }
        }
      };

      const promise = initializeHandler(request);
      await expect(promise).rejects.toThrow(MCPError);
      await expect(promise).rejects.toMatchObject({
        code: MCPErrorCodes.SERVER_ERROR,
        message: 'Unsupported protocol version',
        data: {
          supportedVersions: ['2024-11-05'],
          requestedVersion: 'invalid-version'
        }
      });
    });
  });

  describe('capabilities declaration', () => {
    it('should declare listChanged as false for tools', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} }
        }
      };

      const response = await initializeHandler(request);
      expect(response.result.capabilities.tools.listChanged).toBe(false);
    });

    it('should declare listChanged as false for resources', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} }
        }
      };

      const response = await initializeHandler(request);
      expect(response.result.capabilities.resources.listChanged).toBe(false);
    });

    it('should declare notifyProgress as false', async () => {
      const request: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} }
        }
      };

      const response = await initializeHandler(request);
      expect(response.result.capabilities.tools.notifyProgress).toBe(false);
    });
  });
}); 