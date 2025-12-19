# WorkRail v2: Preferences + Modes (Closed Set, Durable, Rewind-Safe)
**Status:** Draft (intended to be locked)  
**Date:** 2025-12-19

This document locks the v2 design for:
- **Preferences**: a WorkRail-defined closed set of typed values that influence execution behavior without expanding the MCP boundary.
- **Modes**: Studio-facing presets that map to one or more preference values.

Goals:
- Keep the surface area small and type-safe (closed enums, no policy bags).
- Make preference-driven behavior **rewind-safe** and **export/import safe** by recording effective preferences durably on the run graph.
- Preserve user sovereignty: never hard-block a user-selected mode; warn and recommend instead.

Non-goals:
- Provide arbitrary workflow-defined preferences.
- Encode engine internals or workflow progress into preferences.

---

## Definitions

- **Preference**: a WorkRail-owned typed key/value that affects execution behavior in a bounded way.
- **Mode**: a named preset (Studio/UX-facing) that maps to a preference set.
- **Effective preferences**: the preference snapshot that is applied when selecting/advancing the next node.

---

## Closed preference set (v2 minimal)

### `autonomy` (required)

Closed enum:
- `guided`
- `full_auto_stop_on_user_deps`
- `full_auto_never_stop`

Normative behavior:
- `guided` and `full_auto_stop_on_user_deps` may return `blocked` (see gaps/user-only-deps model).
- `full_auto_never_stop` must never return `blocked`; it must continue and record durable gaps/warnings as data.

### `riskPolicy` (required)

Closed enum:
- `conservative`
- `balanced`
- `aggressive`

**Allowed effects (normative)**
`riskPolicy` may influence only:
- warning thresholds (how loudly we warn when a user-selected mode is more aggressive than the workflow recommends)
- default choice selection when multiple paths are available and correctness is preserved
- fallback selection when information is missing (e.g., choose safer default under `conservative`)

**Disallowed effects (normative)**
`riskPolicy` must not:
- change token semantics, idempotency, or fork behavior
- bypass required output contracts or capability requirements
- change what constitutes a user-only dependency
- suppress durable disclosure (assumptions/gaps)

Rationale:
- This keeps `riskPolicy` from turning into a policy bag while still capturing operator intent durably and type-safely.

---

## Invariants (not preferences)

These are v2 invariants and must not be configurable via preferences:
- **Disclosure is mandatory**: assumptions/skips/missing required data must be recorded durably (via outputs and/or gaps).
- **Append-only truth**: no mutable “current pointer” state; projections only.
- **Closed-set discipline**: no arbitrary key/value preference bags.

---

## Modes (Studio presets)

Modes are display-friendly presets that map to a preference snapshot.

Recommended v2 baseline presets:
- **Guided**
  - `autonomy=guided`
  - `riskPolicy=conservative`
- **Full-auto (stop on user deps)**
  - `autonomy=full_auto_stop_on_user_deps`
  - `riskPolicy=balanced`
- **Full-auto (never stop)**
  - `autonomy=full_auto_never_stop`
  - `riskPolicy=conservative`

Rationale:
- Never-stop must be safe by default: it continues through unknowns, so its defaults should skew conservative.

---

## Scope, precedence, and durability

Preferences exist at multiple scopes:
- **Global defaults** (developer-level)
- **Session baseline** (copied from global at first use; global changes do not retroactively affect existing sessions)
- **Node-attached changes** (apply going forward along descendant nodes)

Precedence:
1) node-attached effective preferences (closest ancestor)
2) session baseline
3) global defaults

Durable rule (normative):
- The **effective preference snapshot is recorded durably on nodes** (or via node-scoped events) so replays and export/import reproduce the same behavior.

Console UX rule (recommended):
- Studio/Console may stage “desired” preference changes, but **durable truth** is the node-attached `preferences_changed` record at the point it becomes effective.
- UI must show desired vs effective clearly and apply changes at the next node boundary.

---

## Workflow recommendations (warn, don’t block)

Workflows may declare a recommended maximum automation level and/or recommended risk posture.

Normative:
- WorkRail must never hard-block a user-selected mode.
- If the user selects a more aggressive autonomy than recommended, WorkRail must emit structured warnings and recommend the highest automation combination it considers safe.

Recommended:
- Record these warnings durably on the node where they are produced (for auditability and Console rendering).
