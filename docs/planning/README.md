# Planning System

This is the **general planning home** for WorkRail.

Use it to capture ideas quickly, curate roadmap direction, and promote concrete work into execution-ready tickets without forcing every thought into a full implementation plan too early.

## Planning layers

### `docs/ideas/`

Use for:

- raw ideas
- feature thoughts
- open questions
- design seeds
- things worth remembering before they are prioritized

This is the **official dumpground** for product and system ideas.

### `docs/roadmap/`

Use for:

- curated direction
- now / next / later views
- major bets
- cross-cutting product themes

Roadmap docs should stay **selective**. Not every idea belongs here.

### `docs/tickets/`

Use for:

- execution-ready work
- scoped problems
- acceptance criteria
- clear non-goals
- risks or follow-ups

If an item is ready to build, it should probably become a ticket.

## Graduation path

Default flow:

1. `ideas` — capture it fast
2. `roadmap` — decide if it matters strategically
3. `tickets` — define the work clearly enough to execute

Not every idea must become a roadmap item.  
Not every roadmap item must become a ticket immediately.

## Status ownership

**Status lives in `docs/ideas/backlog.md`**. Each entry has a `Status:` line (idea / partial / done / bug). Use `npm run backlog` to see a scored, sorted view.

Plan docs in `docs/plans/` describe **design and intent** -- not current status. When work ships, update the backlog entry status, not the plan doc.

## Rules of thumb

- **Idea**: "This might be valuable."
- **Roadmap item**: "We likely want this."
- **Ticket**: "We understand this well enough to build."

## Docs vs GitHub

Use **docs** for:

- ideas
- design
- roadmap thinking
- synthesis
- long-form reasoning

Use **GitHub issues** for:

- concrete execution-ready work
- bugs with enough detail to investigate
- chores or features that are scoped clearly enough to do

Use **pull requests** for:

- the implementation record
- review
- closure of execution work

Do not move all design/idea material into GitHub.  
GitHub should primarily track **work**, while docs remain the home for **thinking**.

## Existing planning docs

Existing feature-specific plans in `docs/plans/` still matter. Treat them as **focused initiative plans**, not as the general inbox for new thoughts.

## Starting points

- `docs/vision.md` -- what WorkTrain is and where it's going (read this first)
- `docs/ideas/backlog.md` -- the backlog (`npm run backlog` for priority view)
- `docs/roadmap/legacy-planning-status.md` -- status map for older planning docs
- `docs/tickets/next-up.md` -- scratch space for near-term tickets
