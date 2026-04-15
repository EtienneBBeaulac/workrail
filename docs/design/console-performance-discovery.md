# Console Performance: Architecture Discovery

**Status:** In Progress  
**Date:** 2026-04-06  
**Path:** full_spectrum  
**Artifact strategy:** This document is the human-facing canonical artifact. Notes and execution truth live in-session.

---

## Context / Ask

The workrail MCP server is consuming 140% CPU due to a three-part feedback loop in the console's live session/worktree tracking system.

**The loop:**
```
session write -> fs.watch fires -> SSE 'change' broadcast ->
  queryClient.invalidateQueries(['worktrees']) ->
    /api/v2/worktrees: 606 concurrent git subprocesses (12.5s) ->
      session write from the next continue_workflow -> repeat
```

**Three root causes:**
1. `watchSessionsDir()` in `console-routes.ts` uses `fs.watch(sessionsDir, { recursive: true })`. Every `continue_workflow` call writes 2+ files, each firing the watcher. A 200ms debounce exists but is insufficient - it collapses writes within 200ms but a session write from the _response_ to a worktrees fetch triggers a new event.

2. `useWorkspaceEvents()` in `console/src/api/hooks.ts` calls `queryClient.invalidateQueries(['worktrees'])` on every SSE `change` event with no cooldown - bypassing the `staleTime: 20_000` entirely. `invalidateQueries` marks the cache as stale and triggers an immediate refetch when the component is mounted.

3. `/api/v2/worktrees` in `console-routes.ts` calls `getWorktreeList()` which fans out to all repo roots from sessions. With 101 discovered worktrees (79 from a stale zillow-android-2 session), each enriched with 6 git commands run in parallel, that is 606 concurrent git subprocesses. Each request takes 12.5 seconds.

**Goal:** Keep the console live and reactive. Fix the CPU spiral architecturally - not with band-aids.

## Path Recommendation

**Selected path:** `full_spectrum`

**Rationale:**  
- `landscape_first` would miss the framing risk: "is the current model right at all?" The worktrees view is modeled as a live-refresh-on-session-change resource, but worktrees change on a fundamentally different timescale than sessions. That mismatch is a design flaw, not just a performance gap.
- `design_first` would miss the landscape: there are well-established patterns for live git status (VS Code Source Control, GitLens, tig, LazyGit) that are directly relevant to the solution.
- `full_spectrum` is right because both landscape grounding (what models work for live git status at scale?) and reframing (are sessions and worktrees the right unit of reactivity?) are equally important.

## Constraints / Anti-goals

**Constraints:**
- Console must stay reactive - real-time session state and worktree status are core value
- No feature removal
- Architectural fix - must change invariants, not add special cases
- The fix must hold even when a single active `continue_workflow` session is running (the primary use case)

**Anti-goals:**
- Do not just add a client-side debounce timer
- Do not remove SSE-driven live updates
- Do not reduce information density of the worktrees view
- Do not require rewriting the session persistence layer

---

## Landscape Packet

### Current State Summary

The system has three layers:
1. **Server-side watch** (`console-routes.ts`): `fs.watch` on `~/.workrail/sessions/` with a 200ms debounce. Every file write (session events, snapshots, recaps) triggers the watcher. A single `continue_workflow` call writes 2-4 files.
2. **Client-side SSE consumer** (`hooks.ts`): `useWorkspaceEvents()` subscribes to `/api/v2/workspace/events` and calls `queryClient.invalidateQueries` for both `['sessions']` and `['worktrees']` on every `change` event. `staleTime` on `useWorktreeList` is 20s, but `invalidateQueries` bypasses it by marking the entry stale before the timer fires.
3. **Worktree enrichment** (`worktree-service.ts`): `getWorktreeList()` reads repo roots from sessions (no TTL on active sessions, 60s TTL on the repo root set). For each repo root, runs `git worktree list --porcelain` then for each worktree runs 6 git commands in parallel via `Promise.allSettled`. No concurrency cap across repos or worktrees.

### Existing Approaches / Precedents

