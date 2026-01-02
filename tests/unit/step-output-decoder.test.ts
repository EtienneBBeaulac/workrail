import { describe, it, expect } from 'vitest';
import { decodeForSchemaValidation, schemaExpectsObjectOrArray } from '../../src/application/services/step-output-decoder';

describe('step-output-decoder', () => {
  describe('schemaExpectsObjectOrArray', () => {
    it('returns false for null schema', () => {
      expect(schemaExpectsObjectOrArray(null)).toBe(false);
    });

    it('returns false for undefined schema', () => {
      expect(schemaExpectsObjectOrArray(undefined)).toBe(false);
    });

    it('returns false for non-object schema', () => {
      expect(schemaExpectsObjectOrArray('string')).toBe(false);
      expect(schemaExpectsObjectOrArray(42)).toBe(false);
      expect(schemaExpectsObjectOrArray(true)).toBe(false);
    });

    it('returns true for type: "object"', () => {
      expect(schemaExpectsObjectOrArray({ type: 'object' })).toBe(true);
    });

    it('returns true for type: "array"', () => {
      expect(schemaExpectsObjectOrArray({ type: 'array' })).toBe(true);
    });

    it('returns true for union types containing object', () => {
      expect(schemaExpectsObjectOrArray({ type: ['object', 'null'] })).toBe(true);
    });

    it('returns true for union types containing array', () => {
      expect(schemaExpectsObjectOrArray({ type: ['array', 'string'] })).toBe(true);
    });

    it('returns false for union types without object/array', () => {
      expect(schemaExpectsObjectOrArray({ type: ['string', 'number'] })).toBe(false);
    });

    it('returns true for schema with properties (object-ish heuristic)', () => {
      expect(schemaExpectsObjectOrArray({ properties: { name: { type: 'string' } } })).toBe(true);
    });

    it('returns true for schema with non-empty required array (object-ish heuristic)', () => {
      expect(schemaExpectsObjectOrArray({ required: ['id', 'name'] })).toBe(true);
    });

    it('returns false for schema with empty required array', () => {
      expect(schemaExpectsObjectOrArray({ required: [] })).toBe(false);
    });

    it('returns true for oneOf containing object schema', () => {
      expect(schemaExpectsObjectOrArray({
        oneOf: [
          { type: 'string' },
          { type: 'object', properties: { name: {} } }
        ]
      })).toBe(true);
    });

    it('returns true for anyOf containing array schema', () => {
      expect(schemaExpectsObjectOrArray({
        anyOf: [
          { type: 'number' },
          { type: 'array', items: {} }
        ]
      })).toBe(true);
    });

    it('returns true for allOf containing object schema', () => {
      expect(schemaExpectsObjectOrArray({
        allOf: [
          { type: 'object' },
          { properties: { id: {} } }
        ]
      })).toBe(true);
    });

    it('returns false for oneOf/anyOf/allOf without object/array', () => {
      expect(schemaExpectsObjectOrArray({
        oneOf: [{ type: 'string' }, { type: 'number' }]
      })).toBe(false);
    });

    it('handles deeply nested combinators', () => {
      expect(schemaExpectsObjectOrArray({
        oneOf: [
          { type: 'string' },
          {
            anyOf: [
              { type: 'number' },
              { type: 'object' }
            ]
          }
        ]
      })).toBe(true);
    });

    it('returns false for $ref schemas (known limitation)', () => {
      // NOTE: $ref resolution is not implemented. This is a known limitation.
      // Schemas using $ref to reference object/array definitions won't trigger coercion.
      expect(schemaExpectsObjectOrArray({ $ref: '#/$defs/UserProfile' })).toBe(false);
    });

    it('returns false for if/then/else conditional schemas (known limitation)', () => {
      // Conditional schema keywords are not handled (rare in step output validation)
      expect(schemaExpectsObjectOrArray({
        if: { properties: { type: {} } },
        then: { type: 'object' }
      })).toBe(false);
    });
  });

  describe('decodeForSchemaValidation', () => {
    it('returns null for non-JSON input', () => {
      expect(decodeForSchemaValidation('not json', { type: 'object' })).toBeNull();
    });

    it('returns parsed value without warnings for normal JSON object', () => {
      const result = decodeForSchemaValidation('{"name": "John"}', { type: 'object' });
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ name: 'John' });
      expect(result!.warnings).toEqual([]);
    });

    it('returns parsed value without warnings for normal JSON array', () => {
      const result = decodeForSchemaValidation('[1, 2, 3]', { type: 'array' });
      expect(result).not.toBeNull();
      expect(result!.value).toEqual([1, 2, 3]);
      expect(result!.warnings).toEqual([]);
    });

    it('returns parsed value without warnings for primitives', () => {
      const result = decodeForSchemaValidation('"hello"', { type: 'string' });
      expect(result).not.toBeNull();
      expect(result!.value).toBe('hello');
      expect(result!.warnings).toEqual([]);
    });

    it('coerces double-encoded JSON object when schema expects object', () => {
      const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
      const result = decodeForSchemaValidation(doubleEncoded, { type: 'object' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ name: 'John' });
      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0]).toContain('Coerced double-encoded JSON');
    });

    it('coerces double-encoded JSON array when schema expects array', () => {
      const doubleEncoded = '"[1, 2, 3]"';
      const result = decodeForSchemaValidation(doubleEncoded, { type: 'array' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toEqual([1, 2, 3]);
      expect(result!.warnings).toHaveLength(1);
      expect(result!.warnings[0]).toContain('Coerced double-encoded JSON');
    });

    it('does NOT coerce when schema expects string', () => {
      const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
      const result = decodeForSchemaValidation(doubleEncoded, { type: 'string' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toBe('{"name": "John"}');
      expect(result!.warnings).toEqual([]);
    });

    it('does NOT coerce when inner parse fails', () => {
      const invalidInner = '"{not valid json}"';
      const result = decodeForSchemaValidation(invalidInner, { type: 'object' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toBe('{not valid json}');
      expect(result!.warnings).toEqual([]);
    });

    it('does NOT coerce when inner is primitive', () => {
      const primitiveInner = '"42"';
      const result = decodeForSchemaValidation(primitiveInner, { type: 'object' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toBe('42');
      expect(result!.warnings).toEqual([]);
    });

    it('does NOT coerce when inner is null', () => {
      const nullInner = '"null"';
      const result = decodeForSchemaValidation(nullInner, { type: 'object' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toBe('null');
      expect(result!.warnings).toEqual([]);
    });

    it('coerces when schema has properties (object-ish heuristic)', () => {
      const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
      const result = decodeForSchemaValidation(doubleEncoded, { properties: { name: { type: 'string' } } });
      
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ name: 'John' });
      expect(result!.warnings).toHaveLength(1);
    });

    it('does NOT coerce triple-encoded JSON (only one unwrap level)', () => {
      const tripleEncoded = '"\\"{\\\\\\"name\\\\\\": \\\\\\"John\\\\\\"}\\""';
      const result = decodeForSchemaValidation(tripleEncoded, { type: 'object' });
      
      // Should parse to a string (second layer), not unwrap to object
      expect(result).not.toBeNull();
      expect(typeof result!.value).toBe('string');
      expect(result!.warnings).toEqual([]);
    });

    it('handles whitespace variations in inner JSON', () => {
      const doubleEncoded = '"  { \\"name\\": \\"John\\" }  "';
      const result = decodeForSchemaValidation(doubleEncoded, { type: 'object' });
      
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ name: 'John' });
      expect(result!.warnings).toHaveLength(1);
    });

    it('handles schema with oneOf containing object', () => {
      const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
      const schema = {
        oneOf: [
          { type: 'string' },
          { type: 'object', properties: { name: {} } }
        ]
      };
      const result = decodeForSchemaValidation(doubleEncoded, schema);
      
      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ name: 'John' });
      expect(result!.warnings).toHaveLength(1);
    });

    it('does NOT coerce when schema uses $ref (known limitation)', () => {
      const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
      const result = decodeForSchemaValidation(doubleEncoded, { $ref: '#/$defs/User' });
      
      // Cannot determine if $ref points to object without resolution context
      expect(result).not.toBeNull();
      expect(result!.value).toBe('{"name": "John"}');
      expect(result!.warnings).toEqual([]);
    });
  });
});
