## Production Readiness Audit Rubric

Use this rubric when running the bundled `production-readiness-audit` workflow.

### Coverage domains

- Debugging and correctness
- Runtime readiness
- Technical debt and maintainability
- Philosophy and repo-pattern alignment
- Tests and observability
- Security and performance when the audited scope materially touches them

### Finding classes

- **Confirmed**: supported by primary evidence such as code, tests, build output, runtime traces, or a directly checked artifact
- **Plausible**: directionally concerning, but not yet strong enough to drive the verdict alone
- **Rejected**: weakened or disproved by fuller context or direct evidence

### Verdicts

- **ready**: no material blockers, no major unresolved gaps, and confidence is strong enough for the audited scope
- **ready_with_conditions**: broadly shippable, but bounded conditions or follow-up work still matter
- **not_ready**: blockers or major risks make shipping irresponsible right now
- **inconclusive**: the scope or evidence is too weak for a clean readiness call

### Confidence bands

- **High**: coverage is materially adequate and serious claims are backed by primary evidence
- **Medium**: most important areas are covered, but some uncertainty or weaker proof remains
- **Low**: major gaps, contradictions, or thin evidence still cap the verdict

### Severity discipline

- Do not upgrade a claim to blocker status just because multiple subagents agree
- Do not flatten real contradictions into a single confident story without adjudication
- Do not call a scope production-ready when a material coverage gap still weakens the verdict

### Synthesis discipline

- Treat delegated output as evidence, not final truth
- Say what changed your mind, what you rejected, and why
- Keep the final handoff decision-focused rather than implementation-focused
