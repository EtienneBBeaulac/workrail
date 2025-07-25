# Loop Implementation Specification for Workrail

## Version: 1.0.0
**Date**: 2024-12-20  
**Status**: Approved  
**Complexity**: Large  

## Task Description

Implement loop support in the Workrail workflow system following a unified loop model that enables iterative execution patterns while maintaining the system's stateless architecture and liveness-first philosophy. This implementation will introduce a new `loop` step type that supports while, until, for, and forEach patterns through a single, flexible design.

## Key Objectives & Success Criteria

### Primary Objectives

1. **Enable Iterative Workflows**: Allow workflows to repeat steps based on conditions or collections
2. **Maintain Architectural Integrity**: Preserve the stateless execution model and existing patterns
3. **Ensure Safety**: Prevent infinite loops and resource exhaustion through configurable limits
4. **Provide Clear Migration Path**: Support backward compatibility with schema versioning

### Success Criteria

- [ ] Loop steps execute correctly for all supported patterns (while, until, for, forEach)
- [ ] Context size validation prevents exceeding 256KB limit with warnings at 80%
- [ ] Maximum iteration limits prevent infinite loops (default: 100, max: 1000)
- [ ] Existing workflows continue to function without modification
- [ ] Performance overhead per iteration < 10ms (P95)
- [ ] Migration tool successfully converts v0.0.1 workflows to v0.1.0
- [ ] 95% test coverage for loop execution logic

## Scope and Constraints

### In Scope

1. **Core Loop Implementation** (Phases 1-2)
   - Single-level loops only (no nested loops in initial release)
   - Loop-specific step reference resolution
   - Four loop types: while, until, for, forEach
   - Context variable management for iterations
   - Safety limits and graceful degradation

2. **Schema Evolution** (Phase 1)
   - Version bump from v0.0.1 to v0.1.0
   - New `loop` step type definition
   - Backward compatibility layer
   - Migration tooling

3. **State Management** (Phase 2)
   - `_loopState` reserved context namespace
   - Iteration counter tracking
   - Context size monitoring and validation
   - Graceful exit with warnings

4. **Testing Infrastructure** (Phases 3-4)
   - Unit tests for loop logic
   - Integration tests for execution patterns
   - Performance benchmarks
   - Example workflows demonstrating patterns

### Out of Scope

- Nested loop support (postponed to future release)
- General-purpose step reference system
- Persistent state storage
- Break/continue statements (Phase 4 if time permits)
- Parallel loop execution
- Dynamic loop body modification

### Technical Constraints

1. **Architecture**: Maintain stateless execution model
2. **Performance**: Loop overhead must not exceed 10ms per iteration
3. **Memory**: Total context size limited to 256KB
4. **Compatibility**: Support both v0.0.1 and v0.1.0 schemas for 6 months
5. **Safety**: Hard limit of 1000 iterations per loop

## Technical Design

### Schema Changes

```json
{
  "id": "example-loop",
  "type": "loop",
  "title": "Process Items",
  "loop": {
    "type": "while|until|for|forEach",
    "condition": {"var": "continueProcessing", "equals": true},
    "items": {"var": "itemsToProcess"},
    "maxIterations": 100,
    "iterationVar": "currentIteration",
    "itemVar": "currentItem",
    "indexVar": "currentIndex"
  },
  "body": "process-single-step"
}
```

### Loop Types

1. **while**: Execute while condition is true
2. **until**: Execute until condition becomes true
3. **for**: Execute fixed number of iterations
4. **forEach**: Iterate over array items

### Context Variables

Reserved variables injected by loop execution:
- `_loopState.{loopId}.iteration`: Current iteration number
- `_loopState.{loopId}.index`: Current array index (forEach only)
- `_loopState.{loopId}.item`: Current item (forEach only)
- User-defined variables via `iterationVar`, `itemVar`, `indexVar`

### Error Handling

- **Max Iterations Exceeded**: Add warning to `_warnings.loops.maxIterationsReached`, continue workflow
- **Context Size Exceeded**: Error at 256KB, warning at 204KB (80%)
- **Invalid Loop Configuration**: Validation error during workflow load
- **Step Reference Not Found**: Validation error with clear message

## Implementation Phases

### Phase 1: Core Loop Infrastructure (Weeks 1-2)
- Update workflow schema with loop step type
- Implement loop execution in WorkflowService
- Add loop state tracking to context
- Create condition evaluator extensions
- Add iteration counter and limits

### Phase 2: Single-Step Loops (Weeks 3-4)
- Implement loop-specific step resolver
- Add loop context variable injection
- Create unit tests for all loop types
- Add validation for infinite loop prevention
- Document basic loop patterns

### Phase 3: Multi-Step Support (Weeks 5-6)
- Enable array of steps in body
- Implement scoped context for loop body
- Add forEach loop with item iteration
- Create integration tests
- Update workflow validation

### Phase 4: Polish & Documentation (Weeks 7-8)
- Add performance optimizations
- Create comprehensive documentation
- Build example workflows
- Implement migration tool
- Optional: break/continue support

## Testing Requirements

### Unit Tests
- Loop type execution logic
- Condition evaluation
- Context variable injection
- Iteration limits
- Step reference resolution

### Integration Tests
- End-to-end loop execution
- Context size validation
- Error handling scenarios
- Schema version compatibility
- Performance benchmarks

### Test Workflows
1. Polling pattern (while loop with timeout)
2. Batch processing (forEach with items)
3. Retry logic (for loop with attempts)
4. Search pattern (until condition met)

## Migration Guide

### For Workflow Authors
1. Run validation: `workrail validate my-workflow.json`
2. Auto-migrate: `workrail migrate-workflow my-workflow.json`
3. Test migrated workflow thoroughly
4. Update to use new loop features

### For System Administrators
1. Deploy new version with dual schema support
2. Monitor for validation errors
3. Assist with workflow migration
4. Phase out v0.0.1 support after 6 months

## Risk Mitigation

| Risk | Mitigation | Monitoring |
|------|------------|------------|
| Infinite Loops | Hard iteration limits, timeouts | Track loops hitting limits |
| Context Explosion | Size validation, warnings | Monitor context growth patterns |
| Performance Impact | Benchmark requirements, optimization | Track P95 execution times |
| Migration Issues | Dual version support, tooling | Log schema validation failures |
| Complexity Creep | Explicit scope boundaries | Regular scope reviews |

## Complexity Verification

The **Large** complexity classification remains appropriate due to:
- Fundamental changes to workflow execution model
- Multi-layer system modifications (schema, types, services)
- Comprehensive testing requirements
- Backward compatibility needs
- 8-week implementation timeline

This specification provides clear boundaries and implementation guidance while maintaining system integrity. 