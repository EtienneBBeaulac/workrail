/**
 * Workflow Definition Types
 * 
 * Pure workflow definition - exactly what's in the JSON file.
 * Validated against spec/workflow.schema.json.
 * Immutable value object.
 * 
 * This type represents the SCHEMA of a workflow file.
 * It does NOT include runtime metadata like source.
 */

import { ValidationCriteria } from './validation';
import type { ArtifactContractRef } from '../v2/durable-core/schemas/artifacts/index';
import type { PromptBlocks } from '../application/services/compiler/prompt-blocks.js';
import type { Condition } from '../utils/condition-evaluator.js';

// =============================================================================
// STEP TYPES
// =============================================================================

/**
 * Output contract for typed artifact validation.
 * When specified, step output must include artifacts matching the contract.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 */
export interface OutputContract {
  /** Reference to the artifact contract — must be a registered contract ref */
  readonly contractRef: ArtifactContractRef;
  /** Whether the artifact is required (default: true) */
  readonly required?: boolean;
}

/**
 * A conditional prompt fragment appended to a step's base prompt at render time.
 *
 * When `when` matches the session context, `text` is appended after the base prompt
 * in declaration order. Fragments without `when` are always appended.
 *
 * Fragment texts support {{varName}} context template substitution at render time.
 * {{wr.*}} tokens are rejected by structural validation at compile time.
 */
export interface PromptFragment {
  /** Unique identifier within the step (used for validation and debugging) */
  readonly id: string;
  /**
   * Condition evaluated against accumulated session context at render time.
   * When absent, the fragment is always appended.
   */
  readonly when?: Condition;
  /** Text appended when the condition matches. May contain {{varName}} context templates. */
  readonly text: string;
}

/**
 * Declared assessment dimension for a workflow-owned assessment shape.
 *
 * Dimensions define the bounded axes the engine will later classify.
 * This slice only adds declaration + compile-time validation shape.
 */
export interface AssessmentDimensionDefinition {
  /** Stable identifier referenced within the assessment definition. */
  readonly id: string;
  /** Human purpose shown to workflow authors and operators. */
  readonly purpose: string;
  /** Closed set of allowed canonical levels for this dimension. */
  readonly levels: readonly string[];
  /** Whether the dimension must be supplied when the assessment is used. Default: true. */
  readonly required?: boolean;
}

/**
 * Workflow-declared assessment definition.
 *
 * Assessments are declared at workflow scope and referenced by steps via
 * `assessmentRefs`. Runtime semantics land in later slices; this slice only
 * establishes the explicit authoring and compiler-validation surface.
 */
export interface AssessmentDefinition {
  /** Stable workflow-local identifier referenced by steps. */
  readonly id: string;
  /** Human-readable summary of what this assessment captures. */
  readonly purpose: string;
  /** Bounded dimensions that make up this assessment. */
  readonly dimensions: readonly AssessmentDimensionDefinition[];
}

/**
 * Trigger condition for an assessment consequence.
 * Fires when ANY dimension in the submitted assessment equals anyEqualsLevel.
 */
export interface AssessmentConsequenceTriggerDefinition {
  /**
   * Fires when ANY dimension in the submitted assessment equals this level.
   * For single-dimension assessments this is equivalent to an exact match.
   */
  readonly anyEqualsLevel: string;
}

export interface AssessmentFollowupRequiredEffectDefinition {
  /** Closed-set effect kind for v1 consequence behavior. */
  readonly kind: 'require_followup';
  /** Semantic guidance shown when follow-up is required before retrying the same step. */
  readonly guidance: string;
}

