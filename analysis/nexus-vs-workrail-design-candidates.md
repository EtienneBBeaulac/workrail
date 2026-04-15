# WorkRail Strategic Direction: Design Candidates

_Generated as part of wr.discovery workflow -- nexus ecosystem vs WorkRail positioning analysis._

## Problem Understanding

### Core Tensions

1. **Enforcement depth vs ecosystem richness** -- WorkRail's structural enforcement (token protocol) is its moat, but nexus wins on content richness (model routing, knowledge accumulation, Jira integration, learning loop). Making WorkRail richer risks diluting the enforcement focus; staying enforcement-only risks being bypassed by teams who need the full stack.

2. **Cross-session learning vs stateless portability** -- WorkRail's portability comes from being stateless-across-sessions. Adding cross-session knowledge accumulation requires persistent state, which complicates the deployment story (now users might need a running knowledge service).

3. **Evaluation credibility vs shipping speed** -- nexus-evals proves skill quality via success rate benchmarks. WorkRail has no equivalent. Building an eval framework properly takes significant effort; shipping without one means WorkRail cannot make verifiable claims about its effectiveness.

4. **Interoperability opportunity vs competitive clarity** -- WorkRail could position as the enforcement layer UNDER nexus (complements nexus), or as an alternative to nexus (competes). The interoperability play depends on nexus teams choosing to integrate; the alternative play gives WorkRail full strategic independence but requires matching nexus's content depth.

### Likely Seam

- `~/workrail/sessions/` and `~/workrail/workflows/` -- both already exist and follow append-only event log patterns
- `~/workrail/knowledge/` or `~/workrail/outcomes.jsonl` -- new files following existing patterns
- Workflow JSON schema extensions -- optional fields (backward compatible)

### What Makes This Hard

1. **Cross-session knowledge quality degrades without curation** -- a naive 'dump all notes' approach produces noise; quality filter is the hard part, not storage
2. **Evaluation requires defining success** -- domain-specific and hard to generalize across workflow types
3. **Interoperability requires a champion** -- WorkRail can publish a bridge plugin, but adoption requires nexus-side cooperation

---

## Philosophy Constraints

**Principles that constrain design:**

- **YAGNI with discipline**: No speculative backend services; start with filesystem
- **Use structure only when it earns its place**: Schema fields must prevent real failure modes or improve determinism
- **Make illegal states unrepresentable**: Outcome signals should use closed enums, not free strings
- **Validate at boundaries, trust inside**: Knowledge/outcome injection must validate at the boundary
- **No single-actor dependency**: Candidates must be actionable by Etienne alone

**No philosophy conflicts detected** between stated principles and existing repo patterns.

---

## Impact Surface

Any direction must stay consistent with:

- `continue_workflow` output schema (any extensions must be backward-compatible)
- `~/.workrail/sessions/` append-only event log format (new logs must follow the same JSONL pattern)
- Bundled workflow directory (`workflows/`) structure and discovery
- Workflow JSON schema (`workflowDefinition` type in `src/v2/durable-core/`)

---

## Candidates

### Candidate A: `wf.retro` -- Filesystem Learning Loop

**Summary:** Add a `wf.retro` bundled workflow that reads the last N session note files from `~/.workrail/sessions/`, extracts high-quality learnings via the agent's synthesis judgment, and proposes git-committed patches to the workflow JSON files used in those sessions.

**Tensions resolved:** Closes learning loop gap WITHOUT backend service. **Tensions accepted:** Does not address evaluation gap or convergence risk.

**Boundary:** `~/.workrail/sessions/` (read-only) and `~/.workrail/workflows/` (proposed patches). Both already exist.

**Why this boundary is the best fit:** No new infrastructure. Pattern matches nexus's `/retro` (extract learnings from session context, write workflow patches). Follows existing 'routines as composable fragments' pattern.

**Failure mode:** Quality degrades without an orchestrator-level quality filter. Must use agent synthesis judgment (Opus-level), not just concatenate notes.

**Repo pattern:** FOLLOWS. Routines, workflow discovery layers, notes-as-durable-record are existing patterns. `wf.retro` is a workflow like `wr.discovery`.

