# nexus-core Discovery: WorkRail Auto Learning Extract

**Status:** In progress  
**Date:** 2026-04-14  
**Workflow:** wr.discovery

---

## Context / Ask

Perform a deep dive on nexus-core (Zillow internal, Peter Yao / FUB team, GitLab project 66446) to extract concrete patterns WorkRail Auto can adopt. nexus-core is a full-lifecycle AI dev workflow tool built for Zillow engineers, currently described in the backlog as: "No autonomous mode (human-initiated only). No session durability. No cryptographic enforcement."

**Specific areas to examine:**
1. Org profile system -- `configs/profiles/zillow` (glab, acli, Jira config)
2. Skill loading system -- `scripts/nexus-plugin.sh`
3. SOUL.md principles
4. Session-start/end hooks -- `scripts/session-start.sh`
5. Knowledge injection -- `scripts/inject-knowledge.sh`
6. /compound and /retro skills -- `.claude/skills/compound/SKILL.md`

---

## Path Recommendation

**`landscape_first`** -- The dominant need here is understanding the current landscape of nexus-core's design so WorkRail Auto can adopt concrete patterns from it. We are not reframing a problem or choosing between competing concepts -- we are surveying existing implementation to extract actionable design signals.

**Rationale:** nexus-core is an existing, functional system. The goal is to read and understand what it does well, then map those patterns onto WorkRail Auto's design. That is a landscape task, not a design-from-scratch task. `design_first` would be premature -- we have no evidence yet of a core framing problem. `full_spectrum` would add reframing overhead that isn't needed when the subject is concrete code.

---

## Constraints / Anti-goals

**Constraints:**
- Read nexus-core via glab API (GitLab project 66446) -- no local clone
- Extract patterns that are genuinely adoptable by WorkRail Auto, not just description
- Distinguish between nexus-core's advisory/prompt patterns vs WorkRail's structural enforcement patterns

**Anti-goals:**
- Do not propose merging nexus-core and WorkRail -- they are explicitly kept separate per backlog
- Do not replicate org-specific conventions that break WorkRail's portability
- Do not over-index on nexus-core's human-initiated flow model -- WorkRail Auto is a daemon, not a plugin

---

## Landscape Packet

All six areas read directly from GitLab project 66446 (`fub/apex/ai-prototypes/nexus-core`) via API.

### 1. Org Profile System (`configs/profiles/zillow.yaml`)

nexus-core uses a **YAML-based org profile** at `configs/profiles/zillow.yaml`. Key structure:

```yaml
profile:
  name: zillow
  description: "Zillow Group — internal GitLab + Jira"

git_hosts:
  - host: gitlab.zgtools.net
    cli: glab
    default: true
  - host: github.com
    cli: gh

issue_tracker:
  type: jira
  host: jira.zgtools.net
  cli: acli
  required: true

required_tools:
  - name: glab
    install: "brew install glab"
    post_install: "glab auth login --hostname gitlab.zgtools.net"
    why: "GitLab CLI — required for MR creation..."
  - name: acli
    install: "brew install atlassian/tap/atlassian-cli"
    why: "Atlassian CLI — required for /plan and /flow to fetch Jira ticket details"

auth:
  glab:
    hostname: gitlab.zgtools.net
    token_url: "..."
    scopes: "api, write_repository"
    common_mistake: "Authenticating against gitlab.com instead of gitlab.zgtools.net"
  vpn:
    required: true
    diagnosis: "ping gitlab.zgtools.net — if it fails, connect to corporate VPN"
```

Applied via `scripts/apply-profile.sh zillow`. Also has `configs/nexus.local.yaml` for local overrides (gitignored).

**What this reveals:** Profile = declarative per-org tool configuration. Captures: git hosts + CLI, issue tracker, required tools with install guidance, auth details with common mistakes, VPN requirements. The profile is the single source of truth for "what tools does this org use and how do you set them up."

**Contradiction noted:** The task brief said `config.toml` but the file is actually `configs/profiles/zillow.yaml`. TOML is not used.

