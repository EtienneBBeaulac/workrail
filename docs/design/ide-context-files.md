# IDE Context Files Discovery

**Status:** Complete -- ready for implementation
**Workflow:** wr.discovery
**Confidence:** HIGH

---

## Artifact Strategy

This document is a **human-readable record** of research findings and decisions. It is NOT the execution truth for the workflow -- that lives in WorkRail's step notes and context variables. If a chat rewind occurs, this file may not reflect the latest state; refer to the WorkRail session for canonical progress.

Use this doc to: review findings, understand tradeoffs, reference the final TypeScript array.
Do NOT use this doc as: the authoritative source of what the workflow has or hasn't done.

---

## Context / Ask

**Stated Goal (solution-statement):** Discover every file path where agentic IDEs, AI coding tools, and autonomous agent frameworks store project-level and user-level context/rules/instructions files so WorkTrain can load all of them into the session system prompt.

**Scope:** `src/daemon/workflow-runner.ts` (`WORKSPACE_CONTEXT_CANDIDATE_PATHS`). Do NOT touch `src/mcp/`.

**Reframed Problem:** WorkTrain generates code inconsistent with team conventions when developers use AI tools other than Claude Code, because their project-specific rules live in tool-specific config files that WorkTrain never reads.

---

## Path Recommendation

**Chosen path:** `landscape_first`

**Rationale:** The solution direction (auto-discover known file paths) is correct for WorkTrain's zero-config philosophy. The dominant need is an accurate landscape of what files each tool actually uses -- not a fundamental reframing of the approach. The design risk is low; the research risk is high (paths change between versions, some tools have multiple formats).

**Why not `design_first`:** The stated solution is independently the right answer. The alternatives (manual paste, user-configured paths) shift burden to the user in ways incompatible with WorkTrain's zero-config design.

---

## Constraints / Anti-goals

**Constraints:**
- Scope limited to `src/daemon/workflow-runner.ts` -- do not touch `src/mcp/`
- Must not break existing behavior for Claude Code users
- Must handle file format differences (YAML, frontmatter, plain markdown)
- Context window budget: existing cap is 32KB combined (`WORKSPACE_CONTEXT_MAX_BYTES`)

