# Discovery: Why nexus-core gets attention at Zillow while WorkRail does not

**Date:** 2026-04-14
**Status:** Draft (WorkRail wr.discovery workflow)
**Goal:** Understand the attention gap and what it means strategically

---

## Artifact Strategy

This document is a **human-readable reference** for reviewing findings, sharing with stakeholders, and informing decisions. It is NOT the execution truth for the WorkRail workflow - that lives in the workflow's durable notes and context variables.

**What this doc is for:**
- Sharing with Peter Yao, Andy Rifken, or Nikhil Bagewadi as context for a conversation
- Informing a BTS or Eng AI Demo Series presentation
- Providing a strategic reference when revisiting this question

**What this doc is not:**
- The authoritative record of workflow state (that is in WorkRail notes/context)
- A substitute for direct conversation with the stakeholders named here
- A commitment to any specific action

---

## Context / Ask

WorkRail is an MCP-based workflow engine for AI coding assistants (Claude Code, Cursor) with 1 GitHub star, 0 forks. nexus-core is a skills/plugin system for Claude Code built by Peter Yao at Zillow (FUB/Apex team) with 11 GitLab stars, 2 forks. Inside Zillow, nexus-core has been presented at multiple internal venues and referenced by engineering leadership.

The question: what explains the gap, and what could change it?

---

## Path Recommendation

**`landscape_first`** - The dominant need is understanding the current landscape: who is paying attention to what, why, and along what distribution channels. There is no deep problem reframing needed; the facts speak clearly once assembled.

**Rationale vs alternatives:**
- `design_first` would be appropriate if the core problem were conceptual/architectural. It is not - WorkRail has a working design.
- `full_spectrum` would be overkill. The answer is not about solving the wrong problem; it is about distribution, relationships, and surface area.
- `landscape_first` correctly focuses on: who has the attention, how did they get it, what structural advantages do they hold.

---

## Constraints / Anti-goals

**Constraints:**
- WorkRail is a personal/side project; nexus-core is backed by a Zillow team (Apex) with Zillow resources
- WorkRail is external (GitHub); nexus-core is internal (GitLab)
- WorkRail's value is in workflow structure/durability; nexus-core's value is in immediate dev velocity

**Anti-goals:**
- Do not conclude that WorkRail should copy nexus-core's feature set
- Do not recommend abandoning WorkRail's architectural differentiation
- Do not conflate "internal visibility" with "better tool"

---

## Landscape Packet

### Current-State Summary

Two tools exist in the same problem space at Zillow: nexus-core (internal, FUB/Apex team, Claude Code plugin, skills-based orchestration) and WorkRail (external GitHub project, MCP workflow engine, durable state machine). nexus-core has institutional momentum: VP endorsement, DevEx/Zodiac team as a formal champion, company-wide demo presentations, and a dedicated wiki page. WorkRail has a single wiki reference in a list of "industry tools." The star gap (11 vs 1) understates the attention gap because internal GitLab stars are social signals among colleagues; the real gap is in presentation slots, Slack reach, and organizational sponsorship.

### Existing Approaches / Precedents

| Approach | Who Used It | Outcome |
|----------|-------------|---------|
| Recurring knowledge share series | Peter Yao (FUB+ AI) | Built sustained audience, 6+ sessions, wiki page now cites it as primary resource |
| Company-wide demo series slot | Peter Yao (Eng & Tech AI Demo, 2026-04-03) | VP-level visibility, cross-org spread, DevEx endorsement in same week |
| DevEx/Zodiac endorsement via weekly update | Andy Rifken cited nexus-core | Reach into #ai-productivity-eng, official "window into the future" framing |
| Cross-posting to adjacent orgs | Peter Yao posting to #cfp-ai, #fub-plus-engineering | ZHL comparative analysis created, connections-ai team adopted patterns |
| Perf-review linkage | Etienne (WorkRail in review doc, BTS slot) | Low visibility; internal to review process, not shared publicly |

### Option Categories (for closing the gap)

