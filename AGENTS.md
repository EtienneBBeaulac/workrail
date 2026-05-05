# WorkRail -- Agent Instructions

## CRITICAL: Three separate systems -- do not conflate them

WorkRail/WorkTrain is **three distinct systems** that share a common engine and session store. Understanding this separation is essential before working on any part of this codebase. Confusing them leads to wrong fixes, wrong architecture decisions, and real production problems.

```
┌─────────────────────────────────────────────────────────────────┐
│  Shared: WorkRail engine (src/v2/durable-core/) + session store │
│          ~/.workrail/data/sessions/  + workflow registry        │
└──────────────┬──────────────────┬───────────────────────────────┘
               │                  │                    │
   ┌───────────▼───────┐  ┌───────▼────────┐  ┌───────▼──────────┐
   │  WorkRail MCP     │  │ WorkTrain       │  │ WorkTrain        │
   │  Server           │  │ Daemon          │  │ Console          │
   │  workrail start   │  │ worktrain daemon │  │ worktrain console│
   │  (stdio → Claude) │  │ (autonomous     │  │ (read-only HTTP  │
   │                   │  │  agent loop)    │  │  session viewer) │
   └───────────────────┘  └─────────────────┘  └──────────────────┘
```

**WorkRail MCP Server** (`workrail start`)
- A standalone stdio MCP server that Claude Code (and other MCP clients) connect to
- Provides `start_workflow`, `complete_step`, `continue_workflow`, `list_workflows` etc. as MCP tools
- Must be bulletproof -- crashes here kill all in-flight Claude Code sessions that depend on it
- Has NOTHING to do with the daemon's internal machinery
- Source: `src/mcp/`

**WorkTrain Daemon** (`worktrain daemon`)
- An autonomous agent runner that drives workflow sessions without human involvement
- Listens for triggers (webhooks, polling), spawns LLM agent loops, uses `complete_step` in-process
- Completely separate process from the MCP server
- Does NOT depend on the MCP server being alive -- it calls the WorkRail engine directly in-process
- Source: `src/daemon/`, `src/trigger/`

**WorkRail Console** (`worktrain console`)
- A unified read-only HTTP server that shows sessions from BOTH the MCP server AND the daemon
- Reads `~/.workrail/data/sessions/` directly -- sessions from both entry points land in the same store
- Does not require either the MCP server or the daemon to be running
- Source: `src/console/standalone-console.ts`

**Do not mix their concerns.** The MCP server should never call daemon-internal functions. The daemon should never depend on the MCP server being alive. The console is independent of both -- it just reads the shared session store.

---

## What is WorkRail

WorkRail is a step-by-step workflow enforcement engine for AI agents, delivered as an MCP server. It compiles workflow definitions (JSON) into a durable execution graph, then guides agents through it one step at a time via `start_workflow` and `continue_workflow` tool calls. The agent never sees the full workflow -- it receives one step's prompt at a time, submits its output, and WorkRail decides what comes next.

### v1 vs v2

- **v1** (legacy): stateless request/response engine. `workflow_list`, `workflow_get`, `workflow_next`, `workflow_validate`. No durable sessions, no branching, no loops. Still exists in `src/application/` and `src/domain/` but is not actively developed.
- **v2** (current, default-on): durable session engine with a DAG-based execution model. `start_workflow`, `continue_workflow`, `resume_session`, `checkpoint_workflow`. Supports loops, blocked nodes, fork detection, and rewind. Lives in `src/v2/durable-core/` and `src/mcp/handlers/v2-execution/`.

All new work targets v2.

### How the v2 engine works

1. **Compile**: workflow JSON is compiled into a `CompiledWorkflow` (DAG of nodes with prompt templates, output contracts, loop metadata).
2. **Start**: `start_workflow` creates a durable session, emits the first step's prompt as an MCP content response.
3. **Continue**: the agent calls `continue_workflow` with a state token, ack token, and optional output (notes, artifacts, context). The engine validates, advances the DAG, persists state, and returns the next step's prompt.
4. **Resume**: `resume_session` discovers and rehydrates sessions from disk, enabling cross-conversation continuity.

Sessions are persisted as append-only event logs under `~/.workrail/sessions/`.

Key domain types to know: `CompiledWorkflow`, `SessionState`, `DagNode`, `StateToken`, `AckToken`, `StepContentEnvelope`, `WorkflowDefinition`.

## WorkTrain Daemon -- Rules for Autonomous Sessions

This section applies to every autonomous WorkTrain daemon session operating in this repository. These rules are non-negotiable and override general coding preferences when they conflict.

