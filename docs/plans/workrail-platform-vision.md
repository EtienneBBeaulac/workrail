# WorkRail Platform Vision: From Engine to Ecosystem

## Problem statement

WorkRail is a powerful workflow execution engine. But getting workflows into users' hands -- discovering, installing, sharing, configuring -- is harder than it should be. The engine works well once running; everything around it creates friction.

This matters because WorkRail's value scales with adoption. A workflow that only runs on the author's machine is a personal tool. A workflow that any agent on any team can discover and run is infrastructure. The gap between those two is the problem this document addresses.

## Personas

### Solo developer

Works alone or on a small project. Wants structured agent execution for recurring tasks (code review, feature implementation, bug triage). Doesn't want to learn a new system -- just wants the agent to be better.

- **Entry point**: installs workrail, uses bundled workflows
- **Progression**: tweaks a workflow prompt, eventually authors their own
- **Pain today**: setup is manual, no guidance, has to understand the internals

### Team member

Part of a team sharing a repo. The team has conventions and patterns they want agents to follow consistently. Wants to use team workflows without thinking about it.

- **Entry point**: clones a repo, team workflows should just be there
- **Progression**: contributes improvements to team workflows
- **Pain today**: has to manually install workflows, references break across machines, no project-level discovery

### Platform/infrastructure team

Maintains shared patterns that other teams should follow (contribution models, API design, deployment). Wants to distribute workflows that encode "how to do X correctly" so that consuming teams get it right without tribal knowledge.

- **Entry point**: authors workflows with embedded references (schemas, guides, patterns)
- **Progression**: maintains and versions workflows that other teams consume
- **Pain today**: workspace references break outside the source repo, no distribution mechanism, no way to update consumers

### Open source author

Ships a library or framework. Wants to include a workflow that helps users integrate it correctly. The workflow should work for anyone who installs the package, regardless of their setup.

- **Entry point**: includes a workflow in their package
- **Progression**: maintains the workflow alongside the code
- **Pain today**: no portable packaging, no reference portability, no install mechanism

### Non-developer

Works in content, ops, data, product. Heard that agents can follow structured workflows. Wants to encode a process (incident response, content review, data pipeline check) without writing JSON.

- **Entry point**: describes what they want, agent creates the workflow
- **Progression**: tweaks the workflow through conversation, not code
- **Pain today**: would bounce immediately. JSON authoring is a hard wall.

## Progressive complexity model

Users should be able to use WorkRail at any level without understanding the levels above.

### Level 0: Use bundled workflows

- Install workrail. Bundled workflows are available immediately.
- Pick one, run it. No authoring, no configuration.
- **Requirement**: zero-config start. Works out of the box.

### Level 1: Install a shared workflow

- Someone gives you a workflow (file, URL, package name).
- One action to install. Setup prompt handles it.
- **Requirement**: single-step install. Agent-assisted. No manual file management.

### Level 2: Customize an existing workflow

- Fork a workflow and modify it for your needs.
- Edit prompts, add steps, change confirmation gates.
- Could be JSON editing, markdown editing, or conversational ("make Phase 3 more thorough").
- **Requirement**: multiple authoring surfaces. JSON is not the only option.

### Level 3: Author a new workflow

- Create a workflow from scratch for a recurring task.
- Full access to all features (loops, fragments, references, delegation).
- Use the wr.workflow-for-workflows or author manually.
- **Requirement**: strong authoring spec, good examples, validation tooling.

### Level 4: Distribute workflows

- Package a workflow with its references and companion files.
- Share within a team (repo-local), across teams (multi-repo), or publicly (published package).
- **Requirement**: portable reference resolution, directory-based packaging, optional registry.

## Discovery architecture

Workflow discovery must be layered, automatic, and work without per-project configuration.

### Discovery layers (in resolution order)

| Layer | Source | When it applies | Setup required |
|-------|--------|----------------|----------------|
| Bundled | Shipped with the workrail package | Always | None |
| User-installed | `~/.workrail/workflows/` | Always | Place files or use setup prompt |
| Project-local | `.workrail/workflows/` in any ancestor directory of configured roots | When roots are configured | One-time: add root to config |
| Module-local | `.workrail/workflows/` in subdirectories of configured roots | When roots are configured | None (auto-discovered within roots) |

### Multi-root configuration

A single MCP server instance serves workflows from multiple workspace roots. Roots are configured in `~/.workrail/config.json`:

```json
{
  "workspaceRoots": [
    "~/git/work/monorepo",
    "~/git/personal/workrail",
    "~/git/oss/my-library"
  ]
}
```

The server scans all roots at startup. Within each root, it recursively discovers `.workrail/workflows/` directories at any depth.

Adding a root is a one-time operation, handled by the setup prompt. Removing a root removes its workflows from discovery.

### Grouped listing

`list_workflows` returns workflows grouped by source, not as a flat list:

