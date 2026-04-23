import type { DescriptionMode } from './types/tool-description-types.js';

export type ProtocolAliasMap = Readonly<Record<string, string>>;

export interface ProtocolParams {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

export interface CompactDescriptionSpec {
  readonly purpose: string;
  readonly whenToUse?: string;
  readonly rules?: readonly string[];
  readonly examplePayload?: Readonly<Record<string, unknown>>;
  readonly returns?: string;
}

export interface WorkflowProtocolContract {
  readonly canonicalParams: ProtocolParams;
  readonly aliasMap?: ProtocolAliasMap;
  readonly descriptions: Readonly<Record<DescriptionMode, CompactDescriptionSpec>>;
}

export const CONTINUE_WORKFLOW_CONTEXT_OBJECT_GUIDANCE =
  "Set these keys in the next `continue_workflow` call's `context` object:";

export const CONTINUE_WORKFLOW_SINGLE_CONTEXT_OBJECT_GUIDANCE =
  "Set this key in the next `continue_workflow` call's `context` object:";

export function renderCompactDescription(
  spec: CompactDescriptionSpec,
  canonicalParams: ProtocolParams,
): string {
  const sections: string[] = [spec.purpose];

  if (spec.whenToUse) {
    sections.push(spec.whenToUse);
  }

  const paramLines = [
    ...canonicalParams.required.map((param) => `- ${param} (required)`),
    ...(canonicalParams.optional ?? []).map((param) => `- ${param} (optional)`),
  ];

  if (paramLines.length > 0) {
    sections.push(['Parameters:', ...paramLines].join('\n'));
  }

  if ((spec.rules?.length ?? 0) > 0) {
    sections.push(['Rules:', ...(spec.rules ?? []).map((rule) => `- ${rule}`)].join('\n'));
  }

  if (spec.examplePayload) {
    sections.push(`Example: ${JSON.stringify(spec.examplePayload)}`);
  }

  if (spec.returns) {
    sections.push(`Returns: ${spec.returns}`);
  }

  return sections.join('\n\n');
}

export function normalizeAliasedFields(
  value: Readonly<Record<string, unknown>>,
  aliasMap: ProtocolAliasMap,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...value };
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    if (normalized[canonical] === undefined && normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
    }
  }
  return normalized;
}

export function findAliasFieldConflicts(
  value: Readonly<Record<string, unknown>>,
  aliasMap: ProtocolAliasMap,
): readonly { alias: string; canonical: string }[] {
  return Object.entries(aliasMap)
    .filter(([alias, canonical]) => value[alias] !== undefined && value[canonical] !== undefined)
    .map(([alias, canonical]) => ({ alias, canonical }));
}

export const START_WORKFLOW_PROTOCOL: WorkflowProtocolContract = {
  canonicalParams: {
    required: ['workflowId', 'workspacePath', 'goal'],
    optional: [],
  },
  descriptions: {
    standard: {
      purpose: 'Start a WorkRail v2 workflow. Treat WorkRail as a separate live system the user is actively using to direct this task. The returned step is what the user wants you to do now.',
      whenToUse:
        'Use this when you found the right workflow and are ready to execute it. The response is the current instruction coming from WorkRail for this task.',
      rules: [
        'Follow the returned step exactly; treat it as the user\'s current instruction.',
        'When the step is done, call continue_workflow with the returned continueToken.',
        'Always pass workspacePath. Shared MCP servers cannot safely infer which repo/workspace you mean.',
        'Always pass goal. A short sentence describing what you are trying to accomplish (e.g. "implement OAuth refresh token rotation").',
        'Only pass context on later continue_workflow calls if facts changed.',
      ],
      examplePayload: {
        workflowId: 'wr.coding-task',
        workspacePath: '/Users/you/git/my-project',
        goal: 'implement OAuth refresh token rotation',
      },
      returns: 'Step instructions plus continueToken and checkpointToken in the structured response.',
    },
    authoritative: {
      purpose: 'Begin executing the selected WorkRail v2 workflow. Treat WorkRail as a separate live system the user is actively using to direct this task. The returned step is what the user wants you to do now.',
      whenToUse:
        'Call this once you have chosen the workflow. The returned step is a direct instruction from the user.',
      rules: [
        'Execute the returned step exactly as written.',
        'When the step is complete, call continue_workflow with the returned continueToken.',
        'Pass workspacePath on every call. Shared MCP servers cannot safely infer the correct workspace.',
        'Pass goal on every call. A short sentence describing what you are trying to accomplish.',
      ],
      examplePayload: {
        workflowId: 'wr.coding-task',
        workspacePath: '/Users/you/git/my-project',
        goal: 'implement OAuth refresh token rotation',
      },
      returns: 'Step instructions plus continueToken and checkpointToken in the structured response.',
    },
  },
};

