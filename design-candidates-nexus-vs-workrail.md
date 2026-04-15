# Design Candidates: nexus-core vs WorkRail Adoption

> Raw investigative material for main-agent synthesis. Not a final decision.

## Problem Understanding

### Core Tensions

1. **Enforcement strength vs. expressiveness**
   WorkRail enforces step sequencing cryptographically but can only express what fits in workflow JSON.
   nexus-core is fully expressive (free-form markdown, subagent spawning, model selection, Teams mode)
   but enforcement degrades under context pressure. As enforcement increases, expressiveness decreases.

2. **Durability vs. org-specific depth**
   WorkRail has cross-session durable state, IDE-agnostic deployment, zero-install. But no issue
   tracker, no git host, no org profiles. nexus-core has deep Zillow integration (Jira via acli, glab,
   VPN profile, learning capture). But no durable state - session dies with the conversation.

3. **Convention vs. constraint**
   nexus-core uses SOUL.md principles + markdown checklists + skill instructions (convention).
   WorkRail uses token-gated API + schema-validated JSON + HMAC-signed state tokens (constraint).
   Conventions are flexible and cheap to build but erode. Constraints are rigid but durable.

### Likely Seam
Phase transitions (Plan -> Work -> Validate -> Review -> Learn). This is where enforcement matters
most - not within a phase, but at the gates between them. A well-designed solution enforces at
exactly this level.

### What Makes This Hard
- nexus-core has no published spec for session persistence - must infer from /retro skill source
- The complementarity angle is non-obvious; most evaluations frame this as competition
- WorkRail's enforcement relies on HMAC-SHA256 token signing - understanding why it can't be bypassed
  requires reading the token implementation (payloads.ts, token-codec.js), not just the README

---

## Philosophy Constraints

**Relevant principles (from /Users/etienneb/CLAUDE.md):**
- 'Make illegal states unrepresentable' - nexus-core allows skipped steps (illegal states). WorkRail
  does not. This principle directly validates WorkRail's enforcement approach.
- 'Architectural fixes over patches' - adding WorkRail to enforce nexus-core's phase boundaries is
  an architectural fix. Patching nexus-core's prompts to be more forceful is a patch.
- 'Validate at boundaries, trust inside' - WorkRail validates at the MCP API boundary (token
  verification before serving next step). nexus-core validates in-prompt (weaker boundary).
- 'YAGNI with discipline' - don't add WorkRail infrastructure until the enforcement gap causes a
  real problem in practice.

**Conflicts:**
- 'Make illegal states unrepresentable' vs. 'YAGNI': illegal states (skipped steps) ARE
  representable in nexus-core. YAGNI says: wait until it bites you. These conflict.
- Resolution: if nexus-core compliance is reliable in practice, YAGNI wins. If it's unreliable,
  'make illegal states unrepresentable' wins and C3 is justified.

---

## Impact Surface

- Agent running nexus-core /flow must have the Claude Code plugin installed AND the Zillow profile
  applied. The WorkRail MCP server must also be configured if C3 is adopted.
- Team distribution: if C3 is adopted, `.claude/settings.json` must configure both the nexus-core
  plugin AND the workrail MCP server.
- The workrail-executor agent spec (docs/configuration.md) shows the subagent configuration needed.
- nexus-core's /flow --checkpoints mode overlaps with WorkRail's checkpoint concept - if using C3,
  '--checkpoints' flag becomes redundant (WorkRail provides the same pause/resume semantics).

---

## Candidates

### Candidate 1: nexus-core only (simplest - use what exists)

**Summary:** Install nexus-core as a Claude Code plugin with the Zillow profile. Use /flow for
ticket-to-MR automation. Accept that step compliance is advisory.

**Tensions resolved:** Org-specific depth (Jira, glab, VPN), multi-model orchestration, learning
capture via /compound and /retro.

**Tensions accepted:** Step enforcement is prompt-based. A context-degraded agent can skip steps.
No cross-session durability.

