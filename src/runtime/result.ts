/**
 * Result type (Railway-oriented programming).
 *
 * Philosophy:
 * - Errors are data (no throwing for expected failures)
 * - Discriminated unions (exhaustive by compiler)
 * - Pure helpers for composition (map/andThen/mapErr)
 */

export type Ok<T> = { readonly kind: 'ok'; readonly value: T };
export type Err<E> = { readonly kind: 'err'; readonly error: E };

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Result<T, never> => ({ kind: 'ok', value });
export const err = <E>(error: E): Result<never, E> => ({ kind: 'err', error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.kind === 'ok';
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.kind === 'err';
}

export function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.kind === 'ok' ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.kind === 'err' ? err(fn(result.error)) : result;
}

export function andThen<T, E, U>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.kind === 'ok' ? fn(result.value) : result;
}

export function match<T, E, R>(
  result: Result<T, E>,
  onOk: (value: T) => R,
  onErr: (error: E) => R
): R {
  return result.kind === 'ok' ? onOk(result.value) : onErr(result.error);
}
