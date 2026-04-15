# Competitive Landscape -- Design Candidates
## Structured Workflow Enforcement for AI Agents

> **Note**: This is raw investigative material for main-agent synthesis. It is not a final
> decision document. The primary human-readable reference is:
> `design-docs/competitive-landscape-workflow-enforcement.md`

---

## Problem Understanding

### Core Tensions

1. **Enforcement fidelity vs adoption friction**: Cryptographic token enforcement (WorkRail) is
   maximally reliable but requires deliberate adoption. Prompt-based enforcement (nexus-core,
   CLAUDE.md) is zero-friction but degrades under context pressure. Teams reach for the latter
   first and only discover the gap after an enforcement failure.

2. **Framework-native vs MCP-native**: LangGraph's enforcement is code-structural (Python DAG) --
   deep LangChain ecosystem integration but locked to Python. WorkRail is MCP-native (JSON
   authoring, any client) -- broad compatibility but shallower ecosystem. Ecosystem gravity can
   outweigh design correctness.

3. **Durability breadth vs depth**: LangGraph+LangSmith claims cross-session durability (thread
   IDs, Postgres-backed). WorkRail's durability is cryptographic and audit-trailed (HMAC-signed
   tokens, snapshot store). Both claim 'durable' but the guarantees are architecturally different.
   The word 'durable' is now shared; the mechanisms are not equivalent.

4. **Internal opportunity vs platform preemption**: CIAME team is building WorkRail's problem
   manually in markdown, signaling real demand. But Zodiac/SET's 2026 strategy hints at building
   a workflow platform layer. WorkRail could be preempted by an org-level decision.

### Likely Seam

The competitive moat lives at the three-way intersection:
- MCP server (not tool consumer)
- JSON-authored workflow definition (not code)
- Token-gated cryptographic step enforcement

No other tool occupies this intersection today. This is the falsifiable differentiation.

### What Makes This Hard

Distinguishing 'durable' (LangGraph's thread-ID resumption) from 'durable with cryptographic
audit trail' (WorkRail's HMAC token protocol). The mechanisms are architecturally different but
both projects use the word 'durable.' A surface-level analysis would treat them as equivalent.

The other hard part: the team most in need of WorkRail (CIAME, building it manually) doesn't
know WorkRail exists. The visibility gap is as important as the architecture gap.

---

## Philosophy Constraints

From CLAUDE.md (loaded system-wide):

- **Make illegal states unrepresentable**: Token-gated steps directly implement this. You cannot
  be in step N+1 without completing step N. This is the core philosophical argument for WorkRail.
- **Architectural fixes over patches**: Structural enforcement, not better prompting.
- **Determinism over cleverness**: Same workflow JSON + same token = same execution.
- **YAGNI with discipline**: 3 well-grounded candidates > 5 speculative ones. Don't build
  Temporal's full event-sourcing machinery without demonstrated need.
- **Surface information, don't hide it**: If WorkRail solves CIAME's problem, say so explicitly.

No philosophy conflicts found. CLAUDE.md and WorkRail's architecture are directly aligned.

---

## Impact Surface

Changes or positioning decisions that must remain consistent:

- `spec/workflow.schema.json` -- any positioning about JSON authoring must match actual schema capabilities
- `payloads.ts` HMAC token system -- positioning claims about 'cryptographic enforcement' are grounded here
- `snapshot-store.port.ts` -- durability claims are grounded here; if this abstraction evolves, the positioning evolves
- `@exaudeus/workrail` npm package -- distribution channel; Zodiac listing is additive, not a replacement
- `nexus-vs-workrail-comparison.md` -- existing comparison document; new candidates must be consistent with its conclusions

---

## Candidates

### C1: WorkRail as MCP-Native Durable Enforcement Layer (Narrowly Positioned)

**Summary**: Position WorkRail as the MCP-native, JSON-authored, token-gated workflow enforcement
engine -- the exact tool for teams that need step compliance + durability on top of any
MCP-compatible agent, without writing Python or adopting LangChain.

**Tensions resolved**:
- Framework-native vs MCP-native: WorkRail wins by definition (it IS the MCP-native answer)
- Durability breadth vs depth: WorkRail's cryptographic audit trail is explicitly deeper

**Tensions accepted**:
- Adoption friction: C1 does not try to reduce it; owns the deliberate-adoption niche

