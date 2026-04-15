# Design Review Findings: Claude Code Integration Points for WorkRail Auto

**Design reviewed:** design-candidates-claude-code-integration.md
**Selected direction:** Candidate A (4 hooks for human-driven sessions) + Candidate C (system prompt injection + in-process gate for daemon mode).
**Date:** 2026-04-14

---

## Tradeoff Review

| Tradeoff | Status | Notes |
|----------|--------|-------|
| SM compaction bypass (hook never fires for Tier 1) | ACCEPTABLE with detection | Add optional PostCompact hook to detect when SM compaction fires. Users with SM compaction enabled get explicit recovery prompt. Not blocking for MVP (feature-flagged). |
| PostToolUse subprocess reliability | ACCEPTABLE with mitigation | Gate must be fail-open: if evidence log missing or unreadable, ALLOW advance + log warning. Only block if log EXISTS and evidence is confirmed absent. |
| Separate NDJSON evidence file (not unified with session store) | ACCEPTABLE for MVP | v2 path: WorkRail CLI command writes directly to session store. Documented architectural direction. |
| Token cost of system prompt injection (daemon) | ACCEPTABLE | Capped at last 3 step note summaries (~200 tokens each = max 600 tokens). Well within any context window. |
| Per-agent-id evidence log files (prevents concurrent write corruption) | REQUIRED CHANGE | Original design used single file per session. Concurrent writes from parallel workers would corrupt NDJSON. Must be per-agent-id. |

---

## Failure Mode Review

| Failure Mode | Severity | Handled? | Required Mitigation |
|--------------|----------|----------|---------------------|
| SM compaction bypass (Tier 1 fires, PreCompact hook skipped) | MEDIUM | Partially | Add optional PostCompact hook that detects missing WorkRail context in compact_summary and injects recovery prompt. |
| PostToolUse hook fails silently -> evidence log not written | LOW (with fail-open) | YES | Gate fail-open when log missing. Log warning to ~/.workrail/hook-errors.log. Console should surface hook errors. |
| PreToolUse hook does NOT fire for MCP tool calls | HIGH | NO | Must empirically verify before shipping evidence gate. Test: register PreToolUse hook matching `mcp__workrail__continue_workflow`, verify it fires. |
| Daemon system prompt growth (many steps, large notes) | LOW | YES | Cap at last 3 summaries, 200 tokens each. |
| Evidence log NDJSON concurrent write corruption | MEDIUM | NO | Must use per-agent-id files: ~/.workrail/evidence/{session_id}-{agent_id}.ndjson. |

---

## Runner-Up / Simpler Alternative Review

**Candidate B (session memory file write):** Deferred. One element borrowed: PostCompact hook for SM compaction detection. No session memory file writes at MVP.

**Simpler alternative (PreCompact hook only, no evidence gate):** Rejected. Fails criterion 4 (gates continue_workflow on evidence). Not simplifiable.

**Minimum viable version (PreCompact + no evidence gate):** Acceptable if evidence gate is explicitly descoped as v2. The backlog marks evidence gate as MVP blocking -- so it stays.

---

## Philosophy Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| Make illegal states unrepresentable | SATISFIED (daemon) / PARTIAL (human-driven) | Daemon: in-process gate is structural. Human-driven: subprocess hook can fail. Acceptable given hook model is the only mechanism. |
| Errors are data | SATISFIED | Hook output is structured JSON. PreToolUse denial includes typed permissionDecision + reason text. |
| Validate at boundaries | SATISFIED | PreToolUse hook fires AT the continue_workflow boundary. Internal engine trusts boundary ran. |
| Immutability by default | SATISFIED | Evidence log is append-only NDJSON. Session store is append-only. |
| YAGNI with discipline | SATISFIED | Candidate B deferred with explicit pivot condition. No speculative protection. |
| Determinism | PARTIAL | Hook subprocess can fail non-deterministically. Mitigated by fail-open. |
| Type safety | N/A | Hook scripts are shell scripts. Claude Code provides Zod validation on hook output at runtime. |

---

## Findings

### RED (blocking for correct design)

