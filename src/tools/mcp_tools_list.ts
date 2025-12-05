import { MCPToolsListRequest, MCPToolsListResponse, MCPTool } from '../types/mcp-types';

const tools: MCPTool[] = [
  {
    name: 'workflow_list',
    description: 'List all available workflows',
    inputSchema: {}
  },
  {
    name: 'workflow_get',
    description: 'Retrieve a workflow by id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'workflow_next',
    description: 'Get guidance for the next step of a workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        completedSteps: { type: 'array', items: { type: 'string' } },
        context: { 
          type: 'object', 
          description: 'Optional execution context for evaluating step conditions',
          additionalProperties: true
        }
      },
      required: ['workflowId', 'completedSteps']
    }
  },
  {
    name: 'workflow_validate',
    description: 'Validate output for a workflow step',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        stepId: { type: 'string' },
        output: { type: 'string' }
      },
      required: ['workflowId', 'stepId', 'output']
    }
  }
];

export async function toolsListHandler(
  request: MCPToolsListRequest
): Promise<MCPToolsListResponse> {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      tools
    }
  };
} 