### 2. Skill Loading System (`scripts/nexus-plugin.sh` + `scripts/discover-plugins.sh`)

nexus-core uses a **three-mirror skill system** with a plugin management CLI:

**Three skill locations (all must stay in sync):**
- `.claude/skills/` -- loaded by Claude Code when nexus-core is the working directory
- `skills/` -- discovered by the plugin system when nexus-core is installed as a plugin
- `.agents/skills/` -- loaded by other agents (Gemini CLI, Codex)

**Plugin system:**
```bash
scripts/nexus-plugin.sh add git@host:team/my-plugin.git
scripts/nexus-plugin.sh list
scripts/nexus-plugin.sh update
scripts/nexus-plugin.sh remove my-plugin
```

Plugins live in `plugins/<name>/` and require a `nexus-plugin.yaml` manifest. `scripts/discover-plugins.sh` symlinks plugin skills into all three mirrors. Core skills always win name conflicts (core takes precedence over plugins).

**CI enforcement:** `ci/check-skill-sync.sh` verifies all three skill directories stay in sync. This runs in CI.

**What this reveals:** Skills are files in a directory, invoked as `/skill-name` slash commands. Plugin = git repo with a `nexus-plugin.yaml` manifest + skills directory. symlinks propagate skills from plugin into all three mirrors. The three-mirror pattern serves cross-agent compatibility (Claude Code vs Gemini/Codex). CI enforces sync.

### 3. SOUL.md Principles (`.claude/instructions/SOUL.md`)

Three core sections -- these govern how the agent thinks, not just what it does:

**Epistemic Integrity:**
- Know what you know. Label fact vs inference vs speculation.
- Evidence before assertion. Never claim something works without running it.
- Own your limits. When you hit the boundary of what you can know, say so.

**Intellectual Character:**
- Truth over comfort. Don't agree to be agreeable. Name flaws, surface risks.
- Challenge, then commit. Pressure-test before executing. Then commit fully.
- Prefer the surprising truth to the expected answer. Follow the evidence.

**Professional Standards:**
- Quality is non-negotiable. You are the last line of defense before code hits production.
- Respect the human's time. Lead with the answer, then explain.
- Leave things better than you found them. Capture adjacent discoveries.

**Where SOUL.md lives:** `.claude/instructions/SOUL.md`. Referenced from `CLAUDE.md` at top: "Read `.claude/instructions/SOUL.md` -- it governs how you think, not just what you do."

### 4. Session Hooks (`scripts/session-start.sh` + `scripts/session-end.sh`)

**Session start** (Claude Code `Stop` hook on session open):
1. Guard: skip if in worktree (not main clone), skip if not a nexus workspace
2. Health check: warn if not on main branch
3. Plugin discovery: run `discover-plugins.sh`, report skill count
4. Stale worktree cleanup: remove worktrees >24h old with no changes
5. Knowledge re-injection: if `NEXUS_ACTIVE_REPO` set, run `inject-knowledge.sh` on it
6. Returns structured JSON: `{"status":"ok","messages":[...],"errors":[...]}`

**Session end** (Claude Code `Stop` hook on session close, reads JSON from stdin):
1. Auto-commit uncommitted changes in active worktree (`wip: auto-commit from session end`)
2. Push branch if local commits ahead of remote
3. Verify main clone health
4. Run `compound` extraction in background
5. Clean temp session files

**What this reveals:** Session lifecycle = guard + health + maintenance + injection + cleanup. JSON-in/JSON-out interface for hooks. Non-blocking prereq warnings. Background compound extraction at session end.

**Hook registration:** Configured in `.claude/settings.json`:
- `PreToolUse` on `Edit|Write|MultiEdit` -- runs `guard-main-clone.sh` (blocks direct edits to main clone)
- Session start/end via Claude Code's `Stop` event

### 5. Knowledge Injection (`scripts/inject-knowledge.sh`)

Assembles knowledge from two sources and writes to `<repo>/.claude/instructions/nexus-context.md`:

