/**
 * Workflow Tool Edition Types
 *
 * Discriminated union representing v1 XOR v2 workflow tool surfaces.
 * Illegal states (both v1 and v2 active) are unrepresentable by construction.
 *
 * Design principles:
 * - Make illegal states unrepresentable
 * - Explicit domain types over primitives (no boolean flags)
 * - Exhaustiveness via discriminated union
 * - Type-safe tool names via literal unions
 *
 * @module mcp/types/workflow-tool-edition
 */

import type { z } from 'zod';
import type { ToolDefinition } from '../tool-factory.js';
import type { ToolContext, ToolResult } from '../types.js';

// -----------------------------------------------------------------------------
// Tool Name Literal Unions (compile-time safety)
// -----------------------------------------------------------------------------

/**
 * V1 workflow tool names.
 * Adding/removing a name here forces updates to V1WorkflowHandlers.
 */
export type V1WorkflowToolName =
  | 'discover_workflows'
  | 'preview_workflow'
  | 'advance_workflow'
  | 'validate_workflow'
  | 'get_workflow_schema';

/**
 * V2 workflow tool names.
 * Adding/removing a name here forces updates to V2WorkflowHandlers.
 */
export type V2WorkflowToolName =
  | 'list_workflows'
  | 'inspect_workflow'
  | 'start_workflow'
  | 'continue_workflow'
  | 'checkpoint_workflow'
  | 'resume_session';

// -----------------------------------------------------------------------------
// Wrapped Handler Type
// -----------------------------------------------------------------------------

/**
 * MCP SDK result type (matches MCP SDK expectations).
 *
 * Note: Intentionally duplicated from @modelcontextprotocol/sdk to avoid coupling
 * registry modules to the SDK. The SDK is dynamically imported only at the server
 * composition root (server.ts). If the SDK's CallToolResult changes, update this
 * type to match.
 */
export type McpCallToolResult = {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
};

/**
 * A wrapped tool handler ready for MCP dispatch.
 *
 * This is the "boundary" type - handlers are pre-wrapped with schema validation
 * in the registries, so the dispatch layer just calls them directly.
 */
export type WrappedToolHandler = (
  args: unknown,
  ctx: ToolContext
) => Promise<McpCallToolResult>;

// -----------------------------------------------------------------------------
// Typed Handler Maps (exhaustive by construction)
// -----------------------------------------------------------------------------

/**
 * V1 workflow handlers mapped by tool name.
 * TypeScript ensures all V1 tool names have handlers.
 */
export type V1WorkflowHandlers = Readonly<Record<V1WorkflowToolName, WrappedToolHandler>>;

/**
 * V2 workflow handlers mapped by tool name.
 * TypeScript ensures all V2 tool names have handlers.
 */
export type V2WorkflowHandlers = Readonly<Record<V2WorkflowToolName, WrappedToolHandler>>;

// -----------------------------------------------------------------------------
// Discriminated Union: V1 XOR V2
// -----------------------------------------------------------------------------

/**
 * V1 workflow tool edition.
 */
export interface V1WorkflowToolEdition {
  readonly kind: 'v1';
  readonly tools: readonly ToolDefinition<z.ZodType>[];
  readonly handlers: V1WorkflowHandlers;
}

/**
 * V2 workflow tool edition.
 */
export interface V2WorkflowToolEdition {
  readonly kind: 'v2';
  readonly tools: readonly ToolDefinition<z.ZodType>[];
  readonly handlers: V2WorkflowHandlers;
}

/**
 * Discriminated union: exactly one of v1 or v2.
 *
 * Usage:
 * ```typescript
 * const edition = selectWorkflowToolEdition(flags, buildTool);
 * switch (edition.kind) {
 *   case 'v1': // TypeScript knows edition.handlers is V1WorkflowHandlers
 *   case 'v2': // TypeScript knows edition.handlers is V2WorkflowHandlers
 *   // Compiler error if a case is missing (exhaustiveness)
 * }
 * ```
 */
export type WorkflowToolEdition = V1WorkflowToolEdition | V2WorkflowToolEdition;

// -----------------------------------------------------------------------------
// Type Guards
// -----------------------------------------------------------------------------

export function isV1Edition(edition: WorkflowToolEdition): edition is V1WorkflowToolEdition {
  return edition.kind === 'v1';
}

export function isV2Edition(edition: WorkflowToolEdition): edition is V2WorkflowToolEdition {
  return edition.kind === 'v2';
}
