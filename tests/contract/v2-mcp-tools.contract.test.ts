/**
 * v2 MCP tool contract tests.
 *
 * Purpose: assert that tool response shapes match the locked output schemas.
 * These are pure boundary tests — no behavioral assertions, no side effects.
 * If a response shape drifts, these tests name the exact contract that broke.
 *
 * Why separate from protocol tests:
 * - Protocol tests verify orchestration behavior (rehydrate/advance/replay)
 * - Contract tests verify response shape at the MCP boundary
 * - When a contract breaks, the failure message should say "contract" not "protocol"
 */
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  V2WorkflowListOutputSchema,
  V2WorkflowListItemSchema,
  V2WorkflowInspectOutputSchema,
  V2StartWorkflowOutputSchema,
  V2ContinueWorkflowOutputSchema,
  V2CheckpointWorkflowOutputSchema,
  V2ResumeSessionOutputSchema,
  V2PendingStepSchema,
  V2PreferencesSchema,
  V2NextIntentSchema,
  V2BlockerReportSchema,
} from '../../src/mcp/output-schemas.js';
import {
  V2InspectWorkflowInput,
  V2ListWorkflowsInput,
  V2ResumeSessionInput,
} from '../../src/mcp/v2/tools.js';

// ---------------------------------------------------------------------------
// Helpers: minimal valid response shapes (boundary-only, no runtime deps)
// ---------------------------------------------------------------------------

const VALID_STATE_TOKEN = 'st1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_ACK_TOKEN = 'ack1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_CHECKPOINT_TOKEN = 'chk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_CONTINUE_TOKEN = 'ct_ABCDEFGHIJKLMNOPQRSTUVWX';

function validPendingStep() {
  return { stepId: 'step-1', title: 'Step 1', prompt: 'Do the thing' };
}

function validPreferences() {
  return { autonomy: 'guided' as const, riskPolicy: 'conservative' as const };
}

// ---------------------------------------------------------------------------
// list_workflows response contract
// ---------------------------------------------------------------------------

