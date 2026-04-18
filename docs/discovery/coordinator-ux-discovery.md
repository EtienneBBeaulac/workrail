# Coordinator UX Discovery

**Date:** 2026-04-18
**Status:** In progress (WorkRail wr.discovery session)

**Artifact strategy:** This document is for human readability only. Execution truth (findings, decisions, context variables) lives in WorkRail session notes and context fields. If a chat rewind occurs, this file may diverge from the canonical record -- consult session notes for ground truth.

---

## Context / Ask

**Stated goal (solution-framed):** What should the first coordinator script template look like from the user's perspective -- how does someone invoke it, what do they see, what does it produce?

**Reframed problem (problem-framed):** How can a user kick off a multi-session AI workflow with a single action, stay informed without babysitting it, and receive a structured result -- all with less total effort than running Claude Code sessions manually?

**Original solution framing rejected because:** "coordinator script template" prescribes the mechanism without first identifying what pain it solves. A declarative invocation (`worktrain run pr-review`) could satisfy the same need with less user friction than a script the user maintains.

---

## Path Recommendation

**Path chosen: `design_first`**

Rationale: The goal was a solution-statement. The risk is designing the wrong interface, not lacking enough landscape knowledge. The backlog already contains a detailed vision of the coordinator architecture (Apr 15 entries). The gap is not "what are the options" -- it is "what does the user actually experience, step by step, and where does that differ from what the backlog assumes?"

---

## Constraints / Anti-goals

**Core constraints:**
- Must be better than Claude Code at the specific "review this PR" task (measurably, not just narratively)
- Must not require the user to write or maintain scripts (that is the developer's job, not the user's)
- First version must prove coordination works with real data, not a demo
- Must be buildable against what `worktrain spawn` / `worktrain await` already ship (Tier 3, Apr 18 backlog)

**Anti-goals:**
- Not a general workflow builder / no-code tool
- Not a replacement for Claude Code on single-session tasks
- Not dependent on cloud infrastructure or webhooks for the first version
- Not an analytics dashboard (that is a separate backlog item)

---

## Landscape Packet

### What exists today (Apr 18, 2026)

**CLI commands available:**
- `worktrain init` -- onboarding, setup
- `worktrain tell <message>` -- queue async message to daemon
- `worktrain inbox` -- read daemon outbox messages
- `worktrain spawn -w <workflow> -g <goal> -W <workspace>` -- non-interactive session start, prints session handle
- `worktrain await -s <handles> [-m all|any] [-t timeout]` -- block until sessions complete, prints JSON results
- `worktrain daemon [--install|--uninstall|--status]` -- daemon lifecycle
- `worktrain console` -- standalone console UI
- `worktrain logs [--follow] [--session <id>]` -- daemon event log reader
- `worktrain status <sessionId>` -- per-session health summary

**What spawn/await enable today:**
`worktrain spawn` prints a session handle to stdout. `worktrain await` blocks until sessions complete and prints structured JSON results. These two commands are the building blocks for a coordinator script.

**The MR review workflow (mr-review-workflow-agentic):**
- 8+ phases: locate/bound/classify, hypothesis, freeze fact packet, reviewer family bundle (parallel), contradiction resolution, adversarial validation, final recommendation, handoff
- Produces: severity-graded findings (Critical/Major/Minor/Nit), recommendation (approve/request changes/needs discussion), confidence band, coverage ledger, ready-to-post MR comments
- Output lives in `notesMarkdown` and context variables -- no automatic post to GitHub
- `requireConfirmation` gates exist for THOROUGH/High-risk reviews

**What WorkTrain cannot do yet (key gaps from backlog):**
1. Multi-phase work is invisible -- sessions are flat in console; a 5-session pipeline looks like 5 unrelated sessions
2. No coordinator scripts -- spawn/await exist but no coordinator template runs a full pipeline
3. No auto-commit -- agents write code but don't commit or open PRs autonomously
4. No notifications -- daemon completes work silently
5. Assessment gates unreliable -- not yet validated end-to-end
6. Subagent delegation invisible -- spawn_agent creates proper child sessions, but workflows still use mcp__nested-subagent__Task for most delegation (invisible black box)
7. No artifact store -- agents dump markdown in the repo as a workaround
8. Context poverty -- each session starts from scratch, no persistent knowledge graph

