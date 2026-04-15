# Design Candidates: Claude Code Integration Points for WorkRail Auto

**Source research:** `github.com/Archie818/Claude-Code` -- files read Apr 14, 2026
**Scope:** WorkRail Auto integration with Claude Code's compaction, hooks, session memory, subagent model, and session runner.
**Status:** Raw investigative material for main-agent review. Not a final decision.

---

## Problem Understanding

### Core Tensions

**Tension 1: Hook reliability vs SM compaction bypass**
PreCompact hooks are the obvious integration surface. But Claude Code's Tier 1 Session Memory Compaction (`trySessionMemoryCompaction()`) runs BEFORE checking for PreCompact hooks. If SM compaction succeeds, hooks never fire. Result: WorkRail's step notes are silently excluded from the summary. This is a silent failure mode -- no error, no warning. The context just doesn't have WorkRail state after compaction.

**Tension 2: Evidence enforcement strength vs subprocess reliability**
A PreToolUse hook that denies `continue_workflow` without observed evidence is structurally sound (illegal state). But the evidence collection mechanism (PostToolUse hook) is a subprocess that can fail silently (exit non-2 = non-blocking error = evidence log not written). If PostToolUse hook fails, evidence gate blocks even though the tool actually ran. Tension between structural enforcement and delivery reliability.

**Tension 3: Portability vs integration depth**
WorkRail's value is zero-config portability. But the richer the Claude Code integration (session memory file writes, hook registration), the more setup required. Daemon mode (no Claude Code) actually avoids this tension entirely -- it's more portable, not less.

### Likely Seam
The real seam is NOT in Claude Code. Two WorkRail seams:
1. `scripts/setup-hooks.sh` -- installs hook scripts to `~/.claude/settings.json` for human-driven sessions
2. `src/daemon/runWorkflow.ts` (proposed) -- injects session state into system prompt before each Agent instance

### What Makes This Hard
Three tiers of compaction with different hook activation conditions that are invisible without reading the source. The "obvious" integration (PreCompact hook only) silently fails when Tier 1 SM compaction is active. A junior developer would implement hook-only integration and miss the SM compaction bypass problem entirely.

---

## Philosophy Constraints

From `~/.claude/CLAUDE.md` (system-wide):
- **Make illegal states unrepresentable** -- evidence gate must be structural (PreToolUse deny), not advisory
- **Errors are data** -- hook output must be structured JSON with `permissionDecision: 'deny'` + reason, not just exit code 2
- **Determinism over cleverness** -- evidence log must be idempotent (tool_use_id as dedup key; double-logging same call must not double-count)
- **Validate at boundaries** -- the hook IS the boundary; internal engine doesn't re-validate
- **YAGNI with discipline** -- don't protect against feature-flagged compaction paths that don't affect most users yet

Philosophy tension: 'Make illegal states unrepresentable' wants a fully structural gate. The subprocess hook model is imperfect. In daemon mode, the in-process gate is fully structural. In human-driven mode, the hook model is best available.

---

## Impact Surface

- `~/.claude/settings.json` -- hook registration file. WorkRail's `setup-hooks.sh` must merge hooks, not overwrite. Existing user hooks must be preserved.
- `src/mcp/handlers/v2-workflow.ts` -- the MCP handler for `continue_workflow`. PreToolUse hook intercepts before this handler runs. If hook blocks, handler never executes.
- `src/v2/infra/local/session-lock/index.ts` -- the lock file. Daemon fix (workerId addition) is a prerequisite for in-process evidence gate in daemon mode.
- `src/daemon/runWorkflow.ts` (proposed) -- the evidence gate for daemon mode lives here, as an in-process check before `executeContinueWorkflow()`.
- Claude Code `getSessionMemoryPath()` internal path -- if Candidate B is ever implemented, writes here. Version-sensitive.

---

## Candidates

### Candidate A: Hooks-Only Integration (Human-Driven Sessions)

**Summary:** Register 3 hooks in `~/.claude/settings.json` for PreCompact context injection + PostToolUse evidence logging + PreToolUse evidence gate.

**Tensions resolved:**
- Evidence gate strength (PreToolUse deny = structural enforcement)
- Portability (only writes to `~/.claude/settings.json`)

**Tensions accepted:**
- SM compaction bypass: if Anthropic enables SM compaction (Tier 1) for the user, PreCompact hook never fires. Context notes are lost from the new session (but recoverable from WorkRail session store via `intent: rehydrate`).

**Boundary solved at:** Claude Code hooks system (`settings.json` PreCompact/PreToolUse/PostToolUse). The only documented extension surface.

**Data structures:**
- PreCompact hook output: plain markdown text (step notes). Input: `{hook_event_name: 'PreCompact', trigger: 'auto'|'manual', session_id, transcript_path, cwd, custom_instructions}`.
- PostToolUse evidence log: NDJSON append-only at `~/.workrail/evidence/{session_id}.ndjson`. Entry: `{tool_use_id, tool_name, tool_input, timestamp}`. Deduped by `tool_use_id`.
- PreToolUse gate output: `{decision: 'block', reason: '...', hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Required evidence not observed: [list]'}}`.
- Hook registration: `settings.json:hooks.{PreCompact: [{matcher: '*', hooks: [{type: 'command', command: '~/.workrail/hooks/pre-compact.sh'}]}], PostToolUse: [{matcher: 'Bash|Write|Edit|FileWriteTool|FileEditTool', hooks: [...]}], PreToolUse: [{matcher: 'mcp__workrail__continue_workflow', hooks: [...]}]}`.

