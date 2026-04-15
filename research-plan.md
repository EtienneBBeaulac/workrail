# Research Plan: WorkRail Console Workspace Tab UX Discovery

## Mission
Deep UX analysis of the Workspace tab to determine whether branch is the right primary organizational unit, and to surface tensions and assumptions in the current information architecture.

## Primary Targets

| File | Purpose |
|------|---------|
| `console/src/views/WorkspaceView.tsx` | Main view -- FeaturedCard, CompactRow, repo name rendering |
| `console/src/views/workspace-types.ts` | Domain logic -- sectionFor(), sortWorkspaceItems(), joinSessionsAndWorktrees() |
| `console/src/api/types.ts` | API data shapes -- session, worktree, repo fields available |
| `console/src/api/hooks.ts` | Data fetching -- what endpoints feed the view |

## Secondary Targets

| File | Purpose |
|------|---------|
| `console/src/views/WorktreeList.tsx` | Rendering conventions comparison |
| `console/src/views/SessionList.tsx` | Session listing patterns |
| `console/src/index.css` | Global styles, Tailwind config |

## Exclusions

- `console/src/components/` -- no workspace-specific components
- `console/src/lib/dag-layout.ts` -- DAG layout only, unrelated
- Test files -- not relevant to UX structure analysis
- Server-side code -- focus is on the console frontend

## Key Questions to Answer

1. **Repo visibility**: Exactly where is `item.repoName` rendered in WorkspaceView.tsx? What CSS classes (size, color, contrast)? Is it in FeaturedCard AND CompactRow? Hidden on mobile?

2. **Section model**: How does `sectionFor()` classify items? What are the thresholds for Active vs Recent? Edge cases: branch with uncommitted changes but no sessions; branch with only complete sessions from 25+ days ago?

3. **Sort order**: What is `sortWorkspaceItems()` doing? What is the priority order (section first? status? time)?

4. **Join logic**: In `joinSessionsAndWorktrees()`, what happens when a branch has sessions but no worktree? Worktree but no sessions? What is the resulting item shape?

5. **Tension analysis**: What is most/least prominent in the UI? Single-repo (1 repo, 5 branches) vs multi-repo (3 repos, 15 branches) experience? Does Active/Recent split add or reduce clarity?

## Depth Strategy (DEPTH focus)

- Read every relevant function in full -- do not skim
- Trace data flow from API fetch through join/sort/section to render
- Note exact CSS class names for visual hierarchy analysis
- Map all edge cases in conditional logic
- Identify implicit assumptions in the data model
- Look for what the code *cannot* represent (absent information, forced choices)
- Synthesize tensions: what does the code optimize for vs what the user might need?

## Deliverable

A detailed analysis document covering all five question areas, with specific line-level code references, identifying the core tensions in the current UX model.
