/**
 * Workflow Tool Edition Selector
 *
 * Pure function that selects the active workflow tool edition.
 * Returns a discriminated union: v1 XOR v2, never both.
 *
 * Design principles:
 * - Make illegal states unrepresentable (union enforces exclusivity)
 * - Determinism: same flags always produce the same edition
 * - Pure function: no side effects
 *
 * @module mcp/workflow-tool-edition-selector
 */

import type { IFeatureFlagProvider } from '../config/feature-flags.js';
import type { ToolBuilder } from './tool-factory.js';
import type { WorkflowToolEdition } from './types/workflow-tool-edition.js';
import { buildV1ToolRegistry } from './v1/tool-registry.js';
import { buildV2ToolRegistry } from './v2/tool-registry.js';

/**
 * Select the active workflow tool edition.
 *
 * Returns a discriminated union - v1 XOR v2, never both.
 * The type system enforces exclusivity; callers use exhaustive switch.
 *
 * @param flags - Feature flag provider
 * @param buildTool - Tool builder with injected description provider
 * @returns The selected workflow tool edition
 *
 * @example
 * ```typescript
 * const edition = selectWorkflowToolEdition(flags, buildTool);
 *
 * // Exhaustive switch (compiler error if a case is missing)
 * switch (edition.kind) {
 *   case 'v1':
 *     console.log('v1 tools active');
 *     break;
 *   case 'v2':
 *     console.log('v2 tools active');
 *     break;
 * }
 * ```
 *
 * @pure - same flags + buildTool always produces the same edition
 */
export function selectWorkflowToolEdition(
  flags: IFeatureFlagProvider,
  buildTool: ToolBuilder
): WorkflowToolEdition {
  if (flags.isEnabled('v2Tools')) {
    const { tools, handlers } = buildV2ToolRegistry(buildTool);
    return { kind: 'v2', tools, handlers };
  }

  const { tools, handlers } = buildV1ToolRegistry(buildTool);
  return { kind: 'v1', tools, handlers };
}
