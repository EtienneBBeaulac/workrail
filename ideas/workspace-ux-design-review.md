# Design Review: Workspace UX Candidate B

## Tradeoff Review

| Tradeoff | Acceptable? | Condition where it fails |
|---|---|---|
| Detail requires expand | Yes -- IF recap subtitle is shown inline | Omit subtitle = context recovery regression |
| Long sections (10+ branches) | Yes -- compact rows are dense enough | Power user with 15+ branches; mitigate with 'show N older' at threshold of 7 |
| FeaturedCards removed | Yes -- recap subtitle + expand is equivalent at lower spatial cost | If users rely on nodeCount inline (unlikely) |

## Failure Mode Review

| Mode | Coverage | Risk |
|---|---|---|
| Recap subtitle missing | Must be in spec, not deferred | HIGHEST -- unmitigated context recovery regression |
| Dormant sorts as complete | Resolved by dormant sort tier + distinct dot | HIGH if omitted -- hides incomplete work |
| Section too long | 'Show N older' collapse at threshold 7 | MEDIUM -- usability annoyance, not crisis |

## Runner-Up / Simpler Alternative

Runner-up A (minimal patch) is a strict subset of B's fixes -- no elements to borrow separately.

**B+ hybrid worth noting:** Keep ONE FeaturedCard per section for the single most recent in_progress session (expanded by default). All other branches are compact rows. This gives context recovery for the most urgent work without large-card overhead for everything. Not required for the initial implementation but a clean evolution path if recap subtitle alone proves insufficient.

## Philosophy Alignment

All principles satisfied. One acceptable tension: recap subtitle adds a new data field to CompactRow. Justified by context recovery requirement -- without it the design regresses.

## Findings

**Orange: recap subtitle must be in the spec, not deferred**
The challenge agent correctly called out that the 'pivot condition' framing for the subtitle deferred the mitigation for the design's most serious weakness. The subtitle is mandatory, not optional, for B to be a net improvement over the current implementation.

**Orange: dormant must have its own sort tier and visual state**
`dormant` = incomplete but idle. It must sort ABOVE complete (below blocked) and show a distinct visual state (hollow dot or warning color). Without this, B silently hides stalled mid-workflow sessions.

**Yellow: section collapse threshold is unspecified**
The 'show N older' collapse is noted but the threshold is not defined. Recommend: 7 visible rows + expand for the rest.

## Recommended Revisions

1. **Spec addition (mandatory)**: One-line recap subtitle on every compact row (`text-xs text-[var(--text-muted)] truncate` below the branch name) when `recapSnippet` is available.
2. **Spec addition (mandatory)**: Dormant gets its own sort tier between `blocked` and uncommitted. Visual state: hollow status dot or distinct color (e.g., `var(--text-muted)` ring instead of fill).
3. **Spec addition (implementation guidance)**: Section collapse at 7 visible rows + 'Show N more branches' button.
4. **Spec addition (open question answered)**: Section header shown only when 2+ repos. Conditional on `repos.length > 1`, not hardcoded.

## Residual Concerns

- If single-repo users are the majority, the redesign's primary value is (1) fixing dormant/active confusion, (2) removing empty-state overhead, (3) adding recap subtitle -- not the repo grouping. This is still a net improvement, but the repo sections feature delivers less value than assumed.
- The 'B+ hybrid' (one FeaturedCard per section for in_progress) is a natural next step if users report missing the rich card after shipping B. Design for it intentionally so the compact row doesn't preclude adding it later.
