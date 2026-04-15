# nexus-core Adoption: Design Candidates

**Discovery source:** GitLab project 66446 (`fub/apex/ai-prototypes/nexus-core`)  
**Discovery date:** 2026-04-14  
**Purpose:** WorkRail Auto -- what should we adopt, adapt, or skip?

---

## Problem Understanding

### Core Tensions

**Advisory vs. Structural** -- nexus-core achieves compliance through prompts (SOUL.md, CLAUDE.md rules, skill instructions). WorkRail achieves compliance through structural enforcement (HMAC-gated tokens, step sequencing). Adopting nexus's advisory patterns weakens WorkRail's architectural guarantee.

**Human-initiated vs. Daemon-driven** -- nexus-core's session hooks run at Claude Code start/stop events. WorkRail's daemon has no Claude Code events -- it drives its own pi-mono agent loop. Session lifecycle patterns from nexus don't directly port because the trigger mechanism is different.

**Org-specific vs. Portable** -- nexus-core's profile system is explicitly Zillow-specific. WorkRail's portability (npx -y @exaudeus/workrail works anywhere) is a core feature. Importing the profile concept requires a generic schema.

**Knowledge injection as file vs. as context** -- nexus-core injects knowledge by writing to `repo/.claude/instructions/nexus-context.md` (a file Claude Code picks up automatically). WorkRail's daemon controls the system prompt directly. The file-based pattern is Claude Code-specific indirection that WorkRail's daemon doesn't need.

### Real Seam

nexus-core has working implementations of four things WorkRail Auto doesn't have yet:
1. Workspace/org configuration (nexus: profile YAML; WorkRail: nothing yet)
2. Daemon session start (nexus: session-start.sh; WorkRail: needs equivalent in daemon)
3. Context injection for target repos (nexus: inject-knowledge.sh; WorkRail: needs equivalent for cross-repo sessions)
4. Post-workflow learning capture (nexus: compound/retro; WorkRail: no equivalent yet)

### What Makes This Hard

