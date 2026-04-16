/**
 * Knowledge Graph: DuckDB Setup
 *
 * Why DuckDB: embedded SQL with recursive CTE support for reachability queries.
 * No server process. Pre-built binaries for all major platforms.
 *
 * Why in-memory by default: the spike validates the technology; persistence
 * is post-spike. The dbPath parameter is exposed so callers can opt into a
 * file-based DB without an API change.
 *
 * Why named params ($param): @duckdb/node-api requires values as an object
 * with named keys; positional ? placeholders are not supported.
 */

import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

export { DuckDBConnection };

const CREATE_NODES_TABLE = `
  CREATE TABLE IF NOT EXISTS nodes (
    id    TEXT PRIMARY KEY,
    file  TEXT NOT NULL,
    name  TEXT NOT NULL,
    kind  TEXT NOT NULL,
    scope TEXT
  )
`;

const CREATE_EDGES_TABLE = `
  CREATE TABLE IF NOT EXISTS edges (
    from_id TEXT NOT NULL,
    to_id   TEXT NOT NULL,
    kind    TEXT NOT NULL,
    line    INTEGER
  )
`;

/**
 * Create (or open) a DuckDB database at dbPath and initialize the schema.
 * Pass ':memory:' for an in-memory database.
 */
export async function createDb(dbPath: string): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(CREATE_NODES_TABLE);
  await connection.run(CREATE_EDGES_TABLE);
  return connection;
}

/**
 * Insert a single node row. Skips silently if the ID already exists
 * (INSERT OR IGNORE is DuckDB's equivalent of upsert-if-absent).
 */
export async function insertNode(
  connection: DuckDBConnection,
  id: string,
  file: string,
  name: string,
  kind: string,
  scope: string | null,
): Promise<void> {
  await connection.run(
    `INSERT OR IGNORE INTO nodes (id, file, name, kind, scope) VALUES ($id, $file, $name, $kind, $scope)`,
    { id, file, name, kind, scope: scope ?? null },
  );
}

/**
 * Insert a single edge row.
 */
export async function insertEdge(
  connection: DuckDBConnection,
  fromId: string,
  toId: string,
  kind: string,
  line: number | null,
): Promise<void> {
  await connection.run(
    `INSERT INTO edges (from_id, to_id, kind, line) VALUES ($from_id, $to_id, $kind, $line)`,
    { from_id: fromId, to_id: toId, kind, line: line ?? null },
  );
}
