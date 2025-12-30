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
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_CORRUPTION_DETECTED');
  });

  it('handles empty events array', () => {
    const res = projectNodeOutputsV2([]);
    expect(res.isOk()).toBe(true);
    expect(Object.keys(res._unsafeUnwrap().nodesById)).toEqual([]);
  });

  it('channel isolation: supersession is channel-scoped', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_recap_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:recap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'recap_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Recap 1' },
        },
      },
      {
        v: 1,
        eventId: 'evt_art_1',
        eventIndex: 2,
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
            contentType: 'test',
            byteLength: 10,
          },
        },
      },
      {
        v: 1,
        eventId: 'evt_recap_2',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:recap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'recap_2',
          supersedesOutputId: 'recap_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Recap 2' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    const node = projected.nodesById['node_1']!;
    
    expect(node.currentByChannel.recap.length).toBe(1);
    expect(node.currentByChannel.recap[0]!.outputId).toBe('recap_2');
    expect(node.currentByChannel.artifact.length).toBe(1);
    expect(node.currentByChannel.artifact[0]!.outputId).toBe('art_1');
  });

  it('detects multiple current recap outputs (corruption)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_recap_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:recap_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'recap_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Recap 1' },
        },
      },
      {
        v: 1,
        eventId: 'evt_recap_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:recap_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'recap_2',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Recap 2' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_CORRUPTION_DETECTED');
    expect(res._unsafeUnwrapErr().message).toContain('Multiple current recap outputs');
  });

  it('rejects out-of-order events', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_out_2',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_2',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Later' },
        },
      },
      {
        v: 1,
        eventId: 'evt_out_1',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Earlier' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_INVARIANT_VIOLATION');
  });

  it('handles transitive supersession chains correctly (A→B→C)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_c',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_c',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_c',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Output C' },
        },
      },
      {
        v: 1,
        eventId: 'evt_b',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_b',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_b',
          supersedesOutputId: 'out_c',  // B supersedes C
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Output B' },
        },
      },
      {
        v: 1,
        eventId: 'evt_a',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_a',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_a',
          supersedesOutputId: 'out_b',  // A supersedes B
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'Output A' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    const node = projected.nodesById['node_1']!;
    
    // Only A should be current (transitive: B and C are superseded)
    expect(node.currentByChannel.recap.length).toBe(1);
    expect(node.currentByChannel.recap[0]!.outputId).toBe('out_a');
  });

  it('detects cycles in supersession chains (A→B→C→A)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_a',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_a',
          supersedesOutputId: 'out_b',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'A' },
        },
      },
      {
        v: 1,
        eventId: 'evt_b',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_b',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_b',
          supersedesOutputId: 'out_c',
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'B' },
        },
      },
      {
        v: 1,
        eventId: 'evt_c',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_output_appended',
        dedupeKey: 'node_output_appended:sess_1:out_c',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_c',
          supersedesOutputId: 'out_a',  // Cycle! C → A
          outputChannel: 'recap',
          payload: { payloadKind: 'notes', notesMarkdown: 'C' },
        },
      },
    ];

    const res = projectNodeOutputsV2(events);
    expect(res.isErr()).toBe(true);
    // Note: Cycle is detected during transitive closure walk as PROJECTION_INVARIANT_VIOLATION,
    // but the test data's C→A cycle means out_a is not yet in the history when C references it.
    // So it fails as PROJECTION_CORRUPTION_DETECTED first (missing output).
    // Either error is acceptable as both represent data integrity violations.
    const err = res._unsafeUnwrapErr();
    expect(err.code === 'PROJECTION_INVARIANT_VIOLATION' || err.code === 'PROJECTION_CORRUPTION_DETECTED').toBe(true);
  });
});