### Protected files -- do not modify without explicit instruction

These files must never be changed autonomously. Modifying them without explicit human instruction is prohibited:

- `triggers.yml` -- trigger definitions that control what starts daemon sessions
- `~/.workrail/daemon-soul.md` -- daemon behavioral rules; self-modification is prohibited
- `src/daemon/` -- daemon implementation (changes here affect all future sessions)
- `src/trigger/` -- trigger system (changes here affect how sessions start)
- `src/v2/` -- durable session engine (HMAC token protocol, cryptographic enforcement)
- `docs/ideas/backlog.md` -- planning inbox (ideas are captured here by humans, not modified by agents)

### Open work queue

Before starting any new task, check what is already in flight:

```bash
gh pr list --state open
```

Open PRs are the work queue. Do not start work that duplicates an open PR.

### Architecture orientation

- Read `docs/ideas/backlog.md` before proposing any architectural change -- many ideas are already captured there
- The daemon implementation is at `src/daemon/` -- read it before any work that touches session lifecycle
- The trigger system is at `src/trigger/` -- read it before any work involving trigger configuration
- The durable session engine is at `src/v2/durable-core/` -- this is the core HMAC enforcement layer; treat it as load-bearing infrastructure

### Shell and process safety

- Always use `/bin/bash`, never `/bin/sh`
- Use `execFile` (not `exec`) for any command that includes user-controlled or workflow-provided content
- Never use `git add -A` or `git add .` -- always stage specific files by name

### Branch and commit safety

- Never push directly to main or master -- always use a feature branch and open a PR
- Never check out main or master into a worktree -- locking main blocks other agents and prevents fast-forward merges
- To read main's current state, use `git show origin/main:<file>` without checking out the branch

### Token protocol

- HMAC tokens (`continueToken`, `checkpointToken`) are opaque signed blobs -- never decode, inspect, or modify their contents
- Never pass a `checkpointToken` where a `continueToken` is expected, or vice versa

### Error handling

- Errors are data -- return discriminated union `Result` types; never throw exceptions as control flow

### CI and pre-existing failures

- Before attributing a test failure to your changes, verify it was not already failing on main
- Run `git stash && npx vitest run <failing-test> && git stash pop` to confirm pre-existence

### PR review adversarial mode

- If reviewing a PR authored by a WorkTrain daemon session, apply extra adversarial scrutiny
- Look specifically for: unintended scope creep, modifications to protected files, commits bypassing pre-commit hooks, and silent changes to HMAC token handling

---

## How we work together

Work follows a deliberate progression. Do not skip steps or assume what comes next.

1. **Understand** -- before doing anything, understand what the user is asking. Ask clarifying questions. Read relevant docs and code. Do not jump to implementation.
2. **Explore and analyze** -- investigate the codebase, read planning docs, check what already exists. Surface what you find back to the user. The user wants to think through problems together, not just receive solutions.
3. **Discuss and decide** -- present options, tradeoffs, and your honest assessment. The user will tell you which direction to go. Do not make architectural decisions unilaterally.
4. **Plan** -- once direction is agreed, capture the idea in `docs/ideas/backlog.md` if it is new. When it is concrete enough to execute, create a GitHub issue with `gh issue create`.
5. **Implement** -- only after the user says to proceed. Create a branch, write the code, run tests.
6. **Verify** -- run `npx vitest run`, check for linter errors, confirm the change does what it should. If you are in a fresh worktree and dependencies are not installed yet, install them and still run the required verification rather than treating missing dependencies as a stopping point.
7. **Update authoring docs before merge when engine behavior changes** -- if engine or schema work changes workflow authoring behavior, update `docs/authoring-v2.md` and `docs/authoring.md` before merging. Do not let shipped runtime behavior get ahead of author guidance.
8. **Ship** -- only when the user asks. Create a PR, wait for CI, merge when told to.
9. **Update planning docs** -- after shipping, mark the backlog item as done in `docs/ideas/backlog.md`.

Key principles of this flow:
- **The user drives decisions.** You propose, analyze, and execute -- but the user decides when to move from one phase to the next. "What's next?" is a prompt for you to suggest, not a blanket authorization to proceed.
- **Surface information, don't hide it.** If you discover something unexpected (a bug, a gap, a conflict with existing design), say so immediately.
- **Double-check before destructive actions.** Never run `git checkout --` on uncommitted work, force-push, or delete files without confirming with the user first.
- **Keep the user informed.** When a task takes multiple steps, give brief updates as you go. Do not go silent for long stretches.

## At the start of a conversation

