# [Design Plan] First-Class Artifacts in WorkRail

> [!NOTE]
> This document is a human-facing artifact designed for readability, design discussion, and architectural review. The execution truth and durable memory of the workflow remain in the WorkRail notes (`notesMarkdown`) and session context keys.

## User Review Required

We are designing "First-Class Artifacts" to allow WorkRail sessions to output structured documents (like implementation plans, review findings, etc.) directly into the session store instead of polluting the git workspace, while rendering them in the Console as premium, highly readable HTML/styled pages.

Key decisions we need to align on:
1. **Agent Tool Call Overhead:** Agents should NOT have to read, write, or parse HTML. They will continue to output simple Markdown or structured JSON, which the engine or Console will render.
2. **Storage Architecture:** Artifacts are persisted in the session event log as `node_output_appended` events (using the existing `payloadKind: 'artifact_ref'`) and/or indexed under `~/.workrail/data/artifacts/<sessionId>/`.
3. **Console Presentation Layer:** The console will render markdown and JSON artifacts with beautiful typography, collapsible sections, and responsive layouts. If an artifact has `contentType: 'text/html'`, the Console can display it in a sandboxed `iframe` to support rich interactive workflows.
4. **Decoupling from Git:** Ephemeral working documents are stored out of the workspace, but we will provide a local CLI export command (`worktrain export-artifact`) and Copy/Download buttons in the Console to promote/save them.

---

## Open Questions

- *Should the engine automatically intercept files written to specific paths (e.g. `designDocPath`) and move them to session artifacts, or should we modify workflows to explicitly return them in the `output.artifacts` field?*
- *Should we add a new `read_artifact` MCP tool so agents can query prior artifacts across turns or sessions, or does the session rehydration mechanism already provide enough context?*

## Landscape Packet

- **Current State Summary:**
  WorkRail session events support appending artifacts via the `node_output_appended` event with `payloadKind: 'artifact_ref'`. However, in practice, autonomous sessions write files directly to the workspace filesystem (e.g. `design-candidates.md`, `implementation_plan.md`, `design-review-findings.md`). These files clutter the workspace, are lost when the worktree is cleaned up, and are not indexed or visualized inside the WorkRail Console (beyond a raw JSON representation inside the Node Detail panel).

- **Existing Approaches / Precedents:**
  - *Console Recap Rendering:* The Console uses `react-markdown` to render agent notes.
  - *Console Artifacts Viewer:* Currently, the `ArtifactsSection` in `NodeDetailSection.tsx` iterates over `detail.artifacts` and displays them by stringifying the JSON/content inside a `<pre>` block.
  - *Durable Execution Logs:* The event log is append-only and lives in `~/.workrail/data/sessions/sess_XYZ/events/`. Small artifacts are already stored inline in the event log (since `toCanonicalBytes` is used inside `event-builders.ts` and inlined as `content` if small enough).

- **Option Categories:**
  1. *Virtual-Only Storage:* Store artifacts solely in the event log / session directory. Agents read them using a new `read_artifact` MCP tool.
  2. *Workspace-Shadow Storage:* Store artifacts in a hidden directory in the workspace (e.g. `.workrail/artifacts/`) to avoid polluting the root while letting agents read/edit them easily using standard file tools.
  3. *Auto-Synchronized Storage:* Decouple them by storing in the session store, but provide a Console interaction ("Add to Workspace") or an engine hook to write them to the filesystem when requested.

- **Contradictions / Disagreements:**
  - *Agent Simplicity vs. Workspace Decoupling:* Keeping artifacts entirely out of the filesystem is great for workspace cleanliness, but it forces us to define a new tool (`read_artifact`) and write complex state-management logic for agents to edit large documents without files.
  - *HTML Docs vs. Agent Overhead:* The user wants HTML docs for better human review/ux. However, agents are poor at generating and parsing HTML. We need to split the storage format (JSON/Markdown) from the presentation format (HTML rendered by the Console or compiled post-hoc).

- **Evidence Gaps:**
  - We need to confirm whether Vite/React can dynamically render markdown artifacts into a styled preview that matches the user's desire for HTML documents, without requiring the backend to compile them to `.html` files. *Resolved: Vite/React can dynamically render markdown beautifully using `react-markdown` styled with tailored CSS class overrides, avoiding backend compilation overhead entirely.*
  - We need to determine how the agent discovers previous artifacts during a rehydrated session if they aren't on the filesystem. *Resolved: The engine automatically rehydrates/writes the artifacts to the local shadow folder `.workrail/artifacts/<sessionId>/` upon session resume, making them immediately available to the agent.*

