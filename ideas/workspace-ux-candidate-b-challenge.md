# Hypothesis Challenge: Workspace UX Candidate B

*Adversarial review. Goal: break it or confirm it.*

---

## Target Claim

Repo sections (Candidate B) is the correct redesign for the WorkRail console Workspace tab:
replace Active/Recent split with repo-grouped sections (header conditional on 2+ repos),
compact rows sorted by status/activity, and remove FeaturedCards entirely.

---

## Strongest Counter-Argument

**B is a pure regression for single-repo users, and there is no evidence single-repo is not the majority.**

The entire restructuring -- repo sections, conditional headers, new sort logic, FeaturedCard
removal -- is motivated by multi-repo users. If 80%+ of WorkRail users work in one repo,
the UI changes as follows for them:

- No section header is shown (conditional on 2+ repos)
- Active/Recent distinction is gone
- FeaturedCard recap (220-char 'what was the agent doing?') is gone from the default view
- Interaction model shifts from 'scan and recognize' to 'click each branch to remember'

The net result for the majority: **everything costs more, nothing is gained.**

The document's self-critique acknowledges this but dismisses it as 'B mostly removes two section
headers.' That framing ignores the FeaturedCard removal entirely. The dismissal is only valid if
recap loss is acceptable -- which is exactly the weakest assumption in the design.

---

## Weak Assumptions and Evidence Gaps

### 1. Recap loss is recoverable via expand
This assumption is load-bearing and unsupported. The FeaturedCard recap is not decoration;
it is the primary cognitive handoff signal when a user returns after an interruption.
'Click to expand' changes the session-resumption flow from 'scan 5 rows in 10 seconds'
to 'click and read 5 rows sequentially.' For 4-5 active sessions, that is 4-5 extra
interactions just to re-orient. The design treats this as minor friction. It may be the
defining UX failure.

The document's own mitigation ('add one-line recap subtitle to compact rows') is deferred
to 'if users report.' If the subtitle is the fix, it should be in the proposal from day one.
Deferring it uses user complaints as a detection mechanism for a known flaw.

### 2. Multi-repo is the primary use case
No user distribution data is cited. Zero evidence that multi-repo users are the majority
or even a significant minority. The architectural change is justified entirely on philosophy
principles, not on user need frequency.

### 3. Precedent from GitHub/VS Code/GitKraken transfers
These are repository browsers -- repo grouping is their core organizing principle by
definition. WorkRail is a workflow session tracker. The analogy is an authority transfer
from a fundamentally different tool class. It does not validate the choice for WorkRail.

### 4. Dormant = stale, not urgent
Dormant means 3+ days idle and NOT complete. A blocked session where the user was
interrupted and 3 days passed is dormant. Treating it like 'complete' in sort order hides
genuinely incomplete work. The assumption that dormant is always 'stale and low priority'
is not grounded in session lifecycle analysis.

### 5. Philosophy alignment = user value
The primary justification for B is architectural: 'fix over patch,' YAGNI, 'make illegal
states unrepresentable.' These are implementation quality principles. A change can satisfy
all of them and still be a net UX regression. The document makes no distinction between
'good code' and 'good UX.'

---

## Likely Failure Modes

### FM-1: Recap loss causes session abandonment
User returns after 2 days with 5 active branches. Expand-for-detail means 5 individual
clicks to re-orient. If the first two branches are not what they need, they give up and
start a new session. Result: orphaned incomplete sessions, fragmented work, console
perceived as less useful.

**Severity: High. Directly undermines the core value of the Workspace tab.**

### FM-2: Dormant demotion hides blocked incomplete work
A session that blocked mid-workflow 4 days ago sorts identically to a finished session
under B. The user does not see the blocked incomplete work until they scroll past all
active branches. Under Active/Recent, non-complete sessions were always surfaced in Active.
The demotion logic assumes dormant = done. It may mean dormant = forgotten and stuck.

**Severity: Medium-High. Causes genuinely incomplete work to be invisible.**

