# Competitive Landscape: Structured Workflow Enforcement for AI Agents

## Context / Ask

Find everything that exists in the space of "structured workflow enforcement for AI agents" --
specifically tools that do what WorkRail does or tries to do: enforce step sequencing, provide
durable session state, make agents follow a defined process rather than improvising.

## Path Recommendation

`landscape_first` -- The dominant need is understanding the external and internal competitive
landscape. Both the problem and WorkRail's solution are well-defined. No reframing required.
The discovery is empirical: gather, classify, compare.

`landscape_first` is justified over `full_spectrum` because:
- WorkRail's own identity is clear (token-gated MCP server with HMAC enforcement)
- The question is specifically about external competitors and complements, not about
  what WorkRail should be
- No risk of solving the wrong problem -- the framing is the user's explicit ask

`design_first` rejected: no design decision to be made here; the output is a map, not a design.

## Constraints / Anti-goals

**Constraints:**
- GitHub search via `gh` CLI available and probed successfully
- Glean internal search available and probed successfully
- Existing `nexus-vs-workrail-comparison.md` provides deep nexus-core baseline

**Anti-goals:**
- Not a WorkRail feature backlog (findings may inform one, but this doc does not produce one)
- Not a migration plan or vendor analysis
- Not about general AI agent orchestration (LangChain, AutoGPT) unless they have specific
  step-sequencing enforcement mechanisms

---

## Landscape Packet

### The Core Problem WorkRail Solves

AI agents are non-deterministic. Given a multi-step process, an LLM agent will:
1. Skip steps it considers unnecessary
2. Merge steps when context window pressure increases
3. Forget earlier constraints as conversation grows
4. Hallucinate step completion ("I've reviewed the code" without reviewing it)

Most frameworks address this via **prompt engineering** -- instructing the agent to follow steps.
WorkRail addresses it via **structural enforcement** -- the agent literally cannot receive step N+1
until it acknowledges step N with a cryptographically signed token.

The second unique property is **durable session state**: the ability to save a workflow's exact
position and resume it in a new context window, on a different machine, or after a crash.

### Taxonomy of Approaches

Three distinct mechanisms for structuring agent behavior:

1. **Prompt-based enforcement** (soft) -- markdown checklists, SOUL.md files, CLAUDE.md
   instructions. Agent can ignore them under pressure.

2. **Graph/DAG enforcement** (structural, no durability) -- LangGraph, CrewAI, AutoGen.
   Steps are code nodes; the agent cannot skip them at the graph level. But state lives
   in memory; no cross-session resume.

3. **Durable token-gated enforcement** (structural + durable) -- WorkRail, Temporal.io
   (for general code, not agents specifically). Steps are server-side; cryptographic tokens
   prevent skipping; state persists to disk.

---

## External Landscape

### Tier 1: Direct Competitors (Same Problem, Different Approach)

#### mcp-graph (DiegoNogueiraDev/mcp-graph-workflow) -- 29 stars
- **What it does**: MCP server that converts PRD text files into persistent execution graphs
  (SQLite). Structured 9-phase lifecycle from PRD to production. 45 unified MCP tools.
  "Zero AI fallback" -- deterministic-first architecture.
- **Step enforcement**: Graph-based. SQLite persistence means sessions survive restarts.
  Lock-based task claiming for multi-terminal orchestration.
- **Durable session state**: Yes -- SQLite-backed. Closer to WorkRail than any other external
  project found.
- **Stars/Language**: 29 stars, TypeScript
- **License**: MIT
- **vs WorkRail**: Focused on software development PRD-to-code pipeline specifically.
  WorkRail is domain-agnostic. mcp-graph uses graph/SQLite; WorkRail uses token-gated steps
  with HMAC signing. mcp-graph has 45 tools (heavy); WorkRail has 8 tools (light).
  mcp-graph has no token protocol -- enforcement is graph-structural, not cryptographic.
- **Concern level**: Medium. Most similar architecture found externally. Early but active.

#### oracle/agent-spec -- 327 stars
- **What it does**: Platform-agnostic configuration language (Python SDK: PyAgentSpec) for
  defining agentic systems. Defines Agents (ReAct-style conversational) and Flows
  (structured, workflow-based processes). Serializes to JSON/YAML. Reference runtime: WayFlow.
- **Step enforcement**: Declarative spec -- enforcement depends on the runtime adapter.
  WayFlow provides execution, but it's the spec that's the product, not the runtime.
- **Durable session state**: Not in the spec itself; runtime-dependent.
- **Stars/Language**: 327 stars, Python (Oracle project)
- **License**: UPL-1.0 (permissive)
- **vs WorkRail**: oracle/agent-spec is a description language; WorkRail is an execution engine.
  They could coexist: agent-spec could describe a workflow that WorkRail enforces. The key
  gap in agent-spec is that it doesn't enforce anything at runtime -- that's left to adapters.
  WorkRail's token protocol is not representable in agent-spec (it's execution mechanism, not
  workflow description).
- **Concern level**: Low-medium. Oracle's backing means it could gain traction, but it's
  a spec layer, not a runtime competitor.

