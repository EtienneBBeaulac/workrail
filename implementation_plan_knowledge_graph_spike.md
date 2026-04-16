# Implementation Plan: Knowledge Graph Spike (ts-morph + DuckDB)

Generated 2026-04-15.

---

## 1. Problem Statement

WorkRail needs a persistent, queryable structural code graph to support context-gathering agents. The first spike validates the two core technologies (ts-morph + DuckDB) by building a minimal indexer that correctly answers two structural questions about the WorkRail codebase itself.

---

## 2. Acceptance Criteria

1. Running the test suite with `npx vitest run tests/unit/knowledge-graph.test.ts` completes without errors.
2. Query: "what files import src/trigger/trigger-router.ts?" returns a result that includes both:
   - `trigger/trigger-listener.ts`
   - `v2/usecases/console-routes.ts`
3. Query: "what CLI commands are registered in src/cli.ts?" returns a result that includes all 9 commands:
   - init, sources, list, validate, migrate, start, cleanup, daemon, version
4. The test uses the real WorkRail `src/` directory (no fixtures, no mocks).
5. `buildIndex()` returns a `Result` type (no unhandled promise rejections).
6. `@duckdb/node-api` is added to `package.json` dependencies.

---

## 3. Non-Goals

- Vector/semantic layer (LanceDB, embeddings) -- post-spike
- Incremental re-indexing -- post-spike
- Provenance table -- post-spike
- MCP tool `query_knowledge_graph` integration -- post-spike
- DI container registration -- spike only
- Call-edge extraction (function calls between files) -- post-spike
- Export-edge extraction -- post-spike
- Persistent database file (`:memory:` is sufficient for the spike)

---

## 4. Philosophy-Driven Constraints

From CLAUDE.md:
- **Errors as data**: `buildIndex()` returns `Promise<Result<IndexResult, IndexError>>`. No throwing.
- **Immutability by default**: `Node` and `Edge` are `readonly` interfaces.
- **Explicit domain types**: `NodeId` is a branded string (`string & { readonly __brand: 'NodeId' }`). `NodeKind` and `EdgeKind` are discriminated union types.
- **Validate at boundaries**: `normalizeNodeId()` is the single path normalization function, used at both ingestion and query time.
- **Determinism**: same `srcDir` always produces the same graph.
- **YAGNI with discipline**: no features beyond the two validation queries.

---

## 5. Invariants

1. **Path identity invariant**: All node IDs are `path.relative(srcDir, absoluteFilePath).replace(/\.js$/, '.ts')` with forward slashes. Applied once at ingestion; query inputs normalized identically before SQL.
2. **External import skip invariant**: If `getModuleSpecifierSourceFile()` returns `null`, the import is skipped (external dependency). No error.
3. **CLI scope invariant**: CLI command extraction runs only on the `cli.ts` source file, not all source files.
4. **Command name normalization invariant**: CLI command names are `rawName.split(' ')[0]` (strips Commander argument syntax like `<file>`).
5. **tsconfig invariant**: ts-morph Project is instantiated with `tsConfigFilePath: path.join(repoRoot, 'tsconfig.json')` and `skipAddingFilesFromTsConfig: true`.

---

## 6. Selected Approach + Rationale

**Candidate B: DuckDB in-memory + ts-morph, 5-file module**

Rationale: The spike's stated purpose is to validate ts-morph + DuckDB together. Candidate A (Map-based) validates only ts-morph. Candidate C (DuckDB file + MCP stub) overshoots scope by touching existing files.

**Runner-up: Candidate A (Map-based)**. Loses only because it does not validate DuckDB, which is the explicit purpose of the spike.

**Pivot trigger**: If `@duckdb/node-api` fails to install or run, switch to `better-sqlite3` (identical schema, synchronous API). The module structure and invariants are unchanged.

---

## 7. Vertical Slices

### Slice 1: Package and module scaffold
- Install `@duckdb/node-api` (production dependency)
- Create `src/knowledge-graph/` directory with 5 empty files: `types.ts`, `db.ts`, `indexer.ts`, `queries.ts`, `index.ts`
- **Done when**: `npm install` succeeds; files exist; TypeScript compiles

