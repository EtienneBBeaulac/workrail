# WorkRail BTS Presentation - Production Guide

**For Zillow Build Together Summit Template**

## Quick Reference

- **Total Duration**: 10:00 minutes (exact)
- **Format**: Pre-recorded video
- **Post-video**: Live Q&A session
- **Template**: Zillow BTS official PowerPoint/Keynote template
- **Demo Tool**: Screen recording in IDE (VS Code, Cursor, etc.)

---

## Template Mapping: Slide-by-Slide

### ACT 1: PROBLEM (0:00-1:20)

**Slide 1: Title Card (0:00-0:15)**
- **Use Template**: #1 (Dark blue with highlights)
- **Title**: "How WorkRail Puts AI on Rails for Consistent Results"
- **Subtitle**: Your name, Build Together Summit @ Zillow
- **Duration**: 15 seconds
- **Visual**: Clean title with Zillow branding
- **Recording Note**: Hold on title while speaking opening line

---

**Slide 2: The Universal Problem (0:15-0:45)**
- **Use Template**: #4 or #5 (Dark blue section header)
- **Title**: "We've All Been Here"
- **Content**:
  - Crafting the perfect prompt
  - Still getting inconsistent results
  - Hallucinations and confident wrong answers
  - More time fixing than saving
- **Duration**: 30 seconds
- **Visual Style**: Dark blue for impact
- **Animation**: Bullets can appear on click or be static

---

**Slide 3: The Real Cost (0:45-1:20)**
- **Use Template**: #41-43 (White content slide)
- **Title**: "The Real Problem"
- **Content**:
  - Quote: "I'm losing more time than I'm gaining" — Your teammate
  - Text: "The issue wasn't AI capability. It was AI discipline."
- **Duration**: 35 seconds
- **Visual Style**: White for breathing room after blue
- **Typography**: Make quote stand out (larger, styled)

---

### ACT 2: JOURNEY & INSIGHT (1:20-3:10)

**Slide 4: The Journey (1:20-1:45)**
- **Use Template**: #42 (White with graphics)
- **Title**: "My Journey"
- **Content**:
  - Perfect Prompts → ❌ Still inconsistent
  - Manual Workflows → ↑ Better, but copy-paste hell
  - The Question → 💡
- **Duration**: 25 seconds
- **Visual**: Simple timeline or progression graphic
- **Design Note**: Use icons or emojis for visual interest

---

**Slide 5: The Insight (1:45-2:10)**
- **Use Template**: #5 (Dark blue section header)
- **Title**: "The Insight"
- **Content**:
  - "What if the workflow could guide the agent step-by-step?"
  - "Instead of ME feeding context..."
  - "The WORKFLOW asks the questions."
- **Duration**: 25 seconds
- **Visual Style**: Dark blue for impact moment
- **Typography**: Large, bold text for key question

---

**Slide 6: Structure Elevates Creativity (2:10-2:35)**
- **Use Template**: #43 (White with diagram area)
- **Title**: "Structure Doesn't Limit AI—It Elevates It"
- **Content**:
  - Traditional: You → Prompt → AI (random excellence)
  - WorkRail: You → Workflow → AI (reliable excellence)
  - Text: "Structure ensures thoroughness / LLM brings creative reasoning"
  - **Key phrase**: "Structure + Creativity = Reliable Excellence"
- **Duration**: 25 seconds
- **Visual**: Simple before/after flow diagram
- **Design Note**: Use arrows and simple boxes

---

**Slide 7: Transition to Demo (2:35-3:10)**
- **Use Template**: #5 (Dark blue section header)
- **Title**: "Let Me Show You"
- **Subtitle**: "Bug Investigation Workflow / Real methodology, real results"
- **Duration**: 35 seconds (includes setup time)
- **Visual Style**: Dark blue anticipation builder
- **Recording Note**: Brief pause before transitioning to demo

---

### ACT 3: DEMO (3:10-6:40)

