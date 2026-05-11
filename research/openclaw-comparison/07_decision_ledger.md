# Decision Ledger: OpenClaw vs WorkTrain

**Decision target:** roadmap_prioritization
**Date:** 2026-05-07
**Constraint check:** 3 urgent items ✓ | 1 changes-positioning item ✓ | 0 TBD verdicts ✓

---

## Findings

| Finding | Source confidence | Verdict | Rationale | Owner |
|---------|------------------|---------|-----------|-------|
| **ContextEngine pluggable interface** (assemble, compact, maintain, transcript rewrite, subagent spawn hooks) -- OpenClaw has it, WorkTrain doesn't | verified (E1) | **urgent** | WorkTrain's `buildSystemPrompt()` hardcoded pipeline cannot support dynamic compaction, retrieval-augmented context, or per-workflow context policies. At long sessions, context quality degrades silently. Extractable as a pure TypeScript pattern with no OpenClaw dependencies. | engine |
| **Unified trajectory trace schema** -- OpenClaw has one schema for runtime + transcript; WorkTrain has two separate stores requiring console bridge | verified (E7) | **urgent** | Every new console feature must be built twice or bridged. This is a migration, not a one-liner. The split is a growing architectural tax. Adopting a unified `DaemonEvent` schema (merging daemon event log + v2 session store concepts) removes the split. | engine |
| **Service audit (typed issue codes) + doctor --fix** -- OpenClaw ships `SERVICE_AUDIT_CODES` and auto-repair; WorkTrain's `worktrain daemon --start` silently succeeds on immediate crash | verified (E8, E10) | **urgent** | Known backlog bug. Operators discover failures at 3am. A `worktrain doctor` command with typed issue codes (stale binary, bad config, missing env, launchd mismatch) maps directly to OpenClaw's pattern. Concrete, bounded, high operator value. | daemon |
| **SQLite task registry with status union and flow trees** -- OpenClaw has queryable task history; WorkTrain has append-only `execution-stats.jsonl` | verified (E3) | backlog | WorkTrain currently can't answer "how many sessions succeeded last week" without a full file scan. SQLite task registry adds queryable history, `lost` state, and parent-child flow trees. Not urgent -- append-only log is sufficient at current scale. Priority rises when WorkTrain has more concurrent users. | engine |
| **Subagent role model (main/orchestrator/leaf)** -- OpenClaw types roles explicitly; WorkTrain has depth enforcement but no role distinction | verified (E5) | backlog | Coordinator sessions and worker sessions are structurally identical in WorkTrain today. A typed role model would let the engine enforce "coordinators may only call signal_coordinator, not Bash" at the tool construction layer. Good architectural hygiene; not blocking current use. | daemon |
| **Commitment extraction (LLM-extracted promises with heartbeat delivery)** -- OpenClaw tracks agent-made commitments; WorkTrain has `report_issue` only | verified (E4) | backlog | Addresses the operator-preference-memory gap partially. Not a direct adoption -- the personal-assistant framing doesn't map to WorkTrain's pipeline context. Relevant as inspiration for "what did the agent promise and did it deliver?" in session retrospectives. | engine |
| **Prompt cache observability** (retention, lastCallUsage, cache-break detection) | verified (E2) | backlog | WorkTrain pays full input token cost on every session. At current scale invisible. Cache observability becomes actionable when sessions are long enough that cache hits materially affect cost and latency. | engine |
| **Workspace inheritance on spawn** -- OpenClaw: explicit > target-agent > requester; WorkTrain: always caller-provided | verified (E19) | backlog | WorkTrain's spawn_agent requires explicit workspacePath. Automatic inheritance would reduce boilerplate in coordinator workflows. Low urgency -- current behavior is explicit and correct. | daemon |
| **Detached launchd restart handoff** (PID-wait + kickstart after process exit) | verified (E9) | backlog | WorkTrain currently has a gap between binary update and daemon restart. The detached-handoff pattern eliminates the downtime window. Good to have; not urgent. | daemon |
| **Distribution gap: OpenClaw has 369k stars, WorkTrain has none** | verified | **changes-positioning** | Red hat correctly identified this as underweighted. If OpenClaw ships a 60%-good coding pipeline via ClawHub, it reaches orders of magnitude more users. WorkTrain's response must be to demonstrate correctness advantages publicly (blog, demo, benchmarks) before OpenClaw's distribution moat makes the comparison moot. This is the single most important strategic finding. | positioning |
| **`skills/coding-agent/` directory exists in OpenClaw** | verified (directory confirmed, contents not fully read) | backlog | ACH Alternative A requires reading the directory contents to confirm it is a stub. Assigned as a follow-up, not urgent yet. Escalates to `urgent` if directory contains multi-phase step enforcement logic. | strategy |
| **LICENSE: MIT** | verified (E, 02b) | ignore | No legal exposure. MIT is permissive. WorkTrain is also MIT. Zero license risk for customers adopting OpenClaw alongside WorkTrain. | n/a |
| **Dependency risk: are any WorkTrain customers already depending on OpenClaw?** | unconfirmed | ignore | WorkTrain has no known customer overlap with OpenClaw's user base. OpenClaw is a personal assistant platform; WorkTrain is a dev pipeline tool. No integration surface overlap identified. | n/a |

