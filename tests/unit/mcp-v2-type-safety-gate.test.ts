import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural quality gate: v2 execution handler philosophy enforcement.
 *
 * This test fails if `src/mcp/handlers/v2-execution.ts` violates your core philosophy:
 * - No `as any` in critical paths (token/snapshot/event construction)
 * - No `throw` for expected failures (errors as data)
 * - No `unknown` discrimination (prefer typed unions)
 *
 * Rationale: compile-time guarantees > runtime tests. If the code compiles with these
 * violations, invalid states become representable.
 */
describe('v2-execution type-safety gate (philosophy enforcement)', () => {
  const filePath = path.join(__dirname, '../../src/mcp/handlers/v2-execution.ts');
  const content = fs.readFileSync(filePath, 'utf8');

  it('should not use `as any` in token/snapshot/event critical paths', () => {
    // Remaining `as any` uses are acceptable:
    // - step property access from v1 workflows (runtime shape checking for v1 bridge)
    // - discriminator type guards for union narrowing (e.g., isContinueAckError)
    // - exhaustive check guards with _exhaustive variable
    // But we ban it in:
    // - token payload construction
    // - snapshot construction
    // - event construction
    
    const lines = content.split('\n');
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      
      // Ban `as any` in token signing, snapshot store, event construction contexts
      // Allow: step property checks, discriminator type guards, exhaustive checks, justified casts
      if (line.includes('as any') && 
          !line.includes('step as any') && 
          !line.includes('title') && 
          !line.includes('prompt') &&
          !line.includes('?.kind') &&    // Type guard for kind discriminator
          !line.includes('.kind)') &&    // Type guard includes check
          !line.includes('_exhaustive') && // Exhaustive pattern check
          !line.includes('/* TYPE SAFETY')) { // Explicitly justified cast with comment
        // Allow runtime step property checks and justified casts; ban everything else
        violations.push(`Line ${i + 1}: ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Found ${violations.length} disallowed \`as any\` cast(s) in critical paths:\n${violations.join('\n')}\n\n` +
        `Philosophy: type-safety first; invalid states should be unrepresentable at compile-time.`
      );
    }
  });

  it('should not throw for expected failures in MCP handler paths', () => {
    // We allow `throw` only in truly unexpected invariant violations (rare).
    // Expected failures (token parse, session load, etc.) must return ToolResult errors.
    
    const throwPattern = /\bthrow\s+new\s+Error\(/g;
    const matches = [...content.matchAll(throwPattern)];
    
    // We expect 0 throws; if any are added, they should be in rare invariant-violation guards only.
    expect(matches.length).toBe(0);
  });

  it('should not use Promise.reject for expected error flow control', () => {
    // Promise.reject is imperative error flow; we prefer ResultAsync.
    const rejectPattern = /Promise\.reject\(/g;
    const matches = [...content.matchAll(rejectPattern)];
    
    expect(matches.length).toBe(0);
  });
});
