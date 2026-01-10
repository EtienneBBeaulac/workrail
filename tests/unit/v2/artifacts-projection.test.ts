/**
 * Artifacts Projection Tests
 * 
 * Tests for projecting artifacts from node_output_appended events.
 */

import { describe, it, expect } from 'vitest';
import {
  projectArtifactsV2,
  getArtifactContentsForNode,
  type ArtifactsProjectionV2,
} from '../../../src/v2/projections/artifacts.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

function createArtifactEvent(args: {
  eventIndex: number;
  nodeId: string;
  outputId: string;
  sha256: string;
  content: unknown;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'node_output_appended',
    dedupeKey: `output:sess_1:run_1:${args.nodeId}:${args.outputId}`,
    scope: { runId: 'run_1', nodeId: args.nodeId },
    data: {
      outputId: args.outputId,
      outputChannel: 'artifact',
      payload: {
        payloadKind: 'artifact_ref',
        sha256: args.sha256,
        contentType: 'application/json',
        byteLength: 100,
        content: args.content,
      },
    },
  } as unknown as DomainEventV1;
}

function createNotesEvent(args: {
  eventIndex: number;
  nodeId: string;
  outputId: string;
  notesMarkdown: string;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'node_output_appended',
    dedupeKey: `output:sess_1:run_1:${args.nodeId}:${args.outputId}`,
    scope: { runId: 'run_1', nodeId: args.nodeId },
    data: {
      outputId: args.outputId,
      outputChannel: 'recap',
      payload: {
        payloadKind: 'notes',
        notesMarkdown: args.notesMarkdown,
      },
    },
  } as unknown as DomainEventV1;
}

