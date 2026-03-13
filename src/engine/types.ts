/**
 * WorkRail Library Engine Types
 *
 * Public API types for consuming WorkRail as an in-process library.
 * Design principles:
 * - Discriminated unions for all sum types (illegal states unrepresentable)
 * - Branded token types (cannot mix stateToken/ackToken at compile time)
 * - Typed error variants with domain-specific payloads (errors as data)
 * - Immutable readonly types throughout
 */

// ---------------------------------------------------------------------------
// Branded token types — compile-time safety against token misuse
// ---------------------------------------------------------------------------

declare const StateTokenBrand: unique symbol;
declare const AckTokenBrand: unique symbol;
declare const CheckpointTokenBrand: unique symbol;

/** Opaque state token — identifies a session + run + node position. */
export type StateToken = string & { readonly [StateTokenBrand]: never };

/** Opaque ack token — proves the agent saw a specific step attempt. */
export type AckToken = string & { readonly [AckTokenBrand]: never };

/** Opaque checkpoint token — marks a durable progress point. */
export type CheckpointToken = string & { readonly [CheckpointTokenBrand]: never };

// Constructors — used internally by the engine, not by consumers
export function asStateToken(s: string): StateToken { return s as StateToken; }
export function asAckToken(s: string): AckToken { return s as AckToken; }
export function asCheckpointToken(s: string): CheckpointToken { return s as CheckpointToken; }

// ---------------------------------------------------------------------------
// Pending step
// ---------------------------------------------------------------------------

export interface PendingStep {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly agentRole?: string;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export type Autonomy = 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
export type RiskPolicy = 'conservative' | 'balanced' | 'aggressive';

export interface StepPreferences {
  readonly autonomy: Autonomy;
  readonly riskPolicy: RiskPolicy;
}

// ---------------------------------------------------------------------------
// Next intent
// ---------------------------------------------------------------------------

export type NextIntent =
  | 'perform_pending_then_continue'
  | 'await_user_confirmation'
  | 'rehydrate_only'
  | 'complete';

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

export interface Blocker {
  readonly code: string;
  readonly message: string;
  readonly suggestedFix?: string;
}

// ---------------------------------------------------------------------------
// Step response — discriminated union (ok | blocked | complete)
// ---------------------------------------------------------------------------

interface StepResponseBase {
  readonly stateToken: StateToken;
  readonly ackToken: AckToken | null;
  readonly checkpointToken: CheckpointToken | null;
  readonly isComplete: boolean;
  readonly preferences: StepPreferences;
  readonly nextIntent: NextIntent;
}

export interface StepResponseOk extends StepResponseBase {
  readonly kind: 'ok';
  readonly pending: PendingStep | null;
}

export interface StepResponseBlocked extends StepResponseBase {
  readonly kind: 'blocked';
  readonly pending: PendingStep | null;
  readonly blockers: readonly Blocker[];
  readonly retryable: boolean;
  readonly retryAckToken: AckToken | null;
}

export type StepResponse = StepResponseOk | StepResponseBlocked;

// ---------------------------------------------------------------------------
// Checkpoint response
// ---------------------------------------------------------------------------

export interface CheckpointResponse {
  readonly checkpointNodeId: string;
  readonly stateToken: StateToken;
}

// ---------------------------------------------------------------------------
// Workflow list
// ---------------------------------------------------------------------------

export interface WorkflowListItem {
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
}

export interface WorkflowListResponse {
  readonly workflows: readonly WorkflowListItem[];
}

// ---------------------------------------------------------------------------
// Engine errors — typed variants with domain-specific payloads
// ---------------------------------------------------------------------------

export type EngineError =
  | { readonly kind: 'workflow_not_found'; readonly workflowId: string }
  | { readonly kind: 'workflow_has_no_steps'; readonly workflowId: string }
  | { readonly kind: 'workflow_compile_failed'; readonly message: string }
  | { readonly kind: 'validation_failed'; readonly message: string }
  | { readonly kind: 'token_invalid'; readonly message: string }
  | { readonly kind: 'token_signing_failed'; readonly message: string }
  | { readonly kind: 'session_error'; readonly message: string }
  | { readonly kind: 'storage_error'; readonly message: string }
  | { readonly kind: 'prompt_render_failed'; readonly message: string }
  | { readonly kind: 'precondition_failed'; readonly message: string }
  | { readonly kind: 'internal_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Result type — explicit success/failure without exceptions
// ---------------------------------------------------------------------------

export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EngineError };

export function engineOk<T>(value: T): EngineResult<T> {
  return { ok: true, value };
}

export function engineErr<T>(error: EngineError): EngineResult<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Engine config
// ---------------------------------------------------------------------------

export interface EngineConfig {
  /** Where to store durable state (sessions, snapshots, keyring). Default: ~/.workrail/v2 */
  readonly dataDir?: string;
}

// ---------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------

export interface WorkRailEngine {
  /** Start a workflow, get the first step. */
  readonly startWorkflow: (workflowId: string) => Promise<EngineResult<StepResponse>>;

  /** Advance (ackToken present) or rehydrate (ackToken null). */
  readonly continueWorkflow: (
    stateToken: StateToken,
    ackToken: AckToken | null,
    output?: { readonly notesMarkdown?: string },
  ) => Promise<EngineResult<StepResponse>>;

  /** Checkpoint without advancing. */
  readonly checkpointWorkflow: (
    checkpointToken: CheckpointToken,
  ) => Promise<EngineResult<CheckpointResponse>>;

  /** List available workflows. */
  readonly listWorkflows: () => Promise<EngineResult<WorkflowListResponse>>;

  /** Release resources (keyring, file handles, locks). */
  readonly close: () => Promise<void>;
}
