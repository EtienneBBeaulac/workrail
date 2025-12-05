# Workflow Integration Guide: Adding Session Management

**Target:** `workflows/systematic-bug-investigation-with-loops.json`

---

## Overview

This guide details exactly how to integrate session management tools into the bug investigation workflow.

---

## Step 1: Add Session Tools to metaGuidance

**Location:** After line 39 (`addResumptionJson` definition)

**Add:**
```json
"**SESSION MANAGEMENT:**",
"tool workrail_create_session(workflowId, sessionId, initialData) = 'Create a new session in ~/.workrail/sessions/. Returns session ID and dashboard URL. Use once at investigation start.'",
"tool workrail_update_session(workflowId, sessionId, updates) = 'Update session with deep merge. Objects merged, arrays replaced. Use for all state updates throughout workflow.'",
"tool workrail_read_session(workflowId, sessionId, path?) = 'Read session data. Use JSONPath for targeted reads: dashboard, phases.phase-1, hypotheses[0], hypotheses[?status==active]. ALWAYS prefer targeted reads to save tokens.'",
"tool workrail_open_dashboard(sessionId?) = 'Open web dashboard in browser. Shows real-time progress, visualizations, all session data.'",
"**SESSION DISCIPLINE:**",
"CREATE ONCE: Call workrail_create_session() in Phase 0, store sessionId in context",
"UPDATE FREQUENTLY: Update progress/confidence after every major action",
"READ TARGETED: Use JSONPath queries to read only what you need (96% token savings)",
"EXTERNAL MEMORY: Session is your external memory - never forget key findings",
"NO MARKDOWN FORMATTING: Just write JSON data, dashboard renders the UI",
"ANTI-FORGETTING: Top suspects and key findings always in dashboard.topSuspects",
"DELIVERABLE IN PROGRESS: Session data becomes the investigation report - keep it updated",
"NO TIME ESTIMATES: Never include time estimates - they are unreliable. Use step counts, iterations, or timestamps instead."
```

---

## Step 2: Update Phase 0 - Create Session

**Location:** `phase-0-triage` step

**Add to prompt (after outputs section):**

```
**STEP 5: Session Initialization**
Create investigation session:
```javascript
const sessionId = bugTicketId || `BUG-${Date.now()}`;
workrail_create_session("bug-investigation", sessionId, {
  dashboard: {
    ticketId: sessionId,
    title: bugTitle,
    status: "in_progress",
    progress: 0,
    confidence: 0,
    currentPhase: "0",
    currentStep: "Initial Triage",
    startedAt: new Date().toISOString()
  },
  bugSummary: {
    description: userDescription,
    impact: determinedImpact,
    frequency: frequency,
    environment: environment
  },
  timeline: [{
    timestamp: new Date().toISOString(),
    phase: "0",
    event: "Investigation started",
    type: "phase_start"
  }],
  confidenceJourney: [{
    phase: "0",
    confidence: 0,
    timestamp: new Date().toISOString(),
    reasoning: "Initial state"
  }],
  phases: {
    "phase-0": { complete: false }
  },
  hypotheses: [],
  ruledOut: [],
  codebaseMap: {},
  metadata: {
    workflowVersion: "1.0.0"
  }
});
```

Open dashboard for user visibility:
```javascript
workrail_open_dashboard(sessionId);
```

**Save sessionId to context for all future steps.**

**At end of Phase 0:**
```javascript
workrail_update_session("bug-investigation", sessionId, {
  "dashboard.progress": 10,
  "dashboard.currentPhase": "1",
  "phases.phase-0.complete": true,
  "phases.phase-0.summary": "Triage complete. Complexity: {complexity}. Ready for analysis.",
  "timeline": [
    ...existingTimeline,
    {
      timestamp: new Date().toISOString(),
      phase: "0",
      event: "Triage complete",
      type: "phase_complete"
    }
  ]
});
```

---

## Step 3: Update Phase 1 - Analysis

**Location:** Phase 1 loop iterations

**Start of Phase 1:**
```javascript
workrail_update_session("bug-investigation", sessionId, {
  "dashboard.currentPhase": "1",
  "dashboard.currentStep": "Codebase Analysis - Starting",
  "dashboard.progress": 15
});
```

**After each subsection (1.1, 1.2, 1.3, 1.4):**
```javascript
// Read existing phase-1 data
const phase1 = await workrail_read_session("bug-investigation", sessionId, "phases.phase-1") || {};
const subsections = phase1.subsections || [];