export interface AssessmentConsequenceDefinition {
  /**
   * Closed-set step-level assessment consequence declaration for v1.
   *
   * Lock: v1 supports exactly one consequence family:
   * - trigger: exact-match on one declared dimension level
   * - effect: require_followup with semantic guidance
   */
  readonly when: AssessmentConsequenceTriggerDefinition;
  readonly effect: AssessmentFollowupRequiredEffectDefinition;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly title: string;
  /**
   * Raw prompt string. Required for text-prompt steps.
   * Optional when promptBlocks is used — the compiler renders blocks into
   * this field during compilation, so it is always present after compilation.
   */
  readonly prompt?: string;
  /**
   * Structured prompt blocks. Alternative to raw prompt string.
   * Rendered into prompt during compilation (deterministic, locked order).
   * A step must declare exactly one of prompt or promptBlocks.
   */
  readonly promptBlocks?: PromptBlocks;
  readonly agentRole?: string;
  readonly guidance?: readonly string[];
  readonly askForFiles?: boolean;
  readonly requireConfirmation?: boolean;
  readonly runCondition?: Readonly<Record<string, unknown>>;
  /** 
   * @deprecated Use outputContract for typed artifact validation instead.
   * validationCriteria will be removed once workflows are migrated.
   */
  readonly validationCriteria?: ValidationCriteria;
  /** 
   * Output contract for typed artifact validation.
   * Replaces validationCriteria with machine-checkable artifacts.
   */
  readonly outputContract?: OutputContract;
  /**
   * References to workflow-level assessment definitions expected for this step.
   *
   * Assessments are declared at workflow scope (`workflow.definition.assessments`)
   * and steps opt into them by reference. Unknown refs fail fast during
   * validation/compilation.
   */
  readonly assessmentRefs?: readonly string[];
  /**
   * Step-local consequence declarations for the referenced assessment.
   *
   * Assessment definitions declare vocabulary only. Consequences live on the
   * step usage so execution behavior stays step-local and explicit.
   *
   * Lock: v1 supports at most one exact-match follow-up consequence.
   */
  readonly assessmentConsequences?: readonly AssessmentConsequenceDefinition[];
  /**
   * When true, notes (output.notesMarkdown) are NOT required for this step.
   *
   * By default, all steps require notes — the agent must document what it did.
   * This is enforced at the blocking layer: omitting notes blocks the advance.
   *
   * Set to true only for mechanical steps where notes would be pure noise (e.g.
   * a confirmation gate with no substantive work). Steps with `outputContract`
   * are automatically exempt (the typed artifact IS the evidence).
   *
   * Prefer leaving this unset unless the step genuinely produces no value in
   * the session history.
   */
  readonly notesOptional?: boolean;
  /**
   * Template call: expands this step into one or more steps at compile time.
   * When present, prompt/promptBlocks are ignored — the template provides them.
   * The step's id becomes a prefix for expanded step IDs (e.g. "phase-0" ->
   * "phase-0.investigate", "phase-0.plan").
   */
  readonly templateCall?: TemplateCall;
  /**
   * Conditional prompt fragments appended to this step's base prompt at render time.
   * Each fragment whose `when` condition matches the session context is appended in
   * declaration order. Fragments without `when` are always appended.
   *
   * Lock: evaluated at render time (not compile time) against accumulated session context.
   * Fragment texts must not contain {{wr.*}} tokens (validated at compile time).
   */
  readonly promptFragments?: readonly PromptFragment[];
  readonly functionDefinitions?: readonly FunctionDefinition[];
  readonly functionCalls?: readonly FunctionCall[];
  readonly functionReferences?: readonly string[];
}

