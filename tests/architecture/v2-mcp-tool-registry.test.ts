import { describe, it, expect } from 'vitest';
import { V2_TOOL_TITLES } from '../../src/mcp/v2/tools.js';

/**
 * Enforce exact v2 MCP tool surface (architecture lock).
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase D
 * > Assert the exposed tool set is exactly the locked list (core + flagged)
 * > Prevent accidental "projection MCP tools" from being added
 * 
 * Lock: docs/plans/workrail-v2-one-pager.md (Public MCP surface)
 * 
 * Purpose:
 * - Prevent tool sprawl
 * - Catch accidental exposure of internal projections
 * - Ensure tool surface matches design locks
 */

/**
 * Locked v2 core tool names (always exposed when v2 enabled).
 * 
 * Source: docs/plans/workrail-v2-one-pager.md
 */
const LOCKED_V2_CORE_TOOLS = [
  'list_workflows',
  'inspect_workflow',
  'start_workflow',
  'continue_workflow',
  'checkpoint_workflow',
  'resume_session',
] as const;

/**
 * Locked v2 flagged tool names (exposed only when specific flags enabled).
 * 
 * Note: These are NOT part of core and must not appear in core registry.
 */
const LOCKED_V2_FLAGGED_TOOLS = [
  'start_session',
] as const;

/**
 * Forbidden tool name patterns (projection read-models must not leak to MCP).
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 6
 * > Projections API is internal-only
 * > Do not add MCP tools for projections
 */
const FORBIDDEN_TOOL_PATTERNS = [
  /^project_/,        // projectRunDag, projectGaps, etc.
  /^get_session$/,    // Direct session access
  /^list_sessions$/,  // Session enumeration
  /^read_session$/,   // Session reads
  /^update_session$/, // Session mutations
  /^load_/,           // Load operations
  /^save_/,           // Save operations
  /^derive_/,         // Derived projections
] as const;

describe('v2 MCP tool registry (exact locked set)', () => {
  const exposedTools = Object.keys(V2_TOOL_TITLES).sort();

  it('exposes exactly the locked core v2 tools', () => {
    const expected = [...LOCKED_V2_CORE_TOOLS].sort();
    
    if (JSON.stringify(exposedTools) !== JSON.stringify(expected)) {
      const extra = exposedTools.filter(t => !expected.includes(t));
      const missing = expected.filter(t => !exposedTools.includes(t));
      
      let message = 'Tool registry does not match locked list.\n\n';
      
      if (extra.length > 0) {
        message += `Extra tools (not in locked list): ${extra.join(', ')}\n`;
        message += `If intentional, update LOCKED_V2_CORE_TOOLS in this test.\n\n`;
      }
      
      if (missing.length > 0) {
        message += `Missing tools (in locked list): ${missing.join(', ')}\n`;
        message += `If removal is intentional, update LOCKED_V2_CORE_TOOLS and document migration.\n\n`;
      }
      
      expect.fail(message);
    }
    
    expect(exposedTools).toEqual(expected);
  });

  it('does not expose flagged tools in core registry', () => {
    for (const flagged of LOCKED_V2_FLAGGED_TOOLS) {
      expect(exposedTools, `Flagged tool "${flagged}" should not be in core registry`).not.toContain(flagged);
    }
  });

  it('does not expose projection read-model tools', () => {
    for (const tool of exposedTools) {
      for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
        expect(tool, `Tool "${tool}" matches forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('all core tools have registered titles', () => {
    for (const tool of LOCKED_V2_CORE_TOOLS) {
      expect(V2_TOOL_TITLES[tool], `Title for "${tool}" must be defined`).toBeDefined();
      expect(V2_TOOL_TITLES[tool].length, `Title for "${tool}" must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('no tools added without updating locked list', () => {
    const extra = exposedTools.filter(t => !(LOCKED_V2_CORE_TOOLS as readonly string[]).includes(t));
    
    if (extra.length > 0) {
      expect.fail(
        `Unexpected tools in registry: ${extra.join(', ')}\n\n` +
        `If this is intentional:\n` +
        `1. Update LOCKED_V2_CORE_TOOLS in this test\n` +
        `2. Update docs/plans/workrail-v2-one-pager.md\n` +
        `3. Update docs/design/v2-core-design-locks.md Section 6\n` +
        `4. Justify why this tool belongs in core v2 surface`
      );
    }
  });

  it('no tools removed without updating locked list', () => {
    const missing = (LOCKED_V2_CORE_TOOLS as readonly string[]).filter(t => !exposedTools.includes(t));
    
    if (missing.length > 0) {
      expect.fail(
        `Missing tools from registry: ${missing.join(', ')}\n\n` +
        `If this removal is intentional:\n` +
        `1. Update LOCKED_V2_CORE_TOOLS in this test\n` +
        `2. Update docs/plans/workrail-v2-one-pager.md\n` +
        `3. Document migration path in release notes`
      );
    }
  });
});

describe('v2 tool naming conventions', () => {
  const toolNames = Object.keys(V2_TOOL_TITLES);

  it('all v2 tools use snake_case (not camelCase)', () => {
    for (const tool of toolNames) {
      expect(tool, `Tool "${tool}" must use snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool, `Tool "${tool}" must not contain uppercase`).not.toMatch(/[A-Z]/);
    }
  });

  it('all v2 tools have non-empty titles', () => {
    for (const tool of toolNames) {
      const title = V2_TOOL_TITLES[tool as keyof typeof V2_TOOL_TITLES];
      expect(title, `Tool "${tool}" must have a title`).toBeTruthy();
      expect(title.length, `Tool "${tool}" title must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('all v2 tool titles reference current names (not v1)', () => {
    for (const tool of toolNames) {
      const title = V2_TOOL_TITLES[tool as keyof typeof V2_TOOL_TITLES];
      expect(title, `Tool "${tool}" should not reference v1 workflow_next`).not.toContain('workflow_next');
      expect(title, `Tool "${tool}" should not reference v1 workflow_get`).not.toContain('workflow_get');
      expect(title, `Tool "${tool}" should not reference v1 completedSteps`).not.toContain('completedSteps');
    }
  });
});
