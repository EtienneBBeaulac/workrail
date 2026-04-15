# Design Review Findings: WorkRail User Interaction Model

---

## Tradeoff Review

### Tradeoff 1: Console is Eventually Consistent

**Severity: Yellow** (low risk, design-inherent)

The console reconstructs state from an append-only event log with SSE + 5s polling. Humans always see projections of past events, not instantaneous state.

- Will not violate acceptance criteria for an observation tool
- Would become unacceptable if interactive/real-time control is added -- current design explicitly precludes this
- Hidden assumption: session authors accept eventual consistency as the monitoring contract

### Tradeoff 2: goal Fidelity Depends on Agent Quality

**Severity: Yellow** (known risk, partially mitigated)

WorkRail validates `goal` at the MCP boundary (`z.string().min(1)`) but cannot enforce that the agent translates human intent accurately.

- Could violate success criterion 2 (descriptive session titles) if agents set generic goals
- Partially mitigated by fallback title derivation (recap text as priority 2 in `TITLE_CONTEXT_KEYS`)
- Fallback only activates after first `continue_workflow` note; session title at creation time is always `goal`

---

## Failure Mode Review

### Failure Mode: CLI Gap

**Status: Eliminated.** `src/cli/commands/start.ts` examined during adversarial challenge. The CLI `start` command launches the MCP server process -- it does not create sessions or execute workflows. Two-surface model confirmed.

### Residual Unexamined Areas

**Severity: Yellow** (low probability, named for completeness)

- `scripts/` directory: not examined
- HTTP API routes: not fully audited (only console hooks, which are all GET)

Evidence against these being material: AGENTS.md states console is read-only; README Quick Start shows no write path; all console API hooks are read-only. Probability of a hidden write endpoint: very low.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate 2: CLI Audit):** Subsumed by adversarial challenge. CLI examined; confirmed harmless. Candidates converged.

**Simpler alternative:** Answer the literal questions without the full landscape. Would satisfy the questions but lose the `goal` lifecycle, eventual consistency caveat, and domain event sourcing insight. Not recommended -- the current answer is already lean.

**Hybrid:** None warranted. No uncomfortable tradeoffs remain.

---

## Philosophy Alignment

All relevant principles satisfied:

| Principle | Status |
|-----------|--------|
| Surface information, don't hide it | SATISFIED -- gaps named explicitly |
| Validate at boundaries, trust inside | SATISFIED -- documented as system observation |
| Immutability by default | SATISFIED -- append-only event log documented |
| YAGNI with discipline | SATISFIED -- stopped at sufficient accuracy |
| Document why, not what | SATISFIED -- rationale provided for all key design choices |

One acceptable tension: completeness vs YAGNI (residual unexamined areas). Acceptable given stated goal.

---

## Findings

**No Red findings.**

**Orange (1):**
- `O1: goal fidelity gap` -- WorkRail's quality contract for session titles depends on agent behavior, not WorkRail's own validation. Sessions may have unhelpful titles if agents write poor `goal` strings. Fallback exists (recap text) but only activates after first advance.

**Yellow (3):**
- `Y1: Eventually consistent console` -- 5s lag while viewing a session. Acceptable for observation; would be a problem if interactive control is added.
- `Y2: scripts/ not examined` -- Low probability of a hidden session creation path. Named for completeness.
- `Y3: HTTP router not fully audited` -- Same caveat as Y2.

---

## Recommended Revisions

No revisions to the investigation answer are needed. The two-surface model is confirmed complete. The CLI gap is closed.

The only actionable recommendation: if this investigation is used as a basis for end-user documentation, add a note about `goal` quality (O1) -- advise agent authors to write specific, descriptive `goal` strings.

---

## Residual Concerns

- `O1` is a known system quality risk outside WorkRail's direct control. Partially mitigated by fallback title derivation. No code change needed for this investigation.
- `Y2`/`Y3` are documentation-grade caveats. Only relevant if an exhaustive system audit is required.
