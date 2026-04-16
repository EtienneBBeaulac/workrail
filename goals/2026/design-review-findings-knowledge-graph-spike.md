# Design Review Findings: WorkRail Knowledge Graph Spike

**Date:** 2026-04-15
**Design:** Candidate B -- DuckDB in-memory + ts-morph, 5-file module in src/knowledge-graph/

---

## Tradeoff Review

| Tradeoff | Status | Notes |
|---|---|---|
| DuckDB async API complexity | Accepted | Mitigated by forks pool in vitest; Promise-based API wrappable in Result |
| Broad .command() AST pattern | Accepted | Verified: only cli.ts has .command(string) calls in src/. Scope extractor to cli.ts only. |
| :memory: database (no persistence) | Accepted | dbPath parameter keeps API forward-compatible |
| .getModuleSpecifierSourceFile() nulls | Accepted | Skip externals + pass explicit tsconfig path; return skipped count for debug |

---

## Failure Mode Review

| Failure Mode | Severity | Mitigation | Status |
|---|---|---|---|
| DuckDB + vitest worker threads | Medium | Use pool:'forks' for knowledge-graph test | Handled |
| getModuleSpecifierSourceFile() returns null for all imports | Medium | Explicit tsconfig path; assert skippedExternalImports > 0 and edgeCount > 0 | Handled |
| Path normalization mismatch (silent empty results) | **HIGH** | Single normalizeNodeId() function used everywhere; test asserts known node ID exists before running validation queries | Handled |
| CLI command extractor picks up argument syntax ('validate \<file\>') | Low | Store first word only (split on space) | Handled |

---

## Runner-Up / Simpler Alternative Review

- Candidate A (Map-based) has nothing worth borrowing. DuckDB is required to validate the technology.
- No simpler version satisfies the spike's acceptance criteria (validate DuckDB works).
- Hybrid refinements adopted: return `skippedExternalImports` count from `buildIndex()`, add explicit node-ID existence assertion in tests.

---

## Philosophy Alignment

| Principle | Status | Notes |
|---|---|---|
| Determinism | Satisfied | ts-morph is deterministic over same input files |
| Immutability by default | Satisfied | Node/Edge are readonly interfaces |
| Explicit domain types | Satisfied | NodeId branded, NodeKind/EdgeKind union types |
| Validate at boundaries | Satisfied | normalizeNodeId() is single entry point |
| Errors as data | Under tension | DuckDB rejections must be wrapped in Result<T,E> |
| Make illegal states unrepresentable | Gap (acceptable) | No TypeScript way to prevent querying a closed DB; document for post-spike fix |
| Type safety | Under tension | DuckDB rows are unknown; explicit cast required at boundary |

---

## Findings

### Red (Must Fix)
- **R1: tsconfig path must be explicit.** If the ts-morph Project is instantiated without `tsConfigFilePath`, it may fail to resolve .js imports to .ts files, causing all import edges to be dropped. `buildIndex()` must accept or derive the repo root and pass `tsConfigFilePath: path.join(repoRoot, 'tsconfig.json')` to the Project constructor.

### Orange (Should Fix)
- **O1: Path normalization function must be shared.** `normalizeNodeId()` must be defined once in types.ts or a dedicated `normalize.ts` and imported by both indexer.ts and queries.ts. If it's duplicated, a subtle difference will cause silent empty query results (the highest-risk failure mode).
- **O2: DuckDB errors must be wrapped as Result.** `buildIndex()` must return `Promise<Result<IndexResult, IndexError>>`, not throw. All internal DuckDB async calls wrapped in try/catch -> Err().
- **O3: vitest pool:forks required.** Add a separate vitest project config entry for `tests/unit/knowledge-graph.test.ts` with `pool: 'forks'` to avoid native binary crashes in worker threads.

### Yellow (Nice to Have)
- **Y1: CLI command extraction scoped to cli.ts only.** Rather than walking all source files for .command() calls, pass cli.ts explicitly. Avoids false positives if other files ever adopt Commander-like APIs.
- **Y2: Return skippedExternalImports count.** `buildIndex()` should return `{ db, nodeCount, edgeCount, skippedExternalImports }` so tests can assert the indexer ran correctly even when externals are skipped.
- **Y3: Document the illegal-state gap.** Comment in queries.ts that the DuckDB connection lifetime is the caller's responsibility. Post-spike fix: typed QueryRunner abstraction that owns connection lifecycle.

---

## Recommended Revisions

1. Instantiate ts-morph Project with explicit `tsConfigFilePath` (fixes R1)
2. Define `normalizeNodeId()` in a single location, import everywhere (fixes O1)
3. Return `Promise<Result<IndexResult, IndexError>>` from `buildIndex()` (fixes O2)
4. Add vitest project config with `pool: 'forks'` for knowledge-graph test (fixes O3)
5. Scope CLI extractor to cli.ts only; strip argument syntax from command names (Y1)
6. Return `skippedExternalImports` from `buildIndex()` (Y2)

---

## Residual Concerns

- **DuckDB forks pool in CI**: If the CI environment doesn't support forked processes (e.g., constrained Docker sandbox), the knowledge-graph test may still fail. Fallback: mark the test as integration-only and run it separately from the unit suite.
- **ts-morph memory usage**: Indexing the full src/ tree (200+ files) with ts-morph loads the full TypeScript Compiler API in-process. For the spike this is fine (runs once in test). For production use, a streaming approach would be needed.
- **NodeId branded type ergonomics**: TypeScript branded types require explicit casts in tests. The test file will need `normalizeNodeId(srcDir, absPath) as NodeId` or equivalent. This is a known ergonomic cost, not a design flaw.
