# nexus-core vs WorkRail: Technical Comparison

## Context / Ask

Deep technical comparison of nexus-core (GitLab project 66446, accessed via glab) vs WorkRail
(local at /Users/etienneb/git/personal/workrail). The goal is to understand architecture,
capabilities, and differences across 6 key dimensions so decisions about which tool to use and when
can be made with ground truth.

## Artifact Strategy

This document is a **human-readable reference artifact**. It is NOT the execution truth for the
workflow - that lives in WorkRail's durable session notes and context variables. If the session is
rewound or interrupted, the workflow notes survive; this file may not. Do not use this file as the
source of truth for workflow state.

## Path Recommendation

`landscape_first` - The task is purely comparative. Both tools are known quantities. No risk of
solving the wrong problem - the framing is explicit.

## Constraints / Anti-goals

- **Constraints**: nexus-core accessible only via glab API; WorkRail read directly from local clone
- **Anti-goals**: Not a migration plan. Not a business/cost comparison. Not a recommendation to
  abandon one tool.

## Landscape Packet

### What is nexus-core?

nexus-core is a **Claude Code / Cursor plugin** that encodes the "Nexus Protocol" - a five-phase
AI development lifecycle (Plan -> Work -> Validate -> Review -> Learn). It ships as a set of
markdown skill files organized into slash commands (`/flow`, `/plan`, `/work`, `/review`,
`/validate`, `/ship`, `/compound`, `/retro`, `/repo`, `/worktrees`, `/onboard`).

The primary entry point is `/flow <TICKET-KEY>`, which orchestrates all phases end-to-end by
spawning subagents for each phase. The orchestrator (Opus) never does direct work - it delegates
to Sonnet implementers and Haiku verifiers.

**Key architecture**: Skills are markdown files (`SKILL.md`) with embedded prompt templates,
workflow checklists, and structured decision protocols. There is no separate runtime - the skill
files ARE the instructions. Distribution is via Claude Code's plugin system or Cursor's plugin
panel.

### What is WorkRail?

WorkRail is an **MCP server** (Model Context Protocol) that enforces step-by-step workflow
execution through a durable token-gated API. It runs as a Node.js process alongside any MCP
client (Claude Code, Cursor, Firebender, etc.) and exposes 8 tools:
`start_workflow`, `continue_workflow`, `checkpoint_workflow`, `list_workflows`,
`inspect_workflow`, `create_session`, `update_session`, `read_session`.

The core mechanism: the agent calls `start_workflow`, gets step 1, does the work, calls
`continue_workflow` with a `continueToken`. Future steps are hidden until the previous one is
acknowledged. The agent cannot skip ahead because it literally does not know what comes next.

**Key architecture**: Workflows are JSON files with a defined schema. The runtime is a TypeScript
MCP server with cryptographically signed tokens (HMAC-SHA256, bech32m encoding), durable session
state stored to disk, and a checkpoint/resume system. Distribution is via npm (`@exaudeus/workrail`).

---

## Detailed Comparison

### 1. Execution Model - How Does Each Tool Enforce Step Sequencing?

**nexus-core:**
- Step sequencing is a **social contract**, not a technical constraint. The SKILL.md files contain
  markdown checklists (e.g., `- [ ] Step 1: Parse inputs`). The agent is instructed to follow
  them but there is no mechanism preventing it from jumping ahead.
- Enforcement is through prompt engineering - the orchestrator model is instructed to delegate
  and never do direct work, and verification gates (soft/hard) are defined in the skill prompts.
- There is no runtime that hides future steps. The entire SKILL.md is loaded into the context
  window at once.
- The verification gates (soft after planning, hard after work) create checkpoint-like behavior
  but rely on the model honoring them.

**WorkRail:**
- Step sequencing is **technically enforced at the API level**. The agent literally receives only
  the current step. Future steps are server-side only.
- The `continueToken` is a cryptographically signed HMAC-SHA256 token (see `payloads.ts` -
  `AckTokenPayloadV1`) that encodes `sessionId`, `runId`, `nodeId`, `attemptId`. The server
  validates the token before advancing.
- A `pendingStep` field in `ExecutionState` prevents any other step from being served until the
  current one is completed with the correct token.