1. **Channel access** - Get into existing high-reach venues (Eng AI Demo Series, #ai-productivity-eng weekly updates)
2. **Champion acquisition** - Find an internal Zillow champion with organizational reach (Andy Rifken / DevEx, or Nikhil Bagewadi in CFE)
3. **Complementarity framing** - Position WorkRail as what nexus-core lacks (durability, checkpoint/resume) rather than a competing tool
4. **Activation energy reduction** - Build a Zillow-specific quickstart that matches nexus-core's 4-command setup
5. **Demonstrated integration** - Create a concrete example where WorkRail drives a nexus-core `/flow` execution with durable state

### Notable Contradictions

1. **Stars vs. attention:** nexus-core ecosystem repos (fleet, cortex, nanobot) all have 0 stars. The 11 stars on nexus-core alone come from colleagues being supportive, not from usage breadth. The attention gap is real but the quality signal from stars is weak.
2. **Tool-agnostic pivot:** Peter Yao's April 7 commit "make nexus-core tool-agnostic with org profiles" mirrors WorkRail's portability goal. Both tools are converging on the same architectural insight (org-profile-based configuration), which means the gap will narrow by design - but also means nexus-core could absorb WorkRail's differentiators.
3. **Complementarity vs. competition:** DevEx/Zodiac's Andy Rifken sees nexus-core as the pattern to adopt and is planning to bring it into Zodiac. This could be a threat (WorkRail gets ignored as Zodiac standardizes on nexus patterns) or an opportunity (WorkRail's durability layer is exactly what Zodiac would want to add).

### Evidence Gaps

1. **What does the CFE All-Hands AI objectives slide actually say?** Nikhil referenced it but the document is not directly accessible. This would clarify whether nexus-core is being formally adopted vs. informally spotlighted.
2. **Andy Rifken's Zodiac AI Marketplace plans for WorkRail-like durability.** The weekly #ai-productivity-eng post mentions bringing nexus patterns into Zodiac - does their roadmap include durable workflow state, or would WorkRail fill that gap?
3. **Whether Peter Yao is aware of WorkRail.** The FUB AI-Native Development wiki lists WorkRail alongside SuperClaude_Framework. Did Peter add it, or someone else? This determines whether he is a potential collaborator or has already evaluated and deprioritized it.

### nexus-core metrics (Zillow GitLab project 66446)

| Metric | Value |
|--------|-------|
| Stars | 11 |
| Forks | 2 |
| Open issues | 0 |
| Contributors | 1 (Peter Yao: 23 commits; 2 others recently joined: joshuadem, davisli) |
| Last commit | 2026-04-09 |

**Ecosystem repos** (all 0 stars, minimal forks):
- nexus-fleet: 0 stars, 0 forks
- nexus-cortex: 0 stars, 0 forks
- fub-nanobot: 0 stars, 0 forks
- fub-public-mcp: 1 star, 0 forks

### WorkRail metrics (GitHub)

| Metric | Value |
|--------|-------|
| Stars | 1 |
| Forks | 0 |
| Watchers | 1 |

### Internal visibility channels nexus-core has used

1. **FUB+ AI Knowledge Share series** - Recurring internal sessions. Peter Yao has presented on nexus/Apex at:
   - 2025-10-05: Claude Code intro
   - 2025-11-04: MCP
   - 2026-01-13: Agent Skills
   - 2026-03-20: Claude Playgrounds
   - 2026-03-31: Nexus Core dedicated session (JP Shook announced, recorded, TLDR posted)

2. **Monthly Eng AI Demo Series (cross-org)** - 2026-04-03: "Apex Nexus: Build your own AI Personal Assistant" presented to company-wide engineering audience. Announced in #ai-productivity-eng by Michele Salva.

3. **Engineering-Tech-Org AMA** - Feb 2026: Sof Oubraham (VP/Director level) cited Apex Nexus as a model for cost-efficient model selection. Daniel Ellis: "The Apex Nexus demo is [fire emoji], I highly recommend watching Peter's video!"

4. **DevEx/Zodiac team endorsement** - Andy Rifken (DevEx, Zodiac team): "we believe this is a window into the future of agentic engineering at ZG. Stay tuned for a lot of this innovation to make its way into Zodiac."

5. **CFE All-Hands (April 2026)** - Nikhil Bagewadi (direct message to Etienne, 2026-04-08): "Nexus Core seems to be getting a lot of spotlight" after CFE All Hands AI objectives slides.

6. **Cross-org spread** - Referenced in:
   - `#cfp-ai` (Connections Platform): Gavin Lee sharing with team
   - `#engineering-tech-org-ama`: executive-level discussion
   - `#ai-productivity-eng`: DevEx team official endorsement
   - ZHL Forge comparative analysis document
   - TCE Q1 2026 ZRetreat AI resources doc

7. **FUB AI-Native Development wiki page** - Lists nexus-core alongside official Zillow resources (zgtools docs, Claude Code, etc.)

### WorkRail internal visibility

