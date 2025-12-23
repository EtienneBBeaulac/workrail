import * as os from 'os';
import * as path from 'path';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';

export class LocalDataDirV2 implements DataDirPortV2 {
  constructor(private readonly env: Record<string, string | undefined>) {}

  private root(): string {
    const configured = this.env['WORKRAIL_DATA_DIR'];
    return configured ? configured : path.join(os.homedir(), '.workrail', 'data');
  }

  pinnedWorkflowsDir(): string {
    return path.join(this.root(), 'workflows', 'pinned');
  }

  pinnedWorkflowPath(workflowHash: string): string {
    return path.join(this.pinnedWorkflowsDir(), `${workflowHash}.json`);
  }
}
