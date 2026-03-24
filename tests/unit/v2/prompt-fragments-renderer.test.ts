/**
 * Tests for promptFragments render-time assembly in assembleFragmentedPrompt.
 */
import { describe, it, expect } from 'vitest';
import { assembleFragmentedPrompt } from '../../../src/v2/durable-core/domain/prompt-renderer.js';
import type { PromptFragment } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// assembleFragmentedPrompt — pure function tests
// ---------------------------------------------------------------------------

describe('assembleFragmentedPrompt — basic matching', () => {
  it('appends matching fragment text when condition passes', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'quick', when: { var: 'rigorMode', equals: 'QUICK' }, text: 'Keep it light.' },
      { id: 'deep', when: { var: 'rigorMode', in: ['STANDARD', 'THOROUGH'] }, text: 'Go deeper.' },
    ];
    const result = assembleFragmentedPrompt(fragments, { rigorMode: 'QUICK' });
    expect(result).toBe('Keep it light.');
  });

  it('appends multiple matching fragments in declaration order', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'frag-a', when: { var: 'rigorMode', equals: 'THOROUGH' }, text: 'Fragment A.' },
      { id: 'frag-b', when: { var: 'risk', equals: 'High' }, text: 'Fragment B.' },
    ];
    const result = assembleFragmentedPrompt(fragments, { rigorMode: 'THOROUGH', risk: 'High' });
    expect(result).toBe('Fragment A.\n\nFragment B.');
  });

  it('returns empty string when no fragments match', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'frag', when: { var: 'rigorMode', equals: 'QUICK' }, text: 'Quick only.' },
    ];
    const result = assembleFragmentedPrompt(fragments, { rigorMode: 'THOROUGH' });
    expect(result).toBe('');
  });

  it('returns empty string for an empty fragments array', () => {
    const result = assembleFragmentedPrompt([], { rigorMode: 'QUICK' });
    expect(result).toBe('');
  });
});

describe('assembleFragmentedPrompt — always-include fragments', () => {
  it('appends a fragment with no when condition regardless of context', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'always', text: 'Always here.' },
    ];
    expect(assembleFragmentedPrompt(fragments, {})).toBe('Always here.');
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'QUICK' })).toBe('Always here.');
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'THOROUGH' })).toBe('Always here.');
  });

  it('mixes always-include and conditional fragments correctly', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'always', text: 'Common.' },
      { id: 'conditional', when: { var: 'rigorMode', equals: 'THOROUGH' }, text: 'Thorough extra.' },
    ];
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'THOROUGH' })).toBe('Common.\n\nThorough extra.');
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'QUICK' })).toBe('Common.');
  });
});

describe('assembleFragmentedPrompt — in operator', () => {
  it('appends when rigorMode is in the allowed list', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'standard-thorough', when: { var: 'rigorMode', in: ['STANDARD', 'THOROUGH'] }, text: 'Deep work.' },
    ];
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'STANDARD' })).toBe('Deep work.');
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'THOROUGH' })).toBe('Deep work.');
    expect(assembleFragmentedPrompt(fragments, { rigorMode: 'QUICK' })).toBe('');
  });
});

describe('assembleFragmentedPrompt — empty/missing context (degradation analog)', () => {
  it('returns only always-include fragments when context is empty (no runtime vars available)', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'always', text: 'Always here.' },
      { id: 'conditional', when: { var: 'rigorMode', equals: 'THOROUGH' }, text: 'Thorough extra.' },
    ];
    // Empty context simulates the graceful-degradation path where context projection
    // fails and we fall back to an empty record — only always-include fragments fire.
    expect(assembleFragmentedPrompt(fragments, {})).toBe('Always here.');
  });
});

describe('assembleFragmentedPrompt — declaration order', () => {
  it('preserves declaration order even when conditions match out of natural order', () => {
    const fragments: readonly PromptFragment[] = [
      { id: 'first', when: { var: 'x', equals: true }, text: 'First.' },
      { id: 'second', when: { var: 'y', equals: true }, text: 'Second.' },
      { id: 'third', when: { var: 'z', equals: true }, text: 'Third.' },
    ];
    const result = assembleFragmentedPrompt(fragments, { x: true, y: true, z: true });
    expect(result).toBe('First.\n\nSecond.\n\nThird.');
  });
});