- Referenced once on the FUB AI-Native Development wiki page (under "Industry Tools & Resources" alongside SuperClaude_Framework, github/spec-kit)
- Referenced in Etienne's own performance review document ("WorkRail has become a force multiplier for the team... slated for presentation at BTS")
- Referenced in common-ground MR descriptions
- No Slack channel mentions found in cross-org channels
- No dedicated presentations found

---

## Problem Frame Packet

### Primary Users / Stakeholders

| Stakeholder | Role | Job to be done | Pain | What success looks like |
|-------------|------|----------------|------|------------------------|
| Etienne Beaulac | WorkRail author, Zillow SDE | Get WorkRail recognized and used internally | Invisible next to nexus-core despite having a complementary/superior architecture | WorkRail cited as the workflow layer when Zillow engineers discuss structured AI dev |
| Peter Yao | nexus-core author, FUB/Apex SDE | Build and share AI dev tooling as part of his job | N/A - he has the attention | Continued sponsorship; nexus-core becoming a Zodiac standard |
| Andy Rifken | DevEx/Zodiac team | Identify tools to standardize for ZG agentic engineering | Needs to find the best workflow durability layer for Zodiac | WorkRail evaluated and either adopted or explicitly rejected with documented rationale |
| Nikhil Bagewadi | CFE engineering leader | Improve team AI productivity | Unclear what's best across the FUB/ZG tooling landscape | Clear decision on which tools CFE adopts for structured AI workflows |
| Zillow SDE (general) | Tool user | Complete tickets faster with AI assistance | Tool fragmentation; high activation energy to try new tools | One clear entry point that works for their stack |

### Core Tension

**The core tension is not technical - it is organizational.** WorkRail solves a real problem (AI sessions lose state; structured workflows produce better outputs than ad-hoc prompting). nexus-core also solves a real problem (AI sessions need guidance on what to do next; skills/commands make it concrete). Both are right. The tension is that nexus-core has organizational momentum and WorkRail does not - and organizational momentum, once established, is self-reinforcing.

The deeper tension: Etienne can demonstrate WorkRail's value clearly in a one-on-one or in this document, but the people making adoption decisions (Andy Rifken, Nikhil Bagewadi) are not yet in that conversation.

### Jobs / Outcomes

- **Etienne's real job here:** Not "get stars" - it is "become the person Zillow's AI tooling ecosystem turns to when they need workflow durability and structure."
- **nexus-core's job for Peter Yao:** Demonstrate AI productivity leadership within FUB/CFE, which advances his career and team reputation.
- **Zodiac's job:** Standardize the agentic engineering stack so every ZG engineer benefits, not just FUB.

### Pains / Tensions in Lived Use

1. **WorkRail requires explaining architecture before the value is visible.** nexus-core produces a demo-able output in 10 minutes. WorkRail's value - "your workflow state persists across sessions and can be checkpointed and resumed" - requires either a multi-day experiment or trust in the explanation.
2. **Etienne is in a different org (TCE / Touring & Connections) than the AI tooling center of gravity (FUB/Apex).** The people building the internal AI tooling culture are not Etienne's immediate colleagues.
3. **The BTS slot is described as "slated" in the perf review but not confirmed or scheduled.** This is aspirational, not committed.

### Success Criteria

1. WorkRail is presented at one high-reach internal venue (Eng AI Demo Series or BTS equivalent) within 90 days
2. Andy Rifken or a Zodiac team member explicitly evaluates WorkRail for Zodiac's workflow layer
3. At least one Zillow engineer outside of Etienne's immediate team adopts WorkRail for their AI workflow
4. nexus-core and WorkRail are framed as complementary (not competing) in at least one shared document or presentation

### Assumptions (that could be wrong)

1. **Assumption:** The attention gap can be closed by Etienne alone without formal organizational sponsorship. **Risk:** If Zodiac standardizes on nexus patterns before WorkRail gets any internal presentation, the window closes.
2. **Assumption:** Andy Rifken's Zodiac AI Marketplace does not already have a WorkRail-equivalent durability layer planned. **Risk:** If Zodiac is building its own state machine, WorkRail is redundant in the ZG context.
3. **Assumption:** Peter Yao would welcome a collaboration or complementarity framing. **Risk:** He may view WorkRail as directly competing with nexus-core's planned evolution toward durability (the tool-agnostic refactor suggests he is already moving in that direction).
4. **Assumption:** The FUB AI-Native Development wiki listing of WorkRail means there is already some internal awareness. **Risk:** It may have been auto-indexed by Glean without anyone consciously adding it.

