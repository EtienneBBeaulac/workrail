# Loop Implementation Plan for Workrail

## Version: 1.0.0
**Date**: 2024-12-20  
**Specification**: [loop-implementation-spec.md](../specs/loop-implementation-spec.md)  
**Design**: [loop-implementation-design.md](../design/loop-implementation-design.md)

## 1. Goal Clarification

### Primary Goal
Implement loop support in the Workrail workflow system, enabling iterative execution patterns while maintaining the stateless architecture and backward compatibility.

### Key Assumptions
1. Existing workflows must continue functioning without modification
2. The stateless execution model is non-negotiable
3. Safety limits prevent resource exhaustion
4. Single-level loops only (no nesting) in initial release
5. Context size limit of 256KB must be enforced

### Success Criteria
- [ ] All four loop types (while, until, for, forEach) execute correctly
- [ ] Context size validation prevents exceeding 256KB with warnings at 80%
- [ ] Maximum iteration limits enforced (default: 100, max: 1000)
- [ ] Zero breaking changes to existing workflows
- [ ] Performance overhead < 10ms per iteration (P95)
- [ ] Migration tool converts v0.0.1 → v0.1.0 workflows
- [ ] Test coverage > 95% for loop execution logic
- [ ] Documentation complete with examples

## 2. Impact Assessment

### Affected Components

| Component | Impact Level | Changes Required |
|-----------|-------------|------------------|
| `workflow.schema.json` | High | Add loop step type, version bump |
| `workflow-service.ts` | High | Major refactoring of getNextStep() |
| `workflow-types.ts` | Medium | New interfaces for LoopStep, LoopConfig |
| `validation-engine.ts` | Medium | Loop-specific validation rules |
| `schemas.ts` | Medium | Dual version support |
| Storage implementations | Low | No changes required |
| RPC/MCP layer | Low | No external API changes |

### Dependencies
- **Internal**: Condition evaluator (no changes needed)
- **External**: None
- **Breaking**: None with proper versioning

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Infinite loops | Medium | High | Hard iteration limits, timeouts |
| Context explosion | Medium | High | Size validation, monitoring |
| Migration failures | Low | Medium | Dual version support, clear errors |
| Performance degradation | Low | Medium | Benchmarks, optimization |
| Test complexity | Medium | Low | Phased testing approach |

## 3. Implementation Strategy

### Phase 1: Foundation (Week 1-2)

#### Step 1.1: Schema Evolution
**Task**: Update workflow schema to v0.1.0 with loop support  
**Rationale**: Foundation for all loop functionality  
**Inputs**: Current schema v0.0.1  
**Outputs**: Updated schema with loop definitions  
**Implementation**:
- Copy current schema to `workflow.schema.v0.0.1.json`
- Update main schema with loop step type
- Add version property to schema
- Update schema validator for dual version support

#### Step 1.2: Type Definitions
**Task**: Create TypeScript interfaces for loop structures  
**Rationale**: Type safety for implementation  
**Inputs**: Design document type specifications  
**Outputs**: New types in `workflow-types.ts`  
**Implementation**:
- Define `LoopStep` interface extending `WorkflowStep`
- Define `LoopConfig` interface
- Define `LoopState` interface
- Extend `ConditionContext` with loop variables

#### Step 1.3: Loop Execution Context
**Task**: Implement `LoopExecutionContext` class  
**Rationale**: Encapsulate loop state management  
**Inputs**: Loop configuration, current state  
**Outputs**: Stateful loop manager  
**Location**: `src/application/services/loop-execution-context.ts`  
**Implementation**:
- Constructor accepting loop config
- State tracking (iteration, items, warnings)
- `shouldContinue()` method with safety checks
- `injectVariables()` for context enhancement

#### Step 1.4: Basic Loop Recognition
**Task**: Update WorkflowService to recognize loop steps  
**Rationale**: Enable basic loop detection  
**Inputs**: Workflow with loop steps  
**Outputs**: Loop step identification  
**Implementation**:
- Add type checking in `getNextStep()`
- Create loop context when loop detected
- Stub out loop execution logic

### Phase 2: Core Implementation (Week 3-4)

#### Step 2.1: Loop Step Resolver
**Task**: Implement `LoopStepResolver` class  
**Rationale**: Handle step reference resolution  
**Inputs**: Workflow, step ID  
**Outputs**: Resolved step or validation error  
**Location**: `src/application/services/loop-step-resolver.ts`  
**Implementation**:
- `resolveStepReference()` method
- Validation for step existence
- Prevent circular references
- Cache resolved steps

#### Step 2.2: While Loop Implementation
**Task**: Implement while loop execution  
**Rationale**: Simplest loop type, foundation for others  
**Inputs**: Loop config with condition  
**Outputs**: Iterative execution  
**Implementation**:
- Condition evaluation per iteration
- Context variable updates
- Iteration tracking
- Exit on condition false

#### Step 2.3: Context Size Monitoring
**Task**: Add context size validation  
**Rationale**: Prevent memory exhaustion  
**Inputs**: Context object  
**Outputs**: Size tracking and warnings  
**Implementation**:
- Efficient size calculation
- Warning at 204KB (80%)
- Error at 256KB
- Size stored in `_contextSize`

#### Step 2.4: Loop Validation Rules
**Task**: Extend ValidationEngine for loops  
**Rationale**: Ensure loop configuration validity  
**Inputs**: Loop step configuration  
**Outputs**: Validation results  
**Implementation**:
- Validate loop type
- Check required properties
- Validate step references
- Prevent nested loops

### Phase 3: Full Loop Support (Week 5-6)

