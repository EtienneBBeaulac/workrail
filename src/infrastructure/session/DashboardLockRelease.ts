import fs from 'fs/promises';

export function releaseLockFileSync(lockFile: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsSync = require('fs');
    fsSync.unlinkSync(lockFile);
  } catch (error: any) {
    // Ignore ENOENT (already deleted); log others to stderr at call site if desired.
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function releaseLockFile(lockFile: string): Promise<void> {
  try {
    await fs.unlink(lockFile);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}
