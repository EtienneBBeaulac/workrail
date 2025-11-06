---
marp: true
theme: default
paginate: true
style: |
  section {
    color: #333 !important;
    background-color: #fff;
  }
  section h1 {
    color: #003366 !important;
  }
  section h2 {
    color: #003366 !important;
  }
  section h3 {
    color: #003366 !important;
  }
  section p {
    color: #333 !important;
  }
  section li {
    color: #333 !important;
  }
  section strong {
    color: #003366 !important;
  }
  section.blue {
    background-color: #003366 !important;
    color: #fff !important;
  }
  section.blue h1 {
    color: #fff !important;
  }
  section.blue h2 {
    color: #fff !important;
  }
  section.blue h3 {
    color: #fff !important;
  }
  section.blue p {
    color: #fff !important;
  }
  section.blue li {
    color: #fff !important;
  }
  section.blue strong {
    color: #fff !important;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  img[alt~="center"] {
    display: block;
    margin: 0 auto;
  }
  .small-text {
    font-size: 0.8em;
  }
  .large-text {
    font-size: 1.5em;
    font-weight: bold;
  }
  pre code {
    color: #333 !important;
    background-color: #f5f5f5 !important;
  }
---

<!-- _class: blue -->

# How WorkRail Puts AI on Rails for Consistent Results

**[Your Name]**  
Build Together Summit @ Zillow  
Mobile Track

**Duration**: 25 minutes (25 min content with context card)

<!--
TIMING: 0:00-0:45 (45 seconds)
FORMAT: YOU ON CAMERA

SCRIPT:
"Hi, I'm [Name]. Six months ago, I started building something because I was tired of copy-pasting the same prompts over and over.

[Pause 2 seconds]

I'd crafted effective prompts for debugging, code reviews, feature implementation. They worked great. But every time I needed them, I'd dig through notes, copy-paste, manually customize with context.

[Slight head shake, show frustration]

Exhausting.

I wanted something better—something that could guide the AI step by step, handle context automatically, branch based on complexity. Something anyone could use to get great results without being a prompt expert."

ENERGY: Warm introduction → frustrated → determined
VISUAL: Clean background, eye level, good lighting
-->

---

## Context

<!--
TIMING: 0:45-1:15 (30 seconds)
FORMAT: ON-CAMERA with brief visual overlay

SCRIPT:
"Quick context: I've been deep in LLMs since GPT-3.5 launched. Testing every model, documenting every limitation.

[Brief screenshot of AI Takeaways header appears on screen]

I even wrote this guide—'AI Takeaways'—that got shared around at Zillow. Other teams started using it.

[Pause]

But here's the thing: even with all that knowledge, I was still frustrated.

[Pause]

Because knowing how to prompt LLMs well didn't solve the real problem..."

ENERGY: Establishing credibility → building to problem
VISUAL: AI Takeaways header (just the title, clean)
NOTE: This is on-camera, not a slide. The visual overlay is brief.
-->

---

<!-- _class: blue -->

## WHETHER YOU'RE WRITING

**Swift, Kotlin, JavaScript, or PowerPoint slides...**

🍎 iOS • 🤖 Android • ⚛️ React Native • 🦋 Flutter • 💻 VS Code

### We all face the same AI inconsistency problem

<!--
TIMING: 1:15-2:00 (45 seconds)
FORMAT: SLIDE with VOICEOVER

SCRIPT:
"Whether you're writing Swift, Kotlin, JavaScript, or PowerPoint slides...

[Pause]

We all face the same AI inconsistency problem.

[Pause 2 seconds for text to land]

AI coding assistants are powerful, but unreliable. Same task, different day, completely different quality."

ENERGY: Establishing, inclusive ("we all")
KEY EMPHASIS: Platform-agnostic relevance (mobile track)
-->

---

## We've All Been Here

• Crafting the perfect prompt
• Getting inconsistent results  
• AI confidently giving wrong answers
• More time fixing than saving

<!--
TIMING: 2:00-2:30 (30 seconds)
FORMAT: SLIDE with VOICEOVER

