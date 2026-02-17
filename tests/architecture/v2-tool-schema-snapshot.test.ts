/**
 * V2 Tool Schema Snapshot Test
 *
 * Sub-phase D anti-drift enforcement:
 * Catches silent field additions/removals/renames in v2 MCP tool input schemas.
 * If a field changes, this test fails with a clear diff showing exactly what changed.
 *
 * Update the snapshot when intentional changes are made.
 */

import { describe, it, expect } from 'vitest';
import {
  V2ListWorkflowsInput,
  V2InspectWorkflowInput,
  V2StartWorkflowInput,
  V2ContinueWorkflowInput,
  V2CheckpointWorkflowInput,
  V2ResumeSessionInput,
  V2_TOOL_ANNOTATIONS,
} from '../../src/mcp/v2/tools.js';

/**
 * Extract top-level field names from a Zod object schema.
 * Returns sorted array for deterministic comparison.
 */
function extractFieldNames(schema: any): string[] {
  if (schema._def?.typeName === 'ZodEffects') {
    // .strict() and .superRefine() wrap the inner schema
    return extractFieldNames(schema._def.schema);
  }
  if (schema._def?.typeName === 'ZodObject') {
    return Object.keys(schema._def.shape()).sort();
  }
  return [];
}

describe('v2 tool schema field snapshots (anti-drift)', () => {
  it('list_workflows: no input fields', () => {
    expect(extractFieldNames(V2ListWorkflowsInput)).toEqual([]);
  });

  it('inspect_workflow: exact field set', () => {
    expect(extractFieldNames(V2InspectWorkflowInput)).toEqual([
      'mode',
      'workflowId',
    ]);
  });

  it('start_workflow: exact field set', () => {
    expect(extractFieldNames(V2StartWorkflowInput)).toEqual([
      'context',
      'workflowId',
    ]);
  });

  it('continue_workflow: exact field set', () => {
    expect(extractFieldNames(V2ContinueWorkflowInput)).toEqual([
      'ackToken',
      'context',
      'intent',
      'output',
      'stateToken',
    ]);
  });

  it('checkpoint_workflow: exact field set', () => {
    expect(extractFieldNames(V2CheckpointWorkflowInput)).toEqual([
      'checkpointToken',
    ]);
  });

  it('resume_session: exact field set', () => {
    expect(extractFieldNames(V2ResumeSessionInput)).toEqual([
      'gitBranch',
      'gitHeadSha',
      'query',
    ]);
  });

  it('annotation keys match tool names exactly', () => {
    expect(Object.keys(V2_TOOL_ANNOTATIONS).sort()).toEqual([
      'checkpoint_workflow',
      'continue_workflow',
      'inspect_workflow',
      'list_workflows',
      'resume_session',
      'start_workflow',
    ]);
  });

  it('continue_workflow intent enum is exactly [advance, rehydrate]', () => {
    const shape = V2ContinueWorkflowInput._def.schema._def.shape();
    const intentDef = shape.intent._def;
    expect(intentDef.values).toEqual(['advance', 'rehydrate']);
  });

  it('inspect_workflow mode enum is exactly [metadata, preview]', () => {
    const shape = V2InspectWorkflowInput._def.shape();
    const modeDef = shape.mode._def;
    // mode has a .default() wrapper
    const innerDef = modeDef.innerType._def;
    expect(innerDef.values).toEqual(['metadata', 'preview']);
  });

  it('all v2 tools have non-empty descriptions for every field', () => {
    const schemas = [
      { name: 'inspect_workflow', schema: V2InspectWorkflowInput },
      { name: 'start_workflow', schema: V2StartWorkflowInput },
      { name: 'continue_workflow', schema: V2ContinueWorkflowInput },
      { name: 'checkpoint_workflow', schema: V2CheckpointWorkflowInput },
      { name: 'resume_session', schema: V2ResumeSessionInput },
    ];

    const fieldsWithoutDescription: string[] = [];

    for (const { name, schema } of schemas) {
      let shapeFn: any;
      if (schema._def?.typeName === 'ZodEffects') {
        shapeFn = schema._def.schema._def.shape;
      } else {
        shapeFn = schema._def.shape;
      }

      const shape = shapeFn();
      for (const [fieldName, fieldSchema] of Object.entries(shape)) {
        const desc = (fieldSchema as any)?.description ?? (fieldSchema as any)?._def?.description;
        if (!desc) {
          fieldsWithoutDescription.push(`${name}.${fieldName}`);
        }
      }
    }

    expect(fieldsWithoutDescription).toEqual([]);
  });
});
