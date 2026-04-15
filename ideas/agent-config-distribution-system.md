# Agent Config Distribution System -- Design Document

**Status:** Discovery in progress
**Date:** 2026-04-02
**Workflow:** wr.discovery (full_spectrum path, STANDARD rigor)

---

## Context / Ask

Design a "smart distribution system" for AI agent configs, workflows, and team knowledge
across an engineering org. The system should:

- Be primarily script-based / codified smarts (NOT AI-dependent for automation) -- inspired
  by how opex-pulse works: pure functions on frozen types, config-driven, predictable pipelines
- Support both org-level and team-level artifacts
- Solve onboarding: new devs get everything configured on day one
- Enable sharing of workrail workflows, CLAUDE.md baselines, agent configs, skills, MCP configs
- Solve fragmentation: some people use workrail, some don't; people have inconsistent configs;
  docs/PRDs are scattered

**Explicit anti-goal:** Do NOT make the distribution system itself AI-dependent. The smarts
are in the scripts and schemas, not in runtime AI inference.

---

## Path Recommendation

**Path:** `full_spectrum`
**Rigor:** STANDARD

**Rationale:** This problem needs both (a) landscape grounding -- there are real precedents in
dotfiles managers, Homebrew taps, Ansible playbooks, company onboarding scripts, and the
opex-pulse pattern itself -- AND (b) strong framing work, because the apparent problem
("distribute configs") might not be the real problem ("adoption") or the right shape
("push vs pull", "enforce vs suggest", "org vs team ownership"). A landscape-only pass
would anchor too quickly on existing tooling. A design-first pass would drift from the
real-world constraints (GitLab org structure, team heterogeneity, day-one workflow).

---

## Constraints / Anti-goals

