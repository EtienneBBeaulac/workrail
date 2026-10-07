# Metrics outcome proof definition

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
