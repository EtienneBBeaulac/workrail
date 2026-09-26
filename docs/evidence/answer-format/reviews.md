# Independent reviews

All reviewers used fresh AGY conversations with `gemini-3.8-flash-high`, high effort, embedded personal source only, and a verified wildcard PreToolUse deny-all hook. This is a tool restriction, not an OS sandbox. The coordinator performed edits and verification.

| Review | Conversation | Result |
|---|---|---|
| Reconnaissance and blind ideal | `4f66e6f4-e26a-4b51-9497-1a12c0839299` | Confirmed missing question metadata, generic notes errors and duplicated provider schema |
| Structural design | `bf8dc78c-fa86-40ba-9ea9-a34e85103df1` | Findings below |
| Source adjudication | `8bc05693-ef5c-4e9a-9715-304bfd5816dc` | Confirmed existing completion and wrapper behavior; further claims rechecked below |
| Final design critique | `77046f02-b218-4948-ba79-dbdb4fa8e718` | PASS, no remaining design blockers |
| Philosophy audit | `e53f7b84-6f3d-4c51-86ce-e3d791fbe569` | PASS |
| Independent code review | `a353f866-0a24-4e75-93ca-9286b3f2f33c` | PASS, no concrete regressions found |

## Findings and dispositions

- Strict provider schema could reject answers before durable capture. Fixed in the design: both transports accept JSON; the domain format travels in the question. The code review confirmed the permissive handoff.
- JSON Schema conversion does not preserve arbitrary refinements. Fixed: the minimum review field count is shared explicitly by the decoder and generated schema; Ajv parity tests include empty objects.
- A partial-only example could obscure completion. Fixed: the review example is complete and explicitly fictional; instructions distinguish partial admission, completion fields and correction confirmation.
- Required format metadata must survive every boundary. Fixed: required typed fields on question and model input, explicit runner forwarding, integration and type proofs. The existing Linux wrapper already preserves the typed input; the reviewer confirmed no extra wrapper constructor was needed.
- Claim that only verdict and confidence were required was declined and rechecked: the existing accumulator requires all five fields, including a present findings array. Empty findings counts as present.
- Claim that artifact kind must equal contract reference was declined and rechecked against the canonical schema. They are intentionally distinct identifiers.
- Suggested markdown prompt conversion and a new ephemeral validation failure protocol were declined and rechecked. Explicit JSON fields preserve deterministic structure, and domain rejection remains a recorded result with a receipt.
- Notes validation diagnostics were made specific using the actual Zod path and message. Review diagnostics also include their path.

The philosophy audit covered explicit domain types, immutable data, schema ownership, illegal states, errors as data, deterministic core, boundary validation, capability isolation, small interfaces and the ideal-design comparison. Each passed with source references. The code review checked schema parity, enriched findings, partial/correction semantics, pinned obligation selection and capture integrity.

The first code-review process exceeded its 115-second bound and returned no substantive report. It is not counted as a pass. Process inventory confirmed no AGY/language-server process remained before dispatching the replacement fresh review. No scope-violation worker was resumed. Raw review output is retained locally in `/tmp/workrail-answer-format-review`.
