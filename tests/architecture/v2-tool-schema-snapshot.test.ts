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
 * Navigate through Zod wrapper types to find the inner ZodObject shape.
 * Used for field-level inspection (descriptions, types).
 */
function extractShapeFromSchema(schema: any): Record<string, any> {
  const typeName = schema._def?.typeName;
  if (typeName === 'ZodEffects') return extractShapeFromSchema(schema._def.schema);
  if (typeName === 'ZodPipeline') return extractShapeFromSchema(schema._def.in);
  if (typeName === 'ZodObject') return schema._def.shape();
  return {};
}

/**
 * Extract top-level field names from a Zod object schema.
 * Returns sorted array for deterministic comparison.
 * Traverses ZodEffects (.strict(), .superRefine(), .transform()),
 * ZodPipeline (.pipe()), and ZodObject layers.
 */
function extractFieldNames(schema: any): string[] {
  const typeName = schema._def?.typeName;
  if (typeName === 'ZodEffects') {
    // .strict(), .superRefine(), .transform() wrap the inner schema
    return extractFieldNames(schema._def.schema);
  }
  if (typeName === 'ZodPipeline') {
    // .pipe() wraps the input schema as `in`
    return extractFieldNames(schema._def.in);
  }
  if (typeName === 'ZodObject') {
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
      'workspacePath',
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
      'workspacePath',
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

  it('continue_workflow intent enum is exactly [advance, rehydrate] (optional with auto-inference)', () => {
    // Schema is: ZodPipeline(ZodEffects(transform, ZodEffects(strict, ZodObject)))
    // Navigate to the inner ZodObject to get the shape
    const innerObject = V2ContinueWorkflowInput._def.in._def.schema;
    const shape = innerObject._def.shape();
    const intentDef = shape.intent._def;
    // intent is now z.enum([...]).optional(), so unwrap the optional
    const innerEnum = intentDef.innerType._def;
    expect(innerEnum.values).toEqual(['advance', 'rehydrate']);
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
      // Navigate through ZodEffects/ZodPipeline to find the inner ZodObject shape
      const shape = extractShapeFromSchema(schema);
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
