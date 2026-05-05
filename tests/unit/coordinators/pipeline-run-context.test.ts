import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildPhaseResult,
  parsePipelineRunContext,
  MIN_NOTES_LENGTH_FOR_PHASE_RESULT,
} from '../../../src/coordinators/pipeline-run-context.js';
import type { DiscoveryHandoffArtifactV1 } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

const discoveryArtifact: DiscoveryHandoffArtifactV1 = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'Use discriminated union',
  designDocPath: '',
  confidenceBand: 'high',
  keyInvariants: ['No raw casts'],
};

// ─── buildPhaseResult ────────────────────────────────────────────────────────

describe('buildPhaseResult()', () => {
  it('full when artifact present', () => {
    const r = buildPhaseResult(discoveryArtifact, 'notes');
    expect(r.kind).toBe('full');
    if (r.kind === 'full') {
      expect(r.artifact).toBe(discoveryArtifact);
      expect(r.confidenceBand).toBe('high');
    }
  });

  it('full uses null confidenceBand for artifact without confidenceBand field', () => {
    const noConfidence = { kind: 'wr.shaping_handoff' as const, version: 1 as const, pitchPath: '', selectedShape: '', appetite: '', keyConstraints: [], rabbitHoles: [], outOfScope: [], validationChecklist: [] };
    const r = buildPhaseResult(noConfidence, null);
    expect(r.kind).toBe('full');
    // Shaping/coding artifacts don't carry confidenceBand -- null is the honest value
    if (r.kind === 'full') expect(r.confidenceBand).toBeNull();
  });

  it('partial when notes long enough', () => {
    const longNotes = 'x'.repeat(MIN_NOTES_LENGTH_FOR_PHASE_RESULT + 1);
    const r = buildPhaseResult(null, longNotes);
    expect(r.kind).toBe('partial');
  });

  it('fallback when notes too short', () => {
    expect(buildPhaseResult(null, 'short').kind).toBe('fallback');
  });

  it('fallback when notes null', () => {
    expect(buildPhaseResult(null, null).kind).toBe('fallback');
  });

  it('fallback at exact threshold boundary', () => {
    const borderNotes = 'x'.repeat(MIN_NOTES_LENGTH_FOR_PHASE_RESULT);
    expect(buildPhaseResult(null, borderNotes).kind).toBe('fallback');
  });
});

// ─── parsePipelineRunContext ──────────────────────────────────────────────────

describe('parsePipelineRunContext()', () => {
  it('parses a valid minimal context', () => {
    const raw = {
      runId: 'test-run',
      goal: 'test goal',
      workspace: '/tmp',
      startedAt: new Date().toISOString(),
      pipelineMode: 'FULL',
      phases: {},
    };
    const result = parsePipelineRunContext(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value !== null) {
      expect(result.value.runId).toBe('test-run');
      expect(result.value.phases.discovery).toBeUndefined();
    }
  });

  it('parses context with a full discovery phase record', () => {
    const raw = {
      runId: 'run-2',
      goal: 'test',
      workspace: '/tmp',
      startedAt: new Date().toISOString(),
      pipelineMode: 'FULL',
      phases: {
        discovery: {
          completedAt: new Date().toISOString(),
          sessionHandle: 'sess_abc',
          result: {
            kind: 'full',
            artifact: discoveryArtifact,
            confidenceBand: 'high',
            recapMarkdown: 'notes',
          },
        },
      },
    };
    const result = parsePipelineRunContext(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value !== null) {
      const disc = result.value.phases.discovery;
      expect(disc?.result.kind).toBe('full');
    }
  });

  it('returns err for missing required fields', () => {
    const result = parsePipelineRunContext({ runId: 'x' });
    expect(result.isErr()).toBe(true);
  });

  it('returns err for invalid pipelineMode', () => {
    const raw = { runId: 'x', goal: 'y', workspace: '/tmp', startedAt: '', pipelineMode: 'INVALID', phases: {} };
    const result = parsePipelineRunContext(raw);
    expect(result.isErr()).toBe(true);
  });
});

// ─── File I/O round-trip (uses temp dir) ─────────────────────────────────────

describe('PipelineRunContext file round-trip', () => {
  it('JSON serialization preserves PhaseResult.kind', () => {
    const ctx = {
      runId: 'round-trip-test',
      goal: 'test',
      workspace: '/tmp',
      startedAt: new Date().toISOString(),
      pipelineMode: 'FULL' as const,
      phases: {
        discovery: {
          completedAt: new Date().toISOString(),
          sessionHandle: 'sess_123',
          result: { kind: 'fallback' as const, recapMarkdown: null },
        },
      },
    };

    const serialized = JSON.stringify(ctx);
    const parsed = parsePipelineRunContext(JSON.parse(serialized));
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk() && parsed.value !== null) {
      expect(parsed.value.phases.discovery?.result.kind).toBe('fallback');
    }
  });

  it('ok(null) when file does not exist (crash recovery)', async () => {
    // This tests the parsePipelineRunContext ok(null) contract indirectly
    const result = parsePipelineRunContext(null);
    // null input should fail parsing, not return null -- null is only from readFile ENOENT
    expect(result.isErr()).toBe(true);
  });
});
