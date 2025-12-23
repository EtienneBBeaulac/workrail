import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '../../src/mcp/zod-to-json-schema.js';
import { WorkflowNextInput } from '../../src/mcp/tools.js';

describe('zodToJsonSchema: discriminated unions', () => {
  it('exposes workflow_next.state as oneOf with kind literals', () => {
    const schema = zodToJsonSchema(WorkflowNextInput) as any;
    expect(schema.type).toBe('object');

    const state = schema.properties?.state;
    expect(state).toBeTruthy();
    expect(Array.isArray(state.oneOf)).toBe(true);

    const kinds = new Set<string>();
    for (const branch of state.oneOf) {
      const kindConst = branch?.properties?.kind?.const;
      const kindEnum = branch?.properties?.kind?.enum;
      if (typeof kindConst === 'string') {
        kinds.add(kindConst);
      } else if (Array.isArray(kindEnum) && typeof kindEnum[0] === 'string') {
        kinds.add(kindEnum[0]);
      }

      // Each branch must require the discriminator
      expect(Array.isArray(branch?.required)).toBe(true);
      expect(branch.required).toContain('kind');
    }

    expect(kinds).toEqual(new Set(['init', 'running', 'complete']));
  });
});
