/**
 * Output ordering determinism tests.
 *
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (`node_output_appended`)
 *
 * Tests the `normalizeOutputsForAppend` function to ensure:
 * - At most one recap first
 * - Then artifacts sorted by (sha256, contentType) ascending
 *
 * These tests validate the normalizer output for deterministic replay.
 *
 * @enforces output-ordering-deterministic
 * @enforces output-channel-closed-set
 */
import { describe, it, expect } from 'vitest';
import { normalizeOutputsForAppend } from '../../../src/v2/durable-core/domain/outputs.js';

type TestOutput = {
  readonly outputId: string;
  readonly outputChannel: 'recap' | 'artifact';
  readonly payload: any;
  readonly supersedesOutputId?: string;
};

describe('normalizeOutputsForAppend (output ordering)', () => {
  describe('empty and single output cases', () => {
    it('empty array returns empty result', () => {
      const result = normalizeOutputsForAppend([]);
      expect(result).toEqual([]);
    });

    it('single recap returns that recap', () => {
      const recap: TestOutput = {
        outputId: 'out_recap_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Test recap' },
      };
      const result = normalizeOutputsForAppend([recap]);
      expect(result).toEqual([recap]);
    });

    it('single artifact returns that artifact', () => {
      const artifact: TestOutput = {
        outputId: 'out_art_1',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'a'.repeat(64),
          contentType: 'application/json',
          byteLength: 100,
        },
      };
      const result = normalizeOutputsForAppend([artifact]);
      expect(result).toEqual([artifact]);
    });
  });

  describe('recap ordering', () => {
    it('recap appears first when mixed with artifacts', () => {
      const recap: TestOutput = {
        outputId: 'out_recap_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Test recap' },
      };
      const artifact: TestOutput = {
        outputId: 'out_art_1',
        outputChannel: 'artifact',
        payload: {
          payloadKind: 'artifact_ref',
          sha256: 'sha256:' + 'a'.repeat(64),
          contentType: 'application/json',
          byteLength: 100,
        },
      };

      // Test with recap first in input
      let result = normalizeOutputsForAppend([recap, artifact]);
      expect(result[0]!.outputChannel).toBe('recap');
      expect(result[1]!.outputChannel).toBe('artifact');

      // Test with artifact first in input (should still reorder recap first)
      result = normalizeOutputsForAppend([artifact, recap]);
      expect(result[0]!.outputChannel).toBe('recap');
      expect(result[1]!.outputChannel).toBe('artifact');
    });

    it('multiple recaps: only first recap is kept', () => {
      const recap1: TestOutput = {
        outputId: 'out_recap_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'First recap' },
      };
      const recap2: TestOutput = {
        outputId: 'out_recap_2',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Second recap' },
      };

      const result = normalizeOutputsForAppend([recap1, recap2]);
      expect(result).toHaveLength(1);
      expect(result[0]!.outputId).toBe('out_recap_1'); // First one is kept
    });
  });

  describe('artifact sorting by (sha256, contentType)', () => {
    it('artifacts sorted by sha256 ascending', () => {
      const artifacts: TestOutput[] = [
        {
          outputId: 'out_art_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'c'.repeat(64),
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_art_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_art_3',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'b'.repeat(64),
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
      ];

      const result = normalizeOutputsForAppend(artifacts);
      expect(result).toHaveLength(3);
      expect(result[0]!.outputId).toBe('out_art_2'); // sha256:aaa...
      expect(result[1]!.outputId).toBe('out_art_3'); // sha256:bbb...
      expect(result[2]!.outputId).toBe('out_art_1'); // sha256:ccc...
    });

    it('artifacts with same sha256: sorted by contentType ascending', () => {
      const sameSha = 'sha256:' + 'a'.repeat(64);
      const artifacts: TestOutput[] = [
        {
          outputId: 'out_art_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: sameSha,
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_art_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: sameSha,
            contentType: 'application/json',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_art_3',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: sameSha,
            contentType: 'text/html',
            byteLength: 100,
          },
        },
      ];

      const result = normalizeOutputsForAppend(artifacts);
      expect(result).toHaveLength(3);
      expect(result[0]!.outputId).toBe('out_art_2'); // application/json (comes first alphabetically)
      expect(result[1]!.outputId).toBe('out_art_3'); // text/html (comes before text/plain)
      expect(result[2]!.outputId).toBe('out_art_1'); // text/plain (comes last)
    });

    it('full sort: sha256 then contentType', () => {
      const artifacts: TestOutput[] = [
        {
          outputId: 'out_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'b'.repeat(64),
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'text/html',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_3',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'application/json',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_4',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'b'.repeat(64),
            contentType: 'application/json',
            byteLength: 100,
          },
        },
      ];

      const result = normalizeOutputsForAppend(artifacts);
      expect(result).toHaveLength(4);
      // sha256:aaa... + application/json
      expect(result[0]!.outputId).toBe('out_3');
      // sha256:aaa... + text/html
      expect(result[1]!.outputId).toBe('out_2');
      // sha256:bbb... + application/json
      expect(result[2]!.outputId).toBe('out_4');
      // sha256:bbb... + text/plain
      expect(result[3]!.outputId).toBe('out_1');
    });
  });

  describe('recap + artifacts ordering', () => {
    it('recap first, then sorted artifacts', () => {
      const recap: TestOutput = {
        outputId: 'out_recap_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Test recap' },
      };
      const artifacts: TestOutput[] = [
        {
          outputId: 'out_art_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'c'.repeat(64),
            contentType: 'text/plain',
            byteLength: 100,
          },
        },
        {
          outputId: 'out_art_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'application/json',
            byteLength: 100,
          },
        },
      ];

      // Input in random order
      const result = normalizeOutputsForAppend([artifacts[1]!, recap, artifacts[0]!]);
      expect(result).toHaveLength(3);
      expect(result[0]!.outputChannel).toBe('recap');
      expect(result[1]!.outputId).toBe('out_art_2'); // sha256:aaa...
      expect(result[2]!.outputId).toBe('out_art_1'); // sha256:ccc...
    });
  });

  describe('preserves properties', () => {
    it('preserves supersedesOutputId field', () => {
      const output: TestOutput = {
        outputId: 'out_1',
        outputChannel: 'recap',
        payload: { payloadKind: 'notes', notesMarkdown: 'Test' },
        supersedesOutputId: 'out_0',
      };

      const result = normalizeOutputsForAppend([output]);
      expect(result[0]!.supersedesOutputId).toBe('out_0');
    });
  });

  describe('edge cases', () => {
    it('handles missing sha256 field gracefully', () => {
      const outputs: any[] = [
        {
          outputId: 'out_1',
          outputChannel: 'artifact',
          payload: { payloadKind: 'artifact_ref', contentType: 'text/plain' },
        },
        {
          outputId: 'out_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'text/plain',
          },
        },
      ];

      const result = normalizeOutputsForAppend(outputs);
      expect(result).toHaveLength(2);
      // Missing sha256 sorts as empty string, which comes before 'sha256:aaa...'
      expect(result[0]!.outputId).toBe('out_1');
      expect(result[1]!.outputId).toBe('out_2');
    });

    it('handles missing contentType field gracefully', () => {
      const outputs: any[] = [
        {
          outputId: 'out_1',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
          },
        },
        {
          outputId: 'out_2',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:' + 'a'.repeat(64),
            contentType: 'text/plain',
          },
        },
      ];

      const result = normalizeOutputsForAppend(outputs);
      expect(result).toHaveLength(2);
      // Missing contentType sorts as empty string, which comes before 'text/plain'
      expect(result[0]!.outputId).toBe('out_1');
      expect(result[1]!.outputId).toBe('out_2');
    });
  });
});
