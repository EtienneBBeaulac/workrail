import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/mcp/zod-to-json-schema.js';

describe('zodToJsonSchema: literals', () => {
  it('preserves number literal type using const', () => {
    const s = zodToJsonSchema(z.literal(123)) as any;
    // Prefer JSON Schema const, but at minimum do not stringify to "123"
    expect(s.const ?? s.enum?.[0]).toBe(123);
  });

  it('preserves boolean literal type using const', () => {
    const s = zodToJsonSchema(z.literal(true)) as any;
    expect(s.const ?? s.enum?.[0]).toBe(true);
  });
});
