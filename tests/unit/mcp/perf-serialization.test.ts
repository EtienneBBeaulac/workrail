/**
 * Performance serialization tests.
 *
 * Verifies behavioral equivalence for all MCP serialization micro-optimizations:
 * 1. JSON output is compact (no indentation) and still valid
 * 2. CLEAN_RESPONSE_FORMAT behavior unchanged with env var set/unset
 * 3. buildCoercionFn factory produces same results as direct coercion
 * 4. Suggestion generator produces same suggestions on repeated calls (memoization)
 *
 * These tests are behavioral contracts - they verify the optimizations
 * do not change observable output, not the internal caching mechanism.
 *
 * @module tests/unit/mcp/perf-serialization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Fix 1: JSON compactness in toMcpResult
// -----------------------------------------------------------------------------

describe('toMcpResult JSON compactness', () => {
  beforeEach(() => {
    vi.stubEnv('WORKRAIL_JSON_RESPONSES', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('produces compact JSON (no indentation) for success responses', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const result = toMcpResult({
      type: 'success',
      data: { message: 'hello', value: 42 },
    });
    const text = result.content[0]!.text;
    // Compact JSON has no newlines from indentation
    expect(text).not.toContain('\n');
    // Must still be valid JSON
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed.message).toBe('hello');
    expect(parsed.value).toBe(42);
  });

  it('produces compact JSON for error responses', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const result = toMcpResult({
      type: 'error',
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      retry: { kind: 'not_retryable' },
    });
    const text = result.content[0]!.text;
    // Compact JSON has no newlines
    expect(text).not.toContain('\n');
    // Must still be valid JSON with all required fields
    const parsed = JSON.parse(text);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.message).toBe('Invalid input');
    expect(parsed.retry).toEqual({ kind: 'not_retryable' });
  });

  it('error response includes details when present', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const result = toMcpResult({
      type: 'error',
      code: 'NOT_FOUND',
      message: 'Not found',
      retry: { kind: 'not_retryable' },
      details: { hint: 'check the id' },
    });
    const text = result.content[0]!.text;
    expect(text).not.toContain('\n');
    const parsed = JSON.parse(text);
    expect(parsed.details).toEqual({ hint: 'check the id' });
  });

  it('error response omits details when absent', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const result = toMcpResult({
      type: 'error',
      code: 'NOT_FOUND',
      message: 'Not found',
      retry: { kind: 'not_retryable' },
    });
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.details).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Fix 2: CLEAN_RESPONSE_FORMAT env var behavior
// Note: module-level const is evaluated at import time.
// These tests verify behavioral equivalence by testing with the env var at its
// current state (not set in CI), verifying the formatter returns the expected
// format consistently.
// -----------------------------------------------------------------------------

describe('CLEAN_RESPONSE_FORMAT behavioral equivalence', () => {
  const BASE_RESPONSE = {
    continueToken: 'ct_test',
    isComplete: false,
    pending: {
      stepId: 'step-1',
      title: 'Step 1',
      prompt: 'Do the thing.',
    },
    preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
    nextIntent: 'perform_pending_then_continue',
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { continueToken: 'ct_test' },
    },
  };

  it('classic format: primary contains USER/SYSTEM section headers', async () => {
    // Without WORKRAIL_CLEAN_RESPONSE_FORMAT, formatter uses classic format
    vi.unstubAllEnvs();
    const { formatV2ExecutionResponse } = await import('../../../src/mcp/v2-response-formatter.js');
    const result = formatV2ExecutionResponse(BASE_RESPONSE);
    expect(result).not.toBeNull();
    // Classic format includes the persona delimiters
    expect(result!.primary).toContain('USER');
    expect(result!.primary).toContain('SYSTEM');
  });

  it('returns null for non-v2-execution responses regardless of format mode', async () => {
    const { formatV2ExecutionResponse } = await import('../../../src/mcp/v2-response-formatter.js');
    expect(formatV2ExecutionResponse({ foo: 'bar' })).toBeNull();
    expect(formatV2ExecutionResponse(null)).toBeNull();
    expect(formatV2ExecutionResponse('string')).toBeNull();
  });

  it('complete response: returns formatted result with isComplete/no pending', async () => {
    const { formatV2ExecutionResponse } = await import('../../../src/mcp/v2-response-formatter.js');
    const completeResponse = {
      isComplete: true,
      pending: null,
      preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
      nextIntent: 'complete',
      nextCall: null,
    };
    const result = formatV2ExecutionResponse(completeResponse);
    expect(result).not.toBeNull();
    expect(result!.primary).toContain('Workflow Complete');
  });
});

// -----------------------------------------------------------------------------
// Fix 3: buildCoercionFn factory - same output as direct coercion
// -----------------------------------------------------------------------------

describe('buildCoercionFn factory behavioral equivalence', () => {
  const schema = z.object({
    token: z.string(),
    context: z.record(z.unknown()).optional(),
    output: z.object({ notesMarkdown: z.string().optional() }).optional(),
    count: z.number().optional(),
  });

  const aliasMap: Readonly<Record<string, string>> = {
    contextVars: 'context',
  };

  it('factory function exists and returns a function', async () => {
    const { buildCoercionFn } = await import('../../../src/mcp/boundary-coercion.js');
    const coerce = buildCoercionFn(schema, aliasMap);
    expect(typeof coerce).toBe('function');
  });

  it('coerces JSON-string context field same as direct coercion', async () => {
    const { buildCoercionFn, coerceJsonStringObjectFields } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', context: '{"branch":"main"}' };
    const coerce = buildCoercionFn(schema, aliasMap);
    const factoryResult = coerce(args) as Record<string, unknown>;
    const directResult = coerceJsonStringObjectFields(args, schema, aliasMap) as Record<string, unknown>;
    expect(factoryResult.context).toEqual(directResult.context);
    expect(factoryResult.token).toBe(directResult.token);
  });

  it('returns same reference when no coercion needed (no allocation)', async () => {
    const { buildCoercionFn } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', count: 3 };
    const coerce = buildCoercionFn(schema, aliasMap);
    expect(coerce(args)).toBe(args);
  });

  it('returns a new object when coercion occurs', async () => {
    const { buildCoercionFn } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', context: '{"x":1}' };
    const coerce = buildCoercionFn(schema, aliasMap);
    expect(coerce(args)).not.toBe(args);
  });

  it('calling factory fn multiple times produces identical results', async () => {
    const { buildCoercionFn } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', context: '{"branch":"main","phase":"1"}' };
    const coerce = buildCoercionFn(schema, aliasMap);
    const result1 = coerce(args) as Record<string, unknown>;
    const result2 = coerce(args) as Record<string, unknown>;
    expect(result1.context).toEqual(result2.context);
  });

  it('handles aliased field coercion same as direct', async () => {
    const { buildCoercionFn, coerceJsonStringObjectFields } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', contextVars: '{"branch":"dev"}' };
    const coerce = buildCoercionFn(schema, aliasMap);
    const factoryResult = coerce(args) as Record<string, unknown>;
    const directResult = coerceJsonStringObjectFields(args, schema, aliasMap) as Record<string, unknown>;
    expect(factoryResult.contextVars).toEqual(directResult.contextVars);
  });

  it('handles null args same as direct', async () => {
    const { buildCoercionFn, coerceJsonStringObjectFields } = await import('../../../src/mcp/boundary-coercion.js');
    const coerce = buildCoercionFn(schema, aliasMap);
    expect(coerce(null)).toBe(coerceJsonStringObjectFields(null, schema, aliasMap));
  });

  it('factory without aliasMap coerces canonical fields only', async () => {
    const { buildCoercionFn } = await import('../../../src/mcp/boundary-coercion.js');
    const args = { token: 'ct_abc', output: '{"notesMarkdown":"done"}' };
    const coerce = buildCoercionFn(schema);
    const result = coerce(args) as Record<string, unknown>;
    expect(result.output).toEqual({ notesMarkdown: 'done' });
  });
});

// -----------------------------------------------------------------------------
// Fix 4: Suggestion generator memoization - same suggestions on repeated calls
// -----------------------------------------------------------------------------

describe('suggestion generator memoization behavioral equivalence', () => {
  const schema = z.object({
    workflowId: z.string().describe('Workflow ID to start'),
    workspacePath: z.string().describe('Absolute workspace path'),
    goal: z.string().optional(),
  });

  const config = {
    similarityThreshold: 0.6,
    maxSuggestions: 5,
    includeTemplate: true,
    maxTemplateDepth: 3,
    includeOptionalInTemplate: false,
  };

  it('generateSuggestions produces identical results on repeated calls with same schema', async () => {
    const { generateSuggestions } = await import('../../../src/mcp/validation/suggestion-generator.js');
    const args = { workflowId_typo: 'my-workflow', workspacePath: '/Users/me/repo' };
    const result1 = generateSuggestions(args, schema, config);
    const result2 = generateSuggestions(args, schema, config);
    expect(result1.suggestions).toEqual(result2.suggestions);
    expect(result1.correctTemplate).toEqual(result2.correctTemplate);
  });

  it('produces correct suggestions for unknown key', async () => {
    const { generateSuggestions } = await import('../../../src/mcp/validation/suggestion-generator.js');
    const args = { workflowId_typo: 'my-workflow' };
    const result = generateSuggestions(args, schema, config);
    // Should suggest workflowId for workflowId_typo
    const unknownSuggestions = result.suggestions.filter(s => s.kind === 'unknown_key');
    expect(unknownSuggestions.length).toBeGreaterThan(0);
  });

  it('produces template when includeTemplate is true', async () => {
    const { generateSuggestions } = await import('../../../src/mcp/validation/suggestion-generator.js');
    const args = { wrong_key: 'value' };
    const result = generateSuggestions(args, schema, config);
    expect(result.correctTemplate).not.toBeNull();
    expect(result.correctTemplate).toHaveProperty('workflowId');
    expect(result.correctTemplate).toHaveProperty('workspacePath');
  });

  it('different schema instances produce independent results', async () => {
    const { generateSuggestions } = await import('../../../src/mcp/validation/suggestion-generator.js');
    const schema2 = z.object({
      sessionId: z.string(),
      query: z.string().optional(),
    });
    const args = { unknown_field: 'val' };
    const result1 = generateSuggestions(args, schema, config);
    const result2 = generateSuggestions(args, schema2, config);
    // Different schemas should produce different templates
    expect(result1.correctTemplate).not.toEqual(result2.correctTemplate);
  });

  it('extractExpectedKeys returns consistent results for same schema', async () => {
    const { extractExpectedKeys } = await import('../../../src/mcp/validation/schema-introspection.js');
    const keys1 = extractExpectedKeys(schema);
    const keys2 = extractExpectedKeys(schema);
    expect(keys1).toEqual(keys2);
    expect(keys1).toContain('workflowId');
    expect(keys1).toContain('workspacePath');
    expect(keys1).toContain('goal');
  });
});
