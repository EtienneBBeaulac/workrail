import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { Workflow } from '../../../types/workflow.js';
import { getStepById } from '../../../types/workflow.js';
import type { LoadedSessionTruthV2 } from '../../ports/session-event-log-store.port.js';
import type { LoopPathFrameV1 } from '../schemas/execution-snapshot/index.js';
import type { NodeId, RunId } from '../ids/index.js';
import { asNodeId } from '../ids/index.js';
import { projectRunDagV2 } from '../../projections/run-dag.js';
import type { RunDagRunV2 } from '../../projections/run-dag.js';
import { projectNodeOutputsV2 } from '../../projections/node-outputs.js';
import type { NodeOutputsProjectionV2 } from '../../projections/node-outputs.js';
import { collectAncestryRecap, collectDownstreamRecap, buildChildSummary } from './recap-recovery.js';
import { expandFunctionDefinitions, formatFunctionDef } from './function-definition-expander.js';
import { RECOVERY_BUDGET_BYTES, TRUNCATION_MARKER } from '../constants.js';
import { extractValidationRequirements } from './validation-requirements-extractor.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../schemas/artifacts/index.js';

export type PromptRenderError = {
  readonly code: 'RENDER_FAILED';
  readonly message: string;
};

/**
 * Build non-tip recovery sections (child summaries + downstream recap).
 */
function buildNonTipSections(args: {
  readonly nodeId: NodeId;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
}): readonly string[] {
  const sections: string[] = [];

  const childSummary = buildChildSummary({ nodeId: args.nodeId, dag: args.run });
  if (childSummary) {
    sections.push(`### Branch Summary\n${childSummary}`);
  }

  if (args.run.preferredTipNodeId && args.run.preferredTipNodeId !== String(args.nodeId)) {
    const downstreamRes = collectDownstreamRecap({
      fromNodeId: args.nodeId,
      toNodeId: asNodeId(args.run.preferredTipNodeId),
      dag: args.run,
      outputs: args.outputs,
    });
    if (downstreamRes.isOk() && downstreamRes.value.length > 0) {
      sections.push(`### Downstream Recap (Preferred Branch)\n${downstreamRes.value.join('\n\n')}`);
    }
  }

  return sections;
}

/**
 * Build ancestry recap section.
 */
function buildAncestrySections(args: {
  readonly nodeId: NodeId;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
}): readonly string[] {
  const ancestryRes = collectAncestryRecap({
    nodeId: args.nodeId,
    dag: args.run,
    outputs: args.outputs,
    includeCurrentNode: false,
  });

  if (ancestryRes.isOk() && ancestryRes.value.length > 0) {
    return [`### Ancestry Recap\n${ancestryRes.value.join('\n\n')}`];
  }

  return [];
}

/**
 * Build function definitions section.
 */
function buildFunctionDefsSections(args: {
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly functionReferences: readonly string[];
}): readonly string[] {
  const funcsRes = expandFunctionDefinitions({
    workflow: args.workflow,
    stepId: args.stepId,
    loopPath: args.loopPath,
    functionReferences: args.functionReferences,
  });

  if (funcsRes.isOk() && funcsRes.value.length > 0) {
    const formatted = funcsRes.value.map(formatFunctionDef).join('\n\n');
    return [`### Function Definitions\n\`\`\`\n${formatted}\n\`\`\``];
  }

  return [];
}

/**
 * Build recovery sections (tip/non-tip aware).
 * Pure function extracting recovery logic.
 */
function buildRecoverySections(args: {
  readonly nodeId: NodeId;
  readonly dag: RunDagRunV2;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly functionReferences: readonly string[];
}): readonly string[] {
  const isTip = args.run.tipNodeIds.includes(String(args.nodeId));

  return [
    ...(isTip ? [] : buildNonTipSections({ nodeId: args.nodeId, run: args.run, outputs: args.outputs })),
    ...buildAncestrySections({ nodeId: args.nodeId, run: args.run, outputs: args.outputs }),
    ...buildFunctionDefsSections({
      workflow: args.workflow,
      stepId: args.stepId,
      loopPath: args.loopPath,
      functionReferences: args.functionReferences,
    }),
  ];
}

