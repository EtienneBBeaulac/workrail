/**
 * WorkTrain Daemon: User Notification Service
 *
 * Fires user-facing notifications when a daemon session completes or fails.
 * Supports two channels: macOS native notifications (osascript) and a generic
 * webhook (HTTP POST).
 *
 * Design notes:
 * - notify() returns void synchronously. All async work runs in a detached
 *   Promise that unconditionally swallows errors. This is the same contract
 *   as DaemonEventEmitter.emit() -- observability must never affect correctness.
 * - execFileFn (for osascript) and fetchFn (for HTTP POST) are injected
 *   constructor parameters so tests can use fakes without mocking child_process
 *   or global fetch. Production code omits both (defaults apply).
 * - Platform guard: if macOs=true but process.platform !== 'darwin', a warning
 *   is logged once at construction and the macOS channel is disabled.
 * - URL validation: if webhookUrl is not a valid URL, a warning is logged once
 *   at construction and the webhook channel is disabled.
 * - NotificationService is immutable after construction.
 *
 * Config keys in ~/.workrail/config.json:
 *   "WORKTRAIN_NOTIFY_MACOS": "true"           -- enable macOS notifications
 *   "WORKTRAIN_NOTIFY_WEBHOOK": "https://..."  -- enable generic webhook
 */

import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import type { WorkflowRunResult } from '../daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Injected function types
// ---------------------------------------------------------------------------

/**
 * execFile signature subset used by the macOS notification channel.
 * Injected for testability -- production code uses child_process.execFile.
 *
 * WHY a bare (not promisified) callback form: we do not await the result.
 * The detached-void-Promise pattern fires and forgets. The callback form
 * is simpler to type and to fake in tests.
 */
export type ExecFileNotifyFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

/**
 * fetch signature subset used by the webhook channel.
 * Injected for testability -- production code uses globalThis.fetch.
 */
