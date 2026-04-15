# Discovery: Workspace Context UX

## Context / Ask

The Workspace view shows branches with sessions, but "what's being worked on in
this worktree" is often blank or inferred from recap snippets that only appear
after the first workflow checkpoint. Two distinct gaps:

1. **Session start gap**: A newly started session has no title until the first
   `recapSnippet` fires. The Workspace card headline is empty or just shows
   the workflow name.

2. **Branch-level gap**: A branch with 3 workflow runs (coding-task, mr-review,
   discovery) has no overarching label. The card shows the most recent session's
   recap -- session-specific, not branch-specific.

## Path Recommendation

`full_spectrum` -- both landscape grounding (what mechanisms exist today) and
reframing (is session-level context sufficient or do we need branch-level?)
needed to avoid building the wrong thing.

## Constraints / Anti-goals

**Constraints:**
- Must align with existing `context_set` / observation event model
- Cannot break existing sessions or workflows
- No mandatory new fields on `start_workflow` (optional only)
- Must degrade gracefully when context is missing
- Session = per workflow run (not per branch) -- branch-level context needs a
  separate mechanism

**Anti-goals:**
- Don't require agents to do extra steps beyond what workflows already prompt
- Don't add a mandatory title field that blocks workflow start
- Don't conflate session-level and branch-level context into one mechanism
- Don't build a separate session store for titles (legacy session tool unused)

## Landscape Packet

### Existing session title pipeline

`sessionTitle` is derived from `context_set` events with keys:
`['goal', 'taskDescription', 'mrTitle', 'prTitle', 'ticketTitle', 'problem']`
(defined in `session-summary-provider/index.ts:91`)

Full pipeline:
1. Agent submits `contextVariables` in `continue_workflow` call
2. `buildContextSetEvent()` emits `context_set` event (`v2-advance-events.ts:130`)
3. `projectRunContextV2()` derives current context per runId (`run-context.ts:32`)
4. `deriveSessionTitle()` checks TITLE_CONTEXT_KEYS in order (`session-summary-provider:366`)
5. `ConsoleSessionSummary.sessionTitle` exposed in API

**Gap**: `start_workflow` has no field to provide early context. Title only
populates after the first `continue_workflow` call that includes `contextVariables`.

**Workflow reality**: `mr-review-workflow` sets `mrTitle`, `mrPurpose`, etc. in
Phase 0 context. `coding-task` does NOT set any TITLE_CONTEXT_KEYS explicitly.
No workflow sets `goal` as its first context submission. All context goes via
`continue_workflow`, never via `start_workflow`.

### `recapSnippet` vs `sessionTitle`

| Field | Non-null when | Timing |
|---|---|---|
| `sessionTitle` | TITLE_CONTEXT_KEYS found in context_set events, OR first recap has descriptive text | After first `continue_workflow` with context |
| `recapSnippet` | At least one node has RECAP channel output | After first checkpoint advance |

Both are null at session creation. `sessionTitle` can be populated sooner if
`contextVariables` are set in the first `continue_workflow`.

### Git branch description mechanism

`git config branch.<name>.description` stores a per-branch description. Readable
via a git command; writable by the developer manually.

**Adding to worktree-service.ts**: Easy. 4th command in the `Promise.all` inside
`enrichWorktree()` (lines 118-122). Extend `WorktreeEnrichment` interface + 
`ConsoleWorktreeSummary` type. ~25 lines total.

**Visual slot**: After recap/commit message, before git badges in `FeaturedCard`
(WorkspaceView.tsx line 519-528). Same `text-muted` styling as headMessage.

**Adoption reality**: Rarely used. Power user feature but zero-cost when absent.

### Adding `goal` to `start_workflow`