/**
 * Trim bytes to UTF-8 boundary (O(1) algorithm, always returns valid UTF-8).
 * 
 * Analyzes UTF-8 byte patterns directly to find incomplete trailing characters.
 * - Scans last 4 bytes max (UTF-8 chars are 1-4 bytes)
 * - Identifies lead byte and expected character length
 * - Drops incomplete character if found
 * 
 * Algorithm from notes-markdown.ts (battle-tested).
 * Lock: UTF-8 safe truncation for deterministic budgeting.
 */
function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n === 0) return bytes;

  // Count continuation bytes at end (10xxxxxx pattern)
  let cont = 0;
  for (let i = n - 1; i >= 0 && i >= n - 4; i--) {
    const b = bytes[i]!;
    if ((b & 0b1100_0000) === 0b1000_0000) {
      cont++;
    } else {
      break;
    }
  }

  if (cont === 0) return bytes; // No continuation bytes at end

  const leadByteIndex = n - cont - 1;
  if (leadByteIndex < 0) {
    // All bytes at end are continuation bytes (invalid)
    return new Uint8Array(0);
  }

  const leadByte = bytes[leadByteIndex]!;

  // Determine expected character length from lead byte
  const expectedLen =
    (leadByte & 0b1000_0000) === 0 ? 1 : // 0xxxxxxx = 1-byte (ASCII)
    (leadByte & 0b1110_0000) === 0b1100_0000 ? 2 : // 110xxxxx = 2-byte
    (leadByte & 0b1111_0000) === 0b1110_0000 ? 3 : // 1110xxxx = 3-byte
    (leadByte & 0b1111_1000) === 0b1111_0000 ? 4 : // 11110xxx = 4-byte
    0; // Invalid lead byte

  // If the last character is incomplete or invalid, drop it
  const actualLen = cont + 1;
  if (expectedLen === 0 || expectedLen !== actualLen) {
    return bytes.subarray(0, leadByteIndex);
  }

  return bytes;
}

/**
 * Apply recovery budget and truncate if needed.
 * Pure function handling deterministic truncation.
 */
function applyPromptBudget(combinedPrompt: string): string {
  const encoder = new TextEncoder();
  const promptBytes = encoder.encode(combinedPrompt);

  if (promptBytes.length <= RECOVERY_BUDGET_BYTES) {
    return combinedPrompt;
  }

  // Over budget: truncate deterministically
  const markerText = TRUNCATION_MARKER;
  const omissionNote = `\nOmitted recovery content due to budget constraints.`;
  const suffixBytes = encoder.encode(markerText + omissionNote);
  const maxContentBytes = RECOVERY_BUDGET_BYTES - suffixBytes.length;

  // Trim to UTF-8 boundary
  const truncatedBytes = trimToUtf8Boundary(promptBytes.subarray(0, maxContentBytes));
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(truncatedBytes) + markerText + omissionNote;
}

/**
 * Build a loop context banner injected before the step's authored prompt.
 * Helps agents understand they are intentionally re-entering a loop body step,
 * not looping due to an error.
 *
 * Only injected for non-exit body steps (exit steps have explicit instructions
 * in their own prompt and the output-contract requirements section).
 */
function buildLoopContextBanner(args: {
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly isExitStep: boolean;
}): string {
  if (args.loopPath.length === 0 || args.isExitStep) return '';

  const current = args.loopPath[args.loopPath.length - 1]!;
  const iterationLabel = `Iteration ${current.iteration + 1}`;

  return [
    `---`,
    `**LOOP: ${current.loopId} | ${iterationLabel}** — This step repeats intentionally; the workflow is not stuck or broken.`,
    ``,
    `Choose the instruction that matches your current task:`,
    `- **Drafting / updating**: incorporate amendments discovered in previous iterations before writing.`,
    `- **Auditing / reviewing**: look for what previous passes *missed*, not what they already caught.`,
    `- **Applying changes**: follow prior findings precisely; don't re-debate settled decisions.`,
    ``,
    `Prior iteration work is visible in the **Ancestry Recap** section below (if present).`,
    `---`,
    ``,
  ].join('\n');
}

