# How to Test the Bug Investigation Dashboard

**Quick Guide for Testing with an AI Agent**

---

## 🎯 **What You'll Test**

The complete bug investigation workflow with real-time dashboard:
- Session management
- Real-time updates (3-second polling)
- Progress tracking (0% → 100%)
- Hypothesis management
- Evidence collection
- Root cause identification
- Dashboard visualization

---

## 📋 **Give This to the Agent**

Copy and paste this prompt to an AI agent (Claude, ChatGPT, etc.):

```
I need you to test the Workrail bug investigation workflow. 

Read the file: /Users/etienneb/git/personal/mcp/packages/workrail/AGENT_TEST_INSTRUCTIONS.md

Follow ALL instructions in that file carefully. This is a complete end-to-end test of:
1. The systematic bug investigation workflow
2. Session management with real-time dashboard
3. Progress tracking through 6 phases
4. Hypothesis generation and validation
5. Root cause identification

The test scenario is bug "DASH-001" - a dashboard data staleness issue.

Execute the workflow step-by-step, making ALL required session updates as documented.

Report back on:
- Whether the dashboard updated in real-time
- Any issues encountered
- Final confidence score achieved
- Overall test results
```

---

## 🚀 **Before Testing**

1. **Build the project:**
   ```bash
   cd /Users/etienneb/git/personal/mcp/packages/workrail
   npm run build
   ```

2. **Start the MCP server:**
   ```bash
   node dist/mcp-server.js
   ```

3. **Dashboard will auto-open at:**
   ```
   http://localhost:3456
   ```

---

## 👀 **What to Watch For**

### **In the Dashboard:**
- [ ] Opens automatically when agent starts Phase 0
- [ ] Progress circle animates (0% → 100%)
- [ ] Phase tracker updates with checkmarks
- [ ] Top 5 suspects appear after Phase 1
- [ ] Hypotheses appear with evidence
- [ ] Timeline populates with events
- [ ] Confidence chart shows progression
- [ ] Root cause card appears (green) at end
- [ ] Fix recommendations appear (blue) at end
- [ ] "Last updated" timestamp changes every 3 seconds

### **In the Agent's Output:**
- [ ] Mentions creating session "DASH-001"
- [ ] Shows dashboard URL
- [ ] Provides analysis findings
- [ ] Generates hypotheses
- [ ] Updates session data (you'll see workrail_update_session calls)
- [ ] Identifies root cause
- [ ] Provides fix recommendations

---

## ✅ **Success Looks Like**

1. **Dashboard shows real-time updates** throughout 20-30 minute investigation
2. **All 6 phases complete** (green checkmarks)
3. **Progress reaches 100%**
4. **Confidence reaches 8-10/10**
5. **Root cause identified** with high confidence
6. **Fix recommendations** provided
7. **No errors** in console or agent output

---

## 📊 **Expected Results**

| Metric | Expected Value |
|--------|---------------|
| Duration | 20-30 minutes |
| Final Progress | 100% |
| Final Confidence | 8-10/10 |
| Phases Completed | 6/6 |
| Hypotheses Generated | 3-5 |
| Top Suspects Identified | 5 |
| Root Cause Found | Yes |
| Dashboard Updates | Every 3 seconds |
| Token Usage | ~18,000 (vs 450,000 before) |

---

## 🐛 **If Something Goes Wrong**

### **Dashboard doesn't update:**
- Check browser console for errors
- Verify server is running (should see HTTP requests in logs)
- Check if session file exists: `~/.workrail/sessions/`

### **Agent doesn't use session tools:**
- Verify it's reading the workflow file correctly
- Check that metaGuidance is being followed
- Ensure it's calling `workrail_create_session()` in Phase 0

### **Session data missing:**
- Check `~/.workrail/sessions/` directory
- Verify permissions
- Check server logs for errors

---

## 📁 **Files to Check After Test**

1. **Session Data:**
   ```bash
   cat ~/.workrail/sessions/*/bug-investigation/DASH-001.json | jq '.'
   ```

2. **Server Logs:**
   - HTTP requests should show polling every 3 seconds
   - Session read/write operations

3. **Dashboard:**
   - Should show complete investigation
   - All data should be accurate

---

## 🎉 **What Success Proves**

If the test succeeds, it proves:

✅ **Workflow Integration Works** - All 6 phases write to session  
✅ **Session Management Works** - Data persists and updates correctly  
✅ **HTTP Server Works** - Serves dashboard and API correctly  
✅ **Real-Time Updates Work** - Dashboard polls and updates  
✅ **Token Optimization Works** - ~96% reduction achieved  
✅ **Dashboard UI Works** - All visualizations display correctly  
✅ **End-to-End System Works** - Ready for production!

---

## 📝 **After Testing**

Document:
1. ✅ Test passed/failed
2. ✅ Any issues encountered
3. ✅ Performance observations
4. ✅ Suggestions for improvement

---

**Ready to test?** Give the agent the prompt above and watch the magic happen! ✨

