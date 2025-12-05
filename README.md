<div align="center">
  <img src="./assets/logo.svg" alt="WorkRail Logo" width="180" />
  <h1>WorkRail</h1>
  <p><strong>Step-by-step workflows for AI coding assistants</strong></p>
  <p>An MCP server that guides Claude, Cursor, and other AI assistants through structured processes for debugging, code reviews, and feature implementation.</p>

[![npm version](https://img.shields.io/npm/v/@exaudeus/workrail.svg)](https://www.npmjs.com/package/@exaudeus/workrail)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
</div>

---

## What You Get

Instead of hoping your AI follows best practices, WorkRail enforces them:

```
You: "Help me fix this authentication bug"

Without WorkRail:
  AI jumps straight to code changes, misses the root cause,
  creates three new bugs while "fixing" the original.

With WorkRail:
  Step 1: Reproduce the bug → AI confirms exact failure condition
  Step 2: Gather context → AI reads relevant auth code and logs  
  Step 3: Form hypothesis → AI identifies token expiry issue
  Step 4: Implement fix → AI makes targeted, minimal change
  Step 5: Verify → AI confirms fix and no regressions
```

Same AI. Same task. Dramatically better results.

---

## Quick Start

Add WorkRail to your AI assistant's MCP configuration:

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

That's it. Your AI assistant now has access to guided workflows.

<details>
<summary><strong>Where does this config go?</strong></summary>

| Client | Config Location |
|--------|-----------------|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) |
| Cursor | Settings → MCP Servers |
| Firebender | Project `.firebender/config.json` |
| Other MCP clients | Check your client's documentation |

</details>

---

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   You       │     │  WorkRail   │     │     AI      │
│  "Fix bug"  │────▶│  Provides   │────▶│  Follows    │
│             │     │  workflow   │     │  each step  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Workflow   │
                    │  1. Repro   │
                    │  2. Context │
                    │  3. Analyze │
                    │  4. Fix     │
                    │  5. Verify  │
                    └─────────────┘
```

1. **You ask for help** — "Help me debug this" or "Review this PR"
2. **AI selects a workflow** — Or you specify one: "Use the bug investigation workflow"
3. **WorkRail guides step-by-step** — Each step has clear objectives and quality criteria
4. **AI completes thoroughly** — Can't skip steps, must meet criteria before advancing

---

## Available Workflows

### Development

| Workflow | Use When |
|----------|----------|
| `coding-task-workflow-with-loops` | Implementing features, refactoring, any code changes |
| `systematic-bug-investigation-with-loops` | Debugging issues, investigating failures |

### Review & Planning

| Workflow | Use When |
|----------|----------|
| `mr-review-workflow` | Reviewing merge/pull requests |
| `adaptive-ticket-creation` | Writing tickets, specs, requirements |

### Documentation & Learning

| Workflow | Use When |
|----------|----------|
| `document-creation-workflow` | Writing technical docs, guides, READMEs |
| `exploration-workflow` | Understanding new codebases |
| `personal-learning-course-design` | Creating learning materials |

<details>
<summary><strong>See all workflows</strong></summary>

- `coding-task-workflow-with-loops` — Full development workflow with iterative refinement
- `systematic-bug-investigation-with-loops` — Methodical debugging process
- `mr-review-workflow` — Thorough code review checklist
- `adaptive-ticket-creation` — Structured ticket writing
- `document-creation-workflow` — Documentation with clear structure
- `exploration-workflow` — Systematic codebase exploration
- `presentation-creation` — Slide deck creation
- `personal-learning-course-design` — Course/tutorial design
- `personal-learning-materials-creation-branched` — Adaptive learning content
- `workflow-for-workflows` — Meta: designing new workflows

</details>

---

## What's MCP?

<details>
<summary><strong>New to MCP? Click here.</strong></summary>

**MCP (Model Context Protocol)** is an open standard that lets AI assistants use external tools.

Think of it like browser extensions, but for AI:

- Chrome has extensions → AI assistants have MCP servers
- Extensions add features to your browser → MCP servers add capabilities to your AI
- WorkRail is one MCP server that adds workflow guidance

**Supported clients:**

- Claude Desktop
- Cursor
- Firebender
- Continue
- Any MCP-compatible client

Learn more: [modelcontextprotocol.io](https://modelcontextprotocol.io)

</details>

---

## Advanced Configuration

### Custom Workflows

Create your own workflows in `~/.workrail/workflows/`:

```bash
# Initialize the directory
npx @exaudeus/workrail init

# Validate a workflow
npx @exaudeus/workrail validate ./my-workflow.json

# Get the JSON schema
npx @exaudeus/workrail schema
```

### Load Workflows from Git

Share workflows across your team via Git repositories:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "env": {
        "WORKFLOW_GIT_REPOS": "https://github.com/your-org/workflows.git",
        "GITHUB_TOKEN": "ghp_xxxx"
      }
    }
  }
}
```

<details>
<summary><strong>Multiple repositories & authentication options</strong></summary>

**Multiple repos** (comma-separated, later repos override earlier):

```bash
WORKFLOW_GIT_REPOS="https://github.com/company/base.git,https://github.com/team/custom.git"
```

**Authentication by provider:**

```bash
GITHUB_TOKEN=ghp_xxxx        # github.com
GITLAB_TOKEN=glpat_xxxx      # gitlab.com
BITBUCKET_TOKEN=xxxx         # bitbucket.org
GIT_TOKEN=xxxx               # Generic fallback
```

**SSH:**

```bash
WORKFLOW_GIT_REPOS="git@github.com:org/workflows.git"
# Uses ~/.ssh keys automatically
```

**Repository structure:**

```
your-repo/
├── workflows/
│   ├── custom-workflow.json
│   └── team-process.json
└── README.md
```

</details>

### Docker

```json
{
  "mcpServers": {
    "workrail": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "workrail-mcp"]
    }
  }
}
```

### Environment Variables

<details>
<summary><strong>Full reference</strong></summary>

**Workflow Sources:**

```bash
WORKFLOW_INCLUDE_BUNDLED=true      # Built-in workflows (default: true)
WORKFLOW_INCLUDE_USER=true         # ~/.workrail/workflows (default: true)
WORKFLOW_INCLUDE_PROJECT=true      # ./workflows in cwd (default: true)
WORKFLOW_STORAGE_PATH=/a:/b        # Additional directories (colon-separated)
```

**Cache:**

```bash
WORKRAIL_CACHE_DIR=~/.workrail/cache  # Cache location
CACHE_TTL=300000                       # Cache TTL in ms (default: 5 min)
```

**Logging:**

```bash
WORKRAIL_LOG_LEVEL=INFO    # DEBUG, INFO, WARN, ERROR, SILENT (default)
WORKRAIL_LOG_FORMAT=json   # human (default) or json
```

**Priority order** (later overrides earlier):

1. Bundled workflows
2. User directory (`~/.workrail/workflows`)
3. Custom paths (`WORKFLOW_STORAGE_PATH`)
4. Git repositories (`WORKFLOW_GIT_REPOS`)
5. Project directory (`./workflows`)

</details>

---

## Why Workflows Matter

AI assistants are powerful but inconsistent. The same request can yield:

- A thorough investigation or a quick guess
- A complete solution or a half-implementation
- Best practices or anti-patterns

The difference often comes down to how you prompt. WorkRail removes that variable:

| Without WorkRail | With WorkRail |
|------------------|---------------|
| Quality depends on prompting skill | Consistent process every time |
| AI may skip important steps | Each step must complete before next |
| Results vary between attempts | Reproducible outcomes |
| Junior devs get junior-level help | Everyone gets senior-level process |

---

## MCP Tools Reference

WorkRail exposes these tools to your AI assistant:

| Tool | Purpose |
|------|---------|
| `workflow_list` | Browse available workflows |
| `workflow_get` | Load a workflow's details |
| `workflow_next` | Get the next step to execute |
| `workflow_validate` | Validate step output quality |
| `workflow_validate_json` | Lint workflow JSON files |
| `workflow_get_schema` | Get workflow JSON schema |

---

## Documentation

- [Workflow JSON Schema](spec/mcp-api-v1.0.md) — API specification
- [Loop Support](docs/features/loops.md) — Iteration patterns in workflows
- [Architecture Overview](workrail-mcp-overview.md) — Deep dive into design

---

## License

MIT — see [LICENSE](LICENSE)