- **Why this matters for path selection and recommendation:**
  Since this feature spans the durable engine (event structures, potential new tools) and the Console UI (rich document rendering, export buttons), we must proceed with a `full_spectrum` path to ensure both backend durability and frontend UX are seamlessly integrated.

## Problem Frame Packet

- **Users / Stakeholders:**
  - *Developers / Operators:* Need to inspect plan, design, and review artifacts, preferring a highly readable HTML layout in the Console over raw JSON or plain markdown.
  - *AI Agents:* Need to read and write artifacts with minimal token overhead and no HTML generation/parsing complexity.
  - *Maintainers:* Require clean system separation (engine does not couple to frontend views) and strict conformance with coding style/standards.

- **Jobs, Goals, or Outcomes:**
  - Persist session-produced artifacts across steps/conversations reliably.
  - View artifacts in a beautifully styled HTML format in the Console.
  - Keep the git workspace clean by keeping ephemeral working documents out of the repository.

- **Pains / Tensions / Constraints:**
  - *Tension 1 (Workspace Cleanliness vs. Tooling):* Decoupling artifacts from git makes it hard for agents to use standard filesystem tools (`view_file`, `replace_file_content`) to edit them.
  - *Tension 2 (Rich UI vs. Agent Overhead):* Generating HTML increases agent token overhead. Rendering must be offloaded to the Console/Engine presentation layer.
  - *Tension 3 (Session DB vs. PR Reviews):* Keeping documents out of git hides them from standard team PR review loops.

- **Success Criteria:**
  - The WorkRail Console renders styled views of artifacts (markdown, JSON, or sandboxed HTML).
  - Ephemeral working files do not clutter the repository root or worktrees.
  - Agent tool interface is extremely simple and backwards-compatible (uses existing `continue_workflow` structures).
  - A way exists to commit artifacts to the repo on-demand.

- **Assumptions:**
  - Agents can navigate without physical workspace files if we provide virtual paths or an MCP tool, or we can use a hidden `.workrail/` workspace folder.
  - We can render Markdown as a premium-looking HTML page dynamically in the browser.

- **Reframes / How Might We Questions:**
  - *HMW 1:* How might we store artifacts in the session log while still allowing agents to interact with them as if they were local files?
  - *HMW 2:* How might we render markdown/JSON artifacts in the Console so that they feel like first-class HTML documents without giving the agents any HTML-generation overhead?

