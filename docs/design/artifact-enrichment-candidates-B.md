# Artifact Enrichment Design Candidates (B-Series)

**Date:** 2026-05-15
**Author:** Claude (cautious platform engineer persona)
**Context:** Companion to `artifact-schema-enrichment-discovery.md`

---

## Problem Statement

The engine's artifact validation acts as a closed schema for the entire artifact,
preventing workflow authors from including optional enrichment data without an
engine PR. The engine conflates two concerns that should be separate:

1. Validating that coordinator-required routing fields are present
2. Defining the complete shape of what an artifact may contain

## Riskiest Assumption

The artifact is the right consumer surface for enrichment data today. The
coordinator only reads `verdict` + `finding.summary`. Nothing currently consumes
`file`/`line`/`causalLink`/`remediation` from artifacts. If this assumption is
wrong -- i.e. the artifact is NOT the right place for enrichment -- then any
schema change solves the wrong problem. The right solution would be to build
consumers or use a different channel.

**Defensibility test applied to every candidate:** What does this design look like
if the enrichment-in-artifact assumption turns out to be wrong? Can we undo it
cheaply? Does it close any doors?

---

## Approach 1 (p=0.55): `.passthrough()` on All Artifact Schemas

**Primary mechanism:** Replace `.strict()` with `.passthrough()` on every Zod
artifact schema. The engine validates required fields; any additional fields are
preserved silently.

### Code Change Example

```typescript
// Before (review-verdict.ts)
export const ReviewVerdictArtifactV1Schema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(z.object({ severity: ..., summary: ..., findingCategory: ... }).strict()),
    summary: z.string().min(1),
  })
  .strict();                // <-- removed

// After
export const ReviewVerdictArtifactV1Schema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(z.object({ severity: ..., summary: ..., findingCategory: ... }).passthrough()),
    summary: z.string().min(1),
  })
  .passthrough();           // <-- added
```

### Criteria Assessment

| Criterion | Assessment |
|---|---|
| Coordinator routing fields strictly validated | **Pass** -- required fields still fail fast if missing. |
| No infrastructure before a consumer exists | **Marginal pass** -- no new infrastructure, but the door is now open with no guard. Any field silently passes. |
| Authors don't need engine PR per optional field | **Pass** -- any new field is accepted immediately. |
| Moves toward structured outputs vision | **Fail** -- silently accepts arbitrary JSON, which is indistinguishable from unstructured data. No type safety on enrichment. A typo in `filePath` vs `file_path` passes silently. |
| Senior engineer in 2 years considers it right | **Fail** -- passthrough is the flag that says "we gave up". The CLAUDE.md principle "Types must constrain, not just label" is directly violated. A type that accepts everything its predecessor accepted is a rename, not an improvement. |

**Assumption-failure cost:** If the artifact turns out to be the wrong surface,
passthrough has already trained workflow authors to put enrichment there. Reversing
requires a communication campaign and breakage for existing workflows. Cheap to
introduce, expensive to un-introduce.

**Verdict:** Solves the immediate symptom, fails 2 of 5 criteria, creates soft
lock-in for the wrong abstraction.

---

## Approach 2 (p=0.30): Explicit Optional Fields on Affected Schemas

**Primary mechanism:** Add typed optional fields (`file?`, `startLine?`,
`endLine?`, `causalLink?`, `remediation?`) to the per-finding sub-schema in
`ReviewVerdictArtifactV1Schema`. Keep `.strict()`. Requires an engine PR per field
but each PR is a deliberate decision.

### Code Change Example

```typescript
// review-verdict.ts -- per-finding sub-schema extended
const FindingSchema = z
  .object({
    severity: z.enum(['critical', 'major', 'minor', 'nit']),
    summary: z.string().min(1),
    findingCategory: z.enum([...]).optional(),
    // New optional enrichment fields -- typed but not consumed by coordinator today
    file: z.string().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    causalLink: z.string().url().optional(),
    remediation: z.string().optional(),
  })
  .strict();
```

### Criteria Assessment

| Criterion | Assessment |
|---|---|
| Coordinator routing fields strictly validated | **Pass** -- `.strict()` retained, required fields still enforced. |
| No infrastructure before a consumer exists | **Borderline fail** -- adds fields with no consumer. The fields are declared but read by nothing; they live in the session event log only. |
| Authors don't need engine PR per optional field | **Fail** -- still requires an engine PR. Every new enrichment concept requires touching the engine schema. Problem is reframed, not solved. |
| Moves toward structured outputs vision | **Pass** -- enrichment is typed, documented, validated. `file: "foo.ts"` vs `file: 123` fails fast. |
| Senior engineer in 2 years considers it right | **Marginal** -- it's legible, but the coupling is still there. The shape of optional fields will drift away from what consumers need, or accumulate fields that were never used. |

