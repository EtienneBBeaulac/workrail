---
marp: true
theme: default
paginate: true
backgroundColor: #fff
style: |
  section.blue {
    background-color: #003366;
    color: white;
  }
  section.blue h1, section.blue h2 {
    color: white;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
---

<!-- _class: blue -->

# How WorkRail Puts AI on Rails for Consistent Results

**Build Together Summit @ Zillow**  
Mobile Track

Duration: 25 minutes (22 min content + 3 min Q&A)

<!-- 
TIMING: 0:00-0:45 
FORMAT: YOU ON CAMERA
-->

---

<!-- _class: blue -->

## WHETHER YOU'RE WRITING

**Swift, Kotlin, JavaScript, or PowerPoint slides...**

🍎 iOS • 🤖 Android • ⚛️ React Native • 🦋 Flutter • 💻 VS Code

### We all face the same AI inconsistency problem

<!-- TIMING: 0:45-1:30 -->

---

## We've All Been Here

- Crafting the perfect prompt
- Getting inconsistent results  
- AI confidently giving wrong answers
- More time fixing than saving

<!-- TIMING: 1:30-2:00 -->

---

## The Real Problem

> **"I'm losing more time than I'm gaining"**
> 
> — Your teammate (probably)

**The issue wasn't AI capability.**  
**It was AI *discipline*.**

<!-- TIMING: 2:00-3:00 -->

---

## My Journey

```
Perfect Prompts     →  ❌ Still inconsistent

Manual Workflows    →  ↑ Better, but copy-paste hell

The Question...     →  💡
```

<!-- TIMING: 3:00-4:00 -->

---

<!-- _class: blue -->

## The Insight

### What if the workflow could guide the agent step-by-step?

**Instead of ME feeding context...**  
**The WORKFLOW asks the questions.**

<!-- TIMING: 4:00-5:00 -->

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

<!-- TIMING: 5:00-7:00 -->

---

## Not Checklists—Executable Methodologies

```json
{
  "id": "bug-investigation",
  "steps": [
    {
      "runCondition": {
        "var": "complexity",
        "in": ["medium", "high"]
      }
    },
    {
      "type": "loop",
      "loop": {
        "type": "forEach",
        "items": "${hypotheses}"
      }
    },
    {
      "validationCriteria": [
        {"type": "contains", "value": "evidence"}
      ]
    }
  ]
}
```

<!-- TIMING: 7:00-7:30 -->

---

<!-- _class: blue -->

## Bug Investigation in Action

**Watch for:**
- ✓ Conditional logic adapts to complexity
- ✓ Systematic hypothesis testing
- ✓ Validation gates ensure evidence

<!-- TIMING: 7:30-8:45 -->

---

## Demo: Workflow Initialization

**[Fullscreen IDE Recording]**

- Agent requests workflow_next
- Analyzing bug complexity... **COMPLEX**
- Deep analysis path selected ✓
- Step 1/8: Understanding the problem
- Gathering context systematically...
- Notice: No conclusions yet, just evidence

<!-- TIMING: 8:45-10:30 -->

---

## Demo: Hypothesis Generation

**[Fullscreen IDE Recording]**

Step 4/8: Generate hypotheses

1. Could be race condition in cache...
2. Possible memory leak in...
3. Timing issue with async...
4. Database connection pool...
5. Network timeout...
6. State management bug...
7. Thread safety issue...

**7 hypotheses generated**

<!-- TIMING: 10:30-11:30 -->

---

## Demo: Systematic Testing

**[Fullscreen IDE Recording]**

- Hypothesis 1: Testing with logs... ✓ **CONFIRMED**
- Hypothesis 2: Checking timing... ⚠ **NEEDS MORE DATA**
- Hypothesis 3: Code paths... ✗ **RULED OUT**

**Validation gate: Evidence required** ✓

<!-- TIMING: 11:30-13:30 -->

---

## Demo: Evidence-Based Conclusion

**[Fullscreen IDE Recording]**

**ROOT CAUSE IDENTIFIED:**  
Race condition in cache invalidation

**EVIDENCE:**
- ✓ Stack trace: [detailed trace]
- ✓ Timing logs: [timing data]
- ✓ Reproduction steps: [clear steps]

**Confidence: HIGH** (based on evidence)

<!-- TIMING: 13:30-14:30 -->

---

## That's the Sweet Spot

✓ Workflow adapted to bug complexity  
✓ LLM generated creative hypotheses  
✓ Structure ensured systematic validation  
✓ Evidence-based certainty, not guessing

### Reliable excellence.

<!-- TIMING: 14:30-15:00 -->

---

## Team Impact

<div class="columns">
<div>

### Before:
- ❌ Inconsistent results
- ⏰ Wasting time
- 😤 Ready to quit

</div>
<div>

### After:
- ✅ Daily users
- 🎯 Consistent quality  
- 😊 Team loves it

</div>
</div>

**Most Popular**: Task dev, debugging, MR reviews

<!-- TIMING: 15:00-16:30 -->

---

## The System

```
AI Agent ↔ MCP Protocol ↔ WorkRail ↔ Workflows
```

- Stateless (agent manages state)
- Step-by-step delivery
- Context optimization (60-80% reduction)
- Resumable across sessions

**Details in Q&A**

<!-- TIMING: 16:30-17:30 -->

---

<!-- _class: blue -->

# Problem solved, right?

### But here's what I didn't expect...

<!-- TIMING: 17:30-18:00 -->

---

<!-- _class: blue -->

# Real Productivity Multiplication

**[3 IDE Windows Side-by-Side]**

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

<!-- TIMING: 18:00-19:30 - THE MONEY SHOT -->

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

<!-- TIMING: 19:30-20:00 -->

---

<!-- _class: blue -->

# WorkRail is Open Source

**MIT License**  
**v0.6.1-beta**  
**14 workflows ready to use**

### Structure + Creativity = Reliable Excellence

<!-- TIMING: 20:00-20:30 -->

---

## Get Started Today

### **github.com/exaudeus/workrail**
### **npm: @exaudeus/workrail**

**Start with:**
- **Bug Investigation** (prevents jumping to conclusions)
- **MR Review** (team favorite)
- **Task Development** (comprehensive approach)

<!-- TIMING: 20:30-21:00 -->

---

## Platform-Agnostic

**Whether you're:**
- Debugging iOS memory leaks
- Optimizing Android performance
- Building React Native features
- Creating presentations (like this one!)

### The methodology works.

**Try it Monday.**

<!-- TIMING: 21:00-21:30 -->

---

<!-- _class: blue -->

# Stop crafting perfect prompts.
# Start building perfect processes.

### Structure + Creativity = Reliable Excellence

<!-- TIMING: 21:30-21:50 -->

---

<!-- _class: blue -->

# Thanks for watching!

## Let's talk in Q&A

**github.com/exaudeus/workrail**

<!-- TIMING: 21:50-22:00 -->

---

## Backup: What's MCP?

### Model Context Protocol (MCP)

- Standard protocol for AI-tool communication
- JSON-RPC 2.0 over stdio
- Tools expose capabilities to agents
- Stateless by design

**Think:** REST API, but for AI agents

---

## Backup: When NOT to Use Workflows

<div class="columns">
<div>

### Good Fit:
✓ Repetitive tasks  
✓ Complex analysis  
✓ Team consistency  
✓ Codifying expertise

</div>
<div>

### Poor Fit:
❌ One-off tasks  
❌ Purely creative work  
❌ Simple Q&A  
❌ Flexibility > consistency

</div>
</div>

---

## Backup: Team Adoption Strategy

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


