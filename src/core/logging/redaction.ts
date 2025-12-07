/**
 * Redaction configuration for pino.
 * 
 * CTC MCP Pattern: Security first - never log secrets.
 * Comprehensive paths cover common patterns.
 */
export const REDACTION_CONFIG = {
  paths: [
    // Top-level sensitive fields
    'token',
    'secret', 
    'password',
    'apiKey',
    'authorization',
    'authToken',
    
    // One level nested (*.field)
    '*.token',
    '*.secret',
    '*.password',
    '*.apiKey',
    '*.authToken',
    
    // Common config patterns
    'config.gitlab.token',
    'config.*.token',
    'config.*.authToken',
    
    // HTTP headers
    'headers.authorization',
    'headers.Authorization',
    'headers.x-api-key',
    
    // Error objects might contain config with secrets
    'err.config.*.token',
    'err.config.*.authToken',
  ] as string[],  // Cast to mutable for pino compatibility
  censor: '[REDACTED]',
};
