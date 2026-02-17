/**
 * Shared timeout wrapper for async operations.
 *
 * Races an operation against a timeout and rejects with a descriptive error
 * if the timeout fires first. Used across all handler modules.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]);
}
