/**
 * Handler Factory
 *
 * Creates wrapped tool handlers that:
 * 1. Parse and validate input with Zod
 * 2. Generate "did you mean?" suggestions on validation errors
 * 3. Convert ToolResult to MCP SDK format
 *
 * Extracted from server.ts to enable registries to produce ready-to-dispatch handlers.
 * This follows "validate at boundaries, trust inside" - the boundary is here.
 *
 * @module mcp/handler-factory
 */

import { z } from 'zod';
import type { ToolContext, ToolResult, ToolError } from './types.js';
import { errNotRetryable } from './types.js';
import { buildCoercionFn } from './boundary-coercion.js';
import {
  generateSuggestions,
  formatSuggestionDetails,
  DEFAULT_SUGGESTION_CONFIG,
  patchTemplateForFailedOptionals,
} from './validation/index.js';
import { toBoundedJsonValue } from './validation/bounded-json.js';
import type { PreValidateResult } from './validation/workflow-next-prevalidate.js';
import type { WrappedToolHandler, McpCallToolResult } from './types/workflow-tool-edition.js';
import { internalSuggestion } from './handlers/v2-execution-helpers.js';
import { formatV2ExecutionResponse, formatV2ResumeResponse, type FormattedResponse } from './v2-response-formatter.js';
import { getV2ExecutionRenderEnvelope } from './render-envelope.js';

// -----------------------------------------------------------------------------
// Result Conversion
// -----------------------------------------------------------------------------

/**
 * Convert our ToolResult<T> to MCP's CallToolResult format.
 *
 * For error results, serializes the unified envelope:
 * { code, message, retry, details? }
 */
const jsonResponsesOverride = process.env.WORKRAIL_JSON_RESPONSES === 'true';

export function toMcpResult<T>(result: ToolResult<T>): McpCallToolResult {
  switch (result.type) {
    case 'success': {
      if (!jsonResponsesOverride) {
        const formatted: FormattedResponse | null =
          formatV2ExecutionResponse(result.data) ?? formatV2ResumeResponse(result.data);
        if (formatted !== null) {
          const content: { type: 'text'; text: string }[] = [{ type: 'text', text: formatted.primary }];
          if (formatted.references != null) {
            content.push({ type: 'text', text: formatted.references.text });
          }
          for (const supplement of formatted.supplements ?? []) {
            content.push({ type: 'text', text: supplement.text });
          }
          return { content };
        }
      }
      // JSON mode: include references alongside the response when present
      const envelope = getV2ExecutionRenderEnvelope(result.data);
      const responseBody = envelope != null ? envelope.response : result.data;
      const refs = envelope?.contentEnvelope?.references;
      const jsonPayload = (refs != null && refs.length > 0)
        ? { ...responseBody as Record<string, unknown>, references: refs }
        : responseBody;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(jsonPayload),
        }],
      };
    }
    case 'error':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            code: result.code,
            message: result.message,
            retry: result.retry,
            ...(result.details !== undefined ? { details: result.details } : {}),
          }),
        }],
        isError: true,
      };
  }
}

// -----------------------------------------------------------------------------
// Handler Factories
// -----------------------------------------------------------------------------

/**
 * Create a type-safe handler wrapper that parses input with Zod.
 *
 * When validation fails, generates "did you mean?" suggestions to help
 * agents self-correct parameter naming and structure mistakes.
 *
 * For schemas with transforms/refinements, provide the separate shape schema
 * (canonical source) for introspection. The validation schema handles runtime
 * validation; the shape schema provides the structural contract for error guidance.
 *
 * @param schema - Zod schema for input validation (may include transforms/pipes)
 * @param handler - Raw handler function (takes typed input)
 * @param shapeSchema - Optional bare ZodObject for introspection (defaults to schema)
 * @returns Wrapped handler ready for MCP dispatch
 */
