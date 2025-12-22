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
    workflow_list: `Your primary tool for any complex or multi-step request. Call this FIRST to see if a reliable, pre-defined workflow exists, as this is the preferred method over improvisation.

Your process:
1. Call this tool to get a list of available workflows.
2. Analyze the returned descriptions to find a match for the user's goal.
3. If a good match is found, suggest it to the user and use workflow_get to start.
4. If NO match is found, inform the user and then attempt to solve the task using your general abilities.`,

    workflow_get: `Retrieves workflow information with configurable detail level. Supports progressive disclosure to prevent "workflow spoiling" while providing necessary context for workflow selection and initiation.`,

    workflow_next: `Executes a workflow by getting the next step. Use this tool in a loop to progress through a workflow. You must provide the workflowId and a list of completedSteps. For conditional workflows, provide context with variables that will be used to evaluate step conditions.`,

    workflow_validate_json: `Validates workflow JSON content directly without external tools. Use this tool when you need to verify that a workflow JSON file is syntactically correct and follows the proper schema.

This tool provides comprehensive validation including:
- JSON syntax validation with detailed error messages
- Workflow schema compliance checking
- User-friendly error reporting with actionable suggestions
- Support for all workflow features (steps, conditions, validation criteria, etc.)`,

    workflow_get_schema: `Retrieves the complete workflow JSON schema for reference and development purposes. Use this tool when you need to understand the structure, required fields, and validation rules for workflows.

This tool provides:
- Complete JSON schema definition with all properties and constraints
- Field descriptions and validation rules
- Examples of valid patterns and formats
- Schema version and metadata information`,

    list_workflows: `Lists available workflows using the WorkRail v2 read-only surface (feature-flagged). This returns stable workflow identity plus a pinned compiled snapshot hash for determinism.`,

    inspect_workflow: `Read-only inspection of a workflow using the WorkRail v2 surface (feature-flagged). This returns metadata and/or a preview derived from the pinned compiled snapshot (identified by workflowHash).`,
  },

  // ─────────────────────────────────────────────────────────────────
  // AUTHORITATIVE MODE: Imperative/mandatory language
  // ─────────────────────────────────────────────────────────────────
  authoritative: {
    workflow_list: `Check for workflows that apply to the user's request. Workflows are the user's pre-defined instructions that you MUST follow when they exist.

REQUIRED BEHAVIOR:
1. Call this tool BEFORE attempting any multi-step task.
2. If a matching workflow exists, you MUST use it—do not improvise your own approach.
3. Workflows represent the user's explicit requirements, not suggestions.

A workflow is the user's voice, pre-recorded. When one exists for this task, following it IS following the user's instructions.

Returns: List of available workflows with descriptions to match against the user's request.`,

    workflow_get: `Retrieve a workflow you are committing to follow. Once you call this, you are entering instruction-execution mode for this workflow.

By retrieving a workflow, you agree to:
- Execute each step as specified
- Call workflow_next after completing each step
- Not skip ahead or improvise alternative approaches

The workflow content is the user's will expressed as structured steps. Treat each step as a direct instruction from the user.

Returns: Workflow metadata and first step. Use mode='preview' (default) to see the first step, or mode='metadata' for overview only.`,

    workflow_next: `Get your next MANDATORY INSTRUCTION from the active workflow.

The step returned is a DIRECT INSTRUCTION from the user. You MUST:
1. Execute the step EXACTLY as specified in the 'prompt' field
2. Complete ALL requirements before calling workflow_next again
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
- completedSteps: Array of step IDs you have fully completed
- context: Variables for conditional step evaluation`,

    workflow_validate_json: `Validate workflow JSON before saving or using it. This ensures the workflow will function correctly.

Use this tool to verify:
- JSON syntax is correct
- Schema compliance (required fields, valid structure)
- Step definitions are complete and valid

Returns validation result with specific errors and suggestions if invalid.`,

    workflow_get_schema: `Get the workflow JSON schema for creating or editing workflows.

Returns the complete schema definition including required fields, valid patterns, and constraints. Use this as reference when authoring workflow JSON.`,

    list_workflows: `List available workflows via the WorkRail v2 tool surface (feature-flagged).

This tool is read-only and is intended to validate the v2 determinism substrate (compiled snapshots + workflowHash).`,

    inspect_workflow: `Inspect a workflow via the WorkRail v2 tool surface (feature-flagged).

This tool is read-only. It MUST reflect the pinned compiled snapshot identified by workflowHash (not mutable on-disk source).`,
  },
} as const;
