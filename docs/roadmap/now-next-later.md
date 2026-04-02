# Now / Next / Later

This is the lightweight cross-cutting roadmap view for WorkRail.

## Now

- ~~Complete v2 sign-off and cleanup~~ (done -- v2 is default-on; stale docs cleaned up)
- ~~Expand lifecycle validation coverage to a realistic target~~ (done -- auto-walk smoke test covers all bundled workflows)
- ~~Finish prompt vs supplement boundary alignment across runtime, docs, and planning~~ (done -- boundary is documented consistently across authoring locks, execution contract, and planning docs)
- ~~Modernize `workflow-for-workflows.v2.json` so one canonical authoring workflow supports both creating and modernizing workflows~~ (done -- shipped in `#152`, tracked from issue `#151`)
- ~~Strengthen rehydrate and resume retrieval budgets with deterministic retrieval contracts and broader verification~~ (done -- explicit tiered contracts, 24 KB recovery budget, 2 KB resume preview budget, tier-drop tests; shipped in `#144161e`)
- ~~Modernize `workflow-for-workflows.v2.json` so one canonical authoring workflow supports both creating and modernizing workflows~~ (done -- modernization support landed earlier; the workflow has now been pushed further into a deeper quality gate with effectiveness, simulation, adversarial review, and redesign-loop phases)

## Next

- ~~Content coherence: introduce StepContentEnvelope and linked references~~ (done -- see `docs/plans/content-coherence-and-references.md`)
- ~~Workflow-source setup phase 1: rooted team sharing, remembered roots, grouped source visibility, and migration-aware precedence explanation~~ (done -- phase-1 workflow-source setup landed across `#160`–`#164`; see `docs/plans/workflow-source-setup-phase-1.md`)
- Promote assessment-gate follow-up from the current `bug-investigation.agentic.v2.json` pilot into a higher-value workflow such as `mr-review-workflow.agentic.v2.json`
- Decide whether the current retrieval tier model needs another refinement pass after broader usage, or whether the next move should be doc/spec consolidation only
- Trial the redesigned `workflow-for-workflows.v2.json` quality gate and `production-readiness-audit.json` on several real tasks, then tune `STANDARD` vs `THOROUGH` depth based on observed usefulness and ceremony
- Design console execution-trace UX so runs explain fast paths, conditions, and skipped authoring phases instead of only showing created DAG nodes
- Build a concrete plan for composition and middleware
- Resolve progress notification design issues and decide whether it is worth doing now
- Design authorable response supplements as a narrow typed feature, without implementing it yet

## Later

- Dashboard artifacts: replace file-based docs with session-scoped structured outputs rendered in the console (design exists in `workflow-execution-contract.md`, blocked on console UI)
- Broaden the console from a node-only dashboard into a richer control-plane surface for engine state, execution trace, and decision explanation
- Platform evolution: discovery, sharing, portable references, MCP resources/prompts, agent-driven setup (see `docs/plans/workrail-platform-vision.md`)
- Multi-tenancy and running-workflow upgrades