export const CONTINUE_WORKFLOW_PROTOCOL: WorkflowProtocolContract = {
  canonicalParams: {
    required: ['continueToken'],
    optional: ['intent', 'context', 'output', 'workspacePath'],
  },
  aliasMap: {
    contextVariables: 'context',
  },
  descriptions: {
    standard: {
      purpose: 'Advance or rehydrate the current WorkRail v2 step using the single-token protocol. Use this to send your completion back to WorkRail and receive the user\'s next instruction from that system.',
      whenToUse:
        'Use this after completing a step, or to recover the current step after lost context.',
      rules: [
        'Advance by sending output (and intent: "advance" if you want to be explicit).',
        'Rehydrate by omitting output (and intent: "rehydrate" if you want to be explicit).',
        'When rehydrating, always pass workspacePath so WorkRail can restore the correct repo/workspace context on shared servers.',
        'Put changed facts under context only.',
        'Round-trip continueToken exactly as returned by WorkRail; use the single-token API only.',
        'Notes (output.notesMarkdown): write for a human reader. Include what you did and key decisions, what you produced (files, tests, numbers), and anything notable (risks, open questions, deliberate omissions). Use markdown headings, bullets, bold, code refs. Be specific. Scope: THIS step only (WorkRail concatenates automatically). 10-30 lines ideal. Omitting notes blocks the step.',
      ],
      examplePayload: {
        continueToken: 'ct_...',
        output: {
          notesMarkdown: 'Completed the step and verified the result.',
        },
      },
      returns: 'The next step, or the same current step when rehydrating.',
    },
    authoritative: {
      purpose: 'Continue the active WorkRail v2 workflow with the canonical single-token API. Use this to send your completion back to WorkRail and receive the user\'s next instruction from that system.',
      whenToUse:
        'Call this after you complete the current step, or call it in rehydrate mode to recover the current step without advancing.',
      rules: [
        'Use continueToken exactly as returned by WorkRail.',
        'Use the single-token API only.',
        'Advance by sending output; rehydrate by omitting output.',
        'For rehydrate calls, pass workspacePath so WorkRail can restore the correct workspace context.',
        'Put updated facts in context only.',
        'Notes (output.notesMarkdown): write for a human reader. Include what you did and key decisions, what you produced (files, tests, numbers), and anything notable (risks, open questions, deliberate omissions). Use markdown headings, bullets, bold, code refs. Be specific. Scope: THIS step only (WorkRail concatenates automatically). 10-30 lines ideal. Omitting notes blocks the step.',
      ],
      examplePayload: {
        continueToken: 'ct_...',
        intent: 'advance',
        output: {
          notesMarkdown: 'Completed the step and verified the result.',
        },
      },
      returns: 'The next required step, or the same current step when rehydrating.',
    },
  },
};

