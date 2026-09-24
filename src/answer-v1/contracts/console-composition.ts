/** Read-only composition seam for console answer-driven execution reader.
 * Runtime module 'src/answer-v1/console.ts'.
 */
import type {
  ConsoleSessionAnswerReader,
  ConsoleHostScopedAnswerReader,
  ConsoleReaderBinding,
} from './console-contract.js';
import type {
  SharedAuthorityConfig,
  RuntimeCloseResult,
} from './host-composition.js';
import type { HostEnrollment } from './invocation-contract.js';


export type ConsoleReadRuntimeRefusalReason =
  | 'storage_unavailable'
  | 'unsupported_version'
  | 'missing_authority'
  | 'corrupt'
  | 'cancelled';

export type CreateConsoleReadRuntimeResult =
  | Readonly<{
      kind: 'created';
      runtime: ConsoleReadRuntime;
    }>
  | Readonly<{
      kind: 'refused';
      runtime?: never;
      reason: ConsoleReadRuntimeRefusalReason;
      detail: string;
    }>;

export type BindConsoleHostRefusalReason =
  | 'missing'
  | 'corrupt'
  | 'unsupported_version'
  | 'storage_unavailable'
  | 'cancelled';

export type BindConsoleHostResult =
  | Readonly<{
      kind: 'bound';
      reader: ConsoleHostScopedAnswerReader;
    }>
  | Readonly<{
      kind: 'refused';
      reader?: never;
      reason: BindConsoleHostRefusalReason;
      detail: string;
    }>;

/** Reject wider host/model configurations, not only fresh excess-property literals. */
export type ConsoleReadConfig = SharedAuthorityConfig & Readonly<{
  model?: never; modelFactory?: never; faultSeam?: never; owner?: never; sessionId?: never; enrollment?: never;
}>;
/** Binding uses only the authentic enrollment; never a caller-supplied session pairing. */
export type ConsoleHostEnrollment = HostEnrollment & Readonly<{
  sessionId?: never; owner?: never;
}>;

/** Dedicated read-only runtime exposing unbound reader, authentic host binding, and explicit resource close.
 * Project canonical session truth. Scheduler acknowledgement loss cannot manufacture
 * a reconciling view; unresolved reads return unavailable, not invented workflow state. */
export interface ConsoleReadRuntime {
  readonly unboundReader: ConsoleSessionAnswerReader;
  /** Validate canonical enrollment, derive session identity, and bind a live read projection.
   * Stop/release never acquire an owner or invalidate evidence access. No model calls/writes. */
  bindHost(
    enrollment: ConsoleHostEnrollment,
    signal: AbortSignal
  ): Promise<BindConsoleHostResult>;
  /** Close only reader-owned resources; never close a scheduler or reset global DI. */
  close(signal: AbortSignal): Promise<RuntimeCloseResult>;
}

/** Proposed entrypoint at 'src/answer-v1/console.ts'. */
export declare function createConsoleReadRuntime(
  shared: ConsoleReadConfig,
  signal: AbortSignal
): Promise<CreateConsoleReadRuntimeResult>;

