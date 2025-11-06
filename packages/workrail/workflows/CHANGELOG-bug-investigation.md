# Changelog - Systematic Bug Investigation Workflow

## [1.1.0-beta.18] - 2025-01-06

### CRITICAL FIX
- **Addresses persistent early-stopping bug**: Agents were still stopping after Phase 1/2 saying "I found the bug"
- **Root Cause Identified**: Agents fundamentally misunderstand THE GOAL
  - WRONG: "The goal is finding the bug" → Stop after analysis with high confidence
  - RIGHT: "The goal is PROVING the bug with evidence" → Must complete Phases 3-5
- **New Meta-Guidance Section**: Added explicit "CRITICAL MISUNDERSTANDING TO AVOID" section
  - "FINDING ≠ DONE. PROVING = DONE."
  - "\"I found the bug\" = YOU HAVE A GUESS. \"I proved the bug\" = YOU HAVE EVIDENCE."
  - "NEVER create summary documents until Phase 6"
- **Step-Level Warnings**: Added "FINDING ≠ PROVING" warnings at all critical stopping points:
  - **Phase 1f** (after analysis): Full explanation of why analysis ≠ proof
  - **Phase 2a** (hypothesis development): "You have THEORIES, not EVIDENCE"
  - **Phase 2h** (midpoint): "You may have 'found' the bug, but haven't 'proved' it"
- **Step Count Corrections**: Fixed inconsistencies (27 → 23 steps throughout)

### Why This Fix Is Different
Previous fixes (beta.1-beta.17) added warnings about "high confidence ≠ done" but didn't address the fundamental goal misunderstanding. Agents thought their job was to "identify" the bug, not "prove" it. This fix makes the distinction crystal clear upfront.

## [1.1.0-beta.17] - 2025-01-06

### Major Restructuring
- **Phase 0 Consolidation**: Merged 4 separate Phase 0 steps into single comprehensive setup step
  - Combined: Triage (0), User Preferences (0a), Tool Check (0b), Context Creation (0c)
  - Result: Single "Phase 0: Complete Investigation Setup" step covering all mechanical preparation
  - Rationale: Reduce workflow overhead while maintaining thorough setup
  - New structure: Phase 0 (Setup) → Phase 0a (Commitment Checkpoint, conditional)
  
- **Assumption Verification Relocation**: Moved from Phase 0a to Phase 1f
  - Previously: Early assumption check before ANY code analysis (removed)
  - Now: Assumption verification AFTER all 5 analysis iterations complete (Phase 1f Step 2.5)
  - Rationale: Assumptions can only be properly verified with full code context
  - Timing: Happens after neighborhood mapping, pattern analysis, component ranking, data flow tracing, and test gap analysis
  - Location: Integrated into Phase 1f "Final Breadth & Scope Verification" before hypothesis development
  
### Impact
- **Step Count**: Reduced from 27 steps to 23 steps (4 Phase 0 steps → 1)
- **Phase Numbering**: Simplified Phase 0 structure (Phase 0d → Phase 0a)
- **Debugging Workflow Alignment**: Better follows traditional debugging principles (observe fully THEN question assumptions THEN hypothesize)
- **Agent Experience**: Faster setup phase, more informed assumption checking

### Breaking Changes
- `completedSteps` array format changed:
  - OLD: `["phase-0-triage", "phase-0a-user-preferences", "phase-0b-tool-check", "phase-0c-create-context", "phase-0d-workflow-commitment"]`
  - NEW: `["phase-0-complete-setup", "phase-0a-workflow-commitment"]`
- Step IDs changed: `phase-0d-workflow-commitment` → `phase-0a-workflow-commitment`

## [1.1.0-beta.9] - 2025-01-06

### Enhanced
- **CRITICAL**: Strengthened anti-premature-completion safeguards throughout the workflow
  - Added explicit "ANALYSIS ≠ DIAGNOSIS ≠ PROOF" section in metaGuidance
  - Phase 1f: Added "DO NOT STOP HERE" warning emphasizing ZERO PROOF after analysis (~25% done)
  - Phase 2a: Added "YOU ARE NOT DONE" warning with 5-point reminder about mandatory validation
  - Phase 2h: Added "YOU ARE HALFWAY DONE (~50%)" warning before instrumentation phase
  - Clarified progression: Analysis (20%) → Hypotheses (40%) → Evidence (80%) → Writeup (100%)
  - Reinforced: Even with "100% confidence," stopping before evidence collection = providing guesses, not diagnosis
  
