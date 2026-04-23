# Design Review Findings: Context Assembly Layer v1

*Generated during wr.coding-task session | 2026-04-19*

---

## Tradeoff Review

| Tradeoff | Verdict | Condition for Failure |
|---|---|---|
| FileSystemPortV2 write stubs | RESOLVED -- switching to direct SessionEventLogReadonlyStorePortV2 adapter | N/A |
| Inline DI wiring in infra.ts | Acceptable -- explicitly endorsed by pitch R1 mitigation | N/A |
| Global session list (no workspace filtering) | Accepted -- v2 improvement documented in pitch | Multiple simultaneous workspaces with unrelated sessions |
| Promise.all partial failure | Adequately handled -- each source returns Result, try/catch in infra | N/A |

---

## Failure Mode Review

| Failure Mode | Covered By | Residual Risk |
|---|---|---|
| Write stubs called | Outer try/catch in createListRecentSessions | Low -- FM1 resolved by switching adapter |
| Git commands fail | execGit/execGh return err(), fallback chain | None |
| Sessions dir missing | LocalDirectoryListingV2 returns [] for FS_NOT_FOUND | None |
| Corrupt session data | LocalSessionSummaryProviderV2 graceful skip | None |
| spawnSession backward compat | Optional 4th arg | None |
| contextAssembler not provided | Optional field + if-guard in coordinator | None |

---

## Runner-Up / Simpler Alternative Review

**Runner-up** (Candidate B: raw fs.promises) has no elements worth borrowing into the
selected design.

**Simpler variant identified**: Use a direct `SessionEventLogReadonlyStorePortV2`
adapter in `infra.ts` instead of `LocalSessionEventLogStoreV2`. This eliminates all
`FileSystemPortV2` and `Sha256PortV2` stubs while still reusing `LocalSessionSummaryProviderV2`
and the full projection pipeline. The adapter implements only `load()` and
`loadValidatedPrefix()` using `fs.promises` + existing Zod schemas (`ManifestRecordV1Schema`,
`DomainEventV1Schema`). Approximately 40 lines. This is strictly cleaner.

**Recommendation**: Use the simpler `SessionEventLogReadonlyStorePortV2` adapter approach.

---

## Philosophy Alignment

| Principle | Alignment |
|---|---|
| Errors are data | STRONG -- Result<T,E> throughout |
| DI for boundaries | STRONG -- ContextAssemblerDeps, inline construction accepted for separate process |
| Prefer fakes over mocks | STRONG -- test spec uses fake deps |
| Immutability by default | STRONG -- readonly everywhere |
| Make illegal states unrepresentable | STRONG -- AssemblyTask discriminated union |
| Functional/declarative | STRONG -- factory functions, pure renderContextBundle |
| YAGNI | MILD TENSION -- empty RenderOpts interface (accepted, documented) |
| Architectural fixes over patches | STRONG with adapter approach |

---

## Findings

### YELLOW: Empty RenderOpts interface

**Severity**: Yellow (minor)

**Finding**: `RenderOpts` is an empty interface in v1. TypeScript `{}` and `interface RenderOpts {}` are equivalent. The empty interface is only useful as a future extension point.

**Assessment**: Acceptable -- the pitch explicitly documents this as an intentional v1 placeholder. No action needed.

### YELLOW: Global session filtering (no workspace scope)

**Severity**: Yellow (minor, known)

**Finding**: `listRecentSessions` returns the 3 most recent sessions globally, not scoped to the coordinator's workspace path. For users running multiple workspaces, prior notes from unrelated workspaces may appear.

**Assessment**: Acceptable for v1 -- pitch explicitly documents this as a known limitation. The `_workspacePath` parameter should be named with a leading `_` to signal intentional non-use.

### GREEN: All other design elements

Tradeoffs, failure modes, and philosophy alignment are all sound. No RED or ORANGE findings.

---

## Recommended Revisions

1. **Use direct `SessionEventLogReadonlyStorePortV2` adapter** in `infra.ts` instead of
   `LocalSessionEventLogStoreV2`. Eliminates all write stubs. Implements `load()` using
   `fs.promises.readFile` + `ManifestRecordV1Schema` + `DomainEventV1Schema` parsing.
   Approximately 40 lines.

2. **Name unused parameter** `_workspacePath` in `createListRecentSessions` to signal
   intentional non-use.

---

## Residual Concerns

1. **Import path for Zod schemas**: `ManifestRecordV1Schema` and `DomainEventV1Schema`
   must be importable from `src/v2/durable-core/schemas/session/index.ts`. Verify before
   implementing that these schemas are exported.

2. **`asSessionId` usage**: The `SessionEventLogReadonlyStorePortV2.load()` adapter
   receives a `SessionId` branded type. When reading session directories and mapping
   entry names to `SessionId`, the `asSessionId` import from
   `src/v2/durable-core/ids/index.ts` must be used correctly.

3. **Neverthrow ResultAsync wrapping**: The adapter must return neverthrow `ResultAsync`
   objects (using `okAsync`/`errAsync` from neverthrow), not the custom `Result` type.
   The bridge from neverthrow to custom Result happens in the `createListRecentSessions`
   function via `const result = await resultAsync; if (result.isErr()) return err(...)`.
