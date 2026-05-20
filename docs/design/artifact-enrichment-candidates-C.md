# Design Candidates: Artifact Enrichment Schema (Set C)

**Date:** 2026-05-15
**Status:** Candidate analysis
**Framing prompt:** What if "the engine's .strict() schema is blocking workflow enrichment" is the wrong problem to solve?

---

## Framing Risk Audit

The stated problem: `.strict()` on `ReviewVerdictArtifactV1Schema` prevents workflow authors from adding optional enrichment fields (file, startLine, endLine, causalLink, remediation) without an engine PR.

**What the coordinator actually consumes today:**

```ts
// src/coordinators/pr-review.ts -- readVerdictArtifact()
return {
  severity: v.verdict,             // routing
  findingSummaries: v.findings.map((f) => f.summary), // first 3, fix-agent goal string
  raw: JSON.stringify(v),
  source: 'artifact',
};
```

That is it. `file`, `startLine`, `endLine`, `causalLink`, `remediation` -- **zero consumers today**.

**What the workflow already says:**

> "The file/line/causalLink/remediation detail belongs in the human-readable notes and ready-to-post MR comments above -- not in the artifact. The artifact is for coordinator routing; the notes are for humans."
>
> -- `mr-review-workflow.agentic.v2.json`, phase-6-final-handoff prompt

**What the console renders:** `ArtifactsSection` in `NodeDetailSection.tsx` renders artifacts as raw JSON via `JSON.stringify`. There is no finding-aware renderer, no file/line display, no inline-comment UI.

**Primary framing risk confirmed:** The problem as stated ("schema blocks enrichment") is real but may be solving for infrastructure with zero consumers. If enrichment fields cannot be consumed by anyone today, relaxing the schema produces stored-but-ignored JSON. The more useful question is: *what should consume file/line data when it exists?*

---

## Tension Map

| Tension | Stakes |
|---|---|
| Type safety vs evolvability | Relaxing `.strict()` makes the schema meaningless for unenforced fields; keeping it forces engine PRs |
| Premature infra vs future-proofing | Schema slots bought today cost nothing at rest, but send a false "this is consumed" signal |
| Minimal fix vs architectural correctness | `.passthrough()` is a one-liner; coordinator-owned schemas require a registry design |
| Consistency vs pragmatism | `.strict()` matches `loop-control.ts` and `gate-verdict.ts` precedent; deviating needs justification |
| Artifact as routing channel vs artifact as rich data store | The design intent is routing; the aspirational intent is structured data at every boundary |

---

## Criteria Rubric

| # | Criterion | Weight |
|---|---|---|
| 1 | Coordinator routing fields remain strictly validated | Must-have |
| 2 | No infrastructure for enrichment before a consumer exists | Must-have |
| 3 | Workflow authors don't need an engine PR per optional field | Must-have |
| 4 | Moves toward "structured outputs at every boundary" vision | Vision |
| 5 | Senior engineer in 2 years considers it the right building block | Aspirational |

---

## Candidates

---

### Approach 1 (p=0.55): Replace `.strict()` with `.passthrough()` on the findings sub-schema and top-level artifact schema

**Primary mechanism:** Swap both `.strict()` calls for `.passthrough()`. Zod passes unknown fields through on parse; the coordinator receives and ignores them. The schema continues to enforce required fields at validation time.

**What the code change looks like:**

```ts
// review-verdict.ts (before)
z.object({
  severity: z.enum([...]),
  summary: z.string().min(1),
}).strict()

// review-verdict.ts (after)
z.object({
  severity: z.enum([...]),
  summary: z.string().min(1),
}).passthrough()
```

The top-level `ReviewVerdictArtifactV1Schema` also changes from `.strict()` to `.passthrough()`.
Workflow prompt updated to remove "no extra fields" constraint.

**Pros:**
- C1 (routing strictly validated): YES -- `verdict`, `confidence`, `findings`, `summary` still required and typed
- C2 (no infra before consumer): YES -- enrichment fields are stored in the session event log but ignored; no dead code path added
- C3 (no engine PR per field): YES -- workflow authors add fields freely; validation never rejects them
- C4 (vision alignment): PARTIAL -- data is emitted and stored, but "structured outputs at every boundary" requires a consumer to make it meaningful. Stored-but-ignored is not the same as structured
- C5 (2-year view): WEAK -- `.passthrough()` on a typed schema is a soft contract. When a console renderer or inline-comment poster is added later, it has no schema to import -- it has to re-discover field names from examples. Not a building block, just an open door

