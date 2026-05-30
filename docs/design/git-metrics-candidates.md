# Git Metrics Collection -- Design Candidates

*Pre-registered before implementation. Main agent synthesis.*

---

## Constraint Orientation

Before candidates, each [TEAM_RULE] and [CONVENTION] constraint is applied:

- [TEAM_RULE] run_completed schema must NOT change -- **rules out** any candidate that adds `captureConfidence: 'partial'` to the run_completed event; partial stays in git_metrics_recorded only.
- [TEAM_RULE] Git diff must be fire-and-forget AFTER lock release -- **rules out** any candidate that reads the diff inside outcome-success.ts (inside the session lock).
- [TEAM_RULE] All git commands need explicit timeouts -- **all candidates** must pass timeout arguments to execFile calls.
- [TEAM_RULE] Diff output truncated at ~10k lines with `truncated: true` -- **all candidates** must implement line-count truncation.
- [CONVENTION] New events follow `DomainEventEnvelopeV1Schema.extend({ kind: z.literal('...'), ... })` pattern -- **all candidates** must register events this way.
- [CONVENTION] New EVENT_KIND constants added to the EVENT_KIND object (SCREAMING_SNAKE_CASE key, snake_case value) -- **all candidates** must add GIT_START_RECORDED and GIT_METRICS_RECORDED.
- [CONVENTION] Fire-and-forget appended to the sequential async IIFE using `await` (not concurrent void calls) -- **all candidates** must chain `await recordGitMetrics(...)` after the existing await calls.
- [CONVENTION] Git reader uses execFile not exec for commands with user-controlled content -- **all candidates** must use execFile.
- [CONVENTION] Reader placed in `src/mcp/git-metrics/reader.ts` (sibling to `src/mcp/client-usage/reader.ts`) -- **all candidates** share this location.

---

## Real Tensions

1. **Additive schema purity vs. data consolidation.** The cleanest data model would put all git info in one event (`git_metrics_recorded` only, capturing both start and end state). But start-time dirty state is only available at workflow start, not completion. Splitting into two events (`git_start_recorded` for baseline, `git_metrics_recorded` for diffs) is architecturally correct but adds event registration overhead.

2. **captureConfidence type scope vs. backward compat.** Adding `'partial'` to captureConfidence on `run_completed` would fix the existing bug site most directly. But it requires changing the `run_completed` schema (a [TEAM_RULE] violation) and adding a superRefine for partial. Keeping the fix confined to `git_metrics_recorded` (a new event) preserves backward compat but leaves the `outcome-success.ts` captureConfidence bug still present (permanently `'none'`).

3. **Projection complexity vs. backward compat.** `SessionMetricsV2` could get a clean unified `gitEvidence` field (preferred) or the projection could try to synthesize from old `run_completed` fields + new events simultaneously, increasing complexity.

4. **Reader purity vs. testability.** Pure async functions with execFile are easy to unit-test (mock execFile). A class-based reader with injected shell adapter is more testable with fakes but adds ceremony that violates YAGNI for this size of module.

---

## Candidates

### Candidate A: Minimal patch (no new events)

**Summary:** Fix the `captureConfidence` bug in `outcome-success.ts`, extend `git diff` to run fire-and-forget by adding it after the session lock, store results directly in `context_set` (like agent-reported metrics), and extend `SessionMetricsV2` to read them.

**Tensions resolved:** Simplest change. No new event schema registration.

**Tensions accepted:** Uses `context_set` (untyped JsonValue) as git metrics carrier -- violates "prefer explicit domain types". Conflicts with PHILOSOPHY constraint 2 (GitEvidence must be explicit domain type). Projection boundary is still untyped at storage.

**Constraint satisfaction:**
- [TEAM_RULE] run_completed unchanged: YES
- [TEAM_RULE] fire-and-forget after lock: YES
- [PHILOSOPHY] explicit domain types: NO -- context_set carries JsonValue

**VERDICT: Disqualified.** Violates PHILOSOPHY constraint 2 (explicit domain types). context_set is the wrong carrier for engine-authoritative structured data.

---

### Candidate B: Two new events, gitEvidence projection (RECOMMENDED)