**Source 1: Global knowledge bank** (`docs/knowledge-bank/`):
- `tool-quirks/` -- always injected
- `gotchas/`, `patterns/`, `lessons/`, `codebase-insights/` -- injected if matching the target repo's short name

**Source 2: Per-repo knowledge** (`<repo>/.nexus/learnings/`):
- Written by `/compound` during session work
- Excluded from git tracking via `.git/info/exclude` (not `.gitignore`)

**Output:** `<repo>/.claude/instructions/nexus-context.md` (and `.cursor/instructions/nexus-context.md` if `.cursor/` exists). Capped at 200 lines (configurable in `nexus.yaml`).

**Content written:**
```
# Nexus Context (auto-generated)

## Workflow
Repository: org/repo | Branch: main | CLI: glab

## Global Knowledge
### Tool Quirks
[always included]

### Gotchas / Patterns / Lessons / Codebase-Insights
[if matching repo name]

## Repo-Specific Knowledge
[from .nexus/learnings/]
```

**Repo identity resolved from:** `.nexus/context.yaml` first (written by `/repo` command), then falls back to git remote URL. CLI auto-detected from remote URL (github.com -> gh, else glab).

### 6. /compound and /retro Skills

**`/retro`** = session scanner that identifies learnings and routes them:
- Scan session context: conversation, git commits, files modified
- Classify each learning: does it map to a skill, or to knowledge-bank?
- Skill-mappable: edit `.claude/skills/<name>/SKILL.md` with atomic commit per learning
- Non-skill: delegate to `/compound` for knowledge-bank entries
- Commit format: `fix(skills/<name>): <what>\n\n<why, 2-4 sentences>\n\nSession: <date>\nTicket: <key>`

**`/compound`** = terminal skill that persists learnings to two destinations:
- **Skill edits** -- atomic commits directly to skill SKILL.md files (one learning = one commit)
- **Knowledge-bank entries** -- `docs/knowledge-bank/gotchas/`, `patterns/`, `tool-quirks/`, `codebase-insights/`, `lessons/`
- **Per-repo learnings** -- `repos/<name>/.nexus/learnings/` for repo-specific discoveries
- Optional: write to Obsidian vault if `obsidian` CLI is available

**Structured input preference:** Both skills prefer structured session data (`decisions[]`, `outcome_score.criteria[]`, `failure.fix_attempts`) over raw conversation scanning when available.

**Quality bar:** Max 3 entries per session. Always grep first to avoid duplicates. One learning = one commit, never batched.

**The philosophy:** "Each unit of engineering work should make subsequent units easier." Git history is the journal of skill evolution.

### Key Contradictions / Gaps

- **Profile format mismatch:** Task brief expected `config.toml`; actual format is YAML. Minor.
- **No `apply-profile.sh` read yet:** The profile application script (`scripts/apply-profile.sh`) was not read. It's referenced in the profile but the mechanism is not fully understood.
- **glab not authenticated in this env:** The `GITLAB_API_TOKEN` env var was expired. Fresh token from macOS keychain was required. This is an environment issue, not a nexus issue.

### Evidence Gaps
- `scripts/discover-plugins.sh` -- not read (referenced by plugin system, behavior partially inferred)
- `docs/nexus-protocol.md` -- Five Phases protocol spec not read
- `scripts/apply-profile.sh` -- profile application mechanism not read
- Individual workflow skill files (`/plan`, `/work`, `/review`, `/flow`) -- not read
- `configs/nexus.yaml` read -- confirms: `sidecar_dir: .nexus`, `knowledge.max_lines: 200`

---

## Problem Frame Packet

*To be filled in after landscape survey.*

---

## Candidate Directions

*To be filled in after framing.*

---

## Challenge Notes

*To be filled in.*

---

## Resolution Notes

*To be filled in.*

---

## Decision Log

- **2026-04-14**: Path chosen as `landscape_first`. Rationale: nexus-core is a live system; goal is extraction not invention.

---

## Final Summary

*To be filled in at workflow completion.*