**Failure mode:** SM compaction fires, PreCompact hook never runs. WorkRail notes absent from new session context. User must call `intent: rehydrate` to restore. NOT a silent crash -- context is recoverable. Silent degradation, not failure.

**Repo pattern relationship:** Follows Claude Code's documented extension mechanism exactly. WorkRail already has `scripts/setup-hooks.sh` (sets up hooks for current session). This extends that file.

**Gain:** Simplest implementation. Zero internal Claude Code coupling. Every hook script is a standard shell script with documented JSON contracts.
**Give up:** No protection against SM compaction bypass. Context survival depends on Tier 2 compaction being active.

**Scope:** Best-fit. Exactly what the extension surface was designed for. No overreach.

**Philosophy fit:** Honors 'validate at boundaries', 'make illegal states unrepresentable', 'errors are data'. Minor conflict with 'determinism' (subprocess hook can fail non-deterministically).

---

### Candidate B: Dual-Channel Integration (Adds SM Compaction Coverage) -- DEFERRED

**Summary:** Same 3 hooks as Candidate A PLUS write WorkRail step notes as an appended section in Claude Code's session memory file at `getSessionMemoryPath()` after every successful WorkRail step advance.

**Tensions resolved:**
- SM compaction bypass: session memory file is read by Tier 1 SM compaction. WorkRail's section is included in the SM-derived summary.

**Tensions accepted:**
- Portability: couples to Claude Code internal file path (`~/.claude/projects/{project_id}/{session_id}/session_memory.md`). Version-sensitive.
- Risk of file format rejection: `isSessionMemoryEmpty()` and `truncateSessionMemoryForCompact()` parse the file. Unknown if appended WorkRail section is preserved or truncated.

**Boundary solved at:** Claude Code session memory file (internal path) + hooks system.

**Data structures:**
- Session memory WorkRail section: `\n## WorkRail Session State\n**Session:** {id}\n**Step:** {n}/{total} -- {title}\n**Notes:** {last_step_summary}\n**Pending:** [{next_step_titles}]\n`. Kept under 500 tokens to avoid `truncateSessionMemoryForCompact()` truncation.
- On WorkRail session start: remove previous WorkRail section, write fresh one.

**Failure mode:** Claude Code's `truncateSessionMemoryForCompact()` truncates WorkRail section silently. Mitigation: keep section small. Graceful fallback: if `isSessionMemoryEmpty()` returns true (empty template), SM compaction falls back to Tier 2, and PreCompact hook fires.

**Repo pattern relationship:** Departs from documented extension mechanisms. Writes to a Claude Code internal file -- explicitly against WorkRail's portability principle.

**Gain:** Full Tier 1 SM compaction coverage.
**Give up:** Coupling to Claude Code internals. YAGNI violation (SM compaction is feature-flagged, not default).

**Scope:** Too broad for MVP. Feature-flagged protection against non-default behavior.

**Philosophy fit:** Conflicts with 'YAGNI with discipline' and architectural portability. Honors 'make illegal states unrepresentable' (notes survive all compaction tiers).

**Pivot condition:** Implement when `getFeatureValue_CACHED_MAY_BE_STALE('tengu_sm_compact', false)` returns `true` by default in new Claude Code releases (SM compaction enabled for >50% of users).

---

### Candidate C: Daemon Mode Integration (Autonomous Sessions)

**Summary:** WorkRail's daemon injects current session state into the system prompt of each new pi-mono `Agent` instance. In-process evidence gate checks tool call log before `executeContinueWorkflow()`.

**Tensions resolved:**
- Daemon deployment context (no Claude Code = no hooks available)
- Portability (zero Claude Code dependency)
- Determinism (in-process gate is fully deterministic -- no subprocess reliability concern)
- Evidence gate strength (in-process check = truly structural, stronger than hook-based)

**Tensions accepted:**
- Context window cost: system prompt injection adds ~200-500 tokens per new session. In long autonomous runs, compounds. Mitigation: inject only last 3 step note summaries, not full history.

**Boundary solved at:** `src/daemon/runWorkflow.ts` (proposed). Before `agentLoop()`, reads session state from WorkRail session store and prepends to base system prompt.

**Data structures:**
- System prompt WorkRail section: `<workrail_session_state>\nWorkflow: {id} | Step: {n}/{total} {title}\nRecent notes:\n{last_3_step_note_summaries}\nPending steps: {next_3_step_titles}\n</workrail_session_state>`. XML-tagged for easy identification.
- Evidence gate: reads `tool_call_log` entries from WorkRail session store (append-only event log). Checks required evidence list from `requiredEvidence` context field. Returns `{ ok: boolean, missing: string[] }`. No subprocess.
- Tool call logging: the daemon's `BeforeToolCallResult`/`AfterToolCallResult` hooks (pi-mono `Agent` API) log each tool call to the WorkRail session store as `tool_call_observed` events.

