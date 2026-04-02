## 1. Problem Statement

Phase 1 shipped rooted-sharing trust and per-workflow visibility, but Phase 2A still lacks the **canonical effective source-catalog seam** that later managed onboarding is supposed to build on.

The stale-plan check proved the current codebase still exposes:

- workflow-oriented public MCP surfaces
- request-scoped workflow composition
- per-workflow visibility

and does **not** yet expose:

- a standalone effective source-catalog handler
- source-oriented catalog schemas
- a stable public `sources` payload seam

So the first honest Phase 2A implementation step is **not** managed attach proof directly. It is to establish the missing source-catalog seam that the plan, spec, and uncommitted tests already assume.

## 2. Acceptance Criteria

These mirror the observable behavior in `spec.md`, but are ordered around the corrected baseline.

### Slice-1 outcomes

- A user can query a canonical **effective source catalog** for a workspace.
- The catalog returns **source-oriented** entries, not only workflow-oriented entries.
- The catalog includes at least:
  - rooted-sharing sources
  - legacy project sources
  - env-configured external-style sources
  - built-in effective source presence in whatever minimal honest form the catalog chooses
- The catalog reports enough information to explain:
  - source category
  - effective workflow count
  - total workflow count
  - shadowed workflow count
  - migration/preference context where relevant

### Later Phase-2A outcomes

- Managed onboarding exists for one narrow first intent.
- Review semantics are grounded in real composition, not metadata-only reasoning.
- A later attach/enable operation produces a visible catalog/effective-source change.
- The catalog can eventually relate managed control entries to effective runtime entries without dual truth.

## 3. Non-goals

This corrected Slice 1 still does **not** include:

- managed attach/enable behavior
- managed-source persistence
- review/attach tool-shape decisions
- broader registry/plugin/community onboarding
- rich update/sync/health lifecycle surfaces
- receipts or setup transcripts
- a console control tower
- final `.workrail/*` ownership resolution
- a runtime precedence rewrite

## 4. Philosophy-Driven Constraints

- **Architectural fixes over patches**: establish a real source-catalog seam, not another layer of workflow-only metadata.
- **Prefer explicit domain types over primitives**: source-catalog entries must be their own typed concept.
- **Validate at boundaries, trust inside**: the source-catalog MCP boundary must be explicit and schema-backed.
- **Dependency injection for boundaries**: source catalog derivation should reuse current ports/readers rather than bypass them ad hoc.
- **Errors are data**: source-catalog handler failures should remain typed and boundary-safe.
- **YAGNI with discipline**: Slice 1 should stop at the smallest honest catalog seam and must not smuggle in managed onboarding prematurely.

## 5. Invariants

These are non-negotiable:

1. **The effective source catalog must become a real public seam**
   - tests cannot target a missing `sources` surface any longer.

2. **The catalog must reflect real composition truth**
   - no fabricated catalog detached from request-scoped composition.

3. **Legacy/env/runtime-configured sources remain visible**
   - migration honesty starts with visibility.

4. **No hidden runtime rewrite**
   - Slice 1 remains a catalog/control-surface addition.

5. **Managed-source work must build on this seam, not around it**
   - future attach/review/persistence should reuse the catalog baseline.

## 6. Selected Approach + Rationale + Runner-up

### Selected approach

**Catalog-first Slice 1**:

- add a standalone source-catalog MCP handler/schema/tool seam
- derive source-oriented entries from current request-scoped effective composition
- make the existing test/artifact stream honest against the live codebase
- defer managed persistence and attach proof to the next slice

### Why this approach won

- It resolves the validated stale-plan mismatch directly.
- It aligns implementation with the accepted Phase 2A plan/spec language around a **canonical effective source catalog**.
- It creates the truthful baseline that managed onboarding is supposed to build on.
- It avoids pretending managed attach proof can start before the catalog seam exists.

### Runner-up

**Workflow-surface reinterpretation**

- prove Phase 2A only through `list_workflows` / `inspect_workflow`
- loses because it would redefine the initiative away from a real catalog seam and fight the current test/doc direction

### Pivot conditions

Pivot away from this selected Slice 1 only if:

- a source-catalog seam cannot be derived honestly from current composition without broader runtime rewrites, or
- the catalog becomes so broad that it silently absorbs managed onboarding/lifecycle scope

## 7. Vertical Slices

### Slice 1 — Effective source-catalog seam

Goal: create the missing truthful public catalog baseline.

Deliver:

- standalone source-catalog handler
- source-catalog input/tool definition
- source-catalog output schema
- request-scoped derivation of source-oriented entries from current effective composition
- tests proving rooted, legacy, env-configured, and overlap/shadowing cases

