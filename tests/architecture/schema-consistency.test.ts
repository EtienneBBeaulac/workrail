import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// v1 workflow tool schemas
import {
  WorkflowListInput,
  WorkflowGetInput,
  WorkflowNextInput,
  WorkflowValidateJsonInput,
  WorkflowGetSchemaInput,
  WORKFLOW_TOOL_ANNOTATIONS,
  // Session tools
  CreateSessionInput,
  UpdateSessionInput,
  ReadSessionInput,
  OpenDashboardInput,
  createSessionTool,
  updateSessionTool,
  readSessionTool,
  openDashboardTool,
} from '../../src/mcp/tools.js';

// v2 workflow tool schemas
import {
  V2ListWorkflowsInput,
  V2InspectWorkflowInput,
  V2StartWorkflowInput,
  V2ContinueWorkflowInput,
  V2_TOOL_ANNOTATIONS,
} from '../../src/mcp/v2/tools.js';

// Tool descriptions
import { DESCRIPTIONS } from '../../src/mcp/tool-descriptions.js';

/**
 * Schema Consistency Architecture Tests
 * 
 * Purpose: Prevent agent confusion from inconsistent tool schemas.
 * 
 * Design Lock Reference: docs/design/v2-core-design-locks.md
 * - Section 8: Tools vs docs alignment locks (anti-drift)
 * - Section 12: Unified error envelope
 * - Section 16.5D: Anti-drift enforcement (exact MCP tool registry)
 * 
 * These tests enforce:
 * 1. Consistent parameter naming across all tools
 * 2. No snake_case parameters (agents may normalize incorrectly)
 * 3. All parameters have descriptions
 * 4. Type consistency for shared concepts
 * 5. Annotation consistency (readOnly, idempotent, etc.)
 * 6. Description-schema alignment
 * 7. V2 tool idempotency contracts (Section 1.2)
 */

// -----------------------------------------------------------------------------
// Test Utilities
// -----------------------------------------------------------------------------

interface SchemaInfo {
  name: string;
  schema: z.ZodType;
  hasWorkflowIdConcept: boolean;
}

/** All workflow-related input schemas that may reference a workflow ID */
const WORKFLOW_SCHEMAS: SchemaInfo[] = [
  { name: 'WorkflowGetInput', schema: WorkflowGetInput, hasWorkflowIdConcept: true },
  { name: 'WorkflowNextInput', schema: WorkflowNextInput, hasWorkflowIdConcept: true },
  { name: 'WorkflowValidateJsonInput', schema: WorkflowValidateJsonInput, hasWorkflowIdConcept: false },
  { name: 'WorkflowGetSchemaInput', schema: WorkflowGetSchemaInput, hasWorkflowIdConcept: false },
  { name: 'WorkflowListInput', schema: WorkflowListInput, hasWorkflowIdConcept: false },
  { name: 'V2InspectWorkflowInput', schema: V2InspectWorkflowInput, hasWorkflowIdConcept: true },
  { name: 'V2StartWorkflowInput', schema: V2StartWorkflowInput, hasWorkflowIdConcept: true },
  { name: 'V2ContinueWorkflowInput', schema: V2ContinueWorkflowInput, hasWorkflowIdConcept: false },
  { name: 'V2ListWorkflowsInput', schema: V2ListWorkflowsInput, hasWorkflowIdConcept: false },
];

/** All session-related input schemas */
const SESSION_SCHEMAS: SchemaInfo[] = [
  { name: 'CreateSessionInput', schema: CreateSessionInput, hasWorkflowIdConcept: true },
  { name: 'UpdateSessionInput', schema: UpdateSessionInput, hasWorkflowIdConcept: true },
  { name: 'ReadSessionInput', schema: ReadSessionInput, hasWorkflowIdConcept: true },
  { name: 'OpenDashboardInput', schema: OpenDashboardInput, hasWorkflowIdConcept: false },
];

const ALL_SCHEMAS = [...WORKFLOW_SCHEMAS, ...SESSION_SCHEMAS];

