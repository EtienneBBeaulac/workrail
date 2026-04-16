/**
 * @deprecated Use src/daemon/agent-loop.ts instead.
 *
 * This module previously loaded @mariozechner/pi-agent-core and @mariozechner/pi-ai
 * (private npm packages). Those packages have been replaced by the first-party
 * AgentLoop in src/daemon/agent-loop.ts, which uses @anthropic-ai/sdk and
 * @anthropic-ai/bedrock-sdk (both public packages on npm).
 *
 * This file is kept for backward compatibility but is no longer imported by
 * workflow-runner.ts. It will be removed in a future version.
 *
 * ---
 *
 * ESM interop shim for pi-mono packages (DEPRECATED).
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

// Type exports removed: @mariozechner/pi-agent-core and @mariozechner/pi-ai are no
// longer in package.json. The export lines were deleted because tsc fails on a clean
// install when they reference packages that do not exist. This file is now a
// deprecated no-op kept for reference only.

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
let _bedrockRegistered = false;

/**
 * Load @mariozechner/pi-ai via dynamic import (ESM interop).
 * Also registers the Bedrock provider module so Bedrock models are available.
 * Cached after first call.
 */
export async function loadPiAi(): Promise<AnyModule> {
  if (!_piAi) {
    _piAi = await esmImport('@mariozechner/pi-ai');
    // Register Bedrock provider if not already registered.
    // The bedrock-provider module is loaded via its dist path since pi-ai
    // doesn't export it as a named subpath.
    if (!_bedrockRegistered) {
      try {
        // Resolve path relative to this file's location at runtime
        const path = await import('node:path');
        const bedrockPath = path.resolve(__dirname, '..', '..', 'node_modules', '@mariozechner', 'pi-ai', 'dist', 'bedrock-provider.js');
        const bedrockMod = await esmImport(`file://${bedrockPath}`).catch(() => null);
        if (bedrockMod?.bedrockProviderModule && _piAi.setBedrockProviderModule) {
          _piAi.setBedrockProviderModule(bedrockMod.bedrockProviderModule);
          _bedrockRegistered = true;
        }
      } catch {
        // Bedrock registration is best-effort -- Anthropic direct API still works
      }
    }
  }
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
