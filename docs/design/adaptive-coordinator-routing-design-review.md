# Adaptive Coordinator Routing -- Design Review Findings

**Status:** Review complete
**Date:** 2026-04-19
**Reviewing:** `docs/design/adaptive-coordinator-routing.md` (selected design: A+E)
**For:** Main agent interpretation and final decision

---

## Tradeoff Review

| Tradeoff | Acceptable? | Condition that breaks it |
|----------|-------------|--------------------------|
| All ambiguous tasks run FULL (wasteful for Medium-complexity refactors) | Yes for MVP | >20% of real tasks are Medium-complexity refactors routed to FULL unnecessarily |
| `routeTask()` filesystem check injectable via `TaskSignals` | Yes | Multiple expensive filesystem signals needed (currently only pitchMdExists) |
| `QUICK_REVIEW` and `REVIEW_ONLY` as separate DU variants | Yes | Behaviors converge to same implementation (trivial merge at that point) |

**Hidden assumptions surfaced:**
1. Discovery and shaping phases produce helpful (not misleading) output for all tasks applied to them
2. `pitchMdExists` is the only filesystem routing signal (future signals added to `TaskSignals`)

---

## Failure Mode Review

| Failure mode | Design handles it? | Missing mitigation | Risk |
|--------------|-------------------|--------------------|------|
| PR number in non-review task misroutes to REVIEW_ONLY | Partially (--mode override exists) | Regex pattern too broad -- bare `#\d+` matches non-PR numbers | LOW-MEDIUM |
| Stale pitch.md routes new task to IMPLEMENT incorrectly | No -- convention not enforced | `runImplementPipeline()` must archive pitch.md after successful coding | MEDIUM |
| FULL pipeline timeout leaves intermediate state | Partial (wall-clock budget mentioned) | Per-phase timeouts not specified; intermediate state cleanup undefined | HIGH |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C+E):** Only element worth borrowing is `TaskSignals` as explicit value object -- already incorporated into design. CLASSIFY_AND_RUN mode correctly excluded (non-determinism + format-parsing fragility + FULL mode redundancy).

**Simpler variant (A without E -- monolithic file):** Would satisfy acceptance criteria but violates open/closed (adding a mode modifies shared file). `pr-review.ts` at 1462 lines for one mode is justification for E's decomposition from day one. Monolithic rejected.

---

## Philosophy Alignment

**All key principles satisfied:** illegal-states-unrepresentable, exhaustiveness, errors-as-data, validate-at-boundaries, determinism-over-cleverness, dependency-injection, YAGNI.

**Two acceptable tensions:**
1. `fileExists()` I/O behind `CoordinatorDeps` injectable -- principle preserved by injection
2. Mode executors are imperative (sequential spawns) -- routing layer is declarative/pure; this is the best achievable split for sequential pipeline coordination

---

## Findings

### RED -- must fix before implementation

**R1: FULL pipeline per-phase timeouts and total budget not specified**

The design says "hardcoded timeouts" but does not specify the values. For a coordinator that chains 4 sessions, this is a required constant before implementation. If the coordinator times out mid-pipeline (after discovery but before coding), the repository is left with a `.workrail/current-pitch.md` file and no implementation -- a silent intermediate state that will misroute the next invocation.

**Required additions to the design:**
```typescript
const DISCOVERY_SESSION_TIMEOUT_MS  = 30 * 60 * 1000;  // 30 min
const SHAPING_SESSION_TIMEOUT_MS    = 30 * 60 * 1000;  // 30 min
const CODING_SESSION_TIMEOUT_MS     = 60 * 60 * 1000;  // 60 min
const REVIEW_SESSION_TIMEOUT_MS     = 20 * 60 * 1000;  // 20 min
const FULL_PIPELINE_MAX_MS          = 160 * 60 * 1000; // 160 min total
const FULL_PIPELINE_SPAWN_CUTOFF_MS = 130 * 60 * 1000; // 130 min (stop spawning new phases)
```

And: `runFullPipeline()` must archive pitch.md if it was produced by shaping but coding times out or fails.

---

### ORANGE -- should fix before implementation

**O1: PR number regex pattern too broad**

