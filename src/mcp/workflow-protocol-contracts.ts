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
    required: ['workflowId'],
    optional: ['workspacePath'],
  },
  descriptions: {
    standard: {
      purpose: 'Start a WorkRail v2 workflow and begin following its step-by-step instructions.',
      whenToUse:
        'Use this when you found the right workflow and are ready to execute it. The response body is the current step; the structured response includes the token(s) for your next call.',
      rules: [
        'Follow the returned step exactly; it represents the user\'s plan for the task.',
        'When the step is done, call continue_workflow with the returned continueToken.',
        'Only pass context on later continue_workflow calls if facts changed.',
      ],
      examplePayload: {
        workflowId: 'coding-task-workflow-agentic',
        workspacePath: '/Users/you/git/my-project',
      },
      returns: 'Step instructions plus continueToken and checkpointToken in the structured response.',
    },
    authoritative: {
      purpose: 'Begin executing the selected WorkRail v2 workflow.',
      whenToUse:
        'Call this once you have chosen the workflow you will follow. The returned step is a direct instruction from the user or workflow author.',
      rules: [
        'Execute the returned step exactly as written.',
        'When the step is complete, call continue_workflow with the returned continueToken.',
        'Pass workspacePath when available so WorkRail anchors the session to the correct workspace.',
      ],
      examplePayload: {
        workflowId: 'coding-task-workflow-agentic',
        workspacePath: '/Users/you/git/my-project',
      },
      returns: 'Step instructions plus continueToken and checkpointToken in the structured response.',
    },
  },
};

export const CONTINUE_WORKFLOW_PROTOCOL: WorkflowProtocolContract = {
  canonicalParams: {
    required: ['continueToken'],
    optional: ['intent', 'context', 'output'],
  },
  aliasMap: {
    contextVariables: 'context',
  },
  descriptions: {
    standard: {
      purpose: 'Advance or rehydrate the current WorkRail v2 step using the single-token protocol.',
      whenToUse:
        'Use this after completing a step, or to recover the current step after lost context.',
      rules: [
        'Advance by sending output (and intent: "advance" if you want to be explicit).',
        'Rehydrate by omitting output (and intent: "rehydrate" if you want to be explicit).',
        'Put changed facts under context only.',
        'Round-trip continueToken exactly as returned by WorkRail; use the single-token API only.',
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
      purpose: 'Continue the active WorkRail v2 workflow with the canonical single-token API.',
      whenToUse:
        'Call this after you complete the current step, or call it in rehydrate mode to recover the current step without advancing.',
      rules: [
        'Use continueToken exactly as returned by WorkRail.',
        'Use the single-token API only.',
        'Advance by sending output; rehydrate by omitting output.',
        'Put updated facts in context only.',
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
    required: [],
    optional: ['query', 'gitBranch', 'gitHeadSha', 'workspacePath'],
  },
  descriptions: {
    standard: {
      purpose: 'Find and reconnect to an existing WorkRail v2 workflow session.',
      whenToUse:
        'Use this when you need to resume a previously started workflow but no longer have the latest continueToken in chat context.',
      rules: [
        'Always pass query with the user\'s stated topic or intent (e.g. "resume the ACEI-1234 workflow"). Without query, only git-context matching runs and the right session may not surface.',
        'Pass workspacePath when available so WorkRail can match sessions to the correct workspace and git context.',
        'Pick the best candidate, then call continue_workflow using its nextCall template — no manual parameter construction needed.',
        'Do not call read_session to resume; use the nextCall from the chosen candidate.',
        'If candidates is empty, no eligible session exists — call start_workflow to begin a new session instead.',
        'If all candidates have whyMatched: ["recency_fallback"], the match had no strong signal (git or notes). Verify the snippet before resuming.',
      ],
      examplePayload: {
        workspacePath: '/Users/you/git/my-project',
        query: 'resume the coding task workflow for protocol drift',
      },
      returns: 'Up to 5 ranked candidates, each with whyMatched explaining the match signal and a nextCall template for continue_workflow. If candidates is empty, call start_workflow.',
    },
    authoritative: {
      purpose: 'Find an existing WorkRail v2 session and reconnect to it deterministically.',
      whenToUse:
        'Call this when resuming a workflow without the latest in-chat token block.',
      rules: [
        'Always pass query with the user\'s stated topic or intent. Semantic (notes) matching only runs when query is provided.',
        'Pass workspacePath set to the current workspace whenever possible.',
        'Pick the best candidate and call continue_workflow with its nextCall — the resumeToken is already embedded in nextCall.params.continueToken.',
        'Do not invent token values or call read_session to resume execution.',
        'If candidates is empty, no eligible session exists — call start_workflow instead.',
        'whyMatched values: matched_head_sha / matched_branch / matched_notes = strong signal; recency_fallback = no signal, verify snippet before resuming.',
      ],
      examplePayload: {
        workspacePath: '/Users/you/git/my-project',
        query: 'resume the coding task workflow for protocol drift',
      },
      returns: 'Up to 5 ranked candidates, each with whyMatched confidence signals and a pre-built nextCall. Empty candidates means no session found — call start_workflow.',
    },
  },
};

export function renderProtocolDescription(
  contract: WorkflowProtocolContract,
  mode: DescriptionMode,
): string {
  return renderCompactDescription(contract.descriptions[mode], contract.canonicalParams);
}