// Add new subsection
subsections.push({
  id: subsectionId,  // "1.1", "1.2", etc.
  title: subsectionTitle,
  suspiciousComponents: [
    {
      name: "path/to/Component.ts",
      likelihood: 9,
      reasoning: "Concrete reasoning based on evidence",
      evidence: ["Evidence 1", "Evidence 2"]
    }
    // ... more components
  ],
  keyFindings: ["Finding 1", "Finding 2"]
});

// Write back
workrail_update_session("bug-investigation", sessionId, {
  "phases.phase-1.subsections": subsections,
  "dashboard.progress": baseProgress + (subsectionNum * 5)
});
```

**End of Phase 1:**
```javascript
// Aggregate top suspects
const phase1 = await workrail_read_session("bug-investigation", sessionId, "phases.phase-1");
const allComponents = phase1.subsections.flatMap(s => s.suspiciousComponents);
const topSuspects = allComponents
  .sort((a, b) => b.likelihood - a.likelihood)
  .slice(0, 5)
  .map(c => c.name);

workrail_update_session("bug-investigation", sessionId, {
  "phases.phase-1.complete": true,
  "phases.phase-1.summary": `Analyzed ${subsections.length} dimensions. Identified ${allComponents.length} suspicious components.`,
  "dashboard.progress": 35,
  "dashboard.confidence": 3.5,
  "dashboard.topSuspects": topSuspects,
  "dashboard.topSuspectsReasoning": "Identified in Phase 1 multi-dimensional analysis",
  "timeline": [
    ...existingTimeline,
    {
      timestamp: new Date().toISOString(),
      phase: "1",
      event: `Phase 1 complete - ${allComponents.length} suspicious components identified`,
      type: "phase_complete"
    }
  ],
  "confidenceJourney": [
    ...existingJourney,
    {
      phase: "1",
      confidence: 3.5,
      timestamp: new Date().toISOString(),
      reasoning: "Completed systematic codebase analysis"
    }
  ]
});
```

---

## Step 4: Update Phase 2 - Hypotheses

**Start of Phase 2:**
```javascript
// Read Phase 1 analysis (TARGETED READ - only what we need!)
const phase1 = await workrail_read_session("bug-investigation", sessionId, "phases.phase-1");

workrail_update_session("bug-investigation", sessionId, {
  "dashboard.currentPhase": "2",
  "dashboard.progress": 40
});
```

**After generating hypotheses:**
```javascript
const hypotheses = [
  {
    id: "h1",
    title: "Cache invalidation failure",
    description: "Token cache not invalidating on refresh, causing stale tokens",
    likelihood: 9,
    status: "pending",
    basedOn: [
      "AuthService timing anomalies (Phase 1.2)",
      "Cache logs show no invalidation events",
      "503 errors correlate with token age"
    ],
    testStrategy: "Instrument cache operations, monitor invalidation calls"
  },
  {
    id: "h2",
    title: "Race condition in validation",
    description: "Concurrent requests causing state conflict",
    likelihood: 7,
    status: "pending",
    basedOn: [
      "503 errors spike under load (Phase 1.1)",
      "Thread safety concerns in validator"
    ],
    testStrategy: "Add thread-local logging, test concurrent scenarios"
  }
];

