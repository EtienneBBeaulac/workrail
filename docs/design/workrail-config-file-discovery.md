# WorkRail Config File: Discovery and Architecture Brief

**Status:** Discovery complete  
**Date:** 2026-04-06  
**Author:** Discovery workflow (wr.discovery v3.1.0)

---

## Context / Ask

WorkRail is configured entirely through environment variables passed in each IDE's MCP server block
(Cursor `.cursor/mcp.json`, Claude Code `.claude.json`, Firebender config, etc.). When a flag is
added or changed, every IDE config file must be updated by hand. The user wants a single
`~/.workrail/config` file that all IDEs pick up automatically, with env vars still available as
overrides.

**Desired outcome:** An architecture brief and requirements list ready to turn into a ticket.

---

## Path Recommendation

**Path:** `landscape_first`

**Rationale:** The solution space is bounded and familiar (dotfile config loading is a solved
pattern). The core question is "which design fits best here?" not "are we solving the right
problem?". The landscape -- existing flags, where they are read, and how the codebase is already
structured -- is the dominant input. A full-spectrum reframe would add ceremony without sharpening
the answer.

---

## Landscape Packet

### Current State Summary

WorkRail reads configuration from `process.env` at startup in multiple layers:

**Layer 1: Structured config (validated via Zod, `src/config/app-config.ts`)**