```
Available Workflows:

## WorkRail Built-in
- coding-task-agentic: Lean Coding Task
- wr.workflow-for-workflows: Workflow Authoring

## monorepo (repo-level)
- ci-release: CI Release Flow

## Payments (monorepo/features/payments)
- payment-integration: Payment Integration
- payment-api-review: Payment API Review

## Platform (monorepo/platform)
- platform-contribution: Platform Contribution Guide
```

Groups are named from a `.workrail/config.json` in the module directory if present, falling back to the directory name.

### ID disambiguation

If two workflows share the same ID across groups, `start_workflow` accepts either:
- The bare ID (if unique across all groups)
- A qualified ID: `group/workflow-id` (if ambiguous)

The agent handles disambiguation conversationally when needed.

## Sharing model

### Same repo (team sharing)

Convention-based. Place workflows in `.workrail/workflows/` in the repo or module. Teammates clone the repo, add the root to their config (once), and all workflows are discovered.

```
my-repo/
  .workrail/
    workflows/
      team-code-review.json
      team-feature-impl.json
```

No install step. No sync. Git handles versioning, review, and distribution.

### Cross-repo (org sharing)

Multi-root config. Each repo is a root. Workflows from all repos are available in a single `list_workflows` call.

For workflows that reference files (schemas, guides), use `resolveFrom: workflow` so references resolve relative to the workflow file's location. The workflow and its references are a self-contained directory.

```
shared-workflows-repo/
  contribution/
    .workrail/
      workflows/
        platform-contribution.json
      refs/
        contribution-schema.json
        patterns-guide.md
```

Clone the repo, add it as a root, done.

### Public sharing

A workflow directory is the unit of distribution:

```
my-workflow/
  workflow.json
  refs/
    schema.json
    guide.md
  README.md
```

Distribution mechanisms (any of these work):
- Git repository (clone or submodule)
- npm package
- Tarball / zip
- Direct file sharing (for single-file workflows with no references)

The setup prompt handles installation: "Install this workflow from [URL/path]" -- the agent downloads, places it in `~/.workrail/workflows/`, and verifies references resolve.

## Reference evolution

### Current state

References are pointers to files. The engine resolves paths and tells the agent where to look. The agent reads the files with its own tools. Two resolution bases: `workspace` (user's project) and `package` (workrail's own files).

### Problems

1. `workspace` references break outside the source repo (not portable)
2. `package` references use brittle path arithmetic (`__dirname` + `../../../`)
3. No way to deliver reference content at the right time (all-at-once on start)
4. No way to co-locate references with a workflow for sharing

### Evolution

#### Add `resolveFrom: "workflow"`

Resolves paths relative to the workflow file's location on disk. This is the portability primitive: a workflow directory with co-located references works anywhere.

```json
{
  "id": "api-schema",
  "source": "refs/api-schema.json",
  "resolveFrom": "workflow"
}
```

As long as the `refs/` directory travels with the workflow file, the reference resolves.

#### Add step-level attachments

A step declares which references it needs. The engine reads the file and includes the content in the tool response. The agent doesn't make a separate `read_file` call.

```json
{
  "id": "implement-api",
  "title": "Implement the API endpoint",
  "attachments": ["api-schema"],
  "prompt": "Implement the endpoint according to the attached schema."
}
```

Content is delivered just-in-time. Phase 0 gets the overview doc. Phase 3 gets the schema. Context is fresh at the point of use.

#### Safety limits

- Size cap per attachment (default 32KB, configurable per reference)
- Total attachment budget per step (default 64KB)
- Oversized references fall back to pointer-only with a note: "Reference 'X' is too large to attach. Read it with your file tools at: [path]"

#### MCP resources for bundled content

Package-bundled references (schema, authoring spec, setup guide) are also exposed as MCP resources. Agents and clients that support resources can discover and read them without a workflow context.

## Authoring surface evolution

### Now: JSON + agent-assisted

JSON remains the engine format. The wr.workflow-for-workflows helps authors create workflows through structured agent guidance. The authoring spec and schema define correctness.

### Next: Markdown authoring

A simpler format for Level 2 users who want to tweak workflows without deep JSON knowledge:

```markdown
# Code Review Workflow

## Step 1: Understand the changes
Read the PR description and the changed files. Summarize what was changed and why.

## Step 2: Review for correctness
Check each file for bugs, edge cases, and missing error handling.

> [!confirm]
> Confirm findings with the user before proceeding.

## Step 3: Write review comments
Post your findings as PR review comments.
```

A compiler converts this to JSON. The markdown format supports a subset of features (steps, prompts, confirmation gates). Advanced features (loops, fragments, conditions) require JSON.

### Later: Visual editing

A web UI for workflow authoring. Drag-and-drop steps, visual loop configuration, prompt editing with preview. Outputs JSON. This is the Level 2 experience for non-developers.

The console surface (`console/`) is the natural home for this.

## MCP primitive usage

WorkRail currently uses only MCP tools. The full MCP spec offers three primitives, each suited to different interactions.

