import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export function tmpPath(...parts: readonly string[]): string {
  return path.join(os.tmpdir(), ...parts);
}

export function toFileUrl(localPath: string): string {
  return pathToFileURL(path.resolve(localPath)).href;
}