#### nikhilw/structured-agentic-workflow -- 2 stars
- **What it does**: "Set of skills and workflows to ensure humans and agents stay focused while
  vibe-coding." CLAUDE.md-style instructions for structured process.
- **Step enforcement**: Prompt-based only.
- **Concern level**: None. Markdown conventions, not an engine.

### Tier 2: Architectural Comparables (Different Domain, Same Concepts)

#### Temporal.io (temporalio/temporal) -- 19,586 stars
- **What it does**: Durable execution platform. Workflows are code (Go, Java, TypeScript, Python).
  The Temporal server stores execution state, replays on failure, handles retries automatically.
  The workflow code is deterministic -- same inputs, same outputs, regardless of failures.
- **Step enforcement**: Code-level. Each activity is a discrete unit; the Temporal server
  enforces sequencing via event sourcing / history replay. **Cannot skip an activity.**
- **Durable session state**: Yes -- this is Temporal's primary value proposition. Workflows
  survive server restarts, network failures, and arbitrary delays. Zillow's mortgage team
  (zillow-home-loans/experimental/orion) is already experimenting with Temporal + LangGraph.
- **Stars/Language**: 19,586 stars, Go
- **License**: MIT
- **vs WorkRail**: Temporal requires writing code; WorkRail requires writing JSON.
  Temporal is for production distributed systems; WorkRail is for AI agent process governance.
  The conceptual models are nearly identical (durable step sequencing, event sourcing,
  checkpoint/resume). Temporal does not natively understand MCP or AI agents.
  The Temporal + LangGraph combination (as in the orion repo) is the closest conceptual
  analog to WorkRail's value proposition at production scale.
- **Concern level**: Low (different use case). High interest value (should study).

#### Prefect (PrefectHQ/prefect) -- 22,177 stars
- **What it does**: Workflow orchestration for data pipelines. Flows are Python functions;
  tasks are discrete units. State tracked in Prefect server. Retries, caching, scheduling.
- **Step enforcement**: Task-level. Cannot skip tasks in the DAG.
- **Durable session state**: Yes -- Prefect server tracks flow runs and task states.
- **vs WorkRail**: Same durability story, different domain (data pipelines vs AI agent process).
  No MCP awareness. No AI-specific enforcement patterns.
- **Concern level**: None (different domain).

#### Dagster (dagster-io/dagster) -- 15,323 stars
- **What it does**: Orchestration platform for data assets and pipelines. Asset-centric model.
- **vs WorkRail**: Same pattern (durable, structured), different domain. No AI agent focus.
- **Concern level**: None.

### Tier 3: Graph-Based Agent Frameworks (Structural but Not Durable)

#### LangGraph (langchain-ai/langgraph) -- 29,266 stars
- **What it does**: Low-level orchestration framework for building stateful agents. Nodes are
  Python functions; edges define flow. Durable execution via LangSmith Deployment (managed
  runtime). Three persistence modes: exit (checkpoint at completion), async (async save), sync
  (synchronous save before each step). Cross-process resumption via thread IDs; Postgres-backed
  in production. Explicitly claims: "Build agents that persist through failures and can run for
  extended periods, automatically resuming from exactly where they left off."
- **MCP integration**: LangGraph **consumes** MCP tools (agents discover and invoke MCP servers).
  Does NOT expose workflows as MCP tools. Integration is unidirectional (tool-consumer only).
  Active community: 694-star teddynote-lab/langgraph-mcp-agents, 579-star esxr/langgraph-mcp.
- **Step enforcement**: Graph-structural (cannot skip code nodes in DAG). NOT cryptographic --
  no token-gated enforcement. Agent has full visibility into graph topology at construction.
  No zero-knowledge step revelation.
- **Durable session state**: Yes, via LangSmith Deployment. Thread-ID-based resumption.
  This closes the durability gap with WorkRail but not the enforcement gap.
- **Stars/Language**: 29,266 stars (LangGraph) + 133,571 stars (LangChain parent). Python.
  Actively maintained (pushed 2026-04-14).
- **vs WorkRail**: LangGraph requires Python code; WorkRail requires JSON.
  LangGraph is a flexible agent runtime (graph as code, full topology visible);
  WorkRail is a workflow enforcement engine (workflow as data, one step at a time).
  LangGraph's enforcement is code-structural; WorkRail's is cryptographic.
  LangGraph is MCP-tool-consumer; WorkRail is MCP-tool-server (exposes workflows as MCP).
  LangGraph requires LangChain ecosystem; WorkRail is framework-agnostic.
- **Concern level**: Medium-high. Durability is now a shared claim. Differentiation via
  MCP-native, JSON-authored, token-gated enforcement remains clear and unique.

#### CrewAI (crewAIInc/crewAI) -- 48,894 stars
- **What it does**: Multi-agent framework. "Crews" of agents each have roles and goals.
  Tasks are assigned to agents. Agents collaborate via message passing.
- **Step enforcement**: Task execution order is defined in the crew configuration.
  Sequential, parallel, or hierarchical process modes.
- **Durable session state**: Limited. Memory features (short-term, long-term, entity memory)
  but no cross-session checkpoint/resume for crew execution.
