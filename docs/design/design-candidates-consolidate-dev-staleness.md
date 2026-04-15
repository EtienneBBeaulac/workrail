# Design Candidates: Consolidate WORKRAIL_DEV_STALENESS into WORKRAIL_DEV

## Problem Understanding

**Goal:** Remove the separate `WORKRAIL_DEV_STALENESS` env var so that `WORKRAIL_DEV=1` controls all dev features, including staleness visibility for all workflow categories.

**Core tensions:**
1. Module-load-time vs call-time evaluation -- `DEV_STALENESS` is evaluated once at module load; `isDevMode()` evaluates per call via DI. Not a real tension in practice because the flag doesn't change mid-request.
2. Backward compat vs clean design -- `WORKRAIL_DEV_STALENESS` was never publicly documented and never allowed in `~/.workrail/config.json`. Dropping it is clean with essentially zero user impact.

**Likely seam:** The default parameter value of `shouldShowStaleness()` in `src/mcp/handlers/v2-workflow.ts` line 55. This is both where the symptom appears and the correct fix location.

**What makes it hard:** Nothing structurally hard. The main subtlety is that the replacement (`isDevMode()`) is a function, not a constant, so it must be in a default parameter (call-time) rather than a module-level assignment (load-time).

---

## Philosophy Constraints

From `CLAUDE.md` and `AGENTS.md`:
- **Dependency injection for boundaries** -- use DI-injected flags, not raw `process.env` reads in handler code.
- **Determinism** -- call-time evaluation of `isDevMode()` is deterministic; the flag doesn't change during a request.
- **YAGNI** -- drop `WORKRAIL_DEV_STALENESS` entirely; no deprecated alias needed.
- **Document "why", not "what"** -- update JSDoc to explain the consolidation.

No conflicts between stated philosophy and repo patterns.

---

## Impact Surface

**Must stay consistent:**
- `shouldShowStaleness()` exported function signature -- stays the same (optional `devMode` param)
- `tests/unit/mcp/workflow-staleness.test.ts` -- tests pass `devMode` explicitly, no impact
- `buildV2WorkflowListItem` (line 528) and inspect handler (line 435) -- both call `shouldShowStaleness(visibility?.category)` with no second arg; they will now get `isDevMode()` as the default

**Docs requiring updates:**
- `src/config/feature-flags.ts` line 109: description says staleness is controlled by `WORKRAIL_DEV_STALENESS` separately
- `AGENTS.md` line 141: documents `WORKRAIL_DEV_STALENESS=1`
- `docs/authoring-v2.md` line 495: says `Set WORKRAIL_DEV_STALENESS=1`
- `docs/configuration.md` line 44: lists `WORKRAIL_DEV_STALENESS` as excluded key
- `src/config/config-file.ts` lines 10, 32: comments mention `WORKRAIL_DEV_STALENESS`

---

## Candidates

### Candidate 1: Change default parameter to `isDevMode()` (recommended)

**Summary:** Remove the `DEV_STALENESS` const; change `shouldShowStaleness`'s default from `= DEV_STALENESS` to `= isDevMode()`; import `isDevMode`.

- **Tensions resolved:** Eliminates second env var; staleness now flows through DI like other dev features.
- **Accepts:** Tiny per-call DI resolution overhead (already done by other dev features; negligible).
- **Boundary:** Default parameter in `shouldShowStaleness` -- exactly where the flag is consumed.
- **Failure mode:** If `isDevMode()` is called in a context where DI isn't initialized. Mitigated by `dev-mode.ts` fallback to `process.env['WORKRAIL_DEV']`.
- **Repo pattern:** Follows -- perf timing and perf endpoint already use `isDevMode()` at call time.
- **Gain:** Single flag; DI-consistent; config-file compatible (`WORKRAIL_DEV` can be set in `~/.workrail/config.json`).
- **Give up:** `WORKRAIL_DEV_STALENESS` env var no longer works. Acceptable since it was never publicly documented.
- **Scope judgment:** best-fit.
- **Philosophy:** Honors DI-for-boundaries, determinism, YAGNI. No conflicts.

### Candidate 2: Pass `isDevMode()` explicitly at each call site

**Summary:** Remove `DEV_STALENESS` const; pass `isDevMode()` as the second argument at each of the 2 call sites rather than via default parameter.

- **Tensions resolved:** Same runtime behavior as Candidate 1; slightly more explicit at call sites.
- **Accepts:** More code to maintain; must update 2 call sites instead of 1 location.
- **Failure mode:** Easy to miss a call site if more are added later.
- **Scope judgment:** Slightly too verbose -- 2 call sites, no benefit over Candidate 1.
- **Philosophy:** Marginally better on "explicit over implicit" but outweighed by the existing default-parameter design.

---

## Comparison and Recommendation

Both candidates produce identical runtime behavior. Candidate 1 is preferred:
- Touches fewer lines (1 location vs 3)
- Preserves the existing public API of `shouldShowStaleness` (tests already pass explicit values)
- Follows the established pattern in the file

**Recommendation: Candidate 1**

---

## Self-Critique

**Strongest counter-argument:** Candidate 2 makes the dev flag visible at the call site, which is slightly more transparent. With only 2 call sites, this would be readable. However, the existing default-parameter design was deliberately chosen for testability, and Candidate 1 respects that invariant.

**Narrower option that could work:** Only update the source code but leave the docs unchanged. Would still work but creates documentation drift -- rejected.

**Broader option:** Inject `devMode` into the handler via `ToolContext` and thread it through. This would be a larger architectural change with no benefit for a single boolean flag that already has a clean accessor via `isDevMode()`.

**Assumption that would invalidate:** If `isDevMode()` DI resolution became unreliable or slow. Currently it's a simple map lookup; this assumption is safe.

---

## Open Questions

None. The path is clear.
