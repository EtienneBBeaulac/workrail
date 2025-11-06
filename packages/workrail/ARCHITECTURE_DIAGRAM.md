# WorkRail MCP: Architecture Diagrams

Visual representations of the WorkRail system architecture, component interactions, and data flows.

---

## System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         External Context                         │
│                                                                   │
│  ┌──────────────┐           ┌─────────────────┐                │
│  │              │           │                 │                │
│  │  AI Agents   │◄─────────►│   WorkRail MCP  │                │
│  │  (Clients)   │  MCP      │     Server      │                │
│  │              │ Protocol  │                 │                │
│  └──────────────┘           └────────┬────────┘                │
│   - Claude Desktop                   │                          │
│   - Cursor                           │                          │
│   - Custom agents                    │                          │
│                                      │                          │
│                                      ▼                          │
│                           ┌──────────────────┐                  │
│                           │                  │                  │
│                           │   File System    │                  │
│                           │                  │                  │
│                           │  - Workflows     │                  │
│                           │  - Sessions      │                  │
│                           │  - Cache         │                  │
│                           └──────────────────┘                  │
│                                      │                          │
│                                      ▼                          │
│                           ┌──────────────────┐                  │
│                           │                  │                  │
│                           │  Git Repositories│                  │
│                           │                  │                  │
│                           │  - GitHub        │                  │
│                           │  - GitLab        │                  │
│                           │  - Bitbucket     │                  │
│                           └──────────────────┘                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Container Diagram (High-Level Components)