This is the decisive corrective slice. It resolves the stale-plan mismatch and establishes the real baseline for the rest of Phase 2A.

### Slice 2 — Managed-source domain + persistence seam

Goal: introduce the smallest real control-layer state on top of the catalog baseline.

Deliver:

- managed-source domain type(s)
- store port
- local adapter under the existing `~/.workrail/data/...` pattern
- minimum viable schema

### Slice 3 — Review/attach integration proof

Goal: prove managed state materially affects composition and catalog output.

Deliver:

- one narrow onboarding intent
- composition-backed review
- attach path that visibly changes effective source/catalog output
- explicit prohibition on metadata-only review

### Slice 4 — Catalog relationship modeling + migration alignment

Goal: prevent dual truth and keep migration honest.

Deliver:

- explicit relationship between managed control entries and effective source entries
- legacy/env visibility remains intact
- migration guidance continues to surface

## 8. Work Packages

### Package A — Source catalog domain + schema

- source-catalog entry type(s)
- source-key rules
- category/source-mode vocabulary
- output schema for `sources`

### Package B — Source catalog handler/tool seam

- handler in the v2 MCP surface
- tool input definition
- read-only behavior contract
- no remembered-root persistence side effects from listing

### Package C — Catalog derivation from current composition

- derive source entries from:
  - project source
  - rooted-sharing custom paths
  - env-configured external-style sources already present in composition
- compute:
  - effective workflow count
  - total workflow count
  - shadowed workflow count
  - migration context where relevant

### Package D — Managed-source foundation (next slice)

- only after Package A-C land cleanly
- managed-source domain + persistence seam

## 9. Test Design

### Unit tests

- source-key derivation
- category/source-mode mapping
- rooted-sharing grouping / migration classification
- shadowed/effective count helpers

### MCP/unit boundary tests

- `handleV2ListWorkflowSources(...)` happy path
- rooted-sharing overlap with legacy project workflows
- env-configured external-style source presence
- read-only behavior: listing sources does not persist remembered roots

### Contract tests

- source-catalog output schema
- `sources` root payload
- migration payload shape for legacy-vs-rooted overlap

### Architecture / invariant tests

- source catalog derives from real request-scoped composition
- no direct source-catalog shortcut that bypasses the request reader/composition layer

### Build verification

- `npm run build`
- focused vitest suites around:
  - `v2-workflow-source-catalog-output`
  - request reader
  - source catalog contract coverage

## 10. Risk Register

### Red

- **Catalog dishonesty**
  - Mitigation: derive from request-scoped effective composition, not parallel metadata.

### Orange

- **Slice creep into managed onboarding**
  - Mitigation: keep Slice 1 read-only and source-catalog-only.

- **Source grouping/count logic diverges from effective runtime truth**
  - Mitigation: compute catalog entries from the same composition inputs/runtime ordering already used for workflow resolution.

### Yellow

- **Built-in/source-model representation is initially awkward**
  - Mitigation: permit the smallest honest built-in representation in Slice 1 and refine later if needed.

- **2B creep**
  - Mitigation: defer lifecycle/update/receipt/control-tower work entirely.

## 11. PR Packaging Strategy

### Estimated PR count

**3 PRs**

#### PR 1 — Source-catalog seam

- source-catalog handler/tool/schema
- source-entry derivation
- focused tests

#### PR 2 — Managed-source persistence seam

- managed-source port/store
- minimal schema
- no attach yet unless required for seam proof

#### PR 3 — Review/attach integration proof

- first onboarding intent
- composition-backed review
- attach effect
- catalog relationship modeling if not already landed

## 12. Philosophy Alignment Per Slice

### Slice 1 — Effective source-catalog seam

- **Architectural fixes over patches** -> **satisfied**: fixes the missing public seam directly
- **Prefer explicit domain types over primitives** -> **satisfied**: introduces real source-entry concepts
- **YAGNI with discipline** -> **satisfied**: stops before managed onboarding

### Slice 2 — Managed-source domain + persistence seam

- **Dependency injection for boundaries** -> **satisfied**: new persistence behind a port
- **Errors are data** -> **tension**: typed persistence failures must be explicit
- **No hidden runtime rewrite** -> **satisfied**: still foundation only

### Slice 3 — Review/attach integration proof

- **Validate at boundaries, trust inside** -> **satisfied**: explicit review/attach boundary
- **Architectural fixes over patches** -> **satisfied**: proves real attach effect
- **YAGNI with discipline** -> **tension**: keep to one first intent only

### Slice 4 — Relationship + migration alignment

- **Migration honesty / explainability** -> **satisfied**
- **No hidden runtime rewrite** -> **satisfied**
- **YAGNI with discipline** -> **satisfied** if kept small and output-focused

