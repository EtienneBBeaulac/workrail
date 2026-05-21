import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentToolResult, AgentToolCallResult } from '../agent-loop.js';
import { getArtifactBlockedMessage } from '../../v2/durable-core/schemas/artifacts/blocked-messages.js';
import { V2ContinueWorkflowOutputSchema } from '../../mcp/output-schemas.js';
import type { z } from 'zod';

export type ContinueWorkflowOutput = z.infer<typeof V2ContinueWorkflowOutputSchema>;

export type CortexEvent =
  | { kind: 'step_failure_observed'; stepId: string; failureCount: number; errorSummary: string; ts: number }
  | { kind: 'hint_injected'; stepId: string; ts: number }
  | { kind: 'scaffold_injected'; stepId: string; ts: number }
  | { kind: 'step_rewound'; stepId: string; ts: number }
  | { kind: 'operator_escalated'; stepId: string; ts: number }
  | { kind: 'step_advanced'; stepId: string; ts: number };

export type StepCortexState =
  | { readonly status: 'none'; readonly failureCount: 0 }
  | { readonly status: 'hint_injected'; readonly failureCount: 1 }
  | { readonly status: 'scaffold_injected'; readonly failureCount: number };

export class SessionCortex {
  private readonly cortexPath: string;
  private readonly stepStates = new Map<string, StepCortexState>();
  private lastStepId: string | null = null;

  constructor(cortexPath: string) {
    this.cortexPath = cortexPath;
  }

  /**
   * Load the event log and replay events to restore state for in-flight sessions.
   */
  async load(initialStepId: string | null): Promise<void> {
    this.lastStepId = initialStepId;
    try {
      const data = await fs.readFile(this.cortexPath, 'utf8');
      const lines = data.split('\n').filter((line) => line.trim().length > 0);
      const events: CortexEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore corrupted/incomplete lines (crash safety)
        }
      }

