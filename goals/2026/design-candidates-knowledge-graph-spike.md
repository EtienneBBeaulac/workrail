# Design Candidates: WorkRail Knowledge Graph Spike

**Date:** 2026-04-15
**Task:** Structural layer of WorkRail knowledge graph spike -- ts-morph indexer + DuckDB storage + two validation queries

---

## Problem Understanding

### Core Tensions

1. **Path identity vs. resolution**: ts-morph resolves import paths to absolute filesystem paths. The validation queries use relative paths (e.g. `src/trigger/trigger-router.ts`). Edge IDs must use a consistent normalization scheme or query 1 silently fails.

2. **DuckDB async complexity vs. spike simplicity**: @duckdb/node-api (v1.5.2) has an async-first API with `DuckDBInstance.create()` and prepared statements. Misuse causes runtime errors. The backlog explicitly requires DuckDB for future recursive CTE support -- skipping it means the spike validates nothing about the chosen technology.

3. **Type safety vs. DuckDB dynamic rows**: DuckDB returns `Record<string, unknown>` rows. The repo philosophy demands typed domain objects. Query functions must cast/validate at the boundary.

4. **Spike scope discipline**: The backlog explicitly marks MCP tool integration, provenance table, vector layer, and incremental indexing as post-spike. Including any of these touches existing files and increases review risk.

### What Makes This Hard

- `.js` vs `.ts` extension mismatch: imports in this repo use `.js` suffixes on `.ts` files. ts-morph resolves `.js` imports to actual `.ts` files via the TypeScript Compiler API. The stored edge ID must be the `.ts` path, not `.js`, or the query never matches.
- `program.command('...')` extraction: Commander chains calls, so some command registrations are method calls on the result of a previous `program.command()` call. The extractor must match any CallExpression whose callee's property name is `command` with a string literal argument -- not just direct `program.command()` calls.
- DuckDB in vitest workers: DuckDB may have thread-local limitations. If tests fail in worker threads, configure vitest's `singleFork` option for that file.

### Likely Seam

Entirely new `src/knowledge-graph/` subtree. Nothing in existing src/ is modified. The public surface is `buildIndex(srcDir, dbPath)` returning `{ db, nodeCount, edgeCount }`.

---

## Philosophy Constraints

From CLAUDE.md (authoritative):
- **Determinism over cleverness**: same src/ = same graph output, always
- **Immutability by default**: `Node` and `Edge` types are `readonly` interfaces
- **Errors are data**: query functions return `Result<T, E>` using local `src/runtime/result.js` pattern (not throwing)
- **Explicit domain types over primitives**: `NodeId` is a branded string type, not `string`
- **Validate at boundaries**: path normalization happens once at ingestion; SQL query inputs are normalized before execution
- **YAGNI with discipline**: design clear seams but don't implement post-spike features

**Repo pattern observed**: The codebase uses a local `Result<T, E>` type (src/runtime/result.js `ok`/`err`), not neverthrow directly (even though neverthrow is a dependency). Follow the local pattern.

**Conflicts**: tsconfig says `module:commonjs` but all src/ imports use `.js` suffixes (ESM-style). Follow the existing convention -- `.js` in import paths.

---

## Impact Surface

- No existing files are modified by this spike
- Tests added to `tests/unit/knowledge-graph.test.ts` (new file)
- `package.json` gains one new dependency: `@duckdb/node-api`
- The public API surface (`src/knowledge-graph/index.ts`) is what post-spike work (MCP tool, incremental indexing) will import from

---

## Candidates

### Candidate A: In-memory Map store (no DuckDB)

**Summary**: Use `Map<NodeId, Node>` and `Edge[]` arrays; query functions are array filters. No external binary dependency.

**Tensions resolved**: DuckDB async complexity (avoided). Type safety (native TypeScript).
**Tensions accepted**: DuckDB validation (bypassed entirely -- the spike doesn't test the technology it's supposed to validate).

**Boundary**: src/knowledge-graph/ with types.ts, indexer.ts, store.ts (Map-based), queries.ts.

**Why this boundary is wrong**: The spike's explicit purpose (backlog line 1479) is to validate ts-morph + DuckDB together. A Map-based store answers the indexer question but leaves DuckDB completely unvalidated.

**Failure mode**: Passes all tests today; breaks the moment DuckDB is integrated post-spike because the integration assumptions were never tested.

**Repo pattern**: Follows small-pure-functions pattern. **Departs from** the stated technology spec.

**Gains**: Zero install risk. Tests run anywhere. **Gives up**: The whole point of the spike.

**Scope judgment**: Too narrow.

**Philosophy**: Honors YAGNI in the immediate. Conflicts with determinism (Maps are unordered; results depend on insertion order in edge cases).

---

### Candidate B: DuckDB in-memory + ts-morph (RECOMMENDED)

**Summary**: Install `@duckdb/node-api`, create in-memory DuckDB connection (`':memory:'`), define `nodes` and `edges` tables, populate via ts-morph Project walk, query via SQL.

