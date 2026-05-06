/**
 * Session notes loader for daemon agent sessions.
 *
 * WHY this module: loadSessionNotes() is an I/O function that reads from the
 * WorkRail session store. It has no AgentLoop, SessionState, or SessionScope
 * dependencies -- only V2ToolContext (for store access) and domain types.
 * It belongs in the io/ layer, not in the orchestration file.
 *
 * MAX_SESSION_RECAP_NOTES and MAX_SESSION_NOTE_CHARS live here alongside the
 * function that uses them. They are exported for use by callers that need to
 * document the constraints they apply (e.g., context-loader.ts docs).
 */

import type { V2ToolContext } from '../../mcp/types.js';
import { parseContinueTokenOrFail } from '../../mcp/handlers/v2-token-ops.js';
import { asSessionId } from '../../v2/durable-core/ids/index.js';
import { projectNodeOutputsV2 } from '../../v2/projections/node-outputs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of prior step notes injected into the session state recap.
 * WHY: Caps context window usage. Three notes (~200 tokens each) gives the agent
 * meaningful continuity without bloating the system prompt.
 */
export const MAX_SESSION_RECAP_NOTES = 3;

/**
 * Maximum characters per note in the session state recap.
 * WHY: Individual step notes can be long (30+ lines). Truncating at 800 chars
 * preserves the summary while preventing a single verbose note from consuming
 * the entire session state budget.
 */
export const MAX_SESSION_NOTE_CHARS = 800;

// ---------------------------------------------------------------------------
// loadSessionNotes
// ---------------------------------------------------------------------------

/**
 * Load prior step notes from the WorkRail session store for recap injection.
 *
 * Best-effort: any failure (token decode, store load, projection) logs a WARN
 * and returns an empty array so the daemon session can continue without context.
 * WHY: session state is a continuity aid, not a correctness requirement. A
 * session that starts without a recap still functions correctly -- it just has
 * no awareness of prior steps from the same checkpoint-resumed session.
 *
 * WHY system prompt injection instead of agent.steer():
 * The daemon calls executeStartWorkflow() BEFORE constructing the Agent.
 * Populating the system prompt at Agent construction time satisfies
 * "after start_workflow fires, before first LLM call" -- steer() would fire
 * AFTER the first LLM response (incorrect ordering for pre-step-1 context).
 *
 * @param continueToken - The continueToken from executeStartWorkflow (used to
 *   extract the sessionId via the alias store, without schema changes).
 * @param ctx - V2ToolContext providing tokenCodecPorts, tokenAliasStore, sessionStore.
 */
export async function loadSessionNotes(
  continueToken: string,
  ctx: V2ToolContext,
): Promise<readonly string[]> {
  try {
    const resolvedResult = await parseContinueTokenOrFail(
      continueToken,
      ctx.v2.tokenCodecPorts,
      ctx.v2.tokenAliasStore,
    );

    if (resolvedResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not decode continueToken for session recap: ${resolvedResult.error.message}`,
      );
      return [];
    }

    const sessionId = asSessionId(resolvedResult.value.sessionId);

    const loadResult = await ctx.v2.sessionStore.load(sessionId);
    if (loadResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not load session store for recap: ${loadResult.error.code} -- ${loadResult.error.message}`,
      );
      return [];
    }

    const projectionResult = projectNodeOutputsV2(loadResult.value.events);
    if (projectionResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not project session outputs for recap: ${projectionResult.error.code} -- ${projectionResult.error.message}`,
      );
      return [];
    }

    // Collect all recap-channel notes across all nodes, in event order.
    // WHY recap channel only: 'artifact' outputs are references, not human-readable notes.
    const allNotes: string[] = [];
    for (const nodeView of Object.values(projectionResult.value.nodesById)) {
      for (const output of nodeView.currentByChannel.recap) {
        if (output.payload.payloadKind === 'notes') {
          const note = output.payload.notesMarkdown.length > MAX_SESSION_NOTE_CHARS
            ? output.payload.notesMarkdown.slice(0, MAX_SESSION_NOTE_CHARS) + '\n[truncated]'
            : output.payload.notesMarkdown;
          allNotes.push(note);
        }
      }
    }

    return allNotes.slice(-MAX_SESSION_RECAP_NOTES);
  } catch (err) {
    console.warn(
      `[WorkflowRunner] Warning: unexpected error loading session notes for recap: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
