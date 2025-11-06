# WorkRail Demo - Shot List & Recording Guide

**For Build Together Summit Presentation**

## Demo Overview

**Total Demo Time**: 3:30 minutes (3:25-6:55 in presentation)
**Three Recordings**: Workflow Start (60s) | Hypothesis Testing (90s) | Results (30s)
**Workflow**: Bug Investigation (systematic debugging)
**Recording Quality**: 1080p minimum, high contrast, readable fonts

---

## Pre-Recording Setup

### IDE Configuration

**Font Settings**:
- Minimum size: 18pt (preferably 20-22pt)
- Font: Monospace (Fira Code, JetBrains Mono, or similar)
- Line height: 1.5 for readability

**Theme**:
- High contrast theme (dark or light, but CONSISTENT)
- Recommended: One Dark Pro, GitHub Light, or Monokai Pro
- Ensure terminal/output has same contrast

**Window Size**:
- Record at 1920x1080 (full HD)
- IDE window maximized or near-maximized
- Hide unnecessary panels (keep clean)

**Visible Elements**:
- File tree (left sidebar)
- Main editor pane (center, large)
- Terminal/output (bottom, moderate size)
- Status bar with step counter if possible

**Hidden Elements**:
- Minimap (too small to see in recording)
- Unnecessary extensions popups
- Notifications
- Breadcrumbs (optional - only if large enough)

---

### MCP/Agent Configuration

**Agent**: Claude Desktop, Cursor, or similar
**WorkRail**: Latest version installed and configured
**Workflow**: `systematic-bug-investigation-with-loops.json`

**Test Run**:
- [ ] Run workflow once completely before recording
- [ ] Verify steps appear correctly
- [ ] Check that output is readable
- [ ] Ensure no errors or timeouts
- [ ] Practice the pace

---

### Example Bug Scenario

**Use a REAL or realistic bug** that demonstrates:
1. Non-obvious root cause
2. Multiple possible hypotheses
3. Requires systematic investigation
4. Shows evidence-based conclusion

**Suggested bug scenarios**:
- Race condition in async code
- Memory leak in event listeners
- Cache invalidation timing issue
- State management bug with multiple triggers

**DO NOT use**:
- Syntax errors (too simple)
- Typos (uninteresting)
- Import errors (boring)
- Anything that's "obviously" one thing

---

## Recording 1: Workflow Start & Conditional Logic

**Duration**: 60 seconds (target)
**Timing in Presentation**: 3:25-4:25
**Purpose**: Show workflow initialization and adaptive path selection

### Shot Breakdown

#### Part 1A: Agent Requests Step (0-10 seconds)

**SCREEN SHOWS**:
```
Terminal/Chat window visible
Agent: "Let me start the bug investigation workflow"
> workrail workflow_next "systematic-bug-investigation" []
```

**What to Capture**:
- Clear view of agent making the request
- Workflow ID visible
- Empty completed steps array (starting fresh)

**Recording Notes**:
- Can speed up to 1.5x in editing if slow
- Focus on the REQUEST action

---

#### Part 1B: Workflow Analyzes Context (10-25 seconds)

**SCREEN SHOWS**:
```
Response from WorkRail appears:
{
  "step": {
    "id": "analyze-bug-context",
    "title": "Analyze Bug Context",
    "prompt": "First, let's understand the bug report thoroughly..."
  },
  "guidance": { ... }
}
```

**KEY MOMENT**: Conditional path selection
```
[Workflow analysis]
Bug complexity: High
Error frequency: Intermittent
Codebase familiarity: Moderate

→ Selected path: DEEP_ANALYSIS
```

**What to Capture**:
- Workflow response appearing
- Path selection logic (if visible in logs/output)
- "Deep analysis" path chosen

**Annotation Zone** (add in editing):
- Left side or overlay: "Workflow analyzes complexity"
- Highlight: "Deep Analysis path selected"

**Recording Notes**:
- This might happen fast - be ready
- Capture the decision being made
- OK to pause/slow this section for clarity

---

#### Part 1C: Agent Begins Information Gathering (25-60 seconds)