- **Stars/Language**: 48,894 stars, Python
- **vs WorkRail**: CrewAI is for multi-agent coordination; WorkRail is for single-process
  step enforcement. CrewAI has no token-gated enforcement -- agents can deviate from task
  assignments via prompt. CrewAI has significantly more stars but a different use case.
- **Concern level**: Low (different problem).

#### Microsoft AutoGen (microsoft/autogen) -- 57,085 stars
- **What it does**: Framework for multi-agent conversations. Agents send messages to each
  other; conversation is the coordination mechanism.
- **Step enforcement**: Conversation-based. No explicit step sequencing enforcement.
- **Durable session state**: Limited -- mainly in-memory or via custom persistence.
- **Stars/Language**: 57,085 stars, Python
- **vs WorkRail**: AutoGen is a conversation framework, not a process enforcer. The
  "workflow" emerges from conversation, not from a pre-defined sequence of steps.
- **Concern level**: None (different problem entirely).

### Tier 4: Prompt-Based (Same Problem, Weaker Enforcement)

#### nexus-core (Peter Yao, internal Zillow)
- Covered in depth in `nexus-vs-workrail-comparison.md`. Key verdict: prompt-based
  enforcement degrades under context pressure. No durable session state.
- **Concern level**: Low (complementary, not competitive).

#### nikhilw/structured-agentic-workflow, lleewwiiss/opencode-maestro
- CLAUDE.md / markdown instruction files with structured process guidance.
- **Concern level**: None.

#### oyi77/ADbS (Ai Dont be Stupid) -- 1 star
- Cross-platform Agentic Workflow Enforcer via CLAUDE.md / SDD patterns.
- Prompt-based only.
- **Concern level**: None.

### Tier 5: Related But Different Scope

#### SWE-agent (SWE-agent/SWE-agent) -- 18,988 stars
- Automated software engineering agent that fixes GitHub issues. Structured task execution
  but not a general workflow enforcement framework.
- **Concern level**: None.

#### n8n (n8n-io/n8n) -- 184,074 stars
- Workflow automation platform (think Zapier/Make but self-hostable). Visual workflow builder.
  Not AI-agent-specific; no step enforcement against agent deviation.
- **Concern level**: None (different category).

---

## Internal Landscape (Zillow) -- Updated with Deep Research

### Zodiac (DevEx team)

Zodiac is Zillow's **service catalog and developer portal**, not an AI agent workflow enforcement platform.

- **AI Marketplace** (March 2026): Discovery, sharing, and installation of Agent Skills (markdown-based), MCP servers, and hooks
- **Background Agents**: Validate and safety-check newly submitted Skills and MCPs
- **Agent Readiness Scorecards**: Coming feature to audit codebase AI-readiness
- **No step enforcement**: Zodiac does not prevent agents from skipping steps
- **No durable session state**: No checkpoint/resume capabilities
- **No workflow execution engine**: Zodiac is a registry/marketplace, not a runtime

Relationship to WorkRail: Zodiac is a distribution surface. WorkRail could be listed in the Zodiac AI Marketplace as an MCP. These are not competing -- Zodiac is catalog infrastructure, WorkRail is execution enforcement.

### SET / DevEx Platform

No dedicated "SET" team found matching the 2026 Engineering AI Strategy reference. DevEx sub-teams (Platform Engineering/ZGCP, Delivery/GitLab, Observability, Zodiac) provide infrastructure but none provides workflow execution or step enforcement for AI agents. The 2026 strategy's reference to "SET owns the platform for authoring/operating workflows" appears aspirational, not describing an existing system.

### nexus-core (Peter Yao, FUB team)

Most relevant internal comparison. Deep analysis in `nexus-vs-workrail-comparison.md`.
Prompt-based enforcement (degrades under context pressure), no durable session state.
Distribution: Zodiac AI Marketplace as a Claude Code plugin.
Complementary to WorkRail, not a competitor.

### Apex Nexus (Apex team, FUB)

Production system from which nexus-core was extracted. Orchestrates FUB development lifecycle via Claude Code skills. Agent-only (Claude Code), prompt-based enforcement, ephemeral sessions. No durable state.

### CIAME RS SDK Agent Execution Contracts (Samuel Pérez, CIAM team)

Structured contracts in `docs/standards/rs-sdk-agent-execution-contract.md` governing agent behavior during batch code migration. 3-phase skill set (discover, migrate, review-handoff) with explicit verification gates. Enforcement is prompt-based only; session state via markdown sidecar files.

**Strongest internal demand signal for WorkRail**: a team is manually constructing structured agent process governance in markdown because no better internal tool exists. This is WorkRail's problem statement implemented by hand.

### Temporal.io exploration (Chris Botaish, Zillow Home Loans)

`zillow-home-loans/experimental/orion` -- Temporal + LangGraph integration for durable AI agents. Demonstrates interest in durable agent execution at Zillow, outside WorkRail. Separate workstream; no overlap with WorkRail's MCP approach.

### zagent (Sophie Ge, CoreTech)

Claude Code + Docker sandbox wrapper. Problem axis: blast radius reduction (safety), not step compliance. Not a WorkRail competitor.

### TCE harness (Sergei S, TCE team)

Sandboxed Build-Code Review-Verify loop. CI-style verification focus, not step enforcement. Not a WorkRail competitor.

### Zillow AI Tools Catalog (David Plott)

