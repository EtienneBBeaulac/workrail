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