### FM-3: Long sections with no visual breakpoint
A single repo with 10 active branches gets a 10-row compact flat list. Sort order provides
ordering but no visual grouping. Active/Recent gave a fold point: 'work now' vs 'work done
or idle.' A 10-row list without subgrouping requires linear scan. Sort is not a substitute
for visual hierarchy at list lengths above ~6 items.

**Severity: Medium. Degrades scan speed for active developers.**

### FM-4: 'Expand for detail' is an invisible affordance
Compact rows do not visually signal 'I have hidden content.' Users who learned the
FeaturedCard model will not discover expand. They may conclude the tool no longer surfaces
context, rather than finding the interaction. Interaction model changes require onboarding
or strong visual affordance; B has neither in the current proposal.

**Severity: Medium. Creates a silent UX gap that may not surface in initial feedback.**

---

## Alternative Explanations

**Candidate A (patch) + recap subtitle is the safer bet.**
Fix `multiRepo = true` to `repos.length > 1`. Add a one-line recap subtitle to CompactRows.
Fix dormant sort priority. This resolves three of the four core tensions without:
- Removing inline recap
- Removing Active/Recent priority signaling
- Requiring a new interaction model

Cost: Active/Recent overhead remains. Multi-repo scanning is not spatially grouped.
But for a single-repo majority, neither of those costs is paid.

This is not 'B is wrong.' It is 'A + subtitle may be the right first step before
committing to B's full restructuring.'

**Hybrid: B with inline recap subtitle from day one.**
If the one-line recap subtitle is included in the proposal (not deferred), B becomes
substantially stronger. The combination of repo sections (conditional), compact rows with
one-line recap, and fixed dormant sort order addresses all four tensions without the
context-recovery regression.

---

## Critical Tests

These are the tests that would flip the verdict:

1. **User repo distribution:** What percentage of active WorkRail users have 1 repo vs. 2+?
   - If >70% single-repo: B's primary motivation is a minority use case. Reconsider.
   - If >40% multi-repo: B's restructuring is justified.

2. **FeaturedCard recap engagement:** Do users read the recap snippet before clicking into a session?
   - Instrument: does click-into-session correlate with time-on-card (suggesting recap read)?
   - If recap reading is common: removing inline recap is a confirmed regression, not 'accepted tension.'

3. **Dormant session lifecycle:** Of sessions marked dormant, what fraction are 'complete' vs. 'blocked and unresolved'?
   - Sample 20 dormant sessions: were they actually finished, or did the user just get interrupted?
   - If >30% are genuinely unresolved: dormant demotion is wrong.

4. **Expand affordance discovery:** Do users find the expand interaction without prompting?
   - Usability test: show B to 5 users and observe whether they click to expand within 2 minutes.
   - If less than 3/5 discover it: the affordance is insufficient.

5. **Scan speed on long sections:** With 8+ branches in one repo, do users prefer compact rows (B) or the Active/Recent fold (current)?
   - A/B test or preference interview.

---

## Verdict

**Revise.**

Candidate B is philosophically sound and architecturally correct as a direction. The repo-section
model is the right long-term structure. The `multiRepo = true` hardcoding is a genuine bug.
Dormant sort demotion is also correct in direction.

However, the proposal as stated has two unresolved weaknesses that are severe enough to warrant
revision before implementation:

1. **Inline recap must be in the proposal from day one**, not deferred as a 'pivot condition.'
   The one-line recap subtitle should be part of the compact row spec.

2. **The claim must be conditioned on multi-repo evidence.** If user distribution data shows
   single-repo dominance, the priority should shift to Candidate A + recap subtitle, with B
   implemented only for multi-repo users via the conditional rendering path that already exists.

A revised B with inline recap subtitle included and user distribution acknowledged as an open
risk is a strong proposal. The current B without those two elements is accepting a known
regression on the assumption that it will be fixed later.

---

## Next Action

1. Add one-line recap subtitle to the Candidate B compact row spec before implementation begins.
2. Query session/user data to determine single-repo vs. multi-repo distribution.
3. Before removing FeaturedCards, ship compact rows with inline recap as the visual default.
   FeaturedCards can then be removed once the compact row with recap is validated.
