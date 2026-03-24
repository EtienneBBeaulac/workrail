# GitHub Ticketing Playbook

This is the **Phase 1 operating playbook** for the single-dev, agent-assisted GitHub workflow.

It is intentionally lightweight and follows the current design in `docs/plans/agent-managed-ticketing-design.md`.

## Current model

- ideas live first in `docs/ideas/backlog.md`
- GitHub issues track concrete work
- labels stay minimal
- the developer chooses what becomes active
- agents help when explicitly pointed at a ticket

## Phase 1 labels

### Type

- `feature`
- `bug`
- `chore`

### State

- `next`
- `active`
- `blocked`

### Label application note

The single GitHub issue form captures **work type**, but GitHub does not automatically map that dropdown to labels.

In Phase 1, apply labels manually after issue creation or with the CLI.

## One-time setup checklist

When enabling this workflow in a repo, make sure these are in place:

- create the Phase 1 labels
- verify `.github/ISSUE_TEMPLATE/work-item.yml` exists
- verify `.github/pull_request_template.md` exists
- verify the team knows `docs/ideas/backlog.md` is still the home for fuzzy ideas

## Phase 1 issue shape

Every issue intended for execution should contain:

- **Problem**
- **Goal**
- **Acceptance criteria**
- **Verification**
- **Non-goals**
- **Context**

Optional when an agent may execute it later:

- **Agent execution note**

## When to create an issue

Create a GitHub issue when:

- it is a real candidate for near- or medium-term work
- it is a confirmed bug with enough detail to investigate
- it is important follow-up discovered during active implementation
- you explicitly want it tracked in GitHub

Keep it in `docs/ideas/backlog.md` instead when it is still fuzzy or speculative.

## When something is `next`

An issue is ready for `next` when:

- the problem is understandable
- the goal is understandable
- acceptance criteria exist
- verification exists
- non-goals exist
- no unresolved decision blocks normal execution

## When something is `blocked`

If you add `blocked`, add a short comment that says:

- what is blocked
- the kind of block: `decision`, `dependency`, `context`, or `external/tooling`
- the next thing needed to unblock it

## Closure rule

Close an issue only when:

- a PR landed and the acceptance criteria were actually satisfied
- it was intentionally closed with a clear no-code resolution
- it was superseded by another explicitly linked issue

Before closure:

- verify acceptance criteria
- verify the verification step actually happened
- confirm scope did not silently expand past the non-goals

Default rule:

- the developer closes issues by default
- an agent may close only when closure is clearly mechanical and verification is explicit

## Minimal CLI flow

### Create an issue

```bash
gh issue create
```

### Add labels to an issue

```bash
gh issue edit <number> --add-label feature,next
```

### List open issues

```bash
gh issue list
```

### View one issue

```bash
gh issue view <number>
```

### Comment on progress or blockers

```bash
gh issue comment <number> --body "Blocked on dependency. Kind: dependency. Next needed: merge #123."
```

### Open a PR

```bash
gh pr create
```

## How to hand an issue to an agent

In Phase 1, the developer chooses the issue and explicitly hands it to the agent.

### Suggested prompt

Use something like:

> Work GitHub issue `#129`. Read the issue first, follow its acceptance criteria and non-goals, make the code changes, run the relevant verification, and open a PR that references the issue.

### Expected flow

1. Pick the issue you want worked
2. Have the agent read the issue
3. Mark it `active` when work actually begins
4. Agent implements the change
5. Agent reports blockers in the issue if needed
6. Agent opens a PR that references the issue
7. Close the issue after the PR lands and verification is explicit

### If the issue becomes blocked

Add a short comment that says:

- what is blocked
- the kind of block: `decision`, `dependency`, `context`, or `external/tooling`
- the next thing needed to unblock it

### Phase 1 reminder

Agents do **not** pick backlog work on their own in this mode.  
They help when you explicitly point them at a ticket.

### Create the Phase 1 labels (one-time setup)

```bash
gh label create feature --color 0e8a16 --description "New capability or user-visible improvement"
gh label create bug --color d73a4a --description "Something is wrong"
gh label create chore --color 6f42c1 --description "Maintenance or repo upkeep"
gh label create next --color 1d76db --description "Good candidate for upcoming work"
gh label create active --color fbca04 --description "Currently being worked"
gh label create blocked --color b60205 --description "Cannot proceed until something changes"
```

## Practical defaults

- keep `next` small
- usually keep only one `active` issue
- use labels for status, not long status prose
- use issue bodies for the real contract
