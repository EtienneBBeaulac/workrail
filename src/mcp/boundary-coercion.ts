/**
 * MCP Boundary Input Coercion
 *
 * Normalizes raw MCP tool input before Zod validation runs.
 *
 * Why this exists: some MCP clients (e.g. Claude Code's tool call serializer)
 * send complex object parameters as JSON-encoded strings rather than inline
 * JSON objects. Zod's z.record() and z.object() validators reject string values
 * even when the string is a valid JSON representation of the expected type,
 * producing unhelpful "Expected object, received string" errors.
 *
 * The fix lives here at the boundary — the single entry point through which
 * all raw MCP input passes before reaching schema validation. No Zod schema
 * definitions are modified; the shape/validation schema split is preserved.
 *
 * @module mcp/boundary-coercion
 */

import { z } from 'zod';

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
 * Try to JSON-parse a string.
 *
 * Returns the parsed value on success. Returns the original string on failure
 * so that downstream Zod validation still produces a meaningful type error
 * ("Expected object, received string") rather than a silent no-op.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Normalize JSON-encoded string fields to objects at the MCP input boundary.
 *
 * Walks the shapeSchema to identify fields that expect ZodObject or ZodRecord
 * values. For any such field whose raw value is a JSON string, parses it to
 * an object before Zod validation runs. Aliased fields (via aliasMap) are
 * coerced alongside their canonical counterparts.
 *
 * Non-object string fields, non-string values, and strings that are not valid
 * JSON are left unchanged.
 *
 * This function is a pure transform: if no coercion is needed, it returns
 * the original args reference unchanged (no allocation).
 *
 * @param args - Raw input from the MCP client (unknown at the boundary)
 * @param shapeSchema - Canonical shape schema used for field-type introspection
 * @param aliasMap - Optional alias-to-canonical field name map
 * @returns args with JSON-string object fields replaced by their parsed values
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

    const parsed = tryParseJson(value);
    // Leave as-is if JSON.parse failed (returns original string), produced a
    // non-object primitive (e.g. "123" -> 123, '"foo"' -> "foo"), or produced
    // an array. Arrays are typeof 'object' but are not valid ZodObject/ZodRecord
    // values. Passing them through would swap "Expected object, received string"
    // for "Expected object, received array" — no improvement. Leave the original
    // string so Zod reports the error against the actual input the client sent.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    if (result === null) result = { ...input };
    result[key] = parsed;
  };

  for (const key of objectFields) coerceField(key);
  for (const alias of aliasesToCoerce) coerceField(alias);

  return result ?? args;
}