describe('list_workflows response contract', () => {
  it('accepts valid workflow list', () => {
    const response = {
      workflows: [
        {
          workflowId: 'test.wf',
          name: 'Test',
          description: 'Desc',
          version: '1.0.0',
          kind: 'workflow',
          workflowHash: 'sha256:abc123',
          visibility: {
            category: 'rooted_sharing',
            source: { kind: 'custom', displayName: 'workflows' },
            rootedSharing: {
              kind: 'remembered_root',
              rootPath: path.join(os.tmpdir(), 'repo'),
              groupLabel: 'tools',
            },
          },
        },
        { workflowId: 'test.wf2', name: 'Test 2', description: 'Desc 2', version: '1.0.0', kind: 'workflow', workflowHash: null },
      ],
    };
    expect(V2WorkflowListOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects empty workflowId', () => {
    const response = {
      workflows: [{ workflowId: '', name: 'Test', description: 'Desc', version: '1.0.0', kind: 'workflow', workflowHash: null }],
    };
    expect(V2WorkflowListOutputSchema.safeParse(response).success).toBe(false);
  });

  it('accepts empty workflow list', () => {
    expect(V2WorkflowListOutputSchema.safeParse({ workflows: [] }).success).toBe(true);
  });
});

describe('list_workflows input contract', () => {
  it('requires workspacePath', () => {
    expect(V2ListWorkflowsInput.safeParse({}).success).toBe(false);
  });

  it('accepts absolute workspacePath', () => {
    expect(V2ListWorkflowsInput.safeParse({ workspacePath: '/Users/dev/my-project' }).success).toBe(true);
  });

  it('rejects relative workspacePath', () => {
    expect(V2ListWorkflowsInput.safeParse({ workspacePath: 'relative/path' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inspect_workflow response contract
// ---------------------------------------------------------------------------

describe('inspect_workflow response contract', () => {
  it('accepts valid metadata mode response', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'metadata',
      compiled: { schemaVersion: 1, sourceKind: 'v1_preview', workflowId: 'test.wf' },
      visibility: {
        category: 'legacy_project',
        source: { kind: 'project', displayName: 'Project' },
        migration: {
          preferredSource: 'rooted_sharing',
          currentSource: 'legacy_project',
          reason: 'legacy_project_precedence',
          summary: 'Prefer rooted sharing.',
        },
      },
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts valid preview mode response', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'preview',
      compiled: {
        schemaVersion: 1,
        sourceKind: 'v1_preview',
        workflowId: 'test.wf',
        name: 'Test',
        description: 'Desc',
        version: '1.0.0',
        preview: { stepId: 's1', title: 'S1', prompt: 'P' },
      },
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects invalid mode', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'invalid',
      compiled: {},
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(false);
  });
});

describe('inspect_workflow input contract', () => {
  it('requires workspacePath', () => {
    const result = V2InspectWorkflowInput.safeParse({
      workflowId: 'test_workflow',
      mode: 'preview',
    });
    expect(result.success).toBe(false);
  });

  it('accepts absolute workspacePath', () => {
    const result = V2InspectWorkflowInput.safeParse({
      workflowId: 'test_workflow',
      mode: 'preview',
      workspacePath: '/Users/dev/my-project',
    });
    expect(result.success).toBe(true);
  });

  it('rejects relative workspacePath', () => {
    const result = V2InspectWorkflowInput.safeParse({
      workflowId: 'test_workflow',
      mode: 'preview',
      workspacePath: 'relative/path',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start_workflow response contract
// ---------------------------------------------------------------------------

describe('start_workflow response contract', () => {
  it('accepts valid response with pending step', () => {
    const response = {
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts complete workflow (no pending)', () => {
    const response = {
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: true,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'complete',
      nextCall: null,
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects pending step without continueToken', () => {
    const response = {
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: null,
    };
    // continueToken is required when pending exists (refine rule)
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects invalid continueToken format', () => {
    const response = {
      continueToken: 'not-a-valid-token',
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { continueToken: 'not-a-valid-token' } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// continue_workflow response contract
// ---------------------------------------------------------------------------

describe('continue_workflow response contract', () => {
  it('accepts valid ok response', () => {
    const response = {
      kind: 'ok',
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts valid blocked response', () => {
    const response = {
      kind: 'blocked',
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: null,
      blockers: {
        blockers: [
          {
            code: 'MISSING_REQUIRED_OUTPUT',
            pointer: { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
            message: 'Required artifact missing',
            suggestedFix: 'Provide a loop control artifact',
          },
        ],
      },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts rehydrate-only response (complete, no pending)', () => {
    const response = {
      kind: 'ok',
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: true,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'complete',
      nextCall: null,
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects unknown kind', () => {
    const response = {
      kind: 'unknown',
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: false,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'rehydrate_only',
      nextCall: null,
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-schema contracts (closed sets from design locks)
// ---------------------------------------------------------------------------

describe('closed set contracts', () => {
  describe('nextIntent', () => {
    const LOCKED_VALUES = ['perform_pending_then_continue', 'await_user_confirmation', 'rehydrate_only', 'complete'] as const;

    for (const value of LOCKED_VALUES) {
      it(`accepts locked value: ${value}`, () => {
        expect(V2NextIntentSchema.safeParse(value).success).toBe(true);
      });
    }

    it('rejects unlocked value', () => {
      expect(V2NextIntentSchema.safeParse('auto_advance').success).toBe(false);
    });
  });

  describe('preferences', () => {
    it('accepts all locked autonomy values', () => {
      for (const a of ['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop']) {
        expect(V2PreferencesSchema.safeParse({ autonomy: a, riskPolicy: 'conservative' }).success).toBe(true);
      }
    });

    it('accepts all locked riskPolicy values', () => {
      for (const r of ['conservative', 'balanced', 'aggressive']) {
        expect(V2PreferencesSchema.safeParse({ autonomy: 'guided', riskPolicy: r }).success).toBe(true);
      }
    });

    it('rejects unlocked autonomy value', () => {
      expect(V2PreferencesSchema.safeParse({ autonomy: 'turbo', riskPolicy: 'conservative' }).success).toBe(false);
    });
  });

  describe('blocker codes (via report schema)', () => {
    const LOCKED_CODES = [
      'USER_ONLY_DEPENDENCY',
      'MISSING_REQUIRED_OUTPUT',
      'INVALID_REQUIRED_OUTPUT',
      'MISSING_REQUIRED_NOTES',
      'MISSING_CONTEXT_KEY',
      'CONTEXT_BUDGET_EXCEEDED',
      'REQUIRED_CAPABILITY_UNKNOWN',
      'REQUIRED_CAPABILITY_UNAVAILABLE',
      'INVARIANT_VIOLATION',
      'STORAGE_CORRUPTION_DETECTED',
    ] as const;

    for (const code of LOCKED_CODES) {
      it(`accepts locked blocker code: ${code}`, () => {
        const report = {
          blockers: [{ code, pointer: { kind: 'context_budget' }, message: 'test' }],
        };
        expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
      });
    }

    it('rejects unlocked blocker code', () => {
      const report = {
        blockers: [{ code: 'TIMEOUT_EXCEEDED', pointer: { kind: 'context_budget' }, message: 'test' }],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });
  });

  describe('blocker pointer kinds (via report schema)', () => {
    const LOCKED_POINTERS = [
      { kind: 'context_key', key: 'my-key' },
      { kind: 'context_budget' },
      { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
      { kind: 'capability', capability: 'delegation' },
      { kind: 'workflow_step', stepId: 'step-1' },
    ] as const;

    for (const pointer of LOCKED_POINTERS) {
      it(`accepts locked pointer kind: ${pointer.kind}`, () => {
        const report = {
          blockers: [{ code: 'INVARIANT_VIOLATION', pointer, message: 'test' }],
        };
        expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
      });
    }

    it('rejects unlocked pointer kind', () => {
      const report = {
        blockers: [{ code: 'INVARIANT_VIOLATION', pointer: { kind: 'file_path', path: '/foo' }, message: 'test' }],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });
  });

  describe('blocker report ordering', () => {
    it('rejects unsorted blockers', () => {
      const report = {
        blockers: [
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' }, message: 'b' },
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'a' },
        ],
      };
      // USER_ONLY > INVARIANT lex → unsorted
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });

    it('accepts sorted blockers', () => {
      const report = {
        blockers: [
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'a' },
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' }, message: 'b' },
        ],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// checkpoint_workflow response contract
// ---------------------------------------------------------------------------

describe('checkpoint_workflow response contract', () => {
  it('accepts valid checkpoint output', () => {
    const response = {
      checkpointNodeId: 'node_abc123',
      resumeToken: VALID_STATE_TOKEN,
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects missing checkpointNodeId', () => {
    const response = { resumeToken: VALID_STATE_TOKEN };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects missing resumeToken', () => {
    const response = { checkpointNodeId: 'node_abc123' };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects invalid resumeToken format', () => {
    const response = { checkpointNodeId: 'node_abc123', resumeToken: 'not-a-token' };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkpointToken in continue_workflow / start_workflow contracts
// ---------------------------------------------------------------------------

describe('checkpointToken in response contracts', () => {
  it('continue_workflow accepts checkpointToken', () => {
    const response = {
      kind: 'ok',
      continueToken: VALID_CONTINUE_TOKEN,
      checkpointToken: VALID_CHECKPOINT_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('continue_workflow accepts response without checkpointToken', () => {
    const response = {
      kind: 'ok',
      continueToken: VALID_CONTINUE_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('start_workflow accepts checkpointToken', () => {
    const response = {
      continueToken: VALID_CONTINUE_TOKEN,
      checkpointToken: VALID_CHECKPOINT_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects invalid checkpointToken format', () => {
    const response = {
      kind: 'ok',
      continueToken: VALID_CONTINUE_TOKEN,
      checkpointToken: 'invalid-format',
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_CONTINUE_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resume_session output contract
// ---------------------------------------------------------------------------

/** Minimal valid resume candidate — keeps test fixtures DRY. */
function validResumeCandidate(overrides?: Partial<{
  sessionId: string;
  runId: string;
  workflowId: string;
  sessionTitle: string | null;
  gitBranch: string | null;
  resumeToken: string;
  snippet: string;
  whyMatched: string[];
  confidence: 'strong' | 'medium' | 'weak';
  matchExplanation: string;
}>) {
  return {
    sessionId: 'sess_abc123',
    runId: 'run_001',
    workflowId: 'wr.coding-task',
    sessionTitle: 'Task dev for MR ownership',
    gitBranch: 'feature/mr-ownership',
    resumeToken: VALID_STATE_TOKEN,
    snippet: 'Working on feature X...',
    confidence: 'medium',
    matchExplanation: 'Matched current git branch; same workspace',
    pendingStepId: 'phase-2-define-problem',
    isComplete: false,
    lastModifiedMs: 1700000000000,
    whyMatched: ['matched_branch'],
    nextCall: {
      tool: 'continue_workflow',
      params: { continueToken: VALID_STATE_TOKEN, intent: 'rehydrate' },
    },
    ...overrides,
  };
}

describe('V2ResumeSessionOutputSchema', () => {
  it('accepts valid resume response with candidates', () => {
    const response = {
      candidates: [validResumeCandidate()],
      totalEligible: 3,
    };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts totalEligible greater than candidates.length (pre-cap total)', () => {
    // totalEligible now represents all healthy sessions found, not just the ranked subset.
    // 47 sessions found → top 5 ranked → totalEligible: 47, candidates.length: 5
    const fiveCandidates = Array.from({ length: 5 }, (_, i) =>
      validResumeCandidate({ sessionId: `sess_${String(i)}`, runId: `run_${String(i)}`, snippet: '', whyMatched: ['recency_fallback'] })
    );
    const response = { candidates: fiveCandidates, totalEligible: 47 };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts empty candidates list', () => {
    const response = { candidates: [], totalEligible: 0 };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts multiple whyMatched reasons', () => {
    const response = {
      candidates: [validResumeCandidate({ whyMatched: ['matched_head_sha', 'matched_branch'] })],
      totalEligible: 1,
    };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts all valid whyMatched values', () => {
    const LOCKED_WHY_MATCHED = [
      'matched_exact_id',
      'matched_repo_root',
      'matched_head_sha',
      'matched_branch',
      'matched_notes',
      'matched_notes_partial',
      'matched_workflow_id',
      'recency_fallback',
    ];
    for (const reason of LOCKED_WHY_MATCHED) {
      const response = {
        candidates: [validResumeCandidate({ snippet: '', whyMatched: [reason] })],
        totalEligible: 1,
      };
      expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(true);
    }
  });

  it('rejects candidate missing workflowId', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['workflowId'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('rejects candidate missing sessionTitle', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['sessionTitle'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('rejects candidate missing gitBranch', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['gitBranch'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('rejects candidate missing nextCall', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['nextCall'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('rejects candidate missing confidence', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['confidence'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('rejects candidate missing matchExplanation', () => {
    const candidate = validResumeCandidate() as Record<string, unknown>;
    delete candidate['matchExplanation'];
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [candidate], totalEligible: 1 }).success).toBe(false);
  });

  it('nextCall must have tool: continue_workflow and intent: rehydrate', () => {
    // wrong tool
    const wrongTool = {
      ...validResumeCandidate(),
      nextCall: { tool: 'start_workflow', params: { continueToken: VALID_STATE_TOKEN, intent: 'rehydrate' } },
    };
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [wrongTool], totalEligible: 1 }).success).toBe(false);

    // wrong intent
    const wrongIntent = {
      ...validResumeCandidate(),
      nextCall: { tool: 'continue_workflow', params: { continueToken: VALID_STATE_TOKEN, intent: 'advance' } },
    };
    expect(V2ResumeSessionOutputSchema.safeParse({ candidates: [wrongIntent], totalEligible: 1 }).success).toBe(false);
  });

  it('nextCall continueToken matches resumeToken of the candidate', () => {
    // This is the self-documenting contract: nextCall.params.continueToken IS the resumeToken
    const candidate = validResumeCandidate();
    expect(candidate.nextCall.params.continueToken).toBe(candidate.resumeToken);
  });

  it('rejects invalid whyMatched value', () => {
    const response = {
      candidates: [validResumeCandidate({ whyMatched: ['invalid_reason'] })],
      totalEligible: 1,
    };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(false);
  });

  it('enforces max 5 candidates', () => {
    const sixCandidates = Array.from({ length: 6 }, (_, i) =>
      validResumeCandidate({ sessionId: `sess_${String(i)}`, runId: `run_${String(i)}`, snippet: '', whyMatched: ['recency_fallback'] })
    );
    const response = { candidates: sixCandidates, totalEligible: 6 };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects negative totalEligible', () => {
    const response = { candidates: [], totalEligible: -1 };
    expect(V2ResumeSessionOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resume_session INPUT contract
// ---------------------------------------------------------------------------

describe('V2ResumeSessionInput', () => {
  it('rejects empty input because workspacePath is required', () => {
    expect(V2ResumeSessionInput.safeParse({}).success).toBe(false);
  });

  it('accepts valid query', () => {
    expect(V2ResumeSessionInput.safeParse({
      workspacePath: '/Users/me/git/project',
      query: 'resume the ACEI-1234 workflow',
    }).success).toBe(true);
  });

  it('rejects empty query string — use undefined to omit, not empty string', () => {
    const result = V2ResumeSessionInput.safeParse({ workspacePath: '/Users/me/git/project', query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects query exceeding 256 characters', () => {
    const result = V2ResumeSessionInput.safeParse({ workspacePath: '/Users/me/git/project', query: 'a'.repeat(257) });
    expect(result.success).toBe(false);
  });

  it('accepts valid absolute workspacePath', () => {
    expect(V2ResumeSessionInput.safeParse({ workspacePath: '/Users/dev/my-project' }).success).toBe(true);
  });

  it('rejects non-absolute workspacePath (must start with /)', () => {
    const result = V2ResumeSessionInput.safeParse({ workspacePath: 'relative/path' });
    expect(result.success).toBe(false);
  });

  it('accepts valid 40-char lowercase hex gitHeadSha', () => {
    expect(V2ResumeSessionInput.safeParse({ workspacePath: '/Users/dev/my-project', gitHeadSha: 'a'.repeat(40) }).success).toBe(true);
  });

  it('rejects gitHeadSha that is not 40-char hex', () => {
    expect(V2ResumeSessionInput.safeParse({ workspacePath: '/Users/dev/my-project', gitHeadSha: 'abc123' }).success).toBe(false);
    expect(V2ResumeSessionInput.safeParse({ workspacePath: '/Users/dev/my-project', gitHeadSha: 'G'.repeat(40) }).success).toBe(false);
  });

  it('rejects unknown fields (strict schema)', () => {
    expect(V2ResumeSessionInput.safeParse({ workspacePath: '/Users/dev/my-project', unknownField: 'value' }).success).toBe(false);
  });
});
