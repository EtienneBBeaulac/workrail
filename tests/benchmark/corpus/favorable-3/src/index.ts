import { RateLimiterConfig } from './types';

/**
 * Multi-File Rate Limiter Engine.
 * 
 * Instructions:
 * Implement a RateLimiter class that executes rate-limiting against a key.
 * 
 * Requirements:
 * 1. Support both 'token-bucket' and 'sliding-window' algorithms based on config.
 * 2. You MUST design the state storage in a separate file `src/storage.ts` and import it.
 * 3. The RateLimiter class must expose:
 *    `async isAllowed(key: string, limit: number, windowMs: number, algorithm: 'token-bucket' | 'sliding-window'): Promise<boolean>`
 * 4. Token Bucket rules:
 *    - Tokens refill linearly over time.
 *    - Refill rate: limit / (windowMs / 1000) tokens per second.
 *    - Maximum capacity is equal to 'limit'.
 *    - Initial capacity starts full (at 'limit').
 *    - Each request consumes 1 token. Returns true if consumed, false otherwise.
 * 5. Sliding Window rules:
 *    - Store timestamps of allowed requests.
 *    - Filter out timestamps older than (now - windowMs).
 *    - If log length is less than 'limit', append 'now' and return true. Otherwise return false.
 */
export class RateLimiter {
  // TODO: Implement storage instantiation and isAllowed logic
  async isAllowed(
    key: string,
    limit: number,
    windowMs: number,
    algorithm: 'token-bucket' | 'sliding-window'
  ): Promise<boolean> {
    return false;
  }
}