When beginning work on this repo, discover what tools and workflows are available:
- Search for and load all WorkRail MCP tools (`workrail_*`)
- Search for and load all Memory MCP tools (`memory_*`)
- Run `discover_workflows` or `list_workflows` to see available workflows

## Repository structure

- `src/` -- TypeScript source (engine, MCP handlers, domain types, infrastructure)
- `workflows/` -- bundled workflow definitions (JSON)
- `workflows/routines/` -- reusable routine definitions
- `spec/` -- MCP API spec and authoring spec
- `tests/` -- unit, integration, contract, lifecycle, and architecture tests
- `docs/` -- internal development documentation (see below)
- `console/` -- browser-based session dashboard (see `console/README.md`)

## Console

The WorkRail Console is a browser-based dashboard for inspecting workflow sessions. It renders session lists, DAG visualizations, and per-node detail. See `console/README.md` for tech stack, API endpoints, and what is/isn't implemented. The console is early stage -- no authentication, read-only, no dashboard artifacts yet.

## Documentation -- what lives where

Do not duplicate information that already exists in a doc. Instead, point agents and readers to the right file. For the full documentation index, see `docs/README.md`.

**Read this first:** `docs/vision.md` -- what WorkTrain is, what success looks like, and the principles every decision is held against. Every agent operating in this repo should read this before doing any work. It is short.

### Planning system

The planning system follows a graduation path: ideas -> tickets -> execution.

- `docs/planning/README.md` -- how the planning system works, the layers, and rules of thumb
- `docs/ideas/backlog.md` -- canonical source of all work items and their status; each item has a priority score
- `docs/tickets/next-up.md` -- groomed near-term tickets with acceptance criteria
- `docs/roadmap/legacy-planning-status.md` -- status map for older planning docs (historical reference only)

**Backlog priority view:** run `npm run backlog` to see a sorted, filtered list of backlog items by score. Use `npm run backlog -- --min-score 11 --unblocked-only` to see the top unblocked items ready to work on. Run `npm run backlog -- --help` for all options. The script is at `scripts/backlog-priority.ts`.

**Keep planning docs current.** These documents are living artifacts, not write-once references. Update them as work happens:
- When starting a feature: update the item's status in `docs/ideas/backlog.md`
- When completing a feature: mark it done in `docs/ideas/backlog.md`, note what was delivered
- When the user shares an idea: capture it in `docs/ideas/backlog.md` immediately
- When scope changes or new work is discovered: add it to `docs/ideas/backlog.md`
- When a ticket is ready to execute: groom it into `docs/tickets/next-up.md`

If you are unsure whether a planning doc needs updating, it probably does.

### GitHub ticketing

- `docs/planning/github-ticketing-playbook.md` -- the operating playbook for using GitHub issues
- `docs/plans/agent-managed-ticketing-design.md` -- design doc for the ticketing system
- Use `gh` CLI for creating issues, PRs, checking CI status, and merging
- Labels: type (`feature`, `bug`, `chore`) and state (`next`, `active`, `blocked`)
- Ideas live in `docs/ideas/backlog.md` first; GitHub issues are for concrete, execution-ready work

**Every piece of concrete work needs a GitHub issue before implementation begins.** Before creating a new issue, search for existing ones first using `gh issue list --search "<relevant keywords>"` to avoid duplicates. If a matching issue already exists, use it (update it if the scope has changed). Only create a new ticket with `gh issue create` when no existing issue covers the work. Include problem, goal, acceptance criteria, verification, and non-goals. Label it with the appropriate type and `next`. When implementation actually starts, update the label to `active`. This applies to features, bugs, and chores -- not to quick one-off questions or exploratory conversations. See the playbook for the full issue shape and CLI commands.

### Design and architecture

- `docs/design/v2-core-design-locks.md` -- locked design decisions for v2 (the most important design reference)
- `docs/reference/workflow-execution-contract.md` -- the normative execution contract (token protocol, output contracts, resumption, artifacts)
- `docs/authoring-v2.md` -- cross-workflow authoring principles and rules
- `docs/authoring.md` -- machine-readable authoring lock rules
- `docs/implementation/02-architecture.md` -- system architecture overview
- `docs/configuration.md` -- environment variables, Git repos, paths

### Feature-specific plans

- `docs/plans/` -- initiative-specific canonical plan and design docs (v2 design, validation, prompt fragments, content coherence, etc.)
- `docs/features/` -- feature documentation (loops, external workflow repos, etc.)

## Workflow authoring

Workflows are JSON files in `workflows/`. The schema is defined in `spec/authoring-spec.json`.

