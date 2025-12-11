# CTC MCP Server: Technical Proposal

**Document Version:** 0.1  
**Date:** January 2025  
**Status:** Draft

---

## Executive Summary

### Problem Statement

Developers writing tests in mobile repositories (zillow-android, zillow-ios) need access to test
case specifications that live in a separate CTC (Centralized Test Cases) repository. Currently,
there is no standard way for AI assistants to discover and retrieve these specifications, resulting
in:

- Context switching between repos to find relevant test cases
- AI assistants lacking knowledge of what tests should be implemented
- No automated way to verify test coverage against specifications
- Manual, error-prone process for linking implementations to specs

### Solution Overview

The CTC MCP Server provides a lightweight local server that bridges the CTC repository and AI
development assistants. Running entirely on the developer's machine, it exposes test case
specifications through standardized MCP interfaces, enabling AI agents to:

- Discover test cases relevant to features being implemented
- Retrieve full specifications including given/when/then scenarios
- Help developers implement tests with correct annotations
- Support coverage analysis (post-MVP)

### Why MCP?

Several alternatives were evaluated:

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **Git submodule** | No new infrastructure | Painful UX, sync issues, "submodule hell" | Rejected |
| **Copy specs to mobile repos** | Simple | Violates single source of truth, drift | Rejected |
| **Extend WorkRail** | No new MCP | WorkRail is general-purpose, shouldn't be CTC-specific | Rejected |
| **Multi-root workspace** | Simple | Requires manual setup, two repos to manage | Fallback option |
| **Dedicated CTC MCP** | Clean architecture, agent-native, follows Constellation pattern | Another MCP to configure | **Selected** |

The MCP approach was selected because:

1. Follows the established Constellation MCP pattern
2. Provides agent-native access to specs
3. Maintains CTC repo as single source of truth
4. One-time setup cost per developer

---

## Architecture Overview

### System Context

```
CTC GitLab Repo              CTC MCP Server              Developer's IDE
┌──────────────────┐         ┌──────────────┐           ┌──────────────┐
│ specs/           │         │              │           │              │
│ ├── MM/          │  fetch  │   Registry   │   MCP     │   AI Agent   │
│ │   └── *.yaml   │ ──────► │   + Cache    │ ◄───────► │   (Cursor)   │
│ ├── GTM/         │         │              │           │              │
│ └── TBEX/        │         └──────────────┘           └──────────────┘
└──────────────────┘               │                           │
      (source of              ~/.cache/                  zillow-android/
        truth)               ctc-mcp/                    zillow-ios/
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Separate MCP** | WorkRail is general-purpose; CTC is domain-specific data access |
| **GitLab as data source** | CTC repo is the single source of truth; no duplication |
| **Local caching** | Fast responses, offline capability, reduced API calls |
| **Comment-based annotations** | Works on Android (Kotlin) and iOS (Swift) without build changes |
| **No version detection** | Unlike Constellation, YAML specs are stable; always use main branch |

### Data Model

```typescript
interface TestCase {
  id: string;                    // "TC-MSG-FUNC-001-TC01"
  collectionId: string;          // "TC-MSG-FUNC-001"
  description: string;           // "User sends text message successfully"
  priority: "P1" | "P2" | "P3";
  testType: "Bare Integration" | "UI" | "Snapshot";
  team: string;                  // "MM", "GTM", "TBEX"
  feature: string;               // "messaging", "touring", "rentals"
  given: string[];               // Preconditions
  when: string[];                // Actions
  then: string[];                // Expected outcomes
  requirementsUrl?: string;      // Link to BRD/PRD
  designUrl?: string;            // Link to Figma
  lastUpdated: string;           // ISO date
}
```

---

## MCP Tools

### MVP Scope (2 Tools)

The MVP includes only the essential tools for Pillar 2 (test implementation assistance):

#### 1. search_test_cases

**Purpose:** Find test cases by various criteria. The primary discovery tool.

**Input Schema:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | No | Free text search across descriptions, given/when/then |
| team | string | No | Filter by team (MM, GTM, TBEX) |
| feature | string | No | Filter by feature (messaging, touring, rentals) |
| priority | enum | No | Filter by priority (P1, P2, P3) |
| testType | enum | No | Filter by test type (Bare Integration, UI, Snapshot) |
| limit | number | No | Max results (default: 20) |

**Response:** Array of matching test cases with summary information.

**Example Usage:**

```
Developer: "What tests do I need for the login feature?"
Agent calls: search_test_cases({ feature: "login", priority: "P1" })
Agent: "I found 3 P1 test cases for login:
  - TC-AUTH-001-TC01: Valid credentials returns JWT
  - TC-AUTH-001-TC02: Invalid password returns 401
  - TC-AUTH-001-TC03: Missing email returns 400"