```
┌────────────────────────────────────────────────────────────────────┐
│                        WorkRail MCP System                          │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │                    MCP Server Container                    │     │
│  │                   (src/mcp-server.ts)                     │     │
│  │                                                            │     │
│  │  ┌───────────────────────────────────────────────────┐   │     │
│  │  │         Tool Handlers (10 MCP Tools)              │   │     │
│  │  │                                                    │   │     │
│  │  │  workflow_list | workflow_get | workflow_next    │   │     │
│  │  │  workflow_validate | workflow_validate_json      │   │     │
│  │  │  workflow_get_schema | workrail_create_session   │   │     │
│  │  │  workrail_update_session | workrail_read_session │   │     │
│  │  │  workrail_open_dashboard                          │   │     │
│  │  └───────────────────────┬───────────────────────────┘   │     │
│  │                          │                                │     │
│  │  ┌───────────────────────▼───────────────────────────┐   │     │
│  │  │         MCP Protocol Layer                        │   │     │
│  │  │                                                    │   │     │
│  │  │  JSON-RPC 2.0 | stdio transport                  │   │     │
│  │  │  Error handling | Request routing                │   │     │
│  │  └────────────────────────────────────────────────────┘   │     │
│  └──────────────────────────┬──────────────────────────────┘     │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────┐     │
│  │              Application Container                       │     │
│  │             (src/container.ts - DI)                     │     │
│  │                                                          │     │
│  │  ┌────────────────────┐    ┌───────────────────────┐   │     │
│  │  │  WorkflowService   │    │  ValidationEngine     │   │     │
│  │  │                    │    │                       │   │     │
│  │  │  - Orchestration   │    │  - Step validation    │   │     │
│  │  │  - Next step       │    │  - Workflow check     │   │     │
│  │  │  - Loop handling   │    │  - Schema validation  │   │     │
│  │  └────────┬───────────┘    └───────────────────────┘   │     │
│  │           │                                             │     │
│  │           │                 ┌───────────────────────┐   │     │
│  │           │                 │ LoopContextOptimizer  │   │     │
│  │           │                 │                       │   │     │
│  │           └────────────────►│  - Context reduction  │   │     │
│  │                             │  - Progressive disc.  │   │     │
│  │                             └───────────────────────┘   │     │
│  └──────────────────────────┬──────────────────────────────┘     │
│                             │                                     │
│  ┌──────────────────────────▼──────────────────────────────┐     │
│  │           Infrastructure Container                       │     │
│  │                                                          │     │
│  │  ┌────────────────────────────────────────────────┐     │     │
│  │  │          Storage Stack                         │     │     │
│  │  │                                                 │     │     │
│  │  │  CachingWorkflowStorage                       │     │     │
│  │  │    └─ SchemaValidatingWorkflowStorage         │     │     │
│  │  │        └─ EnhancedMultiSourceWorkflowStorage   │     │     │
│  │  │            ├─ FileWorkflowStorage              │     │     │
│  │  │            ├─ GitWorkflowStorage               │     │     │
│  │  │            ├─ MultiDirectoryWorkflowStorage    │     │     │
│  │  │            ├─ PluginWorkflowStorage            │     │     │
│  │  │            └─ RemoteWorkflowStorage            │     │     │
│  │  └────────────────────────────────────────────────┘     │     │
│  │                                                          │     │
│  │  ┌────────────────────┐    ┌───────────────────────┐   │     │
│  │  │  SessionManager    │    │  HttpServer           │   │     │
│  │  │                    │    │                       │   │     │
│  │  │  - CRUD ops        │    │  - Dashboard API      │   │     │
│  │  │  - File watching   │    │  - Port 3000         │   │     │
│  │  │  - Normalization   │    │  - CORS enabled      │   │     │
│  │  └────────────────────┘    └───────────────────────┘   │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Component Diagram (Detailed Interactions)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Component Interactions                          │
│                                                                      │
│  ┌────────────────┐                                                 │
│  │   AI Agent     │                                                 │
│  └───────┬────────┘                                                 │
│          │ 1. workflow_next(workflowId, completedSteps, context)   │
│          │                                                           │
│  ┌───────▼────────┐                                                 │
│  │  MCP Server    │                                                 │
│  │                │                                                 │
│  │  Tool Handler  │                                                 │
│  └───────┬────────┘                                                 │
│          │ 2. Call workflowServer.getNextStep()                    │
│          │                                                           │
│  ┌───────▼────────────────────────────────────────┐                │
│  │          WorkflowService                       │                │
│  │                                                 │                │
│  │  3. Load workflow from storage                 │                │
│  │     └─► storage.getWorkflowById(workflowId)   │                │
│  │                                                 │                │
│  │  4. Validate workflow structure                │                │
│  │     └─► validationEngine.validateWorkflow()   │                │
│  │                                                 │                │
│  │  5. Determine next step                        │                │
│  │     - Check loop state                         │                │
│  │     - Evaluate conditions                      │                │
│  │     - Find eligible step                       │                │
│  │                                                 │                │
│  │  6. Optimize context (if in loop)             │                │
│  │     └─► loopOptimizer.optimizeLoopContext()   │                │
│  │                                                 │                │
│  │  7. Build step guidance                        │                │
│  │     - Combine prompt + agentRole + guidance   │                │
│  │     - Add loop context info                   │                │
│  └───────┬─────────────────────────────────────────┘                │
│          │ 8. Return { step, guidance, isComplete, context }       │
│  ┌───────▼────────┐                                                 │
│  │  MCP Server    │                                                 │
│  │                │                                                 │
│  │  Format result │                                                 │
│  └───────┬────────┘                                                 │
│          │ 9. JSON-RPC response                                     │
│  ┌───────▼────────┐                                                 │
│  │   AI Agent     │                                                 │
│  │                │                                                 │
│  │  Execute step  │                                                 │
│  └────────────────┘                                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Storage Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Storage Layer Stack                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │           Application Layer                           │     │
│  │    (WorkflowService, ValidationEngine, etc.)         │     │
│  └────────────────────┬──────────────────────────────────┘     │
│                       │ IWorkflowStorage interface             │
│                       │ - loadAllWorkflows()                   │
│                       │ - getWorkflowById(id)                  │
│                       │ - listWorkflowSummaries()              │
│  ┌────────────────────▼──────────────────────────────────┐     │
│  │  Layer 3: CachingWorkflowStorage (Decorator)         │     │
│  │                                                        │     │
│  │  - In-memory cache with TTL (5 min default)          │     │
│  │  - Cache invalidation                                 │     │
│  │  - Performance optimization                           │     │
│  └────────────────────┬──────────────────────────────────┘     │
│                       │                                         │
│  ┌────────────────────▼──────────────────────────────────┐     │
│  │  Layer 2: SchemaValidatingWorkflowStorage (Decorator)│     │
│  │                                                        │     │
│  │  - JSON schema validation                             │     │
│  │  - Workflow structure checks                          │     │
│  │  - Error reporting                                    │     │
│  └────────────────────┬──────────────────────────────────┘     │
│                       │                                         │
│  ┌────────────────────▼──────────────────────────────────┐     │
│  │  Layer 1: EnhancedMultiSourceWorkflowStorage         │     │
│  │                                                        │     │
│  │  Aggregates workflows from multiple sources:         │     │
│  │                                                        │     │
│  │  Priority order (later overrides earlier):           │     │
│  │  1. Bundled (built-in)                               │     │
│  │  2. Plugins (npm)                                    │     │
│  │  3. User (~/.workrail/workflows)                    │     │
│  │  4. Custom (WORKFLOW_STORAGE_PATH)                  │     │
│  │  5. Git repos (WORKFLOW_GIT_REPOS)                  │     │
│  │  6. Project (./workflows)                           │     │
│  └────────┬───────────────────────────────────────────────┘     │
│           │                                                     │
│           ├────────────────────────────────────┐               │
│           │                                    │               │
│  ┌────────▼─────────┐              ┌──────────▼──────────┐    │
│  │  FileWorkflow    │              │  GitWorkflow        │    │
│  │  Storage         │              │  Storage            │    │
│  │                  │              │                     │    │
│  │  Loads from:     │              │  Clones/syncs:     │    │
│  │  - Bundled dir   │              │  - Git repos       │    │
│  │  - JSON files    │              │  - With auth       │    │
│  └──────────────────┘              │  - Offline cache   │    │
│                                    └─────────────────────┘    │
│           │                                    │               │
│  ┌────────▼─────────┐              ┌──────────▼──────────┐    │
│  │  MultiDirectory  │              │  PluginWorkflow     │    │
│  │  WorkflowStorage │              │  Storage            │    │
│  │                  │              │                     │    │
│  │  Combines:       │              │  Loads from:       │    │
│  │  - User dir      │              │  - npm packages    │    │
│  │  - Project dir   │              │  - node_modules    │    │
│  │  - Custom paths  │              │  - Plugin system   │    │
│  └──────────────────┘              └─────────────────────┘    │
│           │                                                     │
│  ┌────────▼─────────┐                                          │
│  │  RemoteWorkflow  │                                          │
│  │  Storage         │                                          │
│  │                  │                                          │
│  │  Fetches from:   │                                          │
│  │  - HTTP registry │                                          │
│  │  - With API key  │                                          │
│  │  - Retry logic   │                                          │
│  └──────────────────┘                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Workflow Execution Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                    Workflow Execution State Machine                 │
│                                                                     │
│                      ┌─────────────────┐                           │
│                      │   START         │                           │
│                      └────────┬────────┘                           │
│                               │                                     │
│                               ▼                                     │
│                      ┌─────────────────┐                           │
│                      │ Load Workflow   │                           │
│                      └────────┬────────┘                           │
│                               │                                     │
│                               ▼                                     │
│                      ┌─────────────────┐                           │
│                      │ Validate Schema │                           │
│                      └────────┬────────┘                           │
│                               │                                     │
│                               ▼                                     │
│              ┌────────────────────────────────┐                    │
│              │  Find Next Eligible Step       │                    │
│              │                                │                    │
│              │  - Skip completed steps        │                    │
│              │  - Evaluate runConditions      │                    │
│              │  - Check loop state            │                    │
│              └────────┬───────────────────────┘                    │
│                       │                                             │
│           ┌───────────┴───────────┐                                │
│           │                       │                                │
│    ┌──────▼──────┐         ┌──────▼──────┐                        │
│    │ Regular Step│         │  Loop Step  │                        │
│    └──────┬──────┘         └──────┬──────┘                        │
│           │                       │                                │
│           │              ┌────────▼───────────┐                    │
│           │              │ Initialize Loop    │                    │
│           │              │                    │                    │
│           │              │ - Check condition  │                    │
│           │              │ - Set loop state   │                    │
│           │              │ - Resolve body     │                    │
│           │              └────────┬───────────┘                    │
│           │                       │                                │
│           │              ┌────────▼───────────┐                    │
│           │              │ Execute Loop Body  │                    │
│           │              │                    │                    │
│           │              │ First iteration:   │                    │
│           │              │ - Full context     │                    │
│           │              │                    │                    │
│           │              │ Later iterations:  │                    │
│           │              │ - Optimized context│                    │
│           │              └────────┬───────────┘                    │
│           │                       │                                │
│           │              ┌────────▼───────────┐                    │
│           │              │ Check Loop Continue│                    │
│           │              └─┬──────────────┬───┘                    │
│           │                │              │                        │
│           │         Continue          Complete                     │
│           │                │              │                        │
│           │                │              │                        │
│    ┌──────▼────────────────▼──────┐       │                       │
│    │  Build Step Guidance         │       │                       │
│    │                               │       │                       │
│    │  - Combine prompt + role     │       │                       │
│    │  - Add loop context          │       │                       │
│    │  - Include function defs     │       │                       │
│    └──────┬───────────────────────┘       │                       │
│           │                                │                       │
│           ▼                                │                       │
│    ┌────────────────┐                     │                       │
│    │ Return to Agent│                     │                       │
│    └──────┬─────────┘                     │                       │
│           │                                │                       │
│    ┌──────▼─────────┐                     │                       │
│    │ Agent Executes │                     │                       │
│    │     Step       │                     │                       │
│    └──────┬─────────┘                     │                       │
│           │                                │                       │
│    ┌──────▼─────────┐                     │                       │
│    │ Validate Output│                     │                       │
│    │  (Optional)    │                     │                       │
│    └──────┬─────────┘                     │                       │
│           │                                │                       │
│    ┌──────▼─────────┐                     │                       │
│    │ Mark Complete  │                     │                       │
│    └──────┬─────────┘                     │                       │
│           │                                │                       │
│           └────────────────────────────────┘                       │
│                       │                                             │
│                       ▼                                             │
│            ┌──────────────────┐                                    │
│            │ All Steps Done?  │                                    │
│            └──┬───────────┬───┘                                    │
│               │           │                                         │
│              No          Yes                                        │
│               │           │                                         │
│               │           ▼                                         │
│               │   ┌──────────────┐                                 │
│               │   │     END      │                                 │
│               │   │  (Complete)  │                                 │
│               │   └──────────────┘                                 │
│               │                                                     │
│               └─────────────────────────┐                          │
│                                         │                          │
│                                         ▼                          │
│                          ┌──────────────────────┐                  │
│                          │ Find Next Eligible   │                  │
│                          │      Step            │                  │
│                          └──────────────────────┘                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Loop Optimization Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  Loop Context Optimization                       │
│                                                                  │
│  ┌────────────────┐                                             │
│  │ Loop Starts    │                                             │
│  └───────┬────────┘                                             │
│          │                                                       │
│          ▼                                                       │
│  ┌──────────────────────────────────┐                          │
│  │ First Iteration (iteration = 0) │                          │
│  │                                  │                          │
│  │ Context:                         │                          │
│  │ ┌──────────────────────────────┐ │                          │
│  │ │ _currentLoop: {              │ │                          │
│  │ │   loopId: "phase-1",        │ │                          │
│  │ │   loopStep: {               │ │   ◄─── Full Context      │
│  │ │     id: "...",              │ │        (~10KB)           │
│  │ │     type: "loop",           │ │                          │
│  │ │     title: "Analysis",      │ │                          │
│  │ │     prompt: "...",          │ │                          │
│  │ │     loop: {...},            │ │                          │
│  │ │     body: [...]  ◄────────────── Complete body array    │
│  │ │   }                         │ │                          │
│  │ │ }                           │ │                          │
│  │ └──────────────────────────────┘ │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ Agent Executes Step              │                          │
│  │                                  │                          │
│  │ - Has full context               │                          │
│  │ - Sees complete instructions     │                          │
│  │ - Understands full scope         │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ Increment Iteration (i = 1)      │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ LoopContextOptimizer.optimize()  │                          │
│  │                                  │                          │
│  │ Actions:                         │                          │
│  │ 1. Strip full loop definition    │                          │
│  │ 2. Keep only loopId + type       │                          │
│  │ 3. Add phase reference           │                          │
│  │ 4. Remove large arrays           │                          │
│  │ 5. Keep current item (forEach)   │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ Subsequent Iteration (i >= 1)    │                          │
│  │                                  │                          │
│  │ Context:                         │                          │
│  │ ┌──────────────────────────────┐ │                          │
│  │ │ _currentLoop: {              │ │                          │
│  │ │   loopId: "phase-1",        │ │   ◄─── Minimal Context   │
│  │ │   loopType: "for",          │ │        (~2KB)            │
│  │ │   iteration: 1,             │ │        60-80% reduction  │
│  │ │   isFirstIteration: false,  │ │                          │
│  │ │   phaseReference: {         │ │                          │
│  │ │     loopId: "phase-1",     │ │                          │
│  │ │     phaseTitle: "Analysis",│ │                          │
│  │ │     totalSteps: 4          │ │                          │
│  │ │   }                        │ │                          │
│  │ │ }                          │ │                          │
│  │ └──────────────────────────────┘ │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ Build Step Prompt                │                          │
│  │                                  │                          │
│  │ Prompt includes:                 │                          │
│  │ - Base instructions              │                          │
│  │ - "Iteration: 2"                │                          │
│  │ - "Refer to phase overview      │                          │
│  │    from first iteration"        │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   ▼                                             │
│  ┌──────────────────────────────────┐                          │
│  │ Agent Executes Step              │                          │
│  │                                  │                          │
│  │ - Has minimal context            │                          │
│  │ - Knows iteration number         │                          │
│  │ - References first iteration     │                          │
│  └────────────────┬─────────────────┘                          │
│                   │                                             │
│                   └───────────────┐                            │
│                                   │                            │
│                                   ▼                            │
│                          ┌───────────────┐                     │
│                          │ Loop Complete?│                     │
│                          └──┬─────────┬──┘                     │
│                            No        Yes                       │
│                             │         │                        │
│                  Increment  │         └──► End Loop            │
│                  iteration  │                                  │
│                             │                                  │
│                             └──────────┐                       │
│                                        │                       │
│                                        ▼                       │
│                          ┌──────────────────────┐              │
│                          │ Continue with        │              │
│                          │ optimized context    │              │
│                          └──────────────────────┘              │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Management Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Session Management System                       │
│                                                                  │
│  ┌────────────────┐              ┌──────────────────┐          │
│  │   AI Agent     │              │  Dashboard UI    │          │
│  │                │              │  (Browser)       │          │
│  └───────┬────────┘              └────────┬─────────┘          │
│          │                                │                     │
│          │ Create/Update/Read            │ HTTP GET            │
│          │ Session (MCP tools)           │ Session data        │
│          │                                │                     │
│  ┌───────▼────────────────────────────────▼─────────┐          │
│  │         SessionManager                           │          │
│  │                                                   │          │
│  │  Operations:                                     │          │
│  │  - createSession(workflowId, sessionId, data)   │          │
│  │  - updateSession(workflowId, sessionId, updates)│          │
│  │  - readSession(workflowId, sessionId, path?)    │          │
│  │  - deleteSession(workflowId, sessionId)         │          │
│  │  - listAllSessions()                            │          │
│  │  - watchSession(workflowId, sessionId)          │          │
│  │                                                   │          │
│  │  Features:                                       │          │
│  │  - Deep merge updates                            │          │
│  │  - JSONPath queries                              │          │
│  │  - Atomic writes (temp + rename)                │          │
│  │  - File watching for real-time updates          │          │
│  │  - Data normalization                            │          │
│  │  - Data validation (non-blocking)               │          │
│  │  - Git worktree support                         │          │
│  └───────────────────┬─────────────────────────────┘          │
│                      │                                         │
│                      ▼                                         │
│  ┌──────────────────────────────────────────────┐             │
│  │       File System Storage                     │             │
│  │                                               │             │
│  │  ~/.workrail/sessions/                       │             │
│  │  ├── {projectId}/                            │             │
│  │  │   ├── project.json                        │             │
│  │  │   ├── {workflowId}/                       │             │
│  │  │   │   ├── {sessionId}.json               │             │
│  │  │   │   └── {sessionId}.json               │             │
│  │  │   └── validation-logs/                    │             │
│  │  │       └── {workflow}-{session}-...log    │             │
│  │  └── {projectId}/                            │             │
│  │      └── ...                                 │             │
│  └──────────────────────────────────────────────┘             │
│                                                                │
│  ┌──────────────────────────────────────────────┐             │
│  │       HttpServer (Dashboard API)             │             │
│  │                                               │             │
│  │  Port: 3000 (default)                        │             │
│  │                                               │             │
│  │  Endpoints:                                  │             │
│  │  GET  /api/sessions               # List all │             │
│  │  GET  /api/projects               # Projects │             │
│  │  GET  /api/sessions/:id           # Details │             │
│  │  GET  /api/workflows/:id          # Workflow│             │
│  │  GET  /dashboard/:sessionId       # UI      │             │
│  │                                               │             │
│  │  Features:                                   │             │
│  │  - CORS enabled                              │             │
│  │  - Real-time updates (SSE)                   │             │
│  │  - Auto-open browser (optional)              │             │
│  └──────────────────────────────────────────────┘             │
│                                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Deployment Options                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Option 1: npx (Recommended)                         │      │
│  │                                                       │      │
│  │  User config:                                        │      │
│  │  {                                                   │      │
│  │    "mcpServers": {                                   │      │
│  │      "workrail": {                                   │      │
│  │        "command": "npx",                             │      │
│  │        "args": ["-y", "@exaudeus/workrail"],        │      │
│  │        "env": {                                      │      │
│  │          "WORKFLOW_GIT_REPOS": "...",               │      │
│  │          "GITHUB_TOKEN": "..."                      │      │
│  │        }                                             │      │
│  │      }                                               │      │
│  │    }                                                 │      │
│  │  }                                                   │      │
│  │                                                       │      │
│  │  Flow:                                               │      │
│  │  AI Agent → npx → Downloads latest → Runs server    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Option 2: Docker                                    │      │
│  │                                                       │      │
│  │  User config:                                        │      │
│  │  {                                                   │      │
│  │    "mcpServers": {                                   │      │
│  │      "workrail": {                                   │      │
│  │        "command": "docker",                          │      │
│  │        "args": ["run", "--rm", "-i",                │      │
│  │                 "workrail-mcp"],                     │      │
│  │        "env": {...}                                  │      │
│  │      }                                               │      │
│  │    }                                                 │      │
│  │  }                                                   │      │
│  │                                                       │      │
│  │  Flow:                                               │      │
│  │  AI Agent → Docker → Runs container → MCP server    │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │  Option 3: Local Installation                       │      │
│  │                                                       │      │
│  │  npm install -g @exaudeus/workrail                  │      │
│  │  workrail                                            │      │
│  │                                                       │      │
│  │  Flow:                                               │      │
│  │  AI Agent → Installed binary → MCP server           │      │
│  └──────────────────────────────────────────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagram (Complete Workflow Execution)

```
┌─────────────────────────────────────────────────────────────────┐
│                Complete Workflow Execution Flow                  │
│                                                                  │
│  1. Agent Request                                               │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_list()                              │
│  └────────┘       Returns: [{ id, name, description, ... }]    │
│                                                                  │
│  2. Workflow Selection                                          │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_get("coding-task", "preview")       │
│  └────────┘       Returns: { metadata, firstStep }             │
│                                                                  │
│  3. Step Execution Loop                                         │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_next(                               │
│  └────────┘         "coding-task",                             │
│                     completedSteps: [],                         │
│                     context: {}                                 │
│                   )                                             │
│                                                                  │
│       MCP Server                                                │
│       │                                                          │
│       ├─► Load workflow from storage                           │
│       │   └─► Check cache                                      │
│       │   └─► Load from file/git                               │
│       │                                                          │
│       ├─► Validate workflow structure                          │
│       │   └─► Check required fields                            │
│       │   └─► Validate loop configs                            │
│       │                                                          │
│       ├─► Find next eligible step                              │
│       │   ├─► Skip completed steps                             │
│       │   ├─► Evaluate runConditions                           │
│       │   └─► Handle loop state                                │
│       │                                                          │
│       ├─► Build step guidance                                  │
│       │   ├─► Combine prompt + role + guidance                 │
│       │   ├─► Inject loop context (if in loop)                │
│       │   └─► Add function definitions                         │
│       │                                                          │
│       └─► Return { step, guidance, isComplete, context }       │
│                                                                  │
│  ┌────────┐                                                     │
│  │ Agent  │ Receives step                                      │
│  └────┬───┘                                                     │
│       │                                                          │
│       ├─► Reads step.prompt                                    │
│       ├─► Executes task (uses tools, writes code, etc.)       │
│       └─► Produces output                                      │
│                                                                  │
│  4. Validation (Optional)                                       │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_validate(                           │
│  └────────┘         "coding-task",                             │
│                     "step-1",                                   │
│                     output                                      │
│                   )                                             │
│                                                                  │
│       MCP Server                                                │
│       │                                                          │
│       ├─► Load workflow + step                                 │
│       ├─► Extract validationCriteria                           │
│       ├─► Evaluate rules against output                        │
│       │   ├─► Check contains/regex/length/schema              │
│       │   ├─► Handle compositions (AND/OR/NOT)                │
│       │   └─► Conditional validation                           │
│       │                                                          │
│       └─► Return { valid, issues, suggestions }                │
│                                                                  │
│  ┌────────┐                                                     │
│  │ Agent  │ Receives validation result                         │
│  └────┬───┘                                                     │
│       │                                                          │
│       └─► If valid: Mark step complete                         │
│           If invalid: Retry or ask user                        │
│                                                                  │
│  5. Next Iteration                                              │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_next(                               │
│  └────────┘         "coding-task",                             │
│                     completedSteps: ["step-1"],                │
│                     context: { taskComplexity: "Medium" }      │
│                   )                                             │
│                                                                  │
│       MCP Server                                                │
│       └─► Returns next step (step-2)                           │
│                                                                  │
│  6. Loop Handling (if applicable)                              │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_next(                               │
│  └────────┘         "coding-task",                             │
│                     completedSteps: ["step-1", "step-2", ...], │
│                     context: {...}                              │
│                   )                                             │
│                                                                  │
│       MCP Server                                                │
│       │                                                          │
│       ├─► Detect loop step                                     │
│       ├─► Initialize loop state                                │
│       ├─► Check loop condition                                 │
│       ├─► Resolve loop body                                    │
│       ├─► Apply context optimization (if not first)           │
│       │                                                          │
│       └─► Return loop body step with optimized context         │
│                                                                  │
│  7. Completion                                                  │
│  ┌────────┐                                                     │
│  │ Agent  │─────► workflow_next(...)                           │
│  └────────┘       Returns: { step: null, isComplete: true }    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

**Document Version**: 1.0  
**Date**: November 3, 2025  
**Codebase Version**: 0.6.1-beta.7

*These diagrams provide visual representations of the WorkRail MCP architecture. For detailed explanations, see CODEBASE_OVERVIEW.md.*



