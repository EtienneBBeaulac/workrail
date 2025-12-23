export interface DataDirPortV2 {
  pinnedWorkflowsDir(): string;
  pinnedWorkflowPath(workflowHash: string): string;

  // Slice 3 prereq: snapshot CAS store
  snapshotsDir(): string;
  snapshotPath(snapshotRef: string): string;

  // Slice 3 prereq: token signing keyring
  keysDir(): string;
  keyringPath(): string;

  // Slice 2: session durable substrate
  sessionsDir(): string;
  sessionDir(sessionId: string): string;
  sessionEventsDir(sessionId: string): string;
  sessionManifestPath(sessionId: string): string;
  sessionLockPath(sessionId: string): string;
}
