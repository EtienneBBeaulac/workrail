import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { Workflow } from '../../../types/workflow.js';
import { getStepById, isLoopStepDefinition } from '../../../types/workflow.js';
import type { AssessmentDefinition, PromptFragment } from '../../../types/workflow-definition.js';
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
import { EVENT_KIND, OUTPUT_CHANNEL, PAYLOAD_KIND } from '../constants.js';
import { extractValidationRequirements } from './validation-requirements-extractor.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../schemas/artifacts/index.js';
import { projectRunContextV2 } from '../../projections/run-context.js';
import { evaluateCondition } from '../../../utils/condition-evaluator.js';
import { resolveContextTemplates } from './context-template-resolver.js';
import type { LoopStepDefinition } from '../../../types/workflow-definition.js';
import {
  createAncestryRecapSegment,
  createBranchSummarySegment,
  createDownstreamRecapSegment,
  createFunctionDefinitionsSegment,
  renderBudgetedRehydrateRecovery,
  type RetrievalPackSegment,
} from './retrieval-contract.js';
import { CLEAN_RESPONSE_FORMAT } from '../../../env-flags.js';

export type PromptRenderError = {
  readonly code: 'RENDER_FAILED';
  readonly message: string;
};

/**
 * Build non-tip recovery segments (child summaries + downstream recap).
 */
function buildNonTipSegments(args: {
  readonly nodeId: NodeId;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
}): readonly RetrievalPackSegment[] {
  const segments: RetrievalPackSegment[] = [];

  const childSummary = buildChildSummary({ nodeId: args.nodeId, dag: args.run });
  const childSummarySegment = createBranchSummarySegment(childSummary);
  if (childSummarySegment) {
    segments.push(childSummarySegment);
  }

  if (args.run.preferredTipNodeId && args.run.preferredTipNodeId !== String(args.nodeId)) {
    const downstreamRes = collectDownstreamRecap({
      fromNodeId: args.nodeId,
      toNodeId: asNodeId(args.run.preferredTipNodeId),
      dag: args.run,
      outputs: args.outputs,
    });
    if (downstreamRes.isOk() && downstreamRes.value.length > 0) {
      const downstreamSegment = createDownstreamRecapSegment(downstreamRes.value.join('\n\n'));
      if (downstreamSegment) {
        segments.push(downstreamSegment);
      }
    }
  }

  return segments;
}

/**
 * Build ancestry recap segment.
 */
function buildAncestrySegments(args: {
  readonly nodeId: NodeId;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
}): readonly RetrievalPackSegment[] {
  const ancestryRes = collectAncestryRecap({
    nodeId: args.nodeId,
    dag: args.run,
    outputs: args.outputs,
    includeCurrentNode: false,
  });

  if (ancestryRes.isOk() && ancestryRes.value.length > 0) {
    const ancestrySegment = createAncestryRecapSegment(ancestryRes.value.join('\n\n'));
    return ancestrySegment ? [ancestrySegment] : [];
  }

  return [];
}

/**
 * Build function definitions segment.
 */
function buildFunctionDefsSegments(args: {
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly functionReferences: readonly string[];
}): readonly RetrievalPackSegment[] {
  const funcsRes = expandFunctionDefinitions({
    workflow: args.workflow,
    stepId: args.stepId,
    loopPath: args.loopPath,
    functionReferences: args.functionReferences,
  });

  if (funcsRes.isOk() && funcsRes.value.length > 0) {
    const formatted = funcsRes.value.map(formatFunctionDef).join('\n\n');
    const functionDefinitionsSegment = createFunctionDefinitionsSegment(`\`\`\`\n${formatted}\n\`\`\``);
    return functionDefinitionsSegment ? [functionDefinitionsSegment] : [];
  }

  return [];
}

function hasPriorNotesInRun(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
}): boolean {
  return args.truth.events.some((e) =>
    e.kind === EVENT_KIND.NODE_OUTPUT_APPENDED &&
    e.scope.runId === args.runId &&
    e.data.outputChannel === OUTPUT_CHANNEL.RECAP &&
    e.data.payload.payloadKind === PAYLOAD_KIND.NOTES,
  );
}

