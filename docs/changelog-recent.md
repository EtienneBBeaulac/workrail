# WorkRail: What Changed in the Last Month

---

WorkRail is the system that makes AI agents follow structured, step-by-step processes. Instead of letting an agent improvise its way through a code review or a bug investigation, WorkRail enforces a defined workflow: one step at a time, with gates, quality checks, and durable history.

This document covers the meaningful changes from the past month -- what shipped, why it matters, and what it changes for your team.

---

## The New Engine Is Now the Default

The original WorkRail engine was stateless -- every call was independent, and if a conversation ended mid-workflow, the work was gone. There was no way to resume, no branching, no loops, and no record of what had happened.

A new engine was built to replace it. When an agent starts a workflow with the new engine, WorkRail creates a session and writes it to disk as an append-only event log. Every step taken, every blocked attempt, every branching path is recorded. Sessions survive across conversations, across days, across restarts. If a long-running workflow is interrupted, it can be resumed exactly where it left off -- even in a different conversation. The execution history is stored as a directed graph, which is what lets the console show a visual trace of everything the agent did.

The new engine was developed while the original ran in production, then gradually rolled out. It is now the default for everyone. The original engine still exists in the codebase but is not actively developed and is not the path anyone is taking.

A few other things shipped alongside this promotion to default:

- Every workflow run now goes through a validation pass before the agent takes a single step, catching broken workflow definitions at startup rather than mid-run
- The protocol agents use to communicate with WorkRail was simplified -- two tokens agents previously had to manage are merged into a single `continueToken`

**What this means:** WorkRail is now resilient infrastructure. Long-running workflows that span hours or multiple conversations are reliable and resumable. The console can show your team a full history of what their agents did and why.

---

## Workflow Discovery Is Much Better

Previously, when an agent asked "what workflows are available?", it got a flat list of names -- not useful if you don't already know what you're looking for.