`zg-ai-tools-catalog.md` -- WorkRail is not listed. nexus-core is listed under both "Enforce team conventions via AI" and "Orchestrate multi-agent workflows." **Gap**: WorkRail is invisible to the internal catalog. Direct adoption opportunity.

---

## Competitive Map: Where WorkRail Fits

```
                   ENFORCEMENT STRENGTH
                   Weak (Prompt)         Strong (Structural)
                ┌─────────────────────┬──────────────────────────┐
          Yes   │  nexus-core          │  WorkRail [MCP/JSON]     │
DURABLE         │  CIAME contracts     │  Temporal.io [code/Go]   │
STATE           │  LangGraph+LangSmith │  mcp-graph [MCP/SQLite]  │
                ├─────────────────────┼──────────────────────────┤
          No    │  CLAUDE.md files     │  LangGraph (standalone)  │
                │  ADbS, maestro       │  CrewAI, AutoGen         │
                │                     │  Prefect/Dagster         │
                └─────────────────────┴──────────────────────────┘
```

**Key observation**: LangGraph with LangSmith Deployment moves from bottom-right to top-left --
it has durability but NOT cryptographic step enforcement (enforcement is graph-structural + prompt).

**WorkRail occupies the top-right quadrant uniquely** in the MCP-native, JSON-authored space.
Other top-right occupants: Temporal.io (code-based Go, not MCP, not AI-specific) and mcp-graph
(early, PRD-to-code focused, no token protocol).

---

## Projects WorkRail Should Study

### High Priority

1. **Temporal.io** -- Not a competitor but the conceptual ancestor. WorkRail's token-gated
   step sequencing is essentially Temporal's durable execution model applied to AI agents via
   MCP. Study: event sourcing for history replay, workflow versioning strategy, signal/query
   patterns for human-in-the-loop. The Zillow orion experiment is worth following.

2. **LangGraph** -- The most serious structural competitor. LangGraph Server adds durability;
   the combination approaches WorkRail's value proposition. Study: how LangGraph handles
   conditional branching and subgraph composition. Watch: whether LangGraph adds MCP-native
   support (would shift the competitive picture significantly).

3. **mcp-graph** -- The closest external analog to WorkRail as an MCP server with persistent
   graphs. 29 stars but architecturally aligned. Study: their 9-phase lifecycle model and
   SQLite schema. Watch: if it gains traction, it's the most direct external competitor.

### Medium Priority

4. **oracle/agent-spec** -- A description language for agents. If it becomes a standard,
   WorkRail workflows could implement the spec as a runtime. Alternatively, WorkRail could
   produce agent-spec-compatible workflow descriptions. Low urgency but high strategic value
   if Oracle pushes adoption.

5. **Zodiac/SET (internal)** -- The Zillow platform layer for workflows and AI agents. WorkRail
   should understand whether Zodiac is building anything that overlaps with WorkRail's
   enforcement model. The 2026 Engineering AI Strategy explicitly assigns "workflow platform"
   to Zodiac/SET. WorkRail should either integrate with that story or differentiate clearly.

---

## Key Findings Summary

1. **WorkRail's top-right quadrant (durable + structural enforcement, MCP-native) is nearly empty
   externally.** The closest external tool is mcp-graph (29 stars, early). LangGraph + LangSmith
   provides durability but NOT cryptographic enforcement (moves to durable+prompt quadrant, not
   durable+structural). WorkRail's three-way intersection (MCP server + JSON-authored + token-gated)
   has no current occupant besides WorkRail itself.

2. **Internally, the problem WorkRail solves is being reinvented in markdown** -- CIAME's RS SDK
   agent execution contracts are essentially a manual WorkRail without the token system. This
   is a strong signal: the demand is real but the solution is fragmented. The CIAME team is the
   most concrete internal adoption candidate; engage for a discovery conversation.

3. **The prompt-enforcement tier (nexus-core, CLAUDE.md) is crowded.** This is not where WorkRail
   competes. WorkRail's moat is the structural impossibility of skipping steps combined with
   durable cryptographic audit trail.

4. **Temporal.io is the architectural ancestor to study**, not to compete with. If you know
   Temporal.io, WorkRail is Temporal for AI agent process governance via MCP -- durable step
   sequencing without writing Go or Java or deploying a Temporal server. Its durability model
   is production-proven at massive scale. Study its workflow versioning strategy and signal/query
   patterns for human-in-the-loop as WorkRail's durability model matures.

5. **The internal catalog gap is the single most actionable finding.** WorkRail is not listed in
   the ZG AI Tools Catalog or Zodiac AI Marketplace. nexus-core is listed under both relevant
   categories. Closing this gap requires zero architecture change -- only distribution and
   outreach effort.

6. **LangGraph's MCP-server direction is the primary watch condition.** LangGraph already generates
   MCP schemas for introspection (`assistants.read` context). If they expose workflows as MCP
   tools, WorkRail's MCP-native moat shrinks. Response if this happens: shift positioning to
   lead with 'JSON-authored workflows + token-gated cryptographic enforcement' as the remaining
   two axes. Watch LangGraph's GitHub for this feature.

