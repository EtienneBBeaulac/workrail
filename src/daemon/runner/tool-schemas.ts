/**
 * JSON Schema definitions for daemon agent tools.
 *
 * WHY this module: getSchemas() returns the plain JSON Schema objects used by
 * all daemon tool factories. It has no session state or I/O dependencies --
 * just pure data. Extracting it keeps tool-schema definitions co-located with
 * the tool construction layer rather than buried in workflow-runner.ts.
 *
 * WHY plain JSON Schema: the Anthropic SDK's Tool.input_schema accepts
 * Record<string, unknown>. TypeBox was only needed because pi-agent-core's
 * AgentTool<TSchema> required a TypeBox schema type. The new AgentTool interface
 * (from agent-loop.ts) accepts plain JSON Schema directly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _schemas: Record<string, any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSchemas(): Record<string, any> {
  if (_schemas) return _schemas;
  _schemas = {
    ContinueWorkflowParams: {
      type: 'object',
      properties: {
        continueToken: {
          type: 'string',
          description: 'The continueToken from the previous start_workflow or continue_workflow call. Round-trip exactly as received.',
        },
        intent: {
          type: 'string',
          enum: ['advance', 'rehydrate'],
          description: 'advance: I completed this step. rehydrate: remind me what the current step is.',
        },
        notesMarkdown: {
          type: 'string',
          description: 'Notes on what you did in this step (10-30 lines, markdown).',
        },
        artifacts: {
          type: 'array',
          items: {},
          description:
            'Optional structured artifacts to attach to this step. ' +
            'Include wr.assessment objects here when the step requires an assessment gate. ' +
            'Example: [{ "kind": "wr.assessment", "assessmentId": "<id>", "dimensions": { "<dimensionId>": "high" } }]',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Updated context variables (only changed values). Exception: metrics_commit_shas must always contain the FULL accumulated list of all commit SHAs from this session -- never send only new SHAs.',
        },
      },
      required: ['continueToken'],
    },
    CompleteStepParams: {
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          minLength: 50,
          description:
            'What you did in this step (required, at least 50 characters). Write for a human reader. ' +
            'Include: what you did and key decisions, what you produced (files, tests, numbers), ' +
            'anything notable (risks, open questions, things you chose NOT to do and why). ' +
            'Use markdown: headings, bullets, bold. 10-30 lines is ideal.',
        },
        artifacts: {
          type: 'array',
          items: {},
          description:
            'Optional structured artifacts to attach to this step. ' +
            'Include wr.assessment objects here when the step requires an assessment gate. ' +
            'Example: [{ "kind": "wr.assessment", "assessmentId": "<id>", "dimensions": { "<dimensionId>": "high" } }]',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Updated context variables (only changed values). Omit entirely if no facts changed. Exception: metrics_commit_shas must always contain the FULL accumulated list of all commit SHAs from this session -- never send only new SHAs.',
        },
      },
      required: ['notes'],
      additionalProperties: false,
    },
    BashParams: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command' },
      },
      required: ['command'],
    },
    ReadParams: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to read. Content is returned in cat -n format: each line prefixed with its 1-indexed line number and a tab character.' },
        offset: { type: 'number', description: '0-indexed line number to start reading from (inclusive). Omit to read from the beginning.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Omit to read to end of file.' },
      },
      required: ['filePath'],
    },
    WriteParams: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['filePath', 'content'],
    },
    GlobParams: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts"). Supports standard glob syntax.' },
        path: { type: 'string', description: 'Absolute path to search root. Defaults to the workspace root.' },
      },
      required: ['pattern'],
    },
    GrepParams: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for in file contents.' },
        path: { type: 'string', description: 'Absolute path to search in. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Glob pattern to restrict which files are searched (e.g. "*.ts").' },
        type: { type: 'string', description: 'File type filter for ripgrep (e.g. "ts", "js", "py").' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. "files_with_matches": only file paths (default). "content": matching lines with context. "count": match counts per file.' },
        head_limit: { type: 'number', description: 'Maximum number of output lines to return. Default: 250.' },
        context: { type: 'number', description: 'Number of lines of context to show before and after each match (output_mode=content only).' },
        '-i': { type: 'boolean', description: 'Case-insensitive search.' },
      },
      required: ['pattern'],
    },
    EditParams: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit. The file must have been read in this session via the Read tool.' },
        old_string: { type: 'string', description: 'Exact string to find and replace. Must appear exactly once in the file (or use replace_all=true for multiple occurrences). Do NOT include line-number prefixes from Read output.' },
        new_string: { type: 'string', description: 'Replacement string. Must differ from old_string.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string. Default: false (fails if more than one match).' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    SpawnAgentParams: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'ID of the workflow to run in the child session (e.g. "wr.discovery").',
        },
        goal: {
          type: 'string',
          description: 'One-sentence description of what the child session should accomplish.',
        },
        workspacePath: {
          type: 'string',
          description: 'Absolute path to the workspace directory for the child session.',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional initial context variables to pass to the child workflow.',
        },
      },
      required: ['workflowId', 'goal', 'workspacePath'],
      additionalProperties: false,
    },
  };
  return _schemas;
}
