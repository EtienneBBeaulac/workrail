/**
 * Routine Loader — Tests
 *
 * Tests loading routine definitions from disk with boundary validation.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { loadRoutineDefinitions } from '../../../src/application/services/compiler/routine-loader.js';

// Resolve the real routines directory
const ROUTINES_DIR = path.resolve(__dirname, '..', '..', '..', 'workflows', 'routines');

describe('loadRoutineDefinitions', () => {
  it('loads routines from the real workflows/routines/ directory', () => {
    const result = loadRoutineDefinitions(ROUTINES_DIR);
    expect(result.isOk()).toBe(true);

    const { routines } = result._unsafeUnwrap();
    expect(routines.size).toBeGreaterThan(0);

    // Verify a known routine is loaded
    expect(routines.has('routine-tension-driven-design')).toBe(true);
    const tdd = routines.get('routine-tension-driven-design')!;
    expect(tdd.name).toBe('Tension-Driven Design Generation');
    expect(tdd.steps.length).toBeGreaterThan(0);
  });

  it('returns empty result for nonexistent directory', () => {
    const result = loadRoutineDefinitions('/tmp/nonexistent-routines-dir-xyz');
    expect(result.isOk()).toBe(true);
    const { routines, warnings } = result._unsafeUnwrap();
    expect(routines.size).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it('loads all expected routines', () => {
    const result = loadRoutineDefinitions(ROUTINES_DIR);
    expect(result.isOk()).toBe(true);

    const { routines } = result._unsafeUnwrap();
    const expectedIds = [
      'routine-tension-driven-design',
      'routine-philosophy-alignment',
      'routine-context-gathering',
    ];
    for (const id of expectedIds) {
      expect(routines.has(id)).toBe(true);
    }
  });

  it('each loaded routine has required fields (boundary validation)', () => {
    const result = loadRoutineDefinitions(ROUTINES_DIR);
    expect(result.isOk()).toBe(true);

    const { routines } = result._unsafeUnwrap();
    for (const [id, def] of routines) {
      expect(def.id).toBe(id);
      expect(def.name).toBeTruthy();
      expect(def.steps.length).toBeGreaterThan(0);
      for (const step of def.steps) {
        expect(step.id).toBeTruthy();
        expect(step.title).toBeTruthy();
        expect(step.prompt).toBeTruthy();
      }
    }
  });

  it('produces no warnings for valid routine files', () => {
    const result = loadRoutineDefinitions(ROUTINES_DIR);
    expect(result.isOk()).toBe(true);
    const { warnings } = result._unsafeUnwrap();
    // All real routine files should pass boundary validation
    expect(warnings).toHaveLength(0);
  });
});