LAYOUT: 
- LEFT: Zillow illustration (robot teaching frustrated people)
- RIGHT: Text with bullet points

SCRIPT:
"We've all been here:

Crafting the perfect prompt. Getting inconsistent results. AI confidently giving wrong answers. More time fixing than saving.

[Pause]

Sound familiar?"

ENERGY: Knowing, relatable
VISUAL: Use Zillow illustration of robot with frustrated developers
-->

---

## The Real Problem

> **"I'm losing more time than I'm gaining"**
> 
> — Your teammate, probably

**The issue wasn't AI capability.**  
**It was AI *discipline*.**

<!--
TIMING: 2:30-3:00 (30 seconds total: on-camera + this slide)
FORMAT: ON-CAMERA SEGMENT then SLIDE

LAYOUT:
- LEFT: Text with quote and emphasis
- RIGHT: Zillow illustration (frustrated person at laptop)

ON-CAMERA SCRIPT:
"A couple months ago, I showed what I'd been building to my team. One teammate told me, 'I'm losing more time than I'm gaining with AI tools. I'm ready to quit using them.'

[Pause, look thoughtful]

That validated what I'd suspected—this wasn't just my problem. The team was struggling even more.

[Pause]

And here's what I realized: the problem wasn't the AI's capability. Claude, GPT, Gemini—they're brilliant. The problem was AI discipline."

SLIDE VOICEOVER:
"The issue wasn't AI capability. It was AI discipline.

[Pause]

LLMs are creative and fast, but they skip the boring-but-critical steps. They jump to conclusions without validation."

ENERGY: Empathetic → realization
VISUAL: Use Zillow illustration of frustrated developer
-->

---

## My Journey

<div style="font-size: 1.3em; line-height: 2em; padding: 2rem;">

**Perfect Prompts** → ❌ Still inconsistent

**Manual Workflows** → ⚠️ Better, but copy-paste hell

**The Question...** → 💡

</div>

<!--
TIMING: 3:00-5:00 (2 minutes)
FORMAT: SLIDE with VOICEOVER (or B-roll with IDE screenshots)

LAYOUT:
- CENTER: Three-line progression with bold labels
- Could add Zillow illustration on LEFT or RIGHT if desired
- Keep it simple and visual

SCRIPT:
"So I started building. Six months ago.

[Pause]

First attempt: Better prompts. I had this five-hundred-word prompt for bug investigation. It worked great... until it didn't.

[Slight head shake]

One day it found the issue in ten minutes. Next day, same type of bug, it refactored the wrong files for two hours. Random excellence, not reliable excellence.

[Pause]

Next attempt: Manual workflows—step-by-step guides I'd follow. I'd built these complex branching workflows—if this, then that—scrolling up and down through notes to find the right prompt to copy-paste.

[Pause, show frustration]

I was spending five minutes just FINDING the right section, then another five customizing it with context. Copy-paste hell.

[Pause]

But the methodology helped. The step-by-step approach worked. The problem was the delivery mechanism.

[Look thoughtful]

That's when I asked: what if the workflow itself could interact with the AI?

[Long pause, let the question hang]

What if..."

ENERGY: Frustrated → reflective → curious → building to reveal
-->

---

<!-- _class: blue -->

## The Insight

### What if the workflow could guide the agent step-by-step?

**Instead of ME feeding context...**  
**The WORKFLOW asks the questions.**

<!--
TIMING: 5:00-6:30 (90 seconds)
FORMAT: SLIDE (5:00-5:30) then ON-CAMERA (5:30-6:30)

LAYOUT:
- RIGHT: Text with key question and emphasis
- LEFT: Consider Zillow diagram/illustration or simple visual
- Alternates from previous slide (text was on left)

SLIDE VOICEOVER (5:00-5:30):
"What if the workflow itself could guide the agent, step-by-step, through an MCP server?

[Pause 2 seconds]

Instead of ME feeding context to the agent... the WORKFLOW asks the questions.

[Pause]

The workflow handles the methodology. I handle the specifics.

[Pause]

That question became WorkRail."

