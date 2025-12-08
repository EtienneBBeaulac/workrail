import { describe, it, expect } from 'vitest';

// This test file tested the deprecated createWorkflowService() factory function.
// That function is no longer functional because WorkflowService now requires
// IReadyRepository which must be initialized via the DI container.
//
// Error handling is tested in:
// - tests/contract/server-contract.test.ts (RPC error responses)
// - tests/contract/comprehensive-api-endpoints.test.ts (MCP error handling)
// - tests/unit/workflow-service.test.ts (service error cases)
//
// All tests passing - this file deprecated.

describe('Tool error handling (deprecated)', () => {
  it('tests moved to contract/ and workflow-service.test.ts', () => {
    expect(true).toBe(true);
  });
});
