/**
 * Feature Registry — Tests
 */
import { describe, it, expect } from 'vitest';
import { createFeatureRegistry } from '../../../src/application/services/compiler/feature-registry.js';

describe('FeatureRegistry', () => {
  const registry = createFeatureRegistry();

  it('resolves wr.features.memory_context', () => {
    const result = registry.resolve('wr.features.memory_context');
    expect(result.isOk()).toBe(true);
    const def = result._unsafeUnwrap();
    expect(def.id).toBe('wr.features.memory_context');
    expect(def.constraints).toBeDefined();
    expect(def.constraints!.length).toBeGreaterThan(0);
  });

  it('resolves wr.features.subagent_guidance', () => {
    const result = registry.resolve('wr.features.subagent_guidance');
    expect(result.isOk()).toBe(true);
    const def = result._unsafeUnwrap();
    expect(def.id).toBe('wr.features.subagent_guidance');
    expect(def.constraints).toBeDefined();
    expect(def.constraints!.length).toBeGreaterThan(0);
    expect(def.procedure).toBeDefined();
    expect(def.procedure!.length).toBeGreaterThan(0);
    expect(def.verify).toBeDefined();
    expect(def.verify!.length).toBeGreaterThan(0);
  });

  it('subagent_guidance feature injects a ref to wr.refs.parallelize_cognition_serialize_synthesis', () => {
    const def = registry.resolve('wr.features.subagent_guidance')._unsafeUnwrap();
    const refConstraint = def.constraints!.find(c => Array.isArray(c)) as readonly { kind: string; refId?: string }[] | undefined;
    expect(refConstraint).toBeDefined();
    expect(refConstraint!.some(p => p.kind === 'ref' && p.refId === 'wr.refs.parallelize_cognition_serialize_synthesis')).toBe(true);
  });

  it('returns UNKNOWN_FEATURE for unregistered feature ID', () => {
    const result = registry.resolve('wr.features.nonexistent');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('UNKNOWN_FEATURE');
    expect(error.featureId).toBe('wr.features.nonexistent');
  });

  it('returns UNKNOWN_FEATURE for empty string', () => {
    const result = registry.resolve('');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNKNOWN_FEATURE');
  });

  it('has() returns true for known features', () => {
    expect(registry.has('wr.features.memory_context')).toBe(true);
    expect(registry.has('wr.features.subagent_guidance')).toBe(true);
  });

  it('has() returns false for unknown features', () => {
    expect(registry.has('wr.features.nonexistent')).toBe(false);
  });

  it('knownIds() returns all registered feature IDs', () => {
    const ids = registry.knownIds();
    expect(ids).toContain('wr.features.memory_context');
    expect(ids).toContain('wr.features.subagent_guidance');
    expect(ids.length).toBe(2);
  });

  it('memory_context feature injects a ref to wr.refs.memory_usage', () => {
    const def = registry.resolve('wr.features.memory_context')._unsafeUnwrap();
    const firstConstraint = def.constraints![0];
    // Should be an array of PromptParts containing a ref
    expect(Array.isArray(firstConstraint)).toBe(true);
    const parts = firstConstraint as readonly { kind: string; refId?: string }[];
    expect(parts.some(p => p.kind === 'ref' && p.refId === 'wr.refs.memory_usage')).toBe(true);
  });
});
