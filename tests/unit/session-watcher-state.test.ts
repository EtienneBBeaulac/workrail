/**
 * Tests for session watcher state utilities.
 * 
 * Critical test: Verify disposeWatcherState() clears BOTH timer and watcher.
 * This is the core fix for the timer leak bug.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  createWatcherState, 
  disposeWatcherState, 
  isTransientError 
} from '../../src/types/session-watcher-state';

describe('createWatcherState', () => {
  it('should initialize state with null timer', () => {
    const mockWatcher = { close: vi.fn() } as any;
    const state = createWatcherState(mockWatcher);
    
    expect(state.watcher).toBe(mockWatcher);
    expect(state.timer).toBe(null);
    expect(state.transientErrorCount).toBe(0);
    expect(state.permanentErrorCount).toBe(0);
    expect(state.createdAt).toBeInstanceOf(Date);
  });
});

describe('disposeWatcherState - THE BUG FIX', () => {
  it('should clear timer before closing watcher', () => {
    const mockWatcher = { close: vi.fn() } as any;
    const state = createWatcherState(mockWatcher);
    
    // Set a timer (simulating debounce)
    let timerFired = false;
    state.timer = setTimeout(() => {
      timerFired = true;
    }, 1000);
    
    // Dispose immediately
    disposeWatcherState(state);
    
    // Timer should be cleared
    expect(state.timer).toBe(null);
    expect(mockWatcher.close).toHaveBeenCalled();
    
    // Wait past when timer would have fired
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Timer should NOT have fired (was cleared)
        expect(timerFired).toBe(false);
        resolve();
      }, 1200);
    });
  });

  it('should handle null timer gracefully', () => {
    const mockWatcher = { close: vi.fn() } as any;
    const state = createWatcherState(mockWatcher);
    
    // Timer is null
    expect(state.timer).toBe(null);
    
    // Should not throw
    expect(() => disposeWatcherState(state)).not.toThrow();
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('should handle watcher close errors gracefully', () => {
    const mockWatcher = {
      close: vi.fn(() => {
        throw new Error('Watcher already closed');
      })
    } as any;
    
    const state = createWatcherState(mockWatcher);
    
    // Should not throw (errors are caught internally)
    expect(() => disposeWatcherState(state)).not.toThrow();
  });

  it('should be idempotent - safe to call multiple times', () => {
    const mockWatcher = { close: vi.fn() } as any;
    const state = createWatcherState(mockWatcher);
    state.timer = setTimeout(() => {}, 1000);
    
    // First disposal
    disposeWatcherState(state);
    expect(state.timer).toBe(null);
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
    
    // Second disposal (timer already null)
    disposeWatcherState(state);
    expect(state.timer).toBe(null);
    expect(mockWatcher.close).toHaveBeenCalledTimes(2);
  });
});

describe('isTransientError', () => {
  it('should categorize EBUSY as transient', () => {
    const error = new Error('File busy') as any;
    error.code = 'EBUSY';
    expect(isTransientError(error)).toBe(true);
  });

  it('should categorize EAGAIN as transient', () => {
    const error = new Error('Try again') as any;
    error.code = 'EAGAIN';
    expect(isTransientError(error)).toBe(true);
  });

  it('should categorize ENOENT as transient', () => {
    const error = new Error('File not found') as any;
    error.code = 'ENOENT';
    expect(isTransientError(error)).toBe(true);
  });

  it('should categorize SyntaxError (bad JSON) as transient', () => {
    const error = new SyntaxError('Unexpected token');
    expect(isTransientError(error)).toBe(true);
  });

  it('should categorize EACCES as permanent', () => {
    const error = new Error('Permission denied') as any;
    error.code = 'EACCES';
    expect(isTransientError(error)).toBe(false);
  });

  it('should categorize unknown errors as permanent', () => {
    const error = new Error('Unknown error');
    expect(isTransientError(error)).toBe(false);
  });

  it('should categorize EISDIR as permanent', () => {
    const error = new Error('Is a directory') as any;
    error.code = 'EISDIR';
    expect(isTransientError(error)).toBe(false);
  });
});
