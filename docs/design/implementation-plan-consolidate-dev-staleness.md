# Implementation Plan: Consolidate WORKRAIL_DEV_STALENESS into WORKRAIL_DEV

## Problem Statement

Two separate dev flags exist:
- `WORKRAIL_DEV=1` -- controls perf timing and the perf console endpoint via DI `isDevMode()`
- `WORKRAIL_DEV_STALENESS=1` -- controls staleness visibility for all workflow categories via a direct `process.env` read in `src/mcp/handlers/v2-workflow.ts`

The module-level `DEV_STALENESS` const bypasses the DI-injected feature flag system, making it inconsistent with other dev features and preventing it from being set via `~/.workrail/config.json`.

## Acceptance Criteria

1. `WORKRAIL_DEV=1` enables staleness visibility for all workflow categories (including built-in and legacy_project).
2. `WORKRAIL_DEV_STALENESS` env var is no longer supported (silently ignored if set).
3. `npx vitest run` passes with no new failures.
4. `npm run build` compiles cleanly.
5. All documentation references to `WORKRAIL_DEV_STALENESS` are updated to `WORKRAIL_DEV`.

## Non-Goals

- Backward compatibility for `WORKRAIL_DEV_STALENESS` (never publicly documented).
- Updating worktree copies of affected files (separate branches).
- Any change to the `shouldShowStaleness()` public API or its explicit test coverage.

## Philosophy-Driven Constraints

- **DI for boundaries** -- no raw `process.env` reads in handler code for feature flags.
- **YAGNI** -- no deprecated alias for `WORKRAIL_DEV_STALENESS`.
- **Immutability** -- `shouldShowStaleness()` signature unchanged (optional `devMode` param stays).
- **Document "why"** -- JSDoc updated to explain consolidation.

## Invariants

- `shouldShowStaleness()` remains exported and its signature is unchanged.
- Tests that pass `devMode` explicitly continue to work unchanged.
- Call sites that pass no second arg now get `isDevMode()` as the effective default.
- `isDevMode()` already handles uninitialized DI via fallback to `process.env['WORKRAIL_DEV']`.

## Selected Approach

Change `shouldShowStaleness`'s default parameter from `= DEV_STALENESS` to `= isDevMode()`. Remove the `DEV_STALENESS` const and its `process.env` read. Add `isDevMode` import.

**Runner-up:** Pass `isDevMode()` explicitly at each of the 2 call sites. Lost because it's more verbose with no benefit.

## Vertical Slices

### Slice 1: Code change in `src/mcp/handlers/v2-workflow.ts`

Files:
- `src/mcp/handlers/v2-workflow.ts`

Changes:
1. Remove lines 46-49 (the `DEV_STALENESS` const and its JSDoc comment).
2. Add `import { isDevMode } from '../dev-mode.js'` near the top (with other imports from `../`).
3. Change `shouldShowStaleness` default parameter from `= DEV_STALENESS` to `= isDevMode()`.
4. Update the JSDoc comment on `shouldShowStaleness` to remove the reference to `DEV_STALENESS` and explain that it now delegates to `isDevMode()`.

### Slice 2: Update `devMode` flag description in `src/config/feature-flags.ts`

Files:
- `src/config/feature-flags.ts`

Changes:
1. Line 109: Replace the description to include staleness visibility:
   ```
   'Enable development features: staleness visibility for all workflow categories, structured tool-call timing on stderr, and /api/v2/perf/tool-calls endpoint'
   ```

### Slice 3: Update comments in `src/config/config-file.ts`

Files:
- `src/config/config-file.ts`

Changes:
1. Line 10 (module JSDoc): Remove `WORKRAIL_DEV_STALENESS` from the exclusion list.
2. Lines 32-33 (ALLOWED_CONFIG_FILE_KEYS comment): Remove the bullet about `WORKRAIL_DEV_STALENESS`.

### Slice 4: Update `AGENTS.md`

Files:
- `AGENTS.md`

Changes:
1. Line 141: Change `WORKRAIL_DEV_STALENESS=1` to `WORKRAIL_DEV=1` and update the description.

### Slice 5: Update `docs/authoring-v2.md`

Files:
- `docs/authoring-v2.md`

Changes:
1. Line 495: Change `Set WORKRAIL_DEV_STALENESS=1` to `Set WORKRAIL_DEV=1`.

### Slice 6: Update `docs/configuration.md`

Files:
- `docs/configuration.md`

Changes:
1. Line 44: Remove `WORKRAIL_DEV_STALENESS` from the excluded keys list.

### Slice 7 (Optional): Update `docs/design/workrail-config-file-discovery.md`

Files:
- `docs/design/workrail-config-file-discovery.md`

Changes:
1. Lines 75, 147, 436: Update references from `WORKRAIL_DEV_STALENESS` to `WORKRAIL_DEV` or remove the separate entry.

## Test Design

- Run `npx vitest run` -- all existing tests should pass. No new tests needed; the logic in `shouldShowStaleness` is unchanged and the existing unit tests in `tests/unit/mcp/workflow-staleness.test.ts` cover it with explicit `devMode` parameters.
- Run `npm run build` -- confirm TypeScript compiles cleanly after the import and default parameter changes.

## Risk Register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| DI container uninitialized when `isDevMode()` called | Very low | Low | `dev-mode.ts` fallback to `process.env['WORKRAIL_DEV']` |
| Missing a doc location | Low | Cosmetic | All 6+1 locations identified and listed |
| TypeScript import error | Low | Caught at build | `npm run build` verification |

## PR Packaging Strategy

Single PR: `feat(mcp): consolidate WORKRAIL_DEV_STALENESS into WORKRAIL_DEV`

## Philosophy Alignment

| Principle | Status | Why |
|---|---|---|
| DI for boundaries | Satisfied | `isDevMode()` uses DI-injected `IFeatureFlagProvider` |
| Determinism | Satisfied | Flag is stable during a request |
| YAGNI | Satisfied | No deprecated alias kept |
| Document "why" | Satisfied | JSDoc and docs updated |
| Immutability by default | Satisfied | `shouldShowStaleness` signature unchanged |

## Plan Confidence

- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
- `estimatedPRCount`: 1
- `followUpTickets`: None
