import { specTypeSchemas, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import type { McpCallToolResult } from './types/workflow-tool-edition.js';

/** Validate generated definitions once at the SDK boundary, preserving union constraints. */
export function toSdkTool(tool: { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>>; readonly annotations?: unknown }): Tool & { description: string } {
  const result = specTypeSchemas.Tool['~standard'].validate({
    ...tool,
    inputSchema: { type: 'object', ...tool.inputSchema },
  });
  if (result.issues) throw new Error('Invalid MCP tool schema: ' + tool.name);
  return { ...result.value, description: tool.description };
}

/** The SDK owns mutable wire arrays; domain results remain immutable. */
export function toSdkCallResult(result: McpCallToolResult): CallToolResult {
  return { ...result, content: result.content.map(item => ({ ...item })) };
}
