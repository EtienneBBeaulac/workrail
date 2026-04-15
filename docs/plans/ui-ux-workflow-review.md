# UI/UX Workflow Design Review Findings

## Tradeoff Review

| Tradeoff | Verdict | Fails if |
|---|---|---|
| Spec not mockup | Acceptable | Team needs visual approval before implementation — add external review checkpoint |
| Context blindness | Acceptable | Agent proceeds without surfacing missing context — Phase 0 requireConfirmation handles this |
| Simple path overuse | Acceptable | Agent misclassifies complex work as Simple — requireConfirmation on classification |

## Failure Mode Review

| Failure Mode | Risk | Coverage | Missing Mitigation |
|---|---|---|---|
| Generic reviewer findings | **High** | Partially | Reviewers must cite specific elements from the design description using frozen context packet |
| Simple path overuse | Medium | Partially | requireConfirmation on complexity classification with explicit Simple criteria |
| Wrong output format | Low | N/A | Not a workflow problem — addressed by how the spec is structured |

**Highest risk: generic reviewer findings.** If reviewers produce platitudes ("consider grouping related items") instead of specific findings, the workflow produces the appearance of rigor without substance.

## Runner-Up / Simpler Alternative Review

- C (Alternatives-First) already incorporated as required step in B's hypothesis phase
- Simpler variant (remove context packet phase) rejected — reviewers lose consistency without shared context
- No hybrid opportunities

## Philosophy Alignment

All principles satisfied: make-illegal-states-unrepresentable, validate-at-boundaries, structured-freedom, errors-are-data, YAGNI (via Simple fast path). Minor acceptable tension on YAGNI resolved by Simple path.

## Findings

**Orange — Reviewer finding quality gate missing**
Both B and D need explicit constraints that reviewer families must cite specific elements from the design description or context packet. Generic UX advice without reference to the actual design is a failing output, not a valid finding. Add to metaGuidance or reviewer instructions.

**Yellow — Simple complexity criteria need explicit definition**
"Simple" must be defined concretely in Phase 0: single component modification, no IA changes, no new user flows, no new interaction patterns. Without this, agents will self-classify to avoid rigor.

## Recommended Revisions

1. Add to reviewer family instructions: "Each finding must cite a specific element, component, or decision from the frozen context packet. Generic UX principles without specific reference are not findings."
2. Define Simple explicitly: single component, no new flows, no IA changes, no new interaction patterns — everything else is Standard or Complex.
3. Consider a `designVocabulary` section in the context packet: let the agent describe layout using structured prose terms (grid, card, list, modal, drawer, etc.) as a partial substitute for visual mockups.

## Residual Concerns

- The audit workflow (D) is most useful after B produces a spec — the workflow catalog should make this composability explicit in descriptions
- Neither B nor D addresses the design system consistency problem (does this design match existing components?) — potential third workflow or reviewer family
