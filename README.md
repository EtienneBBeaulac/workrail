<div align="center">
  <img src="./assets/logo.svg" alt="WorkRail Logo" width="200" />
  <h1>WorkRail: Guided Workflow Orchestration for AI Agents</h1>
  <p><strong>Transform chaotic AI interactions into structured, reliable workflows</strong></p>
  
  [![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)
  [![npm version](https://img.shields.io/npm/v/@exaudeus/workrail.svg)](https://www.npmjs.com/package/@exaudeus/workrail)
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
</div>

---

## 📑 Table of Contents

- [The Problem](#-the-problem)
- [The Solution](#-the-solution)
- [MCP Tools](#️-mcp-tools)
- [Installation](#️-installation)
- [External Workflows](#-external-workflows-load-from-git-repositories)
- [Local Workflows](#-using-local-workflows)
- [Available Workflows](#-available-workflows)
- [Loop Support](#-loop-support)
- [Quick Example](#-quick-example)
- [Why Choose WorkRail](#-why-choose-workrail)
- [Environment Variables](#-environment-variables-reference)
  - [Workflow Sources](#workflow-sources)
  - [External Git Repositories](#external-git-repositories)
  - [Cache & Performance](#cache--performance)
  - [Debugging & Logging](#debugging--logging)
- [Getting Started](#-getting-started)
- [Planned Features](#-planned-features)
- [Learn More](#-learn-more)

---

## 🤔 The Problem

Large Language Models are incredibly powerful but suffer from well-documented limitations:

- **Hallucination** - They confidently generate plausible-sounding but incorrect information
- **Scope Creep** - Given a complex task, they often try to do too much at once, leading to half-baked solutions  
- **Context Loss** - They struggle to maintain focus across long conversations
- **Inconsistency** - The same prompt can yield wildly different results based on minor variations
- **Missing Prerequisites** - They often start implementing before gathering necessary context

Traditional approaches try to solve these through better prompting or more powerful models. WorkRail takes a different approach.

## 💡 The Solution

WorkRail guides LLMs through **proven software engineering best practices** via structured workflows, making it much more difficult for the LLM to go off track.

Instead of hoping an LLM will follow best practices, this system **guides them toward** best practices through structured, machine-readable workflows.

**Traditional Approach:**
```
User: "Help me implement this feature"
AI: [May or may not ask for context, may or may not plan, may or may not test]
```

**WorkRail Approach:**
```
Workflow guides: Context → Clarification → Planning → Implementation → Verification  
AI: [Cannot skip steps, must follow proven patterns]
```

This creates an enhanced experience where developers are guided through optimal workflows, missing fewer critical steps, while LLMs work within their strengths following proven patterns.

---

## 🛠️ MCP Tools

WorkRail exposes 6 core tools through the Model Context Protocol:

- **`workflow_list`** - Browse available workflows for different task types
- **`workflow_get`** - Get complete workflow details and requirements  
- **`workflow_next`** - Get the next step in an active workflow
- **`workflow_validate`** - Validate step outputs against quality criteria
- **`workflow_validate_json`** - Validate and lint workflow JSON files
- **`workflow_get_schema`** - Get the complete workflow JSON schema for workflow creation

---

## ⚙️ Installation

Add WorkRail to your AI agent by configuring the MCP server:

### NPX (Recommended)
Add to your agent's `config.json`:
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

### Docker
Add to your agent's `config.json`:
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

## 🌐 External Workflows: Load from Git Repositories

**NEW in v0.6+**: Load workflows from GitHub, GitLab, Bitbucket, or any Git repository!

Perfect for:
- **Team sharing** - Company-wide workflow repositories
- **Community workflows** - Shared across organizations
- **Version control** - Track workflow changes in Git
- **Multi-source** - Combine workflows from multiple repos

### Quick Start

Add to your agent config:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "env": {
        "WORKFLOW_GIT_REPOS": "https://github.com/your-org/workflows.git",
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

### Multiple Repositories

Load workflows from multiple sources (later repos override earlier ones):

```json
"env": {
  "WORKFLOW_GIT_REPOS": "https://github.com/company/workflows.git,https://gitlab.com/team/workflows.git",
  "GITHUB_TOKEN": "ghp_xxx",
  "GITLAB_TOKEN": "glpat_xxx"
}
```

### Authentication Options

**Service-Specific Tokens** (Recommended):
```bash
GITHUB_TOKEN=ghp_xxxx           # For github.com
GITLAB_TOKEN=glpat_xxxx          # For gitlab.com
BITBUCKET_TOKEN=xxx              # For bitbucket.org
```

**Self-Hosted Git** (hostname-based):
```bash
GIT_COMPANY_COM_TOKEN=xxx        # For git.company.com
GIT_INTERNAL_GITLAB_IO_TOKEN=xxx # For internal.gitlab.io
```

**SSH Keys** (no token needed):
```bash
WORKFLOW_GIT_REPOS="git@github.com:company/workflows.git"
# Uses your ~/.ssh/ keys automatically
```

**Generic Fallback**:
```bash
GIT_TOKEN=xxx                    # Used if no specific token found
WORKFLOW_GIT_AUTH_TOKEN=xxx      # Alternative generic token
```

### Repository Structure

Your Git repository should have a `/workflows` directory:

```
your-repo/
├── workflows/
│   ├── custom-workflow.json
│   ├── team-process.json
│   └── company-standard.json
└── README.md (optional)
```

### Features

- ✅ **Auto-sync** - Workflows update automatically (configurable interval)
- ✅ **Caching** - Works offline after initial clone
- ✅ **Security** - Path traversal prevention, file size limits, command injection protection
- ✅ **Priority system** - Later repos override earlier ones
- ✅ **Branch support** - Specify branch in repo config

---

## 💾 Using Local Workflows

WorkRail will auto-discover workflows even when added to your agent via JSON config. It searches, in priority order:

- User: `~/.workrail/workflows` (recommended)
- Project: `./workflows` relative to the MCP process `cwd`
- Custom: directories listed in `WORKFLOW_STORAGE_PATH` (colon-separated on macOS/Linux)

Example agent config passing env and `cwd` so your local workflows are picked up:

```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"],
      "env": {
        "WORKFLOW_STORAGE_PATH": "/absolute/path/my-workflows:/absolute/path/shared-workflows"
      },
      "cwd": "/absolute/path/my-project"
    }
  }
}
```

WorkRail searches for workflows in this priority order:

1. **Bundled** - Built-in workflows (always available)
2. **User** - `~/.workrail/workflows` (recommended for personal workflows)
3. **Custom** - Directories in `WORKFLOW_STORAGE_PATH` (team/shared workflows)
4. **Git Repositories** - External repos via `WORKFLOW_GIT_REPOS` ([see above](#-external-workflows-load-from-git-repositories))
5. **Project** - `./workflows` relative to process `cwd` (project-specific)

Later sources override earlier ones when workflow IDs conflict.

### Quick Tips

```bash
# Initialize your user directory
workrail init

# Validate a workflow file
workrail validate /path/to/workflow.json

# List all discovered workflows
workrail list

# Get workflow JSON schema
workrail schema
```

See `docs/workflow-management.md` for more details.

---

## 📋 Available Workflows

WorkRail comes with battle-tested workflows for common development tasks:

### 🔧 **Development Workflows**
- **`coding-task-workflow-with-loops`** - Enhanced coding workflow with iterative refinement loops, analysis, planning, implementation, and review *(Recommended)*
- **`systematic-bug-investigation-with-loops`** - Enhanced debugging with iterative analysis loops and systematic methodology *(Recommended)*

#### Deprecated Workflows
- ~~**`coding-task-workflow`** - [DEPRECATED] Use `coding-task-workflow-with-loops` instead~~
- ~~**`systematic-bug-investigation`** - [DEPRECATED] Use `systematic-bug-investigation-with-loops` instead~~

### 🚀 **Project Management**  
- **`adaptive-ticket-creation`** - Create well-structured tickets with proper requirements
- **`mr-review-workflow`** - Thorough merge request review process

### 📚 **Content & Documentation**
- **`document-creation-workflow`** - Structured approach to creating comprehensive documentation
- **`presentation-creation`** - Build engaging presentations with clear narrative flow
- **`personal-learning-course-design`** - Design educational content with learning objectives
- **`personal-learning-materials-creation-branched`** - Create comprehensive learning materials with adaptive complexity

### 🔍 **Discovery & Analysis**
- **`exploration-workflow`** - Systematic codebase or domain exploration
- **`workflow-for-workflows`** - Meta-workflow for designing new workflows

---

## 🔄 Loop Support

WorkRail supports powerful iteration patterns for complex tasks:

- **`while`** - Continue while a condition is true
- **`until`** - Continue until a condition is met  
- **`for`** - Execute a fixed number of times
- **`forEach`** - Process items in an array

Perfect for batch operations, retries, polling, and iterative refinement.

### 🚀 v0.2.0: Optimized Loop Execution

- **60-80% smaller context** after first iteration
- **Progressive disclosure** pattern for loop information
- **Native function DSL** to reduce duplication
- **Automatic empty loop detection** and skipping

See [Loop Optimization Guide](docs/features/loop-optimization.md) for details.

---

## 📖 Quick Example

Here's what a workflow step looks like:

```json
{
  "id": "analyze-codebase",
  "name": "Deep Codebase Analysis",
  "description": "Understand the codebase structure before making changes",
  "agentRole": "You are a senior engineer performing careful code analysis",
  "runCondition": {
    "type": "context",
    "key": "taskComplexity", 
    "operator": "in",
    "values": ["Medium", "Large"]
  },
  "validationCriteria": {
    "outputLength": {"min": 200, "max": 2000},
    "mustContain": ["file structure", "key components", "dependencies"]
  }
}
```

The agent receives structured guidance on **what to do**, **how to do it**, and **quality standards to meet**.

---

## 🌟 Why Choose WorkRail?

### Consistency & Reproducibility  
One of the biggest challenges with AI-assisted development is inconsistency. The same request can yield wildly different approaches depending on how the prompt is phrased, the LLM's randomness, or the developer's prompting expertise.

WorkRail reduces these variables:
- **Same Process** - Every developer follows the same workflow
- **Same Quality** - Helps junior developers produce work closer to senior-level quality  
- **Same Standards** - Code style and patterns are guided by workflows
- **Audit Trail** - Every decision is logged and reviewable

| Without WorkRail | With WorkRail |
|------------------|---------------|
| "Just fix this bug" → agent makes random changes | Systematic investigation → evidence-based diagnosis → targeted fix |
| "Add a feature" → incomplete implementation | Analysis → planning → implementation → testing → review |
| Inconsistent quality across tasks | Repeatable, high-quality processes |
| Outcome depends on prompting skills | Guided best practices regardless of experience |

---

## 🚀 Getting Started

1. **Install** WorkRail as an MCP server (see installation above)
2. **Browse workflows** - Use `workflow_list` to see available options
3. **Start a workflow** - Use `workflow_get` to load a workflow for your task  
4. **Follow the steps** - Use `workflow_next` to get guided, step-by-step instructions
5. **Validate progress** - Use `workflow_validate` to ensure quality at each step

---

## 🌟 Environment Variables Reference

Customize WorkRail's behavior with these environment variables:

### Workflow Sources
```bash
WORKFLOW_INCLUDE_BUNDLED=true   # Include built-in workflows (default: true)
WORKFLOW_INCLUDE_USER=true      # Include ~/.workrail/workflows (default: true)
WORKFLOW_INCLUDE_PROJECT=true   # Include ./workflows from cwd (default: true)
WORKFLOW_STORAGE_PATH=/path1:/path2  # Additional directories (colon-separated)
```

### External Git Repositories
```bash
# Single or multiple repos (comma-separated)
WORKFLOW_GIT_REPOS=https://github.com/org/repo.git
WORKFLOW_GIT_REPOS=repo1.git,repo2.git,repo3.git

# Authentication
GITHUB_TOKEN=ghp_xxx            # GitHub
GITLAB_TOKEN=glpat_xxx          # GitLab  
BITBUCKET_TOKEN=xxx             # Bitbucket
GIT_HOSTNAME_TOKEN=xxx          # Self-hosted (replace dots with underscores)
GIT_TOKEN=xxx                   # Generic fallback
```

### Cache & Performance
```bash
WORKRAIL_CACHE_DIR=/path/to/cache  # Cache location (default: ~/.workrail/cache)
CACHE_TTL=300000                    # Cache TTL in ms (default: 5 minutes)
```

### Debugging & Logging
```bash
# Log levels: DEBUG, INFO, WARN, ERROR, SILENT (default: SILENT)
WORKRAIL_LOG_LEVEL=INFO

# Log format: 'human' (default) or 'json'
WORKRAIL_LOG_FORMAT=json
```

**Log Levels:**
- `DEBUG` - Verbose logging (cloning, pulling, file operations)
- `INFO` - Key operations (initialization, workflows loaded)
- `WARN` - Warnings (branch fallbacks, pull failures)
- `ERROR` - Errors only
- `SILENT` - No logging (default in production)

**Example MCP Configuration with Logging:**
```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail@beta"],
      "env": {
        "WORKRAIL_LOG_LEVEL": "INFO",
        "WORKFLOW_GIT_REPOS": "https://github.com/org/workflows.git"
      }
    }
  }
}
```

Logs are written to **stderr** (stdout is reserved for MCP protocol), so they appear in your MCP client's logs (e.g., Firebender, Claude Desktop).

### Priority Order

Workflows are loaded with this priority (later sources override earlier):
1. Bundled (built-in workflows)
2. Plugins (npm packages)
3. User directory (`~/.workrail/workflows`)
4. Custom paths (`WORKFLOW_STORAGE_PATH`)
5. Git repositories (`WORKFLOW_GIT_REPOS`)
6. Project directory (`./workflows`)

---

## 🚀 Planned Features

WorkRail is actively evolving. Here are key enhancements on the roadmap:

### **Workflow State Management**
- **Save & Resume** - Generate workflow state summaries for resuming complex workflows in new chat sessions
- **Context Preservation** - Maintain workflow progress across conversation boundaries
- **Checkpoint System** - Save progress at key milestones for easy recovery

### **Model Switching Guidance**
Workflows could recommend optimal models for specific steps:
- **Analysis steps** → Tool-use heavy models (Claude) for codebase exploration
- **Planning/design** → Smartest available models for strategic thinking  
- **Implementation** → Cost-effective models once requirements are clear

*Note: WorkRail provides text recommendations to users, not automatic model switching*

### **Enhanced Workflow Management**
- ✅ ~~**Dynamic Workflow Loading**~~ - **IMPLEMENTED in v0.6+** (Git repositories)
- **Workflow Categories** - Organize workflows by domain (debugging, planning, review, etc.)
- **Reusable Components** - Plugin system for common workflow patterns (codebase analysis, document creation, etc.)
- **Schema Versioning** - Backwards-compatible workflow schema evolution
- **Workflow Templates** - Create workflows from templates via CLI

### **Advanced Validation & Quality**
- **Custom Validation Functions** - Domain-specific output validation beyond basic schema checks
- **Integration Hooks** - Connect with external quality tools and linters
- **Performance Validation** - Ensure workflow outputs meet performance criteria
- **Length Validation Optimization** - Faster validation using terminal commands vs. full content rewrite

### **Workflow Discovery & Intelligence**
- **Smart Workflow Suggestions** - Recommend workflows based on task context
- **Pattern Recognition** - Identify when existing codebase patterns should inform workflow steps

---
*Have ideas for WorkRail? The planned features list helps guide development priorities.*

---

## 📚 Learn More

- **[Complete Overview](workrail-mcp-overview.md)** - Deep dive into architecture, philosophy, and detailed examples
- **[Loop Documentation](docs/features/loops.md)** - Advanced iteration patterns  
- **[API Specification](spec/mcp-api-v1.0.md)** - Complete MCP API reference
- **[Internal Documentation](docs/README.md)** - Development and architecture guides

---

## 📄 License

MIT License - see [LICENSE](LICENSE)