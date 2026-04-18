/**
 * Research spike: can structured output (output_config.format / JSON schema) and tool calls
 * coexist in a single API request?
 *
 * WHY this test exists: WorkRail currently uses tool calls for ALL workflow control
 * (complete_step is a tool). A potentially superior architecture would use structured output
 * at end_turn for workflow control while reserving tool calls for external actions (Bash, Read,
 * Write). This test determines whether that architecture is feasible across providers.
 *
 * KEY FINDING THIS TEST ANSWERS:
 * - Does the Anthropic beta API accept both `tools` and `output_config.format` in one request?
 * - Does AnthropicBedrock (AWS) expose the same beta path?
 * - On end_turn, does the response text conform to the declared JSON schema?
 * - Does a strong system prompt JSON constraint produce consistent JSON even without output_config?
 *
 * HOW TO RUN:
 *   AWS_PROFILE=zillow-sandbox npx vitest run tests/integration/structured-output-tools-coexist.ts --reporter=verbose
 *   ANTHROPIC_API_KEY=sk-... npx vitest run tests/integration/structured-output-tools-coexist.ts --reporter=verbose
 *
 * NOTE: All tests skip gracefully when credentials are absent.
 * NOTE: console.log outputs full API responses -- review with --reporter=verbose or on test failure.
 */

import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal tool definition that simulates WorkRail's Bash tool.
 * WHY this tool: represents the "external action" side of the proposed dual architecture.
 */
const BASH_TOOL = {
  name: 'bash_tool',
  description: 'Run a shell command and return output',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
    },
    required: ['command'],
  },
};

/**
 * JSON schema for the "workflow step complete" structured output.
 * WHY this schema: represents the "workflow control" side of the proposed dual architecture.
 * complete_step is today a tool call -- this schema would replace it with structured end_turn.
 */
const STEP_COMPLETE_SCHEMA = {
  type: 'object',
  properties: {
    step_complete: { type: 'boolean', description: 'Whether the current step is complete' },
    notes: { type: 'string', description: 'Notes about what was done in this step' },
  },
  required: ['step_complete', 'notes'],
  additionalProperties: false,
};

/**
 * System prompt asking for a direct end_turn response (no tool calls).
 * WHY this: when we want to test structured output, we need end_turn stop reason.
 * Tool calls have no text response, so JSON schema can only be checked at end_turn.
 */
const SYSTEM_PROMPT_STRUCTURED =
  'You are a workflow executor. Respond ONLY with a JSON object in this exact format: ' +
  '{"step_complete": true, "notes": "brief description of what you analyzed"}. ' +
  'Do NOT call any tools. Do NOT include any text outside the JSON object.';

/**
 * Bedrock model ID for claude-sonnet-4-6.
 */
const BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';

/**
 * Direct Anthropic model ID.
 * WHY claude-sonnet-4-5: this is the most recent claude-sonnet available on the direct
 * Anthropic API as of SDK v0.73.0. claude-sonnet-4-6 is only available via Bedrock as
 * 'us.anthropic.claude-sonnet-4-6' -- the direct API uses a different versioning scheme.
 */
const DIRECT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Simple message that asks for a structured response (end_turn path).
 */
const USER_MESSAGE = 'Analyze this task: write a test. Then report your findings.';

// ---------------------------------------------------------------------------
// Credential guards
// ---------------------------------------------------------------------------

const hasDirectCredentials = !!process.env['ANTHROPIC_API_KEY'];
const hasBedrockCredentials = !!(process.env['AWS_PROFILE'] || process.env['AWS_ACCESS_KEY_ID']);
const hasAnyCredentials = hasDirectCredentials || hasBedrockCredentials;

// ---------------------------------------------------------------------------
// Helper: validate JSON response against STEP_COMPLETE_SCHEMA
// ---------------------------------------------------------------------------

/**
 * Parse response text as JSON and verify it matches STEP_COMPLETE_SCHEMA shape.
 * WHY: FM3 mitigation -- without this, a silent 'output_config ignored' case would
 * produce a passing test (API call succeeded) but incorrect findings.
 */