/**
 * Format system-injected requirements for output contracts.
 * These are generated from contract metadata, not authored prompts.
 */
function formatOutputContractRequirements(
  outputContract: { readonly contractRef?: string } | undefined
): readonly string[] {
  const contractRef = outputContract?.contractRef;
  if (!contractRef) return [];

  switch (contractRef) {
    case LOOP_CONTROL_CONTRACT_REF:
      return [
        `Artifact contract: ${LOOP_CONTROL_CONTRACT_REF}`,
        `Provide an artifact with kind: "wr.loop_control"`,
        `Required field: decision ("continue" | "stop")`,
        `Optional field: loopId — omit unless targeting a specific named loop`,
      ];
    default:
      return [
        `Artifact contract: ${contractRef}`,
        `Provide an artifact matching the contract schema`,
      ];
  }
}

export interface StepMetadata {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly requireConfirmation: boolean;
}

/**
 * Load projections needed for recovery context.
 * Extracted helper to reduce renderPendingPrompt size.
 */
function loadRecoveryProjections(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
}): Result<
  { readonly run: RunDagRunV2; readonly outputs: NodeOutputsProjectionV2 },
  string
> {
  const dagRes = projectRunDagV2(args.truth.events);
  if (dagRes.isErr()) {
    return err('(Recovery context unavailable due to projection failure)');
  }

  const dag = dagRes.value;
  const run = dag.runsById[args.runId];
  if (!run) {
    return err('(Recovery context unavailable: run not found)');
  }

  const outputsRes = projectNodeOutputsV2(args.truth.events);
  if (outputsRes.isErr()) {
    return err('(Recovery context unavailable due to outputs projection failure)');
  }

  return ok({ run, outputs: outputsRes.value });
}

/**
 * Render pending prompt with recovery context (recap + function definitions).
 * 
 * This is the single seam used by all prompt construction call sites to prevent drift.
 * Lock: Recap recovery (contract §315-350, locks §1040-1051)
 */
