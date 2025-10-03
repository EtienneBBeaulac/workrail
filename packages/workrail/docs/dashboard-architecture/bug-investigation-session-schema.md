# Bug Investigation Session Schema

## Overview

This document defines the complete data structure for bug investigation sessions. Agents should use this as a reference when updating session data.

## Quick Reference

**Read the schema**:
```javascript
workrail_read_session(workflowId, sessionId, "$schema")
```

**Common updates**:
```javascript
// Update progress and current phase
workrail_update_session(workflowId, sessionId, {
  "dashboard.progress": 25,
  "dashboard.currentPhase": "Phase 1",
  "dashboard.currentStep": "Breadth Scan Complete"
});

// Add a timeline event
const timeline = await workrail_read_session(workflowId, sessionId, "timeline");
timeline.push({ timestamp: new Date().toISOString(), phase: "1", event: "Analysis complete", type: "phase_complete" });
workrail_update_session(workflowId, sessionId, { timeline });

// Update hypothesis
workrail_update_session(workflowId, sessionId, {
  "hypotheses[0].status": "confirmed",
  "hypotheses[0].evidence": [...newEvidence]
});
```

## Complete Schema

```typescript
{
  // ============================================
  // DASHBOARD (Real-time UI Display)
  // ============================================
  dashboard: {
    ticketId: string,              // Bug ticket ID
    title: string,                 // Short bug description (max 100 chars)
    status: "in_progress" | "complete" | "blocked",
    progress: number,              // 0-100 percentage
    confidence: number,            // 0-10 scale
    currentPhase: string,          // e.g., "Phase 1", "Phase 2b", "1.2"
    currentStep: string,           // Human-readable current step
    startedAt: string,             // ISO timestamp
    completedAt?: string,          // ISO timestamp (when complete)
    topSuspects?: string[],        // Top 5 suspicious components
    hypothesisCount?: number       // Total hypotheses generated
  },

  // ============================================
  // BUG SUMMARY (Initial Context)
  // ============================================
  bugSummary: {
    title: string,                 // Bug title
    ticketId: string,              // Ticket ID
    description: string,           // Full bug description
    impact: "Critical" | "High" | "Medium" | "Low",
    frequency: string,             // e.g., "Always", "Intermittent", "Rare"
    environment: string,           // e.g., "Production", "Staging", "Dev"
    reproductionSteps: string | string[]  // How to reproduce
  },

  // ============================================
  // PHASES (Detailed Phase Progress)
  // ============================================
  phases: {
    "phase-0": {
      complete: boolean,
      summary: string,             // Brief summary of phase outcome
      findings?: any               // Phase-specific findings
    },
    "phase-1": {
      complete: boolean,
      summary: string,
      subsections?: Array<{
        id: string,                // e.g., "1.1", "1.2"
        title: string,             // e.g., "Breadth Scan"
        suspiciousComponents: Array<{
          name: string,            // Component/file name
          likelihood: number,      // 1-10
          reasoning: string,
          evidence: string[]
        }>,
        keyFindings: string[]
      }>,
      topSuspects?: Array<{        // Aggregated from subsections
        name: string,
        averageLikelihood: number,
        appearances: number,
        consolidatedReasoning: string
      }>
    },
    "phase-2": {
      complete: boolean,
      summary: string,
      hypothesesGenerated: number,
      instrumentationPlan?: {
        approach: string,
        logPoints: Array<{
          file: string,
          line: number,
          purpose: string,
          data: string[]
        }>
      }
    },
    // ... additional phases as needed
  },

  // ============================================
  // HYPOTHESES (Investigation Theories)
  // ============================================
  hypotheses: Array<{
    id: string,                    // e.g., "h1", "h2"
    title: string,                 // Short hypothesis title
    description: string,           // Detailed explanation
    likelihood: number,            // 1-10 initial assessment
    status: "pending" | "testing" | "confirmed" | "rejected",
    evidenceStrengthScore: number, // 1-10
    testabilityScore: number,      // 1-10
    impactScope: number,           // 1-10
    reasoning: string,             // Why this hypothesis makes sense
    evidence?: string[],           // Supporting evidence
    logs?: string[],               // Relevant log excerpts
    conclusion?: string,           // Final determination (when status changes)
    rejectionReason?: string       // Why rejected (if applicable)
  }>,

  // ============================================
  // RULED OUT (Rejected Hypotheses)
  // ============================================
  ruledOut: Array<{
    id: string,                    // Original hypothesis ID
    title: string,
    reason: string,                // Why it was ruled out
    evidence: string[],            // Counter-evidence
    timestamp: string              // When it was ruled out
  }>,

  // ============================================
  // TIMELINE (Event Log)
  // ============================================
  timeline: Array<{
    timestamp: string,             // ISO timestamp
    phase: string,                 // e.g., "0", "1", "2"
    event: string,                 // Human-readable event
    type: "phase_start" | "phase_complete" | "hypothesis" | "evidence" | "milestone" | "note"
  }>,

  // ============================================
  // CONFIDENCE JOURNEY (Confidence Over Time)
  // ============================================
  confidenceJourney: Array<{
    phase: string,                 // Phase when confidence changed
    confidence: number,            // 0-10 scale
    timestamp: string,             // ISO timestamp
    reasoning: string              // Why confidence changed
  }>,

  // ============================================
  // CODEBASE MAP (Spatial Understanding)
  // ============================================
  codebaseMap?: {
    components: Array<{
      name: string,                // Component/file name
      path: string,                // Full file path
      role: string,                // Component's role in system
      relationships: string[],     // Related components
      suspiciousScore: number      // 1-10
    }>,
    dataFlow?: Array<{
      from: string,
      to: string,
      dataType: string,
      transformations?: string[]
    }>
  },

  // ============================================
  // ROOT CAUSE (Final Diagnosis)
  // ============================================
  rootCause?: {
    component: string,             // Primary component
    file: string,                  // File path
    lineNumbers?: string,          // e.g., "42-45"
    category: string,              // e.g., "Logic Error", "Race Condition"
    explanation: string,           // Detailed explanation
    evidence: string[]             // Supporting evidence
  },

  // ============================================
  // FIX (Proposed Solution)
  // ============================================
  fix?: {
    approach: string,              // Fix strategy
    files: string[],               // Files to modify
    estimatedComplexity: "Simple" | "Moderate" | "Complex",
    riskAssessment: string,        // Potential risks
    testingStrategy: string,       // How to verify fix
    implementation: string         // Detailed implementation steps
  },

  // ============================================
  // RECOMMENDATIONS (Future Prevention)
  // ============================================
  recommendations?: {
    immediate: string[],           // Immediate actions
    shortTerm: string[],           // Near-term improvements
    longTerm: string[],            // Architectural improvements
    monitoring: string[]           // Monitoring enhancements
  },

  // ============================================
  // METADATA (Technical Details)
  // ============================================
  metadata: {
    workflowVersion: string,       // Workflow version used
    projectType: string,           // e.g., "node", "python"
    bugComplexity: string,         // "Simple", "Standard", "Complex"
    automationLevel: string        // "High", "Medium", "Low"
  }
}
```

