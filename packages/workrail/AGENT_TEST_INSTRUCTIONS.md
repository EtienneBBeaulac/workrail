# 🧪 Bug Investigation Workflow - Agent Test Instructions

**Test Date:** October 2, 2025  
**Workflow:** `systematic-bug-investigation-with-loops`  
**Expected Duration:** 20-30 minutes  
**Goal:** Validate end-to-end bug investigation with real-time dashboard

---

## 📋 **Test Scenario**

You are investigating a bug in the Workrail system. Use this mock bug report:

**Bug Report:**
```
Title: Session data not updating in real-time on dashboard
Ticket ID: DASH-001
Description: Users report that the bug investigation dashboard shows stale data. 
             The "Last updated" timestamp changes every 3 seconds, but the actual 
             progress, confidence, and phase information remains unchanged for 
             minutes at a time. Refreshing the page shows correct data.
Impact: Medium
Frequency: Occurs ~30% of the time
Environment: Production, started 2 days ago after v0.6.1 deployment
Reproduction: 
  1. Start bug investigation workflow
  2. Open dashboard at http://localhost:3456
  3. Observe progress updates
  4. ~30% of the time, progress freezes despite timestamp updating
```

---

## 🎯 **Your Mission**

Execute the `systematic-bug-investigation-with-loops` workflow to investigate this bug. The system will:

1. **Create a real-time dashboard** that you (and the human user) can monitor
2. **Write all findings to a session** (not just to chat)
3. **Update progress in real-time** as you work through phases
4. **Track confidence, hypotheses, and timeline** automatically

---

## 🚀 **Step-by-Step Instructions**

### **Phase 0: Session Initialization**

**What You Should Do:**

1. **Start by acknowledging the bug report** and confirming you'll investigate it
2. **The workflow will automatically:**
   - Create an investigation session with ID `DASH-001`
   - Initialize session data in `~/.workrail/sessions/`
   - Open the dashboard in the user's browser
   - Set initial progress to 10%, confidence to 0

**Expected Output:**
```
Investigation session created! 🎉

You can monitor progress in real-time at:
http://localhost:3456?session=DASH-001

The dashboard will update automatically as I work through the investigation.
```

**✅ Verification:**
- [ ] Dashboard opens automatically
- [ ] Session card shows "DASH-001"
- [ ] Progress shows 10%
- [ ] Confidence shows 0/10

---

### **Phase 1: Multi-Dimensional Analysis (Progress: 10% → 35%)**

**What You Should Do:**

Perform **4 types of analysis** (the workflow will guide you):

1. **Breadth Scan (Progress: 15% → 20%)**
   - Search for all files related to dashboard data loading
   - Use `grep`, `codebase_search` to find relevant components
   - Identify suspicious areas

2. **Component Deep Dive (Progress: 22% → 25%)**
   - Analyze `SessionManager.ts`, `HttpServer.ts`, `dashboard.js`
   - Look for cache issues, stale data, polling problems
   - Examine the 3-second polling logic

3. **Dependencies & Flow (Progress: 28% → 30%)**
   - Trace data flow: Session JSON → HTTP API → Dashboard JS
   - Check for race conditions, timing issues
   - Map the update cycle

4. **Test Coverage (Progress: 32% → 35%)**
   - Look for tests covering dashboard updates
   - Check for tests on SessionManager, HTTP API
   - Identify testing gaps

**Expected Session Updates:**
- After each subsection, **write findings to session**:
  ```javascript
  workrail_update_session(workflowId, sessionId, {
    'phases.phase-1.subsections': [...subsections],
    'dashboard.progress': 20, // Update after each step
    'dashboard.topSuspects': [top 5 component names],
    'dashboard.confidence': 3.5 // After all 4 analyses
  });
  ```

**✅ Verification:**
- [ ] Dashboard shows progress increasing (15% → 35%)
- [ ] Phase 1 marked as complete (green checkmark)
- [ ] Top 5 suspects appear in left sidebar
- [ ] Confidence increases to 3.5/10
- [ ] Timeline shows "Phase 1 complete" event

---

