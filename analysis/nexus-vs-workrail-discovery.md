# Nexus Ecosystem vs WorkRail: Positioning Discovery

## Context / Ask

Compare the full nexus ecosystem (nexus-core, nexus-cortex, nexus-fleet, nexus-evals, nexus-reviewer-hub, fub-nanobot, fub-public-mcp) against WorkRail to understand:

- What problem each solves
- Who each is for
- How they are packaged and distributed
- Where they overlap and differ
- Strategic implications for WorkRail

## Path Recommendation

**landscape_first** -- The dominant need here is understanding the current landscape and comparing positions. No reframing of the problem is needed; we have a clear comparative question.

## Artifact Strategy

This document is the **human-readable artifact** for review and communication. It is NOT execution memory. Execution truth lives in WorkRail step notes and context variables. If the session rehydrates from a checkpoint, this file provides context but the WorkRail session state is authoritative.

## Capability Inventory

- **Delegation:** Available via `mcp__nested-subagent__Task` (WorkRail Executor subagent model)
- **Web browsing:** Not available -- WebFetch tool not in scope for this session
- **Fallback:** All research done via `glab api` direct reads and local file reads; no external web sources needed

## Constraints / Anti-goals

- Anti-goal: Do not recommend WorkRail simply clone nexus features
- Anti-goal: Do not treat Zillow-internal deployment as disqualifying for nexus
- Constraint: Analysis must be based on observed evidence, not speculation

---

## Landscape Packet

### The Full Nexus Constellation

The initial prompt identified 8 projects. Parallel research surfaced a larger ecosystem of 17+ projects. What follows is the corrected, complete landscape.

#### Apex Nexus (65772) -- The Parent
- **Stars:** 13 (highest in the ecosystem -- predates nexus-core)
- **Team:** apex / petery
- **Note:** Appears to be the original implementation from which nexus-core forked. Last active 2026-04-10. The researcher initially treated nexus-core as the root, but this is the ancestor.

#### nexus-core (66446) -- AI Dev Workflow Plugin
- **Stars:** 11
- **Description:** "Core primitives from Apex Nexus: /flow, /plan, /work, /review, /compound, /retro -- reusable AI-powered development workflow"
- **Target users:** Developers at Zillow using Claude Code or Cursor
- **Distribution:** Plugin for Claude Code (`.claude-plugin/plugin.json`) and Cursor (`.cursor-plugin/plugin.json`); also works as "home base" where target repos are cloned into `./repos/`
- **Core capability:** Skills as slash commands: `/flow`, `/plan`, `/work`, `/review`, `/validate`, `/ship`, `/compound`, `/retro`, `/onboard`
- **Orchestrator pattern:** Opus orchestrates, Sonnet implements, Haiku verifies -- explicit model assignment per subagent, **mandatory `model=` parameter on every Task() call**
- **Home base operational model:**
  - You clone nexus-core as your working directory; target repos live in `./repos/` (gitignored)
  - `/repo org/project` clones target repos into the cache
  - Per-repo `.nexus/` sidecars: `context.yaml`, `validation.yaml`, `learnings/`
  - `scripts/inject-knowledge.sh` assembles and writes knowledge to `<repo>/.claude/instructions/nexus-context.md`
- **Session lifecycle hooks:** `session-start.sh`, `session-end.sh`, `guard-main-clone.sh` (PreToolUse Edit/Write/MultiEdit blocker), `finish-worktree.sh`
- **Plugin system:** `scripts/nexus-plugin.sh` CLI; three-mirror skill directories (`.claude/skills/`, `skills/`, `.agents/skills/`) kept in sync by `ci/check-skill-sync.sh`; cross-agent (Gemini/Codex compatible via `.agents/skills/`)
- **Knowledge bank:** Per-repo `.nexus/sidecars`, `docs/knowledge-bank/`, `/compound` and `/retro` extract learnings as committed skill patches
- **Org profiles:** `configs/profiles/zillow` pre-configures glab, acli (Atlassian CLI), Jira at jira.zgtools.net, VPN awareness; pluggable for other orgs
- **Zillow integration:** `/plan` and `/flow` fetch ticket context from Jira via `acli`
- **SOUL.md:** Agent personality principles (epistemic integrity, truth over comfort, professional standards)

