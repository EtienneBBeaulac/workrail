# Testing Strategy Guide

>  **Comprehensive testing strategy for the WorkRail System**

[![Build](https://img.shields.io/github/actions/workflow/status/EtienneBBeaulac/mcp/ci.yml?branch=main)]()
[![Coverage](https://img.shields.io/badge/coverage-90%25-green)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)

##  Table of Contents

1. [Testing Philosophy](#testing-philosophy)
2. [Testing Pyramid](#testing-pyramid)
3. [Current Coverage](#current-coverage)
4. [Testing Requirements](#testing-requirements)
5. [Approaches & Tooling](#approaches--tooling)
6. [Quality Gates](#quality-gates)

---

## Testing Philosophy

Our goal is to guarantee **high confidence with fast feedback**.  Tests must be deterministic, isolated, and easy to maintain.

Core principles:
1. **Test-Driven Development (TDD)** where practical.
2. **Focus on Pure Logic** – Domain & Application layers are unit-tested in isolation.
3. **Contract Tests** – RPC layer has schema-driven tests ensuring parameter validation & error mapping.
4. **No Sleep()** – async code is awaited, not timed.
5. **High Reliability** – flaky tests are fixed or removed immediately.

---

## Testing Pyramid

```
    ┌─────────────┐
    │   E2E Tests │  ← Minimal happy-path CLI / Docker checks
    └─────────────┘
    ┌─────────────┐
    │Integration  │  ← RPC ↔ use-cases ↔ storage
    │   Tests     │
    └─────────────┘
    ┌─────────────┐
    │  Unit Tests │  ← Pure functions (use-cases, validation, errors)
    └─────────────┘
```

Target distribution: **60% unit / 30% integration / 10% E2E**.

---

## Current Coverage

| Suite | Tests | Status | Notes |
|-------|-------|--------|-------|
| Unit Tests | 47 |  Passing | covers use-cases, storage adapters, validation, error mapping, CLI |
| Integration Tests | 22 |  Passing | JSON-RPC requests through stdin/stdout mocked in tests |
| Contract Tests | 12 |  Passing | server contract validation |
| Performance Tests | 7 |  Failing | optimization in progress |
| **Total** | **88** | **81 passing, 7 failing** | comprehensive coverage |

### Test Suite Breakdown
- **Unit Tests**: 47 tests covering CLI validation, storage adapters, workflow validation, error mapping
- **Integration Tests**: 22 tests covering server functionality and RPC layer
- **Contract Tests**: 12 tests ensuring API compliance
- **Performance Tests**: 7 tests (optimization in progress)
- **Workflow Validation Tests**: 27 tests covering JSON validation use case and MCP tool integration

`npm test` executes all Jest suites in <15 s locally.

---

## Testing Requirements

### Unit
* Business rules in Application layer.
* Domain error classes & mapping.
* Validation schemas (positive & negative cases).
* CLI command validation and error handling.
* Workflow JSON validation use case (syntax, schema, error messages).

### Workflow Validation Testing Patterns
* **JSON Syntax Validation**: Malformed JSON, missing quotes, trailing commas
* **Schema Compliance**: Required fields, type validation, constraint checking
* **Error Message Quality**: Actionable suggestions, clear problem descriptions
* **Edge Cases**: Empty JSON, null values, extremely large workflows
* **Integration**: MCP tool parameter validation and response format

### Integration
* RPC server end-to-end through use-cases.
* Storage composition (cache + schema validate + file).

### Performance
* Response time assertion (<200 ms) per RPC call.
* Throughput testing for workflow execution.

### Security & Performance
* Path-traversal checks in FileStorage.
* Version field consistency validation.

---

## Approaches & Tooling

| Area | Tooling |
|------|---------|
| Test runner | **Jest** (ts-jest) |
| Coverage | `--coverage` produces lcov & badge update CI |
| Fast mocks | **jest.mock** for DI container overrides |
| Static analysis | **ESLint**, **TypeScript strict** |
| CI pipeline | GitHub Actions (`ci.yml`) – lint, test, coverage gate |

---

## Quality Gates

1. **Lint Passes** – `npm run lint` must return 0.
2. **Core Tests Pass** – `npm test` unit and integration tests must pass.
3. **Coverage ≥ 90%** – enforced in jest config & CI badge.
4. **No TODO's** – eslint rule `no-warning-comments` for production code.

Performance test failures are allowed during optimization phases but must be addressed before release.

These gates block merges via required GitHub checks. 