**SCREEN SHOWS**:
- Agent starts following first step
- Reading bug report file
- Reading relevant code files
- **NOT** jumping to conclusions
- Output shows: "Step 1/8: Analyzing bug context"

**Example Agent Activity**:
```
Agent: "Let me read the bug report first..."
[Opens bug-report.md]

Agent: "Now let me examine the error logs..."
[Opens logs/error-2024-11-01.log]

Agent: "I need to understand the affected component..."
[Opens src/cache/CacheManager.ts]

Agent: "Gathering context before forming hypotheses..."
```

**What to Capture**:
- Methodical, step-by-step gathering
- Multiple files opened
- NO conclusions yet
- Agent following workflow guidance

**Annotation Zone**:
- "Step 1/8: Understanding the bug"
- "Notice: No conclusions yet"
- "Gathering comprehensive context"

**Recording Notes**:
- This section can be sped up 2x in editing
- Show enough to demonstrate thoroughness
- Include 3-4 file opens
- Keep final 5 seconds at normal speed for transition

---

### Recording 1 Checklist

**Before Recording**:
- [ ] Bug scenario prepared and reproducible
- [ ] Agent configured and tested
- [ ] IDE window clean and fonts large
- [ ] Screen recording software ready
- [ ] 1080p recording settings
- [ ] Audio input OFF (silent recording, voiceover added later)

**During Recording**:
- [ ] Capture agent request clearly
- [ ] Show workflow response
- [ ] Demonstrate conditional path selection
- [ ] Show systematic context gathering
- [ ] No conclusions/guesses yet
- [ ] End at natural transition point

**After Recording**:
- [ ] Review for readability
- [ ] Check that key moments are visible
- [ ] Verify 50-70 seconds (will be edited to 60)
- [ ] Note timecodes for key moments
- [ ] Mark sections to speed up

---

## Recording 2: Hypothesis Testing & Validation

**Duration**: 90 seconds (target)
**Timing in Presentation**: 4:25-5:55
**Purpose**: Show LLM creativity + workflow structure = systematic testing

### Shot Breakdown

#### Part 2A: Hypothesis Generation (0-20 seconds)

**SCREEN SHOWS**:
- Agent generates multiple hypotheses
- LLM creativity at work

**Example Output**:
```
Agent: "Based on the evidence gathered, I see several possibilities:

Hypothesis 1: Race condition in cache invalidation
- Timing: Errors occur during high concurrency
- Evidence: Error timestamps cluster around peak load

Hypothesis 2: Null pointer in error handler
- Pattern: Stack traces show null access
- Location: CacheManager.ts line 247

Hypothesis 3: State corruption from stale references
- Symptom: Intermittent failures
- Scope: Affects multiple cache instances

Let me test each hypothesis systematically..."
```

**What to Capture**:
- Multiple creative hypotheses
- Reasoning for each
- LLM bringing intelligent analysis
- Clear numbered list

**Annotation Zone**:
- "Step 4/8: Generate hypotheses"
- "LLM creativity: Multiple possibilities"
- Highlight: "Now structure ensures thoroughness"

**Recording Notes**:
- This shows LLM capability
- Let this section play at normal speed
- Capture the full list of hypotheses

---

#### Part 2B: Workflow Enforces Systematic Testing (20-30 seconds)

**SCREEN SHOWS**:
- Workflow response: "Test each hypothesis with evidence"
- Loop begins: "Iteration 1/3"

**Example**:
```
WorkRail: {
  "step": {
    "id": "test-hypothesis",
    "title": "Test Hypothesis",
    "prompt": "For this hypothesis, gather concrete evidence:
    - Stack traces showing the issue
    - Timing logs demonstrating the pattern
    - Test cases that reproduce it
    
    No speculation - only facts."
  },
  "loopInfo": {
    "iteration": 1,
    "hypothesis": "Race condition in cache invalidation"
  }
}
```

**What to Capture**:
- Workflow enforcing systematic approach
- Loop structure visible
- "Evidence required" message
- Validation gate mentioned

