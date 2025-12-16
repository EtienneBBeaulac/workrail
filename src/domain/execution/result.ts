export { ok, err, type Result } from 'neverthrow';

// Compatibility helpers to keep call sites simple.
export const isOk = <T, E>(r: import('neverthrow').Result<T, E>): boolean => r.isOk();
export const isErr = <T, E>(r: import('neverthrow').Result<T, E>): boolean => r.isErr();