Workflows are now organized into eight visible categories: Coding & Development, Review & Audit, Investigation & Debugging, Design & Discovery, Documentation, Tickets & Planning, Learning & Personal, and Workflow Authoring. (There is also a Routines category used internally as building blocks for other workflows -- it's deliberately hidden from the user-facing catalog.) Discovery works in two steps:

1. Agent asks -- gets a compact category overview (~500 tokens) with descriptions of when each category applies and example workflow IDs
2. Agent picks a category -- gets only the workflows that match

Workflows can belong to multiple categories. A workflow that generates test cases from tickets shows up under both Tickets & Planning and Coding & Development.

A `workrail://tags` MCP resource lets agents read the full category catalog as a lightweight static read, without triggering a workflow list at all.

**What this means for your team:** Agents make more accurate workflow choices when they understand the landscape. The Workflows tab in the console (covered below) also gives your team a visual catalog to browse before talking to their agent.

---

## Your Team's Workflows Are Now First-Class

This is probably the most relevant change given that you've created workflows for your team.

WorkRail now has a proper source management system. Previously, team workflows lived wherever you put them and agents had to know where to look. Now:

- `list_workflows` tells agents where every workflow comes from: `built_in` (ships with WorkRail), `personal` (your own user directory), `rooted_sharing` (shared via a workspace root), or `external`
- When workflows conflict or overlap, the system explains why one takes precedence
- A `manage_workflow_source` tool lets agents register or unregister workflow directories, useful for sources that aren't in repos the agent already knows about

**Important caveat on team sharing:** The registered sources are stored per-machine (`~/.workrail/`), not per-repo or per-team. Each developer and each CI environment manages its own list. There is no "attach once and everyone sees it" mechanism yet.

**The good news:** If your team's workflows live in a `.workrail/workflows/` directory inside a repo that team members already use with WorkRail, auto-discovery handles it without any manual setup. The agent automatically walks workspace roots it knows about and finds `.workrail/workflows/` directories. For repos that have been used with `list_workflows` or `inspect_workflow` (passing `workspacePath`), the team workflows will already appear.

**Action for you:** If you haven't already, the cleanest setup is to put your team workflows in `.workrail/workflows/` inside your shared repo. As long as team members run WorkRail with that repo's path as their workspace, the workflows appear automatically -- no `manage_workflow_source` call needed.

---

## Assessment Gates Now Support Multiple References

A step can now declare multiple `assessmentRefs` alongside a single `assessmentConsequences` entry. The consequence fires if any dimension across any referenced assessment equals the trigger level.

Previously, having a consequence required exactly one `assessmentRef`, which forced authors to cram unrelated dimensions into one monolithic assessment definition. With many-to-one, you can compose separate orthogonal assessment definitions -- one for quality, one for coverage, one for confidence -- and share a single blocking gate across all of them.

```json
{
  "assessmentRefs": ["quality-gate", "coverage-gate"],
  "assessmentConsequences": [
    { "when": { "anyEqualsLevel": "low" }, "effect": { "kind": "require_followup", "guidance": "Address all low dimensions before proceeding." } }
  ]
}
```

**What this means for workflow authors:** No more monolithic assessment definitions. Compose narrow, reusable assessment vocabularies and combine them at the step level.

**Breaking change:** `stepContext.assessments` in the `continue_workflow` response is now an **array** (one entry per `assessmentRef`), not a single object. If you read `stepContext.assessments.assessmentId` directly, update to `stepContext.assessments[0].assessmentId`. Sessions where an assessment step completed before this change will replay correctly -- the durable event log is unaffected.

---

## Agent Outputs Can Now Have Quality Checkpoints

This is one of the most significant engine additions this month.

Workflows can now declare **assessment criteria** -- named checkpoints where the agent self-evaluates its own output against a set of defined dimensions before the step can complete. For example, a bug investigation step can require that the agent rates its own confidence as `high` before the workflow advances. If the agent rates itself `low`, the engine keeps the step pending and requires a retry with improved output.

It's worth being precise about how this works: the engine does not independently evaluate quality. It records the agent's own self-assessment and checks whether any dimension falls below the configured threshold. If the agent dishonestly rates its own output highly, the gate doesn't catch it. What assessment gates do is create a **structured self-evaluation checkpoint** -- they force the agent to explicitly commit to a quality rating, which in practice produces better outputs because the agent has to reason through its own confidence before proceeding.

The `bug-investigation.agentic.v2.json` workflow uses this for confidence gating on the diagnosis step. The `mr-review-workflow.agentic.v2.json` workflow also uses it, with three dimensions: evidence quality, coverage completeness, and contradiction resolution.

**What this means:** Workflows can create soft quality floors on agent outputs. Not a hard guarantee -- the agent self-reports -- but a forcing function that produces meaningfully better outputs in practice.

---

## New Bundled Workflows

Four new structured workflows were added:

### Production Readiness Audit
Answers one question honestly: is this code actually ready for production? Goes beyond style and lint. Covers runtime operability, error handling, observability, security exposure, and technical debt. Produces an explicit verdict -- `ready`, `ready_with_conditions`, `not_ready`, or `inconclusive` -- with evidence requirements. The agent cannot just say "looks fine."

### UI/UX Design Workflow
Addresses the specific ways AI agents fail at design work: jumping to a single solution before understanding the problem, knowing UX laws but not applying them, ignoring accessibility, and skipping error states and edge cases. Forces the agent through: problem framing (before any solutions), multiple design directions (before converging on one), and parallel review by separate reviewer families for information architecture, UX laws, accessibility, edge cases, and content. Produces a design spec, not just suggestions.

### Architecture Scalability Audit
Scoped, evidence-driven audit across a subset of five dimensions the requester selects: `load` (handling more traffic), `data_volume` (handling more records), `team_org` (more developers working on the same code), `feature_extensibility` (adding features without rearchitecting), and `operational` (more deployments and environments). The user picks which dimensions apply -- not all five are always audited. Every finding must cite actual code. Produces per-dimension verdicts.

### Cross-Platform Code Conversion
Structured migration workflow for moving code between platforms (Android to iOS, server to client, etc.). Classifies work into three tiers: mechanical translation (parallelizable), adaptation (needs design consideration), and redesign (needs full attention). Delegates the mechanical parts to parallel subagents and focuses review effort on the hard cases.

---

## Workflow Authoring Got Significantly Better

Since you've created workflows yourself, these changes are directly relevant.

### `workflow-for-workflows.v2.json` was rebuilt

The workflow used to create or modernize other workflows was significantly redesigned. The full phase structure now includes:

1. Understanding and classifying the authoring task
2. **Effectiveness targeting** -- defining what "good execution" looks like for this specific workflow before writing a single step
3. Designing the workflow architecture (for non-trivial workflows)
4. **Quality gate architecture** -- explicit decisions about what the workflow will enforce vs. leave to the agent
5. Structural validation
6. A quality gate loop with four phases run in sequence: **state-economy audit** (catching redundant context between steps), **execution simulation** (the agent simulates a run before declaring it done), **adversarial review** (a deliberate attempt to find failure modes), and a **redesign phase** if problems are found
7. Final trust handoff with spec version stamp

The result is that workflows produced through this process are more reliable and better calibrated.

### References

A workflow can declare external documents -- your team's coding standards, an architecture decision record, a product spec -- and WorkRail delivers pointers to them when the session starts and again when a session is resumed. (References are not re-sent on every step advance -- the agent is expected to read the files it needs from its initial context.) This gives the agent relevant background from the first step rather than burying it in a prompt halfway through the workflow.

### Prompt fragments

Instead of duplicating near-identical step prompts for "if the scope is small, do X; if large, do Y", workflow authors write one step with named conditional variants. The compiler inlines the right one at runtime based on context variables. Two concrete benefits: less maintenance for authors, and meaningfully less context sent to the agent on each step -- only the relevant variant is delivered, not all of them.

### `about` and `examples` fields

Every workflow now has two new optional fields that are purely for humans -- neither is visible to agents, only through the Workflows tab in the console:

- `about`: a human-readable markdown description (what it does, when to use it, what it produces, how to get good results). Shown in the detail panel when you click a workflow.
- `examples`: 2-6 short, concrete goal strings illustrating what the workflow is for. Shown alongside the description.

All 22 non-test bundled workflows were backfilled with both fields. The authoring workflow now prompts for both during Phase 7a.

**Action for you:** Your team's existing workflows don't have these fields yet. Adding them means anyone on the team can click your workflow in the console and immediately understand what it's for and when to reach for it. Two new fields in the JSON.

### `goal` is now required on `start_workflow`

When an agent starts a workflow, it must provide a `goal` -- a sentence describing what it's trying to accomplish. This is stored immediately as the session title. Omitting it causes a hard validation error before execution begins.

Before this, sessions appeared in the console as random IDs until the agent produced output. Now you see "Review PR #47 for correctness and production risk" from the moment the session starts.

**Action for you:** If your team has scripts or prompts that start workflows without a `goal` parameter, they need to be updated. The error is explicit about what's missing.

---

## The Console Is Now a Full Dashboard

The browser-based console went from an early release to a complete workspace tool this month.

### Workspace (default view)
The main view organizes everything by git branch within each repo. It combines two things that used to require separate tabs: workflow session history and git worktree state. Each branch row shows the session title, workflow name, time ago, git state badges (uncommitted file count, unpushed commit count), and active worktree status. Clicking the badges expands a panel showing the actual files or commits.

Active branches (with running or blocked sessions) sort to the top. Older clean branches show as compact rows below. Keyboard navigation throughout (j/k to move, Enter to open, / for the session archive).

### Workflows tab
A visual catalog of every available workflow. Eight category filter pills. Click any workflow for its full description, usage examples, and preconditions.

---

## Staleness Detection

WorkRail can now detect when a workflow hasn't been reviewed against the current authoring spec. Three signal levels:

- `none` -- validated against the current spec (has a version stamp and it's current)
- `possible` -- no version stamp (was never run through `workflow-for-workflows`)
- `likely` -- has a stamp, but the spec has been updated since the workflow was last reviewed

This shows up in `list_workflows` output (agents see it) and in the CI registry validation check. It's shown only for non-built-in workflows -- built-in workflows ship with their own quality process and don't show staleness signals.

**What this means for your team:** Your team's existing workflows will show as `possible` (no stamp) until they're run through `workflow-for-workflows.v2.json`. That's expected -- it's not an error, just a signal that they haven't been through the new quality gate. Over time, as you modernize them, they'll show `none`.

---

## What's Coming Next

The things in active development or planned for the near term:

- **Console execution trace** -- the console currently shows what nodes were created; it doesn't yet explain *why* the engine chose a particular path (skipped phases, fast paths, condition evaluations). That visibility is the next major console investment
- **Dashboard artifacts** -- instead of agents writing markdown files to your repo during a workflow run, structured outputs would be submitted through the workflow and rendered directly in the console session view
- **Broader workflow source onboarding** -- richer source health reporting, update/sync flows, and making team workflow setup even simpler

---

*Last updated: April 2026*