### **Phase 2: Hypothesis Generation (Progress: 35% → 48%)**

**What You Should Do:**

1. **Generate 3-5 hypotheses** based on Phase 1 analysis

   Example hypotheses:
   - H1: "ETag caching prevents browser from receiving updates"
   - H2: "Race condition in session read/write causes stale data"
   - H3: "JSON serialization doesn't update timestamps properly"

2. **For each hypothesis:**
   - Assign likelihood score (1-10)
   - Document evidence from Phase 1
   - Create test strategy

3. **Write hypotheses to session:**
   ```javascript
   const hypotheses = [
     {
       id: "h1",
       title: "ETag caching issue",
       description: "...",
       likelihood: 9,
       status: "pending",
       basedOn: ["Phase 1.2: HTTP server analysis"],
       testStrategy: "Instrument HTTP responses, check ETag headers"
     },
     // ... h2, h3
   ];
   
   workrail_update_session(workflowId, sessionId, {
     hypotheses: hypotheses,
     'dashboard.progress': 45,
     'dashboard.hypothesisCount': 3,
     'dashboard.confidence': 6.0
   });
   ```

**✅ Verification:**
- [ ] Dashboard shows progress 48%
- [ ] 3-5 hypothesis cards appear in right sidebar
- [ ] Each hypothesis shows likelihood score
- [ ] Confidence increases to 6.0/10
- [ ] Timeline shows "Hypothesis created" events

---

### **Phase 3: Instrumentation (Progress: 48% → 62%)**

**What You Should Do:**

1. **Plan instrumentation** (Phase 2g):
   - Identify where to add logging for each hypothesis
   - Plan log format: `[H1] Component.method:line | data`
   - Document instrumentation locations

2. **Implement instrumentation** (Phase 3):
   - Add logging to relevant files (or describe where you would add it)
   - Use hypothesis-specific prefixes ([H1], [H2], [H3])

3. **Update session:**
   ```javascript
   workrail_update_session(workflowId, sessionId, {
     'phases.phase-3': {
       complete: true,
       summary: 'Instrumentation implemented for all hypotheses'
     },
     'dashboard.progress': 62
   });
   ```

**✅ Verification:**
- [ ] Dashboard shows progress 62%
- [ ] Phase 2g and Phase 3 marked complete
- [ ] Timeline shows "Instrumentation complete" event

---

### **Phase 4: Evidence Collection (Progress: 62% → 70%)**

**What You Should Do:**

1. **Describe running the reproduction** with instrumentation active
2. **Collect "mock evidence"** (since this is a test):
   - For H1: "Logs show ETag header unchanged for 5 minutes"
   - For H2: "Concurrent reads detected at timestamps X, Y"
   - For H3: "JSON output shows identical timestamps"

3. **Update each hypothesis with evidence:**
   ```javascript
   const hypotheses = await workrail_read_session(workflowId, sessionId, 'hypotheses');
   
   const updated = hypotheses.map(h => {
     if (h.id === 'h1') {
       return {
         ...h,
         evidence: [
           {
             description: "ETag header 'W/abc123' unchanged for 5 minutes",
             strength: "high",
             source: "HTTP server logs: line 156",
             timestamp: new Date().toISOString()
           }
         ]
       };
     }
     return h;
   });
   
   workrail_update_session(workflowId, sessionId, {
     hypotheses: updated,
     'dashboard.progress': 70
   });
   ```

**✅ Verification:**
- [ ] Dashboard shows progress 70%
- [ ] Hypothesis cards show evidence items
- [ ] Evidence has strength indicators (high/medium/low)
- [ ] Timeline shows "Evidence collected" event

---

### **Phase 5: Hypothesis Analysis (Progress: 70% → 90%)**

**What You Should Do:**

For each hypothesis, analyze the evidence:

1. **H1 Analysis:**
   - Review evidence collected
   - Determine: Confirmed, Rejected, or Partial
   - Update confidence score