**Gains:** Closes the biggest gap; costs nothing to deploy; nexus's `/retro` is proven precedent.
**Losses:** Knowledge is local per-user (no shared knowledge graph like nexus-cortex-v2).

**Scope:** Best-fit. `~/.workrail/sessions/` already exists; no engine changes required.

**Philosophy:** Honors YAGNI, Use structure only when it earns its place, Functional/declarative. No conflicts.

---

### Candidate B: Auditability-First Positioning + Workflow Trust Level

**Summary:** Add optional `trustLevel: 'experimental' | 'community' | 'verified'` field to workflow JSON, define a verification process (human review + outcome logging to `~/.workrail/audit/`), and emit an audit event on each `continue_workflow` completion: `{sessionId, workflowId, stepId, timestamp, outcomeSignal}` appended to `~/.workrail/audit/<workflowId>.jsonl`.

**Tensions resolved:** Deepens the auditability moat that nexus CANNOT clone without architectural rewrite. Begins closing evaluation gap. **Tensions accepted:** Does not close learning loop. No interoperability play.

**Boundary:** Workflow JSON schema extension + `~/.workrail/audit/` directory (new, following existing sessions pattern).

**Why this boundary:** Extends existing patterns minimally. `trustLevel` is an optional schema field; audit log is JSONL following sessions pattern. Console can display trust badges without engine changes.

**Failure mode:** `trustLevel` becomes a vanity badge without a real verification process. Must define 'verified' with concrete criteria (e.g., 'N documented sessions, human-reviewed, specific outcome signals').

**Repo pattern:** ADAPTS. Extends workflow JSON schema (already has `id`, `version`, `description`). Audit log follows append-only event log pattern.

**Gains:** WorkRail can make claims nexus cannot ('provably compliant, auditable'); opens enterprise sales angle.
**Losses:** Requires defining outcome signals per workflow type (hard to generalize); slight YAGNI tension.

**Scope:** Best-fit. Schema extension is minimal; no engine changes.

**Philosophy:** Honors Determinism over cleverness, Validate at boundaries. Minor YAGNI tension (adding schema field before consumer exists).

---

### Candidate C: nexus-workrail-bridge Plugin

**Summary:** Publish a public GitHub repo (`workrail-nexus-plugin`) containing a nexus plugin that replaces nexus's `/review` skill with a WorkRail-enforced review workflow. nexus provides context (Jira, glab, model routing); WorkRail provides step enforcement.

**Tensions resolved:** Addresses convergence risk by making WorkRail a component of nexus rather than a competitor. **Tensions accepted:** Requires nexus-side champion (violates no-single-actor-dependency criterion). Does not close learning loop or evaluation gap.

**Boundary:** nexus plugin system (`scripts/nexus-plugin.sh add <url>`). Integration point exists today.

**Why this boundary:** nexus's plugin system is specifically designed for this pattern. WorkRail's MCP API is callable from any Claude Code session.

**Failure mode:** Plugin sits unused if no nexus team opts in. Etienne cannot drive adoption alone.

**Repo pattern:** FOLLOWS for a new public repo. No WorkRail engine changes.

**Gains:** If adopted, strong proof point; demonstrates interoperability without architectural commitment.
**Losses:** Depends on external cooperation; Etienne can't drive this alone.

**Scope:** Too narrow by itself (requires external cooperation). Valuable as a published capability demonstration.

