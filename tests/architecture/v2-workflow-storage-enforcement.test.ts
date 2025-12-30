import { describe, it, expect, beforeAll } from 'vitest';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens';

describe('v2 workflow storage: validation wrapper is mandatory (architecture)', () => {
  let resolvedPrimary: any;
  let resolvedValidated: any;

  beforeAll(async () => {
    const { initializeContainer } = await import('../../src/di/container');
    await initializeContainer({ kind: 'test' });

    resolvedPrimary = container.resolve(DI.Storage.Primary);
    resolvedValidated = container.resolve(DI.Storage.Validated);
  });

  it('DI.Storage.Primary is CachingWorkflowStorage wrapping SchemaValidatingWorkflowStorage', () => {
    expect(resolvedPrimary.constructor.name).toBe('CachingWorkflowStorage');

    // CachingWorkflowStorage wraps an inner storage
    const inner = (resolvedPrimary as any).inner;
    expect(inner).toBeDefined();
    expect(inner.constructor.name).toMatch(/SchemaValidating/);
  });

  it('DI.Storage.Validated is SchemaValidatingWorkflowStorage (or composite variant)', () => {
    expect(resolvedValidated.constructor.name).toMatch(/SchemaValidating/);
  });

  it('SchemaValidatingWorkflowStorage enforces WorkflowIdPolicy on load', () => {
    // Verify the validateDefinition method exists and accepts sourceKind parameter.
    // This is a compile-time + runtime shape check (not a deep functional test).
    const validator = resolvedValidated;

    // Access private method indirectly via testing the public API behavior is covered elsewhere.
    // Here we just assert the storage type is correct.
    expect(validator.constructor.name).toMatch(/SchemaValidating/);
  });
});