**VS Code Source Control / GitLens:**
- Use `fs.watch` on `.git/` directory only (not recursive on the whole worktree).
- Maintain a git status cache keyed by repo root.
- Debounce the watcher with 400-800ms delays.
- Only re-scan dirty repos (tracking which repos have pending changes).
- Do NOT invalidate git status on every file write in the workspace.

**LazyGit / tig:**
- Poll on a fixed interval (configurable, default 2-4s).
- Do not react to every file change.
- Separate "refresh" (full rescan) from "watch" (detect dirty state cheaply).

**Tower / Sourcetree (GUI git clients):**
- Maintain a persistent background process per repo.
- Use a dedicated watcher per `.git/HEAD` and `.git/refs/` to detect branch/commit changes.
- Separate worktree file status from branch/commit status.

**React Query patterns:**
- `invalidateQueries` is designed for explicit user actions or focused events (e.g., "the user just did X that would change Y").
- For background sync, the correct pattern is `refetchInterval` + `staleTime`, not invalidation on every external event.
- Invalidation is appropriate when the event type is semantically tied to the data type. A session write event is NOT semantically tied to worktree git status.

**SSE patterns for developer tooling:**
- The standard pattern is to send typed/scoped events, not a generic `change` broadcast. Scoped events let subscribers react only to what concerns them.
- e.g., `{ type: "session:updated", sessionId: "..." }` vs `{ type: "change" }`.
- Generic `change` events force every subscriber to decide whether their data is affected, with no information to make that decision correctly.

### Option Categories

Three broad option categories emerge:

**A. Fix the SSE semantics (event scoping):**  
Replace the generic `change` event with typed, scoped events (`session:updated`, `worktree:dirty`). The worktrees view only invalidates when a worktree-specific event arrives, not on session writes.

**B. Fix the query invalidation strategy (decouple sessions from worktrees):**  
Do not invalidate `['worktrees']` on SSE events at all. Let worktrees be governed by `refetchInterval` alone (e.g., 60s). Session events only invalidate `['sessions']`. The worktrees view becomes "near-realtime" (60s lag) rather than "instant."

**C. Fix the git subprocess fan-out (worktree data model):**  
Cache git enrichment results per worktree with a TTL. Only re-enrich worktrees that have actually changed (by comparing HEAD hash or index mtime). Bound concurrency with a semaphore. Separate expensive enrichment (git log, status, ahead/behind) from cheap existence checks.

**D. Combine A + C (scoped events + server-side git caching):**  
Server knows which repos/worktrees are dirty because it watches `.git/` directories. It only re-enriches dirty repos when a worktree-scoped event fires. Clients get typed events and only refetch worktrees when the server says something relevant changed.

### Contradictions / Disagreements

1. **The 200ms debounce exists but is insufficient:** The debounce collapses rapid writes, but because the worktrees refetch itself (12.5s) triggers more SSE events via session writes from the calling agent, the debounce is circumvented at a higher level. A longer debounce (e.g., 2s) would reduce frequency but not eliminate the loop.

2. **`staleTime: 20_000` was designed to prevent thrash but is bypassed:** The intent was clearly to limit worktrees fetches to once per 20s, but `invalidateQueries` bypasses stale time. This is a usage error in the hook, not a React Query limitation.

3. **The worktrees view conflates two different timescales:** Session events are high-frequency (every continue_workflow call). Git worktree state changes are low-frequency (developer switches branches, commits, etc.). Coupling them in the same invalidation event creates an impedance mismatch.

4. **The stale zillow-android-2 session is a symptom, not a root cause:** Even with 1 repo and 5 worktrees, the loop would still exist. The 79-worktree case makes the cost visible but removing that session is a band-aid.

### Evidence Gaps

1. How does the actual CPU usage break down? Is the 140% from git subprocess spawning, Node.js event loop overhead from SSE broadcasts, or I/O wait from the 12.5s requests queuing up?
2. Is there a way to detect when a worktree's git state has actually changed without running all 6 git commands? (e.g., watching `.git/refs/` and `.git/HEAD`)
3. How many concurrent console clients are typically active? (1 vs 5 changes the SSE broadcast impact significantly)

---