/** Extract parameter names from a Zod object schema */
function getParameterNames(schema: z.ZodType): string[] {
  // Unwrap ZodEffects layers (from .strict(), .superRefine(), .refine(), etc.)
  let current: z.ZodType = schema;
  while (current instanceof z.ZodEffects) {
    current = current._def.schema;
  }
  if (current instanceof z.ZodObject) {
    return Object.keys(current._def.shape());
  }
  return [];
}

/** Extract parameter info including description from a Zod object schema */
function getParameterInfo(schema: z.ZodType): Map<string, { description?: string; type: string }> {
  const result = new Map<string, { description?: string; type: string }>();
  
  // Unwrap ZodEffects layers (from .strict(), .superRefine(), .refine(), etc.)
  let current: z.ZodType = schema;
  while (current instanceof z.ZodEffects) {
    current = current._def.schema;
  }
  if (current instanceof z.ZodObject) {
    const shape = current._def.shape();
    for (const [key, value] of Object.entries(shape)) {
      const zodValue = value as z.ZodType;
      result.set(key, {
        description: zodValue._def.description,
        type: zodValue._def.typeName || 'unknown',
      });
    }
  }
  
  return result;
}

/** Check if a string uses snake_case */
function isSnakeCase(str: string): boolean {
  return str.includes('_');
}

// -----------------------------------------------------------------------------
// Test: Workflow ID Parameter Consistency
// -----------------------------------------------------------------------------

describe('Workflow ID parameter consistency', () => {
  it('all schemas with workflow ID concept must use "workflowId" (not "id" or "workflow_id")', () => {
    const schemasWithWorkflowId = ALL_SCHEMAS.filter(s => s.hasWorkflowIdConcept);
    
    for (const { name, schema } of schemasWithWorkflowId) {
      const params = getParameterNames(schema);
      
      // Must have workflowId
      expect(params, `${name} must have "workflowId" parameter`).toContain('workflowId');
      
      // Must NOT have "id" alone (ambiguous)
      expect(params, `${name} must not use bare "id" (use "workflowId" instead)`).not.toContain('id');
      
      // Must NOT have snake_case variant
      expect(params, `${name} must not use "workflow_id" (use "workflowId" instead)`).not.toContain('workflow_id');
    }
  });

  it('schemas without workflow ID concept must not have stray ID parameters', () => {
    const schemasWithoutWorkflowId = ALL_SCHEMAS.filter(s => !s.hasWorkflowIdConcept);
    
    for (const { name, schema } of schemasWithoutWorkflowId) {
      const params = getParameterNames(schema);
      
      // Should not have workflow_id (snake_case is always wrong)
      expect(params, `${name} has unexpected "workflow_id" parameter`).not.toContain('workflow_id');
    }
  });
});

// -----------------------------------------------------------------------------
// Test: No Snake Case Parameters
// -----------------------------------------------------------------------------

