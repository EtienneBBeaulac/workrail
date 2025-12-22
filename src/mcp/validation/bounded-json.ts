/**
 * Byte-bounded JSON helpers (error UX only)
 *
 * These helpers exist to keep MCP error payloads deterministic and small.
 * They must NEVER be used for durable storage or any correctness-critical data path.
 */

export function byteLengthUtf8(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

export function toBoundedJsonString(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value, null, 2);
  if (byteLengthUtf8(json) <= maxBytes) return json;

  // Byte-precise truncation.
  const buf = Buffer.from(json, 'utf8');
  const truncated = buf.subarray(0, Math.max(0, maxBytes - 32)).toString('utf8');
  return `${truncated}\n...truncated...\n`;
}

export function toBoundedJsonValue(value: unknown, maxBytes: number): unknown | undefined {
  const json = toBoundedJsonString(value, maxBytes);
  // If it was truncated, we can't parse back reliably while guaranteeing correctness.
  // Prefer omitting rather than sending potentially invalid JSON.
  if (json.includes('...truncated...')) return undefined;
  return JSON.parse(json);
}
