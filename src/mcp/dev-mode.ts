/**
 * Single dev-mode flag for all WorkRail development features.
 *
 * Set WORKRAIL_DEV=1 to enable:
 * - Staleness signal for all workflow categories (including built-in)
 * - Structured tool-call timing emitted to stderr after each MCP call
 * - /api/v2/perf/tool-calls endpoint in the console API
 *
 * The value is read from the DI-injected feature flag provider, which merges
 * ~/.workrail/config.json with process.env (env always wins). This means
 * WORKRAIL_DEV=1 can be set in the config file and take effect without
 * having to set the env var in every shell session.
 *
 * Intended for local development and performance investigation.
 * Not documented for production use.
 */

import { container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { IFeatureFlagProvider } from '../config/feature-flags.js';

/**
 * Returns true when dev mode is active.
 *
 * Reads from the DI-injected IFeatureFlagProvider, which resolves WORKRAIL_DEV
 * from the merged environment (config file defaults + process.env overrides).
 *
 * Call-time evaluation is intentional: the DI container (and merged env) is
 * available by the time any handler calls this, but was not yet available when
 * modules were first imported.
 */
export function isDevMode(): boolean {
  try {
    const flags = container.resolve<IFeatureFlagProvider>(DI.Infra.FeatureFlags);
    return flags.isEnabled('devMode');
  } catch {
    // DI container not yet initialized (e.g. during early boot or tests that
    // do not initialize the container). Fall back to process.env so that
    // WORKRAIL_DEV=1 via env still works unconditionally.
    return process.env['WORKRAIL_DEV'] === '1';
  }
}

/**
 * @deprecated Use isDevMode() instead. This constant is evaluated at module
 * load time before the DI container has merged ~/.workrail/config.json, so
 * WORKRAIL_DEV set in the config file has no effect on it.
 *
 * Will be removed once all call sites are migrated.
 */
export const DEV_MODE: boolean = process.env['WORKRAIL_DEV'] === '1';
