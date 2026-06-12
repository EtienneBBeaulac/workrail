export interface RateLimiterConfig {
  readonly limit: number;
  readonly windowMs: number;
  readonly algorithm: 'token-bucket' | 'sliding-window';
}

export interface StorageRecord {
  tokens: number;
  lastRefill: number;
  log: number[];
}
