# Implementation Plan: Trigger Webhook Server (src/trigger/)

## Problem Statement

WorkRail Auto needs a way to start workflow sessions in response to external events (webhook
HTTP POST requests) without human intervention. This is Step 4 of the WorkRail Auto MVP.
The trigger server listens on port 3200, validates incoming webhooks, and dispatches them
to `runWorkflow()` via a `KeyedAsyncQueue` to avoid webhook delivery timeouts.

## Acceptance Criteria

1. `POST /webhook/:triggerId` returns 202 immediately for valid requests; 400/401/404/500 for invalid.
2. `GET /health` returns 200 with `{ status: "ok" }`.
3. HMAC validation uses `crypto.timingSafeEqual` (timing-safe); if `hmacSecret` is configured and
   signature is wrong or missing, return 401.
4. `contextMapping` dot-path extraction maps payload fields to workflow context variables.
5. `runWorkflow()` is called asynchronously (fire-and-forget); result logged to stdout.
6. Feature flag `WORKRAIL_TRIGGERS_ENABLED=true` gates all activation. When unset,
   `startTriggerListener()` returns `null` without starting Express.
7. `triggers.yml` not found: logs warning, starts listener with 0 triggers (no error).
8. Missing `$SECRET_NAME` env var: `startTriggerListener()` returns `Err` with descriptive message.
9. Port conflict (EADDRINUSE): `startTriggerListener()` returns `Err` with descriptive message.
10. `triggers.yml` parse error: `startTriggerListener()` returns `Err` with line/field details.
11. Port defaults to 3200; overridable via `WORKRAIL_TRIGGER_PORT` env var.

## Non-Goals (MVP)

- No SQLite persistence for triggers (YAML file only)
- No auto-registration of webhooks at providers (manual only)
- No cron provider
- No GitLab/GitHub/Jira-specific HMAC schemes (generic HMAC-SHA256 only)
- No full JSONPath (dot-path extraction only, no array indexing)
- No delivery retries or dead letter queue
- No delivery notification back to trigger source
- No MCP tools for trigger CRUD (create_trigger, list_triggers, delete_trigger)

## Philosophy Constraints

- **Errors are data**: All fallible functions return `Result<T, E>`. No throws for expected failures.
- **Immutability**: All exported interfaces use `readonly` fields.
- **Explicit domain types**: `TriggerId` branded string.
- **Validate at boundaries**: YAML parsed + secrets resolved at startup; router trusts `TriggerDefinition`.
- **YAGNI**: No speculative abstractions. Clear seams for post-MVP features.

## Invariants

1. HMAC comparison MUST use `crypto.timingSafeEqual` (never string equality).
2. A length difference short-circuits before `timingSafeEqual` (different lengths = not equal).
3. The `KeyedAsyncQueue` key is `triggerId` (not sessionId) -- serializes concurrent webhooks
   for the same trigger, prevents concurrent runWorkflow() calls for the same trigger.
4. `runWorkflow()` is called AFTER the 202 response is sent (async, not awaited in route handler).
5. `$SECRET_NAME` refs are resolved from `process.env` only (no file/exec for MVP).
6. Feature flag check is the FIRST operation in `startTriggerListener()`.
7. The Express server runs on a SEPARATE port from the MCP server (3200 vs 3100).

## Selected Approach

**Candidate A: Hand-rolled narrow YAML parser + injected V2ToolContext**

Four files under `src/trigger/`:
- `types.ts` -- domain types
- `trigger-store.ts` -- YAML parse + secret resolution
- `trigger-listener.ts` -- Express server (routes only, no business logic)
- `trigger-router.ts` -- HMAC + contextMapping + async dispatch
- `index.ts` -- public API

