# Design Spec: Cognitive Verification & Subagent-Driven Auditing

## Artifact Strategy
> [!NOTE]
> This design spec is for human review and readability only. It provides design concepts, options, and decisions. The canonical, execution-time truth of the workflow session is persisted directly within WorkRail's notes (`notesMarkdown`) and the `context` variables.


## Context / Ask
WorkRail currently relies on hardcoded shell commands or specific step-by-step instructions for verification, which limits platform-agnosticism. Furthermore, having the main agent session perform the audit of its own work introduces confirmation bias. We need to introduce:
1. **Cognitive Verification**: Command-free verification configurations that instruct the main agent to autonomously discover, write, run, and verify tests/builds.
2. **Subagent-Driven Auditing**: Verification and audit configuration blocks that specify a subagent spawning directive. When hit, the engine suspends the parent session, programmatically spawns an independent sandboxed subagent QA auditor to inspect the work, and returns a Pass/Fail verdict with remediation guidance.
This capability must work natively for both **WorkRail MCP** and **WorkTrain Daemon** (autonomous runner).

---

## Path Recommendation
- **Path**: `full_spectrum`
- **Rationale**: This feature requires both landscape grounding (examining how compiled workflows, auto-injection, prompt rendering, and daemon spawning tools are currently implemented) and concept shaping (determining how context mapping, workspace isolation, and synthesis auto-adoption should work). 

---

## Constraints / Anti-goals
- **Constraints**:
  - **No duplicate code**: The capability must leverage a common engine representation.
  - **Opaque tokens**: Do not change or bypass the HMAC token protocol (`continueToken`, `checkpointToken`).
  - **Compatibility**: Legacy workflows must continue to work.
  - **No daemon-mcp conflation**: Keep the daemon's internal spawning separate from MCP stdio/HTTP interfaces.
- **Anti-goals**:
  - We are not building a fully automated self-fixing loop *outside* of the parent agent's session (the parent agent is responsible for executing the loop, correcting errors, and advancing).
  - We are not replacing manual verification; we are complementing it with cognitive and subagent capabilities.

---

## Landscape Packet
- **Current State**:
  - Virtual steps (`verification`, `audit`) are compiled by `workflow-compiler.ts` by appending new `WorkflowStepDefinition` items with derived prompts.
  - Verification steps check for `command` and generate a prompt like `Run the following verification command...` or a fallback `Run the appropriate verification commands...`.
  - Audits check for `rubric` and compile a prompt.
  - Spawning in the Daemon is handled via the `spawn_agent` tool in `spawn-agent.ts`. It runs child sessions in-process, returning `SingleSpawnResult`.
  - Spawning in MCP is handled via client-side prompts, instructing the client (e.g. Claude) to call `invoke_subagent`.
  - Parallel steps (`ParallelStepDefinition`) can have `synthesis` config which compiles into a `${step.id}__synthesis` step.

---

## Problem Frame Packet
- **Users**: Workflow authors, AI developers, and the agents themselves.
- **Jobs**:
  - Authors want to write workflows without environment-specific bash commands.
  - Authors want independent QA auditing of agent outputs.
  - Agents need clean feedback when an audit fails.
- **Pains**:
  - confirmation bias: agents grading their own homework.
  - environment lock-in: `npm test` doesn't work if the workspace is in another language or environment.
- **What would make this framing wrong**: If running a subagent is too slow/expensive for simple steps, or if workspace sharing causes conflicts/corruption.

### Frame Validity Check
- **Current Frame**: "WorkRail needs a platform-agnostic, robust way to delegate verification and auditing of step outputs to avoid environment lock-in and confirmation bias, without introducing workspace corruption or non-deterministic test loops."
- **New Information**: WorkRail's existing ParallelStepDefinition has compile-time/render-time foundations for parallel subagents, but execution and synthesis are currently delegated either client-side (via prompts/MCP client) or daemon-side (via spawn_agent). The local feedback loop (where the parent agent retries failed audits) is extremely natural and requires zero engine state machine rewinds.
- **frameChallenge**: `valid`
- **reframeRequired**: `null`


## Decision Criteria & Ideal End State

