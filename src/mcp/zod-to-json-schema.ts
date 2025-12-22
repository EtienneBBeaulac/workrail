/**
 * Zod to JSON Schema Converter
 *
 * Converts Zod schemas to JSON Schema format for MCP tool definitions.
 * This is a lightweight implementation that handles the common cases
 * used in WorkRail tool definitions.
 */

import { z } from 'zod';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  enum?: string[];
  const?: unknown;
  default?: unknown;
  description?: string;
  pattern?: string;
  minLength?: number;
  additionalProperties?: boolean | JsonSchema;
};

/**
 * Convert a Zod schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return convertZodType(schema);
}

function convertZodType(schema: z.ZodType): JsonSchema {
  // Handle ZodDefault - unwrap and add default
  if (schema instanceof z.ZodDefault) {
    const inner = convertZodType(schema._def.innerType);
    return {
      ...inner,
      default: schema._def.defaultValue(),
    };
  }

  // Handle ZodOptional - unwrap
  if (schema instanceof z.ZodOptional) {
    return convertZodType(schema._def.innerType);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodType(value as z.ZodType);

      // Check if field is required (not optional and no default)
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    const result: JsonSchema = {
      type: 'object',
      properties,
    };

    if (required.length > 0) {
      result.required = required;
    }

    // Add additionalProperties: false for strict objects
    result.additionalProperties = false;

    return result;
  }

  // Handle ZodDiscriminatedUnion (e.g., state machines)
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const discriminator = schema._def.discriminator as string;
    const options = schema._def.options as Array<z.ZodType>;
    return {
      oneOf: options.map((opt) => {
        // Best-effort: each option is typically a ZodObject with a literal discriminator.
        const s = convertZodType(opt);
        if (s.type !== 'object') return s;

        // Ensure discriminator appears required (helps clients / agents)
        const required = new Set(s.required ?? []);
        required.add(discriminator);
        return {
          ...s,
          required: Array.from(required),
        };
      }),
    };
  }

  // Handle ZodString
  if (schema instanceof z.ZodString) {
    const result: JsonSchema = { type: 'string' };

    // Extract checks
    for (const check of schema._def.checks) {
      if (check.kind === 'regex') {
        result.pattern = check.regex.source;
      }
      if (check.kind === 'min') {
        result.minLength = check.value;
      }
    }

    // Add description if present
    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodNumber
  if (schema instanceof z.ZodNumber) {
    const result: JsonSchema = { type: 'number' };

    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodBoolean
  if (schema instanceof z.ZodBoolean) {
    const result: JsonSchema = { type: 'boolean' };

    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    const result: JsonSchema = {
      type: 'array',
      items: convertZodType(schema._def.type),
    };

    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    const result: JsonSchema = {
      type: 'string',
      enum: schema._def.values,
    };

    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const value = schema._def.value as unknown;
    // Prefer JSON Schema "const" to preserve literal typing.
    if (typeof value === 'string') return { type: 'string', const: value };
    if (typeof value === 'number') return { type: 'number', const: value };
    if (typeof value === 'boolean') return { type: 'boolean', const: value };
    if (value === null) return { type: 'null' as any, const: null };
    return { const: value };
  }

  // Handle ZodRecord (for context objects)
  if (schema instanceof z.ZodRecord) {
    const result: JsonSchema = {
      type: 'object',
      additionalProperties: true,
    };

    if (schema._def.description) {
      result.description = schema._def.description;
    }

    return result;
  }

  // Handle ZodUnknown (fallback for any)
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return {};
  }

  // Handle ZodEffects (for transforms, refinements, etc.)
  if (schema instanceof z.ZodEffects) {
    return convertZodType(schema._def.schema);
  }

  // Default fallback
  return { type: 'object' };
}
