# WorkTrain Status Briefing -- Design Candidates

> Raw investigative material for main-agent synthesis. Not a final decision.

---

## Problem Understanding

### Core tensions

**Tension 1: Existing daemon-log status vs v2 projection layer**

The existing `worktrain status <sessionId>` command reads `~/.workrail/events/daemon/<today>.jsonl` directly (string parsing, mechanical metrics only). The v2 architecture uses per-session event stores with typed pure-function projections. A new aggregate status command has two options: (a) extend the daemon-log reader (consistent with existing command, but less data and wrong architecture), or (b) use the v2 session store (more data, correct architecture, requires resolving port wiring from CLI context). Option (b) is clearly correct per the architecture, but it introduces a temporary inconsistency -- two `status` commands reading from different sources.

**Tension 2: Completeness vs read complexity**

A complete briefing needs: goal (from `context_set` event), step name (from snapshot file), step count (from workflow catalog), stuck signal (from lastModifiedMs). Each requires a different read operation. A simpler briefing reads only session events (goal + workflow ID). The v2 projection layer resolves most of this: `HealthySessionSummary` in `resume-ranking.ts` already contains `pendingStepId`, `sessionTitle`, `isComplete`, and `lastModifiedMs` -- the assembly is done.

**Tension 3: Pull-command completeness vs stateless design**

The backlog spec shows a 'RECENTLY COMPLETED' section as a key output element. A pull command reading current session state misses sessions that completed between status runs. No persistent completion index exists. Accepting a point-in-time view (active sessions only) satisfies 4/5 success criteria; adding recently-completed requires either a new completion index or reading daemon log for session_completed events.

### Likely seam

`SessionSummaryProviderPortV2` + `HealthySessionSummary` in `src/v2/projections/resume-ranking.ts`. This is the correct aggregation boundary -- it already loads all sessions, health-checks them, and returns typed summaries. A new briefing command adds a formatter layer on top of this port, not a new data path.

### What makes this hard

A junior developer would: read daemon event log (wrong source, no goal text), produce session IDs instead of goal text, skip step names (miss the snapshot read), and miss that `HealthySessionSummary.sessionTitle` and `HealthySessionSummary.pendingStepId` already exist. The actual complexity is recognizing that the data assembly problem is solved -- only the formatter is missing.

---

## Philosophy Constraints

**Principles that apply directly:**
- **Errors are data (neverthrow):** individual session load failures must be `Result<ActiveSessionBriefing, LoadError>` not exceptions that abort the whole briefing
- **Ports/adapters DI:** session store access must be injected as a port, not hard-coded file reads
- **Pure functions for projection:** `buildStatusBriefing(summaries)` is a pure function, testable without I/O
- **Explicit domain types over primitives:** return type is `StatusBriefingV1`, not `string`
- **YAGNI with discipline:** do not add step-count tracking, completion indexing, time estimates before they are needed
- **Validate at boundaries, trust inside:** session loading validates at the port boundary; the formatter trusts `HealthySessionSummary` fields

**Conflicts:**
- The existing `status <sessionId>` command violates the 'use v2 projection layer' architectural direction. A new `status` command should NOT perpetuate this pattern.

---

## Impact Surface

- `src/cli-worktrain.ts` -- new subcommand added here
- `src/v2/projections/resume-ranking.ts` -- `HealthySessionSummary` type consumed (read-only)
- `src/v2/ports/session-summary-provider.port.ts` -- port consumed by new CLI command
- Future `worktrain talk` -- will consume the same `StatusBriefingV1` type or the same port
- `src/v2/usecases/console-routes.ts` -- not changed for MVP; may add status route later
- Existing `worktrain status <sessionId>` -- not changed; two status commands coexist (inconsistency noted)

---

## Candidates

### Candidate A: Minimal -- CLI formatter over `SessionSummaryProviderPort`

**Summary:** Add a `worktrain status` CLI subcommand (no session ID required) that calls `SessionSummaryProviderPortV2.loadAll()`, filters to active (non-complete) sessions, and formats each `HealthySessionSummary` into 3-4 lines: goal, step, duration, stuck warning if applicable. Defines a typed `StatusBriefingV1` intermediate (pure data structure) even though no HTTP route exists yet.

**Tensions resolved:**
- Goal visibility: `HealthySessionSummary.sessionTitle` (derived from `context_set` goal) already present
- Step context: `HealthySessionSummary.pendingStepId` already present
- Health signal: `lastModifiedMs` available for stuck detection (> N minutes without update)
- Aggregate view: `loadAll()` returns all sessions, no ID required
- Architecture consistency: v2 projection layer, neverthrow, DI

