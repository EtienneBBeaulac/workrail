/**
 * Backfill migration: add timestampMs to existing session events.
 *
 * IMPORTANT: Run this script BEFORE deploying the sub-step (b) schema change
 * (which makes timestampMs required). If you deploy the schema change first,
 * sessions written before sub-step (a) will fail to load until backfilled.
 *
 * What this script does:
 * - Walks ~/.workrail/data/sessions/ (or WORKRAIL_DATA_DIR) for session directories
 * - For each session: reads manifest.jsonl to find segment file paths
 * - Skips sessions with an active .lock file (prints a warning)
 * - For each segment: reads events, stamps any event lacking timestampMs with
 *   the segment file's mtime (accurate to within one session step boundary)
 * - Re-serializes using toJsonlLineBytes (same function as the store) for SHA-256 consistency
 * - Rewrites each affected segment as a tmp file then renames it atomically
 * - Backs up manifest.jsonl to manifest.jsonl.bak before any writes
 * - Rewrites manifest.jsonl with updated sha256 and bytes for affected segments
 * - Verifies the rewritten manifest parses correctly before committing
 * - Prints a progress summary: sessions processed, events stamped, events skipped
 *
 * Recovery: if a session fails to load after deploying the schema change, run this
 * script to backfill it and restore access.
 *
 * Usage:
 *   npx tsx scripts/backfill-timestamps.ts
 *   WORKRAIL_DATA_DIR=/custom/path npx tsx scripts/backfill-timestamps.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { toJsonlLineBytes } from '../src/v2/durable-core/canonical/jsonl.js';
import { ManifestRecordV1Schema, type ManifestRecordV1 } from '../src/v2/durable-core/schemas/session/manifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackfillStats {
  sessionsProcessed: number;
  sessionsSkipped: number; // locked
  sessionsAlreadyStamped: number; // all events had timestampMs
  eventsStamped: number;
  eventsAlreadyStamped: number;
  errors: number;
}

interface SegmentBackfillResult {
  eventsStamped: number;
  eventsAlreadyStamped: number;
  newSha256: string;
  newBytes: number;
  modified: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseJsonlLines(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const results: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip invalid lines -- we'll detect issues during verification
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core: backfill a single segment file
// ---------------------------------------------------------------------------

async function backfillSegment(
  segmentPath: string,
): Promise<SegmentBackfillResult> {
  // Read the segment file
  const raw = await fs.readFile(segmentPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  // Get the segment file's mtime as the fallback timestamp
  const stat = await fs.stat(segmentPath);
  const segmentMtime = stat.mtimeMs;

  let eventsStamped = 0;
  let eventsAlreadyStamped = 0;
  let modified = false;
  const outputParts: Uint8Array[] = [];

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Preserve invalid lines as-is (the store will handle corruption detection)
      const bytes = new TextEncoder().encode(line + '\n');
      outputParts.push(bytes);
      continue;
    }

    if ('timestampMs' in parsed && typeof parsed['timestampMs'] === 'number') {
      // Already stamped -- keep as-is
      eventsAlreadyStamped++;
    } else {
      // Add timestampMs using the segment file's mtime
      parsed['timestampMs'] = segmentMtime;
      eventsStamped++;
      modified = true;
    }

    // Re-serialize using toJsonlLineBytes for SHA-256 consistency with the store
    const encodeResult = toJsonlLineBytes(parsed as import('../src/v2/durable-core/canonical/json-types.js').JsonValue);
    if (encodeResult.isErr()) {
      throw new Error(`Failed to encode event: ${encodeResult.error.message}`);
    }
    outputParts.push(encodeResult.value);
  }

  // Concatenate all output parts
  let totalBytes = 0;
  for (const part of outputParts) {
    totalBytes += part.length;
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of outputParts) {
    output.set(part, offset);
    offset += part.length;
  }

  const newSha256 = sha256Hex(output);
  const newBytes = output.length;

  if (modified) {
    // Write atomically: tmp file -> rename
    const tmpPath = `${segmentPath}.bak-tmp`;
    await fs.writeFile(tmpPath, output);
    await fs.rename(tmpPath, segmentPath);
  }

  return { eventsStamped, eventsAlreadyStamped, newSha256, newBytes, modified };
}

// ---------------------------------------------------------------------------
// Core: backfill a single session
// ---------------------------------------------------------------------------

async function backfillSession(
  sessionDir: string,
  stats: BackfillStats,
): Promise<void> {
  const sessionId = path.basename(sessionDir);
  const manifestPath = path.join(sessionDir, 'manifest.jsonl');
  const lockPath = path.join(sessionDir, '.lock');

  // Check for active lock file
  try {
    await fs.access(lockPath);
    // Lock file exists -- skip with warning
    console.warn(`  [WARN] Session ${sessionId}: skipping (active .lock file)`);
    stats.sessionsSkipped++;
    return;
  } catch {
    // No lock file -- proceed
  }

  // Read and parse manifest.jsonl
  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf-8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // No manifest -- empty session, skip
      return;
    }
    throw e;
  }

  const manifestLines = manifestText.split('\n').filter((l) => l.trim() !== '');
  if (manifestLines.length === 0) {
    return; // Empty manifest
  }

  // Parse manifest records, collecting segment_closed entries
  const manifestRecords: ManifestRecordV1[] = [];
  for (const line of manifestLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`  [ERROR] Session ${sessionId}: invalid JSON in manifest, skipping session`);
      stats.errors++;
      return;
    }
    const result = ManifestRecordV1Schema.safeParse(parsed);
    if (!result.success) {
      console.error(`  [ERROR] Session ${sessionId}: invalid manifest record, skipping session`);
      stats.errors++;
      return;
    }
    manifestRecords.push(result.data);
  }

  const segmentClosedRecords = manifestRecords.filter(
    (r): r is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => r.kind === 'segment_closed',
  );

  if (segmentClosedRecords.length === 0) {
    return; // No segments to backfill
  }

  // Check if all events are already stamped (quick scan before any writes)
  let allAlreadyStamped = true;
  for (const seg of segmentClosedRecords) {
    const segPath = path.join(sessionDir, seg.segmentRelPath);
    let segText: string;
    try {
      segText = await fs.readFile(segPath, 'utf-8');
    } catch {
      // Missing segment -- skip this session
      allAlreadyStamped = false;
      break;
    }
    const events = parseJsonlLines(segText);
    for (const event of events) {
      if (!('timestampMs' in event) || typeof event['timestampMs'] !== 'number') {
        allAlreadyStamped = false;
        break;
      }
    }
    if (!allAlreadyStamped) break;
  }

  if (allAlreadyStamped) {
    // Count events for stats
    for (const seg of segmentClosedRecords) {
      const segPath = path.join(sessionDir, seg.segmentRelPath);
      try {
        const segText = await fs.readFile(segPath, 'utf-8');
        const events = parseJsonlLines(segText);
        stats.eventsAlreadyStamped += events.length;
      } catch {
        // ignore read errors for stats
      }
    }
    stats.sessionsAlreadyStamped++;
    return;
  }

  // Backup manifest.jsonl before any writes
  const manifestBakPath = `${manifestPath}.bak`;
  await fs.copyFile(manifestPath, manifestBakPath);

  // Backfill each segment and collect new sha256/bytes
  const updatedManifestRecords: ManifestRecordV1[] = [];
  let sessionEventsStamped = 0;
  let sessionEventsAlreadyStamped = 0;

  for (const record of manifestRecords) {
    if (record.kind !== 'segment_closed') {
      // Keep non-segment_closed records as-is (snapshot_pinned, etc.)
      updatedManifestRecords.push(record);
      continue;
    }

    const segPath = path.join(sessionDir, record.segmentRelPath);
    let result: SegmentBackfillResult;
    try {
      result = await backfillSegment(segPath);
    } catch (e: unknown) {
      console.error(`  [ERROR] Session ${sessionId}: failed to backfill segment ${record.segmentRelPath}: ${String(e)}`);
      // Restore manifest from backup
      await fs.copyFile(manifestBakPath, manifestPath);
      stats.errors++;
      return;
    }

    sessionEventsStamped += result.eventsStamped;
    sessionEventsAlreadyStamped += result.eventsAlreadyStamped;

    if (result.modified) {
      // Update the segment_closed record with new sha256/bytes
      updatedManifestRecords.push({
        ...record,
        sha256: result.newSha256 as `sha256:${string}`,
        bytes: result.newBytes,
      });
    } else {
      updatedManifestRecords.push(record);
    }
  }

  // Rewrite manifest.jsonl with updated records
  const newManifestLines: string[] = [];
  for (const record of updatedManifestRecords) {
    newManifestLines.push(JSON.stringify(record));
  }
  const newManifestContent = newManifestLines.join('\n') + '\n';

  // Verify the rewritten manifest parses correctly before committing
  for (const line of newManifestLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`  [ERROR] Session ${sessionId}: rewritten manifest contains invalid JSON, restoring backup`);
      await fs.copyFile(manifestBakPath, manifestPath);
      stats.errors++;
      return;
    }
    const result = ManifestRecordV1Schema.safeParse(parsed);
    if (!result.success) {
      console.error(`  [ERROR] Session ${sessionId}: rewritten manifest fails schema validation, restoring backup`);
      await fs.copyFile(manifestBakPath, manifestPath);
      stats.errors++;
      return;
    }
  }

  // Commit the new manifest
  const tmpManifestPath = `${manifestPath}.tmp`;
  await fs.writeFile(tmpManifestPath, newManifestContent);
  await fs.rename(tmpManifestPath, manifestPath);

  stats.eventsStamped += sessionEventsStamped;
  stats.eventsAlreadyStamped += sessionEventsAlreadyStamped;
  stats.sessionsProcessed++;

  if (sessionEventsStamped > 0) {
    console.log(
      `  Session ${sessionId}: stamped ${sessionEventsStamped} events, skipped ${sessionEventsAlreadyStamped} already-stamped`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataDir = process.env['WORKRAIL_DATA_DIR'] ?? path.join(os.homedir(), '.workrail', 'data');
  const sessionsDir = path.join(dataDir, 'sessions');

  console.log(`WorkRail backfill-timestamps`);
  console.log(`Data directory: ${dataDir}`);
  console.log(`Sessions directory: ${sessionsDir}`);
  console.log('');

  // Check if sessions directory exists
  try {
    await fs.access(sessionsDir);
  } catch {
    console.log('No sessions directory found -- nothing to backfill.');
    return;
  }

  // List all session directories
  let sessionEntries: string[];
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    sessionEntries = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(sessionsDir, e.name));
  } catch (e) {
    console.error(`Failed to list sessions directory: ${String(e)}`);
    process.exit(1);
  }

  if (sessionEntries.length === 0) {
    console.log('No sessions found -- nothing to backfill.');
    return;
  }

  console.log(`Found ${sessionEntries.length} session(s) to process...`);
  console.log('');

  const stats: BackfillStats = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    sessionsAlreadyStamped: 0,
    eventsStamped: 0,
    eventsAlreadyStamped: 0,
    errors: 0,
  };

  for (const sessionDir of sessionEntries) {
    try {
      await backfillSession(sessionDir, stats);
    } catch (e: unknown) {
      console.error(`  [ERROR] Session ${path.basename(sessionDir)}: unexpected error: ${String(e)}`);
      stats.errors++;
    }
  }

  console.log('');
  console.log('--- Backfill complete ---');
  console.log(`Sessions processed:       ${stats.sessionsProcessed}`);
  console.log(`Sessions already stamped: ${stats.sessionsAlreadyStamped}`);
  console.log(`Sessions skipped (locked):${stats.sessionsSkipped}`);
  console.log(`Events stamped:           ${stats.eventsStamped}`);
  console.log(`Events already stamped:   ${stats.eventsAlreadyStamped}`);
  if (stats.errors > 0) {
    console.log(`Errors:                   ${stats.errors}`);
    console.log('');
    console.log('[WARN] Some sessions encountered errors. Check output above.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