### Tools (agent-controlled actions)

Keep for execution:
- `start_workflow` -- create session, begin execution
- `continue_workflow` -- advance or rehydrate
- `checkpoint_workflow` -- record progress

Keep for queries that benefit from agent timing:
- `list_workflows` -- discovery (also useful as a resource, see below)
- `inspect_workflow` -- detailed workflow view

### Resources (discoverable content)

Add for content that should be discoverable without a tool call:
- `workrail://spec/workflow-schema` -- JSON schema
- `workrail://spec/authoring-spec` -- authoring guidance
- `workrail://docs/setup-guide` -- setup and configuration guide
- `workrail://workflows/{id}` -- workflow metadata (mirrors inspect_workflow)

Resources complement tools. Clients that support resources get richer discoverability. Clients that only support tools use the existing tool surface. No degradation.

### Prompts (user-triggered interactions)

Add for user-initiated actions that don't need full workflow execution:
- `/setup-workrail` -- first-time setup, add repos, configure preferences
- `/start {workflow}` -- user-friendly workflow start (wraps start_workflow)
- `/help-authoring` -- guidance for writing workflows

Prompts surface in client UIs as slash commands or menu items. They lower the barrier for users who don't know the tool names.

### Backward compatibility

All three primitives are additive. The existing tool surface continues to work unchanged. Resources and prompts are available to clients that support them and invisible to clients that don't.

## Agent-driven setup

Setup and configuration are handled by an MCP prompt backed by a setup guide resource.

### The setup guide

A concise reference document (`docs/setup-guide.md`) shipped with the package and exposed as an MCP resource. Covers:

- WorkRail directory structure and conventions
- How to add a workspace root
- How to install a shared workflow
- How to configure preferences
- How to verify the setup
- Troubleshooting common issues

### The setup prompt

```
/setup-workrail
```

When triggered:
1. Server returns the setup guide content as context
2. Agent reads the user's intent conversationally
3. Agent performs the setup (file operations, config updates, validation)
4. Agent verifies with `list_workflows` and reports what's available

Handles all setup scenarios:
- "Set up workrail for my monorepo"
- "I got this workflow from a teammate" (pastes JSON)
- "Add my other repo to workrail"
- "Change my default preferences"
- "Show me what's available"

### Why not a workflow for setup?

A workflow adds session overhead (tokens, checkpoints, event log) for a task that takes 2 minutes. The setup interaction is stateless and conversational. An MCP prompt with a reference doc is the right weight.

## Phased delivery

### Now (no engine changes)

1. **Write the setup guide** (`docs/setup-guide.md`)
2. **Add multi-root config** support to `~/.workrail/config.json`
3. **Recursive module discovery** within configured roots
4. **Grouped `list_workflows` output** with source tagging

### Next (small engine changes)

5. **`resolveFrom: workflow`** for portable co-located references
6. **MCP resources** for bundled docs (schema, authoring spec, setup guide)
7. **MCP prompt** for `/setup-workrail`
8. **Module-level `.workrail/config.json`** for group naming

### Later (medium engine changes)

9. **Step-level attachments** for timed content delivery
10. **Markdown authoring format** with compiler to JSON
11. **MCP prompt** for `/start {workflow}`
12. **`workrail install` CLI** for one-command workflow installation

### Future (larger scope)

13. **Workflow overlay/extension** system (customize without forking)
14. **Visual authoring** in the console UI
15. **Published workflow packages** (npm or dedicated registry)
16. **Content pinning** at compile time for fully self-contained workflows

## Design constraints

- **Backward compatible**: every change is additive. Existing workflows, tools, and configs continue to work.
- **Client-agnostic**: works with any MCP client. Features that depend on resources/prompts degrade gracefully to tools-only.
- **Convention over configuration**: sensible defaults, auto-discovery, minimal required config.
- **Agent-first setup**: the agent handles infrastructure work. The user makes decisions, not file operations.
- **Progressive disclosure**: Level 0 users never see Level 4 complexity. Each level is self-contained.

## Open questions

1. **Workflow ID namespacing**: should IDs be globally unique, or scoped to their group? Global uniqueness is simpler but constraining. Group-scoped requires qualified IDs for disambiguation.

2. **Config file location**: `~/.workrail/config.json` is user-global. Should there also be a project-level config (`.workrail/config.json` at repo root) for team-shared settings like group names?

3. **Markdown authoring scope**: how much of the JSON feature set should markdown support? Enough for Level 2 (steps, prompts, confirmations) or more (loops, conditions, fragments)?

4. **Reference content delivery format**: when step-level attachments deliver content, how should it be framed? Inline in the prompt? Separate content section? Depends on content type (markdown vs JSON vs code)?

5. **Overlay/extension design**: what's the minimum safe override surface for derived workflows? References only? References + metaGuidance? Step-level patches?

6. **Update semantics**: when a shared workflow is updated upstream, how does the consumer know? Pull-based (check on start)? Notification? Manual?
