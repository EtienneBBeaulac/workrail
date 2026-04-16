/**
 * Knowledge Graph: Query Functions
 *
 * These are the two validation queries that prove the spike works.
 * They are also the public API surface that post-spike work will extend.
 *
 * Why Result<T, QueryError>: DuckDB queries can fail (closed connection,
 * malformed SQL). Return errors as values per CLAUDE.md "errors are data".
 *
 * Why explicit cast at boundary: DuckDB returns row objects as unknown.
 * The cast is isolated here -- callers receive typed values.
 */

import type { DuckDBConnection } from './db.js';
import type { NodeId, QueryError } from './types.js';
import { normalizeNodeId } from './types.js';

export type QueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: QueryError };

/**
 * Return all node IDs that import the target file.
 *
 * @param connection   DuckDB connection
 * @param srcDir       Absolute path to the source directory (for normalizing targetPath)
 * @param targetAbsPath Absolute path of the target file to find importers of
 */
export async function queryImporters(
  connection: DuckDBConnection,
  srcDir: string,
  targetAbsPath: string,
): Promise<QueryResult<NodeId[]>> {
  try {
    const targetId = normalizeNodeId(srcDir, targetAbsPath);

    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT from_id FROM edges WHERE to_id = $to_id AND kind = 'import'`,
      { to_id: targetId },
    );

    const rows = reader.getRowObjects() as Array<{ from_id: string }>;
    return { ok: true, value: rows.map((r) => r.from_id as NodeId) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'db_error', message } };
  }
}

/**
 * Return all registered CLI command names (sorted alphabetically).
 */
export async function queryCliCommands(
  connection: DuckDBConnection,
): Promise<QueryResult<string[]>> {
  try {
    const reader = await connection.runAndReadAll(
      `SELECT name FROM nodes WHERE kind = 'cli_command' ORDER BY name`,
    );

    const rows = reader.getRowObjects() as Array<{ name: string }>;
    return { ok: true, value: rows.map((r) => r.name) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'db_error', message } };
  }
}
