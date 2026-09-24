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