**Annotation Zone**:
- "Step 5/8: Test systematically"
- "Workflow structure: Evidence required"
- "Validation gate active"

---

#### Part 2C: Testing Hypothesis 1 (30-50 seconds)

**SCREEN SHOWS**:
- Agent gathering evidence for hypothesis 1
- Reading logs, stack traces, timing data
- Finding confirming evidence

**Example Activity**:
```
Agent: "Testing Hypothesis 1: Race condition..."

[Opens timing-logs.json]
Agent: "Timing evidence: Operations 50ms apart"

[Opens stack-traces/error-001.log]
Agent: "Stack trace shows concurrent access to line 247"

[Opens tests/load-test-results.md]
Agent: "Load test: 100% reproduction under concurrent load"

Agent: "Hypothesis 1: CONFIRMED
Evidence:
✓ Timing logs show 50ms gap between conflicting operations
✓ Stack traces consistently point to line 247
✓ Reproducible under load testing"
```

**What to Capture**:
- Methodical evidence gathering
- Multiple evidence sources
- Clear confirmation with facts
- No guessing - only evidence

**Annotation Zone**:
- "Gathering evidence..."
- "Multiple sources checked"
- "Confirmed with facts ✓"

**Recording Notes**:
- This can be sped up 1.5x in editing
- Show 2-3 evidence sources
- End with clear confirmation

---

#### Part 2D: Testing Hypothesis 3 (50-70 seconds)

**SCREEN SHOWS**:
- Agent testing hypothesis 3
- Finding NO evidence
- Ruling it out systematically

**Example Activity**:
```
Agent: "Testing Hypothesis 3: State corruption..."

[Opens state-dumps/]
Agent: "Checking state dumps during errors..."

Agent: "State dumps show:
- No stale references found
- State consistency maintained
- No corruption patterns"

[Runs state validation script]
Agent: "Validation: All state transitions correct"

Agent: "Hypothesis 3: RULED OUT
No evidence of state corruption:
❌ State dumps clean
❌ No stale references
❌ State validation passes"
```

**What to Capture**:
- Same systematic approach
- Evidence-based ruling out
- Not speculation - tested and disproven

**Annotation Zone**:
- "Testing all hypotheses"
- "Evidence-based ruling out"
- "Systematic process"

**Recording Notes**:
- Show that even ruling out is systematic
- Can be slightly faster than hypothesis 1
- Demonstrates thoroughness

---

#### Part 2E: Loop Summary (70-90 seconds)

**SCREEN SHOWS**:
- Agent summarizing findings
- Multiple hypotheses tested
- Clear results

**Example**:
```
Agent: "Hypothesis testing complete:

Hypothesis 1: Race condition ✓ CONFIRMED
- Strong evidence from timing logs, stack traces, load tests

Hypothesis 2: Null pointer ⚠️ POSSIBLE
- Some evidence but needs deeper investigation  

Hypothesis 3: State corruption ❌ RULED OUT
- No supporting evidence found

Proceeding with Hypothesis 1 as primary root cause..."
```

**What to Capture**:
- Summary of systematic process
- Multiple hypotheses evaluated
- Evidence-based conclusions
- Transition to next step

**Annotation Zone**:
- "Creativity + Structure"
- "Systematic validation complete"
- "Evidence-based conclusions"

---

### Recording 2 Checklist

**Before Recording**:
- [ ] Hypotheses prepared (write them beforehand)
- [ ] Evidence files created and placed
- [ ] Test both confirmation AND ruling out
- [ ] Practice the flow

**During Recording**:
- [ ] Show hypothesis generation (LLM creativity)
- [ ] Show workflow loop structure
- [ ] Capture evidence gathering for Hypothesis 1
- [ ] Show ruling out Hypothesis 3
- [ ] Demonstrate validation gates
- [ ] Clear "creativity + structure" balance
- [ ] End with summary

**After Recording**:
- [ ] Review for the balance demonstration
- [ ] Check that loop structure is clear
- [ ] Verify 85-95 seconds (will edit to 90)
- [ ] Mark sections to speed up (evidence gathering)
- [ ] Note annotation timecodes