**Daemon event log format (real session, Apr 18):**
- Events are JSONL: `{"kind":"session_started","sessionId":"...","workflowId":"...","workspacePath":"...","ts":...}`
- `tool_called` events show tool name and truncated args summary
- `session_completed` shows outcome: success/error/timeout
- Events are correlated by `sessionId` (UUID) -- no human-readable session name
- `worktrain status <sessionId>` aggregates: LLM turns, step advances, tool calls, issues, last activity

**Scripts-first coordinator (backlog Apr 15):**
The backlog explicitly describes the coordinator as a shell/TypeScript script that uses `worktrain spawn` / `worktrain await` as primitives. The coordinator is NOT an LLM agent -- it is a deterministic script driving a DAG of leaf sessions. This is the architectural commitment already made.

**Live status briefings (backlog Apr 15):**
Vision exists for `worktrain status --workspace` that produces a human-readable briefing (what's running, why, where it is, queue, recently completed, blocked). Not yet implemented.

---

## Problem Frame Packet

### The real gap

The user today does the coordinator's job manually:
1. Opens a new Claude Code session
2. Types "review PR #47"
3. Waits ~20-40 minutes
4. Reads the output
5. Decides what to do next (fix something? re-review? merge?)

With a coordinator, steps 1-5 become one command that returns a result. The coordinator handles the sequencing. The user only re-engages when the pipeline produces a result or hits a decision point.

**What makes this categorically better than Claude Code:**
- Parallelism: reviewer families run simultaneously (Claude Code is serial)
- Persistence: coordinator can restart a failed session without user intervention
- Structure: output is a graded findings JSON, not a prose wall
- Routing: coordinator decides "clean -> merge queue, needs fixes -> spawn fix agent" without asking the user
- History: `worktrain logs --session <id>` shows exactly what happened and why

**The "needs human" path:**
Not every PR review ends cleanly. The coordinator must surface decision points without requiring the user to babysit. Today: silent. The user must poll `worktrain inbox`. Needed: a push notification (even just a Terminal notification or a message written to a designated file the user watches).

---

## Landscape Synthesis

**Precedents:**
1. Scripts-first coordinator pattern (backlog Apr 15) -- the committed architecture: deterministic shell/TS script calling `worktrain spawn` / `worktrain await`, not an LLM coordinator
2. `worktrain status --workspace` vision (backlog Apr 15) -- committed UX vision for a human-readable briefing during execution (not yet implemented)
3. Real event log format (daemon JSONL, Apr 18) -- events are UUID-correlated, tool_called with truncated args; the raw material for a feedback layer

**Hard constraints grounded in code:**
- No auto-post to GitHub -- MR review output lives in session notes; posting requires explicit user action
- No push notifications -- daemon completes work silently; user must poll `worktrain inbox` or watch `worktrain logs`
- Sessions appear flat in console -- no parent-child grouping for coordinator-spawned sessions
- `worktrain spawn/await` merged but not yet tested end-to-end in a real coordinator

**Contradictions:**
1. "Coordinator script template" in the framing implies the user writes or maintains scripts -- but the intended design is that the developer provides a pre-built `coordinator-groom-prs.sh`; the user just invokes it. The template is a developer artifact, not a user artifact.
2. The event log is UUID-keyed with no human names -- but a useful feedback loop needs to surface "which PR is being reviewed" not "sess_abc123 advanced step 3". A translation layer is needed.

**Evidence gaps:**
1. No real-world end-to-end test of `worktrain spawn/await` in a coordinator (known, from backlog)
2. No empirical data on full pipeline duration (how long does a 3-5 session MR review take total?)

## Candidate Directions

**Generation expectations (must be met for this design_first, full-rigor pass):**

1. **At least one reframing direction** -- not just "a coordinator with better UX" but a direction that challenges the coordinator abstraction itself or inverts the design assumptions
2. **Span the invocation spectrum** -- from "user types nothing, daemon just runs" to "user types a named command" to "user runs a script directly"
3. **Include the minimal viable single-session option** -- explicitly compare a single `worktrain spawn` with notification against a full coordinator; this tests the riskiest assumption
4. **Concrete terminal session transcripts** -- each candidate must include a 3-5 line sample of what the user actually sees, not just a description
5. **No clustering** -- if 3 of 4 candidates are "coordinator with different flag styles," one of them must be replaced with a genuinely different direction

### Candidate A: Minimal viable single-session with notify (tests riskiest assumption)

**One sentence:** Add a `worktrain review <pr>` command that spawns a single MR review session, prints the handle, and writes the result to `worktrain inbox` when done -- no coordinator, no script to maintain.

**Terminal session:**
```
$ worktrain review 47
Reviewing PR #47: "feat(engine): add OAuth refresh token rotation"
Session started: sess_4cd0b579 (mr-review-workflow-agentic)
Run 'worktrain logs --follow --session sess_4cd0b579' to watch progress.
Run 'worktrain inbox' when done.
^  Takes ~20-30 min. You can do other things.
```

- Tensions resolved: invocation simplicity, output discoverability (inbox)
- Tensions accepted: no parallelism (serial session), no coordinator routing, user decides next step manually
- Failure mode: session silently fails or gets stuck; no retry logic; user polls inbox and finds nothing
- Pattern relationship: follows existing spawn command; adds a thin `review` alias with PR context lookup
- Philosophy: honors 'validate at boundaries' (PR number validated immediately), 'errors as data' (failure appears in inbox)
- Scope judgment: **too narrow** -- proves the MVP invocation but not coordination; does not address the parallelism/persistence advantages of a real coordinator

---

### Candidate B: Named coordinator pipeline -- `worktrain run pr-review <pr>` (recommended)

**One sentence:** Add a `worktrain run pr-review <pr>` command that drives a pre-built TypeScript coordinator (`src/coordinators/pr-review.ts`), runs reviewer families in parallel via `spawn` + `await`, prints progress lines during execution, and produces a `pr-review-<n>.md` file and a `gh pr comment` command.

**Terminal session:**
```
$ worktrain run pr-review 47
PR #47: feat(engine): add OAuth refresh token rotation (3 files, +142/-18)
Base: main (merge-base: abc1234)

[1/3] Context gathering...  done (1m 12s)
[2/3] Running 3 reviewer families in parallel...
      correctness_invariants  running (3m 20s)
      philosophy_alignment    done (2m 45s)
      runtime_production_risk running (4m 01s)
[2/3] Reviewer families complete (4m 33s)
[3/3] Synthesizing...  done (45s)

RESULT: Request changes (HIGH CONFIDENCE)
  Critical: Token expiry not validated before refresh -- sessions silently extend past max lifetime
  Coverage: correctness_invariants ✓  philosophy_alignment ✓  runtime_production_risk ✓

Full review: pr-review-47.md
Post comment: gh pr comment 47 --body-file pr-review-47-comment.md
```

- Tensions resolved: invocation simplicity, feedback richness (progress lines with timing), structured output (file + 3-line summary), happy path vs. needs-human distinction (RESULT line)
- Tensions accepted: script maintenance (TypeScript coordinator module), discoverability (user must know `worktrain run` exists)
- Failure mode: one reviewer session fails; coordinator produces partial results with explicit coverage gaps
- Pattern relationship: adapts existing CLI command pattern (commander.js) and spawn/await primitives; adds `run` subcommand with coordinator registry
- Philosophy: honors 'errors as data' (partial failure appears as coverage gap, not silent exit), 'make illegal states unrepresentable' (RESULT line forces unambiguous recommendation), 'determinism over cleverness' (routing is scripted, not LLM), 'surface information' (progress lines)
- Scope judgment: **best-fit** -- delivers coordination, parallelism, and structured output; builds on today's primitives; no new daemon infrastructure needed; can evolve toward daemon-native (Candidate C) later

---

### Candidate C: Daemon-native coordinator with `worktrain tell` (too broad for v1)

**One sentence:** The coordinator lives in the daemon as a named pipeline; the user invokes it with `worktrain tell "review PR #47"` and checks `worktrain inbox` or `worktrain console` for the result.

**Terminal session:**
```
$ worktrain tell "review PR #47"
Queued: pr-review pipeline for PR #47 (check inbox or console for result)

[...20-30 min later...]

$ worktrain inbox
  [2026-04-18 14:32] PR #47 review complete
  RESULT: Approve (MEDIUM CONFIDENCE)
  1 minor finding: missing test for refresh token edge case
  Full review: ~/git/repo/pr-review-47.md
  Post: gh pr comment 47 --body-file ~/git/repo/pr-review-47-comment.md
```

- Tensions resolved: invocation simplicity (natural language), integration with daemon ecosystem
- Tensions accepted: feedback gap (async; no real-time progress without console running), dependency on console for visibility
- Failure mode: daemon dies mid-pipeline; user polls inbox and finds nothing; silent failure
- Pattern relationship: follows tell/inbox pattern already in CLI; requires daemon pipeline routing logic (does NOT exist yet)
- Philosophy: honors 'validate at boundaries' (daemon validates message format), but struggles with 'make illegal states unrepresentable' (polling is silent on failure)
- Scope judgment: **too broad for v1** -- requires daemon pipeline routing, console DAG grouping (neither exists); right direction for v2 after Candidate B proves the pipeline

---

### Candidate D: Coordinator shell script in repo with `worktrain run` alias (backlog-committed design)

**One sentence:** A `scripts/coordinator-pr-review.sh` at repo root calls `worktrain spawn` + `worktrain await` + `jq` to produce a review; `worktrain run pr-review 47` is a thin alias that finds and runs it.

**Terminal session (what the user types -- in a second tab, optional):**
```
# Tab 1: run the coordinator
$ worktrain run pr-review 47
Spawning review sessions for PR #47...
  sess_abc123 (context-gathering)
  sess_def456 (reviewer-families)
  sess_ghi789 (synthesizer)
Awaiting all sessions (timeout: 30m)...
[...silence for 20+ min unless user opens Tab 2...]
Done.

RESULT: Request changes
  Critical: Token expiry not validated
  pr-review-47.md written.

# Tab 2 (optional): watch progress
$ worktrain logs --follow
[14:02:15] [sess_abc] step_advanced  -> step advanced
[14:04:32] [sess_def] tool_called  tool=Bash args="gh pr diff 47 | head..."
```

- Tensions resolved: flexibility (script is readable/modifiable), transparency, buildable on today's primitives
- Tensions accepted: feedback gap (Tab 2 required for visibility; UUIDs in log require --session filter), script discoverability
- Failure mode: user does not open Tab 2; 20+ minutes of silence is the DEFAULT experience; not better than Claude Code on the feedback dimension
- Pattern relationship: directly implements backlog Apr 15 `coordinator-groom-prs.sh` design
- Philosophy: honors 'determinism' and 'functional/declarative' (script is pure shell logic); struggles with 'surface information' (silence is default)
- Scope judgment: **best-fit for first prototype** but worst on feedback UX; evolves naturally into Candidate B by adding the progress line printing to the script

---

## Problem Frame Packet

### Primary users

**Autonomous developer (primary):** Uses WorkTrain to run multi-session work while doing other things. CLI-comfortable, knows what `worktrain spawn` does, but does not want to babysit the pipeline. Wants to delegate the cognitive work and be notified of the result.

**WorkTrain developer (secondary):** Builds the coordinator template. This discovery is about the end-user experience, not the template author.

### Jobs / outcomes

- "I want to review PR #47 before merging it, without spending 30 minutes in a Claude Code session"
- "I want to know the review is happening without watching it happen"
- "I want the result to tell me whether to merge, fix, or escalate -- not just a wall of findings"

### Tensions

1. **Feedback tension:** Silent coordination feels like a black box, but verbose coordination interrupts focus. The ideal is ambient awareness -- the pipeline runs, the user gets a summary when it matters.
2. **Trust tension:** "Did it really review all the important things?" The coverage ledger is crucial, but currently buried in session notes. Trust requires the coverage ledger to be surfaced in the output.
3. **Decision tension:** The coordinator should auto-route clean PRs, but humans need to stay in the loop for blocking findings. The boundary between "coordinator decides" and "coordinator asks human" is the hardest design choice.
4. **Invocation tension:** Multiple valid invocation models exist -- named pipeline (`worktrain run pr-review 47`), script (`./scripts/groom-prs.sh`), or daemon tell (`worktrain tell "review PR #47"`). Each has different friction profiles.
5. **Output tension:** MR review produces ready-to-post comments but does not auto-post. First version should produce a file + print a `gh` command, not auto-post -- removes friction while preserving human review of the review.

### Success criteria (concrete, observable)

1. User types one command referencing the PR (number or URL) and nothing else
2. Within 30 seconds of invocation, something appears showing the pipeline is running (not silence)
3. When the pipeline completes, the user sees a 3-line summary: recommendation, top finding, suggested action
4. Full findings are in a deterministic file location (e.g., `mr-review-47.md` or a `gh pr comment` draft)
5. User can distinguish "pipeline ran to completion" from "pipeline stopped due to an error"
6. Total time the user spends actively engaged (not waiting) is under 2 minutes

### HMW reframes

- "HMW make the feedback loop feel like a teammate update rather than a log stream?" -- reframes UX from "what events are happening" to "what should I know right now"
- "HMW design the invocation so users never have to remember flags or workflow IDs?" -- reframes from "CLI command with flags" to "named workflow shortcut"

### Primary framing risk

The design assumes the user wants to manually trigger reviews. But if `triggers.yml` already auto-triggers MR review on every push, then the invocation problem is already solved -- and the real gap is OUTPUT and FEEDBACK design, not invocation. If daemon auto-trigger is the primary path, "what does the user type to kick off a review?" is the wrong question. The right question becomes: "what does the user see when the daemon auto-triggers a review it already started?"

## Challenge Notes

### Challenged assumptions

1. **Script template is the right abstraction** -- users may not want to write/maintain scripts. They want `worktrain run pr-review #47`. The "template" is for the developer building WorkTrain, not the end user. The user-facing interface should feel like a named command, not a script invocation.

2. **Coordination is the first thing to prove** -- visibility may be the bigger gap. If a coordinator runs silently for 30 minutes and the user has no idea what's happening, it feels worse than Claude Code (where you at least see the typing). The first coordinator template must include a feedback loop, even a minimal one.

3. **Better than Claude Code is achievable on the first template** -- only if it adds something Claude Code structurally cannot do. Parallel reviewer families is the clearest candidate. A sequential coordinator that is just slower Claude Code with more setup cost is a regression.

---

## Resolution Notes

*(To be populated after candidate generation and challenge steps)*

---

## Decision Log

### Decision 1: Selected direction -- Candidate B with Candidate D as proof-of-concept step

**Date:** 2026-04-18

**Winner: Candidate B** -- `worktrain run pr-review <pr>` with TypeScript coordinator module + progress lines + structured output file

**Runner-up: Candidate D** -- shell script coordinator; acceptable fallback if TypeScript module proves too costly

**Why B won:**
- Only candidate with real-time feedback built in (progress lines during execution)
- RESULT line enforces unambiguous happy path vs. needs-human distinction
- Structured output (file + gh command) is cleanest delivery mechanism
- Routing and persistence value (coordinator decides next step) is the real differentiator over single-session, not parallelism

**Why the runner-up is real:**
D can reach B-quality UX by adding progress lines to the shell script. If B's TypeScript module proves too costly to build or maintain, D with progress lines is an acceptable substitute.

**Challenge findings that changed the analysis:**
1. **Progress lines require a custom polling loop, not just `worktrain await`.** The current `await` command blocks until done; it does not stream. Real-time progress lines require the coordinator to poll `worktrain status <session-id>` in a loop while waiting. This is extra implementation work beyond the basic spawn/await pattern.
2. **Reviewer family parallelism already exists within a single session.** The MR review workflow (Phase 3) already runs reviewer families in parallel via `mcp__nested-subagent__Task`. The coordinator's value for single-PR review is routing and persistence, not parallelism. This makes Candidate A (single session) closer to B than initially assessed for single-PR use -- but B still wins on the output/routing/persistence dimensions.

**Accepted tradeoffs:**
- Custom polling loop needed for progress lines -- **REQUIRED for first version** (not optional; without it the core feedback promise is broken)
- TypeScript coordinator module must track workflow output schema changes -- **schema validation gate REQUIRED for first version**
- Coordinator value for single-PR is routing + persistence (not parallelism -- that's already in the workflow)
- Partial failure marking REQUIRED -- failed reviewer session must be explicitly labeled, not silently absent (honoring "make illegal states unrepresentable")

**Failure modes:**
1. `worktrain await` not streaming -- coordinator polling loop must be built
2. Coordinator output schema couples to workflow handoff artifact key names
3. If workflow updates without coordinator update, partial results appear without explanation

**Switch trigger to Candidate D:**
If TypeScript coordinator module requires >2 days to build or couples too tightly to CLI infrastructure.

---

## Final Summary

### Recommendation

**Selected direction: Candidate B as UX spec** -- `worktrain run pr-review <pr>` with a coordinator that uses spawn + await + progress polling loop + structured output file.

**Build sequence (Candidate D first, B target):**
1. Build `scripts/coordinator-pr-review.sh` (shell script using `worktrain spawn` + `worktrain await` + progress polling loop + `jq` output transform)
2. Add `worktrain run pr-review <pr>` as a thin wrapper calling the script
3. If shell script proves sufficient: DONE. No TypeScript migration needed.
4. If shell script becomes unwieldy: migrate logic to `src/coordinators/pr-review.ts` TypeScript module

**Confidence band: HIGH**

**Strongest alternative: Candidate D with progress lines** -- the shell script approach satisfies ALL acceptance criteria; TypeScript migration is optional.

**What "better than Claude Code" actually means for this use case:**
- NOT parallelism within a single PR review (reviewer families already parallel inside the workflow)
- YES: routing decisions (coordinator decides next step without user; reading session JSON is the coordinator's job)
- YES: persistence (coordinator can restart a failed session without user intervention)
- YES: structured output (file + gh command; not a prose wall in session notes)
- YES: zero babysitting minutes (user types one command and is done; checks back when done)

### Required first-version implementation constraints

1. **Progress polling loop** (REQUIRED) -- coordinator must poll `worktrain status <id>` every 30s during await; `worktrain await` alone is silent for 20+ min
2. **Output schema validation** (REQUIRED) -- validate all expected JSON keys from await output; emit explicit error on missing keys; never print recommendation without backing data
3. **Partial failure marking** (REQUIRED) -- failed reviewer session must be explicitly labeled in output; not silently absent

### Residual risks

1. **Spawn/await end-to-end not validated** -- per backlog Apr 18, `worktrain spawn/await` is "merged but needs real-world test." The first coordinator build will surface any integration bugs.
2. **Schema coupling** -- coordinator reads `findings`, `recommendation`, `coverageLedger` from await JSON; if workflow output schema changes, coordinator must update. Mitigation: schema validation gate + workflow version header.
3. **Riskiest assumption still open** -- if users find that `worktrain review 47` (single session, Candidate A) satisfies their needs on first 5 PRs, the coordinator layer may be unnecessary for single-PR use. Observable after first real-world use.

### Exact invocation (concrete UX spec)

**What the user types:**
```
worktrain run pr-review 47
```
(or with full URL: `worktrain run pr-review https://github.com/owner/repo/pull/47`)

**What the user sees during execution (Candidate D -- proof-of-concept, single session):**
```
PR #47: feat(engine): add OAuth refresh token rotation  (3 files, +142/-18)
Base: main  merge-base: abc1234
Session: sess_4cd0b579  (mr-review-workflow-agentic)

Watch raw events: worktrain logs --follow --session sess_4cd0b579

Running review...  step 1/8 (0:15)
Running review...  step 2/8 (1:30)
Running review...  step 4/8 (5:22)
Running review...  step 7/8 (18:45)
Done (22:31)
```

**What the user sees during execution (Candidate B -- target, multi-session coordinator):**
```
PR #47: feat(engine): add OAuth refresh token rotation  (3 files, +142/-18)
Base: main  merge-base: abc1234

Watch raw events: worktrain logs --follow

[1/3] Context gathering...  running (0:15)
[1/3] Context gathering...  done (1:12)
[2/3] Reviewer families (3 parallel)...  running
      correctness_invariants    done (2:45)
      philosophy_alignment      done (2:01)
      runtime_production_risk   running (3:20)
[2/3] Reviewer families...  done (4:33)
[3/3] Synthesizing...  done (0:45)
```

*Note: The multi-session display (B) is the target UX. The single-session display (D) is what ships first.*

**What the user gets when it's done:**
```
RESULT: Request changes  [HIGH CONFIDENCE]
  CRITICAL  Token expiry not validated before refresh -- sessions extend past max lifetime
            src/auth/token-service.ts:142

Coverage: correctness_invariants OK  philosophy_alignment OK  runtime_production_risk OK

Full review:    ./pr-review-47.md
Post comment:   gh pr comment 47 --body-file ./pr-review-47-comment.md
```

**Happy path vs. "needs human" distinction:**
- `RESULT: Approve` -- coordinator ran to completion; PR is clean; user can post comment and merge
- `RESULT: Request changes` -- coordinator ran to completion; blocking or critical findings; user reads findings file and decides
- `RESULT: [PARTIAL] Unable to complete` -- one or more reviewer sessions failed; user must review manually with `worktrain logs --session <id>`
- All three states are UNAMBIGUOUS from the RESULT line

**Minimum viable version that proves coordination works:**
The shell script coordinator (`scripts/coordinator-pr-review.sh`) with:
- `worktrain spawn` for each session
- Progress polling loop (30s status prints)
- `worktrain await` for structured JSON results
- `jq` for output transformation
- Schema validation and partial failure marking
- Written to `pr-review-<n>.md` + printed `gh pr comment` command

This is the minimum that is BETTER than Claude Code in ways that matter: zero babysitting, structured output, explicit routing decision, unambiguous result state.
