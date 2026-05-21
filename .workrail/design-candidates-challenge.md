# Hypothesis Challenge: Removing `requireConfirmation` from `wr.mr-review` phase-6

**Date:** 2026-05-20
**Challenger workflow:** `wr.routine-hypothesis-challenge`
**Target candidate:** Candidate A -- remove `requireConfirmation: { kind: 'human_approval' }` from `phase-6-final-handoff` entirely

---

## Target Claim

Candidate A is correct: removing `requireConfirmation` from `phase-6-final-handoff` in `wr.mr-review` allows coordinator-spawned sessions to return `wr.review_verdict` to the parent (fixing C1), while GitHub draft review invisibility provides sufficient safety (C2), and no meaningful work is lost because `resumeFromGate()` does nothing useful anyway.

---

## Strongest Counter-Argument

**Candidate A treats a documented temporary hack as a permanent design decision.**

The `awaitSessions()` implementation in `coordinator-deps.ts` (lines 308-311) explicitly comments: *"Gate checkpoint: treat as terminal for now. PR 2 will dispatch the gate evaluator."* The `paused_at_gate` -> `outcome: 'failed'` mapping is a known, acknowledged workaround -- not an architectural invariant. Candidate A removes the gate (the symptom) rather than fixing the coordinator's gate evaluation (the root cause). Candidate B is the principled fix: it wires `paused_at_gate` to a `coordinator_eval` gate evaluation, making the session properly terminal-success so `getAgentResult()` can read the `wr.review_verdict` artifact. Removing the gate because the coordinator cannot handle it is an architectural patch, not an architectural fix.

**Secondary: the draft posting -> verdict routing ordering is already broken for all wr.mr-review sessions**, not just gate-parked ones. The delivery adapter fires fire-and-forget AFTER `runWorkflowFn` returns in `TriggerRouter`. The coordinator calls `getAgentResult()` before the draft is posted. This means Candidate A does not introduce a new race -- it already exists. But it also means the C2 "draft invisibility" safety argument was never what the gate was providing. The gate was providing session-level durable state: the `review_draft_submitted` event in the WorkRail session log, and the operator-driven `resumeFromGate()` call that advances the terminal step. Removing the gate removes this durable record.

---

## Weak Assumptions / Evidence Gaps

1. **"GitHub drafts are invisible" is partially true, not a platform guarantee.** PENDING drafts are invisible in the GitHub UI to PR authors and reviewers. They are NOT invisible to the GitHub REST API -- any automation with repo read access can enumerate PENDING draft reviews. In organizations with CI bots or review automation this is a real exposure. This is an organizational dependency masquerading as a platform safety property.

2. **"resumeFromGate() does no meaningful work" is correct for the current session but wrong for observability.** The gate resume call writes a `review_draft_submitted` event to the WorkRail session log. Removing the gate removes this record. For standalone sessions (not coordinator-spawned), this is the only durable signal that the operator actually published the review. WorkRail would lose the ability to distinguish "review was drafted and abandoned" from "review was drafted and published."

3. **The C1 bug fix is real but mis-attributed.** The coordinator cannot read `wr.review_verdict` because `getAgentResult()` is only called for sessions where `awaitSessions()` returns `success`. A gate-parked session returns `failed` and the coordinator escalates before calling `getAgentResult()`. Candidate A fixes this by making the session succeed -- but Candidate B fixes it by making `paused_at_gate` sessions evaluable and eventually terminal-success. The attribution of "removing the gate fixes C1" is correct only if the coordinator's gate evaluation path is never going to be built.

---

## Likely Failure Modes if Candidate A is Adopted

| Failure Mode | Severity | Likelihood |
|---|---|---|
| Organization adds API-level review monitoring; PENDING drafts are now visible to automation before operator review | Medium | Low-Medium |
| Operator never publishes a draft review; no durable record in WorkRail that it was abandoned | Low | High (this is normal usage) |
| `wr.gate-eval-generic` is built later for other gates; `wr.mr-review` has no mechanism to opt in without a workflow version bump | Medium | High |
| Coordinator pipeline auto-merges based on `wr.review_verdict: clean`, but the GitHub draft (posted asynchronously) contains blocking findings the coordinator never saw | High | Low (requires review agent to produce inconsistent artifact vs findings) |