**Assumption-failure cost:** If the artifact is the wrong channel, these fields
are dead code in the schema forever (`.strict()` means they block unknown fields
but the known ones are still there and unread). Low migration cost since the fields
are optional and unused.

**Verdict:** More honest than passthrough but doesn't solve the core coupling.
Correctly typed dead fields are still dead fields.

---

## Approach 3 (p=0.08): Two-Tier Validation -- Required Contract + Passthrough Envelope

**Primary mechanism:** Split validation into two stages. Stage 1 validates only
the coordinator-required routing fields (verdict, confidence, findings[].severity,
findings[].summary, summary). Stage 2 accepts anything else via passthrough but
type-tags it as `enrichment: Record<string, unknown>`. The engine enforces the
contract tier; enrichment is opaque to the engine.

This is structurally different from approach 1: enrichment is segregated into a
named, explicit envelope, not silently mixed with routing fields.

### Code Change Example

```typescript
// New two-tier schema in artifact-contract-validator.ts

// Tier 1: coordinator contract (strict)
const ReviewVerdictContractSchema = z.object({
  kind: z.literal('wr.review_verdict'),
  verdict: z.enum(['clean', 'minor', 'blocking']),
  confidence: z.enum(['high', 'medium', 'low']),
  findings: z.array(z.object({
    severity: z.enum(['critical', 'major', 'minor', 'nit']),
    summary: z.string().min(1),
    findingCategory: z.enum([...]).optional(),
  })),
  summary: z.string().min(1),
});

// Tier 2: enrichment envelope (open, explicit)
const ReviewVerdictArtifactV1Schema = ReviewVerdictContractSchema.extend({
  enrichment: z.record(z.unknown()).optional(),
}).passthrough();

// artifact-contract-validator.ts only validates Tier 1 (contract fields)
// The full artifact (including enrichment) is stored in the event log
// Workflow authors put enrichment in artifact.enrichment.filePath, etc.
```

### Criteria Assessment

| Criterion | Assessment |
|---|---|
| Coordinator routing fields strictly validated | **Pass** -- Tier 1 contract is strict. Routing fields fail fast if missing or wrong type. |
| No infrastructure before a consumer exists | **Pass** -- enrichment envelope exists as a named bucket, but building a consumer reads `artifact.enrichment` and is an independent step. The engine doesn't need to change when a consumer appears. |
| Authors don't need engine PR per optional field | **Pass** -- anything goes in `enrichment: {}`. No engine PR required. |
| Moves toward structured outputs vision | **Marginal pass** -- enrichment is a named concept, not invisible passthrough. But `Record<string, unknown>` inside `enrichment` has no type safety for individual fields. A consumer must either validate itself or accept unknown shape. |
| Senior engineer in 2 years considers it right | **Solid** -- the separation of concerns is explicit. The contract is in one schema, the enrichment is in another bucket. The reading pattern (`artifact.enrichment?.filePath`) is clear and intentional. |

**Assumption-failure cost:** If the artifact is the wrong surface, the `enrichment`
envelope documents the intent without polluting the contract fields. Migration means
moving `artifact.enrichment.filePath` to a different channel -- the consumer code
is isolated from the contract layer. Lower switching cost than approaches 1 or 2.

**Verdict:** The most defensible structural answer. Solves coupling without
abandoning type safety on what matters. The cautious platform engineer's pick if
forced to act today.

---

## Approach 4 (p=0.05): Build the Consumer First, Defer Schema Change

**Primary mechanism:** Do not change any schema today. When the first concrete
consumer of enrichment data exists (e.g. review-approval-adapter posting inline
comments, console UI showing file-line annotations), implement the consumer and
let it drive the schema change. The schema change is evidence-based, not
speculative.

Notes remain the channel for enrichment until a consumer justifies the schema
work.

### Code Change Example

```typescript
// No engine changes.
// review-approval-adapter.ts is extended when a consumer appears:

// Future state (when inline comments are implemented):
const body = buildReviewBody(findings, prUrl);  // existing
const inlineComments = buildInlineComments(findings, prUrl);  // new

// At that point, DiscoveryHandoffArtifactV1Schema gets file/line fields
// because the consumer (inline comments API) dictates exactly what shape it needs.
// The schema is driven by the contract, not by speculation.
```

### Criteria Assessment

| Criterion | Assessment |
|---|---|
| Coordinator routing fields strictly validated | **Pass** -- nothing changes. |
| No infrastructure before a consumer exists | **Pass (strong)** -- this criterion is the explicit motivation for the approach. No dead code, no speculative fields. |
| Authors don't need engine PR per optional field | **Fail** -- authors still cannot add enrichment without an engine PR. The problem is deferred, not solved. Workflow authors experience the same friction today. |
| Moves toward structured outputs vision | **Neutral** -- status quo. Notes carry enrichment in free text. |
| Senior engineer in 2 years considers it right | **High if the consumer drives the schema; low if the consumer arrives and finds no path** -- YAGNI with discipline is correct, but "discipline" means having a clear plan for when the consumer appears. Without a plan, deferred becomes forgotten. |