7. **Zodiac/SET platform risk is real but timing uncertain.** The 2026 Engineering AI Strategy
   references 'SET owns workflow platform' as an aspiration. If this becomes a funded project,
   C3 (Zodiac listing) urgency escalates from 'opportunistic' to 'table stakes.' Watch for team
   and budget announcements. If it materializes: list immediately + begin architectural deepening
   (C2 study agenda) to establish differentiation before platform feature parity.

---

## Final Summary

### Recommendation

**WorkRail's position is well-differentiated today and should be maintained through two actions:**

**C1 -- Narrow, Falsifiable Positioning** (immediate):
Position WorkRail as the tool at the three-way intersection: MCP server + JSON-authored
workflow definition + token-gated cryptographic step enforcement. Lead with user benefit:
"Works with any MCP client. No Python required. No LangChain dependency. Steps enforced
cryptographically -- the agent cannot receive step N+1 without acknowledging step N."

Educational anchor: "If you know Temporal.io, WorkRail is Temporal for AI agent process
governance via MCP -- durable step sequencing without deploying a Temporal server."

**C3 -- Internal Distribution** (immediate, zero architecture cost):
List WorkRail in the Zodiac AI Marketplace and ZG AI Tools Catalog. Engage the CIAME team
(Samuel Pérez, CIAM Enablement) for a discovery conversation -- they are building WorkRail's
problem manually in markdown (`rs-sdk-agent-execution-contract.md`).

**C2 -- Temporal Study Agenda** (medium-term, deferred):
Follow the Zillow `orion` repo (Chris Botaish, Zillow Home Loans -- Temporal + LangGraph
integration). Study Temporal's workflow versioning strategy and signal/query patterns.
Revisit whether `snapshot-store.port.ts` should evolve toward event-sourcing replay semantics
when crash-recovery failures are observed in practice.

### Confidence Band: HIGH

- Landscape: mapped from primary sources (gh api, Glean direct search, README reads, parallel subagent research)
- Differentiation: falsifiable binary comparisons (LangGraph is not an MCP server; mcp-graph is not token-gated)
- Internal gaps: evidence-grounded (CIAME doc found directly; catalog absence confirmed)
- Failure modes: named with explicit response conditions (not just 'risks exist')

### Residual Risks (3)

1. **ORANGE**: LangGraph adds MCP-server exposure. Response specified: shift positioning to JSON-authored + token-gated as the remaining moat.
2. **ORANGE**: Zodiac/SET announces workflow execution timeline. Response specified: accelerate C3 listing + C2 architectural deepening.
3. **YELLOW**: Zodiac listing process and 2026 Strategy team/budget unknown. Open questions.

---

## Open Questions

1. What is the actual process for self-submitting an MCP to the Zodiac AI Marketplace?
2. Is there a team and budget behind the 2026 Strategy's 'SET owns workflow platform' statement, or is it aspirational?
3. Is the CIAME team's RS SDK migration workflow a fit for WorkRail's step-enforcement model?
4. Has the Zillow `orion` repo (Temporal + LangGraph) produced shareable architectural learnings?
5. Should the C2 study agenda (Temporal patterns) be tracked as a formal WorkRail milestone or pre-roadmap research?

---

## Problem Frame Packet

### Primary Users / Stakeholders

| Stakeholder | Job / Outcome | Pain / Tension |
|---|---|---|
| **Etienne Beaulac** (WorkRail author) | Understand where WorkRail fits; decide what to study or be concerned about | Is WorkRail differentiated enough? What could make it obsolete? |
| **Potential WorkRail adopters** (Zillow teams) | Run structured multi-step AI processes without agents skipping steps | Finding and evaluating WorkRail vs. alternatives they already know |
| **nexus-core users** (FUB / broader Zillow) | Execute dev lifecycle workflows reliably | When does the enforcement gap in nexus-core become a real problem? |
| **CIAME team** (Samuel Pérez et al.) | Structure complex multi-session agent work (RS SDK migration) | Currently solving WorkRail's problem by hand in markdown |
| **LangChain ecosystem users** | Build production AI agents with durable execution | LangGraph requires Python; doesn't provide token-gated enforcement |

### Core Tension

**Ease vs. enforcement**: Most teams reaching for structured agent workflows will pick the lowest-friction option first (CLAUDE.md, nexus-core, LangGraph). WorkRail's enforcement model is more reliable but requires a deliberate choice to use it. The question is whether teams discover the need for structural enforcement before or after their first enforcement failure.

**Ecosystem gravity vs. design purity**: LangGraph has 133k+29k stars and LangChain ecosystem integration. WorkRail has correct design (zero-knowledge step revelation, HMAC-signed tokens) but is a solo project. Ecosystem gravity can matter more than design correctness at adoption time.

### Success Criteria for This Discovery

1. Can identify every tool in the durable+structural-enforcement quadrant (complete map)
2. Can articulate WorkRail's specific differentiation against each named tool
3. Can name at least one project WorkRail should actively study (architectural learning)
4. Can name at least one real framing risk (what could make this analysis wrong)
5. Internal landscape is grounded in actual Glean evidence, not assumptions

### Key Assumptions (Explicit)

- "Structural enforcement" means the agent cannot receive step N+1 without cryptographically
  acknowledging step N -- not just "code prevents it" or "prompt says so"