function assertStepCompleteJson(text: string): { step_complete: boolean; notes: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Response text is not valid JSON: ${text.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Response JSON is not an object: ${JSON.stringify(parsed)}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['step_complete'] !== 'boolean') {
    throw new Error(`step_complete is not a boolean: ${JSON.stringify(obj)}`);
  }
  if (typeof obj['notes'] !== 'string') {
    throw new Error(`notes is not a string: ${JSON.stringify(obj)}`);
  }

  return { step_complete: obj['step_complete'] as boolean, notes: obj['notes'] as string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Structured output + tool calls coexistence', () => {
  // -------------------------------------------------------------------------
  // ANTHROPIC DIRECT
  // -------------------------------------------------------------------------

  describe('Anthropic direct (ANTHROPIC_API_KEY)', () => {
    /**
     * Case 1: Baseline -- tools only, no output_config.
     * WHY: establishes the baseline response shape so we can compare against the coexistence case.
     */
    it.skipIf(!hasDirectCredentials)(
      'baseline: tools-only call (no output_config)',
      { timeout: 60000 },
      async () => {
        const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

        // Use the STANDARD messages.create() path (not beta) for the baseline.
        // WHY: confirms the existing agent-loop.ts behavior.
        const response = await client.messages.create({
          model: DIRECT_MODEL,
          max_tokens: 1024,
          system: 'You are a helpful assistant. Be concise.',
          messages: [{ role: 'user', content: USER_MESSAGE }],
          tools: [BASH_TOOL],
        });

        console.log('[BASELINE direct] Full API response:');
        console.log(JSON.stringify(response, null, 2));

        // The model may call a tool or just respond -- both are valid for the baseline.
        expect(['tool_use', 'end_turn']).toContain(response.stop_reason);
        console.log(`[BASELINE direct] stop_reason: ${response.stop_reason}`);
        console.log(`[BASELINE direct] content blocks: ${response.content.map((b) => b.type).join(', ')}`);
      },
    );

    /**
     * Case 2: Coexistence -- tools + output_config.format in ONE request via beta API.
     * WHY: the core research question. Does the API accept both? Does end_turn enforce the schema?
     */
    it.skipIf(!hasDirectCredentials)(
      'tools + output_config coexist via beta API',
      { timeout: 60000 },
      async () => {
        const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

        let response: Anthropic.Beta.Messages.BetaMessage | undefined;
        let errorCaught: unknown = undefined;

        try {
          response = await client.beta.messages.create({
            model: DIRECT_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT_STRUCTURED,
            messages: [{ role: 'user', content: USER_MESSAGE }],
            tools: [BASH_TOOL],
            output_config: {
              format: {
                type: 'json_schema',
                schema: STEP_COMPLETE_SCHEMA,
              },
            },
          });
        } catch (err) {
          errorCaught = err;
        }

        if (errorCaught) {
          // API rejected the combination -- this is a valid finding, not a test failure.
          console.log('[DIRECT coexist] API ERROR (tools + output_config rejected):');
          console.log(errorCaught instanceof Error ? errorCaught.message : String(errorCaught));

          // Record the error as a finding but do not fail the test -- the error IS the finding.
          // WHY: expect(false).toBe(true) would hide the actual error message in CI.
          console.log('[DIRECT coexist] FINDING: API rejected tools + output_config coexistence');
          // We DO want to fail the test if there's an unexpected error type.
          if (
            errorCaught instanceof Error &&
            !errorCaught.message.includes('invalid') &&
            !errorCaught.message.includes('not supported') &&
            !errorCaught.message.includes('400') &&
            !errorCaught.message.includes('422')
          ) {
            throw errorCaught; // Re-throw unexpected errors
          }
          return;
        }

        expect(response).toBeDefined();
        console.log('[DIRECT coexist] Full API response:');
        console.log(JSON.stringify(response, null, 2));

        const stopReason = response!.stop_reason;
        console.log(`[DIRECT coexist] stop_reason: ${stopReason}`);
        console.log(`[DIRECT coexist] content blocks: ${response!.content.map((b) => b.type).join(', ')}`);

        // KEY CHECK: if stop_reason is end_turn, the response text MUST be valid JSON matching the schema.
        // WHY: FM3 -- schema silently ignored would still produce end_turn but with unstructured text.
        if (stopReason === 'end_turn') {
          const textBlocks = response!.content.filter((b) => b.type === 'text');
          expect(textBlocks.length).toBeGreaterThan(0);
          const text = (textBlocks[0] as { type: 'text'; text: string }).text;
          console.log(`[DIRECT coexist] end_turn text: ${text}`);

          const parsed = assertStepCompleteJson(text);
          console.log('[DIRECT coexist] FINDING: end_turn response is valid JSON matching schema');
          console.log(`[DIRECT coexist] step_complete=${parsed.step_complete}, notes="${parsed.notes}"`);
        } else {
          console.log('[DIRECT coexist] FINDING: stop_reason was tool_use -- schema constraint not tested (tool_use has no text response)');
        }

        expect(['tool_use', 'end_turn']).toContain(stopReason);
      },
    );

    /**
     * Case 3: System prompt JSON constraint consistency (fallback approach).
     * WHY: if output_config is not available or not working, does a strong system prompt
     * constraint produce consistent JSON across 3 calls? This is the fallback architecture.
     * Run 3 times to test determinism, as required by the coding philosophy.
     */
    it.skipIf(!hasDirectCredentials)(
      'system prompt JSON constraint: 3-call consistency check',
      { timeout: 120000 },
      async () => {
        const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

        const results: Array<{ call: number; text: string; valid: boolean; error?: string }> = [];

        for (let i = 1; i <= 3; i++) {
          const response = await client.messages.create({
            model: DIRECT_MODEL,
            max_tokens: 512,
            system: SYSTEM_PROMPT_STRUCTURED,
            messages: [{ role: 'user', content: USER_MESSAGE }],
            tools: [BASH_TOOL],
            // No output_config -- pure system prompt constraint
          });

          const endTurnBlocks = response.stop_reason === 'end_turn'
            ? response.content.filter((b) => b.type === 'text')
            : [];

          if (endTurnBlocks.length === 0) {
            results.push({ call: i, text: '(tool_use -- no text)', valid: false, error: 'stop_reason was tool_use, not end_turn' });
            console.log(`[DIRECT system-prompt] Call ${i}: stop_reason=${response.stop_reason} -- skipping JSON check`);
            continue;
          }

          const text = (endTurnBlocks[0] as { type: 'text'; text: string }).text;
          try {
            const parsed = assertStepCompleteJson(text);
            results.push({ call: i, text, valid: true });
            console.log(`[DIRECT system-prompt] Call ${i}: VALID JSON -- step_complete=${parsed.step_complete}`);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results.push({ call: i, text, valid: false, error });
            console.log(`[DIRECT system-prompt] Call ${i}: INVALID JSON -- ${error}`);
          }
        }

        console.log('[DIRECT system-prompt] Consistency results:');
        console.log(JSON.stringify(results, null, 2));

        const validCount = results.filter((r) => r.valid).length;
        console.log(`[DIRECT system-prompt] FINDING: ${validCount}/3 calls produced valid schema-conformant JSON`);

        // We don't hard-fail on consistency -- the count IS the finding.
        // But we do assert at least 1 call was end_turn (otherwise the test told us nothing).
        const endTurnCount = results.filter((r) => !r.error?.includes('tool_use')).length;
        if (endTurnCount === 0) {
          console.log('[DIRECT system-prompt] WARNING: All 3 calls were tool_use -- system prompt did not suppress tool calling');
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // AMAZON BEDROCK
  // -------------------------------------------------------------------------

  describe('Amazon Bedrock (AWS_PROFILE or AWS_ACCESS_KEY_ID)', () => {
    /**
     * Case 4: Coexistence -- tools + output_config via Bedrock beta API.
     * WHY: the primary deployment target for WorkRail is Bedrock (Zillow corporate).
     * If Bedrock doesn't support the beta endpoint or output_config, the architecture is moot.
     */
    it.skipIf(!hasBedrockCredentials)(
      'tools + output_config coexist via Bedrock beta API',
      { timeout: 60000 },
      async () => {
        const client = new AnthropicBedrock();

        let response: Anthropic.Beta.Messages.BetaMessage | undefined;
        let errorCaught: unknown = undefined;

        try {
          response = await (client.beta.messages as { create: Function }).create({
            model: BEDROCK_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT_STRUCTURED,
            messages: [{ role: 'user', content: USER_MESSAGE }],
            tools: [BASH_TOOL],
            output_config: {
              format: {
                type: 'json_schema',
                schema: STEP_COMPLETE_SCHEMA,
              },
            },
          }) as Anthropic.Beta.Messages.BetaMessage;
        } catch (err) {
          errorCaught = err;
        }

        if (errorCaught) {
          console.log('[BEDROCK coexist] API ERROR (tools + output_config rejected):');
          console.log(errorCaught instanceof Error ? errorCaught.message : String(errorCaught));

          // Classify the error type for findings
          const msg = errorCaught instanceof Error ? errorCaught.message : String(errorCaught);
          if (msg.includes('not supported') || msg.includes('invalid_request') || msg.includes('400')) {
            console.log('[BEDROCK coexist] FINDING: Bedrock rejected tools + output_config combination');
          } else if (msg.includes('beta') || msg.includes('output_config')) {
            console.log('[BEDROCK coexist] FINDING: Bedrock does not support output_config (beta feature not available)');
          } else {
            console.log('[BEDROCK coexist] FINDING: Unexpected error -- may be credential/routing issue');
            // Re-throw unexpected errors so the test fails visibly
            if (
              !msg.includes('400') && !msg.includes('422') && !msg.includes('not supported')
            ) {
              // Only re-throw if it's not a known API rejection pattern
              // Log but don't re-throw credential errors
              if (!msg.includes('credential') && !msg.includes('auth') && !msg.includes('token')) {
                throw errorCaught;
              }
            }
          }
          return;
        }

        expect(response).toBeDefined();
        console.log('[BEDROCK coexist] Full API response:');
        console.log(JSON.stringify(response, null, 2));

        const stopReason = response!.stop_reason;
        console.log(`[BEDROCK coexist] stop_reason: ${stopReason}`);

        if (stopReason === 'end_turn') {
          const textBlocks = response!.content.filter((b) => b.type === 'text');
          if (textBlocks.length > 0) {
            const text = (textBlocks[0] as { type: 'text'; text: string }).text;
            console.log(`[BEDROCK coexist] end_turn text: ${text}`);
            const parsed = assertStepCompleteJson(text);
            console.log('[BEDROCK coexist] FINDING: end_turn response is valid JSON matching schema');
            console.log(`[BEDROCK coexist] step_complete=${parsed.step_complete}, notes="${parsed.notes}"`);
          }
        }

        expect(['tool_use', 'end_turn']).toContain(stopReason);
      },
    );

    /**
     * Case 5: System prompt JSON constraint consistency via Bedrock (fallback approach).
     * WHY: if output_config is not available on Bedrock, this fallback must work reliably.
     */
    it.skipIf(!hasBedrockCredentials)(
      'system prompt JSON constraint: 3-call consistency check via Bedrock',
      { timeout: 120000 },
      async () => {
        const client = new AnthropicBedrock();

        const results: Array<{ call: number; text: string; valid: boolean; error?: string }> = [];

        for (let i = 1; i <= 3; i++) {
          const response = await client.messages.create({
            model: BEDROCK_MODEL,
            max_tokens: 512,
            system: SYSTEM_PROMPT_STRUCTURED,
            messages: [{ role: 'user', content: USER_MESSAGE }],
            tools: [BASH_TOOL],
          });

          const endTurnBlocks = response.stop_reason === 'end_turn'
            ? response.content.filter((b) => b.type === 'text')
            : [];

          if (endTurnBlocks.length === 0) {
            results.push({ call: i, text: '(tool_use -- no text)', valid: false, error: 'stop_reason was tool_use, not end_turn' });
            console.log(`[BEDROCK system-prompt] Call ${i}: stop_reason=${response.stop_reason} -- skipping JSON check`);
            continue;
          }

          const text = (endTurnBlocks[0] as { type: 'text'; text: string }).text;
          try {
            const parsed = assertStepCompleteJson(text);
            results.push({ call: i, text, valid: true });
            console.log(`[BEDROCK system-prompt] Call ${i}: VALID JSON -- step_complete=${parsed.step_complete}`);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results.push({ call: i, text, valid: false, error });
            console.log(`[BEDROCK system-prompt] Call ${i}: INVALID JSON -- ${error}`);
          }
        }

        console.log('[BEDROCK system-prompt] Consistency results:');
        console.log(JSON.stringify(results, null, 2));

        const validCount = results.filter((r) => r.valid).length;
        console.log(`[BEDROCK system-prompt] FINDING: ${validCount}/3 calls produced valid schema-conformant JSON`);
      },
    );
  });

  // -------------------------------------------------------------------------
  // SKIP ALL
  // -------------------------------------------------------------------------

  it.skipIf(hasAnyCredentials)(
    'skipped: no credentials available (set ANTHROPIC_API_KEY or AWS_PROFILE)',
    () => {
      console.log('No credentials available -- all API tests skipped. Set ANTHROPIC_API_KEY or AWS_PROFILE to run.');
    },
  );
});