### Reframes / HMW Questions

1. **HMW reframe: Stop trying to "get attention" and start solving Zodiac's open problem.** The DevEx team is actively looking for what to standardize. WorkRail's best move is not a demo - it is showing up in the conversation Andy Rifken is already having. How might WorkRail position itself as the answer to the workflow durability gap Zodiac does not yet have?

2. **HMW reframe: What if nexus-core and WorkRail are not competing for the same users?** nexus-core targets FUB engineers who want immediate productivity on FUB tickets. WorkRail targets engineers running complex, multi-session, durable AI workflows (e.g., multi-day agentic projects). How might WorkRail target the use cases where nexus-core's stateless session model breaks down?

3. **Framing risk: Is "attention" the right outcome?** The perf review frames WorkRail as a force multiplier for Mercury Mobile / TCE. If that is the real success criterion, internal Zillow attention matters less than concrete team-level adoption and demonstrated productivity. The attention gap may be a vanity metric masking the real question: is WorkRail actually being used by Etienne's team?

### Why the gap exists

**1. Organizational embeddedness (most powerful factor)**

Peter Yao is a Zillow employee building nexus-core as part of his job on the Apex team. This means:
- He has natural access to Zillow's internal communication channels (Slack, Confluence, all-hands)
- His manager and team have a stake in the tool's success (it demonstrates AI productivity)
- Other Zillow engineers can contribute during work hours (joshuadem, davisli joining recently)
- It is already solving Zillow-specific problems (glab, acli, jira.zgtools.net, Databricks, Datadog)

WorkRail is Etienne's personal project. It requires deliberate cross-context effort to share internally.

**2. Distribution channel access**