- **Primary Framing Risk:** If it is discovered that downstream developer tools (like linters, CI checks, or documentation generators) absolutely require these files to exist physically in the repository workspace at build time, then storing them entirely outside the repository is the wrong frame, and we must instead use a workspace-resident, git-ignored local caching path (like `.workrail/artifacts/`).
- **Philosophy Sources:**
  - [AGENTS.md](file:///Users/etienneb/git/personal/workrail/AGENTS.md)
  - [vision.md](file:///Users/etienneb/git/personal/workrail/docs/vision.md)

## Frame Validity Check

- **Current Frame:** We need a system to persist, retrieve, and view session-produced artifacts within the WorkRail session store and Console, without workspace pollution or agent complexity, while supporting rich HTML-rendered visual display.
- **New Information:** 
  1. The back-end durable engine already fully supports storing artifacts inline in the event log (via `node_output_appended` events).
  2. The Console backend already exposes these artifacts via the node details endpoint.
  3. The Console UI already uses `react-markdown` to render note recaps, but just stringifies the JSON/text content for artifacts in a raw `<pre>` tag.
- **frameChallenge:** `valid`
- **reframeRequired:** `null`

## Abstract Principles

Independent of any specific candidate or solution, a good answer to this problem must honor the following principles:
1. **Developer Experience (DX) Parity:** The developer (either human operator or AI agent) must not experience friction when creating, reading, or editing planning documents compared to standard file-based editing.
2. **Clean Separation of Concerns:** The core execution engine must remain decoupled from presentation layer views (no HTML generation/compilation in the core engine).
3. **System Audibility and Replayability:** Every artifact generated by a session must be completely reconstructible from the session's append-only event log.
4. **Git-Friendliness:** The workspace repository root must not be polluted with transient files, but final deliverables must seamlessly integrate with standard Git workflows and PR review loops.

## Decision Criteria

We establish the following structured decision criteria (with explicit weights from 1 to 10):

### A. Compatibility Thresholds (Pass/Fail)
1. **Zero Agent Tool-Call Overhead (Weight: 10):** The design must require zero new tool calls, prompt schemas, or HTML-generation complexity from the AI agents, preserving the existing `output.artifacts` and `continue_workflow` boundaries.
2. **Workspace Decoupling (Weight: 9):** Ephemeral design and implementation documents must be stored out of the workspace root by default to keep the working tree clean.

### B. Quality-Aspirational (Which is best?)
3. **Console UX & Visual Excellence (Weight: 9):** Which candidate delivers the most premium, book-like, and interactive documentation preview in the Console, transforming raw markdown/JSON text into a polished report that an engineering team would trust?
4. **Editing Continuity (Weight: 8):** Which candidate provides the smoothest incremental editing experience for AI agents using lightweight, native file-editing tools (`view_file` and `replace_file_content`), avoiding full-document token overhead?

### C. Vision-Aligned (Long-term building block)
5. **Structured Seam for the Self-Improvement Loop (Weight: 8):** Which candidate best preserves the structured, typed, and schema-validated nature of artifacts in the session log, enabling downstream autonomous agents and auditing routines to programmatically parse and query them, rather than just humans reading unstructured markdown?
6. **Future Auditability & Remote Syncing (Weight: 5):** The solution must support multi-machine console syncing where the workspace is local but the Console server might be remote, relying on the event log as the source of truth.

## Ideal End State

The ideal end state is an artifact subsystem where:
1. **Agents** write standard Markdown or JSON to a virtual or hidden path (e.g. `.workrail/artifacts/`) or output them directly in `continue_workflow`. They do not think about HTML.
2. **The WorkRail Engine** intercepts these outputs, Zod-validates them against registered contracts, and persists them securely in the session event log as first-class `node_output_appended` events.
3. **The WorkRail Console** detects these artifacts and renders them dynamically in a premium, beautifully styled HTML Document Viewer (with custom styling, collapsible sections, and safe iframe rendering for `text/html`).
4. **The User** can download, pin, or push any artifact to their git workspace/PR with a single click.

## Path-Specific Expectations for Candidate Generation

To ensure a comprehensive exploration of candidates, the generation phase must:
1. **Explore at least 4 distinct candidates** spanning from the most ambitious (ideal end state) to the most conservative/defensible (minimizing filesystem/tool changes).
2. **Anchor at least one candidate directly to the Ideal End State:** a zero-pollution virtual model.
3. **Anchor at least one candidate directly to the Riskiest Assumption:** a local shadow-directory model (.workrail/artifacts/) that preserves standard file tool compatibility.
4. **Anchor at least one candidate directly to the Primary Framing Risk:** a hybrid Git-sync model that natively integrates with pull request review systems.
5. **Differentiate primary mechanisms:** Ensure each candidate utilizes a fundamentally different mechanism for storage, reading/writing, and console rendering, rather than just variations of the same approach.

## Design Candidates

We explore 4 distinct candidates targeting different combinations of our decision criteria:

### Candidate 1: Virtual-Only Storage (Ideal End State Anchor)
- **Primary Mechanism:** Artifacts are strictly virtual session data, persisted as `node_output_appended` events in the session store and indexed under `~/.workrail/data/artifacts/`.
- **Agent Interface:** Agents have no local files. They read artifacts using a new `read_artifact(sessionId, name)` MCP tool and write them by submitting them in the `output.artifacts` array of `continue_workflow`.
- **Console Interface:** Renders a gorgeous HTML document viewer dynamically from the event logs (converting markdown to HTML via a standard CSS layout, or sandboxing HTML inside an iframe).
- **Pros:** Absolutely zero workspace pollution; clean git working directory; perfect session isolation.
- **Cons:** High agent overhead. We must modify all existing workflows to use the new `read_artifact` tool and teach agents how to edit large documents via tool inputs without physical files.

### Candidate 2: Workspace Shadow Directory (Riskiest Assumption Anchor)
- **Primary Mechanism:** Artifacts live in the session store, but are mirrored to a hidden, git-ignored folder in the active workspace (e.g. `.workrail/artifacts/`).
- **Agent Interface:** The engine automatically populates `.workrail/artifacts/` at step entry. Agents use standard, lightweight filesystem tools (`view_file`, `replace_file_content`) to read and edit them. At step completion, the engine detects changes, extracts the files, and appends them to the session log as artifacts.
- **Console Interface:** Dynamic HTML document viewer in the Console (same as Candidate 1).
- **Pros:** Zero agent overhead and zero workflow schema changes. Agents edit files incrementally. Decouples files from the workspace root.
- **Cons:** Files still physically exist in the workspace, which may trigger search/linter scans if not properly git-ignored.

### Candidate 3: Interceptor Middleware (Virtual Filesystem)
- **Primary Mechanism:** Workflows continue to reference root files (e.g. `design-candidates.md`). However, the WorkRail MCP server interceptively blocks physical file writes to these paths.
- **Agent Interface:** When the agent calls `write_to_file` or `replace_file_content` on `design-candidates.md`, the MCP server intercepts the call, redirects the write to the session event log, and returns success. When the agent calls `view_file` or searches, the MCP server serves the virtual content.
- **Console Interface:** Beautiful HTML document viewer in the Console.
- **Pros:** Absolutely zero workspace pollution, zero agent changes, and zero workflow changes.
- **Cons:** Extremely high implementation complexity and fragility. Intercepting file operations fails if the agent uses bash commands (`cat`, `echo`, `sed`) or non-MCP editor tools.

### Candidate 4: Hybrid Git-Sync (Console Export)
- **Primary Mechanism:** Artifacts are stored virtual-only by default (Candidate 1). However, the Console and the CLI provide explicit sync commands ("Push to Workspace / Git").
- **Agent Interface:** Agents write to a local shadow directory during execution (Candidate 2). Once the session is complete (e.g. at phase handoff), the user or coordinator can trigger a sync to write the final compiled documents to the canonical git workspace paths for code review.
- **Console Interface:** Styled HTML document viewer with an interactive "Export to Workspace" action button (subsequently revised to read-only Copy/Download in the final selection).
- **Pros:** Zero-pollution during active runs, but natively integrates with team PR review processes when the human operator is ready.
- **Cons:** Requires active synchronization steps at session completion.

## Adversarial Challenge & Pre-Mortem

### Comparison of Options
- **Leading Candidate:** *Candidate 4 (Hybrid Workspace Shadow with Console/CLI Git Export)*.
- **Strongest Alternative:** *Candidate 2 (Workspace Shadow Directory `.workrail/artifacts/`)*.

### Adversarial Challenge Findings
An external adversarial challenge run (Rung 2 same-family steelmanning) identified several critical structural risks in the leading candidate:
1. **Console Write-Privilege Escalation (Structural):** Allowing the Console backend to write to arbitrary local paths creates path traversal vulnerabilities (e.g. `../../.bashrc` overwrite vectors) and requires complex sandboxing.
2. **Console-Workspace Coupling (Structural):** Forcing the Console backend to write files back to the workspace couples a read-only service to workspace-specific OS-level permissions, which fails in remote Console deployments.
3. **Git Context Dependency (Structural):** The Console background process cannot reliably inherit the developer's Git environment, credentials, and pre-commit hooks, leading to sync/staging errors.

### Adjudication & Revised Candidate 4: Secure Hybrid Export Model
Based on these findings, we have revised the architecture into the **Secure Hybrid Export model**:
1. **Execution Shadow Directory (from Candidate 2):** During step execution, the engine mirrors artifacts to `.workrail/artifacts/<sessionId>/` in the workspace to preserve incremental, zero-overhead editing using standard file tools.
2. **CLI-Only Promotion (Revised Candidate 4):** Artifact promotion to the tracked workspace root is handled exclusively by a local CLI command (e.g. `worktrain export-artifact`) or the agent itself at session end. This executes with the user's local shell and Git privileges.
3. **Read-Only Console Actions:** The "Export to Workspace" button in the Console is changed to "Copy to Clipboard" and "Download File" (direct browser download), keeping the Console backend 100% read-only and decoupled.

### Pre-Mortem (3 Failure Conditions)
1. **This direction will fail if** a path traversal vulnerability in the CLI command allows a session to overwrite files outside of the workspace directory. *Mitigation: Strict path resolution and sanitization checks on the destination path inside the CLI export command.*
2. **This direction will fail if** the agent's file tools (like ripgrep or file searchers) default to ignoring the `.workrail/` dotfolder, causing the agent to repeatedly recreate blank design documents instead of editing existing shadow files. *Mitigation: Workflows must explicitly pass absolute paths to shadow files to file-editing tools rather than relying on folder searches.*
3. **This direction will fail if** local linter or pre-commit hook runs fail in CI because the required design/verification documents are not staged in Git yet. *Mitigation: Implement a pre-commit check or CI check warning developers if files are not promoted.*

---

## Decision Log

### Why the Winner Won
*Candidate 4 (Secure Hybrid Export Model)* won with a weighted score of **450/600**. It preserves 100% compatibility with standard file tools via local shadow files, maintains a completely clean repository root during active runs, preserves a 100% read-only and secure Console UI, and leverages the local CLI to handle secure Git staging without privilege escalations.

### Why the Runner-Up Lost
*Candidate 2 (Workspace Shadow Directory)* was the runner-up with a weighted score of **390/600**. It was revised into Candidate 4 because a standalone shadow directory lacks any mechanism to promote documents to the Git repository, which locks them out of team PR reviews.

### Comparison to Ideal End State
The selected Candidate 4 fully achieves the ideal end state:
1. Agents write standard Markdown/JSON to a local gitignored shadow path `.workrail/artifacts/<sessionId>/` (100% DX parity, zero overhead).
2. The engine persists them securely in the session log as Zod-validated `node_output_appended` events.
3. The Console renders them dynamically in a premium, beautifully styled read-only Document Viewer.
4. The user can export artifacts to git securely using the local CLI command `worktrain export-artifact`.
The ideal end state is a 100% virtual-only storage model with no workspace footprint. The selected hybrid model falls short of this because it still writes files to a hidden `.workrail/` subdirectory in the workspace. However, this is a necessary and fully justified tradeoff to support standard AI agent file tools and incremental diffs without introducing complex new MCP tool APIs.

---

## Proposed Changes

We propose implementing the hybrid Workspace Shadow & Console Export architecture across the engine and console:

### 1. Engine & Runtime Changes
- **Shadow Folder Creation & Lifecycle:** The engine will create `.workrail/artifacts/<sessionId>/` in the workspace at step entry. It will write any pre-existing artifacts from the session event log into this folder. When a session is archived, completed, or older than 30 days, the daemon/CLI will clean up these shadow folders to manage disk space.
- **Path Resolution:** The engine will dynamically rewrite the `designDocPath` and related path context variables to point into the session-specific shadow directory.
- **Git-Ignore Rule:** The engine will ensure `.workrail/` is added to the local repository's `.git/info/exclude` file automatically when starting a session. It will recursively traverse parent directories to locate the `.git` directory or file, and correctly handle Git worktrees (where `.git` is a file referencing the actual `gitdir` path) to locate the true `info/exclude` destination path. Updates will be wrapped in try-catch blocks to prevent concurrent write collisions from crashing startups.
- **Artifact Extraction & Validation:** On `continue_workflow` or `checkpoint_workflow`, the engine will scan the shadow folder, detect modified files, validate them against the Zod schemas/contracts registered in `spec/authoring-spec.json`, and commit them as `node_output_appended` events (using the existing `payloadKind: 'artifact_ref'`). If Zod validation fails, the engine blocks advancing and returns a format error message to the agent.
- **Every-Turn Artifact Directory Reminder:** 
  - Extend `V2PendingStepSchema` in `src/mcp/output-schemas.ts` to include an optional `artifactsDirectory?: string` field.
  - The engine will populate this field with the session-specific shadow folder path (e.g. `.workrail/artifacts/<sessionId>/`) on every turn.
  - The response formatter `src/mcp/v2-response-formatter.ts` will detect this field and automatically append a standardized reminder section in both classic and clean response formats on every turn:
    ```markdown
    Active Session Artifacts:
    - Directory: .workrail/artifacts/<sessionId>/
    (Please read and edit session artifacts inside this folder using standard filesystem tools.)
    ```

### 2. Console Changes
- **"Artifacts" Tab:** Add an "Artifacts" tab in the `SessionDetail.tsx` view (using the existing projected node details).
- **Premium Document Viewer (UI Layout):**
  - Renders a clean split-pane layout: a left-hand sidebar listing all artifacts (with metadata badges like `Markdown`, `HTML Report`, `Zod-Validated`, size, step) and a right-hand preview canvas.
  - **Aesthetics & Typography:** Uses a dedicated theme with Inter or Outfit fonts, proper line-heights, and clean margins (no default browser serifs). Uses subtle dark mode styling with glassmorphism backgrounds (backdrop-filters) and vibrant gradient borders.
  - **Custom Markdown Rendering:** Employs `react-markdown` with CSS overrides to style titles, margins, list indicators, and code blocks. Renders GitHub-style alert callouts (e.g. `[!NOTE]`, `[!WARNING]`) as custom colored blocks.
  - **Sandboxed HTML Rendering:** Renders HTML artifacts (`contentType: 'text/html'`) inside a sandboxed `iframe` using `srcDoc` (with `sandbox="allow-scripts"`) to allow interactive charts, rich HTML reports, and visualizations securely.
- **Read-Only Console Actions (Safe Action Toolbar):** Renders a glassmorphic toolbar at the top of the preview with "Copy to Clipboard" (with micro-animations) and "Download File" buttons. Displays a copy-pasteable command helper displaying:
  `To stage this in git, run: worktrain export-artifact <sessionId> <artifactName>`

### 3. CLI changes
- Add `worktrain export-artifact <sessionId> <artifactName> [destPath]` command. 
- Performs strict path validation: resolves the target destination using `path.resolve` and verifies it resides within the active workspace root. To prevent symlink escapes and resolve paths safely without crashing if the destination file does not exist yet (throwing `ENOENT` on `realpathSync`), it will resolve the real path (`fs.realpathSync`) of the resolved workspace root and the nearest existing parent directory of the target destination path, verifying that the target starts with the resolved workspace root path.
- Safely copies the artifact to the destination and runs `git add` to stage it, using a retry loop with exponential backoff on Git index lock collisions.

### 4. Architectural Invariants & Enforcements
- **Console Write-Privilege Enforcement:** The `console/` codebase must import **zero** write-capable filesystem modules. The console HTTP API exposes strictly `GET` methods for session inspection; no file-writing routes are allowed. Enforced via architecture unit tests.
- **Durable-First Event Log Sovereignty:** The append-only event log is the single source of truth. If the local shadow directory is deleted or corrupted mid-run, the engine will automatically restore it from the event log on the next tool call (self-healing rehydration).
- **Both-Sides-of-the-Fence execution:** Artifact paths are resolved dynamically relative to the `workspacePath` parameter, ensuring identical behavior for local interactive MCP sessions and headless Daemon sessions.
- **Local-Only Git Hygiene:** Ignore entries for `.workrail/` must be written only to the true resolved Git directory's `info/exclude` file to avoid dirtying the project's tracked `.gitignore` file.

---

## Verification Plan

### Automated Tests
- Add a unit test in `tests/unit/` verifying that the engine correctly writes session artifacts to the `.workrail/artifacts/<sessionId>/` directory on start/resume, and extracts them on step completion.
- Add an integration test confirming that `.workrail/` is successfully added to the workspace's `.git/info/exclude` if not present.

### Manual Verification
- Run a discovery workflow run using `workrail start`. Confirm that:
  - Ephemeral design files are written to `.workrail/artifacts/` instead of the root.
  - The git status of the repository remains clean.
- Open the WorkRail Console, click the "Artifacts" tab, and verify that the design candidates render as a styled document.
- Click the "Copy to Clipboard" and "Download" buttons in the Console to verify they function correctly.
- Run the CLI command `worktrain export-artifact` to verify the file is successfully copied to the root and staged in git.

---

## Tradeoff Review & Hidden Assumptions

### Tradeoff 1: Workspace Shadow Directory (.workrail/artifacts/)
- **Verification:** Does not violate any acceptance criteria. The `.workrail/` directory is locally ignored via `.git/info/exclude` dynamically at session startup, ensuring a clean git status for developer workspaces without dirtying the tracked `.gitignore` file.
- **Unacceptable Conditions:** If the agent runner is executed on a read-only filesystem (e.g., stateless cloud runner or serverless worker) where directory creation is blocked, or if local security policies prohibit writing hidden directories.
- **Hidden Assumptions:** Assumes that linter and compiler tools are configured to ignore `.workrail/` so they do not crash or waste processing time. Assumes that workflows pass absolute paths to the agent to prevent search tools (which ignore dotfiles by default) from missing the files.

### Tradeoff 2: Local CLI-Only Promotion (worktrain export-artifact)
- **Verification:** Preserves clean-by-default Git workspace and decoupled Console operations while meeting PR code review requirements.
- **Unacceptable Conditions:** If the developer expects 100% automated real-time syncing of agent plans to remote repository branches without local human intervention or agent-directed end-of-run commands.
- **Hidden Assumptions:** Assumes that developers are willing to run a CLI promotion command to publish artifacts to Git, or that workflows are designed to execute a final, automated export task as part of feature shipping.

---

## Failure Mode Coverage

### Failure Mode 1: Path Traversal during CLI Export
- **Risk Level:** **Critical (Highest Risk)**. If an agent/session produces a malicious artifact name like `../../.bashrc` or resolves to a symlink escaping the boundary, exporting it could overwrite sensitive files on the operator's system.
- **Coverage:** Managed via strict CLI validation. The `worktrain export-artifact` utility will normalize the destination path using `path.resolve` and verify that the target file path resides strictly within the bounds of the resolved active workspace directory. To prevent symlink escapes, the utility must resolve the absolute real path (`fs.realpathSync`) of both the target and the workspace, and verify that the resolved target path starts with the resolved workspace root path. If a path escape is detected, it will abort execution.

### Failure Mode 2: Search Clutter and Agent Tool Loops
- **Risk Level:** Medium. If the agent gets duplicate search hits on files in `.workrail/artifacts/`, it might enter a search/edit tool loop.
- **Coverage:** By placing files in `.workrail/` (a hidden dotfile directory), standard tools like `ripgrep` and IDE searchers ignore them by default.
- **Missing Mitigation:** Update instructions in `AGENTS.md` and `daemon-soul.md` to explicitly forbid agents from parsing or searching `.workrail/` directory paths unless directed by the workflow using an absolute file path parameter.

### Failure Mode 3: Sync races clobbering local shadow edits
- **Risk Level:** High. Resuming or rehydrating a session overwrites existing files in `.workrail/artifacts/` with the event log state. If the developer has made local modifications to files in `.workrail/artifacts/` before resume, those edits are silently overwritten and lost.
- **Coverage:** The engine will check the local files' modification times (`fs.statSync`) and avoid overwriting if the local file has been modified or is newer than the last synced state in the event log. The CLI export utility will also warn the developer if the local file's modification time in `.workrail/artifacts/` is newer than the last synced event index in the database.

### Failure Mode 4: Large Artifact Storage Limits
- **Risk Level:** Medium.
- **Coverage:** Artifacts exceeding 5MB will be saved as separate files in the local artifacts directory and referenced via a SHA256 key in the event log (similar to Git LFS), rather than being inlined completely in the JSON event database, preventing memory bloat.

### Failure Mode 5: Build Tool & Linter Scans of Dotfiles
- **Risk Level:** Medium.
- **Coverage:** Project level tool configuration (e.g. `tsconfig.json`, `eslint.config.js`, `jest.config.js`) will be documented to explicitly exclude `.workrail/` if they do not automatically ignore hidden files, preventing compilation errors.

### Failure Mode 6: Mid-Run Deletion/Modification of the Shadow Folder
- **Risk Level:** Low.
- **Coverage:** If shadow files are deleted or modified mid-run before `continue_workflow`, the engine on `continue_workflow` detects the absence/change. It will fall back to using the last committed state from the event log, and log a warning to the operator/agent.

### Failure Mode 7: Read-Only Filesystems
- **Risk Level:** High.
- **Coverage:** If the environment does not allow writing to `.workrail/artifacts/` (e.g. stateless serverless cloud environments), the engine will detect the write failure and dynamically fall back to Virtual-Only storage (Candidate 1), serving and accepting artifacts directly via MCP tools/parameters without local files.

### Failure Mode 8: Git Index Lock Collisions
- **Risk Level:** Medium.
- **Coverage:** Concurrent execution of `worktrain export-artifact` staging files can collide on `.git/index.lock`, causing operations to crash. Add a retry loop with exponential backoff on Git operations in the CLI export utility.

### Failure Mode 9: Exclude File Write Collisions
- **Risk Level:** Low.
- **Coverage:** Concurrent session startups attempting to write to `.git/info/exclude` can cause write collisions or lock conflicts. Wrap exclude updates in try-catch blocks to ignore lock/write failures gracefully.

---

## Simpler Alternative & Hybrid Analysis

### Simpler Variant Evaluation
A simpler version of the selected design would omit the custom `worktrain export-artifact` CLI command entirely, requiring the operator or the agent to manually copy the files from the shadow directory to the workspace root using standard shell utilities (e.g. `cp .workrail/artifacts/sess_123/artifact.md artifact.md`).
- **Verdict:** While this is simpler to implement (less engine/CLI code to maintain), it places significant operational friction on the developer (CLI fatigue locating active session IDs) and is error-prone for agents trying to resolve the current session's path. Therefore, the custom CLI command is fully justified.

### Hybrid Evaluation
Our selected direction is already a hybrid of Candidate 2 (Workspace Shadow Directory) and Candidate 4 (Git sync / CLI promotion), augmented by the read-only Console constraints from the adversarial challenge. This hybrid resolves the core tension between workspace cleanliness, security, and Git PR loops without introducing unnecessary complexities like file watchers or git clean/smudge configurations.

---

## Philosophy Alignment

### Satisfied Principles
- **Both-Sides-of-the-Fence Execution (docs/vision.md):** Fully satisfied. Using a workspace shadow folder `.workrail/artifacts/<sessionId>/` ensures that both local sandboxed stdio MCP sessions and headless Daemon runners can write and edit artifacts using standard, native filesystem tools.
- **Observable by Default (docs/vision.md):** Fully satisfied. Artifacts are automatically committed on step transitions to the session log as Zod-validated `node_output_appended` events, preserving full historical versioning and making them observable locally and remotely.
- **Typed Contracts at Phase Boundaries (docs/vision.md):** Fully satisfied. Workflows declare artifact contracts, which are validated by Zod at step exits.
- **Systems Simplicity:** Fully satisfied. We avoided complex virtual file systems, watchers, or git smudgers, preferring simple directory mappings and a clean CLI export command.

### Tensions & Adjudication
- *Tension: Cleanliness vs. Tool Access.* Solved via a local gitignored subdirectory.
- *Tension: Secure Console vs. Git reviews.* Solved by restricting Console actions to read-only (Copy/Download) and placing Git-promotion write access in the local CLI (`worktrain export-artifact`).

---

- **Selected Path:** `full_spectrum`
- **Problem Framing:** Persist, retrieve, and view session-produced artifacts within the WorkRail session store and Console, without workspace pollution or agent complexity, while supporting rich HTML-rendered visual display.
- **Landscape Takeaways:** WorkRail has back-end event log storage for inlined artifacts, and the Console API serves them. However, current workflows write to the workspace root, polluting the repo, and the Console renders them only as raw JSON `pre` blocks.
- **Chosen Direction:** A hybrid shadow-directory workspace folder (`.workrail/artifacts/<sessionId>/`) where the engine rehydrates and extracts files automatically during execution, preserving agent tool compatibility and incremental edits, integrated with a Console/CLI export system for git/PR review.
- **Strongest Alternative:** Standalone virtual-only storage, rejected because it forces complex tool changes and token-heavy editing operations on the AI agents.
- **Confidence Band:** `medium`
- **Residual Risks:** Ripgrep search invisibility of dotfolders (mitigated by passing absolute paths in prompt context), CI/CD checker dependencies, and developer shadow folder deletion mid-run (mitigated by engine rehydration self-healing).
- **Next Actions:**
  1. File a GitHub issue with groom-ready details.
  2. Implement engine shadow folder rehydration and extraction.
  3. Implement Console "Artifacts" tab with React Markdown rendering and sandboxed `iframe` HTML viewer.
  4. Implement Console "Copy to Clipboard" and "Download" buttons, and the `worktrain export-artifact` CLI export command.