**Boundary solved at:** Plugin installation boundary. nexus-core hooks into SessionStart/SessionEnd.

**Why this boundary:** This is where nexus-core was designed to operate. The plugin system handles
distribution and activation.

**Failure mode:** Agent bypasses /work verification gate in a long session; implements directly
without planning; fails to spawn verifier subagent.

**Repo-pattern relationship:** Follows nexus-core's designed distribution path (plugin mode with
Zillow profile). No new patterns introduced.

**Gains:** Rich Zillow integration, full dev lifecycle, learning capture, Opus/Sonnet/Haiku tiers.

**Losses:** Step enforcement guarantees, cross-session durability.

**Scope judgment:** Best-fit for the current need. Not too narrow (covers all 5 phases), not too
broad (no unnecessary infrastructure).

**Philosophy fit:** Honors YAGNI. Conflicts with 'make illegal states unrepresentable'.

---

### Candidate 2: WorkRail only (enforcement-first)

**Summary:** Use the existing `coding-task-workflow-agentic.json` workflow (or author a custom
dev-lifecycle workflow in WorkRail JSON). Enforce step sequencing cryptographically. Accept loss
of org-specific integrations.

**Tensions resolved:** Step enforcement (cryptographic), cross-session durability, IDE-agnostic.

**Tensions accepted:** No Jira/glab integration, no multi-model orchestration, no /compound
learning capture. Every step must be self-contained in JSON.

**Boundary solved at:** WorkRail MCP tool boundary (token validation before each step).

**Why this boundary:** WorkRail was designed for exactly this - enforcing sequential steps via
a token-gated API.

**Failure mode:** Workflow too rigid. When the agent needs to make dynamic decisions (nexus-core
handles via 'needs-decision' response), the JSON workflow has no equivalent mechanism. The agent
either halts or improvises outside the workflow structure.

**Repo-pattern relationship:** Adapts the existing `workflows/coding-task-workflow-agentic.json`.
This pattern already exists - candidate is 'use what's there'.

**Gains:** Cryptographic step enforcement, cross-session durability, IDE-agnostic.

**Losses:** Multi-model orchestration, Zillow-specific toolchain, learning capture. Redundant
with coding-task-workflow-agentic.json which already provides similar coverage.

**Scope judgment:** Too narrow for the full Zillow dev lifecycle use case. Adequate for generic
workflow enforcement needs.

**Philosophy fit:** Honors 'make illegal states unrepresentable', 'validate at boundaries'.
Conflicts with YAGNI (re-authors nexus-core capabilities in JSON).

---

### Candidate 3: Combined - WorkRail meta-workflow wraps nexus-core phases

**Summary:** Author a WorkRail workflow whose 4-5 steps correspond to nexus-core's five phases,
using WorkRail's token-gated API to enforce phase transitions while delegating each phase's
execution to nexus-core slash commands.

**Tensions resolved:** Both enforcement strength AND org-specific depth. WorkRail enforces the
phase sequence; nexus-core handles the phase content.

**Concrete shape (workflow JSON):**
```json
{
  "id": "nexus-flow-enforced",
  "version": "1.0.0",
  "steps": [
    {"id": "plan", "title": "Plan", "notesOptional": false,
     "prompt": "Run /nexus-core:plan <TICKET-KEY>. Do not advance until the plan artifact is complete and documented in notes."},
    {"id": "work", "title": "Work",  "notesOptional": false,
     "prompt": "Run /nexus-core:work. Document branch name, commits, and validation results in notes."},
    {"id": "review", "title": "Review", "notesOptional": false,
     "prompt": "Run /nexus-core:review. Document verdict and all blocking issues in notes."},
    {"id": "learn", "title": "Learn", "notesOptional": false,
     "prompt": "Run /nexus-core:compound and /nexus-core:retro. Document learnings captured in notes."}
  ]
}
```

