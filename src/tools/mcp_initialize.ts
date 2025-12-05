import { MCPInitializeRequest, MCPInitializeResponse, MCPErrorCodes } from '../types/mcp-types';
import { MCPError } from '../core/error-handler';

// Supported MCP protocol versions
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05'];

export async function initializeHandler(
  request: MCPInitializeRequest
): Promise<MCPInitializeResponse> {
  // Validate required parameters
  if (!request.params) {
    throw new MCPError(
      MCPErrorCodes.INVALID_PARAMS,
      'Invalid params: params object is required'
    );
  }

  const { protocolVersion, capabilities } = request.params;

  // Validate protocolVersion is provided
  if (!protocolVersion) {
    throw new MCPError(
      MCPErrorCodes.INVALID_PARAMS,
      'Invalid params: protocolVersion is required'
    );
  }

  // Validate capabilities is provided
  if (!capabilities) {
    throw new MCPError(
      MCPErrorCodes.INVALID_PARAMS,
      'Invalid params: capabilities is required'
    );
  }

  // Validate protocol version is supported
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    throw new MCPError(
      MCPErrorCodes.SERVER_ERROR,
      'Unsupported protocol version',
      {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        requestedVersion: protocolVersion
      }
    );
  }

  // Return successful initialization response
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: protocolVersion,
      capabilities: {
        tools: {
          listChanged: false, // Tools are static - never change
          notifyProgress: false
        },
        resources: {
          listChanged: false // No resources supported
        }
      },
      serverInfo: {
        name: 'workflow-lookup',
        version: '1.0.0',
        description: 'MCP server for workflow orchestration and guidance'
      }
    }
  };
} 