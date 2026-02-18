/**
 * Schema Introspection Utilities
 *
 * Pure functions for extracting information from Zod schemas.
 * Used to understand expected structure for suggestions.
 *
 * Philosophy:
 * - Pure functions (deterministic, no side effects)
 * - Validate at boundaries, trust inside
 * - Schemas with transforms/refinements provide a separate "shape schema"
 *   for introspection (interface segregation)
 *
 * @module mcp/validation/schema-introspection
 */

import { z } from 'zod';

/**
 * Extract all expected keys from a Zod object schema.
 *
 * For schemas with transforms/refinements, pass the separate shape schema
 * (the canonical source) rather than the wrapped validation schema.
 *
 * @param schema - A bare ZodObject schema (introspection contract)
 * @returns Array of expected key names (empty if not a ZodObject)
 */
export function extractExpectedKeys(schema: z.ZodType): readonly string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema._def.shape());
  }
  return [];
}

/**
 * Extract required keys from a Zod object schema.
 *
 * A key is required if it's not optional and has no default.
 * For schemas with transforms, pass the shape schema (canonical source).
 *
 * @param schema - A bare ZodObject schema
 * @returns Array of required key names
 */
export function extractRequiredKeys(schema: z.ZodType): readonly string[] {
  if (!(schema instanceof z.ZodObject)) {
    return [];
  }

  const shape = schema._def.shape();
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodType;
    if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
      required.push(key);
    }
  }

  return required;
}

/**
 * Find keys in the provided object that are not in the schema.
 *
 * @param args - The input arguments (unknown type from MCP)
 * @param schema - The expected Zod schema
 * @returns Array of unknown key names
 */
export function findUnknownKeys(args: unknown, schema: z.ZodType): readonly string[] {
  if (typeof args !== 'object' || args === null) {
    return [];
  }

  const expectedKeys = new Set(extractExpectedKeys(schema));
  const providedKeys = Object.keys(args);

  return providedKeys.filter(key => !expectedKeys.has(key));
}

/**
 * Find required keys that are missing from the provided object.
 *
 * @param args - The input arguments
 * @param schema - The expected Zod schema
 * @returns Array of missing required key names
 */
export function findMissingRequiredKeys(args: unknown, schema: z.ZodType): readonly string[] {
  if (typeof args !== 'object' || args === null) {
    return extractRequiredKeys(schema);
  }

  const providedKeys = new Set(Object.keys(args));
  const requiredKeys = extractRequiredKeys(schema);

  return requiredKeys.filter(key => !providedKeys.has(key));
}

/**
 * Generate an example value for a Zod type.
 *
 * Creates a representative value that shows the expected structure.
 * Uses placeholders for values to indicate type expectations.
 *
 * @param schema - A Zod schema
 * @param depth - Current recursion depth (for limiting nested objects)
 * @param maxDepth - Maximum recursion depth
 * @param includeOptional - When true, optional object fields are included in
 *   the output. Use true for error-guidance templates so agents see the full
 *   valid structure rather than a minimal required-only skeleton.
 * @returns Example value or placeholder string
 */
export function generateExampleValue(
  schema: z.ZodType,
  depth: number = 0,
  maxDepth: number = 3,
  includeOptional: boolean = false,
): unknown {
  // Prevent infinite recursion
  if (depth > maxDepth) {
    return '...';
  }

  // Handle ZodDefault - use the default value
  if (schema instanceof z.ZodDefault) {
    return schema._def.defaultValue();
  }

  // Handle ZodOptional - unwrap and generate
  if (schema instanceof z.ZodOptional) {
    return generateExampleValue(schema._def.innerType, depth, maxDepth, includeOptional);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape();
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(shape)) {
      const field = value as z.ZodType;
      // When includeOptional is false, skip optional fields to keep templates
      // concise (e.g. for required-field examples). When true (error guidance),
      // include them so agents can see the full valid input structure.
      if (!includeOptional && field instanceof z.ZodOptional) continue;
      result[key] = generateExampleValue(field, depth + 1, maxDepth, includeOptional);
    }

    return result;
  }

  // Handle ZodDiscriminatedUnion - use the first variant
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema._def.options as Array<z.ZodType>;
    if (options.length > 0) {
      return generateExampleValue(options[0], depth + 1, maxDepth, includeOptional);
    }
    return {};
  }

  // Handle ZodString
  if (schema instanceof z.ZodString) {
    const description = schema._def.description;
    if (description) {
      return `<${description}>`;
    }
    return '<string>';
  }

  // Handle ZodNumber
  if (schema instanceof z.ZodNumber) {
    return '<number>';
  }

  // Handle ZodBoolean
  if (schema instanceof z.ZodBoolean) {
    return '<boolean>';
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    return [];
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    const values = schema._def.values as string[];
    if (values.length > 0) {
      return values[0];
    }
    return '<enum>';
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    return schema._def.value;
  }

  // Handle ZodRecord
  if (schema instanceof z.ZodRecord) {
    return {};
  }

  // Handle ZodUnknown / ZodAny
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return '<any>';
  }

  // Handle ZodEffects (transforms, refinements) — unwrap to inner schema
  if (schema instanceof z.ZodEffects) {
    return generateExampleValue(schema._def.schema, depth, maxDepth, includeOptional);
  }

  // Fallback
  return '<unknown>';
}

/**
 * Generate a complete template showing expected input structure.
 *
 * For schemas with transforms/refinements, pass the shape schema (canonical
 * source) not the wrapped validation schema. This follows interface segregation:
 * introspection reads structure, validation enforces constraints.
 *
 * @param schema - A bare ZodObject schema (introspection contract)
 * @param maxDepth - Maximum recursion depth
 * @param includeOptional - When true, optional fields are included. Use true
 *   for error-guidance templates so agents see the full valid structure.
 * @returns Template object or null if not a ZodObject
 */
export function generateTemplate(
  schema: z.ZodType,
  maxDepth: number = 3,
  includeOptional: boolean = false,
): Readonly<Record<string, unknown>> | null {
  if (!(schema instanceof z.ZodObject)) {
    return null;
  }

  const example = generateExampleValue(schema, 0, maxDepth, includeOptional);
  if (typeof example === 'object' && example !== null) {
    return example as Readonly<Record<string, unknown>>;
  }

  return null;
}

/**
 * Extract enum values from a field if it's an enum type.
 *
 * @param schema - A Zod schema
 * @param path - Dot-separated path to the field
 * @returns Array of allowed values, or empty if not an enum
 */
export function extractEnumValues(schema: z.ZodType, path: string): readonly string[] {
  const parts = path.split('.');
  let current: z.ZodType = schema;

  for (const part of parts) {
    if (current instanceof z.ZodObject) {
      const shape = current._def.shape();
      const field = shape[part] as z.ZodType | undefined;
      if (!field) return [];
      current = field;
    } else if (current instanceof z.ZodOptional) {
      current = current._def.innerType;
      // Re-check with the unwrapped type
      if (current instanceof z.ZodObject) {
        const shape = current._def.shape();
        const field = shape[part] as z.ZodType | undefined;
        if (!field) return [];
        current = field;
      } else {
        return [];
      }
    } else {
      return [];
    }
  }

  // Unwrap optional/default
  if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current._def.innerType;
  }

  // Check if it's an enum
  if (current instanceof z.ZodEnum) {
    return current._def.values as string[];
  }

  // Check if it's a literal (single allowed value)
  if (current instanceof z.ZodLiteral) {
    const value = current._def.value;
    if (typeof value === 'string') {
      return [value];
    }
  }

  return [];
}
