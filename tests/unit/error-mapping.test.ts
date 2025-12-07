import { describe, it, expect } from 'vitest';
import { ErrorHandler, getErrorHandler } from '../../src/core/error-handler';
import { WorkflowNotFoundError, ValidationError } from '../../src/core/error-handler';
import { MCPErrorCodes } from '../../src/types/mcp-types';
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

const handler = new ErrorHandler(new FakeLoggerFactory());

describe('ErrorHandler mapping', () => {
  it('maps WorkflowNotFoundError to JSON-RPC error with correct code', () => {
    const err = new WorkflowNotFoundError('missing');
    const resp = handler.handleError(err, 1);
    expect(resp.error?.code).toBe(MCPErrorCodes.WORKFLOW_NOT_FOUND);
  });

  it('maps ValidationError to JSON-RPC error with correct code', () => {
    const err = new ValidationError('bad input');
    const resp = handler.handleError(err, 2);
    expect(resp.error?.code).toBe(MCPErrorCodes.VALIDATION_ERROR);
  });
}); 