/**
 * Build recovery segments (tip/non-tip aware).
 * Pure function extracting recovery logic.
 */
function buildRecoverySegments(args: {
  readonly nodeId: NodeId;
  readonly run: RunDagRunV2;
  readonly outputs: NodeOutputsProjectionV2;
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly functionReferences: readonly string[];
}): readonly RetrievalPackSegment[] {
  const isTip = args.run.tipNodeIds.includes(String(args.nodeId));

  return [
    ...(isTip ? [] : buildNonTipSegments({ nodeId: args.nodeId, run: args.run, outputs: args.outputs })),
    ...buildAncestrySegments({ nodeId: args.nodeId, run: args.run, outputs: args.outputs }),
    ...buildFunctionDefsSegments({
      workflow: args.workflow,
      stepId: args.stepId,
      loopPath: args.loopPath,
      functionReferences: args.functionReferences,
    }),
  ];
}

/**
 * Find the parent loop step for a given body step ID.
 * Returns undefined if the step is not inside a loop.
 * Single traversal — callers derive maxIterations from the returned step directly.
 */
function resolveParentLoopStep(
  workflow: Workflow,
  stepId: string,
): LoopStepDefinition | undefined {
  for (const step of workflow.definition.steps) {
    if (isLoopStepDefinition(step) && Array.isArray(step.body)) {
      for (const bodyStep of step.body) {
        if (bodyStep.id === stepId) return step as LoopStepDefinition;
      }
    }
  }
  return undefined;
}

/**
 * Build loop-derived context variables for template substitution.
 *
 * Mirrors the logic in workflow-interpreter.ts::projectLoopContextAtIteration.
 * Kept local to avoid a cross-layer dependency on the interpreter module.
 *
 * Produces: iterationVar (1-based), and for forEach loops: itemVar, indexVar.
 * Returns an empty object when the step has no loop context or the items array
 * is not present in the session context (graceful degradation).
 */
function buildLoopRenderContext(
  loopStep: LoopStepDefinition,
  iteration: number,
  sessionContext: Record<string, unknown>,
): Record<string, unknown> {
  // Use || to match interpreter behaviour: empty string falls back to the default.
  const iterationVar = loopStep.loop.iterationVar || 'currentIteration';

  const forEachVars = (): Record<string, unknown> => {
    if (loopStep.loop.type !== 'forEach' || !loopStep.loop.items) return {};
    const items = sessionContext[loopStep.loop.items];
    if (!Array.isArray(items)) return {};
    return {
      [loopStep.loop.itemVar || 'currentItem']: items[iteration],
      [loopStep.loop.indexVar || 'currentIndex']: iteration,
    };
  };

  return {
    [iterationVar]: iteration + 1, // 1-based for agents
    ...forEachVars(),
  };
}

/**
 * Build scope-narrowing instruction based on iteration progress.
 * Guides the agent to do appropriately focused work on each pass.
 */
function buildScopeInstruction(iteration: number, maxIterations: number | undefined): string {
  if (iteration <= 1) return 'Focus on what the first pass missed — do not re-litigate settled findings.';
  if (maxIterations !== undefined && iteration + 1 >= maxIterations) return 'FINAL PASS — verify prior amendments landed correctly. Only flag regressions or clearly missed issues.';
  return 'Diminishing returns expected. Focus on gaps and regressions, not fresh territory.';
}

/**
 * Build a loop context banner injected before the step's authored prompt.
 * Helps agents understand they are re-entering a loop body step with new context.
 *
 * Design principles:
 * - Never show loopId (agents copy it into artifacts and cause mismatches).
 * - First iteration: soft orientation with termination bound.
 * - Subsequent iterations: progress indicator, scope narrowing, differentiated framing.
 * - Exit steps: no banner (they have output-contract requirements instead).
 */
