import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Ajv from 'ajv';
import { toSdkTool, toSdkCallResult } from '../../../src/mcp/sdk-boundary.js';
import { zodToJsonSchema } from '../../../src/mcp/zod-to-json-schema.js';

describe('MCP SDK boundary', () => {
  it('advertises exclusive recovery inputs without discarding either branch', () => {
    const schema = z.union([
      z.object({ recovery: z.string() }).strict(),
      z.object({ attempt: z.string() }).strict(),
    ]);
    const tool = toSdkTool({ name: 'recover_work', description: 'Recover', inputSchema: zodToJsonSchema(schema) });
    const validate = new Ajv().compile(tool.inputSchema);
    for (const [input, accepted] of [
      [{ recovery: 'r' }, true], [{ attempt: 'a' }, true],
      [{ recovery: 'r', attempt: 'a' }, false], [{}, false],
      [{ recovery: 1 }, false], [{ recovery: 'r', extra: true }, false],
      ['r', false],
    ] as const) {
      expect(validate(input)).toBe(accepted);
      expect(schema.safeParse(input).success).toBe(accepted);
    }
  });

  it('preserves tool annotations through SDK validation', () => {
    const annotations = { readOnlyHint: true, destructiveHint: false };
    expect(toSdkTool({ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} }, annotations }).annotations).toEqual(annotations);
  });

  it('rejects an explicitly non-object tool root', () => {
    expect(() => toSdkTool({ name: 'invalid', description: 'Invalid', inputSchema: { type: 'string' } })).toThrow('Invalid MCP tool schema');
  });

  it('copies frozen domain content for SDK ownership', () => {
    const item = Object.freeze({ type: 'text' as const, text: 'original' });
    const source = Object.freeze({ content: Object.freeze([item]), isError: true });
    const wire = toSdkCallResult(source);
    wire.content.push({ type: 'text', text: 'added' });
    expect(source.content).toEqual([item]);
    expect(wire.content[0]).not.toBe(item);
    expect(wire.isError).toBe(true);
  });
});
