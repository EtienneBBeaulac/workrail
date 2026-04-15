# nexus-core Adoption: Design Review Findings

**Date:** 2026-04-14  
**Selected design:** Candidate A (daemon session initializer) + Candidate C (epistemic standards as workflow documentation)  
**Runner-up:** Candidate B (context assembler) -- deferred to post-MVP

---

## Tradeoff Review

| Tradeoff | Violation conditions | Verdict |
|----------|---------------------|---------|
| No global advisory principles (Candidate C modified) | Workflow steps with vague criteria -- authoring quality issue, not architectural | Acceptable |
| Empty knowledge base at MVP (Candidate B deferred) | Agent fails on unfamiliar repo -- shows up in session notes, human can intervene | Acceptable |
| Learning capture deferred (Candidate D) | Missing improvement opportunities -- no regression, pure deferral | Acceptable |

All tradeoffs pass. No acceptance criteria violated under realistic conditions.

---

## Failure Mode Review

| Failure Mode | Handled? | Risk | Mitigation |
|-------------|----------|------|------------|
| Session initializer skipped during development | Partially | Low | Make `initializeSession()` return required type; TypeScript enforces it as dependency |
| Vague step-level epistemic standards | No | Medium | Workflow authoring checklist item: "specify completion evidence, not just 'yes/no'" |
| B Phase 2 built before D Phase 1 generates data | Yes (build order) | Low | Document build order dependency explicitly |

**Highest-risk failure mode:** Vague epistemic standards -- silent quality degradation that passes structural gates. Mitigation is documentation only.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate B -- context assembler):**  
Has one element worth noting: workspace identity injection is already handled by Candidate A's `SessionContext`. Nothing from B needs to be pulled into MVP. B remains correctly deferred.

**Simpler alternative (just A, skip C documentation):**  
Viable. Skipping Candidate C's documentation doesn't break any acceptance criteria. The documentation adds value for new workflow authors but is not MVP-blocking. Slightly simpler variant is acceptable.

**No hybrid needed.** Selected design is already minimal.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Architectural fixes over patches | Clearly satisfied (Candidate C is the direct embodiment) |
| Make illegal states unrepresentable | Satisfied (Result type on initializeSession) |
| Validate at boundaries, trust inside | Satisfied (init is the boundary, loop trusts SessionContext) |
| Errors are data | Satisfied (Result type) |
| Determinism over cleverness | Satisfied (context assembly when built: same inputs, same fragment) |
| Immutability by default | Satisfied (context fragment is generated value, not mutated file) |
| YAGNI with discipline | Under tension (acceptable) -- seams for B and D sketched but not built |
| Dependency injection | Satisfied (DaemonConfig injected into initializeSession) |

No philosophy principle violated. YAGNI tension is acceptable because the seams are clean.

---

## Findings

### Yellow (low risk, worth noting)

**Y1: Session initializer type safety depends on TypeScript enforcement**  
The "TypeScript enforces this" mitigation for accidentally-skipped init requires that `initializeSession()` returns a type that the daemon loop actually requires. This needs to be designed into the function signature from the start -- it's not automatic. If the daemon loop accepts an `any` or a broader union type, the enforcement disappears.

**Y2: Candidate C's documentation value is conditional on workflow author onboarding**  
The epistemic standards documentation (Candidate C modified) only helps if new workflow authors actually read it. If workflow authoring docs are not part of the standard onboarding path, the documentation has no impact. Ensure it's linked prominently in workflow authoring entry points.

**Y3: Build order for B->D dependency is only documented, not enforced**  
The "D Phase 1 must have 5 sessions before B Phase 2" rule is a judgment call. There's no automated check that would prevent premature B Phase 2 implementation. Low risk because B Phase 2 built early just adds a context assembler that reads an empty knowledge base -- graceful degradation, not failure.

---

## Recommended Revisions

1. **Function signature design (for Candidate A implementation):** `initializeSession(config: DaemonConfig): Promise<Result<SessionContext, InitError>>` where `DaemonConfig` and `SessionContext` are both opaque types that the daemon loop cannot construct without calling `initializeSession()`. This enforces the boundary structurally.

2. **Workflow authoring docs update (for Candidate C):** Add one paragraph to `docs/design/workflow-authoring-v2.md` under "Step prompt guidelines": "Specify what constitutes completion evidence for this step. Avoid yes/no criteria. Good example: 'List the 3 specific test cases you ran and their results.' Bad example: 'Did you test the implementation?'"

3. **Phasing document update (for build order):** Add to `docs/ideas/backlog.md` or `docs/design/nexus-core-discovery.md`: "Candidate D Phase 1 must generate at least 5 sessions of data before Candidate B Phase 2 is built. This ensures the context assembler has meaningful content to inject."

---

## Residual Concerns

**RC1: Cross-repo context injection timing**  
The backlog says cross-repo is post-MVP. Candidate B (context injection) is correctly deferred. But if a daemon workflow involves multiple repos at MVP (before B is built), there's no mechanism to inject per-repo context. The daemon will work, but the agent may miss important repo-specific context. This is a feature gap, not a failure. Track as: "daemon MVP has no per-repo context injection -- agent works with workspace-level context only."

**RC2: nexus-core's org profile pattern is not adopted**  
The org profile system (`configs/profiles/zillow.yaml`) is the most portable pattern in nexus-core that WorkRail doesn't have an equivalent of. The candidates above focus on daemon architecture, not workspace configuration. If WorkRail users at orgs with complex tooling (GitLab + Jira + VPN requirements) need a declarative setup mechanism, the nexus profile YAML format is a direct model. This is a separate design decision not addressed by the selected candidates. Flag for future: "consider adopting nexus's org profile YAML pattern as WorkRail's `workspace.yaml` format."

**RC3: SOUL.md's practical value is partially abandoned**  
The adversarial challenge revealed that SOUL.md's advisory principles do have practical value -- specifically "Evidence before assertion" and "Own your limits" -- that is not fully captured by structural gates unless gates are written with specific evidence requirements. Candidate C(modified) addresses this through documentation, but the documentation quality depends on workflow authors following the guidance. This is an accepted residual risk.
