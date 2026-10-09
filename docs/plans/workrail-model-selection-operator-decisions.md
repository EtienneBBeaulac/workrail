# WorkRail model-selection operator decisions

These are the human responses from this feature's current conversation. They are
inputs to the pipeline, not inferred answers or execution evidence.

## Architecture direction

Question: Complete model selection as portable WorkRail requests plus explicit
client bindings, preserving tiers through start, delegation, and recovery, with
client-owned launch, explicit unsupported outcomes, and separate model evidence?

Response: "Implement this boundary (Recommended)".

## Acceptance client

Question: Which client should receive the first end-to-end model-selection check?

Response: "Codex".

## Acceptance binding

Question: Which model should the lightweight tier request for the bounded native
Codex acceptance run, without changing global settings?

Response: "gpt-6-luna (Recommended for a bounded test)".

## Pipeline coordination

Instruction: "use [$pipeline]".

The coordinator must preserve the approved model-selection objective while
following the pipeline's derived next action. No response authorized publishing,
merging, changing global client configuration, or a WorkTrain implementation.
