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

The response contains your first step's instructions as the main content, with tokens in a JSON code block at the end. The step title is the heading, and the step prompt is the body.

What to do:
1. Read the step instructions (the main body of the response) and execute them exactly
2. When done, call continue_workflow with the stateToken and ackToken from the JSON block at the end
3. Add output.notesMarkdown documenting your work (see notes guidance below)
4. Don't predict what comes next — the workflow will tell you

Notes guidance: Write output.notesMarkdown for a human reader who will reference it later. Include what you did, key decisions and trade-offs, what you produced (files, endpoints, test results), and anything notable (risks, open questions, things you deliberately skipped). Use markdown formatting. Be specific — names, paths, numbers. 10–30 lines is ideal; too short is worse than too long.

Workspace anchoring: Pass workspacePath (the "Workspace:" path from your system parameters) so this session can be found by resume_session in future chats. Without it, session discovery may not work.

Context auto-loads: If you provide context at start, WorkRail remembers it. On future continue_workflow calls, only pass context if you have NEW information to add.`,

    continue_workflow: `Get the next step in the workflow (WorkRail v2, feature-flagged).

QUICK START — How to call back after completing a step:
Copy the stateToken and ackToken from the JSON code block at the end of the previous response. Just add your output.

Two modes:

ADVANCE (with ackToken):
- "I completed the current step; give me the next one"
- Requires: stateToken + ackToken (from the JSON block in previous response)
- Optional: output (your work summary), context (if facts changed)
- Result: WorkRail advances to next step and returns it

REHYDRATE (without ackToken):
- "Remind me what the current step is" (after rewind or lost context)
- Requires: stateToken only
- Do NOT include ackToken or output
- Result: Same pending step returned; no advancement; side-effect-free

Intent is auto-inferred: ackToken present → advance, ackToken absent → rehydrate.
You can set intent explicitly if you prefer, but it's optional.

Reading the response:
The response is natural language with your step instructions as the main content. A JSON code block at the end contains the tokens for your next call. The response tells you directly what to do — execute the step, retry with corrections, wait for user input, or acknowledge completion.

Parameters:
- stateToken (required): From the JSON block in the previous response
- ackToken (required for advance): From the JSON block in the previous response
- intent (optional): "advance" or "rehydrate" — auto-inferred from ackToken if omitted
- context (optional): NEW facts only. Omit if unchanged — WorkRail auto-loads previous context
- output.notesMarkdown (advance only): Recap of THIS step — what you did, key decisions, what you produced, anything notable. Write for a human reviewer. Use markdown, be specific (names, paths, numbers). 10–30 lines; never accumulate previous steps.

The workflow is the user's structured instructions. Follow each step exactly as described.`,

    checkpoint_workflow: `Save a checkpoint on the current workflow step (WorkRail v2, feature-flagged).

Creates a durable checkpoint on your current step without advancing. Useful for saving progress on long-running steps.

Requires: checkpointToken (from the most recent start_workflow or continue_workflow response).

Idempotent: calling with the same checkpointToken multiple times is safe and returns the same result.

Returns: checkpointNodeId + a fresh stateToken.`,

    resume_session: `Find and reconnect to an existing workflow session (WorkRail v2, feature-flagged).

Use this when you need to resume a previously started workflow but don't have the stateToken (e.g., new chat, lost context).

Pass workspacePath (the "Workspace:" path from your system parameters) to match sessions anchored to your current workspace. Without it, git-based tier matching won't work.

WorkRail ranks sessions using a 5-tier matching algorithm:
1. Exact git HEAD SHA match
2. Git branch match (exact or prefix)
3. Free text match against session notes
4. Free text match against workflow ID
5. Recency fallback

Returns: Up to 5 ranked candidates, each with a stateToken you can use with continue_workflow.`,
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

The response contains your first step's instructions as the main content (heading + body), with tokens in a JSON code block at the end.