export function createHandler<TInput extends z.ZodType, TOutput>(
  schema: TInput,
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult<TOutput>>,
  shapeSchema?: z.ZodObject<z.ZodRawShape>,
  aliasMap?: Readonly<Record<string, string>>,
): WrappedToolHandler {
  // Pre-compute the coercion function once at registration time.
  // Avoids per-call schema traversal (building objectFields Set) on the hot path.
  const coerce = shapeSchema !== undefined
    ? buildCoercionFn(shapeSchema, aliasMap)
    : null;

  return async (args: unknown, ctx: ToolContext): Promise<McpCallToolResult> => {
    // Normalize JSON-encoded string values to objects before Zod validation.
    // Some MCP clients serialize complex parameters as JSON strings rather than
    // inline objects. The shape schema identifies which fields expect objects.
    const normalizedArgs = coerce !== null ? coerce(args) : args;
    const parseResult = schema.safeParse(normalizedArgs);
    if (!parseResult.success) {
      // Use shape schema for introspection (interface segregation), validation schema as fallback
      const introspectionSchema = shapeSchema ?? schema;

      // Generate suggestions for self-correction (pure, deterministic)
      const suggestionResult = generateSuggestions(normalizedArgs, introspectionSchema, DEFAULT_SUGGESTION_CONFIG, aliasMap);
      const suggestionDetails = formatSuggestionDetails(suggestionResult);

      // Restore optional fields that the agent provided with the wrong type.
      // Without this, agents see a template that omits their field (e.g., context)
      // and infer they should drop it entirely on retry — exactly the wrong move.
      const patchedTemplate = patchTemplateForFailedOptionals(
        (suggestionDetails.correctTemplate as Readonly<Record<string, unknown>> | null) ?? null,
        normalizedArgs,
        parseResult.error.errors,
        introspectionSchema,
        DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
      );
      const patchedDetails = patchedTemplate !== suggestionDetails.correctTemplate
        ? { ...suggestionDetails, correctTemplate: patchedTemplate }
        : suggestionDetails;

      return toMcpResult(
        errNotRetryable('VALIDATION_ERROR', 'Invalid input', {
          validationErrors: parseResult.error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          ...patchedDetails,
        })
      );
    }
    // Boundary safety net: if a handler throws instead of returning ToolResult,
    // catch the exception and convert it to a structured error envelope.
    // This prevents raw Error objects from leaking to the MCP SDK.
    try {
      return toMcpResult(await handler(parseResult.data, ctx));
    } catch (err) {
      // Log the raw error for server-side debugging (stderr, not agent-facing)
      console.error('[WorkRail] Unhandled exception in tool handler:', err);
      return toMcpResult(
        errNotRetryable('INTERNAL_ERROR',
          'WorkRail encountered an unexpected error. This is not caused by your input.',
          { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal error.') },
        )
      );
    }
  };
}

/**
 * Create a handler with pre-validation (for validation-heavy tools).
 *
 * Pre-validation runs before Zod parsing to provide better error UX
 * with domain-specific suggestions (e.g., correct state templates).
 *
 * @param schema - Zod schema for input validation
 * @param preValidate - Pre-validation function
 * @param handler - Raw handler function (takes typed input)
 * @param shapeSchema - Optional bare ZodObject for introspection and JSON-string coercion
 * @param aliasMap - Optional alias-to-canonical field name map
 * @returns Wrapped handler ready for MCP dispatch
 */
export function createValidatingHandler<TInput extends z.ZodType, TOutput>(
  schema: TInput,
  preValidate: (args: unknown) => PreValidateResult,
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult<TOutput>>,
  shapeSchema?: z.ZodObject<z.ZodRawShape>,
  aliasMap?: Readonly<Record<string, string>>,
): WrappedToolHandler {
  // Pre-compute the coercion function once at registration time.
  const coerce = shapeSchema !== undefined
    ? buildCoercionFn(shapeSchema, aliasMap)
    : null;

  // Pre-build the inner handler at registration time.
  // Pass shapeSchema for introspection but omit aliasMap — coercion happens
  // above via the pre-computed coerce fn, so the inner handler only needs
  // shapeSchema for error-path suggestion generation.
  const innerHandler = createHandler(schema, handler, shapeSchema);

  return async (args: unknown, ctx: ToolContext): Promise<McpCallToolResult> => {
    // Normalize JSON-encoded string fields before pre-validation and Zod parsing.
    const normalizedArgs = coerce !== null ? coerce(args) : args;
    const pre = preValidate(normalizedArgs);
    if (!pre.ok) {
      const error = pre.error;

      // Extract correctTemplate from details and bound it if present
      const details = error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
      const correctTemplate = details.correctTemplate;

      // If template exists, bound it to prevent oversized payloads
      if (correctTemplate !== undefined) {
        const boundedTemplate = toBoundedJsonValue(correctTemplate, 512);
        // Construct new details object with bounded template
        const boundedDetails: Record<string, unknown> = {
          ...details,
          correctTemplate: boundedTemplate,
        };
        const boundedError: ToolError = {
          ...error,
          details: boundedDetails as ToolError['details'],
        };
        return toMcpResult(boundedError);
      }

      return toMcpResult(error);
    }

    // Fall back to the standard Zod + handler pipeline.
    // Pass normalizedArgs — args are already coerced above, so the inner
    // handler's coerce fn (built without aliasMap) is a safe no-op.
    return innerHandler(normalizedArgs, ctx);
  };
}
