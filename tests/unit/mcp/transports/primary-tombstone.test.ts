import { describe, it, expect } from 'vitest';
import {
  writeTombstone,
  readTombstone,
  clearTombstone,
  tombstonePath,
  type PrimaryTombstone,
  type WriteSyncLike,
  type ReadSyncLike,
  type UnlinkSyncLike,
} from '../../../../src/mcp/transports/primary-tombstone.js';

/**
 * Unit tests for primary-tombstone.ts.
 * All I/O is injected — no real file system operations.
 */

describe('writeTombstone', () => {
  it('writes a valid JSON tombstone to the correct path', () => {
    const written: Array<[string, string]> = [];
    const writeSync: WriteSyncLike = (path, content) => { written.push([path, content]); };
    const mkdirSync = () => {};
    writeTombstone(3100, 99999, { writeSync, mkdirSync });
    expect(written).toHaveLength(1);
    const [path, content] = written[0]!;
    expect(path).toBe(tombstonePath());
    const parsed = JSON.parse(content) as PrimaryTombstone;
    expect(parsed.pid).toBe(99999);
    expect(parsed.port).toBe(3100);
    expect(typeof parsed.diedAt).toBe('string');
  });

  it('does not throw when writeSync fails (advisory only)', () => {
    const writeSync: WriteSyncLike = () => { throw new Error('EACCES'); };
    const mkdirSync = () => {};
    expect(() => writeTombstone(3100, 99999, { writeSync, mkdirSync })).not.toThrow();
  });

  it('does not throw when mkdirSync fails', () => {
    const writeSync: WriteSyncLike = () => {};
    const mkdirSync = () => { throw new Error('EPERM'); };
    expect(() => writeTombstone(3100, 99999, { writeSync, mkdirSync })).not.toThrow();
  });
});

describe('readTombstone', () => {
  it('returns the tombstone when file exists and is valid JSON', () => {
    const tombstone: PrimaryTombstone = { pid: 12345, port: 3100, diedAt: '2026-04-16T00:00:00.000Z' };
    const readSync: ReadSyncLike = () => JSON.stringify(tombstone);
    const result = readTombstone({ readSync });
    expect(result).toEqual(tombstone);
  });

  it('returns null when file does not exist (ENOENT)', () => {
    const readSync: ReadSyncLike = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const result = readTombstone({ readSync });
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    const readSync: ReadSyncLike = () => 'not-json';
    const result = readTombstone({ readSync });
    expect(result).toBeNull();
  });

  it('returns null when JSON is missing required fields', () => {
    const readSync: ReadSyncLike = () => JSON.stringify({ pid: 12345 }); // missing port and diedAt
    const result = readTombstone({ readSync });
    expect(result).toBeNull();
  });
});

describe('clearTombstone', () => {
  it('calls unlinkSync with the tombstone path', () => {
    const deleted: string[] = [];
    const unlinkSync: UnlinkSyncLike = (path) => { deleted.push(path); };
    clearTombstone({ unlinkSync });
    expect(deleted).toEqual([tombstonePath()]);
  });

  it('does not throw when file does not exist (ENOENT)', () => {
    const unlinkSync: UnlinkSyncLike = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    expect(() => clearTombstone({ unlinkSync })).not.toThrow();
  });
});