ON-CAMERA SCRIPT (5:30-6:30):
"At first, I used my manual workflows to BUILD WorkRail. Copy-pasting instructions to the LLM to help me code faster.

[Small laugh, slight head shake]

But as soon as I had the first workflow working—the task development workflow—I switched.

[Pause]

I started using WorkRail... to make WorkRail better.

[Pause, look directly at camera]

And it accelerated everything.

[Pause]

That's when I knew this was real."

ENERGY: Aha moment → playful → emphatic validation
MUSIC CUE: Shift to optimistic tone at 5:00, build at 5:30
VISUAL: Slide shows diagram (You → AI vs You → Workflow → AI), then cut to on-camera
-->

---

<!-- _class: blue -->

## Structure Doesn't Limit AI—It Elevates It

<div class="columns">
<div>

### Traditional
You → Prompt → AI

**Random excellence**

</div>
<div>

### WorkRail
You → Workflow → AI

**Reliable excellence**

</div>
</div>

**Structure** ensures thoroughness  
**LLM** brings creative reasoning

### Structure + Creativity = Reliable Excellence

<!--
TIMING: 7:00-10:00 (3 minutes: 1.5 min on-camera + 1.5 min this slide)
FORMAT: ON-CAMERA SEGMENT (6:30-8:00) then SLIDE + PIP (8:00-9:30)

ON-CAMERA SCRIPT (6:00-7:30):
"Now, here's what I initially got wrong when I built this.

[Pause, show vulnerability]

At first, I talked about WorkRail like it 'forces' the AI to follow steps—like it 'controls' the agent. But that's not right.

[Head shake]

WorkRail doesn't *limit* AI creativity. It *elevates* it.

[Pause, hand gesture for emphasis]

Let me give you a concrete example.

[Pause]

Without structure: AI says, 'There's a race condition.' Sounds confident. I spent two hours refactoring based on that guess. It wasn't a race condition.

[Pause, show frustration]

With WorkRail: The bug investigation workflow generates hypotheses—'Could be race condition, state management, caching, or timing.' Four possibilities. Then systematically tests each one with evidence.

[Pause]

Found it in twenty minutes. It WAS state management. Correct. With proof.

[Pause]

LLMs need focused attention. Think about debugging—if you're trying to track down ten different crashes simultaneously, you make no progress. But focus on reproducing one crash systematically? You nail it.

[Pause, gesture]

And they need to digest context, not just read it. Like when you read code versus when you explain it to someone—suddenly you notice patterns, dependencies, edge cases you missed.

[Pause]

That's what workflows do: focused attention, digested context, validated output.

[Pause]

The workflow ensures thoroughness. The LLM brings creative reasoning and intelligent analysis. Together, you get reliable excellence, not random brilliance."

SLIDE VOICEOVER (7:30-9:00):
"Traditional approach: you send a prompt, AI responds. Sometimes brilliant. Sometimes confidently wrong. Random excellence.

[Pause]

WorkRail: you provide context, the workflow guides the methodology, AI executes with intelligence. Reliable excellence.

[Pause]

Here's where creativity thrives: Generating hypotheses. Analyzing patterns. Suggesting solutions. That's all the LLM.

[Pause]

Here's what structure ensures: Context is gathered before solutions. Hypotheses are tested with evidence. Edge cases are checked.

[Pause]

The LLM isn't following a script. It's bringing intelligence to a proven methodology.

[Pause]

Structure... plus creativity... equals reliable excellence."

ENERGY: Vulnerable → frustrated → emphatic → confident
KEY MESSAGE: This is the paradigm shift - critical framing
-->

---

## Not Checklists—Executable Methodologies

```json
{
  "id": "bug-investigation",
  "steps": [
    {
      "runCondition": {          // ← Conditional branching
        "var": "complexity",
        "in": ["medium", "high"]
      }
    },
    {
      "type": "loop",             // ← Iterative loops
      "loop": {
        "type": "forEach",
        "items": "${hypotheses}"  // ← Systematic coverage
      }
    },
    {
      "validationCriteria": [     // ← Validation gates
        {"type": "contains", "value": "evidence"}
      ]
    }
  ]
}
```

