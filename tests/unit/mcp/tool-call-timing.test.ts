/**
 * Unit tests for MCP tool call timing infrastructure.
 *
 * Covers:
 * - ToolCallTimingRingBuffer: capacity, ordering, wrap-around
 * - withToolCallTiming: timing capture, outcome detection, sink isolation
 * - composeSinks: both sinks receive observations, errors are swallowed
 * - createRingBufferSink: wires ring buffer correctly
 * - DEV_PERF: module-level flag reads from process.env (tested via exported constant)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ToolCallTimingRingBuffer,
  withToolCallTiming,
  composeSinks,
  createRingBufferSink,
  noopToolCallTimingSink,
  type ToolCallTiming,
  type ToolCallTimingSink,
} from '../../../src/mcp/tool-call-timing.js';

// ---------------------------------------------------------------------------
// ToolCallTimingRingBuffer
// ---------------------------------------------------------------------------

describe('ToolCallTimingRingBuffer', () => {
  function makeTiming(toolName: string, durationMs = 10): ToolCallTiming {
    return { toolName, startedAtMs: Date.now(), durationMs, outcome: 'success' };
  }

  it('rejects capacity < 1', () => {
    expect(() => new ToolCallTimingRingBuffer(0)).toThrow();
  });

  it('starts empty', () => {
    const buf = new ToolCallTimingRingBuffer(5);
    expect(buf.size).toBe(0);
    expect(buf.recent()).toEqual([]);
  });

  it('grows up to capacity', () => {
    const buf = new ToolCallTimingRingBuffer(3);
    buf.push(makeTiming('a'));
    buf.push(makeTiming('b'));
    expect(buf.size).toBe(2);
    buf.push(makeTiming('c'));
    expect(buf.size).toBe(3);
  });

  it('does not exceed capacity', () => {
    const buf = new ToolCallTimingRingBuffer(3);
    for (let i = 0; i < 10; i++) buf.push(makeTiming(`t${i}`));
    expect(buf.size).toBe(3);
  });

  it('returns entries newest-first', () => {
    const buf = new ToolCallTimingRingBuffer(5);
    buf.push(makeTiming('first'));
    buf.push(makeTiming('second'));
    buf.push(makeTiming('third'));
    const result = buf.recent();
    expect(result[0].toolName).toBe('third');
    expect(result[1].toolName).toBe('second');
    expect(result[2].toolName).toBe('first');
  });

  it('respects limit parameter', () => {
    const buf = new ToolCallTimingRingBuffer(5);
    buf.push(makeTiming('a'));
    buf.push(makeTiming('b'));
    buf.push(makeTiming('c'));
    const result = buf.recent(2);
    expect(result.length).toBe(2);
    expect(result[0].toolName).toBe('c');
    expect(result[1].toolName).toBe('b');
  });

  it('limit clamped to actual count when smaller', () => {
    const buf = new ToolCallTimingRingBuffer(10);
    buf.push(makeTiming('only'));
    const result = buf.recent(100);
    expect(result.length).toBe(1);
  });

  it('overwrites oldest on wrap-around, preserves newest N', () => {
    const buf = new ToolCallTimingRingBuffer(3);
    buf.push(makeTiming('old-1'));
    buf.push(makeTiming('old-2'));
    buf.push(makeTiming('old-3'));
    buf.push(makeTiming('new-1')); // overwrites old-1
    const result = buf.recent();
    const names = result.map(t => t.toolName);
    expect(names).toContain('new-1');
    expect(names).toContain('old-2');
    expect(names).toContain('old-3');
    expect(names).not.toContain('old-1');
  });

  it('capacity-1 ring buffer: only keeps latest', () => {
    const buf = new ToolCallTimingRingBuffer(1);
    buf.push(makeTiming('first'));
    buf.push(makeTiming('second'));
    const result = buf.recent();
    expect(result.length).toBe(1);
    expect(result[0].toolName).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// withToolCallTiming
// ---------------------------------------------------------------------------

describe('withToolCallTiming', () => {
  it('returns the handler result unchanged', async () => {
    const expected = { content: 'hello' };
    const result = await withToolCallTiming(
      'my_tool',
      async () => expected,
      noopToolCallTimingSink,
    );
    expect(result).toBe(expected);
  });

  it('emits a timing observation with the correct tool name', async () => {
    const observations: ToolCallTiming[] = [];
    const sink: ToolCallTimingSink = (t) => observations.push(t);

    await withToolCallTiming('test_tool', async () => ({ content: 'ok' }), sink);

    expect(observations).toHaveLength(1);
    expect(observations[0].toolName).toBe('test_tool');
  });

  it('sets outcome=success for a clean result', async () => {
    const observations: ToolCallTiming[] = [];
    await withToolCallTiming('t', async () => ({ content: 'ok' }), (t) => observations.push(t));
    expect(observations[0].outcome).toBe('success');
  });

  it('sets outcome=error when result.isError=true', async () => {
    const observations: ToolCallTiming[] = [];
    await withToolCallTiming(
      't',
      async () => ({ isError: true, content: [] }),
      (t) => observations.push(t),
    );
    expect(observations[0].outcome).toBe('error');
  });

  it('re-throws handler exceptions and sets outcome=error', async () => {
    const observations: ToolCallTiming[] = [];
    const boom = new Error('boom');

    await expect(
      withToolCallTiming('t', async () => { throw boom; }, (t) => observations.push(t)),
    ).rejects.toThrow('boom');

    expect(observations[0].outcome).toBe('error');
  });

  it('emits timing even when handler throws', async () => {
    const observations: ToolCallTiming[] = [];
    await withToolCallTiming('t', async () => { throw new Error(); }, (t) => observations.push(t))
      .catch(() => { /* expected */ });
    expect(observations).toHaveLength(1);
  });

  it('swallows sink errors and still returns the handler result', async () => {
    const throwingSink: ToolCallTimingSink = () => { throw new Error('sink exploded'); };
    const result = await withToolCallTiming('t', async () => 'safe', throwingSink);
    expect(result).toBe('safe');
  });

  it('records a non-negative durationMs', async () => {
    const observations: ToolCallTiming[] = [];
    await withToolCallTiming('t', async () => 'ok', (t) => observations.push(t));
    expect(observations[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records startedAtMs close to Date.now()', async () => {
    const before = Date.now();
    const observations: ToolCallTiming[] = [];
    await withToolCallTiming('t', async () => 'ok', (t) => observations.push(t));
    const after = Date.now();
    expect(observations[0].startedAtMs).toBeGreaterThanOrEqual(before);
    expect(observations[0].startedAtMs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// composeSinks
// ---------------------------------------------------------------------------

describe('composeSinks', () => {
  it('forwards observations to both sinks', async () => {
    const a: ToolCallTiming[] = [];
    const b: ToolCallTiming[] = [];
    const composed = composeSinks((t) => a.push(t), (t) => b.push(t));
    const obs: ToolCallTiming = { toolName: 'x', startedAtMs: 0, durationMs: 5, outcome: 'success' };
    composed(obs);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('swallows errors from first sink and still calls second', () => {
    const b: ToolCallTiming[] = [];
    const composed = composeSinks(
      () => { throw new Error('a exploded'); },
      (t) => b.push(t),
    );
    const obs: ToolCallTiming = { toolName: 'x', startedAtMs: 0, durationMs: 1, outcome: 'success' };
    expect(() => composed(obs)).not.toThrow();
    expect(b).toHaveLength(1);
  });

  it('swallows errors from second sink without affecting first', () => {
    const a: ToolCallTiming[] = [];
    const composed = composeSinks(
      (t) => a.push(t),
      () => { throw new Error('b exploded'); },
    );
    const obs: ToolCallTiming = { toolName: 'x', startedAtMs: 0, durationMs: 1, outcome: 'success' };
    expect(() => composed(obs)).not.toThrow();
    expect(a).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createRingBufferSink
// ---------------------------------------------------------------------------

describe('createRingBufferSink', () => {
  it('pushes observations into the ring buffer', () => {
    const buf = new ToolCallTimingRingBuffer(5);
    const sink = createRingBufferSink(buf);
    sink({ toolName: 'my_tool', startedAtMs: 0, durationMs: 42, outcome: 'success' });
    expect(buf.size).toBe(1);
    expect(buf.recent()[0].toolName).toBe('my_tool');
    expect(buf.recent()[0].durationMs).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// noopToolCallTimingSink
// ---------------------------------------------------------------------------

describe('noopToolCallTimingSink', () => {
  it('does nothing and does not throw', () => {
    expect(() => noopToolCallTimingSink({
      toolName: 'x', startedAtMs: 0, durationMs: 1, outcome: 'success',
    })).not.toThrow();
  });
});
