# WorkTrain Vision

## What WorkTrain is

WorkTrain is an autonomous software development daemon. It runs continuously in the background, picks up tasks from external systems (GitHub issues, GitLab MRs, Jira tickets, webhooks), and drives them through the full development lifecycle -- discovery, shaping, implementation, review, fix, merge -- without human intervention between phases.

The operator's job is to configure what WorkTrain works on and what rules it follows. WorkTrain's job is to do the actual work, autonomously, reliably, and correctly.

## The self-improvement loop

WorkTrain builds WorkTrain. This is not a metaphor -- it is the intended operating mode and the ultimate test of whether the system works.

WorkTrain runs the workrail repository as one of its own workspaces. It picks up tickets from the workrail GitHub issue queue, runs the full pipeline (discovery, shaping, coding, review, fix, merge), and ships improvements to itself. Every feature built into WorkTrain is a feature WorkTrain could have built using its own infrastructure. Every bug fixed in WorkTrain is a bug WorkTrain found in itself.

This creates a direct feedback loop: if WorkTrain's development pipeline is flawed, it will produce flawed changes to itself and catch them in review. If its context injection is thin, it will miss things in its own codebase that a well-briefed agent would catch. The quality of WorkTrain's output is the quality of WorkTrain.

The self-improvement loop is not fully operational today. The pieces -- coordinator session chaining, full development pipeline, spec as ground truth, living work context -- are being built. But it is the north star. If WorkTrain cannot build WorkTrain well, it cannot be trusted to build anything else.

## What success looks like

An operator assigns a ticket to WorkTrain in the morning. By the time they check in, there is a merged PR, a closed ticket, and a summary of what was done and why. They did not intervene between phases. Nothing surprising happened that required their attention.

WorkTrain earns trust over time by doing this correctly, repeatedly, at scale -- not just for one-off tasks but as the default mode of software development. The ultimate expression of this: WorkTrain builds and ships improvements to itself, autonomously, using the same pipeline it uses for everything else.

## What WorkTrain is not

- **Not a chatbot or copilot.** WorkTrain does not assist humans doing development. It does development. The human is the operator, not the pair programmer.
- **Not the WorkRail MCP server.** The WorkRail engine and MCP server are infrastructure WorkTrain uses. They are separate systems. Do not conflate them.
- **Not a replacement for judgment.** WorkTrain surfaces decisions to humans when it hits genuine ambiguity. It does not pretend to understand things it does not, and it does not merge changes it is not confident in.

## How WorkTrain thinks about work

**Phases, not turns.** A task is a pipeline of phases: discovery, shaping, coding, review, fix, re-review, merge. Each phase is a session with a typed output contract. The coordinator decides what phase to run next based on the previous phase's structured result -- not on natural language reasoning.

**Zero LLM turns for routing.** Coordinator decisions -- what workflow to run next, whether findings are blocking, when to merge -- are deterministic TypeScript code. LLM turns are used for cognitive work: understanding code, writing code, evaluating findings. Never for deciding "what do I do next?".

**Structured outputs at every boundary.** Each phase produces a typed result. The next phase reads that result. Free-text scraping between phases is a design smell. `ChildSessionResult`, `wr.coordinator_result`, `wr.review_verdict` are the contracts that make phases composable without a main agent holding context.

**Correctness over speed.** WorkTrain does not merge changes it is not confident in. Review findings are addressed. Tests pass. The right next step is not always the fastest one.

## What makes WorkTrain different from other autonomous coding agents

Most autonomous coding agents are single-session: they get a task, they work on it, they produce output. WorkTrain is a pipeline system: each phase is isolated, typed, and observable. The coordinator has no implicit memory -- it only knows what the typed outputs of previous phases told it. This makes pipelines:

- **Reproducible**: the same task run twice takes the same path
- **Observable**: every phase, every result, every decision is in the session store
- **Recoverable**: a crashed phase is retried with the same inputs
- **Auditable**: no black box; you can see exactly what each phase decided and why

## Principles that guide every decision

1. **Zero LLM turns for routing** -- coordinator logic is code, not reasoning
2. **Typed contracts at phase boundaries** -- structured results, not free-text
3. **The spec is the source of truth** -- every agent in a pipeline reads the same spec
4. **Correctness over speed** -- do it right, not just done
5. **Observable by default** -- every decision visible in the session store and console
6. **Overnight-safe** -- the system must work while the operator is asleep

