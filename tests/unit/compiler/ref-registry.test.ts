/**
 * Ref Registry — Tests
 *
 * Tests the closed-set ref registry: resolution, unknown ref rejection,
 * and content correctness.
 */
import { describe, it, expect } from 'vitest';
import { createRefRegistry } from '../../../src/application/services/compiler/ref-registry.js';

describe('RefRegistry', () => {
  const registry = createRefRegistry();

  it('resolves wr.refs.memory_usage to non-empty text', () => {
    const result = registry.resolve('wr.refs.memory_usage');
    expect(result.isOk()).toBe(true);
    const text = result._unsafeUnwrap();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Memory MCP');
  });

  it('resolves wr.refs.memory_store to non-empty text', () => {
    const result = registry.resolve('wr.refs.memory_store');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toContain('memory_store');
  });

  it('resolves wr.refs.memory_query to non-empty text', () => {
    const result = registry.resolve('wr.refs.memory_query');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toContain('memory_briefing');
  });

  it('returns UNKNOWN_REF for unregistered ref ID', () => {
    const result = registry.resolve('wr.refs.nonexistent');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('UNKNOWN_REF');
    expect(error.refId).toBe('wr.refs.nonexistent');
    expect(error.message).toContain('wr.refs.nonexistent');
  });

  it('returns UNKNOWN_REF for empty string', () => {
    const result = registry.resolve('');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNKNOWN_REF');
  });

  it('has() returns true for known refs', () => {
    expect(registry.has('wr.refs.memory_usage')).toBe(true);
    expect(registry.has('wr.refs.memory_store')).toBe(true);
    expect(registry.has('wr.refs.memory_query')).toBe(true);
  });

  it('has() returns false for unknown refs', () => {
    expect(registry.has('wr.refs.nonexistent')).toBe(false);
    expect(registry.has('')).toBe(false);
  });

  it('knownIds() returns all registered ref IDs', () => {
    const ids = registry.knownIds();
    expect(ids).toContain('wr.refs.memory_usage');
    expect(ids).toContain('wr.refs.memory_store');
    expect(ids).toContain('wr.refs.memory_query');
    expect(ids.length).toBe(3);
  });

  it('resolution is deterministic: same ID always returns same content', () => {
    const a = registry.resolve('wr.refs.memory_usage')._unsafeUnwrap();
    const b = registry.resolve('wr.refs.memory_usage')._unsafeUnwrap();
    expect(a).toBe(b);
  });
});
