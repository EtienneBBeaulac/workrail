# WorkRail Subagent Configurations

This directory contains reference configurations for a universal workflow executor designed to work with WorkRail workflows in agentic IDEs.

## Quick Start

### For Firebender Users

1. Copy the universal WorkRail executor to your Firebender agents directory:
   ```bash
   cp firebender/workrail-executor.md ~/.firebender/agents/
   ```

2. Register it in your `firebender.json`:
   ```json
   {
     "subagents": [
       "~/.firebender/agents/workrail-executor.md"
     ]
   }
   ```

3. **Important:** The executor uses **tool inheritance** (no `tools` field), so it will have access to all tools including WorkRail by default.

### For Other IDEs

Check `docs/integrations/` for IDE-specific setup guides.

---

## Universal Executor Architecture

### **One Subagent, Many Roles**

Instead of multiple specialized subagents (context-researcher, hypothesis-challenger, etc.), WorkRail uses a **single universal executor** that executes any WorkRail workflow.

**Key Insight:** The workflows already define the cognitive function - we don't need to duplicate that in subagent configs.

### **How It Works**

```
Main Agent
  ↓ delegates with workflow name
Universal WorkRail Executor
  ↓ loads and executes
Context Gathering Routine (workflow defines the role)
  ↓ returns
Structured deliverable
```

The executor's role changes based on which workflow it's executing:
- **Context Gathering Routine** → Acts as systematic researcher
- **Hypothesis Challenge Routine** → Acts as adversarial critic
- **Ideation Routine** → Acts as divergent thinker
- **Plan Analysis Routine** → Acts as completeness validator
- **Execution Simulation Routine** → Acts as mental tracer
- **Feature Implementation Routine** → Acts as precise builder

### **Benefits**

1. **Single Source of Truth** - Workflows define behavior, not subagent configs
2. **No Duplication** - Don't repeat role/behavior in two places
3. **Easier to Extend** - Add new routines without creating new subagents
4. **Simpler Installation** - Users install 1 file, not 6+
5. **WorkRail Controls Everything** - The MCP owns the behavior completely

---

## Available Workflows (Routines)
**Cognitive Function:** Deep reading, systematic exploration, execution tracing

**Use When:**
- "I need to understand how this code works"
- "Map the structure of this system"
- "Trace execution from X to Y"

**Depth Levels:** 0-4 (Survey → Dissect)

**Routine:** `routine-context-gathering`

**Model:** Sonnet (depth 2+), Haiku (depth 0-1)

---

#### **2. Hypothesis Challenger** (`hypothesis-challenger.md`)
**Cognitive Function:** Adversarial reasoning, finding holes, edge case identification

**Use When:**
- "Challenge my assumptions"
- "Find holes in this hypothesis"
- "What could go wrong with this approach?"

**Rigor Levels:** 1, 3, 5 (Surface → Maximum Skepticism)

**Routine:** `routine-hypothesis-challenge`

**Model:** Sonnet (rigor 3+), Haiku (rigor 1)

---

#### **3. Plan Analyzer** (`plan-analyzer.md`)
**Cognitive Function:** Plan validation, completeness checking, pattern adherence

**Use When:**
- "Review this implementation plan"
- "Does this plan follow our patterns?"
- "What's missing from this approach?"

**Routine:** `routine-plan-analysis`

**Model:** Sonnet (requires judgment)

---

#### **4. Execution Simulator** (`execution-simulator.md`)
**Cognitive Function:** Mental execution, step-by-step tracing, state tracking

**Use When:**
- "Trace what happens when I call this with X"
- "What's the state after these steps?"
- "Simulate this execution path"

**Routine:** `routine-execution-simulation`

**Model:** Sonnet (requires careful reasoning)

---

#### **5. Ideator** (`ideator.md`)
**Cognitive Function:** Divergent thinking, possibility generation, creative exploration

**Use When:**
- "Generate multiple approaches to solve this problem"
- "What are different ways to implement this feature?"
- "Brainstorm alternative architectures"

**Perspectives:** Simplicity, Performance, Maintainability, Security, Innovation, Pragmatic

