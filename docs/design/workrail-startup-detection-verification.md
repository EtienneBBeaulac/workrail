# Startup observation verification

Local verification snapshot for [#1346](https://github.com/EtienneBBeaulac/workrail/issues/1346), under parent #1152. Production code is committed at `fdf70e029ca8aeaa9a837de23fb5416336844501`. The pipeline G5 implementation gate passed all six requirements. At the time of this local verification, the branch had not been pushed, published, merged or installed into the connected MCP server. Current delivery status is tracked on the issue and its linked pull request.

## Behavior and review

Start and new advance share a closed, pure classifier behind process capture in the use-case layer. Generic VS Code markers resolve to MCP; supported overrides and explicit markers retain documented precedence. Rehydrate and replay preserve signed observations. No capability or provider-model identity is inferred.

The original actual-MCP start test failed because VS Code was classified as Cursor. After correction, the start matrix verifies signatures and session binding for all 16 precedence cases. Four fresh Node processes exercise composed MCP stdio start, daemon-marker start, generic recovery, and replay under changed markers. All pass, with unknown model identity and no invented capabilities. The daemon marker does not establish native WorkTrain parity.

Independent review found incomplete signature assertions, missing source/build lineage, and an asynchronous verification window. These were corrected: signatures are parsed against the actual session; a private compilation compares current source emission with installed build bytes; evidence publishers recheck bindings after asynchronous work. The full suite also exposed a handler-to-infrastructure import, corrected through the existing use-case boundary. Final independent review has no material findings.

## Local checks

- Full Vitest: 488 files passed; 7,438 tests passed, 28 skipped.
- Build, registry, authoring spec, feature coverage and generated authoring docs passed.
- Current-source composed MCP acceptance passed in four fresh processes.
- Compiler checks reject unsupported harness/current-host values, mutation of readonly indicators, and incomplete indicator objects.
- Comment hygiene and `git diff --check` passed.

## Registered latency assay

Y1's numerical hypothesis survived. One baseline and one successful slow control ran, with no A-B-A claim. Each of 16 baseline scenarios contains 200 fresh-process first calls and 10,000 individually timed warm calls. Nearest-rank p99 uses positions 198 and 9,900 respectively.

| Distribution | Highest scenario p99 | Largest sample |
| --- | ---: | ---: |
| First call | 0.871083 ms | 11.401958 ms |
| Warm call | 0.011917 ms | 0.868375 ms |

Both baseline p99 distributions meet the approved strict under-2ms criterion. This does not establish an absolute maximum under 2ms. The successful 3ms capture-delay control exceeds that same threshold: first-call p99 3.885917ms and warm p99 3.124500ms. Import and full process costs are retained separately and are excluded from the sniff threshold.

Named runtime: Node v26.5.0, Darwin arm64 25.6.0, Apple M5 Max. Raw samples, source/build digests, runtime identity, medians and maxima remain in the private host artifact directory `/Users/etienneb/.codex/artifacts/workrail-startup-detection-20261010/latency/`.

A fresh same-family adjudicator independently recomputed counts and summaries and checked matching receipt provenance. Receipt-only adjudication does not independently attest worker identities, the injection mechanism or per-call execution. The coordinator separately inspected the bound production/measurement source and verified current compilation; these receipts are not independent provider attestation.

## Remaining boundary

Remote CI, publishing, installed activation, cross-client model launches and native WorkTrain parity are not established by this local slice. Broader #1152 remains open. The approved design is in [the startup plan](../plans/workrail-startup-detection.md).
