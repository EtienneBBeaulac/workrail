# Design Candidates: TriggerPlugin Interface for WorkRail Auto Daemon

*Generated as part of wr.discovery workflow -- OpenClaw deep dive.*
*This is raw investigative material for main agent review, not a final decision.*
*Date: 2026-04-14*

---

## Problem Understanding

### Core tensions
1. **YAGNI vs. clear seams** -- With 3 integrations, any interface is somewhat speculative. But retrofitting DI boundaries and Result types at integration 4 costs more than defining them now.
2. **Type safety vs. simplicity** -- No interface = convention drift discovered at runtime. TypeScript interface eliminates this at ~150 LOC cost.
3. **DI injection vs. direct construction** -- WorkRail uses inversify DI (DI.Infra.* tokens). Credentials resolved outside DI break testability and the port/adapter invariant.
4. **Immutability vs. heartbeat mutation** -- DaemonRegistry needs lastActivityAt updates. Resolved: register()/unregister() are the only mutation surface; snapshot() returns readonly view.

### Likely seam
The TriggerPlugin interface boundary -- exactly where OpenClaw's ChannelPlugin boundary lives. Daemon core calls plugin methods; each integration implements the interface.

### What makes it hard
Balancing three integration types with different inbound mechanisms (HTTP webhooks for GitLab/Jira, timer for cron) under one interface without over-generalizing. Discriminated union TriggerInboundAdapter (kind: 'webhook' | 'schedule') handles this correctly.

---

## Philosophy Constraints

From /Users/etienneb/CLAUDE.md and WorkRail codebase (neverthrow usage confirmed in session-lock):
- **YAGNI with discipline** -- no dynamic loader; DO define the interface type
- **Type safety as first line of defense** -- typed interface required
- **Errors are data** -- ResultAsync<T,E> from neverthrow; never throw for domain errors
- **DI for boundaries** -- CredentialPort must be injected
- **Immutability** -- DaemonRegistry snapshot() returns readonly view

---

## Impact Surface

- src/di/tokens.ts -- new DI tokens: DI.Infra.DaemonRegistry, DI.Infra.TriggerRegistry
- src/v2/ports/ -- new: credential.port.ts, trigger.port.ts
- src/daemon/ -- new directory for implementations
- src/v2/infra/local/session-lock/index.ts -- workerId='daemon' at construction

---

## Candidates

### Candidate A: Named exports per module (no interface)

**Summary:** Each integration exports 5 named functions. No TypeScript interface.

**Shape:** export function resolveCredentials(), registerWebhookHandler(), postResult(), validate() per integration module.

**Scope:** Too narrow. Violates "type safety as first line of defense" (disqualifying). Convention drift failure at integration 3. No DI boundaries.

---

### Candidate B: TriggerPlugin interface + static array + DI CredentialPort (RECOMMENDED)

**Summary:** TypeScript interface TriggerPlugin<TConfig, TCredentials> with discriminated-union adapter slots; static const TRIGGER_PLUGINS array; CredentialPort injected via DI.

**Shape:**
```typescript
export type TriggerId = 'gitlab' | 'jira' | 'cron' | 'slack';

export type TriggerInboundAdapter =
  | { kind: 'webhook'; registerHandler(app: Express, cb: TriggerCallback): void }
  | { kind: 'schedule'; expression: string; onFire(cb: TriggerCallback): NodeJS.Timeout };

export interface TriggerPlugin<TConfig = unknown, TCredentials = unknown> {
  readonly id: TriggerId;
  readonly meta: Readonly<{ label: string; docsPath: string }>;
  validate(config: TConfig): Result<void, ConfigError>;
  resolveCredentials(config: TConfig, credentialPort: CredentialPort): ResultAsync<TCredentials, CredentialError>;
  inbound?: TriggerInboundAdapter;
  outbound?: { postResult(ctx: DeliveryContext, result: WorkflowResult): ResultAsync<void, DeliveryError> };
}

export const TRIGGER_PLUGINS = [gitlabPlugin, jiraPlugin, cronPlugin] as const;
```

**Tensions resolved:** YAGNI (no dynamic loader), type safety (interface), DI (CredentialPort injected), errors as data (ResultAsync), immutability (const).
**Tensions accepted:** ~150 LOC upfront.
**Failure mode:** Interface grows > 8 methods. Monitor at integration 4.
**Repo-pattern relationship:** FOLLOWS WorkRail's port/adapter pattern. Adapts OpenClaw's ChannelPlugin to WorkRail's DI model.
**Scope:** Best-fit.
**Philosophy:** Honors all relevant principles. No conflicts.

---

### Candidate C: Full OpenClaw dynamic plugin system

**Summary:** jiti loader + PLUGIN.md metadata + runtime discovery from ~/.workrail/plugins/.

**Scope:** Too broad. 600 LOC security-critical code. Zero evidence of third-party plugin authors. Violates YAGNI.

---

### Candidate D: TRIGGER_MAP function map

**Summary:** const TRIGGER_MAP: Record<TriggerId, TriggerHandler> -- plain async function per integration.

**Scope:** Too narrow. No DI, no ResultAsync, no testability isolation. Same failure mode as A.

---

## Comparison and Recommendation

| | A | B | C | D |
|---|---|---|---|---|
| YAGNI | Best | Good | Worst | Best |
| Compile-time enforcement | None | Full | Full | Partial |
| DI boundaries | None | Full | Full | None |
| Errors as data | Optional | Built-in | Built-in | Optional |
| Build cost | ~0 LOC | ~150 LOC | ~600 LOC | ~50 LOC |
| Philosophy violations | Yes (critical) | None | YAGNI | Yes |

**RECOMMENDATION: Candidate B.** Follows WorkRail's port/adapter pattern, honors all relevant philosophy principles, costs ~150 LOC of interface definitions (not implementations), provides compile-time enforcement and DI boundaries for the credential model.

---

## Self-Critique

**Strongest counter-argument:** "Start with D, promote to B at integration 4." Real counter: promotion cost (retrofitting DI + ResultAsync across existing integrations) is worse than starting with B.

**Pivot to D if:** Solo developer, integration 4 is > 12 months away, no other contributors.
**Justify C when:** 10+ integrations, external contributors requesting plugin system.
**Assumption that invalidates B:** If inversify DI initialization proves too slow for daemon startup. Fallback: explicit constructor parameter injection instead of DI container.

---

## Open Questions for Main Agent

1. Is the inversify DI container available in the daemon entry point before MCP server starts?
2. Should TriggerId be a closed enum (4 built-in) or open string union (extensible)?
3. Should outbound.postResult handle progress updates or only final results?
4. Should DaemonRegistry be a DI.Infra.* service or a module-level export?