**Routine:** `routine-ideation`

**Model:** Haiku (simple perspectives), Sonnet (complex perspectives)

**Parallel Pattern:** Spawn multiple ideators with different perspectives simultaneously for diverse solution spaces.

---

#### **6. Builder** (`builder.md`)
**Cognitive Function:** Precise implementation, pattern adherence, incremental development

**Use When:**
- "Implement this feature according to the plan"
- "I have a detailed spec, need it coded"
- "Reduce my context load during implementation"

**Routine:** `routine-feature-implementation`

**Model:** Sonnet (requires judgment)

---

## Available Workflows (Routines)

The WorkRail Executor can execute any of these workflows. Each workflow defines a specific cognitive function.

### **1. Context Gathering Routine**
**Workflow Name:** `Context Gathering Routine` or `routine-context-gathering`

**Cognitive Function:** Systematic researcher exploring codebases

**Parameters:**
- `depth` (0-4): Survey, Scan, Explore, Analyze, Dissect  
- `mode`: `gather` (explore new code) or `audit` (review existing investigation)

**When to Use:**
- "I need to understand how X works"
- "Map the structure of this system"
- "Audit my context gathering for completeness"

---

### **2. Hypothesis Challenge Routine**
**Workflow Name:** `Hypothesis Challenge Routine` or `routine-hypothesis-challenge`

**Cognitive Function:** Adversarial reasoner finding holes and edge cases

**Parameters:**
- `rigor` (1, 3, 5): Surface, Thorough, Maximum skepticism

**When to Use:**
- "Challenge my assumptions"
- "Find holes in this hypothesis"
- "What could go wrong with this approach?"

---

### **3. Ideation Routine**
**Workflow Name:** `Ideation Routine` or `routine-ideation`

**Cognitive Function:** Divergent thinker generating diverse ideas

**Parameters:**
- `perspective`: simplicity, performance, maintainability, security, innovation, pragmatic
- `quantity`: Number of ideas to generate (typically 5-10)

**When to Use:**
- "Generate multiple approaches to solve this"
- "What are different ways to implement X?"
- "Brainstorm alternative architectures"

**Parallel Pattern:** Spawn multiple executors with different perspectives to explore diverse solution spaces.

---

### **4. Plan Analysis Routine**
**Workflow Name:** `Plan Analysis Routine` or `routine-plan-analysis`

**Cognitive Function:** Completeness validator checking pattern adherence

**When to Use:**
- "Review this implementation plan"
- "Does this plan follow our patterns?"
- "What's missing from this approach?"

---

### **5. Execution Simulation Routine**
**Workflow Name:** `Execution Simulation Routine` or `routine-execution-simulation`

**Cognitive Function:** Mental tracer simulating code execution

**Parameters:**
- `mode`: trace, predict, validate

**When to Use:**
- "Trace what happens when I call this with X"
- "What's the state after these steps?"
- "Simulate this execution path"

---

### **6. Feature Implementation Routine**
**Workflow Name:** `Feature Implementation Routine` or `routine-feature-implementation`

**Cognitive Function:** Precise implementer following plans and patterns

**When to Use:**
- "Implement this feature according to the plan"
- "I have a detailed spec, need it coded"
- "Reduce my context load during implementation"

---

## How the Executor Works

## How the Executor Works

### **Stateless Execution**
Each invocation is independent with no memory between calls. The main agent must provide all necessary context upfront in a complete "work package."

### **Autonomous Operation**
The executor works through the entire workflow from start to finish. It doesn't ask follow-up questions or iterate—it completes the routine autonomously and returns a structured deliverable.

### **Structured Deliverables**
Every execution returns a named artifact (e.g., `context-map.md`, `hypothesis-challenges.md`) with a consistent structure: Summary, Detailed Findings, Gaps, Recommendations.

### **Dynamic Role**
The executor's cognitive function changes based on the workflow it's executing. It doesn't have a fixed identity—the workflow defines who it becomes for that task.

---

## Delegation Pattern

### **Complete Work Package**

When delegating to the WorkRail Executor, provide everything upfront:

```
task(subagent_type="workrail-executor", prompt="
  Execute the 'Context Gathering Routine' workflow at depth=2.
  
  Work Package:
  MISSION: Understand how user authentication works
  TARGET: src/auth/middleware/auth.ts, src/auth/services/auth-service.ts
  CONTEXT:
    - Bug: Valid tokens rejected in production
    - Previous Finding: AuthService identified as likely location
    - Constraint: Focus on validateToken flow
  DELIVERABLE: context-map.md with component structure and execution flow
")
```

The executor will:
1. Load the specified workflow
2. Execute all steps autonomously
3. Return the deliverable

---

## Customization

### **Adjusting Tool Access**

If you need to restrict tools (instead of inheriting all), add a `tools` array to the YAML frontmatter in `workrail-executor.md`:

```yaml
---
name: workrail-executor
tools:
  - read_file
  - grep_search
  - codebase_search
  - workflow_list
  - workflow_get
  - workflow_next
  # Restricts to read-only + workflow tools
---
```

### **Adjusting Model**

To use a specific model instead of inheriting from the main agent:

```yaml
---
name: workrail-executor
model: claude-sonnet-4
---
```

Or for cost savings on simple tasks:

```yaml
---
name: workrail-executor  
model: claude-haiku-4
---
```

**Note:** Different workflows have different complexity requirements. Sonnet is recommended for most routines.

---

## Workflows Using the Executor

Agentic workflows (`.agentic.json`) guide the main agent through strategic delegation points. These workflows include prompts that tell the main agent when and how to delegate to the WorkRail Executor.

**Current Agentic Workflows:**
- `bug-investigation.agentic.json` - Adaptive bug investigation with context gathering, hypothesis challenge, ideation, and validation

**To enable agentic workflows:**
```bash
export WORKRAIL_ENABLE_AGENTIC_ROUTINES=true
```

---

## Best Practices

### **1. Use the Universal Executor**
Don't create multiple specialized subagent configs. The universal executor can handle all workflows - the workflow defines the role.

### **2. Provide Complete Work Packages**
Give the executor everything it needs upfront:
- **Workflow**: Which routine to execute (by name)
- **Parameters**: Workflow-specific (depth, rigor, perspective, etc.)
- **Mission**: What to accomplish
- **Target**: What to analyze
- **Context**: Background, constraints, prior work
- **Deliverable**: What artifact to create

### **3. Let Workflows Guide Delegation**
Use agentic workflows (`.agentic.json`) that include delegation instructions. They provide the optimal delegation patterns.

### **4. Validate Deliverables**
Review executor output against the quality gates defined in the workflow. The executor documents gaps and assumptions - check these carefully.
- ✅ All required sections present?
- ✅ File:line citations included?
- ✅ Gaps explicitly noted?
- ✅ Recommendations actionable?

### **5. Main Agent Stays in Control**
Subagents execute tasks, but the main agent makes all strategic decisions and owns the outcome.

---

## Troubleshooting

### **"Subagent isn't using WorkRail tools"**
- Check that the subagent config doesn't have a `tools` array that excludes WorkRail tools
- If using explicit `tools`, add: `workflow_list`, `workflow_get`, `workflow_next`
- Run the diagnostic workflow: `workflow-diagnose-environment`

### **"Subagent output is incomplete"**
- Check the delegation prompt—did you provide all required context?
- Verify the depth/rigor level is appropriate for the task
- Review the subagent's "Gaps" section—did it note why it couldn't complete?

### **"How do I know which depth/rigor level to use?"**
- Start with middle levels (depth=2, rigor=3)
- If output is insufficient, go deeper
- If output is too detailed/slow, go shallower
- See subagent configs for level descriptions

---

## Documentation

- **Design Principles:** `docs/architecture/subagent-design-principles.md`
- **Cascade Protocol:** `docs/architecture/agent-cascade-protocol.md`
- **Firebender Integration:** `docs/integrations/firebender.md`
- **Roadmap:** `docs/plans/agentic-orchestration-roadmap.md`

---

## Support

Questions or issues? Open an issue on GitHub or check the WorkRail documentation.

Happy delegating! 🚀

