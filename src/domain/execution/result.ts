export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly kind: 'ok';
  readonly value: T;
}

export interface Err<E> {
  readonly kind: 'err';
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ kind: 'ok', value });
export const err = <E>(error: E): Err<E> => ({ kind: 'err', error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.kind === 'ok';
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => r.kind === 'err';
