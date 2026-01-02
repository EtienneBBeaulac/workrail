# WorkRail v2 Isolation Plan — Design

**Status:** Design  
**Date:** 2025-12-31  
**Scope:** v2 manual/agentic test isolation under real MCP constraints

## Purpose

Make manual and agentic **v2** testing trustworthy in real MCP environments.

This document defines an isolation contract that is actually achievable when:
- the MCP server is a **single long-lived process** serving multiple chats
- the server **cannot** observe chat identity
- the operator cannot reliably restart the server or inject per-chat env vars

This is **v2-only**. v1 session/dashboard/workflow-storage isolation is out of scope.

## Problem statement

### Current state (what makes v2 testing hard)

1) **MCP reality: no per-chat durable isolation knob**
   - In a single long-lived MCP server process, `process.env` and filesystem roots are process-scoped.
   - WorkRail does not receive a stable “chat id” from the MCP platform.
   - Therefore, “fresh data dir per chat” is not reliably enforceable for agentic testing.

2) **Agentic testing needs two layers of isolation**
   - **New chat** (no conversational memory bleed)
   - **Fresh v2 session boundary** (no token/session reuse bleed)

### Why this matters (not just "convenience")
- **Determinism:** v2 semantics (rehydrate purity, idempotent replay, rewind-as-fork) must be tested without accidental cross-run coupling.
- **Agent-executable repeatability:** the isolation contract must be something an agent can follow without relying on hidden operator steps.

## Isolation model (closed set)

1) **Chat memory isolation** (required)
   - Each scenario runs in a brand new chat.

2) **v2 session isolation** (required)
   - Each scenario starts a **new v2 session** (via `start_workflow`).
   - Tokens are scenario-scoped secrets: **never reuse tokens across chats**.

3) **Process/storage isolation** (optional; best-effort)
   - When the operator can restart or the environment supports it, run scenarios with a fresh durable root (e.g. `WORKRAIL_DATA_DIR` per run) or a process namespace.
   - This is useful for CI and multi-process test harnesses, but is not required for slice 1–3 manual validation.

## Goals (what success looks like)

1) **Reliable v2 scenario isolation without per-chat env injection**
   - New chat per scenario + new v2 session per scenario + no token reuse.

2) **Optional process-level isolation for CI/multi-process**
   - When `WORKRAIL_NAMESPACE` (or a fresh `WORKRAIL_DATA_DIR`) is provided at process start, all v2 durable state is scoped under that root.
   - Namespace is process-start config; no runtime switching.

## Non-goals (explicit boundaries)

- **Not v1 isolation:** v1 sessions/dashboard/workflow cache are out of scope for this doc.
- **Not automatic per-chat durable store isolation:** without a chat identity signal from MCP, WorkRail cannot safely infer chat boundaries.
- **Not token namespace binding:** v2 token payload/signature shape is unchanged; isolation is achieved via session IDs and storage layout.
- **Not runtime namespace switching:** any process-level namespace is fixed at startup.

## Architecture overview

This design treats isolation as a **closed set of boundaries** (see "Isolation model" above). In real MCP environments with a single long-lived server process, the only always-available isolation boundary is **v2 session identity**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WorkRail v2 Isolation (Real MCP)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  One long-lived MCP server process (no per-chat identity signal)            │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ WorkRail MCP Server Process                                          │   │
│  │  • v2 tools: list_workflows / inspect_workflow / start_workflow /     │   │
│  │    continue_workflow                                                 │   │
│  │  • Data root (process-scoped):                                        │   │
│  │     - default: ~/.workrail/data                                       │   │
│  │     - optional: WORKRAIL_DATA_DIR=/path                               │   │
│  └───────────────────────────┬─────────────────────────────────────────┘   │
│                              │ creates durable v2 sessions                   │
│                              ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Durable v2 store (process-scoped root)                               │   │
│  │  data/sessions/<sessionId>/...                                       │   │
│  │  data/snapshots/...                                                  │   │
│  │  data/workflows/pinned/...                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Chat isolation requirement: each scenario starts a NEW session via          │
│  start_workflow and never reuses tokens across chats.                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Token boundary (v2, unchanged):
- Tokens are opaque signed refs that include sessionId/runId/nodeId/etc.
- Isolation between scenarios is achieved by starting a new session and not
  reusing tokens across chats.
```

### Core abstractions (v2-first)

**Session boundary** (required): each scenario is isolated by a fresh `sessionId` created by `start_workflow`.

**Process/storage boundary** (optional): a process-scoped data root (default `~/.workrail/data`, optional `WORKRAIL_DATA_DIR`) can be used for CI or multi-process isolation, but is not required for manual slice 1–3 validation.

## Appendix — Historical namespace design (deprecated)

The sections below describe an earlier namespace-centric isolation design. They are retained for reference, but are not required for v2 slice 1–3 manual/agentic testing in a single long-lived MCP server.

## Type definitions

### Phantom types (compile-time scope enforcement)

```typescript
// Phantom symbols (unique, not exported)
declare const APPLICATION_SCOPED: unique symbol;
declare const NAMESPACE_SCOPED: unique symbol;

// Scope markers (phantom types - no runtime overhead)
export type ApplicationScoped<T> = T & { readonly [APPLICATION_SCOPED]: true };
export type NamespaceScoped<T> = T & { readonly [NAMESPACE_SCOPED]: true };

// Scoped tokens (compile-time enforcement)
export type ApplicationScopedToken<T> = symbol & { 
  __scope: 'application'; 
  __type: ApplicationScoped<T>;
};

export type NamespaceScopedToken<T> = symbol & { 
  __scope: 'namespace'; 
  __type: NamespaceScoped<T>;
};

// Helper to create scoped tokens
export function createApplicationToken<T>(description: string): ApplicationScopedToken<T> {
  return Symbol(description) as ApplicationScopedToken<T>;
}

export function createNamespaceToken<T>(description: string): NamespaceScopedToken<T> {
  return Symbol(description) as NamespaceScopedToken<T>;
}
```

### Branded primitives

```typescript
// Path-related brands
type AbsoluteWorkRailHomeDir = Brand<string, 'AbsoluteWorkRailHomeDir'>;
type SessionsRootPath = Brand<string, 'SessionsRootPath'>;
type LockFilePath = Brand<string, 'LockFilePath'>;
type V2DataRootPath = Brand<string, 'V2DataRootPath'>;
type UserWorkflowsDirPath = Brand<string, 'UserWorkflowsDirPath'>;
type CacheDirPath = Brand<string, 'CacheDirPath'>;

// Namespace brands (smart constructor enforces DNS-safe pattern)
type NamespaceId = Brand<string, 'NamespaceId'>;
type WorkRailNamespace = NamespaceId;  // alias for clarity

// Data directory brand (proves validation at boundary)
type WorkRailDataDir = Brand<string, 'WorkRailDataDir'>;

// Port brands
type DashboardPort = Brand<number, 'DashboardPort'>;
type BasePort = Brand<number, 'BasePort'>;  // base port for derivation (e.g., 3456)

// Time brand
type Timestamp = Brand<number, 'Timestamp'>;

// Namespace lock handle (opaque token proving ownership)
type NamespaceLockHandle = Brand<string, 'NamespaceLockHandle'>;
```

### Lock owner information

```typescript
// Lock owner metadata (for diagnostics and state-based validation)
interface LockOwnerInfo {
  readonly pid: number;
  readonly startedAt: Timestamp;
  readonly hostname: string;
  readonly wasAliveAtCheck: boolean;  // snapshot at time of check; may have changed since
}

// Note: No nonce field. PID reuse detection uses process start time on Linux/macOS.
// Windows limitation documented in error variant (see NamespaceLockError).
```

### Discriminated unions

```typescript
// Namespace is always required (no global mode)
type NamespaceId = Brand<string, 'NamespaceId'>;  // DNS-safe pattern

// Namespace lifecycle mode
type NamespaceMode =
  | { readonly kind: 'ephemeral' }                           // auto-delete on exit
  | { readonly kind: 'sliding'; readonly ttlMs: number }     // auto-delete after TTL
  | { readonly kind: 'persistent' };                         // manual delete only



// Filesystem safety policy
type FilesystemSafetyPolicy = { readonly kind: 'require_local' };

// Filesystem safety errors
type FilesystemSafetyError =
  | { readonly kind: 'network_fs_detected'; readonly path: string; readonly dev: number }
  | { readonly kind: 'check_failed'; readonly path: string; readonly reason: string };

// Token validation errors
type TokenValidationError =
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'signature_invalid' }  // HMAC verification failed (tampered token)
  | { readonly kind: 'expired'; readonly issuedAt: Timestamp; readonly now: Timestamp }
| { readonly kind: 'session_not_found'; readonly sessionId: string };

// Namespace lock errors (fail-fast with clear diagnostics)
type NamespaceLockError =
  | { readonly kind: 'namespace_in_use'; readonly owner: LockOwnerInfo; readonly namespace: NamespaceId }
  | { readonly kind: 'namespace_in_use_windows_caveat'; readonly owner: LockOwnerInfo; readonly namespace: NamespaceId; readonly lockPath: string }  // Platform-specific variant for exhaustive handling
  | { readonly kind: 'lock_corrupted'; readonly path: string; readonly reason: string }
  | { readonly kind: 'lock_reclaim_race'; readonly namespace: NamespaceId }
  | { readonly kind: 'filesystem_error'; readonly code: string; readonly message: string };

// Config validation errors
type ConfigValidationError =
  | { readonly kind: 'invalid_namespace_format'; readonly value: string; readonly reason: string }
  | { readonly kind: 'namespace_required' }
  | { readonly kind: 'home_on_network_fs'; readonly path: string; readonly dev: number }
  | { readonly kind: 'relative_home_path'; readonly value: string }
  | { readonly kind: 'home_path_not_writable'; readonly path: string; readonly error: string }
  | { readonly kind: 'port_out_of_range'; readonly port: number }
  | { readonly kind: 'namespace_reserved'; readonly value: string }  // Reserved: cannot use these names
  | { readonly kind: 'env_parse_error'; readonly variable: string; readonly reason: string };

// Namespace registry errors (for async lifecycle operations)
type NamespaceRegistryError =
  | { readonly kind: 'namespace_already_exists'; readonly id: NamespaceId }
  | { readonly kind: 'namespace_not_found'; readonly id: NamespaceId }
  | { readonly kind: 'namespace_locked'; readonly id: NamespaceId; readonly owner: LockOwnerInfo }
  | { readonly kind: 'create_failed'; readonly id: NamespaceId; readonly reason: string }
  | { readonly kind: 'destroy_failed'; readonly id: NamespaceId; readonly reason: string }
  | { readonly kind: 'filesystem_error'; readonly code: string; readonly message: string };

// Port derivation errors (for dashboard port allocation)
type PortDerivationError =
  | { readonly kind: 'port_in_use'; readonly port: DashboardPort; readonly namespace: NamespaceId }
  | { readonly kind: 'all_ports_exhausted'; readonly basePort: BasePort; readonly scannedCount: number; readonly namespace: NamespaceId };
```

### Core interfaces

```typescript
interface NamespaceContext {
  readonly id: NamespaceId;  // always required
  readonly mode: NamespaceMode;
  readonly paths: WorkRailPathsPort;
  readonly dashboardPort: DashboardPort;
  readonly lockHandle: NamespaceLockHandle;  // always has lock
  
  // Observability
  readonly createdAt: Timestamp;
  toLoggingContext(): Record<string, string>;
}

interface NamespaceRegistry {
  readonly homeDir: AbsoluteWorkRailHomeDir;
  
  // Discovery (infallible - return empty/false on fs errors)
  listNamespaces(): Promise<readonly NamespaceId[]>;
  exists(ns: NamespaceId): Promise<boolean>;
  
  // Lifecycle (errors as data - all failure modes represented in Result)
  create(ns: NamespaceId, mode: NamespaceMode): Promise<Result<NamespaceContext, NamespaceRegistryError>>;
  destroy(ns: NamespaceId): Promise<Result<void, NamespaceRegistryError>>;
  
  // Access (errors as data)
  getContext(ns: NamespaceId): Promise<Result<NamespaceContext, NamespaceRegistryError>>;
}

interface WorkRailPathsPort {
  // Namespace identity
  activeNamespace(): NamespaceId;
  
  // Namespace-scoped paths (all under <home>/namespaces/<ns>/)
  sessionsRoot(): SessionsRootPath;
  dashboardLockPath(): LockFilePath;
  namespaceLockPath(): LockFilePath;
  v2DataRoot(): V2DataRootPath;
  userWorkflowsDir(): UserWorkflowsDirPath;
  cacheDir(): CacheDirPath;
  
  // Global paths (outside namespace tree)
  globalKeysDir(): GlobalKeysDirPath;  // → <home>/keys (not namespace-scoped)
}

// Namespace lock acquisition (capability-based ownership)
interface NamespaceLockPort {
  /**
   * Attempt to acquire exclusive ownership of a namespace.
   * - Returns handle on success (proves ownership)
   * - Returns error if namespace already owned by live process
   * - Automatically reclaims lock from dead processes
   */
  acquire(namespace: NamespaceId): Promise<Result<NamespaceLockHandle, NamespaceLockError>>;
  
  /**
   * Release namespace ownership.
   * Called automatically on graceful shutdown; explicit call for tests.
   */
  release(handle: NamespaceLockHandle): Promise<Result<void, NamespaceLockError>>;
  