These are parsed through `loadConfig({ env: process.env, ... })` with Zod schema validation,
returning a `Result` type. The DI container calls this at startup.

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL` | `300000` | Workflow cache TTL (ms) |
| `WORKRAIL_WORKFLOWS_DIR` | cwd | Override workflow search root |
| `WORKRAIL_DISABLE_UNIFIED_DASHBOARD` | `0` | Disable unified dashboard |
| `WORKRAIL_DISABLE_AUTO_OPEN` | `0` | Disable browser auto-open |
| `WORKRAIL_DASHBOARD_PORT` | `3456` | Dashboard HTTP port |

**Layer 2: Feature flags (boolean toggles, `src/config/feature-flags.ts`)**

Read by `EnvironmentFeatureFlagProvider` which accepts a `Record<string, string | undefined>` env
source. Flags have typed keys, defaults, stability markers, and descriptions.

| Variable | Default | Stable | Description |
|----------|---------|--------|-------------|
| `WORKRAIL_ENABLE_SESSION_TOOLS` | `true` | yes | Session management tools |
| `WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS` | `false` | no | Load experimental/ dir |
| `WORKRAIL_VERBOSE_LOGGING` | `false` | yes | Debug logging |
| `WORKRAIL_ENABLE_AGENTIC_ROUTINES` | `true` | yes | Agentic orchestration |
| `WORKRAIL_ENABLE_LEAN_WORKFLOWS` | `false` | no | Lean workflow variants |
| `WORKRAIL_AUTHORITATIVE_DESCRIPTIONS` | `false` | no | Imperative tool language |
| `WORKRAIL_ENABLE_V2_TOOLS` | `true` | yes | V2 MCP tools |
| `WORKRAIL_CLEAN_RESPONSE_FORMAT` | `false` | no | Clean response format |

**Layer 3: Ad-hoc env flags (read via direct `process.env[]` access)**

Scattered across the codebase; not behind the structured config or feature-flags system.

| Variable | Where read | Description |
|----------|-----------|-------------|
| `WORKRAIL_DEV` | `src/mcp/dev-mode.ts`, `src/mcp/assert-output.ts` | Unified dev flag (staleness + timing + perf endpoint) |
| `WORKRAIL_JSON_RESPONSES` | `src/mcp/handler-factory.ts` | Force JSON response format |
| `WORKRAIL_CLEAN_RESPONSE_FORMAT` | `src/env-flags.ts` | Also read directly (duplicate) |
| `WORKRAIL_LOG_LEVEL` | `src/utils/logger.ts` | Log level |
| `WORKRAIL_LOG_FORMAT` | `src/utils/logger.ts` | Log format (human or json) |
| `WORKRAIL_DATA_DIR` | `src/v2/infra/local/data-dir/index.ts` | Override data directory |
| `WORKRAIL_CACHE_DIR` | `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts` | Cache base directory |
| `WORKFLOW_STORAGE_PATH` | `src/mcp/handlers/shared/request-workflow-reader.ts`, `enhanced-multi-source-workflow-storage.ts` | Additional workflow dirs (colon-sep) |
| `WORKFLOW_GIT_REPOS` | `enhanced-multi-source-workflow-storage.ts` | Git repo URLs |
| `WORKFLOW_GIT_REPO_URL` | same | Single repo URL |
| `WORKFLOW_GIT_REPO_BRANCH` | same | Branch to use |
| `WORKFLOW_GIT_SYNC_INTERVAL` | same | Sync interval (minutes) |
| `WORKFLOW_REGISTRY_URL` | same | Remote registry URL |
| `WORKFLOW_REGISTRY_API_KEY` | same | Registry API key |
| `WORKFLOW_REGISTRY_TIMEOUT` | same | Registry timeout (ms) |
| `WORKFLOW_INCLUDE_BUNDLED` | `enhanced-multi-source-workflow-storage.ts` | Include built-in workflows |
| `WORKFLOW_INCLUDE_USER` | same | Include user workflows |
| `WORKFLOW_INCLUDE_PROJECT` | same | Include project workflows |
| `GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN` | same | VCS auth tokens |
| `GIT_TOKEN` / `WORKFLOW_GIT_AUTH_TOKEN` | same | Generic git auth fallbacks |
| `GIT_<HOSTNAME>_TOKEN` | same | Hostname-based auth tokens |

**Total distinct variables: 35+**

### Existing Patterns and Precedents

1. **`~/.workrail/` already exists** as the user data directory. It contains `workflows/`, `cache/`,
   `sessions/`, `data/`, `logs/`. A `config.json` alongside these would be natural.

2. **`loadConfig` in `app-config.ts`** already accepts `env: Record<string, string | undefined>` --
   not `process.env` directly. This is the right extension point: pass a merged env record instead
   of raw `process.env`.

3. **`EnvironmentFeatureFlagProvider`** accepts the same `Record<string, string | undefined>` shape.
   Same pattern.

4. **`LocalDataDirV2`** reads `WORKRAIL_DATA_DIR` from its injected env. Same pattern -- already
   injectable.

5. **The DI composition root (`src/di/container.ts`)** is the single place where `process.env` is
   injected into all of these. This is the correct and minimal seam to intercept.

6. **`.workrail/bindings.json`** is already a project-level config file -- the project already has
   a precedent for on-disk config.

7. **Industry precedent:** dotenv-style overlay files (`.npmrc`, `~/.gitconfig`, `~/.cargo/config.toml`,
   `~/.docker/config.json`) universally use a pattern where the file provides defaults and env vars
   override.

### Option Categories

- **A. Simple env-file load** -- load `~/.workrail/config` as a key=value (dotenv-style) file,
  merge into `process.env` early, before the DI container runs.
- **B. Typed JSON config file** -- load `~/.workrail/config.json`, map to typed keys, merge into
  the env record at the composition root (not into `process.env`).
- **C. TOML config file** -- same semantics as B but TOML format.
- **D. Two-tier: user config + project config** -- `~/.workrail/config.json` (global) plus
  `.workrail/config.json` (project, gitignored-optional). Already has `.workrail/bindings.json`
  precedent.
- **E. Do nothing, just document** -- accept env vars as the config surface, improve docs.

### Contradictions and Disagreements

1. `WORKRAIL_CLEAN_RESPONSE_FORMAT` is read in TWO places: once through `feature-flags.ts` (via
   DI) and once directly in `src/env-flags.ts`. If config-file loading happens at the DI
   composition root but `env-flags.ts` still reads `process.env` directly, the duplicate path will
   be stale.

2. Some flags are genuinely per-machine or per-IDE (e.g., `WORKFLOW_GIT_REPOS`, `WORKFLOW_STORAGE_PATH`
   -- different machines have different repo paths). A global user config file must handle these
   cases without forcing incorrect defaults.

3. `WORKRAIL_DEV` is a development-only flag explicitly not documented for production use. It is
   unlikely to belong in a user config file but should be considered.

4. Auth tokens (`GITHUB_TOKEN`, etc.) belong in the environment, not in a config file (secret
   management concern). They should be explicitly out of scope for the config file.

5. `WORKRAIL_DATA_DIR` is injected via `LocalDataDirV2(process.env)` from the DI container -- it
   could be supported in config but is rarely needed.

### Evidence Gaps

- No current unit test covers the config-loading seam being injectable. Tests use
  `EnvironmentFeatureFlagProvider.withEnv(env)` for feature flags but the broader `loadConfig` path
  hasn't been verified for full injectability.
- The exact startup order (when `dev-mode.ts` and `env-flags.ts` module-level constants are
  evaluated vs. when the DI container runs) needs to be checked. If those constants are evaluated
  before the config file is read, merging at the DI level is insufficient for those two files.

---

## Problem Frame Packet

### Users / Stakeholders

- **Primary user: the developer configuring WorkRail locally** -- wants to set flags once and have
  all IDE integrations pick them up without maintaining parallel config blocks.
- **CI / automation** -- needs to override individual flags without a config file (env-only path
  must remain fully functional).
- **Team members sharing workflow repos** -- may have different machine-specific paths; config file
  must not force a shared value for per-machine settings.

### Jobs, Goals, and Outcomes

- Set flags once, have all IDEs see them automatically.
- Add a new flag without touching N IDE config files.
- Keep CI clean (no config file in CI, just env vars).
- Preserve the ability for env vars to override the file (for per-IDE variation when legitimately needed).

### Pains / Tensions / Constraints

1. **The "scatter problem"**: 35+ env vars, 3+ IDE configs, manual sync required today.
2. **Auth tokens must stay in env**: config files may be dotfiles-tracked in git; tokens cannot be
   in a potentially-committed file.
3. **Per-machine paths**: `WORKFLOW_GIT_REPOS` and `WORKFLOW_STORAGE_PATH` are typically different
   per machine. They belong in the config file for that machine but should not be treated as global
   team defaults.
4. **Module-level constants** in `dev-mode.ts` and `env-flags.ts` are evaluated at import time,
   before any DI container initialization. A config-file loading approach that only intercepts at
   the DI level will miss these two.
5. **Process boundary**: WorkRail runs as an MCP stdio server; `process.env` is set by the parent
   process (the IDE). A config file must be loaded early in the server's own boot sequence.

### Success Criteria

1. A developer can set any flag in `~/.workrail/config.json` and have it take effect in all IDEs
   without IDE-specific config changes.
2. Env vars still override config file values (env takes precedence over file).
3. Auth tokens (`GITHUB_TOKEN`, etc.) work correctly from env only -- not from config file.
4. CI override: setting an env var in CI overrides the config file value without requiring a config
   file to exist.
5. If the config file is absent or malformed, WorkRail starts with defaults (file is optional).
6. Module-level constants (`WORKRAIL_DEV`, `WORKRAIL_CLEAN_RESPONSE_FORMAT`) are resolved from the
   same merged env, not from raw `process.env`.

### Assumptions

- `~/.workrail/` is the right home for the config file (already established as the user data dir).
- JSON is the right format (already used for `.workrail/bindings.json`, workflow files, etc.).
- TypeScript / Node.js; no external config library like `cosmiconfig` is assumed to be available.
- The config file is not a secrets store.

### Reframes / HMW Questions

- **HMW 1:** How might we make it easy to see which IDE is overriding which config value? (The
  precedence chain should be observable.)
- **HMW 2:** How might we structure the config so that per-machine and per-IDE settings have an
  obvious natural home? (Could the schema group "global" vs "local" keys, or add comments in a
  JSONC format?)

### What Could Make This Framing Wrong

- If `WORKRAIL_DEV` and similar module-level constants are moved into the feature-flags system
  before this work, the "missing seam" problem at module load time disappears.
- If the real driver is "too many flags" (not "too many places to configure them"), the right
  solution might be a flag-review pass + documentation improvement, not a new config file.

---

## Candidate Directions

### Direction A: Env-file merge at process startup (dotenv-style)

Load `~/.workrail/config` as a dotenv file early in `src/mcp-server.ts` (before any module
with module-level constants is imported), merge into `process.env` for keys not already set.

**Fits the path because:** dotenv-style loading is a well-understood pattern in Node.js; it handles
the module-level constant problem because the load happens before any imports evaluate them.

**Strongest evidence for:** Simple. Covers all env vars including module-level constants. Standard
pattern (`dotenv` package or small custom parser). No schema changes needed.

**Strongest risk:** Mutates `process.env`, which violates the "immutability by default" coding
philosophy. Also, dotenv files have no structure -- they look like `.env` files, which users may
conflate with secrets files and hesitate to commit to dotfiles repos.

**When it should win:** If covering module-level constants is the top priority and simplicity
matters more than format elegance.

---

### Direction B: Typed JSON config merged at DI composition root (no process.env mutation)

Load `~/.workrail/config.json` at the DI composition root (`src/di/container.ts`) before the
first `loadConfig` call. Build a merged env record: `{ ...configFileEntries, ...process.env }`.
Pass this merged record to all consumers: `loadConfig`, `EnvironmentFeatureFlagProvider`,
`LocalDataDirV2`. Update `dev-mode.ts` and `env-flags.ts` to receive their values via DI
injection instead of reading `process.env` directly.

**Fits the path because:** It builds on the existing injectable pattern that `loadConfig` and
`EnvironmentFeatureFlagProvider` already use. Does not mutate global state. JSON is already the
project's config format.

**Strongest evidence for:** No `process.env` mutation. The injectable seam already exists for
two of the three layers. JSON schema can be validated with Zod (already a project dependency). The
config key names can map 1:1 to env var names initially, keeping the mental model simple.

**Strongest risk:** Requires refactoring `dev-mode.ts` and `env-flags.ts` away from module-level
constants -- they must not read `process.env` at import time. This is a non-trivial change in
scope; if it is deferred, those two flags still won't benefit from the config file.

**When it should win:** When architectural cleanliness and no global mutation matter more than
scope minimalism.

---

### Direction C: Two-tier config (user + project) JSON

Same as Direction B but with two config files: `~/.workrail/config.json` (user-global) and
`.workrail/config.json` in the project root (per-project, gitignore-able). Precedence:
`process.env > project config > user config`.

**Fits the path because:** Aligns with the existing `.workrail/bindings.json` project-level
precedent. Natural home for per-project overrides (e.g., `WORKFLOW_STORAGE_PATH` scoped to a
specific project).

**Strongest evidence for:** Models how gitconfig (`~/.gitconfig` + `.git/config`) and many other
tools work. The project-level file is already adjacent to `bindings.json` so the directory exists.

**Strongest risk:** More complex to implement and explain. The per-project config file could cause
surprises if committed to a team repo ("why do all team members get the same workflow path?").

**When it should win:** When per-project flag overrides are a real known use case, not speculation.

---

## Challenge Notes

**Challenging Direction B (the leading option):**

The strongest argument against B is the scope of the `dev-mode.ts` / `env-flags.ts` refactor. Both
files export module-level constants that are evaluated at import time -- this is intentional (the
comment in `env-flags.ts` says "MCP servers are long-lived processes; env vars are set at startup
and do not change at runtime. Caching here eliminates per-call lookups"). Injecting these through DI
means converting those module-level exports to injected singleton values, which means every consumer
of `DEV_MODE` and `CLEAN_RESPONSE_FORMAT` must change from `import { DEV_MODE }` to DI resolution.
That is a wider refactor than "load a config file".

**Resolution:** This is a real scope concern, but there is a pragmatic middle path. Direction B can
be implemented in two sub-phases:

- **Phase 1 (tight scope):** Load config file at the DI composition root, merge env record, pass to
  `loadConfig` and `EnvironmentFeatureFlagProvider` only. This covers ~95% of the user-facing flags
  without touching the module-level constants.
- **Phase 2 (cleanup):** Move `dev-mode.ts` and `env-flags.ts` to DI-injectable singletons.
  `WORKRAIL_DEV` is a developer tool not needed by most users; deferring Phase 2 is acceptable.

Direction A (dotenv mutation) is rejected because mutating `process.env` creates implicit coupling
and violates the architectural direction of the codebase.

Direction C (two-tier) is rejected as speculative -- the per-project use case is not a known pain
point today. The project-level config can be added later if demand emerges.

---

## Decision Log

**Selected direction: B (JSON config merged at DI composition root), phased.**

**Why B won:**

1. No `process.env` mutation -- consistent with immutability-by-default principle.
2. The injectable seam (`loadConfig({ env: ... })` and `EnvironmentFeatureFlagProvider.withEnv(env)`)
   already exists. The work is primarily plumbing: load file, build merged record, pass it through.
3. JSON with Zod validation is already the project pattern (see `app-config.ts`). Schema can be a
   subset of env vars -- just the ones that make sense to set globally.
4. The two-phase approach handles the scope concern without deferring user value.

**Why A lost:**

Global `process.env` mutation is architecturally inconsistent with how the codebase is moving. It
also leaves the config surface untyped and unvalidated.

**Why C lost:**

The per-project config tier adds complexity for a use case that does not yet have evidence of user
demand. `.workrail/bindings.json` already handles workflow-level overrides; a second project-level
config file risks confusing the mental model.

**Accepted tradeoffs:**

- `WORKRAIL_DEV` and `WORKRAIL_CLEAN_RESPONSE_FORMAT` will NOT benefit from the config file in
  Phase 1. This is acceptable: `WORKRAIL_DEV` is a developer-only flag, and `WORKRAIL_CLEAN_RESPONSE_FORMAT`
  is already in the feature-flags system (the `env-flags.ts` version is a legacy duplicate).
- The config file will use env var names as keys (not a new abstraction layer). This keeps the
  mental model simple: what you'd put in an IDE env block, you can put in the config file instead.

**Switch trigger:** If the `dev-mode.ts` module-level constant pattern is found to cause problems
in practice (e.g., users can't configure `WORKRAIL_DEV` from the file), Phase 2 should be pulled
forward.

---

## Resolution Notes

**Resolution mode:** `direct_recommendation`

**Confidence band:** HIGH for the config loading architecture. MEDIUM for the exact schema surface
(which keys belong in the file vs. env-only). The codebase evidence is unambiguous on the seam;
the "which keys" question has some judgment calls.

**Residual risks:**

1. `env-flags.ts` still reads `process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT` directly -- this will
   shadow the feature-flags version if anyone sets the key in the config file (they'll see the DI
   flag updated but not the module-level constant). Mitigation: delete the `env-flags.ts` export
   entirely and consolidate on the DI path in Phase 1 (it is already the right place).

2. Auth tokens are excluded from the config schema by design, but the schema validation needs to
   explicitly reject or ignore any token-shaped key submitted to the config file.

3. The config file is read from `~/.workrail/config.json` -- this path is hardcoded. On machines
   where `~` is non-standard or the data dir is overridden via `WORKRAIL_DATA_DIR`, the config file
   location may be surprising. Mitigation: use `os.homedir()` + `/.workrail/config.json`
   consistently and document it.

---

## Final Summary

### Architecture Brief

The correct implementation is a typed JSON config file at `~/.workrail/config.json`, loaded at the
DI composition root before the first `loadConfig` call. The file provides default env values that
are overridden by any key present in `process.env`. No mutation of `process.env`; the merged record
is passed through the existing injectable seams.

**Loading sequence:**

```
~/.workrail/config.json (defaults)
    + process.env (overrides)
    = merged env record
    --> loadConfig(mergedEnv)
    --> EnvironmentFeatureFlagProvider(mergedEnv)
    --> LocalDataDirV2(mergedEnv)
