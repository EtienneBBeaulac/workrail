# WorkRail MCP model-selection verification

Status: verified locally on `fix/etienneb/mcp-model-selection`.
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

## Native acceptance

- Selected binding: lightweight -> native `gpt-6-luna`, fresh context.
- Source hash: `7fcd4f7b4ef8eb5b5d0dd1c040b9613e1a429ac634f66f58c3e927294ad38a51`.
- Runtime build hash: `dfc92ffd0df4e6fd1481efa1019bf1f8db16771f5071703d7f27ff819be01bbb`.
- Nonce: `712039ba-920a-4e29-9a6b-968c87235c3c`.
- Durable child: `sess_wfmbctfvrx65pbvyo4tqvktcfy`.
- Receipt: `.workrail/model-selection-proof/native-receipt.json` (local evidence).
- Result: `native_launch_accepted_and_child_completed`.
- Provider identity: `not_independently_observed`.

The verifier checks unique, ordered build/startup/launch/completion receipts,
matching handoff and native task identity, schema-valid durable start/output/end
events, nonce, source/build hashes and resource closure. Codex encrypts prompt
arguments at rest; the nonce-bearing task name provides a public linkage without
reading or decrypting the prompt. The original transcript remains untouched.

No push, PR, merge or global client-setting change has been performed.

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

Remote review/CI/merge and installed activation are separate from this local result.
The feature remains unshipped and GitHub issue #1152 remains open.