nexus-core benefits from:
- An established recurring series (#fub-plus-ai knowledge shares) with a ready audience
- A champion in DevEx/Zodiac (Andy Rifken) who has organization-level reach
- VP/Director-level visibility through the Eng AMA
- Company-wide demo series (Eng & Tech AI Demo Series) - monthly, high-visibility

WorkRail has none of these institutional channels attached to it.

**3. Artifact type: immediate vs. structured**

nexus-core is a Claude Code plugin. You install it, run `/flow TICKET-123`, and something visible happens immediately. The demo is its own argument.

WorkRail is an MCP server plus a workflow engine. The value is in durability, state management, and structured progress - which is harder to demo in a 10-minute slot and requires explaining an architecture.

**4. Zillow-specific fit**

nexus-core ships with a `zillow` org profile that configures glab, acli, and jira.zgtools.net in 4 commands. It is explicitly built for Zillow's stack. This lowers the activation energy to near-zero for a Zillow engineer.

WorkRail is tool-agnostic and requires setup. Its value proposition (workflow durability, checkpoint/resume, structured reasoning) is harder to grasp before you need it.

**5. Overlap in spirit, divergence in architecture**

Both tools aim to make AI coding more structured and less ad hoc. But nexus-core does this through skills/agents/commands (prompt engineering + orchestration patterns), while WorkRail does it through durable state machines (MCP + workflow files). These are complementary, not competing - but from the outside they look like alternatives.

**6. Network effects and social proof**

Peter Yao has been consistently sharing, demoing, and iterating for 6+ months. He has a recognizable pattern: new capability -> demo -> knowledge share -> wiki doc -> cross-post. Each cycle builds credibility. WorkRail does not yet have that cycle running internally.

---

## Candidate Generation Expectations (landscape_first)

The candidate set must:
1. **Reflect landscape precedents directly** - each candidate should be traceable to a specific precedent, channel, or stakeholder identified in the landscape packet. Free invention is not acceptable here.
2. **Address the structural gap, not the symptom** - candidates must target channel access, champion acquisition, or activation energy, not "write better docs" or "add more features."
3. **Respect the decision criteria** - every candidate must be reachable by Etienne alone, target someone already looking, and produce a concrete artifact or event.
4. **Cover distinct mechanisms** - candidates should not cluster. The 4 candidates should cover: (a) a specific high-reach event/channel, (b) a specific decision-maker relationship, (c) an integration/demonstration artifact, and (d) an activation-energy reduction.
5. **Explicitly address the riskiest assumption** - at least one candidate must either resolve or work around the Zodiac durability roadmap uncertainty.

**Bias to avoid:** Do not generate "spray and pray" visibility candidates (post in every Slack channel, write a blog post). The landscape shows that Peter Yao's approach worked because he had a recurring audience and institutional backing - not because he posted widely.

## Candidate Directions

### Candidate A: Direct Zodiac conversation before the standardization window closes

**One-sentence summary:** Email Andy Rifken directly with a 3-paragraph pitch: (1) what WorkRail does that nexus-core cannot (durable sessions, checkpoint/resume across conversation resets), (2) where it fits in the Zodiac stack (below nexus-core's skills layer, above raw MCP), (3) a single concrete question: "Does Zodiac's roadmap already have a durability layer planned?"

**Tensions resolved:** Solves the Zodiac window survival risk directly. Targets the decision-maker who is already looking. Does not require waiting for a demo slot or Peter Yao's cooperation.

**Tensions accepted:** Does not build public visibility. Does not reduce activation energy for the general engineer population. Outcome depends entirely on whether Andy responds.

**Boundary:** The intervention happens at the decision-maker level, before organizational momentum locks in. This is the correct seam - per the problem analysis, the self-reinforcing nature of nexus-core's momentum means the window to be considered is narrow.

**Specific failure mode:** Andy replies that Zodiac is already building a durability layer, or that they've decided to standardize on nexus-core's stateless model. This would confirm the riskiest assumption and mean the Zodiac window is closed.

**Relates to existing patterns:** WorkRail's AGENTS.md workflow says "discuss and decide before implementing." This is the "discuss" step for the Zodiac relationship. Follows the stated philosophy.

**Gain / Give up:** Gain: direct answer to the riskiest assumption within days. Give up: no public visibility, requires Etienne to write a clear compelling pitch.

**Impact surface:** High leverage on a single relationship. Low blast radius if it fails.

**Scope:** Best-fit. Narrow enough to execute immediately, high enough leverage to potentially change the entire strategic picture.

**Philosophy:** Honors "architectural fixes over patches" (going to the root decision-maker, not broadcasting). Honors "surface information, don't hide it." No conflicts.

---

### Candidate B: Monthly Eng AI Demo Series slot with a "session resurrection" demo script

**One-sentence summary:** Sign up for a 10-minute slot on the Eng & Tech AI Demo Series (open sign-up sheet confirmed), and demo a pre-constructed scenario where a Claude + nexus-core session is interrupted mid-workflow, and WorkRail's checkpoint/resume brings it back exactly where it left off - framed as "the durability layer nexus-core doesn't have yet."

**Tensions resolved:** Addresses the visibility gap directly. Uses the highest-reach internal channel (same one nexus-core used on 2026-04-03). Creates a concrete artifact (a prepared demo repo and scenario).

**Tensions accepted:** The demo format mismatch tension is only partially resolved: 10 minutes is tight for explaining durability. Requires careful scripting to make the counterfactual (what would have been lost) vivid in real time.

**Boundary:** Public visibility at the company-wide engineering audience level. This is the right scope if the goal is being seen, not just being evaluated by one person.

**Specific failure mode:** The demo runs out of time before the value prop lands. The audience sees "a workflow tool" without understanding why durability matters. nexus-core's demo was viscerally compelling (watch it write code); WorkRail's demo is conceptually compelling (watch nothing break). These are different emotional registers.

**Relates to existing patterns:** Directly mirrors the precedent Peter Yao set. Follows the "channel access" candidate category identified in the landscape.

**Gain / Give up:** Gain: company-wide visibility, concrete artifact (demo repo), potential for Andy Rifken or Nikhil Bagewadi to see it live. Give up: 2-4 weeks of preparation time; outcome depends on demo execution quality.

**Impact surface:** Broad (company-wide engineering), but shallow unless followed up. Most impactful combined with Candidate A.

**Scope:** Best-fit if the goal is broad visibility. Too broad if the goal is just getting Zodiac to evaluate WorkRail.

**Philosophy:** "YAGNI with discipline" - the demo repo is a concrete artifact that serves a real purpose, not speculative. Honors "document why, not what" in the demo framing.

---

### Candidate C: nexus-core integration demo as a pull request to the nexus-core repo

**One-sentence summary:** Build a concrete, working demo that shows a nexus-core `/flow` execution driven by a WorkRail workflow, gaining checkpoint/resume for free - and open it as a draft MR or discussion on the nexus-core repo with a note to Peter Yao explaining the integration.

**Tensions resolved:** Resolves the complementarity vs. competition tension by making complementarity concrete and code-visible rather than just claimed. Forces the "does Peter Yao know WorkRail exists" research gap to close.

**Tensions accepted:** Requires Peter Yao's cooperation or at least non-rejection. Does not provide public Zillow visibility directly. The "personal project on GitHub" trust gap remains.

**Boundary:** The integration demo lives at the architectural seam identified in the analysis: the `continue_workflow` tool call is where WorkRail's durability layer sits below nexus-core's skills layer. A working integration demo at this seam is the most honest possible demonstration.

**Specific failure mode:** Peter Yao sees this as a competitive intrusion and declines, or is too busy to engage. The draft MR sits unanswered and becomes an awkward artifact.

**Relates to existing patterns:** WorkRail's engine already handles any workflow author's content via the MCP protocol. Adding a nexus-workflow.json that drives nexus-core steps would follow existing WorkRail workflow authoring patterns (see `docs/authoring-v2.md`). No new engine work required - this is purely a workflow definition + demo script.

**Gain / Give up:** Gain: forces the complementarity question to be answered concretely; potentially creates a strong joint narrative if Peter Yao engages. Give up: exposes WorkRail to Peter Yao's evaluation (he may find architectural objections); requires a working integration that respects both tools' interfaces.

**Impact surface:** Low blast radius if declined; high leverage if Peter Yao engages and co-presents or co-champions.

**Scope:** Best-fit for the "resolve the riskiest assumption about collaboration" goal. Too narrow if the goal is broad Zillow visibility.

**Philosophy:** "Architectural fixes over patches" - this addresses the root problem (no one knows WorkRail is complementary) by making complementarity undeniable. Honors YAGNI (no speculative new engine features). Conflicts slightly with "user drives decisions" from AGENTS.md - this is a unilateral action toward a third party.

---

### Candidate D: Zillow-profile quickstart that mirrors nexus-core's 4-command setup

**One-sentence summary:** Create a `scripts/setup-zillow.sh` in the WorkRail repo that (1) installs WorkRail MCP into `~/.claude/settings.json`, (2) configures glab and acli endpoints, (3) adds the Zillow team workflow bundle from common-ground, and (4) prints a "try your first WorkRail workflow" one-liner - matching nexus-core's 4-command activation energy bar.

**Tensions resolved:** Directly addresses the activation energy tension. A Zillow engineer who finds WorkRail via the wiki can go from zero to running in under 5 minutes, matching nexus-core's bar.

**Tensions accepted:** Does not address the visibility gap - if no one finds the repo, the quickstart is moot. Does not directly target Andy Rifken or the Zodiac conversation.

**Boundary:** Activation energy reduction at the "first Zillow engineer to try WorkRail" level. The correct seam for reducing adoption friction is the installation and first-run experience.

**Specific failure mode:** The quickstart installs correctly but the first workflow a Zillow engineer runs is not compelling. The tool is installed and forgotten. Activation energy is a necessary but not sufficient condition.

**Relates to existing patterns:** nexus-core's `scripts/apply-profile.sh zillow` is the direct precedent. WorkRail already has org-profile concepts in common-ground's `scripts/install.sh`. This extends an existing pattern.

**Gain / Give up:** Gain: any engineer who finds WorkRail via the wiki can try it immediately; creates a concrete artifact that demonstrates Zillow-awareness. Give up: 1-2 days of implementation work; minimal impact if visibility remains low.

**Impact surface:** Low if no new visibility. High multiplier on any visibility actions (A or B) taken first.

**Scope:** Too narrow as a standalone action. Best-fit as a supporting artifact for Candidates A or B.

**Philosophy:** YAGNI tension - is building this before anyone has asked for it premature? Counter: the survival risk justifies it. Honors "validate at boundaries" (the setup script validates tool auth at install time, matching nexus-core's pattern).

---

## Synthesis (Pre-Candidate)

### The opportunity in one sentence
WorkRail is architecturally differentiated (durable state, checkpoint/resume, MCP protocol) from nexus-core (stateless skills/commands), and the DevEx/Zodiac team is actively looking for exactly what WorkRail provides - but they do not know WorkRail exists.

### Decision criteria for any candidate direction
A good direction must satisfy ALL of:
1. **Reachable by Etienne alone** - no corporate sponsorship required to attempt
2. **Targets a decision-maker who is already looking** - Andy Rifken / Zodiac, not cold outreach
3. **Leverages the complementarity framing** - positions WorkRail alongside nexus-core, not against it
4. **Reduces activation energy for a first Zillow engineer to try it** - ideally fewer than 10 minutes from zero to running a workflow
5. **Produces a concrete artifact or event** - not just a conversation

### Strongest framing risk (challenged and resolved)
**The challenge:** WorkRail may already be delivering team-level value (per perf review: "force multiplier for Mercury Mobile"). If so, "internal Zillow attention" is a vanity metric and the real goal is recognition for delivered value, not new adoption.

**Resolution:** The challenge is valid but does not invalidate the framing. There are TWO distinct reasons the attention gap matters:
1. **Survival risk:** DevEx/Zodiac is standardizing on nexus-core patterns. If WorkRail is not in the conversation, it will be displaced before evaluation - not because it lost a fair comparison, but because it was never considered.
2. **Recognition risk:** The perf review explicitly flags BTS presentation and broader adoption as success criteria. Etienne's own career goals require the attention gap to close.
Both risks are real. The framing is correct and survives the challenge.

### Remaining uncertainty (categorized)
- **Recommendation uncertainty:** Does the Zodiac team have a durability layer in their roadmap? (If yes, WorkRail may be redundant; if no, it is the perfect fit.) This would change the priority of Direction 2 (DevEx endorsement).
- **Research uncertainty:** Does Peter Yao know WorkRail exists / would he welcome a complementarity framing? Cannot know without asking.
- **Prototype-learning uncertainty:** Would a Zillow-specific quickstart actually lower activation energy enough, or is the MCP setup overhead irreducible?

### Candidate count target
`landscape_first` mode = 3-4 candidates. Target: **4** (covering channel access, champion acquisition, integration demo, and quickstart).

## Challenge Notes

- The gap is structural (organizational embeddedness), not technical. No amount of feature work closes the channel access gap.
- nexus-core's 11 stars come from being an internal repo where starring is a social signal, not a product judgment. GitHub stars measure something different.
- "Getting attention" and "being strategically valuable" are different. WorkRail may have a deeper architectural moat (durable state, MCP protocol) that nexus-core cannot easily replicate.
- Peter Yao's recent refactor ("make nexus-core tool-agnostic with org profiles") mirrors WorkRail's portability goal - both tools are converging on the same design insight.

---

## Tradeoff Analysis and Recommendation

### Comparison matrix (tensions vs. candidates)

| Tension | A: Direct Zodiac | B: Demo Series | C: nexus-core MR | D: Quickstart |
|---------|-----------------|----------------|------------------|---------------|
| Zodiac window survival | Best (direct) | Partial | Partial | None |
| Visibility gap | None | Best | None | Multiplier only |
| Demo-ability mismatch | N/A | Must navigate | Best (code speaks) | N/A |
| Complementarity framing | Partial | Partial | Best | None |
| Activation energy | None | None | None | Best |
| Riskiest assumption resolved | Best | None | Indirect | None |

### Primary recommendation: A first, then D, then B

**A (Direct Zodiac conversation) is the correct first move** for four reasons:
1. It resolves the riskiest assumption (Zodiac roadmap) within days, not weeks
2. It targets the decision-maker who is already looking - Andy Rifken explicitly cited nexus-core as "the future of agentic engineering at ZG"; he is actively seeking the answer to a question WorkRail answers
3. It costs one well-crafted email with no preparatory artifacts required
4. It is reversible: if Andy says Zodiac already has a durability layer, no time was wasted on demo prep

**D (Zillow quickstart) is the correct supporting artifact** to build in parallel with or immediately after A. If Andy responds with interest, the next question will be "how do I try it?" The quickstart reduces the answer to one script run.

**B (Demo Series) is the right third move**, conditional on A's outcome:
- If Zodiac has no durability layer planned: sign up to create pressure from below
- Do not do B first - the demo slot is wasted without the Andy relationship as follow-through context

**C (nexus-core MR) is a high-variance bet**, useful only if A and B fail to produce movement within 60 days.

### Self-critique

**Strongest argument against this pick:** A is asymmetric. If Andy replies that Zodiac already has a durability layer, the window is confirmed closed. Evidence the window is still open: Andy's March 2026 weekly update described nexus-core as "a window into the future" but did NOT announce a Zodiac durability roadmap item.

**Narrower option that almost won:** Send A and do nothing else for 30 days. Lost because the survival risk of Zodiac momentum is real and D is low-cost. Doing only A is too passive.

**Broader option and what would justify it:** Present at a CFE All-Hands (broader than Demo Series) with Nikhil Bagewadi as champion. Requires Nikhil to explicitly invite WorkRail into the CFE AI objectives discussion - his April 8 message could be the opening.

**Assumption that would invalidate this design:** If Andy Rifken is not the actual decision-maker for Zodiac's workflow layer - e.g., if the decision has been made at a higher level. No evidence for this.

### Pivot conditions
- If A produces no response in 2 weeks: escalate to B as primary visibility channel
- If A confirms Zodiac already has a durability layer: pivot to C as the complementarity path
- If B produces interest from non-Zodiac engineers: WorkRail's opportunity may be grassroots, not top-down standardization

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-14 | Path: landscape_first | Gap is about distribution channels and organizational embeddedness, not about architectural misframing |
| 2026-04-14 | Glean used extensively | Confirmed available and returned high-quality internal data |
| 2026-04-14 | GitHub/GitLab metrics gathered directly | Raw numbers needed for comparison |
| 2026-04-14 | **Selected direction: A+D parallel, then B** | A (Slack DM to Andy Rifken in #ai-productivity-eng) resolves riskiest assumption fastest. D (Zillow quickstart script) is a low-cost conversion multiplier. B (Demo Series) is the conditional follow-on if A confirms Zodiac has no durability layer. C (nexus-core MR) is last resort. |
| 2026-04-14 | **A refined after adversarial challenge** | Outreach mechanism changed from email to Slack DM (@arifken in #ai-productivity-eng). Andy is already active in that channel with weekly public updates; a DM is lower-friction than cold email and more contextually appropriate. |
| 2026-04-14 | **Runner-up: B (Demo Series)** | Strongest alternative. Does not resolve riskiest assumption but provides company-wide visibility that A does not. Switch trigger: A produces no response within 2 weeks. |
| 2026-04-14 | **Challenge: A is asymmetric** | If Andy confirms Zodiac already has durability layer, A confirms a negative. Adjudication: informative failure > silent failure. The alternative (not asking) means the window closes silently without confirmation. Challenge does not weaken A. |
| 2026-04-14 | **Confidence band: moderate-high** | High confidence on the diagnosis (gap is structural/organizational). Moderate confidence on A being the right first move (depends on Andy Rifken's decision authority level, which cannot be confirmed from Glean data). |

---

## Final Summary

**The gap in one sentence:** nexus-core gets attention at Zillow because Peter Yao is a Zillow employee with institutional channel access, an established recurring demo series, and a VP-level champion in DevEx - none of which WorkRail has yet.

### Final recommendation (after adversarial challenge, tradeoff review, failure mode review, philosophy review, and runner-up comparison)

**Execution sequence:**

1. **Pre-draft the session-resurrection demo scenario** (2 hours) - show what a nexus-core session loses when a Claude conversation resets mid-flow; show WorkRail's checkpoint/resume recovering exact session state. This is the concrete artifact that makes WorkRail's value visceral. Use this for A's pitch, B's demo, and D's first-run example.

2. **Simultaneously:** Slack DM to @arifken in #ai-productivity-eng (Andy Rifken, DevEx/Zodiac team) with a 3-paragraph message: (a) what WorkRail does that nexus-core cannot, (b) where it fits below nexus-core in the Zodiac stack, (c) single concrete question: "Does Zodiac's roadmap already have a workflow durability layer planned?" AND sign up for the next available Eng & Tech AI Demo Series slot.

3. **Build `scripts/setup-zillow.sh`** in the WorkRail repo (1-2 days): install WorkRail MCP into `~/.claude/settings.json`, configure glab/acli endpoints, add common-ground Zillow workflow bundle, include the session-resurrection scenario as the Zillow "hello world" example.

4. **After A's response:** Finalize the Demo Series pitch with Andy's feedback in mind. If Zodiac has no durability layer: demo slot is about creating pressure from below. If they do: demo slot is about differentiation.

5. **If no A response in 2 weeks:** Proceed with Demo Series prep as-is.

6. **If 60 days with no movement from A+B:** Slack DM to Peter Yao first, then open a draft nexus-core MR showing the WorkRail integration.

### Strongest alternative: B standalone
If A produces no response, the Demo Series is the highest-reach fallback and a strong standalone action.

### Confidence band: moderate-high
- High confidence: diagnosis is correct (gap is structural/organizational, not technical)
- Moderate confidence: Andy Rifken is the right first contact (his decision authority level within Zodiac cannot be confirmed from Glean)
- Non-blocking: A itself will resolve this uncertainty within days of execution

### Residual risks
1. Andy Rifken's decision authority - cannot confirm without executing A
2. Demo Series slot availability - check sign-up sheet immediately after reading this
3. common-ground tooling stability for D - confirm before publishing setup-zillow.sh

**What would NOT change the gap:** more features, better documentation, or architectural improvements alone. The gap is about distribution and organizational embeddedness, not quality.