describe('Parameter naming conventions', () => {
  it('all parameters must use camelCase (no snake_case)', () => {
    const violations: string[] = [];
    
    for (const { name, schema } of ALL_SCHEMAS) {
      const params = getParameterNames(schema);
      
      for (const param of params) {
        if (isSnakeCase(param)) {
          violations.push(`${name}.${param}`);
        }
      }
    }
    
    if (violations.length > 0) {
      expect.fail(
        `Snake_case parameters found (agents may normalize incorrectly):\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nUse camelCase instead (e.g., "workflowId" not "workflow_id")`
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Test: All Parameters Must Have Descriptions
// -----------------------------------------------------------------------------

describe('Parameter documentation', () => {
  it('all parameters must have .describe() set', () => {
    const undocumented: string[] = [];
    
    for (const { name, schema } of ALL_SCHEMAS) {
      const paramInfo = getParameterInfo(schema);
      
      for (const [paramName, info] of paramInfo) {
        if (!info.description || info.description.trim() === '') {
          undocumented.push(`${name}.${paramName}`);
        }
      }
    }
    
    if (undocumented.length > 0) {
      expect.fail(
        `Parameters without descriptions (agents rely on these):\n` +
        undocumented.map(p => `  - ${p}`).join('\n') +
        `\n\nAdd .describe('...') to each parameter.`
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Test: Type Consistency for Shared Concepts
// -----------------------------------------------------------------------------

describe('Type consistency across tools', () => {
  it('context parameter must be Record<string, unknown> everywhere', () => {
    const schemasWithContext = ALL_SCHEMAS.filter(({ schema }) => {
      const params = getParameterNames(schema);
      return params.includes('context');
    });
    
    for (const { name, schema } of schemasWithContext) {
      if (schema instanceof z.ZodObject) {
        const shape = schema._def.shape();
        const contextField = shape.context as z.ZodType;
        
        // Unwrap optional if present
        const innerType = contextField instanceof z.ZodOptional 
          ? contextField._def.innerType 
          : contextField;
        
        expect(
          innerType instanceof z.ZodRecord,
          `${name}.context must be a Record type`
        ).toBe(true);
      }
    }
  });

  it('workflowId must have consistent validation pattern', () => {
    const schemasWithWorkflowId = ALL_SCHEMAS.filter(s => s.hasWorkflowIdConcept);
    const patterns: Map<string, string> = new Map();
    
    for (const { name, schema } of schemasWithWorkflowId) {
      if (schema instanceof z.ZodObject) {
        const shape = schema._def.shape();
        const workflowIdField = shape.workflowId as z.ZodType;
        
        // Extract pattern if it's a string with regex check
        if (workflowIdField instanceof z.ZodString) {
          const regexCheck = workflowIdField._def.checks?.find(
            (c: { kind: string }) => c.kind === 'regex'
          );
          if (regexCheck && 'regex' in regexCheck) {
            patterns.set(name, (regexCheck as { regex: RegExp }).regex.source);
          } else {
            patterns.set(name, '(no pattern)');
          }
        }
      }
    }
    
    // All patterns should be the same (or all should have no pattern)
    const uniquePatterns = new Set(patterns.values());
    if (uniquePatterns.size > 1) {
      const patternList = Array.from(patterns.entries())
        .map(([schema, pattern]) => `  - ${schema}: ${pattern}`)
        .join('\n');
      
      expect.fail(
        `Inconsistent workflowId validation patterns:\n${patternList}\n\n` +
        `All workflowId fields should use the same pattern for consistency.`
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Test: Tool Annotation Consistency
// -----------------------------------------------------------------------------

describe('Tool annotation consistency', () => {
  const READ_ONLY_V1_TOOLS = ['discover_workflows', 'preview_workflow', 'get_workflow_schema'];
  const READ_ONLY_V2_TOOLS = ['list_workflows', 'inspect_workflow'];
  
  it('read-only v1 tools must have readOnlyHint: true', () => {
    for (const tool of READ_ONLY_V1_TOOLS) {
      const annotations = WORKFLOW_TOOL_ANNOTATIONS[tool as keyof typeof WORKFLOW_TOOL_ANNOTATIONS];
      expect(
        annotations?.readOnlyHint,
        `${tool} should have readOnlyHint: true`
      ).toBe(true);
    }
  });

  it('read-only v2 tools must have readOnlyHint: true', () => {
    for (const tool of READ_ONLY_V2_TOOLS) {
      const annotations = V2_TOOL_ANNOTATIONS[tool as keyof typeof V2_TOOL_ANNOTATIONS];
      expect(
        annotations?.readOnlyHint,
        `${tool} should have readOnlyHint: true`
      ).toBe(true);
    }
  });

  it('mutating tools must have readOnlyHint: false', () => {
    // Note: validate_workflow is read-only (it only validates, doesn't mutate)
    const mutatingV1 = ['advance_workflow'];
    const mutatingV2 = ['start_workflow', 'continue_workflow'];
    
    for (const tool of mutatingV1) {
      const annotations = WORKFLOW_TOOL_ANNOTATIONS[tool as keyof typeof WORKFLOW_TOOL_ANNOTATIONS];
      expect(
        annotations?.readOnlyHint,
        `${tool} should have readOnlyHint: false`
      ).toBe(false);
    }
    
    for (const tool of mutatingV2) {
      const annotations = V2_TOOL_ANNOTATIONS[tool as keyof typeof V2_TOOL_ANNOTATIONS];
      expect(
        annotations?.readOnlyHint,
        `${tool} should have readOnlyHint: false`
      ).toBe(false);
    }
  });

  it('session read tool must have readOnlyHint: true', () => {
    expect(readSessionTool.annotations.readOnlyHint).toBe(true);
  });

  it('session write tools must have readOnlyHint: false', () => {
    expect(createSessionTool.annotations.readOnlyHint).toBe(false);
    expect(updateSessionTool.annotations.readOnlyHint).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Test: Description-Schema Alignment
// -----------------------------------------------------------------------------

describe('Description-schema alignment', () => {
  const TOOLS_WITH_REQUIRED_PARAMS: Array<{
    tool: string;
    requiredParams: string[];
    description: string;
  }> = [
    {
      tool: 'advance_workflow',
      requiredParams: ['workflowId', 'state'],
      description: DESCRIPTIONS.standard.advance_workflow,
    },
    {
      tool: 'preview_workflow',
      requiredParams: ['workflowId'],
      description: DESCRIPTIONS.standard.preview_workflow,
    },
  ];

  it('tool descriptions must mention all required parameters', () => {
    const missingMentions: string[] = [];
    
    for (const { tool, requiredParams, description } of TOOLS_WITH_REQUIRED_PARAMS) {
      for (const param of requiredParams) {
        // Check if param is mentioned in description (case-insensitive word boundary)
        const mentioned = new RegExp(`\\b${param}\\b`, 'i').test(description);
        if (!mentioned) {
          missingMentions.push(`${tool}: missing mention of "${param}"`);
        }
      }
    }
    
    if (missingMentions.length > 0) {
      expect.fail(
        `Tool descriptions don't mention required parameters:\n` +
        missingMentions.map(m => `  - ${m}`).join('\n') +
        `\n\nUpdate tool descriptions to document required parameters.`
      );
    }
  });

  it('authoritative mode descriptions must also mention required parameters', () => {
    const missingMentions: string[] = [];
    
    for (const { tool, requiredParams } of TOOLS_WITH_REQUIRED_PARAMS) {
      const description = DESCRIPTIONS.authoritative[tool as keyof typeof DESCRIPTIONS.authoritative];
      
      for (const param of requiredParams) {
        const mentioned = new RegExp(`\\b${param}\\b`, 'i').test(description);
        if (!mentioned) {
          missingMentions.push(`${tool} (authoritative): missing mention of "${param}"`);
        }
      }
    }
    
    if (missingMentions.length > 0) {
      expect.fail(
        `Authoritative descriptions don't mention required parameters:\n` +
        missingMentions.map(m => `  - ${m}`).join('\n')
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Test: V1/V2 Tool Relationship
// -----------------------------------------------------------------------------

describe('V1/V2 tool relationship', () => {
  // V2 tools are feature-flagged and intentionally overlap with v1.
  // They use the same names because v2 is the replacement surface.
  // The server only exposes one or the other based on feature flags.
  
  const V1_ONLY_TOOLS = ['discover_workflows', 'preview_workflow', 'advance_workflow', 'validate_workflow', 'get_workflow_schema'];
  const V2_ONLY_TOOLS = ['list_workflows', 'inspect_workflow', 'start_workflow', 'continue_workflow'];
  
  it('v1-only tools must not appear in v2 registry', () => {
    const v2Tools = Object.keys(V2_TOOL_ANNOTATIONS);
    
    for (const v1Tool of V1_ONLY_TOOLS) {
      expect(v2Tools, `${v1Tool} should not be in v2 registry`).not.toContain(v1Tool);
    }
  });
  
  it('v2-only tools must not appear in v1 workflow annotations', () => {
    // V2 tools should only be in v2 annotations, not v1
    // Note: WORKFLOW_TOOL_ANNOTATIONS includes both v1 and v2 for completeness
    // This test verifies v2 tools have their own dedicated registry
    for (const v2Tool of V2_ONLY_TOOLS) {
      expect(V2_TOOL_ANNOTATIONS[v2Tool as keyof typeof V2_TOOL_ANNOTATIONS]).toBeDefined();
    }
  });
});

// -----------------------------------------------------------------------------
// Test: V2 Idempotency Contracts (Design Lock Section 1.2)
// -----------------------------------------------------------------------------

describe('V2 idempotency contracts (Section 1.2)', () => {
  /**
   * Design Lock Reference: docs/design/v2-core-design-locks.md Section 1.2
   * 
   * - continue_workflow (with ackToken) is idempotent (replay-safe)
   * - Rehydrate-only (without ackToken) is side-effect-free
   */
  
  it('continue_workflow must have idempotentHint: true (replay-safe per Section 1.2)', () => {
    const annotations = V2_TOOL_ANNOTATIONS.continue_workflow;
    expect(
      annotations.idempotentHint,
      'continue_workflow must be idempotent per design lock Section 1.2'
    ).toBe(true);
  });

  it('start_workflow must have idempotentHint: false (creates new runs)', () => {
    const annotations = V2_TOOL_ANNOTATIONS.start_workflow;
    expect(
      annotations.idempotentHint,
      'start_workflow creates new runs and is not idempotent'
    ).toBe(false);
  });

  it('read-only v2 tools must have idempotentHint: true', () => {
    expect(V2_TOOL_ANNOTATIONS.list_workflows.idempotentHint).toBe(true);
    expect(V2_TOOL_ANNOTATIONS.inspect_workflow.idempotentHint).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Test: Locked V2 Tool Surface (Design Lock Section 16.5D)
// -----------------------------------------------------------------------------

describe('Locked v2 tool surface (Section 16.5D)', () => {
  /**
   * Design Lock Reference: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase D
   * 
   * > Assert the exposed tool set is exactly the locked list (core + flagged)
   * > Prevent accidental "projection MCP tools" from being added
   */
  
  const LOCKED_V2_CORE_TOOLS = [
    'list_workflows',
    'inspect_workflow',
    'start_workflow',
    'continue_workflow',
    'checkpoint_workflow',
  ] as const;

  it('v2 tool registry must match exactly the locked core tool list', () => {
    const registeredTools = Object.keys(V2_TOOL_ANNOTATIONS).sort();
    const lockedTools = [...LOCKED_V2_CORE_TOOLS].sort();
    
    expect(registeredTools).toEqual(lockedTools);
  });

  it('no projection tools must leak to MCP (Section 6 lock)', () => {
    // Design Lock Section 6: "Do not add MCP tools for projections"
    const forbiddenPatterns = [
      /^project_/,      // projectRunDag, projectGaps, etc.
      /^get_session$/,  // Direct session access
      /^list_sessions$/,// Session enumeration
      /^derive_/,       // Derived projections
    ];
    
    const v2Tools = Object.keys(V2_TOOL_ANNOTATIONS);
    for (const tool of v2Tools) {
      for (const pattern of forbiddenPatterns) {
        expect(tool, `Tool "${tool}" matches forbidden pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Test: Token Parameter Consistency (Design Lock Section 1.2)
// -----------------------------------------------------------------------------

describe('Token parameter consistency (Section 1.2)', () => {
  /**
   * Design Lock Reference: docs/design/v2-core-design-locks.md Section 1.2
   * 
   * V2ContinueWorkflowInput must have:
   * - intent (explicit discriminant: "advance" | "rehydrate")
   * - stateToken (opaque, required)
   * - ackToken (opaque, required for advance, forbidden for rehydrate)
   */
  
  it('V2ContinueWorkflowInput must have intent, stateToken, and ackToken parameters', () => {
    const params = getParameterNames(V2ContinueWorkflowInput);
    
    expect(params, 'V2ContinueWorkflowInput must have intent').toContain('intent');
    expect(params, 'V2ContinueWorkflowInput must have stateToken').toContain('stateToken');
    expect(params, 'V2ContinueWorkflowInput must have ackToken').toContain('ackToken');
  });

  it('token parameters must not use snake_case', () => {
    const params = getParameterNames(V2ContinueWorkflowInput);
    
    // Verify no snake_case variants
    expect(params).not.toContain('state_token');
    expect(params).not.toContain('ack_token');
  });
});
