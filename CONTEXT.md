# CONTEXT.md -- worktrain daemon --install (launchd plist)

## Task Summary

Implement `worktrain daemon --install` (and `--uninstall`, `--status`) subcommands that create a launchd plist at `~/Library/LaunchAgents/io.worktrain.daemon.plist`, load it via `launchctl`, and verify the daemon is running outside the MCP process tree so MCP reconnects cannot kill it. This is Tier 1 priority from the Apr 18 sprint -- it eliminates the critical bug where the daemon dies whenever Claude Code reconnects the MCP server.

## Conversation Preferences

- No emojis in code or docs
- No em-dashes in written content
- Errors as values (Result types), not exceptions
- Validate at boundaries, trust inside
- Document "why" not "what"

## Triage

- rigorMode: STANDARD
- auditDepth: normal
- maxQuestions: 3
- maxParallelism: 1
- taskComplexity: Medium
- riskLevel: Medium
- automationLevel: High
- docDepth: Light
- prStrategy: SinglePR

## Environment Capabilities

- delegationMode: solo (MCP tools not available in this agent context)

## Inputs & Sources

- backlog.md lines 4261-4276: root cause + priority description
- src/cli.ts: daemon command at line 233 (the `workrail daemon` command)
- src/cli-worktrain.ts: the worktrain binary entry point
- src/cli/commands/worktrain-init.ts: exemplar for command structure with injected deps

## User Rules & Philosophies (userRules)

- Errors are data -- CliResult discriminated union, no thrown exceptions
- All I/O injected via a deps interface (never direct fs/child_process imports in business logic)
- Zero direct imports in composition root business logic
- Each section idempotent (skip-if-configured)
- Never write secrets to disk
- Thin composition root: cli-worktrain.ts wires deps, business logic in src/cli/commands/worktrain-*.ts
- Exhaustive discriminated unions for all result types
- Tests use fakes not mocks (inject fake deps)
- Document "why", not "what" in comments

## Decision Log

### Decision 1: Where does the command live?

- Decision: `worktrain daemon --install` (subcommand on the `worktrain` binary, NOT `workrail daemon`)
- Why: The daemon is a WorkTrain concept. `workrail` is the MCP server binary. `worktrain` is the user-facing daemon management binary. `daemon --install` belongs there.
- Alternatives: Put it on `workrail daemon` -- rejected because that binary is the MCP server, not the user's CLI tool.
- Impacted files: src/cli-worktrain.ts, src/cli/commands/worktrain-daemon.ts (new)

### Decision 2: File layout

- Decision: `src/cli/commands/worktrain-daemon.ts` for business logic, wired in `src/cli-worktrain.ts`
- Why: Matches existing pattern (worktrain-init.ts, worktrain-tell.ts, etc.)
- Alternatives: single file with all logic -- rejected, violates thin-composition-root rule

### Decision 3: Subcommands design

- Decision: `worktrain daemon --install`, `--uninstall`, `--status` as options on a `daemon` subcommand
- Why: They are related actions on the same resource. Flags are cleaner than sub-subcommands for 3 mutually exclusive actions.
- Alternatives: `worktrain daemon install` / `worktrain daemon uninstall` -- viable but adds nesting depth

### Decision 4: Plist location

- Decision: `~/Library/LaunchAgents/io.worktrain.daemon.plist`
- Why: Standard macOS location for user-level launch agents. Survives reboots, runs as the current user, no sudo required.
- Impacted files: worktrain-daemon.ts

## Relevant Files (max 10)

1. `src/cli-worktrain.ts` -- composition root for worktrain binary, wire new daemon command here
2. `src/cli/commands/worktrain-init.ts` -- exemplar for deps injection pattern
3. `src/cli/commands/index.ts` -- re-export new command here
4. `src/cli/types/cli-result.ts` -- CliResult type used by all commands
5. `src/config/config-file.ts` -- loadWorkrailConfigFile() used by daemon command
6. `tests/unit/cli-version.test.ts` -- exemplar for unit test pattern

## Artifacts Index

- `implementation_plan.md` -- detailed slice plan (below)
- `spec.md` -- (to be created if needed)

## Progress

- Phase: Discovery complete, design decisions locked, ready to implement
- Next: Phase 2 implementation -- create worktrain-daemon.ts + wire in cli-worktrain.ts

---

## Discovery Design Document: worktrain daemon --install

### Q1: What does a launchd plist look like for a Node.js daemon?