#### nexus-cortex (78096) -- Knowledge Storage Service v1
- **Stars:** 0
- **Description:** "A service for storing and documenting knowledge" -- Zodiac-deployed Express.js Node.js service
- **Role:** Backend knowledge persistence for the nexus ecosystem
- **Architecture:** Standard Zillow service (ZGCP, Zodiac, ESLint/Prettier/Pino)
- **Status:** Active but not open/public

#### nexus-cortex-v2 (78097) -- Knowledge Graph (petery personal)
- **Stars:** 0 / **Owner:** petery
- **Description:** "Collective knowledge graph for engineering agents"
- **Note:** A personal experimental rewrite by petery -- implies v1 is being rethought as a graph model

#### nexus-fleet (78155) -- New, Just Created
- **Stars:** 0
- **Role:** Unknown -- brand new Next.js scaffold, no domain content
- **Status:** Scaffold only

#### nexus-evals (66787, not 66777) -- Evaluation Framework
- **Stars:** 0
- **Description:** "Evaluation system for apex-nexus skills -- proves skills improve agent success rate over baseline"
- **Location:** `fub/apex/nexus-evals` (the prompt had ID 66777 which resolves to `fub-ai-mcp`)
- **Note:** ID 66777 is `fub-ai-mcp` (FUB Consumer MCP), not nexus-evals; actual nexus-evals is 66787

#### nexus-reviewer-hub (67304) -- Code Review UI
- **Stars:** 0
- **Description:** Zodiac-linked Next.js service
- **Role:** Web UI for code review workflow results

#### nexus-logs (67127) -- Log Aggregation (petery)
- **Stars:** 0 / **Owner:** petery
- **Description:** "Local log aggregation service for AI coding agents"

#### Nexus Galaxy (66648) -- tmux Session to MR Pipeline
- **Stars:** 2 / **Owner:** petery
- **Description:** tmux session → MR pipeline validation
- **Note:** This is a workflow orchestration experiment, likely precursor or complement to nexus-core

#### nexus-planner (78050) -- Design-First Planning Tool (petery)
- **Stars:** 0 / **Owner:** petery
- **Description:** "AI-powered design-first planning tool for engineering specs"

#### nexus-auto-improve (78085) -- Autonomous Daily Improvement
- **Stars:** 0
- **Description:** "Daily incremental codebase improvement -- 1% better every day"
- **Last active:** 2026-04-14 (TODAY -- actively developed)
- **Note:** The prompt listed this at ID 78096 which is nexus-cortex; actual ID is 78085

#### nexus-test-project (66726) -- Test Harness (petery)
- **Stars:** 0 / **Owner:** petery

#### fub-nanobot (66833) -- Slack CRM Bot
- **Stars:** 0
- **Description:** "Slack-based AI assistant for real estate agents, powered by FUB MCP"
- **Target users:** Real estate agents using Follow Up Boss CRM
- **Architecture:** Python + Slack Socket Mode + Claude Sonnet + `fub-public-mcp` as MCP backend
- **Capability:** Natural language CRM operations (contacts, pipeline, tasks) via Slack
- **Distribution:** Self-hosted Python app

#### fub-public-mcp (66814) -- FUB MCP Server
- **Stars:** 1
- **Architecture:** Express 5 + TypeScript, `POST /fub/mcp` over Streamable HTTP, forwarded token auth
- **Tools surface:** People, notes, tasks, appointments, stages in FUB
- **Deployment:** ZGCP via Workload Shapes
- **Significance:** Production MCP infrastructure consumed by fub-nanobot and the gateway

#### fastmcp-external-gateway-fub-public (66946) -- MCP Proxy Gateway
- **Stars:** 0 / **Team:** zo-orca (not apex)
- **Architecture:** FastMCP v3 (Python), aggregates backends, namespaces tools, handles FUB OAuth
- **Role:** External access layer for FUB tools; different ownership than apex projects

#### Ecosystem Forks and Deployments
- **sbc-nexus** -- Fork of nexus-core by swethar for another team
- **comms-experience-nexus** -- Fork deployed in zillow/engagement-comms org (last active 2026-04-13)
- **nexus-autobeth** (20330, 21691) -- CRM automation bots in itx/premier-agent and itx/zillow-rewards

**Pattern:** Three teams have forked nexus-core for their domains. Two CRM bots use nexus patterns for non-dev use cases. petery has 6 personal R&D satellites.

---

### WorkRail