function buildLoopContextBanner(args: {
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly isExitStep: boolean;
  readonly maxIterations: number | undefined;
  readonly cleanFormat?: boolean;
}): string {
  if (args.loopPath.length === 0 || args.isExitStep) return '';

  const current = args.loopPath[args.loopPath.length - 1]!;
  const iterationNumber = current.iteration + 1;
  const maxIter = args.maxIterations;

  // Clean format: single natural-sounding line, no system-looking formatting
  if (args.cleanFormat) {
    if (current.iteration === 0) {
      const bound = maxIter !== undefined ? ` (up to ${maxIter} passes)` : '';
      return `This is an iterative step${bound}. A decision step after your work determines whether another pass is needed.\n\n`;
    }
    const ofMax = maxIter !== undefined ? ` of ${maxIter}` : '';
    const scope = buildScopeInstruction(current.iteration, maxIter);
    return `Pass ${iterationNumber}${ofMax}. ${scope} Build on your previous work.\n\n`;
  }

  // First iteration: soft orientation with termination bound
  if (current.iteration === 0) {
    const bound = maxIter !== undefined ? ` (up to ${maxIter} passes)` : '';
    return [
      `> This step is part of an iterative loop${bound}. After your work, a decision step determines whether another pass is needed.`,
      ``,
    ].join('\n');
  }

  // Subsequent iterations: progress + scope + differentiated framing
  const lines: string[] = ['---'];

  // Progress indicator
  if (maxIter !== undefined) {
    const filled = Math.min(iterationNumber, maxIter);
    const empty = Math.max(maxIter - filled, 0);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
    lines.push(`**Progress: [${bar}] Pass ${iterationNumber} of ${maxIter}**`);
  } else {
    lines.push(`**Pass ${iterationNumber}**`);
  }

  lines.push('');

  // Scope narrowing
  lines.push(`**Scope**: ${buildScopeInstruction(current.iteration, maxIter)}`);
  lines.push('');

  // Task orientation
  lines.push('Your previous work is in the **Ancestry Recap** below. Build on it — do not repeat work already done.');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
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
        `Do NOT include loopId — the engine matches automatically`,
        `Canonical format:\n\`\`\`json\n{ "artifacts": [{ "kind": "wr.loop_control", "decision": "stop" }] }\n\`\`\``,
      ];
    default:
      return [
        `Artifact contract: ${contractRef}`,
        `Provide an artifact matching the contract schema`,
      ];
  }
}

function formatAssessmentRequirements(
  assessments: readonly AssessmentDefinition[]
): readonly string[] {
  if (assessments.length === 0) return [];

  const requirements: string[] = [];
  for (const assessment of assessments) {
    requirements.push('Provide an artifact with kind: "wr.assessment"');
    requirements.push(`Assessment target: "${assessment.id}"`);
    requirements.push(
      `Dimensions: ${assessment.dimensions.map((dimension) => `${dimension.id} (${dimension.levels.join(' | ')})`).join(', ')}`
    );
    requirements.push('Use only canonical dimension levels. If the engine rejects the artifact, correct the submitted levels instead of inventing new ones.');
  }
  return requirements;
}

/**
 * Assemble fragment texts whose `when` conditions match the given context.
 *
 * Pure function: evaluates each fragment's condition against `context` and
 * returns a joined string of all matching texts in declaration order.
 * Returns an empty string when no fragments match.
 *
 * Fragments without a `when` condition are always included.
 */
export function assembleFragmentedPrompt(
  fragments: readonly PromptFragment[],
  context: Record<string, unknown>,
): string {
  return fragments
    .filter(f => evaluateCondition(f.when, context))
    .map(f => resolveContextTemplates(f.text, context))
    .join('\n\n');
}

export interface StepMetadata {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly agentRole?: string;
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
  // Extract base step metadata.
  // Fail-fast: a missing step is a structural invariant violation, not a "use a fallback" situation.
  // If the interpreter says a step is pending but the workflow doesn't have it, that means
  // either the workflow definition is corrupt or the step ID was mangled during normalization.
  const step = getStepById(args.workflow, args.stepId);
  if (!step) {
    return err({
      code: 'RENDER_FAILED' as const,
      message: `Step '${args.stepId}' not found in workflow '${args.workflow.definition.id}'`,
    });
  }
  const agentRole = step.agentRole;
  const requireConfirmation = Boolean(step.requireConfirmation);
  const functionReferences = step.functionReferences ?? [];

