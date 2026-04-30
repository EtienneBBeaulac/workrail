# Engine Boundary Discovery: SHA Tracking and Layer Architecture

**Date:** 2026-04-30
**Status:** Discovery complete -- recommendation: A now (PR #903), C next
**Goal:** Determine the right architecture for commit SHA tracking and clarify engine/coordinator/delivery layer boundaries

---

## Problem Understanding

### The Real Problem
The engine emits `run_completed` at step T. The delivery pipeline commits to git at step T+1. There is no mechanism to communicate back from T+1 to T. Agent self-reporting of `metrics_commit_shas` was the broken workaround.

### Core Tensions
1. **Information completeness vs engine purity**: commits only exist after delivery, which is after `run_completed`
2. **YAGNI vs architectural completeness**: MCP sessions may not need SHA tracking right now
3. **Port purity vs pragmatism**: `outcome-success.ts` already calls `execFile` directly for `endGitSha` -- known violation
4. **Atomic delivery vs distributed write-back**: appending after `run_completed` requires the session gate to remain open

### What Makes This Hard
The gap is temporal. Information that belongs to session T becomes available at T+1. The event log is append-only but NOT closed after `run_completed` -- `ExecutionSessionGateV2` gates on `healthy` vs `corrupt`, not on completion state. Post-completion appends ARE valid.

---

## Architecture Contract (what exists, what's missing)

### Engine owns (src/v2/durable-core/ + src/mcp/handlers/):
- Session lifecycle (start, advance, checkpoint, resume)
- HMAC token protocol -- cryptographic enforcement
- Append-only event log with crash-safe writes
- Port abstractions for all I/O (no direct fs/git/network calls in engine)
- Projections: reads event log, produces typed views
- **Records observations it can make directly**: git_branch, git_head_sha (via WorkspaceContextResolverPortV2 at START); endGitSha (via execFile direct call at END -- known port violation)

### Coordinator/delivery layer owns (src/trigger/ + src/daemon/):
- Git commits, pushes, PR creation
- Delivery pipeline stages
- SHA extraction from `git commit` output
- Proof records, pipeline orchestration (future)
- Agent loop, context injection, crash recovery

### The gap:
No mechanism for the delivery layer to record its observations (what it committed) back into the session event log.

---

## Philosophy Constraints

- **Architectural fixes over patches**: always-empty is a patch; extending the port is the fix
- **Dependency injection for boundaries**: git I/O must be behind a port in the engine layer
- **Make illegal states unrepresentable**: `captureConfidence: 'high'` with `agentCommitShas: []` is already schema-enforced as invalid
- **Validate at boundaries, trust inside**: SHA derivation must happen at the git boundary, never from agent memory
- **YAGNI with discipline**: don't build write-back infrastructure until coordinators actually consume it

---

## Candidates

### A: Always-empty (current PR #903)
Engine emits `agentCommitShas: []` and `captureConfidence: 'none'` always. Console shows no SHAs. Coordinator scripts derive SHAs from `git log startSha..endSha` themselves.

- **Tensions resolved**: engine purity, illegal states, YAGNI
- **Tensions accepted**: information completeness, worktree-after-cleanup risk
- **Failure mode**: worktree cleaned up before coordinator script runs `git log`
- **Scope**: best-fit immediate fix; patch not architectural fix
- **Philosophy**: honors YAGNI, make-illegal-states-unrepresentable. Conflicts with architectural-fixes-over-patches.

### B: Delivery write-back via DeliveryStage
New 5th DeliveryStage appends `observation_recorded` event with `git_commit_shas` to session event log after successful `git commit`. Requires injecting `SessionEventLogAppendStorePortV2` into `DeliveryPipeline`.

- **Tensions resolved**: information completeness (daemon sessions), crash safety (stage before sidecar delete)
- **Tensions accepted**: delivery-action API change (new session store dependency); MCP sessions still get no SHAs
- **Failure mode**: append fails silently if session health degraded (must be best-effort, never abort delivery)
- **Scope**: best-fit for daemon/autoCommit sessions; accepted gap for MCP
- **Philosophy**: honors architectural-fixes-over-patches, dependency-injection. Mild YAGNI tension.

### C: Extend WorkspaceContextResolverPortV2 with end-state (port-correct fix)
Add `resolveEndState(repoRoot, startSha) -> { endSha, commitShas }` to the workspace anchor port (or create `GitSnapshotPortV2`). Inject into `outcome-success.ts`. Runs `git rev-parse HEAD` + `git log startSha..HEAD --format=%H` in parallel. `run_completed` event gets `commitShas: string[]` field.

- **Tensions resolved**: engine purity (eliminates execFile violation), information completeness (all session types), MCP + daemon covered
- **Tensions accepted**: run_completed schema gets new field; old sessions project `commitShas: []` (non-breaking)
- **Failure mode**: `git log startSha..HEAD` may include merge commits or upstream advances; use `--no-merges --first-parent` to scope
- **Scope**: slightly broader than needed (touches port contract) but correct -- each piece is load-bearing
- **Philosophy**: honors architectural-fixes-over-patches, dependency-injection-for-boundaries, make-illegal-states-unrepresentable.

### D: Delivery sidecar store (reframe -- REJECTED)
Delivery writes `delivery-result-<sessionId>.json` sidecar. Session-metrics reads from both event log and sidecar. REJECTED: violates single-source-of-truth principle for the event log. Two truth sources for SHA data is architecturally unsound for this codebase.

---

## Comparison and Recommendation

**Recommendation: A now (PR #903 as-is), C next.**

C is the architectural ideal because:
1. Solves both problems simultaneously: SHA gap AND the existing execFile violation in outcome-success.ts
2. Works for ALL session types (MCP + daemon) without special-casing
3. Follows the port pattern the codebase is designed around
4. run_completed is the correct home -- startGitSha is already there, endGitSha is already there, commitShas belongs alongside them

B is viable but inferior: adds a session store dependency to the delivery layer (which currently has none), only covers daemon/autoCommit sessions, and has a semantic question (delivery artifacts vs session truth).

A is correct as the IMMEDIATE state. PR #903 should merge. It makes the illegal state (high confidence + empty SHAs) impossible, and clears the field for C.

**The original question -- do we need to split the engine? -- is NO.** The current architecture is sound. The fix is a port extension, not a structural split.

---

## Self-Critique

**Strongest counter-argument against C**: run_completed schema migration. Existing stored events lack `commitShas`. Rebuttal: session-metrics projection already handles absent fields (defaults to []). Adding `commitShas?: string[]` is non-breaking additive.

**What would tip to B**: if daemon sessions with autoCommit dominate and MCP sessions never need SHAs. Currently autoCommit is daemon-only, so B's coverage gap is acceptable. But if MCP sessions start running in worktrees with autoCommit, B becomes wrong.

**Invalidating assumption**: if `git log startSha..HEAD` includes upstream merge commits, SHAs from unrelated PRs land in the session's record. Mitigation: `--no-merges --first-parent` in the port implementation.

---

## Open Questions

1. Should `GitSnapshotPortV2` be a new port or an extension of `WorkspaceContextResolverPortV2`? New port has cleaner separation; extension avoids proliferating ports.
2. What is the right git log filter for commit SHAs: `--no-merges`, `--first-parent`, both? Depends on whether merge commits from squash-merge PRs should be included.
3. Should Candidate C be implemented now (before PR #903 merges) or after? After is safer -- PR #903 is already in CI, touching outcome-success.ts again would create a dirty merge.