---

## Alternative Explanations

**Why the gate looks safe to remove:**
The current gate's only observable effect is delaying the `gate_parked` -> `failed` coordinator escalation path. Since the draft is posted before the gate fires and `resumeFromGate()` advances only the terminal step, it appears to do nothing useful in autonomous mode. This appearance is correct for the coordinator scenario but incorrect for the standalone and observability scenarios.

**Why Candidate C is the right pragmatic choice:**
- `verdict: clean` and `verdict: minor` reviews have no high-severity findings. The probability that an autonomous draft of a clean review would embarrass the organization if seen early is very low.
- `verdict: blocking` reviews contain Critical or Major findings. These are exactly the reviews where organizational safety concerns are highest: the content could unfairly characterize a developer's work, could be based on a false-positive finding, or could trigger a PR close before the author has a chance to respond.
- Candidate C preserves the gate exactly where its C2 value is highest (blocking verdicts) while removing it where it only causes C1 problems (clean/minor verdicts).

---

## Critical Tests

To verify Candidate A is wrong (not merely suboptimal):

1. **Test:** Run a standalone `wr.mr-review` session via a webhook trigger configured with `github_draft_review` delivery. The operator never submits the draft. After 30 days, query the WorkRail session store for whether the review was published. **Expected (Candidate A):** session store shows `complete` with no publication record. Operator has no audit trail. **Expected (Candidate B/C):** session store retains `gate_parked` state, startup recovery detects the abandoned gate, and an escalation is posted to the outbox.

2. **Test:** Run `wr.mr-review` as a coordinator child session (FULL pipeline Stage 7). The review agent produces `verdict: blocking`. With Candidate A: the coordinator reads the `blocking` verdict, runs `runAuditChain()`, and posts the draft -- which now has no operator-approval gate. The draft could contain findings that were contradicted by the audit chain. **Expected (Candidate C):** blocking verdicts still trigger the gate; the draft is never posted without operator review.

3. **Architectural test:** Add a `review_draft_submitted` event query to WorkRail console. With Candidate A, this query returns nothing for sessions where the operator chose not to publish. With Candidate B/C, the gate state is preserved until the operator acts or the session times out.

---

## Verdict: Revise (reject Candidate A as-is; prefer Candidate C as pragmatic, Candidate B as principled)

**Reject Candidate A for three reasons:**
1. It papers over a documented temporary architectural hack (`awaitSessions()` PR 2 comment) instead of fixing it.
2. It removes the only durable record of operator gate-resume in standalone sessions.
3. It makes the safety property irrecoverable -- once the gate is gone, blocking-verdict sessions have no operator review step without a workflow version bump.

**Recommend Candidate C** as the pragmatic path:
- Remove the gate for `clean` and `minor` verdicts (satisfies C1, C3, C5 for the common case)
- Retain the gate for `blocking` verdicts (preserves C2 where it matters most)
- Implement as a conditional `requireConfirmation` using the existing `{ or: [...] }` pattern already used in the workflow (see `phase-0-understand-and-classify` and `phase-5-final-validation`)

**Recommend Candidate B** as the principled long-term path:
- Fix `awaitSessions()` to properly evaluate `paused_at_gate` sessions via `wr.gate-eval-generic`
- Once the coordinator can evaluate gates, `requireConfirmation` in `wr.mr-review` becomes a quality checkpoint rather than a C1 bug

---

## Next Action

If the team proceeds with Candidate A: add an explicit comment to the workflow documenting the lost audit trail property and add a `postToOutbox` call in the delivery adapter when `resumeFromGate` would have fired. This partially restores observability.

If the team proceeds with Candidate C: implement conditional `requireConfirmation` using `{ var: 'verdict', equals: 'blocking' }` in the step definition. Verify via lifecycle tests that `clean` and `minor` verdict sessions complete without gate, and `blocking` verdict sessions park at the gate.

If the team proceeds with Candidate B: wire the `paused_at_gate` -> `coordinator_eval` path in `awaitSessions()` (the PR 2 comment). This fixes the root cause and makes `requireConfirmation` safe to keep in the workflow for all verdict types.
