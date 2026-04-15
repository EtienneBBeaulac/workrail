/**
 * Unit tests for DaemonRegistry.
 *
 * The registry is pure in-memory state -- no I/O, no ports, no fakes needed.
 * Tests cover: register, heartbeat, unregister, snapshot, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { DaemonRegistry } from '../../src/v2/infra/in-memory/daemon-registry/index.js';

describe('DaemonRegistry', () => {
  describe('register()', () => {
    it('creates an entry with running status and timestamps', () => {
      const registry = new DaemonRegistry();
      const beforeMs = Date.now();
      registry.register('sess_aaa', 'coding-task-workflow');
      const afterMs = Date.now();

      const snap = registry.snapshot();
      expect(snap.size).toBe(1);

      const entry = snap.get('sess_aaa');
      expect(entry).toBeDefined();
      expect(entry!.sessionId).toBe('sess_aaa');
      expect(entry!.workflowId).toBe('coding-task-workflow');
      expect(entry!.status).toBe('running');
      expect(entry!.startedAtMs).toBeGreaterThanOrEqual(beforeMs);
      expect(entry!.startedAtMs).toBeLessThanOrEqual(afterMs);
      expect(entry!.lastHeartbeatMs).toBe(entry!.startedAtMs);
    });

    it('replaces an existing entry on re-register (crash recovery)', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_bbb', 'workflow-a');
      registry.register('sess_bbb', 'workflow-b'); // overwrite

      const snap = registry.snapshot();
      expect(snap.size).toBe(1);
      expect(snap.get('sess_bbb')!.workflowId).toBe('workflow-b');
    });

    it('can register multiple sessions independently', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_111', 'wf-1');
      registry.register('sess_222', 'wf-2');

      const snap = registry.snapshot();
      expect(snap.size).toBe(2);
      expect(snap.get('sess_111')!.workflowId).toBe('wf-1');
      expect(snap.get('sess_222')!.workflowId).toBe('wf-2');
    });
  });

  describe('heartbeat()', () => {
    it('updates lastHeartbeatMs on a registered session', async () => {
      const registry = new DaemonRegistry();
      registry.register('sess_ccc', 'wf-test');

      const snapBefore = registry.snapshot();
      const initialHeartbeat = snapBefore.get('sess_ccc')!.lastHeartbeatMs;

      // Small delay to ensure timestamp advances.
      await new Promise((r) => setTimeout(r, 5));
      registry.heartbeat('sess_ccc');

      const snapAfter = registry.snapshot();
      const updatedHeartbeat = snapAfter.get('sess_ccc')!.lastHeartbeatMs;

      expect(updatedHeartbeat).toBeGreaterThanOrEqual(initialHeartbeat);
    });

    it('does not mutate the previous snapshot (immutability)', async () => {
      const registry = new DaemonRegistry();
      registry.register('sess_ddd', 'wf-test');

      const snap1 = registry.snapshot();
      const heartbeatBefore = snap1.get('sess_ddd')!.lastHeartbeatMs;

      await new Promise((r) => setTimeout(r, 5));
      registry.heartbeat('sess_ddd');

      // snap1 was taken before the heartbeat -- it must be unchanged.
      expect(snap1.get('sess_ddd')!.lastHeartbeatMs).toBe(heartbeatBefore);
    });

    it('is a no-op for an unknown session', () => {
      const registry = new DaemonRegistry();
      // Should not throw
      expect(() => registry.heartbeat('sess_unknown')).not.toThrow();
      expect(registry.snapshot().size).toBe(0);
    });
  });

  describe('unregister()', () => {
    it('removes the entry from the snapshot', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_eee', 'wf-test');
      registry.unregister('sess_eee', 'completed');

      expect(registry.snapshot().size).toBe(0);
    });

    it('defaults status to completed when not specified', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_fff', 'wf-test');
      // No throw -- default status used
      expect(() => registry.unregister('sess_fff')).not.toThrow();
      expect(registry.snapshot().size).toBe(0);
    });

    it('is a no-op for an unknown session', () => {
      const registry = new DaemonRegistry();
      expect(() => registry.unregister('sess_unknown', 'failed')).not.toThrow();
    });

    it('only removes the specified session', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_ggg', 'wf-1');
      registry.register('sess_hhh', 'wf-2');
      registry.unregister('sess_ggg', 'completed');

      const snap = registry.snapshot();
      expect(snap.size).toBe(1);
      expect(snap.has('sess_ggg')).toBe(false);
      expect(snap.has('sess_hhh')).toBe(true);
    });
  });

  describe('snapshot()', () => {
    it('returns an empty map when no sessions are registered', () => {
      const registry = new DaemonRegistry();
      expect(registry.snapshot().size).toBe(0);
    });

    it('returns a new map on each call (mutations do not affect future snapshots)', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_iii', 'wf-test');

      const snap1 = registry.snapshot();
      const snap2 = registry.snapshot();

      // Different Map instances
      expect(snap1).not.toBe(snap2);
      // But same content
      expect(snap1.size).toBe(snap2.size);
    });

    it('snapshot taken before unregister is unaffected by later unregister', () => {
      const registry = new DaemonRegistry();
      registry.register('sess_jjj', 'wf-test');

      const snap = registry.snapshot();
      expect(snap.has('sess_jjj')).toBe(true);

      registry.unregister('sess_jjj', 'completed');

      // The already-taken snapshot should still have the entry.
      expect(snap.has('sess_jjj')).toBe(true);
      // But a new snapshot should not.
      expect(registry.snapshot().has('sess_jjj')).toBe(false);
    });
  });
});