- Skipping is impossible by design - the token for step N is not issued until step N-1 is
  acknowledged.

**Verdict**: WorkRail's enforcement is cryptographic and structural. nexus-core's is
prompt-based. A non-compliant or context-degraded agent will drift from nexus-core instructions
but cannot violate WorkRail's token protocol.

---

### 2. Distribution - How Do Teams Get Each Tool?

**nexus-core:**
- **Plugin mode (recommended for teams)**: Add to `.claude/settings.json` in the project repo
  with `extraKnownMarketplaces` and `enabledPlugins`. When teammates open the project, Claude
  Code prompts them to install the plugin. Skills appear as `/nexus-core:plan`, etc.
- **Home-base mode**: Clone nexus-core directly and work from it. Target repos live inside
  `./repos/`.
- **Cursor**: Team marketplace via Cursor Settings, or project-level via `.cursor/settings.json`.
- **Org profiles**: `scripts/apply-profile.sh zillow` pre-configures git host, CLI tools (glab),
  and issue tracker (acli/Jira).
- **Bootstrap**: `scripts/bootstrap.sh` installs prerequisites (jq, yq, bash 4+).
- No npm/package registry involved - distributed as a Git repo.

**WorkRail:**
- **npm package**: `npx -y @exaudeus/workrail` - zero-install, single-line MCP config.
- Works in any MCP client (Claude Code, Cursor, Firebender, Antigravity, Docker).
- Team workflows distributed via `WORKFLOW_GIT_REPOS` env var pointing to any Git repo with a
  `workflows/` directory. Supports GitHub, GitLab, Bitbucket, or self-hosted with token auth.
- Per-user config at `~/.workrail/config.json`.
- Project-level bindings at `.workrail/bindings.json`.
- `workrail init` bootstraps the user directory with a sample workflow.

**Verdict**: WorkRail is simpler to distribute - one npm package, one MCP config line. nexus-core
requires plugin installation steps, profile configuration, and CLI prerequisites. WorkRail wins
for initial adoption friction. nexus-core wins for org-specific configuration depth (profiles,
issue tracker integration, git host config).

---

### 3. Customization - How Do You Write New Workflows/Skills?

**nexus-core:**
- Create a new `SKILL.md` in the appropriate skills directory (`.claude/skills/`, `.agents/skills/`,
  `skills/` - all three must stay in sync, enforced by `ci/check-skill-sync.sh`).
- Skills are markdown files with YAML frontmatter (`name`, `description`) and free-form prompt
  content. No schema validation.
- Extend via the plugin system: `scripts/nexus-plugin.sh add <git-url>` installs a plugin and
  symlinks its skills into all three mirrors.
- The `/retro` skill can automatically patch skill files based on session learnings (git history
  becomes the journal of skill evolution).
- Knowledge bank (`docs/knowledge-bank/`) captures learnings that don't map to skills.

**WorkRail:**
- Drop a JSON file in `~/.workrail/workflows/` or a project `workflows/` directory.
- Validated against `spec/workflow.schema.json` at load time and via `workrail validate file.json`.
- The `spec/authoring-spec.json` defines required/recommended/discouraged rules at 3 rigor levels.
- Supports: loops, conditionals, extension points (`.workrail/bindings.json` for project overrides),
  context variables, artifact contracts, delegation checkpoints, confirmation steps.
- Load workflows from Git repos (`WORKFLOW_GIT_REPOS`) with configurable sync intervals.
- 30+ bundled workflows as reference implementations.
- A `workflow-for-workflows.json` and `wr.discovery.json` workflow guide you through creating new ones.

**Verdict**: nexus-core is more flexible (any markdown) but less structured. WorkRail has a richer
feature set (loops, conditionals, typed context) with schema validation and a linting framework.
WorkRail workflows are more composable and discoverable; nexus-core skills are more powerful for
complex orchestration (spawning model-specific subagents, Teams mode, etc.).

---

### 4. IDE Support - What IDEs Does Each Support?

**nexus-core:**
- **Claude Code**: Full support via `.claude-plugin/plugin.json` manifest. Skills appear as
  `/nexus-core:flow` etc. Hooks integrate with Claude Code's session lifecycle
  (`SessionStart`, `SessionEnd`, `WorktreeCreate`, `WorktreeRemove`, `PreToolUse`).
