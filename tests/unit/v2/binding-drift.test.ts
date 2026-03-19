/**
 * Tests for detectBindingDrift (binding-drift.ts)
 *
 * detectBindingDrift receives `pinnedOverrides` — ONLY project-sourced bindings
 * from the compiled snapshot. Slots resolved via extensionPoint defaults are
 * absent from this map and are never compared. This is intentional: if a slot
 * had no project override at compile time and still has none now, there is
 * nothing to compare and no drift is possible.
 */

import { describe, it, expect } from 'vitest';
import { detectBindingDrift, formatDriftWarning } from '../../../src/v2/durable-core/domain/binding-drift.js';

describe('detectBindingDrift', () => {
  describe('no drift cases', () => {
    it('returns empty array when pinnedOverrides is empty (no project overrides at compile time)', () => {
      const warnings = detectBindingDrift({}, new Map([['design_review', 'my-routine']]));
      expect(warnings).toHaveLength(0);
    });

    it('returns empty array when current overrides match pinned exactly', () => {
      const pinned = { design_review: 'routine-v1', test_runner: 'runner-v2' };
      const current = new Map([['design_review', 'routine-v1'], ['test_runner', 'runner-v2']]);
      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(0);
    });

    it('returns empty array when current adds new slots not in pinnedOverrides', () => {
      // New project overrides added after session start do not affect the compiled session
      const pinned = { design_review: 'routine-v1' };
      const current = new Map([['design_review', 'routine-v1'], ['new_slot', 'some-routine']]);
      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('value changed drift', () => {
    it('emits BINDING_DRIFT when a project override changes value', () => {
      const pinned = { design_review: 'routine-v1' };
      const current = new Map([['design_review', 'routine-v2']]);
      const warnings = detectBindingDrift(pinned, current);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        code: 'BINDING_DRIFT',
        slotId: 'design_review',
        pinnedValue: 'routine-v1',
        currentValue: 'routine-v2',
      });
      // Verify formatting is separate from the domain data
      const msg = formatDriftWarning(warnings[0]!);
      expect(msg).toContain('design_review');
      expect(msg).toContain('routine-v1');
      expect(msg).toContain('routine-v2');
      expect(msg).toContain('Start a new session');
    });

    it('emits one warning per changed slot', () => {
      const pinned = { slot_a: 'old-a', slot_b: 'old-b', slot_c: 'same-c' };
      const current = new Map([
        ['slot_a', 'new-a'],
        ['slot_b', 'new-b'],
        ['slot_c', 'same-c'],
      ]);
      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(2);
      const slotIds = warnings.map(w => w.slotId);
      expect(slotIds).toContain('slot_a');
      expect(slotIds).toContain('slot_b');
      expect(slotIds).not.toContain('slot_c');
    });
  });

  describe('override removal drift', () => {
    it('emits BINDING_DRIFT when a project override is removed (currentValue → undefined)', () => {
      // Session was compiled with an explicit project override for design_review.
      // That override has since been deleted from .workrail/bindings.json.
      // The slot now falls back to its extensionPoint default — that is real drift.
      const pinned = { design_review: 'my-team-routine' };
      const current = new Map<string, string>(); // override removed

      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        code: 'BINDING_DRIFT',
        slotId: 'design_review',
        pinnedValue: 'my-team-routine',
        currentValue: 'default', // sentinel value for removed override
      });

      const msg = formatDriftWarning(warnings[0]!);
      expect(msg).toContain('removed');
      expect(msg).toContain('design_review');
      expect(msg).toContain('my-team-routine');
      expect(msg).toContain('Start a new session');
    });

    it('emits warnings for all removed overrides', () => {
      const pinned = { slot_a: 'override-a', slot_b: 'override-b' };
      const current = new Map<string, string>(); // both removed

      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(2);
      expect(warnings.every(w => w.currentValue === 'default')).toBe(true);
    });
  });

  describe('mixed scenarios', () => {
    it('reports changed override but not same-value override', () => {
      // pinnedOverrides only contains project-sourced slots.
      // slot_changed: override changed → drift
      // slot_same: override unchanged → no drift
      const pinned = {
        slot_changed: 'old-value',
        slot_same: 'same-value',
      };
      const current = new Map([
        ['slot_changed', 'new-value'],
        ['slot_same', 'same-value'],
      ]);
      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.slotId).toBe('slot_changed');
      expect(warnings[0]!.currentValue).toBe('new-value');
    });

    it('reports removed override and changed override in the same call', () => {
      const pinned = { slot_removed: 'was-override', slot_changed: 'old-value', slot_same: 'same-value' };
      const current = new Map([
        ['slot_changed', 'new-value'],
        ['slot_same', 'same-value'],
        // slot_removed: not present → override was deleted
      ]);
      const warnings = detectBindingDrift(pinned, current);
      expect(warnings).toHaveLength(2);
      const removed = warnings.find(w => w.slotId === 'slot_removed');
      const changed = warnings.find(w => w.slotId === 'slot_changed');
      expect(removed?.currentValue).toBe('default');
      expect(changed?.currentValue).toBe('new-value');
    });
  });
});