A launchd plist is a standard macOS XML property list. For a user-level agent:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.worktrain.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/worktrain</string>
    <string>daemon</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AWS_PROFILE</key>
    <string>my-profile</string>
    <key>WORKRAIL_TRIGGERS_ENABLED</key>
    <string>true</string>
    <key>HOME</key>
    <string>/Users/etienneb</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>/Users/etienneb</string>

  <key>StandardOutPath</key>
  <string>/Users/etienneb/.workrail/logs/daemon.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/etienneb/.workrail/logs/daemon.stderr.log</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Location: `~/Library/LaunchAgents/io.worktrain.daemon.plist`

Key notes:
- `RunAtLoad: true` -- starts immediately when loaded with launchctl
- `KeepAlive: true` -- launchd restarts it if it crashes (optional, but very useful for daemon reliability)
- No sudo needed for `~/Library/LaunchAgents`
- The node path must be the absolute path from `which node` or `process.execPath`

### Q2: What env vars does the daemon need?

The daemon (`workrail daemon`) requires these env vars to function:

**Required (one of):**
- `AWS_PROFILE` -- use AWS Bedrock (checks `!!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID']`)
- `ANTHROPIC_API_KEY` -- use direct Anthropic API

**Required:**
- `WORKRAIL_TRIGGERS_ENABLED=true` -- the daemon exits without this

**Important (for subprocess execution):**
- `HOME` -- node scripts rely on this for homedir()
- `PATH` -- so `workrail` and other binaries are findable

**Optional (but configures daemon):**
- `WORKRAIL_DEFAULT_WORKSPACE` -- workspace path (can also come from config.json)
- `GITLAB_TOKEN` / `GITHUB_TOKEN` -- for SCM polling triggers

**Implementation strategy:**
- Capture from `process.env` at install time (what's currently set)
- Only capture the recognized list (not all env vars -- avoid leaking unrelated secrets)
- Inject a standard PATH that includes common node binary locations

### Q3: --install vs --uninstall vs --status subcommands

```
worktrain daemon --install     # Create plist + launchctl load + verify
worktrain daemon --uninstall   # launchctl unload + remove plist
worktrain daemon --status      # Check if launchd service is running (launchctl list)
```

**--install flow:**
1. Check if worktrain binary exists (`which worktrain` / `process.argv[0]`)
2. Resolve absolute path to `workrail daemon` or the node + worktrain path
3. Capture required env vars from current process.env
4. Generate plist XML content
5. Write plist to `~/Library/LaunchAgents/io.worktrain.daemon.plist`
6. Create log directory `~/.workrail/logs/`
7. Run `launchctl load ~/Library/LaunchAgents/io.worktrain.daemon.plist`
8. Wait ~1s, then verify: `launchctl list io.worktrain.daemon`
9. Print status

**--uninstall flow:**
1. Run `launchctl unload ~/Library/LaunchAgents/io.worktrain.daemon.plist`
2. Remove the plist file
3. Print status

**--status flow:**
1. Run `launchctl list io.worktrain.daemon`
2. Parse output and report whether it's running + PID
3. Check if plist file exists

### Q4: Where does it go?

On `worktrain daemon --install`. NOT `workrail daemon --install`.

Reasoning: `workrail` is the MCP server binary. `worktrain` is the user-facing management tool. This is consistent with `worktrain init` being the onboarding wizard.

### Q5: How does it log?

- stdout -> `~/.workrail/logs/daemon.stdout.log`
- stderr -> `~/.workrail/logs/daemon.stderr.log`

The `StandardOutPath` and `StandardErrorPath` plist keys tell launchd where to route the process's stdout/stderr. The daemon itself already writes to stdout/stderr with console.log/console.error.

The --install command creates `~/.workrail/logs/` before loading the plist.

### Q6: launchctl sequence

```bash
# Load (install + start)
launchctl load ~/Library/LaunchAgents/io.worktrain.daemon.plist

# Verify running
launchctl list io.worktrain.daemon
# Output: {"PID": 12345, "Status": 0, "Label": "io.worktrain.daemon"}
# If not running: {"Status": 0, "Label": "io.worktrain.daemon"} (no PID key)

# Unload (stop + remove from launchd)
launchctl unload ~/Library/LaunchAgents/io.worktrain.daemon.plist

# Force reload after plist change
launchctl unload ~/Library/LaunchAgents/io.worktrain.daemon.plist
launchctl load ~/Library/LaunchAgents/io.worktrain.daemon.plist
```

Note: On macOS 10.10+ there is also `launchctl bootstrap`/`launchctl kickstart` but `load`/`unload` works for user agents on all relevant macOS versions.

## Machine State Checkpoint

Phase: Discovery complete.
Next: Implementation phase (Phase 2 workflow).