---

## Recording 3: Evidence-Based Result

**Duration**: 30 seconds (target)
**Timing in Presentation**: 5:55-6:25
**Purpose**: Show the final, evidence-based conclusion

### Shot Breakdown

#### Part 3A: Final Output (0-15 seconds)

**SCREEN SHOWS**:
- Complete investigation results
- Root cause identified
- Evidence summary

**Example Output**:
```
========================================
BUG INVESTIGATION RESULTS
========================================

ROOT CAUSE IDENTIFIED:
Race condition in cache invalidation

LOCATION:
File: src/cache/CacheManager.ts
Line: 247
Function: invalidateCache()

EVIDENCE:
1. Stack Traces:
   - All 47 error instances point to line 247
   - Concurrent access pattern visible
   
2. Timing Logs:
   - Operations occurring 50ms apart
   - Window too small for lock acquisition
   
3. Load Testing:
   - 100% reproducible under concurrent load
   - Zero occurrences with synchronization added

CONFIDENCE: 95% - High certainty based on comprehensive evidence

RECOMMENDED FIX:
Add mutex lock around cache invalidation operations
Estimated effort: 2-3 hours
```

**What to Capture**:
- Complete, professional output
- Multiple evidence types
- Confidence level with justification
- Actionable recommendations

**Recording Notes**:
- Slow scroll through output
- Let text be readable
- Show completeness

---

#### Part 3B: Evidence Details (15-25 seconds)

**SCREEN SHOWS**:
- Scrolling through evidence details
- Stack traces visible
- Timing data visible
- Test results visible

**What to Capture**:
- Actual evidence (not just claims)
- Stack trace excerpt
- Timing logs excerpt
- Reproduction steps

**Annotation Zone**:
- "Certainty with evidence"
- "Not confident guessing"
- "Comprehensive analysis"

**Recording Notes**:
- Slow, deliberate scroll
- Pause on key evidence
- Show depth of analysis

---

#### Part 3C: Contrast with Guessing (25-30 seconds)

**SCREEN SHOWS** (optional overlay):
- Text comparison:

```
AI GUESSING:
"It's probably a race condition. 
Try adding a lock?"

WORKRAIL RESULT:
"Definitely a race condition at line 247.
Here's the evidence: [stack traces], 
[timing logs], [reproduction steps].
Fix: Add mutex lock. 
Confidence: 95%"
```

**What to Capture**:
- Clear contrast
- "Probably" vs "Definitely"
- Speculation vs Evidence

**Annotation Zone**:
- "Reliable excellence"
- "Evidence-based certainty"

**Recording Notes**:
- This overlay may be added in editing
- Or can be a simple text slide
- Drive home the difference

---

### Recording 3 Checklist

**Before Recording**:
- [ ] Final output formatted and complete
- [ ] Evidence files ready to show
- [ ] Clear, readable presentation
- [ ] Professional appearance

**During Recording**:
- [ ] Show complete results
- [ ] Scroll through evidence
- [ ] Demonstrate depth of analysis
- [ ] Show confidence level
- [ ] Contrast with guessing

**After Recording**:
- [ ] Verify 25-35 seconds
- [ ] Check all evidence is readable
- [ ] Confirm professional appearance
- [ ] Note highlight moments

---

## Post-Recording: Editing Guide

### For Each Recording