REQUIRED BEHAVIOR:
1. Execute the step instructions (the main body of the response) EXACTLY as described
2. When done, call continue_workflow with the stateToken and ackToken from the JSON block at the end
3. Add output.notesMarkdown documenting your work — write for a human reader who will reference it later. Include what you did, key decisions/trade-offs, what you produced (files, endpoints, test results), and anything notable (risks, open questions, deliberate omissions). Use markdown formatting, be specific (names, paths, numbers). 10–30 lines; too short is worse than too long.
4. Round-trip tokens UNCHANGED (don't decode, inspect, or modify them)
5. Follow the workflow to completion — don't improvise alternative approaches

Workspace anchoring (IMPORTANT):
- Pass workspacePath set to the "Workspace:" value from your system parameters
- This anchors the session to your workspace so resume_session can find it in future chats
- Example: workspacePath: "/Users/you/git/my-project"

Context handling:
- Pass context at start to establish baseline facts
- WorkRail auto-loads context on subsequent calls
- Only pass context again if facts have CHANGED (e.g., user provided new information)`,

    continue_workflow: `Get your next INSTRUCTION from the workflow (WorkRail v2, feature-flagged).

The workflow represents the USER'S PLAN. The step returned is a DIRECT INSTRUCTION you MUST follow.

HOW TO CALL — Copy the stateToken and ackToken from the JSON code block at the end of the previous response. Add output if desired.

Two modes:

ADVANCE (with ackToken):
- Purpose: "I completed the current step; give me the next instruction"
- Requires: stateToken + ackToken (from the JSON block in the previous response)
- Optional: output (your work summary), context (if facts changed)
- Result: WorkRail advances to next step
- Idempotent: Safe to retry with same tokens if unsure

REHYDRATE (without ackToken):
- Purpose: "Remind me what the current step is" (after rewind/lost context)
- Requires: stateToken only
- Do NOT include ackToken or output
- Result: Same pending step returned; no advancement
- Side-effect-free: No durable writes; pure state recovery

Intent is auto-inferred: ackToken present → advance, ackToken absent → rehydrate.
You can set intent explicitly if you prefer, but it's optional.

REQUIRED BEHAVIOR:
1. Execute the step EXACTLY as described in the response body
2. When done, call continue_workflow with tokens from the JSON block — do NOT construct params manually
3. Do NOT predict what comes next — call continue_workflow and the workflow will tell you
4. Do NOT skip steps, combine steps, or improvise your own approach

Reading the response:
The response is natural language. The step instructions are the main content (heading + body). A JSON code block at the end has the tokens for your next call. The response tells you directly what to do — execute the step, retry with corrections, wait for user input, or acknowledge completion.

Parameters:
- stateToken (required): From the JSON block in the previous response
- ackToken (required for advance): From the JSON block in the previous response
- intent (optional): "advance" or "rehydrate" — auto-inferred from ackToken if omitted
- context (optional): NEW facts only (auto-merges with previous). Omit if unchanged
- output.notesMarkdown (advance only): Recap of THIS step — what you did, key decisions, what you produced, anything notable. Write for a human reviewer. Use markdown, be specific (names, paths, numbers). 10–30 lines; never accumulate previous steps.

The workflow is the user's structured will. Follow it exactly — it may validate, loop, or branch in ways you don't predict.`,

    checkpoint_workflow: `Save a checkpoint on the current workflow step (WorkRail v2, feature-flagged).

Creates a durable checkpoint without advancing. Use for long-running steps to save progress.

Requires: checkpointToken from the most recent response. Idempotent.

Returns: checkpointNodeId + fresh stateToken.`,

    resume_session: `Find and reconnect to an existing workflow session (WorkRail v2, feature-flagged).

Call this when resuming a workflow without a stateToken. WorkRail ranks sessions deterministically:
1. Exact git HEAD SHA match (tier 1)
2. Git branch match (tier 2)
3. Notes content match (tier 3)
4. Workflow ID match (tier 4)
5. Recency (tier 5)

IMPORTANT: Pass workspacePath set to the "Workspace:" value from your system parameters.
Without it, tier 1 and tier 2 matching won't work (git context defaults to server directory, not yours).
Example: workspacePath: "/Users/you/git/my-project"

Returns: Up to 5 candidates with stateTokens. Use the best match's stateToken with continue_workflow.`,
  },
} as const;