**Schema** (from backlog):
```sql
CREATE TABLE nodes (
  id    TEXT PRIMARY KEY,
  file  TEXT NOT NULL,
  name  TEXT NOT NULL,
  kind  TEXT NOT NULL,  -- 'file' | 'cli_command' | 'export' | 'symbol'
  scope TEXT            -- null for file nodes
);
CREATE TABLE edges (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL,  -- 'import' | 'export' | 'call'
  line    INTEGER
);
```

**Path normalization invariant** (critical):
```
nodeId = path.relative(srcDir, absolutePath).replace(/\.js$/, '.ts')
```
All slashes forward. Applied once at ingestion. Query inputs normalized identically before SQL execution.

**Import extraction**: For each `ImportDeclaration`, call `getModuleSpecifierSourceFile()` -- this resolves `.js` imports to real `.ts` files. If null (external/unresolvable), skip. Emit `{ from_id: thisFileId, to_id: resolvedFileId, kind: 'import', line }`.

**CLI command extraction**: Walk all `CallExpression` nodes in `cli.ts` only. Match where callee is a `PropertyAccessExpression` with name `'command'` and first argument is a `StringLiteral`. Emit `{ id: 'cli:' + commandName, file: 'cli.ts', name: commandName, kind: 'cli_command', scope: null }`.

**Tensions resolved**: Path identity (strict single normalization point). DuckDB validation (uses the real technology). Type safety (typed row interfaces with cast at query boundary).
**Tensions accepted**: DuckDB async API complexity (managed with async/await, documented in comments).

**Boundary**: src/knowledge-graph/ -- 5 files, public API only via index.ts.

**Failure mode**: @duckdb/node-api native binary incompatible with vitest worker threads. Mitigation: add `{ pool: 'forks', singleFork: true }` to vitest config for this test, or run as an integration test.

**Repo pattern**: Follows new-capability-in-src-subdomain pattern. Uses local Result type from src/runtime/result.js. Follows .js import suffix convention.

**Gains**: Validates the actual technology. Recursive CTEs available for post-spike reachability queries. Embedded -- no server process.
**Gives up**: Some test environment complexity (native binary in worker thread).

**Scope judgment**: Best-fit. Exactly the scope the backlog defines.

**Philosophy**: Honors determinism, explicit domain types, validate at boundaries, errors as data, YAGNI with discipline.

---

### Candidate C: DuckDB file-based + MCP tool stub

**Summary**: Same DuckDB approach but persists to `~/.workrail/knowledge-graph.db` and adds a stub `query_knowledge_graph(query: string)` MCP tool wired into `src/mcp/tools.ts`.

**Tensions resolved**: Persistence story, MCP integration story.
**Tensions accepted**: Scope -- touches existing files (src/mcp/tools.ts, src/di/container.ts).

**Boundary**: Too broad -- crosses into existing module territory.

**Failure mode**: MCP wiring regressions in existing tools. Test surface expands significantly.

**Repo pattern**: Follows patterns but adds unnecessary scope for a spike.

**Scope judgment**: Too broad. Backlog explicitly marks MCP tool as post-spike.

**Philosophy**: Conflicts with YAGNI. Adds speculative integration that isn't needed to answer the spike's questions.

---

## Comparison and Recommendation

All three candidates share the same hard core: ts-morph path normalization. The only real question is whether to include DuckDB (A vs B) and whether to include MCP wiring (B vs C).

**Recommended: Candidate B.**

The spike's purpose is to validate that ts-morph + DuckDB can answer structural questions about the codebase. Candidate A validates only half of that. Candidate C overshoots scope. Candidate B is the correct fit.

---

## Self-Critique

**Strongest argument against B**: @duckdb/node-api may not be compatible with vitest worker threads (DuckDB uses thread-local state). This would require test infrastructure changes.

**Narrower option that almost worked**: Candidate A is tempting because it's simpler and the validation queries work just as well with a Map. It loses only because it doesn't validate DuckDB -- which is the explicit stated purpose.

**Broader option conditions**: Candidate C would be justified if the sprint goal included shipping a working MCP tool to users. The backlog says explicitly it doesn't.

**Assumption that would invalidate B**: If @duckdb/node-api install fails due to pre-built binary unavailability for the current Node version. Pivot: use `better-sqlite3` as a structural-equivalent substitute (embedded SQL, similar API, no native compilation required beyond what's standard). The schema and queries would be identical.

---

## Open Questions for the Main Agent

1. Should `buildIndex()` return the DuckDB connection object directly, or should queries be encapsulated inside the `buildIndex()` return value as a `{ query: (sql) => ... }` interface? (Leaning toward: return the connection -- it's a spike, YAGNI.)
2. Should the test use `:memory:` or a temp file path? (`:memory:` is simpler and avoids cleanup -- use it.)
3. Should `NodeId` be a branded type `string & { readonly __brand: 'NodeId' }` or a plain `string`? (Leaning toward branded type -- explicit domain types over primitives is a hard rule in CLAUDE.md.)
4. If @duckdb/node-api fails in vitest workers, should we configure `singleFork` globally or only for the knowledge-graph test? (Only for that test -- don't slow down the whole suite.)