## Problem Frame Packet

### Users / Stakeholders

- **Primary user:** The developer running workrail locally while actively using it with an AI agent (Claude Code). They want to see live session progress and worktree state as they work.
- **Secondary user:** The developer checking the console dashboard between sessions. They want a quick overview of all their work across repos.
- **System stakeholder:** The MCP server itself. When the console consumes 140% CPU, the MCP server is starved of resources, degrading the actual agent execution that the console is meant to observe.

### Jobs / Goals / Outcomes

- **See session progress live** (high frequency need - every continue_workflow step)
- **See which worktrees are active, dirty, ahead of main** (low frequency need - changes on developer action)
- **Not have the developer tooling destroy the developer's machine performance** (system-level need)

### Pains / Tensions / Constraints

- **Tension 1:** Reactivity vs. cost. The most reactive system (re-fetch everything on every event) is also the most expensive. The goal is targeted reactivity - fast for what matters, lazy for what doesn't.
- **Tension 2:** Server simplicity vs. correctness. The simplest server-side fix (just adding a longer debounce or a server-side rate limiter on the worktrees endpoint) doesn't fix the root cause - the events and queries are semantically mismatched.
- **Tension 3:** The worktrees endpoint does real work (git). Other queries (sessions list) are cheap. Treating them identically in the invalidation strategy is wrong.

### Success Criteria

1. A single active `continue_workflow` session does not cause CPU to exceed 20% (down from 140%)
2. Session list updates still appear within 1-2 seconds of a session state change
3. Worktree status is still live (updates within 30-60s of a developer action, or faster if the server can detect the change cheaply)
4. The solution works correctly with 100+ worktrees across multiple repos without degradation
5. No regressions: stale session cleanup, session detail view, node detail view all still work

### Assumptions

- The console runs locally, co-located with the MCP server. Latency is not a concern.
- There is typically 1 console client connected at a time (single developer use case).
- Git worktree state changes at developer-action frequency (minutes to hours), not session-event frequency (seconds).
- The sessions directory watch is the right mechanism for session updates; the question is only what actions it should trigger.

### Reframes / HMW Questions

**Reframe 1:** "How might we make the worktrees view update when worktrees actually change, rather than when sessions change?"
- This reframe surfaces that the current coupling (session event -> worktrees refetch) is incorrect at the semantic level. Sessions and worktrees are different entities with different update rates.

**Reframe 2:** "How might we make the server do less work per request rather than making the client ask less often?"
- This reframe surfaces the server-side caching angle. Even with the SSE loop fixed, a 12.5s worktrees endpoint is too slow for a responsive console. The fix needs to address both the trigger frequency AND the per-request cost.

### What Would Make This Framing Wrong

- If it turns out the MCP server CPU is actually from something else entirely (e.g., the `fs.watch` watcher itself has a bug causing recursive firing), then fixing the invalidation chain is a red herring.
- If git operations on these repos are intrinsically slow for reasons other than concurrency (e.g., large pack files, network mounts), then concurrency capping won't help much.

---

## Phase 2: Decision Shape Synthesis

The landscape and framing stories are in agreement on the core issue and converge on a clear decision shape.

### Core Opportunity

The system has three coupled bugs that together create a feedback loop. Any single fix reduces harm but doesn't eliminate the loop. A proper architectural fix must address all three, or at minimum break the loop at one point while separately addressing the cost of the remaining path.

The dominant insight from the landscape: **the worktrees view and the sessions view should not share an invalidation trigger.** They are semantically different resources that change at different rates. The current design couples them through a single generic `change` event, which is the root cause of the loop.

### Decision Criteria (the winning direction must satisfy all of these)

1. **Breaks the feedback loop permanently** - a session write must not be able to trigger a 12.5s worktrees refetch in a tight loop
2. **Maintains session reactivity** - the sessions list and session detail must update within ~2 seconds of a session event
3. **Maintains worktree live-ness** - worktrees must update on a reasonable cadence that reflects actual git state changes, not just "slower"
4. **Scales to 100+ worktrees** - a large repo with many worktrees must not degrade the console
5. **Architecturally correct** - the fix must change the coupling invariants, not just slow down the loop

