/**
 * Architecture tests enforcing v2 design locks from:
 * docs/design/v2-core-design-locks.md Section 17 (Dependency layering)
 * 
 * Invariants:
 * - durable-core/** MUST NOT import from infra/** or Node I/O modules
 * - ports/** MUST NOT import from infra/**
 * - projections/** MUST NOT import from MCP wiring or infra/**
 * 
 * Purpose: Keep the functional core pure; side effects live at the edges.
 * 
 * @enforces durable-core-no-node-imports
 * @enforces durable-core-no-buffer
 * @enforces ports-interfaces-only
 * @enforces infra-only-node-io
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const V2_ROOT = path.join(__dirname, '../../src/v2');

interface ForbiddenImportRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

// Forbidden patterns per directory
const FORBIDDEN_IMPORTS: Record<string, readonly ForbiddenImportRule[]> = {
  'durable-core': [
    {
      name: 'infra imports',
      pattern: /from\s+['"](?:\.\.\/)+infra/,
      reason: 'Side effects must be injected via ports (see v2-core-design-locks.md Section 17)',
    },
    {
      name: 'Node fs',
      pattern: /from\s+['"]fs['"]/,
      reason: 'durable-core must be pure (no filesystem I/O)',
    },
    {
      name: 'Node fs/promises',
      pattern: /from\s+['"]fs\/promises['"]/,
      reason: 'durable-core must be pure (no filesystem I/O)',
    },
    {
      name: 'Node path',
      pattern: /from\s+['"]path['"]/,
      reason: 'durable-core must be pure (platform-specific operations forbidden)',
    },
    {
      name: 'Node crypto',
      pattern: /from\s+['"]crypto['"]/,
      reason: 'durable-core must use CryptoPort instead of Node crypto',
    },
    {
      name: 'Node os',
      pattern: /from\s+['"]os['"]/,
      reason: 'durable-core must be pure (platform-specific operations forbidden)',
    },
    {
      name: 'Node child_process',
      pattern: /from\s+['"]child_process['"]/,
      reason: 'durable-core must be pure (no process spawning)',
    },
  ],
  'ports': [
    {
      name: 'infra imports',
      pattern: /from\s+['"](?:\.\.\/)+infra/,
      reason: 'Ports are pure interfaces; implementations live in infra/**',
    },
    {
      name: 'Node fs',
      pattern: /from\s+['"]fs['"]/,
      reason: 'Ports must not contain implementation details',
    },
    {
      name: 'Node crypto',
      pattern: /from\s+['"]crypto['"]/,
      reason: 'Ports must not contain implementation details',
    },
  ],
  'projections': [
    {
      name: 'infra imports',
      pattern: /from\s+['"](?:\.\.\/)+infra/,
      reason: 'Projections are pure functions; no I/O allowed',
    },
    {
      name: 'MCP wiring',
      pattern: /from\s+['"](?:\.\.\/)+(?:\.\.\/)?mcp\//,
      reason: 'Projections are internal-only; MCP is the external boundary (v2-core-design-locks.md Section 6)',
    },
    {
      name: 'Node fs',
      pattern: /from\s+['"]fs['"]/,
      reason: 'Projections must be pure (no filesystem I/O)',
    },
  ],
};

function getAllTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('v2 import boundaries (architecture lock enforcement)', () => {
  for (const [subdir, rules] of Object.entries(FORBIDDEN_IMPORTS)) {
    describe(`${subdir}/**`, () => {
      const targetDir = path.join(V2_ROOT, subdir);
      
      if (!fs.existsSync(targetDir)) {
        it.skip(`${subdir} directory does not exist yet`, () => {});
      } else {
        const files = getAllTsFiles(targetDir);
        
        if (files.length === 0) {
          it.skip(`${subdir} has no TypeScript files yet`, () => {});
        } else {
          for (const file of files) {
            const relativePath = path.relative(V2_ROOT, file);
            
            describe(relativePath, () => {
              const content = fs.readFileSync(file, 'utf-8');
              
              for (const rule of rules) {
                it(`has no ${rule.name}`, () => {
                  const matches = content.match(rule.pattern);
                  
                  if (matches) {
                    const lines = content.split('\n');
                    const violationLines: string[] = [];
                    
                    for (let i = 0; i < lines.length; i++) {
                      if (rule.pattern.test(lines[i]!)) {
                        violationLines.push(`  Line ${i + 1}: ${lines[i]!.trim()}`);
                      }
                    }
                    
                    const errorMsg = [
                      `Forbidden import detected: ${rule.name}`,
                      `Reason: ${rule.reason}`,
                      ``,
                      `Violations:`,
                      ...violationLines,
                    ].join('\n');
                    
                    expect.fail(errorMsg);
                  }
                });
              }
            });
          }
        }
      }
    });
  }
  
  it('enforces that all v2 subdirectories have boundary rules', () => {
    const subdirs = fs.readdirSync(V2_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    
    const criticalDirs = ['durable-core', 'ports', 'projections'];
    const missingRules = criticalDirs.filter(dir => !FORBIDDEN_IMPORTS[dir]);
    
    expect(missingRules).toEqual([]);
  });
});

/**
 * Architecture test: MCP handlers must not import v2/infra/local
 * 
 * Invariant: Handlers consume `ctx.v2` capability bundle only; no infra construction.
 */
