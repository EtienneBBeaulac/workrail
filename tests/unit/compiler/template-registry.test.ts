/**
 * Template Registry — Tests
 */
import { describe, it, expect } from 'vitest';
import { createTemplateRegistry } from '../../../src/application/services/compiler/template-registry.js';

describe('TemplateRegistry', () => {
  const registry = createTemplateRegistry();

  it('returns UNKNOWN_TEMPLATE for any template ID (registry is empty)', () => {
    const result = registry.resolve('wr.templates.something');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('UNKNOWN_TEMPLATE');
    expect(error.templateId).toBe('wr.templates.something');
    expect(error.message).toContain('(none)');
  });

  it('returns UNKNOWN_TEMPLATE for empty string', () => {
    const result = registry.resolve('');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNKNOWN_TEMPLATE');
  });

  it('has() returns false for all IDs (registry is empty)', () => {
    expect(registry.has('wr.templates.something')).toBe(false);
    expect(registry.has('')).toBe(false);
  });

  it('knownIds() returns empty array', () => {
    expect(registry.knownIds()).toEqual([]);
  });
});
