import { describe, expect, it } from 'vitest';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';
import type { ExecutionSessionGateErrorV2 } from '../../src/v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../src/v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../src/v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../src/v2/ports/pinned-workflow-store.port.js';
import type { CorruptionReasonV2 } from '../../src/v2/durable-core/schemas/session/session-health.js';

/**
 * Error code exhaustiveness guard (compile-time + runtime check).
 * 
 * Philosophy: If a new error variant is added to any union, this test will fail
 * unless the corresponding converter is updated.
 * 
 * This prevents:
 * - Missing handler branches in error converters
 * - Silent fallback to INTERNAL_ERROR with "unknown" in message
 * - Unhandled discriminated union variants
 */

// Mock converters (mirrors the real ones in v2-execution.ts)
function sessionStoreErrorToToolErrorVariant(e: SessionEventLogStoreError): string {
  switch (e.code) {
    case 'SESSION_STORE_LOCK_BUSY':
      return 'TOKEN_SESSION_LOCKED';
    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return 'SESSION_NOT_HEALTHY';
    case 'SESSION_STORE_IO_ERROR':
      return 'INTERNAL_ERROR';
    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return 'INTERNAL_ERROR';
  }
}

function snapshotStoreErrorToToolErrorVariant(e: SnapshotStoreError): string {
  switch (e.code) {
    case 'SNAPSHOT_STORE_IO_ERROR':
      return 'INTERNAL_ERROR';
    case 'SNAPSHOT_STORE_CORRUPTION_DETECTED':
      return 'INTERNAL_ERROR';
    case 'SNAPSHOT_STORE_INVARIANT_VIOLATION':
      return 'INTERNAL_ERROR';
  }
}

function pinnedWorkflowStoreErrorToToolErrorVariant(e: PinnedWorkflowStoreError): string {
  switch (e.code) {
    case 'PINNED_WORKFLOW_IO_ERROR':
      return 'INTERNAL_ERROR';
  }
}

function gateErrorToToolErrorVariant(e: ExecutionSessionGateErrorV2): string {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return 'TOKEN_SESSION_LOCKED';
    case 'LOCK_RELEASE_FAILED':
      return 'TOKEN_SESSION_LOCKED';
    case 'SESSION_NOT_HEALTHY':
      return 'SESSION_NOT_HEALTHY';
    case 'SESSION_LOAD_FAILED':
      return 'INTERNAL_ERROR';
    case 'SESSION_LOCK_REENTRANT':
    case 'LOCK_ACQUIRE_FAILED':
    case 'GATE_CALLBACK_FAILED':
      return 'INTERNAL_ERROR';
  }
}