**Philosophy:** Dependency injection for boundaries (WorkRail injected into nexus's review step), YAGNI. **Conflicts with:** No single-actor dependency criterion.

---

### Candidate D: Outcome Signal Protocol + `wf.eval-summary`

**Summary:** Add optional `outcomeSignal: 'succeeded' | 'partial' | 'failed' | 'unknown'` + optional `outcomeNote: string` to `continue_workflow` output schema; auto-log these to `~/.workrail/outcomes.jsonl` as `{workflowId, sessionId, stepId, timestamp, outcomeSignal, outcomeNote}`; ship a `wf.eval-summary` bundled workflow that aggregates the log and produces per-workflow success rate trends.

**Tensions resolved:** Closes evaluation gap (WorkRail can now claim 'this workflow succeeds N% of the time based on M sessions'). **Tensions accepted:** Self-reported signals are noisier than nexus-evals's controlled benchmarks. Does not close the learning loop directly.

**Boundary:** `continue_workflow` output schema (optional field -- backward compatible) + new `~/.workrail/outcomes.jsonl` + `wf.eval-summary` bundled workflow.

**Why this boundary:** Backward-compatible schema extension; follows append-only log pattern from `~/.workrail/sessions/`; `wf.eval-summary` is a workflow file like `wr.discovery`.

**Failure mode:** Agents self-report success even for partial outcomes (sycophancy bias). Mitigation: authoring guide must define calibration guidance for each signal value.

**Repo pattern:** FOLLOWS. Append-only event log pattern, output contract extension, bundled workflow.

**Gains:** Evidence base accumulates passively; zero user behavior change required; data foundation for D + A combination.
**Losses:** Self-reported signals are noisier than controlled evals; won't fully satisfy rigorous enterprise evaluation.

**Scope:** Best-fit. Backward-compatible; follows existing patterns; new files only.

**Philosophy:** Errors are data (outcome is a value), Determinism over cleverness, Validate at boundaries (closed enum). Minor tension: `unknown` as allowed state reduces pressure to provide real signal.

---

## Comparison and Recommendation

| | A: wf.retro | B: Audit/Trust | C: nexus-bridge | D: Outcome Signals |
|---|---|---|---|---|
| Learning loop gap | Resolves | Partial | No | No (but enables A) |
| Evaluation gap | No | Partial | No | Resolves (proxy) |
| Convergence risk | No | Deepens moat | Resolves (interop) | Partial |
| No single-actor dependency | YES | YES | **NO** | YES |
| Repo pattern fit | Follows | Adapts | Follows (new repo) | Follows |
| Reversibility | High | Medium | Medium | High |
| Scope | Best-fit | Best-fit | Too narrow | Best-fit |
| YAGNI fit | Excellent | Good | Excellent | Excellent |

**Recommendation: D first, then A, then B; C as a low-cost demonstration.**

**D (Outcome Signal Protocol) is primary** because it:
1. Closes the evaluation gap (most strategically important for enterprise credibility)
2. Creates the data foundation that makes A more valuable (retro that operates on real outcome data)
3. Requires no external cooperation
4. Is backward-compatible and follows existing patterns

**A (`wf.retro`) is secondary** -- once D has accumulated outcome data, a retro that can reference 'this workflow has a 40% partial rate on step 3' is far more useful than one operating blind.

**B (audit/trust) is a third phase** -- surfaces the gains from D+A to external audiences (enterprise buyers, teams evaluating WorkRail vs nexus).

**C is a low-cost demonstration** (~1 day to publish a bridge plugin repo) that signals interoperability intent without requiring nexus cooperation.

---

## Self-Critique

**Strongest argument against picking D first:** Outcome signals are self-reported and unreliable. nexus-evals uses controlled scenarios with actual success rate measurement. Self-reported signals are noisier and give WorkRail the 'appearance of evaluation without rigor.' This is legitimate -- but the alternative is no evaluation data at all. Noisy signals with trend analysis are better than zero, and calibration improves with use.

**Narrower option that might still work:** Just ship A (`wf.retro`) alone. A learning loop without outcome data is still better than no learning loop. Loses if learning quality is poor without outcome grounding.

**Broader option that might be justified:** Build a nexus-cortex equivalent (deployed knowledge service with cross-user knowledge sharing). Evidence required: WorkRail reaches a user base large enough that cross-user knowledge sharing is valuable (not yet at this scale).

**Assumption that would invalidate D:** If WorkRail workflows don't have enough repeat usage to produce meaningful outcome statistics, D produces no signal. Mitigation: `unknown` as default until usage accumulates; don't block on sparse data.

---

## Open Questions for the Main Agent

1. Is the outcome signal self-reporting problem severe enough to invalidate D, or is it acceptable as a v1 proxy with planned improvement?
2. Should `wf.retro` propose workflow patches as git commits (like nexus's `/retro`) or just produce a summary report that the user acts on manually?
3. For Candidate C (nexus bridge): is there any indication that petery/Peter Yao would be receptive to a WorkRail integration proposal, or is this purely speculative?
4. Should the auditability story (B) come before the learning loop (A), or does A have higher user value in the short term?
