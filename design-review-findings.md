# Design Review Findings: WorkRail Auto / Claude Code Integration

**Selected Direction:** A (session memory section write) + B (PostToolUse HTTP hook)
**Reviewed:** 2026-04-14

## Tradeoff Review

| Tradeoff | Status | Conditions for Failure |
|---|---|---|
| Path coupling to `~/.claude/` | Acceptable | Claude Code changes sha256(cwd) formula or directory layout |
| Daemon required for evidence collection (B) | Acceptable | Non-blocking failure; clear gate error at continue_workflow |
| Session memory section could conflict with template changes | Acceptable | Use `<!-- WorkRail State -->` comment block, not header section |

All tradeoffs acceptable under realistic conditions with documented mitigations.

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| Path formula changes → silent wrong-file write | Adequate (startup validation + fallback) | MEDIUM |
| Daemon down → HTTP timeout → evidence not collected | Adequate (non-blocking, clear gate failure) | LOW-MEDIUM |
| Remote mode → session memory disabled (A breaks silently) | **INADEQUATE** -- unhandled | **HIGH** |

## Runner-Up / Simpler Alternative Review

- PreCompact hook: worth adding post-MVP as Tier 2 belt-and-suspenders, not MVP-blocking.
- daemon-state.json only: sufficient for daemon mode but not interactive MCP mode. A is justified.
- Sidecar file approach: has the same Tier 1 timing issue. Not simpler or better.

## Philosophy Alignment

**Satisfied:** Architectural fixes over patches, validate at boundaries, errors are data, determinism.

**Risky tension:** DI for I/O -- path resolver MUST be an injected port, not hardcoded. If hardcoded, tests become environment-dependent.

## Findings

**RED -- Remote Mode Silently Breaks A**
When `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` (remote/cloud mode), `initSessionMemory()` returns early and session memory extraction never runs. WorkRail daemon writes to the session memory file, the file exists, but the content is never read back during compaction. State is silently lost. The daemon has no way to detect this from outside Claude Code.

**ORANGE -- Path Resolver Must Be Validated**
The sha256(cwd) formula is an internal Claude Code implementation detail. WorkRail's path formula could diverge from Claude Code's actual formula between versions. Startup validation is required, but periodic re-validation during long sessions is missing.

**ORANGE -- Evidence Collection Disk Flush Missing**
Evidence from PostToolUse hooks is recorded in daemon memory. If daemon crashes before flushing to disk, evidence is lost. For `requiredEvidence` auditing, evidence must be durable.

**YELLOW -- Path Resolver Not Yet Injected**
DI for I/O principle requires `SessionMemoryPort` interface. If the path resolver is hardcoded at implementation time, tests will fail outside the `~/.claude/` environment.

**YELLOW -- setup-hooks.sh Idempotency**
`workrail init-hooks` must be idempotent -- registering the same hooks twice should not duplicate them. The hooks settings merging logic needs dedup on registration.

## Recommended Revisions

1. **[RED] Add remote mode detection to daemon startup.** Check `CLAUDE_CODE_ENVIRONMENT_KIND`. If `bridge`, skip session memory writes and inject state via system prompt at session initialization instead.

2. **[ORANGE] Add path validation + periodic re-check.** Validate `~/.claude/projects/<hash>/session-memory.md` at startup AND re-validate before each write. On failure, log warning and skip (rely on daemon-state.json).

3. **[ORANGE] Flush evidence to disk synchronously.** Before returning from `/hooks/post-tool-use`, write evidence to `~/.workrail/evidence/<sessionId>.jsonl`. Atomic append.

4. **[YELLOW] Inject path resolver as `SessionMemoryPort`.** Interface: `getSessionMemoryPath(cwd: string): string`. Daemon injects `ClaudeCodeSessionMemoryPort`; tests inject `FakeSessionMemoryPort(tmpDir)`.

5. **[YELLOW] Dedup hook registration in init-hooks.** Check existing `.claude/settings.json` before writing. Skip if identical hook already registered.

## Residual Concerns

- PreCompact hook as Tier 2 belt-and-suspenders: not MVP-blocking but should be added in the next pass.
- Open question from candidates: exact sha256(cwd) formula -- needs verification against `src/utils/permissions/filesystem.ts`.
- Coordinator mode for subworkflows: not covered in this review (orthogonal to compaction/evidence concerns).