**Speed Adjustments**:
- Recording 1: 2x speed during file browsing, normal for key moments
- Recording 2: 1.5x during evidence gathering, normal for conclusions
- Recording 3: Normal speed throughout (it's already short)

**Annotations to Add**:
All annotations should be:
- Large, readable font (24pt+)
- High contrast
- Positioned outside laptop frame OR overlaid with semi-transparent background
- Animated in/out smoothly

**Recording 1 Annotations**:
- "Step 1/8: Understanding the bug" (at 10 sec)
- "Workflow adapts to complexity" (at 20 sec)
- "Notice: No conclusions yet" (at 40 sec)

**Recording 2 Annotations**:
- "Step 4/8: Generate hypotheses (LLM creativity)" (at 5 sec)
- "Step 5/8: Test systematically (workflow structure)" (at 25 sec)
- "Creativity + Structure" (at 45 sec)
- "Validation gate: Evidence required ✓" (at 50 sec)

**Recording 3 Annotations**:
- "Certainty with evidence" (at 10 sec)
- "Not confident guessing" (at 20 sec)

---

### Laptop Mockup Integration

**Place recordings INSIDE laptop frame** (from Zillow template #62-67):
- Align recording to screen area of laptop graphic
- Add subtle shadow/reflection if template doesn't include it
- Ensure template branding (Zillow logo) remains visible
- Keep aspect ratio correct

**Annotation placement**:
- Left side of screen (outside laptop frame)
- OR overlay on screen with semi-transparent background
- Consistent positioning across all three recordings

---

### Audio Sync

Match voiceover from script to recordings:
- Recording 1: 3:25-4:25 in script
- Recording 2: 4:25-5:55 in script
- Recording 3: 5:55-6:25 in script

Sync points:
- Recording 1: Start voice as workflow response appears
- Recording 2: "Now watch the balance" as hypotheses appear
- Recording 3: "And here's the result" as output shows

---

## Technical Specifications

**Recording Software Options**:
- OBS Studio (free, professional)
- QuickTime (Mac, simple)
- Camtasia (paid, easy editing)
- ScreenFlow (Mac, professional)

**Settings**:
```
Resolution: 1920x1080 (1080p)
Frame rate: 30fps (60fps if smooth scrolling important)
Bitrate: 5000-8000 kbps
Format: MP4 (H.264)
Audio: OFF (voiceover added separately)
```

**File Management**:
```
demo-1-workflow-start-raw.mp4
demo-1-workflow-start-edited.mp4
demo-2-hypothesis-testing-raw.mp4
demo-2-hypothesis-testing-edited.mp4
demo-3-results-raw.mp4
demo-3-results-edited.mp4
```

---

## Troubleshooting

**If recording is choppy**:
- Lower resolution temporarily
- Close unnecessary applications
- Record in segments and stitch together
- Use screen recording optimization settings

**If text is unreadable**:
- Increase IDE font size (20-24pt)
- Use higher contrast theme
- Record at higher resolution and downscale
- Zoom IDE window to 125-150%

**If timing is off**:
- Record longer than needed, edit to fit
- Practice the flow before recording
- Have script timing visible while recording
- Use editing to adjust pace

**If agent is too slow**:
- Speed up recording in editing
- Use faster agent responses (adjust temperature/settings)
- Pre-script agent responses for consistency
- Edit out dead time

**If agent makes mistakes**:
- Re-record that segment
- Edit out the mistake
- Have backup responses prepared
- Practice run reduces mistakes

---

## Final Quality Checks

Before considering demo recordings complete:

- [ ] All three recordings at 1080p
- [ ] Text readable at small sizes
- [ ] Key moments clearly visible
- [ ] Smooth playback (no stutters)
- [ ] Proper duration (within 5 seconds of target)
- [ ] Demonstrates intended concepts clearly
- [ ] Professional appearance
- [ ] Annotations planned and positioned
- [ ] Files backed up
- [ ] Ready for integration into laptop mockup frames

---

## Demo Success Criteria

The three recordings together should demonstrate:
1. ✓ Adaptive conditional logic
2. ✓ LLM creativity (hypothesis generation)
3. ✓ Workflow structure (systematic testing)
4. ✓ Validation gates (evidence required)
5. ✓ Balance of creativity + structure
6. ✓ Evidence-based conclusions
7. ✓ Reliable excellence (not random)
8. ✓ Professional, methodical process
9. ✓ Clear superiority over guessing

If all nine criteria are met, the demo successfully supports your presentation message.

---

**Shot List Version**: 1.0  
**Last Updated**: November 3, 2025  
**Total Demo Duration**: 3:30 minutes  
**Recordings**: 3 segments  
**Estimated Recording Time**: 2-3 hours (including retakes)


