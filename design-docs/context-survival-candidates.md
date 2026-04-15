# Design Candidates: WorkRail Context Survival MVP

> Raw investigative material for main-agent synthesis. Not a final decision.

---

## Problem Understanding

### Core tensions

1. **Always-on ancestry vs performance:** `projectRunDagV2` + `projectNodeOutputsV2`
   currently run only on `rehydrateOnly=true` calls. Making them always-run adds two
   projection calls to every advance/start. Mitigated: both are pure functions with no I/O;
   the `precomputedIndex` extension path is available as optimization if needed.

2. **Context survival vs agent awareness:** Compaction cannot be detected from MCP.
   Conditional injection ('only inject when context resets') is not reliably triggerable.
   Always-on injection is the only approach that is zero-agent-awareness.

3. **`rehydrateOnly` flag name vs post-change semantic:** Currently the flag gates
   recovery injection. Post-change, it is completely unused. The principle 'make illegal
   states unrepresentable' demands removing the parameter entirely.

4. **MVP scope vs follow-on optimization:** Guard removal is the MVP. SessionIndex
   extension is the optimization. Conflating them would be premature.

### Likely seam

`prompt-renderer.ts`, `renderPendingPrompt`, lines ~593-596:
```typescript
// REMOVE THIS:
if (!args.rehydrateOnly) {
  return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
}
```

This is the EXACT seam. Removing it makes the `loadRecoveryProjections` +
`buildRecoverySegments` + `renderBudgetedRehydrateRecovery` path run on ALL step renders.
Empty ancestry gracefully returns empty segments, producing no text change.

**Additional finding:** `rehydrateOnly` flag has NO behavioral effect on the header label.
The header is controlled by `cleanResponseFormat`, not `rehydrateOnly` (line ~629). Post-
guard-removal, `rehydrateOnly` becomes completely unused. Parameter should be removed, not
renamed.

### What makes it hard

- Single-seam invariant: change must be correct for ALL callers simultaneously
- `rehydrateOnly` parameter removal: 4 call sites to update (but easy, clean diff)
- Performance is uncharted: no benchmark for `projectRunDagV2` on large sessions

---

## Philosophy Constraints

| Principle | Impact |
|---|---|
| Architectural fixes over patches | DEMANDS guard removal, not a flag/workaround |
| Make illegal states unrepresentable | DEMANDS `rehydrateOnly` parameter removal |
| YAGNI | REJECTS `contextSurvivalMode` config option |
| Determinism | SATISFIED by always-on injection |
| Functional/pure | `renderPendingPrompt` remains pure |
| neverthrow | New code must use `Result<T, E>` |
| Single seam | MANDATES fix goes in `renderPendingPrompt` |

No philosophy conflicts.

---

## Impact Surface

1. **`start.ts`** -- remove `rehydrateOnly: false` from call. Step 1 = empty ancestry = no change. Correct.
2. **`replay.ts` x2** -- remove `rehydrateOnly: false`. Step N+1 prompt now includes ancestry N. Test snapshots update required.
3. **`continue-rehydrate.ts`** -- remove `rehydrateOnly: true`. Explicit rehydrate still works; `recoveryHeader` label determined by `cleanResponseFormat`, unaffected.
4. **Prompt snapshot tests** -- sessions with prior notes will see ancestry content added. Empty sessions unchanged.
5. **No external callers** -- only 4 call sites in `src/mcp/handlers/v2-execution/`.

---

## Candidates

### Candidate A: Guard Removal + Parameter Removal (RECOMMENDED)

**Summary:** Remove the 3-line early-return guard and remove the now-unused `rehydrateOnly`
parameter from `renderPendingPrompt`. Ancestry recap runs on ALL step renders.

**Tensions resolved:** (1) Zero agent awareness. (2) Existing seam. (3) N/A for rename.
(4) Budget-safe. (5) Semantic accuracy via parameter removal.
**Tensions accepted:** Performance -- DAG projection added to advance path (managed risk).

**Boundary:** `renderPendingPrompt` signature + 4 call sites.