**Boundary solved at:** Phase transitions. WorkRail enforces that Plan is done before Work starts.
nexus-core handles all within-phase execution.

**Why this boundary:** Phase transitions are where enforcement matters most. Within-phase
orchestration (model selection, subagent spawning) should remain with nexus-core.

**Failure mode:** Agent treats WorkRail notes requirements as a formality. Mitigated by
`notesOptional: false` and substantive notes requirements in each step prompt.

**Repo-pattern relationship:** Departs from both tools' standalone use cases. Is explicitly
supported by architecture: nexus-protocol.md is agent-agnostic, WorkRail's workrail-executor
spec in docs/configuration.md shows this is designed to work.

**Gains:** Cryptographic phase-transition enforcement + org-specific execution depth (Jira, glab,
VPN) + cross-session checkpoint tokens for multi-day workflows.

**Losses:** Setup complexity (two systems, two configs). Two surfaces to maintain. '/flow
--checkpoints' becomes redundant.

**Scope judgment:** Best-fit when cross-session durability and phase enforcement are real needs.
Too broad for simple single-session dev tasks.

**Philosophy fit:** Honors 'architectural fixes over patches' most strongly. Mild YAGNI tension.

---

## Comparison and Recommendation

| Criterion | C1: nexus-core only | C2: WorkRail only | C3: Combined |
|-----------|--------------------|--------------------|--------------|
| Step enforcement | Prompt-based (weak) | Cryptographic (strong) | Phase-level cryptographic (strong) |
| Org integration | Full | None | Full |
| Cross-session state | None | Full | Full |
| Multi-model tiers | Full | None | Full |
| Learning capture | Full | None | Full |
| Setup complexity | Low | Low | High |
| YAGNI fit | Best | Poor | Medium |
| 'Illegal states' fit | Poor | Best | Best |

**Recommendation: C1 now; C3 when enforcement or durability becomes a real pain point.**

C1 is the right starting point because:
- YAGNI: don't add WorkRail infrastructure until the enforcement gap actually causes a problem
- nexus-core's '/flow --checkpoints' provides human-enforced phase boundaries as a fallback
- The rich Zillow integration (Jira, glab, /compound) is immediately valuable

C3 is the right evolution when:
- Sessions regularly break mid-flow (context limits, IDE restarts, multi-day tasks)
- The agent demonstrably skips verification gates under context pressure
- Cross-session resumption is a real workflow need

C2 is dominated by C1 (C1 has everything C2 has plus Zillow integration) and by C3 (C3 has
everything C2 has plus the full nexus-core capability set).

---

## Self-Critique

**Strongest argument against C1:** 'Make illegal states unrepresentable' is a core principle in
Etienne's coding philosophy, and C1 explicitly allows skipped steps. If the principle is taken
seriously as an engineering standard (not just a coding guideline), C1 is architecturally
unsatisfying even if practically sufficient. An engineer who upholds this principle consistently
should prefer C3.

**What would tip toward C3 immediately:**
- Any session where the agent skips the Work verification gate and ships broken code to review
- Any multi-day workflow that requires resuming after an IDE restart

**Assumption that would invalidate C1:** If nexus-core compliance is unreliable in practice
(agent frequently skips steps or takes shortcuts), C1 fails and C3 is the only defensible option.

**Narrower option that could work:** Use only `/flow --checkpoints` (no WorkRail). This adds
human-enforced phase boundaries without WorkRail infrastructure. Loses cross-session durability
but eliminates the dual-system overhead.

---

## Open Questions for the Main Agent

1. Has the enforcement gap in nexus-core actually caused problems in practice? (Determines C1 vs C3)
2. Are multi-day /flow sessions (requiring IDE restart mid-flow) a real use case? (Determines
   whether cross-session durability justifies C3 overhead)
3. Is nexus-protocol.md's 'agent-agnostic' language an aspiration or an implemented contract?
   (Determines whether C3's combined architecture is truly supported or just theoretically possible)