---

## Adversarial points from 06_red_hat_critique.md -- incorporated vs rebutted

| Adversarial point | Disposition |
|------------------|-------------|
| GitHub/OpenAI sponsorship underweighted | **Incorporated** -- added to battlecard "We Lose When" #1 and "Objection → Response" #3. Sponsor signal is flagged as "watch the coding-agent skill closely." Not reclassified as a current threat because no active pivot evidence exists. |
| Distribution moat never reasoned about | **Incorporated** -- upgraded to `changes-positioning` verdict in decision ledger. Battlecard "We Lose When" #1 addresses it directly. |
| "Overnight-safe" is theoretical while startup bugs exist | **Incorporated** -- battlecard "We Lose When" #3 surfaces the context-degradation gap. Decision ledger `urgent` for doctor/service-audit addresses the startup bug. |
| JTBD "different jobs" is underdetermined | **Rebutted** -- The red hat argues users can hire both products simultaneously. True, but the hiring trigger differs: no user hires a personal AI assistant because they want a typed-phase pipeline. The overlap is incidental, not substitutive. OpenClaw users don't assign GitHub issues; WorkTrain users don't ask the agent via WhatsApp. |
| E11 (hierarchy rejection) used contradictorily | **Incorporated as reviewer note** -- E11 is genuinely load-bearing in two directions. As an "anxiety blocker" it is valid: any operator who needs typed-phase enforcement won't get it from OpenClaw today. As "stable moat" it is weak: OpenClaw could close the gap. Decision ledger `changes-positioning` row reflects this instability. |
| "Extractable patterns" needs a concrete plan | **Partially rebutted** -- This analysis is a competitive analysis, not an implementation plan. The decision ledger verdicts (urgent/backlog) serve as the prioritization. Actual migration plans belong in separate design docs. The red hat is correct that an extraction plan should be created; it is out of scope for this artifact. |
| `coding-agent/` contents unread | **Incorporated** -- Battlecard flags it as unconfirmed. Decision ledger assigns it as a backlog follow-up that escalates to urgent if multi-phase logic is found. |

---

## Reviewer notes (unanswered adversarial points)

**REVIEWER NOTE 1:** The synthesis uses E11 (OpenClaw rejects hierarchy) as both "not a threat" AND "anxiety blocker." These are logically compatible but create a fragile moat claim. The moat exists only while OpenClaw's VISION holds. A follow-up to read `skills/coding-agent/` contents is required to assess whether this is already eroding. Recommend scheduling a 30-day re-read of that directory.

**REVIEWER NOTE 2:** ACH Alternative B (WorkTrain's typed-phase pipeline produces measurably better outcomes) is currently unsupported. No documented catch examples exist. The decision ledger `changes-positioning` row for distribution gap implicitly assumes WorkTrain's correctness advantages can be demonstrated publicly. If they cannot be demonstrated with real examples, the positioning response collapses.
