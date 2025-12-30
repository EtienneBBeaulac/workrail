/**
 * StepInstanceKey roundtrip correctness.
 *
 * Lock: docs/design/v2-core-design-locks.md Section 2 (StepInstanceKey)
 *
 * Format:
 * - No loops: `stepId`
 * - With loops: `loopId@iteration/loopId@iteration::stepId`
 *
 * Delimiter-safe: stepId and loopId match /^[a-z0-9_-]+$/
 *
 * @enforces step-instance-key-delimiter-safe
 * @enforces step-instance-key-format
 */
import { describe, it, expect } from 'vitest';
import {
  parseStepInstanceKeyV1,
  stepInstanceKeyFromParts,
  asDelimiterSafeIdV1,
  DelimiterSafeIdV1Schema,
} from '../../../src/v2/durable-core/schemas/execution-snapshot/step-instance-key.js';

describe('StepInstanceKey roundtrip', () => {
  it('simple step (no loops) roundtrips correctly', () => {
    const stepId = asDelimiterSafeIdV1('simple_step');
    const formatted = stepInstanceKeyFromParts(stepId, []);

    expect(String(formatted)).toBe('simple_step');

    const parsed = parseStepInstanceKeyV1(String(formatted));
    expect(parsed.isOk()).toBe(true);
    expect(String(parsed._unsafeUnwrap())).toBe('simple_step');
  });

  it('single loop roundtrips correctly', () => {
    const stepId = asDelimiterSafeIdV1('inner_step');
    const loopPath = [{ loopId: asDelimiterSafeIdV1('outer_loop'), iteration: 2 }];

    const formatted = stepInstanceKeyFromParts(stepId, loopPath);
    expect(String(formatted)).toBe('outer_loop@2::inner_step');

    const parsed = parseStepInstanceKeyV1(String(formatted));
    expect(parsed.isOk()).toBe(true);
    expect(String(parsed._unsafeUnwrap())).toBe('outer_loop@2::inner_step');
  });

  it('nested loops roundtrip correctly', () => {
    const stepId = asDelimiterSafeIdV1('deep_step');
    const loopPath = [
      { loopId: asDelimiterSafeIdV1('outer'), iteration: 0 },
      { loopId: asDelimiterSafeIdV1('middle'), iteration: 1 },
      { loopId: asDelimiterSafeIdV1('inner'), iteration: 2 },
    ];

    const formatted = stepInstanceKeyFromParts(stepId, loopPath);
    expect(String(formatted)).toBe('outer@0/middle@1/inner@2::deep_step');

    const parsed = parseStepInstanceKeyV1(String(formatted));
    expect(parsed.isOk()).toBe(true);
    expect(String(parsed._unsafeUnwrap())).toBe('outer@0/middle@1/inner@2::deep_step');
  });

  it('rejects invalid delimiter characters', () => {
    // asDelimiterSafeIdV1() is an unsafe cast; validation is done at boundaries via the schema.
    expect(DelimiterSafeIdV1Schema.safeParse('invalid@id').success).toBe(false);
    expect(DelimiterSafeIdV1Schema.safeParse('invalid::id').success).toBe(false);
    expect(DelimiterSafeIdV1Schema.safeParse('invalid/id').success).toBe(false);
    expect(DelimiterSafeIdV1Schema.safeParse('Invalid-Id').success).toBe(false);
  });

  it('rejects malformed keys during parse', () => {
    const invalid = ['loop@a::step', 'loop@-1::step', 'loop@0', '::step', 'loop@0::', 'outer@0/inner::step'];

    for (const key of invalid) {
      const parsed = parseStepInstanceKeyV1(key as any);
      expect(parsed.isErr(), `Should reject: ${key}`).toBe(true);
    }
  });
});
