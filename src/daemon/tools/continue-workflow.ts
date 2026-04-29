/**
 * Factories for the continue_workflow and complete_step tools used in daemon agent sessions.
 *
 * These two tools share workflow advancement logic (executeContinueWorkflow, persistTokens).
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { V2ToolContext } from '../../mcp/types.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { executeContinueWorkflow } from '../../mcp/handlers/v2-execution/index.js';
import { persistTokens, withWorkrailSession } from './_shared.js';

export function makeContinueWorkflowTool(
  sessionId: string,
  ctx: V2ToolContext,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  // Optional injection point for testing -- defaults to the real implementation.
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
): AgentTool {
  return {
    name: 'continue_workflow',
    description:
      '[DEPRECATED in daemon sessions -- use complete_step instead] ' +
      'Advance the WorkRail workflow to the next step. Call this after completing all work ' +
      'required by the current step. Include your notes in notesMarkdown. ' +
      'When the step requires an assessment gate, include wr.assessment objects in artifacts.',
    inputSchema: schemas['ContinueWorkflowParams'],
    label: 'Continue Workflow',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      console.log(`[WorkflowRunner] Tool: continue_workflow sessionId=${sessionId}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'continue_workflow', summary: (params.intent as string | undefined) ?? 'advance', ...withWorkrailSession(workrailSessionId) });
      const result = await _executeContinueWorkflowFn(
        {
          continueToken: params.continueToken,
          intent: (params.intent ?? 'advance') as 'advance' | 'rehydrate',
          // WHY: output is constructed when either notesMarkdown or artifacts is present.
          // Agents may need to submit assessment artifacts without notes (e.g. when the
          // step's only requirement is an assessment gate). Using `?.length` prevents an
          // empty artifacts array from constructing a spurious output object.
          output: (params.notesMarkdown || (params.artifacts as unknown[] | undefined)?.length)
            ? {
                ...(params.notesMarkdown ? { notesMarkdown: params.notesMarkdown } : {}),
                ...(params.artifacts ? { artifacts: params.artifacts } : {}),
              }
            : undefined,
          context: params.context,
        },
        ctx,
      );

      if (result.isErr()) {
        throw new Error(`continue_workflow failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
      }

      const out = result.value.response;

      // Persist tokens atomically before returning -- crash safety invariant.
      // WHY continueToken vs retryToken: for a blocked response, nextCall.params.continueToken
      // is the retry token (retryContinueToken for retryable, or continueToken for non-retryable).
      // Persisting this ensures crash recovery resumes with the correct token.
      const continueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      const persistToken = (out.kind === 'blocked' ? out.nextCall?.params.continueToken : undefined) ?? continueToken;
      if (persistToken) {
        const persistResult = await persistTokens(sessionId, persistToken, checkpointToken);
        // WHY log-and-continue (not throw): a persist failure degrades crash recovery but
        // the session is still live and the LLM has the token in memory. Killing the session
        // here loses in-progress work. Invariant 4.3: onAdvance/onTokenUpdate must still fire.
        if (persistResult.kind === 'err') {
          console.warn(`[WorkflowRunner] persistTokens failed (continue_workflow): ${persistResult.error.code} -- ${persistResult.error.message}`);
        }
      }

      // WHY: when the engine returns a blocked response, the step did NOT advance.
      // Calling onAdvance() would erroneously signal advancement and cause the agent
      // to loop forever believing it moved forward. Return feedback instead so the
      // agent knows what to fix and can retry the same step.
      if (out.kind === 'blocked') {
        const retryToken = out.nextCall?.params.continueToken ?? continueToken;
        const lines: string[] = ['## Step blocked -- action required\n'];

        for (const blocker of out.blockers.blockers) {
          lines.push(blocker.message);
          if (blocker.suggestedFix) {
            lines.push(`\nWhat to do: ${blocker.suggestedFix}`);
          }
          lines.push('');
        }

        if (out.validation) {
          if (out.validation.issues.length > 0) {
            lines.push('**Issues:**');
            for (const issue of out.validation.issues) lines.push(`- ${issue}`);
            lines.push('');
          }
          if (out.validation.suggestions.length > 0) {
            lines.push('**Suggestions:**');
            for (const s of out.validation.suggestions) lines.push(`- ${s}`);
            lines.push('');
          }
        }

        if (out.assessmentFollowup) {
          lines.push(`**Follow-up required:** ${out.assessmentFollowup.title}`);
          lines.push(out.assessmentFollowup.guidance);
          lines.push('');
        }

        if (out.retryable) {
          lines.push(`Retry the same step with corrected output.\n\ncontinueToken: ${retryToken}`);
        } else {
          lines.push(`You cannot proceed without resolving this. Inform the user and wait for their response, then call continue_workflow.\n\ncontinueToken: ${retryToken}`);
        }

        const feedback = lines.join('\n');
        return {
          content: [{ type: 'text', text: feedback }],
          details: out,
        };
      }

      if (out.isComplete) {
        // Pass the agent's notes and artifacts from this final step to onComplete so the
        // trigger layer can extract the structured handoff artifact for delivery, and so
        // coordinators can read typed artifacts via WorkflowRunSuccess.lastStepArtifacts.
        onComplete(
          params.notesMarkdown as string | undefined,
          Array.isArray(params.artifacts) ? (params.artifacts as readonly unknown[]) : undefined,
        );
        return {
          content: [{ type: 'text', text: 'Workflow complete. All steps have been executed.' }],
          details: out,
        };
      }

      const pending = out.pending;
      const stepText = pending
        ? `## Next step: ${pending.title}\n\n${pending.prompt}\n\ncontinueToken: ${continueToken}`
        : `Step advanced. continueToken: ${continueToken}`;

      onAdvance(stepText, continueToken);

      return {
        content: [{ type: 'text', text: stepText }],
        details: out,
      };
    },
  };
}

/**
 * Build the complete_step tool for daemon sessions.
 *
 * WHY this tool exists: continue_workflow requires the LLM to round-trip a
 * continueToken (an HMAC-signed opaque token). The LLM frequently mangles
 * this token, causing TOKEN_BAD_SIGNATURE errors that kill sessions. complete_step
 * eliminates this failure mode by having the daemon inject the continueToken
 * internally -- the LLM only provides notes, artifacts, and context.
 *
 * WHY two token-update paths: the continueToken must be updated on both
 * (a) successful advance: getCurrentToken() returns the new next-step token
 *     from the response, which onAdvance will have stored before the next call.
 * (b) blocked retry: the engine returns a retryContinueToken that must be used
 *     on the retry call; onTokenUpdate updates the closure variable so the next
 *     complete_step call injects the correct retry token.
 * Both paths are mutually exclusive (kind: 'ok' vs kind: 'blocked') and cannot
 * race because AgentLoop runs tools sequentially (toolExecution: 'sequential').
 *
 * WHY getCurrentToken is a getter (not a value): the closure variable
 * currentContinueToken in runWorkflow() is updated after each step advance.
 * The getter captures the variable by reference so each complete_step call
 * reads the current token at call time, not at construction time.
 *
 * @param sessionId - Process-local UUID for crash-recovery token persistence.
 * @param ctx - V2ToolContext from the shared DI container.
 * @param getCurrentToken - Getter that returns the current continueToken from the
 *   runWorkflow() closure. Called at tool execution time, not construction time.
 * @param onAdvance - Called after a successful step advance with the next step text
 *   and the new continueToken. Appends step text to pendingSteerParts and updates currentContinueToken.
 * @param onComplete - Called when the workflow is complete.
 * @param onTokenUpdate - Called when the continueToken changes without an advance
 *   (i.e., on a blocked retry). Updates currentContinueToken in the runWorkflow() closure.
 * @param schemas - Plain JSON Schema map from getSchemas().
 * @param _executeContinueWorkflowFn - Optional injection point for testing.
 * @param emitter - Optional event emitter for structured lifecycle events.
 * @param workrailSessionId - WorkRail session ID for event correlation.
 */
