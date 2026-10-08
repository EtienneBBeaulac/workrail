# Copied source proof definitions

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

## Verdict routing

`gate-verdict.py` observes the actual evaluator dispatcher and gate-verdict schema.
Successful fake evaluator sessions exercise missing, valid approval, invalid,
rejected and uncertain artifacts. Only a complete typed observation reaches
Python assertions; import, runtime, archive and observation failures exit 2.
This proves routing and validation, not live evaluator judgment.

```bash
python3 experiments/answer-driven-execution/proofs/gate-verdict-controls.py \
  --node /absolute/path/to/node --sha256 <sha256>
python3 experiments/answer-driven-execution/proofs/gate-verdict.py \
  --root /absolute/path/to/workrail \
  --node /absolute/path/to/node --sha256 <sha256>
```

The declaration must witness `gate-verdict.py`, `gate-verdict.mjs`,
`metrics-outcome.py` (shared boundary helpers), the dispatcher, the real
`gate-verdict.ts` schema, `package.json`, `package-lock.json`, and the archived
dependency under `vendor/`. The archive is verified against the lockfile and
materialized without npm, network access or ambient `node_modules`. A changed
lockfile requires reviewed dependency/proof refresh, not an installed fallback.
See [the dependency fixture](vendor/README.md).

## Delivery handoff command contract

`delivery-handoff.py` exercises the actual coordinator and delivery implementation
through its injected execution boundary. Seven ordered cases verify a complete
handoff and each missing required field. Each invalid handoff must refuse before
any delivery call, and a subsequent complete handoff must remain usable.

The definition asserts the exact staging arguments, commit text and attribution,
PR title, and literal body read from the real temporary file. It also checks
command order, workspace and existing operation deadlines, and body-file cleanup.
The execution boundary records calls and supplies deterministic responses; it
never invokes Git, the optional scanner or GitHub. This proves command
construction and refusal, not remote publication or actual Git effects.

Declare the Python definition, adjacent bridge, `metrics-outcome.py` boundary
helpers, `package.json`, `src/coordinators/coordinator-delivery.ts`,
`src/trigger/delivery-action.ts`, and `src/runtime/result.ts`. The bridge permits
only those runtime edges and the delivery module's declared Node builtins.
Use the same absolute root, explicit Node executable and SHA256 arguments as the
other copied definitions. Missing or mismatched copied runtime capabilities have
no ambient fallback.

```bash
python3 experiments/answer-driven-execution/proofs/delivery-handoff-controls.py \
  --node /absolute/path/to/node --sha256 <sha256>
python3 experiments/answer-driven-execution/proofs/delivery-handoff.py \
  --root /absolute/path/to/workrail \
  --node /absolute/path/to/node --sha256 <sha256>
```

Independent staging, commit, title, body and missing-field mutants must reach
Python assertion failures. Malformed observations, syntax errors, undeclared
imports and absent source remain unavailable (exit 2). Existing Vitest coverage
remains separate and unchanged.

## Assessment consequence scoping

`assessment-scoping.py` checks the actual pure evaluator with five ordered cases:
missing named assessment, high named assessment with an unrelated low assessment,
matching named low assessment, two matching declarations, and a matching high
rule. Assertions compare every effect field, guidance and declaration order.
This verifies evaluation, not durable follow-up effects or model judgment.

Declare the definition, adjacent bridge, `metrics-outcome.py` helpers,
`package.json`, and `src/mcp/handlers/v2-advance-core/assessment-consequences.ts`.
The subject currently has only type imports; new runtime imports refuse rather
than loading undeclared dependencies. Use the same explicit Node identity and
absolute source root as the other copied definitions.

```bash
python3 experiments/answer-driven-execution/proofs/assessment-scoping-controls.py \
  --node /absolute/path/to/node --sha256 <sha256>
```

Scope, guidance and declaration-order mutants must reach Python assertions.
Missing source, syntax, undeclared imports and malformed observations remain
unavailable (exit 2). Existing Vitest coverage remains unchanged.

## Normalized comparison safety

`comparison-safety.py` calls the actual Stage A scorer with a complete synthetic
40-trial cohort. Separate controls lose accepted work, duplicate an obligation,
record an effect for another run, or add a successful write during finished-work
recovery. The intact cohort may meet measurement thresholds; all four unsafe
cohorts must be rejected for safety. Every cohort remains valid normalized input,
with no unrelated trial-integrity errors.

Declare the definition and bridge, `gate-verdict.py` and `metrics-outcome.py`
helpers, the locked dependency archive, `package.json`, `package-lock.json`, and
`experiments/answer-driven-execution/usability-scorer.mts`. Locked Zod bytes are
materialized by the existing verified helper; ambient packages are not loaded.

```bash
python3 experiments/answer-driven-execution/proofs/comparison-safety-controls.py \
  --node /absolute/path/to/node --sha256 <sha256>
```

The primary source mutant admits every cohort and must reach an assertion
failure. Supplementary mutants erase individual safety classifications; those
verify classification and are not claimed as violations of overall admission
when another rejection remains. Missing source, syntax, undeclared imports,
corrupt archives and lock drift remain unavailable (exit 2).

This proves rejection and classification of normalized synthetic evidence.
It does not establish live task correctness, agent benefit or release approval.

## Manifest declaration and artifact bytes

`manifest-bytes.py` exercises the actual manifest verifier using real temporary
files for complete synthetic Stage A and B declarations. Python independently
enumerates 29 Stage A paths and 20 Stage B paths. The 100 observations include
both intact declarations, then a changed-file and an unreadable-file case for
each artifact. Every case must attempt exactly the independently specified read
population. Positive cases must verify all artifacts and explicitly grant no
trial authorization.

Declare the definition, adjacent bridge, `manifest-byte-fixtures.mjs`,
`gate-verdict.py` and `metrics-outcome.py` helpers, the locked Zod archive,
`package.json`, `package-lock.json`, and the actual `study-manifest.mts` subject.
Fixture declarations are synthetic and do not assert real executable or
preflight identity. The private reader only reads their actual temporary files.

```bash
python3 experiments/answer-driven-execution/proofs/manifest-bytes-controls.py \
  --node /absolute/path/to/node --sha256 <sha256>
```

The primary source mutant accepts mismatched bytes. Supplemental mutants omit
Stage B's required proof or incorrectly grant trial authorization. Each must
reach a Python assertion. An actual unreadable artifact is expected product
rejection; missing source, syntax, undeclared imports, invalid archives and lock
drift are unavailable evidence (exit 2).

The complete observation population is bounded at 256 KiB and the Node child at
15 seconds. This proof covers declarations and artifact bytes, not the truth of
preflight content, live study outcomes or permission to execute a trial.