  // Extract output contract requirements (system-injected, not prompt-authored)
  const outputContract = 'outputContract' in step
    ? (step as { outputContract?: { contractRef?: string } }).outputContract
    : undefined;
  const stepAssessmentRefs = 'assessmentRefs' in step
    ? (step as { assessmentRefs?: readonly string[] }).assessmentRefs
    : undefined;
  const stepAssessments = stepAssessmentRefs && stepAssessmentRefs.length > 0
    ? (args.workflow.definition.assessments ?? []).filter((assessment) => stepAssessmentRefs.includes(assessment.id))
    : [];
  const isExitStep = outputContract?.contractRef === LOOP_CONTROL_CONTRACT_REF;

  // Single traversal resolves the parent loop step — used for both context template
  // resolution (loop vars) and the loop context banner (maxIterations).
  const loopStep = resolveParentLoopStep(args.workflow, args.stepId);
  const maxIterations = loopStep?.loop.maxIterations;

  // Context template resolution: substitute {{varName}} / {{varName.path}} tokens in the
  // authored step prompt and title using live session context merged with loop-derived vars.
  // This runs before banner/requirements injection so only the authored text is substituted.
  const sessionContext: Record<string, unknown> = projectRunContextV2(args.truth.events).match(
    (ok) => (ok.byRunId[String(args.runId)]?.context ?? {}) as Record<string, unknown>,
    (e) => {
      console.warn(
        `[prompt-renderer] Context projection failed for step '${args.stepId}' — ` +
        `{{varName}} tokens will render as [unset:...]: ${e.message}`,
      );
      return {};
    },
  );

  // .at(-1) is idiomatic and expresses intent directly — last frame of the loop path
  const loopIterationFrame = args.loopPath.at(-1);
  const loopRenderContext = loopStep && loopIterationFrame
    ? buildLoopRenderContext(loopStep, loopIterationFrame.iteration, sessionContext)
    : {};

  // Loop vars take precedence over session context (they are derived from it but more specific)
  const renderContext: Record<string, unknown> = { ...sessionContext, ...loopRenderContext };

  // Resolve both prompt and title — titles are agent-visible (inspect output, UI headers).
  // prompt is optional (steps may use promptBlocks instead); default to '' so the resolver
  // always receives a string.
  const basePrompt = resolveContextTemplates(step.prompt ?? '', renderContext);
  const baseTitle = resolveContextTemplates(step.title, renderContext);

  // Use module-level CLEAN_RESPONSE_FORMAT (cached at startup) — same pattern
  // as v2-response-formatter.ts to avoid per-call env lookups on the hot path.
  const cleanResponseFormat = CLEAN_RESPONSE_FORMAT;

  // Loop context banner — prepended before the authored prompt so the agent
  // understands it is intentionally re-entering a loop body step.
  const loopBanner = buildLoopContextBanner({ loopPath: args.loopPath, isExitStep, maxIterations, cleanFormat: cleanResponseFormat });

  // Extract validation requirements and append to prompt if present
  const validationCriteria = step.validationCriteria;
  const requirements = extractValidationRequirements(validationCriteria);
  const requirementsSection = requirements.length > 0
    ? cleanResponseFormat
      ? `\n\n${requirements.map(r => `- ${r}`).join('\n')}`
      : `\n\n**OUTPUT REQUIREMENTS:**\n${requirements.map(r => `- ${r}`).join('\n')}`
    : '';
  
  const contractRequirements = formatOutputContractRequirements(outputContract);
  const contractSection = contractRequirements.length > 0
    ? cleanResponseFormat
      ? `\n\n${contractRequirements.map(r => `- ${r}`).join('\n')}`
      : `\n\n**OUTPUT REQUIREMENTS (System):**\n${contractRequirements.map(r => `- ${r}`).join('\n')}`
    : '';

