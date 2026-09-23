/** Read-only canonical session discovery contract. */
/**
 * Minimum trusted canonical host-session discovery.
 * Reads canonical session journal/root/keyring from SharedAuthorityConfig.
 * Does not perform model inference, owner acquisition, dispatch, enrollment,
 * or index rebuild writes.
 * Host index is an optional non-authoritative cache; missing it cannot hide host enrollments.
 */
import type { SessionId } from '../../v2/durable-core/ids/index.js';
import type {
  HostJournalStorageConfig,
  PersistedHostPointer,
  RuntimeCloseResult,
  SharedAuthorityConfig,
} from './host-composition.js';

export const MAX_HOST_DISCOVERY_ENTRIES = 64;

declare const hostDiscoveryCursorBrand: unique symbol;

/**
 * Opaque cursor. The shared brand rejects raw callers, but does not distinguish
 * scanner instances; the runtime must validate that binding on every scan.
 * Cursors are reusable read positions, not consumable authority. Restarting a scan
 * does not revoke existing cursors; equivalent new cursor values may be issued.
 */
export type HostDiscoveryCursor = {
  readonly [hostDiscoveryCursorBrand]: never;
};

export type DiscoveryUnavailableReason =
  | 'missing'
  | 'corrupt'
  | 'unsupported_version'
  | 'storage_unavailable';

/**
 * Canonical host session enrollment validated from session journal.
 * Pointers are trusted-scheduler-only and never exposed in worker or console routes.
 * Snapshot is not authorization; does not steal live ownership or call recovery.
 */
type NoExecutionAuthority = Readonly<{ owner?: never; fence?: never; runner?: never; reply?: never; attempt?: never }>;

export type DiscoveredHostSession = NoExecutionAuthority & Readonly<{
  kind: 'host';
  sessionId: SessionId;
  pointer: PersistedHostPointer;
}>;

export type DiscoveredLegacySession = NoExecutionAuthority & Readonly<{
  kind: 'legacy';
  sessionId: SessionId;
}>;

export type DiscoveredUnboundSession = NoExecutionAuthority & Readonly<{
  kind: 'unbound';
  sessionId: SessionId;
}>;

export type DiscoveredUnavailableSession = NoExecutionAuthority & Readonly<{
  kind: 'unavailable';
  sessionId: SessionId;
  reason: DiscoveryUnavailableReason;
  detail: string;
}>;

export type DiscoveredSessionEntry =
  | DiscoveredHostSession
  | DiscoveredLegacySession
  | DiscoveredUnboundSession
  | DiscoveredUnavailableSession;

/**
 * Explicit page result: runtime enforces at most MAX_HOST_DISCOVERY_ENTRIES entries.
 * 'more' pages are guaranteed nonempty with a nextCursor.
 */
export type HostDiscoveryPage =
  | Readonly<{
      kind: 'more';
      entries: readonly [DiscoveredSessionEntry, ...DiscoveredSessionEntry[]];
      nextCursor: HostDiscoveryCursor;
    }>
  | Readonly<{
      kind: 'end';
      entries: readonly DiscoveredSessionEntry[];
    }>;

export type HostScanResult =
  | Readonly<{ kind: 'page'; page: HostDiscoveryPage }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_cursor' | 'scanner_closed'; detail: string }>
  | Readonly<{ kind: 'unavailable'; reason: DiscoveryUnavailableReason; detail: string }>
  | Readonly<{ kind: 'cancelled' }>;

/**
 * Trusted scanner interface.
 * Pagination uses fixed initial session-id enumeration per scanner first scan,
 * ordered lexicographically by UTF-16 code units (not locale-dependent collation).
 * undefined restarts at the first page of that enumeration; a new scanner refreshes it.
 * Session mutation after enumeration may give unavailable entries for known IDs,
 * avoiding repeat or unbounded endless scans.
 * Enumeration freezes only after a successful root read. A missing root is
 * unavailable/missing; an unreadable or non-directory root is unavailable/storage_unavailable.
 * Neither is an empty population. After repair the same scanner may retry enumeration.
 * An existing empty directory yields an end page with no entries.
 * Pre-cancelled calls on an open scanner return cancelled without consuming its
 * read position. Successful close is idempotent; later live-signal scans refuse
 * scanner_closed. Closing discovery never stops a canonical session.
 */
export interface HostSessionScanner {
  scan(cursor: HostDiscoveryCursor | undefined, signal: AbortSignal): Promise<HostScanResult>;
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

/**
 * Shared authority configuration for discovery.
 * Explicitly rejects wider model-, owner-, fence-, or dispatch-bearing configurations.
 */
export type HostDiscoveryConfig = SharedAuthorityConfig & Readonly<{
  model?: never;
  owner?: never;
  fence?: never;
  dispatch?: never;
  dispatcher?: never;
}>;

export type CreateHostDiscoveryResult =
  | Readonly<{ kind: 'created'; scanner: HostSessionScanner }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'unsupported_version' | 'missing_authority'; detail: string }>
  | Readonly<{ kind: 'cancelled' }>;

/** Proposed entrypoint at 'src/answer-v1/discovery.ts'.
 * Pre-cancelled construction returns cancelled. Construction validates existing
 * authority; absent configured keyring refuses missing_authority without creating
 * one. Root enumeration is deferred until scan, so a transient root failure is
 * retryable through that scanner rather than mistaken for an empty population.
 */

export type {
  HostJournalStorageConfig,
  PersistedHostPointer,
  RuntimeCloseResult,
  SessionId,
  SharedAuthorityConfig,
};
