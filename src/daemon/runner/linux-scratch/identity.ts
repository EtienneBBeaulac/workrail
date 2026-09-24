import { createHash } from 'node:crypto';

/** Search hint only. A deterministic name never grants execution or cleanup authority. */
export function scratchContainerName(supervisor: string): string {
  return 'workrail-scratch-' + createHash('sha256').update(supervisor).digest('hex').slice(0, 32);
}