## 13. Open Unknowns

1. ~~Exact minimal source-catalog entry shape for built-in presence~~ -- **RESOLVED**: test expects `sources.some(entry => entry.category === 'built_in')` passes; bundled sources are included as-is
2. ~~Whether the first source-catalog tool should live in `v2-workflow.ts` or a separate handler module~~ -- **RESOLVED**: add to `v2-workflow.ts` following the existing `handleV2ListWorkflows` pattern
3. Exact minimum managed-source schema for Slice 2
4. Best first onboarding intent for Slice 3
5. Whether review and attach should be separate or combined in Slice 3

## 15. Slice 1 Technical Specification (from context gathering)

### Files to change (6)

1. `src/mcp/types/workflow-tool-edition.ts` -- add `'list_workflow_sources'` to `V2WorkflowToolName` union
2. `src/mcp/v2/tools.ts` -- add `V2ListWorkflowSourcesInput` schema; add entry to `V2_TOOL_TITLES` and `V2_TOOL_ANNOTATIONS`
3. `src/mcp/output-schemas.ts` -- add `V2WorkflowSourceCatalogEntrySchema` and `V2WorkflowSourceCatalogOutputSchema`
4. `src/mcp/handlers/v2-workflow.ts` -- implement `handleV2ListWorkflowSources`
5. `src/mcp/v2/tool-registry.ts` -- register new tool and handler
6. `src/mcp/tool-descriptions.ts` -- add description string

### Handler logic (storage-instance-first approach)

```
handleV2ListWorkflowSources(input, ctx):
  1. requireV2Context guard
  2. listRememberedRootRecords (for rootedSharing derivation)
  3. createWorkflowReaderForRequest (workspace-aware; captures stalePaths but ignores them here)
     - DO NOT call rememberExplicitWorkspaceRoot (read-only contract)
  4. if not composite reader: return empty sources
  5. Get effective summaries from composite: workflowReader.listWorkflowSummaries()
  6. Build effective ID→source map: Map<workflowId, sourceDirectoryPath>
  7. For each storage instance in workflowReader.getStorageInstances():
     a. List all workflows in this source: storage.listWorkflowSummaries()
     b. totalWorkflowCount = all.length
     c. effectiveWorkflowCount = count of IDs whose source matches this storage in the effective map
     d. shadowedWorkflowCount = total - effective
     e. Derive sourceKey, category, sourceMode, source, rootedSharing, migration
  8. Return V2WorkflowSourceCatalogOutputSchema.parse({ sources })
```

### sourceKey derivation
- `bundled` → `'built_in'`
- `user` → `'user:' + source.directoryPath`
- `project` → `'project:' + source.directoryPath`
- `custom` → `'custom:' + source.directoryPath`
- `git` → `'git:' + source.repositoryUrl`
- `remote` → `'remote:' + source.registryUrl`

### migration guidance
Apply to a `legacy_project` entry when ANY `rooted_sharing` source in the catalog has a workflow ID that also exists in this project source.

### Effective/shadowed count algorithm (corrected after audit)

`WorkflowSummary.source` is stripped to `{kind, displayName}` with no path identity -- cannot cross-reference composite vs per-instance by source field. Use `seenIds` tracking instead:

```
const instances = workflowReader.getStorageInstances(); // priority order (highest first)
const seenIds = new Set<string>();
for (const instance of instances) {
  const allSummaries = await instance.listWorkflowSummaries();
  const allIds = allSummaries.map(s => s.id);
  const effectiveIds = allIds.filter(id => !seenIds.has(id));
  for (const id of allIds) seenIds.add(id);
  // totalWorkflowCount = allIds.length
  // effectiveWorkflowCount = effectiveIds.length
  // shadowedWorkflowCount = total - effective
}
```

This mirrors how `EnhancedMultiSourceWorkflowStorage.listWorkflowSummaries()` deduplicates internally.

### sourceMode derivation
- `bundled` → `'built_in'`
- `user` → `'personal'`
- `project` → `'legacy_project'`
- `custom` + rootedSharing → `'rooted_sharing'`
- `custom` (no rootedSharing) → `'live_directory'`
- `git`, `remote`, `plugin` → `'live_directory'`

### displayName derivation for custom sources
`source.label ?? path.basename(source.directoryPath)`

### Migration guidance (source-level)
For a `legacy_project` catalog entry: apply migration guidance if ANY other storage instance in the catalog is a `rooted_sharing` source AND shares at least one workflow ID with this project source.

### Acceptance test status
`tests/unit/mcp/v2-workflow-source-catalog-output.test.ts` -- 3 tests, 0% passing. Goal: 3/3.

