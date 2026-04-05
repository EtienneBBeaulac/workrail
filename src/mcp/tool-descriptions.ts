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
import {
  CHECKPOINT_WORKFLOW_PROTOCOL,
  CONTINUE_WORKFLOW_PROTOCOL,
  RESUME_SESSION_PROTOCOL,
  START_WORKFLOW_PROTOCOL,
  renderProtocolDescription,
} from './workflow-protocol-contracts.js';

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

    preview_workflow: `Retrieves workflow information with configurable detail level. Supports progressive disclosure to prevent "workflow spoiling" while providing necessary context for workflow selection and initiation.

Parameters:
- workflowId: The unique identifier of the workflow to retrieve
- mode (optional): 'metadata' for overview only, 'preview' (default) for first step`,

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
    list_workflows: `Lists available workflows using WorkRail v2 (feature-flagged). When a workflow exists for the user's request, following it means following the user's structured instructions.

Discovery pattern (token-efficient — do this):
1. Call with no tags → returns tagSummary (~500 tokens): 9 tags with counts and when-to-use phrases. Identify which tag fits.
2. Call with tags=["<tag>"] → returns the filtered workflow list for that tag.

Alternatively, read the workrail://tags MCP resource for tag definitions without any tool call.

Always pass workspacePath so project-scoped workflow variants are resolved against the correct workspace. Shared MCP servers cannot infer this safely.`,

    inspect_workflow: `Inspect a workflow structure before starting it (WorkRail v2, feature-flagged).

Use this to understand what steps the workflow will guide you through. The workflow is a step-by-step plan the user (or workflow author) created for this type of task.

Parameters:
- workflowId: The workflow to inspect
- mode: metadata mode shows name/description only; preview mode shows the full step breakdown
- workspacePath: absolute workspace path for correct project-scoped workflow resolution

Returns:
- metadata mode: Just name and description
- preview mode: Full step-by-step breakdown (default)

Always pass workspacePath so project-scoped workflow variants are resolved against the correct workspace. Shared MCP servers cannot infer this safely.

Remember: inspecting is read-only. Call start_workflow when ready to begin.`,

    start_workflow: renderProtocolDescription(START_WORKFLOW_PROTOCOL, 'standard'),

    continue_workflow: renderProtocolDescription(CONTINUE_WORKFLOW_PROTOCOL, 'standard'),

    checkpoint_workflow: renderProtocolDescription(CHECKPOINT_WORKFLOW_PROTOCOL, 'standard'),

    resume_session: renderProtocolDescription(RESUME_SESSION_PROTOCOL, 'standard'),

    manage_workflow_source: `Attach or detach a workflow directory as a managed source.

Use this to explicitly add a directory containing workflow files so its workflows appear in list_workflows as managed entries.

Parameters:
- action: "attach" to add a directory, "detach" to remove it. Both are idempotent.
- path: absolute filesystem path to the workflow directory

Attach is idempotent: attaching an already-attached path is a no-op.
Detach is idempotent: detaching an absent path is a no-op.`,
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

Parameters:
- workflowId: The unique identifier of the workflow to retrieve
- mode (optional): 'metadata' for overview only, 'preview' (default) for first step`,

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
    list_workflows: `List available workflows via WorkRail v2 (feature-flagged). When a workflow exists for the user's request, you MUST use it instead of improvising your own approach.

Discovery pattern (token-efficient — do this):
1. Call with no tags → returns tagSummary (~500 tokens): 9 tags with counts and when-to-use phrases. Identify which tag fits.
2. Call with tags=["<tag>"] → returns the filtered workflow list for that tag.

Alternatively, read the workrail://tags MCP resource for tag definitions without any tool call.

Pass workspacePath on every call so project-scoped workflow variants are resolved against the correct workspace. Shared MCP servers cannot infer this safely.`,

    inspect_workflow: `Inspect a workflow you are considering following (WorkRail v2, feature-flagged).

Use this to understand the workflow's structure before starting. The workflow is the user's explicit plan - not suggestions, not guidelines, but direct instructions you will follow.

Parameters:
- workflowId: The workflow to inspect
- mode: 'metadata' (name/description only) or 'preview' (full step breakdown)
- workspacePath: absolute workspace path for correct project-scoped workflow resolution

This is read-only. Call start_workflow when ready to commit to following the workflow.`,

    start_workflow: renderProtocolDescription(START_WORKFLOW_PROTOCOL, 'authoritative'),

    continue_workflow: renderProtocolDescription(CONTINUE_WORKFLOW_PROTOCOL, 'authoritative'),

    checkpoint_workflow: renderProtocolDescription(CHECKPOINT_WORKFLOW_PROTOCOL, 'authoritative'),

    resume_session: renderProtocolDescription(RESUME_SESSION_PROTOCOL, 'authoritative'),

    manage_workflow_source: `Attach or detach a workflow directory as a managed source.

When the user wants to register an external workflow directory, use attach. When they want to remove it, use detach. Both are idempotent.

Parameters:
- action: "attach" to add a directory, "detach" to remove it. Both are idempotent.
- path: absolute filesystem path to the workflow directory

Attach is idempotent: attaching an already-attached path is a no-op.
Detach is idempotent: detaching an absent path is a no-op.`,
  },
} as const;
