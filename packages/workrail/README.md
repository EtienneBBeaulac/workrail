# WorkRail: Guided Workflow Orchestration for AI Agents

> **Transform chaotic AI interactions into structured, reliable workflows**

[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.org)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)]()

---

## 🤔 The Problem

Large Language Models are incredibly powerful but suffer from well-documented limitations:

- **Hallucination** - They confidently generate plausible-sounding but incorrect information
- **Scope Creep** - Given a complex task, they often try to do too much at once, leading to half-baked solutions  
- **Context Loss** - They struggle to maintain focus across long conversations
- **Inconsistency** - The same prompt can yield wildly different results based on minor variations
- **Missing Prerequisites** - They often start implementing before gathering necessary context

Traditional approaches try to solve these through better prompting or more powerful models. WorkRail takes a different approach.

## 💡 The Solution

WorkRail guides LLMs through **proven software engineering best practices** via structured workflows, making it much more difficult for the LLM to go off track.

Instead of hoping an LLM will follow best practices, this system **guides them toward** best practices through structured, machine-readable workflows.

**Traditional Approach:**
```
User: "Help me implement this feature"
AI: [May or may not ask for context, may or may not plan, may or may not test]
```

**WorkRail Approach:**
```
Workflow guides: Context → Clarification → Planning → Implementation → Verification  
AI: [Cannot skip steps, must follow proven patterns]
```

This creates an enhanced experience where developers are guided through optimal workflows, missing fewer critical steps, while LLMs work within their strengths following proven patterns.

---

## 🛠️ MCP Tools

WorkRail exposes 5 core tools through the Model Context Protocol:

- **`workflow_list`** - Browse available workflows for different task types
- **`workflow_get`** - Get complete workflow details and requirements  
- **`workflow_next`** - Get the next step in an active workflow
- **`workflow_validate`** - Validate step outputs against quality criteria
- **`workflow_validate_json`** - Validate and lint workflow JSON files

---

## ⚙️ Installation

Add WorkRail to your AI agent by configuring the MCP server:

