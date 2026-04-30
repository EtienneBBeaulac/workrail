# Engine Boundary Discovery: Design Review Findings

**Date:** 2026-04-30
**Decision:** A now (PR #903), C next (GitSnapshotPortV2)
**Confidence:** HIGH

---

## Tradeoff Review

| Tradeoff | Acceptable? | Invalidating condition |
|---|---|---|
| Console shows empty SHAs until C is built | Yes -- empty is honest, no current consumer needs populated SHAs | Proof records feature built before C |
| MCP sessions get no SHAs under A-only | Yes -- human can check git; MCP is not the autonomous use case | MCP sessions start requiring attribution for proof records |
| run_completed schema gets optional field | Yes -- non-breaking additive change; old sessions project [] | Schema versioning feature enforces strict field presence |

All tradeoffs acceptable under current conditions.

---

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| git log includes upstream merge commits | Mitigate with `--no-merges --first-parent` in port implementation | MEDIUM -- must be in the implementation spec |
| outcome-success.ts partial failure (endGitSha or commitShas fails) | Promise.all + best-effort; both degrade to null/[] independently | LOW -- same behavior as current resolveEndGitSha |

**Highest-risk**: FM1. Must specify `--no-merges --first-parent` explicitly in Candidate C implementation.

---

## Runner-up / Simpler Alternative Review

- B (delivery write-back): no elements worth borrowing. Its coupling (session store injected into delivery layer) is the problem C avoids.
- Simpler C variant (fix execFile violation only, skip commitShas): would require a second port extension later. Marginal cost of doing both at once is low. Not simpler enough to justify the incompleteness.
- No hybrid warranted. A-then-C sequencing is correct.

---

## Philosophy Alignment

**Satisfied**: make-illegal-states-unrepresentable, validate-at-boundaries, errors-as-data, dependency-injection-for-boundaries, architectural-fixes-over-patches.

**Under acceptable tension**: YAGNI (building port before proof records consume it -- justified by dual purpose: also fixes execFile violation). Immutability (appending to completed session -- design-correct, session gate confirms).

---

## Findings

### YELLOW: git log filter not specified
The implementation of Candidate C's `resolveCommitShaRange` must use `--no-merges --first-parent` to avoid including upstream merge commits. This is not currently specified anywhere. Without it, sessions on branches with merge commits from main would record incorrect SHAs.
**Action**: add explicit filter spec to the Candidate C implementation ticket.

### YELLOW: No forcing function to build C after A merges
PR #903 will merge. C is the architectural fix. Without a ticket, C may never get built and the console SHA display stays empty indefinitely.
**Action**: create a GitHub issue for Candidate C immediately after PR #903 merges.

---

## Recommended Revisions to Selected Design

1. Before implementing C: specify `--no-merges --first-parent` as the required git log filter in the issue description
2. New port name: `GitSnapshotPortV2` is cleaner than extending `WorkspaceContextResolverPortV2` -- keeps the end-state capture concern separate from the start-state anchor concern
3. New method signature: `resolveEndSnapshot(repoRoot: string, startSha: string): Promise<{ endSha: string | null, commitShas: string[] }>`
4. In `outcome-success.ts`: replace `resolveEndGitSha` with `resolveEndSnapshot` -- single port call that returns both `endGitSha` and `commitShas` in parallel

---

## Residual Concerns

- **Architecture contract not written**: the meta-fix (documenting what the engine layer owns vs coordinator/delivery) has not been done. This is the most important long-term outcome from this discovery. Without it, future contributors will make the same boundary violations. Should be added to `docs/design/v2-core-design-locks.md`.
- **C has open design question**: `GitSnapshotPortV2` vs extension of `WorkspaceContextResolverPortV2`. Both work. `GitSnapshotPortV2` is slightly cleaner (separate port, separate concern). Decision can be made at implementation time.
