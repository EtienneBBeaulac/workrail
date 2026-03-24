# Docs Taxonomy and Migration Plan

This is the **concrete cleanup plan** for reducing `docs/` directory sprawl.

It does **not** move files immediately. It defines:

- the target long-term directory taxonomy
- which existing directories are canonical vs transitional vs legacy
- the recommended destination for the most confusing current files

## Why this exists

`docs/` currently reflects multiple generations of organization:

- old guide-style buckets like `implementation/`, `architecture/`, `advanced/`, `features/`
- newer planning buckets like `ideas/`, `roadmap/`, `tickets/`, `planning/`
- initiative-specific plan clusters in `plans/`
- generated artifacts and older docs that should no longer act like current truth

The result is too many directories with overlapping meanings.

## Target long-term taxonomy

These should be the long-term homes:

- `docs/adrs/` — architectural decision records
- `docs/design/` — durable design and architecture
- `docs/reference/` — normative/reference docs and operational reference material
- `docs/integrations/` — external platform and integration docs
- `docs/generated/` — generated artifacts
- `docs/ideas/` — low-friction idea capture
- `docs/roadmap/` — curated status and prioritization views
- `docs/tickets/` — execution-ready work
- `docs/planning/` — planning system meta-docs and documentation strategy
- `docs/plans/` — active initiative-specific plan/design docs only

## Directory classification

### Canonical

- `adrs/`
- `design/`
- `reference/`
- `integrations/`
- `generated/`
- `ideas/`
- `roadmap/`
- `tickets/`
- `planning/`

### Transitional

- `plans/`
- `features/`

### Legacy / shrink over time

- `architecture/`
- `implementation/`
- `advanced/`
- `migration/`

## Consolidation rules

### Rule 1: durable architecture and design go to `design/`

Use `design/` for:

- architectural explanations
- design principles
- extension-point design
- deep system model docs

Do **not** keep separate `architecture/` and `design/` worlds long term.

### Rule 2: reference and operations material goes to `reference/`

Use `reference/` for:

- configuration
- operational guidance
- troubleshooting
- stable feature reference

### Rule 3: `plans/` is only for live initiative docs

Keep `plans/` for:

- active feature/initiative roadmap docs
- active feature/initiative design docs
- canonical plan/design pairs like validation and v2

Do **not** let `plans/` become a graveyard of old entrypoints.

### Rule 4: planning surfaces stay separate by maturity

- `ideas/` = raw thoughts
- `roadmap/` = curated priorities and status
- `tickets/` = execution-ready work
- `planning/` = planning system meta-docs

## Directory-by-directory migration plan

### 1. `docs/architecture/` → fold into `docs/design/`

**Why**: this directory overlaps heavily with `design/` and should not remain a parallel home.

#### Recommended moves

- `docs/architecture/agent-cascade-protocol.md`
  - **Move to**: `docs/design/agent-cascade-protocol.md`
  - **Why**: durable protocol/design material

- `docs/architecture/subagent-design-principles.md`
  - **Move to**: `docs/design/subagent-design-principles.md`
  - **Why**: durable design/principles doc

- `docs/architecture/refactor-audit.md`
  - **Likely outcome**: retire from the live taxonomy, not a canonical design doc
  - **Why**: audit/history rather than long-term architecture truth

- `docs/architecture/REFACTOR-COMPLETE.md`
  - **Likely outcome**: remove from the live taxonomy
  - **Why**: milestone status note, not durable design

#### End state

`architecture/` should stop being treated as a live destination and eventually disappear.

### 2. `docs/advanced/` → absorb into `reference/` or `implementation/`

**Why**: these are effectively topical guides, not a distinct documentation class.

#### Recommended moves

- `docs/advanced/deployment.md`
  - **Merge into**: `docs/implementation/07-deployment-guide.md`
  - **Then**: retire `advanced/deployment.md` from the live taxonomy

- `docs/advanced/performance.md`
  - **Merge into**: `docs/implementation/06-performance-guide.md`
  - **Then**: retire `advanced/performance.md` from the live taxonomy

