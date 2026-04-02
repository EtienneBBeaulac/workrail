/**
 * In-memory managed source store -- for testing only.
 *
 * No I/O, no persistence. Implements the same port as LocalManagedSourceStoreV2
 * so tests can use it without a real filesystem.
 */

import path from 'path';
import { okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type {
  ManagedSourceRecordV2,
  ManagedSourceStoreError,
  ManagedSourceStorePortV2,
} from '../../../ports/managed-source-store.port.js';

export class InMemoryManagedSourceStoreV2 implements ManagedSourceStorePortV2 {
  private readonly sources: ManagedSourceRecordV2[] = [];

  list(): ResultAsync<readonly ManagedSourceRecordV2[], ManagedSourceStoreError> {
    return okAsync([...this.sources]);
  }

  attach(sourcePath: string): ResultAsync<void, ManagedSourceStoreError> {
    const normalizedPath = path.resolve(sourcePath);
    const alreadyPresent = this.sources.some((s) => s.path === normalizedPath);
    if (!alreadyPresent) {
      this.sources.push({ path: normalizedPath, addedAtMs: Date.now() });
    }
    return okAsync(undefined);
  }

  detach(sourcePath: string): ResultAsync<void, ManagedSourceStoreError> {
    const normalizedPath = path.resolve(sourcePath);
    const index = this.sources.findIndex((s) => s.path === normalizedPath);
    if (index !== -1) {
      this.sources.splice(index, 1);
    }
    return okAsync(undefined);
  }
}