2. **Example: Confirm H1, Reject H2:**
   ```javascript
   const hypotheses = await workrail_read_session(workflowId, sessionId, 'hypotheses');
   const ruledOut = await workrail_read_session(workflowId, sessionId, 'ruledOut') || [];
   
   const updated = hypotheses.map(h => {
     if (h.id === 'h1') {
       return { ...h, status: 'confirmed', confidence: 9.5 };
     } else if (h.id === 'h2') {
       return { ...h, status: 'rejected', rejectionReason: 'No concurrent access detected in logs' };
     }
     return h;
   });
   
   // Add rejected to ruledOut
   ruledOut.push({
     item: "Race condition hypothesis",
     reason: "Logs show no concurrent access - sequential reads only",
     timestamp: new Date().toISOString(),
     phase: "5"
   });
   
   workrail_update_session(workflowId, sessionId, {
     hypotheses: updated,
     ruledOut: ruledOut,
     'dashboard.confidence': 9.5,
     'dashboard.progress': 85
   });
   ```

**✅ Verification:**
- [ ] Dashboard shows progress 85-90%
- [ ] Hypothesis cards show updated status (confirmed/rejected)
- [ ] Confidence increases to 8-10/10
- [ ] Ruled Out section shows rejected hypotheses
- [ ] Timeline shows "H1 confirmed" and "H2 rejected" events

---

### **Phase 6: Final Writeup (Progress: 90% → 100%)**

**What You Should Do:**

1. **Read the FULL session data** (only time this is OK):
   ```javascript
   const fullSession = await workrail_read_session(workflowId, sessionId);
   ```

2. **Write comprehensive diagnostic report** (in chat)

3. **Write final results to session:**
   ```javascript
   workrail_update_session(workflowId, sessionId, {
     rootCause: {
       identified: true,
       confidence: 9.5,
       description: "ETag caching prevents browser from receiving updated session data",
       location: "HttpServer.ts:line 57 - 'etag: strong' setting",
       mechanism: "Express.js strong ETags cause 304 Not Modified responses even when data changes",
       whyNowDiscovered: "Added comprehensive instrumentation revealing ETag behavior",
       evidence: [
         "HTTP logs show ETag unchanged for 5+ minutes",
         "Browser receives 304 responses despite data changes",
         "Disabling ETags fixes the issue"
       ]
     },
     fix: {
       approach: "Change from strong ETags to weak ETags OR disable for session API",
       filesAffected: ["src/infrastructure/session/HttpServer.ts"],
       risks: ["Increased bandwidth (minor - JSON is small)", "Potential browser cache issues"],
       testingStrategy: "Add test for API cache headers, verify data always fresh",
       alternatives: [
         "Add cache-control headers to prevent caching",
         "Use timestamp-based cache busting in API calls",
         "Implement WebSocket for real-time updates"
       ]
     },
     recommendations: [
       {
         priority: 10,
         description: "Add integration tests for real-time updates",
         reasoning: "Would have caught this issue before production"
       }
     ],
     'phases.phase-6': {
       complete: true,
       summary: 'Investigation complete. Root cause identified.'
     },
     'dashboard.status': 'complete',
     'dashboard.progress': 100,
     'dashboard.completedAt': new Date().toISOString(),
     timeline: [...existingTimeline, {
       timestamp: new Date().toISOString(),
       phase: '6',
       event: 'Investigation complete - root cause identified with 9.5/10 confidence',
       type: 'investigation_complete'
     }]
   });
   ```

**✅ Verification:**
- [ ] Dashboard shows progress 100%
- [ ] Status changes to "complete"
- [ ] Green "Root Cause" card appears with details
- [ ] Blue "Fix Recommendation" card appears
- [ ] All phases show green checkmarks
- [ ] Timeline shows final "Investigation complete" event
- [ ] Confidence journey chart shows full progression

---

## 🎯 **Critical Success Criteria**

### **Dashboard Must Show:**

1. **Real-time updates** (every 3 seconds)
2. **Progress circle** animating from 0% → 100%
3. **Phase tracker** with checkmarks as phases complete
4. **Top 5 suspects** after Phase 1
5. **3-5 hypotheses** with evidence after Phase 2-4
6. **Confidence chart** showing progression (0 → 3.5 → 6.0 → 9.5)
7. **Timeline** with all major events
8. **Final root cause** in green card
9. **Fix recommendations** in blue card

