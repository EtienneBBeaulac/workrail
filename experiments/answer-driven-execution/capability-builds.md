# Cross-build recovery proof

Run from the repository with its dependencies already installed:

```sh
python3 experiments/answer-driven-execution/verify-capability-builds.py --output /tmp/workrail-capability-proof
```

The output directory must not exist. The runner copies personal source and resources,
compiles independent full and notes-only candidates, and retains source hashes, compiler
logs and probe results. The only source difference between candidates is the immutable
supported-output declaration, which enrollment and recovery enforce. These are current
source build variants, not historical released readers. Nothing is installed or activated.

The probe verifies compatible notes recovery, refusal of a workflow requiring future
review output through each ownership-acquiring recovery port, unchanged canonical and
pinned bytes, zero inference on refusal, subsequent capable recovery, exact receipts and
downstream review artifact consumption. A completed review can be reconciled without
execution capability. This proves that specific contract, not the whole roadmap gate.

# Historical notes controls

Some retained controls target the unmerged notes prototype at
`fa8846112444ae38fcdf1beffe72074cd37ba083`, which exposed `start_work` and
`submit_work`. The current candidate does not ship that profile. Prepare the real
prototype separately, then run both historical controls and current candidate cases:

```sh
python3 experiments/answer-driven-execution/prepare-notes-baseline.py --output /tmp/workrail-notes-control
WORKRAIL_NOTES_BASELINE_ROOT=/tmp/workrail-notes-control node_modules/.bin/vitest run --config experiments/answer-driven-execution/vitest.config.js experiments/answer-driven-execution/agent-answer.probe.ts experiments/answer-driven-execution/host-unbound-isolation.probe.ts experiments/answer-driven-execution/host-persisted-reader.probe.ts --retry=0
```

The baseline manifest retains the Git revision and archive digest. Dependencies come
from the explicitly selected candidate checkout; this is a source compatibility
control, not a reproduction of a historical installed dependency environment.
