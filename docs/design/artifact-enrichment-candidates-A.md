# Artifact Enrichment Design Candidates -- Series A

**Date:** 2026-05-15
**Problem:** The engine's artifact validation uses `.strict()` Zod schemas, treating the entire artifact as a closed schema. This conflates two concerns: validating coordinator-required routing fields (engine's job) and defining the complete shape of everything an artifact may contain (not the engine's job). Workflow authors cannot include optional enrichment data without an engine PR.

**Ideal end state:** Two-tier validation. Required routing fields are strictly enforced at `complete_step`. Everything else is preserved as-is in the session store -- no rejection, no stripping -- and available to any consumer without touching engine code. The type system retains full safety on required fields. Workflow authors declare enrichment fields in their workflow definition or workflow-scoped schema, not in the engine.

**Riskiest assumption:** The artifact is the right consumer surface for enrichment data today. If no consumer reads file/line/causal data, enriching the schema has no value and the real solution is to build the consumer first.

---

## Approach 1 (p=0.70): Replace `.strict()` with `.passthrough()` on all artifact schemas

**Primary mechanism:** Change every `.strict()` call on artifact Zod schemas to `.passthrough()`. The engine validates the required routing fields and ignores unknown fields, which are preserved in the parsed output and stored in the session event log.

### Code change example

```typescript
// review-verdict.ts -- before
export const ReviewVerdictArtifactV1Schema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor', 'nit']),
        summary: z.string().min(1),
        findingCategory: z.enum([...]).optional(),
      }).strict(),                   // <-- blocks enrichment
    ),
    summary: z.string().min(1),
  })
  .strict();                         // <-- blocks enrichment

// review-verdict.ts -- after
export const ReviewVerdictArtifactV1Schema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor', 'nit']),
        summary: z.string().min(1),
        findingCategory: z.enum([...]).optional(),
      }).passthrough(),              // <-- enrichment preserved
    ),
    summary: z.string().min(1),
  })
  .passthrough();                    // <-- enrichment preserved
```

A workflow author can now emit:
```json
{
  "kind": "wr.review_verdict",
  "verdict": "blocking",
  "findings": [{ "severity": "critical", "summary": "...", "file": "src/foo.ts", "startLine": 42 }],
  "summary": "..."
}
```

### Criteria assessment

| Criterion | Assessment |
|-----------|-----------|
| Coordinator routing fields strictly validated | Routing fields (`verdict`, `confidence`, `findings[].severity`, `findings[].summary`) remain required and validated. Unknown fields bypass type checking. Marginal risk: a typo in a required field name would not be caught if the mistyped name happens to shadow an unknown field, but this cannot actually occur with Zod -- required fields are still checked by path. **Pass.** |
| No infrastructure for enrichment before a consumer exists | Passes trivially -- no new types, no new validation, no new schema registration infrastructure. The engine is smaller after this change. **Pass.** |
| Workflow authors don't need an engine PR per optional field | Yes. Authors add whatever fields they want. Zero engine involvement. **Pass.** |
| Moves toward structured outputs vision, not notes scraping | Partially. The enrichment fields are in the artifact (structured), not notes. But they are untyped from the engine's perspective -- `Record<string, unknown>` at the boundary. The vision principle "structured outputs at every boundary" means the type should be known at the consumer, not just present. This is a step forward but leaves the consumer with `unknown` for enrichment. **Partial.** |
| Senior engineer in 2 years considers it right building block | Probably not. `.passthrough()` breaks the invariant that "types must constrain, not just label." A TypeScript type that says `ReviewVerdictArtifactV1` but silently carries arbitrary additional fields is misleading. The type becomes a partial label, not a constraint. A senior engineer will want to remove it or replace it with a proper two-tier design. **Weak.** |

### Tensions surfaced

- **Type safety vs evolvability:** This approach explicitly trades type safety for evolvability. The resulting TypeScript type `ReviewVerdictArtifactV1` no longer accurately represents what the coordinator receives -- it silently omits the enrichment fields from the type. This is the "types must constrain, not just label" failure mode described in CLAUDE.md.
- **YAGNI alignment:** Strong YAGNI alignment -- only change what is broken, do not build infrastructure for consumers that don't exist.
- **Consistency:** Applying `.passthrough()` everywhere is consistent, but it weakens all schemas uniformly, even ones where the set of enrichment fields is knowable today.

**Summary:** The pragmatic minimal fix. Unblocks workflow authors immediately. Acceptable as a short-term patch if followed by Approach 4 or 5 when a consumer materializes. Bad as the final design because it removes type safety without providing a better alternative.

---

## Approach 2 (p=0.35): Explicit optional fields on per-finding schema (known enrichment pattern)

**Primary mechanism:** Add a fixed set of optional enrichment fields directly to the per-finding schema in `ReviewVerdictArtifactV1Schema`. Keep `.strict()` on all other artifact schemas. The engine PR is required once for the known enrichment fields; future unknown fields still require a PR.

### Code change example

```typescript
// review-verdict.ts -- after
const FindingEnrichmentSchema = z.object({
  /** Source file path containing this finding. Optional enrichment. */
  file: z.string().min(1).optional(),
  /** Zero-indexed start line within `file`. */
  startLine: z.number().int().nonnegative().optional(),
  /** Zero-indexed end line within `file`. Inclusive. */
  endLine: z.number().int().nonnegative().optional(),
  /**
   * Causal link: what change or condition caused this finding.
   * Human-readable string for report generation.
   */
  causalLink: z.string().min(1).max(500).optional(),
  /** Suggested remediation text for the fix-agent goal string. */
  remediation: z.string().min(1).max(500).optional(),
});

export const ReviewVerdictArtifactV1Schema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor', 'nit']),
        summary: z.string().min(1),
        findingCategory: z.enum([...]).optional(),
      })
      .merge(FindingEnrichmentSchema)  // enrichment fields declared explicitly
      .strict(),                        // still closed -- no unknown fields
    ),
    summary: z.string().min(1),
  })
  .strict();
```

A workflow author can now emit the known enrichment fields; a typo in `startLine` (e.g. `startline`) is caught by `.strict()`.

### Criteria assessment

| Criterion | Assessment |
|-----------|-----------|
| Coordinator routing fields strictly validated | Yes. Required fields stay required; enrichment fields are optional but type-checked. **Pass.** |
| No infrastructure for enrichment before a consumer exists | Fails on the spirit: the enrichment fields are declared in the engine schema before any consumer reads them. The `file`, `startLine`, `endLine`, `causalLink`, `remediation` fields exist in the type with no code reading them today. **Technically fails.** |
| Workflow authors don't need an engine PR per optional field | Only for the pre-declared set. Any new enrichment field beyond `file/startLine/endLine/causalLink/remediation` still requires an engine PR. The problem is deferred, not solved. **Partial.** |
| Moves toward structured outputs vision | Yes -- enrichment fields are fully typed at the engine boundary. A future consumer can use `finding.file` with full type safety. **Pass.** |
| Senior engineer in 2 years considers it right building block | Possibly, if the enrichment field set stays small and stable. If it grows to 15 fields it becomes a maintenance burden. The explicit declaration is correct; the engine-ownership is the problem. **Conditional.** |

### Tensions surfaced

- **YAGNI vs future-proofing:** Declaring enrichment fields before any consumer is a minor YAGNI violation. The counter-argument is that the schema serves as documentation for workflow authors, so declaring the intent has value even before a consumer exists.
- **Premature infrastructure:** The fields are in the engine but serve no runtime function today. This creates dead code in the type system.
- **Correct mechanism, wrong ownership:** The explicit optional fields are architecturally correct. The problem is that they live in the engine rather than in a coordinator-owned schema. This is a smell that will need addressing when Approach 5 is implemented.

**Summary:** Correct for a small, stable, well-understood enrichment set. Becomes a maintenance burden as the field set grows. Good intermediate step if Approach 5 is planned but not yet built.

---

## Approach 3 (p=0.05): Two-tier schema split -- routing schema + open enrichment envelope

**Primary mechanism:** Each artifact contract is split into two schemas: a `RoutingSchema` (strict, validated at `complete_step`) and an `EnrichmentSchema` (open, validated lazily at consumer read time). The session store persists the full artifact; the engine only validates the routing slice. Workflow authors declare enrichment in a companion workflow-scoped `enrichmentSchema` field. The engine validates the routing slice and stores the full artifact verbatim.

### Code change example

```typescript
// review-verdict.ts -- after: two distinct schemas
/**
 * Routing schema: the fields the engine validates at complete_step.
 * Strict. Any violation blocks the session.
 */
export const ReviewVerdictRoutingSchema = z
  .object({
    kind: z.literal('wr.review_verdict'),
    verdict: z.enum(['clean', 'minor', 'blocking']),
    confidence: z.enum(['high', 'medium', 'low']),
    findings: z.array(z.object({
      severity: z.enum(['critical', 'major', 'minor', 'nit']),
      summary: z.string().min(1),
    }).strict()),
    summary: z.string().min(1),
  })
  .strict();

/**
 * Full artifact type: routing fields + open enrichment.
 * Not validated by the engine. Consumers read this type with
 * full type safety on routing fields; enrichment is `unknown`.
 */
export const ReviewVerdictArtifactV1Schema = ReviewVerdictRoutingSchema
  .extend({
    findings: z.array(z.object({
      severity: z.enum(['critical', 'major', 'minor', 'nit']),
      summary: z.string().min(1),
      findingCategory: z.enum([...]).optional(),
    }).passthrough()),
  })
  .passthrough();                    // <-- open envelope for enrichment

// artifact-contract-validator.ts: validate only routing fields
const routingResult = ReviewVerdictRoutingSchema.safeParse(artifact);
// store full artifact (not just routing slice) in session event log
```

In workflow JSON, workflow authors optionally declare enrichment fields for documentation:
```json
{
  "id": "emit-verdict",
  "output": {
    "contractRef": "wr.contracts.review_verdict",
    "enrichmentFields": ["file", "startLine", "endLine", "causalLink"]
  }
}
```
The engine ignores `enrichmentFields` -- it is documentation for the agent and for console display.

### Criteria assessment

| Criterion | Assessment |
|-----------|-----------|
| Coordinator routing fields strictly validated | Yes. `ReviewVerdictRoutingSchema` is strict and blocks on violation. Engine never validates the full artifact. **Pass.** |
| No infrastructure for enrichment before a consumer exists | Mostly. The `passthrough()` extension requires a small change to the schema split but no consumer-side infrastructure. `enrichmentFields` in the workflow step is optional documentation. **Pass with caveat.** |
| Workflow authors don't need an engine PR per optional field | Yes. Authors add any enrichment field to the artifact; the engine ignores it and stores it. **Pass.** |
| Moves toward structured outputs vision | Partially. Routing fields are typed at both producer and consumer. Enrichment fields are untyped at the engine boundary but available as structured data. A future consumer can add a typed enrichment schema without touching the engine. **Good trajectory.** |
| Senior engineer in 2 years considers it right building block | Strong yes. The routing/enrichment separation is an explicit and correct architectural seam. It directly models the domain: "the engine cares about routing fields; enrichment is application-domain concern." The schema split is a load-bearing design decision that pays forward to Approach 5. **Strong.** |

### Tensions surfaced

- **Type safety vs evolvability:** Routing fields retain full type safety. Enrichment fields are `unknown` at the engine layer, which is honest -- the engine genuinely does not know what they mean. Consumer type safety is a consumer-side concern, achieved via a consumer-owned schema (not the engine's problem).
- **Premature infrastructure vs future-proofing:** The schema split is new infrastructure but it is architectural, not speculative. It models a real domain invariant (routing vs enrichment) rather than anticipating a specific consumer.
- **Implementation cost:** Requires splitting every artifact schema into two variants. Medium effort. The `ReviewVerdictRoutingSchema` and `ReviewVerdictArtifactV1Schema` must stay in sync on the routing fields -- a maintenance surface.

**Summary:** The architecturally cleanest approach in this set. Correctly separates the two concerns the problem statement identifies. Higher implementation cost than Approach 1 but pays forward to any future consumer without further engine changes.

---

## Approach 4 (p=0.04): Consumer-first -- no schema change until a consumer exists

**Primary mechanism:** Do not change the artifact schemas. Build the enrichment consumer (console display, report script, fix-agent context injection) first. The schema change is then driven by the consumer's actual type requirements, not speculative field lists. Today, workflow enrichment fields go in `notesMarkdown`; structured enrichment lands in the artifact once there is code that reads it.

### Code change example

No engine change. The workflow prompt is updated to emit enrichment as structured notes:

```markdown
## Findings (structured for downstream tooling)

```json
[
  {
    "severity": "critical",
    "summary": "Race condition in session lock",
    "file": "src/v2/durable-core/ids/with-healthy-session-lock.ts",
    "startLine": 42,
    "causalLink": "Non-atomic read-modify-write on session state"
  }
]
```
```

When the console or fix-agent needs to consume `file`/`startLine`, that PR also adds the fields to `ReviewVerdictArtifactV1Schema` with full type safety:
```typescript
// Only added when a consumer is written at the same time
findings: z.array(z.object({
  severity: z.enum(['critical', 'major', 'minor', 'nit']),
  summary: z.string().min(1),
  findingCategory: z.enum([...]).optional(),
  file: z.string().optional(),       // added with the console display PR
  startLine: z.number().int().nonnegative().optional(), // same PR
}).strict()),
```

### Criteria assessment

| Criterion | Assessment |
|-----------|-----------|
| Coordinator routing fields strictly validated | Unchanged. **Pass.** |
| No infrastructure for enrichment before a consumer exists | Perfect alignment. No schema change. No infrastructure. The enrichment lives in notes until something reads it. **Pass.** |
| Workflow authors don't need an engine PR per optional field | Fails. Authors are still blocked from using the artifact for enrichment until someone adds the field. The problem is deferred, not solved. **Fail.** |
| Moves toward structured outputs vision | Regresses in the short term -- enrichment goes into notes (prose), not the artifact (structured). When the consumer PR lands it will be structured, but until then it is notes-dependent. **Temporary regression.** |
| Senior engineer in 2 years considers it right building block | Mixed. The discipline of "build the consumer first" is sound. But the result is that workflow prompts carry embedded JSON in notes (a notes-scraping variant) until the consumer PR lands. In 2 years the senior engineer will want to know why enrichment ended up in notes and will need to migrate it. **Conditional.** |

### Tensions surfaced

- **YAGNI alignment:** Maximum YAGNI compliance. Zero speculative infrastructure. The cost is paid in workflow ergonomics: authors must use notes for enrichment today and then migrate to artifact fields when the consumer is ready.
- **Structured outputs vision tension:** The vision says "structured outputs at every boundary." This approach deliberately defers that for enrichment data, accepting notes as a temporary holding pattern.
- **Riskiest assumption check:** This approach takes the riskiest assumption seriously -- if no consumer ever materializes, nothing was wasted. But it also assumes the structured/notes boundary can be cleanly migrated later, which is not guaranteed.

**Summary:** Disciplined and correct if the riskiest assumption holds (no consumer today, worth nothing to build for). Becomes the wrong call if a consumer arrives in the next sprint and the migration cost exceeds the cost of doing Approach 3 now. Best when paired with a concrete consumer ticket date -- if the consumer is "maybe someday," this is the right call; if it is "next month," Approach 3 pays more.

---

## Approach 5 (p=0.03): Workflow-declared enrichment schema -- engine validates routing, workflows own enrichment types

**Primary mechanism:** Artifact contracts are split into two independently owned registries: the engine owns the routing-field contract (required fields, closed strict schema, validated at `complete_step`); the workflow file optionally declares an enrichment schema as inline JSON Schema in a new `enrichmentSchema` field on the step's `outputContract`. The engine validates routing, stores the full artifact, and exposes enrichment validation as a separate lazy path for consumers. Workflow authors declare enrichment types in the workflow JSON -- no engine code change per field.

### Code change example

**Workflow JSON (no engine change required for new enrichment fields):**
```json
{
  "id": "emit-verdict",
  "output": {
    "contractRef": "wr.contracts.review_verdict",
    "enrichmentSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "properties": {
        "findings": {
          "items": {
            "properties": {
              "file": { "type": "string" },
              "startLine": { "type": "integer", "minimum": 0 },
              "endLine": { "type": "integer", "minimum": 0 },
              "causalLink": { "type": "string" },
              "remediation": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

**Engine change (one-time, not per new field):**
```typescript
// artifact-contract-validator.ts
// Step 1: validate routing fields (existing behavior, strict schema)
const routingResult = validateRoutingFields(artifacts, contract);
if (!routingResult.valid) return routingResult;

// Step 2: if workflow declares enrichmentSchema, validate enrichment (new, lazy)
// This path is optional -- no enrichmentSchema means step 2 is skipped
if (contract.enrichmentSchema) {
  const enrichmentResult = validateEnrichmentFields(artifact, contract.enrichmentSchema);
  // enrichment validation failures are warnings, not blockers (by default)
  // workflow may declare enrichmentSchema.required: true to make it blocking
}

// Step 3: store full artifact (routing + enrichment) in session event log
return { valid: true, artifact: fullArtifact };
```

**Consumer (coordinator, console) -- no engine change required:**
```typescript
// pr-review coordinator reads routing fields (already type-safe)
const verdict = parseReviewVerdictArtifact(rawArtifact);

// console reads enrichment fields via the workflow-declared schema
// (validated lazily; type-safe against the declared JSON Schema)
const enrichment = validateEnrichmentSchema(rawArtifact, step.enrichmentSchema);
```

### Criteria assessment

| Criterion | Assessment |
|-----------|-----------|
| Coordinator routing fields strictly validated | Yes. The routing validation path is unchanged and strictly enforced. **Pass.** |
| No infrastructure for enrichment before a consumer exists | Fails the strict reading -- declaring `enrichmentSchema` in the workflow requires the engine to parse and apply JSON Schema at runtime. That infrastructure must exist before any consumer. However, the workflow opt-in nature means the engine change is one-time, not per-field. **Partial -- one-time engine investment.** |
| Workflow authors don't need an engine PR per optional field | Strong pass. Once the `enrichmentSchema` feature is shipped, workflow authors declare any enrichment shape they want in the workflow JSON. No engine involvement. **Pass.** |
| Moves toward structured outputs vision | Strongest of all approaches. Enrichment fields are fully typed and validated at their declaration site (workflow JSON). Consumers receive typed enrichment without engine coupling. The JSON Schema inline declaration is machine-readable, versionable, and can be displayed in the console. **Strong Pass.** |
| Senior engineer in 2 years considers it right building block | Yes, with one caveat. This is the correct architecture for a platform that wants workflow-authors to own their artifact shapes without engine PRs. The caveat: JSON Schema inline in workflow JSON is verbose and may be replaced by a more ergonomic declaration syntax. But the separation of concerns is right. **Strong.** |

### Tensions surfaced

- **Premature infrastructure vs future-proofing:** This is the highest-infrastructure approach. Requires implementing a JSON Schema validator in the engine, wiring `enrichmentSchema` into the output contract type, and updating the workflow schema (`spec/workflow.schema.json`). All of this before any consumer uses enrichment. Significant YAGNI risk.
- **Consistency with extensible contract registration backlog item:** This approach is a subset of the extensible contract registration design (backlog item). Building `enrichmentSchema` before coordinator-owned routing registration creates an asymmetry: enrichment schemas are workflow-owned (JSON Schema), routing schemas are engine-owned (Zod). Eventually both should be coordinator-owned. The interim state is architecturally inconsistent.
- **JSON Schema ergonomics:** Inline JSON Schema in workflow YAML/JSON is verbose. Workflow authors will find it painful to write. A better long-term ergonomic is a typed workflow-definition API, but that is further out.
- **Dependency on JSON Schema library:** Adds a runtime dependency for schema validation. Minor but real.

**Summary:** The architecturally ideal end-state design. Correctly separates routing enforcement (engine) from enrichment typing (workflow author). Pays full dividend when multiple workflows need different enrichment shapes. Premature today -- no consumer, no workflow using enrichment, and the extensible contract registration design has not been built yet. Best scheduled after Approach 3 is proven and after at least one coordinator reads enrichment fields.

---

## Comparison table

| Approach | Routing safety | Author freedom | YAGNI | Type quality | Effort | 2-year view |
|----------|---------------|----------------|-------|--------------|--------|-------------|
| 1: passthrough everywhere | Pass | Full | Strong | Weak -- unknown enrichment | Minimal | Replace |
| 2: explicit optional fields | Pass | Limited -- known set only | Weak | Strong on known fields | Low | Extend |
| 3: two-tier routing/enrichment split | Pass | Full | Good | Strong on routing, honest on enrichment | Medium | Extend |
| 4: consumer-first, no schema change | Pass | None until consumer | Strongest | Strong | None | Migrate |
| 5: workflow-declared enrichment schema | Pass | Full | Weakest | Strongest | High | Ideal end state |

## Recommendation for this moment

The riskiest assumption is still unverified: no consumer reads enrichment fields today. This points toward Approach 4 as the epistemically correct move -- but only if "consumer" is genuinely uncertain. If the mr-review v2.9.0 overhaul or the console is a concrete near-term consumer, Approach 3 is the better call: it invests in the routing/enrichment seam that every future approach depends on, without building speculative consumer infrastructure.

Approach 1 is acceptable as a pure unblock if timeline pressure is high, but should be labeled as temporary and linked to a follow-up ticket for Approach 3.

Approach 5 is the correct long-term design. It should not be built before the extensible contract registration design (backlog item) is resolved -- building workflow-owned enrichment schemas and coordinator-owned routing schemas in isolation creates an inconsistent intermediate state.
