# Hypothesis Challenge: PR Review Coordinator HTTP-First Design

*Generated: 2026-04-18*

## Target Claim

The PR review coordinator's HTTP-first design (Candidate B) is sound: the 2-call HTTP notes extraction is reliable, the two-tier keyword parser correctly classifies review severity, and the 5 robustness rules are sufficient.

## Strongest Counter-Argument

`phase-6-final-handoff` has `requireConfirmation: true`. The preferredTipNodeId may point to a checkpoint/confirmation node whose recapMarkdown is sparse or absent, causing the keyword scanner to misclassify clean PRs as 'unknown' and escalate them unnecessarily.

**Verdict:** Mitigated. In autonomous mode, the agent calls `continue_workflow` with substantive notes before the confirmation gate. WorkRail stores these notes as the RECAP payload for the node. The recapMarkdown IS populated for autonomous sessions completing phase-6. The requireConfirmation flag only blocks advancement until notes are written -- which the autonomous agent does.

## Weak Assumptions / Evidence Gaps

1. **`runs[0]` is always the most recent run:** True in practice. WorkRail appends new runs; index 0 is the most recent. Confirmed in worktrain-await.ts pollSession() which uses `runs[0]`.

2. **Keyword scan is context-unaware:** 'blocking' appearing in negative context ('this is not blocking') would trigger a false positive. Mitigation: require BLOCKING keyword to be present without a preceding negation. Simpler: use priority order -- any blocking keyword -> blocking, regardless of context. The conservative default is acceptable.

3. **go/no-go time check needs adaptation:** Rule 3 (don't spawn if remaining time < 20 minutes) was designed for daemon sessions with known maxSessionMinutes. A CLI coordinator has no such limit. Adaptation: track wall-clock time since coordinator start, refuse to spawn new sessions if elapsed > coordinator_max_minutes - 20.

## Likely Failure Modes

1. **recapMarkdown null for final step** -> 'unknown' severity -> escalate (conservative, correct)
2. **Fix-agent loop max 3 passes exceeded** -> escalate after 3 (loop counter enforces this)
3. **ECONNREFUSED on daemon calls** -> early exit with clear error message
4. **Keyword false positive** -> PR escalated as blocking when actually clean (false negative on merge, acceptable)
5. **Merge conflict at merge time** -> `gh pr merge` fails, coordinator reports error and escalates

## Critical Tests

- `parseFindingsFromNotes(null)` -> returns err, classifies as 'unknown'
- `parseFindingsFromNotes(markdown with 'not blocking but...')` -> must NOT return 'blocking'
- Loop counter: 3 passes with persistent minor -> escalate on pass 3, NOT pass 4
- ECONNREFUSED: spawnSession failure propagates cleanly to stderr and exit code 1

## Verdict: Keep

The design is sound. The 2-call HTTP extraction works for autonomous sessions. The two-tier parser with conservative defaults is sufficient. The 5 robustness rules need one adaptation: Rule 3 (go/no-go time check) should use wall-clock time since coordinator start, not daemon session remaining time.

## Next Action

Proceed with Candidate B implementation. Add adaptation to Rule 3: track coordinator wall-clock start time; refuse new spawns if `now() - startTime > (coordinatorMaxMs - 20*60*1000)`. Default coordinatorMaxMs = 90 minutes.
