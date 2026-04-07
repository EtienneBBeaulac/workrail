/**
 * Tests for resolveContextTemplates — render-time {{varName}} substitution.
 * Tests behavior, not implementation details.
 */
import { describe, it, expect } from 'vitest';
import { resolveContextTemplates } from '../../../src/v2/durable-core/domain/context-template-resolver.js';

describe('resolveContextTemplates — fast path', () => {
  it('returns the template unchanged when no tokens are present', () => {
    expect(resolveContextTemplates('Hello world.', {})).toBe('Hello world.');
  });

  it('returns the template unchanged when no {{ is present', () => {
    const t = 'Implement the slice named currentSlice.name without braces.';
    expect(resolveContextTemplates(t, {})).toBe(t);
  });
});

describe('resolveContextTemplates — simple substitution', () => {
  it('replaces a top-level variable token', () => {
    const result = resolveContextTemplates('Mode: {{rigorMode}}.', { rigorMode: 'STANDARD' });
    expect(result).toBe('Mode: STANDARD.');
  });

  it('replaces multiple distinct tokens in one pass', () => {
    const result = resolveContextTemplates('{{a}} + {{b}} = {{c}}', { a: 1, b: 2, c: 3 });
    expect(result).toBe('1 + 2 = 3');
  });

  it('replaces the same token appearing multiple times', () => {
    const result = resolveContextTemplates('{{x}} and {{x}}', { x: 'hello' });
    expect(result).toBe('hello and hello');
  });

  it('coerces numeric values to strings', () => {
    expect(resolveContextTemplates('Pass {{n}}', { n: 42 })).toBe('Pass 42');
  });

  it('coerces boolean values to strings', () => {
    expect(resolveContextTemplates('Flag: {{flag}}', { flag: false })).toBe('Flag: false');
  });
});

describe('resolveContextTemplates — dot-path navigation', () => {
  it('resolves one-level dot-path {{obj.prop}}', () => {
    const result = resolveContextTemplates(
      'Implement slice `{{currentSlice.name}}`.',
      { currentSlice: { name: 'Slice 1: Schema', index: 0 } },
    );
    expect(result).toBe('Implement slice `Slice 1: Schema`.');
  });

  it('resolves two-level dot-path {{a.b.c}}', () => {
    const result = resolveContextTemplates(
      '{{user.address.city}}',
      { user: { address: { city: 'Montreal' } } },
    );
    expect(result).toBe('Montreal');
  });

  it('resolves a mix of flat and dotted tokens', () => {
    const result = resolveContextTemplates(
      '{{rigorMode}} — slice: {{currentSlice.name}}',
      { rigorMode: 'THOROUGH', currentSlice: { name: 'Slice 2' } },
    );
    expect(result).toBe('THOROUGH — slice: Slice 2');
  });
});

describe('resolveContextTemplates — missing variable fallback', () => {
  it('produces [unset: varName] for a missing top-level variable', () => {
    const result = resolveContextTemplates('Mode: {{rigorMode}}.', {});
    expect(result).toBe('Mode: [unset: rigorMode].');
  });

  it('produces [unset: path] for a missing dot-path variable', () => {
    const result = resolveContextTemplates('Slice: {{currentSlice.name}}', {});
    expect(result).toBe('Slice: [unset: currentSlice.name]');
  });

  it('produces [unset: path] when the parent object exists but the leaf is absent', () => {
    const result = resolveContextTemplates('{{slice.title}}', { slice: { name: 'x' } });
    expect(result).toBe('[unset: slice.title]');
  });

  it('produces [unset: path] when intermediate path segment is not an object', () => {
    const result = resolveContextTemplates('{{a.b.c}}', { a: 'flat-string' });
    expect(result).toBe('[unset: a.b.c]');
  });

  it('produces [unset: path] when value is null', () => {
    const result = resolveContextTemplates('{{x}}', { x: null });
    expect(result).toBe('[unset: x]');
  });
});

describe('resolveContextTemplates — wr.* namespace isolation', () => {
  it('does NOT replace {{wr.bindings.*}} tokens — those are compiler-owned', () => {
    const t = 'Run {{wr.bindings.design_review}} now.';
    expect(resolveContextTemplates(t, { 'wr.bindings.design_review': 'override' })).toBe(t);
  });

  it('does NOT replace {{wr.refs.*}} tokens', () => {
    const t = 'See {{wr.refs.context}}.';
    expect(resolveContextTemplates(t, {})).toBe(t);
  });

  it('resolves a context token adjacent to a wr.* token without touching the wr.* token', () => {
    const result = resolveContextTemplates(
      '{{rigorMode}} and {{wr.bindings.audit}}',
      { rigorMode: 'QUICK' },
    );
    expect(result).toBe('QUICK and {{wr.bindings.audit}}');
  });
});

describe('resolveContextTemplates — expression tokens pass-through (no regression)', () => {
  it('leaves {{x + 1}} expressions unchanged — expressions are not evaluable', () => {
    // Previously these were author-written template hints; after our change they must
    // remain as-is, not become [unset: x + 1].
    const t = 'Step {{currentStepNumber + 1}} of {{totalSteps}}';
    expect(resolveContextTemplates(t, { currentStepNumber: 2, totalSteps: 5 })).toBe(
      'Step {{currentStepNumber + 1}} of 5',
    );
  });

  it('leaves {{fn()}} call-style tokens unchanged', () => {
    const t = 'Rate: {{(processed / items.length * 100).toFixed(1)}}%';
    expect(resolveContextTemplates(t, {})).toBe(t);
  });

  it('leaves tokens with spaces unchanged', () => {
    // Whitespace-padded tokens are NOT resolved — the strict identifier regex does not match them.
    const t = '{{ rigorMode }}';
    expect(resolveContextTemplates(t, { rigorMode: 'QUICK' })).toBe(t);
  });
});

describe('resolveContextTemplates — regex lastIndex safety', () => {
  it('resolves the same template correctly on two consecutive calls (no lastIndex bleed)', () => {
    // A shared global `g`-flagged regex can retain lastIndex state across calls.
    // This test calls resolveContextTemplates twice with the same template to ensure
    // the second call produces the same result as the first.
    const template = '{{a}} and {{b}} and {{a}}';
    const context = { a: 'X', b: 'Y' };
    const first = resolveContextTemplates(template, context);
    const second = resolveContextTemplates(template, context);
    expect(first).toBe('X and Y and X');
    expect(second).toBe('X and Y and X');
    expect(first).toBe(second);
  });

  it('resolves tokens correctly after a call that left tokens unresolved', () => {
    // Unresolved tokens produce [unset: ...] replacements; verify the next call is clean.
    const template = '{{x}}';
    const first = resolveContextTemplates(template, {});
    expect(first).toBe('[unset: x]');
    const second = resolveContextTemplates(template, { x: 'resolved' });
    expect(second).toBe('resolved');
  });
});

describe('resolveContextTemplates — edge cases', () => {
  it('returns template unchanged when context is empty and no tokens are present', () => {
    expect(resolveContextTemplates('No tokens here.', {})).toBe('No tokens here.');
  });

  it('handles an empty template string', () => {
    expect(resolveContextTemplates('', { x: 1 })).toBe('');
  });

  it('resolves items.length via dot-path into an array (arrays are objects)', () => {
    // {{items.length}} is a common pattern — arrays expose .length as a property.
    const result = resolveContextTemplates(
      'item {{currentIndex}} of {{items.length}}',
      { currentIndex: 2, items: ['a', 'b', 'c'] },
    );
    expect(result).toBe('item 2 of 3');
  });
});