### Slice 2: Domain types
- Define `NodeId` branded type
- Define `NodeKind` union: `'file' | 'cli_command'`
- Define `EdgeKind` union: `'import'`
- Define `Node` readonly interface: `{ id: NodeId, file: string, name: string, kind: NodeKind, scope: string | null }`
- Define `Edge` readonly interface: `{ from_id: NodeId, to_id: NodeId, kind: EdgeKind, line: number | null }`
- Define `IndexResult`: `{ db: DuckDBConnection, nodeCount: number, edgeCount: number, skippedExternalImports: number }`
- Define `IndexError` union
- Export `normalizeNodeId(srcDir: string, absolutePath: string): NodeId`
- **Done when**: types.ts compiles with strict TypeScript

### Slice 3: DuckDB schema setup
- Implement `createDb(dbPath: string): Promise<DuckDBConnection>`
- Create `nodes` table: `id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT`
- Create `edges` table: `from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER`
- Wrap in `Result<DuckDBConnection, IndexError>`
- **Done when**: createDb(':memory:') resolves without error; tables are created

### Slice 4: ts-morph indexer
- Implement `runIndexer(srcDir: string, cliFile: string, db: DuckDBConnection): Promise<Result<{ nodeCount, edgeCount, skippedExternalImports }, IndexError>>`
- Create ts-morph Project with `{ tsConfigFilePath, skipAddingFilesFromTsConfig: true }`
- `addSourceFilesAtPaths(srcDir + '/**/*.ts')`
- Walk all source files: emit one `file` node per file
- Walk all ImportDeclarations: for each, call `getModuleSpecifierSourceFile()`; if not null, emit `import` edge; if null, increment `skippedExternalImports`
- Walk cli.ts only: find CallExpressions where callee is PropertyAccessExpression with name `'command'` and first arg is StringLiteral; emit `cli_command` node with `name = split(' ')[0]`
- Use batched INSERT statements
- **Done when**: Running indexer against src/ produces nodeCount > 0, edgeCount > 0, and query "SELECT id FROM nodes WHERE kind = 'cli_command'" returns 9 rows

### Slice 5: Query functions
- Implement `queryImporters(db: DuckDBConnection, targetId: NodeId): Promise<Result<NodeId[], QueryError>>`
  - SQL: `SELECT DISTINCT from_id FROM edges WHERE to_id = ? AND kind = 'import'`
- Implement `queryCliCommands(db: DuckDBConnection): Promise<Result<string[], QueryError>>`
  - SQL: `SELECT name FROM nodes WHERE kind = 'cli_command' ORDER BY name`
- Cast DuckDB rows to typed values at boundary
- **Done when**: Both functions return correct results against a populated in-memory DB

### Slice 6: Public index.ts API
- Re-export `buildIndex(opts: { srcDir: string; repoRoot: string; dbPath: string }): Promise<Result<IndexResult, IndexError>>`
- Re-export `queryImporters`, `queryCliCommands`
- Re-export `normalizeNodeId`, `NodeId`, `NodeKind`, `EdgeKind`
- **Done when**: Single import from `src/knowledge-graph/index.ts` provides everything needed for the test

### Slice 7: Test + vitest config
- Add vitest project entry for `tests/unit/knowledge-graph.test.ts` with `pool: 'forks'` and `singleFork: true`
- Write `tests/unit/knowledge-graph.test.ts`:
  - `beforeAll`: call `buildIndex({ srcDir: 'src/', repoRoot: '.', dbPath: ':memory:' })` with real path resolution; assert Result is Ok
  - Sanity test: assert `nodeCount > 0` and `edgeCount > 0` and `skippedExternalImports > 0`
  - Sanity test: assert node `normalizeNodeId(srcDir, absPath('src/trigger/trigger-router.ts'))` exists in nodes table
  - Test 1: `queryImporters(db, triggerRouterId)` result includes `trigger/trigger-listener.ts` and `v2/usecases/console-routes.ts`
  - Test 2: `queryCliCommands(db)` result includes all 9 commands: init, sources, list, validate, migrate, start, cleanup, daemon, version
