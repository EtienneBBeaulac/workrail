/**
 * Tests for collectArtifactsForEvaluation — the last link between durable
 * events and the interpreter's artifact-based loop control evaluation.
 *
 * Why this matters: if this function silently drops or mangles artifacts,
 * the interpreter never sees the agent's stop decision and loops run forever.
 */
import { describe, it, expect } from 'vitest';
import { collectArtifactsForEvaluation } from '../../../src/mcp/handlers/v2-context-budget.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

/** Helper to build a node_output_appended event with an artifact payload. */
function buildArtifactEvent(
  eventIndex: number,
  content: unknown,
): DomainEventV1 {
  return {
    v: 1,
    eventId: `e${eventIndex}`,
    eventIndex,
    sessionId: 's1',
    kind: 'node_output_appended',
    dedupeKey: `node_output_appended:s1:out_${eventIndex}`,
    scope: { runId: 'run_1', nodeId: 'node_1' },
    data: {
      outputId: `out_${eventIndex}`,
      outputChannel: 'artifact',
      payload: {
        payloadKind: 'artifact_ref',
        content,
      },
    },
  } as unknown as DomainEventV1;
}

/** Helper to build a non-artifact event (recap/notes). */
function buildRecapEvent(eventIndex: number): DomainEventV1 {
  return {
    v: 1,
    eventId: `e${eventIndex}`,
    eventIndex,
    sessionId: 's1',
    kind: 'node_output_appended',
    dedupeKey: `node_output_appended:s1:out_${eventIndex}`,
    scope: { runId: 'run_1', nodeId: 'node_1' },
    data: {
      outputId: `out_${eventIndex}`,
      outputChannel: 'recap',
      payload: {
        payloadKind: 'notes',
        content: 'some recap text',
      },
    },
  } as unknown as DomainEventV1;
}

describe('collectArtifactsForEvaluation', () => {
  it('returns empty when no events and no input artifacts', () => {
    const result = collectArtifactsForEvaluation({
      truthEvents: [],
      inputArtifacts: [],
    });
    expect(result).toEqual([]);
  });

  it('collects artifact content from durable events', () => {
    const artifact = { kind: 'wr.loop_control', decision: 'stop' };
    const events = [buildArtifactEvent(0, artifact)];

    const result = collectArtifactsForEvaluation({
      truthEvents: events,
      inputArtifacts: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(artifact);
  });

  it('appends input artifacts after event artifacts (order matters for last-wins)', () => {
    const eventArtifact = { kind: 'wr.loop_control', decision: 'continue' };
    const inputArtifact = { kind: 'wr.loop_control', decision: 'stop' };

    const result = collectArtifactsForEvaluation({
      truthEvents: [buildArtifactEvent(0, eventArtifact)],
      inputArtifacts: [inputArtifact],
    });

    expect(result).toHaveLength(2);
    // Event artifacts come first, input artifacts appended last (most recent)
    expect(result[0]).toEqual(eventArtifact);
    expect(result[1]).toEqual(inputArtifact);
  });

  it('skips non-artifact events (recap/notes)', () => {
    const result = collectArtifactsForEvaluation({
      truthEvents: [buildRecapEvent(0), buildRecapEvent(1)],
      inputArtifacts: [],
    });

    expect(result).toEqual([]);
  });

  it('skips artifact events with undefined content', () => {
    const event = buildArtifactEvent(0, undefined);
    // Override content to undefined to simulate edge case
    (event as any).data.payload.content = undefined;

    const result = collectArtifactsForEvaluation({
      truthEvents: [event],
      inputArtifacts: [],
    });

    expect(result).toEqual([]);
  });

  it('preserves mismatched loopId in artifact (no filtering)', () => {
    // Critical: this function must NOT filter by loopId — it passes everything through
    const artifact = { kind: 'wr.loop_control', loopId: 'wrong-id', decision: 'stop' };

    const result = collectArtifactsForEvaluation({
      truthEvents: [buildArtifactEvent(0, artifact)],
      inputArtifacts: [],
    });

    expect(result).toHaveLength(1);
    expect((result[0] as any).loopId).toBe('wrong-id');
    expect((result[0] as any).decision).toBe('stop');
  });

  it('preserves event order (eventIndex order = chronological)', () => {
    const first = { kind: 'wr.loop_control', decision: 'continue', metadata: { order: 1 } };
    const second = { kind: 'wr.loop_control', decision: 'stop', metadata: { order: 2 } };

    const result = collectArtifactsForEvaluation({
      truthEvents: [
        buildArtifactEvent(0, first),
        buildRecapEvent(1), // non-artifact in between
        buildArtifactEvent(2, second),
      ],
      inputArtifacts: [],
    });

    expect(result).toHaveLength(2);
    expect((result[0] as any).metadata.order).toBe(1);
    expect((result[1] as any).metadata.order).toBe(2);
  });

  it('handles mixed event types and input artifacts together', () => {
    const eventArtifact = { kind: 'wr.loop_control', decision: 'continue' };
    const inputArtifact = { kind: 'wr.loop_control', loopId: 'phase-4-plan', decision: 'stop' };

    const result = collectArtifactsForEvaluation({
      truthEvents: [
        buildRecapEvent(0),
        buildArtifactEvent(1, eventArtifact),
        buildRecapEvent(2),
      ],
      inputArtifacts: [inputArtifact],
    });

    expect(result).toHaveLength(2);
    expect((result[0] as any).decision).toBe('continue');
    expect((result[1] as any).decision).toBe('stop');
    expect((result[1] as any).loopId).toBe('phase-4-plan');
  });
});
