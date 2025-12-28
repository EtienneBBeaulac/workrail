# Remaining Waves for A+ Completion

## Current Status
- Branch: `feature/etienneb/unified-mcp-error-envelope`  
- Commits: 4 (DI foundation complete)
- Wave 1: Outputs ready in WAVE1_OUTPUTS.md (apply manually or via next session)

## Wave 2: Remove try/catch (2 parallel subagents)

**Prerequisites**: Wave 1 committed

### Subagent 2A: handleV2StartWorkflow
- Read: `src/mcp/handlers/v2-execution.ts` (after Wave 1)
- Task: Remove `try {` and matching `} catch (e) {...}` 
- Philosophy: Errors as data (all infrastructure returns Result types)
- Output: Modified function

### Subagent 2B: handleV2ContinueWorkflow  
- Same pattern
- Output: Modified function

**Integrate**: Apply both → typecheck → test → commit

## Wave 3: Documentation (2 parallel subagents)

### Subagent 3A: Update header comment (lines 42-46)
### Subagent 3B: Add KDoc to helpers

**Integrate**: Apply both → commit

## Wave 4: Verification (5 parallel auditors)

### Auditor A: Type safety
### Auditor B: Philosophy compliance (score 0-100%)
### Auditor C: Test coverage
### Auditor D: Lock compliance  
### Auditor E: Code quality

**Integrate**: Compile report → fix issues → final commit

## Timeline
- Wave 2: ~15 min
- Wave 3: ~10 min
- Wave 4: ~10 min
- Fixes: ~5 min
Total: ~40 min to A+
