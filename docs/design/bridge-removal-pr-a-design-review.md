# PR-A Bridge Removal -- Design Review Findings

**Status:** Review complete. No blocking issues. Ready to implement.
**Date:** 2026-04-17
**Reviewed design:** Direct deletion of bridge-entry.ts, primary-tombstone.ts, bridge-events.ts; targeted import removal from mcp-server.ts, stdio-entry.ts, http-entry.ts.

---

## Tradeoff Review

| Tradeoff | Verdict | Notes |
|---|---|---|
| Losing `logBridgeEvent` lifecycle logging | Acceptable | No consumer reads bridge.log except bridge forensics. Grep confirms no reader in `src/`. |
| `waitForStdinReadable` removed from public API | Acceptable | Not re-exported from `mcp/index.ts`. Only consumer is `tests/unit/mcp/stdin-probe.test.ts` which is also deleted. |
| `mcp-server.ts` JSDoc describes removed behavior | Requires fix | Top comment block (lines 11-24) explains auto-bridge mechanism that will no longer exist. Must update. |

---

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| Missed import in unexpected file | **Fully covered** -- grep of src/ and tests/ returned exactly the expected 7 files. TypeScript compiler provides second verification. | Low |
| `mcp-server.test.ts` string assertions failing | **Covered** -- test file read in full; no assertion for startBridgeServer, detectHealthyPrimary, or waitForStdinReadable. | Low |
| http-entry.ts transport logic accidentally broken | **Covered** -- tombstone call sites are isolated lines (32, 35, 111-113); transport registration (73-76, 78), health endpoint (89-91), and port binding (45) are untouched. | Low |

No high-risk failure modes remain.

---

## Runner-Up / Simpler Alternative Review

No genuine runner-up. All alternatives examined:
- **Keep bridge-events.ts:** Leaves dead module with bridge-specific event vocabulary. Rejected (YAGNI).
- **Skip test file deletion:** Would fail `npm test` at import resolution. Not simpler.
- **Skip source file modification:** Build fails with cannot-find-module errors. Not viable.

The selected design is already the minimal change that satisfies acceptance criteria.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Architectural fixes over patches | Satisfied -- root cause deleted, no flag |
| YAGNI with discipline | Satisfied -- all 3 modules have zero callers post-removal |
| Determinism over cleverness | Satisfied -- startup becomes one unconditional call |
| Make illegal states unrepresentable | Satisfied -- waitForStdinReadable deleted |
| Type safety as first line of defense | Satisfied -- compiler verifies completeness |
| Document why, not what | Under tension -- JSDoc needs update (see Yellow finding) |

---

## Findings

### Yellow -- JSDoc in mcp-server.ts describes removed behavior

**File:** `src/mcp-server.ts` lines 11-24 (auto-bridge and zombie-bridge guard comments)

**Issue:** After removal, the multi-line JSDoc comment at the top of the file describes behavior (auto-bridge detection, zombie-bridge guard, stdin probe) that no longer exists. Leaving it would mislead future readers.

**Recommended fix:** Replace the existing comment block with a simplified description: "Resolves transport mode from environment and starts the appropriate server."

**Severity:** Yellow -- not a correctness issue, but violates "Document why, not what" and misleads future readers.

---

## Recommended Revisions

1. **Update JSDoc in mcp-server.ts** -- replace the auto-bridge explanation (lines 11-24) with a brief description of the simplified startup path. Required before commit.

2. **Verify test passes for `mcp-server.test.ts`** -- after editing, run the test explicitly to confirm the string-match assertions still pass. This is a build-time check, but worth isolating.

---

## Residual Concerns

None. Import surface verified. Failure modes covered. Philosophy alignment confirmed. The JSDoc revision is a required edit, not an unresolved concern.
