/**
 * MCP boundary coercion: normalizes JSON-encoded string fields to objects
 * before Zod validation runs, so clients that serialize parameters as strings
 * instead of inline objects do not produce spurious type errors.
 *
 * @module mcp/boundary-coercion
 */

import { z } from 'zod';
import { getCachedShape } from './validation/schema-introspection.js';

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Unwrap Zod wrapper types to expose the base validator for type inspection.
 *
 * Handles: ZodOptional, ZodDefault, ZodEffects (transforms, refinements,
 * and z.preprocess wrappers). Stops at the first unwrappable type.
 */
function unwrapToBaseType(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      current = current._def.innerType as z.ZodType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema as z.ZodType;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Return true if the field schema expects an object or record at runtime.
 *
 * Unwraps Optional/Default/Effects wrappers before checking the base type
 * so that e.g. z.record(...).optional() is correctly identified.
 */
function expectsObjectValue(fieldSchema: z.ZodType): boolean {
  const base = unwrapToBaseType(fieldSchema);
  return base instanceof z.ZodObject || base instanceof z.ZodRecord;
}

/**
 * Parse a JSON string and return the result only if it is a plain object.
 * Returns null for invalid JSON, primitives, and arrays.
 */
function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Build a coercion function that pre-computes the set of fields to coerce
 * at handler-registration time rather than on every call.
 *
 * Use this factory when the schema and aliasMap are known ahead of time
 * (e.g. at MCP handler registration). The returned function has the same
 * semantics as coerceJsonStringObjectFields but avoids per-call schema
 * traversal.
 *
 * @param shapeSchema - ZodObject schema describing the expected input shape
 * @param aliasMap - Optional alias-to-canonical field name map
 * @returns Coercion function with pre-computed field sets
 */
export function buildCoercionFn(
  shapeSchema: z.ZodObject<z.ZodRawShape>,
  aliasMap?: Readonly<Record<string, string>>,
): (args: unknown) => unknown {
  const shape = getCachedShape(shapeSchema);

  // Pre-compute once at registration time.
  const objectFields = new Set<string>();
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (expectsObjectValue(fieldSchema as z.ZodType)) {
      objectFields.add(key);
    }
  }

  const aliasesToCoerce = new Set<string>();
  if (aliasMap) {
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      if (objectFields.has(canonical)) {
        aliasesToCoerce.add(alias);
      }
    }
  }

  const hasCoercibleFields = objectFields.size > 0 || aliasesToCoerce.size > 0;

  return (args: unknown): unknown => {
    if (!hasCoercibleFields) return args;
    if (typeof args !== 'object' || args === null) return args;

    const input = args as Record<string, unknown>;
    let result: Record<string, unknown> | null = null;

    const coerceField = (key: string): void => {
      const value = input[key];
      if (typeof value !== 'string') return;
      const parsed = tryParseJsonObject(value);
      if (parsed === null) return;
      if (result === null) result = { ...input };
      result[key] = parsed;
    };

    for (const key of objectFields) coerceField(key);
    for (const alias of aliasesToCoerce) coerceField(alias);

    return result ?? args;
  };
}

/**
 * For each field in shapeSchema that expects a ZodObject or ZodRecord value,
 * parse it from JSON if the raw value is a string. Aliased fields are included
 * via aliasMap. Returns the original args reference when nothing needs coercion.
 *
 * Prefer buildCoercionFn when schema and aliasMap are known at handler
 * registration time — it pre-computes the field sets once rather than on
 * every call.
 */
export function coerceJsonStringObjectFields(
  args: unknown,
  shapeSchema: z.ZodObject<z.ZodRawShape>,
  aliasMap?: Readonly<Record<string, string>>,
): unknown {
  if (typeof args !== 'object' || args === null) return args;

  const input = args as Record<string, unknown>;
  const shape = shapeSchema._def.shape();

  // Identify canonical fields that expect object values.
  const objectFields = new Set<string>();
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (expectsObjectValue(fieldSchema as z.ZodType)) {
      objectFields.add(key);
    }
  }

  // Build alias -> canonical lookup restricted to object-typed canonical fields.
  // Aliases that map to non-object canonicals are not coerced.
  const aliasesToCoerce = new Set<string>();
  if (aliasMap) {
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      if (objectFields.has(canonical)) {
        aliasesToCoerce.add(alias);
      }
    }
  }

  if (objectFields.size === 0 && aliasesToCoerce.size === 0) return args;

  // Lazy copy: only allocate a new object if at least one field is coerced.
  let result: Record<string, unknown> | null = null;

  const coerceField = (key: string): void => {
    const value = input[key];
    if (typeof value !== 'string') return;
    const parsed = tryParseJsonObject(value);
    if (parsed === null) return;
    if (result === null) result = { ...input };
    result[key] = parsed;
  };

  for (const key of objectFields) coerceField(key);
  for (const alias of aliasesToCoerce) coerceField(alias);

  return result ?? args;
}