- **Cursor**: Full support via `.cursor-plugin/plugin.json` manifest. Team marketplace and
  project-level installation documented.
- **Other agent runtimes**: `.agents/skills/` directory suggests compatibility with additional
  runtimes (the triple-mirror structure with sync CI check).
- **Gemini CLI**: Referenced in `reference-impl.md` docs as a supported installation target.

**WorkRail:**
- Any **MCP-compatible client**: Claude Code, Claude Desktop, Cursor, Firebender, Antigravity.
- Docker deployment supported.
- **Not IDE-specific**: WorkRail runs as a sidecar process, not as a plugin inside the IDE.
  This means it works with any client that supports MCP, including future ones.
- No IDE-specific hooks or session lifecycle integration (those are the host IDE's concern).

**Verdict**: nexus-core is more deeply integrated into specific IDEs (hooks, plugin manifests,
session lifecycle events). WorkRail is more broadly compatible across any MCP client and is
IDE-agnostic by design.

---

### 5. State Persistence - Can You Resume a Session After Closing Your IDE?

**nexus-core:**
- **No durable session state**. nexus-core is a set of prompt instructions. When the Claude Code
  session ends, all context is lost.
- The closest analog is the `--checkpoints` flag on `/flow`, which pauses between phases for
  explicit user approval - but this is within a single session, not across sessions.
- Active sessions use `docs/handoffs/active-session.md` (referenced in `/retro`) as a sidecar
  file for state, but this is a convention, not a guaranteed mechanism.
- Knowledge bank and skill patches persist across sessions (git-tracked), but workflow execution
  state does not.
- Resuming a nexus-core workflow after closing your IDE requires re-reading the sidecar file
  and manually re-establishing context.

**WorkRail:**
- **Full durable session state**. The WorkRail MCP server stores session state to disk via
  `snapshot-store.port.ts`. Sessions are identified by `SessionId` (a branded type), and state
  includes: `completed` step list, `loopStack`, `pendingStep`, workflow hash reference, and
  accumulated notes.
- **Checkpoint tokens** (`chk_` prefix, `CheckpointTokenPayloadV1`) allow saving progress at
  any point and resuming later with `checkpoint_workflow`.
- **Resume tokens** (`st_` prefix, `StateTokenPayloadV1`) represent a durable node state and
  can be stored and reused to rehydrate the current step without advancing.
- Tokens are HMAC-signed with machine keyring for security. Session state survives IDE restarts,
  crashes, and machine reboots (as long as the MCP server data directory persists).
- `read_session`, `update_session`, `create_session` tools provide direct session management.

**Verdict**: WorkRail has a purpose-built durable session system with cryptographically secured
checkpoint tokens. nexus-core has no durable execution state - only the conversation context
and any sidecar files written to disk. This is one of the sharpest architectural differences.

---

### 6. Multi-Step Enforcement - Does nexus-core Prevent Agents from Skipping Steps?

**nexus-core:**
- **No technical enforcement**. nexus-core uses markdown checklists and prompt instructions.
  The agent is instructed to follow the workflow checklist (`- [ ] Step 1`, `- [ ] Step 2`...)
  but nothing prevents it from skipping steps.
- Verification gates (soft/hard) are defined in SKILL.md and the agent is instructed to honor
  them, but a context-degraded or misaligned agent can skip them.
- The Opus/Sonnet/Haiku model assignment is a convention, not a constraint. The skill file
  says "spawn Haiku for verification" but nothing enforces which model is actually called.
- The `/flow --checkpoints` flag adds explicit user approval prompts between phases, which
  provides human-enforced step sequencing but not automated enforcement.

**WorkRail:**
- **Cryptographic enforcement**. The `continueToken` is a signed ack token that encodes the
  exact `nodeId` and `attemptId` the server expects next. The server validates the token
  signature and the node identity before serving the next step.
- The server maintains `pendingStep` in `ExecutionState` - if a step is pending, no other step
  can be started until it is completed with the correct token.
- The workflow JSON is hashed (`workflowHashRef` in the token) - if the workflow definition
  changes mid-execution, the token becomes invalid, preventing silent drift.
- Notes are required on non-optional steps (`notesOptional: false`). The server blocks
  advancement if required notes are not provided.
- Steps with `requireConfirmation: true` pause for explicit human acknowledgment before the
  server issues the next token.

**Verdict**: WorkRail's multi-step enforcement is a first-class system-level constraint. nexus-core's
is purely advisory and prompt-based. A sufficiently pressured or context-degraded agent will
eventually skip nexus-core steps; it cannot skip WorkRail steps.

---

## Candidate Generation Expectations (landscape_first)

The candidate set must:
1. Reflect actual landscape precedents - candidates must be grounded in documented behaviors from source files, not invented features
2. Respect hard constraints - nexus-core's enforcement is prompt-based (cannot be changed without rewriting the skill files), WorkRail's is token-cryptographic (cannot be bypassed)
3. Not drift into free invention - the comparison is empirical, candidates are adoption/integration scenarios grounded in evidence
4. Include the complementarity scenario as a first-class candidate, not just a footnote
5. The strongest candidate is the one most directly supported by architectural evidence

## Candidate Directions

### Direction 1: nexus-core for development lifecycle automation
**When to adopt:** Teams at Zillow (or similar orgs) needing end-to-end ticket-to-MR automation with deep org integration. Jira via acli, glab, VPN awareness. Multi-model orchestration (Opus orchestrates, Sonnet implements, Haiku verifies). Session learning capture (/compound, /retro).
**Evidence grounding:** Zillow profile in configs/profiles/, acli integration in task context builder, REPO_CACHE pattern in reference-impl.md.
**Hard constraint to accept:** Step enforcement is prompt-based. Under sustained context pressure or in long sessions, an agent can drift from the workflow checklist.

### Direction 2: WorkRail for process compliance on any workflow type
**When to adopt:** Any team needing guaranteed step sequencing, cross-session durability, and IDE-agnostic deployment. Not tied to software development - applies to any structured process.
**Evidence grounding:** HMAC-signed token system (payloads.ts), ExecutionState with pendingStep (state.ts), disk-persisted snapshots (snapshot-store.port.ts), 29+ bundled workflow templates.
**Hard constraint to accept:** WorkRail does not know about your issue tracker, git host, or org toolchain. Each step must be self-contained in the workflow JSON.

### Direction 3: Combined (nexus-core provides content, WorkRail enforces structure)
**When to adopt:** Teams that need both org-specific dev lifecycle automation AND guaranteed process compliance. nexus-core /flow defines what happens in each phase; a wrapping WorkRail workflow enforces that phases execute in order, with checkpoint tokens enabling cross-session resumption.
**Evidence grounding:** nexus-core's docs/nexus-protocol.md is explicitly agent-agnostic ("any AI agent that implements these phases can participate"). WorkRail's workrail-executor agent spec in docs/configuration.md shows how subagents can execute WorkRail-gated workflows. The complementarity is designed-in, not accidental.
**Hard constraint to accept:** Requires authoring a WorkRail workflow that wraps the nexus-core phase sequence, and the team must maintain both systems.

## Summary Comparison Table

| Dimension | nexus-core | WorkRail |
|-----------|-----------|---------|
| **Execution model** | Prompt-based checklists in markdown skills | Token-gated MCP API; future steps hidden until current acknowledged |
| **Step enforcement** | Advisory (agent can skip) | Cryptographic (HMAC tokens prevent skipping) |
| **State persistence** | None (conversation context + optional sidecar files) | Durable (disk-persisted sessions, checkpoint/resume tokens) |
| **Session resume** | Manual (re-read sidecar, re-establish context) | Automatic (provide checkpoint token to any MCP client) |
| **Distribution** | Git plugin (Claude Code plugin system / Cursor marketplace) | npm package (`@exaudeus/workrail`), zero-install |
| **Team distribution** | `.claude/settings.json` in project repo; auto-prompt on open | `WORKFLOW_GIT_REPOS` env var pointing to any Git repo |
| **Customization format** | Markdown (SKILL.md) with YAML frontmatter | JSON with validated schema |
| **Customization features** | Free-form prompts, subagent spawning, model selection | Loops, conditionals, extension points, context variables, artifact contracts |
| **Schema validation** | None | `workrail validate` + JSON schema |
| **IDE support** | Claude Code, Cursor, Gemini CLI (deep hooks/plugin integration) | Any MCP client (Claude Code, Cursor, Firebender, etc.) |
| **IDE hooks** | Full lifecycle (SessionStart/End, WorktreeCreate/Remove, PreToolUse) | None (IDE-agnostic by design) |
| **Org profiles** | Yes (zillow profile: glab, acli, Jira, VPN) | No |
| **Issue tracker integration** | Yes (Jira via acli, auto-detect from git remote) | No |
| **Multi-model orchestration** | Yes (Opus orchestrates, Sonnet implements, Haiku verifies) | No (model-agnostic) |
| **Learning/knowledge capture** | Yes (/compound, /retro, knowledge-bank) | No (out of scope) |
| **Bundled workflows** | 11 skills (flow, plan, work, review, validate, ship, compound, retro, repo, worktrees, onboard) | 30+ workflows |
| **Workflow count** | 11 skills (composable) | 30+ standalone + composable |
| **License** | MIT | MIT |

---

## Narrative: Where Each Is Stronger

### nexus-core is stronger when:

1. **You need full software development lifecycle automation.** nexus-core handles the entire
   ticket-to-merged-MR pipeline: fetch ticket, plan, implement in waves, verify, review,
   create MR, extract learnings. WorkRail enforces step sequences but doesn't know about your
   issue tracker or git host.

2. **You need multi-model orchestration.** nexus-core explicitly assigns Opus to orchestration,
   Sonnet to implementation, and Haiku to verification - matching model capability to task
   cost/quality tradeoffs. WorkRail is model-agnostic.

3. **You're working in a specific org context.** The Zillow profile pre-configures everything:
   glab, acli, jira.zgtools.net, VPN awareness. WorkRail has no org-specific configuration
   concept.

4. **You want automated learning capture.** `/retro` and `/compound` extract session learnings
   and write them back as skill patches (committed to git) or knowledge-bank entries. This
   compounds over time - each session makes the next one better.

5. **You need deep IDE integration.** nexus-core hooks into `SessionStart`, `SessionEnd`,
   `WorktreeCreate`, and `WorktreeRemove`. It can run setup scripts on session start, guard
   the main clone against edits, and clean up worktrees on exit.

### WorkRail is stronger when:

1. **You need guaranteed step compliance.** If an agent running on any IDE must follow a
   specific process without any possibility of skipping steps, WorkRail is the only option.
   The cryptographic token protocol enforces this at the system level.

2. **You need cross-session durability.** Closing the IDE, crashing, or switching machines
   does not lose a WorkRail session. The checkpoint token is a portable, self-describing,
   cryptographically signed artifact that can be resumed from any MCP-compatible client.

3. **You want IDE-agnostic workflows.** A WorkRail workflow runs identically in Claude Code,
   Cursor, Firebender, or any future MCP client. nexus-core plugins are written for specific
   IDE plugin APIs.

4. **You need structured workflow composition.** WorkRail's JSON schema supports loops,
   conditionals, extension points, and typed context variables. Workflows can be parameterized
   and composed. nexus-core skills are markdown documents that must be read and interpreted
   by the agent.

5. **You're authoring process workflows for teams.** The `workflow-for-workflows` and
   `wr.discovery` meta-workflows guide teams through creating and validating new workflows.
   The authoring spec (`spec/authoring-spec.json`) provides a versioned, machine-readable
   rulebook for what makes a good workflow.

6. **You want zero-install deployment.** `npx -y @exaudeus/workrail` with one MCP config
   line. No git clones, no bootstrap scripts, no prerequisites to install.

### They are complementary, not competitors:

WorkRail enforces *that* steps happen in order. nexus-core defines *what* those steps are
for a software development lifecycle. A team could use WorkRail to enforce the meta-process
of running a nexus-core `/flow` session - starting with ticket discovery, moving through
implementation phases, and ending with learning capture - while nexus-core handles the
actual development work within each step.

The sharpest architectural divergence is in their failure modes: a nexus-core agent under
context pressure will start skipping steps and doing direct work instead of delegating.
A WorkRail session cannot skip steps but can only enforce what has been pre-authored into
the workflow JSON.

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Path selection | `landscape_first` | Task is a direct comparison of known systems; no problem to reframe |
| glab access | Confirmed available | Used to read nexus-core files directly from GitLab API |
| Subagent delegation | Skipped | Single-agent research task; parallelism would add overhead without value |
| Design doc location | `/Users/etienneb/git/personal/workrail/nexus-vs-workrail-comparison.md` | WorkRail workspace root (not project-specific) |
| Adoption recommendation | C1 (nexus-core with --checkpoints as standard), C3 as upgrade path for multi-session work | C1 honors YAGNI and provides immediate Zillow integration value; C3 is the architectural fix when enforcement gap causes real problems |
| C2 (WorkRail only) | Rejected | Dominated by C1 on features (no org integration, no multi-model tiers, no learning capture) and by C3 on enforcement (same token enforcement without C1's capability losses) |
| C3 pre-deployment requirement | Proof-of-concept session required before team deployment | C3 architecture (nexus-core + WorkRail combined) is grounded in design analysis but has no reference implementation |

---

## Recommendation (Final)

**For Zillow dev lifecycle work: Use nexus-core with `/flow --checkpoints` as the standard invocation.**

Rationale:
- Provides full Zillow integration (Jira via acli, glab, VPN awareness)
- Multi-model orchestration (Opus orchestrates, Sonnet implements, Haiku verifies)
- Learning capture (/compound, /retro) compounds across sessions
- '/flow --checkpoints' converts the highest-risk failure mode (silent gate skip) from
  silent-and-accumulating to visible-and-catchable

**Upgrade to C3 (nexus-core + WorkRail meta-workflow) when any of these occur:**
1. Sessions regularly break mid-flow due to context limits or IDE restarts
2. Multi-day workflows requiring session resumption are observed in practice
3. An enforcement failure propagates to review without being caught by the human

**C3 implementation requirements when adopted:**
1. Author a 4-step WorkRail meta-workflow (Plan/Work/Review/Learn) wrapping nexus-core /flow phases
2. Each step must have `notesOptional: false` and explicit content requirements in the prompt
3. Run a proof-of-concept session before team-wide deployment
4. Add a 4-week monitoring checkpoint: if multi-session executions are common, accelerate adoption

**Strongest alternative:** C3 immediately, on the grounds that 'make illegal states unrepresentable'
and 'architectural fixes over patches' (both from CLAUDE.md) argue for fixing the enforcement gap
now rather than waiting for evidence. Valid argument - switch to this position if the CLAUDE.md
principles are taken as strict engineering standards rather than guidelines.

---

## Confidence and Residual Risks

**Confidence: High**

**Residual risks:**
1. YELLOW: Multi-session prevalence unknown. If epics/multi-day sessions are common, C1 is
   insufficient today and C3 should be the default immediately.
2. YELLOW: nexus-core /flow phase structure must remain stable for C3 meta-workflow to avoid
   maintenance burden.
3. LOW: C3 combined architecture is architecturally grounded but has no reference implementation.
   Proof-of-concept session required before team deployment.

---

## Final Summary

nexus-core and WorkRail solve adjacent but distinct problems. nexus-core is a **development
lifecycle framework** - it knows about tickets, code, testing, review, and learning. WorkRail
is a **workflow execution enforcer** - it guarantees steps happen in sequence with durable state.

nexus-core's enforcement is prompt-based and degrades under context pressure. WorkRail's is
cryptographic and degrades only on token system failure (which doesn't happen in practice).

**The tools are complementary, not competitors.** The recommended adoption path is:
- Start with nexus-core + '/flow --checkpoints' for single-session Zillow dev work
- Add WorkRail as a meta-process enforcer when multi-session durability or automated phase
  enforcement becomes a real need (empirical signal: one enforcement failure propagating to review)

For teams that need guaranteed process compliance on any workflow (not just software development),
WorkRail is the right foundation. For teams that want a rich, org-specific, ticket-to-MR
automation layer, nexus-core provides a more complete solution. For teams that want both,
the combined architecture is designed-in (nexus-protocol.md is explicitly agent-agnostic;
WorkRail's workrail-executor spec covers this integration pattern).