/** A compile-time template invocation. */
export interface TemplateCall {
  /** Template ID from the closed-set registry (wr.templates.*). */
  readonly templateId: string;
  /** Optional arguments passed to the template expansion function. */
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface LoopStepDefinition extends WorkflowStepDefinition {
  readonly type: 'loop';
  readonly loop: LoopConfigDefinition;
  readonly body: string | readonly WorkflowStepDefinition[];
}

/**
 * Loop condition source: discriminated union controlling how loop
 * continuation is determined.
 * 
 * Lock: §9 Loops authoring — "while loop continuation MUST NOT be controlled
 * by mutable ad-hoc context keys." New workflows MUST use 'artifact_contract'.
 * Legacy workflows auto-derive 'context_variable' during compilation.
 * 
 * Why closed: exhaustive switch in interpreter prevents silent fallback chains.
 */
export type LoopConditionSource =
  | { readonly kind: 'artifact_contract'; readonly contractRef: ArtifactContractRef; readonly loopId: string }
  | { readonly kind: 'context_variable'; readonly condition: Readonly<Record<string, unknown>> };

export interface LoopConfigDefinition {
  readonly type: 'while' | 'until' | 'for' | 'forEach';
  readonly condition?: Readonly<Record<string, unknown>>;
  /**
   * Explicit condition source for while/until loops.
   * When present, the interpreter uses this instead of the implicit
   * condition + context fallback chain.
   * 
   * Derived automatically by the compiler when absent:
   * - Step has outputContract → artifact_contract
   * - Step has condition only → context_variable (deprecated)
   */
  readonly conditionSource?: LoopConditionSource;
  readonly items?: string;
  readonly count?: number | string;
  readonly maxIterations: number;
  readonly iterationVar?: string;
  readonly itemVar?: string;
  readonly indexVar?: string;
}

// =============================================================================
// FUNCTION TYPES
// =============================================================================

export interface FunctionParameter {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: unknown;
}

export interface FunctionDefinition {
  readonly name: string;
  readonly definition: string;
  readonly parameters?: readonly FunctionParameter[];
  readonly scope?: 'workflow' | 'loop' | 'step';
}

export interface FunctionCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Pure workflow definition - exactly what's stored in JSON files.
 * 
 * This is a VALUE OBJECT:
 * - Immutable (all fields readonly)
 * - No runtime state
 * - Defined entirely by its fields
 * - Can be serialized/deserialized without loss
 */
// =============================================================================
// EXTENSION POINT TYPES
// =============================================================================

/**
 * A single extension point declared by a parent workflow.
 *
 * Extension points define bounded cognitive slots that users can customize
 * per-project via .workrail/bindings.json, without forking the workflow.
 *
 * The `default` is the routine/workflow ID used when no project override exists.
 * Resolution order: .workrail/bindings.json override → default.
 *
 * Lock: extension points are compile-time only. Tokens ({{wr.bindings.slotId}})
 * are resolved before hashing. Unknown slot IDs fail fast at compile time.
 */
export interface ExtensionPoint {
  /** Stable identifier used in {{wr.bindings.slotId}} tokens */
  readonly slotId: string;
  /** Human description of what this slot does */
  readonly purpose: string;
  /** Default routine/workflow ID used when no project override is declared */
  readonly default: string;
  /** Allowed implementation kinds (optional; informational only in v1) */
  readonly acceptedKinds?: readonly ('routine' | 'workflow')[];
}

/**
 * Workflow-level preference recommendations.
 * 
 * Lock: §5 "closed-set recommendation targets"
 * These are optional hints from the workflow author about what autonomy/risk
 * levels are appropriate. They never hard-block user choice, but emit
 * structured warnings (gap_recorded) when effective preferences exceed them.
 */
export interface WorkflowRecommendedPreferences {
  /** Recommended autonomy level. If user's effective autonomy exceeds this, a warning gap is emitted. */
  readonly recommendedAutonomy?: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
  /** Recommended risk policy. If user's effective risk policy exceeds this, a warning gap is emitted. */
  readonly recommendedRiskPolicy?: 'conservative' | 'balanced' | 'aggressive';
}

/**
 * A workflow-declared reference to an external document.
 *
 * References are pointers — content is never inlined. The agent reads the
 * file itself if needed. Declarations are included in the workflow hash;
 * referenced file content is not (hash stability).
 *
 * Resolution phases:
 * - Compile-time: structural validation (unique IDs, non-empty fields)
 * - Start-time: path existence validated via filesystem I/O (handler layer)
 *
 * Lock: references are workflow-declared in v1. Project-attached references
 * (.workrail/references.json) are a future extension.
 */
export interface WorkflowReference {
  /** Unique identifier within the workflow */
  readonly id: string;
  /** Human-readable title for the reference */
  readonly title: string;
  /**
   * File path to the referenced document.
   *
   * Resolution base depends on `resolveFrom`:
   * - `'workspace'` (default): resolved relative to the user's workspace root.
   * - `'package'`: resolved relative to the workrail package root. Use this for
   *   files that ship with the workflow (specs, schemas, guides).
   */
  readonly source: string;
  /** Why this reference matters to the workflow */
  readonly purpose: string;
  /** Whether this document is authoritative (agent should follow it strictly) */
  readonly authoritative: boolean;
  /**
   * Where to resolve `source` from.
   *
   * - `'workspace'` (default): user's project root. For project-specific artifacts.
   * - `'package'`: workrail package root. For files bundled with the workflow.
   */
  readonly resolveFrom?: 'workspace' | 'package';
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[];
  readonly preconditions?: readonly string[];
  readonly clarificationPrompts?: readonly string[];
  /**
   * Workflow-level behavioral rules surfaced on start and resume.
   *
   * Use metaGuidance for persistent behavioral constraints ("always maintain CONTEXT.md",
   * "never commit without user approval"). These are compiled into step guidance at
   * compile-time via the template registry.
   *
   * For pointing agents at external documents, use `references` instead.
   * For conditional prompt content based on session state, use `promptFragments`.
   */
  readonly metaGuidance?: readonly string[];
  readonly functionDefinitions?: readonly FunctionDefinition[];
  /**
   * Workflow-level preference recommendations.
   * When effective preferences exceed these recommendations, structured
   * warnings are emitted as gap_recorded events (severity: warning).
   */
  readonly recommendedPreferences?: WorkflowRecommendedPreferences;
  /**
   * Workflow-level feature declarations (closed-set, wr.features.*).
   * Features are compiler middleware that inject content into promptBlocks.
   * Resolved at compile time — unknown feature IDs fail fast.
   */
  readonly features?: readonly string[];
  /**
   * Workflow-declared assessment definitions.
   *
   * Steps reference these definitions via `assessmentRefs` instead of
   * embedding assessment structure inline repeatedly.
   */
  readonly assessments?: readonly AssessmentDefinition[];
  /**
   * Extension points: bounded cognitive slots that users can customize
   * via .workrail/bindings.json without forking the workflow.
   *
   * Each slot is referenced in step prompts via {{wr.bindings.slotId}}.
   * The compiler resolves these tokens at compile time using:
   *   1. Project override from .workrail/bindings.json
   *   2. Fallback to this slot's `default` field
   *
   * Unknown tokens fail fast at compile time.
   */
  readonly extensionPoints?: readonly ExtensionPoint[];
  /**
   * Workflow-declared references to external documents.
   *
   * Each reference points at an authoritative or supporting document that
   * the agent should be aware of. References are validated structurally at
   * compile time and resolved (path existence) at start time.
   *
   * Declarations participate in the workflow hash. Referenced file content
   * does not (hash remains stable when referenced files change).
   */
  readonly references?: readonly WorkflowReference[];
  /** The authoring spec version this workflow was last validated against. */
  readonly validatedAgainstSpecVersion?: number;
  /**
   * Human-readable overview for display in the console and other UIs.
   * Markdown is supported. Written for a user deciding whether to use this
   * workflow -- what it does, when to use it, what it produces, and how to
   * get good results. User-facing surface; not an agent instruction (use
   * metaGuidance for that).
   */
  readonly about?: string;
  /**
   * Short illustrative goal strings showing what this workflow is used for.
   * Useful both for humans browsing the catalog and for agents selecting the
   * right workflow.
   */
  readonly examples?: readonly string[];
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isLoopStepDefinition(
  step: WorkflowStepDefinition | LoopStepDefinition
): step is LoopStepDefinition {
  return 'type' in step && step.type === 'loop';
}

export function isWorkflowStepDefinition(
  step: WorkflowStepDefinition | LoopStepDefinition
): step is WorkflowStepDefinition {
  return !isLoopStepDefinition(step);
}

/**
 * Whether a step declares at least one prompt source.
 *
 * Valid prompt sources (exactly one required):
 * - prompt: raw string (backward compat)
 * - promptBlocks: structured blocks (compiled to prompt)
 * - templateCall: expands to steps that have their own prompt source
 *
 * This is the single source of truth for "does this step have content?"
 * Used by both the validation engine (pre-compilation) and can be reused
 * anywhere that needs this check.
 */
export function stepHasPromptSource(step: WorkflowStepDefinition): boolean {
  return Boolean(step.prompt || step.promptBlocks || step.templateCall);
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Check if an object has the shape of a WorkflowDefinition.
 * This is a structural check, not schema validation.
 */
export function hasWorkflowDefinitionShape(obj: unknown): obj is WorkflowDefinition {
  if (!obj || typeof obj !== 'object') return false;
  
  const candidate = obj as Record<string, unknown>;
  
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['description'] === 'string' &&
    typeof candidate['version'] === 'string' &&
    Array.isArray(candidate['steps']) &&
    candidate['steps'].length > 0
  );
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an immutable WorkflowDefinition with deep freezing.
 * Enforces immutability at runtime to match the readonly type.
 */
export function createWorkflowDefinition(
  definition: WorkflowDefinition
): WorkflowDefinition {
  return Object.freeze({
    ...definition,
    steps: Object.freeze(
      definition.steps.map(step =>
        Object.freeze({
          ...step,
          assessmentConsequences: 'assessmentConsequences' in step && step.assessmentConsequences
            ? Object.freeze(step.assessmentConsequences.map(consequence => Object.freeze({
                ...consequence,
                when: Object.freeze({ ...consequence.when }),
                effect: Object.freeze({ ...consequence.effect }),
              })))
            : undefined,
        })
      )
    ),
    preconditions: definition.preconditions ? Object.freeze([...definition.preconditions]) : undefined,
    clarificationPrompts: definition.clarificationPrompts ? Object.freeze([...definition.clarificationPrompts]) : undefined,
    metaGuidance: definition.metaGuidance ? Object.freeze([...definition.metaGuidance]) : undefined,
    functionDefinitions: definition.functionDefinitions ? Object.freeze([...definition.functionDefinitions]) : undefined,
    assessments: definition.assessments
      ? Object.freeze(
          definition.assessments.map(assessment =>
            Object.freeze({
              ...assessment,
              dimensions: Object.freeze(assessment.dimensions.map(dimension => Object.freeze({ ...dimension }))),
            })
          )
        )
      : undefined,
    extensionPoints: definition.extensionPoints ? Object.freeze([...definition.extensionPoints]) : undefined,
    references: definition.references ? Object.freeze(definition.references.map(ref => Object.freeze({ ...ref }))) : undefined,
  }) as WorkflowDefinition;
}