**Cons:**
- Typos in field names pass silently (e.g. `startline` instead of `startLine`). The agent gets no error, the consumer gets `undefined`
- Breaks the precedent set by `loop-control.ts`, `gate-verdict.ts`, and `coding-handoff.ts`, all of which use `.strict()`
- If the enrichment fields are untyped, the console cannot import a type to render them; it must use `(artifact as any).startLine` or re-define the shape
- Conflicts with the extensible contract registration design (backlog): that design wants coordinator-owned schemas, not schema-agnostic passthrough. Passthrough makes that design harder to argue for later

**Probability rationale:** The most common "quick fix" response from an AI assistant when told "validation rejects extra fields." High probability because it is obvious, low-effort, and satisfies the stated symptom.

---

### Approach 2 (p=0.25): Add explicit optional fields to the per-finding schema now, with the consumer stub committed alongside

**Primary mechanism:** Add `file?: string`, `startLine?: number`, `endLine?: number`, `causalLink?: string`, `remediation?: string` to the finding sub-schema as optional Zod fields. Simultaneously commit a `readEnrichedFinding()` pure function in `pr-review.ts` that extracts these fields -- even if its only caller today is a no-op log line. The function's existence documents the contract and gives future consumers a typed import.

**What the code change looks like:**

```ts
// review-verdict.ts
z.object({
  severity: z.enum([...]),
  summary: z.string().min(1),
  findingCategory: z.enum([...]).optional(),
  // Enrichment fields -- optional, consumed by inline-comment posters and console renderers
  file: z.string().optional(),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  causalLink: z.string().optional(),
  remediation: z.string().optional(),
}).strict()

// pr-review.ts (new stub, not called by routing)
export function readEnrichedFinding(
  f: ReviewVerdictArtifactV1['findings'][number]
): EnrichedFindingDetail | null {
  if (!f.file) return null;
  return { file: f.file, startLine: f.startLine, endLine: f.endLine, causalLink: f.causalLink, remediation: f.remediation };
}
```

**Pros:**
- C1: YES -- required fields still `.strict()`, still enforced
- C2: PARTIAL -- the stub consumer costs ~10 lines but documents intent without adding runtime paths. The no-op log line is a committed promise, not dead infrastructure
- C3: YES -- any field in the declared optional set requires no engine PR; new fields outside the set still do
- C4: STRONG -- explicit optional fields in a typed schema IS structured output at the boundary. The schema is importable, the type is derivable via `z.infer`, the console renderer has something to import
- C5: STRONG -- a senior engineer in 2 years finds explicit typed fields, a pure extractor function, and a clear seam. They add the console renderer or inline-comment poster against a real type, not `(artifact as any)`

**Cons:**
- Still requires an engine PR for fields outside the declared set (C3 is partial for truly open enrichment)
- Adds fields to the schema before a live consumer exists -- this is mild YAGNI violation
- The stub function is defensive infrastructure -- it may be wrong about what the console actually wants to display when that day comes
- Does not solve the open-ended enrichment problem for other artifact types

**Probability rationale:** A typical AI assistant often suggests this as a compromise, but usually frames it as "add the fields and use them" without the stub-consumer discipline. The stub-consumer anchor is the non-obvious part that keeps this from being pure YAGNI violation.

---

### Approach 3 (p=0.08): Do nothing to the schema; redirect the enrichment drive toward building the actual consumer first

**Primary mechanism:** Keep `.strict()`. Reject the framing that the schema is the problem. The real gap is that no consumer reads enrichment fields today. The right next step is to build one -- either (a) the coordinator posts inline GitHub review comments from `summary` + hypothetical `file`/`line`, or (b) the console renders a finding-aware card. When the consumer is designed, the fields it needs become clear, and the schema change is driven by the consumer's shape rather than by speculation.

**What the code change looks like:**

No engine change. Instead, add a GitHub issue:

> **"Inline PR comment poster: coordinator posts file-anchored review comments after minor verdict"**
> Consumer design drives the schema. When the coordinator can call `gh api repos/:owner/:repo/pulls/:number/reviews` with file+line+body, we know exactly what fields the artifact needs.

The workflow prompt already correctly says enrichment belongs in notes. Status quo is architecturally correct.

**Pros:**
- C1: YES -- nothing changes, routing still strictly validated
- C2: YES -- strongest possible: no enrichment infrastructure at all until a consumer is specified
- C3: FAILS -- workflow authors still cannot add optional enrichment fields without an engine PR. This is the one criterion this approach cannot satisfy
- C4: HONEST -- "structured outputs at every boundary" is only meaningful when a boundary consumer exists. Deferring is aligned with the vision's intent, not opposed to it
- C5: STRONG -- a senior engineer in 2 years finds a tight schema that only grew when a consumer was ready. No dead code paths, no "what is this field for?" confusion

