import { describe, it, expect } from 'vitest';
import { buildPhaseResult, MIN_NOTES_LENGTH_FOR_PHASE_RESULT } from '../../../src/coordinators/pipeline-run-context.js';
import type { DiscoveryHandoffArtifactV1 } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

const discoveryArtifact: DiscoveryHandoffArtifactV1 = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'Use discriminated union',
  designDocPath: '',
  confidenceBand: 'high',
  keyInvariants: ['No raw casts'],
};

describe('buildPhaseResult()', () => {
  it('returns full when artifact is present', () => {
    const result = buildPhaseResult(discoveryArtifact, 'some notes');
    expect(result.kind).toBe('full');
    if (result.kind === 'full') {
      expect(result.artifact).toBe(discoveryArtifact);
      expect(result.confidenceBand).toBe('high');
      expect(result.recapMarkdown).toBe('some notes');
    }
  });

  it('returns full with null recapMarkdown when artifact present and no notes', () => {
    const result = buildPhaseResult(discoveryArtifact, null);
    expect(result.kind).toBe('full');
  });

  it('returns partial when no artifact but notes exceed threshold', () => {
    const longNotes = 'x'.repeat(MIN_NOTES_LENGTH_FOR_PHASE_RESULT + 1);
    const result = buildPhaseResult(null, longNotes);
    expect(result.kind).toBe('partial');
    if (result.kind === 'partial') {
      expect(result.recapMarkdown).toBe(longNotes);
    }
  });

  it('returns fallback when no artifact and notes at exactly threshold', () => {
    const borderNotes = 'x'.repeat(MIN_NOTES_LENGTH_FOR_PHASE_RESULT);
    const result = buildPhaseResult(null, borderNotes);
    expect(result.kind).toBe('fallback');
  });

  it('returns fallback when no artifact and notes too short', () => {
    const result = buildPhaseResult(null, 'short');
    expect(result.kind).toBe('fallback');
  });

  it('returns fallback when no artifact and null notes', () => {
    const result = buildPhaseResult(null, null);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.recapMarkdown).toBeNull();
    }
  });

  it('trims whitespace from partial recapMarkdown', () => {
    const paddedNotes = '  ' + 'x'.repeat(MIN_NOTES_LENGTH_FOR_PHASE_RESULT + 1) + '  ';
    const result = buildPhaseResult(null, paddedNotes);
    expect(result.kind).toBe('partial');
    if (result.kind === 'partial') {
      expect(result.recapMarkdown).not.toMatch(/^\s|\s$/);
    }
  });
});
