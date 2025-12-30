# v2 Lock Closure Plan

> **Auto-generated** — Do not edit manually.
> Registry version: 1.0.0

This file is a deterministic “what to do next” plan for driving **uncovered locks → 0**.

---

## Summary

- Total locks: **109**
- Covered: **109**
- Uncovered: **0**

## Uncovered locks by priority

Rule: add `@enforces <lockId>` only when the test truly asserts the invariant.

---

## How to close a lock

1. Add or extend a test that **asserts** the invariant.
2. Add `@enforces <lockId>` in that test file JSDoc comment.
3. Run `npm run generate:locks` and ensure uncovered locks decrease.