- `docs/advanced/security.md`
  - **Merge into**: `docs/implementation/05-security-guide.md`
  - **Then**: retire `advanced/security.md` from the live taxonomy

#### End state

`advanced/` should disappear as a live directory.

### 3. `docs/implementation/` → keep only live guides

**Why**: this directory contains a mix of still-live guides and retired docs.

#### Keep as live guides

- `02-architecture.md`
- `04-testing-strategy.md`
- `05-security-guide.md`
- `06-performance-guide.md`
- `07-deployment-guide.md`
- `09-simple-workflow-guide.md`
- `13-advanced-validation-guide.md`

#### Already retired / not live

- `03-development-phases.md`
- `11-implementation-planning-guide.md`

#### Recommendation

Either:

- keep `implementation/` as a smaller live guide bucket, or
- later split it into `guides/` plus a smaller set of clearly retired docs

Short-term, keeping it is acceptable once the dead docs stop competing.

### 4. `docs/features/` → split by actual doc type

**Why**: `features/` is currently a mixed bucket containing feature reference, design writeups, examples, and old analysis docs.

#### Keep as reference-worthy feature docs (short-term acceptable)

- `features/loops.md`
- `features/external-workflow-repositories.md`
- `features/feature-flags.md`

#### Better moved to `design/`

- `features/feature-flags-architecture.md`
- `features/loop-optimization.md`
- `features/loop-validation-best-practices.md`
- `features/context-optimization-guide.md`
- `features/agent-context-guidance.md`
- `features/agent-context-cleaner-snippet.md`
- `features/save-flow-analysis.md`

#### Better treated as examples/templates

- `features/example-workflow-repository-template/`
  - **Better home**: `docs/reference/examples/` or a dedicated `examples/` area if one is introduced

#### End state

`features/` should shrink to **true feature reference docs only**, or eventually disappear after redistribution.

### 5. `docs/plans/` → active initiative docs only

**Why**: `plans/` is useful, but only if it stays focused on live initiative-level docs.

#### Keep as canonical active initiative docs

- `agentic-orchestration-roadmap.md`
- `library-extraction-plan.md`
- `v2-followup-enhancements.md`
- `workflow-validation-roadmap.md`
- `workflow-validation-design.md`
- `workflow-v2-roadmap.md`
- `workflow-v2-design.md`
- `prompt-fragments.md`

#### Retire from the live surface

- old validation cluster entrypoints
- old prompt fragments trio
- old v2 one-pager/resumption docs
- `BRANCH_STRATEGY.md`
- `native-context-management-epic.md`

#### Recommendation

Continue reducing `plans/` by consolidating clusters into **one roadmap doc + one design doc** where possible.

### 6. `docs/migration/` → keep tiny or absorb into reference

**Why**: with only `migration/v0.1.0.md`, this is not really a mature directory.

#### Recommendation

Either:

- keep it as a tiny historical bucket until there are more migrations, or
- move the file into `reference/` if migration docs remain rare

This is low priority.

## Suggested execution order

### Phase 1 — lowest-risk structural cleanup

1. move `architecture/` docs into `design/`
2. leave, at most, a minimal directory note while `architecture/` is being phased out
3. update index links

### Phase 2 — remove redundant guide buckets

1. merge `advanced/` docs into their corresponding `implementation/` guides
2. remove `advanced/` as a live destination

### Phase 3 — shrink mixed buckets

1. split `features/` into:
   - design-heavy docs → `design/`
   - stable feature reference → keep or move to `reference/`
   - examples → dedicated example location
2. keep `plans/` focused on live initiative docs only

### Phase 4 — optional final polish

1. decide whether `implementation/` should stay as a live guide bucket
2. decide whether `migration/` should remain its own directory
3. simplify `docs/README.md` to reflect the final taxonomy

## Success criteria

This cleanup is successful when:

- each directory has a **clear, non-overlapping meaning**
- old directories no longer compete with new canonical ones
- `docs/README.md` can explain the structure simply
- contributors can tell where to put a doc without guessing