- **Version:** 3.16.0 (mature, not a prototype)
- **Distribution:** npm package (`@exaudeus/workrail`), MIT license, GitHub
- **Bundled workflows:** 27+ production workflows across 8 categories (debugging, review, documentation, discovery, learning, etc.)
- **Architecture:** MCP server with durable session engine (v2), append-only event log, cryptographic token protocol (HMAC-SHA256)
- **Session persistence:** Full cross-conversation durability via checkpoint/resume, stored in `~/.workrail/sessions/`
- **Console:** Browser-based dashboard with DAG visualization, session list, execution trace (Layers 1-3 shipped)
- **Execution model:** Token-gated step enforcement -- agent literally cannot see step N+1 until N is acknowledged
- **Workflow composition:** Routines (`wr.templates.routine.*`), `templateCall`, conditional step execution (`runCondition`), loops (`type: "loop"`), parallel delegation, output contracts
- **Discovery layers:** Bundled / user-installed (~/.workrail) / project-local / module-local; multi-root workspace config
- **Platform vision:** 5 personas defined (solo dev → platform team → open-source author); progressive complexity Level 0-4; remote references designed but not shipped
- **Authoring philosophy:** "Structured freedom" -- constrain outcomes/invariants, not cognition; never-stop by default; multi-dimensional confidence (boundary/context/policy/evidence); anti-ceremony design

---

## Problem Frame Packet

### Stakeholders

| Stakeholder | Job / Outcome | Pain / Tension |
|-------------|---------------|----------------|
| **petery / Peter Yao** (Apex team lead) | Build AI dev tooling that makes Zillow engineers faster and more reliable | Has a working system (nexus); the tension is whether enforcement-first adds value over orchestration-first |
| **Zillow engineers using nexus** (3+ orgs with forks) | Ship tickets faster with AI assistance, without AI making expensive mistakes | Need Jira/glab integration; can't use a tool that requires external npm setup |
| **WorkRail users (general)** | Guaranteed agent compliance across sessions, IDEs, and orgs | Need workflows that don't drift as context grows; want to prove process was followed |
| **Enterprise buyers / regulated teams** | Audit trail proving AI followed a defined process | Can't use nexus (Zillow-internal tooling); need WorkRail's portability and observability |
| **Solo developers (WorkRail target)** | Get senior-level workflow structure without a team or tooling setup | nexus requires VPN + glab + acli + Jira -- too heavy; WorkRail just needs npm |
| **Etienne B (WorkRail author)** | Build a product with a defensible moat and growing adoption | needs to understand where nexus competes, where it doesn't, and what WorkRail should do next |

### Core Tension

**nexus bet vs WorkRail bet:**
nexus bets that rich prompts + model routing + a learning loop produce reliable agent behavior. WorkRail bets that prompts fade and only structural enforcement (the token protocol) can guarantee step compliance.

Both bets have merit. nexus has proven the prompt-based approach works for Zillow's stack. WorkRail has proven the enforcement approach works for domain-agnostic tasks across IDEs. The tension is: **at what session length / complexity level does prompt discipline fail**, and has nexus hit that wall yet?

**Secondary tension:** nexus's knowledge accumulation (/compound, /retro, cortex) means nexus gets smarter over time. WorkRail sessions are isolated. This compounds: over time, nexus users get increasingly tailored guidance while WorkRail users get the same workflows as day one. This is the asymmetric advantage WorkRail needs to address.

### Success Criteria

For this discovery to be considered complete:
1. Clear answer on whether nexus and WorkRail compete for the same user -- **answered: different primary users**
2. Clear answer on whether Peter Yao would adopt WorkRail -- **answered: unlikely wholesale; possible at the component level**
3. Specific actionable recommendations for WorkRail -- **answered: knowledge accumulation, eval framework, auditability story**
4. No assumptions promoted to facts -- all claims tied to observed evidence
5. Framing risks named explicitly -- see below

### Assumptions (that could be wrong)

1. **Assumption:** "Peter Yao" is the nexus-core lead and makes adoption decisions. **Risk:** petery and Peter Yao may be the same person (petery = pete.r.y), but this is inferred from GitLab username + project ownership, not confirmed.
2. **Assumption:** nexus-core's 11-star adoption means active use. **Risk:** Stars on internal GitLab may not reflect actual daily use; adoption could be concentrated in Apex team alone.
3. **Assumption:** WorkRail's token enforcement is the key differentiator. **Risk:** nexus could implement a similar enforcement mechanism natively (petery has the skill for it) if prompt drift ever becomes a real problem.
4. **Assumption:** "Different target users" is the resolution. **Risk:** As WorkRail adds more dev-focused workflows and nexus adds portability, they converge. The overlap could grow.
5. **Assumption:** nexus-auto-improve ("1% better every day") is an autonomous improvement loop. **Risk:** Could be a manual workflow that just describes itself that way; the project is new and unclear.

