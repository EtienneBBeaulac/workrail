import fs from 'fs/promises';

/**
 * Heartbeat updater for the unified dashboard lock file.
 * Keeps process-liveness information fresh without coupling the logic to HttpServer.
 */
export class DashboardHeartbeat {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly lockFile: string,
    private readonly isPrimary: () => boolean
  ) {}

  start(): void {
    this.stop();

    this.timer = setInterval(async () => {
      if (!this.isPrimary()) return;

      try {
        const lockContent = await fs.readFile(this.lockFile, 'utf-8');
        const lockData = JSON.parse(lockContent) as { lastHeartbeat?: string };
        lockData.lastHeartbeat = new Date().toISOString();
        await fs.writeFile(this.lockFile, JSON.stringify(lockData, null, 2));
      } catch {
        // Lock file might have been removed; that's OK.
      }
    }, 30000);

    // Don't keep process alive just for heartbeat.
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
