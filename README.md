<div align="center">
  <img src="./assets/logo.svg" alt="WorkRail Logo" width="180" />
  <h1>WorkRail</h1>
  <p>Step-by-step workflow enforcement for AI agents</p>

[![npm version](https://img.shields.io/npm/v/@exaudeus/workrail.svg)](https://www.npmjs.com/package/@exaudeus/workrail)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
</div>

---

## The Problem

AI agents are eager to help. Too eager.

Ask one to fix a bug and it starts editing code immediately - before understanding the system, before
considering alternatives, before verifying assumptions. It's not stupid; it's a predictive model
doing what predictive models do: fill in gaps and race to an answer.

You can add system prompts: "plan before coding," "gather context first." But as conversations grow,
those instructions fade into the background. The agent reverts to its default: assume, predict, jump
to conclusions.

**The result: inconsistent quality that depends on how much you babysit the agent.**

---

## How WorkRail Works

WorkRail replaces the human effort of guiding an agent step-by-step.

Instead of one system prompt that fades over time, WorkRail drip-feeds instructions through
the [Model Context Protocol](https://modelcontextprotocol.org). The agent calls `workflow_next`,
gets ONE step, completes it, calls again. Future steps stay hidden until previous ones are done.

**The agent can't skip to implementation because it doesn't know those steps exist yet.**

### The Mechanism

```
You                      Agent                     WorkRail
 │                         │                          │
 │  "Fix the auth bug"     │                          │
 │────────────────────────>│                          │
 │                         │                          │
 │                         │  workflow_next()         │
 │                         │─────────────────────────>│
 │                         │                          │
 │                         │   Step 1: Understand     │
 │                         │      the problem         │
 │                         │<─────────────────────────│
 │                         │                          │
 │   "What error do you    │                          │
 │    see exactly?"        │                          │
 │<────────────────────────│                          │
 │                         │                          │
 │         ...             │  workflow_next()         │
 │                         │─────────────────────────>│
 │                         │                          │
 │                         │   Step 2: Plan your      │
 │                         │      investigation       │
 │                         │<─────────────────────────│
```

### Without WorkRail

```
You:   "There's a bug in the auth flow"

Agent: "I see the issue! In auth.js line 42, there's a null check that 
        should handle this. Let me fix it..."
        
        *edits code based on a 30-second skim*
        *breaks something else*
```

### With WorkRail

```
You:   "There's a bug in the auth flow"

Agent: "I'll use the bug-investigation workflow."
        → workflow_next()
       
       Step 1: Investigation Setup
       "Before I investigate, I need to understand the problem.
        What exactly happens when it fails? Can you share the error?"
       
       [Documents bug, reproduction steps, environment]
        → workflow_next()
       
       Step 2: Plan Investigation
       "I'll trace execution from login through the auth middleware.
        Key areas: token validation, session lookup, error handling."
       
       [Creates investigation plan before touching code]
        → workflow_next()
       
       Step 3: Form Hypotheses
       "Based on my analysis, three possible causes:
        H1: Clock skew in token validation (7/10)
        H2: Race condition in session lookup (6/10)
        H3: Null check masking the real error (4/10)"
       
       [Tests hypotheses systematically, gathers evidence, proves root cause]
```

Same agent. Same model. But it prepared properly because it had no choice.

### Why Steps Are Structured This Way

Each step follows a pattern that prevents common AI failure modes:

- **Prep**: Understand before acting - read the code, clarify requirements, confirm approach
- **Implement**: One focused change - not five things at once
- **Verify**: Validate before continuing - catch errors before they compound

This isn't arbitrary structure. It's how experienced developers actually work.

### Why This Beats System Prompts

| System Prompt | WorkRail |
|---------------|----------|
| "Plan first" fades as context grows | Each step is fresh and immediate |
| Agent decides what to follow | Agent can't skip - next step is hidden |
| One-size-fits-all instructions | Workflows adapt to task complexity |
| Inconsistent results | Repeatable, consistent quality |

---

## Quick Start

Add to your MCP client config (Claude Code, Cursor, Firebender, Antigravity, etc.):

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"]
    }
  }
}
```

Then prompt your agent:

> "Use the bug-investigation workflow to debug this auth issue"

The agent will find the workflow, start at step 1, and proceed systematically.

---

## CI & Releases

- **Lockfile is enforced**: `package-lock.json` is canonical and CI will fail if `npm ci` would modify it. Commit lockfile changes intentionally.
- **Release authority**: releases are produced by **semantic-release** in GitHub Actions (don’t bump versions/tags locally).
- **Preview a release (dry-run)**:
  - **Locally**: `npx semantic-release --dry-run --no-ci`
  - **In Actions**: run the **Release (dry-run)** workflow (`.github/workflows/release-dry-run.yml`).

---

## Included Workflows

20+ workflows included for development, debugging, review, documentation, and more:

| Workflow | When to Use |
|----------|-------------|
| `coding-task-workflow-with-loops` | Feature development with analysis, planning, and review |
| `bug-investigation` | Systematic debugging with hypothesis testing |
| `mr-review-workflow` | Code review with architecture and security checks |
| `exploration-workflow` | Understanding an unfamiliar codebase |
| `document-creation-workflow` | Technical documentation with structure |

Workflows adapt to complexity - simple tasks get fast-tracked, complex tasks get full rigor.

[See all workflows →](docs/workflows.md)

---

## The Philosophy

### Guardrails Enable Excellence

WorkRail doesn't lobotomize your AI. The agent still reasons, explores, and creates - but within a
structure that ensures it actually prepares, plans, and verifies. Guardrails prevent shortcuts, not
creativity.

### Expert Knowledge, Codified

Workflows aren't just task checklists. They embed hard-won expertise: "verify understanding before
implementing," "form multiple hypotheses before concluding," "test assumptions with evidence." This
is how senior engineers think - now encoded into every workflow.

### Replacing the Human Guide

A skilled developer doesn't let AI run unsupervised on complex tasks. They guide it: "Wait, did you
check X?" "What about edge case Y?" "Show me your reasoning."

WorkRail does this automatically. The workflow asks the questions a senior dev would ask, at the
moments they'd ask them.

---

## Create Your Own

Drop a JSON file in `~/.workrail/workflows/`:

```json
{
  "id": "my-review-checklist",
  "name": "Team Code Review",
  "version": "1.0.0",
  "description": "Our standard review process",
  "steps": [
    {
      "id": "check-tests",
      "title": "Verify Test Coverage",
      "prompt": "Check that new code has tests. List untested paths.",
      "agentRole": "You are a reviewer focused on test coverage."
    },
    {
      "id": "check-security",
      "title": "Security Review",
      "prompt": "Look for: injection risks, auth issues, data exposure.",
      "agentRole": "You are a security-focused reviewer."
    }
  ]
}
```

WorkRail discovers it automatically. This is a minimal example - workflows also
support [conditions, loops, validation criteria](docs/authoring.md), and more.

[Writing workflows →](docs/authoring.md) · [Load from Git →](docs/configuration.md#git-repositories)

---

## Documentation

- [All Workflows](docs/workflows.md) – Full list with detailed descriptions
- [Writing Workflows](docs/authoring.md) – Custom workflow creation guide
- [Configuration](docs/configuration.md) – Git repos, environment variables, local paths
- [Advanced Features](docs/advanced.md) – Loops, conditionals, validation

---

[GitHub](https://github.com/EtienneBBeaulac/workrail) · MIT License
