# Discovery: Artifact Schema Enrichment

**Date:** 2026-05-15  
**Status:** In progress

## Context / Ask

The engine's `ReviewVerdictArtifactV1Schema` uses `.strict()`. Any field a workflow adds to the artifact beyond the coordinator-required routing fields causes validation failure at `complete_step`, triggering the blocked-response path. The coordinator falls back to keyword regex scanning.

**Stated goal (solution statement):** Replace `.strict()` with `.passthrough()` on artifact Zod schemas.

**Reframed problem:** The engine's artifact validation acts as a closed schema for the entire artifact, preventing workflow authors from including optional enrichment data without an engine PR. The constraint is tighter than necessary for what the engine actually needs to enforce.

## Path Recommendation

`design_first` -- the stated solution (.passthrough) may be the right answer, but assumption #2 (is the artifact even the right place for enrichment data today?) needs investigation before writing engine code.

**Rigor:** THOROUGH  
**Ambition:** ideal_solution  
**Domain:** software

## Constraints / Anti-goals

- Coordinator routing (clean/minor/blocking) must continue to work on old sessions that don't have enrichment fields
- Required fields (verdict, confidence, findings, summary) must still be type-safe -- cannot become a free-for-all
- Must not conflict with the existing extensible contract registration backlog item
- Anti-goal: adding enrichment fields just to have them if no consumer exists today

## What the coordinator actually reads

From `src/coordinators/pr-review.ts:readVerdictArtifact()`:
- `v.verdict` -- routing decision
- `v.findings[].summary` -- fix-agent goal string (first 3 summaries)
- Nothing else

`file`, `startLine`, `endLine`, `causalLink`, `remediation` would be stored in the session event log but **consumed by nothing today**.

## Candidate Directions

1. **Status quo** -- keep `.strict()`, put enrichment in notes only. Current state. Safe. Enrichment is human-readable only -- console and report scripts would have to parse notes to get it.

2. **`.passthrough()` on all artifact schemas** -- minimal engine change. Silently accepts any field. Loses type safety on enrichment fields (typos pass). No consumer today so value is only future-proofing. Conflicts slightly with extensible contract registration design (that design wants coordinator-owned schemas, not schema-agnostic passthrough).

3. **Explicit optional fields on `ReviewVerdictArtifactV1Schema`** -- add `file?: string`, `startLine?: number`, `endLine?: number`, `causalLink?: string`, `remediation?: string` to the per-finding schema. Type-safe, self-documenting, backwards compatible. Still requires an engine PR per new enrichment field. Better than passthrough but still coupled.

4. **Build the consumer first, then the schema** -- don't change the schema at all until something actually consumes the enrichment fields. Today: notes carry enrichment, coordinator reads `verdict` + `summary`. When console or report scripts want file/line data, add the fields then with the consumer as the driver.

5. **Extensible contract registration (backlog item)** -- coordinator-owned schemas, engine-enforced. The engine owns validation mechanism, coordinators own schema definitions. Solves the coupling problem architecturally. Higher complexity, longer timeline.

## Challenge Notes

- Option 2 (.passthrough) solves the symptom but creates a different problem: schema validation becomes meaningless for enrichment fields, and the extensible registration design becomes harder to justify if passthrough already "works."
- Option 3 (explicit optional fields) is correct but still requires an engine PR. It doesn't reduce the coupling, just makes it explicit.
- Option 4 (build consumer first) may be the right call today -- the enrichment fields in the workflow prompt are primarily for human-readable MR comments, not for coordinator consumption. The artifact is for routing.
- Option 5 is the right long-term architecture but overkill for the immediate problem.

## Decision Log

TBD -- pending resolution step.

## Final Summary

TBD