- **Done when**: All assertions pass; `npx vitest run tests/unit/knowledge-graph.test.ts` exits 0

---

## 8. Test Design

**Location**: `tests/unit/knowledge-graph.test.ts`

**Approach**: Real src/ directory, no mocks. This is an integration-style test that runs against the actual WorkRail codebase. It is placed in `tests/unit/` because it uses no network or external processes (DuckDB is in-process).

**vitest config**: Third project entry with `pool: 'forks'` to avoid DuckDB native binary + worker thread conflicts.

**Test structure**:
```
describe('knowledge-graph indexer', () => {
  let db: DuckDBConnection;

  beforeAll(async () => {
    const result = await buildIndex({ srcDir, repoRoot, dbPath: ':memory:' });
    expect(result.isOk()).toBe(true);
    db = result.value.db;
  });

  it('indexes nodes and edges', () => {
    expect(result.value.nodeCount).toBeGreaterThan(0);
    expect(result.value.edgeCount).toBeGreaterThan(0);
  });

  it('query 1: what imports trigger-router.ts?', async () => {
    const r = await queryImporters(db, triggerRouterNodeId);
    expect(r.isOk()).toBe(true);
    expect(r.value).toContain('trigger/trigger-listener.ts');
    expect(r.value).toContain('v2/usecases/console-routes.ts');
  });

  it('query 2: what CLI commands are registered?', async () => {
    const r = await queryCliCommands(db);
    expect(r.isOk()).toBe(true);
    expect(r.value).toContain('init');
    expect(r.value).toContain('daemon');
    // ... all 9
  });
});
```

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| @duckdb/node-api install fails | Low | High | Switch to better-sqlite3; schema/queries identical |
| DuckDB + vitest forks pool incompatible | Low | Medium | Mark as integration test, run separately |
| ts-morph getModuleSpecifierSourceFile() returns null for internal imports | Low | High | Explicit tsconfig path (R1); assert skipped > 0 |
| Path normalization mismatch | Low | High | Single normalizeNodeId() function; ID existence assertion in test |
| CLI command extraction false positives | Very Low | Low | Scope to cli.ts only; no other file has .command(string) |

---

## 10. PR Packaging Strategy

- **Branch**: `feat/knowledge-graph-spike`
- **Single PR** against `main`
- PR contains: package.json change, src/knowledge-graph/ (5 files), tests/unit/knowledge-graph.test.ts, vitest.config.js update
- Nothing in existing src/ is modified

---

## 11. Philosophy Alignment Per Slice

| Slice | Principle | Status |
|---|---|---|
| S2 (types) | Explicit domain types | Satisfied -- branded NodeId, union NodeKind/EdgeKind |
| S2 (types) | Immutability by default | Satisfied -- all interfaces are readonly |
| S3 (db) | Errors as data | Satisfied -- Result<DuckDBConnection, IndexError> |
| S4 (indexer) | Determinism | Satisfied -- ts-morph is deterministic |
| S4 (indexer) | Validate at boundaries | Satisfied -- normalizeNodeId() applied once at ingestion |
| S5 (queries) | Type safety as first line | Tension -- DuckDB rows are unknown; explicit cast at boundary |
| S5 (queries) | Errors as data | Satisfied -- Result<T, QueryError> |
| S6 (index.ts) | YAGNI with discipline | Satisfied -- only two query functions exported |
| S7 (tests) | Determinism | Satisfied -- tests against real src/ are reproducible |

---

## 12. Estimated PR Count: 1

## 13. Follow-up Tickets
- Post-spike: vector layer (LanceDB + local embeddings)
- Post-spike: incremental re-indexing on session handoff
- Post-spike: provenance table
- Post-spike: MCP tool `query_knowledge_graph`
- Post-spike: typed QueryRunner abstraction (fix illegal-state gap for closed DB)
- Post-spike: call-edge extraction (function calls between files)

## 14. Plan Confidence: High
- unresolvedUnknownCount: 1 (DuckDB + vitest forks pool -- untested but standard mitigation)
- planConfidenceBand: High
