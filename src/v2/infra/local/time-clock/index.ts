import type { TimeClockPortV2 } from '../../../ports/time-clock.port.js';

/**
 * Node time/process adapter using platform APIs.
 */
export class NodeTimeClockV2 implements TimeClockPortV2 {
  nowMs(): number {
    return Date.now();
  }

  getPid(): number {
    return process.pid;
  }
}