#### Step 3.1: Additional Loop Types
**Task**: Implement until, for, forEach loops  
**Rationale**: Complete loop type coverage  
**Inputs**: Various loop configurations  
**Outputs**: All loop types functional  
**Implementation**:
- Until: inverse of while logic
- For: fixed iteration count
- forEach: array iteration with item/index

#### Step 3.2: Multi-Step Body Support
**Task**: Enable array of steps in loop body  
**Rationale**: Support complex loop bodies  
**Inputs**: Array of step definitions  
**Outputs**: Sequential step execution  
**Implementation**:
- Parse step array
- Maintain sub-step completion tracking
- Handle body step conditions

#### Step 3.3: Integration Tests
**Task**: Comprehensive integration testing  
**Rationale**: Ensure end-to-end functionality  
**Inputs**: Test workflows  
**Outputs**: Test suite  
**Location**: `tests/integration/loop-execution.test.ts`  
**Implementation**:
- Test all loop types
- Context size limits
- Iteration limits
- Error scenarios

#### Step 3.4: Performance Optimization
**Task**: Optimize loop execution performance  
**Rationale**: Meet <10ms overhead requirement  
**Inputs**: Performance benchmarks  
**Outputs**: Optimized implementation  
**Implementation**:
- Lazy evaluation for forEach
- Efficient state updates
- Context cloning optimization
- Benchmark validation

### Phase 4: Polish & Tools (Week 7-8)

#### Step 4.1: Migration Tool
**Task**: Create workflow migration utility  
**Rationale**: Enable smooth version transition  
**Inputs**: v0.0.1 workflows  
**Outputs**: v0.1.0 workflows  
**Location**: `src/cli/migrate-workflow.ts`  
**Implementation**:
- Version detection
- Schema validation
- Auto-migration logic
- Error reporting

#### Step 4.2: Example Workflows
**Task**: Create demonstration workflows  
**Rationale**: Documentation and testing  
**Inputs**: Common use cases  
**Outputs**: Example JSON files  
**Location**: `workflows/examples/loops/`  
**Implementation**:
- Polling pattern (while)
- Retry logic (for)
- Batch processing (forEach)
- Search pattern (until)

#### Step 4.3: Documentation
**Task**: Comprehensive documentation  
**Rationale**: Enable adoption  
**Inputs**: Implementation details  
**Outputs**: User and developer docs  
**Location**: `docs/features/loops.md`  
**Implementation**:
- Loop type explanations
- Configuration examples
- Best practices
- Migration guide

#### Step 4.4: Final Testing & Polish
**Task**: Final test pass and cleanup  
**Rationale**: Production readiness  
**Inputs**: All implementation  
**Outputs**: Polished feature  
**Implementation**:
- Edge case testing
- Performance validation
- Code cleanup
- PR preparation

## 4. Testing Strategy

### Unit Testing (>95% coverage)
- **LoopExecutionContext**: State management, iteration control
- **LoopStepResolver**: Reference resolution, validation
- **WorkflowService**: Loop step handling
- **ValidationEngine**: Loop validation rules

### Integration Testing
- End-to-end loop execution for all types
- Context size limit enforcement
- Schema version compatibility
- Error handling scenarios

### Performance Testing
- Benchmark loop overhead (<10ms P95)
- Large array handling (forEach)
- Context size growth patterns
- Memory usage profiling

### Test Patterns
- Follow existing test structure in `tests/`
- Mock storage for unit tests
- Real execution for integration tests
- Deterministic iteration for repeatability

## 5. Failure Handling

### Development Failures

| Failure Type | Response Strategy |
|--------------|-------------------|
| Test failures | Fix immediately, don't proceed to next step |
| Performance regression | Profile, optimize, re-benchmark |
| Schema validation errors | Review schema changes, fix inconsistencies |
| Type errors | Update interfaces, ensure consistency |
| Integration failures | Debug with integration tests, check assumptions |

### Runtime Failures

| Failure Type | Handling Strategy |
|--------------|-------------------|
| Infinite loop detected | Exit gracefully, add warning, continue workflow |
| Context size exceeded | Throw error with clear message, halt workflow |
| Invalid step reference | Validation error during workflow load |
| Condition evaluation error | Log error, treat as false, continue |

### Rollback Strategy
1. Revert to previous commit if critical failure
2. Dual schema support allows gradual rollback
3. Feature flag for loop execution (if needed)
4. Clear communication of issues found

## 6. Final Review Checklist

### Code Quality
- [ ] All loop types implemented and tested
- [ ] Test coverage > 95% for new code
- [ ] No linting errors or warnings
- [ ] Code follows existing patterns and conventions
- [ ] Performance benchmarks pass (<10ms overhead)

### Functionality
- [ ] While loops execute correctly
- [ ] Until loops execute correctly
- [ ] For loops execute correctly
- [ ] forEach loops execute correctly
- [ ] Context size validation works
- [ ] Iteration limits enforced
- [ ] Graceful exit on limits

### Compatibility
- [ ] Existing workflows unaffected
- [ ] Schema v0.0.1 workflows load correctly
- [ ] Schema v0.1.0 workflows load correctly
- [ ] Migration tool works correctly
- [ ] No breaking API changes

### Documentation
- [ ] Loop feature documentation complete
- [ ] Migration guide written
- [ ] Example workflows created
- [ ] API documentation updated
- [ ] CHANGELOG.md updated

### Safety
- [ ] No infinite loops possible
- [ ] Context size limits enforced
- [ ] Resource usage bounded
- [ ] Error handling comprehensive
- [ ] Security considerations addressed

### Integration
- [ ] All storage implementations compatible
- [ ] RPC/MCP layer unchanged
- [ ] Validation engine extended
- [ ] Condition evaluator integration working

This implementation plan provides a systematic approach to adding loop support while maintaining system integrity and meeting all specified requirements. 