<!--
TIMING: 9:30-10:00 (30 seconds)
FORMAT: FULLSCREEN code view with annotations OR split layout

LAYOUT OPTIONS:
- OPTION A: Fullscreen code (no left/right split)
- OPTION B: LEFT: Code, RIGHT: Annotations/callouts
- Use whichever fits Zillow template better

SCRIPT:
"These aren't checklists. Workflows have conditional logic that adapts to context. Iterative loops for systematic coverage. Validation gates for quality assurance.

[Pause as JSON scrolls or highlights appear]

These are sophisticated systems that respond to what they discover. Executable methodologies, not templates."

ENERGY: Technical but accessible
VISUAL: Dark IDE theme, yellow annotations/callouts
-->

---

<!-- _class: blue -->

## Bug Investigation in Action

**Watch for:**
- ✓ Conditional logic adapts to complexity
- ✓ Systematic hypothesis testing
- ✓ Validation gates ensure evidence

<!--
TIMING: 10:00-15:00 (5 minutes total for demo)
FORMAT: Screen recording with voiceover (no slides needed)

=== FULL DEMO SCRIPT (9:30-14:30) ===

--- INTRO (9:30-10:30, 60 seconds) ---
ON-CAMERA:
"Let me show you the bug investigation workflow in action.

[Pause]

This is perfect to demonstrate because everyone has experienced AI confidently jumping to the wrong conclusion. You've debugged based on assumptions that turned out to be completely wrong.

[Lean in slightly]

Watch what happens when we prevent that.

Pay attention to three things: how it adapts to complexity, how it systematically tests hypotheses, and how it requires evidence instead of guessing."

[Transition to screen recording]

--- PART 1: INITIALIZATION (10:30-11:30, 60 seconds) ---
SCREEN: Show fullscreen IDE with WorkRail bug investigation workflow starting
- Font 16-18px, clean terminal
- Show realistic bug scenario
- Add annotations in video editing (yellow text, arrows)

VOICEOVER:
[0:00-0:15 - minimal narration, let them watch]
"The agent requests its first step..."

[0:15-0:30]
"The workflow analyzes the bug. It's complex, so it selects the deep analysis path."

[0:30-0:50]
"Notice how it's gathering comprehensive information first. No jumping to conclusions. This is conditional branching in action—the workflow adapts to what it discovers about the problem."

[0:50-1:00]
[Brief pause, let them watch]

--- PART 2: HYPOTHESIS GENERATION (11:30-12:30, 60 seconds) ---
SCREEN: Show LLM generating multiple hypotheses (7-10 different possibilities)

VOICEOVER:
[0:00-0:15]
"Now watch the balance between creativity and structure."

[0:15-0:30]
"See how it generated seven different possibilities? That's the LLM bringing creativity. It's reasoning about what COULD cause this behavior."

[0:30-0:50]
"But notice—it can't move forward until it has at least three. That validation gate ensures thoroughness. No 'I think it's probably X'—we explore multiple angles."

[0:50-1:00]
[Brief pause]

--- PART 3: SYSTEMATIC TESTING (12:30-13:45, 75 seconds) ---
SCREEN: Show workflow testing each hypothesis with evidence gathering

VOICEOVER:
[0:00-0:20]
"Now it's testing the first hypothesis. Look—it's gathering actual evidence from logs. Not guessing. Not assuming."

[0:20-0:35]
"The workflow won't accept 'I think this is the issue.' It requires proof. Stack traces. Error messages. Reproduction steps."

[0:35-0:55]
"Hypothesis ruled out. Evidence says this isn't the cause. Without WorkRail, the LLM might have spent an hour refactoring based on this hunch. The workflow saved us from that rabbit hole."

[0:55-1:15]
"Now we're getting somewhere. Look at the evidence accumulating. Not 'maybe' or 'probably'—actual log entries, stack traces, timing data."

--- PART 4: CONCLUSION (13:45-14:30, 45 seconds) ---
SCREEN: Show final evidence-based conclusion with stack traces, logs, reproduction steps

VOICEOVER:
[0:00-0:15]
"There it is. Root cause identified with evidence: stack traces showing exactly where it fails, timing logs proving the sequence, reproduction steps that work every time."