Rationale:
- Zero new runtime deps (format is under WorkRail's control)
- V2ToolContext injected by caller (testable without DI)
- Three-layer separation matches existing daemon architecture

Runner-up: Candidate C (js-yaml) -- correct long-term answer when users need complex YAML.
Upgrade path: replace narrow parser in `trigger-store.ts` with `js-yaml` (one-file change,
no API changes).

## Vertical Slices

### Slice 1: Types and trigger store (types.ts + trigger-store.ts)
**Scope**: Domain types and YAML loading.
**Files**: `src/trigger/types.ts`, `src/trigger/trigger-store.ts`
**Done when**: `loadTriggerConfig(yaml, env)` returns correct `TriggerConfig` for valid YAML;
returns typed errors for missing secrets, parse errors, unknown providers.
**Tests**: `tests/unit/trigger-store.test.ts` -- YAML parse (happy path, quoted values,
missing fields, unknown provider, $SECRET_NAME resolution, missing env var).

### Slice 2: Express listener (trigger-listener.ts)
**Scope**: Express app with routes. No business logic -- delegates to TriggerRouter.
**Files**: `src/trigger/trigger-listener.ts`
**Done when**: `createTriggerApp(router)` returns an Express app with POST /webhook/:triggerId
and GET /health routes. `startTriggerListener(ctx, opts)` starts the server, handles EADDRINUSE
and ENOENT for triggers.yml, returns `{ port, stop }` or `Err`.
**Tests**: In-process HTTP tests (supertest pattern) for 202/400/401/404/200 responses.

### Slice 3: Router (trigger-router.ts)
**Scope**: HMAC validation, contextMapping, async dispatch.
**Files**: `src/trigger/trigger-router.ts`
**Done when**: `TriggerRouter.route(triggerId, rawBody, signature)` validates HMAC,
applies contextMapping, enqueues `runWorkflow()` via `KeyedAsyncQueue`.
**Tests**: `tests/unit/trigger-router.test.ts` -- HMAC valid/invalid, contextMapping happy path,
contextMapping missing key, array path warning, feature flag gate.

### Slice 4: Public API and integration
**Scope**: `src/trigger/index.ts` and wiring.
**Files**: `src/trigger/index.ts`
**Done when**: `startTriggerListener(ctx, opts)` is exported and usable from an entry point.
Feature flag check works correctly.
**Tests**: Covered by Slice 2 tests.

## Test Design

### trigger-store.test.ts (unit)
- Parse minimal valid triggers.yml with one trigger
- Parse trigger with contextMapping
- Parse trigger without hmacSecret (allowed)
- Reject trigger with missing required field (workflowId)
- Reject trigger with unknown provider
- Resolve `$SECRET_NAME` from env
- Reject trigger with `$SECRET_NAME` not in env
- Parse trigger with quoted string value containing colon
- Return empty config for empty YAML

### trigger-router.test.ts (unit)
- Route to trigger with valid HMAC: enqueues runWorkflow()
- Reject unknown triggerId: returns `Err('not_found')`
- Reject bad HMAC: returns `Err('hmac_invalid')`
- Accept no-HMAC trigger (hmacSecret not configured): routes successfully
- Apply contextMapping: sets workflow context from payload dot-paths
- Missing contextMapping key: logs warning, uses undefined for that key
- Array path segment: logs warning, returns undefined
- runWorkflow() called with correct workflowId, goal, workspacePath, context

### Fake runWorkflow for tests
Tests inject a `RunWorkflowFn` stub instead of the real `runWorkflow()`.
This avoids DI bootstrapping in unit tests.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Narrow YAML parser fails on valid-but-exotic YAML | Low (format is controlled) | Medium (confusing error) | Quoted string handling + clear error messages |
| `runWorkflow()` errors silent to callers | High (by design) | Low (MVP) | Stdout log with triggerId + workflowId + error detail |
| Port conflict in development (3200 in use) | Medium | Low | EADDRINUSE handler + clear error message |
| HMAC timing attack via length check | Low (length is public) | Low | Length check is safe: digest length is not secret |

## PR Packaging Strategy

**Single PR**: `feat/trigger-webhook-server` branch. All 5 source files + 2 test files in one commit.
No existing files are modified. Zero risk of regression to existing functionality.

## Philosophy Alignment

| Principle | Status | Evidence |
|---|---|---|
| Errors are data | Satisfied | `loadTriggerConfig()` and `startTriggerListener()` return `Result` |
| Immutability by default | Satisfied | All exported interfaces use `readonly` fields |
| Explicit domain types | Satisfied | `TriggerId` branded string |
| Make illegal states unrepresentable | Satisfied | `TriggerDefinition` with optional `hmacSecret`; presence = validate, absence = open |
| Validate at boundaries | Satisfied | YAML parsed and secrets resolved at startup |
| Errors are data (async tension) | Accepted tension | Spec requires 202 immediately; error is logged to stdout |
| YAGNI with discipline | Satisfied | No speculative abstractions; clear seams for post-MVP |
| Compose with small pure functions | Satisfied | `parseTriggerYaml`, `resolveSecrets`, `applyContextMapping`, `validateHmac` |
