/**
 * Unit tests for ActiveSessionSet and SessionHandle.
 *
 * The registry is pure in-memory state -- no I/O, no ports, no fakes needed
 * except for AgentLoop. Tests cover: register/steer, get, TDZ safety, setAgent,
 * setAgent idempotency, dispose/size lifecycle, abortAll, and sessionIds iterator.
 */

import { describe, it, expect } from 'vitest';
import { ActiveSessionSet } from '../../src/daemon/active-sessions.js';
import type { AgentLoop } from '../../src/daemon/agent-loop.js';

// ---------------------------------------------------------------------------
// Fake AgentLoop
// ---------------------------------------------------------------------------

/**
 * Minimal fake for AgentLoop.
 * WHY: we must not import the real AgentLoop (it pulls in heavyweight SDK deps
 * and is unnecessary for testing the registry layer). A plain object with an
 * abort counter is sufficient to verify all abort-related invariants.
 */
function makeFakeAgent() {
  let abortCalled = 0;
  return {
    abort: () => {
      abortCalled++;
    },
    getAbortCount: () => abortCalled,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActiveSessionSet', () => {
  describe('register() and steer()', () => {
    it('returns a handle whose steer() invokes the onSteer callback', () => {
      const set = new ActiveSessionSet();
      const received: string[] = [];
      const handle = set.register('sess_1', (text) => received.push(text));

      handle.steer('hello');
      handle.steer('world');

      expect(received).toEqual(['hello', 'world']);
    });
  });

  describe('get()', () => {
    it('returns the registered handle', () => {
      const set = new ActiveSessionSet();
      const handle = set.register('sess_2', () => {});

      const result = set.get('sess_2');

      expect(result).toBe(handle);
      expect(result!.sessionId).toBe('sess_2');
    });

    it('returns undefined for an unknown sessionId', () => {
      const set = new ActiveSessionSet();
      expect(set.get('unknown')).toBeUndefined();
    });
  });

  describe('abort() before setAgent() -- TDZ safety', () => {
    it('is a safe no-op and does not throw', () => {
      const set = new ActiveSessionSet();
      const handle = set.register('sess_3', () => {});

      // WHY: between register() and setAgent() there is a ~200-500ms window where
      // _agent is null. A SIGTERM during this window must not crash the daemon.
      expect(() => handle.abort()).not.toThrow();
    });
  });

  describe('setAgent() and abort()', () => {
    it('calls agent.abort() after setAgent()', () => {
      const set = new ActiveSessionSet();
      const handle = set.register('sess_4', () => {});
      const agent = makeFakeAgent();

      handle.setAgent(agent as unknown as AgentLoop);
      handle.abort();

      expect(agent.getAbortCount()).toBe(1);
    });

    it('is idempotent -- second setAgent() call is ignored; only first agent is aborted', () => {
      const set = new ActiveSessionSet();
      const handle = set.register('sess_5', () => {});
      const agent1 = makeFakeAgent();
      const agent2 = makeFakeAgent();

      handle.setAgent(agent1 as unknown as AgentLoop);
      handle.setAgent(agent2 as unknown as AgentLoop); // second call -- must be a no-op

      handle.abort();

      // Only the first agent's abort should have been called.
      expect(agent1.getAbortCount()).toBe(1);
      expect(agent2.getAbortCount()).toBe(0);
    });
  });

  describe('dispose()', () => {
    it('decrements size from 1 to 0', () => {
      const set = new ActiveSessionSet();
      expect(set.size).toBe(0);

      const handle = set.register('sess_6', () => {});
      expect(set.size).toBe(1);

      handle.dispose();
      expect(set.size).toBe(0);
    });

    it('deregisters the handle so get() returns undefined', () => {
      const set = new ActiveSessionSet();
      const handle = set.register('sess_7', () => {});

      handle.dispose();

      expect(set.get('sess_7')).toBeUndefined();
    });
  });

  describe('abortAll()', () => {
    it('calls abort() on all registered handles that have an agent', () => {
      const set = new ActiveSessionSet();
      const h1 = set.register('sess_8a', () => {});
      const h2 = set.register('sess_8b', () => {});
      const agent1 = makeFakeAgent();
      const agent2 = makeFakeAgent();

      h1.setAgent(agent1 as unknown as AgentLoop);
      h2.setAgent(agent2 as unknown as AgentLoop);

      set.abortAll();

      expect(agent1.getAbortCount()).toBe(1);
      expect(agent2.getAbortCount()).toBe(1);
    });

    it('does not throw when called before any setAgent()', () => {
      const set = new ActiveSessionSet();
      set.register('sess_9a', () => {});
      set.register('sess_9b', () => {});

      // WHY: SIGTERM may fire before AgentLoop construction completes for any session.
      expect(() => set.abortAll()).not.toThrow();
    });
  });

  describe('sessionIds()', () => {
    it('contains exactly the registered session IDs, and excludes disposed ones', () => {
      const set = new ActiveSessionSet();
      const h1 = set.register('sess_10a', () => {});
      const h2 = set.register('sess_10b', () => {});

      const beforeDispose = Array.from(set.sessionIds()).sort();
      expect(beforeDispose).toEqual(['sess_10a', 'sess_10b']);

      h1.dispose();

      // Collect the iterator AFTER dispose so we see the updated map state.
      const afterDispose = Array.from(set.sessionIds());
      expect(afterDispose).toEqual(['sess_10b']);
      expect(afterDispose).not.toContain('sess_10a');
    });
  });
});