**Failure mode:** System prompt grows too large if every step's notes are included. Fixed by keeping only last 3 summaries. Full history always available via WorkRail session store.

**Repo pattern relationship:** Follows WorkRail's existing `intent: rehydrate` pattern (reconstructs session context for resumed sessions). The daemon does this at every session init, not just on resume. The `context_set` event in WorkRail's session store maps directly to what the daemon injects into the system prompt.

**Gain:** Zero Claude Code dependency, works with any LLM, fully deterministic, structurally stronger evidence gate than hook-based.
**Give up:** Token cost per session. WorkRail must own the full system prompt construction (cannot delegate to Claude Code's prompt builder).

**Scope:** Best-fit for daemon mode. MVP-required -- daemon has no other mechanism for context injection or evidence enforcement.

**Philosophy fit:** Fully honors 'determinism over cleverness', 'make illegal states unrepresentable' (in-process gate = truly illegal state), 'errors are data' (Result-typed gate check). No conflicts.

---

## Comparison and Recommendation

| Criterion | A (Hooks-Only) | B (Dual-Channel) | C (Daemon) |
|-----------|----------------|------------------|------------|
| SM compaction survival | Loses (Tier 1 bypasses) | Wins | N/A |
| Legacy compaction survival | Wins | Wins | N/A |
| Evidence gate strength | Good (hook-based) | Good (same) | Best (in-process) |
| Portability | Best | Medium (internal file) | Best |
| Determinism | Medium (subprocess) | Medium (same) | Best |
| Scope fit | Best-fit | Too broad MVP | Best-fit |
| Reversibility | Easy | Medium | Easy |
| Implementation cost | Low (~3 scripts) | Medium (+file write logic) | Medium (prompt builder) |

**Recommendation: Implement A + C together. Defer B.**

A and C are complementary (not alternatives) -- they cover the two deployment contexts. B is deferred until SM compaction is default.

**For human-driven sessions (Claude Code + WorkRail MCP):** Candidate A. Uses the only documented extension surface. PreCompact hook covers Tier 2 compaction. PostToolUse + PreToolUse hooks implement the evidence gate.

**For daemon mode (WorkRail daemon + Anthropic API):** Candidate C. No hooks available. System prompt injection is the only mechanism. In-process evidence gate is actually stronger than hook-based.

---

## Self-Critique

**Strongest counter-argument (against deferring B):**
Anthropic is actively developing SM compaction (it's the "preferred" path in the source). When it ships broadly, hook-only users silently lose context notes. The fix (append section to file) is 30 lines of code. Deferring creates urgency debt.

Counter: WorkRail's `intent: rehydrate` is the recovery mechanism for context loss. SM compaction bypass is a degradation, not a failure. And Candidate A's PreCompact hook provides a display message when compaction runs -- users know their notes were submitted to the summarizer. The session store is always ground truth.

**Narrower option considered:**
Candidate A without the PreToolUse evidence gate. Loses -- evidence gate is the core enforcement mechanism for `requiredEvidence`. Without it, the feature is advisory.

**Pivot conditions for B:**
1. `tengu_sm_compact` feature flag becomes default-true in Claude Code
2. WorkRail users report context loss after compactions (SM compaction is now common)
3. Confirmed via testing that WorkRail section survives `truncateSessionMemoryForCompact()`

**Assumption that would invalidate Candidate A:**
Anthropic restricts PreToolUse hooks for MCP tools. The source shows no such restriction -- `matchQuery` on `tool_name` works for any tool name including `mcp__workrail__continue_workflow`. But if Claude Code adds a security restriction that MCP tools cannot be gated by hooks (to prevent malicious MCPs from blocking legitimate tools), the evidence gate breaks. Mitigation: monitor Claude Code releases.

---

## Open Questions for Main Agent

1. Should the `setup-hooks.sh` merge strategy use `jq` to merge into existing settings.json, or is a simpler approach (add to a separate `settings.workrail.json` that Claude Code merges) viable? Claude Code merges settings from multiple sources (user, project, local) -- check if WorkRail can register as a local settings source.

2. For Candidate C daemon mode: should the WorkRail system prompt section use XML tags (`<workrail_session_state>`) or markdown headers (`## WorkRail Session State`)? XML tags are less likely to conflict with other system prompt sections and are easier for the agent to identify.

3. Evidence gate for daemon mode: should `requiredEvidence` be checked by the WorkRail engine before advancing, or should WorkRail's daemon implement the check as a `BeforeToolCallResult` hook on `continue_workflow` calls? The latter is more modular but adds complexity.

4. The PostToolUse hook filters by tool name matcher `'Bash|Write|Edit'`. Should it also match MCP tool names that produce side effects (e.g., `mcp__glean_default__*` writes, `mcp__jira__*` updates)? Or is the gate only for filesystem-level evidence?