### Claude Desktop
Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "workrail": {
      "command": "npx",
      "args": ["-y", "@exaudeus/workrail"]
    }
  }
}
```

### Other MCP Clients
Use the same command pattern: `npx -y @exaudeus/workrail`

---

## 📋 Available Workflows

WorkRail comes with battle-tested workflows for common development tasks:

### 🔧 **Development Workflows**
- **`coding-task-workflow`** - Comprehensive coding workflow with analysis, planning, implementation, and review
- **`coding-task-workflow-with-loops`** - Enhanced version with iterative refinement loops
- **`systemic-bug-investigation`** - Systematic debugging methodology that prevents jumping to conclusions

### 🚀 **Project Management**  
- **`adaptive-ticket-creation`** - Create well-structured tickets with proper requirements
- **`mr-review-workflow`** - Thorough merge request review process

### 📚 **Content & Documentation**
- **`document-creation-workflow`** - Structured approach to creating comprehensive documentation
- **`presentation-creation`** - Build engaging presentations with clear narrative flow
- **`learner-centered-course-workflow`** - Design educational content with learning objectives

### 🔍 **Discovery & Analysis**
- **`exploration-workflow`** - Systematic codebase or domain exploration
- **`workflow-for-workflows`** - Meta-workflow for designing new workflows

---

## 🔄 Loop Support

WorkRail supports powerful iteration patterns for complex tasks:

- **`while`** - Continue while a condition is true
- **`until`** - Continue until a condition is met  
- **`for`** - Execute a fixed number of times
- **`forEach`** - Process items in an array

Perfect for batch operations, retries, polling, and iterative refinement.

---

## 📖 Quick Example

Here's what a workflow step looks like:

```json
{
  "id": "analyze-codebase",
  "name": "Deep Codebase Analysis",
  "description": "Understand the codebase structure before making changes",
  "agentRole": "You are a senior engineer performing careful code analysis",
  "runCondition": {
    "type": "context",
    "key": "taskComplexity", 
    "operator": "in",
    "values": ["Medium", "Large"]
  },
  "validationCriteria": {
    "outputLength": {"min": 200, "max": 2000},
    "mustContain": ["file structure", "key components", "dependencies"]
  }
}
```

The agent receives structured guidance on **what to do**, **how to do it**, and **quality standards to meet**.

---

## 🌟 Why Choose WorkRail?

### Consistency & Reproducibility  
One of the biggest challenges with AI-assisted development is inconsistency. The same request can yield wildly different approaches depending on how the prompt is phrased, the LLM's randomness, or the developer's prompting expertise.

WorkRail reduces these variables:
- **Same Process** - Every developer follows the same workflow
- **Same Quality** - Helps junior developers produce work closer to senior-level quality  
- **Same Standards** - Code style and patterns are guided by workflows
- **Audit Trail** - Every decision is logged and reviewable

| Without WorkRail | With WorkRail |
|------------------|---------------|
| "Just fix this bug" → agent makes random changes | Systematic investigation → evidence-based diagnosis → targeted fix |
| "Add a feature" → incomplete implementation | Analysis → planning → implementation → testing → review |
| Inconsistent quality across tasks | Repeatable, high-quality processes |
| Outcome depends on prompting skills | Guided best practices regardless of experience |

---

## 🚀 Getting Started

1. **Install** WorkRail as an MCP server (see installation above)
2. **Browse workflows** - Use `workflow_list` to see available options
3. **Start a workflow** - Use `workflow_get` to load a workflow for your task  
4. **Follow the steps** - Use `workflow_next` to get guided, step-by-step instructions
5. **Validate progress** - Use `workflow_validate` to ensure quality at each step

---

## 🚀 Planned Features

WorkRail is actively evolving. Here are key enhancements on the roadmap:

### **Workflow State Management**
- **Save & Resume** - Generate workflow state summaries for resuming complex workflows in new chat sessions
- **Context Preservation** - Maintain workflow progress across conversation boundaries
- **Checkpoint System** - Save progress at key milestones for easy recovery

### **Model Switching Guidance**
Workflows could recommend optimal models for specific steps:
- **Analysis steps** → Tool-use heavy models (Claude) for codebase exploration
- **Planning/design** → Smartest available models for strategic thinking  
- **Implementation** → Cost-effective models once requirements are clear

*Note: WorkRail provides text recommendations to users, not automatic model switching*

### **Enhanced Workflow Management**
- **Dynamic Workflow Loading** - Add/edit workflows without republishing the server
- **Workflow Categories** - Organize workflows by domain (debugging, planning, review, etc.)
- **Reusable Components** - Plugin system for common workflow patterns (codebase analysis, document creation, etc.)
- **Schema Versioning** - Backwards-compatible workflow schema evolution

### **Advanced Validation & Quality**
- **Custom Validation Functions** - Domain-specific output validation beyond basic schema checks
- **Integration Hooks** - Connect with external quality tools and linters
- **Performance Validation** - Ensure workflow outputs meet performance criteria
- **Length Validation Optimization** - Faster validation using terminal commands vs. full content rewrite

### **Workflow Discovery & Intelligence**
- **Smart Workflow Suggestions** - Recommend workflows based on task context
- **Pattern Recognition** - Identify when existing codebase patterns should inform workflow steps

---
*Have ideas for WorkRail? The planned features list helps guide development priorities.*

---

## 📚 Learn More

- **[Complete Overview](workrail-mcp-overview.md)** - Deep dive into architecture, philosophy, and detailed examples
- **[Loop Documentation](docs/features/loops.md)** - Advanced iteration patterns  
- **[API Specification](spec/mcp-api-v1.0.md)** - Complete MCP API reference
- **[Internal Documentation](docs/README.md)** - Development and architecture guides

---

## 📄 License

MIT License - see [LICENSE](LICENSE)