[0:15-0:35]
"This isn't 'probably the cause'—it's 'definitely the cause, here's the proof.'"

[0:35-0:45]
"That's the difference between systematic investigation and confident guessing."

ANNOTATION: "Certainty with evidence, not confident guessing"

=== END DEMO RECORDING ===

ENERGY: Excited intro → Calm explanatory → Building engagement → Satisfied conclusion
VISUAL: Fullscreen IDE, yellow annotations/arrows, progress indicators
-->

---

## That's the Sweet Spot

✓ Workflow adapted to bug complexity  
✓ LLM generated creative hypotheses  
✓ Structure ensured systematic validation  
✓ Evidence-based certainty, not guessing

### Reliable excellence.

<!--
TIMING: 15:00-15:30 (30 seconds)
FORMAT: ON-CAMERA

SCRIPT:
"That's the sweet spot—creative reasoning plus systematic thoroughness.

[Pause]

The LLM brought the intelligence to generate hypotheses. The workflow ensured we didn't skip validation.

[Pause]

Together: reliable excellence.

[Pause, shift energy]

Those results were great..."

ENERGY: Satisfied → transitioning
VISUAL: Hand gesture - bring hands together on "together"
-->

---

## Team Impact

<div style="text-align: center; font-size: 1.6em; line-height: 1.8;">

**Before WorkRail:** 2.2/5  
**After WorkRail:** 4.2/5  
*Team satisfaction with AI tools*

**100%** would recommend

**~7 hours** saved per week

</div>

<!--
TIMING: 15:30-18:30 (3 minutes: 1 min slide + 2 min on-camera)
FORMAT: SLIDE + PIP (15:30-16:30) then ON-CAMERA (16:30-18:30)

LAYOUT:
- Centered, large text
- Three key stats with clear labels
- "Before/After WorkRail" makes context obvious

SLIDE VOICEOVER (15:00-16:00):
"Here's the impact.

[Pause, let first stat appear]

Before using WorkRail, my team rated their experience with AI coding assistants at two-point-two out of five. After using WorkRail, four-point-two. Nearly doubled.

[Pause, let second stat appear]

One hundred percent would recommend it to other teams.

[Pause, let third stat appear]

And they're saving about seven hours per week."

ON-CAMERA SCRIPT (16:00-17:30):
"Let me tell you about a friend of mine.

[Pause]

He'd been working on a bug. On and off. For over a month.

[Pause, show the weight of that]

Countless hours trying to figure out what was happening.

[Pause]

And people are hesitant to try WorkRail. Maybe fear of complexity. New tool. Or if they're confident with AI, they think they don't need it.

[Pause]

So out of exasperation, I physically added WorkRail to his VS Code config myself. Ran the bug investigation workflow with him.

[Pause, lean in]

Under twenty minutes.

[Pause]

Found it. Fixed it.

[Pause]

He was mind blown. He's been an avid user ever since.

[Pause]

Over a month... to under twenty minutes.

[Pause]

And here's the thing—it works regardless of platform. My team uses it for Android, iOS, and even non-coding work.

[Slight smile]

I literally used the presentation workflow to help create this talk.

[Small laugh]

Meta, right?

[More serious]

The methodology is platform-agnostic."

ENERGY: Data-driven → warm storytelling → playful → matter-of-fact
-->

---

## What the Team Says

> **"WorkRail is the literal 'rails' on which the AI workflow 'trains' run."**
>
> — Nikhil, Engineering Manager

> **"Having a competent developer by your side to bounce ideas and have them do the tedious work for you."**
>
> — Team Member

<!--
TIMING: 18:30-19:00 (30 seconds)
FORMAT: SLIDE with VOICEOVER

LAYOUT:
- Two quotes, stacked or side-by-side
- Clean typography, emphasized text
- Optional: small team photo or illustration

VOICEOVER:
"Here's how the team describes it.

[Pause, let first quote appear]

'WorkRail is the literal rails on which the AI workflow trains run.' That's from Nikhil, our engineering manager.

