# Discovery Loop Fix -- Design Review Findings

**Date:** 2026-04-21
**Selected direction:** Candidate 2 -- complete fix set (Fix 1+2+3)
**Context:** Review of tradeoffs, failure modes, and philosophy alignment for the selected direction.

---

## Tradeoff Review

| Tradeoff | Verdict | Condition that makes it unacceptable |
|---|---|---|
| Interface signature change to `CoordinatorDeps.spawnSession` (5th optional param) | Acceptable | If test fakes use `as unknown as CoordinatorDeps` casts that miss the new param |
| Sidecar write is new I/O (fire-and-forget) | Acceptable | If `~/.workrail/` is on a slow mount; negligible on local disk |
| Permanent `worktrain:blocked` label on first escalation | Acceptable for this incident (13 consecutive timeouts) | Would be unacceptable for a single transient failure |

---

## Failure Mode Review

| Failure mode | Coverage | Missing mitigation | Risk |
|---|---|---|---|
| GitHub API error on label write propagates to daemon | Partial -- outer `void` swallows it but log is confusing | Add explicit `catch` on label write with structured log entry `[QueuePoll] label-write-failed #N` | Medium |
| Escalation label not in `queueConfig.excludeLabels` | Not enforced | Use `worktrain:in-progress` (already excluded) OR add startup assertion | **High** |
| `agentConfig` threading missed for shaping/coding spawn sites | Not enforced by TypeScript | Code review checklist item for all 3 spawn sites | Medium |

**Most dangerous:** Failure mode 2. If the label name is not in `excludeLabels`, Fix 2 applies the label visibly but has zero effect on re-selection. The loop continues and the operator sees a confusing state.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate 1, Fix 2 only):** Deployable faster but operationally worse in production -- every new issue through FULL mode gets permanently labeled after first escalation. Ruled out as standalone deployment.

**Hybrid opportunity:** Deploy Fix 2 in PR #1 (immediate loop stop), then Fix 1+3 in PR #2. The two PRs are independent. This captures Candidate 1's deployment velocity without sacrificing Candidate 2's completeness.

**Label simplification:** Using `worktrain:in-progress` as the escalation label instead of `worktrain:blocked` eliminates the highest-risk failure mode (failure mode 2) at no cost. Slightly wrong semantic (issue is not in progress after escalation) but pragmatically correct. Recommended.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Type safety as first line of defense | Restored by removing `Promise<unknown>` cast |
| Exhaustiveness everywhere | Partially satisfied -- `merged` and `dry_run` cases need explicit handling even if they are no-ops |
| Errors are data | Satisfied -- PipelineOutcome is used, not discarded |
| Make illegal states unrepresentable | Under tension -- timeout mismatch becomes structurally bounded but not fully eliminated |
| Architectural fixes over patches | Under tension -- Candidate 3 (coordinator-owns-termination) is the correct architectural direction; this fix patches the poller boundary |
| YAGNI with discipline | Satisfied -- Fix 3 is low-cost and addresses a real crash scenario |

---

## Findings

### RED

**Finding R1: Escalation label not in excludeLabels is a silently ineffective fix**
If `worktrain:blocked` (or whatever label is applied on escalation) is not present in `queueConfig.excludeLabels`, Fix 2 writes the label to GitHub but has no effect on re-selection. The loop continues. The operator sees a label but no behavioral change. This is the most dangerous failure mode.
- **Mitigation:** Use `worktrain:in-progress` (already in excludeLabels) as the escalation label, or add a startup runtime assertion.

### ORANGE

**Finding O1: Fix 2 `.then()` handler needs explicit `catch` on label write**
An unhandled rejection from the GitHub API call inside `.then()` could produce a confusing unhandled-rejection warning. The daemon will not crash (outer `void` catches it), but the error will not be logged structurally.
- **Mitigation:** Add `try/catch` around the label write with `console.warn('[QueuePoll] label-write-failed #N ...')`.

**Finding O2: Exhaustiveness in `.then()` outcome handler**
The `.then((outcome) =>` handler should handle all three `PipelineOutcome` kinds explicitly: `escalated` (apply label), `merged` (log success), `dry_run` (log, no action). Without exhaustive handling, a future change to `PipelineOutcome` could silently skip new outcome kinds.
- **Mitigation:** Add explicit case for `merged` and `dry_run` (even if they are just console.log calls) so TypeScript enforces exhaustiveness on future changes.

**Finding O3: Fix 1 must cover all three spawn sites**
The `agentConfig` threading must be applied to `wr.discovery` (55 min), `wr.shaping` (35 min), and `wr.coding` (65 min) spawn sites in `full-pipeline.ts`. Omitting any one results in that phase inheriting the 30-minute default.
- **Mitigation:** Code review checklist; confirm all three TIMEOUT constants are passed.

### YELLOW

**Finding Y1: Permanent label may be too aggressive for transient failures**
A network outage or rate limit error would trigger the same `worktrain:blocked` label as a structural failure. For a production system with many issues, this creates operational toil.
- **Mitigation (follow-on):** Add an N-strike mechanism (label only after 3+ consecutive escalations). Out of scope for incident fix.

**Finding Y2: Sidecar file naming convention is undocumented**
The proposed `-queue.json` suffix distinguishes issue-ownership sidecars from session sidecars, but there is no comment in `checkIdempotency` explaining the naming convention.
- **Mitigation:** Add a comment to `checkIdempotency` noting that `*-queue.json` files are issue-ownership sidecars written by the queue poller.

---

## Recommended Revisions

1. **Use `worktrain:in-progress` as the escalation label** (not a new `worktrain:blocked` label) to eliminate Finding R1. If semantics matter, remove `worktrain:in-progress` and add a new label in the same config change -- but do not deploy label application before config verification.

2. **Add explicit `catch` on label write** inside `.then()` handler (Finding O1).

3. **Handle all three `PipelineOutcome` kinds** in the `.then()` handler (Finding O2).

4. **Verify all three spawn sites** in `full-pipeline.ts` during code review (Finding O3).

5. **Deploy as two sequential PRs:** Fix 2 first (loop stop), then Fix 1+3 (completeness). This makes the loop fix independently verifiable.

---

## Residual Concerns

- **Coordinator-owns-termination (Candidate 3)** is the architecturally correct long-term design. The current fix patches the poller. This should be logged as technical debt.
- **N-strike mechanism** for label application would reduce operational toil for transient failures. Worth a follow-on issue.
- **Full-pipeline.ts spawn sites** should be verified during implementation -- the investigation docs describe them but line numbers were not directly verified in this session.