## Update Patterns

### Pattern 1: Incremental Progress Updates
```javascript
// Update progress as you work through phases
workrail_update_session(workflowId, sessionId, {
  "dashboard.progress": 35,
  "dashboard.currentPhase": "Phase 2",
  "dashboard.currentStep": "Generating hypotheses"
});
```

### Pattern 2: Adding Timeline Events
```javascript
// Always append to timeline, never replace
const timeline = await workrail_read_session(workflowId, sessionId, "timeline") || [];
timeline.push({
  timestamp: new Date().toISOString(),
  phase: "2",
  event: "Generated 3 hypotheses",
  type: "milestone"
});
workrail_update_session(workflowId, sessionId, { timeline });
```

### Pattern 3: Updating Confidence
```javascript
// Update both dashboard and journey
const journey = await workrail_read_session(workflowId, sessionId, "confidenceJourney") || [];
journey.push({
  phase: "4",
  confidence: 8.5,
  timestamp: new Date().toISOString(),
  reasoning: "Strong evidence from logs confirms hypothesis h1"
});
workrail_update_session(workflowId, sessionId, {
  "dashboard.confidence": 8.5,
  confidenceJourney: journey
});
```

### Pattern 4: Completing a Phase
```javascript
workrail_update_session(workflowId, sessionId, {
  "phases.phase-1.complete": true,
  "phases.phase-1.summary": "Analysis identified 5 suspicious components",
  "dashboard.progress": 40,
  "dashboard.currentPhase": "Phase 2",
  timeline: [...existingTimeline, {
    timestamp: new Date().toISOString(),
    phase: "1",
    event: "Phase 1 complete",
    type: "phase_complete"
  }]
});
```

## Best Practices

1. **Read Before Write**: Always read existing arrays before appending
2. **Atomic Updates**: Group related updates in a single call
3. **Timestamp Everything**: Use `new Date().toISOString()` for consistency
4. **Progress Accuracy**: Update progress to reflect actual completion (0-100)
5. **Timeline Clarity**: Make events human-readable and specific
6. **Confidence Justification**: Always explain confidence changes
7. **Hypothesis Tracking**: Keep status current (pending → testing → confirmed/rejected)

## Special Paths

- `$schema`: Returns this schema structure
- `dashboard`: Get all dashboard fields
- `timeline`: Get all timeline events
- `hypotheses[0]`: Get first hypothesis
- `phases.phase-1`: Get Phase 1 data

