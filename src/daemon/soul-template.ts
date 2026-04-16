/**
 * WorkRail Daemon Soul Template
 *
 * Exported here as a standalone zero-import module so that:
 * 1. The CLI init command can import the template without pulling in the full
 *    workflow-runner.ts dependency graph (which includes the LLM agent SDK).
 * 2. workflow-runner.ts imports from here, keeping a single source of truth.
 *
 * WHY no imports: this file must remain import-free. Any import here transitively
 * enters every CLI command that touches onboarding. Heavy deps slow CLI startup.
 */

// ---------------------------------------------------------------------------
// Default soul content
//
// Used as the fallback when daemon-soul.md is absent or unreadable.
// ---------------------------------------------------------------------------

export const DAEMON_SOUL_DEFAULT = `\
- Write code that follows the patterns already established in the codebase
- Never skip tests. Run existing tests before and after changes
- Prefer small, focused changes over large rewrites
- If a step asks you to write code, write actual code -- do not write pseudocode or placeholders
- Commit your work when you complete a logical unit`;

// ---------------------------------------------------------------------------
// Full soul file template
//
// Written to ~/.workrail/daemon-soul.md on first run (by daemon or by init).
// ---------------------------------------------------------------------------

export const DAEMON_SOUL_TEMPLATE = `\
# WorkRail Daemon Soul
#
# This file is injected into every WorkRail Auto daemon session system prompt under
# "## Agent Rules and Philosophy". Edit it to customize the agent's behavior for
# your environment: coding conventions, commit style, tool preferences, etc.
#
# Changes take effect on the next daemon session -- no restart required.
#
# The defaults below reflect general best practices. Override them freely.

${DAEMON_SOUL_DEFAULT}
`;
