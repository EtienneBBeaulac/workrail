# Design Review Findings: WorkRail Context Survival MVP

## Tradeoff Review

### T1: Performance -- DAG projections on every advance call

**Accepted.** `projectRunDagV2` + `projectNodeOutputsV2` are now called on every step
render (was: rehydrate-only). Both are single O(N) passes over an in-memory array.
For realistic sessions (25-500 events), this is microseconds. No I/O.

**Unacceptable if:** Sessions routinely exceed 1000+ events. Escape hatch: extend
`SessionIndex` to pre-compute these projections (Candidate B).

### T2: Snapshot test churn

**Accepted.** Tests for sessions with prior notes will see ancestry content added.
This is a correct behavioral change -- tests asserting absence of ancestry were testing
a bug, not a feature. One-time cost with `--update-snapshots`.

---

## Failure Mode Review

### FM1: Performance regression (LOW risk)

Validated: submillisecond for realistic sessions. No violation of acceptance criteria.
Missing: no automated performance regression test. Recommendation: add benchmark note
to implementation task.

### FM2: Snapshot tests breaking CI (LOW risk)

Standard snapshot update process. Documented in implementation notes.

### FM3: Untested compaction simulation (MEDIUM risk) -- MOST DANGEROUS

**No integration test exists for the primary use case:** start workflow, advance 4 steps
with notes, simulate context reset (call continue_workflow without prior context), verify
step 5 prompt contains ancestry recap from steps 1-4.

If the guard removal silently misfires for the start path, the feature would appear to
work but fail in the exact scenario it is designed for. Unit tests would pass.

**Required mitigation:** Integration test for the compaction simulation scenario.

---

## Runner-Up / Simpler Alternative Review

**Candidate B (SessionIndex extension):** No elements worth pulling into MVP. The
performance optimization is premature without benchmark data. Clean follow-on.

**Simpler variant (rename rehydrateOnly, don't remove):** Rejected. Dead parameter
violates 'make illegal states unrepresentable'. Removal is both cleaner and simpler.

**No hybrid adds value.**

---

## Philosophy Alignment

All 7 relevant principles satisfied:

| Principle | Status |
|---|---|
| Architectural fixes over patches | CLEAR PASS |
| Make illegal states unrepresentable | PASS (parameter removed) |
| YAGNI | PASS (no new config, flags, or types) |
| Determinism | PASS (pure function unchanged) |
| Functional/pure | PASS (renderPendingPrompt still pure) |
| Validate at boundaries, trust inside | PASS (no new defensive checks) |
| Document why not what | REQUIRES: `// WHY:` comment on guard removal |

---

## Findings

### RED (Blocking)
None.

### ORANGE (Required before ship)

**O1: Missing integration test for compaction simulation**
A test that verifies the full scenario (start -> N steps with notes -> context reset ->
continue correctly injects ancestry) does not exist. This is the PRIMARY use case.
Must be added to the implementation task.

### YELLOW (Should fix, not blocking)

**Y1: No performance benchmark note**
No documented trigger for when to evaluate the performance escape hatch (Candidate B).
Add: "if advance latency > 50ms on sessions with 200+ events, evaluate Candidate B."

**Y2: `// WHY:` comment required**
WorkRail codebase convention: non-obvious decisions get a `// WHY:` comment. The guard
removal must include: `// WHY: ancestry recap is always injected to survive context
compaction. See design-docs/context-survival-mvp.md.`

---

## Recommended Revisions

1. **Add integration test** for compaction simulation (ORANGE -- required)
2. **Add `// WHY:` comment** on the guard removal site (YELLOW -- should fix)
3. **Document pivot condition** in implementation notes: if advance latency > 50ms on
   200+ event sessions, evaluate Candidate B (SessionIndex extension) (YELLOW)

---

## Residual Concerns

**No showstoppers.** The design is sound and well-grounded in the existing codebase
infrastructure. The challenge audit found no blocking issues (challenge 2 was a false
positive; the budget contention concern does not apply because step prompt and recovery
section are additive, not competing).

**Confidence: HIGH.** Ready to proceed to resolution and final spec.
