# Answer-Driven Execution Review Study Harness

## Purpose

This experiment harness provides deterministic verification for answer-driven review study execution. It defines schemas, manifests, normalization logic, and scoring contracts for evaluating review workflows under controlled conditions.

## Verification

Run the verification suite from the repository root:

```bash
./scripts/verify-review-study-harness
```

The script executes:
1. Vitest probes defined in `experiments/answer-driven-execution/` using `vitest.config.js`.
2. Strict TypeScript type-checking across all shipped `.mts` and `.check.ts` files.

## Test Boundaries and Synthetic Fixtures

All tests and acceptance probes in this suite are fake-only. They run against deterministic in-memory fixtures, synthetic streams, and temporary directories. No network calls, live LLM endpoints, or external model services are invoked during test runs.

## Authorization and Scope Constraints

The existence of this harness does not grant real-study authorization, nor does passing verification prove review quality. Live agent studies require separately approved inputs and a frozen evaluation protocol.
