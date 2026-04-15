# Design Review Findings: Trigger Webhook Server (src/trigger/)

## Tradeoff Review

| Tradeoff | Assessment | What would make it unacceptable |
|---|---|---|
| Async 202 + stdout logging | Acceptable -- spec requires it | Delivery system needed (post-MVP) |
| Narrow YAML parser | Acceptable -- format is owned by WorkRail | User needs anchors or multi-line values |
| Dot-path contextMapping only | Acceptable -- spec says no full JSONPath for MVP | User needs array indexing |
| Env-only secret resolution | Acceptable -- common for daemon deployments | Container file-based secret injection needed |
| No delivery retries | Acceptable for MVP | Unreliable webhook providers in production |

## Failure Mode Review

| Failure Mode | Design Coverage | Gap |
|---|---|---|
| Missing `$SECRET_NAME` env var | Caught at startup, returns Err | None |
| Wrong HMAC secret | timingSafeEqual + length check, returns 400 | None |
| `triggers.yml` parse error | Returns Err, listener refuses to start | Quoted strings with colons need special handling |
| `runWorkflow()` error | Logged to stdout, dropped | No retry, no delivery notification |
| Express port conflict (EADDRINUSE) | Not currently in design | **GAP: must add server.on('error') handler** |
| `triggers.yml` file not found | Not currently in design | **GAP: must treat as no-op (warn + return null)** |

## Runner-Up / Simpler Alternative Review

- **Runner-up (js-yaml)**: No elements worth borrowing for MVP. Upgrade path is a one-file
  change in `trigger-store.ts` when needed.
- **Simpler (single-file)**: Rejected -- three-layer separation is worth the file count for
  testability of HMAC and contextMapping logic.
- **Simpler (skip contextMapping)**: Rejected -- spec includes it; 30 lines is low cost.
- **Hybrid (JSON-as-YAML)**: Rejected -- worse than both options.

## Philosophy Alignment

- **Errors are data**: Satisfied. All fallible functions return `Result`.
- **Immutability**: Satisfied. All exported interfaces are `readonly`.
- **Explicit domain types**: Satisfied. `TriggerId` branded string.
- **Validate at boundaries**: Satisfied. YAML parsed and secrets resolved at startup; router
  trusts resolved `TriggerDefinition`.
- **YAGNI**: Satisfied. No speculative abstractions. Clear seams for post-MVP features.
- **Tension (async 202 vs errors-as-data)**: Accepted. Required by spec.

## Findings

### Red (blocking -- must fix before implementation)
None.

### Orange (should fix -- implementation risk without mitigation)

**O1: Express EADDRINUSE not handled**
Without a `server.on('error')` handler, a port conflict causes an unhandled Node.js error
that crashes the process without a clear message. Fix: wrap `server.listen()` in a promise that
rejects on error; `startTriggerListener()` returns `Err` on EADDRINUSE.

**O2: YAML parser doesn't handle quoted string values**
A `goal` value containing a colon (e.g., `goal: "Review: MR #123"`) breaks a naive key-value
split. Fix: in the YAML parser, detect leading `"` and strip quotes before returning the value.
Also handle `'` single-quote quoting.

**O3: `triggers.yml` file-not-found not handled**
If the file doesn't exist, `fs.readFile()` throws. This should be a `null` return (trigger
listener starts but does nothing), not a crash. Fix: catch ENOENT explicitly in
`startTriggerListener()` and return a started-but-empty listener.

### Yellow (worth noting -- low risk, no blocking action required)

**Y1: Async `runWorkflow()` errors are silent to webhook callers**
A broken `workflowId` or missing API key produces a 202 response and a stdout log entry.
Operators must watch logs. This is spec-compliant and documented; no fix required for MVP.

**Y2: `contextMapping` dot-path array indexing not supported**
A path like `$.labels[0]` silently returns `undefined`. Should produce a warning log entry.
Fix: detect `[` in path segments and log a clear "array indexing not supported" warning.

## Recommended Revisions

1. **Add EADDRINUSE handler** to `trigger-listener.ts` `startTriggerListener()`.
2. **Handle quoted string values** in the narrow YAML parser.
3. **Handle ENOENT** for `triggers.yml` in `startTriggerListener()`.
4. **Log warning on array path segments** in `applyContextMapping()`.

## Residual Concerns

- The hand-rolled YAML parser is the most likely source of post-MVP maintenance. Clear
  upgrade path: replace with `js-yaml` when a user hits an unsupported format. Parser is
  isolated in `trigger-store.ts` with a clean `Result`-returning API, so the swap is trivial.
- No delivery system means operator visibility depends entirely on stdout log quality. Log
  lines should include `triggerId`, `workflowId`, and error details for queryability.
