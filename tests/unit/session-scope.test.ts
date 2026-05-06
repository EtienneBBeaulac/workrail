import { describe, it, expect } from 'vitest';
import { DefaultFileStateTracker } from '../../src/daemon/session-scope.js';
import type { ReadFileState } from '../../src/daemon/types.js';

describe('DefaultFileStateTracker', () => {
  describe('initially empty (no constructor arg)', () => {
    it('hasBeenRead returns false for unknown path', () => {
      const tracker = new DefaultFileStateTracker();
      expect(tracker.hasBeenRead('/foo')).toBe(false);
    });

    it('getReadState returns undefined for unknown path', () => {
      const tracker = new DefaultFileStateTracker();
      expect(tracker.getReadState('/foo')).toBeUndefined();
    });
  });

  describe('recordRead', () => {
    it('stores state so hasBeenRead returns true', () => {
      const tracker = new DefaultFileStateTracker();
      tracker.recordRead('/foo', 'content', Date.now(), false);
      expect(tracker.hasBeenRead('/foo')).toBe(true);
    });

    it('stores correct content and isPartialView: false', () => {
      const tracker = new DefaultFileStateTracker();
      const ts = Date.now();
      tracker.recordRead('/foo', 'hello world', ts, false);
      expect(tracker.getReadState('/foo')).toEqual<ReadFileState>({
        content: 'hello world',
        timestamp: ts,
        isPartialView: false,
      });
    });

    it('stores isPartialView: true correctly', () => {
      const tracker = new DefaultFileStateTracker();
      const ts = Date.now();
      tracker.recordRead('/foo', 'partial', ts, true);
      expect(tracker.getReadState('/foo')!.isPartialView).toBe(true);
    });

    it('timestamp stored is a positive integer', () => {
      const tracker = new DefaultFileStateTracker();
      const ts = 1_700_000_000_000;
      tracker.recordRead('/foo', 'x', ts, false);
      const state = tracker.getReadState('/foo')!;
      expect(typeof state.timestamp).toBe('number');
      expect(state.timestamp).toBeGreaterThan(0);
      expect(Number.isInteger(state.timestamp)).toBe(true);
    });

    it('tracks multiple files independently', () => {
      const tracker = new DefaultFileStateTracker();
      const tsA = 1_000;
      const tsB = 2_000;
      tracker.recordRead('/alpha', 'alpha content', tsA, false);
      tracker.recordRead('/beta', 'beta content', tsB, true);

      expect(tracker.getReadState('/alpha')).toEqual<ReadFileState>({
        content: 'alpha content',
        timestamp: tsA,
        isPartialView: false,
      });
      expect(tracker.getReadState('/beta')).toEqual<ReadFileState>({
        content: 'beta content',
        timestamp: tsB,
        isPartialView: true,
      });
    });

    it('second recordRead on same path overwrites the first (latest write wins)', () => {
      const tracker = new DefaultFileStateTracker();
      tracker.recordRead('/foo', 'first', 1_000, false);
      tracker.recordRead('/foo', 'second', 2_000, true);

      const state = tracker.getReadState('/foo')!;
      expect(state.content).toBe('second');
      expect(state.timestamp).toBe(2_000);
      expect(state.isPartialView).toBe(true);
    });
  });

  describe('toMap', () => {
    it('returns the same Map instance on repeated calls', () => {
      const tracker = new DefaultFileStateTracker();
      const mapA = tracker.toMap();
      const mapB = tracker.toMap();
      expect(mapA).toBe(mapB);
    });

    it('mutations via toMap are visible through getReadState (same-instance contract)', () => {
      const tracker = new DefaultFileStateTracker();
      const externalState: ReadFileState = { content: 'x', timestamp: 1, isPartialView: false };
      tracker.toMap().set('/bar', externalState);

      expect(tracker.hasBeenRead('/bar')).toBe(true);
      expect(tracker.getReadState('/bar')).toBe(externalState);
    });

    it('recordRead is visible through the Map returned by toMap', () => {
      const tracker = new DefaultFileStateTracker();
      tracker.recordRead('/foo', 'hello', 42, false);
      const map = tracker.toMap();
      expect(map.get('/foo')).toEqual<ReadFileState>({
        content: 'hello',
        timestamp: 42,
        isPartialView: false,
      });
    });
  });

  describe('constructor with existing Map', () => {
    it('wraps an existing Map -- pre-existing entries are visible via hasBeenRead', () => {
      const existingState: ReadFileState = { content: 'pre', timestamp: 999, isPartialView: false };
      const existingMap = new Map<string, ReadFileState>([['/pre', existingState]]);
      const tracker = new DefaultFileStateTracker(existingMap);

      expect(tracker.hasBeenRead('/pre')).toBe(true);
      expect(tracker.getReadState('/pre')).toBe(existingState);
    });

    it('shares the same Map instance (no copy is made)', () => {
      const existingMap = new Map<string, ReadFileState>();
      const tracker = new DefaultFileStateTracker(existingMap);
      expect(tracker.toMap()).toBe(existingMap);
    });

    it('new recordRead calls are visible on the original Map', () => {
      const existingMap = new Map<string, ReadFileState>();
      const tracker = new DefaultFileStateTracker(existingMap);
      tracker.recordRead('/new', 'val', 100, false);
      expect(existingMap.get('/new')).toEqual<ReadFileState>({
        content: 'val',
        timestamp: 100,
        isPartialView: false,
      });
    });
  });

  describe('default constructor (no arg) starts empty', () => {
    it('toMap returns an empty Map', () => {
      const tracker = new DefaultFileStateTracker();
      expect(tracker.toMap().size).toBe(0);
    });
  });
});
