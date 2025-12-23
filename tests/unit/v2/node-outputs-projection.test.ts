import { describe, it, expect } from 'vitest';
import { projectNodeOutputsV2 } from '../../../src/v2/projections/node-outputs.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 node outputs projection', () => {
  it('derives current outputs by supersedes linkage (artifact keeps multiple)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_out_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'First recap' },
        },
      },
      {
        v: 1,
        eventId: 'evt_out_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_2',
          supersedesOutputId: 'out_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Second recap' },
        },
      },
      {
        v: 1,
        eventId: 'evt_art_1',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:art_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'art_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
            contentType: 'application/json',
            byteLength: 10,
          },
        },
      },
      {
        v: 1,
        eventId: 'evt_art_2',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:art_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'art_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
            contentType: 'text/plain',
            byteLength: 5,
          },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    const node = projected.nodesById['node_1']!;

    expect(node.historyByChannel.recap.length).toBe(2);
    expect(node.currentByChannel.recap.length).toBe(1);
    expect(node.currentByChannel.recap[0]!.outputId).toBe('out_2');

    expect(node.historyByChannel.artifact.length).toBe(2);
    expect(node.currentByChannel.artifact.map((o) => o.outputId).sort()).toEqual(['art_1', 'art_2']);
  });

  it('fails fast when supersedesOutputId references missing output', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_out_2',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_2',
          supersedesOutputId: 'missing',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Recap' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isErr()).toBe(true);
  });
});