### Context
- **Problem**: Agents were stopping after Phase 1 or 2 when they reached "100% confidence" in analysis/hypotheses
- **Root Cause**: Agents conflating "confident theory" with "proven diagnosis"
- **Solution**: Explicit warnings at every potential stopping point emphasizing lack of proof until Phases 3-5 complete
- **Impact**: Forces agents to understand that analysis/hypotheses are NOT evidence, and professional practice requires validation

## [1.1.0-beta.8] - 2025-01-06

### Fixed
- **CRITICAL**: Fixed loop execution bug where body steps with `runCondition` using iteration variables were completely skipped
  - Root cause: Loop variables (e.g., `analysisPhase`) were being injected AFTER evaluating runConditions, causing all conditions to fail
  - Impact: Phase 1's 5-iteration analysis loop was being entirely skipped, jumping straight to Phase 1f
  - Fix: Reordered logic to inject loop variables BEFORE evaluating body step runConditions
  - Also fixed: Pre-existing bug where single-step loop bodies didn't increment iterations properly
  - Test coverage: Added comprehensive integration tests (`loop-runCondition-bug.test.ts`) to prevent regression

## [1.1.0-beta.7] - 2025-01-06

### Fixed
- **HOTFIX**: Corrected Phase 0e `runCondition` to use `not_equals` instead of invalid `notEquals` operator
  - Phase 0e now properly executes only when `automationLevel != 'High'`
  - High automation mode now seamlessly proceeds through all phases without early termination checkpoint

## [1.1.0-beta.6] - 2025-01-06

### Added
- **New Phase 1f**: Final Breadth & Scope Verification checkpoint after codebase analysis
  - Prevents tunnel vision by forcing scope sanity checks before hypothesis development
  - Requires evaluation of 2-3 alternative investigation scopes
  - Catches the #1 cause of wrong conclusions: looking in wrong place or too narrowly
  - Positioned strategically after Phase 1 analysis and before Phase 2 hypothesis formation

### Enhanced
- **Phase 3 (Instrumentation)**: Dramatically expanded with concrete, step-by-step instructions
  - Language-specific code examples (JavaScript/TypeScript, Python, Java)
  - Detailed `search_replace` usage examples for applying instrumentation
  - Hypothesis-specific prefixes ([H1], [H2], [H3]) with standard formatting
  - File-by-file workflow: read → locate → instrument → verify
  - Fallback strategy if edit tools unavailable
  - Instrumentation checklist for tracking progress
  
- **Phase 4 (Evidence Collection)**: Comprehensive decision tree and 7-step process
  - **OPTION A**: Agent can execute code → 4-step execution workflow
  - **OPTION B**: Agent cannot execute → User instruction template
  - Clear instructions on when to use each approach
  - Log consolidation and evidence organization by hypothesis
  - Evidence quality assessment (1-10 scale)

- **metaGuidance**: Added explicit high auto mode discipline
  - Clarified that agents should not ask for permission between phases in high auto mode
  - Exception: Phase 0e early termination and Phase 4a controlled experiments
  - Reinforced that asking "should I continue?" implies investigation is optional (it is NOT)

### Changed
- Total workflow steps: 26 steps (added Phase 1f)
- Phase 1 analysis loop: Now clearly labeled as "Analysis 1/5" through "Analysis 5/5"

## [1.1.0-beta.5] - 2025-01-06

### Changed
- **Phase 0e Relocation**: Moved early termination checkpoint from Phase 5b to Phase 0e (after triage)
  - Now appears immediately after setup, before any investigation work begins
  - Eliminates sunk cost fallacy (decision at 5% vs 90% completion)
  - Forces upfront decision-making about workflow commitment
  
### Added
- **Mandatory User Communication**: Phase 0e now requires agents to explicitly tell users about 90% accuracy difference
  - Template message is NOT optional - agents MUST communicate this
  - User must explicitly confirm proceeding with full investigation
  