  /**
   * Check namespace lock status without attempting to acquire.
   * Returns owner info if locked, null if available.
   * Non-destructive - does not modify lock state.
   */
  peek(namespace: NamespaceId): Promise<Result<LockOwnerInfo | null, NamespaceLockError>>;
}

// Process metadata (injected for testability and state-based lock validation)
interface ProcessInfoPort {
  pid(): number;
  startTime(): Date;
  hostname(): string;
  
  /** Check if process exists (kill(pid, 0)). Handles EPERM on Windows. */
  isProcessAlive(pid: number): boolean;
  
  /** Check if process is suspended (SIGSTOP). Platform-specific: Linux/macOS only. */
  isProcessSuspended(pid: number): boolean;
  
  /** Get process start time in epoch ms for PID reuse detection. Returns null if unavailable (Windows). */
  getProcessStartTime(pid: number): number | null;
}

// File system operations (for namespace locking)
interface FileSystemPort {
  /**
   * Create directory recursively.
   * Returns Ok(void) if created or already exists.
   */
  mkdir(path: string, options: { recursive: boolean }): Promise<Result<void, FsError>>;
  
  /**
   * Write file with exclusive create flag (O_EXCL / 'wx').
   * Fails with EEXIST if file already exists (atomic).
   */
  writeFileExclusive(path: string, content: string): Promise<Result<void, FsError>>;
  
  /**
   * Read file contents.
   * Returns Err with code ENOENT if file doesn't exist.
   */
  readFile(path: string): Promise<Result<string, FsError>>;
  
  /**
   * Delete file.
   * Returns Ok if deleted or file doesn't exist (ENOENT is success).
   */
  deleteFile(path: string): Promise<Result<void, FsError>>;
}

type FsError = {
  readonly code: string;  // Node.js error code (EEXIST, ENOENT, EACCES, etc.)
  readonly message: string;
};

/**
 * Note: This interface overlaps with v2's FileSystemPortV2 but has different
 * signatures (Result-based async). Consider unifying in a future refactor, but for
 * Slice 2 this keeps namespace lock implementation independent of v2 substrate.
 */

// Namespace lifecycle events (observability)
type UnsubscribeFn = () => void;

interface NamespaceEvents {
  /**
   * Emit namespace lifecycle events for debugging multi-process scenarios.
   * Events are informational only; not used for correctness.
   */
  emit(event: NamespaceLifecycleEvent): void;
  on(handler: (event: NamespaceLifecycleEvent) => void): UnsubscribeFn;
}

type NamespaceLifecycleEvent =
  | { readonly kind: 'namespace_lock_acquired'; readonly namespace: NamespaceId; readonly pid: number }
  | { readonly kind: 'namespace_lock_released'; readonly namespace: NamespaceId; readonly pid: number }
  | { readonly kind: 'namespace_lock_reclaimed'; readonly namespace: NamespaceId; readonly stalePid: number; readonly newPid: number }
  | { readonly kind: 'namespace_created'; readonly namespace: NamespaceId; readonly mode: NamespaceMode }
  | { readonly kind: 'namespace_destroyed'; readonly namespace: NamespaceId }
  | { readonly kind: 'heartbeat_started'; readonly namespace: NamespaceId }
  | { readonly kind: 'heartbeat_stopped'; readonly namespace: NamespaceId };
```

## Design decisions (what we chose and why)

### Decision 1 — Unified namespaced home for v1 + v2 (not v2-only)
**Chosen:** add `WORKRAIL_HOME_DIR` + `WORKRAIL_NAMESPACE` and apply to **both** v1 and v2 storage.

**Alternatives considered:**
- v2-only namespace (leave v1 hardcoded): still bleeds on dashboard/session tools; doesn't solve the root cause.
- Two separate env vars (`WORKRAIL_V1_HOME`, `WORKRAIL_V2_HOME`): adds surface area; risks confusion.

**Why unified:**
- **Architectural fix over patches:** v1's hardcoded `~/.workrail/...` is the root cause; removing it once solves isolation for the whole product.
- **Determinism:** tests should isolate v1 + v2 together; partial isolation just moves the bleed.
- **Small surface:** one home dir + one namespace, not N separate roots.

### Decision 2 — Validated config at boundary (not ad-hoc env reads)
**Chosen:** extend `src/config/app-config.ts` to parse/validate `WORKRAIL_HOME_DIR` + `WORKRAIL_NAMESPACE` using Zod, and return typed/branded values.

**Alternatives considered:**
- Let services read `process.env` directly: violates capability boundaries; hard to test; spreads env knowledge.
- A "god config bag" with arbitrary keys: violates closed sets; no compile-time safety.

**Why validated config:**
- **Validate at boundaries, trust inside:** once config is validated, services operate on typed values (no defensive checks scattered).
- **Errors as data:** invalid config produces structured errors (not throws deep in services).
- **Capability-based:** only composition root (`src/di/container.ts`) reads `process.env`; services inject validated config.

### Decision 3 — Single paths port (capability boundary)
**Chosen:** introduce a tiny `WorkRailPathsPort` interface with a few canonical path methods, implemented as a pure adapter over validated config.

**Alternatives considered:**
- Just add env checks in SessionManager/HttpServer: scatters knowledge; violates single source of truth.
- Overload existing `DataDirPortV2`: wrong abstraction; v2-specific, not shared v1/v2 layout.

**Why a new port:**
- **Single source of truth:** all path decisions in one place; no scattered `~/.workrail/...`.
- **Pure functions:** path derivation is deterministic (same config → same paths); easy to unit test.
- **Small interface:** 3–4 methods; avoids becoming a general filesystem API.

### Decision 4 — Namespace is process-start config (not runtime-mutable)
**Chosen:** `WORKRAIL_NAMESPACE` is read once at process start and frozen for the lifetime of the DI container.

**Alternatives considered:**
- MCP tool to switch namespace mid-run: introduces hidden mutable state; breaks determinism; makes tokens invalid across namespace switches.

**Why frozen:**
- **Determinism:** namespace is explicit input; no hidden runtime mutation.
- **Token correctness:** tokens minted in one namespace can't accidentally be used in another namespace after a switch (would be a correctness violation).
- **Aligns with philosophy:** control flow from explicit data state, not ad-hoc flags.

### Decision 5 — Namespace Collision Detection via Lock + PID + Suspended State

**Chosen:** Atomic lock file creation with `O_EXCL` + multi-layer state validation.

**Alternatives considered:**
- No collision detection: insufficient for CI/CD
- Arbitrary timeout (24h): violates determinism (lock validity depends on wall clock)
- Heartbeat-based lock: requires ongoing timer; adds complexity
- OS-level flock(): requires native dependency; platform-specific

**Why atomic lock + explicit state checks:**
- **Atomic acquisition:** `O_EXCL` / `wx` flag guarantees exclusive create
- **Cross-platform:** same behavior everywhere (Linux, macOS, Windows)
- **Deterministic:** lock validity determined by explicit state, not time
- **Automatic crash recovery:** reclaims locks from dead/suspended processes
- **No external dependencies:** uses only Node.js built-ins
- **Fail-fast:** collision detected immediately with clear diagnostics

**Implementation - Three-Layer Validation:**

1. **Layer 1: PID liveness**
   ```typescript
   if (!process.kill(pid, 0)) {
     reclaim('process is dead');
   }
   ```

2. **Layer 2: Process suspended detection**
   ```typescript
   // Linux: /proc/<pid>/stat state field
   // macOS: ps -o state
   // Windows: N/A (processes are running or dead)
   if (isProcessSuspended(pid)) {
     reclaim('process is suspended (SIGSTOP)');
   }
   ```

3. **Layer 3: PID reuse detection**
   ```typescript
   const ownerStartTime = getProcessStartTime(pid);
   const lockStartTime = lockFile.startedAt;
   if (Math.abs(ownerStartTime - lockStartTime) > 2000) {
     reclaim('PID was reused by different process');
   }
   ```

**Lock file structure:**
```json
{
  "pid": 12345,
  "startedAt": "2025-01-01T12:00:00.000Z",
  "hostname": "dev-machine.local"
}
```

**Note:** No nonce field. PID reuse detection uses `getProcessStartTime()` on Linux/macOS. Windows limitation is handled via platform-specific error variant (see `namespace_in_use_windows_caveat`).

**Acquisition protocol:**
1. Attempt `writeFileExclusive(lockPath, lockData)` (atomic via `O_EXCL`)
2. If succeeds → return `Ok(NamespaceLockHandle)`
3. If `EEXIST` → validate owner via 3-layer checks
4. If owner invalid (dead/suspended/reused) → delete stale lock, retry exclusive create
5. If owner valid → return `Err({ kind: 'namespace_in_use', owner: {...} })`
6. If exclusive create fails during reclaim → return `Err({ kind: 'lock_reclaim_race' })`

**Why no arbitrary timeout:**
- Timeout couples correctness to wall clock (violates determinism)
- Suspended process detection is explicit state check (not time-based)
- Operators can manually remove locks for hung processes (escape hatch)

### Decision 5b — Local Filesystem Requirement (No Override)

**Chosen:** Fail-fast if network filesystem detected. No operator override.

**Alternatives considered:**
- Allow override (`WORKRAIL_FS_SAFETY=force_allow`): violates fail-fast principle
- Heartbeat-based coordination on NFS: adds massive complexity for edge case
- Document-only warning: insufficient (users will ignore, encounter corruption)

**Why fail-fast with no override:**
- **Correctness over convenience:** O_EXCL atomicity not guaranteed on NFS/SMB
- **Fail-fast philosophy:** better to refuse than corrupt data silently
- **Clear solution:** error message provides actionable fix (use local directory)
- **Prevents escalation:** operator override would hide root cause of lock races

**Detection method:**
```typescript
// Heuristic: Check device number
const stats = await fs.lstat(dirPath);
if (stats.dev === 0 || stats.dev === 0xffffffff) {
  return err({ kind: 'network_fs_detected', path: dirPath });
}
```

**Error message:**
```
ERROR: Network filesystem detected at /mnt/nfs-share

WorkRail requires local filesystem atomicity for namespace locking.
Network filesystems (NFS, SMB) have eventual consistency windows
(50ms-3s) that allow dual lock acquisition → data corruption.

Solution: Use a local directory
  export WORKRAIL_HOME_DIR=/tmp/workrail

For CI/CD, mount local volume:
  docker run -v /tmp/workrail:/root/.workrail ...
