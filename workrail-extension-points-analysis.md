# WorkRail Workflow Discovery - Extension Points Analysis

## What This Document Is

A technical map of the WorkRail workflow discovery system as it exists today.
For human readability. Execution truth lives in WorkRail workflow notes and context.

## What This Document Is NOT

This is not a design proposal. No fixes are proposed here.
This is not an exhaustive code audit - scoped to discovery-relevant paths only.

---

## 1. Complete Set of Workflow Sources

`EnhancedMultiSourceWorkflowStorage` (`src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`) is the root aggregator. It loads workflows from seven sources in priority order (highest priority last, last-wins deduplication):

| Priority | Source kind | Default path | How activated |
|----------|-------------|--------------|---------------|
| 1 (lowest) | `bundled` | `dist/../../workflows/` (package-relative) | Always on. Resolved via `getBundledWorkflowsPath()` at line 426. |
| 2 | `plugin` | npm package dir | `EnhancedMultiSourceConfig.pluginConfigs` array. Not env-var driven. |
| 3 | `user` | `~/.workrail/workflows` | Always on unless `WORKFLOW_INCLUDE_USER=false`. Path at line 436. |
| 4 | `custom` | any directory | `WORKFLOW_STORAGE_PATH` (colon-delimited) parsed at line 141. Also `customPaths` config array. |
| 5 | `git` | cloned to `~/.workrail/cache/git-N-name/` | `WORKFLOW_GIT_REPOS` (JSON or comma-delimited) parsed at line 495. Single repo: `WORKFLOW_GIT_REPO_URL` + `WORKFLOW_GIT_REPO_BRANCH`. |
| 6 | `remote` | HTTP registry | `WORKFLOW_REGISTRY_URL` + `WORKFLOW_REGISTRY_API_KEY` at line 605. |
| 7 (highest) | `project` | `<cwd>/workflows` | Always on unless `WORKFLOW_INCLUDE_PROJECT=false`. Path at line 439. |

**Additional sources loaded per-request in `createWorkflowReaderForRequest`** (`src/mcp/handlers/shared/request-workflow-reader.ts`):

When `workspacePath` or `resolvedRootUris` is present in the request, a new storage instance is constructed per-call that adds:

- **Rooted-sharing sources** (`custom` kind): discovered by walking remembered root directories for `.workrail/workflows/` subdirectories, up to depth 5. Walk is cached for 5 minutes. Skips: `.git`, `node_modules`, `build`, `dist`, `.claude`, `.claude-worktrees`, and 14 other dirs.
- **Managed sources** (`custom` kind): explicitly attached directories persisted in `~/.workrail/data/managed-sources/managed-sources.json` via `manage_workflow_source`. Loaded through `ManagedSourceStorePortV2`.

**Summary of all env vars** that affect which workflows load:

```
WORKFLOW_STORAGE_PATH         # colon-delimited custom directories (priority 4)
WORKFLOW_INCLUDE_BUNDLED      # bool, default true
WORKFLOW_INCLUDE_USER         # bool, default true
WORKFLOW_INCLUDE_PROJECT      # bool, default true
WORKFLOW_GIT_REPOS            # JSON array or comma-delimited URLs
WORKFLOW_GIT_REPO_URL         # single git repo URL
WORKFLOW_GIT_REPO_BRANCH      # branch for WORKFLOW_GIT_REPO_URL, default "main"
WORKFLOW_GIT_SYNC_INTERVAL    # minutes, default 60
WORKFLOW_GIT_AUTH_TOKEN       # fallback auth token for git
WORKFLOW_REGISTRY_URL         # HTTP registry base URL
WORKFLOW_REGISTRY_API_KEY     # API key for registry
WORKRAIL_CACHE_DIR            # override for git clone cache dir, default ~/.workrail/cache
```

All of these can also be set in `~/.workrail/config.json` (except `*_TOKEN` vars), which is merged with process.env at startup (`src/config/config-file.ts`, line 37-71). The `ALLOWED_CONFIG_FILE_KEYS` set at line 37 is the authoritative list of what the config file accepts.

---

## 2. Workflow Metadata Schema Fields

Source: `spec/workflow.schema.json`

Top-level fields relevant to discovery:

| Field | Type | Max length | Purpose |
|-------|------|-----------|---------|
| `id` | string (pattern) | 64 | Primary identifier. Used as discovery key everywhere. |
| `name` | string | 128 | Human-friendly title. Included in `list_workflows` response. |
| `description` | string | 512 | What the workflow accomplishes. Included in `list_workflows` response. |
| `version` | semver string | - | Included in `list_workflows` response. |
| `about` | string (markdown) | 4096 | Human-readable overview for the console UI. NOT currently included in `list_workflows` responses. |
| `examples` | string[] | 1-6 items, 10-120 chars each | "Short illustrative goal strings." IS included in `list_workflows` item when present (line 473-476 of `v2-workflow.ts`). |

**The critical gap:** `tags` is NOT a field in `workflow.schema.json`. Workflow-to-tag mapping lives entirely in `spec/workflow-tags.json`, which is a separate file bundled with the package. External/team workflows have no path to appear in this file.

**What IS indexed/queryable per-workflow:**
- `id`, `name`, `description`, `version` - always present in list items
- `examples` - included in list items when present in the workflow definition
- `visibility.category` - derived at runtime (bundled, personal, rooted_sharing, external, managed, legacy_project)

**What is NOT queryable:**
- `about` - loaded by the engine but absent from list_workflows output
- tags - workflow-tags.json only covers bundled workflows by ID; external workflow IDs are not in this file

---

## 3. list_workflows Response Shape Per Call Variant

Handler: `handleV2ListWorkflows` in `src/mcp/handlers/v2-workflow.ts` lines 175-324.

**Variant A: No arguments (no tags, no workspacePath, no includeSources)**

```json
{
  "workflows": [],
  "tagSummary": [
    { "id": "coding", "displayName": "...", "count": N, "when": [...], "examples": [...] },
    ...9 tags total...
  ],
  "_nextStep": "Pick a tag from tagSummary..."
}
```

- `workflows` is always `[]` (empty array) in this variant (line 255)
- `tagSummary` is built from `spec/workflow-tags.json` only
- **Tag counts come from the intersection of `workflow-tags.json` entries and the actually-loaded workflow IDs** (`buildTagSummary`, lines 86-103). If a bundled workflow is missing on disk, count drops. External workflow IDs that appear in loaded workflows but are absent from `workflow-tags.json` are NOT counted.
- `_nextStep` is present to guide the agent

**Variant B: With tags filter (e.g. tags=["coding"])**

```json
{
  "workflows": [
    {
      "workflowId": "...",
      "name": "...",
      "description": "...",
      "version": "...",
      "workflowHash": "...",
      "kind": "workflow",
      "visibility": { "category": "built_in", ... },
      "examples": [...],
      "staleness": { "level": "none", ... }
    },
    ...
  ]
}
```

- Only workflows whose IDs appear in `workflow-tags.json` for the requested tag are returned
- External/team workflows are never returned by a tags filter (they have no entry in `workflow-tags.json`)
- `tagSummary` and `_nextStep` are absent
- `staleRoots` is present if any remembered root path is missing on disk

**Variant C: With workspacePath only (no tags, no includeSources)**

- Same response as Variant A, but the underlying reader now includes rooted-sharing and managed sources
- The `tagSummary` still only reflects bundled workflow IDs from `workflow-tags.json`
- External workflows loaded from rooted/managed sources are counted in `loadAllWorkflows()`, but since they are absent from `workflow-tags.json` they never appear in `tagSummary.count` and are invisible when browsing by tag

**Variant D: includeSources=true (source catalog mode)**

```json
{
  "workflows": [...full list from all sources...],
  "sources": [
    { "sourceKey": "built_in", "category": "built_in", ... },
    { "sourceKey": "user:/path", "category": "personal", ... },
    { "sourceKey": "custom:/path", "category": "managed", ... },
    ...
  ]
}
```

- `tagSummary` is absent (line 259)
- `workflows` contains ALL workflows from all sources, not filtered
- `sources` catalog is present, showing per-source effective/shadowed/total counts
- **This is the only mode that returns external workflows**
- `staleRoots` is also present when managed source dirs are missing

---

## 4. manage_workflow_source Tool

Handler: `handleV2ManageWorkflowSource` in `src/mcp/handlers/v2-manage-workflow-source.ts`.

Input schema (`src/mcp/v2/tools.ts` line 184):

```typescript
V2ManageWorkflowSourceInput = z.object({
  action: z.enum(['attach', 'detach']),
  path: z.string()
})
```