- "Durable" means session survives process restart and is resumable by any compatible client
- WorkRail's MCP-native approach is a genuine differentiator (other tools are not MCP servers)
- The internal Zillow landscape represents the primary adoption surface

### Reframes / HMW Questions

1. **HMW**: What if the real market is not "agent step enforcement" but "human-in-the-loop workflow governance"? WorkRail's `requireConfirmation` step type and checkpoint tokens already address this -- but it's not how WorkRail is currently positioned. Reframe: WorkRail is a durable human-AI collaboration protocol, not just an agent enforcement engine.

2. **HMW**: What if the threat is not LangGraph or mcp-graph but rather LLM models getting better at following instructions reliably? If GPT-5/Claude 4 follows process prompts with 99.9% fidelity, prompt-based enforcement converges with structural enforcement, and WorkRail's cryptographic model loses its primary value. Counter: The token protocol's value is not just enforcement fidelity -- it provides auditability and resumability regardless of model compliance.

### Framing Risks

1. **LangGraph's MCP-server direction**: LangGraph already generates schemas for MCP introspection (`assistants.read` context). If they expose workflows as MCP tools, WorkRail's MCP-native position is no longer unique. This is a real near-term risk.

2. **The "good enough" problem**: Teams may reach for nexus-core + careful prompting rather than WorkRail because the marginal enforcement value doesn't justify the additional tool. The CIAME case (building it manually in markdown) suggests demand, but also suggests teams will build workarounds before adopting a new tool.

3. **Internal platform gap**: If Zodiac/SET eventually build a workflow execution layer into Zodiac (a logical extension of the AI Marketplace), WorkRail's internal opportunity could shrink. The 2026 strategy hint ("SET owns workflow platform") may be prescriptive, not descriptive -- but it signals intent.

---

## Candidate Directions

### Direction 1: WorkRail as MCP-Native Durable Enforcement Layer (Narrowly Positioned)

**One-sentence summary**: Position WorkRail as the MCP-native, JSON-authored, token-gated workflow enforcement engine -- the exact tool for teams that need step compliance + durability on top of any MCP-compatible agent, without writing Python or adopting LangChain.

