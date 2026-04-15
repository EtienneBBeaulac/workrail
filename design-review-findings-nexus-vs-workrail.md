# Design Review Findings: nexus-core vs WorkRail Adoption

> Concise, actionable findings for main-agent synthesis. Complement to design-candidates-nexus-vs-workrail.md.

## Tradeoff Review

| Tradeoff | Acceptable under expected conditions? | What makes it unacceptable |
|----------|--------------------------------------|---------------------------|
| C1: prompt-based enforcement (skipped steps possible) | Yes, for single-session tasks with healthy context | Security-sensitive workflows; very long sessions; weaker models (Haiku in cost-saving mode) |
| C1: no cross-session durability | Yes, for single-session tasks | Multi-day workflows; epic-level work; remote work with frequent interruptions |
| C3 overhead: two systems to maintain | Acceptable - meta-workflow JSON is ~30 min to author; WorkRail is zero-install via npx | nexus-core /flow phase structure changes frequently (meta-workflow needs sync) |

**Hidden assumption requiring monitoring:** Most nexus-core /flow sessions at Zillow complete in a single IDE session. If multi-session execution is common in practice, the C1 durability tradeoff is unacceptable today, not eventually.

---

## Failure Mode Review

| Failure Mode | Design handling | Missing mitigation | Risk level |
|--------------|-----------------|--------------------|------------|
| C1: agent skips verification gate in long session | Not handled technically; '/flow --checkpoints' is a human-gate workaround | No automated gate detection | Medium (recoverable in review, but wasted work) |
| C3: agent treats WorkRail notes as formality | Partially - `notesOptional: false` blocks empty notes; server does not validate content quality | Step prompts need required content specs ('document: branch name, commits, validation results') | Low-medium (visible in audit trail; bounded damage) |

**Highest-risk failure mode:** C1's silent verification gate skip. The failure is silent at occurrence, accumulates (bad plan -> bad work -> review finds bugs), and is not proactively detectable. The '/flow --checkpoints' mitigation converts it from silent-and-accumulating to visible-and-catchable.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C3 immediately) strengths:**
- Meta-workflow JSON is cheap to author (~30 min, 4 steps)
- Checkpoint tokens have zero ongoing cost - durability is a system property, not an operation
- `requireConfirmation: true` flag can make Plan -> Work transitions explicit

**Simpler variant (C1 + '/flow --checkpoints' always on):**
- Addresses the highest-risk failure mode (silent gate skip) without WorkRail infrastructure
- This is the practical C1 recommendation with the key mitigation baked in

**Hybrid recommendation:** '/flow --checkpoints' as default for single-session work. WorkRail meta-workflow for multi-session work. Technical dividing line: session boundary, not qualitative pain level.

---

## Philosophy Alignment

| Principle | Satisfied? | Notes |
|-----------|-----------|-------|
| YAGNI with discipline | Yes | C1 as default honors YAGNI; C3 upgrade path is defined but not premature |
| Validate at boundaries | Yes | WorkRail at MCP token boundary; nexus-core at skill execution boundary |
| Determinism over cleverness | Yes | WorkRail token system is deterministic; nexus-core skill definitions are stable |
| Document 'why' not 'what' | Yes | WorkRail `notesMarkdown` directly enforces this |
| Make illegal states unrepresentable | Tension (acceptable) | C1 allows skipped steps; accepted because recoverable and '/flow --checkpoints' mitigates |
| Architectural fixes over patches | Tension (acceptable) | '/flow --checkpoints' is a patch; C3 is the architectural fix; upgrade path is defined |

**Tensions that become risky:** If nexus-core is used for security-sensitive workflows (access control, credentials), the 'make illegal states unrepresentable' tension becomes a compliance risk. C3 required in that case.

---

## Findings

### RED (blocking)
None. No finding requires blocking the selected direction.

### ORANGE (revise before finalizing)

**ORANGE-1: '/flow --checkpoints' must be the default mode, not the exception**
The highest-risk failure mode (silent verification gate skip) is only mitigated if '/flow --checkpoints' is used consistently. If it is treated as an optional flag for 'careful' sessions, the mitigation is ineffective. Revise the recommendation to specify '--checkpoints' as the standard invocation pattern for all non-trivial work.

**ORANGE-2: C3 meta-workflow step prompts need required content specifications**
The `notesOptional: false` requirement in C3 blocks empty notes but does not validate content quality. Step prompts for the meta-workflow must specify required content explicitly (e.g., 'document: plan artifact location, task DAG structure' for the plan step; 'document: branch name, commits, validation pass/fail' for the work step). Without this, C3's audit trail value is degraded.

### YELLOW (monitor)

**YELLOW-1: Multi-session prevalence assumption**
The entire C1-as-default recommendation rests on the assumption that most Zillow /flow sessions complete in a single IDE session. If epics or multi-ticket flows are common, this assumption is wrong and C3 should be the default today. Monitor session completion patterns in the first 4 weeks of nexus-core adoption.

**YELLOW-2: nexus-core /flow phase stability**
If FUB Apex refactors the /flow phase structure (adding or removing phases), any C3 meta-workflow JSON must be kept in sync. This is low-risk today (nexus-protocol.md defines the five phases as stable) but should be checked on each nexus-core upgrade.

---

## Recommended Revisions

1. Change recommendation wording: 'Use /flow (with --checkpoints as standard invocation)' rather than 'Use /flow, optionally with --checkpoints.'
2. For C3 meta-workflow: add required content specifications to each step prompt before deploying.
3. Add a 4-week monitoring checkpoint: if multi-session /flow executions are observed, accelerate to C3 immediately.

---

## Residual Concerns

1. **nexus-core active-session.md sidecar spec is not fully documented.** The /retro skill loads it as optional, confirming it is not a system-level persistence mechanism. But if FUB Apex adds more robust session persistence to nexus-core in a future update, the C1 vs C3 comparison on durability would need to be revisited.

2. **WorkRail's note-content validation is advisory, not enforced.** The server validates note presence (non-empty string), not note quality. A highly automated agent can satisfy the requirement with minimal notes. The mitigation is prompt engineering in the step text, not a system guarantee.

3. **The combined architecture (C3) has no reference implementation.** The claim that nexus-core + WorkRail can work together is grounded in architectural analysis (nexus-protocol.md 'agent-agnostic' + workrail-executor spec) but has not been demonstrated in a running session. If C3 is adopted, a proof-of-concept session should be run before team-wide deployment.
