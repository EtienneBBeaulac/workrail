import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const activeSandboxes = new Set<string>();

export function registerCleanupHandlers(): void {
  const cleanupAll = () => {
    for (const dir of activeSandboxes) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  };
  process.on('exit', cleanupAll);
  process.on('SIGINT', () => {
    cleanupAll();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanupAll();
    process.exit(143);
  });
}

export function createSandboxWorkspace(
  taskName: string,
  templateDir: string
): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    const sandboxRoot = path.join(__dirname, 'workspaces');
    if (!fs.existsSync(sandboxRoot)) {
      fs.mkdirSync(sandboxRoot, { recursive: true });
    }

    const runId = Math.random().toString(36).substring(2, 10);
    const sandboxDir = path.join(sandboxRoot, `run-${taskName}-${runId}`);

    // Copy template files recursively
    fs.cpSync(templateDir, sandboxDir, { recursive: true });
    activeSandboxes.add(sandboxDir);



    return { ok: true, dir: sandboxDir };
  } catch (err: any) {
    return { ok: false, error: `Failed to create sandbox: ${err.message}` };
  }
}

export function cleanupSandboxWorkspace(sandboxDir: string): void {
  try {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
    activeSandboxes.delete(sandboxDir);
  } catch {
    // Swallow cleanup errors to preserve process stability
  }
}

export function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs = 5000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const proc = exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: proc.exitCode !== null ? proc.exitCode : (error ? (error as any).code || 1 : 0),
        stdout,
        stderr,
        timedOut,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, 'SIGKILL');
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Swallow kill errors
        }
      }
    }, timeoutMs);
  });
}
