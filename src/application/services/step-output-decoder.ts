export interface SchemaDecodeResult {
  readonly value: unknown;
  readonly warnings: readonly string[];
}

const COERCION_WARNING =
  'Coerced double-encoded JSON (JSON string containing JSON) into an object/array for schema validation.';

export function decodeForSchemaValidation(output: string, schema: unknown): SchemaDecodeResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  // Coerce only when schema expects object/array and the parsed value is a JSON string containing JSON.
  if (typeof parsed === 'string' && schemaExpectsObjectOrArray(schema)) {
    const inner = parsed.trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        const innerParsed = JSON.parse(inner);
        if (innerParsed !== null && typeof innerParsed === 'object') {
          return { value: innerParsed, warnings: [COERCION_WARNING] };
        }
      } catch {
        // fall through to non-coerced return
      }
    }
  }

  return { value: parsed, warnings: [] };
}

/**
 * Determines if a JSON schema expects object or array values.
 * 
 * LIMITATIONS:
 * - Does NOT resolve $ref references. Schemas using { "$ref": "#/$defs/User" }
 *   will return false even if the referenced schema is object/array.
 *   To fix this, schema resolution context is required.
 * - Does NOT handle conditional schemas (if/then/else, dependentSchemas, etc.).
 * 
 * CURRENT USAGE:
 * As of 2025-01-01, no workflows in this repo use schema-type validation rules
 * (all use contains/regex/length). The limitation is theoretical until schema
 * validation is adopted in practice.
 */
export function schemaExpectsObjectOrArray(schema: unknown): boolean {
  if (schema == null || typeof schema !== 'object') return false;
  const s = schema as any;

  const t = s.type;
  if (t === 'object' || t === 'array') return true;
  if (Array.isArray(t) && (t.includes('object') || t.includes('array'))) return true;

  // Heuristic: properties/required implies object-ish schema even if type omitted.
  if (s.properties && typeof s.properties === 'object') return true;
  if (Array.isArray(s.required) && s.required.length > 0) return true;

  const combos = ['oneOf', 'anyOf', 'allOf'] as const;
  for (const k of combos) {
    if (Array.isArray(s[k]) && s[k].some((child: unknown) => schemaExpectsObjectOrArray(child))) {
      return true;
    }
  }
  return false;
}