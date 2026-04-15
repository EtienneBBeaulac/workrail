# Design Candidates: Trigger Webhook Server (src/trigger/)

## Problem Understanding

**Core tensions:**

1. **Async fire-and-forget vs error surfacing**: The HTTP listener must return 202 immediately
   (webhook providers retry if they don't get a 2xx within ~10s), but `runWorkflow()` is
   long-running (minutes to hours). Any workflow error can only be logged to stdout for MVP
   -- there is no delivery system yet. The tension: by firing async, we give up synchronous
   error reporting. Accepted as MVP limitation; `TriggerSource` is designed to carry delivery
   context for a future result-posting system.

2. **YAML parsing without a library vs correctness**: No YAML parser is in the project's
   runtime dependencies. The `triggers.yml` format is under WorkRail's control (fixed schema,
   documented format). Three options: hand-rolled narrow parser (no dep, fragile for exotic
   syntax), add `js-yaml` (full correctness, new dep), or use JSON config (departs from spec).

3. **In-process V2ToolContext reuse**: `runWorkflow()` requires a `V2ToolContext` from the
   shared DI container. Building it requires `bootstrap()` + `createToolContext()`, which is
   idempotent after first call. The trigger module must receive a pre-initialized context from
   the caller rather than self-initializing, so that tests don't pay DI startup cost and
   same-process runs share the container.

4. **Generic-only vs extensible provider model**: MVP ships generic only (any HTTP POST is a
   trigger). But the architecture must be extensible (post-MVP: GitLab, GitHub, Jira with
   provider-specific HMAC schemes). Provider dispatch is behind a string `provider` field --
   unknown values must fail fast at startup, not silently at webhook time.

**Likely seam:** `src/trigger/` is a new directory -- purely additive. No existing file is
modified. The real coupling point is `runWorkflow()` in `src/daemon/workflow-runner.ts`
(the thing the trigger calls) and `createToolContext()` in `src/mcp/server.ts` (how V2ToolContext
is built). Both are imported, not modified.

**What makes this hard:**

- YAML parsing for a structured format without a library. The format uses indented lists and
  optional nested keys -- line-by-line is insufficient; a proper indentation-tracking parser is
  needed for the `contextMapping` sub-object.
- HMAC timing-safe comparison with Node.js `crypto.timingSafeEqual` requires equal-length
  buffers. A length check must short-circuit before the call (different lengths == not equal,
  safe to short-circuit because length itself is not secret for a constant-length digest).
- Feature flag must gate the entire module at startup. If `WORKRAIL_TRIGGERS_ENABLED` is not set,
  `startTriggerListener()` should return `null` without starting Express, without logging
  misleading startup messages, and without requiring a `triggers.yml` file.

## Philosophy Constraints

From CLAUDE.md:
- **Errors are data**: `loadTriggerConfig()` returns `Result<TriggerConfig, TriggerStoreError>`.
  `startTriggerListener()` returns `null` (not enabled) or `{ port, stop }` (running). Never throws
  for expected failures.
- **Immutability by default**: All exported interfaces use `readonly` fields.
- **Explicit domain types**: `TriggerId` branded string (`string & { readonly _brand: 'TriggerId' }`).
- **Validate at boundaries**: YAML parsed and env vars resolved at listener startup; router trusts
  the resolved `TriggerDefinition`.
- **YAGNI with discipline**: No SQLite persistence, no cron provider, no full JSONPath, no delivery
  retries in MVP.

**No philosophy conflicts**: The daemon module already uses custom discriminated unions (not neverthrow).
The trigger module follows the same pattern.

## Impact Surface

- `src/daemon/workflow-runner.ts`: imports `runWorkflow()` and `WorkflowTrigger` -- no changes needed.
- `src/mcp/server.ts`: imports `createToolContext()` -- no changes needed.
- `src/v2/infra/in-memory/keyed-async-queue/index.ts`: imports `KeyedAsyncQueue` -- no changes needed.
- No existing files are modified.

## Candidates

### Candidate A: Hand-rolled narrow YAML + injected V2ToolContext (SELECTED)

**Summary**: A minimal indentation-tracking YAML parser that handles exactly the documented
`triggers.yml` format; `V2ToolContext` is injected into `startTriggerListener()` by the caller.

**Tensions resolved**:
- Dep constraint: no new runtime dep.
- In-process context: injected by caller, not self-initialized.