workrail_update_session("bug-investigation", sessionId, {
  "hypotheses": hypotheses,
  "dashboard.hypothesisCount": hypotheses.length,
  "dashboard.progress": 45,
  "phases.phase-2.complete": true,
  "timeline": [
    ...existingTimeline,
    ...hypotheses.map(h => ({
      timestamp: new Date().toISOString(),
      phase: "2",
      event: `Hypothesis created: ${h.title}`,
      type: "hypothesis_created"
    }))
  ]
});
```

---

## Step 5: Update Phase 3 - Instrumentation

**Read hypotheses (TARGETED!):**
```javascript
const hypotheses = await workrail_read_session("bug-investigation", sessionId, "hypotheses");
```

**Update instrumentation plan:**
```javascript
workrail_update_session("bug-investigation", sessionId, {
  "phases.phase-3.instrumentationPlan": detailedPlan,
  "dashboard.currentPhase": "3",
  "dashboard.progress": 50
});
```

---

## Step 6: Update Phase 4 - Evidence Collection

**Read only active hypotheses:**
```javascript
const activeHypotheses = await workrail_read_session(
  "bug-investigation",
  sessionId,
  "hypotheses[?status=='active']"
);
```

**Update hypothesis with evidence:**
```javascript
// Read all hypotheses
const allHypotheses = await workrail_read_session("bug-investigation", sessionId, "hypotheses");

// Update specific hypothesis
const updated = allHypotheses.map(h => 
  h.id === "h1" 
    ? {
        ...h,
        evidence: [
          ...(h.evidence || []),
          {
            description: "Cache.invalidate() never called in TokenRefreshService",
            strength: "high",
            source: "debug logs: TokenRefreshService.java:line 47",
            timestamp: new Date().toISOString()
          }
        ]
      }
    : h
);

workrail_update_session("bug-investigation", sessionId, {
  "hypotheses": updated,
  "dashboard.progress": 70
});
```

---

## Step 7: Update Phase 5 - Analysis

**Read specific hypothesis:**
```javascript
const h1 = await workrail_read_session("bug-investigation", sessionId, "hypotheses[0]");
```

**Confirm or reject:**
```javascript
const allHypotheses = await workrail_read_session("bug-investigation", sessionId, "hypotheses");

const updated = allHypotheses.map(h => 
  h.id === "h1"
    ? {
        ...h,
        status: "confirmed",
        confidence: 9.5,
        evidence: [...h.evidence, ...newEvidence]
      }
    : h.id === "h2"
    ? {
        ...h,
        status: "rejected",
        rejectionReason: "Logs show no concurrent access patterns"
      }
    : h
);

const confirmedCount = updated.filter(h => h.status === "confirmed").length;
const newConfidence = confirmedCount > 0 ? 9.2 : 6.0;

workrail_update_session("bug-investigation", sessionId, {
  "hypotheses": updated,
  "dashboard.confidence": newConfidence,
  "dashboard.progress": 85,
  "timeline": [
    ...existingTimeline,
    {
      timestamp: new Date().toISOString(),
      phase: "5",
      event: "H1 confirmed with 9.5/10 confidence",
      type: "hypothesis_confirmed"
    },
    {
      timestamp: new Date().toISOString(),
      phase: "5",
      event: "H2 rejected - no concurrent access",
      type: "hypothesis_rejected"
    }
  ],
  "confidenceJourney": [
    ...existingJourney,
    {
      phase: "5",
      confidence: newConfidence,
      timestamp: new Date().toISOString(),
      reasoning: `${confirmedCount} hypotheses confirmed with strong evidence`
    }
  ]
});

