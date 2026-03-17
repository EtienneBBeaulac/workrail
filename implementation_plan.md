# Implementation Plan: Routine-to-Template Injection

## Problem Statement
WorkRail routines can only be consumed via subagent delegation. There is no way to inject a routine's steps directly into a workflow at compile time, causing duplication and drift when workflows want to run routine logic inline.

## Acceptance Criteria
1. A workflow can reference a routine via `templateCall` and the routine's steps appear as compiled workflow steps
2. The same routine JSON works for both injection and delegation without modification
3. Routine metaGuidance is scoped to expanded steps as step-level `guidance`, not leaked into parent workflow
4. Existing tests pass; new tests cover routine-based expansion
5. Routine JSON files containing `templateCall` are rejected at load time
6. Missing template args fail compilation with a clear error message
7. Args use single-brace `{arg}` substitution; double-brace `{{contextVar}}` left untouched for runtime

## Non-Goals
- Changing routine JSON format
- Removing subagent delegation as a consumption mode
- Deciding which routines should be injected vs delegated in specific workflows
- Recursive routine injection (routines injecting other routines)

## Philosophy-Driven Constraints
- **Result<T> over exceptions**: all new functions return `Result`, no throws
- **Pure functions**: `createRoutineExpander` and arg substitution are pure, deterministic
- **Immutability**: routine data is readonly, expanded steps are readonly
- **Fail-fast at compile time**: missing args, malformed steps, recursive templateCall all fail during compilation
- **Composition over inheritance**: factory function creates expanders, no class hierarchy

## Invariants
- Compiler remains pure (no I/O) -- routine data passed as parameter
- Template expansion is deterministic -- same input always produces same output
- Routine JSON is the single source of truth for both injection and delegation modes
- Step IDs are prefixed with caller ID for provenance

## Selected Approach
Parameterized `createTemplateRegistry(routines)` that registers each routine as `wr.templates.routine.<name>`. A `createRoutineExpander` factory maps routine steps to `WorkflowStepDefinition[]` with arg substitution and metaGuidance injection.

**Runner-up**: Dedicated `RoutineLoader` interface. Rejected as unnecessary abstraction for simple data passing.

## Vertical Slices

### Slice 1: Core Expander + Registry Parameterization
**Files**: `template-registry.ts`, `workflow-compiler.ts`

1. Add `createRoutineExpander(routineId, definition)` factory in `template-registry.ts`
   - Maps routine steps to `WorkflowStepDefinition[]`
   - Prefixes step IDs with `callerId`
   - Injects routine `metaGuidance` as step-level `guidance`
   - Performs single-brace arg substitution on prompts
   - Validates: required fields (id, title, prompt), no unresolved args, no templateCall in routine steps
2. Change `createTemplateRegistry()` to accept `routineDefinitions: ReadonlyMap<string, WorkflowDefinition>`
3. Update `resolveDefinitionSteps` in `workflow-compiler.ts` to accept `TemplateRegistry` as parameter
4. Update `WorkflowCompiler.compile()` to pass registry

**Philosophy alignment**:
- [Result<T>] -> satisfied (all functions return Result)
- [pure functions] -> satisfied (no I/O in expander)
- [immutability] -> satisfied (readonly throughout)
- [fail-fast] -> satisfied (arg validation, required field validation at compile time)

### Slice 2: Routine Loading + Wiring
**Files**: `file-workflow-storage.ts` or new loader utility, `workflow-compiler.ts`

1. Extract routine definitions from `FileWorkflowStorage` or create a utility to load routine JSONs from `workflows/routines/`
2. Pass loaded routines to `createTemplateRegistry()` at initialization
3. Validate no recursive `templateCall` in loaded routines

### Slice 3: Tests
**Files**: `template-registry.test.ts`, `resolve-templates.test.ts`

1. Test `createRoutineExpander`: step mapping, ID prefixing, arg substitution, metaGuidance injection
2. Test missing arg detection (fail-fast)
3. Test recursive templateCall rejection
4. Test end-to-end: routine-based template in `resolveTemplatesPass`
5. Update existing registry tests for new parameterized signature

## Test Design
- **Unit**: `createRoutineExpander` with various routine shapes, arg combinations, edge cases
- **Unit**: `createTemplateRegistry` with routine definitions, verify resolve/has/knownIds
- **Integration**: `resolveTemplatesPass` with routine-based templates mixed with regular steps
- **Validation**: malformed routines (missing prompt, recursive templateCall, unresolved args)

## Risk Register
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Arg regex matches inside double-braces | Low | High | Regex `{([^{}]+)}` naturally excludes nested braces |
| Module-level singleton breaks callers | Low | Medium | Only internal callers; update them all in same PR |
| Routine step missing required fields | Medium | Low | Validate at expansion time with clear error |

## PR Strategy
**Single PR** -- all slices are small and interdependent. Estimated ~200-300 lines of new code + tests.

## Estimated Confidence
**High** -- design is well-specified, follows existing patterns exactly, bounded scope.
