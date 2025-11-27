import { Workflow } from '../../types/mcp-types';
import { LoopStackFrame, EnhancedContext } from '../../types/workflow-types';

/**
 * Service responsible for stateless recovery of loop execution state.
 * Follows SRP - single concern: "Restore loop state from execution history"
 * 
 * This service handles the common case where MCP agents don't preserve _loopStack
 * between calls. It reconstructs the loop stack from completed steps.
 */
export interface ILoopRecoveryService {
  /**
   * Recovers loop stack from completed steps when _loopStack is missing.
   * Uses iteration variables from context when available for accuracy.
   * 
   * @param workflow - The workflow being executed
   * @param completed - Array of completed step IDs (will be MUTATED - body steps removed)
   * @param context - Current execution context (may contain iteration variables)
   * @param loopBodySteps - Set of all loop body step IDs in the workflow
   * @returns Reconstructed loop stack frames
   */
  recoverLoopStack(
    workflow: Workflow,
    completed: string[],
    context: EnhancedContext,
    loopBodySteps: Set<string>
  ): LoopStackFrame[];
}