**Tensions accepted:**
- No 'recently completed' section (only active sessions; completions require daemon log read or completion index)
- No queue state (queue.jsonl does not exist)
- No step count -- only step name (e.g., "phase-3-implement"), not "step 4 of 8"
- Status-talk reuse is partial: both will call the same port, but no shared HTTP contract yet

**Boundary:** New `buildStatusBriefing(summaries: HealthySessionSummary[]): StatusBriefingV1` pure function in `src/v2/projections/status-briefing.ts`. New `worktrain status` subcommand in `src/cli-worktrain.ts` that wires the port and calls the formatter.

**Why this boundary is best fit:** The data assembly is already done in the projection layer. The briefing function is a pure, testable formatter -- not a new data path. Minimal surface area, minimal risk.

**Failure mode:** `SessionSummaryProviderPortV2` may not be available from CLI context (only wired in the HTTP server's DI container). Mitigation: expose a `createStandaloneSessionSummaryProvider(dataDir)` factory that wires the port without a full server context.

**Repo pattern:** Follows `src/v2/projections/` pattern (pure projection functions). The port-wiring from CLI context is a new pattern (existing CLI commands either call HTTP API or read files directly). Small, well-bounded new pattern.

**Gains:** Shippable in < 1 day. Satisfies 4/5 success criteria. Typed return type enables future talk integration. No daemon required.

**Losses:** No recently-completed section. No queue. Step count absent.

**Scope judgment:** Best-fit for MVP.

**Philosophy fit:** Honors errors-as-data, pure functions, DI, explicit domain types. Honors YAGNI (no speculative infrastructure). Resolves the stated philosophy conflict by using v2 layer instead of daemon log.

---

### Candidate B: `GET /api/v2/status/briefing` HTTP endpoint + CLI consumer

**Summary:** Add `GET /api/v2/status/briefing` returning a typed `StatusBriefingV1` JSON object, consumed by both a CLI `worktrain status` formatter and later by `worktrain talk` as its opening context bundle. The HTTP route calls `ConsoleService.getStatusBriefing()` which calls the same `SessionSummaryProviderPort`. The CLI subcommand calls the HTTP route (like `spawn`/`await`).

**Tensions resolved:**
- Status-talk reuse: `StatusBriefingV1` is the canonical shared contract; talk imports from the same endpoint
- Architecture layering: CLI talks to HTTP API, matching the `spawn`/`await` pattern
- Multiple consumers: web console can display a status widget without a separate data path

**Tensions accepted:**
- Requires a running daemon/console server (HTTP API unavailable if daemon is not running)
- More moving parts for the same MVP output (route + service method + DTO + CLI command)
- The 'reuse' benefit is speculative -- `worktrain talk` doesn't exist yet

**Boundary:** `StatusBriefingV1` in `src/v2/usecases/console-types.ts`, new `ConsoleService.getStatusBriefing()` method, new HTTP route, new CLI subcommand.

**Why this boundary is best fit:** If the canonical delivery mechanism is the HTTP API and multiple consumers exist, the API boundary is the right seam. But today there is only one consumer (the CLI), so this is premature optimization.

**Failure mode:** `worktrain status` becomes useless if the console server is not running. Candidate A works without a daemon; Candidate B does not. This is a usability regression for the core "check what's happening" use case.

**Repo pattern:** Follows `spawn`/`await` (CLI calls HTTP). Adds a new service method and route (standard pattern). Slightly too broad for the current moment.

**Gains:** Clean consumer contract for talk. Multiple consumers share one data path. Web console gets a status widget 'for free'.

**Losses:** Daemon dependency. Higher implementation cost (2-3 days vs 1 day). Premature given talk doesn't exist.

**Scope judgment:** Slightly too broad for MVP; right for the medium-term architecture if talk is imminent.

**Philosophy fit:** Honors explicit domain types, DI. The daemon dependency is a mild violation of 'validate at boundaries, trust inside' -- it introduces a runtime availability assumption that Candidate A avoids.

---

### Candidate C: Extend existing `worktrain status <sessionId>` with `--all` flag

**Summary:** Add `--all` flag to the existing `status` command that iterates sessions and renders health summaries for each.

**Tensions resolved:**
- Aggregate view (with --all flag)
- Consistency with existing command (same command name)

**Tensions accepted:**
- **Critically:** The existing command reads daemon event logs (mechanical metrics: LLM turns, tool call counts, failure rate). Adding `--all` to it would produce a list of sessions WITHOUT goal text and WITHOUT step names. The output would be "here are your N sessions: each ran X tool calls, Y LLM turns" -- useful for ops debugging, not for 'what are you doing and why'.
- The two-storage-system contradiction is not resolved; it's perpetuated.

**Failure mode:** Either (a) the output is inferior (no goal text) -- solving the wrong problem, or (b) the implementation is changed to read from v2 store instead -- which is functionally the same as Candidate A but with worse ergonomics (extending a misaligned command rather than a clean new one).

**Scope judgment:** Too narrow. Perpetuates the daemon-log-reading pattern that should not be extended.

**Philosophy fit:** Conflicts with 'architectural fixes over patches' -- extends a symptom location rather than the correct seam.

---

## Comparison and Recommendation

### Matrix

| Criterion | A (CLI+Port) | B (HTTP route) | C (extend existing) |
|-----------|-------------|---------------|---------------------|
| Goal text in output | YES | YES | NO (without arch change) |
| Step name in output | YES | YES | NO (without arch change) |
| Aggregate view | YES | YES | YES |
| Status-talk reuse | PARTIAL | FULL | NO |
| Daemon required | NO | YES | NO |
| Implementation cost | 1 day | 2-3 days | 1 day (wrong output) |
| Architecture correct | YES | YES | NO |
| MVP satisfies user | 4/5 criteria | 4/5 criteria | 0/5 criteria |

### Recommendation: Candidate A + typed `StatusBriefingV1` type

**Candidate A** wins on best-fit scope, minimum viable implementation, daemon-independent operation, and correctness (goal text + step name in output). The one addition from B: define a typed `StatusBriefingV1` return type even though the HTTP route is not built yet. This adds < 30 minutes to the implementation and gives `worktrain talk` a named contract to consume without requiring HTTP.

**Concrete implementation plan:**
1. New file: `src/v2/projections/status-briefing.ts` -- pure `buildStatusBriefing(summaries: HealthySessionSummary[]): StatusBriefingV1` function
2. New types: `StatusBriefingV1`, `ActiveSessionBriefing` in the same file
3. New CLI subcommand `status` (no positional arg) in `src/cli-worktrain.ts` -- note: renames the existing positional-arg `status <sessionId>` command to `health <sessionId>` to avoid ambiguity, or adds `status` as an alias
4. Port wiring: `createStandaloneSessionSummaryProvider(dataDir: string)` factory if the port is not accessible from CLI context

---

## Self-Critique

### Strongest argument against this recommendation

Candidate B is architecturally cleaner for multi-consumer scenarios. If `worktrain talk` is planned for the next sprint, building the HTTP API route now avoids a refactor. The extra day of implementation is cheap compared to duplicated port-wiring if the CLI and talk both wire the provider independently.

### Narrower option that lost

Candidate A without the typed return type (format directly to strings in the CLI command). Lost because: `worktrain talk` would need to re-implement the assembly logic, violating DRY. The typed intermediate is < 30 minutes of extra work and high future value.

### Broader option and what evidence would justify it

Candidate B. Evidence required: backlog prioritization showing `worktrain talk` is the immediate next milestone (< 2 weeks), or confirmation that the web console UI needs a live status widget in the same timeframe.

### Pivot conditions

- If `SessionSummaryProviderPortV2` cannot be wired from CLI context without significant boilerplate -- consider Candidate B (the HTTP server already wires it, so calling the API from CLI avoids duplicating DI logic)
- If the user confirms talk is imminent -- add the HTTP route now as part of the same PR
- If step count ('of N total steps') is a hard requirement -- add workflow catalog read to `buildStatusBriefing()` (still Candidate A shape, small scope addition)

---

## Open Questions for Main Agent

1. Is `SessionSummaryProviderPortV2` accessible from a standalone CLI context, or is it only wired in the HTTP server's DI container? (determines whether a factory function is needed)
2. Should the existing `worktrain status <sessionId>` be renamed to `worktrain health <sessionId>` to avoid command name collision, or should the new aggregate command use a different name (`worktrain status --all` or `worktrain ls`)?
3. How important is the 'RECENTLY COMPLETED' section for the initial release? If important, a daemon-log scan for `session_completed` events from the last 24 hours is a feasible addition to the briefing.
4. Is `worktrain talk` planned for the next sprint? If yes, Candidate B is worth the extra day.
