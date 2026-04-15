# Design Candidates: WorkRail Attention Gap at Zillow

**Date:** 2026-04-14
**Context:** wr.discovery workflow - landscape_first pass
**Full analysis:** `/Users/etienneb/git/personal/workrail/analysis/nexus-attention-gap.md`

---

## Problem Understanding

### Core tensions
1. **Visibility vs. integrity:** Getting internal Zillow attention requires playing the institutional game (demo series, VP framing, Zodiac partnership). WorkRail's value is architectural - durable workflow state, checkpoint/resume. Optimizing for visibility risks diluting the architectural message.

2. **Complementarity vs. competition:** WorkRail and nexus-core solve different layers (durability vs. skills/commands). Positioning as complementary requires Peter Yao to agree - but he is actively making nexus-core more tool-agnostic, narrowing the gap. Waiting for collaboration risks being absorbed.

3. **Personal project vs. institutional tool:** WorkRail lives on GitHub. Zillow engineers default to internal (GitLab) tools already in the security/auth perimeter.

4. **Speed vs. correctness of the Zodiac window:** The DevEx team is standardizing now (Andy Rifken weekly updates since March 2026). The riskiest assumption: does Zodiac already have a workflow durability layer planned?

### Likely seam
Not in WorkRail's features. The seam is in how the value proposition is presented to decision-makers before organizational momentum locks in.

The architectural seam vs. nexus-core: the `continue_workflow` MCP tool call. Everything above it (what the agent does per step) is nexus-territory. Everything below it (what persists, what checkpoints) is WorkRail-territory.

### What makes this hard
- Attention gap is self-reinforcing: the more nexus-core gets cited, the more it becomes the default reference
- Zodiac standardization is moving fast - weekly updates since March 2026
- WorkRail's killer feature (durability) cannot be demonstrated in 10 minutes without a carefully constructed scenario
- Peter Yao's April 7 commit ("make nexus-core tool-agnostic with org profiles") signals intentional expansion toward WorkRail's portability territory

---

## Philosophy Constraints

**Principles under pressure:**
- **Architectural fixes over patches** (honors A, conflicts with broadcast tactics)
- **YAGNI with discipline** (tension: build Zillow quickstart before anyone asks? Survival risk justifies it)
- **Surface information, don't hide it** (complementarity framing requires honest direct conversation)
- **User drives decisions** from AGENTS.md (tension with unilateral action toward Peter Yao in Candidate C)

**No conflicts between stated philosophy and WorkRail repo patterns.**

---

## Impact Surface

- **Andy Rifken / Zodiac team:** Primary decision-maker. A direct conversation changes his evaluation frame.
- **Peter Yao / nexus-core:** Collaboration opens complementarity path. Perceived intrusion closes it.
- **Nikhil Bagewadi / CFE:** Watching for CFE-level conclusion on AI tooling. April 8 message signals openness.
- **WorkRail's architectural identity:** Any candidate that dilutes the durability message risks making WorkRail appear to be a nexus-core clone - the worst outcome.

---

## Candidates

### Candidate A: Direct Zodiac conversation (email Andy Rifken)