**Summary:** Add `git_start_recorded` and `git_metrics_recorded` as new event schema members in `DomainEventV1Schema`. Add `GIT_START_RECORDED` and `GIT_METRICS_RECORDED` to EVENT_KIND. Build `src/mcp/git-metrics/` with `types.ts`, `reader.ts`, `record.ts`, `index.ts`. Wire `recordGitStart` fire-and-forget in `handleV2StartWorkflow`. Wire `recordGitMetrics` appended to the existing sequential async IIFE in `handleV2ContinueWorkflow`. Extend `SessionMetricsV2` with `gitEvidence: GitEvidence | null`. Fix captureConfidence in `outcome-success.ts` to produce correct 'high'/'none' even without changing the schema (endSha !== null && commitShas.length > 0 check). Add `'partial'` only to the new `git_metrics_recorded` event schema's captureConfidence field.

**Tensions resolved:** Type safety (explicit GitEvidence domain type), backward compat (no run_completed schema change), deterministic fire-and-forget (established pattern), reader purity (pure async functions).

**Tensions accepted:** Two event registrations (minor overhead). captureConfidence enum is now diverged between run_completed ('high'|'none') and git_metrics_recorded ('high'|'partial'|'none') -- slight inconsistency but necessary for backward compat.

**Constraint satisfaction:**
- [TEAM_RULE] run_completed unchanged: YES -- schema untouched
- [TEAM_RULE] fire-and-forget after lock: YES -- both record calls are outside the session lock
- [TEAM_RULE] explicit timeouts: YES -- 10000ms for diff, 5000ms for status/log
- [TEAM_RULE] truncation at ~10k lines: YES -- reader checks line count
- [CONVENTION] DomainEventEnvelopeV1Schema.extend pattern: YES
- [CONVENTION] EVENT_KIND constant: YES
- [CONVENTION] sequential async IIFE await: YES
- [CONVENTION] execFile not exec: YES
- [CONVENTION] reader placement: YES
- [PHILOSOPHY] explicit domain types: YES -- GitEvidence is a named typed interface
- [PHILOSOPHY] errors are data: YES -- readers return null on failure, never throw
- [PHILOSOPHY] pure functions: YES -- reader.ts is pure async, no class

**VERDICT: Recommended.** Fully satisfies all constraints with the smallest surface area expansion.

---

### Candidate C: Single event (`git_session_recorded`), start state embedded

**Summary:** Capture start dirty state synchronously inside `executeStartWorkflow` (before returning), store it in the session as a single `git_session_recorded` event that is updated at completion using an event amendment pattern.

**Tensions resolved:** One event registration instead of two.

**Tensions accepted:** Events in the session store are append-only -- "amending" an event requires a new event with a reference to the original, adding complexity. Capturing synchronously at start potentially slows the start response (violates fire-and-forget requirement). Start state capture inside the session lock is a [TEAM_RULE] violation.

**Constraint satisfaction:**
- [TEAM_RULE] fire-and-forget after lock: NO -- synchronous start capture is inside the lock
- [TEAM_RULE] run_completed unchanged: YES

**VERDICT: Disqualified.** Violates [TEAM_RULE] for fire-and-forget (synchronous git I/O at session start would block the response).

---

### Candidate D: Candidate B + captureConfidence fix on run_completed schema

**Summary:** Same as Candidate B, but also extends run_completed schema to allow `'partial'` in captureConfidence, updating the superRefine accordingly.

**Tensions resolved:** Unifies captureConfidence semantics across both events; fixes the bug at its root site in outcome-success.ts with full type support.

**Tensions accepted:** Requires modifying run_completed schema -- a [TEAM_RULE] violation.

**Constraint satisfaction:**
- [TEAM_RULE] run_completed unchanged: NO -- schema extended with 'partial'

**VERDICT: Rejected.** The schema change has downstream consequences (any parser that parses old events with 'partial' must handle the new enum value). AGENTS.md explicitly states run_completed schema must not change. The fix is better done in the new event only.

---

## Constraint Satisfaction Matrix

| Constraint | Candidate A | Candidate B | Candidate C | Candidate D |
|---|---|---|---|---|
| run_completed unchanged [TEAM_RULE] | YES | YES | YES | NO |
| fire-and-forget [TEAM_RULE] | YES | YES | NO | YES |
| explicit domain types [PHILOSOPHY] | NO | YES | YES | YES |
| errors are data [PHILOSOPHY] | YES | YES | YES | YES |
| DomainEventEnvelopeV1Schema.extend [CONVENTION] | N/A | YES | YES | YES |
| execFile not exec [CONVENTION] | YES | YES | YES | YES |

---

## Recommendation

**Candidate B** is the only candidate that satisfies all constraints without violating any [TEAM_RULE] or [CONVENTION]. Candidates A, C, and D each have a disqualifying violation. Candidate B resolves the captureConfidence bug at the correct scope (new event only), preserves backward compat for old sessions, and follows the established fire-and-forget pattern exactly.