export function makeCompleteStepTool(
  sessionId: string,
  ctx: V2ToolContext,
  getCurrentToken: () => string,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void,
  onTokenUpdate: (t: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  // Optional injection point for testing -- defaults to the real implementation.
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
): AgentTool {
  return {
    name: 'complete_step',
    description:
      'Mark the current WorkRail workflow step as complete and advance to the next one. ' +
      'Call this after completing all work required by the current step. ' +
      'Include your substantive notes (min 50 characters) describing what you did. ' +
      'The daemon manages the session token internally -- you do not need a continueToken. ' +
      'When the step requires an assessment gate, include wr.assessment objects in artifacts.',
    inputSchema: schemas['CompleteStepParams'],
    label: 'Complete Step',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      console.log(`[WorkflowRunner] Tool: complete_step sessionId=${sessionId}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'complete_step', summary: 'advance', ...withWorkrailSession(workrailSessionId) });

      // WHY runtime validation: JSON Schema minLength is informational to the LLM
      // but NOT enforced by AgentLoop. We must validate here so the LLM gets a
      // clear error immediately, rather than a downstream blocked response from
      // the engine. Fail fast at the boundary.
      const notes = params.notes as string | undefined;
      if (!notes || notes.length < 50) {
        throw new Error(
          `complete_step: notes is required and must be at least 50 characters. ` +
          `Provide substantive notes describing what you did, what you produced, and any notable decisions. ` +
          `Current length: ${notes?.length ?? 0} characters.`,
        );
      }

      // WHY inject getCurrentToken(): the daemon holds the continueToken in a
      // closure variable (currentContinueToken in runWorkflow()). The LLM never
      // sees this token -- we inject it here so the engine can authenticate the
      // advance call. This is the core value of complete_step over continue_workflow.
      const continueToken = getCurrentToken();

      const result = await _executeContinueWorkflowFn(
        {
          continueToken,
          intent: 'advance',
          // WHY: output is constructed when notes is present (always true after validation)
          // or when artifacts is a non-empty array (e.g. assessment-only steps without notes,
          // though complete_step always requires notes). An empty artifacts array must not
          // spread {} or {} with artifacts: [] -- use ?.length to guard against this.
          output: (notes || (params.artifacts as unknown[] | undefined)?.length)
            ? {
                notesMarkdown: notes,
                ...((params.artifacts as unknown[] | undefined)?.length ? { artifacts: params.artifacts } : {}),
              }
            : undefined,
          context: params.context,
        },
        ctx,
      );

      if (result.isErr()) {
        throw new Error(`complete_step failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
      }

      const out = result.value.response;

      // Persist tokens atomically before returning -- crash safety invariant.
      // WHY this must happen before onAdvance/onTokenUpdate: a crash between
      // executeContinueWorkflow returning and the token being persisted would
      // leave no recoverable state. Persisting first ensures crash recovery works.
      const newContinueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      // WHY blocked uses retry token: on a blocked response, the engine returns a
      // retryContinueToken (via nextCall.params.continueToken). The session token
      // advances to this retry token -- the original session token is consumed.
      const persistToken = (out.kind === 'blocked' ? out.nextCall?.params.continueToken : undefined) ?? newContinueToken;
      if (persistToken) {
        const persistResult = await persistTokens(sessionId, persistToken, checkpointToken);
        // WHY log-and-continue (not throw): a persist failure degrades crash recovery but
        // the session is still live. Invariant 4.3: onAdvance/onTokenUpdate must still fire.
        if (persistResult.kind === 'err') {
          console.warn(`[WorkflowRunner] persistTokens failed (complete_step): ${persistResult.error.code} -- ${persistResult.error.message}`);
        }
      }

      // WHY onTokenUpdate on blocked: the next complete_step call must inject the
      // retry token (not the original session token). We update the closure variable
      // so getCurrentToken() returns the correct retry token on the next call.
      // This is a separate path from onAdvance because a blocked response does NOT
      // advance the step -- it only changes which token is valid for retry.
      if (out.kind === 'blocked') {
        const retryToken = out.nextCall?.params.continueToken ?? newContinueToken;
        // Update the closure token to the retry token for the next complete_step call.
        onTokenUpdate(retryToken);

        const lines: string[] = ['## Step blocked -- action required\n'];

        for (const blocker of out.blockers.blockers) {
          lines.push(blocker.message);
          if (blocker.suggestedFix) {
            lines.push(`\nWhat to do: ${blocker.suggestedFix}`);
          }
          lines.push('');
        }

        if (out.validation) {
          if (out.validation.issues.length > 0) {
            lines.push('**Issues:**');
            for (const issue of out.validation.issues) lines.push(`- ${issue}`);
            lines.push('');
          }
          if (out.validation.suggestions.length > 0) {
            lines.push('**Suggestions:**');
            for (const s of out.validation.suggestions) lines.push(`- ${s}`);
            lines.push('');
          }
        }

        if (out.assessmentFollowup) {
          lines.push(`**Follow-up required:** ${out.assessmentFollowup.title}`);
          lines.push(out.assessmentFollowup.guidance);
          lines.push('');
        }

        if (out.retryable) {
          lines.push(`Retry the same step: call complete_step again with corrected notes.`);
        } else {
          lines.push(`You cannot proceed without resolving this. Inform the user and wait for their response, then call complete_step.`);
        }

        const feedback = lines.join('\n');
        return {
          content: [{ type: 'text', text: feedback }],
          details: out,
        };
      }

      if (out.isComplete) {
        // Forward artifacts alongside notes so WorkflowRunSuccess.lastStepArtifacts is
        // populated for coordinator consumption. See docs/discovery/artifacts-coordinator-channel.md.
        onComplete(notes, Array.isArray(params.artifacts) ? (params.artifacts as readonly unknown[]) : undefined);
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'complete' }) }],
          details: out,
        };
      }

      const pending = out.pending;
      // WHY no continueToken in the response text: the LLM does not need the token.
      // Including it would invite the LLM to store it and pass it to continue_workflow,
      // defeating the purpose of complete_step.
      const nextStepTitle = pending?.title ?? 'Next step';
      const stepText = pending
        ? `${JSON.stringify({ status: 'advanced', nextStep: pending.title })}\n\n## ${pending.title}\n\n${pending.prompt}`
        : JSON.stringify({ status: 'advanced', nextStep: nextStepTitle });

      onAdvance(stepText, newContinueToken);

      return {
        content: [{ type: 'text', text: stepText }],
        details: out,
      };
    },
  };
}
