# Single-Dev Ticketing with Agents

This is the **live design doc** for a lightweight ticketing system that works well for a **single developer using agents**.

Use this doc to refine:

- how work is captured and promoted
- what role agents should play in ticket management
- how GitHub issues should be structured
- how much autonomy agents should have over prioritization, execution, and closure

## Goal

Create a ticketing system that is:

- lightweight enough for one developer
- explicit enough for agents when they are asked to help
- easy to operate from the GitHub CLI
- hard for agents to misinterpret or over-manage

## Non-goals

- recreating a heavyweight project-management system
- building a full scrum workflow
- making agents responsible for product strategy
- treating every idea as a GitHub issue

## Current operating mode

Right now this design assumes:

- the developer chooses what to work on
- agents do **not** autonomously browse the backlog and pick tickets
- agents are **assistant executors/shapers**, not autonomous backlog managers

That means the system should optimize for **human-directed, agent-assisted** work first, while leaving room for a stricter future mode if autonomous agent pickup is introduced later.

## Core problem

A system that works for a human alone is often **too implicit** for agents.

Humans tolerate:

- fuzzy status
- soft priorities
- incomplete acceptance criteria
- informal “I know what I mean” issue bodies

Agents do not handle those gaps well. If agents browse and manage the work, ambiguity turns into:

- bad prioritization
- premature execution
- over-creation of tickets
- accidental scope expansion
- false claims of completion

## Design principles

### 1. Lightweight for the human, strict for the agent

The system should minimize ceremony for the developer while making ticket state and execution readiness explicit enough for an agent to act safely.

### 2. Separate capture from execution

Not every thought should become a ticket.

Use:

- **ideas** for raw capture
- **GitHub issues** for work that is concrete enough to track
- **pull requests** for execution records

### 3. Readiness must be machine-legible

Agents need a clear answer to:

- may I start?
- what counts as done?
- what requires a human decision first?

### 4. Human owns priority and product intent

Agents may help **draft, refine, and execute**, but they should not silently become product managers.

### 5. Done must be concrete

Tickets should define completion in a way an agent can verify, not just narrate.

## Two-phase model

### Phase 1: Human-directed, agent-assisted

This is the **current target**.

Characteristics:

- you decide what to work on
- you point an agent at an issue when useful
- agents help shape, implement, and summarize
- agents do **not** independently curate the backlog

### Phase 2: Agent-managed backlog

This is **future work**, not the current recommendation.

Characteristics:

- agents may browse the backlog directly
- agents may propose or manage readiness/state transitions
- the ticket system must become more machine-legible and permissioned

This phase needs stricter lifecycle semantics, clearer authority boundaries, and tighter closure rules than Phase 1.

### Future supervised execution loop

A likely intermediate step before full autonomous backlog management is a **supervised execution loop**:

- the agent reads the local GitHub/ticketing docs
- the agent inspects GitHub issues labeled as viable candidates (for example `next`)
- the agent suggests one ticket to the developer
- the developer approves or rejects the suggestion
- after approval, the agent executes the issue through WorkRail
- the agent opens the PR, watches checks, and reports status
- merge behavior stays explicitly policy-controlled

This is different from a fully autonomous backlog agent because the human still approves:

- which issue gets worked
- whether execution should start now
- whether merge authority is delegated

This future mode likely needs:

- a ticket selection policy
- a clear approval gate before execution
- a mapping from GitHub issue fields into a WorkRail task workflow
- a PR/check watcher
- explicit merge policy

## Implemented Phase 1 artifacts

- `.github/ISSUE_TEMPLATE/work-item.yml`
- `.github/pull_request_template.md`
- `docs/planning/github-ticketing-playbook.md`

## Recommended system model

### Layer 1: Ideas

Use local docs for:

- raw ideas
- half-formed observations
- things that are worth remembering but not ready for execution

Current home:

- `docs/ideas/backlog.md`

### Layer 2: GitHub issues

Use GitHub issues for:

- work that is real enough to potentially do
- bugs with enough detail to investigate
- features with a clear problem and goal
- chores that have a meaningful completion condition

### Layer 3: Pull requests

Use pull requests for:

- the implementation record
- review
- closure of the associated issue

## Recommended lifecycle for Phase 1

Keep the current lifecycle simple:

- **`next`** — good candidate for upcoming work
- **`active`** — currently being worked
- **`blocked`** — cannot proceed

Everything else can remain implicit in the issue body for now.

## Phase 1A: Concrete operating contract

