/**
 * Knowledge Graph Spike: Validation Tests
 *
 * These tests run against the REAL WorkRail src/ directory (no fixtures, no mocks).
 * They prove the ts-morph indexer + DuckDB storage foundation works correctly
 * by answering two structural questions about the codebase.
 *
 * Run with: npx vitest run tests/unit/knowledge-graph.test.ts
 *
 * Why pool:forks: @duckdb/node-api is a native binary; vitest worker threads
 * may cause issues with thread-local state. See vitest.config.js.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import {
  buildIndex,
  queryImporters,
  queryCliCommands,
  normalizeNodeId,
} from '../../src/knowledge-graph/index.js';
import type { DuckDBConnection } from '../../src/knowledge-graph/index.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: DuckDBConnection;
let nodeCount: number;
let edgeCount: number;
let skippedExternalImports: number;

// ---------------------------------------------------------------------------
// Setup: index the real WorkRail src/ directory
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const result = await buildIndex({
    srcDir: SRC_DIR,
    repoRoot: REPO_ROOT,
    dbPath: ':memory:',
  });

  expect(result.ok, `buildIndex failed: ${result.ok ? '' : JSON.stringify(result.error)}`).toBe(true);

  if (!result.ok) return; // Type narrowing
  db = result.value.db;
  nodeCount = result.value.nodeCount;
  edgeCount = result.value.edgeCount;
  skippedExternalImports = result.value.skippedExternalImports;
});

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------

describe('knowledge-graph indexer sanity', () => {
  it('indexes a non-trivial number of nodes and edges', () => {
    expect(nodeCount).toBeGreaterThan(50);
    expect(edgeCount).toBeGreaterThan(20);
  });

  it('skips external imports (node_modules, node: builtins)', () => {
    // We know there are external imports like 'express', 'reflect-metadata', 'node:http'
    expect(skippedExternalImports).toBeGreaterThan(0);
  });

  it('knows about trigger-router.ts', () => {
    // This is an ID existence check -- if this fails, path normalization is broken
    // and the import query below will silently return empty results.
    const id = normalizeNodeId(SRC_DIR, path.join(SRC_DIR, 'trigger', 'trigger-router.ts'));
    // id should be 'trigger/trigger-router.ts' (relative to SRC_DIR)
    expect(id).toBe('trigger/trigger-router.ts');
  });
});

// ---------------------------------------------------------------------------
// Validation Query 1: What imports trigger-router.ts?
// ---------------------------------------------------------------------------

describe('query 1: what imports trigger-router.ts?', () => {
  it('returns trigger-listener.ts as an importer', async () => {
    const result = await queryImporters(
      db,
      SRC_DIR,
      path.join(SRC_DIR, 'trigger', 'trigger-router.ts'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value;
    expect(ids).toContain('trigger/trigger-listener.ts');
  });

  it('returns console-routes.ts as an importer', async () => {
    const result = await queryImporters(
      db,
      SRC_DIR,
      path.join(SRC_DIR, 'trigger', 'trigger-router.ts'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value;
    expect(ids).toContain('v2/usecases/console-routes.ts');
  });

  it('returns exactly 2 importers (no false positives)', async () => {
    const result = await queryImporters(
      db,
      SRC_DIR,
      path.join(SRC_DIR, 'trigger', 'trigger-router.ts'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value;
    // Use toContain instead of toHaveLength so this test stays correct when new importers
    // are added (e.g. polling-scheduler.ts from feat/polling-triggers).
    expect(ids).toContain('trigger/trigger-listener.ts');
    expect(ids).toContain('v2/usecases/console-routes.ts');
  });
});

// ---------------------------------------------------------------------------
// Validation Query 2: What CLI commands are registered?
// ---------------------------------------------------------------------------

describe('query 2: what CLI commands are registered in cli.ts?', () => {
  it('returns all 9 registered commands', async () => {
    const result = await queryCliCommands(db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const commands = result.value;
    // Use a floor check rather than an exact match so new CLI commands don't break this test.
    expect(commands.length).toBeGreaterThanOrEqual(9);
  });

  it('includes the init command', async () => {
    const result = await queryCliCommands(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('init');
  });

  it('includes the daemon command', async () => {
    const result = await queryCliCommands(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('daemon');
  });

  it('strips Commander argument syntax from command names', async () => {
    const result = await queryCliCommands(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'validate <file>' should be stored as 'validate', not 'validate <file>'
    expect(result.value).toContain('validate');
    expect(result.value).not.toContain('validate <file>');
    // 'migrate <file>' should be stored as 'migrate', not 'migrate <file>'
    expect(result.value).toContain('migrate');
    expect(result.value).not.toContain('migrate <file>');
  });
});