[Pause, let second quote appear]

And another teammate said: 'Having a competent developer by your side to bounce ideas and have them do the tedious work for you.'

[Pause]

That's the experience we're going for."

ENERGY: Warm, validating
-->

---

## The System

```
AI Agent ↔ MCP Protocol ↔ WorkRail ↔ Workflows
```

- Stateless (agent manages state)
- Step-by-step delivery
- Minimal overhead
- Resumable across sessions

**Details in Q&A**

<!--
TIMING: 19:00-20:00 (60 seconds)
FORMAT: SLIDE with VOICEOVER

SCRIPT:
"Quick architecture overview. WorkRail is an MCP server—Model Context Protocol. The agent requests steps, WorkRail delivers them with context.

Stateless design means horizontal scaling. Minimal overhead—WorkRail doesn't bloat your context. And workflows are resumable across sessions—when you hit token limits, you can continue in a fresh chat.

[Pause]

We can dive deeper in Q and A."

ENERGY: Technical but brief
-->

---

<!-- _class: blue -->

# Problem solved, right?

### But here's what I didn't expect...

<!--
TIMING: 20:00-20:45 (45 seconds)
FORMAT: ON-CAMERA - BUILD SUSPENSE

SCRIPT:
"Those results were great. My team had consistent, reliable AI assistance.

[Pause]

Problem solved, right?

[3 second pause, look thoughtful, slight head tilt]

But here's what I didn't expect when I built this...

[2 second pause]

Because the workflows produce consistent, reliable, methodical results—not random excellence, but reliable excellence—I can trust them to work while I focus elsewhere.

[Pause, lean in slightly]

Just Friday afternoon, I finished four separate tasks in parallel. Created a bunch of merge requests for them.

[Pause]

One used the bug investigation workflow—fixing flaky tests. The other three used the task development workflow.

[Pause]

Four tasks. One afternoon. All progressing simultaneously.

[Pause]

And this happens regularly.

[Pause]

Not babysitting. Actual parallel work.

[Pause]

Let me show you what I mean."

ENERGY: Satisfied → mysterious → building excitement → reveal hint
CRITICAL: Don't rush the pauses - this sets up the climax
MUSIC CUE: Build anticipation
-->

---

<!-- _class: blue -->

# 🎥 Real Productivity Multiplication

**[CUSTOM GRAPHIC: 3 IDE Windows Side-by-Side]**

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐
│ Bug Investigation│  │Feature Dev      │  │MR Review    │
│─────────────────│  │─────────────────│  │─────────────│
│Step 6/8:        │  │Step 4/12:       │  │Step 7/8:    │
│Testing hyp. 2...│  │Analyzing...     │  │Checking...  │
│████████░░ 75%   │  │████░░░░░░ 33%   │  │███████░ 88% │
└─────────────────┘  └─────────────────┘  └─────────────┘

                    9:47 AM
              All running simultaneously