The hard part is distinguishing between patterns that are portable and patterns that are working accidents of nexus's Claude Code dependency. Some nexus patterns only work because Claude Code loads `.claude/instructions/` files automatically. WorkRail's daemon doesn't have that automatic loading -- it must inject context explicitly.

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md`:

- **Architectural fixes over patches** -- advisory principles are a patch; structural enforcement (tokens, gates) is the fix
- **Make illegal states unrepresentable** -- bad agent behavior should be structurally impossible, not just discouraged
- **Immutability by default** -- nexus-context.md overwrites a file; WorkRail should generate an immutable context fragment
- **Determinism over cleverness** -- nexus's knowledge injection caps at 200 lines, deterministic assembly order; WorkRail should do the same
- **YAGNI with discipline** -- design clear seams but don't build the knowledge base format before there's data to put in it
- **Validate at boundaries** -- the session initializer IS the boundary; fail fast with a clear error, not silently

**Philosophy conflict:** nexus's SOUL.md expresses the same principles (evidence before assertion, quality non-negotiable) as advisory prompts. WorkRail's equivalent must be structural. The two approaches converge on the same values but via different mechanisms.

---

## Impact Surface

Any adoption of nexus patterns will touch:
- `src/daemon/` (new modules -- session-initializer, context-assembler, learning-capture)
- workspace manifest format (cross-repo sessions need a `repos` array with paths)
- `~/.workrail/knowledge/` (new storage path for per-workspace learnings)
- `docs/design/workflow-authoring-v2.md` (document why structural enforcement replaces advisory principles)

Must stay consistent:
- WorkRail's session store (append-only event log) -- no mutations
- WorkRail's token protocol -- no bypass of step sequencing
- WorkRail's portability guarantee -- no Zillow-specific conventions

---

## Candidates

### Candidate A (Simplest): Daemon Session Initializer

**Summary:** Implement `initializeSession(config: DaemonConfig): Promise<Result<SessionContext, InitError>>` in `src/daemon/session-initializer.ts` -- the TypeScript equivalent of nexus's `session-start.sh`, running at daemon session start.

**Tensions resolved:**
- Advisory vs structural: TypeScript init is structural -- fails explicitly on missing config
- Human-initiated vs daemon: daemon calls this at session start, no Claude Code hook needed

**Tensions accepted:**
- Org-specific vs portable: requires a workspace config format (not yet designed, but the format will be generic)

**Boundary solved at:** Daemon session initialization. Equivalent to nexus's guards + health check + context prep.

**Why this boundary is the best fit:** Session initialization is a clear, well-bounded daemon startup concern. nexus's session-start.sh does exactly this and its 4 actions (guard, health check, plugin discovery, knowledge injection) map cleanly to WorkRail's 4 equivalent actions (validate workspace, check workflow availability, build session context, inject prior step notes).

**Failure mode to watch:** Workspace path not set -- must fail fast with a clear `InitError`, not proceed silently.

**Repo-pattern relationship:** Follows `src/v2/infra/local/` pattern of typed ports + adapters. `DaemonConfig` port already exists in backlog design.

**Gains:** Clean TypeScript, no bash dependency, runs in-process, fully testable. Daemon startup has a well-defined contract.
**Losses:** TypeScript init can be accidentally skipped during development (bash hooks always run if registered). Mitigation: make `initializeSession()` mandatory in the daemon startup path via type system.

**Scope:** Best-fit. This is a prerequisite for all other daemon capabilities.

**Philosophy fit:** Honors "Validate at boundaries" (init is the boundary), "Errors are data" (Result type), "Dependency injection" (DaemonConfig injected). No conflicts.

---

### Candidate B (Adapt existing pattern): Cross-Repo Context Assembler

**Summary:** Adapt `inject-knowledge.sh`'s assembly model into a TypeScript `assembleRepoContext(repoPath: string, knowledgeBase: KnowledgeBase): Promise<string>` function that produces a deterministic, capped context fragment for injection into the daemon's session system prompt.

**Tensions resolved:**
- Human-initiated vs daemon: assembly happens programmatically at session start
- Advisory vs structural: injected content is part of the structured system prompt, not an advisory document
- Knowledge injection as file vs context: daemon uses system prompt injection directly

**Tensions accepted:**
- Org-specific vs portable: the knowledge base format needs a generic schema (not yet designed)

**Boundary solved at:** Context assembly before agent loop initialization.

**Why this boundary is the best fit:** This is exactly where nexus injects knowledge -- before the agent works on the task. The key adaptation is that where nexus writes to a file for Claude Code to load, WorkRail passes the assembled fragment directly to pi-mono's `Agent` as part of the system prompt.

**Assembly order (from nexus's model, adapted):**
1. Workspace identity (repo name, branch, CLI tool -- always first)
2. Tool quirks / always-inject items (nexus: tool-quirks always included)
3. Repo-specific learnings from knowledge base (nexus: filtered by repo name, capped)
4. Recent session step notes from WorkRail session store (nexus: .nexus/learnings/)

**Cap:** Configurable max tokens (nexus: 200 lines; WorkRail: ~500-1000 tokens, configurable in workspace config).

**Failure mode to watch:** Context fragment grows unbounded across sessions as learnings accumulate. The cap is critical. Phase 1 with empty knowledge base: graceful (fragment = just workspace identity header).

**Repo-pattern relationship:** Extends WorkRail's session store (new consumer of existing step notes). The session store already has all the raw data.

**Gains:** The assembled context survives context resets because it's regenerated at daemon session start from durable sources (session store + knowledge base). Directly addresses "context survival" problem.
**Losses:** Requires designing the KnowledgeBase format. YAGNI tension: if no knowledge base entries exist, the assembler adds no value.

**Scope:** Best-fit (depends on Candidate A existing first). Phase 1 implementation is minimal: just inject workspace identity. Phase 2 adds knowledge base entries.

**Philosophy fit:** Honors "Determinism" (same inputs, same fragment), "Immutability" (fragment is a generated value, not a mutated file), "YAGNI with discipline" (MVP is Phase 1 only). No conflicts.

---

### Candidate C (Structural, not advisory): Explicit non-adoption of SOUL.md pattern

**Summary:** WorkRail should NOT implement a SOUL.md equivalent. Instead, document that every behavior nexus-core expresses as advisory principles must be expressed in WorkRail as structural enforcement (assessment gates, required evidence fields, token protocol).

**Tensions resolved:**
- Advisory vs structural: this IS the architectural choice; it is not adopted, it is the WorkRail architecture
- Org-specific vs portable: no principles document means no org-specific values to maintain

**Tensions accepted:**
- Some behaviors SOUL.md enforces culturally cannot be structurally enforced (e.g., "prefer the surprising truth"). These are accepted as outside WorkRail's enforcement scope.

**Boundary solved at:** Workflow authoring documentation (`docs/design/workflow-authoring-v2.md`). A "why WorkRail uses structural enforcement" section communicates the same intent as SOUL.md -- but to workflow authors, not to the agent.

**Why this boundary is the best fit:** SOUL.md addresses the agent's behavior. WorkRail's token protocol already addresses agent behavior structurally. Adding advisory principles on top would be redundant at best, conflicting at worst (the agent might follow the advisory principles in a way that bypasses the structural gate).

**Failure mode to watch:** Workflows that lack assessment gates and required evidence fields -- the agent produces technically correct but low-quality output that passes all structural gates. WorkRail's answer: this is a workflow authoring problem. The fix is better gates, not a principles document.

**Repo-pattern relationship:** This is a deliberate non-adoption. It follows WorkRail's existing architectural approach (structural enforcement over advisory prompts).

**Gains:** Zero complexity added. Resolves the riskiest assumption in the framing (SOUL.md vs structural enforcement). A workflow-authoring document that explains why WorkRail uses gates has enduring value.
**Losses:** SOUL.md is genuinely good for communicating design intent to onboarding contributors. A short section in workflow authoring docs partially compensates.

**Scope:** Best-fit (zero code; one documentation section).

**Philosophy fit:** Honors "Architectural fixes over patches" (most directly), "Make illegal states unrepresentable". No conflicts.

---

### Candidate D (Adapt compound/retro): Post-workflow Learning Capture

**Summary:** After each WorkRail session completes, a background `captureWorkflowLearnings(sessionId)` function scans step notes for patterns and writes them to `~/.workrail/knowledge/{workspace}/` for use by context assembler (Candidate B) in future sessions.

**Tensions resolved:**
- Human-initiated vs daemon: capture runs automatically at session end
- Advisory vs structural: workflow improvement suggestions require human review before being applied (not auto-committed)

**Tensions accepted:**
- nexus's "one learning = one commit" discipline is harder to enforce when improvements are queued for review

**Boundary solved at:** Post-session cleanup, after the daemon session ends.

**Three output paths (adapting nexus's compound routing):**
1. **Workflow improvement suggestions** -- written to `~/.workrail/pending-improvements/YYYY-MM-DD-{session-id}.json` for human review before any workflow changes
2. **Workspace knowledge** -- repo-specific discoveries written to `~/.workrail/knowledge/{workspace-name}/`
3. **Global WorkRail knowledge** -- discoveries applicable across all workspaces, written to `~/.workrail/knowledge/global/`

**Phase 1 (MVP):** Write all step notes to `~/.workrail/knowledge/{workspace}/sessions/{date}-{session-id}.md` with no classification. Feed this archive to context assembler (Candidate B Phase 2).

**Phase 2:** Add classification heuristics (error->resolution = gotcha, repeated friction = codebase-insight, new tool behavior = tool-quirk).

**Phase 3:** Add workflow improvement suggestions (workflow step could be skipped for this case = improvement candidate).

**Failure mode to watch:** Pending improvements queue fills without review. Prune improvements older than 30 days automatically.

**Repo-pattern relationship:** New consumer of existing session store. Follows WorkRail's append-only model for the knowledge base.

**Gains:** WorkRail sessions compound over time. Each session's learnings improve future sessions. This is the "each unit of work should make subsequent units easier" principle from nexus's compound skill applied to WorkRail.
**Losses:** Significant complexity (classification heuristics, three output paths, queue management). Phase 1 is the right starting point.

**Scope:** Best-fit for Phase 1. Too broad for full implementation in MVP. Phase 1 is ~2 days. Full implementation is 2-3 weeks.

**Philosophy fit:** Honors "Compose with small pure functions" (capture composed of: read notes, classify, route). Phase 1 honors "YAGNI with discipline" (write notes, no classification). Full form has classification heuristics that are inherently fuzzy (minor conflict with "Determinism over cleverness"). Accepted tradeoff.

---

## Comparison and Recommendation

### All four candidates are complementary, not competing.

This is not a "pick one" decision. Recommended build order:

**1. Candidate C first (zero code, highest value)**
Write the "why WorkRail uses structural enforcement instead of advisory principles" section in workflow authoring docs. Resolves the riskiest assumption at zero cost.

**2. Candidate A second (daemon MVP prerequisite)**
`src/daemon/session-initializer.ts` is the foundation. Nothing else works without it.

**3. Candidate B third (context injection, depends on A)**
`src/daemon/context-assembler.ts` Phase 1: inject workspace identity + step notes. Add knowledge base in Phase 2 when Candidate D has populated it.

**4. Candidate D last (post-MVP)**
Phase 1: write step notes to knowledge archive. Phase 2: classification. Phase 3: workflow improvement suggestions.

### Narrower MVP: Just A and C

If the goal is only to get the daemon running, implement Candidate A (session initializer) and Candidate C (documentation). Skip B and D until the daemon is running and cross-repo use cases are proven. This is consistent with the backlog's "cross-repo is post-MVP" note.

---

## Self-Critique

**Strongest counter-argument:** Candidate B requires designing a knowledge base format before there's any content to put in it. YAGNI discipline says: build the assembler only when there's data to assemble. The narrower answer (Candidate A + C only) may be more disciplined for an actual MVP build.

**Pivot conditions:**
- If daemon sessions frequently miss important repo context: accelerate Candidate B
- If assessment gates catch all quality issues without advisory principles: validates Candidate C
- If sessions accumulate step notes that users reference in future sessions: accelerate Candidate D Phase 1
- If knowledge base format reveals unexpected complexity: defer Candidate B, do Candidate D Phase 1 first

**Assumption that would invalidate Candidates A+B+D:** If WorkRail's daemon never handles multi-repo workflows, the workspace-specific context injection is unnecessary overhead. Build the session initializer (A) first; validate the cross-repo need before building B.

---

## Open Questions for the Main Agent

1. Is cross-repo context injection needed at daemon MVP, or is it post-MVP? (This decides whether to build B in v1 or defer it.)
2. Should the knowledge base format be designed upfront (enabling B), or should we build Candidate D Phase 1 first and let the format emerge from actual session data?
3. The org profile system (configs/profiles/zillow.yaml) has value for WorkRail users at multi-tool orgs. Should WorkRail adopt a `workspace.yaml` format with the same structure (git hosts, issue tracker, required tools)? This is orthogonal to the four candidates above.
