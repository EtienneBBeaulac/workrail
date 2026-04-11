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
 * - Disk persistence via JSONL append (fire-and-forget, lazy eviction on read)
 * - `WORKRAIL_DEV=1` unified dev flag (see dev-mode.ts)
 *
 * @module mcp/tool-call-timing
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a tool call at the MCP boundary.
 * Discriminated union ensures exhaustive handling at all consumers.
 */
export type ToolCallOutcome = 'success' | 'error' | 'unknown_tool';

/**
 * Persisted timing record: `ToolCallTiming` enriched with server version metadata.
 *
 * WHY a separate type rather than adding `serverVersion` to `ToolCallTiming`:
 * - `ToolCallTiming` is the in-flight observation type (no version context at emit time)
 * - `ToolCallTimingEntry` is the stored/API type (always includes server version)
 * - Keeps the in-flight type minimal; illegal state (missing version on disk) is unrepresentable
 */
export type ToolCallTimingEntry = ToolCallTiming & {
  readonly serverVersion: string;
};

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

  /**
   * Add a timing observation. Overwrites the oldest entry when full.
   * Safe without locking: Node.js single-threaded event loop means two-field
   * mutation (head + count) is never observed in a torn state by another caller.
   */
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

/**
 * Default ring buffer capacity for the console API endpoint.
 * 100 entries covers ~10 minutes of typical agent activity (one call every ~6s)
 * while keeping memory overhead negligible (each entry is <200 bytes).
 */
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
 * Create a sink that persists each timing observation as a JSONL line to disk.
 *
 * Each line is a complete `ToolCallTimingEntry` JSON record terminated by `\n`.
 * Uses async append (fire-and-forget) so disk I/O never blocks the event loop.
 * Errors are silently swallowed -- observability must not affect correctness.
 *
 * The target directory is created synchronously at construction time (once).
 * This avoids ENOENT on first write without adding async complexity.
 *
 * @param perfFilePath  Absolute path to the JSONL file (e.g. `~/.workrail/data/perf/tool-calls.jsonl`)
 * @param serverVersion Server version string from package.json (e.g. `"3.16.0"`)
 */
export function createDiskPersistSink(perfFilePath: string, serverVersion: string): ToolCallTimingSink {
  // Create directory once at construction time -- sync is acceptable here (startup path, not hot path).
  try { fs.mkdirSync(path.dirname(perfFilePath), { recursive: true }); } catch { /* ignore */ }

  return (timing: ToolCallTiming): void => {
    const entry: ToolCallTimingEntry = { ...timing, serverVersion };
    // Fire-and-forget: errors must not affect the calling tool handler.
    fs.promises.appendFile(perfFilePath, JSON.stringify(entry) + '\n').catch(() => {
      // Disk write failure is a silent observability gap, not a correctness failure.
    });
  };
}

/**
 * Create a sink that logs to stderr (enabled when WORKRAIL_DEV=1).
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
 * Compose any number of sinks into one.
 * All sinks receive every observation independently.
 * If any sink throws, the exception is swallowed (timing is observability, not correctness).
 * Binary usage (composeSinks(a, b)) continues to work unchanged.
 */
export function composeSinks(...sinks: ToolCallTimingSink[]): ToolCallTimingSink {
  return (timing) => {
    for (const sink of sinks) {
      try { sink(timing); } catch { /* observability must not affect correctness */ }
    }
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

  // Initial value is 'error': if something fails before the try block assigns
  // a real outcome (impossible today but defensively correct), 'error' is the
  // honest fallback. 'unknown_tool' would be wrong here since the tool is known.
  let outcome: ToolCallOutcome = 'error';

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
