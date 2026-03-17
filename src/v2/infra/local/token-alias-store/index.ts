/**
 * Local token alias store — JSONL file + in-memory Map.
 *
 * WHY: v2 short tokens (~27 chars) don't embed session data. This store maps
 * each token's nonce → session position so the engine can resolve them.
 *
 * Storage: <dataDir>/token-index.jsonl (append-only JSONL)
 * Memory:  Map<nonceHex, TokenAliasEntryV2> loaded at startup via loadIndex()
 *
 * Crash safety: uses openAppend + writeAll + fsyncFile (same pattern as manifest.jsonl).
 * Partial lines from a crash are invalid JSON and are skipped on reload.
 *
 * Lookup is O(1) from the in-memory Map. Only register() does I/O.
 */

import { okAsync, errAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2 } from '../../../ports/fs.port.js';
import type {
  TokenAliasStorePortV2,
  TokenAliasEntryV2,
  TokenAliasRegistrationError,
  TokenAliasLoadError,
} from '../../../ports/token-alias-store.port.js';
import type { ShortTokenKind } from '../../../durable-core/tokens/short-token.js';

/** Version discriminator written to every JSONL line for forward compatibility. */
const ALIAS_FILE_VERSION = 1 as const;

type AliasFileLine = TokenAliasEntryV2 & { readonly v: typeof ALIAS_FILE_VERSION };

/** Build a canonical position key for reverse lookup. */
function positionKey(
  tokenKind: ShortTokenKind,
  sessionId: string,
  nodeId: string,
  attemptId?: string,
  aliasSlot?: 'retry',
): string {
  return `${tokenKind}:${aliasSlot ?? ''}:${sessionId}:${nodeId}:${attemptId ?? ''}`;
}

export class LocalTokenAliasStoreV2 implements TokenAliasStorePortV2 {
  private readonly index = new Map<string, TokenAliasEntryV2>();
  /** Reverse index: positionKey → nonceHex (for idempotent replay). */
  private readonly positionIndex = new Map<string, string>();

  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
  ) {}

  register(entry: TokenAliasEntryV2): ResultAsync<void, TokenAliasRegistrationError> {
    // Duplicate nonce is an invariant violation — two separate minting calls reusing
    // the same nonce would make one token unretrievable.
    if (this.index.has(entry.nonceHex)) {
      return errAsync({
        code: 'ALIAS_DUPLICATE_NONCE' as const,
        nonceHex: entry.nonceHex,
      });
    }

    const line: AliasFileLine = { v: ALIAS_FILE_VERSION, ...entry };
    const lineBytes = encodeJsonlLine(line);

    const filePath = this.dataDir.tokenIndexPath();
    const dir = this.dataDir.keysDir(); // token-index.jsonl lives alongside keyring.json

    return this.fs.mkdirp(dir)
      .andThen(() => this.fs.openAppend(filePath))
      .andThen((handle) =>
        this.fs.writeAll(handle.fd, lineBytes)
          .andThen(() => this.fs.fsyncFile(handle.fd))
          .andThen(() => this.fs.closeFile(handle.fd))
          .orElse((e) =>
            this.fs.closeFile(handle.fd)
              .mapErr(() => e)
              .andThen(() => errAsync(e)),
          ),
      )
      .map(() => {
        // Only add to in-memory index after successful durable write.
        this.index.set(entry.nonceHex, entry);
        this.positionIndex.set(
          positionKey(entry.tokenKind, entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot),
          entry.nonceHex,
        );
      })
      .mapErr((e) => ({
        code: 'ALIAS_IO_ERROR' as const,
        message: (e as { message?: string }).message ?? String(e),
      }));
  }

  lookup(nonceHex: string): TokenAliasEntryV2 | null {
    return this.index.get(nonceHex) ?? null;
  }

  lookupByPosition(
    tokenKind: ShortTokenKind,
    sessionId: string,
    nodeId: string,
    attemptId?: string,
    aliasSlot?: 'retry',
  ): TokenAliasEntryV2 | null {
    const key = positionKey(tokenKind, sessionId, nodeId, attemptId, aliasSlot);
    const nonceHex = this.positionIndex.get(key);
    if (!nonceHex) return null;
    return this.index.get(nonceHex) ?? null;
  }

  loadIndex(): ResultAsync<void, TokenAliasLoadError> {
    const filePath = this.dataDir.tokenIndexPath();

    return this.fs.readFileUtf8(filePath)
      .map((content) => {
        let loaded = 0;
        let skipped = 0;
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            const entry = parseAliasLine(parsed);
            if (entry) {
              this.index.set(entry.nonceHex, entry);
              this.positionIndex.set(
                positionKey(entry.tokenKind, entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot),
                entry.nonceHex,
              );
              loaded++;
            } else {
              skipped++;
            }
          } catch {
            // Malformed JSON — skip. This is expected after a crash mid-write.
            skipped++;
          }
        }
        if (skipped > 0) {
          // Non-fatal: log to stderr for observability but do not fail.
          process.stderr.write(`[TokenAliasStore] loadIndex: loaded=${loaded} skipped=${skipped} (malformed lines)\n`);
        }
      })
      .orElse((e) => {
        // File not found = first run; that's fine. Any other error is propagated.
        if (e.code === 'FS_NOT_FOUND') return okAsync(undefined);
        return errAsync({ code: 'ALIAS_IO_ERROR' as const, message: e.message });
      });
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function encodeJsonlLine(line: AliasFileLine): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(line) + '\n');
}

function parseAliasLine(parsed: unknown): TokenAliasEntryV2 | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (
    r['v'] !== ALIAS_FILE_VERSION ||
    typeof r['nonceHex'] !== 'string' ||
    (r['tokenKind'] !== 'state' && r['tokenKind'] !== 'ack' && r['tokenKind'] !== 'checkpoint' && r['tokenKind'] !== 'continue') ||
    typeof r['sessionId'] !== 'string' ||
    typeof r['runId'] !== 'string' ||
    typeof r['nodeId'] !== 'string'
  ) {
    return null;
  }
  return {
    nonceHex: r['nonceHex'],
    tokenKind: r['tokenKind'],
    sessionId: r['sessionId'],
    runId: r['runId'],
    nodeId: r['nodeId'],
    ...(typeof r['attemptId'] === 'string' ? { attemptId: r['attemptId'] } : {}),
    ...(r['aliasSlot'] === 'retry' ? { aliasSlot: 'retry' as const } : {}),
    ...(typeof r['workflowHashRef'] === 'string' ? { workflowHashRef: r['workflowHashRef'] } : {}),
  };
}