### Removed
- **Phase 5b**: Removed old completion checkpoint (now Phase 0e)
  - Total workflow steps reduced from 28 to 26

## [1.1.0-beta.4] - 2025-01-05

### Enhanced
- **Sophisticated Code Analysis**: Integrated advanced analysis techniques from MR review workflow into Phase 1
  
### Added
- **New Phase 1a**: Neighborhood, Call Graph & Contracts analysis
  - Module root computation (nearest common ancestor, clamped to package boundary)
  - Neighborhood mapping (immediate neighbors, imports, tests, entry points)
  - Bounded call graph with HOT path ranking (Small Multiples ASCII visualization)
  - Flow anchors (entry points to bug: HTTP routes, CLI commands, scheduled jobs, event handlers)
  - Contracts & invariants discovery (API symbols, endpoints, database tables, stated guarantees)
  
- **Enhanced Phase 1 Structure**: Now 5 sub-phases (was 4)
  1. Neighborhood, Call Graph & Contracts (NEW)
  2. Breadth Scan (pattern discovery)
  3. Deep Dive (suspicious code analysis)
  4. Dependencies & Data Flow
  5. Test Coverage Analysis
  
### Changed
- Total workflow steps increased from 27 to 28 (added Phase 1a)
- Phase 1 loop now iterates 5 times (was 4)
- Each analysis phase now produces more structured, evidence-based outputs

## [1.1.0-beta.3] - 2025-01-05

### Fixed
- **Critical**: Prevented ALL phase skipping, not just final documentation phase
  - Root cause: Agents didn't understand they MUST repeatedly call workflow_next
  - Added mandatory workflow execution instructions to metaGuidance
  - Added early commitment checkpoint (Phase 0e) requiring user confirmation
  - Reinforced evidence-based persuasion: 90% error rate for premature conclusions

### Added
- **Phase 0e**: Workflow Execution Commitment checkpoint
  - Appears immediately after triage (before investigation begins)
  - Requires agent acknowledgment of workflow structure (26 steps)
  - Requires user confirmation to proceed with full investigation
  - Explicit warning: stopping early leads to wrong conclusions ~90% of time
  
### Enhanced
- **metaGuidance**: Added comprehensive workflow execution discipline
  - Agents MUST call workflow_next until isComplete=true
  - High confidence (9-10/10) does NOT mean workflow is complete
  - Professional research shows 90% error rate for jumping to conclusions
  - Added "WHY THIS STRUCTURE EXISTS (Evidence-Based)" section

## [1.1.0-beta.2] - 2025-01-05

### Added
- **Phase 5b**: Mandatory completion checkpoint with user confirmation
  - Prevents agents from skipping comprehensive diagnostic writeup (Phase 6)
  - Requires explicit acknowledgment that Phase 6 is the required deliverable
  - User must confirm proceeding to final documentation phase

### Enhanced
- **metaGuidance**: Added critical workflow discipline instructions
  - Emphasized that high confidence does NOT equal completion
  - Clarified that Phase 6 is a mandatory deliverable, not optional
  - Added explicit instructions on when to set `isWorkflowComplete=true`

## [1.1.0-beta.1] - 2025-01-05

### Fixed
- **Critical**: Prevented premature workflow completion
  - Agents were jumping to conclusions and skipping phases with high confidence
  - Root cause: Misinterpreting progress/confidence as final completion

### Added
- **metaGuidance Section**: "CRITICAL WORKFLOW DISCIPLINE"
  - High confidence (9-10/10) does NOT mean completion
  - Agent MUST complete all phases (0-6) regardless of confidence
  - Only set `isWorkflowComplete=true` after Phase 6 comprehensive writeup
  
- **Phase-Specific Warnings**:
  - Phase 2a (Hypothesis Formation): Warning against treating hypothesis as conclusion
  - Phase 5a (Confidence Assessment): Warning that 10/10 confidence still requires Phase 6

### Enhanced
- **Phase 6 Instructions**: Explicit completion marking
  - Must set `isWorkflowComplete=true` in this phase
  - Must produce comprehensive diagnostic writeup
  - This is the ONLY phase that marks workflow as truly complete

### Changed
- All phase prompts updated to reference 27 total workflow steps for clarity