**Anti-goals:**
- Do NOT implement a plugin system or user-configurable path list (YAGNI)
- Do NOT parse/execute structured config files (e.g., Aider's YAML) as code
- Do NOT load binary or non-text files
- Do NOT change the priority order for the currently-supported Claude Code files

---

## Challenged Assumptions

1. **Files are plain text injectable directly into the system prompt**
   - Why it might be wrong: Cursor `.mdc` files have YAML frontmatter metadata; Aider `.aider.conf.yml` is YAML config not freeform prose; mixing structured config keys with instructions would pollute the prompt
   - Evidence needed: Inspect actual format of each file type before deciding injection strategy

2. **Loading more context files always improves output quality**
   - Why it might be wrong: Conflicting rules from multiple tools could confuse the model; large injections consume context window that may be better used for code
   - Evidence needed: Empirical comparison of curated vs. exhaustive injection (not yet available)

3. **The set of tools and their config file paths is stable enough to hardcode**
   - Why it might be wrong: Cursor already migrated from `.cursorrules` to `.cursor/rules/*.mdc` between versions; tools iterate quickly
   - Evidence needed: Check changelogs for Cursor/Windsurf for path changes in the past 12 months

---

## Landscape Packet

### Claude Code -- Official Documentation

Source: https://code.claude.com/docs/en/memory (confirmed, April 2026)

**Workspace/project paths (searched up the directory tree from CWD):**
- `CLAUDE.md` -- project instructions (root)
- `.claude/CLAUDE.md` -- project instructions (hidden dir)
- `CLAUDE.local.md` -- personal project prefs, gitignored
- `.claude/rules/*.md` -- modular rules, optional YAML frontmatter with `paths:` for path-scoping

**User-level paths:**
- `~/.claude/CLAUDE.md` -- personal preferences, all projects
- `~/.claude/rules/*.md` -- personal rules, all projects

**Org-level managed policy:**
- macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`
- Linux/WSL: `/etc/claude-code/CLAUDE.md`

**Format:** Plain markdown. `.claude/rules/*.md` files may have YAML frontmatter with `paths:` globs.

**Note on AGENTS.md:** Claude Code reads `CLAUDE.md`, not `AGENTS.md`. Teams using both tools should have `CLAUDE.md` import `AGENTS.md` via `@AGENTS.md`.

---

### Cursor -- Empirical Evidence

Source: Direct filesystem inspection of `/Users/etienneb/git/zillow/zillow-android-2/.cursor/rules/` (April 2026) + community knowledge. Official docs (cursor.com) are JavaScript SPA -- not fetchable with curl/WebFetch.

**Workspace/project paths:**
- `.cursorrules` -- legacy single file, still works (plain markdown)
- `.cursor/rules/*.mdc` -- current recommended approach (YAML frontmatter + markdown body)

**User-level paths:**
- `~/.cursor/rules/` -- user-level rules directory (no files found in this env)

**Format:**
- `.cursorrules`: plain markdown, injected verbatim
- `.mdc` files: YAML frontmatter (has `alwaysApply:`, `description:`, `_cg_managed:`, etc.) + markdown body. **Requires frontmatter stripping before injection.**

**Example frontmatter observed:**
```yaml
---
_cg_managed: "true"
alwaysApply: true
description: "Team-wide context from common-ground. Always applied."
---
```

**Status:** `.cursorrules` is legacy but still functional. `.cursor/rules/*.mdc` is the current format.

---

### Windsurf (Codeium) -- Official Documentation

Source: https://docs.windsurf.com/windsurf/cascade/memories (confirmed, April 2026)

**Workspace/project paths:**
- `.windsurf/rules/*.md` -- project rules (YAML frontmatter + markdown, individual files per rule)
- `AGENTS.md` or `agents.md` anywhere in workspace (auto-scoped by directory)

**User-level paths:**
- `~/.codeium/windsurf/memories/global_rules.md` -- global rules, all workspaces (6,000 char limit)

**Org/system-level (enterprise):**
- macOS: `/Library/Application Support/Windsurf/rules/*.md`
- Linux/WSL: `/etc/windsurf/rules/*.md`

**Format:** Markdown with YAML frontmatter. Frontmatter includes `trigger:` (always-on vs. conditional). **Requires frontmatter stripping.**

**Note:** `.windsurfrules` is NOT documented -- confirmed not in use.

---

### GitHub Copilot -- Official Documentation

Source: https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot (confirmed, April 2026)

**Workspace/project paths:**
- `.github/copilot-instructions.md` -- repository-wide instructions (plain markdown)
- `.github/instructions/*.instructions.md` -- path-scoped instructions (YAML frontmatter with glob patterns)

**User-level paths (JetBrains):**
- macOS: `~/.config/github-copilot/intellij/global-copilot-instructions.md`

**Format:**
- `copilot-instructions.md`: plain markdown, injected verbatim
- `*.instructions.md`: YAML frontmatter with `applyTo:` glob patterns + markdown body

**Priority:** Personal instructions > repository instructions > organization instructions

---

### Aider -- Official Documentation

Source: https://aider.chat/docs/usage/conventions.html (confirmed, April 2026)

**Workspace/project paths:** NONE auto-discovered.

Aider does NOT auto-discover any context files. Users must explicitly configure:
- `--read CONVENTIONS.md` flag (any filename)
- Or `read: CONVENTIONS.md` in `.aider.conf.yml`

**Format:** Not applicable -- no auto-discovered files.

**Verdict:** Aider has no fixed path to add to WorkTrain's candidate list.

---

### Continue.dev -- Official Documentation

Source: https://docs.continue.dev/customize/deep-dives/rules (confirmed, April 2026)

**Workspace/project paths:**
- `.continue/rules/*.md` -- individual markdown files (one rule per file)

**User-level paths:**
- `~/.continue/rules/*.md` -- global rules, all workspaces

**Format:** Plain markdown. No frontmatter requirement noted.

---

### Devin (Cognition) -- Official Documentation

Source: https://docs.devin.ai/llms.txt (confirmed, April 2026)

**Workspace/project paths:**
- `AGENTS.md` -- project root or anywhere in repo (already covered)

**Format:** Plain markdown.

---

### Firebender -- Empirical Evidence

Source: Direct filesystem inspection of `/Users/etienneb/git/zillow/zillow-android-2/.firebender/` (April 2026) + `docs/integrations/firebender.md` in this repo.

**Workspace/project paths:**
- `.firebender/AGENTS.md` -- project-level agent instructions (plain markdown)
- `.firebender/rules/*.mdc` -- project rules (YAML frontmatter + markdown body)

**User-level paths:**
- `~/.firebender/rules/` -- global rules (no files found in this env, directory present)
- `~/.firebender/firebender.json` -- global config (subagents, commands -- not a context file)

**Format:** Same `.mdc` format as Cursor -- YAML frontmatter + markdown. **Requires frontmatter stripping.**

---

### Cody (Sourcegraph) -- Research Result

No project-level context files found in official docs. Configuration is managed through Sourcegraph Enterprise instance settings. No fixed path for WorkTrain to read.

---

### Gemini Code Assist (Google) -- Research Result

No project-level context/rules files documented. Mentions `.aiexclude` for file exclusion (like `.gitignore`), not instructions. No path to add.

---

### OpenAI Codex / o3 -- Knowledge

`AGENTS.md` is the specified file (already covered). No other auto-discovered paths documented.

---

## What Exists Locally (This Environment)

Confirmed via filesystem scan (April 2026):

| File pattern | Present? | Where |
|---|---|---|
| `.cursorrules` | YES | Firebender worktrees + zillow-android repos |
| `.cursor/rules/*.mdc` | YES | Multiple zillow repos + worktrees |
| `.windsurf/rules/*.md` | YES | Multiple zillow repos |
| `.github/copilot-instructions.md` | YES | zillow-android-2 + worktrees |
| `CLAUDE.md` | YES | workrail, zillow-android-2, many repos |
| `AGENTS.md` | YES | workrail, zillow-android-2, many repos |
| `.firebender/AGENTS.md` | YES | zillow-android-2 + worktrees |
| `.firebender/rules/*.mdc` | YES | Multiple zillow repos |
| `~/.claude/CLAUDE.md` | NO | Not present |
| `~/.continue/rules/` | NO | Not present |
| `.windsurfrules` | NO | Not found anywhere |
| `.aider.conf.yml` | NO | Not found |

---

## Problem Frame Packet

**Core tension:** Three categories of files exist:

1. **Literal paths** -- single stable files like `.github/copilot-instructions.md` that can be added to `WORKSPACE_CONTEXT_CANDIDATE_PATHS` as-is
2. **Glob patterns** -- directories like `.cursor/rules/*.mdc` that require scanning + concatenation, not supported by current literal-path implementation
3. **Format stripping required** -- `.mdc` files and `.windsurf/rules/*.md` files have YAML frontmatter that must be stripped before injection

**Implication:** The current `WORKSPACE_CONTEXT_CANDIDATE_PATHS` literal-path approach handles category 1 only. Supporting categories 2 and 3 requires a code change to `workflow-runner.ts` -- either:
- Extend the path entry type to support glob patterns
- Strip YAML frontmatter from files before injection

**Contradictions found (1):**
- `.windsurfrules` is widely referenced in community resources and other tools' docs but is NOT in Windsurf's own official documentation. The actual Windsurf convention is `.windsurf/rules/*.md`. This contradicts the assumption in the original goal statement.

**Evidence gaps (2):**
- Cursor's official docs are not accessible (JavaScript SPA). File format confirmed empirically but version history unknown.
- `.cursor/rules/` user-level path (`~/.cursor/rules/`) is present as an empty directory -- documented but not in use locally.

---

## Problem Frame Packet

### Primary Users

Developers using WorkTrain alongside other AI coding tools (Cursor, Windsurf, Firebender, GitHub Copilot) in the same repository. Their team's coding conventions are distributed via tool-specific config files that WorkTrain never reads, causing generated code to miss team standards.

### Jobs / Desired Outcomes

- "I want to set up coding conventions once and have all my AI tools follow them automatically"
- "When WorkTrain generates code in my monorepo, it should follow the same rules as Cursor does"

### Core Tensions

1. **Literal paths vs. glob patterns:** The existing `WORKSPACE_CONTEXT_CANDIDATE_PATHS` is a `string[]` of literal relative paths. The most important new conventions (`.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, `.firebender/rules/*.mdc`) require glob scanning. This is a scope expansion.

2. **More context vs. context quality:** Injecting raw `.mdc` files adds YAML frontmatter (`alwaysApply: true`, `description: "..."`) into the system prompt. This metadata is noise for WorkTrain. Injecting without stripping is worse than not injecting.

3. **Stability vs. completeness:** Some tools (Cursor) already migrated conventions once. A hardcoded list requires maintenance. But a plugin/discovery system is over-engineering for now (YAGNI).

### Success Criteria

1. A developer's `.cursorrules` or `.cursor/rules/*.mdc` rules appear in WorkTrain sessions without manual config
2. The frontmatter in `.mdc` / `.windsurf/rules/*.md` files is stripped before injection
3. The `WORKSPACE_CONTEXT_CANDIDATE_PATHS` entry type is expanded to support `{ pattern: string, stripFrontmatter?: boolean }` (or equivalent)
4. All added paths have cited sources
5. User-level global context paths are documented separately from workspace paths
6. Priority order is deterministic and documented

### HMW Questions

- "How might we support glob patterns in `WORKSPACE_CONTEXT_CANDIDATE_PATHS` without breaking the existing literal-path contract?"
- "How might we strip YAML frontmatter without risking stripping legitimate content from plain markdown files?"

### Framing Risks

1. **Scope creep risk:** The code change to support glob patterns touches more of `workflow-runner.ts` than "just adding strings to an array." This might be better as a separate PR.
2. **False assumption in original goal:** `.windsurfrules` does NOT exist -- Windsurf uses `.windsurf/rules/*.md`. If implemented based on the original assumption, the Windsurf path would be wrong.
3. **Frontmatter stripping could be lossy:** Some `.mdc` files might have content above the `---` delimiter that isn't frontmatter. The stripping logic must handle edge cases.

---

## Candidate Generation Expectations

**Path:** `landscape_first` + `THOROUGH`

**What the candidate set must cover:**
1. Reflect the Phase A / Phase B distinction discovered in landscape research -- not all candidates need both phases
2. Must include a minimalist option (literal paths only, zero code change to resolution logic)
3. Must include an option that separates glob-pattern scanning from the existing literal-path array (parallel structures)
4. Must include at least one option that considers frontmatter metadata as useful signal (e.g., skip `alwaysApply: false` rules)
5. Must NOT cluster -- all 4 candidates should differ on scope, implementation approach, or frontmatter handling

**Candidates must not do:**
- Touch `src/mcp/`
- Break existing 4 paths
- Exceed WORKSPACE_CONTEXT_MAX_BYTES
- Add files without cited sources

---

## Candidate Directions

### Candidate 1 -- Minimal literal path expansion (Phase A only)

**One-sentence summary:** Add 3 literal paths to the existing `string[]` array with zero code changes.

**New paths added:**
- `CLAUDE.local.md` -- Claude Code personal project prefs (official docs, high confidence)
- `.cursorrules` -- Cursor legacy rules, plain markdown (empirically confirmed)
- `.github/copilot-instructions.md` -- GitHub Copilot (official docs, high confidence)

**Tensions resolved:** None of the structural ones.
**Tensions accepted:** No glob support (misses `.cursor/rules/*.mdc`), no frontmatter handling.
**Failure mode:** `.cursorrules` often has the same content as `.cursor/rules/*.mdc` in the Zillow setup -- double-injection possible. Not harmful but wastes budget.
**Scope judgment:** Too narrow -- misses the most actively-used paths in this environment.
**Philosophy:** Honors YAGNI, immutability. Conflicts with Explicit Domain Types.

---

### Candidate 2 -- Literal paths + unconditional frontmatter stripper (Phase A + stripping)

**One-sentence summary:** Add the same 3 literal paths AND a `stripFrontmatter(content: string): string` pure function called on every file before injection (safe no-op if no frontmatter present).

**New function shape:**
```typescript
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content; // malformed -- don't strip
  return content.slice(end + 4).trimStart();
}
```

**Tensions resolved:** Frontmatter pollution (safe, starts-with-`---` guard).
**Tensions accepted:** No glob support, string[] type stays primitive.
**Failure mode:** A file that legitimately starts with `---` on line 1 (extremely unlikely for instruction files) gets incorrectly stripped.
**Scope judgment:** Best-fit incremental -- clean injection without full type expansion.
**Philosophy:** Honors Compose with small pure functions. Conflicts with Make illegal states unrepresentable (stripping not in type).

---

### Candidate 3 -- Discriminated union type + glob expansion + frontmatter stripping (Phase A + B)

**One-sentence summary:** Replace `string[]` with `readonly WorkspaceContextCandidate[]` (discriminated union), expand `loadWorkspaceContext()` to handle glob entries with alpha-sorted expansion and per-entry frontmatter stripping.

**New type:**
```typescript
type LiteralCandidatePath = {
  readonly kind: 'literal';
  readonly relativePath: string;
  readonly stripFrontmatter?: boolean;
};
type GlobCandidatePath = {
  readonly kind: 'glob';
  readonly pattern: string;
  readonly stripFrontmatter: boolean;
  readonly sort: 'alpha';
};
type WorkspaceContextCandidate = LiteralCandidatePath | GlobCandidatePath;
```

**Full candidate array includes:** `.claude/CLAUDE.md`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.github/AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc` (glob, strip), `.windsurf/rules/*.md` (glob, strip), `.firebender/rules/*.mdc` (glob, strip), `.firebender/AGENTS.md`, `.github/copilot-instructions.md`, `.continue/rules/*.md` (glob, no strip).

**Tensions resolved:** All 4 -- expressive type, glob support, frontmatter in contract, deterministic ordering.
**Failure mode:** (1) Per-glob file count cap needed (e.g. max 20 files). (2) Glob dependency -- check if `fast-glob` already in package.json or use Node 22+ `fs.glob`.
**Scope judgment:** Best-fit -- broader than Candidate 1/2 but fully contained in `workflow-runner.ts`.
**Philosophy:** Honors Explicit domain types, Unrepresentable illegal states, Exhaustiveness. Moderate YAGNI tension for Continue.dev (unused locally).

---

### Candidate 4 -- Parallel Set for strip flags (NOT recommended)

**One-sentence summary:** Keep `string[]` unchanged and add a parallel `Set<string>` of paths that need frontmatter stripping.

**Tensions resolved:** Backward compatibility only.
**Failure mode:** Maintenance trap -- easy to add a path and forget to update the Set.
**Scope judgment:** Too narrow in design quality (patch, not fix).
**Philosophy:** Conflicts with Architectural fixes over patches, Unrepresentable illegal states. **NOT recommended.**

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-19 | Path: landscape_first | Solution direction is correct; dominant need is accurate file path data |
| 2026-04-19 | Scope: workflow-runner.ts only | MCP layer should not be touched per stated constraint |
| 2026-04-19 | Selected: Candidate 3 (discriminated union + glob + stripping) | tinyglobby already in package.json, Node v25.2.1, no external callers of WORKSPACE_CONTEXT_CANDIDATE_PATHS, glob paths empirically confirmed present in user's repos |
| 2026-04-19 | Runner-up: Candidate 2 (literal + stripping) | Would be the choice if tinyglobby were unavailable or if glob paths were speculative |
| 2026-04-19 | Priority order: .cursor/rules/*.mdc before .cursorrules | Glob format first, legacy fallback second -- reduces duplicate injection when both exist |
| 2026-04-19 | .windsurfrules does NOT exist | Confirmed: Windsurf uses .windsurf/rules/*.md directory per official docs + local scan |

---

## Final Summary

### Recommendation

**Selected direction:** Candidate 3 -- Discriminated union type + glob expansion + frontmatter stripping.

**Confidence band:** HIGH. All factual preconditions verified empirically.

### Implementation Contract

**New type (add to `workflow-runner.ts`):**
```typescript
/**
 * A literal path entry: a single file at a known relative path.
 * WHY: Claude Code paths are stable single-file conventions.
 */
type LiteralCandidatePath = {
  readonly kind: 'literal';
  readonly relativePath: string;
  // WHY: even literal paths may have YAML frontmatter (e.g., CLAUDE.md imported
  // from tools that inject frontmatter). stripFrontmatter defaults false for
  // existing Claude Code paths to preserve backward compatibility.
  readonly stripFrontmatter?: boolean;
};

/**
 * A glob pattern entry: zero or more files matching a pattern in a directory.
 * WHY: Cursor, Windsurf, and Firebender all use directory-based conventions
 * where teams add multiple rule files. A glob pattern discovers them all.
 */
type GlobCandidatePath = {
  readonly kind: 'glob';
  // Relative to workspacePath, e.g. '.cursor/rules/*.mdc'
  readonly pattern: string;
  // WHY: .mdc (Cursor/Firebender) and .windsurf/rules/*.md files have YAML
  // frontmatter with metadata (alwaysApply, description, etc.) that is not
  // meant for LLM consumption. Must be stripped before injection.
  readonly stripFrontmatter: boolean;
  // WHY: tinyglobby order is filesystem-dependent. Alpha sort ensures the same
  // workspace produces the same context on every WorkTrain session.
  readonly sort: 'alpha';
};

type WorkspaceContextCandidate = LiteralCandidatePath | GlobCandidatePath;
```

**New constant (replace existing `WORKSPACE_CONTEXT_CANDIDATE_PATHS`):**
```typescript
/**
 * WHY priority order: More specific (tool-specific, project-specific) before
 * more general. User-written Claude Code config takes top priority. Glob
 * formats (newer) come before legacy single-file formats (older) for each tool
 * to reduce duplicate injection when both coexist.
 *
 * Sources:
 *   Claude Code: https://code.claude.com/docs/en/memory (April 2026)
 *   Cursor .cursorrules: empirical (zillow-android-2/.cursorrules)
 *   Cursor .cursor/rules/*.mdc: empirical (zillow-android-2/.cursor/rules/)
 *   Windsurf .windsurf/rules/*.md: https://docs.windsurf.com/windsurf/cascade/memories (April 2026)
 *   Firebender .firebender/rules/*.mdc: empirical (zillow-android-2/.firebender/rules/)
 *   Firebender AGENTS.md: docs/integrations/firebender.md + empirical
 *   GitHub Copilot: https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot (April 2026)
 *   Continue.dev: https://docs.continue.dev/customize/deep-dives/rules (April 2026)
 *
 * NOTE: .windsurfrules does NOT exist -- Windsurf uses .windsurf/rules/ directory.
 * NOTE: alwaysApply: false rules in .mdc files are injected unconditionally in
 *   Phase 1. Phase 2 will add filtering based on the alwaysApply frontmatter field.
 */
const WORKSPACE_CONTEXT_CANDIDATE_PATHS: readonly WorkspaceContextCandidate[] = [
  { kind: 'literal', relativePath: '.claude/CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.local.md' },
  { kind: 'literal', relativePath: 'AGENTS.md' },
  { kind: 'literal', relativePath: '.github/AGENTS.md' },
  // Cursor: newer directory format before legacy single-file format
  { kind: 'glob', pattern: '.cursor/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.cursorrules' },
  // Windsurf: directory format only (.windsurfrules does NOT exist per official docs)
  { kind: 'glob', pattern: '.windsurf/rules/*.md', stripFrontmatter: true, sort: 'alpha' },
  // Firebender: both AGENTS.md convention and rules directory
  { kind: 'glob', pattern: '.firebender/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.firebender/AGENTS.md' },
  // GitHub Copilot
  { kind: 'literal', relativePath: '.github/copilot-instructions.md' },
  // Continue.dev
  { kind: 'glob', pattern: '.continue/rules/*.md', stripFrontmatter: false, sort: 'alpha' },
] as const;

/**
 * Maximum files to read per glob pattern.
 * WHY: Prevents I/O cost and context budget waste in repos where .cursor/rules/
 * or similar directories contain many files (generated artifacts, etc.).
 */
const MAX_GLOB_FILES_PER_PATTERN = 20;
```

**New helper function:**
```typescript
/**
 * Strip YAML frontmatter from file content before injection into the system prompt.
 *
 * WHY: .mdc files (Cursor, Firebender) and .windsurf/rules/*.md files include
 * YAML metadata (alwaysApply, description, trigger) that is tool-specific and
 * not meaningful in a WorkTrain system prompt context.
 *
 * Safety: Only strips if the file starts with '---' (YAML frontmatter is always
 * at the start of the file). Returns original content unchanged if:
 * - File does not start with '---\n' (no frontmatter present -- safe no-op)
 * - No closing '---' delimiter found (malformed frontmatter -- preserve as-is)
 *
 * Called unconditionally on all injected content regardless of the
 * stripFrontmatter flag (the flag documents which files are EXPECTED to have
 * frontmatter; the implementation is unconditionally defensive).
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trimStart();
}
```

**Updated `loadWorkspaceContext()` loop (pseudocode):**
```typescript
for (const entry of WORKSPACE_CONTEXT_CANDIDATE_PATHS) {
  if (truncated) break;
  
  if (entry.kind === 'literal') {
    // existing behavior: read single file, skip ENOENT silently
    const content = await tryReadFile(path.join(workspacePath, entry.relativePath));
    if (content === null) continue;
    accumulateWithBudget(entry.relativePath, stripFrontmatter(content));
  } else {
    // glob: expand pattern, sort, cap, read each
    const matches = await glob(entry.pattern, { cwd: workspacePath });
    const sorted = matches.sort().slice(0, MAX_GLOB_FILES_PER_PATTERN);
    if (matches.length > MAX_GLOB_FILES_PER_PATTERN) {
      console.warn(`[WorkflowRunner] ${entry.pattern}: ${matches.length} files found, capped at ${MAX_GLOB_FILES_PER_PATTERN}`);
    }
    for (const relativePath of sorted) {
      if (truncated) break;
      const content = await tryReadFile(path.join(workspacePath, relativePath));
      if (content === null) continue;
      accumulateWithBudget(relativePath, stripFrontmatter(content));
    }
  }
}
```

### User-Level Global Context Paths

These are NOT added to `WORKSPACE_CONTEXT_CANDIDATE_PATHS` (workspace-relative only). Document here for future consideration:

| Tool | User-level path | Format |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | Plain markdown |
| Claude Code | `~/.claude/rules/*.md` | Markdown with optional frontmatter |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | Plain markdown |
| GitHub Copilot (JetBrains) | `~/.config/github-copilot/intellij/global-copilot-instructions.md` | Plain markdown |
| Continue.dev | `~/.continue/rules/*.md` | Plain markdown |

Loading user-level paths is a potential Phase 3 enhancement. It requires knowing the user's home directory and handling OS-level paths correctly.

### Strongest Alternative

**Candidate 2** (literal paths + unconditional stripping, no glob support) would be the choice if:
- `tinyglobby` were not already a dependency, OR
- The glob paths were speculative (not found locally)

Neither condition holds.

### Residual Risks

1. **`alwaysApply: false` rules injected unconditionally** -- accepted for Phase 1, deferred to follow-up issue. Content is over-broad but not incorrect.
2. **Cursor official docs inaccessible** -- format confirmed empirically. If Cursor changes `.mdc` format, the design doc will need re-research.
3. **Duplicate content** -- `.cursorrules` and `.cursor/rules/*.mdc` may contain identical content. Priority order (glob first) naturally limits duplication. Not harmful.

### Follow-up Work

- GitHub issue: `feat(engine): filter alwaysApply: false rules from .mdc context injection`
- Consider loading user-level global context paths (Phase 3)
