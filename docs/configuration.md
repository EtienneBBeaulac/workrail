# Configuration

WorkRail can be configured through environment variables, a config file, and file paths.

## Config File

`~/.workrail/config.json` is a persistent, per-user configuration file. All IDEs pick it up automatically -- no MCP `env` block changes needed.

### Location

```
~/.workrail/config.json
```

### Format

A flat JSON object whose keys are env var names and whose values are strings:

```json
{
  "WORKRAIL_LOG_LEVEL": "INFO",
  "WORKRAIL_CLEAN_RESPONSE_FORMAT": "true",
  "CACHE_TTL": "600000"
}
```

### Precedence

```
process.env  (highest -- always wins)
    +
~/.workrail/config.json  (defaults)
    +
compiled defaults  (lowest)
```

Environment variables set in the MCP `env` block, shell, or system always override the config file.

### Excluded keys

The following keys are intentionally ignored in the config file and must be set via `process.env` only:

- `*_TOKEN` -- authentication tokens (security)
- `NODE_ENV`, `VITEST` -- injected by the Node.js / test runtime

### Generate a template

```bash
workrail init --config
```

Creates `~/.workrail/config.json` with all supported keys commented out and their default values shown. If the file already exists, prints its current contents without overwriting.

---

## Quick Start

For most users, no configuration is needed. Just add WorkRail to your MCP client:

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

---

## Workflow Sources

WorkRail loads workflows from multiple sources with priority-based merging (later sources override
earlier ones with the same ID).

### Priority Order (lowest to highest)

1. **Bundled** – Built-in workflows shipped with WorkRail
2. **User** – Personal workflows in `~/.workrail/workflows/`
3. **Custom Paths** – Directories in `WORKFLOW_STORAGE_PATH`
4. **Git Repositories** – External repos via `WORKFLOW_GIT_REPOS`
5. **Project** – Project-specific workflows in `./workflows/` (relative to cwd)

### Source Control

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_INCLUDE_BUNDLED` | `true` | Include built-in workflows |
| `WORKFLOW_INCLUDE_USER` | `true` | Include `~/.workrail/workflows/` |
| `WORKFLOW_INCLUDE_PROJECT` | `true` | Include `./workflows/` from cwd |
| `WORKFLOW_STORAGE_PATH` | – | Additional directories (colon-separated) |

**Example: Disable bundled workflows**

```bash
WORKFLOW_INCLUDE_BUNDLED=false
```

**Example: Add custom directories**

```bash
WORKFLOW_STORAGE_PATH=/path/to/team-workflows:/path/to/shared-workflows
```

---

## Git Repositories

Load workflows from GitHub, GitLab, Bitbucket, or any Git repository.

### Basic Setup

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

### Multiple Repositories

Comma-separated list (later repos override earlier ones):

```bash
WORKFLOW_GIT_REPOS=https://github.com/community/workflows.git,https://github.com/myteam/workflows.git
```

### Authentication

**Service-specific tokens (recommended):**

| Service | Variable | Example |
|---------|----------|---------|
| GitHub | `GITHUB_TOKEN` | `ghp_xxxxxxxxxxxx` |
| GitLab | `GITLAB_TOKEN` | `glpat_xxxxxxxxxx` |
| Bitbucket | `BITBUCKET_TOKEN` | `xxxxxxxxxxxxxxxx` |

**Self-hosted Git (hostname-based):**

Convert hostname to env var: replace `.` and `-` with `_`, uppercase, add `GIT_` prefix and `_TOKEN`
suffix.

| Hostname | Variable |
|----------|----------|
| `git.company.com` | `GIT_COMPANY_COM_TOKEN` |
| `gitlab.internal.org` | `GIT_GITLAB_INTERNAL_ORG_TOKEN` |

**SSH keys (no token needed):**

```bash
WORKFLOW_GIT_REPOS=git@github.com:company/workflows.git
```

Uses your `~/.ssh/` keys automatically.

**Generic fallback:**

```bash
GIT_TOKEN=xxxx                    # Used if no specific token found
WORKFLOW_GIT_AUTH_TOKEN=xxxx      # Alternative fallback
```

### Git Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_GIT_REPOS` | – | Comma-separated repo URLs or JSON array |
| `WORKFLOW_GIT_REPO_URL` | – | Single repo URL (alternative) |
| `WORKFLOW_GIT_REPO_BRANCH` | `main` | Branch to use |
| `WORKFLOW_GIT_SYNC_INTERVAL` | `60` | Minutes between sync |

### Repository Structure

Your repository should have a `workflows/` directory:

```
your-repo/
├── workflows/
│   ├── team-review.json
│   ├── deploy-process.json
│   └── onboarding.json
└── README.md
```

### Advanced: JSON Configuration

For complex setups, use JSON array:

```bash
WORKFLOW_GIT_REPOS='[
  {
    "repositoryUrl": "https://github.com/community/workflows.git",
    "branch": "main",
    "syncInterval": 1440
  },
  {
    "repositoryUrl": "https://github.com/myteam/workflows.git",
    "branch": "production",
    "syncInterval": 60
  }
]'
```

---

## Project Binding Overrides

Workflows that declare `extensionPoints` can be customized at the project level by creating `.workrail/bindings.json` in your project root.

```json
{
  "my-workflow": {
    "design_review": "my-team-design-review"
  }
}
```

The file is looked up relative to the `workspacePath` passed to `start_workflow` and `continue_workflow` (falls back to the MCP root URI, then `process.cwd()`).

**Gitignore for personal overrides:**

```
.workrail/bindings.json
```

**Commit for team-wide defaults** — the file is plain JSON and safe to version.

