/**
 * Unit tests for collect() from src/mcp/client-usage/index.ts.
 *
 * Tests the collection orchestration: reader enumeration, directory scanning,
 * file filtering, and result aggregation.
 * Uses mock readers to avoid I/O.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { collect } from '../../src/mcp/client-usage/index.js';
import type { ClientUsage, ClientUsageReader } from '../../src/mcp/client-usage/types.js';

// ── Mock reader helpers ────────────────────────────────────────────────────────

function makeFixedReader(
  name: string,
  dirs: string[],
  parseResult: ClientUsage | null,
): ClientUsageReader {
  return {
    clientName: name,
    searchDirs: () => dirs,
    parseUsage: async () => parseResult,
  };
}

function makeSelectiveReader(
  name: string,
  dirs: string[],
  // Map from filename to result
  results: Record<string, ClientUsage | null>,
): ClientUsageReader {
  return {
    clientName: name,
    searchDirs: () => dirs,
    parseUsage: async (filePath: string) => {
      const filename = path.basename(filePath);
      return results[filename] ?? null;
    },
  };
}

function makeFixedUsage(client: string): ClientUsage {
  return {
    client,
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteTokens: 300,
    turns: 5,
  };
}

// ── collect() ─────────────────────────────────────────────────────────────────

describe('collect()', () => {
  it('returns empty array when workspacePath is null', async () => {
    const reader = makeFixedReader('test', ['/any/dir'], makeFixedUsage('test'));
    const results = await collect('sess_test', null, 0, [reader]);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when workspacePath is empty string', async () => {
    const reader = makeFixedReader('test', ['/any/dir'], makeFixedUsage('test'));
    const results = await collect('sess_test', '', 0, [reader]);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no readers are registered', async () => {
    const results = await collect('sess_test', '/my/project', 0, []);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when reader searchDirs returns non-existent directory', async () => {
    const reader = makeFixedReader('test', ['/does/not/exist/xyz'], makeFixedUsage('test'));
    const results = await collect('sess_test', '/my/project', 0, [reader]);
    expect(results).toHaveLength(0);
  });

  it('collects results from a reader that matches files', async () => {
    // Create a temp directory with JSONL files
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-collect-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'conv1.jsonl'), 'dummy\n');
      await fs.writeFile(path.join(tmpDir, 'conv2.jsonl'), 'dummy\n');
      await fs.writeFile(path.join(tmpDir, 'not-a-jsonl.txt'), 'ignored\n');

      const usage = makeFixedUsage('test-client');
      const reader: ClientUsageReader = {
        clientName: 'test-client',
        searchDirs: () => [tmpDir],
        parseUsage: async (filePath: string) => {
          // Only match conv1.jsonl
          if (path.basename(filePath) === 'conv1.jsonl') return usage;
          return null;
        },
      };

      const results = await collect('sess_test', '/my/project', 0, [reader]);
      expect(results).toHaveLength(1);
      expect(results[0]).toBe(usage);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('aggregates results from multiple readers', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-collect-multi-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'file.jsonl'), 'dummy\n');

      const usageA = makeFixedUsage('client-a');
      const usageB = makeFixedUsage('client-b');
      const readerA = makeFixedReader('client-a', [tmpDir], usageA);
      const readerB = makeFixedReader('client-b', [tmpDir], usageB);

      const results = await collect('sess_test', '/my/project', 0, [readerA, readerB]);
      expect(results).toHaveLength(2);
      expect(results.map(r => r.client)).toContain('client-a');
      expect(results.map(r => r.client)).toContain('client-b');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips non-jsonl files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-collect-skip-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'ignored\n');
      await fs.writeFile(path.join(tmpDir, 'file.json'), 'ignored\n');
      await fs.writeFile(path.join(tmpDir, 'file.jsonl'), 'will-be-checked\n');

      const parsedFiles: string[] = [];
      const reader: ClientUsageReader = {
        clientName: 'test',
        searchDirs: () => [tmpDir],
        parseUsage: async (filePath: string) => {
          parsedFiles.push(path.basename(filePath));
          return null;
        },
      };

      await collect('sess_test', '/project', 0, [reader]);
      expect(parsedFiles).toHaveLength(1);
      expect(parsedFiles[0]).toBe('file.jsonl');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles reader parseUsage errors without throwing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-collect-err-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'file.jsonl'), 'dummy\n');

      const reader: ClientUsageReader = {
        clientName: 'broken',
        searchDirs: () => [tmpDir],
        parseUsage: async () => {
          throw new Error('simulated reader error');
        },
      };

      // Should not throw
      const results = await collect('sess_test', '/project', 0, [reader]);
      expect(results).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses default USAGE_READERS registry when no readers are passed', async () => {
    // Should not throw and should return an array (empty in test env)
    const results = await collect('sess_nonexistent', '/some/workspace', 0);
    expect(Array.isArray(results)).toBe(true);
  });
});