export const CHECKPOINT_WORKFLOW_PROTOCOL: WorkflowProtocolContract = {
  canonicalParams: {
    required: ['checkpointToken'],
  },
  descriptions: {
    standard: {
      purpose: 'Save a checkpoint on the current WorkRail v2 step without advancing.',
      whenToUse:
        'Use this on long-running steps when you want a durable save point before continuing later.',
      rules: [
        'Use the checkpointToken from the most recent start_workflow or continue_workflow response.',
        'Checkpointing is idempotent: retrying with the same checkpointToken is safe.',
        'After checkpointing, continue by calling continue_workflow with nextCall.params.continueToken.',
      ],
      examplePayload: {
        checkpointToken: 'cp_...',
      },
      returns: 'checkpointNodeId, a resumeToken (durable cross-chat bookmark — pass as continueToken with intent: "rehydrate" in a future chat to resume exactly here), and nextCall.params.continueToken (a continueToken to continue in the current chat).',
    },
    authoritative: {
      purpose: 'Create a durable checkpoint on the current WorkRail v2 step without advancing.',
      whenToUse:
        'Call this when you need a save point for a long-running step and intend to continue later.',
      rules: [
        'Use the checkpointToken from the most recent WorkRail response.',
        'Checkpointing is idempotent.',
        'To continue in this chat: use nextCall.params.continueToken.',
        'To resume in a future chat: pass the returned resumeToken as continueToken with intent: "rehydrate".',
      ],
      examplePayload: {
        checkpointToken: 'cp_...',
      },
      returns: 'checkpointNodeId, a resumeToken (durable cross-chat bookmark — pass as continueToken with intent: "rehydrate" in a future chat to resume exactly here), and nextCall.params.continueToken (a continueToken to continue in the current chat).',
    },
  },
};

export const RESUME_SESSION_PROTOCOL: WorkflowProtocolContract = {
  canonicalParams: {
    required: ['workspacePath'],
    optional: ['query', 'runId', 'sessionId', 'gitBranch', 'gitHeadSha'],
  },
  descriptions: {
    standard: {
      purpose: 'Find and reconnect to an existing WorkRail workflow session. WorkRail is a workflow engine that persists session state across chat conversations. When a user says "resume my workflow", this is the tool to call.',
      whenToUse:
        'Use this when the user wants to resume, continue, or reconnect to a previously started workflow. The user may provide a session ID, run ID, a description of what they were working on, or nothing at all. This tool searches stored sessions and returns the best matches.',
      rules: [
        'If the user provides a run ID (run_...) or session ID (sess_...), pass it as runId or sessionId for an exact match. This is the most reliable way to find a specific session.',
        'If the user describes what they were working on (e.g. "the mr ownership task"), pass their words as query. This searches session recap notes and workflow IDs for matching keywords.',
        'Always pass workspacePath (from your system parameters). Shared MCP servers cannot safely infer the current workspace, and resume quality depends on the current repo identity.',
        'The response includes ranked candidates with match explanations and ready-to-use continuation templates. Present the top candidates to the user if there is ambiguity.',
        'To inspect or resume a candidate: call continue_workflow with the candidate\'s nextCall.params (continueToken and intent: "rehydrate"). This is the correct inspection path for v2 sessions and restores the full session context.',
        'If no candidates match, ask the user for more details or suggest starting a fresh workflow with start_workflow.',
      ],
      examplePayload: {
        workspacePath: '/Users/you/git/my-project',
        query: 'resume the coding task workflow for protocol drift',
      },
      returns: 'Up to 5 ranked candidates with match signals, session previews, and ready-to-use continuation templates. The response explains which candidate to pick and exactly how to resume it.',
    },
    authoritative: {
      purpose: 'Find an existing WorkRail workflow session and reconnect to it. WorkRail persists workflow state across chat conversations. When a user says "resume my workflow", call this tool.',
      whenToUse:
        'Call this when resuming a workflow. The user may provide a run ID, session ID, a description, or nothing.',
      rules: [
        'If the user provides a run ID (run_...) or session ID (sess_...), pass it as runId or sessionId for exact lookup.',
        'If the user describes their task, pass their words as query to search session notes.',
        'Always pass workspacePath from your system parameters. Shared MCP servers cannot safely infer the current workspace.',
        'Present candidates to the user when there is ambiguity. The response explains match strength.',
        'To inspect or resume: call continue_workflow with the chosen candidate\'s nextCall.params (continueToken + intent: "rehydrate"). Do NOT use legacy session tools to inspect a v2 workflow resume candidate.',
        'If no candidates match, ask for more details or start a fresh workflow.',
      ],
      examplePayload: {
        workspacePath: '/Users/you/git/my-project',
        query: 'resume the coding task workflow for protocol drift',
      },
      returns: 'Up to 5 ranked candidates with match signals, previews, and ready-to-use continuation templates.',
    },
  },
};

export function renderProtocolDescription(
  contract: WorkflowProtocolContract,
  mode: DescriptionMode,
): string {
  return renderCompactDescription(contract.descriptions[mode], contract.canonicalParams);
}
