# IDE Context Files -- Design Candidates

**Status:** Raw investigative material for main agent review. Not a final decision.
**Parent doc:** `docs/design/ide-context-files.md`

---

## Problem Understanding

### Core Tensions

1. **Literal paths vs. glob patterns.** The current `WORKSPACE_CONTEXT_CANDIDATE_PATHS` is a `readonly string[]`. The most valuable new conventions (`.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, `.firebender/rules/*.mdc`) use directory-based glob patterns, not single files. Supporting them requires either a type change or a parallel mechanism.

2. **Frontmatter stripping vs. verbatim injection.** `.mdc` files (Cursor, Firebender) and `.windsurf/rules/*.md` files have YAML frontmatter (`alwaysApply: true`, `description: "..."`, etc.). Injecting raw content would pollute the system prompt with metadata the model is not expecting. Stripping must be correct (safe no-op when no frontmatter present) and not lossy.

3. **Type expressivity vs. simplicity.** A richer type (`{ kind: 'literal' | 'glob'; ... }`) expresses the behavioral contract but makes the array harder to read at a glance compared to plain strings.

4. **Scope creep vs. incompleteness.** Phase A alone (literal paths only) ships fast but skips the actively-used glob paths in this environment. Phase A+B ships everything needed but is a larger PR.

### What Makes This Hard

- The `---` YAML frontmatter delimiter is also a valid markdown horizontal rule. Stripping logic must only trigger if `---` appears at the very start of the file.
- Glob expansion order must be deterministic. Multiple `.mdc` files in `.cursor/rules/` without a defined order would produce non-deterministic context injection.
- The `as const` annotation on the current array makes it a `readonly string[]` -- adding objects requires removing `as const` and replacing with an explicit `readonly WorkspaceContextCandidate[]` type.
- The existing `loadWorkspaceContext()` loop at line 960 iterates `for (const relativePath of WORKSPACE_CONTEXT_CANDIDATE_PATHS)` -- this must be refactored to handle both literal and glob entries.

### Likely Seam

`WORKSPACE_CONTEXT_CANDIDATE_PATHS` constant (line 180) + `loadWorkspaceContext()` function (line 955) in `src/daemon/workflow-runner.ts`. This is the correct and only seam -- no MCP code touches this.

---

## Philosophy Constraints

Principles from `AGENTS.md` that are directly relevant:

- **Explicit domain types over primitives** -- `string[]` is too primitive. A discriminated union expresses the behavioral differences.
- **Make illegal states unrepresentable** -- "this path needs frontmatter stripping" is state that should live in the type, not in a comment or a parallel Set.
- **Architectural fixes over patches** -- adding a parallel `Set` for strip flags is a patch; a type expansion is a fix.
- **Compose with small pure functions** -- `stripFrontmatter(content)` as a pure function is the right shape.
- **YAGNI with discipline** -- the glob paths are NOT speculative; they are confirmed present in the user's repos. YAGNI does not argue against them.
- **Errors are data** -- stripping failures (malformed frontmatter) should return original content, not throw.
- **Immutability by default** -- the new array must be `readonly WorkspaceContextCandidate[]`.

**No philosophy conflicts among the stated principles for Candidate 3.** YAGNI vs. unrepresentable-states is only a tension if the glob paths were speculative -- they are not.

---

## Impact Surface

Code that must remain consistent if `WORKSPACE_CONTEXT_CANDIDATE_PATHS` changes:

1. **`loadWorkspaceContext()` (line 955):** The main consumer. Must be refactored to handle `kind: 'literal'` and `kind: 'glob'` branches.
2. **System prompt format (line 983):** `parts.push(\`### ${relativePath}\n${content}\`)` -- the `### filename` header format must be preserved for glob entries (use the expanded file path as the header).
3. **Console.log (line 999):** `WORKSPACE_CONTEXT_CANDIDATE_PATHS.filter(...)` -- this will need updating to log which glob patterns contributed files.
4. **`WORKSPACE_CONTEXT_MAX_BYTES` enforcement (line 979):** Must cover glob-expanded files. The byte budget logic already handles per-file truncation correctly.

**External consumers:** None. `WORKSPACE_CONTEXT_CANDIDATE_PATHS` is not exported and not imported outside `workflow-runner.ts`. Confirmed via grep.

---

## Candidates

### Candidate 1 -- Minimal literal path expansion

**Summary:** Add 3 strings to the existing `string[]`. Zero code change to `loadWorkspaceContext()`.

**New paths:**
- `CLAUDE.local.md` (Claude Code official docs, personal project prefs)
- `.cursorrules` (Cursor legacy, plain markdown, empirically confirmed)
- `.github/copilot-instructions.md` (GitHub Copilot official docs)

**Tensions resolved:** None of the structural ones.
**Tensions accepted:** All four. No glob support. No frontmatter handling. String[] stays primitive.
**Boundary solved at:** Data only (the constant array).
**Why this boundary:** Easiest possible change.
**Failure mode:** `.cursorrules` and `.cursor/rules/team-context.mdc` in Zillow repos contain the same content -- double-injection wastes context budget. Not harmful but suboptimal.
**Repo pattern:** Follows exactly.
**Gains:** Ships in minutes, zero regression risk.
**Losses:** Misses all glob-based paths that are actually present in the user's environment.
**Scope judgment:** Too narrow.
**Philosophy fit:** Honors YAGNI, immutability. Conflicts with Explicit Domain Types.

---

### Candidate 2 -- Literal paths + unconditional frontmatter stripper

**Summary:** Add the same 3 literal paths AND add `stripFrontmatter(content: string): string` as a pure helper. Apply it to every file before injection (safe no-op for plain markdown).

**Stripper logic:**
```typescript
function stripFrontmatter(content: string): string {
  // Only strip if file STARTS with --- (YAML frontmatter is always at file start)
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return content; // no closing delimiter -- don't strip, return as-is
  return content.slice(endIdx + 4).trimStart();
}
```

**Tensions resolved:** Frontmatter pollution (safe for all files).
**Tensions accepted:** No glob support. String[] stays primitive.
**Boundary solved at:** `loadWorkspaceContext()` function body + new pure helper.
**Why this boundary:** Extends the existing pure-function pipeline without changing the interface.
**Failure mode:** A legitimate file that starts with `---` on line 1 for a non-frontmatter reason would be incorrectly stripped. In practice: extremely unlikely for instructions/rules files that all start with a heading or paragraph.
**Repo pattern:** Adapts existing pattern (pure string transform in `loadWorkspaceContext()` pipeline).
**Gains:** Clean injection of literal paths. `stripFrontmatter()` is reusable if glob support is added later.
**Losses:** Still no glob support -- `.cursor/rules/*.mdc` remains unread.
**Scope judgment:** Best-fit for an incremental "Phase A" PR. If glob support is coming soon, this is good groundwork.
**Philosophy fit:** Honors Compose with small pure functions, Errors are data. Conflicts with Make illegal states unrepresentable (stripping not expressed in the type).

---

### Candidate 3 -- Discriminated union type + glob expansion + frontmatter stripping

**Summary:** Replace `string[]` with `readonly WorkspaceContextCandidate[]` (discriminated union with `kind: 'literal' | 'glob'`), expand `loadWorkspaceContext()` to handle both kinds, using `tinyglobby` (already a dependency) for glob expansion with alpha sorting.

**New type:**
```typescript
type LiteralCandidatePath = {
  readonly kind: 'literal';
  readonly relativePath: string;
  readonly stripFrontmatter?: boolean;
};
type GlobCandidatePath = {
  readonly kind: 'glob';
  readonly pattern: string;           // e.g. '.cursor/rules/*.mdc'
  readonly stripFrontmatter: boolean;
  readonly sort: 'alpha';             // always alpha for determinism
};
type WorkspaceContextCandidate = LiteralCandidatePath | GlobCandidatePath;
```

**Full array (in priority order):**
```typescript
const WORKSPACE_CONTEXT_CANDIDATE_PATHS: readonly WorkspaceContextCandidate[] = [
  { kind: 'literal', relativePath: '.claude/CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.local.md' },
  { kind: 'literal', relativePath: 'AGENTS.md' },
  { kind: 'literal', relativePath: '.github/AGENTS.md' },
  { kind: 'literal', relativePath: '.cursorrules' },
  { kind: 'glob', pattern: '.cursor/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'glob', pattern: '.windsurf/rules/*.md', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'glob', pattern: '.firebender/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.firebender/AGENTS.md' },
  { kind: 'literal', relativePath: '.github/copilot-instructions.md' },
  { kind: 'glob', pattern: '.continue/rules/*.md', stripFrontmatter: false, sort: 'alpha' },
];
```

**Glob expansion logic shape:**
```typescript
// For GlobCandidatePath entries:
import { glob } from 'tinyglobby';
const matches = await glob(entry.pattern, { cwd: workspacePath, absolute: false });
const sorted = matches.sort(); // alpha sort for determinism
// Then read each, optionally strip frontmatter, accumulate under budget
```

**Tensions resolved:** All 4 -- type is expressive, glob supported, frontmatter in contract, deterministic ordering.
**Tensions accepted:** Slightly larger PR scope.
**Boundary solved at:** `WORKSPACE_CONTEXT_CANDIDATE_PATHS` type + `loadWorkspaceContext()` function + new `stripFrontmatter()` helper.
**Why this boundary:** The discriminated union makes illegal states unrepresentable. A glob entry without `stripFrontmatter` is a TypeScript error. A literal entry without a path is a TypeScript error.
**Failure mode:** (1) Glob expansion could return many files. Mitigation: add `MAX_GLOB_FILES_PER_PATTERN = 20` cap with warning log. (2) `tinyglobby` import -- confirm API matches expected usage (it does: `glob(pattern, { cwd })` is the standard API).
**Repo pattern:** Departs from string[] but honors "Explicit domain types" and "Make illegal states unrepresentable." This is an architectural improvement, not a departure from values.
**Gains:** Complete coverage of all discovered conventions. Type contract prevents future maintainer bugs. Frontmatter stripping correct for all cases. Deterministic output.
**Losses:** Larger diff. Type change requires touching more lines in `loadWorkspaceContext()`.
**Scope judgment:** Best-fit complete solution. Fully contained in `workflow-runner.ts`.
**Philosophy fit:** Strongly honors Explicit domain types, Unrepresentable illegal states, Exhaustiveness, Compose with small pure functions. YAGNI is NOT a counter-argument here -- glob paths are confirmed present.

---

### Candidate 4 -- Parallel Set for strip flags (NOT recommended)

**Summary:** Keep `string[]` unchanged, add `const WORKSPACE_CONTEXT_STRIP_FRONTMATTER_PATHS = new Set<string>([...])` alongside it.

**Tensions resolved:** Backward compat (type unchanged).
**Failure mode:** Maintenance trap. Adding a new path to the array without updating the Set is a silent bug. This is precisely the illegal state a discriminated union prevents.
**Scope judgment:** Too narrow in design quality.
**Philosophy fit:** Conflicts with Architectural fixes over patches, Unrepresentable illegal states. **Eliminated.**

---

## Comparison and Recommendation

| Criterion | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| Covers glob paths (.cursor/rules/*.mdc) | No | No | Yes | No |
| Frontmatter stripping | No | Yes | Yes | Partial |
| Type expressivity | No | No | Yes | No |
| Backward compat | Yes | Yes | Yes (no external callers) | Yes |
| New dependency | No | No | No (tinyglobby already present) | No |
| Scope | Too narrow | Incremental | Complete | Patch |

**Recommendation: Candidate 3.**

Key deciding factors:
1. The 3 glob paths are confirmed present in the user's actual repos (empirical, not speculative).
2. `tinyglobby` is already a project dependency -- zero new dependency cost.
3. `WORKSPACE_CONTEXT_CANDIDATE_PATHS` has no external callers -- type change has no coordination cost.
4. The discriminated union is the correct architectural shape per the project's stated philosophy.

---

## Self-Critique

**Strongest counter-argument against C3:**
The `loadWorkspaceContext()` function grows significantly -- from a simple loop over strings to a branching loop with glob expansion, file count caps, and two code paths. A reviewer might push back on the increased complexity.
**Counter:** The complexity is necessary and localized. The alternative (C2) ships an incomplete solution that requires a follow-up PR anyway.

**What narrower option (C2) lost:**
C2 is a correct and safe incremental step. It loses because the most important paths in this environment are glob-based and present right now. Shipping C2 would leave `.cursor/rules/*.mdc` unread in an environment where it's actively in use.

**What broader option might be justified:**
Adding `alwaysApply: false` frontmatter filtering (skip rules that opt out). This would be justified if performance or context budget is a concern. Not in scope for this PR -- add as a follow-up.

**Assumption that would invalidate this design:**
If `tinyglobby`'s `glob()` API is incompatible with the expected call signature. Mitigation: verify against package docs before coding. The API is stable and widely used.

---

## Open Questions for the Main Agent

1. Should glob-expanded files that have the same relative path as a literal-path entry be deduplicated? (Example: `.cursorrules` exists as both a literal entry AND could theoretically match a glob pattern.) Current design: no deduplication -- the literal entry has higher priority and the glob pattern won't match `.cursorrules` anyway.

2. Should the `alwaysApply: false` frontmatter field be respected to skip conditional rules? Current design: strip all frontmatter and inject the body regardless. This is simpler and avoids parsing YAML. A follow-up PR could add smart filtering.

3. What should the per-glob file count cap be? Suggested: 20 files. This is conservative -- most `.cursor/rules/` directories have 1-5 files.

4. Should `CLAUDE.local.md` be placed before `AGENTS.md` (more specific, personal) or after (less team-critical)? Current design: after `CLAUDE.md` and before `AGENTS.md` -- reflects that local prefs are personal overrides but less authoritative than the shared AGENTS.md.