This section is the **current implementation target** for the human-directed, agent-assisted mode.

### 1. When to create a GitHub issue

Create a GitHub issue when at least one of these is true:

- it is a real candidate for near- or medium-term work
- it is a confirmed bug with enough detail to investigate
- it is follow-up work discovered during active implementation that should not be lost
- the developer explicitly wants the work tracked in GitHub

Rule of thumb:

- if you would plausibly work on it in the next few weeks, or need to preserve it as real follow-up work, it can be an issue

Do **not** create a GitHub issue for:

- raw ideas that are still fuzzy
- tiny observations that do not yet justify execution tracking
- speculative product thoughts with no current intent to act

Those should stay in:

- `docs/ideas/backlog.md`

#### Agent issue creation in Phase 1

Agents may always:

- draft issue bodies

Agents may create an issue directly only when one of these is true:

- the developer explicitly asked for the issue to be created
- the work is a confirmed bug with enough context to be tracked
- the work is important follow-up discovered during active execution and is likely to be lost otherwise

### 2. Minimal Phase 1 labels

Use only:

- **type**: `feature`, `bug`, `chore`
- **state**: `next`, `active`, `blocked`

Do not add more labels in Phase 1 unless the current set proves insufficient in practice.

### 3. Minimum issue body

Every issue intended for execution should contain:

- **Problem**
- **Goal**
- **Acceptance criteria**
- **Verification**
- **Non-goals**
- **Context**

And, if an agent might be asked to execute it:

- **Agent execution note**

Phase 1 minimum quality bar:

- at least one acceptance criterion
- at least one verification step
- explicit non-goals or `none`
- enough context that the developer could hand the issue to an agent without additional reconstruction

### 4. What qualifies for `next`

An issue should get `next` only when:

- the problem is understandable
- the goal is understandable
- acceptance criteria exist
- verification exists
- non-goals exist
- there is no unresolved decision blocking normal execution

`next` means:

- this is a serious candidate for upcoming work
- if the developer points an agent at it, the agent should have enough structure to proceed

### 5. What qualifies for `blocked`

Use `blocked` when work cannot reasonably continue because of:

- missing required context
- an unresolved decision
- dependency on another change
- a failing prerequisite outside the current issue

When something becomes blocked, the issue should get:

- a short comment explaining **what is blocked**
- the **kind of block** (`decision`, `dependency`, `context`, or `external/tooling`)
- the **next thing needed** to unblock it

### 6. Closure rule for Phase 1

An issue should be closed only when one of these is true:

- a PR landed and the acceptance criteria were actually satisfied
- the issue was intentionally closed with a clear no-code resolution
- the issue was superseded by another explicitly linked issue

Before closure, verify:

- acceptance criteria were met
- verification was actually performed
- scope did not silently expand past the non-goals

Default closure ownership:

- the developer closes issues by default
- an agent may close an issue only when closure is clearly mechanical and the verification is explicit

### 7. Current agent permissions

In Phase 1, agents may:

- draft issue bodies
- refine issue structure
- suggest that something should become `next`
- mark a ticket `active` when explicitly asked to work on it
- mark a ticket `blocked` with an explanation
- implement a ticket the developer explicitly handed them
- open a PR linked to the issue

In Phase 1, agents should **not**:

- freely browse and pick backlog work on their own
- invent priority
- create large numbers of new issues from minor observations
- close issues unless completion is clear and verification is explicit

### 8. Default single-dev rule

Default operating stance:

- many ideas
- small number of GitHub issues
- small `next` set
- usually one `active` issue

### 9. Phase 1 defaults checklist

Use this as the default operating checklist:

- ideas stay in docs until they are concrete enough to track
- issues are for real work, confirmed bugs, or important follow-up
- labels stay minimal: `feature|bug|chore` and `next|active|blocked`
- `next` stays small
- `blocked` always gets a short explanatory comment
- the developer chooses what becomes active
- agents help when explicitly pointed at a ticket

### Deferred lifecycle for Phase 2

If agents later start browsing and picking up work autonomously, introduce a stricter lifecycle:

- `inbox`
- `shaped`
- `ready`
- `active`
- `blocked`
- `done`

And add an explicit `decision-needed` control state.

## Recommended authority split

### Human-owned

- prioritization
- promotion from idea to issue
- final product decisions
- scope changes that alter user intent
- deciding whether ambiguous work is actually done

### Agent-owned

- drafting issues
- refining issue structure
- updating progress/comments
- implementing work that you explicitly hand them
- opening pull requests
- linking PRs to issues