export function renderPendingPrompt(args: {
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly rehydrateOnly: boolean;
}): Result<StepMetadata, PromptRenderError> {
  // Extract base step metadata
  const step = getStepById(args.workflow, args.stepId);
  const baseTitle = step?.title ?? args.stepId;
  const basePrompt = step?.prompt ?? `Pending step: ${args.stepId}`;
  const requireConfirmation = Boolean(step?.requireConfirmation);
  const functionReferences = step?.functionReferences ?? [];

  // Extract output contract requirements (system-injected, not prompt-authored)
  const outputContract = step && typeof step === 'object' && 'outputContract' in step
    ? (step as { outputContract?: { contractRef?: string } }).outputContract
    : undefined;
  const isExitStep = outputContract?.contractRef === LOOP_CONTROL_CONTRACT_REF;

  // Loop context banner — prepended before the authored prompt so the agent
  // understands it is intentionally re-entering a loop body step.
  const loopBanner = buildLoopContextBanner({ loopPath: args.loopPath, isExitStep });

  // Extract validation requirements and append to prompt if present
  const validationCriteria = step?.validationCriteria;
  const requirements = extractValidationRequirements(validationCriteria);
  const requirementsSection = requirements.length > 0
    ? `\n\n**OUTPUT REQUIREMENTS:**\n${requirements.map(r => `- ${r}`).join('\n')}`
    : '';
  
  const contractRequirements = formatOutputContractRequirements(outputContract);
  const contractSection = contractRequirements.length > 0
    ? `\n\n**OUTPUT REQUIREMENTS (System):**\n${contractRequirements.map(r => `- ${r}`).join('\n')}`
    : '';

  // Notes requirement (system-injected): all steps require notes unless the step declares
  // notesOptional, or has an outputContract (artifact is the primary evidence).
  // This makes the enforcement visible to the agent before they submit.
  const isNotesOptional =
    outputContract !== undefined ||
    (step !== null && step !== undefined && 'notesOptional' in step && (step as { notesOptional?: boolean }).notesOptional === true);
  const notesSection = isNotesOptional
    ? ''
    : '\n\n**NOTES REQUIRED (System):** You must include `output.notesMarkdown` when advancing. ' +
      'These notes are displayed to the user in a markdown viewer and serve as the durable record of your work. Write them for a human reader.\n\n' +
      'Include:\n' +
      '- **What you did** and the key decisions or trade-offs you made\n' +
      '- **What you produced** — files changed, functions added, test results, specific numbers\n' +
      '- **Anything notable** — risks, open questions, things you deliberately chose NOT to do and why\n\n' +
      'Formatting: Use markdown headings, bullet lists, `code references`, and **bold** for emphasis. ' +
      'Be specific — file paths, function names, counts, not vague summaries. ' +
      '10–30 lines is ideal. Too short is worse than too long.\n\n' +
      'Scope: THIS step only — WorkRail concatenates notes across steps automatically. Never repeat previous step notes.\n\n' +
      'Example of BAD notes:\n' +
      '> Reviewed the code and found some issues. Made improvements to error handling.\n\n' +
      'Example of GOOD notes:\n' +
      '> ## Review: Authentication Module\n' +
      '> **Files examined:** `src/auth/oauth2.ts`, `src/auth/middleware.ts`, `tests/auth.test.ts`\n' +
      '>\n' +
      '> ### Key findings\n' +
      '> - Token refresh logic in `refreshAccessToken()` silently swallows network errors — changed to propagate as `AuthRefreshError`\n' +
      '> - Added missing `audience` validation in JWT verification (was accepting any audience)\n' +
      '> - **3 Critical**, 2 Major, 4 Minor findings total\n' +
      '>\n' +
      '> ### Decisions\n' +
      '> - Did NOT flag the deprecated `passport` import — it\'s used only in the legacy path scheduled for removal in Q2\n' +
      '> - Recommended extracting token storage into a `TokenStore` interface for testability\n' +
      '>\n' +
      '> ### Open questions\n' +
      '> - Should refresh tokens be rotated on every use? Current impl reuses until expiry.\n\n' +
      'Omitting notes will block this step — use the `retryAckToken` to fix and retry.';

  const enhancedPrompt = loopBanner + basePrompt + requirementsSection + contractSection + notesSection;

  // If not rehydrate-only, return enhanced prompt (no recovery needed for advance/start)
  if (!args.rehydrateOnly) {
    return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, requireConfirmation });
  }

  // Rehydrate-only: load recovery projections (extracted helper)
  const projectionsRes = loadRecoveryProjections({ truth: args.truth, runId: args.runId });
  if (projectionsRes.isErr()) {
    return ok({
      stepId: args.stepId,
      title: baseTitle,
      prompt: enhancedPrompt + '\n\n' + projectionsRes.error,
      requireConfirmation,
    });
  }

  const { run, outputs } = projectionsRes.value;

  // Build recovery sections (extracted helper)
  const sections = buildRecoverySections({
    nodeId: args.nodeId,
    dag: run,
    run,
    outputs,
    workflow: args.workflow,
    stepId: args.stepId,
    loopPath: args.loopPath,
    functionReferences,
  });

  // No recovery content
  if (sections.length === 0) {
    return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, requireConfirmation });
  }

  // Combine and apply budget (extracted helpers)
  const recoveryText = `## Recovery Context\n\n${sections.join('\n\n')}`;
  const combinedPrompt = `${enhancedPrompt}\n\n${recoveryText}`;
  const finalPrompt = applyPromptBudget(combinedPrompt);

  return ok({ stepId: args.stepId, title: baseTitle, prompt: finalPrompt, requireConfirmation });
}
