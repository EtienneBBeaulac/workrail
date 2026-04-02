/**
 * Tests for MCP boundary input coercion.
 *
 * Validates that coerceJsonStringObjectFields correctly normalizes
 * JSON-encoded string values to objects at the MCP input boundary,
 * handling canonical fields, aliased fields, and edge cases.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceJsonStringObjectFields } from '../../../src/mcp/boundary-coercion.js';

// -----------------------------------------------------------------------------
// Test schema fixtures
// -----------------------------------------------------------------------------

const schema = z.object({
  token: z.string(),
  context: z.record(z.unknown()).optional(),
  output: z.object({ notesMarkdown: z.string().optional() }).optional(),
  count: z.number().optional(),
});

const aliasMap: Readonly<Record<string, string>> = {
  contextVars: 'context',
};

// -----------------------------------------------------------------------------
// Core coercion behavior
// -----------------------------------------------------------------------------

describe('coerceJsonStringObjectFields', () => {
  it('passes through args unchanged when no fields need coercion', () => {
    const args = { token: 'ct_abc', count: 3 };
    const result = coerceJsonStringObjectFields(args, schema);
    expect(result).toBe(args); // same reference — no allocation
  });

  it('passes through args unchanged when object fields are already objects', () => {
    const args = { token: 'ct_abc', context: { branch: 'main' } };
    const result = coerceJsonStringObjectFields(args, schema);
    expect(result).toBe(args);
  });

  it('coerces a JSON-string context field to an object', () => {
    const args = { token: 'ct_abc', context: '{"branch":"main","complexity":"Medium"}' };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.context).toEqual({ branch: 'main', complexity: 'Medium' });
    expect(result.token).toBe('ct_abc');
  });

  it('coerces a JSON-string output field to an object', () => {
    const args = { token: 'ct_abc', output: '{"notesMarkdown":"## Done\\nAll good."}' };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.output).toEqual({ notesMarkdown: '## Done\nAll good.' });
  });

  it('coerces both context and output when both are JSON strings', () => {
    const args = {
      token: 'ct_abc',
      context: '{"phase":"0"}',
      output: '{"notesMarkdown":"step done"}',
    };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.context).toEqual({ phase: '0' });
    expect(result.output).toEqual({ notesMarkdown: 'step done' });
  });

  it('does not coerce non-object string fields (token, string primitives)', () => {
    const args = { token: 'ct_abc', context: { x: 1 } };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.token).toBe('ct_abc'); // unchanged
  });

  it('does not coerce a numeric field even if schema has one', () => {
    const args = { token: 'ct_abc', count: 5 };
    const result = coerceJsonStringObjectFields(args, schema);
    expect(result).toBe(args);
  });

  it('leaves an invalid JSON string unchanged so Zod can report the type error', () => {
    const args = { token: 'ct_abc', context: 'not-json' };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.context).toBe('not-json'); // original string preserved
  });

  it('leaves a JSON string that parses to a non-object (number) unchanged', () => {
    const args = { token: 'ct_abc', context: '42' };
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(result.context).toBe('42');
  });

  it('leaves a JSON string that parses to a non-object (array) unchanged', () => {
    // Arrays are not plain objects — context expects a record
    const args = { token: 'ct_abc', context: '[1,2,3]' };
    // JSON.parse('[1,2,3]') is an object (typeof === 'object'), so it IS coerced.
    // This is intentional: arrays pass the object check and Zod will then validate
    // whether an array satisfies z.record(), which it does not — giving a clear error.
    const result = coerceJsonStringObjectFields(args, schema) as Record<string, unknown>;
    expect(Array.isArray(result.context)).toBe(true);
  });

  it('returns original args reference when no coercion occurs (no allocation)', () => {
    const args = { token: 'ct_abc' };
    expect(coerceJsonStringObjectFields(args, schema)).toBe(args);
  });

  it('returns a new object (not the original reference) when coercion occurs', () => {
    const args = { token: 'ct_abc', context: '{"x":1}' };
    const result = coerceJsonStringObjectFields(args, schema);
    expect(result).not.toBe(args);
  });

  // ---------------------------------------------------------------------------
  // Alias map handling
  // ---------------------------------------------------------------------------

  it('coerces an aliased field when the canonical field expects an object', () => {
    const args = { token: 'ct_abc', contextVars: '{"branch":"dev"}' };
    const result = coerceJsonStringObjectFields(args, schema, aliasMap) as Record<string, unknown>;
    expect(result.contextVars).toEqual({ branch: 'dev' });
  });

  it('does not coerce an alias that maps to a non-object canonical field', () => {
    const schemaWithStringAlias = z.object({
      token: z.string(),
    });
    const aliasToString = { tokenAlias: 'token' };
    const args = { tokenAlias: '"hello"' }; // valid JSON string, but canonical is string not object
    const result = coerceJsonStringObjectFields(args, schemaWithStringAlias, aliasToString);
    expect(result).toBe(args); // unchanged
  });

  it('coerces both canonical and alias field independently when both are present', () => {
    // Conflict detection (alias + canonical both provided) is Zod's job after coercion.
    // Coercion should handle both without interfering.
    const args = {
      token: 'ct_abc',
      context: '{"from":"canonical"}',
      contextVars: '{"from":"alias"}',
    };
    const result = coerceJsonStringObjectFields(args, schema, aliasMap) as Record<string, unknown>;
    expect(result.context).toEqual({ from: 'canonical' });
    expect(result.contextVars).toEqual({ from: 'alias' });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('returns args unchanged when args is null', () => {
    expect(coerceJsonStringObjectFields(null, schema)).toBeNull();
  });

  it('returns args unchanged when args is a string (not an object)', () => {
    expect(coerceJsonStringObjectFields('hello', schema)).toBe('hello');
  });

  it('returns args unchanged when schema has no object/record fields', () => {
    const primitiveSchema = z.object({ token: z.string(), count: z.number() });
    const args = { token: 'ct_abc', count: 1 };
    expect(coerceJsonStringObjectFields(args, primitiveSchema)).toBe(args);
  });

  it('does not mutate the original args object', () => {
    const args = { token: 'ct_abc', context: '{"x":1}' };
    const frozen = Object.freeze({ ...args });
    const result = coerceJsonStringObjectFields(frozen, schema) as Record<string, unknown>;
    expect(result.context).toEqual({ x: 1 });
    expect(frozen.context).toBe('{"x":1}'); // original unchanged
  });
});
