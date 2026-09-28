# Answer format verification

Issue: #1264. Local build from `etienneb/answer-format-guidance`, based on `e5307049360bff07b8b476f146ea2c31f58c6ff2`.

Source digest (sorted `src/**/*.ts`, path + NUL + bytes + NUL, SHA-256): `c34e92a2a697b7d3c73fa5d589c6993020598cc3de80294727067bdc0e100701`.

The coordinator built the actual MCP executable and drove it using the MCP SDK over stdio with a fresh temporary workflow directory, keyring and session store. No installed candidate was activated and no live model inference was run.

Observed scenarios in `mcp-transcript.json`:

- Opening the notes step returned a string schema and an example before any answer.
- Submitting an array returned a recorded rejection with `answer.notes: Expected string, received array` and the notes format.
- Reading its receipt returned the exact submitted array; inspection returned the format without a reply capability.
- Closing the process and starting another preserved the notes format on recovery.
- Submitting a string advanced to the review step with review schema, example and completion fields.
- Submitting only the verdict returned a partial receipt and the remaining fields; inspection preserved review guidance.
- Submitting the remaining fields completed the workflow.

Opaque local capabilities in the committed transcript are consistently replaced with placeholders. The original transcript remains in `/tmp/workrail-answer-format-review/mcp-transcript-raw.json`. These are deterministic interface observations, not evidence of improved live-model performance.

Validation on the final source: TypeScript and type proofs passed; full build passed; 468 test files passed (7,125 tests passed, 28 skipped). The skip count matches the existing environment-gated suite. Authoring spec, generated authoring docs, feature coverage and comment hygiene checks passed. The full suite initially caught obsolete exact prompt-shape assertions; these now require the added format metadata, including recovery probes and strict read-only HTTP projections.