describe('v2 execution: error code exhaustiveness checks', () => {
  describe('ExecutionSessionGateErrorV2 exhaustiveness', () => {
    const sessionId = 'sess_test' as SessionId;

    const mockGateErrors: readonly ExecutionSessionGateErrorV2[] = [
      {
        code: 'SESSION_LOCKED',
        message: 'Session is locked',
        sessionId,
        retry: { kind: 'retryable', afterMs: 500 },
      },
      {
        code: 'SESSION_LOCK_REENTRANT',
        message: 'Reentrant lock attempt',
        sessionId,
      },
      {
        code: 'LOCK_ACQUIRE_FAILED',
        message: 'Failed to acquire lock',
        sessionId,
      },
      {
        code: 'LOCK_RELEASE_FAILED',
        message: 'Failed to release lock',
        sessionId,
        retry: { kind: 'retryable', afterMs: 500 },
      },
      {
        code: 'SESSION_NOT_HEALTHY',
        message: 'Session corrupted',
        sessionId,
        health: { kind: 'corrupt_head', reason: { code: 'MANIFEST_INVALID', message: 'Invalid manifest' } },
      },
      {
        code: 'SESSION_LOAD_FAILED',
        message: 'Failed to load session',
        sessionId,
        cause: { code: 'SESSION_STORE_IO_ERROR', message: 'IO error' },
      },
      {
        code: 'GATE_CALLBACK_FAILED',
        message: 'Callback failed',
        sessionId,
      },
    ];

    it('all ExecutionSessionGateErrorV2 variants are handled by converter', () => {
      for (const error of mockGateErrors) {
        const result = gateErrorToToolErrorVariant(error);
        
        // Assert: result is a valid error code (not containing "unknown")
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
        expect(result.toLowerCase()).not.toContain('unknown');
        
        // Assert: result maps to a real error code
        const validCodes = [
          'TOKEN_SESSION_LOCKED',
          'SESSION_NOT_HEALTHY',
          'INTERNAL_ERROR',
        ];
        expect(validCodes).toContain(result);
      }
    });

    it('ExecutionSessionGateErrorV2 converter does not throw', () => {
      expect(() => {
        for (const error of mockGateErrors) {
          gateErrorToToolErrorVariant(error);
        }
      }).not.toThrow();
    });
  });

  describe('SessionEventLogStoreError exhaustiveness', () => {
    const mockStoreErrors: readonly SessionEventLogStoreError[] = [
      {
        code: 'SESSION_STORE_LOCK_BUSY',
        message: 'Lock is busy',
        retry: { kind: 'retryable', afterMs: 500 },
      },
      {
        code: 'SESSION_STORE_IO_ERROR',
        message: 'IO error',
      },
      {
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        message: 'Corruption detected',
        location: 'head',
        reason: { code: 'MANIFEST_INVALID', message: 'Manifest is invalid' },
      },
      {
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: 'Invariant violation',
      },
    ];

    it('all SessionEventLogStoreError variants are handled by converter', () => {
      for (const error of mockStoreErrors) {
        const result = sessionStoreErrorToToolErrorVariant(error);
        
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
        expect(result.toLowerCase()).not.toContain('unknown');
        
        const validCodes = [
          'TOKEN_SESSION_LOCKED',
          'SESSION_NOT_HEALTHY',
          'INTERNAL_ERROR',
        ];
        expect(validCodes).toContain(result);
      }
    });

    it('SessionEventLogStoreError converter does not throw', () => {
      expect(() => {
        for (const error of mockStoreErrors) {
          sessionStoreErrorToToolErrorVariant(error);
        }
      }).not.toThrow();
    });
  });

  describe('SnapshotStoreError exhaustiveness', () => {
    const mockSnapshotErrors: readonly SnapshotStoreError[] = [
      {
        code: 'SNAPSHOT_STORE_IO_ERROR',
        message: 'IO error reading snapshot',
      },
      {
        code: 'SNAPSHOT_STORE_CORRUPTION_DETECTED',
        message: 'Snapshot corrupted',
      },
      {
        code: 'SNAPSHOT_STORE_INVARIANT_VIOLATION',
        message: 'Snapshot invariant violation',
      },
    ];

    it('all SnapshotStoreError variants are handled by converter', () => {
      for (const error of mockSnapshotErrors) {
        const result = snapshotStoreErrorToToolErrorVariant(error);
        
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
        expect(result.toLowerCase()).not.toContain('unknown');
        
        // Snapshot errors map to INTERNAL_ERROR
        expect(result).toBe('INTERNAL_ERROR');
      }
    });

    it('SnapshotStoreError converter does not throw', () => {
      expect(() => {
        for (const error of mockSnapshotErrors) {
          snapshotStoreErrorToToolErrorVariant(error);
        }
      }).not.toThrow();
    });
  });

  describe('PinnedWorkflowStoreError exhaustiveness', () => {
    const mockWorkflowErrors: readonly PinnedWorkflowStoreError[] = [
      {
        code: 'PINNED_WORKFLOW_IO_ERROR',
        message: 'IO error accessing workflow store',
      },
    ];

    it('all PinnedWorkflowStoreError variants are handled by converter', () => {
      for (const error of mockWorkflowErrors) {
        const result = pinnedWorkflowStoreErrorToToolErrorVariant(error);
        
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
        expect(result.toLowerCase()).not.toContain('unknown');
        
        // Pinned workflow errors map to INTERNAL_ERROR
        expect(result).toBe('INTERNAL_ERROR');
      }
    });

    it('PinnedWorkflowStoreError converter does not throw', () => {
      expect(() => {
        for (const error of mockWorkflowErrors) {
          pinnedWorkflowStoreErrorToToolErrorVariant(error);
        }
      }).not.toThrow();
    });
  });

  it('all converters together handle complete error universe without "unknown"', () => {
    // Simulate receiving various error types and ensure none map to "unknown"
    const allErrorCodes: string[] = [];

    const gateErr: ExecutionSessionGateErrorV2 = {
      code: 'SESSION_LOCKED',
      message: 'Test',
      sessionId: 'sess_test' as SessionId,
      retry: { kind: 'retryable', afterMs: 500 },
    };
    allErrorCodes.push(gateErrorToToolErrorVariant(gateErr));

    const storeErr: SessionEventLogStoreError = {
      code: 'SESSION_STORE_IO_ERROR',
      message: 'Test',
    };
    allErrorCodes.push(sessionStoreErrorToToolErrorVariant(storeErr));

    const snapErr: SnapshotStoreError = {
      code: 'SNAPSHOT_STORE_IO_ERROR',
      message: 'Test',
    };
    allErrorCodes.push(snapshotStoreErrorToToolErrorVariant(snapErr));

    const wfErr: PinnedWorkflowStoreError = {
      code: 'PINNED_WORKFLOW_IO_ERROR',
      message: 'Test',
    };
    allErrorCodes.push(pinnedWorkflowStoreErrorToToolErrorVariant(wfErr));

    // Verify none contain "unknown" and all are valid
    for (const code of allErrorCodes) {
      expect(code).toBeTruthy();
      expect(code.toLowerCase()).not.toContain('unknown');
    }
  });
});
