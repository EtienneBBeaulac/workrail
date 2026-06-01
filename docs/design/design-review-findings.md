# Design Review Findings: Hybrid EAT and Subagent Model Routing (#1152)

This document contains the detailed findings and reviews of the selected Hybrid EAT (Environment Attestation Token) architecture.

---

## 1. Tradeoff Review

- **Tension 1: Programmatic Sniffing vs. Zero-Overhead Latency**
  - *Verification:* Probing process ancestry and environmental variables takes <2ms, keeping standard linear workflows completely fast and free of active LLM turns, preserving startup invariants.
  - *No Longer Acceptable If:* Client platforms strip all custom environment variables from child processes, forcing the engine to run the slow-path lazy handshake on 100% of workflows, which negates all fast-path benefits.
  - *Hidden Assumptions:* Assumes environments consistently expose standard markers (like `CLAUDE_CODE` or process names) in terminal scopes.

- **Tension 2: Keychain Isolation vs. Backward Compatibility**
  - *Verification:* Centralizing key directory resolution via `LocalDataDirV2.keysDir()` with `WORKRAIL_KEYS_DIR` config variables and fallback checks for legacy `~/.workrail/data/keys/keyring.json` preserves 100% backward compatibility for all existing developer setups.
  - *No Longer Acceptable If:* Operators run in extremely locked-down container environments that forbid home-directory write access entirely, causing first-run key creation to fail.
  - *Hidden Assumptions:* Assumes the host environment allows write access to `~/.workrail/` to bootstrap the keys directory.

- **Tension 3: Context-Embedded EAT vs. Shared File Caching**
  - *Verification:* Persistent signed EAT context keys avoid flat file locking contention and concurrency races, fully preserving DAG purity and deterministic replay across machine boundaries.
  - *No Longer Acceptable If:* Extremely recursive spawn chains inflate context payloads to a size that violates the 256KB limit or degrades JCS serialization speed.
  - *Hidden Assumptions:* Assumes subagent depth is bounded by a hard limits safeguard (max depth 3) to prevent unbounded recursion.

---

## 2. Failure Mode Review

- **Failure Mode 1: Distributed Keyring Mismatch (Highest Risk)**
  - *Trace:* If the local MCP server (running in the user's IDE terminal) and the background system daemon do not share the exact same user-wide keyring directory (`~/.workrail/keys/`), token signatures in spawned subagents will fail validation.
  - *Mitigation:* Centralize keyring path resolution in `LocalDataDirV2.keysDir()` to default to a user-wide standard (`~/.workrail/keys/`), check for `WORKRAIL_KEYS_DIR` overrides in both MCP and daemon configurations, and support backward-compatible fallbacks for legacy `data/keys` locations.
  - *Severity:* **Red**

- **Failure Mode 2: Environment Variable Stripping in Virtual/Sandboxed Environments**
  - *Trace:* Proxies or container gateways may strip custom environment markers (`CLAUDE_CODE`, `CURSOR_APP`).
  - *Mitigation:* The sniff fast-path falls back cleanly to a conditional, lazy handshake step when variables are absent and advanced delegation features are requested. We also introduce a manual bypass override `WORKRAIL_FORCE_HARNESS` so operators can explicitly declare the environment.
  - *Severity:* **Orange**

- **Failure Mode 3: Context Size Budget Overflow in Deep Recursion Loops**
  - *Trace:* Deep spawning cascades could accumulate context weight, violating `MAX_CONTEXT_BYTES = 256KB`.
  - *Mitigation:* Keep the EAT payload extremely compact (less than 300 bytes) and mathematically short-circuit cascading loops at the token boundary using decrementing depth checks.
  - *Severity:* **Yellow**

---

## 3. Comparative Selection Review

- **Runner-up Strengths Worth Borrowing (Candidate B - Composable Sub-Graph EAT):**
  - Fuses Candidate B's absolute security boundaries with 100% DAG purity by packing the signed attestation token directly inside the durably persisted session context parameters instead of writing to an out-of-band flat file.
- **Simpler Alternative Analysis (Pure Offline Sniffing):**
  - Pure offline detection without conditional lazy handshake fallback is rejected because in sandboxed CI/CD containers, an offline-only engine cannot verify local tool paths or subagent whitelists, leading to runtime failures during subagent spawning. The conditional lazy handshake is the essential safety valve that guarantees execution resilience in sandboxed settings.

---

## 4. Philosophy & Principles Alignment

- **Durable Execution & Event Log Purity (Core Lock):** Perfect alignment. Storing the signed Environment Attestation Token (EAT) directly inside the durably persisted session `context` state preserves DAG purity and deterministic replay across machine boundaries.
- **Zero-Overhead Footprint for Lightweight Workflows:** Perfect alignment. Standard linear developer execution loops bypass all active capability handshake turns completely.
- **Rigorous Subagent Boundaries & Loop Prevention:** Perfect alignment. Mathematical depth bounds checked at the token boundary prevent cascading billing loops.

---

## 5. Findings & Recommended Revisions

- **Finding [F-01] (Critical - Red): Distributed Keyring Contention**
  - *Details:* The default keys directory resolved in `LocalDataDirV2.keysDir()` was hardcoded inside the data directory (`~/.workrail/data/keys/`). If separate processes (MCP and Daemon) do not share keys, token validation will reject otherwise authentic sessions.
  - *Revision:* Add `WORKRAIL_KEYS_DIR` allowed config key, refactor `LocalDataDirV2.keysDir()` to default to `~/.workrail/keys/`, and fallback to legacy `data/keys` if `keyring.json` already exists.
- **Finding [F-02] (High - Orange): Sniffing Fragility**
  - *Details:* Integrated shells and sandbox proxies often strip environment variable markers.
  - *Revision:* Enforce a robust conditional lazy handshake turn if sniffing indicators are ambiguous and advanced tools are explicitly requested, accompanied by a `WORKRAIL_FORCE_HARNESS` manual override variable.
- **Finding [F-03] (Medium - Yellow): Recursion Overrun**
  - *Details:* Unbounded subagent spawning chains could inflate context sizes, violating the 256KB context budget constraint.
  - *Revision:* Enforce a strict max depth of 3 inside the engine, decrementing the depth at every subagent spawn turn.

---

## 6. Residual Concerns

- **Upkeep overhead:** The programmatic sniffing logic must be maintained for new integrated IDE terminals or changing shell platforms.
- **Keyring file permissions:** Keyring files must be created with `600` permissions securely so local non-privileged processes cannot harvest token keys.