**Assumption-failure cost:** Near zero. If the artifact is the wrong surface,
nothing was wasted. But this approach is the most vulnerable to the original
problem persisting: workflow authors who want to add `filePath` for human readability
(not coordinator consumption) are still blocked.

**Verdict:** Architecturally correct under "validate at boundaries, trust inside"
and YAGNI. But it does not solve criterion 3 -- authors still need engine PRs.
The right choice if the team decides enrichment in artifacts is premature. The
wrong choice if there is a real workflow authoring need being suppressed.

---

## Approach 5 (p=0.02): Extensible Contract Registration -- Engine Owns Mechanism, Authors Own Schema

**Primary mechanism:** Introduce a contract registry that maps contract refs to
validation functions. The engine validates the required contract fields via the
registry; workflow authors register additional fields for their artifact type in
a workflow-local schema declaration (JSON Schema fragment in the workflow file,
not a TypeScript file). The engine loads author schemas at compile time, generates
a merged validator, and enforces both tiers.

This is the architectural root-cause fix. The engine owns the validation mechanism;
coordinators and workflow authors own the schemas they care about.

### Code Change Example

```typescript
// workflow JSON (author-declared enrichment, no engine PR needed)
{
  "outputContract": {
    "contractRef": "wr.contracts.review_verdict",
    "enrichmentSchema": {
      "type": "object",
      "properties": {
        "file": { "type": "string" },
        "startLine": { "type": "integer", "minimum": 1 },
        "remediation": { "type": "string" }
      },
      "additionalProperties": false
    }
  }
}

// artifact-contract-validator.ts
// Engine validates coordinator contract (Zod, strict)
// Then validates enrichmentSchema (ajv, author-provided) against artifact.enrichment
// Both must pass; neither can be bypassed
```

### Criteria Assessment

| Criterion | Assessment |
|---|---|
| Coordinator routing fields strictly validated | **Pass** -- coordinator contract is still Zod + strict. Enrichment validation is separate. |
| No infrastructure before a consumer exists | **Fail** -- this IS new infrastructure. Significant engine work to build the registry, schema loading, ajv integration. |
| Authors don't need engine PR per optional field | **Pass (strong)** -- the entire point. Authors declare enrichment in the workflow JSON file. |
| Moves toward structured outputs vision | **Pass (strong)** -- every boundary has a declared schema. No untyped passthrough anywhere. The platform vision of "structured outputs at every boundary" is fully realized. |
| Senior engineer in 2 years considers it right | **Pass** -- this is the correct long-term architecture. The question is whether it is right for today. |

**Assumption-failure cost:** Highest of any approach. If the artifact is the wrong
surface, a new contract registry was built for the wrong abstraction. The registry
could be repurposed but the investment is real.

**Verdict:** Architecturally the most correct. Too much investment before validating
that the artifact is the right enrichment surface. The right target state for the
backlog when the consumer-first assumption is proven.

---

## Comparison Table

| Approach | Routing Safety | No Premature Infra | No Engine PR | Structured Vision | 2yr Senior | Undo Cost |
|---|---|---|---|---|---|---|
| 1. passthrough all | Pass | Marginal | Pass | Fail | Fail | High |
| 2. Explicit optional fields | Pass | Borderline fail | Fail | Pass | Marginal | Low |
| 3. Two-tier + enrichment envelope | Pass | Pass | Pass | Marginal | Solid | Low |
| 4. Consumer-first, defer | Pass | Pass (strong) | Fail | Neutral | Conditional | Near zero |
| 5. Contract registry | Pass | Fail | Pass | Pass | Pass | High |

---

## Recommendation

**If the team believes enrichment-in-artifact is the right surface today:**
Approach 3 (two-tier validation, explicit enrichment envelope). It satisfies all
three must-have criteria, makes the separation of concerns explicit, and has low
undo cost if the assumption proves wrong. It does not require building a consumer
first but does not block building one later.

**If the team is uncertain whether the artifact is the right surface:**
Approach 4 (consumer-first deferral). Accept that workflow authors are blocked on
enrichment for now. When the first consumer materializes, let it drive the schema
shape. The discipline cost is communicating to authors why the friction exists.

**Do not choose Approach 1** (passthrough). It is the path of least resistance and
the most likely choice a typical assistant would make. It solves the symptom,
trains authors on the wrong abstraction, and makes Approach 5 harder to justify
later.

**Approach 5** belongs in the backlog as the target end state, not as today's PR.
