# WorkRail MCP model-selection verification

Status: token-based MCP implementation shipped in WorkRail 3.127.0; installed
package active in Codex; normal heavy/lightweight native acceptance passed.
Scope: token-based MCP model intent and client launch planning; GitHub issue #1152.

The implementation and assessment are described in
[the model-selection plan](../plans/workrail-mcp-model-selection.md).

Focused checks passed for routing, child independence, all readable/structured wire
combinations, recovery containing retained functions, trusted-vs-worker provenance,
genuine historical sessions, strict shared-start consumers and authoring guidance.
Compile-time proofs reject mutation of nested routing targets and requests.

Independent philosophy/code reviews repaired all reported source findings. Critique
pass 1 found missing readable coordinator policy on parallel steps; pass 2 returned
zero new material findings after independent recheck. The final source/build native receipt is now verified. The full repository implementation gate passed all 14 acceptance requirements.

## Publication and installed package

- PR [#1343](https://github.com/EtienneBBeaulac/workrail/pull/1343) merged as
  `d362c7a6b7964f580c61b59b08cb86801c419c35`.
- Merge-head CI [run 38007033089](https://github.com/EtienneBBeaulac/workrail/actions/runs/38007033089)
  and Release [run 38007737201](https://github.com/EtienneBBeaulac/workrail/actions/runs/38007737201)
  succeeded against that exact head.
- Published npm version is `3.127.0`; its `gitHead` is `d362c7a6`, matching the
  merge commit. Integrity is
  `sha512-Pv0r/bO5wI6hdDuR8dXjnJuDj3MlF5YjVDUQzZvnknOfJ4BSe6meqZ8leXbifFWbirmZc5vz42erGIkAOYU89w==`.
- Codex configuration points to
  `/Users/etienneb/.local/share/workrail/codex-3.127.0/node_modules/@exaudeus/workrail`.
  Its six changed runtime modules match the independently tested build. The old
  3.126 installation is retained.
- After the user reconnected Codex, the actual root `mcp__workrail` inspection
  exposed `initialModelRequest`. This is current connection evidence; the earlier
  checkpoint reporting the old connected server is superseded. The standalone
  published-server inspection had also exposed the field. Configuration alone
  was not used as proof of connection state.

## Normal heavy/lightweight acceptance

Passed on October 9, 2026 (user timezone), using the published 3.127.0 package
for a real documentation planning and implementation task:

- Heavy planning: registered `wr.routine-plan-generation`, resolved to
  `gpt-6-astra`, native Codex launch accepted, durable session
  `sess_7d2dgxbvqrc6pwnhpblxzuiyy4` completed all five authored steps.
- Lightweight implementation: registered `wr.routine-feature-implementation`,
  resolved to `gpt-6-luna`, native Codex launch accepted, durable session
  `sess_gwnvmmmlgpufupsbbklx3bdoyy` completed all five authored steps through
  the reconnected MCP server. Its three documentation changes were independently
  inspected against the actual Git diff.
- The planner's mid-routine recovery used a fresh server process; independently
  compared responses preserved its step, model selection and both routing bindings.
  The worker also reported unchanged mid-routine recovery. Its exact call IDs
  were not retained, so that particular observation is worker evidence. The parent
  independently resumed and rehydrated its completed session through live MCP.
- An unavailable target returned `unsupported` with `target_unavailable` from
  the installed client launch planner. No native launch was attempted for that
  target and no completion is claimed for its isolated workflow session.

The parent checked both native spawn calls, durable `run_started` model bindings
and `run_completed` records, the planner's raw recovery responses, and a live
resume of the completed implementation session. Local evidence is retained under
`/tmp/workrail-3.127.0-normal-20261010/`; the two evidence summaries identify the
sessions and checks. Requested-model launch acceptance is established; provider
identity remains `not_independently_observed`.

The planning routine's Git-metrics report contains unexplained commit attribution,
although that agent made no Git mutations. Those listed commits are not evidence
of planner or worker authorship. This observation remains separate from the
verified model-selection behavior. Broader issue
[#1152](https://github.com/EtienneBBeaulac/workrail/issues/1152) remains open;
this closeout makes no answer-profile parity or WorkTrain routing claim.

## Astra follow-up review

An independent Astra review without skills reproduced two runtime defects:
conflicting inspection/onboarding tiers and loss of advancement after two signing
key rotations. Both regression tests failed before their fixes. Inspection and
onboarding now derive the same initial authored policy without pinning subsequent
steps. A previous-key-verified attestation is renewed while its authority remains
valid; invalid or retired signatures still fail closed, and verified lineage is
preserved.

The client planner also requires explicit unknown or observed current execution
state and returns `already_satisfied` for a matching target. This prevents a
correctly launched agent from requiring an unnecessary switch. Compile-time proofs
reject omitted observation state and ambiguous model/executor targets.

Astra independently rechecked the fixes and 24 focused tests with retries disabled,
confirming both runtime findings and the planner gap addressed, with no new material
findings. The native acceptance below was refreshed against the changed source and
build. Its earlier receipt remains retained as historical evidence.

## Native acceptance

- Selected binding: lightweight -> native `gpt-6-luna`, fresh context.
- Source hash: `2ca97f8438b1630484ecdff9df58faff44403187ca8ffa79e83e3a93d1d152a1`.
- Runtime build hash: `3eeb0448be5828c45668181ffc7874a6d1443784de033faa35913532f03d5e96`.
- Nonce: `bfd85ddb-2451-40d3-968d-376620ce8e3e`.
- Durable child: `sess_vq5dsnmb3xzstqqoy77qwk7g4i`.
- Receipt: `.workrail/model-selection-proof/native-receipt.json` (local evidence).
- Result: `native_launch_accepted_and_child_completed`.
- Provider identity: `not_independently_observed`.

The verifier checks unique, ordered build/startup/launch/completion receipts,
matching handoff and native task identity, schema-valid durable start/output/end
events, nonce, source/build hashes and resource closure. Codex encrypts prompt
arguments at rest; the nonce-bearing task name provides a public linkage without
reading or decrypting the prompt. The original transcript remains untouched.

The native receipt above records branch-built execution. Publication, installed
package identity, and current normal acceptance are recorded separately above.

## Final local verification

The implementation gate passed after executing the recorded requirement commands,
including the complete repository suite with four workers and retries disabled:

- `npm run build`
- `npx vitest run --maxWorkers=4 --retry=0`
- `npm run validate:registry`
- `npm run validate:authoring-spec`
- `npm run validate:feature-coverage`
- `npm run validate:authoring-docs`

`npm run typecheck` also passed, including nested immutable type proofs.
The final native verifier passed independently, and the original retained-function
recovery witness now passes against the built runtime. All recorded findings are
closed with executable evidence; independent critique found zero new material gaps
on its second pass. Platform-specific test skips remain as declared by the suite.

The earlier full attempt is retained as failed: it caught the provenance admission
regression and schema snapshot drift, and included transient fixture timeouts and a
proof rebuild overlapping CLI tests. The compatibility/schema fixes passed targeted
checks, the affected Git fixtures passed a stable rerun, and the final complete gate
ran against frozen source. No failing attempt is counted as successful evidence.

The earlier local gate and branch-native receipt remain historical evidence.
Publication and package activation are evidenced above; broader GitHub issue #1152
remains open.
