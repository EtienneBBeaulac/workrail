# Now / Next / Later

This is the lightweight cross-cutting roadmap view for WorkRail.

## Now

- ~~Complete v2 sign-off and cleanup~~ (done -- v2 is default-on; stale docs cleaned up)
- ~~Expand lifecycle validation coverage to a realistic target~~ (done -- auto-walk smoke test covers all bundled workflows)
- ~~Finish prompt vs supplement boundary alignment across runtime, docs, and planning~~ (done -- boundary is documented consistently across authoring locks, execution contract, and planning docs)
- ~~Modernize `workflow-for-workflows.v2.json` so one canonical authoring workflow supports both creating and modernizing workflows~~ (done -- shipped in `#152`, tracked from issue `#151`)

## Next

- ~~Content coherence: introduce StepContentEnvelope and linked references~~ (done -- see `docs/plans/content-coherence-and-references.md`)
- Build a concrete plan for composition and middleware
- Resolve progress notification design issues and decide whether it is worth doing now
- Design authorable response supplements as a narrow typed feature, without implementing it yet

## Later

- Dashboard artifacts: replace file-based docs with session-scoped structured outputs rendered in the console (design exists in `workflow-execution-contract.md`, blocked on console UI)
- Platform evolution: discovery, sharing, portable references, MCP resources/prompts, agent-driven setup (see `docs/plans/workrail-platform-vision.md`)
- Multi-tenancy and running-workflow upgrades
