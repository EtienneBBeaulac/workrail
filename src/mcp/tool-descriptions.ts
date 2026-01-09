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
    list_workflows: `Lists available workflows using WorkRail v2 (feature-flagged). Returns workflow metadata plus pinned snapshot hashes for deterministic execution.

Use this to discover workflows before attempting multi-step tasks. When a workflow exists for the user's request, following it means following the user's structured instructions.`,

    inspect_workflow: `Inspect a workflow structure before starting it (WorkRail v2, feature-flagged).

Use this to understand what steps the workflow will guide you through. The workflow is a step-by-step plan the user (or workflow author) created for this type of task.

Returns:
- metadata mode: Just name and description
- preview mode: Full step-by-step breakdown (default)

Remember: inspecting is read-only. Call start_workflow when ready to begin.`,

    start_workflow: `Begin following a workflow's step-by-step instructions (WorkRail v2, feature-flagged).

The workflow represents the user's plan for this task. Each step will tell you exactly what to do. Your job is to execute each step's instructions and report back.

What you'll receive:
- stateToken: Your session handle (save this - you'll need it for every continue_workflow call)
- ackToken: Your completion acknowledgement token (include when advancing to next step)
- pending: The first step's instructions (in pending.prompt)
- nextIntent: What to do next (usually "perform_pending_then_continue")
- preferences: Execution mode settings (autonomy level, risk policy)

What to do:
1. Execute the pending step exactly as its prompt describes
2. Call continue_workflow with stateToken + ackToken + your output
3. Don't predict what comes next - the workflow will tell you

Context auto-loads: If you provide context at start, WorkRail remembers it. On future continue_workflow calls, only pass context if you have NEW information to add.`,

    continue_workflow: `Get the next step in the workflow (WorkRail v2, feature-flagged).

This is an interactive conversation with state. Each call either:
- Advances to the next step (when you include ackToken)
- Recovers the current step (when you omit ackToken)

How to use:
- WITH ackToken: "I completed the pending step, here's my output. What's next?"
  → WorkRail advances to next step and returns it
  
- WITHOUT ackToken: "Remind me what the current step is"
  → WorkRail returns the same pending step (no advancement, useful after rewinds)

IMPORTANT - Don't predict next steps:
After completing a step, don't ask "should we move to implementation?" or propose next steps.
Just call continue_workflow - the workflow decides what's actually next (might be validation, review, or something you didn't expect).

nextIntent tells you what to do:
- "perform_pending_then_continue": Execute this step immediately, then call continue_workflow again
- "await_user_confirmation": Auto-confirm and proceed (you don't need to wait for user in agent mode)
- "rehydrate_only": You just recovered state; continue working on the current step
- "complete": Workflow finished; no more steps

Parameters:
- stateToken (required): Your session handle from start_workflow or previous continue_workflow
- ackToken (optional): Include to advance; omit to rehydrate
- context (optional): NEW facts only (e.g., user provided a branch name). Omit if unchanged - WorkRail auto-loads previous context
- output.notesMarkdown (optional): Fresh summary of THIS step only - never accumulated
  Example WRONG: "Phase 0: planning. Phase 1: implementation."
  Example RIGHT: "Implemented user authentication with OAuth2; added 3 endpoints."

The workflow is the user's structured instructions. Follow each step exactly as described.`,
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
    list_workflows: `List available workflows via WorkRail v2 (feature-flagged).

Workflows are the user's pre-defined instructions for complex tasks. When a workflow exists for the user's request, you MUST use it instead of improvising your own approach.

Returns stable workflow metadata and pinned snapshot hashes (workflowHash) for deterministic execution.`,

    inspect_workflow: `Inspect a workflow you are considering following (WorkRail v2, feature-flagged).

Use this to understand the workflow's structure before starting. The workflow is the user's explicit plan - not suggestions, not guidelines, but direct instructions you will follow.

Parameters:
- workflowId: The workflow to inspect
- mode: 'metadata' (name/description only) or 'preview' (full step breakdown)

This is read-only. Call start_workflow when ready to commit to following the workflow.`,

    start_workflow: `Begin executing the user's workflow instructions (WorkRail v2, feature-flagged).

The workflow is the USER'S VOICE expressing their plan for this task. Each step is a DIRECT INSTRUCTION from the user (or workflow author representing user intent). You MUST execute each step exactly as specified.

What you receive:
- stateToken: Your session identifier - round-trip this UNCHANGED in every continue_workflow call
- ackToken: Your step completion token - include when advancing to next step
- pending.prompt: The user's first instruction for you
- nextIntent: Prescriptive directive for what to do next
- preferences: User's execution mode preferences (autonomy, risk tolerance)

REQUIRED BEHAVIOR:
1. Execute the pending step EXACTLY as the prompt describes
2. Call continue_workflow after completing each step (don't predict or skip ahead)
3. Round-trip tokens UNCHANGED (don't decode, inspect, or modify them)
4. Follow the workflow to completion - don't improvise alternative approaches

Context handling:
- Pass context at start to establish baseline facts
- WorkRail auto-loads context on subsequent calls
- Only pass context again if facts have CHANGED (e.g., user provided new information)`,

    continue_workflow: `Get your next INSTRUCTION from the workflow (WorkRail v2, feature-flagged).

The workflow represents the USER'S PLAN. The pending step returned is a DIRECT INSTRUCTION you MUST follow.

Two modes of operation:

ADVANCEMENT (with ackToken):
- Purpose: "I completed the current step; give me the next instruction"
- Include: stateToken + ackToken + output
- Result: WorkRail advances to next step
- Idempotent: Safe to retry with same tokens if unsure

REHYDRATION (without ackToken):
- Purpose: "Remind me what the current step is" (after rewind/lost context)
- Include: stateToken only (no ackToken, no output)
- Result: Same pending step returned; no advancement
- Side-effect-free: No durable writes; pure state recovery

REQUIRED BEHAVIOR:
1. Execute the step EXACTLY as specified in pending.prompt
2. Do NOT predict what comes next - call continue_workflow and the workflow will tell you
3. Do NOT skip steps, combine steps, or improvise your own approach
4. Do NOT ask "should we move to implementation?" - just call continue_workflow

nextIntent is PRESCRIPTIVE (not advisory):
- "perform_pending_then_continue": Execute this step, then call continue_workflow immediately
- "await_user_confirmation": Auto-confirm and proceed (workflow represents user's intent)
- "rehydrate_only": State recovery occurred; continue working on current step
- "complete": Workflow finished; no further calls needed

Parameters:
- stateToken (required): Round-trip unchanged from previous response
- ackToken (optional): Include to ADVANCE, omit to REHYDRATE
- context (optional): NEW facts only (auto-merges with previous). Omit if unchanged
- output.notesMarkdown (optional): Summary of THIS step only (fresh, never accumulated)
  
The workflow is the user's structured will. Follow it exactly - it may validate, loop, or branch in ways you don't predict.`,
  },
} as const;
