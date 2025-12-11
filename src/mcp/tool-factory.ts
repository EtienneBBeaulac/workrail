/**
 * Tool Factory
 *
 * Higher-order function that creates tool builders with injected descriptions.
 * Separates tool structure (static) from descriptions (dynamic).
 *
 * @module mcp/tool-factory
 */

import type { z } from 'zod';
import type { IToolDescriptionProvider } from './tool-description-provider.js';
import type { WorkflowToolName } from './types/tool-description-types.js';

/**
 * Tool annotation hints for MCP clients.
 */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

/**
 * Complete tool definition structure.
 */
export interface ToolDefinition<TInput extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly annotations: ToolAnnotations;
}

/**
 * Configuration for building a tool (everything except description).
 *
 * The `name` field is constrained to WorkflowToolName to ensure
 * compile-time safety: only valid tool names can be used.
 */
export interface ToolConfig<TInput extends z.ZodType> {
  readonly name: WorkflowToolName;
  readonly title: string;
  readonly inputSchema: TInput;
  readonly annotations: ToolAnnotations;
}

/**
 * Tool builder function type.
 */
export type ToolBuilder = <TInput extends z.ZodType>(
  config: ToolConfig<TInput>
) => ToolDefinition<TInput>;

/**
 * Create a tool factory with injected description provider.
 *
 * This is a higher-order function that returns a tool builder.
 * The builder creates complete tool definitions by combining
 * the provided config with descriptions from the provider.
 *
 * @example
 * ```typescript
 * const buildTool = createToolFactory(descriptionProvider);
 *
 * const listTool = buildTool({
 *   name: 'workflow_list',
 *   title: 'List Available Workflows',
 *   inputSchema: WorkflowListInput,
 *   annotations: { readOnlyHint: true },
 * });
 * ```
 *
 * @param descriptionProvider - Source for tool descriptions
 * @returns Tool builder function
 */
export function createToolFactory(
  descriptionProvider: IToolDescriptionProvider
): ToolBuilder {
  return function buildTool<TInput extends z.ZodType>(
    config: ToolConfig<TInput>
  ): ToolDefinition<TInput> {
    return {
      name: config.name,
      title: config.title,
      description: descriptionProvider.getDescription(config.name),
      inputSchema: config.inputSchema,
      annotations: config.annotations,
    };
  };
}
