# Subagent Design Principles & Catalog

## Overview

This document defines WorkRail's approach to subagent design for agentic IDEs. It outlines the core principles, patterns, and catalog of specialized subagents that enhance WorkRail workflows.

**Philosophy:** Subagents are **specialized cognitive functions**, not task owners. They execute complete, autonomous routines and return structured deliverables to the main agent orchestrator.

---

## Core Principles

### 1. **Cognitive Specialization, Not Task Ownership**

** Good:** "Context Researcher" - Specializes in deep reading and systematic exploration
** Bad:** "Debugger" - Too broad, owns entire debugging workflow

**Rule:** Subagents should embody a **specific cognitive mode** (exploration, challenge, verification) that can be applied across many workflows, not own a complete workflow themselves.

### 2. **Stateless & Self-Contained**

Each subagent invocation is independent:
- **No memory** between calls
- **No conversational refinement**
- **No follow-up questions**

**Implication:** The main agent must provide **all necessary context upfront** in a single, complete work package.

**Pattern:**
```
Main Agent → Subagent: [Complete Context Package]
Subagent: [Autonomous Execution]
Subagent → Main Agent: [Structured Deliverable]
```

### 3. **Autonomous Routine Execution**

Subagents execute **complete routines** from start to finish:
- Receive: Self-contained work package with all context
- Execute: Multi-step routine autonomously
- Return: Named, structured artifact (e.g., `ExecutionFlow.md`)

**Not this:** Iterative back-and-forth, gradual context building, conversational refinement.

### 4. **Depth-Aware Investigation**

For research/exploration tasks, subagents support **configurable depth levels** to balance speed vs thoroughness:

| Level | Name | Time | Use Case |
|-------|------|------|----------|
| 0 | Survey | 1-2 min | "What exists here?" |
| 1 | Scan | 5-10 min | "What are the major components?" |
| 2 | Explore | 15-30 min | "What does each component do?" |
| 3 | Analyze | 30-60 min | "How does this specific logic work?" |
| 4 | Dissect | 60+ min | "What is every line doing?" |

Main agent chooses depth based on uncertainty and importance.

### 5. **Structured Deliverables**

Every subagent routine produces a **named artifact** with a **consistent structure**:

**Standard Output Format:**
```markdown
### Summary (3-5 bullets)
- Key findings

### Detailed Findings
- Component breakdowns
- File citations (file:line)

### Suspicious Points / Concerns / Gaps
- What could be problematic
- What couldn't be determined

### Recommendations
- What main agent should do next
```

**Deliverable Quality Gates:**

Main agent validates each deliverable against these criteria:
-  **Completeness**: All required sections present
-  **Citations**: File:line references for all findings
-  **Gaps Section**: Explicit about limitations and unknowns
-  **Actionability**: Clear next steps or recommendations

**If a deliverable fails quality gates**, the main agent should:
1. Note the gaps in the workflow context
2. Decide if the partial deliverable is sufficient
3. Optionally re-run with clarified context (not automatic)

**Artifact Naming Convention:** Use kebab-case for filenames:
- `execution-flow.md`
- `hypothesis-challenges.md`
- `plan-analysis.md`

### 6. **Explicit Over Implicit**

While agentic IDEs support auto-invocation (system picks subagent based on task description), **WorkRail workflows use explicit delegation**:

```
Use: task(subagent_type="context-researcher", prompt="...")
Not: "Hey, someone gather context for me" (auto-invoke)
```

**Rationale:** Predictability, debuggability, user understanding.

### 7. **Auditor Model: Review, Don't Execute**

**Key Discovery:** Subagents work better as **auditors** than **executors**.

** Executor Model (Problematic):**
```
Main Agent: "Go gather context about authentication"
Subagent: *reads files, builds understanding*
Problem: Main agent doesn't have the context, needs to re-read
```

** Auditor Model (Effective):**
```
Main Agent: *reads files, builds understanding*
Main Agent: "I read these files and learned X. Audit my work."
Subagent: "You missed Y, assumption Z is risky, go deeper on W"
Main Agent: *investigates gaps*
Result: Main agent has full context + quality control
```

**Why Auditors Work Better:**
- **No dilution**: Main agent has full, uncompressed context
- **No duplication**: Main agent doesn't need to re-read what subagent read
- **Fresh perspective**: Auditor catches gaps and blind spots
- **Quality control**: Ensures sufficient understanding before proceeding
- **Cognitive diversity**: Different perspective on the same work

**When to Use Auditors:**
- Context gathering (audit for completeness and depth)
- Hypothesis formation (challenge assumptions)
- Plan creation (validate completeness and soundness)
- Final validation (adversarial review before committing)

**When Executors Still Make Sense:**
- Simulation (running "what-if" scenarios in parallel)
- Independent parallel work (different execution paths)
- Specialized tasks main agent can't do well

### 8. **Parallel Delegation for Critical Work**

**Pattern:** Spawn multiple subagents **simultaneously** for critical phases to get diverse perspectives and ensure nothing is missed.

**Explicit Parallelism:**
```
 **CRITICAL: Spawn ALL subagents SIMULTANEOUSLY, not sequentially.**

Delegate to THREE subagents AT THE SAME TIME:
1. [Subagent 1 with specific focus]
2. [Subagent 2 with different focus]
3. [Subagent 3 with different focus]
```

**Use Cases:**

**1. Multi-Perspective Auditing (Diverse Focuses)**
```
Main agent gathers context
↓
Parallel Audit (2-3 subagents):
├─ Context Researcher (FOCUS: Completeness)
├─ Context Researcher (FOCUS: Depth)
└─ [Optional 3rd perspective]

Main agent synthesizes all perspectives
```

**2. Redundant Critical Work (Different Rigor)**
```
Main agent forms hypotheses
↓
Parallel Challenge (2 subagents):
├─ Hypothesis Challenger (rigor=3: Thorough)
└─ Hypothesis Challenger (rigor=5: Maximum)

Main agent strengthens hypotheses based on challenges
```

**3. Multi-Modal Validation (Different Cognitive Modes)**
```
Main agent proposes fix
↓
Parallel Validation (3 subagents):
├─ Hypothesis Challenger (adversarial review)
├─ Execution Simulator (simulate the fix)
└─ Plan Analyzer (validate the plan)

Main agent proceeds only if ALL THREE validate
```

**Synthesis Guidance:**

When main agent receives multiple parallel deliverables:
- **Common concerns**: If 2+ subagents flag the same issue → High priority
- **Unique insights**: Each subagent may catch different gaps → Investigate all
- **Conflicting advice**: If they disagree → Investigate to understand why
- **Quality gate**: For critical phases, require ALL subagents to validate

**Cost/Speed Tradeoff:**
- Parallel = faster wall time but higher token cost
- Use for critical phases where quality matters most
- Use for phases where diverse perspectives add value

### 9. **Focused Audits for Parallel Work**

When spawning multiple auditors in parallel, give each a **specific focus** to maximize diversity and minimize overlap.

**Pattern:**
```
Subagent 1: FOCUS = Completeness
- Priority: Did they miss any critical areas?
- Still checks other dimensions, but emphasizes coverage
```
