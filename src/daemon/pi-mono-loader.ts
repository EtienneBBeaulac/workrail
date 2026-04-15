/**
 * ESM interop shim for pi-mono packages.
 *
 * pi-mono is ESM-only. WorkRail compiles to CommonJS. Node.js allows CJS modules
 * to load ESM via dynamic import() but not via static require(). This module
 * provides a lazy-loaded, cached entry point so the rest of the codebase can
 * use pi-mono types with a single async loader call.
 */

// Types are erased at runtime -- safe to import statically from ESM.
export type { Agent, AgentTool, AgentToolResult, AgentEvent, AgentLoopConfig } from '@mariozechner/pi-agent-core';
export type { Model, TSchema } from '@mariozechner/pi-ai';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = Record<string, any>;

let _piAi: AnyModule | null = null;
let _piAgentCore: AnyModule | null = null;

/**
 * Load @mariozechner/pi-ai via dynamic import (ESM interop).
 * Cached after first call.
 */
export async function loadPiAi(): Promise<AnyModule> {
  if (!_piAi) _piAi = await import('@mariozechner/pi-ai');
  return _piAi;
}

/**
 * Load @mariozechner/pi-agent-core via dynamic import (ESM interop).
 * Cached after first call.
 */
export async function loadPiAgentCore(): Promise<AnyModule> {
  if (!_piAgentCore) _piAgentCore = await import('@mariozechner/pi-agent-core');
  return _piAgentCore;
}
