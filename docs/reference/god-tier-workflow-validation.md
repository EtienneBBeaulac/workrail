# God-Tier Workflow Validation
## Purpose
This document defines the required bar for workflow validation in WorkRail.
It exists to eliminate a class of trust-destroying failures where a workflow appears valid, is discoverable, is mergeable, or is startable, but later fails because the workflow itself is invalid.
The core promise is simple:
**if WorkRail says a workflow is valid and runnable, it must not fail later because of workflow-definition, normalization, discovery, compilation, or execution-contract defects.**
---
## Product-Level Non-Negotiables
### 1. Workflows must never fail during execution because the workflow itself is invalid
Once a workflow is accepted as runnable:
- `start_workflow` must not fail because the workflow is invalid
- `continue_workflow` must not fail because the workflow is invalid
- no later execution step may rediscover authoring invalidity
- pinned snapshots must already be trustworthy executable artifacts
If such a failure occurs, that is a **validation bug**.
### 2. Invalid workflows must never be mergeable
If any discoverable workflow is invalid:
- local validation must fail
- precommit must fail
- CI must fail
- merge must be blocked
### 3. Invalid workflows must never be hidden
Invalid workflows must not be:
- silently skipped
- omitted from validation output
- shadowed by another file without an explicit error
- hidden from registry validation because a different variant passed
Validation must fail loudly and report the problem.
### 4. Validation must be runtime-authoritative
Validation must validate the **same workflow runtime would execute**, not just a nearby file that looks similar.
---
## Core Contract
A workflow is only considered valid if WorkRail can prove all of the following:
1. it is discoverable without ambiguity
2. its runtime ID resolves deterministically
3. the resolved authored definition is schema-valid
4. the resolved authored definition is structurally valid
5. it normalizes into executable form successfully
6. the executable form passes executable schema validation
7. the executable form compiles successfully
8. the workflow can be started successfully
9. the workflow can be advanced successfully
10. the workflow can be driven to terminal completion in deterministic test execution
If any of these fail, the workflow is invalid.
---
## What Validation Must Be
### Authoritative
Validation is the single source of truth for executability.
There must not be multiple incompatible definitions of “valid” across:
- JSON schema validation
- structural validation
- workflow discovery
- start-time normalization
- runtime compilation
- execution-time transitions
### Runtime-equivalent
Validation must exercise the same logical contract as runtime:
- workflow discovery
- workflow ID resolution
- source selection
- authored-definition checks
- executable normalization
- executable schema enforcement
- compilation
- startability
- execution lifecycle
### Deterministic
The same repository state must always produce the same validation outcome.
There must be no:
- source-order dependence
- best-effort repair paths
- silent fallback to alternate workflow definitions
- hidden discovery precedence rules that validation does not model
### Total
Validation must cover:
- every discoverable workflow file
- every resolved runtime workflow ID
- every workflow variant that runtime could select
### Exhaustive
Validation must report **all invalid workflows in one run**.
Stopping on the first failure is not acceptable for repository-wide validation.
### Explainable
Each failure must report:
- workflow ID
- resolved source file
- competing source files, if any
- validation phase that failed
- exact error message
- exact bad path, if available
- suggested fix
---
## Validation Phases
## Phase 1 — Discovery Validation
Validation must load the same workflow registry that runtime uses and verify:
- all discoverable workflow files are enumerated
- all runtime workflow IDs are enumerated
- source-to-ID mapping is explicit
- duplicate IDs are detected
- ambiguous resolution is detected
### Required rule
If multiple sources can satisfy the same runtime workflow ID and resolution is not explicitly deterministic and validated, validation fails.
## Phase 2 — Resolution Validation
For each runtime workflow ID, validation must determine:
- which exact source runtime would use
- why it won
- what competing candidates exist
### Required rule
Validation must validate the **resolved runtime target**, not just individual files.
## Phase 3 — Authored Definition Validation
Validation must check the authored workflow for:
- schema validity
- required fields
- duplicate step IDs
- prompt-source rules
- loop rules
- reference integrity
- function definition/call integrity
- condition shape
- confirmation rule shape
- validation criteria shape
- output contract shape
- structural workflow invariants
This layer catches bad authored input early, before normalization.
## Phase 4 — Executable Normalization Validation
Validation must prove the authored workflow can normalize into runtime executable form:
- template expansion
- feature expansion
- ref resolution
- promptBlocks resolution
- authoring-only field stripping or rejection
- runtime-only shape enforcement
### Required rule
If normalization fails, validation fails.
There must be no raw authored fallback for executable workflows.
## Phase 5 — Executable Schema Validation
The normalized executable workflow must pass the stricter runtime schema.
This schema must reject:
- authoring-only keys
- unsupported runtime shapes
- unresolved prompt sources
- illegal runtime confirmation shapes
- any field runtime cannot faithfully execute
## Phase 6 — Compilation Validation
Validation must prove the executable workflow compiles into runtime structures successfully:
- step graph
- loop graph
- step lookup map
- loop-body resolution
- condition-source derivation
- output contracts
- any other runtime compilation artifacts
### Required rule
If compilation fails, validation fails.
## Phase 7 — Startability Validation
Validation must prove the resolved workflow can be started:
- initial execution state can be created
- first pending step is reachable
- no workflow-definition errors occur on the start path
### Required rule
If `start_workflow` would fail because of workflow shape, validation must fail first.
## Phase 8 — Lifecycle Executability Validation
Validation must prove the workflow can execute from start to finish under deterministic fixtures:
- start succeeds
- continue/advance succeeds
- terminal completion is reachable
- no workflow-definition/internal-shape error appears anywhere in the lifecycle
This is required for the strongest possible guarantee.
---
## Full-Workflow Execution Testing
## Goal
Static validity is necessary but not sufficient.
WorkRail should automatically test real workflow execution end-to-end.
## Required Harness
WorkRail should have a deterministic execution harness that:
1. starts a workflow by runtime ID
2. consumes pending steps
3. provides fixture-driven `output`, `context`, and approvals
4. advances the workflow repeatedly
5. verifies that terminal completion is reachable
6. fails on any workflow-definition or runtime-contract error
## Required Fixture Inputs
Each execution-tested workflow should define or be paired with:
- workflow ID
- required start inputs
- required workspace path, if any
- synthetic user answers
- synthetic step outputs
- branch-driving context values
- expected terminal condition
## Required Execution Coverage
At minimum, each runnable workflow should have:
- one happy-path completion test
- one minimum-input path where applicable
- one branch/confirmation path where applicable
- one loop path where applicable
For higher-risk workflows, add:
- retry path
- alternate branch path
- degraded/edge input path
## Required Failure Policy
If a workflow cannot be driven to completion under deterministic fixtures because of workflow-definition, compilation, or execution-contract issues, it is invalid and must fail validation/CI.
---
## Merge-Gate Requirements
Validation must block merges if any of the following are true:
- any workflow file is schema-invalid
- any discoverable workflow is structurally invalid
- any runtime workflow ID is ambiguous
- any resolved workflow cannot normalize into executable form
- any executable workflow fails executable schema validation
- any executable workflow fails compilation
- any workflow fails startability validation
- any workflow fails full-lifecycle deterministic execution testing
There are no exceptions for “hidden” or “unused” workflows.
If it is discoverable, it must validate.
---
## Runtime Invariants
These must hold system-wide:
1. no invalid workflow may be discoverable without validation failing
2. no ambiguous workflow ID may exist in the runtime registry
3. no authored workflow may be pinned unless it normalized successfully
4. no executable workflow may be stored unless it passes executable schema validation
5. no executable workflow may be runnable unless it compiles
6. no workflow-definition error may first appear during user-visible execution
7. validation and runtime resolution must be identical
8. if runtime hits a workflow-definition failure, the validator is considered incomplete
---
## Reporting Requirements
Repository-wide validation must report **every** invalid workflow in one run.
For each runtime workflow ID, the report should include:
- workflow ID
- selected source path
- competing source paths
- discovery status
- authored validation status
- executable normalization status
- executable schema status
- compilation status
- startability status
- lifecycle execution status
For each failure, report:
- phase
- message
- path
- suggested fix
---
## Anti-Patterns That Must Be Eliminated
- validating files while runtime executes resolved IDs
- silently preferring one duplicate over another
- best-effort raw fallback for executable workflows
- passing validation but failing `start_workflow`
- passing `start_workflow` but failing later because of workflow-definition issues
- hiding invalid workflows from lists or validation output
- stopping repository validation at the first invalid workflow
- allowing precommit/CI to pass when any discoverable workflow is invalid
---
## Acceptance Criteria
This system is only “done” when all of the following are true:
1. `validate:workflows` validates the full runtime registry, not just files
2. validation reports all invalid workflows in a single run
3. duplicate/ambiguous workflow IDs are hard failures
4. the exact workflow runtime would execute has already passed validation
5. `start_workflow` cannot fail because the workflow definition is invalid
6. `continue_workflow` cannot fail because the workflow definition is invalid
7. full deterministic execution tests can run workflows from start to terminal completion
8. any workflow-definition failure observed during execution is treated as a validation bug
---
## One-Sentence Standard
**A WorkRail workflow is valid only if the exact runtime-resolved workflow ID can be deterministically discovered, normalized, compiled, started, advanced, and completed under automated validation before it is allowed to merge or execute for a user.**