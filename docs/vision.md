# WorkTrain Vision

## What WorkTrain is

WorkTrain is an autonomous software development daemon. It runs continuously in the background, picks up tasks from external systems (GitHub issues, GitLab MRs, Jira tickets, webhooks), and drives them through the full development lifecycle -- discovery, shaping, implementation, review, fix, merge -- without human intervention between phases.

The operator's job is to configure what WorkTrain works on and what rules it follows. WorkTrain's job is to do the actual work, autonomously, reliably, and correctly.

## What success looks like

An operator assigns a ticket to WorkTrain in the morning. By the time they check in, there is a merged PR, a closed ticket, and a summary of what was done and why. They did not intervene between phases. Nothing surprising happened that required their attention.

WorkTrain earns trust over time by doing this correctly, repeatedly, at scale -- not just for one-off tasks but as the default mode of software development.

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

## What is still being built

WorkTrain is not finished. The vision above is where it is going, not where it is today. Key pieces still in progress:

- **Living work context** -- shared knowledge document that accumulates across all phases so every agent starts informed (`docs/ideas/backlog.md`: "Living work context")
- **Coordinator pipeline templates** -- actual coordinator scripts for full development pipeline, bug-fix, grooming (`docs/ideas/backlog.md`: "Scripts-first coordinator")
- **`worktrain spawn`/`await` CLI** -- CLI surface for coordinator scripts
- **Knowledge graph** -- per-workspace structural understanding so agents skip discovery on repeated tasks
- **Spec as ground truth** -- wiring `wr.shaping` output into coordinator dispatch so coding/review agents work from the same spec

For the current prioritized list, see `npm run backlog` or `docs/ideas/backlog.md`.