**R1: Evidence log concurrent write corruption**
The original design uses `{session_id}.ndjson` -- a single file per session. In coordinator/worker mode, multiple agents call tools simultaneously. Concurrent `append` operations to a single file produce interleaved lines = corrupt NDJSON. The PreToolUse gate reads a corrupt file and either errors out (gate blocked) or misses entries (gate passes when it shouldn't).
**Required fix:** Use `{session_id}-{agent_id}.ndjson`. The PreToolUse gate aggregates across all agent-id files for the session when checking evidence.

### ORANGE (should fix before shipping)

**O1: PreToolUse hook on MCP tools -- empirical test required before shipping evidence gate**
The source code confirms no restriction on MCP tool names in hook matchers. But the source is leaked and may not reflect the shipped version. If PreToolUse hooks don't fire for MCP calls, the evidence gate is silently disabled with no error. This would be discovered only when evidence is required but `continue_workflow` advances anyway.
**Required action:** Before shipping the evidence gate feature, run a manual test: register a PreToolUse hook matching `mcp__workrail__continue_workflow` and call the tool. Confirm the hook fires and can block the call.

**O2: PostToolUse gate must be fail-open, not fail-closed**
If the PostToolUse hook script fails (missing executable, permission error, subprocess timeout), the evidence log is not written. A fail-closed PreToolUse gate then blocks `continue_workflow` permanently. This is a stuck workflow.
**Required fix:** PreToolUse gate logic: if evidence log file DOES NOT EXIST for this session/agent, ALLOW and log warning. Only DENY if log exists AND required evidence is confirmed absent.

### YELLOW (note for implementation)

**Y1: SM compaction bypass is a known gap (not blocking for MVP)**
When Anthropic's SM compaction (Tier 1) is enabled for a user, the PreCompact hook never fires. WorkRail context notes are not injected into the compaction summary. The live context window does not have WorkRail state after compaction.
**Optional mitigation:** Add PostCompact hook script that reads `compact_summary` from stdin and checks for WorkRail marker strings. If absent, outputs `additionalContext` prompting the agent to call `intent: rehydrate`. This turns a silent degradation into an explicit recovery prompt.

**Y2: System prompt injection requires WorkRail to own the full prompt (daemon mode)**
When the daemon constructs each Agent instance's system prompt, it must prepend the WorkRail state section. This means the daemon cannot delegate prompt construction to a library that generates the full prompt. The WorkRail section must be injected before the rest of the prompt.
**Implementation note:** Use a clear XML tag: `<workrail_session_state>...</workrail_session_state>`. Tag makes the section identifiable and parseable if the agent or future tooling needs to inspect it.

---

## Recommended Revisions

1. **Change evidence log file naming** from `{session_id}.ndjson` to `{session_id}-{agent_id}.ndjson` (RED R1).
2. **Make PreToolUse gate fail-open** when evidence log is missing (ORANGE O2).
3. **Add empirical MCP hook test** to the evidence gate implementation checklist (ORANGE O1).
4. **Add optional PostCompact hook script** to the hook setup bundle (YELLOW Y1, low-priority).
5. **Use XML tags** for WorkRail system prompt section in daemon mode (YELLOW Y2, implementation detail).

---

## Residual Concerns

1. **SM compaction broad rollout (future):** When Anthropic enables SM compaction by default, WorkRail users in human-driven sessions will experience silent context loss every compaction. Candidate B (session memory file write) becomes necessary at that point. Monitor Claude Code releases for `tengu_sm_compact` flag becoming default.

2. **Unified evidence store (v2):** The separate NDJSON evidence file is a known architectural debt. v2 path: WorkRail CLI command (`workrail evidence log`) writes `tool_call_observed` events to the session store. Both deployment contexts (hook scripts + daemon) use the same store. The PreToolUse gate reads from the session store directly.

3. **MCP tool hook restrictions:** Anthropic could restrict hooks on MCP tools for security reasons (to prevent malicious MCPs from blocking legitimate tools). This would break the evidence gate. WorkRail should have a fallback: if PreToolUse hook cannot intercept MCP calls, move the evidence check server-side to the `executeContinueWorkflow` handler, reading the transcript file from the hook context path.