**Slide 8: Demo Setup (3:10-3:25)**
- **Use Template**: #4 (Section header)
- **Title**: "Bug Investigation in Action"
- **Content**:
  - "Watch for:"
  - ✓ Conditional logic adapts to complexity
  - ✓ Systematic hypothesis testing
  - ✓ Validation gates ensure evidence
- **Duration**: 15 seconds
- **Visual Style**: Brief setup slide

---

**SCREEN RECORDING 1: Workflow Start (3:25-4:25)**
- **Use Template**: #62, #64, or #66 (Laptop mockup)
- **Frame**: Place screen recording INSIDE laptop mockup
- **Duration**: 60 seconds
- **Content to Record**:
  - IDE showing agent starting workflow
  - Agent calls `workflow_next()`
  - Workflow analyzes bug context
  - Path selection: "Complex bug → Deep analysis path"
  - First step: Gather context (no conclusions yet)
- **Editing Notes**:
  - Speed up: File browsing (2x speed)
  - Slow down: When workflow response appears
  - Add annotations: Left side or overlay
    - "Step 1/8: Understanding the bug"
    - "Workflow adapts to complexity"
    - "Notice: No conclusions yet"
- **Audio**: Voiceover describing what's happening
- **Technical Setup**:
  - IDE font size: 18pt minimum
  - High contrast theme
  - Clear visibility of step counter

---

**SCREEN RECORDING 2: Hypothesis Testing (4:25-5:55)**
- **Use Template**: #64 (Laptop mockup)
- **Frame**: Screen recording in laptop mockup
- **Duration**: 90 seconds
- **Content to Record**:
  - LLM generates hypotheses: "Could be: 1) Race condition, 2) Null pointer, 3) State corruption"
  - Workflow loop: "Test each hypothesis"
  - Show iteration: Testing 1... Testing 2...
  - Validation gate: "Evidence required ✓"
  - Results: Hypothesis 1 CONFIRMED, Hypothesis 3 ruled out
- **Editing Notes**:
  - Speed up: File reading (1.5-2x)
  - Slow down: Hypothesis generation, validation gates
  - Highlight: Evidence being gathered
  - Annotations:
    - "Step 4/8: Generate hypotheses (LLM creativity)"
    - "Step 5/8: Test systematically (workflow structure)"
    - "Creativity + Structure"
    - "Validation gate: Evidence required ✓"
- **Audio**: Voiceover emphasizing the balance
- **Key Message**: Structure elevates creativity

---

**SCREEN RECORDING 3: Evidence-Based Result (5:55-6:25)**
- **Use Template**: #66 (Laptop mockup)
- **Frame**: Screen recording in laptop mockup
- **Duration**: 30 seconds
- **Content to Record**:
  - Final output displayed
  - Root cause: "Race condition in cache invalidation"
  - Evidence list:
    - Stack trace: CacheManager.ts:247
    - Timing logs: 50ms between operations
    - Reproduction: 100% under load
- **Editing Notes**:
  - Slow scroll through output
  - Highlight evidence sections
  - Annotations:
    - "Certainty with evidence"
    - "Not confident guessing"
- **Audio**: Emphasis on evidence vs. guessing

---

**Slide 9: Demo Debrief (6:25-6:40)**
- **Use Template**: #43 (White slide)
- **Title**: "What Just Happened?"
- **Content**:
  - ✓ Workflow adapted to bug complexity
  - ✓ LLM generated creative hypotheses
  - ✓ Structure ensured systematic validation
  - ✓ Evidence-based certainty, not guessing
  - "Reliable excellence."
- **Duration**: 15 seconds
- **Visual Style**: Clean summary

---

### ACT 4: ARCHITECTURE (6:40-7:10)

**Slide 10: How It Works (6:40-7:00)**
- **Use Template**: #43 (White with diagram)
- **Title**: "The System"
- **Content**:
  - Diagram: AI Agent ↔ MCP ↔ WorkRail ↔ Workflows
  - Bullets:
    - Stateless (agent manages state)
    - Step-by-step delivery
    - Context optimization (60-80% reduction)
    - Resumable across sessions
