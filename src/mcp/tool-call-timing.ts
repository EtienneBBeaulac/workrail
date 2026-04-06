/**
 * MCP Tool Call Timing
 *
 * End-to-end latency tracing for MCP tool call lifecycle: entry -> response.
 *
 * Architecture decisions:
 * - Structured observation type (not stringly-typed) -- domain type over primitives
 * - Sink interface (not global mutable) -- DI for I/O boundaries
 * - Best-effort: sink errors never affect handler results (immutability of correctness)
 * - Ring buffer for console API: bounded, deterministic, zero dynamic growth
 * - `WORKRAIL_DEV_PERF=1` dev flag mirrors the `WORKRAIL_DEV_STALENESS=1` pattern
 *
 * @module mcp/tool-call-timing
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a tool call at the MCP boundary.
 * Discriminated union ensures exhaustive handling at all consumers.
 */
export type ToolCallOutcome = 'success' | 'error' | 'unknown_tool';

/**
 * Structured timing observation for one MCP tool call.
 *
 * Captured at the outermost boundary (CallToolRequestSchema handler) so it
 * covers everything: input validation, handler dispatch, response formatting.
 */
export interface ToolCallTiming {
  /** Tool name from MCP request params. */
  readonly toolName: string;
  /** Wall-clock start time (epoch ms). */
  readonly startedAtMs: number;
  /** Total elapsed time from entry to response. */
  readonly durationMs: number;
  /** Outcome at the MCP boundary. */
  readonly outcome: ToolCallOutcome;
}

/**
 * Sink for tool call timing observations.
 * Defaults to no-op; inject a real sink (structured log, ring buffer) when needed.
 *
 * Same pattern as ProjectionTimingSink in projection-timing.ts.
 */
export type ToolCallTimingSink = (timing: ToolCallTiming) => void;

/** No-op sink -- zero overhead when timing is not observed. */
export const noopToolCallTimingSink: ToolCallTimingSink = () => {};

// ---------------------------------------------------------------------------
// Dev flag
// ---------------------------------------------------------------------------

/**
 * When set to '1', writes structured timing to stderr after each tool call.
 * Intended for local development and performance investigation.
 * Not documented for production use.
 */
export const DEV_PERF: boolean = process.env['WORKRAIL_DEV_PERF'] === '1';

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer for ToolCallTiming observations.
 *
 * Bounded at construction -- no dynamic growth at runtime.
 * Oldest entries are overwritten once capacity is reached.
 *
 * Why a ring buffer rather than an array: array.push() unbounded growth is
 * a silent memory leak in a long-running MCP server process. Ring buffer
 * makes the memory contract explicit and constant.
 */
export class ToolCallTimingRingBuffer {
  private readonly buffer: Array<ToolCallTiming | undefined>;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('Ring buffer capacity must be >= 1');
    this.buffer = new Array<ToolCallTiming | undefined>(capacity).fill(undefined);
  }

  /** Add a timing observation. Overwrites the oldest entry when full. */
  push(timing: ToolCallTiming): void {
    this.buffer[this.head] = timing;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Return recent observations, newest-first.
   * Returns at most `limit` entries (defaults to all entries).
   */
  recent(limit?: number): readonly ToolCallTiming[] {
    const n = limit !== undefined ? Math.min(limit, this.count) : this.count;
    const results: ToolCallTiming[] = [];
    for (let i = 1; i <= n; i++) {
      // Walk backwards from head
      const idx = (this.head - i + this.capacity) % this.capacity;
      const entry = this.buffer[idx];
      if (entry !== undefined) results.push(entry);
    }
    return results;
  }

  /** Number of stored entries (0..capacity). */
  get size(): number {
    return this.count;
  }
}

// ---------------------------------------------------------------------------
// Sink factories
// ---------------------------------------------------------------------------

/** Default ring buffer capacity for the console API endpoint. */
export const DEFAULT_RING_BUFFER_CAPACITY = 100;

/**
 * Create a sink that writes to a ring buffer.
 * Use for the console API endpoint to expose recent timing observations.
 */
export function createRingBufferSink(
  buffer: ToolCallTimingRingBuffer,
): ToolCallTimingSink {
  return (timing) => {
    buffer.push(timing);
  };
}

/**
 * Create a sink that logs to stderr (for WORKRAIL_DEV_PERF=1).
 * Output format is designed for easy scanning in a terminal.
 */
export function createDevPerfSink(): ToolCallTimingSink {
  return (timing) => {
    const outcomeLabel = timing.outcome === 'success' ? 'OK' : timing.outcome.toUpperCase();
    const line = `[PerfTrace] ${timing.toolName} ${timing.durationMs.toFixed(1)}ms [${outcomeLabel}]`;
    console.error(line);
  };
}

/**
 * Compose two sinks into one.
 * Both sinks receive every observation independently.
 * If either throws, the exception is swallowed (timing is observability, not correctness).
 */
export function composeSinks(
  a: ToolCallTimingSink,
  b: ToolCallTimingSink,
): ToolCallTimingSink {
  return (timing) => {
    try { a(timing); } catch { /* observability must not affect correctness */ }
    try { b(timing); } catch { /* observability must not affect correctness */ }
  };
}

// ---------------------------------------------------------------------------
// Timing wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a raw MCP CallTool handler to emit timing observations.
 *
 * The wrapper is transparent to callers: same input/output shape.
 * Timing is best-effort -- if the sink throws, the response is still returned.
 *
 * @param toolName - Tool name extracted from the MCP request (captured before dispatch)
 * @param handler  - The actual tool dispatch function
 * @param sink     - Where to send timing observations
 */
export async function withToolCallTiming<T>(
  toolName: string,
  handler: () => Promise<T>,
  sink: ToolCallTimingSink,
): Promise<T> {
  const startedAtMs = Date.now();
  const startHr = performance.now();

  let outcome: ToolCallOutcome = 'unknown_tool';

  try {
    const result = await handler();
    // Heuristic: MCP error results have isError=true on the returned object
    outcome = (result as { isError?: boolean } | null)?.isError === true ? 'error' : 'success';
    return result;
  } catch (err) {
    outcome = 'error';
    throw err;
  } finally {
    const durationMs = Math.round((performance.now() - startHr) * 100) / 100;
    try {
      sink({ toolName, startedAtMs, durationMs, outcome });
    } catch {
      // Timing is observability, not correctness.
    }
  }
}