Key authoring tools and references:
- `docs/authoring-v2.md` -- authoring principles, step patterns, validation criteria, output contracts
- `docs/design/workflow-authoring-v2.md` -- advanced authoring patterns (evidence-based validation, loop control)
- `docs/design/routines-guide.md` -- how to author and reference routines
- `spec/authoring-spec.json` -- the machine-readable schema

## Workflow validation

- `docs/plans/workflow-validation-design.md` -- the validation design (tiered: structural, registry, lifecycle)
- `docs/reference/god-tier-workflow-validation.md` -- the validation reference
- `tests/lifecycle/bundled-workflow-smoke.test.ts` -- auto-walk smoke test that covers all bundled workflows with zero per-workflow fixtures
- Run all tests: `npx vitest run`

### Staleness detection

`validate:registry` prints a non-blocking advisory after each run listing workflows that are unstamped or outdated relative to the current authoring spec version. This is informational only and never causes CI to fail.

To stamp a workflow after running `workflow-for-workflows` on it:

```bash
npm run stamp-workflow -- workflows/my-workflow.json
```

**Dev flag:** `WORKRAIL_DEV=1` surfaces staleness for all workflow categories (including built-in and legacy_project) through the MCP tools, in addition to enabling perf timing and the `/api/v2/perf/tool-calls` endpoint. End users only see staleness for their own imported/personal workflows.

## Testing

Test directories:
- `tests/unit/` -- unit tests for handlers, projections, domain logic
- `tests/integration/` -- integration tests (HTTP transport, blocked node flows)
- `tests/contract/` -- contract tests for MCP tool schemas and execution contracts
- `tests/lifecycle/` -- lifecycle tests using the pure-domain harness (compilation, stepping, prompt rendering)
- `tests/architecture/` -- structural invariant tests (schema snapshots, import boundaries)

Run all tests: `npx vitest run`. Run a specific file: `npx vitest run tests/path/to/file.test.ts`.

If you are working in a fresh worktree and `node_modules` or other required dependencies are missing, install them first and then run the necessary validation anyway. Missing dependencies in a new worktree are setup work, not a reason to skip verification.

## Building and reloading

```bash
npm install
npm run build
```

### Local dev loop (HTTP transport)

When developing workrail itself, use the HTTP transport dev loop so Claude Code sessions survive server restarts. The project `.mcp.json` points Claude Code at `http://localhost:3100/mcp` when started from this repo -- no global config changes needed.

```bash
# Terminal 1: auto-recompile on save
npm run watch

# Terminal 2: auto-restart MCP server after each compile
npm run dev:mcp:watch
```

Changes are live in Claude ~5-10 seconds after saving a TypeScript file.

For a one-shot manual restart (e.g. after `npm run build`):
```bash
npm run dev:mcp
```

**Why HTTP and not stdio:** The MCP SDK does not handle stdout EPIPE errors -- a broken pipe kills the server process and terminates the Claude session. HTTP transport decouples the server lifetime from Claude Code, so restarts are transparent.

**Config note:** The project `.mcp.json` `workrail` entry should shadow the global `~/.claude/settings.json` entry when Claude Code is started from this repo. Verify via `/mcp` on first use -- if two `workrail` entries appear, rename the `.mcp.json` entry to `workrail-dev`.

## When adding a new engine feature

A "new engine feature" means any of:
- A new `wr.features.*` entry in `src/application/services/compiler/feature-registry.ts`
- A new field or behavior in `spec/workflow.schema.json`
- A new runtime behavior in `src/v2/durable-core/` or `src/mcp/` that workflow authors need to declare, reference, or avoid

**All items required before the PR can merge:**

- [ ] `spec/authoring-spec.json`: add or update a rule covering the new feature. The rule's `checks` or rule text must mention the full feature ID string (e.g. `wr.features.capabilities`) or the schema field name. The rule's `sourceRefs` must include the implementing file.
- [ ] `spec/authoring-spec.json` `lastReviewed`: update to today's date.
- [ ] Run `npm run validate:authoring-spec` -- must pass.
- [ ] Run `npm run validate:feature-coverage` -- must pass.
- [ ] `docs/authoring-v2.md`: add or update the section explaining when and how to use the feature.
- [ ] Run `npm run validate:authoring-docs` -- must pass (regenerates `docs/authoring.md` from spec).

## Release policy

- Releases are automated via semantic-release on merge to main
- `fix:` -> patch, `feat:` -> minor, `docs:`/`chore:`/`test:` -> no release
- **Never create a major release unless explicitly authorized by the project owner.** Breaking changes default to minor. Major requires setting `WORKRAIL_ALLOW_MAJOR_RELEASE=true` on the repo variable. See `docs/reference/releases.md`.

