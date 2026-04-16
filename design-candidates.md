# Design Candidates: PR #417 Fixes (maxConcurrentSessions semaphore)

**Date:** 2026-04-15
**Status:** Ready for main-agent review

---

## Problem Understanding

### Core Tensions

1. **Silent falsy coercion vs. explicit validation**: `parseInt('0') || undefined` looks
   idiomatic but treats `0` (a valid user intent) the same as `NaN` or absent.

2. **TypeScript type safety vs. runtime NaN**: TypeScript types `NaN` as `number`, so the
   type system cannot prevent `NaN` from reaching `new Semaphore(NaN)`. The runtime guard
   in the constructor is the only defense against a silent deadlock.

3. **Boundary responsibility**: Config values should be validated where they cross from
   string to typed number (listener), but the constructor should also enforce its own
   invariant (class boundary). Both are correct; neither replaces the other.

### Likely Seam

- **F1**: `trigger-listener.ts`, the expression `parseInt(maxConcurrencyRaw, 10) || undefined`
- **F2**: `trigger-router.ts` constructor, after the `??` fallback, before the `< 1` clamp
- **F5**: `trigger-router.ts` constructor, after `this.semaphore = new Semaphore(...)`

### What Makes This Hard

- `|| undefined` idiom looks correct at a glance; falsy case for `0` is easy to miss.
- `??` guards against `null | undefined` but not `NaN`.
- A deadlock in `Semaphore(NaN)` is silent: `acquire()` enqueues a waiter that never resolves.

---

## Philosophy Constraints

- **Make illegal states unrepresentable**: NaN as a semaphore cap is an illegal state.
- **Validate at boundaries, trust inside**: Listener = config-string boundary; constructor = class invariant boundary.
- **Determinism over cleverness**: Replace `||` with `!isNaN()`.
- **Document 'why', not 'what'**: The NaN guard needs a `// WHY:` comment.
- **Errors are data**: Invalid config -> `console.warn` + safe fallback (not throw).

No philosophy conflicts.

---

## Impact Surface

- `src/trigger/trigger-listener.ts`: one expression change
- `src/trigger/trigger-router.ts`: two-line guard insertion + one `console.log`
- No test changes required

---

## Candidates

All candidates converge. Noted honestly.

### Candidate 1 (Selected): Surgical three-expression fixes

Fix `|| undefined` to `!isNaN()` in listener, add NaN guard before `< 1` clamp in constructor
with `// WHY:` comment, add startup log line.

- **Tensions resolved**: All three.
- **Failure mode**: Variable name divergence during editing (`requested` vs `cap`).
- **Repo pattern**: Follows exactly. Same `console.warn` + clamp style.
- **Scope**: Best-fit.

### Candidate 2 (Rejected): Parse and validate in constructor only

Accept `string | number | undefined` in constructor. Rejected: wrong boundary, architectural
regression violating 'validate at boundaries'.

---

## Recommendation

Candidate 1. Surgical, correct, consistent with repo patterns and philosophy.

**Self-critique**: F2 NaN guard is redundant given F1 fix. Counter: defense-in-depth when
failure is a silent deadlock costs two lines. Worth it.

**Open questions**: None.
