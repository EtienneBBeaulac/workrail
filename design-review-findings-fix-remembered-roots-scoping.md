# Design Review Findings: Fix Remembered-Roots Scoping

## Tradeoff Review

**Cross-repo bleed eliminated (intentional):** Acceptable. This IS the acceptance criterion. Engineers who relied on cross-repo bleed have `manage_workflow_source` as the supported mechanism for explicit cross-repo sharing. The commit message should document this migration path.

**No user-visible warning for filtered roots (non-dev mode):** Acceptable. Addressed via `WORKRAIL_DEV=1` debug log following the existing pattern at line 425. Silent in production.

**Walk cache key changes per workspace:** Acceptable. Two workspaces should not share discovery results. Slightly more cold-path misses; within acceptable latency budget.

## Failure Mode Review

**Symlinked workspace/roots:** Pre-existing limitation of the entire remembered-roots system. All path comparisons use `path.resolve` not `fs.realpath`. Not a regression -- not addressed in this change.

**Degenerate workspace path (`/` or `/home/user`):** Filter is correct for realistic inputs. Process.cwd() fallback does not produce `/` in practice.

**Test fixture regression:** Four existing tests use sibling layout that will fail after the fix. Must update all four. Highest-risk implementation failure mode.

**Monorepo layout (`repo/packages/app` workspace, `repo` root):** Filter is correct -- `path.relative('repo', 'repo/packages/app')` = `packages/app`, passes. No mitigation needed.

## Runner-Up / Simpler Alternative Review

No runner-up has elements worth borrowing. Selected design is already the simplest possible change satisfying acceptance criteria. No hybrid opportunities.

## Philosophy Alignment

All key principles satisfied: validate-at-boundaries, immutability, determinism, compose-with-small-pure-functions. Minor tension on "surface information" -- addressed with WORKRAIL_DEV log.

## Findings

**Yellow: Missing WORKRAIL_DEV debug log for filtered roots**
Engineers diagnosing missing workflows have no signal in production. Existing pattern at line 425 of `request-workflow-reader.ts` establishes the idiom. Add a log listing filtered-out roots when `WORKRAIL_DEV === '1'`.

**Yellow: Test fixtures need restructuring (4 tests)**
Tests at lines 163, 187, 211, 238 of `tests/unit/mcp/request-workflow-reader.test.ts` use sibling layout. These will fail after the fix. Must update fixture layout to ancestor hierarchy. Risk: mechanical but error-prone.

## Recommended Revisions

1. Add `WORKRAIL_DEV` log after the filter listing excluded roots (follow the pattern at line 425)
2. Update 4 test fixtures: put workspace inside rememberedRoot, not alongside it
3. Add 1 new test: "does not discover .workrail/workflows from unrelated remembered roots"

## Residual Concerns

Symlink handling is a pre-existing limitation not addressed here. If symlinked project roots become a common pattern, a separate issue should track `fs.realpath` normalization for remembered-roots comparisons.
