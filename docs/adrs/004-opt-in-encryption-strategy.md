# ADR 004: Opt-In Encryption Strategy

**Status:** Accepted
**Date:** 2024-07-27

## Context

Workflow context can contain sensitive information. Storing this data in plain text on a user's local machine poses a security risk, especially on multi-user systems or if the machine is compromised. We need a strategy to protect this data at rest.

The primary options considered were:
1.  **No Encryption:** Simple, but insecure. Not a viable option for a robust tool.
2.  **Encryption by Default:** Maximum security, but introduces performance overhead and potential key management complexity for all users, even those who do not handle sensitive data.
3.  **User-Provided Key:** Require the user to supply an encryption key via an environment variable or config file. This is flexible but places a significant security burden on the user (e.g., key storage, rotation).
4.  **Opt-In Encryption with Secure Key Management:** Make encryption an optional feature that, when enabled, uses the native, secure credential storage facilities of the host operating system.

## Decision

We will implement an **opt-in encryption strategy using the host OS's native keychain** for secure, non-interactive key management.

-   **Disabled by Default:** Encryption will be off by default to ensure maximum performance and simplicity for the common case.
-   **Enabled via Configuration:** Users can enable encryption with a simple configuration flag (e.g., `WORKRAIL_ENCRYPTION=enabled`).
-   **OS Keychain Integration:** When enabled, the server will generate a master encryption key and store it securely in the appropriate OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service API via a library like `keytar`). This avoids storing raw keys in config files.
-   **Transparent Operation:** Once enabled, the encryption and decryption of context blobs will be handled transparently by the storage layer.

## Consequences

### Positive:
-   **User Choice & Flexibility:** Users who do not need encryption are not impacted by its performance overhead. Those who do can enable it with a single, simple flag.
-   **High Security:** Leverages industry-standard, secure key storage mechanisms provided by the operating system, which is significantly more secure than storing keys in plain text files.
-   **Good User Experience:** Avoids burdening the user with manual key management. The process is non-interactive and transparent after the initial setup.
-   **Aligns with Professional Tooling:** This approach is standard practice for mature developer tools that handle potentially sensitive local data.

### Negative:
-   **Not Secure by Default:** Requires a conscious choice from the user to enable protection. Users who are unaware or forget to enable the feature will have their data stored in plain text. (This can be mitigated with clear documentation).
-   **Added Dependency:** Requires adding a dependency (e.g., `keytar`) to interact with the various OS keychains.
-   **Platform Complexity:** Requires implementation and testing across all three major platforms (macOS, Windows, Linux), each of which has a different native API for secret storage. 