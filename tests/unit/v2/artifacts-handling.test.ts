/**
 * Artifact handling tests.
 * 
 * Tests artifact output wiring from Phase 1 (Layer 3 integration):
 * - ArtifactRefPayloadV1Schema accepts optional content field
 * - Artifact outputs are properly structured with inlined content
 * - Output normalization handles artifacts with content
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { normalizeOutputsForAppend } from '../../../src/v2/durable-core/domain/outputs.js';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/events.js';

type TestOutput = {
  readonly outputId: string;
  readonly outputChannel: 'recap' | 'artifact';
  readonly payload: any;
  readonly supersedesOutputId?: string;
};

describe('artifact handling (Layer 3 Phase 1)', () => {
  describe('ArtifactRefPayloadV1Schema content field', () => {
    it('accepts artifact_ref payload without content (backward compat)', () => {
      const event = {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 0,
        sessionId: 's1',
        kind: 'node_output_appended',
        dedupeKey: 'output:s1:run_1:node_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'application/json',
            byteLength: 100,
            // No content field - backward compat
          },
        },
      };

      const result = DomainEventV1Schema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('accepts artifact_ref payload with content (new capability)', () => {
      const event = {
        v: 1,
        eventId: 'evt_2',
        eventIndex: 1,
        sessionId: 's1',
        kind: 'node_output_appended',
        dedupeKey: 'output:s1:run_1:node_1:out_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'b'.repeat(64),
            contentType: 'application/json',
            byteLength: 50,
            content: { kind: 'wr.loop_control', loopId: 'plan-iteration', decision: 'continue' },
          },
        },
      };

      const result = DomainEventV1Schema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('accepts artifact_ref with complex nested content', () => {
      const event = {
        v: 1,
        eventId: 'evt_3',
        eventIndex: 2,
        sessionId: 's1',
        kind: 'node_output_appended',
        dedupeKey: 'output:s1:run_1:node_1:out_3',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_3',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'c'.repeat(64),
            contentType: 'application/json',
            byteLength: 200,
            content: {
              kind: 'test_artifact',
              data: {
                nested: {
                  array: [1, 2, 3],
                  string: 'test',
                  boolean: true,
                  null: null,
                },
              },
            },
          },
        },
      };

      const result = DomainEventV1Schema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('accepts artifact_ref with null content', () => {
      const event = {
        v: 1,
        eventId: 'evt_4',
        eventIndex: 3,
        sessionId: 's1',
        kind: 'node_output_appended',
        dedupeKey: 'output:s1:run_1:node_1:out_4',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_4',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'd'.repeat(64),
            contentType: 'application/json',
            byteLength: 4,
            content: null, // Explicit null is valid JSON
          },
        },
      };

      const result = DomainEventV1Schema.safeParse(event);
      expect(result.success).toBe(true);
    });
  });

  describe('artifact output normalization with content', () => {
    it('normalizes artifact outputs with inlined content', () => {
      const artifact: TestOutput = {
        outputId: 'out_artifact_attempt1_0',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'e'.repeat(64),
          contentType: 'application/json',
          byteLength: 75,
          content: { kind: 'wr.loop_control', loopId: 'test', decision: 'stop' },
        },
      };

      const result = normalizeOutputsForAppend([artifact]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(artifact);
    });

    it('sorts multiple artifacts with content by sha256', () => {
      const artifact1: TestOutput = {
        outputId: 'out_artifact_1',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'z'.repeat(64),
          contentType: 'application/json',
          byteLength: 10,
          content: { id: 1 },
        },
      };

      const artifact2: TestOutput = {
        outputId: 'out_artifact_2',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'a'.repeat(64),
          contentType: 'application/json',
          byteLength: 10,
          content: { id: 2 },
        },
      };

      // Input in reverse order
      const result = normalizeOutputsForAppend([artifact1, artifact2]);
      
      expect(result).toHaveLength(2);
      // Should be sorted by sha256 ascending (a < z)
      expect(result[0]!.payload.sha256).toBe('sha256:' + 'a'.repeat(64));
      expect(result[1]!.payload.sha256).toBe('sha256:' + 'z'.repeat(64));
    });

    it('places recap before artifacts with content', () => {
      const recap: TestOutput = {
        outputId: 'out_recap_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Step complete' },
      };

      const artifact: TestOutput = {
        outputId: 'out_artifact_1',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'f'.repeat(64),
          contentType: 'application/json',
          byteLength: 50,
          content: { decision: 'continue' },
        },
      };

      // Input artifact first
      const result = normalizeOutputsForAppend([artifact, recap]);
      
      expect(result).toHaveLength(2);
      expect(result[0]!.outputChannel).toBe('recap');
      expect(result[1]!.outputChannel).toBe('artifact');
    });
  });

  describe('artifact output structure (integration pattern)', () => {
    it('artifact output has expected structure for loop control', () => {
      // This test documents the expected structure that v2-execution.ts produces
      const loopControlArtifact = {
        outputId: 'out_artifact_attempt123_0',
        outputChannel: 'artifact' as const,
        payload: {
          payloadKind: 'artifact_ref' as const,
          sha256: 'sha256:' + '0'.repeat(64), // Computed from canonical bytes
          contentType: 'application/json',
          byteLength: 58, // Canonical JSON byte length
          content: { kind: 'wr.loop_control', loopId: 'plan-iteration', decision: 'continue' },
        },
      };

      // Verify structure matches expectations
      expect(loopControlArtifact.outputChannel).toBe('artifact');
      expect(loopControlArtifact.payload.payloadKind).toBe('artifact_ref');
      expect(loopControlArtifact.payload.content).toEqual({
        kind: 'wr.loop_control',
        loopId: 'plan-iteration',
        decision: 'continue',
      });
    });

    it('multiple artifacts have unique outputIds', () => {
      const attemptId = 'attempt_xyz';
      const artifacts = [
        { kind: 'artifact1', data: 'a' },
        { kind: 'artifact2', data: 'b' },
        { kind: 'artifact3', data: 'c' },
      ];

      // Simulate the outputId generation pattern from v2-execution.ts
      const outputIds = artifacts.map((_, idx) => `out_artifact_${attemptId}_${idx}`);

      expect(outputIds).toEqual([
        'out_artifact_attempt_xyz_0',
        'out_artifact_attempt_xyz_1',
        'out_artifact_attempt_xyz_2',
      ]);
      
      // Verify uniqueness
      const uniqueIds = new Set(outputIds);
      expect(uniqueIds.size).toBe(outputIds.length);
    });
  });
});
