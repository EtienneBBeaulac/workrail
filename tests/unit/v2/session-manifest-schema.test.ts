/**
 * v2 Session Manifest Schema Tests
 *
 * @enforces paths-relative-only
 */
import { describe, it, expect } from 'vitest';
import { ManifestRecordV1Schema } from '../../../src/v2/durable-core/schemas/session/index.js';

/**
 * @enforces paths-relative-only
 * 
 * Tests that all paths in manifests/bundles are relative (no absolute paths or traversal).
 */
describe('v2 session manifest schemas (Slice 2 locks)', () => {
  it('accepts segment_closed record shape (v=1)', () => {
    const parsed = ManifestRecordV1Schema.safeParse({
      v: 1,
      manifestIndex: 0,
      sessionId: 'sess_01JH...',
      kind: 'segment_closed',
      firstEventIndex: 0,
      lastEventIndex: 10,
      segmentRelPath: 'events/00000000-00000010.jsonl',
      sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
      bytes: 123,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts snapshot_pinned record shape (v=1)', () => {
    const parsed = ManifestRecordV1Schema.safeParse({
      v: 1,
      manifestIndex: 1,
      sessionId: 'sess_01JH...',
      kind: 'snapshot_pinned',
      eventIndex: 42,
      snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
      createdByEventId: 'evt_01JH...',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid sha256 digest format', () => {
    const parsed = ManifestRecordV1Schema.safeParse({
      v: 1,
      manifestIndex: 0,
      sessionId: 'sess_01JH...',
      kind: 'segment_closed',
      firstEventIndex: 0,
      lastEventIndex: 0,
      segmentRelPath: 'events/00000000-00000000.jsonl',
      sha256: 'not-a-digest',
      bytes: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('paths-relative-only: rejects absolute paths in segmentRelPath', () => {
    const parsed = ManifestRecordV1Schema.safeParse({
      v: 1,
      manifestIndex: 0,
      sessionId: 'sess_01JH...',
      kind: 'segment_closed',
      firstEventIndex: 0,
      lastEventIndex: 0,
      segmentRelPath: '/events/00000000-00000000.jsonl',
      sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
      bytes: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('paths-relative-only: rejects path traversal in segmentRelPath', () => {
    const parsed = ManifestRecordV1Schema.safeParse({
      v: 1,
      manifestIndex: 0,
      sessionId: 'sess_01JH...',
      kind: 'segment_closed',
      firstEventIndex: 0,
      lastEventIndex: 0,
      segmentRelPath: '../escape.jsonl',
      sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
      bytes: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('paths-relative-only: accepts valid relative paths', () => {
    const validPaths = [
      'events/segment.jsonl',
      'subdir/another/segment.jsonl',
      'file.txt',
      'a/b/c/d/e.jsonl',
    ];

    for (const relPath of validPaths) {
      const parsed = ManifestRecordV1Schema.safeParse({
        v: 1,
        manifestIndex: 0,
        sessionId: 'sess_01JH...',
        kind: 'segment_closed',
        firstEventIndex: 0,
        lastEventIndex: 0,
        segmentRelPath: relPath,
        sha256: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        bytes: 0,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