- **Duration**: 20 seconds
- **Visual**: Simple architecture diagram with arrows
- **Design Note**: Keep diagram simple, high-level only

---

**Slide 11: What's in a Workflow? (7:00-7:10)**
- **Use Template**: #42 (White content)
- **Title**: "What's in a Workflow?"
- **Subtitle**: "Not checklists. Executable methodologies:"
- **Content**:
  - Conditional branching (adapt to context)
  - Iterative loops (systematic coverage)
  - Validation gates (quality assurance)
  - Meta-guidance (strategic thinking)
  - Agent roles (perspective shifts)
  - Text: "These are systems that respond to what they discover."
- **Duration**: 10 seconds
- **Visual Style**: Quick overview, save details for Q&A

---

### ACT 5: IMPACT & CLIMAX (7:10-8:50)

**Slide 12: Team Transformation (7:10-7:30)**
- **Use Template**: #101-102 (Stats/comparison layout)
- **Title**: "Team Impact"
- **Content**:
  - **Before** (left side):
    - ❌ Inconsistent results
    - ⏰ Wasting time
    - 😤 Ready to quit
  - **After** (right side):
    - ✅ Daily users
    - 🎯 Consistent quality
    - 😊 Team loves it
  - Bottom text: "Most popular: Task dev, debugging, MR reviews"
- **Duration**: 20 seconds
- **Visual**: Use template's stat boxes effectively
- **Design Note**: Strong visual contrast between before/after

---

**Slide 13: Suspense Build (7:30-7:45)**
- **Use Template**: #5 (Dark blue, minimal text)
- **Content**:
  - "Problem solved, right?"
  - [Large empty space]
  - "But here's what I didn't expect..."
- **Duration**: 15 seconds
- **Visual Style**: Dark blue, suspenseful
- **Recording Note**: Include 3-second pause mid-slide
- **Audio**: Build anticipation with pacing

---

**Slide 14: The Unexpected Benefit (7:45-8:00)**
- **Use Template**: #42 (White)
- **Title**: "The Unexpected Benefit"
- **Content**:
  - "Because workflows are consistent, reliable, methodical..."
  - "I can trust them to work unattended."
  - [Space]
  - "This changed everything."
- **Duration**: 15 seconds
- **Visual Style**: Clean, anticipatory
- **Recording Note**: Brief pause before transition

---

**Slide 15: PARALLELIZATION REVEAL (8:00-8:35)**
- **Use Template**: Custom layout OR adapt #85-86 OR go full-screen
- **Title**: "Real Productivity Multiplication"
- **Content**: **THE MONEY SHOT**
  - Visual: 3 IDE windows side-by-side or staggered
  - **Window 1** (Left): Bug Investigation
    - "Step 6/8: Testing hypothesis 2..."
    - Progress bar: 75%
  - **Window 2** (Center): Feature Development
    - "Step 4/12: Examining patterns..."
    - Progress bar: 33%
  - **Window 3** (Right): MR Review
    - "Step 7/8: Checking edge cases..."
    - Progress bar: 88%
  - **Bottom center**: "9:47 AM" (same timestamp)
  - **Text**: "All running simultaneously"
- **Duration**: 35 seconds (CRITICAL - this is the climax)
- **Visual Requirements**:
  - Must show 3 distinct IDE instances
  - Each showing real, sophisticated work
  - Progress indicators visible
  - Same timestamp = simultaneity
  - Professional screenshot or mockup
- **Recording Notes**:
  - [0-5 sec] Show visual, SILENCE - let them SEE it
  - [5-35 sec] Voiceover with careful pacing
- **Design Options**:
  - **Option A**: 3 screenshots arranged side-by-side
  - **Option B**: Staggered overlapping windows
  - **Option C**: Go full-screen (break from template momentarily)
- **Critical**: This must visually communicate parallel work clearly

---