~4 file changes:
1. `src/mcp/v2/tools.ts:39` -- add `goal?: string` to `V2StartWorkflowInput`
2. `src/mcp/handlers/v2-execution/start.ts:168` -- add `goal?` to `buildInitialEvents()` args
3. `src/mcp/handlers/v2-execution/start.ts:200-260` -- emit `context_set` event (source: 'initial') with `{ goal }` when provided
4. `src/mcp/handlers/v2-execution/start.ts:410` -- pass `input.goal` to `buildInitialEvents()`

Event order after: session_created (0) → run_started (1) → node_created (2) →
preferences_changed (3) → **context_set:initial (4)** → observations (5+)

`deriveSessionTitle()` picks it up immediately -- `sessionTitle` is non-null
from session creation.

### `task_description` workspace anchor (alternative)

Would add a new key to the closed `WorkspaceAnchor` union. Per-session, not
per-branch. More complex (3 files + adapter logic). Not meaningfully different
from `goal` on `start_workflow` in outcome -- both populate `sessionTitle` via
the same `context_set` → `deriveSessionTitle()` pipeline. No advantage over
the simpler option.

### Workflow intake prompts (alternative)

Update workflows to set `goal` in Phase 0 context. Works, but:
- Requires updating every workflow
- Only helps for workflows that have been updated
- `start_workflow.goal` covers all workflows with zero workflow changes

## Problem Frame Packet

### Primary users

1. **Developer using Workspace** -- wants to see "what's happening on each branch"
   at a glance, within seconds, without clicking into sessions
2. **Agent calling `start_workflow`** -- already knows the task description
   (the user just told it); passing `goal` is near-zero friction

### Jobs to be done

| Job | Current friction | Gap |
|---|---|---|
| Ambient check ("what's this branch for?") | Empty card until first recap | Session start gap |
| Multi-workflow branch ("what phase is this in?") | Most recent recap only | Branch-level gap |
| Resume lookup ("which session was for X?") | Scan session list | sessionTitle is null, can't search by it |

### Where the real seam is

The **session start gap** is a pure data availability problem -- the title
mechanism exists but has no early input. The fix is `goal` on `start_workflow`.

The **branch-level gap** is a conceptual model question -- the branch is not a
first-class entity in WorkRail's data model. The Workspace view treats it as a
grouping key. A branch-level description is inherently out-of-band (git) or
needs a new domain concept.

**Reframe**: For the ambient awareness use case, the session start gap matters
far more than the branch-level gap. A user knows what their branches are for --
the friction is not knowing what's happening RIGHT NOW. A `sessionTitle` that
says "implement OAuth refresh token rotation" immediately on session start serves
that need. The branch-level description is secondary context.

### Riskiest assumption

"Agents will naturally pass `goal` when available." If agents skip it (it's
optional), the gap persists. Mitigation: add `goal` to the
`start_workflow` tool description as a strongly-worded recommendation; update
CLAUDE.md or system prompt to prompt agents to always pass it.

## Candidate Directions

### A -- `goal` on `start_workflow` only (minimal)

Add optional `goal` field. Agents pass task description at session start.
`sessionTitle` populated immediately. Zero workflow changes.

- **Closes**: Session start gap
- **Leaves open**: Branch-level gap (shows most recent recap as branch headline)
- **Risk**: Agents may skip it (optional)
- **Effort**: ~4 file changes, ~30 lines

---

### B -- `goal` on `start_workflow` + git branch description (recommended)

A + read `git config branch.<name>.description` per worktree + display in
FeaturedCard as a subtitle.

- **Closes**: Session start gap fully; branch-level gap for users who set it
- **Branch gap reality**: git description is rarely set, but when present it's
  exactly right (developer intent, not agent inference)
- **Graceful degradation**: No description = no subtitle, card unchanged
- **Risk**: Branch description adoption is low; doesn't solve multi-session
  branch gap for users who don't set it
- **Effort**: A + ~25 lines in worktree-service + ~6 lines in FeaturedCard

---

### C -- `goal` on `start_workflow` + update workflow intake steps