**Constraints:**
- Scripts must be runnable without an AI agent present (idempotent, deterministic)
- Must support macOS (primary dev environment)
- Must integrate with existing GitLab org structure
- Must handle heterogeneous teams (some use workrail, some don't; some on Android, some iOS, some backend)
- Should not require central IT/infra involvement for everyday updates
- Minimal new runtime dependencies; prefer tools engineers already have (git, brew, zsh/bash)

**Anti-goals:**
- Not a general configuration management system (not Ansible/Chef for prod infra)
- Not AI-powered at runtime (no LLM calls in the distribution pipeline itself)
- Not a replacement for team autonomy (teams can still override defaults)
- Not a sync daemon / agent running in background
- Not a company-wide mandate system -- should be valuable enough that adoption is organic

---

## Landscape Packet

### Current State Summary

Engineering orgs that adopt AI-assisted development face a rapidly emerging problem: the
"AI toolchain" (Claude Code / Cursor / Firebender configs, MCP servers, workrail workflows,
CLAUDE.md files, coding philosophies) is just as fragmented as dotfiles were 15 years ago.
The problem is structurally identical to the dotfiles problem but with two new dimensions:
(1) org-level knowledge that should be shared (CLAUDE.md philosophy, workrail workflows)
rather than purely personal, and (2) the tooling is evolving fast enough that even motivated
engineers don't stay current.

The opex-pulse project demonstrates the target architecture pattern: config-driven, pure
pipelines, frozen types, scripts that produce deterministic outputs from well-defined inputs.
That pattern is the model for the distribution system itself.

### Existing Approaches / Precedents

**1. Dotfiles managers (chezmoi, yadm, dotbot, GNU stow)**
- Handle personal config distribution well
- Templating support for machine-specific variations
- Not designed for org-level or team-level sharing; purely personal
- No concept of "team baseline + individual override"
- Gap: no native concept of artifact types (workflow vs config vs philosophy doc)

**2. Homebrew taps (custom formula repositories)**
- The user already has a `homebrew-tap` repo
- Proven pattern for distributing tools across macOS engineers
- Could distribute CLI tools / scripts as formulas
- Gap: not designed for non-binary artifacts (CLAUDE.md, JSON workflow files, MCP configs)

**3. Ansible / Chef / Puppet**
- Designed for fleet configuration management
- Overkill for dev toolchain distribution; wrong mental model (infra ops vs developer experience)
- Heavy dependency; requires central orchestration

**4. Company onboarding scripts (most common internal pattern)**
- Single `setup.sh` or `bootstrap.sh` in an internal repo
- Familiar pattern, low friction, easy to maintain
- Gap: typically set-and-forget; no concept of staying current after day one
- Gap: no layering (org base + team overlay + personal override)

**5. Nix / Home Manager**
- Fully declarative, reproducible environments
- High adoption friction; learning curve is steep
- Not realistic for a mid-size eng org without dedicated tooling investment

**6. GitHub/GitLab template repositories**
- Organizations can define template repos; new repos auto-include them
- Useful for repo-level defaults (CI/CD, linters) but not for engineer workstation config

**7. Internal wiki / Confluence / Notion pages**
- Where most orgs put CLAUDE.md equivalents today: scattered, stale, nobody reads them
- The fragmentation problem in its current form

**8. opex-pulse (direct precedent, same author)**
- `team-config.json` --> config layer
- Scripts pipeline: extract --> enrich --> analyze --> present
- Pure functions on frozen types; no runtime AI; deterministic
- `run-all.sh` orchestrates the pipeline
- Key insight: the "smarts" are in the analysis specs, not in procedural logic
- **This is the target architecture pattern**

### Option Categories

A. **Pull-based personal tool** -- engineer runs `agt-sync` when they want, gets latest configs
B. **Push-based org automation** -- CI/CD job or scheduled job pushes changes to engineers' machines
C. **Registry + discovery** -- a catalog that engineers and agents can query; no auto-installation
D. **Package-based distribution** -- artifacts packaged as installable units (Homebrew, npm, pip)
E. **Repo-as-source-of-truth** -- a GitLab repo per artifact type; engineers clone/pull
F. **Layered config system** -- explicit org / team / personal layers with merge semantics

### Notable Contradictions

- **Contradiction 1:** "Script-based, no AI" vs "smart distribution" -- the word "smart" implies
  intelligence, but the constraint says no runtime AI. Resolution: "smart" means rich metadata,
  layering semantics, and codified merge rules -- not LLM inference.
- **Contradiction 2:** "Team autonomy" vs "consistent baseline" -- teams need to override, but
  org-level consistency is the value proposition. Resolution: explicit layering with override
  semantics (org base < team overlay < personal override), all checked in.
- **Contradiction 3:** "No new runtime dependencies" vs "day-one onboarding" -- a bootstrapper
  needs to be installable before any of the toolchain exists. Resolution: the bootstrapper
  itself must be a single-file shell script or Homebrew formula, zero dependencies.

### Evidence Gaps

- Gap 1: How many engineers are at Zillow on the Mercury Mobile team vs the broader org? Affects
  whether "team-level" is 5 people or 50.
- Gap 2: What MCP configs currently exist? Are they checked in anywhere?
- Gap 3: Does GitLab org have any existing onboarding automation? (Likely some setup.sh exists)
- Gap 4: Are workrail workflows already versioned / tagged? (Yes -- they're in the workrail repo,
  but there's no distribution mechanism yet)
- Gap 5: How often do CLAUDE.md / workflow / MCP configs actually change? Affects whether a
  "stay current" mechanism matters vs a one-time install.

---

## Problem Frame Packet

### Users / Stakeholders

**Primary users:**
1. **New engineers (day-one onboarding)** -- highest leverage; they have nothing and need everything
   configured fast. They are non-experts on the AI toolchain. They just want it to work.
2. **Existing engineers switching to AI-assisted workflows** -- have partial configs, maybe
   inconsistent. Need a "catch-up" path, not a full install.
3. **Team leads / tech leads** -- want to define and enforce team-specific conventions
   (CLAUDE.md, workrail workflows for their domain). Currently have no distribution channel.
4. **The agent itself (Claude Code, Cursor)** -- consumes CLAUDE.md, MCP configs, workflow files
   at runtime. Is a non-human "user" of the distribution output.

**Secondary stakeholders:**
5. **Etienne (system author)** -- wants low maintenance; doesn't want to babysit a system;
   wants the pattern to generalize across projects
6. **Workrail (the product)** -- benefits from wider workflow adoption; the distribution system
   is a growth channel for workrail itself

### Jobs / Goals / Outcomes

- **Day-one:** Engineer clones one repo or runs one command; 20 minutes later has full AI toolchain
- **Stay current:** When org or team publishes an updated CLAUDE.md or new workflow, engineers get
  it with minimal friction (ideally: run one command, or it's surfaced in their next git pull)
- **Team customization:** Tech lead defines team-specific configs in one place; all team members
  get them without manual distribution
- **Discovery:** Engineer can see what workflows and skills exist org-wide; can opt into extras
- **Agent discoverability:** When an agent starts a session in a project, it can find the right
  CLAUDE.md and MCP configs for that project/team context

### Pains / Tensions / Constraints

- **Pain 1 (adoption cliff):** Engineers who haven't adopted AI tools yet don't have a clear
  entry point. The barrier isn't capability -- it's configuration friction on day one.
- **Pain 2 (stale configs):** People set up their tools once and never update. CLAUDE.md from
  6 months ago may be actively counterproductive (outdated patterns, deprecated tools).
- **Pain 3 (no team baseline):** There's no org or team "defaults" concept today. Every engineer
  has an ad-hoc setup. Teams can't enforce conventions.
- **Pain 4 (discovery gap):** Workrail workflows exist but engineers don't know they exist or
  how to use them. Same for MCP configs, CLAUDE.md patterns.
- **Pain 5 (fragmentation):** Docs are in wikis, configs are in personal dotfiles, workflows
  are in the workrail repo. There's no single place to look.
- **Tension A (autonomy vs consistency):** Engineers want to customize; org wants consistency.
  A pure push model breaks autonomy; pure pull model doesn't achieve consistency.
- **Tension B (velocity vs correctness):** A fast bootstrap that installs everything is
  dangerous (may overwrite custom configs); a careful one that asks about everything is slow.
- **Tension C (org-owned vs team-owned):** Who owns what? If the org CLAUDE.md and team
  CLAUDE.md conflict, who wins?

### Success Criteria

1. New engineer can be fully configured in under 30 minutes from zero
2. Existing engineer can sync to latest configs with a single command
3. Tech lead can push a new workflow or CLAUDE.md update; team members get it within one
   sync cycle without any action by the tech lead beyond a commit
4. An engineer can discover all available workflows, skills, and configs from one place
5. The system itself has no runtime AI dependency (fully script-based)
6. Override semantics are explicit and predictable (no silent overwrites)
7. The system is maintainable by one person (Etienne) without it becoming a full-time job

### Assumptions

- A1: Engineers have Homebrew installed (or can install it -- it's the standard macOS package manager)
- A2: Engineers have GitLab access to the relevant repos
- A3: Workrail is the primary workflow engine; other tools (Cursor, Claude Code) consume static
  config files
- A4: The layering model is: org-base < team-overlay < personal-override (three layers max)
- A5: CLAUDE.md, MCP configs, and workrail workflow files are the primary artifact types to distribute
- A6: The system should work offline after initial setup (no network calls at agent startup)
- A7: Engineers are on macOS (primary), potentially Linux (secondary)

### Reframes / HMW Questions

**Reframe 1: Distribution is a pull problem, not a push problem**
The instinct is to "push" configs to engineers. But opex-pulse runs when you run it.
HMW: How might we make pulling the latest configs as easy and habit-forming as `git pull`?

**Reframe 2: The real problem is discoverability, not distribution**
Engineers don't use workflows because they don't know they exist or when to use them.
HMW: How might we surface the right workflow at the right moment in the dev loop, rather
than expecting engineers to remember to look for it?

**Reframe 3: The system should be a repo, not a daemon**
A background sync process is fragile and requires trust. A repo that engineers clone and
occasionally `pull` is familiar, auditable, and low-maintenance.
HMW: How might we use git itself as the distribution mechanism, with scripts as the
installation layer?

### What Would Make This Framing Wrong

- If engineers are already using dotfiles managers religiously and just need a new "module"
  added -- then the problem is shallower than framed (just a plugin, not a system)
- If the real bottleneck is organizational (team leads don't want to document conventions)
  rather than technical -- then no distribution system will achieve the adoption goal
- If the day-one onboarding problem is already solved by IT/HR provisioning -- then the
  target user is actually "existing engineers catching up", not new hires
- If MCP configs and workrail workflows change so rarely that "stay current" is not a
  real need -- then a simple README pointing to a repo is sufficient

---

## Phase 2: Opportunity Synthesis and Decision Shape

### Synthesis

The opportunity is real and well-defined. The center of gravity is **the day-one onboarding
problem plus the "stay current" problem** -- both are distribution problems but with different
shapes. Day-one is a bootstrapping problem (zero to configured). Stay-current is an update
problem (configured to current).

The landscape teaches us that:
- Dotfiles managers solve the personal layer well but have no org/team concept
- Homebrew taps are the right pattern for distributing tools; wrong for config files
- The opex-pulse pattern (config-driven, script pipelines, frozen types) is the right
  architecture model -- apply it here

The framing teaches us that:
- Three-layer semantics (org / team / personal) is the right conceptual model
- The system needs to be pull-based (engineers run it) not push-based (it runs them)
- Discoverability may matter as much as distribution

### Decision Criteria (for candidate evaluation)

1. **Day-one velocity:** Can a new engineer get from zero to configured in < 30 minutes?
2. **Layering semantics:** Does the design support org / team / personal layers with explicit override?
3. **Script-only runtime:** No AI at runtime; deterministic; auditable
4. **Maintenance burden:** Can Etienne maintain this alone without it becoming a job?
5. **Adoption gradient:** Does it work for engineers who only want part of it?
6. **Agent-readiness:** Does the output work for AI agents (Claude Code, Cursor) as consumers?

### Riskiest Assumption

**A4 (three layers max)** -- the three-layer model (org / team / personal) may be too simple
for a large org where "team" has multiple dimensions (Android vs iOS vs backend; feature team
vs platform team; seniority). If teams need sub-team layers, the merge semantics become
complex fast.

### Candidate Count Target

STANDARD rigor: 3-4 candidates

---

## Candidate Directions

### Candidate 1: Git Repo + Shell Installer (Simplest Plausible)

**Summary:** One GitLab repo (`agent-config-dist`) contains all artifact types in a defined
directory structure. A shell script (`install.sh`) reads a local `config.toml` specifying
org/team membership and symlinks or copies artifacts to the right locations.

**Structure:**
```
agent-config-dist/
  org/
    CLAUDE.md
    mcp-config.json
    workflows/
  teams/
    mercury-mobile/
      CLAUDE.md           (extends org base via front-matter)
      workflows/
      mcp-config.patch.json
  install.sh              (reads config.toml, installs layers)
  config.toml.example
```

**Why it fits the path:** Direct application of the opex-pulse pattern. Scripts, config,
deterministic. No new runtime deps beyond git and bash.

**Strongest evidence for:** Most engineers know git. Clone + run is the lowest-friction
install model. Audit trail is built-in (git log). Mirrors how many successful internal
tools work (every company has their `setup.sh`).

**Strongest risk against:** No "stay current" mechanism -- engineer has to remember to
`git pull && ./install.sh`. Symlink vs copy semantics create complexity (symlinks break
if the repo moves; copies go stale). No discovery UI.

**When it wins:** When the team is small (< 20 engineers), change frequency is low, and
the primary value is day-one onboarding not ongoing updates.

---

### Candidate 2: Layered Config Package Manager (`agt` CLI tool)

**Summary:** A dedicated CLI tool (`agt`) that understands artifact types, layer semantics,
and merge rules. Engineers run `agt sync` to pull the latest. `agt list` shows available
workflows. `agt status` shows what's installed vs current. The tool is distributed via
Homebrew tap.

**Structure:**
```
~/.agt/
  registry.toml       (what repos to pull from; org + team + personal)
  installed/          (installed artifacts with provenance metadata)
  cache/              (local copies of remote artifacts)

agt sync              (pull all registries, merge layers, install)
agt list [workflows|configs|skills]
agt status            (what's stale, what's current)
agt add <url>         (add a new registry source)
agt diff              (show what would change before sync)
```

**Layer merge:** Each artifact type has a merge strategy. CLAUDE.md uses append/section
merge. MCP configs use deep JSON merge with explicit override keys. Workflow files are
replaced (versioned).

**Why it fits the path:** Addresses both day-one AND stay-current. Makes discoverability
first-class (`agt list`). Adoption gradient works (engineers can `agt sync --only workflows`).

**Strongest evidence for:** The Homebrew tap model is proven for tool distribution at this
scale. A dedicated CLI creates the right mental model (package manager for AI configs).
`agt status` answers "am I current?" which is the latent question engineers have today.

**Strongest risk against:** Building a CLI tool is a meaningful investment. Merge semantics
for CLAUDE.md (a prose document) are hard to get right without either losing customization
or requiring careful authoring conventions. Distribution via Homebrew tap requires maintaining
a tap repo.

**When it wins:** When the eng org is large enough (> 10-20 engineers regularly using AI
tools) that the investment in a proper CLI pays off in reduced maintenance and wider adoption.

---

### Candidate 3: Workspace MCP Server (Agent-Native Discovery)

**Summary:** Rather than distributing configs to engineer workstations, build an MCP server
(`workspace-mcp`) that agents query at session start to get the right CLAUDE.md, workflows,
and configs for the current project/team context. Engineers don't install configs -- agents
pull them on-demand from the MCP server.

**Key insight:** The agent is the real consumer. If the agent can discover the right config
at session start, the distribution problem is solved at the source rather than at the
engineer's workstation.

**Structure:**
```
workspace-mcp/
  server.ts             (MCP server)
  registry/
    org.toml            (org-level artifacts)
    teams/mercury-mobile.toml
  tools:
    get_project_context(project_path) -> {claudeMd, workflows, mcpConfig}
    list_workflows(tag?, team?)
    get_workflow(id)
    get_team_config(team)
```

**Why it fits the path:** Addresses the "agent discoverability" dimension directly. No
workstation-side installation needed for the agent-consumption use case. Can serve both
the agent at session start AND an engineer using a discovery UI.

**Strongest evidence for:** The `workspace-mcp` repo already exists in the personal git
directory -- there's a start here. Agents already consume MCP servers. This is an
architecture that could work across teams without per-engineer setup.

**Strongest risk against:** Requires a running MCP server (network dependency). Does NOT
solve the day-one workstation configuration problem (terminal aliases, zsh config, etc.).
Does not work offline. The server needs to be hosted somewhere reliably.

**When it wins:** When the primary pain is agent-side discoverability (agent starts a
session in a new repo and doesn't know what conventions apply) rather than workstation
configuration.

---

### Candidate 4: Layered Dotfiles Repo with opex-pulse-style Pipeline

**Summary:** A GitLab repo that is the "source of truth" for all org and team configs. It
uses an opex-pulse-style pipeline: `config.toml` drives which layers apply; a `build.sh`
generates merged artifacts into a `dist/` directory; engineers can symlink `dist/` into
their home dirs or project dirs. This is the opex-pulse pattern applied directly.

**Structure:**
```
agent-configs/
  config.toml.example   (engineer fills in: org=zillow, team=mercury-mobile)
  src/
    org/zillow/
      CLAUDE.md
      workflows/
      mcp/
    teams/mercury-mobile/
      CLAUDE.md.patch     (front-matter: extends org)
      workflows/
  build.sh              (reads config.toml, merges layers, writes dist/)
  dist/                 (generated, gitignored, what gets installed)
  install.sh            (symlinks dist/ into ~/  and project dirs)
  Makefile              (make sync, make install, make status)
```

**Pipeline:** `config.toml` --> `build.sh` --> `dist/` --> `install.sh` --> installed

**Why it fits the path:** Directly mirrors the opex-pulse architecture the user explicitly
cited as the model. Scripts and schemas are the "smarts", not runtime AI. The `build.sh`
pipeline is the codified intelligence. Makefile targets make common operations discoverable.

**Strongest evidence for:** Explicit user reference to opex-pulse as the model. Pattern
is proven at small-to-medium scale. Pure functions on config inputs means it's testable
and auditable. Makefile makes it self-documenting (`make help`).

**Strongest risk against:** Merge semantics for CLAUDE.md (prose + structure) are harder
than JSON merge. No discovery UI -- engineers must read the repo to know what's available.
Symlinks can be fragile across different home directory layouts.

**When it wins:** When the primary user is a technically sophisticated engineer who is
comfortable with a Makefile-driven workflow and the main goal is architectural correctness
and low maintenance overhead.

---

## Challenge Notes

### Leading candidate assessment

After initial generation, **Candidate 4 (opex-pulse pipeline)** is the most structurally
aligned with the user's explicit preferences. **Candidate 2 (agt CLI)** is the strongest
alternative -- it adds discoverability and makes "stay current" a first-class experience.

### Strongest argument against Candidate 4 (the leading option)

The opex-pulse pattern is excellent for analysis pipelines where the inputs are data and
the outputs are insights. But config distribution has a different shape: the "build" step
is simple (merge files), and the hard problems are (1) merge semantics for heterogeneous
artifact types, (2) discovery/awareness that things exist, and (3) "stay current" as a
habit. Candidate 4 solves the installation mechanics well but provides no answer for
discovery (how does an engineer know to run `make sync` if they don't know new workflows
exist?), and the CLAUDE.md merge problem (prose docs with structure) is harder than a
pure JSON merge.

### Challenge response

The challenge lands -- discovery IS a real gap in Candidate 4. However, discovery can be
addressed without abandoning the architecture: a `make list` target that prints available
artifacts, and a `make news` that shows what's changed since last sync. This keeps the
architecture simple while addressing the discovery gap.

The CLAUDE.md merge problem is real but bounded: if the convention is that CLAUDE.md
files use clear section headers and team files use `## [APPEND]` markers, a simple
section-merge script handles 90% of cases. The remaining 10% (team wants to override
an org section entirely) is handled by an explicit `[OVERRIDE]` marker.

### What would trigger a switch to Candidate 2

If the org grows to > 30 active AI tool users, the investment in a proper CLI (`agt`)
becomes justified. At that scale, "run `make sync`" vs "run `agt sync`" matters less than
having first-class `agt status`, `agt diff`, and `agt list` UX. The switch trigger is:
(1) > 30 engineers using the system, OR (2) merge conflicts become a regular maintenance
burden that a smarter CLI could prevent.

---

## Resolution Notes

**Resolution mode:** `direct_recommendation`

Rationale: The landscape is well-understood, the problem is bounded, the precedents are
clear, and the candidate set has been challenged. No prototype is needed to validate the
core architecture (the opex-pulse pattern is already proven). No further research is needed
(the evidence gaps are acknowledged but don't change the recommendation).

**Confidence band:** MEDIUM-HIGH

Caveats: The CLAUDE.md merge semantics are the riskiest unresolved detail. The recommendation
assumes the three-layer model is sufficient (may need re-examination if the org has
sub-team complexity). The "stay current" habit-formation problem is addressed architecturally
but not behaviorally.

---

## Decision Log

| Decision | Chosen | Rejected alternatives | Why |
|---|---|---|---|
| Path | full_spectrum | landscape_first, design_first | Both landscape grounding and framing reframes were needed |
| Architecture | opex-pulse pipeline (Candidate 4) with discovery additions | agt CLI (Candidate 2), MCP server (Candidate 3), shell installer (Candidate 1) | Explicit user preference for opex-pulse model; simplest that solves the core problem; MCP server leaves workstation config unsolved; agt CLI is higher investment than current problem warrants |
| Distribution channel | Git repo + shell scripts | Homebrew tap, Ansible | Git is already present; shell scripts have zero new deps; Homebrew adds distribution of a binary we'd need to build and maintain |
| Layer model | 3 layers: org / team / personal | 2 layers (org / personal), 4+ layers | 3 layers matches the real structure; 2 layers loses team conventions; 4+ layers adds merge complexity without proportional value |
| Merge approach for CLAUDE.md | Section markers ([APPEND], [OVERRIDE]) | Full prose merge, no merge (last-layer wins), template system | Section markers are simple to implement, explicit in the file, auditable, and cover 90%+ of real cases |
| Runtime AI dependency | None | AI-assisted merge, AI-assisted discovery | Explicit user constraint: script-based, not AI-dependent |

---

## Final Summary

### Selected Direction

**Candidate 4 extended: Layered Config Repo with opex-pulse Pipeline + Discovery**

A GitLab repo (`agent-configs` or similar) structured as a config-driven pipeline:

```
agent-configs/
  config.toml.example     (engineer's identity: org + team)
  src/
    org/zillow/           (org-level artifacts)
    teams/                (team-level artifacts, one dir per team)
  build.sh                (reads config.toml, merges layers, writes dist/)
  dist/                   (generated output, gitignored)
  install.sh              (symlinks/copies dist/ to correct locations)
  Makefile                (make setup, make sync, make list, make status, make news)
  docs/
    artifacts.md          (what artifact types exist, where they install)
    authoring.md          (how to author CLAUDE.md with section markers)
    teams.md              (team registry, how to add a team)
```

**Core pipeline:** `config.toml` --> `build.sh` --> `dist/` --> `install.sh` --> installed

**Discovery:** `make list` prints all available artifacts. `make news` diffs the current
repo state against the installed state and shows what's new or changed. `make status` shows
staleness per artifact.

**Day-one:** Engineer runs `git clone <repo> && cp config.toml.example config.toml`,
edits one line (their team), runs `make setup`. Done in < 15 minutes.

**Stay current:** `make sync` = `git pull && make build && make install` -- one command,
safe to run repeatedly (idempotent), shows what changed.

### Strongest Alternative

**Candidate 2 (agt CLI)** -- justified if the org grows to > 30 active AI tool users or
if merge conflict maintenance becomes a regular burden. The CLI investment pays off at
scale; the pipeline repo is the right starting point.

### Confidence Band

MEDIUM-HIGH

### Residual Risks

1. **CLAUDE.md merge semantics** -- section markers work in practice but require authoring
   discipline. If team authors ignore conventions, merges will be wrong. Mitigation: a
   `make validate` target that lints CLAUDE.md files for marker compliance.
2. **"Stay current" as a behavior** -- the system can make it easy but can't make engineers
   run `make sync`. Mitigation: surface it as a MOTD-style reminder in CLAUDE.md itself.
   Do NOT wire it into a git hook -- a hook that silently modifies CLAUDE.md and MCP configs
   mid-session is a footgun that can change agent behavior during active work.
3. **Sub-team complexity** -- the three-layer model may be too flat for a large org. Mitigation:
   teams can include other teams' artifacts via explicit `extends:` in their team config.
4. **MCP config merge** -- JSON merge is well-defined, but MCP configs have array semantics
   that need explicit handling. Mitigation: define a clear JSON merge strategy in `build.sh`
   (deep merge with array append for `mcpServers`, explicit overrides via `_override` keys).

---

## Identified Gaps (post-discovery review)

### Gap 1: Manifest / lockfile (load-bearing, required before implementation)

The idempotency claim ("safe to run repeatedly") is fragile without a record of what was
last installed. If an engineer locally edits their installed CLAUDE.md, `make sync` must
not silently overwrite it. And `make news` has nothing to diff against without a baseline.

**Required:** `~/.agent-configs/manifest.json` (or `dist/manifest.json`) recording:
- Which artifacts were installed
- Their content checksums at install time
- Install timestamps

`make sync` compares checksums: if the installed file matches the last-installed checksum,
safe to overwrite. If it diverged locally, warn and show a diff -- never silently clobber.
This also enables `make rollback`: just re-install from the previous manifest snapshot.

### Gap 2: Secrets in MCP configs (load-bearing, required before implementation)

MCP configs contain API keys (GitHub tokens, internal service tokens, etc.) that cannot
live in a shared GitLab repo. The build pipeline needs a secret injection mechanism.

**Design:**
- `secrets.toml` (gitignored, personal) alongside `config.toml`
- `secrets.toml.example` documents what keys are required
- `build.sh` reads both and injects secrets into the MCP config during the build step
- `make validate` checks that required secrets are present and warns if any are missing

### Gap 3: Skills as a first-class artifact type

The original problem statement mentioned skills. `~/.claude/agents/` (subagent definitions)
are a distribution artifact that every team member should have. Skills and agent definitions
should be an explicit artifact type alongside workflows and CLAUDE.md.

**Artifact types (complete list):**
- `claude-md` -- CLAUDE.md files, installed to `~/CLAUDE.md` and project roots
- `workflows` -- workrail workflow JSON, installed to `~/.workrail/workflows/`
- `mcp-config` -- MCP server configuration, merged into `~/.claude/settings.json`
- `agents` -- Claude Code agent definitions, installed to `~/.claude/agents/`
- `skills` -- Claude Code skill definitions, installed to `~/.claude/skills/` (if applicable)
- `docs` -- reference docs and PRDs, installed to `~/.agent-configs/docs/` for MCP serving

### Gap 4: Personal layer mechanism (underspecified)

The design references "personal override" as a layer but never specifies where it lives or
how it gets merged. Engineers should not commit personal overrides to the shared repo.

**Design:**
- Personal layer lives in `~/.agent-configs/personal/` (outside the cloned repo)
- Same directory structure as `src/org/` and `src/teams/`
- `build.sh` reads it as a third source after org and team layers
- Documented in `docs/authoring.md` -- engineers can add personal overrides at any time
- `make edit-personal` opens the personal layer directory in their editor

### Gap 5: Project-level CLAUDE.md (orthogonal concern, needs a decision)

Claude Code reads CLAUDE.md at multiple levels: global (`~/CLAUDE.md`), project root, and
`.claude/`. The pipeline only addresses the global level. Team-specific context often belongs
at the project level (e.g., Android architecture conventions in `zillow-android-2/CLAUDE.md`).

**Options:**
A. Out of scope -- project-level CLAUDE.md is the team's responsibility, managed in each repo
B. Project bindings -- a `project-bindings.toml` maps team configs to repo paths; `make install`
   symlinks team CLAUDE.md into each listed project root
C. Hybrid -- build produces a `dist/project-templates/` dir; teams decide whether to apply it

**Recommendation:** Option B for teams that want it. Opt-in, not forced. The team config can
declare `project_roots = ["/path/to/repo1", "/path/to/repo2"]` and `make install` handles it.

### Gap 6: Workflow namespacing

If mercury-mobile and platform both ship a `code-review.json`, last-layer-wins is too blunt.
Both workflows should be available, differentiated by team namespace.

**Design:** `build.sh` automatically namespaces workflow files by source team:
- `src/teams/mercury-mobile/workflows/code-review.json` -> `dist/workflows/mercury-mobile/code-review.json`
- WorkRail already supports source-tagged workflow IDs; the install step preserves the namespace

### Gap 7: Rollback mechanism

A bad merge (malformed CLAUDE.md, broken MCP config) has no recovery path today.

**Design:** `install.sh` creates a timestamped backup before overwriting any artifact:
- `~/.agent-configs/backups/YYYYMMDD-HHMMSS/` mirrors the previous installed state
- `make rollback` restores from the most recent backup
- `make rollback --to <timestamp>` for older snapshots
- Backups older than 30 days are pruned automatically

### Gap 8: Bootstrap (day-zero) is undesigned

The doc mentions "Homebrew formula or curl-pipe-bash" as a residual risk but never designs
it. Day-zero is the highest-leverage moment and needs a concrete artifact.

**Design:** A single-file bootstrap script hosted at a stable URL (or in the Homebrew tap):
```bash
curl -fsSL https://raw.githubusercontent.com/.../bootstrap.sh | bash
```
The bootstrap script:
1. Checks for git, brew -- installs brew if missing (using the official brew installer)
2. Clones `agent-configs` to `~/git/agent-configs`
3. Copies `config.toml.example` to `config.toml`
4. Opens `config.toml` in the default editor for the engineer to set their team
5. Runs `make setup`

Total: one command, one edit, one make target. Under 10 minutes.

### Gap 9: `make diff` (improvement)

Engineers are more likely to run `make sync` if they can preview changes first.

**Design:** `make diff` shows what `make sync` *would* change without installing anything.
Output is a human-readable diff per artifact type. Analogous to `terraform plan`.

---

## Agent Tools and MCP Server

### Rationale

The pipeline + install.sh solves the workstation configuration problem (static, offline).
But there is an orthogonal problem: an agent running mid-session needs to *query* the
distribution system -- to discover workflows, fetch docs, or understand team conventions --
without reading files off disk. A lightweight MCP server solves this at the agent layer.

These two capabilities are complementary, not competing:
- **Pipeline** = distribution and installation (write path, run on demand)
- **MCP server** = agent context and discovery (read path, queried at runtime)

There is also a nice self-referential loop: `make install` installs the MCP server config
itself, so agents automatically get access to the context server without any manual wiring.

### In-repo agent scripts

Scripts in `scripts/agent/` that an agent can invoke directly via bash:

```
scripts/agent/
  get-context.sh <project-path>     # outputs JSON: team, CLAUDE.md content, active workflows
  list-artifacts.sh [--type ...]    # prints artifact catalog by type
  validate.sh                       # lints all CLAUDE.md files, team configs, secrets.toml
  search-docs.sh <query>            # keyword search across all docs in src/
```

These scripts are usable without the MCP server -- useful for CI/CD, for agents running
in environments where MCP isn't configured, and as the implementation layer the MCP server
calls through to.

### MCP server (`src/mcp/`)

A lightweight read-only MCP server embedded in the repo. Engineers add it to their MCP
config once (or `make install` does it automatically).

**Tools:**

`get_project_context(project_path: string)`
- Determines which team owns the project (by path matching `project-bindings.toml`)
- Returns: merged CLAUDE.md content, active workflow IDs, team name, coding rules
- Use case: agent starts a session and needs to know what conventions apply

`list_artifacts(type?: "workflow" | "doc" | "agent" | "skill" | "mcp-config")`
- Returns the full catalog of available artifacts with name, team, description, install status
- Use case: discovering what workflows exist before starting a task

`get_doc(name: string)`
- Fetches a reference doc, PRD, or runbook by name (fuzzy match)
- Returns full content
- Use case: agent needs to read a PRD without knowing its file path

`get_rules(team?: string)`
- Returns coding philosophy and team conventions as structured data
- Org rules + team overlay merged (same semantics as the pipeline)
- Use case: agent wants to validate that a design decision aligns with team conventions

`search_docs(query: string)`
- Full-text keyword search across all docs in `src/`
- Returns matching excerpts with file references
- Use case: "what do our docs say about error handling?" during a code review workflow

**Resources (MCP file resources):**
The MCP server also exposes all docs under `src/` as MCP Resources, so agents can
`read_resource("docs/architecture.md")` without knowing the repo path.

**Implementation notes:**
- Read-only: no mutation, no session state
- Zero network dependency: reads directly from the cloned repo
- Can be run as stdio MCP (standard) or HTTP (for CI/CD environments)
- Implemented in TypeScript (consistent with workrail) or bash-backed Python (simpler)
- Registered in `~/.claude/settings.json` by `make install`

### Updated repo structure (with MCP server and scripts)

```
agent-configs/
  config.toml.example
  secrets.toml.example
  src/
    org/zillow/
      CLAUDE.md
      workflows/
      mcp/
      agents/
      docs/
    teams/
      mercury-mobile/
        CLAUDE.md.patch
        workflows/
        agents/
  build.sh
  install.sh
  Makefile                  # setup, sync, build, install, diff, list, status, news, validate, rollback
  dist/                     # generated, gitignored
  scripts/
    agent/
      get-context.sh
      list-artifacts.sh
      validate.sh
      search-docs.sh
    bootstrap.sh            # day-zero installer
  src/mcp/
    server.ts               # MCP server
    tools/
      get-context.ts
      list-artifacts.ts
      get-doc.ts
      get-rules.ts
      search-docs.ts
  docs/
    artifacts.md
    authoring.md
    teams.md
    secrets.md
```

### Decision: add MCP server to selected direction

The MCP server is added to Candidate 4 as a second tier. It does not change the core
pipeline architecture -- it layers on top of it as a read-only query interface.

**Build decisions:**
| Decision | Chosen | Why |
|---|---|---|
| MCP server language | TypeScript | Consistent with workrail; same toolchain |
| Deployment | stdio MCP (default) + optional HTTP | stdio is standard for Claude Code; HTTP for CI |
| Scope | Read-only | Mutation stays in the pipeline scripts; MCP server is discovery only |
| Installation | `make install` wires it into `~/.claude/settings.json` automatically | Self-referential; no manual step |

---

### Updated Next Actions

**Phase 1: Foundation (must design before building)**
1. Design the manifest/lockfile schema (enables idempotent install, news, rollback)
2. Design secrets.toml format and injection mechanism
3. Define all artifact types and install paths (`docs/artifacts.md`)
4. Define team config schema (`docs/teams.md`) -- required before adding a second team
5. Create `agent-configs` repo (personal first, GitLab when stable)

**Phase 2: Core pipeline**
6. Write `build.sh` -- reads config.toml + secrets.toml, merges layers, writes dist/
7. Write `install.sh` -- with manifest tracking, backup-before-overwrite, and rollback support
8. Write `Makefile` with all targets: setup, sync, build, install, diff, list, status, news, validate, rollback
9. Author org-level CLAUDE.md with section markers as the first real artifact
10. Add Mercury Mobile team config as the first team

**Phase 3: Agent tools and MCP server**
11. Write `scripts/agent/` bash scripts (get-context, list-artifacts, validate, search-docs)
12. Write the MCP server (`src/mcp/`) with the five tools
13. Wire `make install` to register the MCP server in `~/.claude/settings.json`
14. Test the MCP tools from a Claude Code session

**Phase 4: Bootstrap and day-one**
15. Write `scripts/bootstrap.sh` for day-zero install
16. Test full day-one flow on a clean setup
17. Evaluate after 2-3 months: is Candidate 2 (agt CLI) now justified?

---

*This document was produced by the wr.discovery workflow (full_spectrum path, STANDARD
rigor) and updated in a follow-up review pass. It represents a design recommendation,
not an implementation plan.*

---

**Superseded by:** `/Users/etienneb/git/zillow/common-ground/docs/design.md`

The design evolved significantly after the discovery workflow. The canonical architecture
reference is the design.md in the common-ground repo. Key changes from this document:
- CLAUDE.md renamed to AGENTS.md throughout source tree
- No global ~/AGENTS.md -- per-repo injection via generated CLAUDE.md with @imports
- Repo discovery via mdfind + git remote URL matching (no manual project_roots list)
- Work vs personal detection via org.toml remote_host (not per-engineer config)
- dist/ installs to ~/.cg/dist/ (stable path); per-repo CLAUDE.md @imports from there
- Worktrees handled via per-repo post-checkout git hook