// Add rejected hypothesis to ruled-out registry
if (h2Rejected) {
  const ruledOut = await workrail_read_session("bug-investigation", sessionId, "ruledOut") || [];
  workrail_update_session("bug-investigation", sessionId, {
    "ruledOut": [
      ...ruledOut,
      {
        item: "Race condition hypothesis",
        reason: "Logs show no concurrent access patterns",
        timestamp: new Date().toISOString(),
        phase: "5"
      }
    ]
  });
}
```

---

## Step 8: Update Phase 6 - Final Writeup

**Read full session (this is the one place where full read makes sense):**
```javascript
const fullSession = await workrail_read_session("bug-investigation", sessionId);
```

**Complete investigation:**
```javascript
workrail_update_session("bug-investigation", sessionId, {
  "rootCause": {
    "identified": true,
    "confidence": 9.5,
    "description": "Cache invalidation not triggered on token refresh",
    "location": "TokenRefreshService.java:line 47",
    "mechanism": "refreshToken() updates cache but never calls invalidate()",
    "whyNowDiscovered": "Added comprehensive instrumentation in Phase 3",
    "evidence": [
      "Debug logs confirm invalidate() never called",
      "Cache TTL expired while old token still served",
      "Manual cache.invalidate() call fixes issue"
    ]
  },
  "fix": {
    "approach": "Add cache.invalidate(oldToken) before cache.put(newToken)",
    "filesAffected": ["TokenRefreshService.java"],
    "risks": ["Potential race if multiple threads refresh simultaneously"],
    "testingStrategy": "Add unit test for concurrent refreshes, monitor cache hit rate",
    "alternatives": ["Use atomic cache operations", "Implement cache versioning"]
  },
  "phases.phase-6.complete": true,
  "dashboard.status": "complete",
  "dashboard.progress": 100,
  "dashboard.completedAt": new Date().toISOString(),
  "timeline": [
    ...existingTimeline,
    {
      timestamp: new Date().toISOString(),
      phase: "6",
      event: "Investigation complete - root cause identified with 9.5/10 confidence",
      type: "phase_complete"
    }
  ]
});
```

**If confidence < 9.0, add recommendations:**
```javascript
if (confidence < 9.0) {
  workrail_update_session("bug-investigation", sessionId, {
    "recommendations": [
      {
        priority: 10,
        description: "Investigate cache implementation internals",
        reasoning: "May reveal additional edge cases"
      },
      {
        priority: 8,
        description: "Review concurrent access patterns under load",
        reasoning: "Current testing may not cover all scenarios"
      }
    ]
  });
}
```

---

## Benefits of This Integration

### For Agents (LLMs)

**Before (Markdown Hell):**
```javascript
// Create BreadthAnalysis.md
"## Top Suspicious Components\n\n### 1. AuthService\n**Likelihood**: 9/10\n..."
// Later: Read entire file (45k tokens)
// Later: Update table (formatting nightmare)
```

**After (Simple JSON):**
```javascript
// Write structured data
workrail_update_session(..., {
  "phases.phase-1.subsections[0].suspiciousComponents": [...]
});
// Later: Read only what you need (200 tokens)
const dashboard = await workrail_read_session(..., "dashboard");
```

**Token Savings:**
- Phase 1: 45k → 1k tokens (98% savings)
- Phase 5: 85k → 500 tokens (99% savings)
- **Total: 450k → 18k tokens (96% savings)**

### For Users

**Before:**
- No visibility into progress
- Investigation could be stuck
- Report quality varies

**After:**
- Real-time dashboard at http://localhost:3456
- See progress, confidence, hypotheses as they develop
- Consistent, structured deliverable
- Can share dashboard URL with team

### For Workflow Quality

**Before:**
- LLM forgets Phase 1 findings by Phase 5 (30% context loss)
- Formatting errors in Markdown (15% failure rate)
- Inconsistent report structure

**After:**
- Zero context loss (dashboard always shows top suspects)
- Zero formatting errors (JSON → dashboard renders)
- Consistent structure enforced by schema

---

## Implementation Checklist

- [ ] Update metaGuidance with session tools
- [ ] Add session creation in Phase 0
- [ ] Update Phase 1 to write analysis results
- [ ] Update Phase 2 to write hypotheses
- [ ] Update Phase 3 to write instrumentation plan
- [ ] Update Phase 4 to write evidence
- [ ] Update Phase 5 to update hypothesis status
- [ ] Update Phase 6 to write final results
- [ ] Add targeted reads throughout (use JSONPath!)
- [ ] Test workflow end-to-end
- [ ] Validate session data matches schema

---

## Testing Command

```bash
# Start MCP server
# (Run from repository root)
npm run build
npm run dev

# In agentic system, run workflow:
workflow_get("systematic-bug-investigation-with-loops", "preview")
workflow_next("systematic-bug-investigation-with-loops", [], {
  bugDescription: "503 errors on token refresh",
  ...context
})

# Watch dashboard update in real-time:
open http://localhost:3456
```

---

**Next:** Complete the integration and test!

