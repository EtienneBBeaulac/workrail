/**
 * Centralized in-memory fakes for V2 ports.
 *
 * Pattern P4 (Test Fakes) implementation: all fakes are centralized here
 * and shared across tests to prevent duplication and drift.
 *
 * Export all fakes for convenient importing in tests.
 */

export { InMemorySessionEventLogStore } from './session-event-log-store.fake.js';
export { InMemorySnapshotStore } from './snapshot-store.fake.js';
export { InMemoryPinnedWorkflowStore } from './pinned-workflow-store.fake.js';
export { InMemorySessionLock } from './session-lock.fake.js';
export { InMemoryKeyring } from './keyring.fake.js';
export { InMemoryFileSystem } from './file-system.fake.js';
