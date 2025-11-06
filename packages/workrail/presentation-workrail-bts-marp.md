---
marp: true
theme: default
paginate: true
backgroundColor: #fff
style: |
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  
  section {
    font-family: 'Inter', sans-serif;
    padding: 60px 128px;
    font-size: 28px;
  }
  
  h1 {
    font-size: 80px;
    font-weight: 700;
    margin-bottom: 60px;
    line-height: 1.1;
  }
  
  h2 {
    font-size: 56px;
    font-weight: 700;
    margin-bottom: 40px;
    line-height: 1.2;
  }
  
  h3 {
    font-size: 40px;
    font-weight: 700;
    margin-bottom: 30px;
  }
  
  section.blue {
    background-color: #0074E4;
    color: white;
  }
  section.blue h1, section.blue h2, section.blue h3 {
    color: white;
  }
  
  section.dark-blue {
    background-color: #004B95;
    color: white;
  }
  section.dark-blue h1, section.dark-blue h2, section.dark-blue h3 {
    color: white;
  }
  
  section.teal {
    background-color: #00A3AD;
    color: white;
  }
  section.teal h1, section.teal h2, section.teal h3 {
    color: white;
  }
  
  section.highlight {
    background-color: #7FD4DD;
    color: #111;
  }
  
  .columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 48px;
  }
  
  blockquote {
    font-size: 32px;
    font-style: normal;
    border-left: 6px solid #0074E4;
    padding-left: 30px;
    margin: 30px 0;
  }
  
  ul {
    font-size: 32px;
    line-height: 1.8;
  }
  
  strong {
    font-weight: 700;
  }
  
  section.blue strong {
    color: #7FD4DD;
  }
  
  .demo-placeholder {
    background-color: #f0f0f0;
    border: 3px dashed #0074E4;
    padding: 40px;
    border-radius: 12px;
    font-size: 22px;
    color: #333;
  }
---

<!-- _class: blue -->
# How WorkRail Puts AI on Rails for Consistent Results

## Etienne Bergeron
### Build Together Summit @ Zillow

---

<!-- _class: blue -->
# We've All Been Here

- Crafting the perfect prompt
- Still getting inconsistent results  
- Hallucinations and confident wrong answers
- More time fixing than saving

---

# The Real Problem

> "I'm losing more time than I'm gaining"  
> — Your teammate

The issue wasn't AI **capability**.  
It was AI **discipline**.

---

# My Journey

```text
Perfect Prompts     →  ❌ Still inconsistent

Manual Workflows    →  ↑ Better, but copy-paste hell

The Question...     →  💡
```

---

<!-- _class: blue -->

# The Insight

## What if the workflow could guide the agent step-by-step?

Instead of **ME** feeding context...  
The **WORKFLOW** asks the questions.

---

# Structure Doesn't Limit AI—It Elevates It

**Traditional:**  
You → Prompt → AI = **Random excellence**

**WorkRail:**  
You → Workflow → AI = **Reliable excellence**

---

# Structure + Creativity = Reliable Excellence

**Structure** ensures thoroughness  
**LLM** brings creative reasoning

Together: **Reliable excellence**

---

<!-- _class: blue -->
# Let Me Show You

## Bug Investigation Workflow
### Real methodology, real results

---

# Bug Investigation in Action

## Watch for:

✓ Conditional logic adapts to complexity  
✓ Systematic hypothesis testing  
✓ Validation gates ensure evidence

---

<!-- _class: teal -->

# Demo: Workflow Start

<div class="demo-placeholder">

## 🎬 SCREEN RECORDING 1 (60 seconds)

### IDE showing Bug Investigation workflow starting

**What you'll see:**
- Agent requests first step from WorkRail
- Workflow analyzes complexity → selects "Deep Analysis" path
- Agent begins gathering context systematically
- **No jumping to conclusions**

**Key annotations:**
- "Step 1/8: Understanding the bug"
- "Workflow adapts to complexity"
- "Notice: No conclusions yet"

</div>

---

<!-- _class: teal -->

# Demo: Systematic Testing

<div class="demo-placeholder">

## 🎬 SCREEN RECORDING 2 (90 seconds)

### IDE showing hypothesis testing loop

**What you'll see:**
- LLM generates 3 creative hypotheses
- Workflow enforces systematic testing
- Loop iterates through hypotheses
- Validation gates require actual proof
- Hypothesis 1 **confirmed** ✓ / Hypothesis 3 **ruled out** ❌

**Key annotations:**
- "Step 4/8: Generate hypotheses (LLM creativity)"
- "Step 5/8: Test systematically (workflow structure)"
- "Creativity + Structure"

</div>

---

<!-- _class: teal -->

# Demo: The Result

