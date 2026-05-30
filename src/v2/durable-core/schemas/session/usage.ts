/**
 * ClientUsage: summed token usage for a single MCP session as reported by one client.
 *
 * This type is the domain-level representation of the data in `usage_recorded` events.
 * It is defined here (in durable-core) so that both the projections layer and the MCP
 * client-usage module can reference it without creating cross-boundary imports.
 *
 * WHY here and not in mcp/client-usage/: projections/session-metrics.ts must not import
 * from the MCP layer (architecture lock: projections are internal-only). Defining the
 * shared type in durable-core makes it accessible to both sides.
 */

/**
 * Summed token usage for a single MCP session as reported by one MCP client.
 *
 * All token counts are non-negative integers. model is nullable because
 * client logs may not record the model for every turn.
 */
export type ClientUsage = {
  readonly client: string;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly turns: number;
};