### Framing Risks

1. **The "not competing" frame might be premature.** WorkRail is actively building dev workflows (coding-task, mr-review, bug-investigation). nexus is actively being forked across orgs. If WorkRail adds model routing hints and nexus adds an enforcement layer, they converge on the same user. The "complementary" framing could age poorly in 6 months.

2. **We're analyzing from WorkRail's perspective.** From nexus's perspective, WorkRail might be irrelevant noise -- a small npm package by an individual developer vs. an internal Zillow platform backed by an actual team. The relevant question for Apex might not be "should we adopt WorkRail?" but "what ideas from the space are worth studying?"

3. **nexus's strength might be overstated.** 11 stars on internal GitLab with VPN + glab + acli + Jira prerequisites is a high adoption barrier. The 3 forks could mean "teams adopted it" or "teams started it and abandoned it." We can't distinguish from star counts alone.

### HMW Questions (How Might We)

1. **HMW make WorkRail the enforcement layer underneath nexus's orchestrator?** Instead of "adopt WorkRail," the nexus `/review` skill calls WorkRail's `mr-review-workflow` as an MCP subprotocol. nexus provides the content; WorkRail provides the enforcement.

2. **HMW give WorkRail a learning loop without building a knowledge service?** Instead of nexus-cortex-style infrastructure, WorkRail's `wf.retro` workflow proposes patches to workflow JSON files via git commits -- same pattern as nexus's `/retro`, no backend required.

### What problem does nexus-core solve?

nexus-core solves **full-lifecycle AI development workflow** for a Zillow-profiled engineering team. It packages the Nexus Protocol (Plan, Work, Validate, Review, Learn) as slash commands that plug into Claude Code and Cursor. It handles:

- Model routing (Opus orchestrates, Sonnet implements, Haiku verifies -- mandatory `model=` per subagent)
- Per-repo knowledge accumulation (`.nexus/` sidecars, knowledge-bank entries)
- Wave-based execution with hard verification gates
- Session lifecycle hooks (session-start, session-end, guard-main-clone)
- Org-specific tooling (Jira via acli, glab, VPN awareness)
- Learning that feeds back into skill patches via `/compound` and `/retro`
- Multi-IDE support (Claude Code, Cursor, Gemini/Codex via `.agents/skills/`)

It is **skill-centric and full-stack for its org**: the entire developer workflow from ticket to merged MR is encoded in composable skills.

### What problem does WorkRail solve?

WorkRail solves **agent discipline at the protocol level** -- it enforces step-by-step execution via MCP, preventing agents from skipping ahead regardless of context window length or session drift.

WorkRail's core insight: instructions in a system prompt fade. Instructions drip-fed one step at a time cannot be skipped because the agent literally cannot see future steps until it completes the current one.

WorkRail is **domain-agnostic and enforcement-first**: it works for coding tasks, security reviews, documentation, learning, debugging -- any domain where a step sequence matters. Its moat is **structural enforcement + auditability + cross-session durability** rather than workflow content richness.

---

## Candidate Generation Expectations

**Path: landscape_first.** Candidates must be grounded in observed landscape evidence -- not free invention. Each candidate direction must trace directly to one or more findings from the Landscape Packet or Problem Frame.

**Required spread for 4 candidates:**
1. One candidate that exploits WorkRail's existing enforcement differentiator more aggressively (deepens the moat)
2. One candidate that directly closes the most critical gap identified (knowledge accumulation / learning loop)
3. One candidate that addresses convergence risk head-on (interoperability with nexus rather than competing)
4. One candidate that targets the evaluation gap (prove WorkRail workflows improve outcomes -- something nexus-evals does that WorkRail cannot)