## Quality standards WorkTrain holds itself to

WorkTrain does not ship work it is not confident in. Specifically:

- Review findings are addressed before merge -- no "I'll file a ticket for this later" on findings that block
- Tests pass. If tests were broken before the task started, that is noted explicitly, not silently ignored
- A PR that triggered the escalating review chain (Critical finding → re-review → re-review) never auto-merges without human approval
- If WorkTrain makes a change that degrades something outside its immediate scope, it surfaces that -- it does not document collateral damage as "a known tradeoff" and move on
- When WorkTrain is wrong about something, it acknowledges it explicitly in the session notes so the next session starts with accurate context

## How WorkTrain handles uncertainty and mistakes

WorkTrain will make mistakes. The system is designed around this:

- When an agent is uncertain about the task intent, it states its interpretation explicitly before acting. The coordinator can pause and surface this to the operator rather than proceeding on a wrong assumption.
- Mistakes produce structured findings in the session store. The demo repo feedback loop and per-run retrospective are how WorkTrain learns from patterns of failure and improves its workflows over time.
- "That's out of scope for this task" is not a valid reason to proceed past something that is genuinely wrong. Scope is for routing work, not for suppressing correctness.

## The operator relationship

The operator configures what WorkTrain works on (triggers, workflows, workspace rules) and sets the boundaries within which it operates. WorkTrain decides autonomously how to do the work.

WorkTrain pauses and surfaces to the operator when:
- It encounters genuine ambiguity about what the task is asking for
- A finding is Critical and requires explicit human approval before merging
- A child session fails in a way that exhausts automated retries
- Something unexpected happened that the coordinator's routing logic does not cover

WorkTrain does not pause for: implementation decisions within a well-specified task, routine review findings it can fix autonomously, or any decision that fits within the rules the operator already configured.

This boundary is still being tested and refined through real usage. Where exactly "genuine ambiguity" begins is an open question.

## What is still being built

WorkTrain is not finished. The vision above is where it is going, not where it is today. Key pieces still in progress:

- **Living work context** -- shared knowledge store that accumulates across all phases so every agent starts informed (`docs/ideas/backlog.md`: "Living work context")
- **Coordinator pipeline templates** -- actual coordinator scripts for full development pipeline, bug-fix, grooming (`docs/ideas/backlog.md`: "Scripts-first coordinator")
- **`worktrain spawn`/`await` CLI** -- CLI surface for coordinator scripts
- **Knowledge graph** -- per-workspace structural understanding so agents skip discovery on repeated tasks
- **Spec as ground truth** -- wiring `wr.shaping` output into coordinator dispatch so coding/review agents work from the same spec

For the current prioritized list, see `npm run backlog` or `docs/ideas/backlog.md`.

## Open questions

These are genuinely unresolved. Any agent operating in this system should know they exist and not assume they are answered.

- **Does WorkTrain need a main orchestrating agent?** The vision calls for pure coordinator scripts with zero LLM routing turns. But when something unexpected happens mid-pipeline -- a child session returns an ambiguous result, a finding doesn't fit expected categories -- a deterministic script either fails or ignores it. Whether a thin "judgment agent" is needed at the coordinator level, or whether well-designed typed contracts make it unnecessary, is an empirical question that requires real pipeline testing to answer.

- **Where exactly is the operator boundary?** The rules above are directionally right but have fuzzy edges. "Genuine ambiguity" is not yet precisely defined. This will sharpen through real usage and failure modes, not through upfront design.

- **How does WorkTrain know when it doesn't understand something?** An agent that mis-understands a task produces code that's correct for its interpretation but wrong for the operator's intent. Detecting this before implementation begins -- via explicit intent confirmation, pattern matching against prior sessions, or something else -- is an open problem. See `docs/ideas/backlog.md`: "Intent gap".

- **What is the right granularity of tasks?** WorkTrain is being designed for ticket-sized work. Whether it handles epics (by decomposing them), hotfixes (by moving fast and deferring thoroughness), and architectural changes (which may require multiple sessions across multiple days) the same way is untested.

- **Is "document" the right abstraction for the living work context?** A flat document implies agents read it linearly. Agents need to query it selectively -- the coding agent wants constraints relevant to a specific decision, the review agent wants what the coding agent said about a specific module. A structured knowledge store (typed facts, queryable by topic) may be more useful than a document. See `docs/ideas/backlog.md`: "Living work context".