**Cons:**
- C3 failure is real: if the workflow author wants to include enrichment in the artifact for any reason (e.g. human inspection in the console's raw JSON view), they are blocked
- Requires the team to actually build the consumer -- which may be indefinitely deferred
- Does not address the underlying coupling (artifact schema lives in the engine, not with the coordinator that owns the contract)

**Probability rationale:** A typical AI assistant rarely suggests "do nothing and redirect." This is the contrarian option that requires confidence in the framing-risk argument. Low p because it is uncomfortable and requires explaining why a requested change is the wrong move.

---

### Approach 4 (p=0.07): Two-tier schema: strict coordinator-routing schema + open `meta` bag validated only for well-formedness

**Primary mechanism:** Split the artifact into two validated zones. The top-level required fields (`kind`, `verdict`, `confidence`, `findings`, `summary`) are validated strictly as today. An optional `meta: Record<string, unknown>` field is validated only for structural well-formedness (must be an object if present, not an array or primitive). Enrichment lives in `meta`. The engine never needs to know what `meta` contains.

**What the code change looks like:**

```ts
// review-verdict.ts
export const ReviewVerdictArtifactV1Schema = z.object({
  kind: z.literal('wr.review_verdict'),
  verdict: z.enum(['clean', 'minor', 'blocking']),
  confidence: z.enum(['high', 'medium', 'low']),
  findings: z.array(FindingSchema.strict()),
  summary: z.string().min(1),
  /**
   * Optional enrichment bag. Engine validates only that it is a plain object.
   * Consumers (console, inline-comment poster) are responsible for their own
   * sub-schema validation when reading from meta.
   */
  meta: z.record(z.unknown()).optional(),
}).strict()

// workflow prompt
// Agents place enrichment in meta:
// { ..., meta: { findings_detail: [{ file: "src/foo.ts", startLine: 42, ... }] } }
```

The console can read `artifact.meta?.findings_detail` and apply its own Zod schema when it exists.

**Pros:**
- C1: YES -- all routing fields still strictly validated
- C2: PARTIAL -- `meta` is an open bag; once it exists, agents will use it whether or not a consumer exists. Better than untyped passthrough (the intent is explicit) but still allows dead data
- C3: YES -- workflow authors can put anything in `meta` without an engine PR
- C4: PARTIAL -- `meta` is explicitly "unstructured at the engine boundary." It is honest that the engine does not own this data, but it is not "structured output at every boundary" -- it is "structured routing output plus an escape hatch"
- C5: MODERATE -- the meta bag is a recognizable pattern (similar to Kubernetes annotations or HTTP headers) that signals "owned by consumers." But `Record<string, unknown>` is the pattern CLAUDE.md explicitly warns against: "a type that accepts everything its predecessor accepted is a rename, not an improvement"

**Cons:**
- `meta: Record<string, unknown>` violates the explicit CLAUDE.md rule about index signatures: "An interface with an index signature is structurally identical to `Record<string, unknown>` and provides no safety"
- Without a sub-schema, consumers cannot import a type -- they must validate defensively at read time
- Creates a two-class system within the same artifact: "real fields" vs "meta fields." Over time, `meta` becomes a dumping ground
- If the coordinator ever needs to read an enrichment field for routing (e.g. route differently by file path), it has to dig into `meta` with an unsafe cast

**Probability rationale:** The meta/annotations pattern is well-known in infrastructure tooling and occasionally appears in AI-suggested designs when the assistant is trying to be clever about extensibility. Low probability because it requires thinking beyond "just add a field" but is not the most architecturally correct option.

---

### Approach 5 (p=0.05): Coordinator-owned schema registration: engine owns the validation mechanism, coordinator declares the schema

**Primary mechanism:** Instead of the engine hard-coding `ReviewVerdictArtifactV1Schema` in `artifact-contract-validator.ts`, introduce a schema registry that coordinators (or workflow authors) populate at startup. The engine validates "is this a registered schema?" and "does the artifact pass that schema?" but does not own the schema definition. The `pr-review` coordinator registers its own Zod schema with as many optional fields as it wants. The engine PR is replaced by a coordinator PR.

**What the code change looks like:**

```ts
// New: src/v2/durable-core/schemas/artifact-registry.ts
export interface ArtifactSchema<T> {
  readonly contractRef: string;
  readonly kindDiscriminant: string; // e.g. 'wr.review_verdict'
  readonly schema: z.ZodType<T>;
  readonly isKindMatch: (artifact: unknown) => boolean;
}

// pr-review coordinator registers its own schema:
import { artifactRegistry } from '../v2/durable-core/schemas/artifact-registry.js';

artifactRegistry.register({
  contractRef: 'wr.contracts.review_verdict',
  kindDiscriminant: 'wr.review_verdict',
  schema: ReviewVerdictArtifactV1Schema, // coordinator owns this type
  isKindMatch: isReviewVerdictArtifact,
});

// coordinator's schema can add optional enrichment fields freely:
const ReviewVerdictArtifactV1Schema = z.object({
  // ... required routing fields strict ...
  findings: z.array(
    z.object({
      severity: ...,
      summary: ...,
      file: z.string().optional(),
      startLine: z.number().int().nonnegative().optional(),
      // ...
    }).strict()
  ),
}).strict();
```

The engine's `artifact-contract-validator.ts` becomes a thin dispatch layer that delegates to the registry.

**Pros:**
- C1: YES -- the coordinator's schema enforces routing fields strictly. Nothing is softened
- C2: YES -- the coordinator owns the schema. Optional fields are added when the coordinator is ready to read them, not speculatively
- C3: YES -- workflow authors still need a coordinator PR to add fields (not engine), but coordinator PRs are smaller scope and the coordinator is the right owner of this contract
- C4: STRONG -- this is the architecturally correct path. Structured outputs at every boundary where each boundary owns its schema
- C5: STRONG -- this is the backlog item ("extensible contract registration") and the right long-term architecture. A senior engineer in 2 years will recognize it as the correct seam

**Cons:**
- Highest complexity of all candidates. The registry, the registration API, the engine dispatch refactor -- all require careful design to avoid race conditions and to preserve the HMAC-enforced state machine
- Coordinator-owned schema registration at startup requires careful module initialization order (coordinator PR must be available when the engine boots)
- C3 is only partially met: workflow authors still cannot add enrichment fields without *someone's* PR (engine or coordinator). The coupling is moved but not eliminated
- This is the backlog item -- doing it now, driven by a single missing optional field, is over-engineering for the immediate problem. The right trigger is when two or more coordinators need diverging schemas for the same contract, not one coordinator wanting optional fields

**Probability rationale:** Rarely suggested by typical AI assistants because it requires reading and respecting the existing backlog design rather than inventing from scratch. Very low probability for an AI that does not have context on the existing architecture.

---

## Recommendation

**The framing is partially wrong.** The current workflow prompt already correctly places enrichment in notes ("file/line/causalLink/remediation detail belongs in the human-readable notes"). The `.strict()` schema is not blocking anything that has a consumer today.

**The real gap, if it exists, is one of two things:**

1. If the coordinator should post inline GitHub review comments with file/line anchors (which would be a new capability), *that* consumer defines exactly what fields the artifact needs. Build the consumer first, then the schema change is obvious and driven by a real type contract.

2. If the console should render a finding-aware card that shows file/line/causalLink (richer than raw JSON), *that* consumer defines exactly what fields the display needs. Build the renderer first.

**If neither consumer is being built now**, the correct approach is **Approach 3** (status quo + GitHub issue). The workflow prompt is architecturally correct. No schema change is warranted until a consumer exists.

**If a consumer is being built alongside this change**, the correct approach is **Approach 2** (explicit optional fields with typed extractor stub), because it gives the consumer a real schema to import and constrains typos at schema validation time.

**Approach 1** (`.passthrough()`) satisfies C2 and C3 but violates the coding philosophy's prohibition on open index signatures and breaks the established `.strict()` precedent without architectural justification.

**Approach 5** (registry) is the right long-term architecture but premature for a single coordinator's optional enrichment fields.

---

## Summary Table

| | Approach 1 | Approach 2 | Approach 3 | Approach 4 | Approach 5 |
|---|---|---|---|---|---|
| Name | `.passthrough()` | Explicit optional fields | Status quo / consumer first | Two-tier `meta` bag | Coordinator-owned registry |
| p(typical AI) | 0.55 | 0.25 | 0.08 | 0.07 | 0.05 |
| C1: routing strict | YES | YES | YES | YES | YES |
| C2: no infra before consumer | YES | PARTIAL | YES | PARTIAL | YES |
| C3: no engine PR per field | YES | PARTIAL | FAILS | YES | PARTIAL |
| C4: vision alignment | PARTIAL | STRONG | HONEST | PARTIAL | STRONG |
| C5: 2-year building block | WEAK | STRONG | STRONG | MODERATE | STRONG |