**Slide 16: The Result (8:35-8:50)**
- **Use Template**: #106 (White with visual)
- **Title**: "The Result"
- **Content**:
  - "My feature: ✓ Completed with full context"
  - "Bug investigation: ✓"
    - "Ten hypotheses narrowed to two root causes"
    - "With evidence: stack traces, logs, reproduction steps"
  - "MR review: ✓"
    - "Comprehensive feedback ready for teammate"
    - "Edge cases identified, patterns checked"
  - **Key phrase**: "Not just better results—MORE results."
- **Duration**: 15 seconds
- **Visual**: Checkmarks, success indicators
- **Recording Note**: Let the final phrase land with emphasis

---

### ACT 6: CLOSING & CTA (8:50-10:00)

**Slide 17: It's Available Now (8:50-9:05)**
- **Use Template**: #5 (Dark blue)
- **Title**: "WorkRail is Open Source"
- **Content**:
  - "MIT License"
  - "v0.6.1-beta"
  - "14 workflows ready to use"
  - **Key phrase**: "Structure + Creativity = Reliable Excellence"
- **Duration**: 15 seconds
- **Visual Style**: Dark blue for impact

---

**Slide 18: How to Start (9:05-9:25)**
- **Use Template**: #41 (White content)
- **Title**: "Get Started Today"
- **Content**:
  - **Large, readable**: "github.com/exaudeus/workrail"
  - "npm: @exaudeus/workrail"
  - "Start with:"
    - Bug Investigation (prevents jumping to conclusions)
    - MR Review (team favorite)
    - Task Development (comprehensive approach)
- **Duration**: 20 seconds
- **Design Note**: Make GitHub link VERY prominent and readable
- **Visual**: QR code optional but helpful

---

