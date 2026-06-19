import { describe, expect, it } from 'vitest';
import { buildResponseSupplements } from '../../../src/mcp/response-supplements.js';

describe('buildResponseSupplements', () => {
  it('returns authority context and notes guidance for start in deterministic order', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'start',
      cleanFormat: true,
    });

    expect(supplements.map((supplement) => supplement.kind)).toEqual([
      'executor_directive',
      'authority_context',
      'notes_guidance',
      'subagent_guidance',
    ]);
    expect(supplements.map((supplement) => supplement.order)).toEqual([4, 10, 20, 30]);
    expect(supplements[0]!.text).toContain('WorkRail Executor Behavioral Rules');
    expect(supplements[1]!.text).toContain('WorkRail is a separate live system');
    expect(supplements[2]!.text).toContain('How to write good notes');
    expect(supplements[3]!.text).toContain('Interactive Session Advancement');
  });

  it('returns only authority context for rehydrate', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'rehydrate',
      cleanFormat: true,
    });

    expect(supplements.map((supplement) => supplement.kind)).toEqual([
      'executor_directive',
      'authority_context',
      'subagent_guidance',
    ]);
    expect(supplements[0]!.text).toContain('WorkRail Executor Behavioral Rules');
    expect(supplements[1]!.text).not.toContain('How to write good notes');
    expect(supplements[2]!.text).toContain('Interactive Session Advancement');
  });

  it('executor_directive emits on start', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'start',
      cleanFormat: true,
    });

    const kinds = supplements.map((s) => s.kind);
    expect(kinds).toContain('executor_directive');
    const directive = supplements.find((s) => s.kind === 'executor_directive');
    expect(directive).toBeDefined();
    expect(directive!.text).toContain('ct_');
    expect(directive!.text).toContain('st_');
  });

  it('executor_directive emits on rehydrate', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'rehydrate',
      cleanFormat: true,
    });

    const kinds = supplements.map((s) => s.kind);
    expect(kinds).toContain('executor_directive');
    const directive = supplements.find((s) => s.kind === 'executor_directive');
    expect(directive).toBeDefined();
    expect(directive!.text).toContain('Rehydrate is read-only');
  });

  it('supports once-per-session supplements without durable tracking', () => {
    const startSupplements = buildResponseSupplements({
      lifecycle: 'start',
      cleanFormat: true,
    });
    const rehydrateSupplements = buildResponseSupplements({
      lifecycle: 'rehydrate',
      cleanFormat: true,
    });

    expect(startSupplements.map((supplement) => supplement.kind)).toContain(
      'notes_guidance',
    );
    expect(
      rehydrateSupplements.map((supplement) => supplement.kind),
    ).not.toContain('notes_guidance');
  });

  it('returns no supplements for advance', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'advance',
      cleanFormat: true,
    });

    expect(supplements).toEqual([]);
  });

  it('returns no supplements when clean format is disabled', () => {
    const supplements = buildResponseSupplements({
      lifecycle: 'start',
      cleanFormat: false,
    });

    expect(supplements).toEqual([]);
  });
});
