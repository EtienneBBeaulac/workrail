# Metrics proof definitions

This checks the real metrics projection with completed-run observations. An absent
reported outcome must remain unknown, and each supported reported outcome must
remain visible. The observed supported-outcome population must match the complete
declared population, so a new supported outcome cannot be silently omitted. It supplements the existing Vitest coverage rather than replacing
it. It does not prove daemon autonomy, review quality or delivery ownership.

Supply an absolute source root and an explicitly selected Node executable with its
SHA256. The tested runtime is standalone Node 24 with built-in TypeScript support;
no npm packages or installation are used by this definition.

```sh
python3 experiments/answer-driven-execution/proofs/metrics-outcome.py \
  --root /absolute/workrail --node /absolute/node --sha256 <executable-sha256>
```

For a copied proof, the current context must declare both
`FPIPE_NODE_EXECUTABLE` and `FPIPE_NODE_SHA256`, plus the current Python assertion
driver identity and deadline. The definition uses the injected copied executable
when `FPIPE_IN_SABOTAGE=1`; missing or mismatched capability fields refuse without
falling back to the ordinary runtime argument.

Declare the definition, adjacent `.mjs` bridge, `package.json`,
`src/v2/projections/session-metrics.ts` and `src/v2/durable-core/constants.ts` as
source inputs. The import hook maps only the projection's known constants import
to its declared TypeScript file. Package mode and runtime bytes remain explicit
inputs. Platform libraries are outside the executable-byte claim.

Exit 0 means valid observations satisfy the domain assertions. A semantic assertion
is exit 1 under the Python assertion driver. Runtime, import, syntax, timeout,
duplicate or malformed observation failures are exit 2 and cannot count as a
semantic detection. Output, executable reads and child duration are bounded.

Run the boundary controls with the same explicit runtime:

```sh
python3 experiments/answer-driven-execution/proofs/metrics-outcome-controls.py \
  --node /absolute/node --sha256 <executable-sha256>
```

## Delivery provenance

`metrics-delivery.py` checks seven ordered cases: matching-run delivery wins over
agent reports, context and completed-run fallback remain available, another run's
delivery neither replaces nor erases fallback, an earlier other-run event does not
suppress matching delivery, and empty delivery preserves context fallback.
Expected commits live in the Python assertion definition; the Node bridge reports
actual projection results without deciding whether they are correct.

Use the same absolute root, selected runtime and SHA256 arguments as the outcome
definition. The copied input declaration must include `metrics-delivery.py`,
`metrics-delivery.mjs`, and `metrics-outcome.py` for the reused boundary helpers,
alongside the projection, constants and `package.json`. The existing outcome
source stays unchanged, preserving its current sealed input identity.

```sh
python3 experiments/answer-driven-execution/proofs/metrics-delivery-controls.py \
  --node /absolute/node --sha256 <executable-sha256>
```

Controls execute precedence and wrong-run mutants independently. Both must reach
an assertion failure; runtime, syntax and malformed observations must remain
errors. A stored file-proof recipe binds one declared mutation and its complete
receipt. A second independent control is supplementary evidence, not another
stored witness or exhaustive product correctness. This verifies provenance
projection behavior and does not assign historical delivery ownership.
