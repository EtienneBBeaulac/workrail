import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  // String similarity
  levenshteinDistance,
  computeSimilarity,
  computeSimilarityIgnoreCase,
  findClosestMatch,
  findAllMatches,
  similarity,
  // Schema introspection
  extractExpectedKeys,
  extractRequiredKeys,
  findUnknownKeys,
  findMissingRequiredKeys,
  generateExampleValue,
  generateTemplate,
  // Suggestion generation
  generateSuggestions,
  formatSuggestionDetails,
  hasSuggestions,
  patchTemplateForFailedOptionals,
  DEFAULT_SUGGESTION_CONFIG,
  EMPTY_SUGGESTION_RESULT,
} from '../../src/mcp/validation/index.js';

// -----------------------------------------------------------------------------
// Test Schemas (use REAL Zod schemas, not mocks)
// -----------------------------------------------------------------------------

const SimpleSchema = z.object({
  workflowId: z.string().describe('The workflow ID'),
  mode: z.enum(['metadata', 'preview']).default('preview'),
});

const ComplexSchema = z.object({
  workflowId: z.string().regex(/^[A-Za-z0-9_-]+$/).describe('Workflow identifier'),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('init') }),
    z.object({
      kind: z.literal('running'),
      completed: z.array(z.string()),
    }),
    z.object({ kind: z.literal('complete') }),
  ]).describe('Execution state'),
  context: z.record(z.unknown()).optional().describe('External context'),
});

// -----------------------------------------------------------------------------
// String Similarity Tests
// -----------------------------------------------------------------------------

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length for empty vs non-empty', () => {
    expect(levenshteinDistance('', 'hello')).toBe(5);
    expect(levenshteinDistance('hello', '')).toBe(5);
  });

  it('computes correct distance for single edit', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1); // substitution
    expect(levenshteinDistance('cat', 'cats')).toBe(1); // insertion
    expect(levenshteinDistance('cats', 'cat')).toBe(1); // deletion
  });

  it('computes correct distance for multiple edits', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('workflow_id', 'workflowId')).toBe(2);
  });

  it('is deterministic (same inputs, same output)', () => {
    const d1 = levenshteinDistance('abc', 'xyz');
    const d2 = levenshteinDistance('abc', 'xyz');
    expect(d1).toBe(d2);
  });
});

describe('computeSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(computeSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(computeSimilarity('', 'hello')).toBe(0);
    expect(computeSimilarity('hello', '')).toBe(0);
  });

  it('returns value between 0 and 1', () => {
    const score = computeSimilarity('workflow_id', 'workflowId');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('handles snake_case to camelCase conversion', () => {
    // workflow_id vs workflowId should have high similarity
    const score = computeSimilarityIgnoreCase('workflow_id', 'workflowId');
    expect(score).toBeGreaterThan(0.7);
  });
});

describe('findClosestMatch', () => {
  const candidates = ['workflowId', 'state', 'context', 'mode'];

  it('finds exact match with score 1.0', () => {
    const result = findClosestMatch('workflowId', candidates, similarity(0.5));
    expect(result).not.toBeNull();
    expect(result?.match).toBe('workflowId');
    expect(result?.score).toBe(1);
  });

  it('finds close match for typo', () => {
    const result = findClosestMatch('workflow_id', candidates, similarity(0.6));
    expect(result).not.toBeNull();
    expect(result?.match).toBe('workflowId');
  });

  it('returns null when no match meets threshold', () => {
    const result = findClosestMatch('xyz', candidates, similarity(0.9));
    expect(result).toBeNull();
  });

  it('returns null for empty candidates', () => {
    const result = findClosestMatch('test', [], similarity(0.5));
    expect(result).toBeNull();
  });
});