```

<!--
TIMING: 20:45-23:00 (2 minutes 15 seconds) - THE MONEY SHOT

VOICEOVER WITH PRECISE TIMING:
[0:00-0:03]
[TOTAL SILENCE - let the visual appear and land]

[0:03-0:20]
"Three workflows. Bug investigation, feature development, merge request review. All running at the same time. All making real progress."

[0:20-0:35]
"Different git worktrees, different IDE windows, all executing WorkRail workflows simultaneously."

[0:35-0:55]
"I focused my attention on the feature development—that's where I needed to think, to make decisions, to write actual code."

[0:55-1:15]
"But these workflows were methodical enough, reliable enough, that I could trust them to work in the background. Not babysitting. Not checking in every two minutes. Real work, unattended."

[1:15-1:35]
"I've been doing this almost daily since I built WorkRail. Two, three, sometimes four workflows running simultaneously. Bug investigations, merge reviews, exploration tasks."

[1:35-1:55]
"While I'm writing code, one agent is tracking down a production issue. Another is reviewing a teammate's pull request. Another is exploring a new feature area."

[1:55-2:10]
"And when I finished my feature this morning, both other workflows had completed. With comprehensive results."

[2:10-2:15]
[Pause before next slide]

ENERGY: Start calm → building → emphatic on "real work" → matter-of-fact about daily use
CRITICAL: 3 seconds silence at start, "Not babysitting" emphasis, "I've been doing this almost daily" is key
VISUAL: This must be stunning - your signature moment
NOTE: Take actual screenshot of your 3 terminal windows running workflows!
-->

---

## The Result

✅ **My feature**: Completed with full context

✅ **Bug investigation**:  
10 hypotheses → 2 root causes  
(with stack traces, logs, reproduction steps)

✅ **MR review**:  
Comprehensive feedback ready  
(edge cases identified, patterns checked)

### Not just better results—MORE results.

<!--
TIMING: 23:00-23:30 (30 seconds)
FORMAT: SLIDE (or ON-CAMERA alternative)

VOICEOVER:
"The bug investigation had systematically tested ten hypotheses and narrowed it to two root causes—with stack traces, logs, reproduction steps.

[Pause]

The MR review had comprehensive feedback ready—edge cases identified, existing patterns checked.

[Longer pause]

Not just better results.

[Pause]

MORE results."

ENERGY: Building → EMPHATIC on "MORE results"
KEY: Break up final statement with pauses for impact
-->

---

<!-- _class: blue -->

# WorkRail is Open Source

**MIT License**  
**v0.6**  
**14 workflows ready to use**

### Structure + Creativity = Reliable Excellence

<!--
TIMING: 23:30-24:00 (30 seconds)
FORMAT: SLIDE with VOICEOVER

SCRIPT:
"WorkRail is open source. MIT license. Version zero-point-six.

Fourteen workflows ready to use or customize.

[Pause]

Structure plus creativity equals reliable excellence."

ENERGY: Generous, inviting
-->

---

## Get Started Today

### **github.com/exaudeus/workrail**
### **npm: @exaudeus/workrail**

**Start with:**
- **Bug Investigation** (prevents jumping to conclusions)
- **Task Development** (most popular with our team)
- **MR Review** (comprehensive feedback)

<!--
TIMING: 24:00-24:30 (30 seconds)
FORMAT: SLIDE + PIP

LAYOUT:
- LEFT: Large QR code for GitHub repo
- RIGHT: Text with URLs and starter workflows
- Makes scanning easy for audience

VOICEOVER:
"Find it on GitHub: github dot com slash exaudeus slash workrail. Or npm: at-exaudeus slash workrail.

Start with bug investigation if you want to prevent AI from jumping to conclusions. Task development is most popular with our team. Or M-R review for comprehensive feedback."

ENERGY: Helpful, actionable
VISUAL: QR code for easy scanning + short URLs
-->

---

## Platform-Agnostic

**Whether you're:**
- Debugging iOS memory leaks
- Optimizing Android performance
- Building React Native features
- Creating presentations (like this one!)

### The methodology works.

**Try it Monday.**

<!--
TIMING: 24:30-25:00 (30 seconds)
FORMAT: ON-CAMERA

SCRIPT:
"Whether you're debugging iOS memory leaks, optimizing Android performance, building React Native features, or even creating presentations like this one—it works.

[Pause]

The methodology is platform-agnostic.

[Pause, smile]

Try it Monday."

ENERGY: Warm, confident, inviting
-->

---

<!-- _class: blue -->

# Stop crafting perfect prompts.
# Start building perfect processes.

### Structure + Creativity = Reliable Excellence

<!--
TIMING: 25:00-25:20 (20 seconds)
FORMAT: SLIDE with VOICEOVER

SCRIPT:
"Stop crafting perfect prompts.

[Pause]

Start building perfect processes.

[Pause]

Structure plus creativity equals reliable excellence."

ENERGY: Strong, definitive - this is your tagline
-->

---

<!-- _class: blue -->

# Thanks for watching!

## Let's talk in Q&A

**github.com/exaudeus/workrail**

<!--
TIMING: 25:20-25:30 (10 seconds)
FORMAT: ON-CAMERA

SCRIPT:
"Thanks for watching.

[Smile]

Let's talk in Q and A!"

[Hold smile 2-3 seconds]

ENERGY: Friendly, excited for Q&A
VISUAL: Wave optional, genuine smile
-->

---

<!-- BACKUP SLIDES FOR Q&A -->

---

## WorkRail vs Cursor Composer / Agent Mode

<div class="columns">
<div>

### Cursor Composer
- Ad-hoc prompting
- Follow instructions
- No validation gates
- Resets on token limit

</div>
<div>

### WorkRail
- Codified methodology
- Adaptive behavior
- Validation enforcement
- Resumable workflows

</div>
</div>

**Key difference:** Composer does what you ask. WorkRail ensures *how* it's done properly.

---

## Cursor's Planning & Review?

<div class="columns">
<div>

### They're nice, but...
UI-wrapped prompts

**Each click:**
- Fresh generation
- No enforcement
- No methodology

*Macro, not workflow*

</div>
<div>

### WorkRail workflows:
Executable methodology

**Example:**
- Gather (gate)
- IF complex → deep
- Generate 3+ (gate)
- FOR EACH test (loop)

*Process, not prompt*

</div>
</div>

---

## Claude Code Sub-Agents?

<div class="columns">
<div>

### Sub-Agents
**Task delegation**

"Agent A: security"  
"Agent B: performance"  
"Agent C: types"

*Project manager*

</div>
<div>

### WorkRail
**Methodology**

"MUST check patterns"  
"IF complex → deep"  
"CANNOT skip evidence"

*Standard Operating Procedure*

</div>
</div>

**They complement!** WorkRail orchestrates sub-agents.  
**Workers + Blueprint**

---

## Why Not Just Prompts?

### I tried for 6 months:

❌ Static - no adaptation  
❌ No branching  
❌ No validation  
❌ Copy-paste hell

### WorkRail:

✅ Interactive  
✅ Conditional  
✅ Enforcing  
✅ Resumable

**That's why I built it.**

---

## When to Use What?

<div class="columns">
<div>

### Native IDE Tools
- One-off tasks
- Quick questions
- Exploration
- Simple generation

</div>
<div>

### WorkRail
- Proven methodology
- High-stakes work
- Team consistency
- Multi-session tasks

</div>
</div>

**Complementary, not competitive**

---

## Structure Elevates Creativity

### LLMs stay creative:
- Hypothesis generation
- Evidence analysis
- Solution design
- Pattern recognition

### Workflows constrain:
**Premature commitment**, not creativity

### The Jazz Metaphor:
Structure + Improvisation = Music, not chaos

**Evidence:** 2.2→4.2 satisfaction

---

## What's MCP?

### Model Context Protocol (MCP)

- Standard protocol for AI-tool communication
- JSON-RPC 2.0 over stdio
- Tools expose capabilities to agents
- Stateless by design

**Think:** REST API, but for AI agents

---

## When NOT to Use Workflows

<div class="columns">
<div>

### Good Fit:
✓ Repetitive tasks with proven methodology  
✓ Complex analysis requiring thoroughness  
✓ Team consistency matters  
✓ Codifying expertise

</div>
<div>

### Poor Fit:
❌ One-off exploratory tasks  
❌ Truly creative work with no structure  
❌ Simple Q&A  
❌ Flexibility > consistency

</div>
</div>

---

## Workflow JSON Example

```json
{
  "id": "bug-investigation",
  "name": "Systematic Bug Investigation",
  "steps": [
    {
      "id": "gather-context",
      "title": "Gather Context",
      "prompt": "Analyze the bug report...",
      "runCondition": {
        "var": "bugComplexity",
        "equals": "high"
      },
      "validationCriteria": [
        {
          "type": "contains",
          "value": "evidence"
        }
      ]
    }
  ]
}
```

---

## Team Adoption Strategy

### Start Small:

1. Pick one workflow (MR review works well)
2. One team member tries it
3. Share results in standup
4. Team adopts what works
5. Customize for your patterns

**Don't force it. Let results sell it.**

---

<!-- _class: blue -->

# Thank You

### **github.com/exaudeus/workrail**

**Structure + Creativity = Reliable Excellence**


