/**
 * Transport mode for WorkRail MCP server.
 * 
 * Discriminated union ensures illegal states are unrepresentable:
 * - can't have { useHttp: true, port: undefined }
 * - can't have ambiguous "default" mode
 * - exhaustive switching required at compile time
 */
export type TransportMode =
  | { readonly kind: 'stdio' }
  | { readonly kind: 'http'; readonly port: number };

/**
 * Resolve transport mode from environment variables.
 * 
 * Environment:
 * - WORKRAIL_TRANSPORT: 'stdio' | 'http' (default: 'stdio')
 * - WORKRAIL_HTTP_PORT: port number for HTTP mode (default: 3100)
 * 
 * Philosophy:
 * - Validate at boundaries: env vars validated here, trusted afterward
 * - Determinism: same env produces same mode
 * - Fail fast: invalid port throws immediately
 */
export function resolveTransportMode(env: NodeJS.ProcessEnv): TransportMode {
  const transport = env.WORKRAIL_TRANSPORT ?? 'stdio';
  
  if (transport === 'http') {
    const portStr = env.WORKRAIL_HTTP_PORT ?? '3100';
    const port = parseInt(portStr, 10);
    
    if (isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(
        `Invalid WORKRAIL_HTTP_PORT: "${portStr}". Must be a number between 1-65535.`
      );
    }
    
    return { kind: 'http', port };
  }
  
  if (transport !== 'stdio') {
    throw new Error(
      `Invalid WORKRAIL_TRANSPORT: "${transport}". Must be 'stdio' or 'http'.`
    );
  }
  
  return { kind: 'stdio' };
}