**Change scope:**
- `prompt-renderer.ts`: remove `rehydrateOnly` from `renderPendingPrompt` signature and params. Remove 3-line guard.
- `start.ts`: remove `rehydrateOnly: false` arg
- `replay.ts` x2: remove `rehydrateOnly: false` arg
- `continue-rehydrate.ts`: remove `rehydrateOnly: true` arg
- Add `// WHY: ancestry recap is now always injected for context survival` comment

**Failure mode:** Performance regression on sessions with 1000+ events. Escape hatch:
extend SessionIndex to pre-compute DAG projection (Candidate B).

**Repo pattern:** Follows. Dead parameter removal is idiomatic cleanup.

**Gains:** Simplest interface. No lying flag. Correct behavior.
**Losses:** Performance optimization deferred.

**Scope judgment:** Best-fit.

**Philosophy fit:** Honors all 7 relevant principles.

---

### Candidate B: Guard Removal + SessionIndex DAG Extension

**Summary:** Remove the guard AND extend `buildSessionIndex` to pre-compute `RunDagRunV2`
and `NodeOutputsProjectionV2`, stored as new fields. `renderPendingPrompt` reads from
`precomputedIndex` when available, eliminating the per-render projection cost.

**Additional fields in `SessionIndexData`:**
```typescript
readonly runDagByRunId: ReadonlyMap<string, RunDagRunV2>;
readonly nodeOutputsByRunId: ReadonlyMap<string, NodeOutputsProjectionV2>;
```

**`loadRecoveryProjections` change:** Accept optional `precomputedIndex`; if present, read
from index instead of calling `projectRunDagV2(truth.events)`.

**Tensions resolved:** (1), (2), (4), (5). Also resolves (3) performance.
**Tensions accepted:** Minor YAGNI conflict (optimization before evidence).

**Boundary:** `session-index.ts` + `prompt-renderer.ts` + 4 call sites.

**Failure mode:** `buildSessionIndex` heap pressure on dense sessions.

**Repo pattern:** Adapts the precomputedIndex pattern.

**Scope judgment:** Slightly too broad. No benchmark data.

**Philosophy fit:** Minor YAGNI conflict.

---

### Candidate C: MCP System-Prompt Tier Injection

**Summary:** Inject session ancestry into the MCP server's system prompt via a new MCP
resource, rendered per connection from the latest session state.

**Fatal flaw:** WorkRail supports multiple concurrent sessions. There is no 'active session'
concept at MCP server level. This candidate FAILS criterion (1) zero agent awareness.

**Scope judgment:** Too broad. Wrong boundary.

---

## Comparison and Recommendation

| | A (Guard + Param Removal) | B (+ SessionIndex) | C (System Prompt) |
|---|---|---|---|
| Zero agent awareness | YES | YES | NO -- fatal |
| Existing seam | YES | YES | NO |
| Graceful degradation | YES | YES | N/A |
| Budget-safe | YES | YES | N/A |
| Semantic accuracy | YES (removal) | YES | N/A |
| Performance | Accepted | Resolved | N/A |
| Best-fit scope | YES | Slightly too broad | Too broad |
| Reversible | YES | YES | NO |

**Recommendation: Candidate A**

---

## Self-Critique

**Strongest counter-argument:** Candidate B eliminates performance risk upfront. If sessions
routinely hit 200+ events or the SLA is tight, B is worth the implementation cost.

**Pivot conditions:**
- Advance latency > 50ms on sessions with >200 events -> Candidate B
- Always-on causes unexpected prompt behavior -> confirm RECOVERY_BUDGET_BYTES cap
- Future multi-session injection requirement -> NOT Candidate C; new solution needed

**Invalidating assumption:** `projectRunDagV2` is fast enough on every advance call.

---

## Open Questions for Main Agent

1. Remove `rehydrateOnly` entirely (parameter deletion, smaller interface) vs rename to
   `isExplicitResume` (safer diff, clearer intent for reviewers)? Analysis favors removal
   since the flag has zero behavioral effect post-change.

2. Should performance regression tests be added as part of this MVP?

3. Confirm no callers of `renderPendingPrompt` outside `src/mcp/handlers/v2-execution/`.
