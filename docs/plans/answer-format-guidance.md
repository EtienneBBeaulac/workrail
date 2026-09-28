# Answer format guidance

The interface pilot exposed a discoverability defect: a notes answer was submitted as an array because the question did not describe its accepted shape. This change makes each question self-contained, through MCP and the internal model boundary.

## Design

The ideal is one domain schema that validates answers and describes their format. The smaller change, hand-written instructions beside the validators, would create a second source of truth. Instead, extract the notes schema and derive the review fields from the existing review artifact schema. Generate JSON Schema from those definitions, with the review minimum field count shared explicitly between validation and conversion.

Every question requires an `answerFormat`; every model input carries that same format. Notes and review formats are a discriminated union with typed examples. Review guidance distinguishes a valid partial contribution from the five fields required for completion. Examples are illustrative, not evidence of completed work.

Transport accepts JSON so invalid domain answers can still be captured and returned with rejection receipts. Provider tool definitions must not impose narrower admission than the host. The daemon's duplicated domain schema is removed. The pinned step selects the format, never fields supplied in an answer.

No change to review accumulation, correction confirmation, replay, reply capabilities, or installed runtime activation is intended. The Linux scratch adapter preserves the same typed input while adding workspace instructions.

## Delivery and verification

1. Shared domain schemas and required question/model metadata, including validator-specific notes rejection reasons.
2. Tests comparing JSON Schema with domain validation for valid/invalid notes, review partials, empty objects and enriched findings.
3. Integration checks for inspect/recover/rejection/successor format selection, plus provider requests and durable invalid-answer capture.
4. Build and exercise the actual MCP executable with isolated authority and session data. Save the request/response transcript and scenario results.
5. Independent philosophy audit and code review, full checks, then reviewed PR. Merge requires separate approval; activation and live model studies are outside this change.

This is standalone delivery, separate from historical approval-record repairs in the answer-driven-execution feature store. No old gate is overridden or declared passed.

## Interface usage

A `question` response includes `answerFormat.kind`, `instructions`, `schema`, and `example`. The schema and example describe the value of the `answer` argument, not the whole tool call. Supply the question's opaque `reply` separately. Inspection includes the same guidance without granting a reply capability.

For a notes question, submit `{"notes":"Actual observations"}` as `answer`. Arrays of notes are invalid; combine the observations into a string. For a review question, any nonempty subset of the review fields can be submitted. `completionFields` names the fields needed across retained contributions; `issues` identifies what is still missing or requires correction. Finding objects may carry enrichment beyond their validated routing fields.

Examples illustrate structure only. They are not evidence, default verdicts, or claims that work has been performed. An invalid domain answer is still recorded with a rejection receipt and a follow-up question. The permissive transport schema exists to retain those answers; it does not replace the question's domain schema.
