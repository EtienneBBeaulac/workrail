import { MCPShutdownRequest, MCPShutdownResponse } from '../types/mcp-types';

export async function shutdownHandler(
  request: MCPShutdownRequest
): Promise<MCPShutdownResponse> {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: null
  };
} 