For full documentation, see [Extension Points](authoring.md#extension-points).

---

## Cache & Performance

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKRAIL_CACHE_DIR` | `~/.workrail/cache` | Cache directory for Git repos |
| `CACHE_TTL` | `300000` | Workflow cache TTL in milliseconds (5 min) |

---

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKRAIL_LOG_LEVEL` | `SILENT` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR`, `SILENT` |
| `WORKRAIL_LOG_FORMAT` | `human` | Log format: `human` or `json` |

**Log levels:**

- `DEBUG` – Verbose (cloning, pulling, file operations)
- `INFO` – Key operations (initialization, workflows loaded)
- `WARN` – Warnings (branch fallbacks, pull failures)
- `ERROR` – Errors only
- `SILENT` – No logging (default for MCP)

Logs go to **stderr** (stdout is reserved for MCP protocol).

**Example with logging:**

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "env": {
        "WORKRAIL_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

---

## Local Development

### Initialize User Directory

```bash
workrail init
```

Creates `~/.workrail/workflows/` with a sample workflow.

### CLI Commands

```bash
workrail list              # List all available workflows
workrail list --verbose    # Detailed listing
workrail validate file.json # Validate a workflow file
workrail schema            # Print workflow JSON schema
```

### Project Workflows

Create a `workflows/` directory in your project root:

```bash
mkdir workflows
# Add your .json workflow files here
```

These will be auto-discovered when WorkRail runs from that directory.

---

## MCP Client Configuration Examples

### Claude Code / Claude Desktop

#### Claude Desktop App

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent

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

#### Claude Code CLI

The CLI has per-project configuration. Use `claude mcp add`:

```bash
claude mcp add workrail npx -y @exaudeus/workrail
```

This creates/updates `.claude.json` in your project root. To configure environment variables:

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "workrail": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@exaudeus/workrail"],
          "env": {
            "WORKFLOW_STORAGE_PATH": "/path/to/custom/workflows"
          }
        }
      }
    }
  }
}
```

#### workrail-executor Agent (Recommended)

For delegating workflow execution to subagents in Claude Code, create `~/.claude/agents/workrail-executor.md`:

```markdown
---
name: workrail-executor
description: Executes WorkRail workflows step by step using the WorkRail MCP tools. Use when the user wants to run a workflow, follow a structured process, or resume a previous workflow session. Handles start, continue, and checkpoint operations, interpreting each step's instructions faithfully and advancing only when the step is complete.
tools: Bash, Read, Write, Edit, mcp__workrail__list_workflows, mcp__workrail__inspect_workflow, mcp__workrail__start_workflow, mcp__workrail__continue_workflow, mcp__workrail__checkpoint_workflow, mcp__workrail__resume_session, mcp__workrail__create_session, mcp__workrail__update_session, mcp__workrail__read_session, mcp__workrail__open_dashboard
---

You are the WorkRail executor. Your job is to faithfully follow WorkRail workflow steps one at a time.

## Core responsibilities

- Use `mcp__workrail__start_workflow` to begin a workflow by name or ID.
- Use `mcp__workrail__continue_workflow` with a `continueToken` to advance after completing a step.
- Use `mcp__workrail__checkpoint_workflow` to save progress and return a resume token when asked or when ending a session.
- Use `mcp__workrail__list_workflows` to show available workflows.
- Use `mcp__workrail__inspect_workflow` to preview a workflow's steps before starting.

## Execution rules

1. **Read each step carefully.** The step prompt is your instruction. Execute it fully before advancing.
2. **Do not skip steps.** Every step must be completed in order.
3. **Provide required notes.** Steps that require notes (`notesOptional: false`) must receive substantive notes before you call `continue_workflow`. Pass them via the `output.notesMarkdown` parameter.
4. **Advance only when done.** Call `continue_workflow` only after the step's work is complete.
5. **Checkpoint on request.** If the user asks to pause or save progress, call `mcp__workrail__checkpoint_workflow` and share the resume token.
6. **Report clearly.** After each step, briefly summarize what was done before moving on.

## Token handling

- `continueToken` (`ct_` prefix) — use with `continue_workflow` to advance.
- `checkpointToken` / `resumeToken` (`cp_` or `st_` prefix) — use with `checkpoint_workflow` or `continue_workflow` to save/rehydrate.
- Never mix token types.

## Workflow complete

When `isComplete: true` is returned, summarize all work done across the workflow and confirm completion to the user.
```

After creating this file, the agent becomes available via the Agent tool:

```
Agent(subagent_type="workrail-executor", prompt="Start the wr.bug-investigation workflow...")
```

### Cursor

File: `.cursor/mcp.json` in your project

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### With Custom Workflows

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "env": {
        "WORKFLOW_STORAGE_PATH": "/path/to/custom/workflows",
        "WORKFLOW_GIT_REPOS": "https://github.com/team/workflows.git",
        "GITHUB_TOKEN": "ghp_xxxx"
      },
      "cwd": "/path/to/project"
    }
  }
}
```

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

---

## Troubleshooting

### Workflows Not Found

```bash
# Check what sources are active
WORKRAIL_LOG_LEVEL=DEBUG npx @exaudeus/workrail

# Verify your custom path exists
ls -la ~/.workrail/workflows/

# Validate workflow files
workrail validate your-workflow.json
```

### Git Repository Issues

```bash
# Test authentication
git ls-remote https://github.com/your-org/workflows.git

# Check if token works
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/your-org/workflows

# Clear cache and retry
rm -rf ~/.workrail/cache
```

### Permission Issues

```bash
chmod 755 ~/.workrail/workflows
chmod 644 ~/.workrail/workflows/*.json
```

---

## See Also

- [Workflow Authoring Guide](authoring.md) – Create custom workflows
- [All Workflows](workflows.md) – Full list of included workflows
- [Advanced Features](advanced.md) – Loops, conditionals, validation
