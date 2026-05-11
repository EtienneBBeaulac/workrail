# Human Sign-off: OpenClaw vs WorkTrain Competitive Analysis

**Date:** 2026-05-07
**Reviewer:** Etienne Beaulac

---

## Verdict changes

None. All verdicts confirmed as-is:
- urgent: ContextEngine, unified trajectory schema, worktrain doctor
- changes-positioning: distribution gap / coding-agent skill risk
- backlog: SQLite registry, subagent roles, commitment extraction, prompt cache, workspace inheritance, restart handoff, coding-agent follow-up
- ignore: MIT license risk, dependency risk

## Adversarial points

Both reviewer notes **accepted**:

1. **E11 fragile moat (accepted):** The "OpenClaw rejects hierarchy" moat is acknowledged as weak. It holds only while their VISION holds. Kept as backlog pending the `skills/coding-agent/` follow-up read. Escalation trigger: if directory contains multi-phase step enforcement logic, move `coding-agent` follow-up and distribution gap to urgent.

2. **ACH Alternative B unsupported (accepted):** No documented examples of WorkTrain's typed-phase contracts catching a failure that a flat agent would have missed. This is a real gap in the positioning claim. Backlog item: document at least 3 real session examples where crash recovery, worktree isolation, or typed contracts demonstrably prevented a failure mode.

## Staleness threshold

**90 days confirmed.** Analysis expires: **2026-08-05.**

Primary re-read trigger (before 90 days): if `skills/coding-agent/` contents change materially in OpenClaw's main branch, re-run from step 2.