```

**Why no override:**
- Aligns with "fail fast with meaningful error messages"
- Prevents users from shooting themselves in the foot
- Network FS is rare for WorkRail (primarily test isolation use case)
- Clear workaround available (local directory)

### Decision 6 — Keep v2 tokens namespace-agnostic (process/session isolation only)

**Chosen:** Do **not** embed namespace in v2 token payloads or signatures.

Tokens remain the locked v2 shape (e.g., `st.v1.*`, `ack.v1.*`, `chk.v1.*`) and remain signed over the canonical payload bytes only.

**Why:**
- In real MCP environments, WorkRail cannot reliably observe per-chat identity.
- Isolation between agent scenarios is achieved via **v2 session boundaries** (fresh `sessionId` per scenario + no token reuse).
- Optional process-level isolation (CI/multi-process) is achieved via process-scoped storage roots, not by altering token formats.

**Namespace interaction (when used at process start):**
- Tokens reference `sessionId`.
- Storage lookup for that `sessionId` occurs under the process’s configured root.
- A token from another process namespace simply fails to resolve because the session does not exist under the current root.

### Decision 7 — Process-scoped data root override (optional)

**Chosen:** Keep `WORKRAIL_DATA_DIR` as the primary mechanism for process-level durable root configuration.

**Why:**
- Works for CI and multi-process test harnesses.
- Does not require per-chat env injection.
- Keeps v2 path layout deterministic and centralized.

### Decision 8 — No per-chat container scoping in a single MCP process

**Chosen:** Do not introduce per-chat namespaces, per-chat child DI containers, or runtime namespace switching.

**Why:**
- A single long-lived MCP server process serving multiple chats has no reliable chat identifier.
- Any runtime switching would be implicit/heuristic and would create hidden state.
- v2 already has a correctness-grade isolation boundary: **sessionId + tokens**.

## Design locks (architectural constraints)

These constraints MUST be enforced and tested. Violations are fatal errors.

### Lock 1 — namespace-immutable-per-container
Once the DI container is initialized, the namespace MUST NOT change for the lifetime of that container. Any attempt to re-register paths with a different namespace is a fatal error.

**Enforcement:** DI container throws if `WorkRailPathsPort` is re-registered after initialization.

### Lock 2 — paths-port-single-source
No service may construct filesystem paths to WorkRail-owned storage (sessions, locks, data, keys, snapshots, workflows, cache) without going through `WorkRailPathsPort`.

**Enforcement:** Architecture test scanning for `os.homedir()` and hardcoded `~/.workrail` in `src/infrastructure/**` and `src/v2/**`. After Slice 3, only `src/config/app-config.ts` and `src/di/container.ts` may reference `os.homedir()`.

### Lock 3 — namespace-directory-schema
The directory structure under `<home>/namespaces/<ns>/` is:
```
namespaces/<ns>/
├── .namespace.lock    # ownership lock file (Lock 11)
├── .namespace.json    # namespace metadata (mode, schemaVersion)
├── sessions/          # session storage
├── dashboard.lock     # v1 dashboard lock
├── workflows/         # user-defined workflow definitions
├── cache/             # git clone cache and transient data
└── data/              # v2 substrate
    ├── snapshots/     # per-namespace CAS
    ├── sessions/      # v2 event logs
    └── workflows/
        └── pinned/    # compiled workflow snapshots
```

The global keyring lives outside the namespace tree:
```
<home>/
├── keys/
│   └── keyring.json   # shared process secret (not namespace-scoped)
└── namespaces/
    └── <ns>/
        └── ...
```

**Namespace metadata file (`.namespace.json`):**
```json
{
  "schemaVersion": 1,
  "namespaceId": "test-1",
  "mode": { "kind": "ephemeral" },
  "createdAt": "2025-01-01T12:00:00.000Z"
}
```

**Rationale:** The keyring is a process-level secret for HMAC signing, not a 
namespace-scoped resource. v2 token validation checks sessionId against 
namespace-scoped storage; tokens from namespace A fail in namespace B because 
the session doesn't exist, not because of crypto mismatch. This aligns with 
"namespace is process-start config" (Decision 4) and v2-core-design-locks.md §10.

This layout MUST NOT change without a version bump. **No migration plan** — hard break per philosophy (no backward compatibility). Existing keyrings at old locations (`~/.workrail/data/keys/keyring.json`) will be orphaned; new keyrings will be created at global location.

**Enforcement:** Golden path test asserting expected structure.

### Lock 4 — Namespace is optional and process-start only

`WORKRAIL_NAMESPACE` is an optional **process-start** configuration knob.

- If `WORKRAIL_NAMESPACE` is set at process start, WorkRail scopes durable storage under `<home>/namespaces/<ns>/...`.
- If `WORKRAIL_NAMESPACE` is not set, WorkRail uses the default global durable root.
- WorkRail MUST NOT attempt to infer per-chat identity or auto-switch namespaces at runtime.

**Why:** In real MCP environments the server may be a single long-lived process across many chats. Per-chat durable isolation must be achieved via v2 session boundaries, not namespaces.

### Lock 6 — branded-types-at-boundaries
Public APIs of `WorkRailPathsPort` MUST return branded path types. Internal implementations may use `string`, but any path crossing a module boundary MUST be branded.

**Enforcement:** TypeScript compiler (branded types are compile-time enforced).

### Lock 7 — v2 token shape is unchanged

Tokens MUST remain the locked v2 shape (payload/signature inputs unchanged). In particular:
- Tokens MUST NOT embed any namespace identifier.
- Token validation MUST be based on signature verification + session lookup.

Isolation for manual/agentic testing is achieved by:
- starting a fresh v2 session per scenario (`start_workflow`)
- never reusing tokens across chats

### Lock 8 — no implicit per-chat durable isolation

In a single long-lived MCP server process, WorkRail MUST NOT attempt to infer chat identity or auto-switch durable roots at runtime.

If a caller needs durable isolation beyond the session boundary, it must be provided at process start (e.g., `WORKRAIL_DATA_DIR` in CI/multi-process scenarios).

### Lock 9 — single container per process

WorkRail runs as a single long-lived MCP server process. The container is process-scoped.

Per-chat isolation is provided by **v2 session boundaries**, not per-chat DI containers.

### Lock 10 — namespace-mode-determines-lifecycle
Namespace lifecycle is determined by its mode at creation time:
- `ephemeral`: MUST be deleted when owning process exits
- `sliding`: MUST be deleted when TTL expires AND no heartbeat for 5 minutes
- `persistent`: MUST NOT be auto-deleted; requires explicit `destroy()` call

Mode MUST NOT change after namespace creation.

**Enforcement:** Unit test asserting mode is immutable; integration test verifying cleanup behavior per mode.

### Lock 11 — single-owner-per-namespace
At most one process may hold the namespace lock at any time. The lock file `<ns>/.namespace.lock` is the single source of truth for ownership. Lock acquisition MUST be atomic (no partial states). Lock reclamation from dead processes MUST verify PID liveness before taking over.

**Distinction from dashboard lock:**
The namespace lock (`.namespace.lock`) and dashboard lock (`dashboard.lock`) serve 
different purposes and exist at different scopes:

| Lock Type | Purpose | Scope | Location |
|-----------|---------|-------|----------|
| Namespace lock | Prevent namespace collision | Per-namespace | `<ns>/.namespace.lock` |
| Dashboard lock | Primary election | Per-namespace | `<ns>/dashboard.lock` |

**Interaction:**
- Process A acquires namespace lock for `test-1` → gets exclusive ownership of entire namespace
- Process A then attempts dashboard primary election → may succeed or fail (if another process somehow started)
- Process B attempts namespace lock for `test-1` → fails with `namespace_in_use` (before even trying dashboard)

**Lock file structure:**
```json
{
  "pid": 12345,
  "startedAt": "2025-01-01T12:00:00.000Z",
  "hostname": "dev-machine.local",
  "nonce": "a3f5c2d8e1b4f7a9c6d2e8f1a5b3c7d9"
}
```

**Acquisition protocol:**
1. Atomic create with `O_EXCL` → success = ownership
2. If exists → validate owner via 3-layer check:
   a. PID liveness: `kill(pid, 0)`
   b. Suspended state: `/proc/<pid>/stat` or `ps` (platform-specific)
   c. PID reuse: compare process start time OR nonce (Windows)
3. If owner dead/suspended/reused → reclaim (delete + retry)
4. If owner alive and valid → fail-fast with `namespace_in_use` error

**Enforcement:** Integration test with two processes attempting same namespace; exactly one succeeds.

## Invariants (properties that must always hold)

These are correctness properties. Tests should verify them; violations indicate bugs.

### Invariant 1 — namespace-path-disjointness
For any two distinct namespace IDs A and B:
- `paths(A).sessionsRoot()` and `paths(B).sessionsRoot()` share no common prefix beyond `<home>/`
- `paths(A).dashboardLockPath() ≠ paths(B).dashboardLockPath()`
- `paths(A).v2DataRoot()` and `paths(B).v2DataRoot()` share no common prefix beyond `<home>/`
- `paths(A).userWorkflowsDir()` and `paths(B).userWorkflowsDir()` share no common prefix beyond `<home>/`
- `paths(A).cacheDir()` and `paths(B).cacheDir()` share no common prefix beyond `<home>/`

**Guarantees:** No cross-namespace data bleed (sessions, workflows, cache, v2 data).

**Test:** Property-based test with arbitrary namespace pairs.

### Invariant 2 — path-determinism
Given identical `(homeDir, namespace)` inputs, `WorkRailPathsPort` MUST return identical paths on every call. No randomness, no timestamps, no external state.

**Additional guarantee:** Path resolution MUST NOT depend on filesystem checks. The path returned is a pure function of config, not whether files exist at that path.

**Violations:**
- ❌ Check if namespaced path exists, fall back to legacy path (dual-read)
- ❌ Return different paths based on current time
- ❌ Return different paths based on environment variables read during resolution
- ✅ Return deterministic path from validated config

**Guarantees:** Reproducible test runs, predictable behavior.

**Test:** Call each method 100x, assert all results equal.

### Invariant 3 — namespace-containment
All paths returned by `WorkRailPathsPort` MUST be descendants of `<home>/namespaces/<ns>/`. No path may escape this subtree. This applies to:
- `sessionsRoot()`
- `dashboardLockPath()`
- `v2DataRoot()`
- `userWorkflowsDir()`
- `cacheDir()`

**Guarantees:** Namespace isolation is complete.

**Test:** For all methods, assert `path.startsWith(namespaceDir)`.

### Invariant 4 — lock-file-uniqueness
At most one process may hold the dashboard lock for a given `(home, namespace)` pair at any time. The lock file path uniquely identifies the lock scope.

**Guarantees:** No dashboard primary conflicts within a namespace.

**Test:** Existing lock file tests (already covered by HttpServer tests).

### Invariant 5 — config-to-path-validity
If `loadConfig()` returns `Ok(config)`, then constructing `WorkRailPathsPort` with that config MUST succeed (no throws, no errors). Config validation failures are caught at the boundary, not during path construction.

**Guarantees:** Validate once at boundary, trust inside.

**Test:** Fuzz valid configs, assert port construction never throws.

### Invariant 6 — namespace-dns-safe
Valid namespaces match `^[a-z][a-z0-9-]{0,61}[a-z0-9]$` (allowlist pattern, not blocklist):
- **Must** start with lowercase letter (not number or special char)
- **Must** end with lowercase letter or number
- **May** contain lowercase letters, digits, hyphens in between
- Length: 2-63 characters

This pattern automatically excludes:
- Reserved words like `global`, `default` (don't start with letter after letter)
- Numeric-only like `123` (doesn't start with letter)
- Underscore-prefix like `_hidden` (not in allowed character set)
- Path traversal like `.` or `..` (not in allowed character set)

**Guarantees:** Safe for filesystems, URLs, env vars, DNS. Makes illegal states unrepresentable.

**Test:** Smart constructor with Result type enforces pattern. Unit tests verify rejection of invalid inputs.

### Invariant 7 — token-session-binding
For any token referencing a v2 `sessionId = S`:
- Validation succeeds only if session `S` exists in the process-scoped durable root and the token signature is valid.
- If session `S` does not exist under the current durable root, validation fails with `session_not_found`.

**Guarantees:** Tokens are capability handles to a specific durable session. They are not transferable across sessions, and scenario isolation is achieved by starting a fresh session per scenario.

### Invariant 8 — scenario isolation contract (manual/agentic)
For manual/agentic testing, each scenario MUST:
- run in a new chat
- start a new v2 session (`start_workflow`)
- never reuse tokens from any other chat

### Invariant 12 — no-filesystem-probing

Path resolution methods MUST NOT perform filesystem checks (existence, permissions, readability).

**Invalid (filesystem I/O):**
```typescript
// ❌ INVALID: Filesystem check in path resolution
async sessionPath(sessionId: string): Promise<string> {
  const path = `${this.namespaceDir()}/sessions/${sessionId}`;
  if (await fs.exists(path)) {  // ❌ I/O in path method
    return path;
  }
  throw new Error('not found');  // ❌ Should not check existence
}
```

**Valid (pure function):**
```typescript
// ✅ VALID: Pure function, no I/O
sessionPath(sessionId: string): string {
  return `${this.namespaceDir()}/sessions/${sessionId}`;
}
```

**Guarantees:**
- Path resolution is synchronous and instant
- No hidden I/O in path methods
- Behavior is deterministic (doesn't depend on filesystem state)

**Rationale:** 
- Aligns with "determinism over cleverness"
- Prevents temporal coupling (path can't change based on file creation/deletion)
- Makes testing easier (no need to mock filesystem for path derivation)

**Test:** Unit tests call path methods without filesystem setup; must not throw or perform I/O.

### Invariant 13 — compile-time-scope-enforcement

Services MUST be prevented from registering in wrong-scoped containers at compile time.

**Type-level guarantee:**
```typescript
// This compiles
registerInRoot(DI.Services.WorkflowCompiler, ...);  // ApplicationScoped

// This fails to compile
registerInChild(DI.Services.WorkflowCompiler, ...);  // ❌ Type error!
// Error: Argument of type 'ApplicationScopedToken<WorkflowCompiler>' 
//        is not assignable to parameter of type 'NamespaceScopedToken<T>'
```

**Guarantees:**
- Wrong-scoped registrations caught at compile time
- No need for runtime checks (validated at boundary)
- Self-documenting (type signature shows scope)

**Enforcement:** TypeScript compiler via phantom types.

**Test:** Add test file with intentional violations; verify it fails `tsc` compilation.

## Operational constraints (timeouts and fail-fast behavior)

These constraints ensure the system fails fast and doesn't hang on I/O issues.

### Constraint 1 — Home directory writability check at startup
At container initialization, verify the home directory exists and is writable. If not:
- **Missing directory:** attempt to create it (fail-fast if creation fails)
- **Not writable:** fail immediately with `ConfigValidationError.home_path_not_writable`

**Rationale:** Failing at startup is better than failing on first session write (clearer diagnostics, no partial state).

**Timeout:** 5 seconds for directory creation/check.

### Constraint 2 — Lock file operations have bounded timeouts
All lock file operations (acquire, release, heartbeat update) must complete within bounded time:
- **Lock acquisition:** 2 seconds max, then fail with "lock acquisition timeout"
- **Lock release:** 1 second max, then log warning and continue (best-effort cleanup)
- **Heartbeat update:** 1 second max, then log warning (non-fatal, will retry)

**Rationale:** Network filesystems or permission issues shouldn't hang the process indefinitely.

### Constraint 3 — Config validation is synchronous and fast
`loadConfig()` must complete synchronously and not perform I/O beyond reading `process.env`. Filesystem checks (home dir writability) happen separately in DI initialization.

**Rationale:** Config parsing should be pure and instant; I/O validation is a separate concern.

### Constraint 4 — Fail-fast on permission errors
If any WorkRail-owned path operation fails with `EACCES` or `EPERM`:
- Log the error with the full path and required permission
- Fail immediately (don't retry)
- Return a structured error (not throw)

**Rationale:** Permission errors don't self-heal; retrying wastes time and obscures the root cause.

### Constraint 5 — Local Filesystem Requirement

**At container initialization, detect network filesystems and fail immediately.**

Detection method:
```typescript
const stats = await fs.lstat(homeDir);
if (stats.dev === 0 || stats.dev === 0xffffffff) {
  throw ConfigValidationError.home_on_network_fs;
}
```

**Rationale:** O_EXCL atomicity (required for lock correctness) is not guaranteed on network filesystems (NFS, SMB). Eventual consistency windows (50ms-3s) allow dual lock acquisition → data corruption.

**No override:** Network filesystem detection has no escape hatch. If detected, WorkRail refuses to start. Solution: use local directory (`WORKRAIL_HOME_DIR=/tmp/workrail`).

**Timeout:** Detection must complete within 2 seconds.

### Constraint 6 — Suspended Process Detection

**Lock validation must check for suspended processes via OS-level state inspection.**

Platform-specific detection:
- **Linux:** Read `/proc/<pid>/stat`, check state field for `T` (stopped/traced)
- **macOS:** Execute `ps -p <pid> -o state=`, check for `T`
- **Windows:** No suspended state; processes are running or dead

**Rationale:** `kill(pid, 0)` returns true for suspended processes (`SIGSTOP`), but suspended processes don't respond. Detecting suspended state allows reclaiming locks from zombie processes without arbitrary timeouts.

**Timeout:** State check must complete within 500ms.

**Fallback:** If detection unavailable (unsupported platform, `/proc` unmounted), treat as "not suspended" (conservative - may leave zombie locks).

### Constraint 7 — No Temporal Coupling in Lock Validity

**Lock validity is determined by explicit state checks, never by wall clock time.**

Invalid approaches:
- ❌ "Reclaim if lock age > 24 hours"
- ❌ "Heartbeat every 30s, stale if >2 minutes"

Valid approach:
- ✅ "Reclaim if PID is dead OR suspended OR reused"

**Rationale:** Time-based expiry violates determinism (same lock can be valid at t=0, invalid at t=24h despite identical state). Explicit state checks are deterministic.

**Philosophy alignment:** "Determinism over cleverness" + "Control flow from data state". Lock validity is a pure function of process state (alive/dead/suspended/reused), not wall clock time. Same process state always produces same lock validity decision.

## Implementation plan (v2-only)

This implementation plan focuses on what is achievable and required for v2 manual/agentic testing in a single long-lived MCP server process.

### Slice A — Session isolation contract (docs + ergonomics)
**Goal:** Make v2 slice 1–3 manual testing reliable without per-chat env injection.

**Changes:**
- Document the required isolation contract:
  - new chat per scenario
  - new v2 session per scenario (`start_workflow`)
  - never reuse tokens across chats
  - do not run scenarios in parallel against the same WorkRail instance

### Slice B — Retention/cleanup policy (optional but recommended)
**Goal:** Prevent the durable store from accumulating confusing state across many runs in a long-lived MCP server.

**Changes:**
- Add a deterministic retention policy (TTL and/or max session count).
- Delete only what is safe to delete (derived caches first; sessions only when eligible).
- On corruption/unknown version: enter safe mode (no deletes) and emit a structured warning.

### Slice C — Process-level isolation for CI (optional)
**Goal:** Support multi-process isolation when the environment can set process-start config.

**Changes:**
- Use `WORKRAIL_DATA_DIR` as the primary process-scoped durable root override.
- `WORKRAIL_NAMESPACE` (if used) remains process-start only and does not affect token formats.

---

## Appendix — Deprecated namespace-based plan (do not implement)

The remainder of this section predates the v2-only, single-process MCP constraints and is retained only for historical context.

### Slice 1 — Extend config schema + validation
**Goal:** parse `WORKRAIL_HOME_DIR` + `WORKRAIL_NAMESPACE` at the boundary and return typed values.

**Changes:**
- `src/config/app-config.ts`:
  - extend `EnvSchema` with:
    - `WORKRAIL_HOME_DIR?: string` (must be absolute if present; default `~/.workrail`)
    - `WORKRAIL_NAMESPACE: string` (REQUIRED; pattern `^[a-z][a-z0-9-]{0,61}[a-z0-9]$`; 2-63 chars)
      - **Allowlist pattern** (not blocklist): Must start with letter, contain only a-z/0-9/-, end with alphanumeric
      - Automatically excludes: reserved words, numeric-only, underscore-prefix, path traversal
      - See Invariant 6 for complete rationale
    - `WORKRAIL_DATA_DIR?: string` (existing, now tracked explicitly for precedence)
  - add branded types:
    - `AbsoluteWorkRailHomeDir` — branded string proving absolute path validation
    - `WorkRailNamespace` — branded string proving DNS-safe pattern validation
  - add discriminated unions to `AppConfig` type:
    - `paths.homeDir: AbsoluteWorkRailHomeDir` (branded, name indicates absolute-ness)
    - `paths.namespace: NamespaceId` (always required, DNS-safe pattern)
    - `paths.filesystemSafety: FilesystemSafetyPolicy` (require_local only)
  - add config error variants:
    ```ts
    type ConfigValidationError =
      | { readonly kind: 'invalid_namespace_format'; readonly value: string; readonly reason: string }
      | { readonly kind: 'namespace_required' }
      | { readonly kind: 'home_on_network_fs'; readonly path: string; readonly dev: number }
      | { readonly kind: 'relative_home_path'; readonly value: string }
      | { readonly kind: 'home_path_not_writable'; readonly path: string }
      | { readonly kind: 'other'; readonly message: string };
    ```
  - update `buildConfig()` to compute these fields
  - add filesystem safety check in config validation

**Type definitions:**
```ts
// Branded types (name indicates constraint)
type AbsoluteWorkRailHomeDir = Brand<string, 'AbsoluteWorkRailHomeDir'>;
type WorkRailNamespace = Brand<string, 'WorkRailNamespace'>;

// Discriminated unions (exhaustive handling)
// NOTE: NamespaceConfig is defined in Types § - use that canonical definition
// Here we show the config-specific fields:
//   paths.namespace: NamespaceConfig (from validated config)

**Tests:**
- Add unit tests for config parsing:
  - no WORKRAIL_NAMESPACE set: fails with `{ kind: 'namespace_required' }`
  - `WORKRAIL_NAMESPACE=chat-1`: home is `~/.workrail`, namespace id is `chat-1`
  - `WORKRAIL_HOME_DIR=/tmp/wr-test`: home is `/tmp/wr-test`, namespace id is from env
  - `WORKRAIL_HOME_DIR=/mnt/nfs`: fails with `{ kind: 'home_on_network_fs', dev: 0 }`
  - invalid namespace (`Chat-1` uppercase): fails with `{ kind: 'invalid_namespace_format', ... }`
  - relative home path (`./foo`): fails with `{ kind: 'relative_home_path', ... }`

**Files to change:**
- `src/config/app-config.ts`
- New test: `tests/unit/config/test-isolation-config.test.ts`

**Estimated Effort:** 1 day (was 0.5 days; added NFS detection + namespace requirement)

### Slice 2 — Add WorkRailPathsPort + local adapter
**Goal:** introduce a pure capability that derives canonical paths from validated config.

**Changes:**
- `src/runtime/ports/workrail-paths.port.ts`:
  ```ts
  // Branded path types (Lock 6: branded-types-at-boundaries)
  export type SessionsRootPath = Brand<string, 'SessionsRootPath'>;
  export type LockFilePath = Brand<string, 'LockFilePath'>;
  export type V2DataRootPath = Brand<string, 'V2DataRootPath'>;
  
  export interface WorkRailPathsPort {
    sessionsRoot(): SessionsRootPath;
    dashboardLockPath(): LockFilePath;
    v2DataRoot(): V2DataRootPath;
    userWorkflowsDir(): UserWorkflowsDirPath;
    cacheDir(): CacheDirPath;
    activeNamespace(): NamespaceId;  // observability
  }
  ```
- `src/runtime/adapters/local-workrail-paths.ts`:
  ```ts
  export class LocalWorkRailPaths implements WorkRailPathsPort {
    constructor(
      private readonly _homeDir: AbsoluteWorkRailHomeDir,
      private readonly namespace: NamespaceId
    ) {}
    
    homeDir(): AbsoluteWorkRailHomeDir {
      return this._homeDir;
    }
    
    private namespaceDir(): string {
      return path.join(this._homeDir, 'namespaces', this.namespace);
    }
    
    sessionsRoot(): SessionsRootPath {
      return path.join(this.namespaceDir(), 'sessions') as SessionsRootPath;
    }
    
    dashboardLockPath(): LockFilePath {
      return path.join(this.namespaceDir(), 'dashboard.lock') as LockFilePath;
    }
    
    v2DataRoot(): V2DataRootPath {
      return path.join(this.namespaceDir(), 'data') as V2DataRootPath;
    }
    
    userWorkflowsDir(): UserWorkflowsDirPath {
      return path.join(this.namespaceDir(), 'workflows') as UserWorkflowsDirPath;
    }
    
    cacheDir(): CacheDirPath {
      return path.join(this.namespaceDir(), 'cache') as CacheDirPath;
    }
    
    activeNamespace(): NamespaceId {
      return this.namespace;
    }
  }
  ```

**DI wiring:**
- `src/di/tokens.ts`: add `DI.Runtime.WorkRailPaths`
- `src/di/container.ts`: register in `registerRuntime()`:
  ```ts
  const paths = new LocalWorkRailPaths(config);
  container.register(DI.Runtime.WorkRailPaths, { useValue: paths });
  ```

**Tests:**
- Unit test `LocalWorkRailPaths` against various configs:
  - namespace `test-1` → `~/.workrail/namespaces/test-1/sessions`, `dashboard.lock`, `data`, `workflows`, `cache`
  - home override + namespace → `<home>/namespaces/<ns>/sessions`, etc.
  - all paths derive from `namespaceDir()` with no conditionals

**Namespace lock port** (collision detection per Decision 5a, Lock 11):
- `src/runtime/ports/namespace-lock.port.ts`:
  ```ts
  export interface NamespaceLockPort {
    acquire(namespace: NamespaceId): Result<NamespaceLockHandle, NamespaceLockError>;
    release(handle: NamespaceLockHandle): Result<void, NamespaceLockError>;
  }
  ```
- `src/runtime/adapters/local-namespace-lock.ts`:
  ```ts
  export class LocalNamespaceLock implements NamespaceLockPort {
    constructor(
      private readonly homeDir: AbsoluteWorkRailHomeDir,
      private readonly fs: FileSystemPort,
      private readonly processInfo: ProcessInfoPort,
    ) {}
    
    async acquire(namespace: NamespaceId): Promise<Result<NamespaceLockHandle, NamespaceLockError>> {
      const nsDir = path.join(this.homeDir, 'namespaces', namespace);
      const lockPath = path.join(nsDir, '.namespace.lock');
      const selfInfo = {
        pid: this.processInfo.pid(),
        startedAt: this.processInfo.startTime().toISOString(),
        hostname: this.processInfo.hostname(),
      };
      
      // Ensure namespace directory exists
      const mkdirResult = await this.fs.mkdir(nsDir, { recursive: true });
      if (mkdirResult.kind === 'err') {
        return err({ kind: 'filesystem_error', code: mkdirResult.error.code, message: 'mkdir failed' });
      }
      
      // Atomic create (O_EXCL)
      const createResult = await this.fs.writeFileExclusive(lockPath, JSON.stringify(selfInfo));
      if (createResult.kind === 'ok') {
        return ok(createLockHandle(namespace));
      }
      
      // Lock exists - check if owner is alive
      if (createResult.error.code === 'EEXIST') {
        return await this.handleExistingLock(namespace, lockPath, selfInfo);
      }
      
      return err({ kind: 'filesystem_error', code: createResult.error.code, message: createResult.error.message });
    }
    
    private async handleExistingLock(
      namespace: NamespaceId, 
      lockPath: string, 
      selfInfo: LockFileContents
    ): Promise<Result<NamespaceLockHandle, NamespaceLockError>> {
      const readResult = await this.fs.readFile(lockPath);
      if (readResult.kind === 'err') {
        return err({ kind: 'lock_corrupted', path: lockPath, reason: 'unreadable' });
      }
      
      let owner: LockFileContents;
      try {
        owner = JSON.parse(readResult.value);
      } catch (e) {
        return err({ kind: 'lock_corrupted', path: lockPath, reason: 'invalid JSON' });
      }
      
      // Check PID liveness AND startedAt match (defense against PID reuse)
      const pidExists = this.processInfo.isProcessAlive(owner.pid);
      if (pidExists) {
        const ownerStartTime = new Date(owner.startedAt).getTime();
        const currentStartTime = this.processInfo.getProcessStartTime(owner.pid);
        
        // If start times match (within 2s tolerance), it's the same process
        const isOriginalOwner = currentStartTime !== null &&
          Math.abs(currentStartTime - ownerStartTime) < 2000;
        
        if (isOriginalOwner) {
          return err({ kind: 'namespace_in_use', namespace, owner: { ...owner, wasAliveAtCheck: true } });
        }
        // PID reused by different process - treat as stale, fall through to reclaim
      }
      
      // Owner dead OR PID reused - reclaim using DELETE + EXCLUSIVE CREATE pattern
      // This uses atomic exclusive create (O_EXCL / 'wx' flag) to prevent races
      
      // Save owner info for race detection (High #6: distinguish fresh create vs parallel reclaim)
      const staleOwner = owner;
      
      // Step 1: Delete the stale lock
      const deleteResult = await this.fs.deleteFile(lockPath);
      if (deleteResult.kind === 'err' && deleteResult.error.code !== 'ENOENT') {
        return err({ kind: 'filesystem_error', code: deleteResult.error.code, message: 'delete failed' });
      }
      
      // Step 2: Attempt exclusive create (fails if another process created lock between delete and create)
      // The 'wx' flag guarantees atomic exclusive create on all platforms (Linux, macOS, Windows)
      const createResult = await this.fs.writeFileExclusive(lockPath, JSON.stringify(selfInfo));
      
      if (createResult.kind === 'err') {
        if (createResult.error.code === 'EEXIST') {
          // Another process created a lock between our delete and create
          // Re-read to distinguish: same stale owner (parallel reclaim) vs different owner (fresh create)
          const rereadResult = await this.fs.readFile(lockPath);
          if (rereadResult.kind === 'ok') {
            try {
              const currentOwner = JSON.parse(rereadResult.value);
              if (currentOwner.pid === staleOwner.pid && currentOwner.startedAt === staleOwner.startedAt) {
                // Same stale owner - parallel reclaim race
                return err({ kind: 'lock_reclaim_race', namespace });
              } else {
                // Different owner - fresh create won
                return err({ 
                  kind: 'namespace_in_use', 
                  namespace, 
                  owner: { ...currentOwner, wasAliveAtCheck: true } 
                });
              }
            } catch {
              return err({ kind: 'lock_reclaim_race', namespace });
            }
          }
          return err({ kind: 'lock_reclaim_race', namespace });
        }
        return err({ kind: 'filesystem_error', code: createResult.error.code, message: 'exclusive create failed' });
      }
      
      return ok(createLockHandle(namespace));
    }
    
    async release(handle: NamespaceLockHandle): Promise<Result<void, NamespaceLockError>> {
      const nsDir = path.join(this.homeDir, 'namespaces', handle.__ns);
      const lockPath = path.join(nsDir, '.namespace.lock');
      return await this.fs.deleteFile(lockPath);
    }
    
    async peek(namespace: NamespaceId): Promise<Result<LockOwnerInfo | null, NamespaceLockError>> {
      const nsDir = path.join(this.homeDir, 'namespaces', namespace);
      const lockPath = path.join(nsDir, '.namespace.lock');
      
      const readResult = await this.fs.readFile(lockPath);
      if (readResult.kind === 'err') {
        if (readResult.error.code === 'ENOENT') {
          return ok(null);  // No lock file = namespace available
        }
        return err({ kind: 'lock_corrupted', path: lockPath, reason: 'unreadable' });
      }
      
      try {
        const owner = JSON.parse(readResult.value);
        const isAlive = this.processInfo.isProcessAlive(owner.pid);
        return ok({ ...owner, wasAliveAtCheck: isAlive });
      } catch (e) {
        return err({ kind: 'lock_corrupted', path: lockPath, reason: 'invalid JSON' });
      }
    }
  }
  
  /**
   * Create a namespace lock handle (branded token proving ownership).
   * Internal use only - returned by acquire().
   */
  function createLockHandle(namespace: NamespaceId): NamespaceLockHandle {
    return `ns_lock_${namespace}` as NamespaceLockHandle;
  }
  ```

**ProcessInfo port** (DI for process metadata):
- `src/runtime/ports/process-info.port.ts`:
  ```ts
  export interface ProcessInfoPort {
    pid(): number;
    startTime(): Date;
    hostname(): string;
    isProcessAlive(pid: number): boolean;
    isProcessSuspended(pid: number): boolean;  // NEW: detect SIGSTOP state
    /** Get start time of another process (for PID reuse detection). Returns null if unknown. */
    getProcessStartTime(pid: number): number | null;
    /** Generate cryptographic nonce for lock file (Windows PID reuse mitigation). */
    generateNonce(): string;  // NEW: returns 32-byte hex
  }
  ```
- `src/runtime/adapters/node-process-info.ts`:
  ```ts
  export class NodeProcessInfo implements ProcessInfoPort {
    pid(): number { return process.pid; }
    startTime(): Date { return new Date(Date.now() - process.uptime() * 1000); }
    hostname(): string { return os.hostname(); }
    isProcessAlive(pid: number): boolean {
      try { 
        process.kill(pid, 0); 
        return true; 
      } catch (e: unknown) {
        // Platform-specific error handling:
        // - ESRCH: process doesn't exist (all platforms)
        // - EPERM: process exists but can't signal (Windows, or permission issue)
        // On Windows, EPERM means the process IS alive but we can't signal it
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EPERM') {
          return true;  // Process exists, just can't signal
        }
        return false;  // ESRCH or other error = not alive
      }
    }
    isProcessSuspended(pid: number): boolean {
      if (process.platform === 'linux') {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
          const state = stat.split(' ')[2];  // Third field is process state
          return state === 'T' || state === 't';  // T = stopped, t = tracing stop
        } catch {
          return false;  // If can't read, assume not suspended
        }
      }
      
      if (process.platform === 'darwin') {
        try {
          const output = execSync(`ps -p ${pid} -o state=`, { encoding: 'utf8' });
          return output.trim() === 'T';  // T = stopped
        } catch {
          return false;
        }
      }
      
      // Windows: No suspended state (processes are running or dead)
      return false;
    }
    
    getProcessStartTime(pid: number): number | null {
      try {
        if (process.platform === 'linux') {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
          const starttime = parseInt(stat.split(' ')[21], 10);
          const bootTime = this.getBootTime();
          const ticksPerSecond = 100; // sysconf(_SC_CLK_TCK), typically 100 on Linux
          return bootTime + (starttime / ticksPerSecond) * 1000;
        }
        // macOS/Windows: fall back to null (use nonce for PID reuse detection)
        return null;
      } catch {
        return null;
      }
    }
    
    generateNonce(): string {
      return crypto.randomBytes(32).toString('hex');
    }
    private getBootTime(): number {
      // Read /proc/stat for btime on Linux
      try {
        const stat = fs.readFileSync('/proc/stat', 'utf-8');
        const btimeLine = stat.split('\n').find(l => l.startsWith('btime'));
        return btimeLine ? parseInt(btimeLine.split(' ')[1], 10) * 1000 : 0;
      } catch {
        return 0;
      }
    }
  }
  ```

**DI wiring for namespace lock:**

Note: Namespace lock acquisition must happen **after** config parsing (config provides the namespace ID).
The current DI initialization order is:
```
registerRuntime(options)  // creates ProcessInfo, signals, etc.
await registerConfig()    // parses WORKRAIL_NAMESPACE and other config
await registerStorageChain()
await registerV2Services()
await registerServices()
```

Namespace lock acquisition happens in a new `registerNamespaceLock()` function called after `registerConfig()`:

- `src/di/container.ts`: add `registerNamespaceLock()` after `registerConfig()`:
  ```ts
  async function registerNamespaceLock(): Promise<void> {
    const config = container.resolve<ValidatedConfig>(DI.Config.App);
    const processInfo = container.resolve<ProcessInfoPort>(DI.Runtime.ProcessInfo);
    const fs = container.resolve<FileSystemPort>(DI.V2.FileSystem);
    
    const lockPort = new LocalNamespaceLock(config.paths.homeDir, fs, processInfo);
    const lockResult = await lockPort.acquire(config.paths.namespace);
    
    if (lockResult.kind === 'err') {
      // Fail-fast with structured error (errors-as-data)
      console.error(formatNamespaceError(lockResult.error));
      process.exit(1);
    }
    
    container.register(DI.Runtime.NamespaceLockHandle, { useValue: lockResult.value });
    container.register(DI.Runtime.NamespaceLock, { useValue: lockPort });
  }
  ```

Updated initialization order in `initializeContainer()`:
  ```ts
  registerRuntime(options);
  await registerConfig();
  await registerNamespaceLock();  // NEW: after config, fail-fast on collision
  await registerStorageChain();
  await registerV2Services();
  await registerServices();
  ```

**Files to change:**
- `src/di/service-scope.ts` (new) — phantom type definitions for compile-time scope enforcement
- `src/runtime/ports/workrail-paths.port.ts` (new) — includes `UserWorkflowsDirPath` and `CacheDirPath` brands
- `src/runtime/adapters/local-workrail-paths.ts` (new) — implements `userWorkflowsDir()` and `cacheDir()`
- `src/runtime/ports/namespace-lock.port.ts` (new) — with nonce field in lock file
- `src/runtime/adapters/local-namespace-lock.ts` (new)
- `src/runtime/ports/process-info.port.ts` (new) — add `isProcessSuspended()`, `generateNonce()`
- `src/runtime/adapters/node-process-info.ts` (new) — implement platform-specific suspended detection
- `src/config/app-config.ts` (add branded path types, or in separate file)
- `src/di/tokens.ts`
- `src/di/container.ts`
- New test: `tests/unit/runtime/workrail-paths.test.ts`
- New test: `tests/unit/runtime/namespace-lock.test.ts`
- New test: `tests/unit/runtime/process-suspended.test.ts`
- New test: `tests/unit/di/phantom-types.test.ts`

**Estimated Effort:** 1.5 days (was 1 day; added suspended detection + phantom types)

### Slice 3 — Remove v1 hardcoded paths (stop bleed)
**Goal:** make v1 SessionManager, HttpServer, and workflow storage use the paths port instead of hardcoding `~/.workrail/...`.

**Changes:**

**3a. Session infrastructure:**
- `src/infrastructure/session/SessionManager.ts`:
  - remove: `this.sessionsRoot = path.join(os.homedir(), '.workrail', 'sessions');`
  - inject: `WorkRailPathsPort`
  - use: `this.sessionsRoot = this.paths.sessionsRoot();`
- `src/infrastructure/session/HttpServer.ts`:
  - remove: `this.lockFile = path.join(os.homedir(), '.workrail', 'dashboard.lock');`
  - inject: `WorkRailPathsPort`
  - use: `this.lockFile = this.paths.dashboardLockPath();`

**3b. Workflow storage:**
- `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`:
  - add constructor parameter: `paths: WorkRailPathsPort | null = null`
  - replace `getUserWorkflowsPath()`: return `this.paths?.userWorkflowsDir() ?? path.join(os.homedir(), '.workrail', 'workflows')`
  - replace hardcoded cache path: use `this.paths?.cacheDir() ?? path.join(os.homedir(), '.workrail', 'cache')`
  - when creating `GitWorkflowStorage`, pass `cacheDir` from paths port
- `src/infrastructure/storage/git-workflow-storage.ts`:
  - extend `GitWorkflowConfig` with optional `cacheDir?: string`
  - in `validateAndNormalizeConfig()`: use `config.cacheDir ?? path.join(os.homedir(), '.workrail', 'cache')`

**3c. Delete unused code:**
- Delete `src/utils/workflow-init.ts` — function `initializeUserWorkflowDirectory()` is never imported or called; verified via grep
- **Philosophy alignment:** "YAGNI with discipline" — dead code is removed, not commented out or deprecated
- No migration needed; no references exist in codebase

**DI wiring updates:**
- `src/di/container.ts` in `registerStorageChain()`:
  ```ts
  const paths = c.resolve<WorkRailPathsPort>(DI.Runtime.WorkRailPaths);
  return new EnhancedMultiSourceWorkflowStorage({}, featureFlags, paths);
  ```



**Tests:**
- Update existing session/dashboard tests if any assume hardcoded paths
- Update existing git storage tests to use fake paths port for isolation
- Add integration test showing:
  - with namespace set: session file is created under `namespaces/<ns>/sessions/...`
  - with namespace set: git cache is created under `namespaces/<ns>/cache/...`

**Files to change:**
- `src/infrastructure/session/SessionManager.ts`
- `src/infrastructure/session/HttpServer.ts`
- `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`
- `src/infrastructure/storage/git-workflow-storage.ts`
- `src/utils/workflow-init.ts` (delete)
- `docs/features/save-flow-analysis.md`
- `src/di/container.ts`

### Slice 4 — Bridge v2 to the namespaced home

**Goal:** make v2 `LocalDataDirV2` derive its root from the namespaced home.

**Changes:**
- `src/di/container.ts` in `registerV2Services()`:
  ```ts
  const paths = container.resolve<WorkRailPathsPort>(DI.Runtime.WorkRailPaths);
  const homeDir = paths.homeDir();
  const v2DataRoot = paths.v2DataRoot();
  
  container.register(DI.V2.DataDir, {
    useFactory: instanceCachingFactory(() => new LocalDataDirV2({ 
      WORKRAIL_DATA_DIR: v2DataRoot,
      WORKRAIL_GLOBAL_KEYS_DIR: path.join(homeDir, 'keys'),  // Keyring outside namespace (Lock 3)
    })),
  });
  ```
  - Pass both `WORKRAIL_DATA_DIR` (namespace-scoped) and `WORKRAIL_GLOBAL_KEYS_DIR` (global)
  - Pure: DI wiring is deterministic from validated config

**DataDirPortV2 interface extension required:**
Add global path methods to `src/v2/ports/data-dir.port.ts`:
```ts
// Global paths (outside namespace tree, per Lock 3)
globalKeysDir(): string;      // → <home>/keys
globalKeyringPath(): string;  // → <home>/keys/keyring.json
```

Update `LocalDataDirV2` to implement these methods using `WORKRAIL_GLOBAL_KEYS_DIR`.
Update `LocalKeyringV2` to use `globalKeyringPath()` instead of `keyringPath()`.

**Keyring migration: Hard break (no auto-migration)**
- Old keyring location: `~/.workrail/data/keys/keyring.json` (ORPHANED)
- New keyring location: `~/.workrail/keys/keyring.json` (CREATED FRESH)
- **Philosophy alignment:** "No deprecation or backwards compatibility unless specified"
- Existing tokens from v1 will be invalidated (expected behavior for test isolation)
- Error message if old keyring referenced: "Keyring not found. Creating new keyring at global location. Existing v1 tokens are invalidated."

**Tests:**
- Unit test showing v2 data root is `~/.workrail/namespaces/<ns>/data` for the given namespace
- Unit test verifying keyring is at `~/.workrail/keys/keyring.json` regardless of namespace
- Integration test: old keyring exists but ignored; new keyring created

**Files to change:**
- `src/di/container.ts`
- `src/v2/ports/data-dir.port.ts` (add `globalKeysDir()`, `globalKeyringPath()`)
- `src/v2/infra/local/data-dir/index.ts` (implement global keys methods)
- `src/v2/infra/local/keyring/index.ts` (use `globalKeyringPath()` instead of `keyringPath()`)

### Slice 5 — Lock and invariant verification tests
**Goal:** prove that design locks and invariants hold through automated tests; demonstrate namespace isolation.

**5a. Architecture tests (Lock 2 enforcement):**
- `tests/architecture/no-hardcoded-workrail-paths.test.ts`:
  - Grep `src/infrastructure/**` and `src/v2/**` for `os.homedir()` and `~/.workrail`
  - Fail if found outside `app-config.ts` and `container.ts`

**5b. Lock verification tests:**
- `tests/unit/runtime/workrail-paths-locks.test.ts`:
  - **Lock 3:** Golden assertion of directory structure under `<home>/namespaces/<ns>/`
  - **Lock 4:** Assert namespace validation rejects empty string and reserved names
  - **Lock 11:** Acquire namespace lock, verify `.namespace.lock` file exists with correct contents
  - **Lock 11:** Release namespace lock, verify file deleted
  - **Lock 11:** Attempt acquire on already-owned namespace, verify `namespace_in_use` error

**5c. Invariant verification tests:**
- `tests/unit/runtime/workrail-paths-invariants.test.ts`:
  - **Invariant 1 (disjointness):** Property-based test — generate N random namespaces, assert all paths disjoint
  - **Invariant 2 (determinism):** Call each port method 100x with same config, assert identical results
  - **Invariant 3 (containment):** For namespaced config, all paths start with `<home>/namespaces/<ns>/`
  - **Invariant 5 (config-to-path):** Fuzz valid configs, assert port construction never throws
  - **Invariant 11 (ownership):** Two processes target same namespace; exactly one succeeds; kill winner; loser can now acquire

**5d. Namespace pattern tests (Invariant 6):**
- `tests/unit/config/namespace-pattern.test.ts`:
  - Valid: `test-1`, `a`, `abc123`, `my-namespace`, `a1b2c3`
  - Invalid format: `Test-1` (uppercase), `-start` (leading hyphen), `end-` (trailing hyphen), `has space`, `über` (non-ASCII), empty string, `a--b` (consecutive hyphens - decide: allow or reject)
  - Reserved names (ConfigValidationError.namespace_reserved): 
    - **Reserved names:** `global`, `default`, `namespaces` (reserved to prevent confusion)
    - **Path safety:** `namespaces` (would create `namespaces/namespaces/`), `.`, `..` (path traversal)
    - **Semantic conflicts:** `none`, `null`, `undefined`, `test`, `prod`, `dev` (common but ambiguous)
    - **System names:** `tmp`, `temp`, `cache`, `data`, `sessions`, `workflows` (directory names)

**5e. Integration test (isolation proof):**
- `tests/integration/test-isolation-mode.test.ts`:
  - Configure two DI containers with different namespaces
  - Create a session in each
  - Verify session files exist in different dirs
  - Verify no lock contention
  - Verify v2 event logs are in separate directories

**5f. Test fake:**
- `tests/fakes/runtime/in-memory-workrail-paths.ts`:
  - `InMemoryWorkRailPaths` fake for use in unit tests that need path isolation without filesystem
  - Must implement all path methods: `sessionsRoot()`, `dashboardLockPath()`, `v2DataRoot()`, `userWorkflowsDir()`, `cacheDir()`, `activeNamespace()`
  - All paths always derive from `namespaceDir()` (no conditionals)
- `tests/helpers/fake-workrail-paths.ts`:
  - `createFakeWorkRailPaths(tempDir)` — creates paths port pointing to temp directory for test isolation
  - `createRealWorkRailPaths()` — creates paths port with real homedir for integration tests that don't need isolation

**5g. Namespace lock tests:**
- `tests/unit/runtime/namespace-lock.test.ts`:
  - Acquire on fresh namespace → `Ok(handle)`
  - Acquire on owned namespace → `Err(namespace_in_use)` with owner info
  - Acquire after owner crash (PID dead) → `Ok(handle)` (stale reclaim)
  - Release → `.namespace.lock` file removed
  - Lock file contains correct PID, hostname, startedAt
  - Corrupted lock file → `Err(lock_corrupted)`
  - Filesystem error → `Err(filesystem_error)`
  - Race during reclaim → `Err(lock_reclaim_race)`
- `tests/integration/namespace-collision.test.ts`:
  - Spawn child process with same namespace → child fails with `namespace_in_use`
  - Kill parent, respawn child → child succeeds
  - Verify error message includes parent's PID, hostname, startedAt

**5h. Edge case and platform tests:**
- `tests/unit/runtime/namespace-lock-edge-cases.test.ts`:
  - **PID reuse detection:** Mock lock file with old PID that's now reused by different process (different `startedAt`) → reclaim succeeds
  - **PID reuse same timestamp:** Mock lock file with old PID, same `startedAt` within 1s tolerance → treat as same process (don't reclaim)
  - **Namespace at 63-char boundary:** Create namespace with exactly 63 characters → succeeds; 64 chars → validation error
  - **Namespace with all valid chars:** `a1-b2-c3-d4` (mix of letters, digits, hyphens) → succeeds
- `tests/unit/runtime/process-info-platform.test.ts`:
  - **Windows EPERM handling:** Mock `process.kill` throwing EPERM → `isProcessAlive()` returns `true`
  - **ESRCH handling:** Mock `process.kill` throwing ESRCH → `isProcessAlive()` returns `false`
  - **getProcessStartTime unavailable:** Non-Linux platform → returns `null`, lock still works (fallback to PID-only)

**5i. Port derivation tests:**
- `tests/unit/runtime/dashboard-port.test.ts`:
  - **Primary port available:** Hash-derived port is free → returns that port
  - **Primary port in use:** Primary port occupied → fallback scan returns next available
  - **All ports exhausted:** All 6 ports (primary + 5 fallback) in use → `Err(all_ports_exhausted)`
  - **Determinism:** Same namespace → same primary port on 1000 calls

**5j. Lifecycle edge cases:**
- `tests/integration/namespace-lifecycle-edge-cases.test.ts`:
  - **SIGKILL cleanup:** Start process with ephemeral namespace, SIGKILL it (no `beforeExit`) → next process can reclaim (stale lock detection works)
  - **Home directory read-only:** Home dir becomes read-only after startup → graceful error on write operations
  - **Concurrent registry operations:** Parallel `create()` calls for different namespaces → all succeed (no interference)
  - **Destroy while in use:** Attempt `destroy()` on namespace with active lock → `Err(namespace_locked)`

**Files to create:**
- `tests/architecture/no-hardcoded-workrail-paths.test.ts`
- `tests/unit/runtime/workrail-paths-locks.test.ts`
- `tests/unit/runtime/workrail-paths-invariants.test.ts`
- `tests/unit/runtime/namespace-lock.test.ts`
- `tests/unit/config/namespace-pattern.test.ts`
- `tests/integration/test-isolation-mode.test.ts`
- `tests/integration/namespace-collision.test.ts`
- `tests/fakes/runtime/in-memory-workrail-paths.ts`
- `tests/fakes/runtime/fake-namespace-lock.ts`
- `tests/helpers/fake-workrail-paths.ts` (5f)
- `tests/unit/runtime/namespace-lock-edge-cases.test.ts` (5h)
- `tests/unit/runtime/process-info-platform.test.ts` (5h)
- `tests/unit/runtime/dashboard-port.test.ts` (5i)
- `tests/integration/namespace-lifecycle-edge-cases.test.ts` (5j)

### Slice 6 — Update manual test plan (ergonomics)
**Goal:** make the manual/agentic test plan match real MCP constraints.

**Changes:**
- Update `docs/testing/v2-slices-1-3-manual-test-plan.md` isolation contract:
  - Required: **new chat** + **fresh v2 session** per scenario (call `start_workflow` in each chat)
  - Required: **never reuse tokens across chats**
  - Optional (best-effort): if the operator can restart the server or inject env at process start, use a fresh `WORKRAIL_DATA_DIR` per run

**Files to change:**
- `docs/testing/v2-slices-1-3-manual-test-plan.md`

### Slice 7 — (Removed) Token namespace encoding
This slice is intentionally removed.

Rationale:
- In real MCP environments, WorkRail cannot safely infer per-chat identity.
- v2 tokens are locked to a stable payload/signature shape (no namespace field).
- Scenario isolation is achieved by **fresh v2 sessions** and **no token reuse across chats**.

### Slice 8 — Deterministic port derivation
**Goal:** Derive dashboard port deterministically from namespace with fallback on collision.

**Changes:**
- `src/runtime/ports/dashboard-port.port.ts` (new):
  ```ts
  interface DashboardPortDeriver {
    /**
     * Derive a dashboard port for the given namespace.
     * Returns Result to handle port exhaustion (errors-as-data).
     */
    derivePort(ns: NamespaceConfig): Result<DashboardPort, PortDerivationError>;
  }
  
  interface PortChecker {
    isPortAvailable(port: number): Promise<boolean>;
  }
  ```
- `src/runtime/adapters/hash-dashboard-port.ts` (new):
  ```ts
  export class HashDashboardPortDeriver implements DashboardPortDeriver {
    private static readonly PORT_RANGE = 256;  // NEW (was 43)
    private static readonly FALLBACK_SCAN_COUNT = 5;
    
    constructor(
      private readonly basePort: number = 3456,
      private readonly portChecker: PortChecker,
    ) {}
    
    async derivePort(ns: NamespaceId): Promise<Result<DashboardPort, PortDerivationError>> {
      // Hash-based derivation (3456-3711, 256 ports)
      const hash = sha256(ns);
      const offset = parseInt(hash.slice(0, 8), 16) % HashDashboardPortDeriver.PORT_RANGE;
      const primaryPort = this.basePort + offset;
      
      if (await this.portChecker.isPortAvailable(primaryPort)) {
        return ok(primaryPort as DashboardPort);
      }
      
      // Fallback: linear scan next 5 ports
      for (let i = 1; i <= HashDashboardPortDeriver.FALLBACK_SCAN_COUNT; i++) {
        const fallbackPort = primaryPort + i;
        if (fallbackPort > this.basePort + HashDashboardPortDeriver.PORT_RANGE) continue; // stay in range
        if (await this.portChecker.isPortAvailable(fallbackPort)) {
          return ok(fallbackPort as DashboardPort);
        }
      }
      
      // All ports exhausted
      return err({
        kind: 'all_ports_exhausted',
        basePort: this.basePort,
        scannedCount: HashDashboardPortDeriver.FALLBACK_SCAN_COUNT + 1,
        namespace: ns.id,
      });
    }
  }
  ```
- `src/infrastructure/session/HttpServer.ts`:
  - Inject `DashboardPortDeriver`
  - Handle `PortDerivationError` at startup (fail-fast with clear message)

**Port availability check:** Uses `net.createServer().listen()` to test if port is available. This is synchronous during startup (acceptable latency).

**Tests:**
- `derivePort('test-1')` → same value on 1000 calls (deterministic)
- Two different namespaces → different ports (high probability)
- Port collision → fallback scan returns next available
- All ports exhausted → `Err({ kind: 'all_ports_exhausted', ... })`

**Files to change:**
- `src/runtime/ports/dashboard-port.port.ts` (new)
- `src/runtime/adapters/hash-dashboard-port.ts` (new)
- `src/infrastructure/session/HttpServer.ts`
- `src/di/tokens.ts`
- `src/di/container.ts`
- `tests/unit/runtime/dashboard-port.test.ts` (new)

### Slice 9 — Scoped DI container factory
**Goal:** Create child DI containers per namespace for true isolation.

**Changes:**
- `src/di/namespace-container.ts` (new):
  ```ts
  import { NamespaceScopedToken, ApplicationScopedToken } from '../di/service-scope.js';
  
  export async function createNamespaceContainer(
    root: DependencyContainer,
    ns: NamespaceConfig,
    mode: NamespaceMode
  ): Promise<DependencyContainer> {
    const child = root.createChildContainer();
    
    // Type-safe registration (compile-time enforced)
    function registerScoped<T>(
      token: NamespaceScopedToken<T>,
      factory: (c: DependencyContainer) => T
    ): void {
      child.register(token, { useFactory: instanceCachingFactory(factory) });
    }
    
    // Register namespace-scoped services
    const config = root.resolve<ValidatedConfig>(DI.Config.App);
    const paths = new LocalWorkRailPaths(config.paths.homeDir, ns);
    
    registerScoped(DI.Namespace.Config, () => ns);
    registerScoped(DI.Namespace.Mode, () => mode);
    registerScoped(DI.Namespace.Paths, () => paths);
    
    // Build NamespaceContext
    registerScoped(DI.Namespace.Context, (c) => {
      return new DefaultNamespaceContext(
        c.resolve(DI.Namespace.Config),
        c.resolve(DI.Namespace.Mode),
        c.resolve(DI.Namespace.Paths)
      );
    });
    
    return child;
  }
  ```
- `src/di/tokens.ts`:
  - Add `DI.Namespace.*` tokens for scoped services
  - Brand all tokens with scope: `ApplicationScopedToken` or `NamespaceScopedToken`

**Tests:**
- Create two child containers with different namespaces
- Resolve `NamespaceContext` from each → different values
- Services from container A can't see container B's registrations

**Files to change:**
- `src/di/namespace-container.ts` (new)
- `src/di/tokens.ts`
- `tests/unit/di/namespace-container.test.ts` (new)

**Estimated Effort:** 1 day (was 0.5 days; added phantom type wiring)

### Slice 10 — Namespace lifecycle modes
**Goal:** Implement ephemeral, sliding, and persistent lifecycle modes.

**Dependency direction (avoiding circular dependency with Slice 11):**
- `NamespaceLifecycleManager` is a **pure timer/scheduler** — it tracks heartbeats and schedules cleanup callbacks
- `NamespaceRegistry` is the **coordinator** — it owns lifecycle manager and calls it during create/destroy
- Lifecycle manager does NOT call registry directly; it invokes a cleanup callback provided at creation time
- This breaks the cycle: Registry → LifecycleManager (dependency), LifecycleManager → callback (inversion)

**Changes:**
- `src/runtime/namespace-lifecycle.ts` (new):
  ```ts
  // Heartbeat configuration (locked)
  const HEARTBEAT_INTERVAL_MS = 30_000;  // 30 seconds
  const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;  // 5 minutes
  
  // Callback for cleanup (provided by registry, avoiding circular dep)
  type CleanupCallback = (ns: NamespaceId) => Promise<void>;
  
  interface NamespaceLifecycleManager {
    // Heartbeat for liveness detection
    // Updates <namespace>/heartbeat.json every HEARTBEAT_INTERVAL_MS (30s)
    startHeartbeat(ns: NamespaceId): void;
    stopHeartbeat(ns: NamespaceId): void;
    
    // Cleanup based on mode (invokes callback when cleanup is due)
    scheduleCleanup(ns: NamespaceId, mode: NamespaceMode, onCleanup: CleanupCallback): void;
    cancelCleanup(ns: NamespaceId): void;
    
    // Check if namespace should be cleaned up
    // Returns true if no heartbeat update for > STALENESS_THRESHOLD_MS (5 min)
    isStale(ns: NamespaceId): Promise<boolean>;
  }
  ```

**Heartbeat file structure:**
```json
{
  "pid": 12345,
  "lastUpdate": "2025-01-01T12:05:00.000Z"
}
```

**Staleness algorithm:**
1. Read `<namespace>/heartbeat.json`
2. If file missing → stale
3. If `Date.now() - lastUpdate > STALENESS_THRESHOLD_MS` → stale
4. Otherwise → alive
- Ephemeral cleanup: on process exit (via `beforeExit` handler)
- Sliding cleanup: background timer checks TTL + staleness

**Ephemeral crash recovery (SIGKILL/power loss):**
The `beforeExit` handler doesn't fire on SIGKILL or system crash. Orphaned ephemeral namespaces are recovered via **stale lock detection** (Decision 5a, Lock 11):
- Next process attempting to use that namespace sees the `.namespace.lock` file
- PID liveness check detects the owner is dead
- Lock is reclaimed automatically; namespace becomes usable
- **Trade-off:** orphaned namespace directories remain on disk until explicitly destroyed or reclaimed. This is acceptable because:
  - Disk space impact is bounded (test namespaces are small)
  - Correctness is preserved (no data corruption)
  - Automatic reclaim happens on next use
- For CI environments with many ephemeral namespaces, consider periodic `rm -rf <home>/namespaces/` cleanup between CI runs (operator responsibility, not system behavior)

**Integration with Registry (Slice 11):**
```ts
// In LocalNamespaceRegistry.create():
const context = this.buildContext(ns, mode, lockHandle);
this.lifecycleManager.scheduleCleanup(ns, mode, async (ns) => {
  await this.destroy(ns);  // Registry's own destroy method
});
return ok(context);
```

**Tests:**
- Ephemeral namespace deleted on process exit
- Sliding namespace deleted after TTL when stale
- Persistent namespace not auto-deleted
- Heartbeat keeps sliding namespace alive
- Cleanup callback invoked with correct namespace ID

**Files to change:**
- `src/runtime/namespace-lifecycle.ts` (new)
- `src/runtime/adapters/local-namespace-lifecycle.ts` (new)
- `tests/unit/runtime/namespace-lifecycle.test.ts` (new)

### Slice 11 — NamespaceRegistry implementation
**Goal:** Implement namespace discovery, creation, and destruction with concurrency safety.

**Changes:**
- `src/runtime/ports/namespace-registry.port.ts` (new):
  ```ts
  interface NamespaceRegistry {
    listNamespaces(): Promise<readonly NamespaceId[]>;
    exists(ns: NamespaceId): Promise<boolean>;
    create(ns: NamespaceId, mode: NamespaceMode): Promise<Result<NamespaceContext, NamespaceRegistryError>>;
    destroy(ns: NamespaceId): Promise<Result<void, NamespaceRegistryError>>;
    getContext(ns: NamespaceId): Promise<Result<NamespaceContext, NamespaceRegistryError>>;
  }
  ```
- `src/runtime/adapters/local-namespace-registry.ts` (new):
  - `listNamespaces()`: enumerate `<home>/namespaces/*/`
  - `exists()`: check `<home>/namespaces/<ns>/` exists
  - `create()`: mkdir + namespace.json + child container
  - `destroy()`: rm -rf `<home>/namespaces/<ns>/`
  - `getContext()`: build context from existing namespace

**Concurrency safety:**
Registry operations are protected by per-namespace locking:
- **create/destroy/getContext:** acquire namespace lock (Lock 11) before mutation
- **listNamespaces/exists:** read-only, no lock needed (eventual consistency acceptable)
- **Rationale:** namespace lock (`.namespace.lock`) already exists for collision detection; reuse it for registry operations rather than adding a separate mutex
- **Concurrent create on same namespace:** second caller gets `Err({ kind: 'namespace_already_exists' })` (atomic via O_EXCL)
- **Concurrent destroy while in use:** second caller gets `Err({ kind: 'namespace_locked', owner: ... })`

```ts
export class LocalNamespaceRegistry implements NamespaceRegistry {
  constructor(
    private readonly homeDir: AbsoluteWorkRailHomeDir,
    private readonly lockPort: NamespaceLockPort,
  ) {}
  
  async create(ns: NamespaceId, mode: NamespaceMode): Promise<Result<NamespaceContext, NamespaceRegistryError>> {
    // Acquire namespace lock first (atomic via Lock 11)
    const lockResult = this.lockPort.acquire(ns);
    if (lockResult.kind === 'err') {
      if (lockResult.error.kind === 'namespace_in_use') {
        return err({ kind: 'namespace_already_exists', id: ns });
      }
      return err({ kind: 'create_failed', id: ns, reason: lockResult.error.kind });
    }
    
    // Lock acquired — safe to create directory structure
    try {
      await this.createNamespaceDir(ns, mode);
      return ok(this.buildContext(ns, mode, lockResult.value));
    } catch (e) {
      // Cleanup on failure
      this.lockPort.release(lockResult.value);
      return err({ kind: 'create_failed', id: ns, reason: String(e) });
    }
  }
}
```

**Tests:**
- `listNamespaces()` returns empty initially
- `create('test-1')` → `exists('test-1')` = true
- `destroy('test-1')` → `exists('test-1')` = false
- `destroy()` is idempotent
- `getContext()` for non-existent returns `Err({ kind: 'namespace_not_found' })`
- **Concurrent create same namespace** → exactly one succeeds, other gets `namespace_already_exists`
- **Destroy while locked** → `Err({ kind: 'namespace_locked' })`

**Files to change:**
- `src/runtime/ports/namespace-registry.port.ts` (new)
- `src/runtime/adapters/local-namespace-registry.ts` (new)
- `src/di/tokens.ts`
- `src/di/container.ts`
- `tests/unit/runtime/namespace-registry.test.ts` (new)

### Slice 12 — Benchmarking support (cross-namespace read)
**Goal:** Enable cross-namespace metric comparison for benchmarking.

**Changes:**
- Extend `NamespaceRegistry`:
  ```ts
  interface NamespaceRegistry {
    // ... existing methods
    
    // Benchmarking support
    getMetrics(ns: NamespaceId): Promise<NamespaceMetrics>;
    compareNamespaces(correlationId: string): Promise<BenchmarkComparison>;
    streamMetrics(correlationId: string, onMetric: (m: NamespaceMetrics) => void): () => void;
  }
  ```
- `NamespaceMetrics`:
  ```ts
  interface NamespaceMetrics {
    namespaceId: NamespaceId;
    correlationId: string;
    executionTime: number;
    successCount: number;
    failureCount: number;
    customMetrics: Record<string, unknown>;
  }
  ```
- Correlation ID links benchmark runs across namespaces
- Read-only: comparison doesn't modify namespaces

**Tests:**
- Create two namespaces with same correlationId
- Run workflows in each
- `compareNamespaces(correlationId)` returns both
- Read operations don't modify namespace state

**Files to change:**
- `src/runtime/ports/namespace-registry.port.ts` (extend)
- `src/runtime/adapters/local-namespace-registry.ts` (extend)
- `tests/unit/runtime/benchmarking.test.ts` (new)

### Slice 13 — Philosophy Compliance Verification

**Goal:** Verify all philosophy alignment constraints through automated tests.

**Changes:**

**13a. Determinism Tests**
- `tests/philosophy/determinism.test.ts`:
  - Path resolution is pure (100 calls → identical results)
  - No filesystem probing in path methods
  - Lock validity is state-based (not time-based)
  - Port derivation is deterministic

**13b. Type Safety Tests**
- `tests/philosophy/type-safety.test.ts`:
  - Create file with wrong-scoped registrations
  - Verify `tsc` compilation fails
  - Test phantom type enforcement

**13c. Fail-Fast Tests**
- `tests/philosophy/fail-fast.test.ts`:
  - NFS detection fails immediately (no override)
  - Missing namespace fails at startup (not runtime)
  - Invalid config fails at boundary (not deep in services)

**13d. No Hidden State Tests**
- `tests/philosophy/no-hidden-state.test.ts`:
  - Path resolution doesn't mutate state
  - No temporal coupling (behavior doesn't change over time)
  - No filesystem checks in deterministic functions

**Files to create:**
- `tests/philosophy/determinism.test.ts`
- `tests/philosophy/type-safety.test.ts`
- `tests/philosophy/fail-fast.test.ts`
- `tests/philosophy/no-hidden-state.test.ts`

**Estimated Effort:** 1 day

## Design constraints (alignment with philosophy)

This design respects the core philosophy:

- **Immutability by default:** path layout is pure/deterministic from config; no runtime mutation.
- **Architectural fix over patches:** removes v1 hardcoded paths (root cause) instead of patching test scripts.
- **Validate at boundaries, trust inside:** config is validated once at `app-config.ts`; services consume typed values.
- **Capability-based:** only composition root reads env; services inject the paths port.
- **Small, focused interfaces:** `WorkRailPathsPort` has 6 methods (sessions, lock, v2 data, workflows, cache, namespace); focused on path derivation only.
- **Errors as data:** invalid config (bad namespace pattern, relative home path, NFS) produces typed errors.
- **Determinism:** same config → same paths; no hidden state; no filesystem probing; lock validity is state-based (not time-based).
- **Closed sets where meaning matters:** namespace pattern is DNS-safe (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?`), not freeform strings.
- **Type safety as first line of defense:** phantom types enforce service scope at compile time; wrong registrations fail `tsc`.
- **Fail fast with meaningful errors:** NFS detection rejects immediately; missing namespace fails at startup; no operator overrides that hide problems.

## Key risks + mitigations

### Risk 1 — Namespace collision (same namespace, two processes)
**Mitigation:** 
- **Lock-based detection (Lock 11):** namespace lock file acquired atomically at startup via `O_EXCL`; second process fails-fast with `namespace_in_use` error.
- **Clear diagnostics:** error includes owning PID, hostname, start time, nonce for debugging.
- **Automatic stale recovery:** if owning process crashed/suspended/reused, lock reclaimed via 3-layer validation (PID liveness + suspended state + start time/nonce).
- **No operator coordination:** collision handled entirely by the system.

### Risk 2 — Scattered env reads regressing (services bypass config)
**Mitigation:** scoped DI containers with phantom types enforce isolation at compile time; architecture tests verify no direct env reads.

### Risk 3 — Port collision (hash-based derivation)
**Mitigation:** 0.96% collision probability with 100 namespaces (256-port range); fallback linear scan on collision; clear error if all ports exhausted.

### Risk 4 — Lifecycle mode complexity
**Mitigation:** three simple modes with clear semantics; heartbeat-based staleness detection prevents orphaned namespaces; grace period before deletion.

### Risk 5 — Scoped container overhead
**Mitigation:** child containers are lightweight; one-time creation per namespace; services resolved lazily.

## Philosophy-Aligned Design Decisions

This design incorporates feedback from philosophy alignment analysis. The following decisions were made to maximize alignment with functional programming principles:

### 1. Hard Breaks Over Backward Compatibility

**Decision:** No migration code for v1→v2 token transition or keyring relocation.

**Rationale:**
- Philosophy: "No deprecation or backwards compatibility unless specified"
- V1 tokens and keyrings are ephemeral by nature (test sessions)
- Migration code adds complexity without meaningful value
- Clear error messages provide remediation path

**Impact:**
- Existing keyrings at `~/.workrail/data/keys/keyring.json` → orphaned
- New keyrings created at `~/.workrail/keys/keyring.json`
- V1 tokens → `version_unsupported` error with actionable message

### 2. State-Based Lock Validity (No Timeouts)

**Decision:** Remove time-based staleness from `HttpServer.shouldReclaimLock()`. Lock validity determined purely by process state.

**Rationale:**
- Philosophy: "Determinism over cleverness" + "Control flow from data state"
- Time-based logic is non-deterministic (same lock, different validity at t₀ vs t₁)
- Process state (alive/dead/suspended/reused) is explicit and deterministic

**Implementation:**
```typescript
// REMOVED: if (ageMinutes > 2) { reclaim(); }
// ADDED: Three-layer state validation (PID liveness, suspended, reuse)
```

### 3. Allowlist Pattern for Namespaces

**Decision:** Use `^[a-z][a-z0-9-]{0,61}[a-z0-9]$` allowlist pattern, not blocklist of reserved names.

**Rationale:**
- Philosophy: "Make illegal states unrepresentable" + "Reduce path explosion"
- Allowlist excludes invalid states by construction
- No need to enumerate every reserved word
- Pattern automatically prevents: numeric-only, underscore-prefix, path traversal

**Impact:**
- Can't create namespace `123`, `_hidden`, `global`, `.`, etc. (pattern rejects)
- Smart constructor with Result type enforces at boundary

### 4. Smart Constructors for Domain Types

**Decision:** `parseNamespaceId(string) → Result<NamespaceId, Error>` is only way to create valid namespace.

**Rationale:**
- Philosophy: "Prefer explicit domain types over primitives" + "Validate at boundaries"
- Raw strings can be malformed; branded types prove validation happened
- Token signature binding requires NamespaceId, preventing accidental raw string usage

**Implementation:**
```typescript
// Can't do this:
signToken("test-1", ...)  // ❌ Compile error

// Must do this:
const ns = parseNamespaceId("test-1");
if (ns.kind === 'ok') signToken(ns.value, ...)  // ✅
```

### 5. Platform-Specific Error Variants

**Decision:** Distinct `namespace_in_use_windows_caveat` error variant (not string message).

**Rationale:**
- Philosophy: "Exhaustiveness everywhere" + "Errors are data"
- Platform limitations encoded in type system, not buried in strings
- Exhaustive matching forces proper handling

**Implementation:**
```typescript
type NamespaceLockError =
  | { kind: 'namespace_in_use'; ... }
  | { kind: 'namespace_in_use_windows_caveat'; lockPath: string; ... }  // Distinct variant
```

### 6. Capability-Based Lock File Interface

**Decision:** `DashboardHeartbeat` receives `LockFileCapability`, not raw file path.

**Rationale:**
- Philosophy: "Capability-based architecture" + "Keep interfaces small and focused"
- Heartbeat can only read/write lock file (can't access other paths)
- Interface segregation: minimal surface area

**Implementation:**
```typescript
interface LockFileCapability {
  readonly lockFilePath: string;
  readLockFile(): Promise<Result<...>>;
  writeLockFile(data): Promise<Result<...>>;
}
```

### 7. Structured Errors with Resolutions

**Decision:** Filesystem safety errors include structured `resolution` field with actionable steps.

**Rationale:**
- Philosophy: "Errors are data" + "Observability as a constraint"
- Error provides both diagnostic info AND remediation
- Machine-readable resolution (not just human-readable message)

**Implementation:**
```typescript
type FilesystemSafetyError = {
  kind: 'network_fs_suspected';
  path: string;
  device: number;
  resolution: {
    suggestion: string;
    command: string;
    reportUrl: string;
  };
};
```

### 8. Delete Dead Code (No Deprecation)

**Decision:** Delete `src/utils/workflow-init.ts` immediately (verified unused via grep).

**Rationale:**
- Philosophy: "YAGNI with discipline"
- Dead code is removed, not commented or deprecated
- No "just in case" speculative keeping

**Verification:** `grep -r "workflow-init" src/` → no matches

## Philosophy Compliance Testing Strategy

This section documents tests that explicitly verify alignment with functional programming principles.

### Test Category: Determinism

**File:** `tests/philosophy/determinism.test.ts`

**Tests:**
1. **Path resolution is pure** - Identical config → identical paths (100 calls)
2. **No filesystem probing** - Path methods perform zero I/O operations
3. **Lock validity is state-based** - Lock validity determined by PID state, not time elapsed
4. **Port derivation is deterministic** - Same namespace → same port (1000 calls)

### Test Category: Type Safety

**File:** `tests/philosophy/type-safety.test.ts`

**Tests:**
1. **Compile-time scope enforcement** - Wrong-scoped registrations fail `tsc` compilation
2. **Branded types prevent mixing** - Cannot use `SessionsRootPath` as `LockFilePath`

### Test Category: Fail-Fast

**File:** `tests/philosophy/fail-fast.test.ts`

**Tests:**
1. **NFS detection fails immediately** - No override environment variable exists
2. **Missing namespace fails at startup** - Container initialization rejects unset namespace
3. **Invalid config fails at boundary** - Config validation catches errors before services load

### Test Category: No Hidden State

**File:** `tests/philosophy/no-hidden-state.test.ts`

**Tests:**
1. **Path resolution doesn't mutate** - Calling path methods doesn't change object state
2. **No temporal coupling** - Path resolution at t=0 equals t=1h
3. **No filesystem checks** - Path methods work without filesystem

### Integration with CI

**Script:** `tests/philosophy/verify-type-safety.sh`
```bash
#!/bin/bash
# Verify compile-time type safety enforcement

npx tsc tests/philosophy/type-safety-violations.ts --noEmit 2>&1 | grep "is not assignable"

if [ $? -eq 0 ]; then
  echo "✅ Type safety enforced"
  exit 0
else
  echo "❌ Type safety VIOLATED"
  exit 1
fi
```

## Verification (how we know it works)

### Unit tests (config + paths)
- Config parsing succeeds/fails as expected
- Path derivation is deterministic and correct for all combinations
- Token namespace encoding/decoding round-trips correctly
- Port derivation is deterministic for same namespace

### Invariant tests
- Namespace path disjointness (property-based)
- Token namespace binding (cross-namespace validation fails)
- Port disjointness (different namespaces → different ports)
- Lifecycle consistency (create/destroy idempotent)

### Integration tests
- Two namespaces produce disjoint session/lock/data dirs
- v1 sessions + v2 event logs don't collide
- Tokens minted in namespace A fail in namespace B
- Scoped containers isolate services correctly
- Lifecycle modes behave as specified (ephemeral, sliding, persistent)

### Benchmarking tests
- Cross-namespace read doesn't modify source namespace
- Correlation ID links related namespace runs
- Metrics comparison returns correct aggregations

### Philosophy compliance tests (Slice 13)
- Determinism: Path resolution is pure; lock validity is state-based
- Type safety: Phantom types enforce scope at compile time
- Fail-fast: NFS detection; missing namespace; invalid config
- No hidden state: No filesystem probing; no temporal coupling

### Manual validation (before declaring "done")
- Run the v2 manual test plan with `WORKRAIL_NAMESPACE=chat-1-happy`, `chat-2-fork`, etc.
- Verify no cross-chat token/session bleed
- Verify deterministic port allocation
- Verify cleanup is just `rm -rf <home>/namespaces/<ns>` (no scattered state)
- Verify benchmarking comparison works across namespaces

## Implementation sequencing (required order)

```
Phase 1: Foundation (Slices 1-2)
┌─────────────────────────────────────────────────┐
│ Slice 1: Config schema + validation             │
│    ↓                                            │
│ Slice 2: WorkRailPathsPort + local adapter      │
└─────────────────────────────────────────────────┘

Phase 2: Core Extensions (Slices 7-8, parallel)
┌─────────────────────────────────────────────────┐
│ Slice 7: Token namespace encoding               │
│ Slice 8: Deterministic port derivation          │
│    (can run in parallel)                        │
└─────────────────────────────────────────────────┘

Phase 3: DI Architecture (Slice 9)
┌─────────────────────────────────────────────────┐
│ Slice 9: Scoped DI container factory            │
│    (depends on Slices 2, 7, 8)                  │
└─────────────────────────────────────────────────┘

Phase 4: Service Migration (Slices 3-4, parallel)
┌─────────────────────────────────────────────────┐
│ Slice 3: Remove v1 hardcoded paths              │
│ Slice 4: Bridge v2 to namespaced home           │
│    (can run in parallel, depend on Slice 9)    │
└─────────────────────────────────────────────────┘

Phase 5: Lifecycle (Slices 10-11, co-developed)
┌─────────────────────────────────────────────────┐
│ Slice 10: Namespace lifecycle modes             │
│ Slice 11: NamespaceRegistry implementation      │
│    (co-developed: callback inversion breaks     │
│     circular dep — see Slice 10 notes)          │
└─────────────────────────────────────────────────┘

Phase 6: Advanced Features (Slice 12)
┌─────────────────────────────────────────────────┐
│ Slice 12: Benchmarking support                  │
│    (depends on Slice 11)                        │
└─────────────────────────────────────────────────┘

Phase 7: Verification + Docs (Slices 5-6, 13)
┌─────────────────────────────────────────────────┐
│ Slice 5: Lock/invariant verification tests      │
│ Slice 6: Documentation updates                  │
│ Slice 13: Philosophy compliance tests           │
│    (run throughout, finalize at end)           │
└─────────────────────────────────────────────────┘
```

### Detailed sequencing

**Phase 1: Foundation**
1) Slice 1 (config) — validates inputs at boundary, NFS detection, namespace requirement
2) Slice 2 (paths port) — pure path derivation, phantom types, suspended detection

**Phase 2: Core Extensions** (parallel)
3) Slice 7 (token encoding) — namespace in token payload + signature
4) Slice 8 (port derivation) — deterministic port from namespace hash (256-port range)

**Phase 3: DI Architecture**
5) Slice 9 (scoped containers) — child containers per namespace with phantom types

**Phase 4: Service Migration** (parallel)
5) Slice 3 (v1 fix) — removes hardcoded paths
6) Slice 4 (v2 bridge) — unifies namespace

**Phase 5: Lifecycle** (co-developed)
7) Slice 10 (lifecycle modes) — ephemeral, sliding, persistent
8) Slice 11 (registry) — discovery, creation, destruction
   
   Note: These slices are co-developed because registry uses lifecycle manager, but lifecycle manager invokes cleanup via callback (not direct registry call). This callback inversion breaks the potential circular dependency. Implement lifecycle manager interface first (Slice 10), then wire into registry (Slice 11).

**Phase 6: Advanced Features**
9) Slice 12 (benchmarking) — cross-namespace read for comparison

**Phase 7: Verification + Docs**
10) Slice 5 (tests) — lock/invariant verification
    - 5a: Architecture tests (Locks 2, 9)
    - 5b: Lock verification tests (Locks 3, 4, 11)
    - 5c: Invariant verification tests (Invariants 1-13)
    - 5d: Namespace pattern tests (Invariant 6)
    - 5e: Integration test (isolation proof with token validation)
    - 5f: Test fakes for unit tests
11) Slice 6 (docs) — manual test plan updates
12) Slice 13 (philosophy tests) — determinism, type safety, fail-fast, no hidden state

### Estimated timeline

| Phase | Slices | Estimated Effort |
|-------|--------|------------------|
| 1 | 1-2 | 2.5 days (config + paths + phantom types + NFS + suspended) |
| 2 | 7-8 | 3 days (token v2 + port range 256) |
| 3 | 9 | 1 day (DI with phantom types) |
| 4 | 3-4 | 1-2 days (v1/v2 migration, parallel) |
| 5 | 10-11 | 2-3 days (lifecycle + registry) |
| 6 | 12 | 1-2 days (benchmarking) |
| 7 | 5, 13 | 4 days (locks/invariants + philosophy tests) |
| **Total** | | **~11 days (2.2 weeks)** |

**Changes from original estimate:**
- Added: Philosophy compliance tests (+1 day)
- Added: NFS detection + suspended process detection (+0.5 days)
- Added: Phantom types for compile-time safety (+0.5 days)
- Removed: Dual-read backward compat (-1 day)
- Net change: +1 day

Each slice is independently testable and maintains philosophy compliance.

## References

### Design documents
- WorkRail v2 design philosophy: `docs/plans/workrail-v2-design-resumption-pack.md`
- v2 core locks: `docs/design/v2-core-design-locks.md` §13 (data directory layout), §17 (architecture map)

### Current implementation (to be modified)
- v2 DataDir implementation: `src/v2/infra/local/data-dir/index.ts`
- Config validation: `src/config/app-config.ts`
- DI composition: `src/di/container.ts`
- SessionManager: `src/infrastructure/session/SessionManager.ts`
- HttpServer: `src/infrastructure/session/HttpServer.ts`
- Token minting: `src/v2/durable-core/tokens/` (no changes needed - isolation via storage)
- Workflow storage: `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`
- Git workflow storage: `src/infrastructure/storage/git-workflow-storage.ts`
- Unused workflow init: `src/utils/workflow-init.ts` (delete per Slice 3c)

### v2 integration points
- v2 keyring location: **NOT namespace-scoped** - lives at `<home>/keys/keyring.json`
- v2 token architecture: unchanged (see v2-core-design-locks.md §1.2)
- v2 data directory: namespace-scoped via `WORKRAIL_DATA_DIR` override in DI wiring
- v2 snapshots: per-namespace CAS (no global dedupe in namespaced mode)

### Related patterns
- Runtime ports pattern: `src/runtime/ports/*.ts`
- Runtime adapters pattern: `src/runtime/adapters/*.ts`
- Branded types: `src/runtime/brand.ts`

### Test patterns
- Architecture tests: `tests/architecture/`
- v2 unit tests: `tests/unit/v2/`
- Fakes: `tests/fakes/`
