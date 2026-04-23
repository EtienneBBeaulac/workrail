# Design Candidates: Context Assembly Layer v1

*Generated during wr.coding-task session | 2026-04-19*

---

## Problem Understanding

### Core Tensions

1. **Clean DI vs. pragmatic inline construction**: `LocalSessionSummaryProviderV2` is
   wired through the full DI container in the MCP server process. The coordinator runs
   as a CLI in a separate process. We cannot share the DI container. The coordinator
   composition root (`src/cli-worktrain.ts`) must construct the provider inline.

2. **Neverthrow ResultAsync vs. custom Result**: Storage layer uses neverthrow. New
   `src/context-assembly/` uses the repo's custom `Result<T,E>` (`kind: 'ok'|'err'`).
   The bridge must happen at the `infra.ts` boundary.

3. **Partial failure semantics**: Each source (gitDiff, priorNotes) must fail
   independently without aborting context assembly. `Promise.all()` is safe because
   each source always resolves to a `Result` (never throws) when implemented correctly.

4. **Backward compatibility vs. interface evolution**: Adding `contextAssembler?` as
   optional to `CoordinatorDeps` and optional 4th arg to `spawnSession` keeps all
   existing tests and callers working without modification.

### Likely Seam

The real seam is `CoordinatorDeps.spawnSession`. The coordinator calls this to dispatch
a session. Context bundle assembly belongs immediately before this call.

### What Makes This Hard

- `LocalSessionEventLogStoreV2` requires `FileSystemPortV2` (a composite of 5 sub-ports
  including write/fd ops). But `load()` only calls `readFileUtf8`. All write methods
  can be stubs for read-only use, but this is a partial lie against the interface contract.
- `LocalDirectoryListingV2` takes `DirectoryListingOpsPortV2` (separate, simpler) --
  NOT the full `FileSystemPortV2`. These are separate ports.
- Two Result type systems (neverthrow vs custom) must coexist without leaking across
  the `infra.ts` boundary.
- `Sha256PortV2` is injected into `LocalSessionEventLogStoreV2` but only called in
  `append()`, not `load()`. Safe to stub.

---

## Philosophy Constraints

From `CLAUDE.md` (system-wide agent instructions):

- **Errors are data**: Use `Result<T,E>` values. No throwing for expected failures.
- **DI for boundaries**: Inject I/O effects; keep core logic testable.
- **Prefer fakes over mocks**: Tests use realistic substitutes (no `vi.mock()`).
- **YAGNI with discipline**: No speculative abstractions.
- **Architectural fixes over patches**: Reuse canonical parsing logic.
- **Immutability by default**: `readonly` on all fields.

**Potential conflict**: Creating write stubs on `FileSystemPortV2` is pragmatic but
technically lies about the contract. The pitch (R1 mitigation) explicitly endorses this
approach. Acceptable given the inline-construction pattern is already acknowledged as
a special case.

---

## Impact Surface

- `src/coordinators/pr-review.ts`: `CoordinatorDeps.spawnSession` (add optional 4th arg),
  `contextAssembler?` optional field. Backward-compatible.
- `src/daemon/workflow-runner.ts`: `buildSystemPrompt()` reads `trigger.context['assembledContextSummary']`.
  No signature change needed -- `trigger.context` already typed as `Readonly<Record<string,unknown>>`.
- `src/cli-worktrain.ts`: `spawnSession` impl forwards 4th arg; `contextAssembler` wired.
- All existing tests that construct `CoordinatorDeps` fakes: safe (optional fields).
- No changes to `src/mcp/` or `src/v2/durable-core/`.

---

## Candidates

### Candidate A: Real local infra classes with minimal read-only shims (SELECTED)

**Summary**: Construct `LocalDataDirV2`, `LocalDirectoryListingV2`, and
`LocalSessionEventLogStoreV2` directly inside `infra.ts`. Create inline adapters:
- `DirectoryListingOpsPortV2`: wraps `fs.promises.readdir` + `stat` with `okAsync/errAsync`
- `FileSystemPortV2`: only `readFileUtf8` is real; write/fd methods throw 'context-assembly: write ops not supported'
- `Sha256PortV2`: stub that throws (never called during `load()`)

**Tensions resolved**: R1 (DI wiring scope). Uses battle-tested session loading and
projection code. Neverthrow/custom Result bridge stays at `infra.ts` boundary only.

**Tensions accepted**: Write stubs on `FileSystemPortV2` are a partial lie.