**Slide 19: What You'll Discover (9:25-9:45)**
- **Use Template**: #42 (White)
- **Title**: "What You'll Discover"
- **Content**:
  - When workflows help (vs. when they're overkill)
  - How to customize for YOUR team
  - Ways to codify YOUR expertise
  - The sweet spot: Structure + Creativity
- **Duration**: 20 seconds
- **Visual Style**: Benefit-focused list

---

**Slide 20: Transition to Q&A (9:45-10:00)**
- **Use Template**: #25 (Q&A slide from template)
- **Title**: "Let's answer some questions!"
- **Content**:
  - "Coming up in Q&A:"
  - Writing custom workflows
  - MCP protocol deep dive
  - Team adoption strategies
  - Architecture details
- **Duration**: 15 seconds
- **Visual**: Use template's Q&A styling
- **Recording Note**: Friendly, inviting tone

---

## Backup Slides (For Live Q&A)

Keep these ready but hidden in presentation:

**Backup 1: What's MCP?**
- Template #43
- Protocol overview

**Backup 2: When NOT to Use**
- Template #101-102
- Good fit / Poor fit comparison

**Backup 3: Workflow JSON Example**
- Template #46-47
- Code sample with syntax highlighting

**Backup 4: Context Optimization**
- Template #43
- Technical details about loop optimization

**Backup 5: Team Adoption Strategy**
- Template #42
- Step-by-step adoption approach

---

## Visual Design Notes

### Color Rhythm Strategy
Alternate between dark blue (impact/transitions) and white (content/explanation):
- Blue → White → White → Blue creates visual pacing
- Blue slides: 1, 2, 5, 7, 8, 13, 15, 17, 20
- White slides: 3, 4, 6, 9, 10, 11, 12, 14, 16, 18, 19

### Typography Guidelines
- **Headlines**: Bold, 44pt minimum
- **Body text**: 24pt minimum
- **Code snippets**: 18pt minimum (monospace)
- **GitHub link**: 32pt or larger

### Accessibility Checklist
- ✓ High contrast (dark blue on white, white on dark blue)
- ✓ Large fonts (readable from back of room)
- ✓ No color-only information
- ✓ Alt text for all images/diagrams
- ✓ Clear hierarchy

### Zillow Branding
- ✓ Logo visible on all slides (template handles this)
- ✓ Maintain brand colors
- ✓ Professional polish throughout

---

## Recording Production Notes

### Equipment Setup
- **Camera**: HD webcam or camera for talking head segments
- **Microphone**: External mic for clear audio
- **Screen Recording**: OBS, QuickTime, or similar (1080p minimum)
- **Lighting**: Good lighting for talking head segments
- **Background**: Clean, professional background

### Filming Segments

**Talking Head Segments** (Bookends + transitions):
- Opening (Slide 1): 0:00-0:15
- Closing/Q&A transition (Slide 20): 9:45-10:00
- Optional: Brief talking head moments between sections

**Screen Recording Segments**:
- Demo 1: 60 seconds of clean workflow execution
- Demo 2: 90 seconds of hypothesis testing
- Demo 3: 30 seconds of final results
- All at 1080p or higher
- High contrast IDE theme
- Large fonts (18pt minimum)

### Editing Workflow

1. **Record all segments separately**:
   - Talking head segments
   - Screen recordings (3 separate recordings)
   - B-roll if needed

2. **Edit in video editor** (Premiere, Final Cut, DaVinci Resolve):
   - Import all segments
   - Place in timeline according to timestamps
   - Add transitions (subtle, professional)
   - Add annotations to screen recordings
   - Sync audio carefully
   - Add background music (optional, subtle)

3. **Overlay slides**:
   - Export slides as images from PowerPoint/Keynote
   - Overlay on talking head segments as needed
   - OR use picture-in-picture for laptop mockups

4. **Polish**:
   - Color correction
   - Audio leveling
   - Remove "ums" and pauses (but keep intentional pauses)
   - Ensure exactly 10:00 runtime

5. **Export**:
   - 1080p MP4
   - H.264 codec
   - AAC audio
   - Bitrate: 8-10 Mbps

---

## Pre-Production Checklist

### Content Preparation
- [ ] Script finalized and timed
- [ ] Slides built in Zillow template
- [ ] Demo recordings captured
- [ ] Annotations prepared
- [ ] Backup slides ready

### Technical Setup
- [ ] Recording software tested
- [ ] Audio quality verified
- [ ] Screen recording settings optimized
- [ ] IDE configured (fonts, theme, layout)
- [ ] Workflow execution tested

### Recording Environment
- [ ] Quiet location
- [ ] Good lighting
- [ ] Clean background
- [ ] No interruptions scheduled
- [ ] Equipment charged/plugged in

---

## Production Timeline Estimate

- **Slide creation**: 4-6 hours
- **Demo recording**: 2-3 hours (with retakes)
- **Talking head recording**: 1-2 hours
- **Video editing**: 4-6 hours
- **Review & polish**: 1-2 hours
- **Total**: 12-19 hours

---

## Quality Assurance

### Before Finalizing:
- [ ] Exactly 10:00 runtime
- [ ] All animations work
- [ ] Audio levels consistent
- [ ] No visual glitches
- [ ] Text readable at small size
- [ ] Transitions smooth
- [ ] Demo recordings clear
- [ ] Annotations visible
- [ ] GitHub link correct and prominent
- [ ] Branding consistent

### Test Viewing:
- [ ] Watch on laptop screen
- [ ] Watch on phone (accessibility check)
- [ ] Watch without audio (visual clarity check)
- [ ] Get feedback from colleague

---

## Day-of-Q&A Preparation

### Have Ready:
- Backup slides loaded
- GitHub repo open in browser
- Example workflow JSON ready
- Architecture diagram handy
- Team adoption story prepared
- Technical deep-dive notes

### Common Questions to Prep:
1. "How do I write a custom workflow?"
2. "What's the learning curve?"
3. "Can it work with [specific AI tool]?"
4. "What about costs/performance?"
5. "How do I convince my team to try it?"
6. "What are the limitations?"

---

## Contact & Resources

- **Presentation file**: [Link to template file]
- **Demo recordings**: ./demo-recordings/
- **Assets**: ./assets/
- **Backup slides**: In main presentation (hidden)
- **Script**: presentation-recording-script.md
- **Shot list**: presentation-demo-shotlist.md