**Tensions resolved**:
- Resolves: framework-native vs MCP-native (WorkRail is the MCP-native answer by definition)
- Resolves: durability breadth vs depth (WorkRail's cryptographic audit trail is explicitly deeper than thread-ID resumption)
- Accepts: adoption friction (does not try to reduce it -- owns the deliberate-adoption niche)

**Boundary solved at**: The three-way intersection of (1) MCP server, (2) JSON-authored workflow, (3) token-gated cryptographic enforcement. No other tool occupies this intersection today.

**Specific failure mode**: If LangGraph adds MCP-server exposure (expose workflows as MCP tools), this positioning loses its MCP-native uniqueness. Watchable via LangGraph's GitHub `assistants.read` introspection context, which already generates MCP schemas.

**Relation to existing patterns**: Directly follows repo architecture (`payloads.ts` HMAC tokens, `ExecutionState.pendingStep`, `snapshot-store.port.ts` disk persistence). No change to core.

**Gains**: Clear, falsifiable differentiation. 'Is LangGraph an MCP server?' is a binary question. WorkRail wins until it isn't.
**Gives up**: Broad adoption (narrow position = smaller initial market).

**Impact surface**: Zodiac AI Marketplace listing (distribution), ZG AI Tools Catalog entry (discoverability), CIAME team as reference adopter.

**Scope judgment**: Best-fit. Matches the evidence: the moat is architectural, not ecosystem.

**Philosophy**: Honors 'make illegal states unrepresentable', 'determinism over cleverness', 'architectural fixes over patches'. No conflicts.

---

### Direction 2: WorkRail as Temporal.io for MCP Agents (Study-Driven Positioning)

**One-sentence summary**: Acknowledge Temporal.io as the production-grade ancestor, study its event-sourcing and workflow-versioning patterns, and evolve WorkRail's durability model toward the same guarantees -- positioning WorkRail as "Temporal for AI agents via MCP" rather than as an independent category.

**Tensions resolved**:
- Resolves: durability breadth vs depth (studies Temporal's proven model to deepen WorkRail's guarantees)
- Resolves: enforcement fidelity vs adoption friction (uses Temporal's brand recognition to explain the value proposition)
- Accepts: time investment (studying Temporal is a deliberate research cost)

**Boundary solved at**: The architectural seam between WorkRail's current snapshot-store (disk-persisted sessions) and Temporal's event-sourcing with history replay. The gap is that WorkRail does not currently replay step history to reconstruct state after a failure; Temporal does.

**Specific failure mode**: WorkRail could adopt Temporal's complexity without Temporal's ecosystem support, creating a heavy maintenance burden on a solo project.

**Relation to existing patterns**: `snapshot-store.port.ts` is already abstracting the persistence layer. Adapting toward event-sourcing would extend rather than replace this abstraction.

**Evidence grounding**: Zillow's `orion` repo (Chris Botaish) is already combining Temporal + LangGraph for durable AI agents. WorkRail can learn from this workstream without competing with it.

**Gains**: Deeper durability guarantees, better vocabulary for explaining WorkRail to teams who know Temporal.
**Gives up**: Simplicity. WorkRail's current model is simpler than Temporal's; studying Temporal is valuable but adoption of Temporal patterns increases complexity.

**Scope judgment**: Best-fit for a medium-term learning agenda. Not an immediate architectural change.

**Philosophy**: Honors 'architectural fixes over patches' (event sourcing is the architectural fix for replay). Mild tension with 'YAGNI with discipline' (don't build Temporal's full replay machinery without demonstrated need).

---

### Direction 3: WorkRail as Internal Zillow Standard via Zodiac + CIAME Adoption (Opportunistic)

**One-sentence summary**: Address the internal visibility gap immediately -- list WorkRail in the Zodiac AI Marketplace and ZG AI Tools Catalog, and engage the CIAME team (who are building WorkRail's problem manually in markdown) as a reference adopter.

**Tensions resolved**:
- Resolves: internal opportunity vs internal competition (act before Zodiac/SET builds a competing workflow execution layer)
- Resolves: adoption friction (distribution via Zodiac = teams find WorkRail where they're already looking)
- Accepts: platform risk (if Zodiac/SET later build a workflow execution layer, WorkRail still benefits from established adoption)

**Boundary solved at**: The Zodiac AI Marketplace listing + ZG AI Tools Catalog entry. These are distribution surfaces, not architectural changes. The CIAME case is a concrete adoption entry point.

**Specific failure mode**: Zodiac/SET build a workflow execution layer into Zodiac, making WorkRail's listing a dependency on a platform that competes with it. Risk is real (2026 strategy signals intent) but timing is uncertain.

**Relation to existing patterns**: WorkRail already supports distribution via `WORKFLOW_GIT_REPOS` and npm (`@exaudeus/workrail`). Zodiac listing is an additional distribution channel, not an architectural change.

**Evidence grounding**:
- CIAME `rs-sdk-agent-execution-contract.md` is WorkRail's problem implemented manually
- `zg-ai-tools-catalog.md` lists nexus-core but not WorkRail
- Zodiac AI Marketplace launched March 2026 -- currently distributes Skills and MCPs

**Gains**: Internal discoverability, a reference adopter (CIAME), and a hedge against platform preemption.
**Gives up**: Nothing architecturally. Pure distribution and relationship investment.

**Scope judgment**: Narrower than ideal as a standalone direction, but pairs naturally with Direction 1 (correct positioning + correct distribution).

**Philosophy**: Honors 'surface information, don't hide it' (if WorkRail solves CIAME's problem, say so). No conflicts.

---

## Challenge Notes

### Comparison Matrix (Tensions x Candidates)

| Tension | C1 (Narrow Positioning) | C2 (Study-Driven) | C3 (Internal Distribution) |
|---|---|---|---|
| Enforcement fidelity vs adoption friction | Accepts friction, owns niche | Neutral | Reduces friction (better discoverability) |
| Framework-native vs MCP-native | **Resolves best** (clearest differentiation) | Neutral | Neutral |
| Durability breadth vs depth | Resolves (claims cryptographic depth) | **Resolves best** (deepens the guarantee) | Neutral |
| Internal opportunity vs internal competition | Neutral | Neutral | **Resolves best** (acts before platform preemption) |

### Scope Judgment

- C1: Best-fit. Architectural moat is real and falsifiable.
- C2: Best-fit for medium-term. Too broad as an immediate action; correct as a learning agenda.
- C3: Slightly narrow as standalone but zero-cost (no architecture required, pure distribution).

### Failure Mode Manageability

- C1: Failure mode (LangGraph MCP-server) is **watchable and binary** -- a specific GitHub feature. Can detect early.
- C2: Failure mode (complexity creep) is **diffuse** -- harder to detect until it's already a problem.
- C3: Failure mode (Zodiac builds competing layer) is **uncertain timing** -- real risk but years away, not months.

### Philosophy Fit

All three honor the core philosophy. C2 has mild tension with YAGNI. C1 is the most philosophically pure (directly implements 'make illegal states unrepresentable' as a positioning claim, not just a code principle).

### Recommendation

**C1 + C3 in combination, with C2 as a deliberate learning investment.**

Rationale:
- C1 provides the correct positioning clarity that C3's distribution needs to work. Listing WorkRail in Zodiac without clear differentiation just adds it to the noise.
- C3 is free (no architecture change) and addresses the single biggest gap found: WorkRail is invisible internally despite solving a real problem teams are already dealing with manually.
- C2 is not an immediate action but a deliberate study agenda: follow the Zillow `orion` repo (Temporal + LangGraph), study Temporal's workflow versioning strategy, and consider whether WorkRail's snapshot-store abstraction should evolve toward event-sourcing. No immediate commitment required.

### Strongest Counter-Argument

C2 alone could be sufficient: if WorkRail publicly identifies itself as "Temporal for AI agents via MCP," it benefits from Temporal's brand recognition and avoids the narrow-niche problem of C1. Counter-counter: Temporal requires code; WorkRail requires JSON. The comparison is educationally useful but misleading at adoption time. Teams evaluating Temporal won't find WorkRail.

### What Would Tip the Decision

If CIAME team adopts WorkRail and reports that the token-gated enforcement solved a real problem that markdown contracts didn't, C1+C3 is validated. If Zodiac/SET announce a workflow execution layer timeline, C3's urgency increases substantially (first-mover advantage in internal catalog matters more).

### Pivot Conditions

- If LangGraph adds MCP-server exposure: C1's MCP-native positioning needs to evolve to "JSON-authored + token-gated" as the remaining moat
- If models improve to 99%+ instruction-following reliability: the enforcement story needs to shift to auditability/resumability rather than compliance
- If Zodiac builds workflow execution: C3 becomes table stakes (list or be preempted), urgency escalates

---

## Candidate Generation Expectations (landscape_first)

The candidate set must:

1. **Reflect actual landscape precedents** -- candidates must be grounded in documented behaviors
   from the research above, not invented features or wishful thinking about what tools will do.

2. **Respect hard constraints** -- LangGraph is Python-only (not MCP-native), mcp-graph is early
   (29 stars, PRD-to-code focus), Temporal.io requires code authoring. These are not soft preferences.

3. **Not drift into free invention** -- the question is "how does WorkRail position given what exists"
   not "what should WorkRail build." The competitive map is the deliverable.

4. **Include the near-term risk case as a first-class candidate** -- LangGraph's potential
   MCP-server expansion is a real near-term risk, not a footnote.

5. **The strongest finding is the one most directly supported by evidence** -- the CIAME case
   (manual markdown workaround) and the Zodiac catalog gap (WorkRail not listed) are the two
   most concrete, evidence-grounded findings. Any candidate that ignores these is weaker.

---

## Resolution Notes

### Adversarial Challenge of C1+C3

Three challenges tested:

1. **Is the three-way intersection actually unique?** Verified against mcp-graph (SQLite locking, not
   HMAC tokens) and LangGraph (thread-ID resumption, not cryptographic enforcement). The claim holds.

2. **Is the MCP-server distinction meaningful to users?** The technical claim needs to be translated
   to user benefit: "works with any MCP client, no Python required, no LangChain dependency."
   The distinction is real but language should lead with benefit, not architectural label.

3. **Is CIAME a viable reference adopter?** CIAME validates demand but doesn't guarantee fit. The
   C3 recommendation should be scoped as "engage CIAME for a discovery conversation," not
   "CIAME will adopt WorkRail."

None of these challenges broke C1+C3. Challenge 2 sharpened required positioning language;
challenge 3 scoped the CIAME opportunity more accurately.

### Selection: C1+C3 Combined (C2 as Study Agenda)

**Why C1+C3 wins**: C1 provides falsifiable differentiation (binary comparisons against LangGraph
and mcp-graph). C3 closes the internal visibility gap at zero architecture cost.

**Why C2 is runner-up**: Correct architectural growth path but requires demonstrated need (YAGNI).
No crash-recovery failures observed in WorkRail sessions. Switch trigger: sessions that fail to
resume correctly despite having checkpoint tokens.

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Path | `landscape_first` | Empirical discovery task; problem is well-framed; no reframing needed |
| GitHub search approach | `gh search repos` + `gh api` for specific repos | Direct CLI access confirmed |
| Glean probes | Used for internal Zillow context | Confirmed available; yielded material findings |
| Nexus-core treatment | Referenced existing comparison doc | Deep comparison already exists at `nexus-vs-workrail-comparison.md` |
| LangGraph classification | Durable+prompt (top-left quadrant) not durable+structural | Deep research confirmed: thread-ID resumption, no HMAC tokens, not an MCP server |
| Zodiac classification | Catalog/marketplace, not workflow execution engine | Deep research confirmed: no step enforcement, no durable session state |
| n8n, AutoGPT | Classified Tier 5 (different scope) | General automation / no step enforcement mechanism |
| Subagent delegation | Used in step 3 only (LangGraph + Zodiac parallel research) | Two independent high-uncertainty questions justified parallel subagents |
| Selected direction | C1+C3 combined | Falsifiable differentiation + internal distribution at zero architecture cost |
| Runner-up | C2 (Temporal study agenda) | Correct medium-term path; not immediate (YAGNI -- no crash-recovery failures observed) |

---

## Artifact Strategy

This document is the **human-readable reference artifact**. It is NOT the execution truth for
the workflow -- that lives in WorkRail's durable session notes and context variables. If the
session is rewound or interrupted, the workflow notes survive; this file may not.

**Capabilities confirmed available:**
- Delegation (`mcp__nested-subagent__Task`): Available -- confirmed via tool schema fetch
- Web browsing (`WebFetch`): Available -- confirmed via tool schema fetch
- GitHub CLI (`gh`): Available -- confirmed via probe calls in step 1
- Glean search/chat: Available -- confirmed via probe calls in step 1

**Capability decisions:**
- Web browsing: Available but not used for research depth. `gh api` provides richer structured
  data for GitHub repos than WebFetch would. Glean provides internal context. No public web
  browsing needed for this task.
- Delegation: Available but not used in step 1 (single-agent research; no parallelism benefit
  over already-parallel tool calls). May be used in later steps if deep concurrent research
  is needed.
- Fallback path: Both capabilities are present; no degradation required.