**What to avoid:**
- Candidates that out-nexus nexus on full-lifecycle dev automation (violates anti-goal: don't clone nexus)
- Candidates that require Peter Yao's cooperation (violates decision criteria #4)
- Candidates that ignore the learning loop asymmetry (violates criteria #2)

**Extra push check (rigorMode = full):** After generating 4 candidates, verify the spread doesn't cluster around "add features to WorkRail." At least one candidate should be a genuinely different strategic bet.

---

## Candidate Directions

### How they are similar

1. Both aim to make AI agents behave like senior engineers on complex tasks
2. Both encode "verify before acting," "plan before coding," multi-perspective review
3. Both target Claude Code as primary integration
4. Both have learned about distributing workflows/skills across repos
5. Both are MIT licensed with GitHub presence

### Where they are genuinely different

| Dimension | nexus-core | WorkRail |
|-----------|-----------|---------|
| **Mechanism** | Skill/slash commands (markdown prompts + scripts) | MCP protocol enforcement (step sequencing) |
| **Enforcement** | Soft -- agent CAN ignore prompts if context degrades | Hard -- agent CANNOT get step N+1 without finishing N |
| **State** | Per-repo `.nexus/` sidecars + knowledge bank | Session state in MCP server (continueToken, HMAC-signed) |
| **Distribution** | Plugin (Claude Code + Cursor); git clone | npm package; MCP server |
| **Scope** | Full dev lifecycle skills for Zillow engineers | General workflow enforcement (any domain, any org) |
| **Learning** | Explicit (`/compound`, `/retro` → committed skill patches) | Per-session notes only; no cross-session learning |
| **Knowledge persistence** | nexus-cortex service + local `.nexus/` + knowledge-bank | Notes per step, stored in session (durable within session) |
| **Audience** | Developers with Zillow-internal tooling (glab, acli, Jira) + other orgs | General (npm, MIT, no org-specific config) |
| **Model routing** | Explicit (Opus/Sonnet/Haiku per role, mandatory) | Agent-agnostic (WorkRail does not route models) |
| **IDE support** | Claude Code + Cursor + Gemini/Codex | Any MCP client (Claude Code, Cursor, Firebender) |
| **Composition** | Flat markdown skills with embedded checklists | Declarative JSON: routines, templateCall, loops, conditionals |
| **Session durability** | Skill state via git commits; no cross-IDE resume | Cross-session checkpoint/resume via signed portable token |
| **Observability** | None -- black box execution | Browser console, DAG viz, execution trace (Layers 1-3) |
| **Backward compat** | None -- skills can change and break | Designed (not yet shipped): versioned workflows with adapter layer |
| **Cross-org portability** | Org profile system (zillow profile, pluggable) | No org profiles; fully portable by design |

### The critical difference

nexus-core is **skill-first + full-stack for its org**: gives the agent rich expert skills and trusts the orchestrator pattern to maintain discipline. It works because Apex controls their stack, can inject Jira context, and has a learning loop that improves future sessions.

WorkRail is **enforcement-first + domain-agnostic**: structurally prevents skipping via the token protocol. Works for any team, any domain, any IDE. Its moat is that the enforcement is at the API boundary -- not in the prompt, not in the context window.

**The philosophical bets:**
- nexus bet: good prompts + orchestration patterns + model routing produce reliable behavior
- WorkRail bet: prompts fade and context degrades; you need structural enforcement that can't be bypassed

---

## Challenge Notes

### Does nexus actually need WorkRail?

nexus-core achieves consistency through the Orchestrator pattern: Opus delegates, Sonnet implements, Haiku verifies. Hard verification gates exist between waves. The orchestrator's discipline comes from SOUL.md principles + skill definitions. As sessions grow long, context drift is possible -- WorkRail's structural enforcement would be more robust. But nexus hasn't named this as a blocking problem, and the `/retro` learning loop means its prompts actually improve over time.

**Verdict:** nexus doesn't need WorkRail today. It might benefit from it at very long sessions or very complex workflows.

### Does WorkRail need what nexus has?

WorkRail lacks:
1. **Cross-session knowledge accumulation** -- nexus gets smarter via `/compound` and `/retro`; WorkRail sessions are isolated
2. **Model routing** -- nexus explicitly assigns Opus/Sonnet/Haiku per role; WorkRail is model-agnostic
3. **Org profile system** -- nexus has `configs/profiles/zillow`; WorkRail has no equivalent for enterprise tooling config
4. **Full-lifecycle dev skills** -- nexus `/flow` goes ticket → MR; WorkRail has workflows but not with Jira/glab integration

These are genuine gaps for the developer audience. They are NOT gaps for WorkRail's target users who need domain-agnostic enforcement.

### Is model-agnostic actually a feature?

The depth audit made a good point: nexus's mandatory model routing is powerful when you control your stack, but it's a configuration burden for teams who don't. WorkRail's model-agnostic design means workflows run unchanged across any model. This is a genuine advantage for portability.

### What did the completeness audit find that changes the analysis?

1. **Apex Nexus (65772) is the real parent** -- nexus-core is a fork/refactor. More stars (13 vs 11).
2. **nexus-auto-improve (78085, ID was wrong)** is being actively developed TODAY -- "1% better every day" autonomous improvement. This is significant.
3. **Three org forks** of nexus-core in production (sbc-nexus, comms-experience-nexus, and a third) -- proves adoption beyond Apex
4. **petery's personal R&D constellation** (6 projects: logs, galaxy, cortex-v2, planner, test-project, galaxy) suggests active experimentation beyond the official nexus
5. **nexus-autobeth bots** in production sales/rewards teams -- nexus patterns adopted for non-dev CRM automation, proving generalization
6. **nexus-evals (66787)** exists and specifically "proves skills improve agent success rate over baseline" -- this is a rigor/measurement capability WorkRail has no equivalent of

---

## Resolution Notes

### If you were Peter Yao, would you adopt WorkRail?

Peter Yao has built an ecosystem that works: nexus-core has internal adoption, forks, CRM automation bots, a knowledge service, an eval framework, and active R&D. From his vantage:

**Arguments for:**
- WorkRail's enforcement-first mechanism would give nexus structural step compliance (vs. the current prompt-discipline model)
- WorkRail's 27+ domain-agnostic workflows would expand nexus's coverage without Apex maintaining everything
- WorkRail's cross-session durability (signed portable tokens) is superior to nexus's git-commit-based session state
- WorkRail's browser console would give nexus teams observability they currently lack

**Arguments against:**
- nexus already has mandatory verification gates and the orchestrator pattern; WorkRail's enforcement solves a problem Peter hasn't hit
- nexus has things WorkRail cannot match: model routing, knowledge accumulation, Jira integration, `/compound`/`/retro` learning loop, evaluation framework
- adopting WorkRail means adding an external npm dependency where the current system is self-contained
- the slash command UX is simpler; WorkRail's MCP invocation requires more setup
- Peter has petery's personal R&D -- he can build the enforcement mechanism natively if he ever needs it

**Honest verdict:** Peter would likely not adopt WorkRail wholesale. The enforcement gain doesn't justify the integration cost or lost capabilities. However, he might:
- Use WorkRail's `mr-review-workflow.agentic.v2.json` as the enforcement layer inside nexus's `/review` skill
- Study WorkRail's session durability design for nexus-cortex v2's architecture
- Cherry-pick the `continueToken` pattern for nexus's long-running `/flow` sessions

### If you were building WorkRail today knowing about nexus, what would you do differently?

**High confidence (nexus has a proven solution; WorkRail should learn):**

1. **Build a cross-session knowledge store.** nexus's `/compound` + `/retro` + knowledge-bank is the feature WorkRail is missing most. A `wf.retro` workflow that extracts session notes → proposed workflow patches, plus `~/workrail/knowledge/` readable by any workflow, would be a genuine moat.

2. **Ship the evaluation framework first.** nexus-evals "proves skills improve agent success rate over baseline." WorkRail has no way to prove its workflows improve outcomes. This matters for enterprise adoption: buyers want evidence, not promises.

3. **Add model routing hints to workflow definitions.** nexus's explicit `model=` per subagent matches capability to cost. WorkRail workflows could include `agentModel: "opus"` / `"sonnet"` hints that IDEs can respect. Model-agnostic is fine as default; hints enable optimization.

**Medium confidence (nexus shows the direction; WorkRail should adapt):**

4. **Ship backward compatibility before it's a crisis.** nexus has no versioning contract for skills; WorkRail's design calls for it but hasn't shipped it. "Workflows written today run forever" is a platform moat. Build it now while the workflow library is small.

5. **Build an org profile system.** nexus's `configs/profiles/` pattern is reusable. WorkRail could support `~/.workrail/profiles/` where teams configure tooling defaults (issue tracker, git host, model preferences). Lowers enterprise onboarding cost.

6. **Lean harder into auditability as the differentiated story.** nexus optimizes for speed/automation. WorkRail's moat is trust -- you can prove the agent followed the process. Security reviews, compliance workflows, regulated industries: this is where WorkRail wins decisively. The README buries this.

**Lower confidence (disagree with researcher's earlier framing):**

7. **Do NOT make WorkRail model-routing-first.** The depth audit is right: model-agnostic is a feature for portable cross-org workflows. Adding model routing would fragment the workflow library by model family. Better to let IDEs/agents handle model selection and focus WorkRail on structural enforcement.

---

## Synthesis -- Decision Shape

### The Opportunity in One Sentence

WorkRail's structural enforcement is genuinely differentiated from nexus's prompt-based approach, but WorkRail is missing the features (knowledge accumulation, evals, auditability marketing) needed to convert that differentiation into durable competitive advantage.

### Criteria the Final Directions Must Satisfy

1. **Grounded in the enforcement differentiator.** Any WorkRail recommendation must build from what WorkRail uniquely provides -- structural step compliance that cannot be bypassed -- not from trying to out-nexus nexus on content richness.
2. **Addresses the learning loop gap.** nexus gets smarter over time; WorkRail doesn't. A recommendation is incomplete if it doesn't have a credible path to cross-session knowledge.
3. **Accounts for convergence risk.** nexus is expanding portability; WorkRail is expanding dev workflows. Recommendations must be robust to a world where they're targeting the same users in 12-18 months.
4. **Requires no single-actor commitment.** WorkRail shouldn't bet on nexus adopting it. Any recommendation that requires Peter Yao to say yes is not actionable by Etienne.
5. **Names the evaluation gap.** nexus-evals proves skill quality. WorkRail has nothing equivalent. Any recommendation that doesn't mention "prove that WorkRail workflows improve outcomes" is incomplete.

### Strongest Framing Risk (Self-Challenge)

**The "complementary, not competitive" frame may be wrong, and it's the most important assumption in this analysis.**

Evidence against the frame:
- nexus has an org profile system explicitly designed for non-Zillow orgs (it wants to expand)
- WorkRail has developer-specific workflows (coding-task, mr-review, bug-investigation) that overlap directly with nexus's `/work`, `/flow`, `/review`
- nexus-auto-improve ("1% better every day") is active today -- if it learns to generalize, it could produce portable workflows
- The Apex team has demonstrated it will build whatever it needs (6 petery personal projects, 2 CRM bots, evaluation framework)

**Resolution:** The "complementary today" frame is accurate for current state. The strategic risk is convergence. WorkRail's correct response is to **deepen its structural moat** (enforcement, auditability, durability) rather than race nexus on content -- because the structural moat is something nexus cannot clone without a significant architectural rewrite.

### Remaining Uncertainty

- **Recommendation uncertainty (low):** The direction is clear -- deepen the enforcement moat, add knowledge accumulation, build evals. The uncertainty is prioritization order.
- **Research uncertainty (medium):** We don't know if nexus adoption is broad (3 forks = 3 active teams) or shallow (forked once, abandoned). Star counts on internal GitLab are unreliable signals.
- **Prototype-learning uncertainty (low):** No prototype is needed; this is a strategic analysis, not a design problem requiring proof-of-concept.

## Decision Log

- **Path:** landscape_first -- the primary question is comparative, not framing a new problem
- **Design doc location:** `/Users/etienneb/git/personal/workrail/analysis/nexus-vs-workrail-discovery.md`
- **ID corrections confirmed by completeness audit:**
  - 66777 resolves to `fub-ai-mcp`; nexus-evals is actually 66787
  - 78096 is nexus-cortex; nexus-auto-improve is actually 78085
  - nexus-auto-improve is actively developed today (2026-04-14)
- **Parallel delegation used:** Two simultaneous subagent executors (completeness + depth), synthesized by main agent
- **Claim revision:** Initial claim "Peter would not adopt WorkRail" stands, but the reasoning changes: it's not "nexus works so why bother" but "nexus has capabilities WorkRail cannot match and the enforcement gain doesn't outweigh integration cost"
- **Claim revision:** Initial claim "model-agnostic is a gap" challenged and downgraded -- model-agnostic is a design feature for portability, not a missing capability
- **New finding (depth audit):** WorkRail's workflow composition primitives (routines, templateCall, loops, conditionals) are more advanced than nexus's flat markdown skills -- this differentiator was understated in initial analysis
- **New finding (completeness audit):** nexus-evals (proves skill quality via success rate benchmarks) has no WorkRail equivalent; this is a gap for enterprise credibility
- **Candidate selection:** Initial recommendation was Candidate D (Outcome Signal Protocol). Adversarial challenge reversed this decision:
  - Schema fit attack: `outcomeSignal` as a top-level field is architecturally misaligned; the existing `artifacts[]` typed contract system is the correct mechanism if outcome signals ever ship
  - Priority attack: zero mentions of evaluation metrics in roadmap/backlog; not a current user need
  - Value attack: `wf.retro` delivers more immediate user value (qualitative improvement) than success rate dashboards (quantitative reporting without actionable context)
- **Final selected direction: Candidate A (`wf.retro`)** -- filesystem learning loop, follows existing patterns, closes the learning loop gap, delivers immediate user value
- **Runner-up: Candidate B (auditability story)** -- audit trail and trust level are the right second phase once `wf.retro` has demonstrated the learning loop value
- **Candidate C:** Publish as a low-cost interop demonstration; do not bet on adoption
- **Candidate D:** Backlog the `outcomeSignal` concept as a future typed artifact kind (`kind: "wr.outcome_signal"` under `output.artifacts[]`), not a near-term feature

---

## Final Summary

### Ecosystem Comparison

The nexus ecosystem is a **full-lifecycle AI development platform** for Zillow engineers: skills as slash commands, model routing, Jira integration, wave-based execution, cross-session knowledge accumulation, evaluation framework, and active forks across three internal teams. It is being actively developed (nexus-auto-improve updated today), has a personal R&D constellation from its lead, and has proven generalization beyond coding to CRM automation (nexus-autobeth). nexus-core (11 stars) is the deployable artifact; Apex Nexus (13 stars) is the ancestor.

WorkRail (v3.16.0) is a **protocol enforcement platform** -- its moat is structural: agents cannot skip steps because they cannot see them. Cross-session durability (signed portable tokens), browser console, declarative workflow composition, and domain-agnostic coverage (27+ workflows) distinguish it from nexus's skill-centric model.

**They are complementary today, on convergent trajectories.** nexus serves teams with custom internal tooling who need full-lifecycle automation and a learning loop. WorkRail serves teams that need guaranteed compliance, auditability, and portability across orgs and IDEs. But both are expanding: nexus is adding portability (org profile system, cross-agent support); WorkRail is adding dev-specific workflows. In 12-18 months they may target the same user.

### Strategic Recommendation for WorkRail

**Selected direction: `wf.retro` (Candidate A, v1 hybrid)**

A bundled workflow (`workflows/wf.retro.json`) that:
1. Scans `~/.workrail/sessions/` for recent sessions -- required note quality pre-check first step
2. Extracts learnings using agent synthesis with explicit anti-sycophancy instructions (look for uncertainty, failure patterns, edge cases -- not confirmation of success)
3. Outputs a markdown report with extraction confidence disclosure (`high/medium/low` with recommended action when low)
4. Defers git-committed workflow patch proposals to v2

This is a workflow authoring task only. No schema changes, no new infrastructure, no engine changes. Ships immediately.

**Why `wf.retro` first (not outcome signals, not auditability):**
- Closes the learning loop gap -- the most important asymmetry between nexus and WorkRail
- Actionable by Etienne alone; no external cooperation required
- Delivers immediate user value (qualitative improvement) before enterprise positioning (quantitative metrics)
- Backward-compatible; follows existing patterns exactly
- Adversarial challenge confirmed: Candidate D (outcome signals) has schema fit issues and is not in the current roadmap

**Phase 2: Candidate B (audit/trust level)** once `wf.retro` has demonstrated learning loop value.

**Phase 3: Candidate C (nexus-workrail-bridge)** as a low-cost interop demonstration (~1 day), signaling the interoperability play without betting on Peter Yao's cooperation.

**Backlog: Candidate D** -- outcome signal protocol as a typed artifact kind (`{kind: "wr.outcome_signal"}` under `output.artifacts[]`) when the user base reaches scale where workflow quality metrics matter.

### Confidence Band and Residual Risks

**Confidence: medium-high.** The strategic direction (wf.retro) is well-grounded. The specific workflow JSON authoring is implementation work that follows.

**Residual risks:**
1. Thin session notes make retro useless (mitigated by required quality scan step)
2. Convergence risk at 12-18 months requires monitoring (not a blocking concern now)
3. nexus adoption breadth is unverifiable from star counts alone (research uncertainty; does not affect recommendation)
4. nexus-fleet purpose unknown (just scaffolded; not relevant to WorkRail's direction)

### The Interoperability Angle

The most elegant long-term play: nexus orchestrates; WorkRail enforces. nexus's `/review` skill could call WorkRail's `mr-review-workflow` via MCP. nexus provides the context (Jira, glab, model routing); WorkRail provides the step enforcement. No architectural conflict; both get stronger. Publish a nexus plugin repo to signal this is possible.