A + update `coding-task`, `mr-review`, `wr.discovery` Phase 0 prompts to
explicitly require agents to set `goal` in their first `contextVariables`.

- **Closes**: Session start gap; improves session title quality by ensuring
  workflows set it
- **Better than A alone**: Makes `goal` de facto standard not just optional
- **Risk**: Requires updating all current and future workflows; enforcement is
  doc-level not schema-level
- **Effort**: A + update 3-5 workflow JSON files + docs

---

### D -- `goal` on `start_workflow` + git branch description + workflow prompts (full)

B + C combined. All three mechanisms.

- **Closes**: All gaps
- **Best UX**: Session title always populated; branch description when set; all
  sessions from all workflows have good titles
- **Risk**: Workflow prompt changes need maintenance
- **Effort**: B + C workflow changes

---

## Challenge Notes

**Strongest case against B (git branch description)**:
Git branch descriptions are a niche feature most developers never use. The
"branch-level gap" may not be worth solving with a mechanism that requires
manual action outside of WorkRail. The session recaps already serve
this purpose adequately for active work.

**What tips toward B anyway**: The slot is visual (FeaturedCard already shows
headMessage as fallback). Adding it costs 25 lines and zero runtime cost when
unused. Even if only 10% of users set it, those 10% get a better experience
with no downside for the other 90%.

**Strongest case against C (workflow prompts)**:
`goal` on `start_workflow` makes workflow changes unnecessary. Agents already
know the goal at call time. Making workflows also prompt for it is redundant and
creates maintenance overhead. The `start_workflow` field is the right seam.

**What tips toward C anyway**: The tool input description can only do so much.
Explicit workflow steps that say "set goal in your context" create a stronger
norm. But this is a workflow quality concern, not a core UX fix.

## Resolution Notes

**Selected: D (full) with B as the shippable MVP**

B ships first as the immediate UX fix. C (workflow prompt updates) is a
follow-up that improves quality without being blocking.

## Decision Log

### Selected approach: B ships first, C as follow-up

**Why B over A**: Git branch description is free to add, visually occupies the
right slot (FeaturedCard subtitle), and serves users who want to document branch
intent. Cost is negligible when unused.

**Why B before C**: `start_workflow.goal` closes the session start gap
immediately for all workflows without any workflow changes. C improves the norm
but is optional.

**Why not `task_description` workspace anchor**: Same outcome as `goal` on
`start_workflow` but more complex (closed-set union requires 3 file changes vs
1 field on existing input). No advantage.

## Final Summary

### Recommended implementation

**Phase 1 (this PR):**
1. Add `goal?: string` to `V2StartWorkflowInput` -- emits `context_set:initial`
   event at session start; populates `sessionTitle` immediately
2. Read `git config branch.<name>.description` in `worktree-service.ts` --
   surface as `description?: string` on `ConsoleWorktreeSummary`
3. Display branch description in `FeaturedCard` as a subtitle (muted text,
   below recap/commit message, above git badges)

**Phase 2 (workflow updates):**
4. Update `coding-task-workflow-agentic.v2.json` Phase 0 to prompt `goal`
5. Update `mr-review-workflow.agentic.v2.json` to confirm `mrTitle` is set
6. Update `wr.discovery` intake to prompt `goal`
7. Add `goal` recommendation to `start_workflow` tool description (stronger than
   current empty description)

### What this achieves

| Scenario | Before | After Phase 1 |
|---|---|---|
| New session, just started | Empty card headline | "implement OAuth refresh token rotation" |
| Branch with annotated description | headMessage fallback | "OAuth refresh token work" subtitle |
| Multi-workflow branch (active) | Most recent recap | recap + branch description subtitle |
| Multi-workflow branch (all done) | Most recent recap | Most recent recap + branch description |

### Confidence: High

Both mechanisms are additive, optional, and degrade cleanly. No breaking changes.