describe('projectArtifactsV2', () => {
  describe('basic projection', () => {
    it('projects single artifact for a node', () => {
      const events = [
        createArtifactEvent({
          eventIndex: 0,
          nodeId: 'node_1',
          outputId: 'out_1',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: { kind: 'wr.loop_control', loopId: 'test', decision: 'continue' },
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.byNodeId['node_1']).toBeDefined();
        expect(result.value.byNodeId['node_1']!.artifacts).toHaveLength(1);
        expect(result.value.byNodeId['node_1']!.artifacts[0]!.content).toEqual({
          kind: 'wr.loop_control',
          loopId: 'test',
          decision: 'continue',
        });
      }
    });

    it('projects multiple artifacts for same node', () => {
      const events = [
        createArtifactEvent({
          eventIndex: 0,
          nodeId: 'node_1',
          outputId: 'out_1',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: { kind: 'artifact_1', data: 'first' },
        }),
        createArtifactEvent({
          eventIndex: 1,
          nodeId: 'node_1',
          outputId: 'out_2',
          sha256: 'sha256:' + 'b'.repeat(64),
          content: { kind: 'artifact_2', data: 'second' },
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.byNodeId['node_1']!.artifacts).toHaveLength(2);
      }
    });

    it('projects artifacts for multiple nodes', () => {
      const events = [
        createArtifactEvent({
          eventIndex: 0,
          nodeId: 'node_1',
          outputId: 'out_1',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: { node: 1 },
        }),
        createArtifactEvent({
          eventIndex: 1,
          nodeId: 'node_2',
          outputId: 'out_2',
          sha256: 'sha256:' + 'b'.repeat(64),
          content: { node: 2 },
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(Object.keys(result.value.byNodeId)).toHaveLength(2);
        expect(result.value.byNodeId['node_1']!.artifacts).toHaveLength(1);
        expect(result.value.byNodeId['node_2']!.artifacts).toHaveLength(1);
      }
    });

    it('returns empty projection for empty events', () => {
      const result = projectArtifactsV2([]);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(Object.keys(result.value.byNodeId)).toHaveLength(0);
      }
    });
  });

  describe('filtering', () => {
    it('ignores notes output events', () => {
      const events = [
        createNotesEvent({
          eventIndex: 0,
          nodeId: 'node_1',
          outputId: 'out_1',
          notesMarkdown: 'Some notes',
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(Object.keys(result.value.byNodeId)).toHaveLength(0);
      }
    });

    it('ignores artifacts without inlined content', () => {
      const events = [
        {
          v: 1,
          eventId: 'evt_0',
          eventIndex: 0,
          sessionId: 'sess_1',
          kind: 'node_output_appended',
          dedupeKey: 'output:sess_1:run_1:node_1:out_1',
          scope: { runId: 'run_1', nodeId: 'node_1' },
          data: {
            outputId: 'out_1',
            outputChannel: 'artifact',
            payload: {
              payloadKind: 'artifact_ref',
              sha256: 'sha256:' + 'a'.repeat(64),
              contentType: 'application/json',
              byteLength: 100,
              // No content field - blob ref only
            },
          },
        } as unknown as DomainEventV1,
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(Object.keys(result.value.byNodeId)).toHaveLength(0);
      }
    });

    it('only includes artifact channel events', () => {
      const events = [
        createNotesEvent({
          eventIndex: 0,
          nodeId: 'node_1',
          outputId: 'out_1',
          notesMarkdown: 'Notes',
        }),
        createArtifactEvent({
          eventIndex: 1,
          nodeId: 'node_1',
          outputId: 'out_2',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: { type: 'artifact' },
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.byNodeId['node_1']!.artifacts).toHaveLength(1);
        expect(result.value.byNodeId['node_1']!.artifacts[0]!.content).toEqual({ type: 'artifact' });
      }
    });
  });

  describe('invariants', () => {
    it('fails on unsorted events', () => {
      const events = [
        createArtifactEvent({
          eventIndex: 1,
          nodeId: 'node_1',
          outputId: 'out_1',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: {},
        }),
        createArtifactEvent({
          eventIndex: 0, // Out of order
          nodeId: 'node_1',
          outputId: 'out_2',
          sha256: 'sha256:' + 'b'.repeat(64),
          content: {},
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
      }
    });

    it('preserves event index on projected artifacts', () => {
      const events = [
        createArtifactEvent({
          eventIndex: 5,
          nodeId: 'node_1',
          outputId: 'out_1',
          sha256: 'sha256:' + 'a'.repeat(64),
          content: { data: 'test' },
        }),
      ];

      const result = projectArtifactsV2(events);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.byNodeId['node_1']!.artifacts[0]!.createdAtEventIndex).toBe(5);
      }
    });
  });
});

describe('getArtifactContentsForNode', () => {
  it('returns artifact contents for existing node', () => {
    const projection: ArtifactsProjectionV2 = {
      byNodeId: {
        node_1: {
          artifacts: [
            {
              content: { kind: 'wr.loop_control', loopId: 'test', decision: 'continue' },
              outputId: 'out_1',
              sha256: 'sha256:' + 'a'.repeat(64),
              contentType: 'application/json',
              byteLength: 50,
              createdAtEventIndex: 0,
            },
          ],
        },
      },
    };

    const contents = getArtifactContentsForNode(projection, 'node_1');
    expect(contents).toHaveLength(1);
    expect(contents[0]).toEqual({ kind: 'wr.loop_control', loopId: 'test', decision: 'continue' });
  });

  it('returns empty array for non-existent node', () => {
    const projection: ArtifactsProjectionV2 = {
      byNodeId: {},
    };

    const contents = getArtifactContentsForNode(projection, 'non_existent');
    expect(contents).toHaveLength(0);
  });

  it('returns multiple contents for node with multiple artifacts', () => {
    const projection: ArtifactsProjectionV2 = {
      byNodeId: {
        node_1: {
          artifacts: [
            {
              content: { id: 1 },
              outputId: 'out_1',
              sha256: 'sha256:' + 'a'.repeat(64),
              contentType: 'application/json',
              byteLength: 10,
              createdAtEventIndex: 0,
            },
            {
              content: { id: 2 },
              outputId: 'out_2',
              sha256: 'sha256:' + 'b'.repeat(64),
              contentType: 'application/json',
              byteLength: 10,
              createdAtEventIndex: 1,
            },
          ],
        },
      },
    };

    const contents = getArtifactContentsForNode(projection, 'node_1');
    expect(contents).toHaveLength(2);
    expect(contents[0]).toEqual({ id: 1 });
    expect(contents[1]).toEqual({ id: 2 });
  });
});
