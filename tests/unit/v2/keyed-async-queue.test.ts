import { describe, expect, it } from 'vitest';
import { KeyedAsyncQueue } from '../../../src/v2/infra/in-memory/keyed-async-queue/index.js';

describe('KeyedAsyncQueue', () => {
  it('resolves the result of fn()', async () => {
    const queue = new KeyedAsyncQueue();
    const result = await queue.enqueue('a', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('rejects when fn() rejects, propagating the error to caller', async () => {
    const queue = new KeyedAsyncQueue();
    const err = new Error('test error');
    await expect(queue.enqueue('a', () => Promise.reject(err))).rejects.toBe(err);
  });

  it('serializes concurrent enqueues for the same key (FIFO order)', async () => {
    const queue = new KeyedAsyncQueue();
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = queue.enqueue('key', () => new Promise<void>((res) => {
      resolveFirst = res;
    }).then(() => { order.push(1); }));

    const second = queue.enqueue('key', async () => { order.push(2); });

    // Second should not run until first resolves.
    await Promise.resolve(); // yield to microtask queue
    expect(order).toEqual([]);

    resolveFirst();
    await first;
    await second;

    expect(order).toEqual([1, 2]);
  });

  it('runs enqueues for different keys concurrently', async () => {
    const queue = new KeyedAsyncQueue();
    const order: string[] = [];

    let resolveA!: () => void;
    const a = queue.enqueue('a', () => new Promise<void>((res) => {
      resolveA = res;
    }).then(() => { order.push('a'); }));

    const b = queue.enqueue('b', async () => { order.push('b'); });

    // b should complete before a (different key, no serialization)
    await b;
    expect(order).toEqual(['b']);

    resolveA();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('continues processing subsequent enqueues after fn() failure', async () => {
    const queue = new KeyedAsyncQueue();
    const order: number[] = [];

    // First enqueue fails
    await expect(
      queue.enqueue('key', () => Promise.reject(new Error('fail')))
    ).rejects.toThrow('fail');

    // Second enqueue should still run
    await queue.enqueue('key', async () => { order.push(1); });

    expect(order).toEqual([1]);
  });

  it('cleans up Map entry after completion', async () => {
    const queue = new KeyedAsyncQueue();
    await queue.enqueue('key', () => Promise.resolve());
    // Allow microtask queue to flush
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.activeKeyCount).toBe(0);
  });

  it('handles multiple keys independently', async () => {
    const queue = new KeyedAsyncQueue();
    const results = await Promise.all([
      queue.enqueue('x', () => Promise.resolve(1)),
      queue.enqueue('y', () => Promise.resolve(2)),
      queue.enqueue('z', () => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  describe('depth()', () => {
    it('returns 0 for an unknown key', () => {
      const queue = new KeyedAsyncQueue();
      expect(queue.depth('unknown-key')).toBe(0);
    });

    it('increments when enqueued, decrements after completion', async () => {
      const queue = new KeyedAsyncQueue();

      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        // Enqueue a task that holds open until we release it
        void queue.enqueue('key', () => new Promise<void>((res) => {
          releaseFirst = res;
          resolve();
        }));
      });

      await firstStarted;
      expect(queue.depth('key')).toBe(1);

      // Enqueue a second task (will wait for the first)
      const second = queue.enqueue('key', () => Promise.resolve());
      expect(queue.depth('key')).toBe(2);

      releaseFirst();
      await second;

      // Allow .finally() microtasks to drain
      await Promise.resolve();
      await Promise.resolve();

      expect(queue.depth('key')).toBe(0);
    });

    it('depth is independent per key', async () => {
      const queue = new KeyedAsyncQueue();

      let releaseA!: () => void;
      const aEnqueued = queue.enqueue('a', () => new Promise<void>((res) => {
        releaseA = res;
      }));
      // 'b' enqueues and completes immediately
      await queue.enqueue('b', () => Promise.resolve());
      // Allow .finally() microtasks from 'b' to drain
      await Promise.resolve();
      await Promise.resolve();

      // 'a' is still pending; 'b' has fully completed
      expect(queue.depth('a')).toBe(1);
      expect(queue.depth('b')).toBe(0);

      releaseA();
      await aEnqueued;
      // Allow .finally() microtasks from 'a' to drain
      await Promise.resolve();
      await Promise.resolve();

      expect(queue.depth('a')).toBe(0);
    });

    it('decrements even when fn() rejects', async () => {
      const queue = new KeyedAsyncQueue();

      // enqueue() increments depth synchronously
      const promise = queue.enqueue('key', () => Promise.reject(new Error('fail')));

      // Catch the rejection so the test doesn't fail on unhandled rejection
      await promise.catch(() => {});

      // Allow .finally() microtasks to drain
      await Promise.resolve();
      await Promise.resolve();

      expect(queue.depth('key')).toBe(0);
    });
  });
});
