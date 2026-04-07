import { describe, it, expect, vi } from 'vitest';
import { mapPerfQueryToResult } from './perf-state';
import type { PerfToolCallsResponse } from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATA_RESPONSE: PerfToolCallsResponse = {
  observations: [
    { toolName: 'list_files', startedAtMs: 1000, durationMs: 42, outcome: 'success' },
  ],
  total: 1,
  devMode: true,
};

const EMPTY_RESPONSE: PerfToolCallsResponse = {
  observations: [],
  total: 0,
  devMode: true,
};

const noop = () => undefined;

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe('mapPerfQueryToResult', () => {
  it('maps isLoading=true to loading state', () => {
    const result = mapPerfQueryToResult(
      { isLoading: true, isError: false, error: null, data: undefined },
      noop,
    );
    expect(result.state).toBe('loading');
  });

  it('maps isError=true to error state with message from Error instance', () => {
    const err = new Error('Network timeout');
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: true, error: err, data: undefined },
      noop,
    );
    expect(result.state).toBe('error');
    if (result.state !== 'error') return; // narrow type
    expect(result.message).toBe('Network timeout');
  });

  it('maps isError=true with non-Error to fallback error message', () => {
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: true, error: 'string error', data: undefined },
      noop,
    );
    expect(result.state).toBe('error');
    if (result.state !== 'error') return;
    expect(result.message).toBe('Could not load performance data.');
  });

  it('exposes retry callback in error state', () => {
    const retry = vi.fn();
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: true, error: new Error('x'), data: undefined },
      retry,
    );
    expect(result.state).toBe('error');
    if (result.state !== 'error') return;
    result.retry();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('maps data=null (404 sentinel) to devModeOff', () => {
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: false, error: null, data: null },
      noop,
    );
    expect(result.state).toBe('devModeOff');
  });

  it('maps data=undefined (no initial data) to loading', () => {
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: false, error: null, data: undefined },
      noop,
    );
    expect(result.state).toBe('loading');
  });

  it('maps data.devMode=false to devModeOff (defense-in-depth)', () => {
    const result = mapPerfQueryToResult(
      {
        isLoading: false,
        isError: false,
        error: null,
        data: { ...DATA_RESPONSE, devMode: false },
      },
      noop,
    );
    expect(result.state).toBe('devModeOff');
  });

  it('maps valid data with observations to data state', () => {
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: false, error: null, data: DATA_RESPONSE },
      noop,
    );
    expect(result.state).toBe('data');
    if (result.state !== 'data') return;
    expect(result.data).toBe(DATA_RESPONSE);
    expect(result.data.observations).toHaveLength(1);
  });

  it('maps valid data with empty observations to data state (not devModeOff)', () => {
    const result = mapPerfQueryToResult(
      { isLoading: false, isError: false, error: null, data: EMPTY_RESPONSE },
      noop,
    );
    expect(result.state).toBe('data');
    if (result.state !== 'data') return;
    expect(result.data.observations).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });
});