      for (const event of events) {
        switch (event.kind) {
          case 'step_failure_observed': {
            const current = this.stepStates.get(event.stepId);
            const status = current?.status ?? 'none';
            if (status === 'none') {
              this.stepStates.set(event.stepId, { status: 'none', failureCount: 0 });
            } else if (status === 'hint_injected') {
              this.stepStates.set(event.stepId, { status: 'hint_injected', failureCount: 1 });
            } else {
              this.stepStates.set(event.stepId, { status: 'scaffold_injected', failureCount: event.failureCount });
            }
            break;
          }
          case 'hint_injected': {
            this.stepStates.set(event.stepId, { status: 'hint_injected', failureCount: 1 });
            break;
          }
          case 'scaffold_injected': {
            const current = this.stepStates.get(event.stepId);
            const failureCount = current?.failureCount ?? 2;
            this.stepStates.set(event.stepId, { status: 'scaffold_injected', failureCount });
            break;
          }
          case 'step_advanced':
            this.stepStates.delete(event.stepId);
            break;
          case 'step_rewound':
          case 'operator_escalated':
            break;
        }
      }
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code !== 'ENOENT') {
        const message = 'message' in e ? String(e.message) : '';
        console.error(`[SessionCortex] Error reading event log: ${message}`);
      }
    }
  }

  /**
   * Log an event to the append-only JSONL log file.
   */
  private async logEvent(event: CortexEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cortexPath), { recursive: true });
      await fs.appendFile(this.cortexPath, JSON.stringify(event) + '\n', 'utf8');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[SessionCortex] Failed to write event to log: ${message}`);
    }
  }

  /**
   * Handle the turn_end event, detecting rejections and injecting steer guidance.
   */
  async handleTurnEnd(
    event: { readonly type: 'turn_end'; readonly toolResults: ReadonlyArray<AgentToolCallResult> },
    agent: { steer(msg: { role: 'user'; content: string; timestamp: number }): void },
    state: { pendingStepIdAfterAdvance: string | null; pendingSteerParts: string[] },
  ): Promise<void> {
    // 1. Detect step advancement/transition
    const currentStepId = state.pendingStepIdAfterAdvance;
    if (currentStepId !== this.lastStepId) {
      if (this.lastStepId !== null) {
        await this.logEvent({ kind: 'step_advanced', stepId: this.lastStepId, ts: Date.now() });
        this.stepStates.delete(this.lastStepId);
      }
      this.lastStepId = currentStepId;
    }

    if (!currentStepId) return;

    // 2. Check if complete_step was called and returned a blocked outcome
    const completeStepResult = event.toolResults.find((r) => r.toolName === 'complete_step');
    if (!completeStepResult || completeStepResult.isError) return;

    const result = completeStepResult.result as AgentToolResult<ContinueWorkflowOutput> | null;
    const details = result?.details;
    if (!details || details.kind !== 'blocked') return;

    // 3. Extract validation/contract information safely
    const blockers = details.blockers?.blockers ?? [];
    let contractRef: string | undefined = undefined;
    for (const b of blockers) {
      if (b.pointer.kind === 'output_contract') {
        contractRef = b.pointer.contractRef;
        break;
      }
    }

    // 4. Update failure count using single StepCortexState discriminated union Map
    const currentState = this.stepStates.get(currentStepId) ?? { status: 'none', failureCount: 0 };
    const newCount = currentState.failureCount + 1;

    const errorSummary = blockers.map((b) => b.message).join(' | ').slice(0, 200);
    await this.logEvent({
      kind: 'step_failure_observed',
      stepId: currentStepId,
      failureCount: newCount,
      errorSummary,
      ts: Date.now(),
    });

    // 5. Escalate and inject steer guidance
    if (newCount === 1) {
      if (currentState.status === 'none') {
        this.stepStates.set(currentStepId, { status: 'hint_injected', failureCount: 1 });
        await this.logEvent({ kind: 'hint_injected', stepId: currentStepId, ts: Date.now() });

        const hint = contractRef
          ? this.buildHintMessage(currentStepId, contractRef)
          : this.buildHintFallback(currentStepId);
        
        state.pendingSteerParts.push(hint);
      }
    } else if (newCount === 2) {
      if (currentState.status === 'hint_injected') {
        this.stepStates.set(currentStepId, { status: 'scaffold_injected', failureCount: 2 });
        await this.logEvent({ kind: 'scaffold_injected', stepId: currentStepId, ts: Date.now() });

        const scaffoldLines = contractRef ? getArtifactBlockedMessage(contractRef) : null;
        const scaffold = (contractRef && scaffoldLines)
          ? this.buildScaffoldMessage(currentStepId, contractRef, scaffoldLines)
          : this.buildScaffoldFallback(currentStepId);

        state.pendingSteerParts.push(scaffold);
      }
    } else {
      this.stepStates.set(currentStepId, { status: 'scaffold_injected', failureCount: newCount });
    }
  }

  private buildHintMessage(stepId: string, contractRef: string): string {
    const artifactName = contractRef.replace('wr.contracts.', '');
    return [
      `**Cortex Interceded (Tier-1 Hint)**`,
      `Your submission for step '${stepId}' was rejected because it is missing the required output artifact.`,
      `- **Required Contract**: \`${contractRef}\` (kind: \`${artifactName}\`)`,
      `- **Action**: You must call \`complete_step\` with a valid \`wr.${artifactName}\` artifact (formatted as JSON) in the \`artifacts\` array parameter.`,
      `- **Format Guidance**: Make sure your artifact exactly matches the schema. Double-check your parameters and notes.`
    ].join('\n');
  }

  private buildScaffoldMessage(stepId: string, contractRef: string, scaffoldLines: readonly string[]): string {
    return [
      `**Cortex Interceded (Tier-2 Scaffold)**`,
      `Your submission for step '${stepId}' was rejected again. To help you proceed, here is a complete copy-pasteable example of a valid artifact for this contract (\`${contractRef}\`):`,
      ``,
      `\`\`\`json`,
      scaffoldLines.join('\n'),
      `\`\`\``,
      ``,
      `Please call \`complete_step\` and include this artifact in the \`artifacts\` parameter, filling in correct values for your task.`,
      `If you have failed multiple times, stop trying the same unsuccessful approach. Re-read the step prompt and validation criteria, adjust your parameters, and call \`complete_step\` with the corrected artifact.`
    ].join('\n');
  }

  private buildHintFallback(stepId: string): string {
    return [
      `**Cortex Interceded (Tier-1 Hint)**`,
      `Your submission for step '${stepId}' was rejected by the engine.`,
      `Please check the step prompt and validation criteria for the required artifact format, and pass it in \`output.artifacts\` of your next \`complete_step\` call.`
    ].join('\n');
  }

  private buildScaffoldFallback(stepId: string): string {
    return [
      `**Cortex Interceded (Tier-2 Scaffold)**`,
      `Your submission for step '${stepId}' was rejected again.`,
      `Please carefully review the required output schema from the step prompt, ensure all validation criteria are met, and pass the correct artifact in \`output.artifacts\` of your next \`complete_step\` call.`
    ].join('\n');
  }
}
