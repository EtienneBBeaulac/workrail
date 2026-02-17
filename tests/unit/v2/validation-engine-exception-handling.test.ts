import { describe, expect, it } from 'vitest';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';

describe('ValidationEngine.validate (Result-based)', () => {
  it('returns err(schema_compilation_failed) for invalid JSON schema', async () => {
    const engine = new ValidationEngine(new EnhancedLoopValidator());

    const res = await engine.validate(
      '{}',
      [
        {
          type: 'schema',
          schema: { type: 'nope', properties: { a: { type: 'string' } } },
        },
      ] as any,
      {}
    );

    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.kind).toBe('schema_compilation_failed');
    }
  });

  it('returns err(invalid_criteria_format) for invalid criteria shape', async () => {
    const engine = new ValidationEngine(new EnhancedLoopValidator());

    const res = await engine.validate('x', { foo: 'bar' } as any, {});

    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.kind).toBe('invalid_criteria_format');
    }
  });

  it('returns err(invalid_criteria_format) for invalid regex pattern', async () => {
    const engine = new ValidationEngine(new EnhancedLoopValidator());

    const res = await engine.validate(
      'x',
      [
        {
          type: 'regex',
          pattern: '(',
        },
      ] as any,
      {}
    );

    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.kind).toBe('invalid_criteria_format');
    }
  });
});