### Agent-restricted

Agents should **not** freely:

- create many tickets from every small observation
- reprioritize the backlog
- close ambiguous tickets without explicit verification

## Recommended GitHub label set

Keep the label set small.

### Work type

- `feature`
- `bug`
- `chore`

### State

- `next`
- `active`
- `blocked`

### Optional later labels

These are useful only if backlog-managing agents become real later:

- `decision-needed`
- `ready`
- `agent-ok`
- `human-check`

## Recommended ticket schema

Every execution-oriented GitHub issue should have:

### Problem

What is wrong, missing, or confusing?

### Goal

What outcome do we want?

### Acceptance criteria

What must be true for this to count as done?

### Verification

How should completion be checked?

### Non-goals

What is intentionally out of scope?

### Context

Relevant files, docs, prior issues, PRs, or design notes.

### Agent execution note

For Phase 1, keep this light:

- **Can an agent take this if I point them at it?** yes/no
- **Anything the agent should avoid?**

Save the heavier autonomy contract for Phase 2.

## Recommended issue template for Phase 1

```md
## Problem

## Goal

## Acceptance criteria
- [ ]

## Verification
- [ ]

## Non-goals
- 

## Context
- 

## Agent execution note
- Can an agent take this if I explicitly hand it over: yes/no
- Avoid:
```

## Recommended promotion rules

### Idea → issue

Promote an idea into a GitHub issue when:

- it is likely real work
- the problem is understandable
- there is enough context to shape it

### Issue → next

A ticket becomes `next` when:

- the problem is clear enough
- the goal is clear enough
- acceptance criteria exist
- non-goals exist

### Next → active

Only one ticket should usually be `active` at a time for a single developer unless there is a very intentional reason otherwise.

## Recommended single-dev operating model

### Inbox

Raw ideas and newly created issues.

### Next

Small set of `next` tickets.

### Active

Usually one ticket.

### Done

Closed issues with a linked PR or explicit closure rationale.

## How agents should manage it

### Good agent behaviors in Phase 1

- draft or refine tickets from rough notes
- ask for shaping when a ticket is not actually clear enough
- execute only work you explicitly point them at
- update the issue with progress and blockers
- open a PR that closes the issue

### Bad agent behaviors

- interpreting vague notes as permission to implement
- inventing priority
- silently expanding scope
- creating too many tickets from minor observations
- closing work based on partial implementation plus persuasive prose

## GitHub CLI flow

### Shaping

- create issue with `gh issue create`
- inspect/refine with `gh issue view`
- comment or edit as the shape improves

### Execution

- pick the issue you explicitly want to work on
- implement
- open PR with `gh pr create`
- link PR to issue

### Closure

- close via PR or explicit `gh issue close`
- leave a concise summary of what landed and what did not

## Main gaps and risks

### 1. Tickets can still be underspecified

Even in Phase 1, weak issue bodies will make agent execution worse.

### 2. Agents can still overstep if prompts are loose

If you hand an issue to an agent without scope guidance, they may still expand it.

### 3. Closure can drift from real verification

If “done” is not checked concretely, agents may optimize for plausible summaries instead of true completion.

### 4. The system can get overbuilt too early

If we optimize now for autonomous backlog agents that do not exist yet, we add unnecessary ceremony.

## Recommended defaults

For this repo and workflow, the default stance should be:

- ideas live first in docs
- only concrete, execution-worthy work becomes GitHub issues
- labels stay lightweight
- one active issue at a time by default
- human keeps ownership of priority and product decisions
- agents help when explicitly pointed at a ticket

## Open questions

- When do we actually want to introduce a stricter `ready` state?
- Should agents be allowed to create issues directly, or mainly draft them?
- Do we want one standard issue template for all work, or separate templates for `feature`, `bug`, and `chore`?
- At what point would GitHub Projects/custom fields become worth the complexity?
- Do we want a supervised agent loop that suggests one `next` ticket, waits for approval, then executes it through WorkRail?
- If so, what should the merge policy be: ask before merge, or merge automatically after green checks?

## Current recommendation

Start simple:

1. keep ideas in `docs/ideas/backlog.md`
2. use GitHub issues for work that is concrete enough to track
3. use a minimal `next` / `active` / `blocked` label set
4. keep the issue body clear enough for an agent when you explicitly hand it over
5. keep human control over priority and decision-making

If this works well, we can later refine:

- issue templates
- label taxonomy
- GitHub CLI conventions
- a future Phase 2 readiness/permission model for autonomous backlog agents
