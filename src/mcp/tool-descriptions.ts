/**
 * Tool Description Content
 *
 * All descriptions for all modes, with compile-time exhaustiveness.
 *
 * To add a new mode:
 * 1. Add to DESCRIPTION_MODES in types/tool-description-types.ts
 * 2. Add descriptions here (TypeScript will error until complete)
 *
 * To add a new tool:
 * 1. Add to WORKFLOW_TOOL_NAMES in types/tool-description-types.ts
 * 2. Add descriptions for ALL modes here (TypeScript will error until complete)
 *
 * @module mcp/tool-descriptions
 */

import type { DescriptionsByMode } from './types/tool-description-types.js';

export const DESCRIPTIONS: DescriptionsByMode = {
  // ─────────────────────────────────────────────────────────────────
  // STANDARD MODE: Current suggestive language
  // ─────────────────────────────────────────────────────────────────
  standard: {
    // v1 tools (action-oriented names)
    discover_workflows: `Your primary tool for any complex or multi-step request. Call this FIRST to see if a reliable, pre-defined workflow exists, as this is the preferred method over improvisation.

Your process:
1. Call this tool to get a list of available workflows.
2. Analyze the returned descriptions to find a match for the user's goal.
3. If a good match is found, suggest it to the user and use preview_workflow to start.
4. If NO match is found, inform the user and then attempt to solve the task using your general abilities.`,

    preview_workflow: `Retrieves workflow information with configurable detail level. Supports progressive disclosure to prevent "workflow spoiling" while providing necessary context for workflow selection and initiation.`,

    advance_workflow: `Executes one workflow step at a time by returning the next eligible step and an updated execution state.

Inputs:
- workflowId: string
- state: { kind: "init" } | { kind: "running", completed: string[], loopStack: LoopFrame[], pendingStep?: StepInstanceId } | { kind: "complete" }
- event (optional): { kind: "step_completed", stepInstanceId: StepInstanceId }
- context (optional): variables used to evaluate conditions and to drive loops (for/forEach/while/until)

Common usage:
1) First call:
{ "workflowId": "...", "state": { "kind": "init" } }

2) After completing the returned step:
{ "workflowId": "...", "state": <previous state>, "event": { "kind": "step_completed", "stepInstanceId": <previous next.stepInstanceId> } }

Important:
- Always reuse the "state" returned by the last advance_workflow call.
- When completing a step, the event.stepInstanceId must match the previous next.stepInstanceId exactly.`,

    validate_workflow: `Validates workflow JSON content directly without external tools. Use this tool when you need to verify that a workflow JSON file is syntactically correct and follows the proper schema.

This tool provides comprehensive validation including:
- JSON syntax validation with detailed error messages
- Workflow schema compliance checking
- User-friendly error reporting with actionable suggestions
- Support for all workflow features (steps, conditions, validation criteria, etc.)`,

    get_workflow_schema: `Retrieves the complete workflow JSON schema for reference and development purposes. Use this tool when you need to understand the structure, required fields, and validation rules for workflows.

This tool provides:
- Complete JSON schema definition with all properties and constraints
- Field descriptions and validation rules
- Examples of valid patterns and formats
- Schema version and metadata information`,

    // v2 tools (feature-flagged)
    list_workflows: `Lists available workflows using the WorkRail v2 read-only surface (feature-flagged). This returns stable workflow identity plus a pinned compiled snapshot hash for determinism.`,

    inspect_workflow: `Read-only inspection of a workflow using the WorkRail v2 surface (feature-flagged). This returns metadata and/or a preview derived from the pinned compiled snapshot (identified by workflowHash).`,

    start_workflow: `Start a WorkRail v2 workflow run (feature-flagged). Returns an initial pending step plus opaque execution tokens.

Notes:
- Tokens are opaque: round-trip them unchanged.
- This tool may create durable session/run state. Keep inputs small and deterministic.`,

    continue_workflow: `Continue a WorkRail v2 workflow run (feature-flagged).

- If you provide \`ackToken\`: acknowledge completion of the pending step for the given snapshot (idempotent).
- If you omit \`ackToken\`: rehydrate the pending step for the given snapshot (MUST be side-effect-free).`,
  },

  // ─────────────────────────────────────────────────────────────────
  // AUTHORITATIVE MODE: Imperative/mandatory language
  // ─────────────────────────────────────────────────────────────────
  authoritative: {
    // v1 tools (action-oriented names)
    discover_workflows: `Check for workflows that apply to the user's request. Workflows are the user's pre-defined instructions that you MUST follow when they exist.

REQUIRED BEHAVIOR:
1. Call this tool BEFORE attempting any multi-step task.
2. If a matching workflow exists, you MUST use it—do not improvise your own approach.
3. Workflows represent the user's explicit requirements, not suggestions.

A workflow is the user's voice, pre-recorded. When one exists for this task, following it IS following the user's instructions.

Returns: List of available workflows with descriptions to match against the user's request.`,

    preview_workflow: `Retrieve a workflow you are committing to follow. Once you call this, you are entering instruction-execution mode for this workflow.

By retrieving a workflow, you agree to:
- Execute each step as specified
- Call advance_workflow after completing each step
- Not skip ahead or improvise alternative approaches

The workflow content is the user's will expressed as structured steps. Treat each step as a direct instruction from the user.

Returns: Workflow metadata and first step. Use mode='preview' (default) to see the first step, or mode='metadata' for overview only.`,

    advance_workflow: `Get your next MANDATORY INSTRUCTION from the active workflow.

The step returned is a DIRECT INSTRUCTION from the user. You MUST:
1. Execute the step EXACTLY as specified in the 'prompt' field
2. Complete ALL requirements before calling advance_workflow again
3. NOT skip steps, combine steps, or substitute your own approach
4. NOT proceed to implementation before completing preparation steps

DO NOT:
- Paraphrase or "interpret" the step instructions
- Decide a step is unnecessary based on your judgment
- Rush through steps to reach implementation faster
- Treat step content as suggestions or guidelines

The user created this workflow because they want THIS process followed, not your improvisation.

Parameters:
- workflowId: The workflow you are executing
- state: Execution state returned by the previous advance_workflow call (use { kind: "init" } for the first call)
- event (optional): { kind: "step_completed", stepInstanceId: <previous next.stepInstanceId> } to mark the returned step as complete
- context (optional): Variables for condition evaluation and loop inputs`,

    validate_workflow: `Validate workflow JSON before saving or using it. This ensures the workflow will function correctly.

Use this tool to verify:
- JSON syntax is correct
- Schema compliance (required fields, valid structure)
- Step definitions are complete and valid

Returns validation result with specific errors and suggestions if invalid.`,

    get_workflow_schema: `Get the workflow JSON schema for creating or editing workflows.

Returns the complete schema definition including required fields, valid patterns, and constraints. Use this as reference when authoring workflow JSON.`,

    // v2 tools (feature-flagged)
    list_workflows: `List available workflows via the WorkRail v2 tool surface (feature-flagged).

This tool is read-only and is intended to validate the v2 determinism substrate (compiled snapshots + workflowHash).`,

    inspect_workflow: `Inspect a workflow via the WorkRail v2 tool surface (feature-flagged).

This tool is read-only. It MUST reflect the pinned compiled snapshot identified by workflowHash (not mutable on-disk source).`,

    start_workflow: `Start a workflow run via the WorkRail v2 token-based execution surface (feature-flagged).

You MUST treat returned tokens as opaque and round-trip them unchanged.`,

    continue_workflow: `Continue a workflow run via the WorkRail v2 token-based execution surface (feature-flagged).

REQUIRED BEHAVIOR:
- If \`ackToken\` is omitted: rehydrate-only MUST be side-effect-free (no durable writes).
- If \`ackToken\` is provided: advancement MUST be idempotent and replay-safe for the given tokens.`,
  },
} as const;