### Ideal End State
An elegant, unified verification engine where workflow authors can specify either standard execution contracts or a new cognitive validation mode. When running under the daemon, it utilizes a sandboxed, git-worktree-isolated subagent daemon loop to audit changes; under the MCP server, it invokes a client-side subagent (or guides the user's agent) to perform the same audit. The verification output is structured, cryptographically signed/checked if needed, and ensures the workspace remains clean, while avoiding confirmation bias.

### Decision Criteria
1. **Both-Sides-of-the-Fence Execution (Vision-Aligned) [Weight: Critical]**: Which candidate best compiles a single polymorphic execution model that guides interactive human/MCP agents via prompts, and autonomous daemon agents via native tool executions, without duplicating routing logic?
2. **Design Elegance & Extensibility (Quality-Aspirational) [Weight: High]**: Which design creates the cleanest, most modular separation of concerns between workflow compilation (auto-injecting virtual steps as parallel delegation nodes) and the execution runner (MCP client-side prompts vs. Daemon in-process worktrees), ensuring that a senior engineer would find the architecture elegant and easily extensible to new subagent types in two years?
3. **Workspace Isolation & Hermeticity [Weight: High]**: Which design best prevents workspace contamination, race conditions, and file system conflicts when spawning subagents in parallel or sequentially?
4. **Local Loop Recovery [Weight: Medium]**: Which design enables the simplest, most intuitive recovery/fix loop for agents when verification or auditing fails, avoiding complex engine state rollbacks?

---

## Candidate Directions

### Angle 1: Declarative Spawning Directives in Workflow Schema
Allow `verification` and `audit` blocks to declare a subagent delegate:
```json
"verification": {
  "cognitive": true,
  "delegate": {
    "workflowId": "wr.routine-code-reviewer",
    "modelTier": "heavy",
    "contextMapping": {
      "reframedProblem": "targetGoal"
    }
  }
}
```
If `delegate` is specified, the compiler turns the virtual step into a `ParallelStepDefinition` with a single delegation.

### Angle 2: Local Agent Feedback Loop vs. State-Machine Rewind
When a subagent QA audit fails:
- **Local feedback loop (Recommended)**: The tool call `spawn_agent` returns `outcome: 'error'` and `notes: 'remediation guide...'`. The parent agent remains on the current step, corrects the code in the workspace, and calls `spawn_agent` again. It only calls `continue_workflow` when the tool returns `outcome: 'success'`. This prevents complex state-machine rollback logic.
- **State-machine rewind**: The engine registers the failure, rolls back the parent step, and marks the parent step as active again. This is complex and risks infinite loop cycles.

### Angle 3: Workspace Isolation (Worktree vs. Shared)
- **MCP Client**: The client (e.g., Claude) spawns the subagent with its native `Workspace: 'branch'` capability, automatically handling isolation and uncommitted changes.
- **Daemon**: The daemon's `spawn_agent` tool can either:
  1. Share the parent's workspace directly (cheap, but risk of mutations).
  2. Create a temporary git commit of the parent's changes, spawn a `git worktree` off that commit, run the subagent, and clean up afterwards.

---

## Challenge Notes
An adversarial challenge was conducted pointing out structural weaknesses in a mandatory git-worktree sandboxing model:
1. **Dependency Installation Tax**: Clean worktrees lack ignored dependencies (`node_modules`), forcing costly reinstalls or fragile symlinking that kills execution speed.
2. **Platform Portability**: Git worktree setup fails under dirty index states, and Windows symlinking requires admin privileges.
3. **Local Loop Recovery Disconnect**: Debugging failed audits is difficult when error traces point to temporary worktrees instead of the active workspace.
4. **Shared Resource Collisions**: Filesystem sandboxing fails to isolate external resource collisions (e.g. database ports or Docker states).

---

## Resolution Notes
We **revised** the design to adopt a **Hybrid Polymorphic Verification Engine**:
1. **Default Mode (Shared Workspace + Caching)**: Use local/shared-directory execution with content-hash caching and read-only subagent constraints as the default. This keeps validation sub-second (<50ms).
2. **Optional Mode (Git-Worktree Sandboxing)**: Enable git-worktree isolation as an optional parameter (`isolation: "worktree"`) for final PR validation or critical files before merge.

## Decision Log

### 1. Selected Winner: Candidate 5 (Hybrid Polymorphic Verification Engine)
- **Why it won**: Candidate 5 is the only candidate that spans all layers of the stack (compiler, execution runner, caching, and agent-loop recovery) to resolve all pre-committed decision criteria. It resolves the core speed-vs-isolation tension by using change-detection caching to bypass execution for cognitive/unchanged steps (Candidate 3) and only spins up APFS/COW worktrees (Candidate 2) when code changes occur.
- **Comparison to Ideal End State**: It reaches the ideal end state. It unifies execution models across MCP and Daemon (using Candidate 1's AST step compilation), maintains a clean workspace via ref-linked worktrees, and implements a simple, local error correction loop (Candidate 4).

### 2. Runner-Up: Candidate 1 (Polymorphic AST Step Injection)
- **Why it lost**: While Candidate 1 provides an elegant, extensible compile-time AST step mutation (crucial for Both-Sides-of-the-Fence execution), it is purely a compiler-level solution. It does not address workspace isolation, setup latency, or error recovery, which are necessary for safe daemon runs. It was integrated into the winner (Candidate 5) as the compilation layer rather than being used alone.



## Candidate Generation Expectations
- **Path-Specific Bias**: Since we are on a `full_spectrum` path, we require the candidate set to clearly reflect both ideal long-term architectural visions and concrete landscape/implementation precedents.
- **Angles to Emphasize**:
  1. *Ideal End State Focus*: Create candidate directions that achieve the absolute highest quality ceiling (clean syntax, robust subagent delegation, proper sandboxed auditing).
  2. *Riskiest Assumption Focus*: Mitigate risks around workspace isolation, npm dependency performance, and ensuring verification commands actually execute real tests.
  3. *Framing Risk Focus*: Address the risk of subagent auditing being too slow or resource-heavy by proposing optimizations or graceful degradation modes.
- **Rigor (Thorough)**: The subagents must generate at least 5 distinct candidates each, including creative, low-probability options.

---

## Residual Risks & Mitigations

Adversarial hypothesis challenges and execution simulations identified key implementation-level risks and defined the following mitigations:

### 1. Monorepo Symlink Dependency Leak & Git Root Resolution Escape
- **Risk**: Spawning sandboxes in subdirectories (e.g. `.workrail/sandbox/`) leaks monorepo absolute paths and allows upward-scanning git/lint tools to escape past the sandbox and modify the host workspace.
- **Mitigation**: Sandbox directories must reside strictly out-of-tree (e.g., `~/.workrail/sandbox/<sessionId>/`). All paths must be normalized using `fs.realpathSync` to canonicalize them before comparisons.

### 2. State Preservation and Git Stash Pop Conflict Risk
- **Risk**: Using `git stash --include-untracked` -> `git stash pop` to manage dirty parent workspaces is highly prone to merge conflicts, risking silent data loss or index corruption.
- **Mitigation**: Avoid `git stash` entirely. Instead of git worktrees, use a Node-level recursive copy (`fs.cpSync` excluding `.git` and `node_modules`) to clone the active workspace files. This copies the exact active state (including untracked and uncommitted files) into the out-of-tree sandbox without modifying the parent's git index.

### 3. Windows Directory Junction Cleanup Data Loss
- **Risk**: Standard recursive folder deletion (`fs.rmSync` or shell `rm -rf`) on Windows directory junctions traverses the link and deletes the source `node_modules` directory contents.
- **Mitigation**: When cleaning up junctions, explicitly unlink the directory junction using `fs.unlinkSync` before deleting the parent folder.

### 4. Dangling Lock PID Reuse Deadlock
- **Risk**: Lock managers using `process.kill(pid, 0)` to check if a lock owner is still alive fail if the OS reuses the crashed process's PID for a new unrelated process, causing permanent deadlocks.
- **Mitigation**: Store a unique run ID and timestamp inside the lock file and update the lock's `mtime` (modified time) periodically as a heartbeat. If the heartbeat stops or the run ID is missing, safely break the lock.

### 5. Flaky Test Loop Trap
- **Risk**: Stuck-detection algorithms comparing tool input parameter hashes (`argsSummary`) fail to detect loops when the parent agent repeatedly edits files to address flaky tests, since replacement contents differ across turns.
- **Mitigation**: Track the frequency of edits to identical files in a single step (e.g. max 5 edits) and enforce a workflow step-visit limit.

---

## Final Summary
We have validated **Candidate 5 (Hybrid Polymorphic Verification Engine)**. The engine compiles declarative validations into standard ParallelStepDefinitions. The runner executes them inside an out-of-tree sandbox using Node-native recursive directory copying (`fs.cpSync`) and dependency symlinks (falling back to Windows junctions/unlinking and sequential file locks when permissions fail). This completely avoids git stashing risks and monorepo workspace leakage while maintaining sub-second validation latency.

## Next Actions
1. **Backlog Graduation**: File a GitHub Issue tracking the implementation of the Hybrid Polymorphic Verification Engine (Candidate 5) using the `gh` CLI.
2. **Phase 1 Implementation - Compiler Integration**: Implement polymorphic AST compilation in `workflow-compiler.ts` to expand `verification`/`audit` declarations into standard `ParallelStepDefinition` nodes.
3. **Phase 2 Implementation - Sandbox Copying & Junction Fallbacks**: Write the out-of-tree Node-based copy sandbox runner inside `src/daemon/tools/spawn-agent.ts` with Windows junction fallbacks and safe `fs.unlinkSync` cleanup.
4. **Phase 3 Implementation - Lock Heartbeats & Edit Limiters**: Set up lock heartbeat verification and file edit frequency limiters to prevent deadlocks and stuck loop traps.
