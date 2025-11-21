# WorkRail Subagent Configurations

This directory contains reference configurations for specialized subagents designed to work with WorkRail workflows in agentic IDEs.

## Quick Start

### For Firebender Users

1. Copy the subagent `.md` files you want to use to your Firebender agents directory:
   ```bash
   cp firebender/*.md ~/.firebender/agents/
   ```

2. Register them in your `firebender.json`:
   ```json
   {
     "subagents": [
       "~/.firebender/agents/context-researcher.md",
       "~/.firebender/agents/hypothesis-challenger.md",
       "~/.firebender/agents/plan-analyzer.md",
       "~/.firebender/agents/execution-simulator.md",
       "~/.firebender/agents/ideator.md",
       "~/.firebender/agents/builder.md"
     ]
   }
   ```

3. **Important:** These configs use **tool inheritance** (no `tools` field), so subagents will have access to all tools including WorkRail by default. If you need to restrict tools, add a `tools` array to the YAML frontmatter.

### For Other IDEs

Check `docs/integrations/` for IDE-specific setup guides.

---

## Available Subagents

### **Core 6 (Tier 1) - Recommended for Phase 1**

These 6 subagents cover the primary cognitive functions needed across debugging, planning, and implementation workflows.

#### **1. Context Researcher** (`context-researcher.md`)
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

## How Subagents Work

### **Stateless Execution**
Each subagent invocation is independent with no memory between calls. The main agent must provide all necessary context upfront in a complete "work package."

### **Autonomous Routines**
Subagents execute complete routines from start to finish. They don't ask follow-up questions or iterate—they work autonomously and return structured deliverables.

### **Structured Deliverables**
Every subagent returns a named artifact (e.g., `execution-flow.md`, `hypothesis-challenges.md`) with a consistent structure: Summary, Detailed Findings, Gaps, Recommendations.

---

## Delegation Pattern

### **Complete Context Package**

When delegating to a subagent, provide everything upfront:

```
task(subagent_type="context-researcher", prompt="
  Execute context-gathering at depth=2:
  
  **Mission:**
  Understand how user authentication works
  
  **Target:**
  - src/auth/middleware/auth.ts
  - src/auth/services/auth-service.ts
  
  **Context:**
  - Bug: Valid tokens rejected in production
  - Previous Finding: AuthService identified as likely location
  - Constraint: Focus on validateToken flow
  
  **Deliverable:**
  Create execution-flow.md with:
  1. Call chain (entry → validation)
  2. Data flow
  3. Suspicious points
")
```

---

## Customization

### **Adjusting Tool Access**

If you need to restrict tools (instead of inheriting all), add a `tools` array to the YAML frontmatter:

```yaml
---
name: context-researcher
tools:
  - read_file
  - grep_search
  - codebase_search
  # No write operations
---
```

### **Adjusting Model**

To use Haiku instead of Sonnet for cost savings:

```yaml
---
name: context-researcher
model: claude-haiku-4
---
```

### **Custom Subagents**

To create your own subagent:
1. Copy an existing `.md` file as a template
2. Modify the YAML frontmatter (name, description, tools, model)
3. Update the system prompt to define the cognitive function
4. Register it in your IDE's config

---

## Workflows Using Subagents

Subagent-aware workflows are identified by the `.agentic.json` file extension:
- `bug-investigation.agentic.json` - Uses Context Researcher and Hypothesis Challenger
- More coming in Phase 2+

**To enable agentic workflows:**
```bash
export WORKRAIL_ENABLE_AGENTIC_ROUTINES=true
```

---

## Best Practices

### **1. Start with Core 6**
Don't create more subagents until you've validated these six work well for your use case.

### **2. Use Explicit Delegation**
Always use `task(subagent_type=...)` rather than relying on auto-invocation. It's more predictable.

### **3. Package Complete Context**
Give subagents everything they need upfront. They can't ask follow-up questions.

### **4. Validate Deliverables**
Check subagent output against quality gates:
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

