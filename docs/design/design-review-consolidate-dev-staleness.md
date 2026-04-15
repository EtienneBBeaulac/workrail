# Design Review: Consolidate WORKRAIL_DEV_STALENESS into WORKRAIL_DEV

## Tradeoff Review

| Tradeoff | Status | Notes |
|---|---|---|
| `WORKRAIL_DEV_STALENESS` env var stops working | Acceptable | Never publicly documented; not present in any checked-in configs |
| Per-call DI resolution instead of module-level const | Acceptable | `isDevMode()` is a map lookup; `dev-mode.ts` has fallback for uninitialized DI |
| 5 documentation locations to update | Manageable | All identified; none in shipped user-facing docs requires backward-compat consideration |

## Failure Mode Review

| Failure mode | Handled | Notes |
|---|---|---|
| DI container uninitialized at call time | Yes | `dev-mode.ts` try/catch fallback to `process.env['WORKRAIL_DEV']` |
| Test regression from default param change | Yes | All tests pass `devMode` explicitly; default is not exercised by tests |
| Missing a doc update | Low risk | 5 locations identified; missing one would be cosmetic only |

## Runner-Up / Simpler Alternative Review

- **Runner-up (explicit call sites):** No strengths worth borrowing. Strictly more code for the same behavior.
- **Simpler variant:** None exists. The selected approach is already the minimum change.

## Philosophy Alignment

All relevant principles satisfied:
- DI for boundaries: `isDevMode()` via `IFeatureFlagProvider`
- Determinism: flag is stable during a request
- YAGNI: no deprecated alias kept
- Document "why": JSDoc updated
- Immutability: `shouldShowStaleness` signature unchanged

No philosophy tensions.

## Findings

No red or orange findings. One yellow:

**Yellow:** The design doc `docs/design/workrail-config-file-discovery.md` contains 3 references to `WORKRAIL_DEV_STALENESS` (lines 75, 147, 436). This is a historical design document, not a runtime or user-facing doc. Updating it is optional but recommended for consistency.

## Recommended Revisions

None required. The implementation plan is:
1. `src/mcp/handlers/v2-workflow.ts`: Remove `DEV_STALENESS` const; change default param; add `isDevMode` import; update JSDoc on `shouldShowStaleness`.
2. `src/config/feature-flags.ts` line 109: Update description to include staleness.
3. `src/config/config-file.ts` lines 10 and 32: Remove `WORKRAIL_DEV_STALENESS` from comments.
4. `AGENTS.md` line 141: Change to `WORKRAIL_DEV=1`.
5. `docs/authoring-v2.md` line 495: Change to `WORKRAIL_DEV=1`.
6. `docs/configuration.md` line 44: Remove `WORKRAIL_DEV_STALENESS`.
7. (Optional) `docs/design/workrail-config-file-discovery.md`: Update 3 references.

## Residual Concerns

None. This is a low-risk, well-scoped change.