## 14. Execution Summary

Slice 1 is complete (PR #192 merged). The source catalog seam is real and tested.

Slice 2 begins next: establish the managed-source persistence seam so Slice 3 can build attach/enable behavior on top of it.

## 16. Slice 2 Technical Specification

### Status
Complete. PR merged.

### Files to create/change (9)

1. `src/v2/ports/managed-source-store.port.ts` -- new port: domain types + interface
2. `src/v2/infra/local/managed-source-store/index.ts` -- new local adapter (mirrors remembered-roots-store)
3. `src/v2/ports/data-dir.port.ts` -- add `managedSourcesPath()` and `managedSourcesLockPath()`
4. `src/v2/infra/local/data-dir/index.ts` -- implement the two new methods
5. `src/mcp/types.ts` -- add `managedSourceStore?: ManagedSourceStorePortV2` to `V2Dependencies`
6. `src/di/tokens.ts` -- add `ManagedSourceStore: Symbol('V2.ManagedSourceStore')` under `V2` group
7. `src/di/container.ts` -- register `LocalManagedSourceStoreV2` in `registerV2Services()` Level 2
8. `src/mcp/server.ts` -- resolve `DI.V2.ManagedSourceStore` and wire into `v2` object
9. `tests/unit/v2/managed-source-store.test.ts` -- new unit tests

### Domain types (port file)

```typescript
export type ManagedSourceStoreError =
  | {
      readonly code: 'MANAGED_SOURCE_BUSY';
      readonly message: string;
      readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number };
      readonly lockPath: string;
    }
  | { readonly code: 'MANAGED_SOURCE_IO_ERROR'; readonly message: string }
  | { readonly code: 'MANAGED_SOURCE_CORRUPTION'; readonly message: string };

export interface ManagedSourceRecordV2 {
  readonly path: string;       // absolute, normalized filesystem path
  readonly addedAtMs: number;  // epoch ms when attached
}

export interface ManagedSourceStorePortV2 {
  list(): ResultAsync<readonly ManagedSourceRecordV2[], ManagedSourceStoreError>;
  attach(path: string): ResultAsync<void, ManagedSourceStoreError>;
  detach(path: string): ResultAsync<void, ManagedSourceStoreError>;
}
```

### File format

```json
{ "v": 1, "sources": [{ "path": "/abs/path", "addedAtMs": 0 }] }
```

File location: `<dataRoot>/managed-sources/managed-sources.json`
Lock location: `<dataRoot>/managed-sources/managed-sources.lock`

### Adapter behavior

- `list()`: read file; FS_NOT_FOUND -> return []; parse and validate with Zod; normalize paths
- `attach(path)`: withLock -> list -> dedup by resolved path -> append if new -> persist
- `detach(path)`: withLock -> list -> filter out resolved path -> persist
- `persist()`: same crash-safe write as remembered-roots (mkdirp -> openWriteTruncate(tmp) -> writeAll -> fsyncFile -> closeFile -> rename -> fsyncDir)
- `withLock()`: same openExclusive pattern as remembered-roots

### Type cast rule (architecture lock)

`v2-type-safety.test.ts` enforces no `as any` in `src/v2/**`. When passing the file value to `toCanonicalBytes`, use the `as unknown as JsonValue` double-cast pattern (not `as any`). This matches the pattern in `LocalRememberedRootsStoreV2` and is the only permitted escape hatch.

### Idempotency invariant

`attach()` for an already-present path is a no-op (does not update addedAtMs). This keeps the timestamp semantically accurate (it means "when first attached").

### DataDir new methods

```typescript
managedSourcesPath(): string {
  return path.join(this.root(), 'managed-sources', 'managed-sources.json');
}

managedSourcesLockPath(): string {
  return path.join(this.root(), 'managed-sources', 'managed-sources.lock');
}
```

### Test cases (unit, tests/unit/v2/managed-source-store.test.ts)

1. persists and reloads attached sources across store instances
2. attach is idempotent -- duplicate path does not add a second entry
3. detach removes a source; second detach is a no-op (does not fail)
4. list returns empty array when file does not exist yet
5. returns MANAGED_SOURCE_CORRUPTION for invalid JSON
6. returns MANAGED_SOURCE_BUSY when lock file already exists

### Acceptance criteria

- `ManagedSourceStorePortV2` port exists and is importable
- `LocalManagedSourceStoreV2` adapts the port with crash-safe local file persistence
- `DataDirPortV2` declares the two new path methods; `LocalDataDirV2` implements them
- `V2Dependencies.managedSourceStore` is optional and wired in production bootstrap
- All 6 unit tests pass
- `npm run build` passes with no type errors
