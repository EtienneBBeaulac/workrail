/**
 * Branded types for type-safe session identifiers.
 * 
 * Prevents parameter swap bugs at compile time:
 * - Can't pass SessionId where WorkflowId is expected
 * - Can't pass raw strings without parsing
 * - Validation happens once at construction
 */

declare const WorkflowIdBrand: unique symbol;
declare const SessionIdBrand: unique symbol;

export type WorkflowId = string & { readonly [WorkflowIdBrand]: never };
export type SessionId = string & { readonly [SessionIdBrand]: never };

/**
 * Smart constructor for WorkflowId.
 * Only way to create a validated WorkflowId.
 */
export const WorkflowId = {
  /**
   * Parse and validate a workflow ID from external input.
   * 
   * @param raw - Raw string to validate
   * @returns Validated WorkflowId
   * @throws TypeError if invalid format
   */
  parse(raw: string): WorkflowId {
    if (!raw || typeof raw !== 'string') {
      throw new TypeError('WorkflowId must be a non-empty string');
    }
    if (!/^[a-z0-9-]+$/.test(raw)) {
      throw new TypeError(
        `Invalid WorkflowId: "${raw}". Must contain only lowercase letters, numbers, and hyphens.`
      );
    }
    return raw as WorkflowId;
  },

  /**
   * Unsafe coercion - only use when input is already validated.
   * Prefer parse() for external inputs.
   * 
   * Use cases:
   * - Deserializing from trusted storage
   * - Converting from validated session objects
   */
  unsafeCoerce(raw: string): WorkflowId {
    return raw as WorkflowId;
  },
} as const;

/**
 * Smart constructor for SessionId.
 * Only way to create a validated SessionId.
 */
export const SessionId = {
  /**
   * Parse and validate a session ID from external input.
   * 
   * @param raw - Raw string to validate
   * @returns Validated SessionId
   * @throws TypeError if invalid format
   */
  parse(raw: string): SessionId {
    if (!raw || typeof raw !== 'string') {
      throw new TypeError('SessionId must be a non-empty string');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
      throw new TypeError(
        `Invalid SessionId: "${raw}". Must contain only alphanumeric, underscore, and hyphen.`
      );
    }
    return raw as SessionId;
  },

  /**
   * Unsafe coercion - only use when input is already validated.
   */
  unsafeCoerce(raw: string): SessionId {
    return raw as SessionId;
  },
} as const;

/**
 * Composite key for session watchers.
 * Immutable, type-safe identifier for a specific session.
 */
export interface SessionWatcherKey {
  readonly workflowId: WorkflowId;
  readonly sessionId: SessionId;
}

/**
 * Utilities for working with SessionWatcherKey.
 */
export const SessionWatcherKey = {
  /**
   * Create a watcher key from validated IDs.
   */
  create(workflowId: WorkflowId, sessionId: SessionId): SessionWatcherKey {
    return Object.freeze({ workflowId, sessionId });
  },

  /**
   * Serialize to string for use as Map key.
   * 
   * Format: "workflow-id::session-id"
   * Using :: as separator (not / which could be in IDs)
   */
  serialize(key: SessionWatcherKey): string {
    return `${key.workflowId}::${key.sessionId}`;
  },

  /**
   * Deserialize from string.
   * 
   * @throws TypeError if invalid format
   */
  deserialize(serialized: string): SessionWatcherKey {
    const parts = serialized.split('::');
    if (parts.length !== 2) {
      throw new TypeError(`Invalid serialized SessionWatcherKey: "${serialized}"`);
    }
    const [workflow, session] = parts;
    if (!workflow || !session) {
      throw new TypeError(`Invalid serialized SessionWatcherKey: "${serialized}"`);
    }
    return SessionWatcherKey.create(
      WorkflowId.unsafeCoerce(workflow),
      SessionId.unsafeCoerce(session)
    );
  },

  /**
   * Check equality of two keys.
   */
  equals(a: SessionWatcherKey, b: SessionWatcherKey): boolean {
    return a.workflowId === b.workflowId && a.sessionId === b.sessionId;
  },
} as const;
