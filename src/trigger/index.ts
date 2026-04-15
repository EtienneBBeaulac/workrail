/**
 * WorkRail Auto: Trigger System Public API
 *
 * Entry point for the src/trigger/ module.
 *
 * Usage:
 *   import { startTriggerListener } from './trigger/index.js';
 *
 *   const handle = await startTriggerListener(ctx, {
 *     workspacePath: '/path/to/repo',
 *     apiKey: process.env.ANTHROPIC_API_KEY,
 *   });
 *
 *   if (handle === null) {
 *     // Feature flag WORKRAIL_TRIGGERS_ENABLED not set -- listener not started
 *   } else if ('_kind' in handle) {
 *     // Startup error (port conflict, missing secret, parse error, etc.)
 *     console.error('Trigger listener failed to start:', handle.error);
 *   } else {
 *     console.log('Listening on port', handle.port);
 *     // ... later ...
 *     await handle.stop();
 *   }
 */

export { startTriggerListener } from './trigger-listener.js';
export type { TriggerListenerHandle, TriggerListenerError, StartTriggerListenerOptions } from './trigger-listener.js';
export { loadTriggerConfig, loadTriggerConfigFromFile } from './trigger-store.js';
export type { TriggerStoreError } from './trigger-store.js';
export type {
  TriggerId,
  TriggerDefinition,
  TriggerConfig,
  TriggerSource,
  WebhookEvent,
  ContextMapping,
  ContextMappingEntry,
} from './types.js';
