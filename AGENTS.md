# WorkRail -- Agent Instructions

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

## How we work together

Work follows a deliberate progression. Do not skip steps or assume what comes next.

1. **Understand** -- before doing anything, understand what the user is asking. Ask clarifying questions. Read relevant docs and code. Do not jump to implementation.
2. **Explore and analyze** -- investigate the codebase, read planning docs, check what already exists. Surface what you find back to the user. The user wants to think through problems together, not just receive solutions.
3. **Discuss and decide** -- present options, tradeoffs, and your honest assessment. The user will tell you which direction to go. Do not make architectural decisions unilaterally.
4. **Plan** -- once direction is agreed, capture the idea in `docs/ideas/backlog.md` if it is new. When it is concrete enough to execute, create a GitHub issue with `gh issue create`. Update `now-next-later.md` and `open-work-inventory.md` as needed.
5. **Implement** -- only after the user says to proceed. Create a branch, write the code, run tests.
6. **Verify** -- run `npx vitest run`, check for linter errors, confirm the change does what it should. If you are in a fresh worktree and dependencies are not installed yet, install them and still run the required verification rather than treating missing dependencies as a stopping point.
7. **Update authoring docs before merge when engine behavior changes** -- if engine or schema work changes workflow authoring behavior, update `docs/authoring-v2.md` and `docs/authoring.md` before merging. Do not let shipped runtime behavior get ahead of author guidance.
8. **Ship** -- only when the user asks. Create a PR, wait for CI, merge when told to.
9. **Update planning docs** -- after shipping, mark work as done in the roadmap and inventory docs.

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

### Planning system

The planning system follows a graduation path: ideas -> roadmap -> tickets -> execution.

- `docs/planning/README.md` -- how the planning system works, the layers, and rules of thumb
- `docs/ideas/backlog.md` -- raw ideas and feature thoughts (low-friction inbox)
- `docs/roadmap/now-next-later.md` -- lightweight cross-cutting roadmap (what is active, what is next, what is later)
- `docs/roadmap/open-work-inventory.md` -- consolidated list of all partial, unimplemented, and parked work with status and source doc references
- `docs/tickets/next-up.md` -- groomed near-term tickets with acceptance criteria
- `docs/roadmap/legacy-planning-status.md` -- status map for older planning docs

**Keep planning docs current.** These documents are living artifacts, not write-once references. Update them as work happens:
- When starting a feature: mark the relevant item as active in `now-next-later.md` and `open-work-inventory.md`
- When completing a feature: mark it done, update status, note what was delivered
- When the user shares an idea: capture it in `docs/ideas/backlog.md` immediately
- When scope changes or new work is discovered: add it to `open-work-inventory.md`
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

The MCP server is started automatically by agentic IDEs (Firebender, Cursor, Claude Code). After making changes:
1. Kill all running WorkRail processes
2. Run `npm run build`
3. Toggle the MCP server off and on in the IDE so it reloads with the new build

Do not attempt to restart the MCP server programmatically -- the user will toggle it manually.

## Release policy

- Releases are automated via semantic-release on merge to main
- `fix:` -> patch, `feat:` -> minor, `docs:`/`chore:`/`test:` -> no release
- **Never create a major release unless explicitly authorized by the project owner.** Breaking changes default to minor. Major requires setting `WORKRAIL_ALLOW_MAJOR_RELEASE=true` on the repo variable. See `docs/reference/releases.md`.

## Branch and commit conventions

- Branch naming: `feature/etienneb/<name>`, `fix/etienneb/<name>`, `docs/etienneb/<name>`
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`)
- PRs are squash-merged to main
- Prefer rebasing on main over merge commits when resolving conflicts

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