export type FetchNotifyFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NotificationConfig {
  /**
   * Enable macOS native notification channel.
   * Requires process.platform === 'darwin'. A warning is logged at construction
   * time if true on a non-darwin platform, and the channel is disabled.
   */
  readonly macOs: boolean;
  /**
   * Webhook URL for generic HTTP POST notification channel.
   * Must be a valid http:// or https:// URL. A warning is logged at construction
   * time if the value is not a valid URL, and the channel is disabled.
   */
  readonly webhookUrl?: string;
  /**
   * Injectable exec function for the macOS channel.
   * Production: defaults to child_process.execFile.
   * Tests: pass a fake to capture calls without spawning osascript.
   */
  readonly execFileFn?: ExecFileNotifyFn;
  /**
   * Injectable fetch function for the webhook channel.
   * Production: defaults to globalThis.fetch.
   * Tests: pass a fake to capture calls without real HTTP.
   */
  readonly fetchFn?: FetchNotifyFn;
  /**
   * Injectable platform detection function.
   * Production: defaults to os.platform().
   * Tests: pass a fake to simulate different platforms without spying on ESM
   * exports (vi.spyOn on ESM node:os exports is not supported in Vitest).
   */
  readonly platformFn?: () => NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Notification payload (webhook POST body)
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  readonly event: 'session_completed';
  readonly workflowId: string;
  readonly outcome: 'success' | 'error' | 'timeout' | 'delivery_failed';
  readonly detail: string;
  readonly goal: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Message building (pure)
// ---------------------------------------------------------------------------

/**
 * Build the macOS notification body string for a given WorkflowRunResult.
 *
 * WHY pure function: deterministic, testable in isolation from the side-effecting
 * channel delivery. Same inputs always produce the same notification text.
 */
export function buildNotificationBody(result: WorkflowRunResult, goal: string): string {
  const truncated = goal.length > 60 ? `${goal.slice(0, 57)}...` : goal;
  switch (result._tag) {
    case 'success':
      return `Session completed: ${truncated}`;
    case 'error':
      return `Session failed: ${truncated}`;
    case 'timeout':
      return `Session timed out: ${truncated}`;
    case 'delivery_failed':
      return `Session completed but result delivery failed: ${truncated}`;
  }
}

/**
 * Build the outcome string for the webhook NotificationPayload.
 */
export function buildOutcome(result: WorkflowRunResult): NotificationPayload['outcome'] {
  return result._tag;
}

/**
 * Build a human-readable detail string for the NotificationPayload.
 */
export function buildDetail(result: WorkflowRunResult): string {
  switch (result._tag) {
    case 'success':
      return `stopReason: ${result.stopReason}`;
    case 'error':
      return result.message;
    case 'timeout':
      return result.message;
    case 'delivery_failed':
      return `stopReason: ${result.stopReason}; deliveryError: ${result.deliveryError}`;
  }
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

/**
 * Fires user-facing notifications after a daemon session completes.
 *
 * Constructed once at daemon startup from ~/.workrail/config.json values and
 * injected optionally into TriggerRouter. When neither macOs nor webhookUrl is
 * configured, no instance is created -- zero overhead.
 *
 * WHY optional injection (not singleton): consistent with DaemonEventEmitter
 * and execFn patterns in TriggerRouter. Callers that do not inject an instance
 * pay zero cost.
 */
export class NotificationService {
  private readonly _macOsEnabled: boolean;
  private readonly _webhookUrl: string | undefined;
  private readonly _execFileFn: ExecFileNotifyFn;
  private readonly _fetchFn: FetchNotifyFn;

  constructor(config: NotificationConfig) {
    const getPlatform = config.platformFn ?? os.platform.bind(os);
    // Platform guard: macOS channel requires darwin.
    if (config.macOs && getPlatform() !== 'darwin') {
      console.warn(
        '[NotificationService] WORKTRAIN_NOTIFY_MACOS=true but platform is not darwin ' +
        `(platform: ${getPlatform()}). macOS notifications are disabled.`,
      );
      this._macOsEnabled = false;
    } else {
      this._macOsEnabled = config.macOs;
    }

    // URL validation: webhook channel requires a valid http(s) URL.
    if (config.webhookUrl !== undefined && config.webhookUrl !== '') {
      let valid = false;
      try {
        const parsed = new URL(config.webhookUrl);
        valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        valid = false;
      }
      if (!valid) {
        console.warn(
          `[NotificationService] WORKTRAIN_NOTIFY_WEBHOOK is not a valid http(s) URL ` +
          `("${config.webhookUrl}"). Webhook notifications are disabled.`,
        );
        this._webhookUrl = undefined;
      } else {
        this._webhookUrl = config.webhookUrl;
      }
    } else {
      this._webhookUrl = undefined;
    }

    // Default production implementations.
    this._execFileFn = config.execFileFn ?? ((file, args, options, callback) => {
      childProcess.execFile(file, args as string[], options, callback);
    });
    this._fetchFn = config.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  }

  /**
   * Fire user-facing notifications for a completed session.
   *
   * Returns void synchronously. All async work runs in a detached Promise that
   * unconditionally swallows errors. A failed notification never affects the
   * workflow result or propagates to the caller.
   *
   * WHY void (not Promise<void>): TypeScript cannot await a void return value.
   * This makes the fire-and-forget contract type-enforced -- accidental await
   * is a compile error.
   *
   * @param result - The WorkflowRunResult from the completed session.
   * @param goal - The goal string passed to start_workflow (for the notification body).
   */
  notify(result: WorkflowRunResult, goal: string): void {
    void this._doNotify(result, goal).catch(() => {
      // Intentionally empty: errors are silently swallowed.
      // Observability must never affect correctness.
    });
  }

  /**
   * Internal async notification implementation.
   *
   * WHY separated from notify(): keeps notify() synchronous and makes the
   * async I/O path unit-testable in isolation.
   */
  private async _doNotify(result: WorkflowRunResult, goal: string): Promise<void> {
    const body = buildNotificationBody(result, goal);

    const deliveries: Promise<void>[] = [];

    if (this._macOsEnabled) {
      deliveries.push(this._notifyMacOs(body, result.workflowId));
    }

    if (this._webhookUrl !== undefined) {
      deliveries.push(this._notifyWebhook(result, goal));
    }

    // Run both channels concurrently. Individual errors are caught per-channel.
    await Promise.allSettled(deliveries);
  }

  /**
   * Fire a macOS native notification via osascript.
   *
   * Uses execFile (not exec) so the notification text is passed as discrete args
   * and is never interpolated into a shell string. Shell metacharacters have no effect.
   *
   * The 5000ms timeout guards against osascript stalls (documented on some macOS
   * versions under heavy load). A stall kills the process (SIGKILL via execFile
   * timeout) and the error is caught and logged.
   */
  private _notifyMacOs(body: string, workflowId: string): Promise<void> {
    const script = `display notification ${JSON.stringify(body)} with title "WorkTrain" subtitle ${JSON.stringify(workflowId)}`;
    return new Promise<void>((resolve) => {
      this._execFileFn(
        'osascript',
        ['-e', script],
        { timeout: 5000 },
        (error) => {
          if (error) {
            console.warn(
              `[NotificationService] macOS notification failed: ${error.message}`,
            );
          }
          resolve();
        },
      );
    });
  }

  /**
   * POST a notification payload to the configured webhook URL.
   *
   * Uses AbortController with a 30-second timeout (same as delivery-client.ts).
   * Non-2xx responses and network errors are caught, logged, and discarded.
   */
  private async _notifyWebhook(result: WorkflowRunResult, goal: string): Promise<void> {
    const url = this._webhookUrl!;
    const payload: NotificationPayload = {
      event: 'session_completed',
      workflowId: result.workflowId,
      outcome: buildOutcome(result),
      detail: buildDetail(result),
      goal,
      timestamp: new Date().toISOString(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await this._fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.warn(
          `[NotificationService] Webhook notification failed: HTTP ${res.status} from ${url}`,
        );
      }
    } catch (e: unknown) {
      console.warn(
        `[NotificationService] Webhook notification error: ${String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
