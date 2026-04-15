/**
 * ESM interop shim for pi-mono packages.
 *
 * pi-mono is ESM-only. WorkRail compiles to CommonJS. Node.js allows CJS modules
 * to load ESM via dynamic import() but not via static require(). This module
 * provides a lazy-loaded, cached entry point so the rest of the codebase can
 * use pi-mono types with a single async loader call.
 *
 * WHY new Function() instead of await import():
 * TypeScript with module:commonjs rewrites `await import('pkg')` at compile time to
 * `Promise.resolve().then(() => __importStar(require('pkg')))`. This breaks on
 * ESM-only packages whose exports field has no 'require' condition.
 * Using `new Function('specifier', 'return import(specifier)')` places the import()
 * call inside a string that TypeScript never touches, so the compiled output emits
 * a true ESM dynamic import at runtime, bypassing the CJS require() rewrite.
 */

// Types are erased at runtime -- safe to import statically from ESM.
export type { Agent, AgentTool, AgentToolResult, AgentEvent, AgentLoopConfig } from '@mariozechner/pi-agent-core';
export type { Model, TSchema } from '@mariozechner/pi-ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = Record<string, any>;

/**
 * A true ESM dynamic import that survives TypeScript's module:commonjs compilation.
 *
 * TS rewrites `await import(x)` to `require(x)` when targeting CommonJS. This
 * function is constructed from a string so the TypeScript compiler never sees the
 * import() expression and cannot rewrite it. The runtime result is a real ESM
 * import() that can load type:module packages from CJS compiled hosts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const esmImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<AnyModule>;

let _piAi: AnyModule | null = null;
let _piAgentCore: AnyModule | null = null;

/**
 * Load @mariozechner/pi-ai via dynamic import (ESM interop).
 * Cached after first call.
 */
export async function loadPiAi(): Promise<AnyModule> {
  if (!_piAi) _piAi = await esmImport('@mariozechner/pi-ai');
  return _piAi;
}

/**
 * Load @mariozechner/pi-agent-core via dynamic import (ESM interop).
 * Cached after first call.
 */
export async function loadPiAgentCore(): Promise<AnyModule> {
  if (!_piAgentCore) _piAgentCore = await esmImport('@mariozechner/pi-agent-core');
  return _piAgentCore;
}