Current routing rule: "goal contains PR/MR number" matches any bare `#\d+` in the goal text. This produces false positives for `"refactor PR #47 related auth code"` (wants IMPLEMENT, gets REVIEW_ONLY) or `"fix issue #123 in the auth module"` (wants FULL, gets REVIEW_ONLY).

**Required fix:** Use context-sensitive pattern matching:
- REVIEW_ONLY: `\bPR\s*#\d+\b` or `\bMR\s*!?\d+\b` with leading verb context (`review`, `check`, `approve`, etc.)
- Or more conservatively: require the goal to START with review-intent keywords (`"Review PR #..."`, `"Check MR ..."`) rather than contain a PR number anywhere

Recommendation: the routing function should be aware of ambiguous patterns and log a warning when a PR number is found but no review-intent verb precedes it.

**O2: pitch.md archival not specified**

`runImplementPipeline()` must rename `.workrail/current-pitch.md` to `.workrail/pitches/[timestamp]-[goal-slug]-pitch.md` (or similar) after the coding session completes successfully. Without this, stale pitch files cause incorrect IMPLEMENT routing for subsequent tasks.

The `IMPLEMENT` mode coordinator needs a post-coding cleanup step. This is an implementation detail but must be in the design spec before coding begins.

---

### YELLOW -- nice to fix, non-blocking

**Y1: `QUICK_REVIEW` and `REVIEW_ONLY` distinction underspecified**

The design mentions QUICK_REVIEW uses a "lighter model config" but does not define what "lighter" means -- which model, what `agentConfig` fields, what the expected speed/quality tradeoff is. Before implementing QUICK_REVIEW, define: `{ model: 'amazon-bedrock/claude-haiku-4-5', maxSessionMinutes: 5 }` or equivalent.

**Y2: `TaskSignals` interface not fully specified**

The design refers to `TaskSignals` but does not define all fields. A complete definition is needed before implementation:
```typescript
interface TaskSignals {
  readonly triggerProvider: string;        // 'generic' | 'github_prs_poll' | 'github_issues_poll' | 'gitlab_poll'
  readonly pitchMdExists: boolean;         // .workrail/current-pitch.md exists in workspace
  readonly issueLabels: readonly string[]; // labels from trigger payload (empty if not from polling trigger)
  readonly explicitMode?: string;          // from --mode CLI flag or trigger context variable
}
```

**Y3: `AdaptiveCoordinatorDeps` vs `CoordinatorDeps` relationship**

The design does not specify whether `AdaptiveCoordinatorDeps` extends `CoordinatorDeps` from pr-review.ts or is a separate interface. Recommendation: separate interface that copies shared methods (no inheritance from pr-review.ts since that coordinator's deps are highly specific to PR review). Shared pattern, not shared type.

---

## Recommended Revisions

1. **(RED) Add per-phase timeout constants and intermediate state cleanup to design** -- required before implementation
2. **(ORANGE) Tighten PR number routing regex** -- reduces false positives meaningfully
3. **(ORANGE) Specify pitch.md archival in `runImplementPipeline()`** -- prevents stale routing
4. **(YELLOW) Define `TaskSignals` interface fully**
5. **(YELLOW) Define QUICK_REVIEW model config**
6. **(YELLOW) Specify `AdaptiveCoordinatorDeps` relationship to `CoordinatorDeps`**

---

## Residual Concerns

1. **Discovery/shaping quality for tasks they shouldn't run on.** If `wr.discovery` is unhelpful for "refactor auth.ts" tasks (just produces boilerplate), the FULL default becomes actively harmful, not just wasteful. Monitoring needed in production: log which tasks route to FULL and whether discovery findings are actually used by the shaping phase.

2. **No checkpoint/resume for multi-phase pipeline.** If the coordinator crashes mid-FULL-pipeline, there is no way to resume from the completed phases. The current design requires re-running from the beginning. This is acceptable for MVP but should be tracked as a gap.

3. **The context-passing agent's `adaptive-coordinator-context.md` did not exist at review time.** The assumptions section in the routing design is speculative. If the context-passing design introduces new contracts (e.g., coordinator must inject a `discoveryDoc` at the shaping spawn), the routing design is unaffected (routing is pure, context injection is per-mode), but the mode coordinator implementations need updating.