<div class="demo-placeholder">

## 🎬 SCREEN RECORDING 3 (30 seconds)

### IDE showing final investigation results

**ROOT CAUSE:** Race condition in cache invalidation  
**LOCATION:** CacheManager.ts:247  
**EVIDENCE:**
- Stack traces (47 instances → line 247)
- Timing logs (50ms window, too small for lock)
- Load test (100% reproducible)

**CONFIDENCE:** 95% - High certainty

## Not "probably" → "Definitely, here's why"

</div>

---

# What Just Happened?

✓ Workflow adapted to bug complexity  
✓ LLM generated creative hypotheses  
✓ Structure ensured systematic validation  
✓ Evidence-based certainty, not guessing

## Reliable excellence.

---

# The System

```text
AI Agent ↔ MCP Protocol ↔ WorkRail ↔ Workflows
```

- Stateless (agent manages state)
- Step-by-step delivery
- Context optimization (60-80% reduction)
- Resumable across sessions

---

# What's in a Workflow?

## Not checklists. Executable methodologies:

- Conditional branching (adapt to context)
- Iterative loops (systematic coverage)
- Validation gates (quality assurance)
- Meta-guidance (strategic thinking)
- Agent roles (perspective shifts)

### These are systems that respond to what they discover.

---

# Team Impact

## Before → After

**Before:**
- ❌ Inconsistent results  
- ⏰ Wasting time  
- 😤 Ready to quit

**After:**
- ✅ Daily users  
- 🎯 Consistent quality  
- 😊 Team loves it

**Most popular workflows:** Task development, debugging, MR reviews

---

<!-- _class: blue -->
# Problem solved, right?

&nbsp;

&nbsp;

## But here's what I didn't expect...

---

# The Unexpected Benefit

Because workflows are consistent, reliable, methodical...

## I can trust them to work unattended.

&nbsp;

**This changed everything.**

---

<!-- _class: highlight -->
# Real Productivity Multiplication

## Three Workflows Running Simultaneously

**🐛 Bug Investigation** - Step 6/8: Testing hypothesis 2... ████████░░ 75%

**⚡ Feature Development** - Step 4/12: Examining patterns... ████░░░░░░ 33%

**📋 MR Review** - Step 7/8: Checking edge cases... ███████░░░ 88%

---

### ⏰ 9:47 AM — All running at the same time

**This is true productivity multiplication.**

---

# The Result

**My feature:** ✓ Completed with full context

**Bug investigation:** ✓  
Ten hypotheses narrowed to two root causes  
With evidence: stack traces, logs, reproduction steps

**MR review:** ✓  
Comprehensive feedback ready for teammate  
Edge cases identified, patterns checked

## Not just better results—MORE results.

---

<!-- _class: blue -->

# WorkRail is Open Source

**MIT License**  
**v0.6.1-beta**  
**14 workflows ready to use**

## Structure + Creativity = Reliable Excellence

---

# Get Started Today

## github.com/exaudeus/workrail
## npm: @exaudeus/workrail

**Start with:**
- **Bug Investigation** (prevents jumping to conclusions)
- **MR Review** (team favorite)
- **Task Development** (comprehensive approach)

---

# What You'll Discover

- When workflows help (vs. when they're overkill)
- How to customize for YOUR team
- Ways to codify YOUR expertise
- The sweet spot: **Structure + Creativity**

---

<!-- _class: blue -->
# Let's answer some questions!

**Coming up in Q&A:**
- Writing custom workflows
- MCP protocol deep dive  
- Team adoption strategies
- Architecture details

---
<!-- BACKUP SLIDES FOR Q&A -->

---

# What's MCP?

## Model Context Protocol (MCP)

- Standard protocol for AI-tool communication
- JSON-RPC 2.0 over stdio
- Tools expose capabilities to agents
- Stateless by design

**Think:** REST API, but for AI agents

---

# When NOT to Use Workflows

**Good Fit:**
- ✓ Repetitive tasks with proven methodology
- ✓ Complex analysis requiring thoroughness
- ✓ Team consistency matters
- ✓ Codifying expertise

**Poor Fit:**
- ❌ One-off exploratory tasks
- ❌ Pure creative work with no structure
- ❌ Simple Q&A
- ❌ When flexibility > consistency

---

# Workflow JSON Example

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
      }
    }
  ]
}
```

---

# Team Adoption Strategy

## Start Small:
1. Pick one workflow (MR review works well)
2. One team member tries it
3. Share results in standup
4. Team adopts what works
5. Customize for your patterns

**Don't force it. Let results sell it.**

---

<!-- _class: blue -->
# Thank You

## github.com/exaudeus/workrail

**Structure + Creativity = Reliable Excellence**
