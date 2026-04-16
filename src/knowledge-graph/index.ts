/**
 * Knowledge Graph: Public API
 *
 * This is the only file that should be imported from outside src/knowledge-graph/.
 * Internal modules (db.ts, indexer.ts, queries.ts, types.ts) are implementation details.
 */

import * as path from 'path';
import { createDb } from './db.js';
import { runIndexer } from './indexer.js';
import type { IndexResult, IndexError } from './types.js';

export type { NodeId, NodeKind, EdgeKind, IndexResult, IndexError, QueryError } from './types.js';
export { normalizeNodeId } from './types.js';
export { queryImporters, queryCliCommands } from './queries.js';
export type { QueryResult } from './queries.js';
export type { DuckDBConnection } from './db.js';

export type BuildIndexOptions = {
  /** Absolute path to the TypeScript source directory to index */
  readonly srcDir: string;
  /** Absolute path to the repo root (must contain tsconfig.json) */
  readonly repoRoot: string;
  /**
   * DuckDB database path. Pass ':memory:' for an in-process ephemeral database
   * or an absolute file path for a persistent one.
   */
  readonly dbPath: string;
};

export type BuildIndexResult =
  | { readonly ok: true; readonly value: IndexResult & { readonly db: import('./db.js').DuckDBConnection } }
  | { readonly ok: false; readonly error: IndexError };

/**
 * Index all TypeScript source files under opts.srcDir into a DuckDB database.
 *
 * Returns a Result containing the DuckDB connection (for querying) and
 * summary statistics. The caller owns the connection lifetime.
 *
 * @example
 * const result = await buildIndex({ srcDir: '/project/src', repoRoot: '/project', dbPath: ':memory:' });
 * if (!result.ok) throw new Error(result.error.message);
 * const { db, nodeCount, edgeCount } = result.value;
 */
export async function buildIndex(opts: BuildIndexOptions): Promise<BuildIndexResult> {
  const { srcDir, repoRoot, dbPath } = opts;

  let db: import('./db.js').DuckDBConnection;
  try {
    db = await createDb(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'db_error', message } };
  }

  const cliFile = path.join(srcDir, 'cli.ts');
  const indexerResult = await runIndexer(srcDir, repoRoot, cliFile, db);

  if (!indexerResult.ok) {
    return { ok: false, error: indexerResult.error };
  }

  return {
    ok: true,
    value: { db, ...indexerResult.value },
  };
}
