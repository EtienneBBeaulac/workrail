/**
 * Tests for selectWorkflowToolEdition
 *
 * Verifies the discriminated union behavior:
 * - v1 edition when v2Tools flag is disabled
 * - v2 edition when v2Tools flag is enabled
 * - Exhaustive handling of all cases
 */

import { describe, it, expect, vi } from 'vitest';
import { selectWorkflowToolEdition } from '../../../src/mcp/workflow-tool-edition-selector.js';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';
import type { ToolBuilder } from '../../../src/mcp/tool-factory.js';
import type { WorkflowToolEdition } from '../../../src/mcp/types/workflow-tool-edition.js';

// Mock tool builder that returns minimal tool definitions
function createMockBuildTool(): ToolBuilder {
  return (config) => ({
    name: config.name,
    title: config.title,
    description: `Mock description for ${config.name}`,
    inputSchema: config.inputSchema,
    annotations: config.annotations,
  });
}

describe('selectWorkflowToolEdition', () => {
  const V1_TOOL_NAMES = [
    'discover_workflows',
    'preview_workflow',
    'advance_workflow',
    'validate_workflow',
    'get_workflow_schema',
  ] as const;

  const V2_TOOL_NAMES = [
    'list_workflows',
    'inspect_workflow',
    'start_workflow',
    'continue_workflow',
  ] as const;

  it('returns v1 edition when v2Tools flag is disabled', () => {
    const flags = new StaticFeatureFlagProvider({ v2Tools: false });
    const buildTool = createMockBuildTool();

    const edition = selectWorkflowToolEdition(flags, buildTool);

    expect(edition.kind).toBe('v1');
    expect(edition.tools.map(t => t.name)).toEqual(V1_TOOL_NAMES);
    expect(Object.keys(edition.handlers).sort()).toEqual([...V1_TOOL_NAMES].sort());
  });

  it('returns v2 edition when v2Tools flag is enabled', () => {
    const flags = new StaticFeatureFlagProvider({ v2Tools: true });
    const buildTool = createMockBuildTool();

    const edition = selectWorkflowToolEdition(flags, buildTool);

    expect(edition.kind).toBe('v2');
    expect(edition.tools.map(t => t.name)).toEqual(V2_TOOL_NAMES);
    expect(Object.keys(edition.handlers).sort()).toEqual([...V2_TOOL_NAMES].sort());
  });

  it('handlers are callable functions', () => {
    const flags = new StaticFeatureFlagProvider({ v2Tools: false });
    const buildTool = createMockBuildTool();

    const edition = selectWorkflowToolEdition(flags, buildTool);

    // All handlers should be functions
    for (const [name, handler] of Object.entries(edition.handlers)) {
      expect(typeof handler).toBe('function');
    }
  });

  it('editions are exhaustively typed (compile-time check)', () => {
    const flags = new StaticFeatureFlagProvider({ v2Tools: false });
    const buildTool = createMockBuildTool();

    const edition = selectWorkflowToolEdition(flags, buildTool);

    // Exhaustive switch - adding a new kind without handling it breaks compilation
    const kind = ((): string => {
      switch (edition.kind) {
        case 'v1':
          return 'v1';
        case 'v2':
          return 'v2';
        default: {
          // This line should never be reached if all cases are handled
          const _exhaustive: never = edition;
          throw new Error(`Unhandled edition: ${_exhaustive}`);
        }
      }
    })();

    expect(['v1', 'v2']).toContain(kind);
  });

  it('v1 and v2 tool names do not overlap', () => {
    const v1Set = new Set(V1_TOOL_NAMES);
    const v2Set = new Set(V2_TOOL_NAMES);

    const intersection = [...v1Set].filter(name => v2Set.has(name as any));

    expect(intersection).toEqual([]);
  });

  it('is deterministic - same inputs produce same outputs', () => {
    const flags = new StaticFeatureFlagProvider({ v2Tools: true });
    const buildTool = createMockBuildTool();

    const edition1 = selectWorkflowToolEdition(flags, buildTool);
    const edition2 = selectWorkflowToolEdition(flags, buildTool);

    expect(edition1.kind).toBe(edition2.kind);
    expect(edition1.tools.map(t => t.name)).toEqual(edition2.tools.map(t => t.name));
    expect(Object.keys(edition1.handlers)).toEqual(Object.keys(edition2.handlers));
  });

  it('defaults to v1 when v2Tools flag is not explicitly set', () => {
    // Empty flags - should use defaults (v2Tools defaults to false)
    const flags = new StaticFeatureFlagProvider({});
    const buildTool = createMockBuildTool();

    const edition = selectWorkflowToolEdition(flags, buildTool);

    expect(edition.kind).toBe('v1');
    expect(edition.tools.map(t => t.name)).toEqual(V1_TOOL_NAMES);
  });
});
