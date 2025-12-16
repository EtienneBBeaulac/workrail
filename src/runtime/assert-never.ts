/**
 * Exhaustiveness helper for discriminated unions.
 * Use in `switch` statements to fail fast at compile time when a new union member is added.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