```

**Config file format:**

```json
{
  "WORKRAIL_ENABLE_LEAN_WORKFLOWS": "true",
  "WORKRAIL_CLEAN_RESPONSE_FORMAT": "true",
  "WORKRAIL_AUTHORITATIVE_DESCRIPTIONS": "true",
  "WORKRAIL_ENABLE_V2_TOOLS": "true",
  "WORKFLOW_STORAGE_PATH": "/Users/me/shared-workflows",
  "WORKFLOW_GIT_REPOS": "https://github.com/myteam/workflows.git",
  "CACHE_TTL": "0"
}
```

Keys are the exact env var names. String values, same as env vars. Unknown keys: warn and ignore
(never error -- WorkRail should still start if a key is unknown).

**Precedence:** `process.env` > `~/.workrail/config.json` > compiled defaults.

**Excluded from config file schema (env-only):**

- All `*_TOKEN` keys (`GITHUB_TOKEN`, `GITLAB_TOKEN`, etc.) -- secrets management concern.
- `WORKRAIL_DEV` -- developer-only, not a user config surface.
- `NODE_ENV`, `VITEST` -- runtime/test framework vars.

**Phase 1 scope:**

1. Add `loadWorkrailConfigFile(): Record<string, string>` utility in a new `src/config/config-file.ts`.
   Uses `os.homedir()`, reads `~/.workrail/config.json` if it exists, validates with Zod, returns
   empty record on absence or parse error (with a warning log).
2. In `src/di/container.ts`, call `loadWorkrailConfigFile()` before `loadConfig()`. Build
   `mergedEnv = { ...configFileValues, ...process.env }`. Pass `mergedEnv` to `loadConfig` and to
   `EnvironmentFeatureFlagProvider`.
3. Delete `src/env-flags.ts` (the `WORKRAIL_CLEAN_RESPONSE_FORMAT` module-level constant is already
   covered by the feature-flags DI path; the duplicate is dead weight).
4. Add `workrail init --config` CLI command that writes a commented `~/.workrail/config.json`
   template with all supported keys and their defaults.
5. Update `docs/configuration.md` with the new config file section, precedence order, and what
   belongs in the file vs. env-only.

**Phase 2 scope (deferred):**

Move `dev-mode.ts` (`WORKRAIL_DEV`) to a DI-injectable singleton so it can also read from the
config file.

### Requirements List (ticket-ready)

**Functional requirements:**

- FR1: WorkRail reads `~/.workrail/config.json` on startup if it exists.
- FR2: Any env var name (except excluded secrets and dev-only flags) may appear as a key in the config file.
- FR3: `process.env` values override config file values for the same key.
- FR4: If the config file is absent, WorkRail starts with compiled defaults (file is optional).
- FR5: If the config file is malformed (invalid JSON or invalid key types), WorkRail logs a warning
  and starts with compiled defaults -- no crash.
- FR6: Unknown keys in the config file produce a warning log and are ignored.
- FR7: Auth token keys (`*_TOKEN`) are not read from the config file (excluded from schema or
  ignored with a warning).

**Non-functional requirements:**

- NFR1: No mutation of `process.env`.
- NFR2: Config file loading uses `os.homedir()` for portability.
- NFR3: The merged env record is the only input to `loadConfig` and `EnvironmentFeatureFlagProvider`
  (no other `process.env` access in those constructors).
- NFR4: Config loading failure is represented as a `Result` type, not a thrown exception.
- NFR5: Loading must complete before any DI registration that reads env vars.

**CLI / DX requirements:**

- DX1: `workrail init --config` writes a `~/.workrail/config.json` template with all supported
  keys commented out and their defaults shown.
- DX2: `WORKRAIL_LOG_LEVEL=DEBUG` (or via config file) should log which keys were loaded from
  the config file and which were overridden by `process.env`.

**Documentation requirements:**

- DOC1: `docs/configuration.md` must document the config file, its location, format, precedence
  order, and excluded keys.
- DOC2: Existing env var documentation should note that the same keys work in the config file.

**Testing requirements:**

- TEST1: Unit test for `loadWorkrailConfigFile()` -- file absent, valid file, malformed JSON, unknown
  keys, excluded token key.
- TEST2: Integration test for the DI composition root with a config file present -- verify that
  config file values are visible to `loadConfig` and feature flags.
- TEST3: Override test -- env var overrides config file value for the same key.

---

## Next Actions

1. Create a ticket from the requirements list above.
2. Phase 1 implementation:
   a. `src/config/config-file.ts` -- `loadWorkrailConfigFile()` with Zod schema.
   b. `src/di/container.ts` -- inject merged env into `loadConfig` and `EnvironmentFeatureFlagProvider`.
   c. Delete `src/env-flags.ts` -- consolidate on feature-flags DI path.
   d. `workrail init --config` CLI subcommand.
   e. Update `docs/configuration.md`.
3. Phase 2 (separate ticket): move `WORKRAIL_DEV` to a DI singleton.