### Riskiest Assumption

The riskiest assumption is that server-side git caching (memoizing enrichment results with a TTL) will be sufficient to make the worktrees endpoint fast enough to serve on a short polling interval without needing the SSE-driven invalidation. If git enrichment is intrinsically slow regardless of caching (e.g., even a single pass of 101 worktrees takes 12.5s and there's no incremental approach), then the caching direction would need to be combined with a complete decoupling of worktrees from SSE.

### Remaining Uncertainty

Categorized as **recommendation uncertainty** - the evidence is sufficient to recommend a direction, but there is residual uncertainty about the right caching granularity and TTL values that can only be resolved through implementation.

### Candidate Count Target: 3-4 (STANDARD rigor)

---

## Candidate Directions

*(Path is `full_spectrum`, STANDARD rigor. Setup expectations: candidates must reflect both the landscape and the reframing. At least one direction must meaningfully change the coupling model, not just tune parameters.)*

---

### Candidate A: Typed SSE Events + Client-Side Routing (Event Scoping)

**Summary:** Replace the generic `{ type: "change" }` SSE event with typed, scoped events: `{ type: "session:updated", sessionId: "..." }` for session writes, and a separate `{ type: "worktree:dirty", repoRoot: "..." }` event that the server only emits when it detects actual git state changes (by watching `.git/HEAD` and `.git/refs/` directories per known repo). The client routes each event type to the appropriate query invalidation.

**Why it fits the path:**  
Directly addresses the semantic mismatch identified in the reframe. Sessions and worktrees become independently reactive. The server controls which events fire and when, so the client cannot accidentally over-invalidate.

**Strongest evidence for it:**  
This is the standard pattern used by VS Code, GitLens, and other dev tools. Typed events are more informative, more extensible, and prevent the coupling by construction. The landscape showed that generic `change` events force every subscriber to decide whether their data is affected - typed events eliminate that decision.

**Strongest risk against it:**  
The server now needs to watch `.git/HEAD` and `.git/refs/` per known repo. This adds watcher instances that need lifecycle management. If the known-repos set changes (new session from a new repo), the server needs to add a watcher dynamically. This adds complexity to `console-routes.ts`.

**When it wins:**  
When the primary goal is architectural correctness and the team has tolerance for the additional server-side watcher complexity. Best when the console's role as a developer tool (not an ops dashboard) is emphasized - developers trigger git state changes deliberately, and the server can detect them cheaply.

---

### Candidate B: Decouple Worktrees from SSE (Polling-Only for Worktrees)

**Summary:** Stop invalidating `['worktrees']` on SSE events entirely. Session events only affect `['sessions']`. The worktrees query is governed solely by `refetchInterval: 60_000` (or a configurable value). Separately, fix the git subprocess concurrency with a bounded semaphore (e.g., max 8 concurrent git processes). The feedback loop is broken because the trigger that caused it (SSE -> worktrees invalidation) is removed.

**Why it fits the path:**  
The simplest intervention that breaks the loop. Respects the reality that worktrees change at developer-action frequency, not session-event frequency. The reframe "make worktrees update when worktrees change" is satisfied by removing the incorrect trigger.

**Strongest evidence for it:**  
All existing git GUI clients (LazyGit, tig, Tower) poll worktree status on an interval rather than watching for changes. The 60s polling interval with concurrency capping would reduce peak CPU from 140% to a brief spike once per minute. LazyGit defaults to 2s refresh with a very cheap "is anything dirty?" check first.

**Strongest risk against it:**  
Worktrees feel "stale" when a developer switches branches or commits while the console is open. The 60s lag is acceptable for passive observation but feels wrong for active use (e.g., the developer wants to see their new commit reflected immediately). The solution partially degrades the "live" feel of the worktrees panel.

**When it wins:**  
When simplicity of implementation is paramount and the user accepts a 60s polling cadence for worktrees. This is the minimum viable fix that breaks the loop. It's also a necessary precondition for any other option - even if Candidate A is chosen, the worktrees query should not be on SSE without server-side filtering.

---

### Candidate C: Server-Side Git Cache with Incremental Enrichment

**Summary:** Add a server-side git enrichment cache keyed by `(repoRoot, branch, headHash)`. After the first full enrichment of a worktree, subsequent requests for the same HEAD commit return the cached result immediately (since git log, status, ahead/behind are deterministic for a given commit). Only worktrees where HEAD or index mtime has changed trigger re-enrichment. The worktrees endpoint goes from 12.5s to ~50ms for a cache-hit scenario. With fast responses, the worktrees query can be invalidated on session events without causing a spiral (since each invalidation is cheap).

**Why it fits the path:**  
Addresses the "server does too much work per request" dimension that the reframe surfaced. With a fast worktrees endpoint, the cost of occasional over-invalidation becomes negligible. This is an architectural fix to the data model layer.

**Strongest evidence for it:**  
Git log, status, and ahead/behind are deterministic for a given HEAD commit. A cache keyed on HEAD hash is correct by construction - stale data cannot appear as long as HEAD changes are detected. VS Code uses exactly this pattern: caches git decorations per commit hash.

**Strongest risk against it:**  
`git status --short` is NOT deterministic for a given HEAD - uncommitted working directory changes are not captured by HEAD hash. So the status (dirty/clean, changed files) would need a separate, cheaper invalidation mechanism (file watcher on the worktree directory, or a short TTL of 5-10s). This splits the cache into two tiers: commit-level (permanent) and working-directory-level (short TTL). Complexity increases.

**When it wins:**  
When high-frequency worktree refreshes (< 5s) are needed and the team has the appetite to implement a two-tier cache. Best paired with Candidate A (typed events) so the cache is only invalidated when real changes occur.

---

### Candidate D: Compound Fix - Decouple + Concurrency Cap + Session-Only SSE (Selected)

**Summary:** Three targeted changes that together eliminate the loop at every layer:
1. **SSE scoping** (`console-routes.ts`): The SSE `change` event is still generic, but the client only invalidates `['sessions']` in response to it (not `['worktrees']`). This breaks the loop immediately.
2. **Worktrees polling** (`hooks.ts`): `useWorktreeList` keeps its `refetchInterval: 30_000` but `useWorkspaceEvents` stops invalidating `['worktrees']`. The `staleTime` of 20s is actually respected now.
3. **Concurrency cap** (`worktree-service.ts`): Add a simple semaphore (max 8 concurrent git subprocesses) to `enrichWorktree`. This bounds the per-request cost from 606 concurrent to 8-at-a-time, reducing peak I/O from ~12.5s to a bounded, sequential enrichment. For 101 worktrees x 6 commands / 8 concurrent = ~76 sequential batches x ~50ms avg = ~3.8s per full request (vs 12.5s today).
4. **Stale session cleanup** (optional but high leverage): The `remembered-roots-store` should evict roots from stale/completed sessions older than N days. This is a separate concern but reduces the worktree count from 101 to something more reasonable.

**Why it fits the path:**  
Satisfies all 5 decision criteria. Breaks the feedback loop (change 1). Maintains session reactivity (SSE still fires for session events). Maintains worktree live-ness via polling (30s cadence). Scales better (concurrency cap). Architecturally correct (the coupling invariant is changed: sessions and worktrees are decoupled in the invalidation model).

**Strongest evidence for it:**  
The combination of "correct invalidation semantics" (change 1) and "bounded concurrency" (change 3) maps directly to what the landscape showed: no production tool couples session writes to worktree git fetches. The 30s polling interval for worktrees is consistent with what Tower and Sourcetree use in the background.

**Strongest risk against it:**  
The 30s polling cadence may feel unresponsive for active use. A developer who commits and switches branches wants the console to reflect that promptly. This is mitigated by: (a) the worktrees endpoint being faster due to the concurrency cap, so a manual refresh is snappy; (b) a future addition of Candidate A's typed SSE events for git state changes, which can be layered on top.

**What would change my mind between D and A:**  
If the implementation cost of server-side `.git/` watchers is low (it's maybe 20 lines of code per repo), Candidate A is strictly better and should replace the polling fallback in D. The key question is whether the `remembered-roots` set changes frequently enough that managing watcher lifecycle is a real problem or a theoretical one.

---

## Challenge Notes

**Strongest argument against the leading option (D):**

The 30s polling for worktrees is not actually a full fix - it's a regression in live-ness. If a developer is actively working (frequent commits, branch switches) the console will feel sluggish. The "real" fix requires the server to know when git state has changed. Candidate D essentially says "we'll check less often" rather than "we'll check at the right time."

Counter-argument: The current state is 140% CPU and a broken console. A 30s poll that is always correct is better than a "live" console that brings the machine to a halt. More importantly, the polling fix is independently valuable and is a precondition for everything else. Even if Candidate A is the long-term target, Candidate D is the right first ship. The loop fix (removing worktrees from SSE invalidation) is the core change; the concurrency cap is risk reduction; the polling cadence can be tightened later with the server-side watcher.

**Adversarial challenge: what if the framing is wrong?**

The framing assumes the CPU cost is from git subprocess fan-out. But what if the real cost is from the `fs.watch` watcher misfiring - e.g., the watcher itself has a bug on macOS where it fires continuously even without writes? 

Check: the code shows a 200ms debounce is already in place. If the watcher misfired continuously, the debounce would absorb it. The problem description says "every continue_workflow call writes 2+ files" - this is the trigger, not a watcher bug. The framing is correct.

**What challenge pressure changed:**  
The challenge confirmed that the polling regression is real but acceptable as a first step. It also sharpened the recommendation to call out "Candidate A as a natural follow-on" explicitly in the handoff rather than presenting D as the final answer.

---

## Decision Log

**Winner: Candidate D (Compound Fix)**  
**Runner-up: Candidate A (Typed SSE Events)**

**Why D won:**
- Breaks the feedback loop with the minimum number of changes
- All three changes are independent and can be shipped separately
- The concurrency cap is valuable independent of the loop fix (protects against large repos)
- The session/worktree decoupling is architecturally correct and does not degrade any existing functionality
- Can be implemented in hours, not days

**Why A lost (runner-up):**
- Server-side `.git/` watchers per known repo are the right long-term model but add lifecycle complexity
- Requires adding watcher management for a dynamic set of repos (as sessions discover new repos)
- The value of A is captured by adding it on top of D in a second pass
- A is strictly better for user experience (true live worktree updates) but D is better as the immediate fix

**Accepted tradeoffs:**
- Worktrees view will have a 30s refresh cadence instead of being SSE-driven
- The concurrency cap (8 processes) means the first cold request after restart takes longer to complete than a fully parallel request, but it won't saturate the CPU

**Identified failure modes:**
- If the sessions directory watch fires for reasons other than session writes (e.g., temp files from other processes), the loop could re-emerge. Mitigation: filter the watcher to only fire on `.jsonl` file changes.
- If the semaphore implementation is buggy (e.g., never releases), the worktrees endpoint hangs. Mitigation: use a well-tested semaphore pattern with a timeout.
- The stale session problem (79 zillow-android-2 worktrees) is not fixed by D. Even with concurrency capping, 101 worktrees takes ~3.8s. This needs a separate `remembered-roots` TTL or explicit session eviction.

**Switch triggers:**
- If after implementing D the worktrees view still feels unresponsive enough to impair daily use, add Candidate A's `.git/` watchers to enable typed SSE events for worktree state changes.
- If the worktrees endpoint is still slow after concurrency capping due to inherently slow git on the large repo, add Candidate C's per-worktree cache keyed on HEAD hash.

---

## Resolution Notes

**Resolution mode:** `direct_recommendation`

**Confidence band:** High (85-90%)

The three-part fix is grounded in:
- Direct code reading (not assumptions) of all three affected files
- Established precedent from VS Code, GitLens, and git GUI tools
- Clear causal chain from the problem description to the fix
- Each fix is independently testable

**Residual risks:**
1. Stale session problem (79 worktrees) needs separate attention - not addressed by the concurrency cap alone
2. The `.git/` watcher approach (Candidate A) is the right long-term model and should be tracked as a follow-on
3. macOS `fs.watch` reliability: the current watcher uses `{ recursive: true }` which is macOS-specific. The fix in change 1 (stopping worktrees invalidation) makes the watcher's behavior less critical, but the underlying reliability concern remains.

---

## Final Summary

### Selected Path
`full_spectrum` - because the problem required both landscape grounding (what do real git tools do?) and reframing (are sessions and worktrees the right reactivity unit?).

### Problem Framing
A feedback loop caused by semantic mismatch: session writes (high frequency, every continue_workflow step) are coupled to worktree git status fetches (should be low frequency, developer-action-triggered) through a generic SSE `change` event and an unconditional `invalidateQueries` call.

### Landscape Takeaways
- No production git tool couples session writes to git status fetches
- All live git tools either poll on an interval (LazyGit, tig) or watch `.git/HEAD` and `.git/refs/` specifically (VS Code, GitLens)
- `invalidateQueries` is for explicit user actions, not background sync; `staleTime` + `refetchInterval` is the correct React Query pattern for background data
- Typed SSE events are the standard for live developer tools; generic `change` events are an antipattern

### Chosen Direction: Candidate D (Compound Fix)

**Three changes, each independently valuable:**

**Change 1 - Break the loop (console/src/api/hooks.ts):**
```typescript
// Remove this line from useWorkspaceEvents():
void queryClient.invalidateQueries({ queryKey: ['worktrees'] });
// Keep only:
void queryClient.invalidateQueries({ queryKey: ['sessions'] });
```
This alone breaks the feedback loop. Worktrees are now governed solely by `refetchInterval`.

**Change 2 - Bound git concurrency (src/v2/usecases/worktree-service.ts):**
Add a process-level semaphore capping concurrent git subprocesses to 8. The `enrichWorktree` function currently runs 6 git commands in parallel per worktree; with 101 worktrees all enriched simultaneously, that's 606 concurrent processes. A semaphore wrapper around `enrichWorktree` (or around the `git()` helper) bounds this.

**Change 3 - Filter SSE watcher events (src/v2/usecases/console-routes.ts):**
The `fs.watch` callback currently fires for any file change. Filter to only broadcast when the change is to a `.jsonl` file (session event log), not every temp file write. This reduces SSE noise.

**Optional Change 4 - Stale session root eviction:**
Add a TTL (e.g., 30 days) to the `remembered-roots-store` so stale sessions from inactive repos don't permanently inflate the worktree count.

### Strongest Alternative
Candidate A (Typed SSE Events + server-side `.git/` watchers per repo). It's strictly better for user experience (true live worktree updates instead of 30s polling) but adds lifecycle complexity to the server. It's the right follow-on after D is shipped.

**Why it lost:** Implementation complexity of dynamic watcher management per known repo, and the loop fix in Change 1 is needed regardless. D is the right immediate ship; A is the right next evolution.

### Confidence Band
High (85-90%). All three fixes are grounded in direct code reading. The main residual uncertainty is whether the stale session problem (101 worktrees, 79 from zillow-android-2) needs addressing alongside the loop fix for the console to feel good in practice.

### Residual Risks
1. Stale session problem: 101 worktrees even with concurrency capping means ~3.8s per full worktrees request. Tracked separately.
2. Candidate A (`.git/` watchers) is the right long-term model - should be a follow-on ticket.
3. `fs.watch({ recursive: true })` has platform quirks on macOS/Linux - consider a future migration to a more reliable file watching library (chokidar).

### Next Actions
1. **Immediate:** Implement Change 1 (one-line fix in `hooks.ts`). This alone breaks the loop.
2. **Same PR:** Implement Change 2 (concurrency cap in `worktree-service.ts`). Protects against large repos.
3. **Same PR:** Implement Change 3 (filter watcher to `.jsonl` only). Reduces SSE noise.
4. **Follow-on ticket:** Add TTL to `remembered-roots-store` to evict stale session roots.
5. **Future ticket:** Implement Candidate A's typed SSE events (`session:updated`, `worktree:dirty`) with server-side `.git/` directory watchers for true live worktree reactivity.
