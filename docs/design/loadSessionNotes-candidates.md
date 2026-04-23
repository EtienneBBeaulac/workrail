# Candidate Directions: loadSessionNotes Test Coverage

**Context:** Issue #393. A complete test implementation (14 tests, all passing) already exists
uncommitted on disk. The design question is: which approach to land?

---

## Candidate A: Ship the existing implementation as-is (Direct export + vi.mock)

**Summary:** Export `loadSessionNotes` from `src/daemon/workflow-runner.ts` (already done in
working tree) and ship `tests/unit/workflow-runner-load-session-notes.test.ts` (already written,
14/14 passing) as a single focused PR closing issue #393.

**Why it fits the path:** This is the `design_first` fast-exit conclusion. The design decision
was already made by a prior session. Shipping it closes the triggering issue and stops the
"done but not shipped" daemon loop.

**Strongest evidence for it:**
- Implementation is 100% complete, verified, and ready. Zero additional work required.
- `workflow-runner-spawn-agent.test.ts` establishes the vi.mock + vi.hoisted precedent for the
  same pattern of module-level dependency stubbing.
- All 7 success criteria (Phase 1f) are satisfied.

**Strongest risk against it:**
- The export adds a name to `workflow-runner.ts`'s public surface that wasn't there before.
  If the module is later refactored, the export may need to move. Low probability — the
  function is already stable and the module is protected.
- vi.mock is considered a weaker pattern than fakes per project philosophy. The test is
  correct but not architecturally ideal.

**When it wins:** When the goal is closing #393 cleanly with zero additional implementation
risk. This is the correct choice for an autonomous agent operating with surgical constraints.

---

## Candidate B: Extract first, then ship (Module extraction + pure fake tests)

**Summary:** Move `loadSessionNotes` (and its constants `MAX_SESSION_NOTE_CHARS`,
`MAX_SESSION_RECAP_NOTES`) into a new module `src/daemon/session-recap-loader.ts`. Export
from there. Update the single import in `workflow-runner.ts`. Rewrite
`tests/unit/workflow-runner-load-session-notes.test.ts` to import from the new module and
use real fakes instead of vi.mock.

**Why it fits the path:** This is the "stronger reframe" the design_first path asks for.
It solves the underlying architectural concern: `workflow-runner.ts` is already large
(3500+ lines), and session recap loading is a separable concern. Better module boundaries
reduce future vi.mock dependency in tests.

**Strongest evidence for it:**
- Prior session's discovery (see design doc) explicitly recommended Option A (extraction)
  over Option B (direct export).
- Project philosophy: "prefer fakes over mocks" and "compose with small, pure functions."
- A separate module makes `loadSessionNotes` testable without any vi.mock overhead.
- `src/daemon/session-recap-loader.ts` would be a natural home alongside
  `session-recap` related code.

**Strongest risk against it:**
- Requires undoing the already-implemented working-tree changes and writing ~150 additional
  lines across two files.
- `src/daemon/` is listed as a protected directory in AGENTS.md — autonomous modification
  requires the change to be strictly surgical. Extraction is more invasive than export.
- Every day this work sits undone, issue #393 stays open and the daemon fires more
  discovery sessions. Candidate B takes longer.
- The test file written for Candidate A (vi.mock) is perfectly functional and follows
  established precedent.

**When it wins:** When the project owner explicitly prefers module extraction over direct
export for architectural cleanliness, and is willing to accept a slightly larger PR.

---

## What would change the verdict

Switch from Candidate A to Candidate B if **either** of these is true:
1. The project owner confirms that `src/daemon/session-recap-loader.ts` was the intended
   approach before implementation started (i.e., Option A from the prior session was
   the authoritative decision, not merely a recommendation).
2. A code review of the PR for Candidate A explicitly requests module extraction as a
   blocking concern before merge.

In the absence of either signal, Candidate A wins: it is already implemented, already
tested, follows established project precedent, and closes the issue immediately.

---

## Candidate C (considered, not recommended): Make contracts visible via Result types

**Summary:** Change `loadSessionNotes` to return `Result<readonly string[], Error>` instead
of silently returning `[]` on failure. Force the caller to decide how to handle each failure
mode explicitly. Tests then assert on `Result` discriminants rather than `[]` shortcircuits.

**Why it is genuinely different:** This reframes the problem from "test the silent-fail
function" to "make the function's contracts visible at the type level." It addresses the
root cause: the function hides its failure modes from callers and from tests.

**Why it is not recommended:**
- Requires changing `loadSessionNotes` signature AND the `Promise.all` caller at line 3498
  in `src/daemon/workflow-runner.ts` (protected file, more invasive than export-only).
- The three failure paths are ALL best-effort recoveries — there is no meaningful action
  the caller can take differently based on which failure occurred. Silent `[]` IS the correct
  contract for a best-effort context-injection helper.
- Result types add value when the caller needs to branch. Here, the caller always passes
  `[]` to `buildSessionRecap`, which returns `''` for empty. The Result type would be
  immediately `.unwrapOr([])`'d — adding type complexity with no behavioral change.
- Scope creep relative to issue #393.

**When it wins:** Never, for this specific problem. Might be correct in a future refactor
that redesigns the session recap injection architecture more broadly.
