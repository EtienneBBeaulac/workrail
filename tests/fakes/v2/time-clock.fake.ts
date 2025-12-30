import type { TimeClockPortV2 } from '../../../src/v2/ports/time-clock.port.js';

/**
 * Fake time clock for deterministic testing.
 *
 * Allows tests to advance time and set specific timestamps
 * for testing time-sensitive logic like lock expiration.
 */
export class FakeTimeClockV2 implements TimeClockPortV2 {
  private currentMs = 1000000000000;  // Fixed epoch
  private pid = 12345;

  nowMs(): number {
    return this.currentMs;
  }

  getPid(): number {
    return this.pid;
  }

  // Test utilities
  advance(ms: number) {
    this.currentMs += ms;
  }

  setTime(ms: number) {
    this.currentMs = ms;
  }

  setPid(pid: number) {
    this.pid = pid;
  }
}