**Tensions accepted**:
- YAML fragility: users writing YAML outside the documented format get a parse error.

**Boundary**: `trigger-store.ts` owns YAML parse + secret resolution (returns `Result`).
`trigger-router.ts` is a pure dispatcher (trusts resolved `TriggerDefinition`).
`trigger-listener.ts` is the Express wrapper (no business logic).

**Failure mode**: User writes `triggers.yml` with YAML anchors (`&ref`, `*ref`) or inline
arrays (`[a, b]`) and gets an unhelpful parse error. The error message should say
"unsupported YAML syntax" with a pointer to the documented format.

**Repo-pattern relationship**: Follows lean-dep pattern. Follows daemon's discriminated union
error style. Adapts `server.ts`'s `createToolContext()` call.

**Gains**: Zero new deps. Fully testable without DI. Narrow scope.
**Gives up**: YAML format flexibility.

**Scope judgment**: Best-fit. Implements exactly what the spec describes.

**Philosophy fit**: Honors YAGNI, errors-as-data, validate-at-boundaries. No conflicts.

---

### Candidate B: JSON config (`.triggers.json` instead of `triggers.yml`)

**Summary**: Accept `triggers.json` instead of `triggers.yml`, using `JSON.parse()`. Eliminates
the YAML parsing problem entirely.

**Tensions resolved**: YAML complexity eliminated.
**Tensions accepted**: Spec says `.yml`. Departs from stated spec.

**Failure mode**: Users following the documented `triggers.yml` format are confused about the
actual file extension.

**Repo-pattern relationship**: Follows the project's heavy JSON use (workflow files are JSON).
Departs from the spec.

**Scope judgment**: Too narrow -- doesn't honor the spec's intent.

**Philosophy fit**: Honors YAGNI but conflicts with stated spec.

**Verdict**: Rejected.

---

### Candidate C: Add `js-yaml` as runtime dep

**Summary**: `npm install js-yaml @types/js-yaml`. Full YAML support, handles any valid YAML.

**Tensions resolved**: YAML fragility eliminated.
**Tensions accepted**: New runtime dep.

**Failure mode**: Adds a dep to a module the project keeps lean. `js-yaml` is 70kB and
well-maintained but adds a permanent maintenance surface.

**Repo-pattern relationship**: Departs from lean-dep pattern (15 runtime deps, all unavoidable
infrastructure). `js-yaml` is avoidable for the documented format.

**Scope judgment**: Too broad for MVP. Can be added later when users hit the format limits.

**Philosophy fit**: Conflicts with YAGNI. However, it is the correct long-term answer if
`triggers.yml` ever supports complex YAML.

**Verdict**: Rejected for MVP. Upgrade path: replace the narrow parser with `js-yaml` when a
user files a bug for an unsupported YAML feature.

## Comparison and Recommendation

| Dimension | A: Narrow YAML | B: JSON config | C: js-yaml |
|---|---|---|---|
| Spec adherence | Full | Departs | Full |
| New runtime dep | None | None | js-yaml |
| YAML correctness | Narrow format only | N/A | Full |
| Testability | High | High | High |
| Reversibility | Easy (replace parser) | Hard (migrate users) | N/A |
| YAGNI | Yes | Yes (over-applied) | No |
| Repo pattern | Follows | Follows JSON | Departs |

**Recommendation: Candidate A.**

The format is under WorkRail's control. The documented `triggers.yml` format is simple and
closed. A narrow parser that handles exactly that format and rejects anything else with a clear
error is correct for MVP. The upgrade path to `js-yaml` is a one-file change when needed.

## Self-Critique

**Strongest counter-argument**: js-yaml eliminates a class of user confusion at the cost of one
well-maintained library. If a user copies a YAML snippet from a GitLab docs page and it uses an
anchor, the narrow parser will fail in a confusing way.

**Narrower option**: Candidate B (JSON) -- rejected because it doesn't honor the spec.

**Broader option**: Candidate C (js-yaml) -- justified if users commonly write complex YAML configs.
No evidence of this yet.

**Assumption that invalidates this design**: If the project later adopts `js-yaml` for other config
files. In that case the narrow parser becomes dead code. Mitigation: the narrow parser is isolated
in `trigger-store.ts` and replaceable without API changes.

## Open Questions for the Main Agent

- None. Design is fully specified by the backlog and design doc. The narrow YAML parser is the
  right call for MVP. The upgrade path is clear.