  const assessmentRequirements = formatAssessmentRequirements(stepAssessments);
  const assessmentSection = assessmentRequirements.length > 0
    ? cleanResponseFormat
      ? `\n\n${assessmentRequirements.map(r => `- ${r}`).join('\n')}`
      : `\n\n**ASSESSMENT REQUIREMENTS (System):**\n${assessmentRequirements.map(r => `- ${r}`).join('\n')}`
    : '';

  // Notes requirement (system-injected): all steps require notes unless the step declares
  // notesOptional, or has an outputContract (artifact is the primary evidence).
  // This makes the enforcement visible to the agent before they submit.
  //
  // Clean response format: notes reminder handled in the response formatter footer.
  const isNotesOptional =
    outputContract !== undefined ||
    ('notesOptional' in step && (step as { notesOptional?: boolean }).notesOptional === true);
  const notesSection = (() => {
    if (isNotesOptional) return '';

    // Clean format: minimal inline reminder — detailed guidance is in the tool description
    if (cleanResponseFormat) {
      return '';  // Notes reminder handled in the response formatter footer
    }

    const hasPriorNotes = hasPriorNotesInRun({ truth: args.truth, runId: args.runId });
    if (hasPriorNotes && !args.rehydrateOnly) {
      return '\n\n**NOTES REQUIRED (System):** Include `output.notesMarkdown` when advancing.\n\n' +
        'Scope: this step only — WorkRail concatenates notes automatically.\n' +
        'Include: what you did, what you produced, and anything notable.\n' +
        'Be specific. Omitting notes will block this step.';
    }

    return '\n\n**NOTES REQUIRED (System):** You must include `output.notesMarkdown` when advancing. ' +
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
  })();

  // Conditional prompt fragments: project accumulated session context and append matching fragments.
  // Fragments are evaluated at render time (not compile time) so they can reference runtime context
  // variables like rigorMode. Context projection failure degrades gracefully — fragments are skipped,
  // not the entire render.
  const promptFragments = 'promptFragments' in step
    ? (step as { promptFragments?: readonly PromptFragment[] }).promptFragments
    : undefined;

  // Uses renderContext (session + loop vars) so fragment conditions and texts can
  // reference both session variables (rigorMode) and loop variables (currentSlice).
  const fragmentSuffix = promptFragments && promptFragments.length > 0
    ? assembleFragmentedPrompt(promptFragments, renderContext)
    : '';

  // Array join avoids 5 intermediate string allocations from the + chain.
  const enhancedPrompt = [
    loopBanner,
    basePrompt,
    requirementsSection,
    contractSection,
    assessmentSection,
    notesSection,
    fragmentSuffix ? '\n\n' + fragmentSuffix : '',
  ].join('');

  // If not rehydrate-only, return enhanced prompt (no recovery needed for advance/start)
  if (!args.rehydrateOnly) {
    return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
  }

  // Rehydrate-only: load recovery projections (extracted helper)
  const projectionsRes = loadRecoveryProjections({ truth: args.truth, runId: args.runId });
  if (projectionsRes.isErr()) {
    return ok({
      stepId: args.stepId,
      title: baseTitle,
      prompt: enhancedPrompt + '\n\n' + projectionsRes.error,
      agentRole,
      requireConfirmation,
    });
  }

  const { run, outputs } = projectionsRes.value;

  // Build recovery segments (extracted helper)
  const segments = buildRecoverySegments({
    nodeId: args.nodeId,
    run,
    outputs,
    workflow: args.workflow,
    stepId: args.stepId,
    loopPath: args.loopPath,
    functionReferences,
  });

  // No recovery content
  if (segments.length === 0) {
    return ok({ stepId: args.stepId, title: baseTitle, prompt: enhancedPrompt, agentRole, requireConfirmation });
  }

  // Combine and apply budget with tier-aware recovery rendering.
  const recoveryHeader = cleanResponseFormat ? 'Your previous work:' : '## Recovery Context';
  const recoveryText = renderBudgetedRehydrateRecovery({
    header: recoveryHeader,
    segments,
  }).text;
  const finalPrompt = `${enhancedPrompt}\n\n${recoveryText}`;

  return ok({ stepId: args.stepId, title: baseTitle, prompt: finalPrompt, agentRole, requireConfirmation });
}
