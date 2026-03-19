/**
 * Tests for loadProjectBindings (binding-registry.ts)
 *
 * Verifies loading behavior for all code paths:
 * - File not found → empty map (silent)
 * - Unparseable JSON → empty map (warn)
 * - Non-object JSON → empty map (warn)
 * - Per-workflow format: { "workflowId": { "slotId": "routineId" } }
 * - Flat format: { "slotId": "routineId" }
 * - Mixed/unexpected structure → empty map
 *
 * Uses the optional `baseDir` parameter to point loadProjectBindings at a
 * temp directory without changing process.cwd() (unsupported in workers).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadProjectBindings } from '../../../src/application/services/compiler/binding-registry.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Setup: create a temp directory per test
// ---------------------------------------------------------------------------

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wr-binding-registry-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function writeBindings(content: string): void {
  const dir = join(baseDir, '.workrail');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bindings.json'), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

describe('loadProjectBindings — missing file', () => {
  it('returns empty map when .workrail/bindings.json does not exist', () => {
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Parse errors
// ---------------------------------------------------------------------------

describe('loadProjectBindings — parse errors', () => {
  it('returns empty map and warns when file is not valid JSON', () => {
    writeBindings('{ not valid json }');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    warnSpy.mockRestore();
  });

  it('returns empty map and warns when file is a JSON array', () => {
    writeBindings('["not", "an", "object"]');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('must be a JSON object'));
    warnSpy.mockRestore();
  });

  it('returns empty map when file is a JSON string', () => {
    writeBindings('"just a string"');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.size).toBe(0);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Per-workflow format
// ---------------------------------------------------------------------------

describe('loadProjectBindings — per-workflow format', () => {
  it('returns bindings for the specified workflow ID', () => {
    writeBindings(JSON.stringify({
      'my-workflow': { design_review: 'team-design-review', final_check: 'team-final-check' },
      'other-workflow': { design_review: 'other-routine' },
    }));

    const result = loadProjectBindings('my-workflow', baseDir);
    expect(result.get('design_review')).toBe('team-design-review');
    expect(result.get('final_check')).toBe('team-final-check');
    expect(result.size).toBe(2);
  });

  it('does not leak entries from other workflow sections', () => {
    writeBindings(JSON.stringify({
      'my-workflow': { slot_a: 'routine-a' },
      'other-workflow': { slot_b: 'routine-b' },
    }));
    const result = loadProjectBindings('my-workflow', baseDir);
    expect(result.has('slot_b')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('returns empty map when the workflow ID has no matching section', () => {
    writeBindings(JSON.stringify({ 'other-workflow': { design_review: 'routine' } }));
    const result = loadProjectBindings('my-workflow', baseDir);
    expect(result.size).toBe(0);
  });

  it('skips non-string values within a per-workflow section and warns', () => {
    writeBindings(JSON.stringify({
      'my-workflow': { valid_slot: 'my-routine', bad_slot: 42 },
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadProjectBindings('my-workflow', baseDir);
    expect(result.get('valid_slot')).toBe('my-routine');
    expect(result.has('bad_slot')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bad_slot'));
    warnSpy.mockRestore();
  });

  it('warns and returns empty map when the per-workflow value is not an object', () => {
    writeBindings(JSON.stringify({ 'my-workflow': 'not-an-object' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadProjectBindings('my-workflow', baseDir);
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Flat format (workflow-agnostic)
// ---------------------------------------------------------------------------

describe('loadProjectBindings — flat format', () => {
  it('returns all flat entries when every top-level value is a string', () => {
    writeBindings(JSON.stringify({
      design_review: 'my-design-review',
      final_check: 'my-final-check',
    }));

    // workflowId has no matching key → falls back to flat format
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.get('design_review')).toBe('my-design-review');
    expect(result.get('final_check')).toBe('my-final-check');
    expect(result.size).toBe(2);
  });

  it('returns empty map when top-level has mixed values (not all strings)', () => {
    // Contains both object and string values → ambiguous, not treated as flat
    writeBindings(JSON.stringify({
      some_workflow: { slot: 'routine' },
      stray: 'value',
    }));

    const result = loadProjectBindings('unrelated-workflow', baseDir);
    expect(result.size).toBe(0);
  });

  it('returns empty map when file is valid JSON object but empty', () => {
    writeBindings('{}');
    const result = loadProjectBindings('any-workflow', baseDir);
    expect(result.size).toBe(0);
  });
});