**Boundary solved at**: The three-way intersection (MCP server + JSON authoring + token-gated
enforcement). Binary and falsifiable: 'Is LangGraph an MCP server?' -- no. 'Is mcp-graph
token-gated?' -- no. WorkRail wins both comparisons today.

**Failure mode**: LangGraph adds MCP-server exposure (logical next step given they already
generate MCP schemas for introspection in `assistants.read` context). This is watchable via
LangGraph's GitHub. Binary signal: if it ships, the MCP-native moat shrinks to the remaining
two axes (JSON-authored + token-gated).

**Repo-pattern relationship**: Directly follows existing architecture. `payloads.ts`, `ExecutionState.pendingStep`, `snapshot-store.port.ts` all provide the evidence base for these claims.

**Gains**: Clear, falsifiable differentiation. Easy to explain: "LangGraph requires Python and
doesn't enforce steps cryptographically; WorkRail is JSON + HMAC tokens + any MCP client."
**Gives up**: Broad adoption appeal (narrow position = smaller initial market).

**Scope judgment**: Best-fit. The moat is architectural, not ecosystem.

**Philosophy**: Fully honors 'make illegal states unrepresentable', 'determinism over cleverness',
'architectural fixes over patches'. No conflicts.

---

### C2: WorkRail as Temporal.io for MCP Agents (Study-Driven Positioning)

**Summary**: Acknowledge Temporal.io as the production-grade ancestor, study its event-sourcing
and workflow-versioning patterns, and evolve WorkRail's durability model toward the same
guarantees -- positioning as "Temporal for AI agents via MCP" to benefit from Temporal's
brand recognition.

**Tensions resolved**:
- Durability breadth vs depth: studying Temporal deepens WorkRail's guarantees toward event-sourcing
- Enforcement fidelity: 'Temporal for AI agents' vocabulary explains the value clearly

**Tensions accepted**:
- Time investment: studying Temporal is a deliberate research cost

**Boundary solved at**: `snapshot-store.port.ts` abstraction layer. The gap between WorkRail's
current snapshot model and Temporal's event-sourcing with history replay. The abstraction
already exists; C2 asks whether it should evolve toward replay semantics.