describe('MCP handler boundary enforcement (no v2 infra imports)', () => {
  const HANDLERS_DIR = path.join(__dirname, '../../src/mcp/handlers');
  
  const forbiddenPatterns = [
    {
      name: 'v2/infra/local import',
      pattern: /from\s+['"][^'"]*v2\/infra\/local/,
      reason: 'Handlers must consume ctx.v2 only; no infra construction (composition root discipline)',
    },
    {
      name: 'new Node*V2 construction',
      pattern: /new\s+Node\w+V2\s*\(/,
      reason: 'Handlers must not construct v2 infra adapters; use ctx.v2 instead',
    },
    {
      name: 'new Local*V2 construction',
      pattern: /new\s+Local\w+V2\s*\(/,
      reason: 'Handlers must not construct v2 infra stores; use ctx.v2 instead',
    },
  ];

  const files = getAllTsFiles(HANDLERS_DIR);
  
  for (const file of files) {
    const relativePath = path.relative(path.join(__dirname, '../..'), file);
    const content = fs.readFileSync(file, 'utf-8');
    
    for (const rule of forbiddenPatterns) {
      it(`${relativePath} has no ${rule.name}`, () => {
        const matches = content.match(new RegExp(rule.pattern.source, 'g'));
        
        if (matches) {
          const lines = content.split('\n');
          const violationLines: string[] = [];
          
          for (let i = 0; i < lines.length; i++) {
            if (rule.pattern.test(lines[i]!)) {
              violationLines.push(`  Line ${i + 1}: ${lines[i]!.trim()}`);
            }
          }
          
          const errorMsg = [
            `Forbidden pattern detected: ${rule.name}`,
            `Reason: ${rule.reason}`,
            ``,
            `Violations:`,
            ...violationLines,
          ].join('\n');
          
          expect.fail(errorMsg);
        }
      });
    }
  }
});

/**
 * Architecture test: fs/promises only in FS adapter
 * 
 * Invariant: Direct filesystem access must go through FileSystemPortV2.
 */
describe('v2 fs/promises boundary enforcement', () => {
  const V2_INFRA_LOCAL = path.join(V2_ROOT, 'infra/local');
  const ALLOWED_FILE = path.join(V2_INFRA_LOCAL, 'fs/index.ts');
  
  it('only src/v2/infra/local/fs/index.ts imports fs/promises', () => {
    const allV2InfraFiles = getAllTsFiles(V2_INFRA_LOCAL);
    const violations: string[] = [];
    
    for (const file of allV2InfraFiles) {
      // Skip the allowed file
      if (path.normalize(file) === path.normalize(ALLOWED_FILE)) continue;
      
      const content = fs.readFileSync(file, 'utf-8');
      const pattern = /from\s+['"]fs\/promises['"]/;
      
      if (pattern.test(content)) {
        const relativePath = path.relative(path.join(__dirname, '../..'), file);
        violations.push(relativePath);
      }
    }
    
    if (violations.length > 0) {
      expect.fail(
        `fs/promises imported outside FS adapter:\n` +
        violations.map(v => `  - ${v}`).join('\n') +
        `\n\nUse FileSystemPortV2 instead for runtime neutrality and crash-safety.`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Daemon SessionState mutation invariants
// ---------------------------------------------------------------------------
//
// These tests enforce structural invariants introduced by the TerminalSignal
// refactor and the SessionScope capability boundary work:
//
// 1. state.terminalSignal must only be written through setTerminalSignal().
//    Direct assignment (`state.terminalSignal = ...`) bypasses first-writer-wins
//    and can corrupt the stuck/timeout priority invariant.
//
// 2. constructTools() must not reference `session.state` or `state.` directly.
//    All SessionState access must go through SessionScope's typed callbacks and
//    getter fields. This enforces the capability boundary: tool factories get
//    only the operations they need, not the full mutable state object.

describe('Daemon SessionState mutation invariants', () => {
  const WORKFLOW_RUNNER = path.join(__dirname, '../../src/daemon/workflow-runner.ts');
  const SET_TERMINAL_SIGNAL_FN = 'setTerminalSignal';

  it('state.terminalSignal is only assigned inside setTerminalSignal()', () => {
    const content = fs.readFileSync(WORKFLOW_RUNNER, 'utf-8');
    const lines = content.split('\n');

    const violations: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match `state.terminalSignal =` (assignment, not comparison)
      if (/\bstate\.terminalSignal\s*=(?!=)/.test(line)) {
        // Only allowed inside the setTerminalSignal function body:
        // scan backwards to find the nearest enclosing function signature.
        let inSetterFn = false;
        for (let j = i; j >= 0; j--) {
          if (lines[j]!.includes(`export function ${SET_TERMINAL_SIGNAL_FN}`)) {
            inSetterFn = true;
            break;
          }
          // Stop at any other function boundary
          if (j < i && /^(?:export\s+)?(?:async\s+)?function\b/.test(lines[j]!.trim())) {
            break;
          }
        }
        if (!inSetterFn) {
          violations.push(`  line ${i + 1}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Direct state.terminalSignal assignment found outside setTerminalSignal():\n` +
        violations.join('\n') +
        `\n\nUse setTerminalSignal(state, signal) to preserve first-writer-wins invariant.`,
      );
    }
  });

  it('constructTools() does not reference state or session.state directly', () => {
    const content = fs.readFileSync(WORKFLOW_RUNNER, 'utf-8');

    // Extract constructTools function body
    const fnStart = content.indexOf('\nfunction constructTools(');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the closing brace by counting brace depth
    let depth = 0;
    let fnEnd = -1;
    let inFn = false;
    for (let i = fnStart; i < content.length; i++) {
      if (content[i] === '{') { depth++; inFn = true; }
      else if (content[i] === '}') {
        depth--;
        if (inFn && depth === 0) { fnEnd = i; break; }
      }
    }
    expect(fnEnd).toBeGreaterThan(fnStart);

    const fnBody = content.slice(fnStart, fnEnd + 1);
    const bodyLines = fnBody.split('\n');

    const violations: string[] = [];
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i]!;
      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // Match session.state or bare state. access
      if (/\bsession\.state\b|\bstate\./.test(line)) {
        violations.push(`  line ${i + 1}: ${line.trim()}`);
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `constructTools() references state directly:\n` +
        violations.join('\n') +
        `\n\nAll SessionState access must go through SessionScope callbacks and getters.`,
      );
    }
  });
});