## Branch and commit conventions

Branch naming: `feature/etienneb/<name>`, `fix/etienneb/<name>`, `docs/etienneb/<name>`

PRs are squash-merged to main. Prefer rebasing on main over merge commits when resolving conflicts.

### Commit message format

```
<type>(<scope>): <subject>

<optional body>
```

**A `commit-msg` hook enforces these rules.** If your commit message is rejected, the hook prints the full rules. Run `./scripts/setup-hooks.sh` once after cloning to activate it.

#### Types

| Type | When to use | Release effect |
|---|---|---|
| `feat` | New user-visible feature or capability | minor bump |
| `fix` | Bug fix that affects users | patch bump |
| `perf` | Performance improvement | patch bump |
| `revert` | Reverts a previous commit | patch bump |
| `chore` | CI, deps, build, tooling, internal cleanup | no release |
| `refactor` | Code restructuring with no behavior change | no release |
| `docs` | Documentation only | no release |
| `test` | Adding or updating tests | no release |

**Use `chore` for CI/deps/build changes -- not `fix`.** `fix(ci)`, `fix(deps)`, `fix(build)` are wrong: they create a release entry that users do not care about.

#### Scopes

Scopes must be **product areas**, not implementation tracking labels.

Allowed: `console` `mcp` `workflows` `engine` `schema` `docs`

Not allowed: `phase2a`, `slice4`, `task-123`, `sprint`, `ci`, `deps`, `build`

If the change does not fit a named product area cleanly, omit the scope entirely.

#### Subject line

Write for a user reading the release changelog -- not for a developer tracking implementation work.

| Bad | Why | Good |
|---|---|---|
| `fix phase2a slice 4 dedup gap` | Internal jargon | `fix(engine): deduplicate env path roots on source scan` |
| `fix(ci): update validate:registry` | Should be chore | `chore: replace deprecated validate:workflows script` |
| `add stuff for console tab` | Vague | `feat(console): add Workflows tab with tag filter and detail panel` |
| `WIP` | Not a commit message | Finish the work first |

Rules:
- 72 characters max on the first line
- No period at the end of the subject
- The subject completes the sentence: "If merged, this commit will..."

## Pull requests and merging

When the project owner asks you to create a PR or merge:
- Create the branch, push, and open the PR using `gh pr create`
- Wait for CI to pass (poll with `gh pr checks`)
- Merge with `gh pr merge --squash --delete-branch`
- Do not push or merge unless explicitly asked. Do not assume finishing a feature means "create a PR."

## Coding philosophy

These principles guide all code decisions in this project. When writing, reviewing, or analyzing code, justify structural choices against them. When multiple principles conflict, surface the tension explicitly.

- **Immutability by default** -- make data read-only; confine mutation behind explicit, minimal APIs
- **Architectural fixes over patches** -- solve root causes by changing constraints and invariants, not by adding localized special-cases
- **Make illegal states unrepresentable** -- model domain states so invalid combinations cannot be constructed
- **Prefer explicit domain types over primitives** -- avoid stringly/numberly typed APIs when domain-specific types or ADTs communicate intent
- **Type safety as the first line of defense** -- prefer compile-time guarantees over runtime checks
- **Exhaustiveness everywhere** -- use discriminated unions so handling is complete and refactor-safe
- **Errors are data** -- represent failure as values (Result/Either), not exceptions as control flow
- **Validate at boundaries, trust inside** -- do input validation at system edges; keep core logic free of defensive checks
- **Determinism over cleverness** -- same inputs produce the same outputs; avoid hidden state
- **Functional/declarative over imperative** -- describe what should happen; minimize mutable state
- **Compose with small, pure functions** -- split logic into tight, testable units; favor composition over large methods
- **Dependency injection for boundaries** -- inject external effects (I/O, clocks, randomness) to keep core logic testable
- **YAGNI with discipline** -- avoid speculative abstractions, but design clear seams and invariants
- **Prefer fakes over mocks** -- tests should validate behavior with realistic substitutes
- **Document "why", not "what"** -- comments explain intent, invariants, and tradeoffs; code explains mechanics

## Things to avoid

- Do not commit new `.md` documentation files unless explicitly authorized. You can create them locally, just do not commit them.
- Do not remove existing `.md` files without authorization.
- Do not use emojis in documentation.
- Do not use em-dashes in MR descriptions.
- Do not create major releases.
- Do not throw exceptions -- use Result types or explicit error return types.
