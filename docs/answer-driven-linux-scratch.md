# Opt-in Linux scratch source profile

The answer-host runner has an internal Linux scratch composition. It is not installed,
admitted by the public daemon scheduler, or activated automatically. Native/worktree policies
retain their existing refusal. This source is intended for a trusted host caller with a fresh
canonical owner and the original execution deadline, not a serialized resume record.

The model sees Read, Write, Edit, Bash, Glob and Grep plus answer_work. It receives a clear
scratch-workspace instruction. The host owns Docker, owner fences, deadlines, the protocol
sequence and durable effect accounting. A typed backend refusal never falls back to host tools.
Observed Bash exit failures are returned as error results; missing replies halt the delivery.

## Input and execution contract

- The profile names a cached digest-pinned image and Linux architecture. Runtime never pulls an
  image. Python 3 and /bin/bash are checked before granting the live workspace capability.
- The input is an explicit supplied-file manifest with its selection description, at most 128
  files and 256 KiB of UTF-8 data. It is copied, validated and frozen. This API does not crawl a
  checkout, read untracked files implicitly, or exclude user edits silently. The trusted caller
  must make the selected subset explicit. Symlinks, special files and .git metadata are not input.
- The container has no network, host mounts, credentials, or daemon socket. Root is read-only;
  scratch writes use a private 8 MiB tmpfs. It has 32 PIDs, 64 MiB memory and 0.5 CPU limits.
- The supervisor owns its protocol as root. Only SETUID, SETGID, CHOWN and DAC_OVERRIDE are added
  after dropping capabilities, so shell processes can run as uid 65534 with separate output and
  no protocol descriptors. This is process/container isolation, not protection from daemon
  administrators or kernel compromise. No host credentials are forwarded in command environments.
- File operations resolve directory descriptors with no-follow semantics and refuse nonregular
  files. One live exec stream validates nonce, exact sequence, complete frames and output bounds.
  There is no reconnect or deserialization API. Command budgets cannot extend the run deadline.
- Creation intent is retained before allocation. Lost create acknowledgment leaves an inspectable
  orphan and refuses replacement. Historical records grant no live execution authority.

## Inspection and cleanup

`finish` returns explicit inspection and cleanup outcomes. Its fixed, read-only capture program
has no agent command input; it reads bounded regular files without following links. The immutable
JSON observation is exclusively created and synced under the host-provided artifact directory.
It contains base64 file content and is never extracted into a checkout. It is an observation
while the environment exists, not an atomic snapshot, successful export, or proof of quiescence.
Unknown or interrupted work may have unavailable inspection; that outcome is explicit.

Cleanup checks the observed daemon ID, exact container ID and canonical supervisor label,
retains stop intent, observes process exit and removes only that exact stopped container.
A stop-only capability uses a separate 30-second teardown deadline, so expiry of the inference
journal cannot prevent cleanup records. It exposes no creation, start, model or tool operations.
The trusted caller supplies a cleanup signal independent of inference cancellation. A
changed owner, uncertain acknowledgment, identity mismatch or failed command returns unconfirmed.
It never uses force removal, shared pruning, retries of effects, or a second cleanup registry.
Unknown bootstrap/cleanup requires operator reconciliation using canonical evidence. A Docker
ID check is an observation, not an atomic expected-daemon conditional API or restart guarantee.

## Execution ownership

The internal `bindLinuxScratchExecution` adapter adopts one prepared workspace and the original
admission deadline. It binds each delivery to fresh canonical model/effect accounting while
keeping scratch files across accepted nonfinal answers and corrections. The canonical runner
still owns answer capture and commit; there is no parallel answer engine or execution registry.
The scratch warning travels in the turn input because the transport owns the retained system
prompt. It reaches the actual provider request without replacing that retained prompt.

Final answers, failures, uncertainty, cancellation and idle expiry revoke inference and join one
tracked cleanup operation. Cleanup uses its own bounded capability. An accepted answer remains
accepted even if cleanup is unconfirmed. `close` exposes both the lifecycle result and workspace
inspection/cleanup outcome; a provider still settling is reported as work in flight even when the
workspace is removed. It never reports a thrown cleanup boundary as successful.

The durable policy schema now accepts an explicit Linux scratch manifest. The trusted
`prepareLinuxScratchExecution` entry consumes a fresh admission handoff, provisions only that
retained profile, and transfers its original deadline and workspace to the adapter. Request
cancellation during preparation closes that deadline; after adoption the request listener is
removed. Unknown creation is returned with the owned identity for reconciliation, never retried.
The request workspace path is provenance only for this profile, not a mount or file-read grant.
Host enrollment registration and ownership-release integration remain outstanding. The public
runtime continues refusing daemon policy enrollment. The adapter cannot resume a lost stream or
reconstruct deadline continuity from a persisted pointer.

## Verification

Deterministic channel/profile and canonical controller tests run in the ordinary suite. The
real local backend proof requires explicit environment variables and a preloaded pinned image:

```
WORKRAIL_TEST_LINUX_SCRATCH=1 \
WORKRAIL_TEST_DOCKER_BINARY=/absolute/path/to/docker \
WORKRAIL_TEST_DOCKER_SOCKET=/absolute/path/to/docker.sock \
npx vitest run tests/integration/answer-host/host-admission.test.ts \
  -t 'composes canonical effects with an isolated Linux' --retry=0
```

That proof uses a fake model and real canonical journal/controller/backend. It verifies all six
tools, shell-error propagation, retained file contents, cancellation after a write and during a
running shell, lost replies, stale owners, bootstrap uncertainty, deadline refusal and symlink
escape refusal. It does not establish improved AI review quality or safe automatic host writeback.

The `execution resource spans` matrix additionally exercises fresh admission, the canonical runner,
budgeted SDK transport and execution ownership. Ordinary cases use a fake workspace; opt-in
`real_two_turns` and `real_expired_idle` use Docker, proving one allocation, cross-turn file content
and cleanup triggered while idle. These are trusted source-composition tests, not public enrollment.

The `prepares only the retained scratch profile` cases cover consumed handoffs, native-profile
refusal, preflight failures, caller input isolation and cancellation. Opt-in real cases additionally
prove retained file content, unknown creation and cancellation during allocation with no retry.