```

#### 2. get_test_case

**Purpose:** Get full details of a specific test case by ID. Includes fuzzy matching suggestions if
ID not found.

**Input Schema:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| testCaseId | string | Yes | Test case ID (e.g., TC-MSG-FUNC-001-TC01) |

**Response:** Full test case specification, or error with suggested similar IDs.

**Example Usage:**

```
Developer: "Show me the details for TC-AUTH-001-TC01"
Agent calls: get_test_case({ testCaseId: "TC-AUTH-001-TC01" })
Agent: "Here's the full spec:
  
  TC-AUTH-001-TC01: Valid credentials returns JWT
  Priority: P1
  Type: Bare Integration
  
  Given:
  - User has valid credentials in the system
  - Authentication service is available
  
  When:
  - User submits login with correct email and password
  
  Then:
  - User receives 200 OK response
  - Response contains valid JWT token
  - Token expiry is set to 24 hours"
```

**Not Found Handling:**

```
Agent calls: get_test_case({ testCaseId: "TC-AUTH-001-TC99" })
Response: {
  "found": false,
  "requestedId": "TC-AUTH-001-TC99",
  "suggestions": [
    "TC-AUTH-001-TC01",
    "TC-AUTH-001-TC02",
    "TC-AUTH-001-TC03"
  ]
}
```

### Post-MVP Tools

These tools will be added after MVP validation:

#### 3. get_implementation_template (Post-MVP)

**Purpose:** Generate platform-specific test skeleton with correct annotation format.

**Input Schema:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| testCaseId | string | Yes | Test case ID to implement |
| platform | enum | Yes | Target platform (android, ios) |

**Response:** Code template with `@TestCaseId` annotation and spec as comments.

**Why Post-MVP:** The agent can generate code without this tool. Having it ensures consistent
annotation format, but it's not essential for initial validation.

#### 4. find_unimplemented_test_cases (Post-MVP)

**Purpose:** Coverage gap analysis for Pillar 3.

**Input Schema:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| team | string | No | Filter by team |
| feature | string | No | Filter by feature |
| implementedIds | string[] | Yes | List of test case IDs already implemented |

**Response:** Coverage statistics and list of unimplemented test cases.

**Why Post-MVP:** This is Pillar 3 functionality. Pillar 2 (implementation assistance) should be
validated first.

### Tool Summary

| Tool | MVP? | Pillar | Purpose |
|------|------|--------|---------|
| search_test_cases | Yes | 2 | Discovery |
| get_test_case | Yes | 2 | Retrieval |
| get_implementation_template | No | 2 | Code generation |
| find_unimplemented_test_cases | No | 3 | Coverage analysis |

---

## Integration with Three Pillars

### Pillar 1: Test Case Generation

**Relationship:** CTC MCP is a consumer of Pillar 1 output.

- Pillar 1 generates YAML test case specs in the CTC repo
- CTC MCP reads these specs and exposes them to agents
- No changes needed to Pillar 1 for MCP to work

### Pillar 2: Test Implementation Assistance

**Relationship:** CTC MCP is the primary enabler of Pillar 2.

**Developer Flow:**

1. Developer starts implementing a feature in zillow-android
2. Asks agent: "What tests do I need for this feature?"
3. Agent calls `search_test_cases` via CTC MCP
4. Agent presents relevant test cases
5. Developer selects one to implement
6. Agent calls `get_test_case` for full spec
7. Agent helps write test code with `@TestCaseId` annotation
8. Developer commits test

**Annotation Format:**

```kotlin
// Android (Kotlin)
// @TestCaseId("TC-MSG-FUNC-001-TC01")
@Test
fun `user sends text message successfully`() {
    // Test implementation
}
```

```swift
// iOS (Swift)
// @TestCaseId("TC-MSG-FUNC-001-TC01")
func testUserSendsTextMessageSuccessfully() {
    // Test implementation
}
```

### Pillar 3: Verification

**Relationship:** CTC MCP provides data for coverage analysis (post-MVP).

**Coverage Flow:**

1. Script extracts all `@TestCaseId` annotations from codebase
2. Agent calls `find_unimplemented_test_cases` with extracted IDs
3. MCP compares against full spec inventory
4. Returns coverage percentage and missing test cases

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

- [ ] Project scaffolding (Node.js, TypeScript)
- [ ] GitLab API client with rate limiting
- [ ] Local cache manager (~/.cache/ctc-mcp/)
- [ ] Configuration management (~/.config/ctc-mcp/config.json)
- [ ] YAML parser for test case specs

### Phase 2: MVP Tools (Week 2-3)

- [ ] `search_test_cases` implementation
- [ ] `get_test_case` implementation with fuzzy matching
- [ ] MCP server setup (stdio transport)
- [ ] Error handling and logging

### Phase 3: Distribution (Week 3-4)

- [ ] npm package preparation
- [ ] Installation documentation
- [ ] IDE configuration examples (Cursor, Firebender)
- [ ] Troubleshooting guide

### Phase 4: Post-MVP (Future)

- [ ] `get_implementation_template` tool
- [ ] `find_unimplemented_test_cases` tool
- [ ] WorkRail workflow integration
- [ ] Coverage dashboard integration

---

## Developer Setup

### Installation

Add to IDE's MCP configuration (e.g., `mcp.json`):

```json
{
  "mcpServers": {
    "ctc-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "--registry",
        "https://artifactory.zgtools.net/artifactory/api/npm/znpm",
        "@zillow/ctc-mcp@latest"
      ]
    }
  }
}
```

### Configuration

Create `~/.config/ctc-mcp/config.json`:

```json
{
  "gitlab": {
    "token": "glpat-xxxxxxxxxxxxxxxxxxxx"
  },
  "logLevel": "info"
}
```

### Verification

Ask your AI assistant:
> "What test cases exist for the messaging feature?"

The agent should return test cases from the CTC repository.

---

## Caching Strategy

### Cache Structure

```
~/.cache/ctc-mcp/
├── test_cases.json      # All test cases
├── teams.json           # Team metadata
└── manifest.json        # Cache metadata
```

### Cache Behavior

| Scenario | Behavior |
|----------|----------|
| First run | Fetch from GitLab, populate cache |
| Subsequent runs | Use cache |
| Cache miss | Fetch from GitLab |
| Manual refresh | Delete cache directory, restart |

### Why No TTL/Expiry?

Unlike Constellation (where component APIs change frequently), CTC specs are:

- Updated less frequently
- Not version-sensitive (no API signatures)
- Easy to manually refresh when needed

Developers can clear cache when they know specs have changed:

```bash
rm -rf ~/.cache/ctc-mcp
```

---

## Comparison to Constellation MCP

| Aspect | Constellation MCP | CTC MCP |
|--------|-------------------|---------|
| **Domain** | UI components + design tokens | Test case specifications |
| **Tools count** | Many (search, tokens, migration, etc.) | Minimal (2 for MVP) |
| **Version detection** | Yes (API signatures change) | No (YAML is stable) |
| **Cache strategy** | Version-based | Simple (main branch) |
| **Platform support** | Android, iOS, Web | Android, iOS |
| **Code generation** | No | Yes (post-MVP) |
| **Coverage tracking** | No | Yes (post-MVP) |

---

## Success Criteria

### MVP Success

The MVP will be considered successful if:

1. **Functional:** Agents can search and retrieve test cases
2. **Performant:** Response time < 500ms for cached queries
3. **Adopted:** At least 5 developers actively using it
4. **Useful:** Developers report finding relevant test cases faster

### Metrics to Track

| Metric | Target | Measurement |
|--------|--------|-------------|
| Setup success rate | > 90% | First-run telemetry |
| Query response time | < 500ms | Local timing |
| Cache hit rate | > 80% | Cache statistics |
| Developer satisfaction | > 7/10 | Survey |

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| GitLab API rate limits | Low | Medium | Aggressive caching |
| MCP protocol changes | Low | High | Pin to stable version |
| Low adoption | Medium | High | Good docs, simple setup |
| Cache corruption | Low | Low | Easy cache clear |

---

## Open Questions

1. **Should MCP support both main branch and tagged releases?**
    - Current proposal: main branch only
    - Alternative: Support version override for specific tags

2. **How should coverage data be aggregated across Android and iOS?**
    - Pillar 3 concern, deferred to post-MVP

3. **Should there be a WorkRail workflow that uses CTC MCP?**
    - Deferred to post-MVP
    - WorkRail can call MCP tools; integration is natural

---

## Appendix: Rejected Alternatives

### A. Extend WorkRail with CTC Tools

**Proposal:** Add `ctc_lookup` tool directly to WorkRail MCP.

**Rejected because:**

- WorkRail is a general-purpose workflow engine
- Adding domain-specific tools violates single responsibility
- Authentication and data source management would complicate WorkRail
- CTC team should own CTC tooling

### B. Extend Constellation MCP

**Proposal:** Add test case queries to Constellation MCP.

**Rejected because:**

- Constellation is for design system (components, tokens)
- Test cases are unrelated domain
- Would create confusing scope for Constellation MCP
- Different teams own different concerns

### C. Git Submodule

**Proposal:** Add CTC repo as submodule in mobile repos.

**Rejected because:**

- Git submodules have poor developer experience
- Sync issues, stale refs, merge conflicts
- Requires manual `git submodule update`
- MCP provides better UX for same outcome

### D. Combined "Orchestration MCP"

**Proposal:** Single MCP combining WorkRail + CTC + other tools.

**Rejected because:**

- Creates coupling between unrelated systems
- Release coordination overhead
- Unclear ownership
- Scope creep risk ("everything goes in the MCP")

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | January 2025 | - | Initial draft |