**What it does:**
- `attach`: Persists a directory path to `~/.workrail/data/managed-sources/managed-sources.json` via `ManagedSourceStorePortV2.attach()`. Idempotent.
- `detach`: Removes the path from the same store. Idempotent.
- The store is keyed by path; `addedAtMs` is set on attach and never updated.

**How managed sources flow into discovery:**
1. `createWorkflowReaderForRequest` calls `listManagedSourceRecords` (line 400)
2. Paths present on disk are added to `customPaths` for `createEnhancedMultiSourceWorkflowStorage`
3. Missing paths are tracked as `staleManagedRecords` and surfaced in `staleRoots` + source catalog
4. Managed sources appear in the `sources` catalog with `category: "managed"` and their `addedAtMs`

**Relevance to the discovery gap:**
- `manage_workflow_source attach` is the only mechanism today for an agent/user to make an external directory persistently visible across all calls.
- However, workflows from managed sources still don't appear in tag-based browsing (`list_workflows` with tags filter) because they have no entries in `spec/workflow-tags.json`.
- They are only surfaced via `includeSources=true` (Variant D above).

---

## 5. CI Scripts and Registry/Discovery Metadata Generation

### validate-workflow-discovery.js (`scripts/validate-workflow-discovery.js`)

- CI script that validates bundled workflow discoverability via `workflowService.listWorkflowSummaries()` and `getWorkflowById()`
- Tests only the bundled `workflows/` directory contents against the DI-constructed service
- **Scope:** bundled workflows only. No external source awareness. Line 256: `const repoWorkflowsDir = path.resolve(__dirname, '..', 'workflows')`.
- Registered as npm script `validate:workflow-discovery` (package.json line 47)
- Uses `scripts/workflow-validation-variants.json` to test across feature flag permutations

### validate-workflows-registry.ts (`scripts/validate-workflows-registry.ts`)

- More comprehensive CI script: validates schema, structure, and compilation of all bundled workflows
- Calls `checkUntaggedWorkflows()` (line 364) which reads `spec/workflow-tags.json` and reports bundled workflows missing from the tags file
- **Scope:** `workflows/` directory only. Does not walk `~/.workrail/workflows/` or external sources.
- The `checkUntaggedWorkflows()` function at line 364 could be extended but currently hardcodes `path.join(repoRoot, 'workflows')` as the scan root

### generate-workflow-docs.js (`scripts/generate-workflow-docs.js`)

- Generates documentation from bundled workflows. Not directly relevant to runtime discovery.

### No tag generation or indexing step exists

- `spec/workflow-tags.json` is hand-authored and checked into the repo. There is no build step that generates it from workflow file contents.
- No script reads `tags` from individual workflow JSON files (because `tags` is not a field in `workflow.schema.json`).
- The tag-to-workflow mapping is entirely a static lookup table in `spec/workflow-tags.json`, keyed by hardcoded bundled workflow IDs.

---

## 6. Root Cause Summary of the Two Gaps

### Gap 1: External workflows invisible to tag-based browsing

The tag-based discovery path (`filterByTags` at line 108 in `v2-workflow.ts`) filters the compiled workflow ID list against the static `workflow-tags.json` lookup table. A workflow ID that is not in `workflow-tags.json` is simply dropped from any tagged result.

`workflow-tags.json` is:
- Bundled with the npm package at `spec/workflow-tags.json`
- Loaded once at module initialization (line 80: `const WORKFLOW_TAGS = readWorkflowTags()`)
- Read-only at runtime - no mechanism to extend it with entries from external sources

The `buildTagSummary` function (line 86) counts only workflows whose IDs appear in `workflow-tags.json` AND in the loaded ID set. External workflows satisfy neither condition.

### Gap 2: No "show me everything" mode

Three partial modes exist:
1. **No args**: returns `tagSummary` + `workflows: []` - zero actual workflows surfaced
2. **tags filter**: returns only bundled/tagged workflows matching the tag
3. **includeSources=true**: returns all workflows from all sources, no tag filtering

Mode 3 (`includeSources=true`) is the closest to "show me everything" but:
- Its primary purpose is showing the source catalog, not workflow browsing
- The `_nextStep` guidance hint is absent in this mode (line 268), so agents don't know to use it for browsing
- It bypasses tag-based UX entirely, dropping the `tagSummary` structure
- There is no "all workflows regardless of tag, with tagSummary" response variant

---

---

## 7. Final Summary for the Implementing Engineer