### **Session Data Must Include:**

- ✅ `dashboard` - All status fields
- ✅ `bugSummary` - Initial bug details
- ✅ `phases` - All phase completion data
- ✅ `hypotheses` - Array with evidence
- ✅ `ruledOut` - Rejected hypotheses
- ✅ `timeline` - All events chronologically
- ✅ `confidenceJourney` - Confidence progression
- ✅ `rootCause` - Final identification
- ✅ `fix` - Recommendations

---

## 🚨 **Important Notes**

### **Session Management:**

1. **Always use targeted reads:**
   ```javascript
   // Good - targeted
   const hypotheses = await workrail_read_session(workflowId, sessionId, 'hypotheses');
   
   // Bad - full read (except in Phase 6)
   const fullSession = await workrail_read_session(workflowId, sessionId);
   ```

2. **Array updates - read, modify, write:**
   ```javascript
   // Read existing array
   const existing = await workrail_read_session(..., 'hypotheses') || [];
   
   // Modify
   const updated = existing.map(h => h.id === 'h1' ? {...h, status: 'confirmed'} : h);
   
   // Write back
   workrail_update_session(..., { hypotheses: updated });
   ```

3. **Update progress frequently:**
   - Every phase transition
   - After major milestones
   - Keep user informed

### **Token Optimization:**

- **Before dashboard:** Would read all context repeatedly (~450K tokens)
- **With dashboard:** Targeted reads only (~18K tokens)
- **Savings:** 96% reduction in token usage!

---

## 📊 **Expected Timeline**

| Phase | Duration | Progress | Confidence |
|-------|----------|----------|------------|
| Phase 0 | 2-3 min | 0% → 10% | 0/10 |
| Phase 1 | 5-8 min | 10% → 35% | 0 → 3.5/10 |
| Phase 2 | 3-5 min | 35% → 48% | 3.5 → 6.0/10 |
| Phase 3 | 2-3 min | 48% → 62% | 6.0/10 |
| Phase 4 | 2-3 min | 62% → 70% | 6.0/10 |
| Phase 5 | 3-5 min | 70% → 90% | 6.0 → 9.5/10 |
| Phase 6 | 3-5 min | 90% → 100% | 9.5/10 |

**Total:** 20-30 minutes

---

## ✅ **Final Checklist**

Before concluding the test, verify:

- [ ] Dashboard showed real-time updates throughout
- [ ] All 6 phases completed (green checkmarks)
- [ ] Progress reached 100%
- [ ] Confidence reached 8-10/10
- [ ] Top suspects appeared after Phase 1
- [ ] Hypotheses displayed with evidence
- [ ] Ruled out section populated
- [ ] Timeline shows all major events
- [ ] Confidence chart shows progression
- [ ] Root cause card appeared (green)
- [ ] Fix card appeared (blue)
- [ ] Session data stored in `~/.workrail/sessions/`
- [ ] No errors in console/logs

---

## 🎉 **Success Criteria**

The test is **successful** if:

1. ✅ Investigation completes with root cause identified
2. ✅ Dashboard updates in real-time throughout
3. ✅ All session data writes correctly
4. ✅ Final confidence >= 8.0/10
5. ✅ User can monitor progress without asking agent
6. ✅ ~96% token savings achieved

---

## 📝 **What to Report**

After completing the test, report:

1. **Did the dashboard update in real-time?** (Yes/No + details)
2. **Were all phases completed?** (List any issues)
3. **Final confidence score:** (X/10)
4. **Token usage:** (Approximate count)
5. **Root cause identified:** (Summary)
6. **Any errors or issues:** (List)
7. **Overall experience:** (Smooth/Minor issues/Major issues)

---

## 🚀 **Ready to Start?**

Begin the investigation by saying:

> "I'll investigate bug DASH-001 using the systematic bug investigation workflow. Starting Phase 0..."

The workflow will guide you through all phases. The dashboard will open automatically and update as you work!

Good luck! 🎯