**Boundary solved at**: `src/context-assembly/infra.ts` -- coordinator composition root.

**Why this boundary is best-fit**: The coordinator is already a composition root
(`src/cli-worktrain.ts` wires all real deps). `infra.ts` is a thin adapter layer that
belongs exactly here.

**Failure mode**: If `LocalSessionEventLogStoreV2.load()` ever internally calls a write
method (unlikely but possible in future refactors), `infra.ts` would throw at runtime
rather than returning `err()`. This would be caught immediately by tests.

**Repo-pattern relationship**: Follows existing local infra pattern exactly.
`LocalDataDirV2`, `LocalDirectoryListingV2`, `LocalSessionEventLogStoreV2` are already
the canonical local implementations.

**Gains**: Reuses battle-tested store loading and projection code. No risk of format
divergence if session file structure changes.

**Losses**: Write stubs feel slightly dishonest. Minor complexity in `infra.ts`.

**Scope judgment**: Best-fit. Stays within `src/context-assembly/` with no v2 changes.

**Philosophy fit**: Honors DI for boundaries (composition root pattern), errors-as-data
(Result bridge), architectural fixes over patches (reuses canonical code). Minor
tension with YAGNI (write stubs) and interface honesty.

---

### Candidate B: Read session files directly with fs.promises

**Summary**: Skip the port hierarchy. Read `manifest.jsonl` and `events/*.jsonl` directly
using `fs.promises.readFile`. Parse manually or reuse just the schema validators.

**Tensions resolved**: R1 completely -- no DI wiring at all.

**Tensions accepted**: Duplicates session reading logic. Any change to session file
format requires updates in two places.

**Failure mode**: Silent breakage if session file format changes.

**Repo-pattern relationship**: Departs from established pattern (re-implements existing logic).

**Scope judgment**: Too narrow -- creates a fragile parallel implementation.

**Philosophy fit**: Conflicts with 'architectural fixes over patches'.

---

### Candidate C: Add createLocalSessionSummaryProvider() factory to v2 module

**Summary**: Add a `createLocalSessionSummaryProvider()` factory function to
`src/v2/infra/local/session-summary-provider/index.ts` that wires real deps and
returns a `SessionSummaryProviderPortV2`. Import and call from `infra.ts`.

**Tensions resolved**: Cleanest DI wiring.

**Tensions accepted**: Modifies an existing v2 infra module.

**Failure mode**: Entangles CLI-coordinator concerns into the storage layer.

**Scope judgment**: Slightly too broad -- modifies v2 module with no functional benefit
over Candidate A.

---

## Comparison and Recommendation

**Recommendation: Candidate A**

All candidates agree on the high-level approach (4 new files, 3 modified files, exact
pitch interfaces). The only real design decision is `infra.ts` implementation.

Candidate A wins because:
1. It reuses battle-tested code for session reading and health projection
2. It stays within `src/context-assembly/` -- no v2 module changes
3. The write stubs are safe: `load()` provably does not call write methods
4. The pitch explicitly endorses this approach as R1 mitigation

---

## Self-Critique

**Strongest counter-argument**: The write stubs on `FileSystemPortV2` create a silent
contract violation. If a future `load()` implementation adds a write call internally,
the error would surface at runtime (throw) rather than compile-time.

**Narrower option that lost**: Candidate B (raw fs.promises). Lost because it duplicates
canonical parsing logic and diverges from existing patterns.

**Broader option and evidence required**: Candidate C would be justified if multiple
other CLI commands needed access to session summaries -- adding a factory to the v2
module would be worth the scope increase. No evidence of this need in v1.

**Assumption that would invalidate this design**: If `LocalSessionEventLogStoreV2.load()`
internally calls any of the stubbed write methods (currently provably false by code
inspection of `loadImpl()`, `loadValidatedPrefixImpl()`, `readManifestOrEmpty()`).

---

## Open Questions for Main Agent

1. Verify: does `Sha256PortV2` have a simple interface that can be satisfied with a
   1-line `node:crypto` implementation? (If so, use real impl rather than throw stub.)
2. Verify: does the `FileSystemPortV2` shim need anything beyond `readFileUtf8` for
   the `load()` path? (Current analysis: no -- `readManifestOrEmpty` and segment loading
   both use `readFileUtf8` only.)
3. The re-review spawn (line ~1265 in pr-review.ts) should forward `spawnContext` from
   the outer scope per the pitch. Confirm this is the correct approach (vs. reassembling
   context for re-reviews).