**Specific areas to study in Temporal**:
- Workflow versioning strategy (how Temporal handles schema changes mid-execution)
- Signal/query patterns for human-in-the-loop pauses
- History replay for crash recovery (vs WorkRail's current checkpoint tokens)

**Evidence grounding**: Zillow's `orion` repo (Chris Botaish, zillow-home-loans/experimental)
combines Temporal + LangGraph for durable AI agents. This is a live experiment to follow.

**Failure mode**: Adopts Temporal's complexity without Temporal's ecosystem support and
contributor base. Complexity creep on a solo project. Harder to detect than C1's failure mode.

**Repo-pattern relationship**: Extends (does not replace) `snapshot-store.port.ts` abstraction.
Consistent with 'architectural fixes over patches' principle.

**Gains**: Deeper durability guarantees. Better vocabulary for teams who know Temporal.
Access to Temporal's conceptual toolkit for explaining crash recovery, replay, and versioning.
**Gives up**: Simplicity. WorkRail's current model is intentionally simpler than Temporal's.

**Scope judgment**: Best-fit for medium-term learning agenda. Too broad as an immediate action.

**Philosophy**: Honors 'architectural fixes over patches'. Mild tension with 'YAGNI with
discipline' -- don't build history replay machinery without demonstrated crash-recovery failures.

---

### C3: WorkRail as Internal Zillow Standard via Zodiac + CIAME Adoption (Opportunistic)

**Summary**: Address the internal visibility gap immediately -- list WorkRail in the Zodiac AI
Marketplace and ZG AI Tools Catalog, and engage the CIAME team (who are building WorkRail's
problem manually in markdown) as the first reference adopter.

**Tensions resolved**:
- Internal opportunity vs platform preemption: act before Zodiac/SET builds a competing layer
- Adoption friction: distribution via Zodiac = teams find WorkRail where they already look

**Tensions accepted**:
- Platform risk: if Zodiac/SET builds workflow execution, WorkRail listing may become a
  dependency on a competing platform. Real risk, but timing is uncertain (years, not months).

**Boundary solved at**: Zodiac AI Marketplace listing + ZG AI Tools Catalog entry + CIAME
team engagement. These are distribution/relationship changes, not architecture changes.

**Evidence grounding**:
- `docs/standards/rs-sdk-agent-execution-contract.md` (CIAME) is WorkRail's problem implemented
  manually -- the team has demonstrated demand and willingness to build structured process governance
- `zg-ai-tools-catalog.md` lists nexus-core but not WorkRail -- a concrete gap
- Zodiac AI Marketplace launched March 2026, currently distributes Skills and MCPs

**Failure mode**: Zodiac/SET announce a workflow execution layer timeline. If this happens,
C3's urgency escalates: first-mover advantage in internal catalog matters more.

**Repo-pattern relationship**: Zero architecture change. WorkRail already supports `@exaudeus/workrail` npm + `WORKFLOW_GIT_REPOS` for distribution. Zodiac is an additive channel.

**Gains**: Internal discoverability, a reference adopter, hedge against platform preemption.
Free optionality: listing requires no architectural commitment.
**Gives up**: Nothing. Pure distribution and relationship investment.

**Scope judgment**: Slightly narrow as standalone. Pairs naturally with C1 (correct position
+ correct distribution). C3 without C1 adds visibility without differentiation.

**Philosophy**: Honors 'surface information, don't hide it'. No conflicts.

---

## Comparison and Recommendation

### Matrix

| Criterion | C1 | C2 | C3 |
|---|---|---|---|
| Resolves MCP-native tension | Best | Neutral | Neutral |
| Resolves durability depth tension | Good | Best | Neutral |
| Resolves internal opportunity tension | Neutral | Neutral | Best |
| Failure mode manageability | Binary/watchable | Diffuse | Uncertain timing |
| Architecture cost | Zero | Medium-term | Zero |
| Philosophy fit | Perfect | Good (YAGNI tension) | Perfect |

### Recommendation

**C1 + C3 in combination** as immediate positioning and distribution actions.
**C2 as deliberate study agenda** (not an immediate commitment).

Rationale:
1. C1 provides the differentiation clarity that makes C3's distribution meaningful. Listing
   WorkRail in Zodiac without clear positioning just adds it to the catalog noise.
2. C3 is free (no architecture) and closes the single biggest gap found: internal invisibility
   despite solving a real problem that CIAME is solving manually.
3. C2 is the right learning agenda but not an immediate action. Follow `orion`, study Temporal's
   workflow versioning strategy, and evaluate whether `snapshot-store.port.ts` should evolve
   toward event-sourcing replay. Revisit when crash-recovery failures are observed in practice.

---

## Self-Critique

**Strongest counter-argument against C1+C3**:
C2 alone could provide brand recognition by associating WorkRail with Temporal ('Temporal for
AI agents via MCP'). This would help teams who already know Temporal find WorkRail.
Counter-counter: Temporal requires code; WorkRail requires JSON. Teams evaluating Temporal are
engineers building distributed systems -- not the same audience as teams using Claude Code with
MCP. The association is educationally useful but won't drive adoption via the Temporal discovery path.

**Narrower option**: C3 alone (just list in Zodiac). Loses: the differentiation that makes
the listing meaningful. CIAME team needs to understand why WorkRail is better than what they're
doing, not just that it exists.

**Broader option**: All three simultaneously. Justified if: the Zodiac/SET workflow platform
risk materializes on a short timeline. In that case, both architecture deepening (C2) and
distribution (C3) become urgent simultaneously.

**Assumption that would invalidate this design**:
LangGraph adds MCP-server exposure (expose workflows as MCP tools). If true, C1's three-way
intersection shrinks to a two-way intersection (JSON-authored + token-gated). Still
differentiated, but the MCP-native claim needs to shift from 'WorkRail IS an MCP server'
to 'WorkRail is an MCP server that enforces steps cryptographically.'

---

## Open Questions for the Main Agent

1. Is the CIAME team accessible for an adoption conversation? Who is the right contact?
2. What is the current process for listing an MCP in the Zodiac AI Marketplace?
3. Has the `orion` repo (Temporal + LangGraph at Zillow) produced any shareable learnings?
4. Does the 2026 Engineering AI Strategy 'SET owns workflow platform' statement have a
   timeline or team owner that could be identified?
5. Should C2's study agenda be tracked as a formal WorkRail milestone, or is it
   pre-roadmap research?