**Summary:** Email Andy Rifken: (1) what WorkRail does that nexus-core cannot (durable sessions, checkpoint/resume), (2) where it fits in Zodiac stack (below nexus-core's skills layer, above raw MCP), (3) single concrete question: "Does Zodiac's roadmap already have a workflow durability layer planned?"

**Tensions resolved:** Zodiac window survival. Riskiest assumption directly.
**Tensions accepted:** No public visibility. Outcome depends on single relationship.
**Boundary:** Decision-maker level, before organizational momentum locks in.
**Failure mode:** Andy confirms Zodiac already has durability layer (informative failure - opens Candidate C path).
**Repo-pattern:** Follows AGENTS.md "discuss and decide before building."
**Gain:** Direct answer to riskiest assumption within days. Reversible if window closed.
**Loss:** No public visibility. Requires well-crafted pitch.
**Scope:** Best-fit.
**Philosophy:** Honors "architectural fixes over patches." No conflicts.

---

### Candidate B: Monthly Eng AI Demo Series slot with session-resurrection demo

**Summary:** Sign up for 10-minute slot on the Eng & Tech AI Demo Series (open sign-up confirmed). Demo: Claude + nexus-core session interrupted mid-workflow; WorkRail checkpoint/resume brings it back exactly where it left off. Framing: "the durability layer nexus-core doesn't have yet."

**Tensions resolved:** Visibility gap. Uses highest-reach internal channel (same nexus-core used April 3, 2026).
**Tensions accepted:** Demo format mismatch - durability is conceptually compelling, not viscerally compelling like nexus-core's code-writing demo.
**Boundary:** Company-wide engineering audience.
**Failure mode:** Demo runs out of time before value prop lands. Audience sees "a workflow tool" without understanding why durability matters.
**Repo-pattern:** Demo repo follows existing WorkRail workflow authoring patterns.
**Gain:** Company-wide visibility. Concrete demo artifact as lasting reference.
**Loss:** 2-4 weeks prep. Execution-dependent.
**Scope:** Best-fit for broad visibility. Too broad if only Zodiac evaluation is needed.
**Philosophy:** YAGNI tension resolved by concrete purpose.

---

### Candidate C: nexus-core integration demo as draft MR to Peter Yao

**Summary:** Build working demo: nexus-core `/flow` execution driven by a WorkRail workflow, gaining checkpoint/resume for free. Open as draft MR/discussion on nexus-core repo with note to Peter Yao.

**Tensions resolved:** Complementarity vs. competition (makes it code-visible, not just claimed). Closes "does Peter Yao know WorkRail" gap.
**Tensions accepted:** Requires Peter Yao's cooperation. No public visibility. GitHub trust gap remains.
**Boundary:** The `continue_workflow` MCP call - the literal architectural seam between the two tools.
**Failure mode:** Peter Yao sees it as competitive intrusion, declines. Draft MR sits unanswered.
**Repo-pattern:** No new WorkRail engine work. A `nexus-flow.json` workflow definition follows existing `docs/authoring-v2.md` patterns.
**Gain:** Forces complementarity question to close. High leverage if Peter Yao engages.
**Loss:** Unilateral action. Slight conflict with AGENTS.md "user drives decisions."
**Scope:** Best-fit for collaboration uncertainty. Too narrow for broad visibility.
**Philosophy:** "Architectural fixes over patches." Minor conflict with AGENTS.md.

---

### Candidate D: Zillow-profile quickstart script

**Summary:** `scripts/setup-zillow.sh` that: installs WorkRail MCP into `~/.claude/settings.json`, configures glab/acli endpoints, adds Zillow team workflow bundle from common-ground, prints first-run one-liner. 4 commands matching nexus-core's setup bar.

**Tensions resolved:** Activation energy tension.
**Tensions accepted:** Does not address visibility gap. If no one finds the repo, the quickstart is moot.
**Boundary:** First-run experience for a Zillow engineer who has decided to try WorkRail.
**Failure mode:** First workflow run is not compelling enough; tool installed and forgotten.
**Repo-pattern:** nexus-core `scripts/apply-profile.sh zillow` is the direct precedent. common-ground `scripts/install.sh` already has org-profile concepts.
**Gain:** Converts any visibility action to trial. Low effort (1-2 days).
**Loss:** Minimal standalone impact.
**Scope:** Too narrow standalone. Best-fit as multiplier for A or B.
**Philosophy:** YAGNI tension justified by survival risk. Honors "validate at boundaries."

---

## Comparison and Recommendation

| Tension | A: Direct Zodiac | B: Demo Series | C: nexus-core MR | D: Quickstart |
|---------|-----------------|----------------|------------------|---------------|
| Zodiac window survival | Best | Partial | Partial | None |
| Visibility gap | None | Best | None | Multiplier only |
| Demo-ability mismatch | N/A | Must navigate | Best | N/A |
| Complementarity framing | Partial | Partial | Best | None |
| Activation energy | None | None | None | Best |
| Riskiest assumption resolved | Best | None | Indirect | None |

**Recommendation: A + D in parallel, then B conditional on A's answer**

1. Execute A immediately (one email)
2. Build D in parallel (1-2 days)
3. After A responds: if no Zodiac durability layer planned, sign up for B; if they have one, pivot to C

---

## Self-Critique

**Strongest counter:** A is asymmetric. If window already closed, A only confirms a negative. Response: informative failure > silent failure. Downside is bounded.

**Narrower option that almost won:** A only, wait 30 days. Rejected: nexus-core's self-reinforcing momentum means passive waiting is too risky given D's low cost.

**Broader option:** CFE All-Hands with Nikhil Bagewadi as champion. Requires explicit invitation from Nikhil.

**Invalidating assumption:** Andy Rifken is not the actual Zodiac decision-maker. No evidence for this, but it is the key unknown.

---

## Open Questions for the Main Agent

1. Is Andy Rifken the right contact, or is there someone above him on the Zodiac AI standardization decision?
2. Has Etienne already had any direct contact with Andy Rifken or Peter Yao about WorkRail?
3. Is the BTS presentation slot actually scheduled, or still aspirational?
4. Is WorkRail being used by Etienne's own team (TCE/Mercury Mobile) in a way that generates concrete metrics? (If yes, the demo pitch writes itself.)
