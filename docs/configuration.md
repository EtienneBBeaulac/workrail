# Configuration

WorkRail can be configured through environment variables and file paths.

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

**WorkRail v2 note (reserved namespaces / no shadowing):**
- In v2, bundled/core workflows use the reserved `wr.*` namespace and are **protected**: non-core sources must not define `wr.*` IDs, and `wr.*` workflows cannot be overridden/shadowed by higher-priority sources.
  - This is an intentional correctness/safety rule and supersedes “later sources override earlier ones” for `wr.*` only.

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

File: `~/.config/claude/config.json` (macOS) or equivalent

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