describe('findAllMatches', () => {
  const candidates = ['workflowId', 'workflowName', 'flowId', 'id'];

  it('returns matches sorted by similarity descending', () => {
    const matches = findAllMatches('workflowId', candidates, similarity(0.5), 10);
    expect(matches.length).toBeGreaterThan(0);
    // First should be exact match
    expect(matches[0].match).toBe('workflowId');
    expect(matches[0].score).toBe(1);
  });

  it('respects limit parameter', () => {
    const matches = findAllMatches('work', candidates, similarity(0.3), 2);
    expect(matches.length).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// Schema Introspection Tests
// -----------------------------------------------------------------------------

describe('extractExpectedKeys', () => {
  it('extracts keys from object schema', () => {
    const keys = extractExpectedKeys(SimpleSchema);
    expect(keys).toContain('workflowId');
    expect(keys).toContain('mode');
  });

  it('returns empty for non-object schema', () => {
    const keys = extractExpectedKeys(z.string());
    expect(keys).toEqual([]);
  });
});

describe('extractRequiredKeys', () => {
  it('extracts only required keys', () => {
    const keys = extractRequiredKeys(SimpleSchema);
    expect(keys).toContain('workflowId');
    // mode has default, so not required
    expect(keys).not.toContain('mode');
  });

  it('handles complex schemas', () => {
    const keys = extractRequiredKeys(ComplexSchema);
    expect(keys).toContain('workflowId');
    expect(keys).toContain('state');
    expect(keys).not.toContain('context'); // optional
  });
});

describe('findUnknownKeys', () => {
  it('finds keys not in schema', () => {
    const args = { workflow_id: 'test', unknown_key: true };
    const unknown = findUnknownKeys(args, SimpleSchema);
    expect(unknown).toContain('workflow_id');
    expect(unknown).toContain('unknown_key');
    expect(unknown).not.toContain('workflowId');
  });

  it('returns empty for valid keys', () => {
    const args = { workflowId: 'test', mode: 'preview' };
    const unknown = findUnknownKeys(args, SimpleSchema);
    expect(unknown).toEqual([]);
  });

  it('handles non-object args', () => {
    const unknown = findUnknownKeys('string', SimpleSchema);
    expect(unknown).toEqual([]);
  });
});

describe('findMissingRequiredKeys', () => {
  it('finds missing required keys', () => {
    const args = { mode: 'preview' };
    const missing = findMissingRequiredKeys(args, SimpleSchema);
    expect(missing).toContain('workflowId');
  });

  it('returns empty when all required present', () => {
    const args = { workflowId: 'test' };
    const missing = findMissingRequiredKeys(args, SimpleSchema);
    expect(missing).toEqual([]);
  });
});

describe('generateExampleValue', () => {
  it('generates example for string', () => {
    const example = generateExampleValue(z.string().describe('test field'));
    expect(example).toBe('<test field>');
  });

  it('generates example for enum', () => {
    const example = generateExampleValue(z.enum(['a', 'b', 'c']));
    expect(example).toBe('a');
  });

  it('generates example for object', () => {
    const example = generateExampleValue(SimpleSchema);
    expect(typeof example).toBe('object');
    expect(example).toHaveProperty('workflowId');
  });

  it('uses default value when available', () => {
    const schemaWithDefault = z.string().default('default_value');
    const example = generateExampleValue(schemaWithDefault);
    expect(example).toBe('default_value');
  });
});

describe('generateTemplate', () => {
  it('generates template for object schema', () => {
    const template = generateTemplate(SimpleSchema);
    expect(template).not.toBeNull();
    expect(template).toHaveProperty('workflowId');
  });

  it('returns null for non-object schema', () => {
    const template = generateTemplate(z.string());
    expect(template).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Suggestion Generation Tests
// -----------------------------------------------------------------------------

describe('generateSuggestions', () => {
  it('suggests workflowId for workflow_id', () => {
    const result = generateSuggestions(
      { workflow_id: 'test' },
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );

    expect(result.suggestions.length).toBeGreaterThan(0);

    const unknownKeySuggestion = result.suggestions.find(s => s.kind === 'unknown_key');
    expect(unknownKeySuggestion).toBeDefined();
    if (unknownKeySuggestion?.kind === 'unknown_key') {
      expect(unknownKeySuggestion.provided).toBe('workflow_id');
      expect(unknownKeySuggestion.didYouMean).toBe('workflowId');
    }
  });

  it('suggests missing required parameters', () => {
    const result = generateSuggestions(
      {}, // Missing workflowId
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );

    const missingRequiredSuggestion = result.suggestions.find(
      s => s.kind === 'missing_required'
    );
    expect(missingRequiredSuggestion).toBeDefined();
    if (missingRequiredSuggestion?.kind === 'missing_required') {
      expect(missingRequiredSuggestion.param).toBe('workflowId');
    }
  });

  it('includes template when configured', () => {
    const result = generateSuggestions(
      { workflow_id: 'test' },
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );

    expect(result.correctTemplate).not.toBeNull();
    expect(result.correctTemplate).toHaveProperty('workflowId');
  });

  it('returns empty result for valid input', () => {
    const result = generateSuggestions(
      { workflowId: 'test' },
      SimpleSchema,
      { ...DEFAULT_SUGGESTION_CONFIG, includeTemplate: false }
    );

    // No unknown keys, no missing required (mode has default)
    expect(result.suggestions.length).toBe(0);
  });

  it('is deterministic (same inputs, same output)', () => {
    const args = { workflow_id: 'test', extra_key: true };
    
    const result1 = generateSuggestions(args, SimpleSchema, DEFAULT_SUGGESTION_CONFIG);
    const result2 = generateSuggestions(args, SimpleSchema, DEFAULT_SUGGESTION_CONFIG);
    
    expect(result1).toEqual(result2);
  });
});

describe('formatSuggestionDetails', () => {
  it('formats unknown key suggestions', () => {
    const result = generateSuggestions(
      { workflow_id: 'test' },
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );
    
    const details = formatSuggestionDetails(result);
    
    expect(details).toHaveProperty('suggestions');
    expect(Array.isArray(details.suggestions)).toBe(true);
  });

  it('includes correctTemplate in details', () => {
    const result = generateSuggestions(
      { workflow_id: 'test' },
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );
    
    const details = formatSuggestionDetails(result);
    
    expect(details).toHaveProperty('correctTemplate');
  });

  it('returns empty object for empty result', () => {
    const details = formatSuggestionDetails(EMPTY_SUGGESTION_RESULT);
    expect(details).toEqual({});
  });
});

describe('hasSuggestions', () => {
  it('returns true when suggestions exist', () => {
    const result = generateSuggestions(
      { workflow_id: 'test' },
      SimpleSchema,
      DEFAULT_SUGGESTION_CONFIG
    );
    
    expect(hasSuggestions(result)).toBe(true);
  });

  it('returns false for empty result', () => {
    expect(hasSuggestions(EMPTY_SUGGESTION_RESULT)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Integration-style Tests (with real WorkRail schemas)
// -----------------------------------------------------------------------------

describe('Real-world agent error scenarios', () => {
  it('handles snake_case parameter naming (most common error)', () => {
    // Simulating agent passing snake_case instead of camelCase
    const badArgs = {
      workflow_id: 'relocation-workflow-us',
      user_input: 'I want to relocate...',
    };
    
    const result = generateSuggestions(badArgs, ComplexSchema, DEFAULT_SUGGESTION_CONFIG);
    
    // Should suggest workflowId for workflow_id
    const workflowIdSuggestion = result.suggestions.find(
      s => s.kind === 'unknown_key' && s.provided === 'workflow_id'
    );
    expect(workflowIdSuggestion).toBeDefined();
    if (workflowIdSuggestion?.kind === 'unknown_key') {
      expect(workflowIdSuggestion.didYouMean).toBe('workflowId');
    }
    
    // Should suggest missing required 'state' parameter
    const stateSuggestion = result.suggestions.find(
      s => s.kind === 'missing_required' && s.param === 'state'
    );
    expect(stateSuggestion).toBeDefined();
  });

  it('handles completely invented parameter names', () => {
    const badArgs = {
      user_query: 'test', // Completely wrong
      data: {}, // Completely wrong
    };
    
    const result = generateSuggestions(badArgs, SimpleSchema, DEFAULT_SUGGESTION_CONFIG);
    
    // Should suggest missing workflowId
    const missing = result.suggestions.find(s => s.kind === 'missing_required');
    expect(missing).toBeDefined();
    
    // Template should show correct structure
    expect(result.correctTemplate).not.toBeNull();
    expect(result.correctTemplate).toHaveProperty('workflowId');
  });
});

// -----------------------------------------------------------------------------
// patchTemplateForFailedOptionals Tests
// -----------------------------------------------------------------------------

describe('patchTemplateForFailedOptionals', () => {
  const SchemaWithOptionals = z.object({
    workflowId: z.string().describe('required'),
    context: z.record(z.unknown()).optional().describe('optional context object'),
    workspacePath: z.string().optional().describe('optional path'),
  });

  it('restores optional field that was provided as wrong type (string instead of object)', () => {
    // Simulate: agent passed context: "some problem description"
    const args = { workflowId: 'my-workflow', context: 'some problem description' };
    const parseResult = SchemaWithOptionals.safeParse(args);
    expect(parseResult.success).toBe(false);

    const baseTemplate = generateTemplate(SchemaWithOptionals)!;
    // Base template should NOT include context (it's optional and was skipped)
    expect(baseTemplate).not.toHaveProperty('context');

    const patched = patchTemplateForFailedOptionals(
      baseTemplate,
      args,
      parseResult.success ? [] : parseResult.error.errors,
      SchemaWithOptionals,
      DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
    );

    // Patched template SHOULD include context as an example object
    expect(patched).not.toBeNull();
    expect(patched).toHaveProperty('context');
    expect(typeof patched!.context).toBe('object');
    // workflowId should still be there
    expect(patched).toHaveProperty('workflowId');
  });

  it('does not add fields that were not provided by the agent', () => {
    // Agent omitted context entirely — no need to patch it
    const args = { workflowId: 'my-workflow', context: 'oops-a-string' };
    const parseResult = SchemaWithOptionals.safeParse(args);
    const baseTemplate = generateTemplate(SchemaWithOptionals)!;

    const patched = patchTemplateForFailedOptionals(
      baseTemplate,
      { workflowId: 'my-workflow' }, // no context provided
      parseResult.success ? [] : parseResult.error.errors,
      SchemaWithOptionals,
      DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
    );

    // workspacePath was not provided — should NOT appear in template
    expect(patched).not.toHaveProperty('workspacePath');
  });

  it('does not overwrite fields already in the template', () => {
    const args = { workflowId: 'my-workflow', context: 'wrong' };
    const parseResult = SchemaWithOptionals.safeParse(args);
    const baseTemplateWithContext: Readonly<Record<string, unknown>> = {
      workflowId: '<The workflow ID>',
      context: { alreadyPresent: 'yes' }, // Already in template
    };

    const patched = patchTemplateForFailedOptionals(
      baseTemplateWithContext,
      args,
      parseResult.success ? [] : parseResult.error.errors,
      SchemaWithOptionals,
      DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
    );

    // Should not overwrite the already-present context value
    expect(patched).toHaveProperty('context');
    expect((patched!.context as Record<string, unknown>).alreadyPresent).toBe('yes');
  });

  it('returns null when correctTemplate is null', () => {
    const args = { workflowId: 'my-workflow', context: 'wrong' };
    const parseResult = SchemaWithOptionals.safeParse(args);

    const result = patchTemplateForFailedOptionals(
      null,
      args,
      parseResult.success ? [] : parseResult.error.errors,
      SchemaWithOptionals,
      DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
    );

    expect(result).toBeNull();
  });

  it('returns same reference when no patching was needed', () => {
    // No optional fields failed — template should be returned as-is
    const args = { workflowId: 'my-workflow' }; // workflowId is wrong type but that's required
    const parseResult = SchemaWithOptionals.safeParse(args);
    const baseTemplate = generateTemplate(SchemaWithOptionals)!;

    const patched = patchTemplateForFailedOptionals(
      baseTemplate,
      args,
      parseResult.success ? [] : parseResult.error.errors,
      SchemaWithOptionals,
      DEFAULT_SUGGESTION_CONFIG.maxTemplateDepth,
    );

    // No optional fields failed — same reference returned
    expect(patched).toBe(baseTemplate);
  });
});