**Investigation path:** landscape_first - complete technical map of existing sources, metadata,
and filtering logic. All findings grounded in code reads with exact file:line references.

**What the investigation answered:**

1. All 7+ workflow source kinds enumerated with load order and env var names
2. The tag filtering mechanism traced completely: static `workflow-tags.json` loaded once at
   `v2-workflow.ts:80`; `filterByTags` at line 108 drops any ID absent from that file
3. All schema fields relevant to discovery documented; `tags` is absent from schema (key finding)
4. `manage_workflow_source` documented: persists to `~/.workrail/data/managed-sources/`,
   makes external dirs visible but doesn't solve the tag browsing gap
5. CI scripts documented: both scope to bundled workflows only; `checkUntaggedWorkflows` at
   `validate-workflows-registry.ts:364` is the natural extension point

**Candidate directions identified (not recommended, for implementing engineer):**

- Gap 1 fix: Add optional `tags: string[]` (closed enum of 9 values) to `workflow.schema.json`.
  Update `buildTagSummary` (v2-workflow.ts:86) to merge schema-declared tags with `workflow-tags.json`.
  Precedence: `workflow-tags.json` wins for `bundled` source; schema field wins for all others.

- Gap 2 fix (simplest): Include `tagSummary` in the `includeSources=true` response
  (currently excluded at v2-workflow.ts:259). No new parameter. ~10-line change.

- Gap 2 fix (cleaner): Add `includeAll: boolean` parameter to `V2ListWorkflowsInput`.
  Returns all workflows + tagSummary with a synthetic `custom` bucket for untagged external
  workflows (filtered to exclude `visibility.category === 'built_in'`).

**RED finding that must be addressed before shipping any Gap 1 fix:**
`buildTagSummary` at `v2-workflow.ts:86` currently counts from `workflow-tags.json` only.
If `filterByTags` is updated to also include schema-tagged workflows, the count in the first
call will understate the result count of the second call. `buildTagSummary` must be updated
to count from both sources simultaneously.

**Strongest alternative (Candidate B):** Per-source `.workrail/workflow-tags.json` overlay files.
Zero schema change, zero per-workflow migration. Better fit if external teams can't be expected
to edit individual workflow JSON files. Runner-up because it introduces a new file convention
and the merge logic is more complex.

**Confidence:** High for investigation findings. Medium for candidate directions (not prototyped).

---

## Key File Locations

| File | Purpose |
|------|---------|
| `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts` | All source loading, env var parsing |
| `src/mcp/handlers/v2-workflow.ts` | `handleV2ListWorkflows`, tag filtering, tagSummary building |
| `src/mcp/handlers/shared/request-workflow-reader.ts` | Per-request reader: rooted discovery, managed sources, walk logic |
| `src/mcp/handlers/v2-manage-workflow-source.ts` | `manage_workflow_source` attach/detach handler |
| `src/v2/ports/managed-source-store.port.ts` | Managed source store interface |
| `spec/workflow-tags.json` | Static tag-to-workflow mapping (bundled only) |
| `spec/workflow.schema.json` | Workflow metadata schema (`about`, `examples` present; `tags` absent) |
| `src/config/config-file.ts` | `~/.workrail/config.json` allowed keys, template |
| `scripts/validate-workflow-discovery.js` | CI: bundled workflow discoverability validation |
| `scripts/validate-workflows-registry.ts` | CI: full validation + untagged workflow check |

---

## Precise Line References for the Discovery Gap

- Tag filtering entry point: `v2-workflow.ts:108` (`filterByTags`)
- Tag summary building: `v2-workflow.ts:86` (`buildTagSummary`)
- Tags file loaded at module init: `v2-workflow.ts:80` (`const WORKFLOW_TAGS = readWorkflowTags()`)
- Tags file read function: `v2-workflow.ts:70` (`readWorkflowTags`)
- Tags file path: `v2-workflow.ts:73` (`spec/workflow-tags.json`)
- "No tags = empty workflows" rule: `v2-workflow.ts:255` (`return []`)
- "includeSources = full list" bypass: `v2-workflow.ts:249` (`if (input.includeSources) return sortedCompiled`)
- External workflows added per-request: `request-workflow-reader.ts:366` (`createEnhancedMultiSourceWorkflowStorage`)
- `workflow-tags.json` untagged check in CI: `validate-workflows-registry.ts:364` (`checkUntaggedWorkflows`)
