# External Workflow Repositories

> **Status**:  Infrastructure Complete |  Integration Pending  
> **Last Updated**: 2025-01-20

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture](#architecture)
3. [Approach Comparison](#approach-comparison)
4. [Usage Examples](#usage-examples)
5. [Creating a Repository](#creating-a-repository)
6. [Implementation Guide](#implementation-guide)
7. [Security](#security)
8. [Troubleshooting](#troubleshooting)
9. [Best Practices](#best-practices)

---

## Executive Summary

### Current Status

 **Infrastructure: COMPLETE** - All code exists and is production-ready  
 **Integration: NOT ENABLED** - Not wired into default configuration  
 **What's Missing**: < 1 week of integration work

### Key Finding

**WorkRail already has complete, tested infrastructure for external workflow repositories.** The system supports:

1.  **Git repositories** (GitHub, GitLab, Bitbucket) - `GitWorkflowStorage`
2.  **HTTP registries** (npm-style) - `RemoteWorkflowStorage`
3.  **Plugin packages** (npm) - `PluginWorkflowStorage`
4.  **Security features** (URL validation, path traversal prevention, file size limits)
5.  **Graceful degradation** (continues if one source fails)
6.  **Priority-based merging** (later sources override earlier ones)

### Why This Matters

WorkRail supports loading workflows from external sources, enabling teams to:
- Share workflow collections
- Consume community workflows
- Maintain centralized workflow repositories
- Version control workflows with Git
- Collaborate using pull requests

### Recommended Approach: Git Repositories

| Factor | Git | HTTP Registry | Plugins |
|--------|-----|--------------|---------|
| Version Control |  Built-in |  Not included |  Via npm |
| Infrastructure |  GitHub/GitLab free |  Need server |  npm exists |
| Familiarity |  Developers know Git |  Custom API |  npm familiar |
| Offline Support |  Local cache |  Needs network |  node_modules |
| Pull Request Workflow |  Native |  Custom |  npm publish |
| Already Implemented |  Yes |  Yes |  Yes |
| Security |  Excellent |  Good |  Good |
| Setup Complexity |  Low |  High |  Medium |

**Git Workflow Benefits:**
```
Developer → Fork Repo → Add Workflow → PR → Review → Merge → Auto-Sync
                                                              ↓
                                                    All users get update
```

- **No infrastructure**: Use GitHub/GitLab (free)
- **Familiar workflow**: Developers already know Git/PR process
- **Built-in review**: PRs provide natural approval process
- **Version control**: Full history, rollback capability
- **Free hosting**: GitHub/GitLab provide unlimited public repos

---

## Architecture

### Current Implementation

```
┌─────────────────────────────────────────────────────────────────┐
│                   IWorkflowStorage Interface                     │
└─────────────────────────────────────────────────────────────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
         ┌───────▼──────┐ ┌─────▼─────┐ ┌──────▼──────┐
         │ FileWorkflow │ │GitWorkflow│ │RemoteWorkflow│
         │   Storage    │ │  Storage  │ │   Storage    │
         └──────────────┘ └───────────┘ └──────────────┘
                 │
         ┌───────▼──────────────────────────────────┐
         │  MultiDirectoryWorkflowStorage (current) │
         │  - Bundled workflows                     │
         │  - User directory (~/.workrail)          │
         │  - Project directory (./workflows)       │
         │  - Custom paths (env vars)               │
         └──────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│             Decorator Pattern (Currently Used)                   │
│  CachingWorkflowStorage                                          │
│    → SchemaValidatingWorkflowStorage                            │
│      → MultiDirectoryWorkflowStorage (base)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Design Principles

The system follows these principles (from the MCP stateless model):

1. **Stateless** - Storage manages state, not the MCP server
2. **Composable** - Multiple storage sources can be combined
3. **Graceful Degradation** - Failures in one source don't break others
4. **Security-First** - URL validation, path traversal prevention, file size limits
5. **Decorator Pattern** - Validation and caching are orthogonal concerns

### Proposed: EnhancedMultiSourceWorkflowStorage

```typescript
export interface MultiSourceWorkflowConfig {
  // Existing local directories
  includeBundled?: boolean;
  includeUser?: boolean;
  includeProject?: boolean;
  customPaths?: string[];
  
  // NEW: Git repositories
  gitRepositories?: GitWorkflowConfig[];
  
  // NEW: Remote registries
  remoteRegistries?: RemoteWorkflowRegistryConfig[];
  
  // NEW: Plugin directories
  pluginPaths?: string[];
}

export class EnhancedMultiSourceWorkflowStorage implements IWorkflowStorage {
  constructor(config: MultiSourceWorkflowConfig = {}) {
    // Priority order (lowest to highest):
    // 1. Bundled workflows
    // 2. User directory
    // 3. Git repositories
    // 4. Remote registries
    // 5. Project directory (highest priority)
  }
}
```

---

## Approach Comparison

### Option 1: Git-Based Repositories (RECOMMENDED)

**Use Case**: Teams want to share workflows via GitHub/GitLab

**Pros**:
-  Version control built-in
-  Pull request workflow for contributions
-  Already implemented (`GitWorkflowStorage`)
-  Works offline (local cache)
-  Familiar to developers
-  Free hosting (GitHub/GitLab)
-  Automatic sync with configurable intervals

**Cons**:
-  Requires Git installed
-  Clone/pull operations add latency
-  Not suitable for high-frequency updates

**Best For**:
- Team workflow repositories
- Community workflow collections
- Organization-wide standard workflows
- Workflows requiring version control and review

### Option 2: HTTP-Based Registries

**Use Case**: npm-style workflow registry with REST API

**Pros**:
-  Fast (no clone/pull)
-  Already implemented (`RemoteWorkflowStorage`)
-  Supports authentication (API keys)
-  Good for high-frequency updates
-  Retry logic with exponential backoff

**Cons**:
-  Requires running a registry server
-  No built-in version control
-  Requires network for every access (unless cached)

**Best For**:
- Large organizations with internal registries
- High-frequency workflow updates
- Centralized workflow management systems
- Integration with existing artifact management

### Option 3: Plugin-Based (npm packages)

**Use Case**: Distribute workflows as npm packages

**Pros**:
-  Already implemented (`PluginWorkflowStorage`)
- Uses npm ecosystem
-  Semantic versioning
-  Dependency management

**Cons**:
-  Requires npm/node_modules
-  More complex workflow publishing
-  Version lock-in

**Best For**:
- Public workflow distributions
- Integration with existing npm packages
- When you need strict dependency management

### Option 4: Hybrid Approach

Combine multiple sources with priority ordering:

```
Priority (highest to lowest):
1. Project directory (team overrides)
2. Git repository (shared team workflows)
3. User directory (personal workflows)
4. Community Git repo (public workflows)
5. Bundled workflows (defaults)
```

**Best For**: Most organizations

---

## Usage Examples

### 1. Simple Team Repository

**Scenario**: Small team wants to share workflows via GitHub.

#### Configuration

```typescript
// src/container.ts
import { createEnhancedMultiSourceWorkflowStorage } from './infrastructure/storage/enhanced-multi-source-workflow-storage';

export function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const baseStorage = createEnhancedMultiSourceWorkflowStorage({
    includeBundled: true,
    includeUser: true,
    includeProject: true,
    gitRepositories: [
      {
        repositoryUrl: 'https://github.com/myteam/workflows.git',
        branch: 'main',
        syncInterval: 60, // Sync every hour
        localPath: path.join(os.homedir(), '.workrail', 'team')
      }
    ]
  });
  
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  return new CachingWorkflowStorage(validatingStorage, 300_000);
}
```

#### Environment Variables

```bash
# .env
WORKFLOW_GIT_REPO_URL=https://github.com/myteam/workflows.git
WORKFLOW_GIT_REPO_BRANCH=main
WORKFLOW_GIT_SYNC_INTERVAL=60
```

#### Usage

```bash
# Initialize WorkRail (will clone the repository)
workrail init

# List workflows (includes team workflows)
workrail list

# Run a team workflow
workrail run team-code-review
```

### 2. Multi-Repository Setup

**Scenario**: Organization wants to combine public community workflows with private team workflows.

```typescript
export function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const baseStorage = createEnhancedMultiSourceWorkflowStorage({
    includeBundled: true,
    includeUser: true,
    includeProject: true,
    gitRepositories: [
      // Public community workflows (lower priority)
      {
        repositoryUrl: 'https://github.com/workrail/community-workflows.git',
        branch: 'main',
        syncInterval: 1440, // Daily sync
        localPath: path.join(os.homedir(), '.workrail', 'community')
      },
      // Private team workflows (higher priority)
      {
        repositoryUrl: 'https://github.com/mycompany/team-workflows.git',
        branch: 'production',
        syncInterval: 60, // Hourly sync
        authToken: process.env['GITHUB_TOKEN'],
        localPath: path.join(os.homedir(), '.workrail', 'team')
      }
    ]
  });
  
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  return new CachingWorkflowStorage(validatingStorage, 300_000);
}
```

**Priority Order**: If the same workflow ID exists in multiple sources, the higher priority source wins:
1. Bundled workflows (built-in defaults)
2. User workflows (`~/.workrail/workflows`)
3. Community workflows (GitHub public repo)
4. Team workflows (GitHub private repo)
5. Project workflows (`./workflows`) - highest priority

### 3. Private Repository with Authentication

**Scenario**: Company uses private GitHub repository with authentication.

#### Generate GitHub Personal Access Token

1. Go to GitHub → Settings → Developer settings → Personal access tokens
2. Generate new token (classic)
3. Select scope: `repo` (for private repositories)
4. Copy the token

#### Configuration

```typescript
export function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const baseStorage = createEnhancedMultiSourceWorkflowStorage({
    gitRepositories: [
      {
        repositoryUrl: 'https://github.com/mycompany/private-workflows.git',
        branch: 'production',
        authToken: process.env['GITHUB_TOKEN'], // Read from environment
        syncInterval: 60,
        maxFileSize: 2 * 1024 * 1024, // 2MB limit
        maxFiles: 100,
        localPath: path.join(os.homedir(), '.workrail', 'private')
      }
    ]
  });
  
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  return new CachingWorkflowStorage(validatingStorage, 300_000);
}
```

#### Environment Setup

```bash
# Set your GitHub token
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Or use a .env file
echo "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx" >> .env
```

**Security Notes**:
- **Never commit tokens to version control**
- Use read-only tokens when possible
- Rotate tokens regularly
- Consider using GitHub Apps for organization-wide access

### 4. Hybrid Local + Remote

**Scenario**: Development uses local workflows, production uses Git repository.

```typescript
export function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const isDevelopment = process.env['NODE_ENV'] === 'development';
  
  const config = {
    includeBundled: true,
    includeUser: true,
    includeProject: true,
    gitRepositories: isDevelopment ? undefined : [
      {
        repositoryUrl: 'https://github.com/mycompany/workflows.git',
        branch: 'production',
        syncInterval: 60,
        authToken: process.env['GITHUB_TOKEN']
      }
    ]
  };
  
  const baseStorage = createEnhancedMultiSourceWorkflowStorage(config);
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  return new CachingWorkflowStorage(validatingStorage, 300_000);
}
```

```bash
# Development: Use local workflows
NODE_ENV=development workrail run my-workflow

# Production: Use Git workflows
NODE_ENV=production workrail run my-workflow
```

### 5. HTTP Registry

**Scenario**: Large organization with internal workflow registry.

```typescript
export function createDefaultWorkflowStorage(): CachingWorkflowStorage {
  const baseStorage = createEnhancedMultiSourceWorkflowStorage({
    includeBundled: true,
    includeUser: true,
    includeProject: true,
    remoteRegistries: [
      {
        baseUrl: 'https://workflows.mycompany.internal',
        apiKey: process.env['WORKFLOW_REGISTRY_API_KEY'],
        timeout: 10000,
        retryAttempts: 3
      }
    ]
  });
  
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  return new CachingWorkflowStorage(validatingStorage, 300_000);
}
```

**Registry API Requirements**:
```
GET  /workflows              → List all workflows
GET  /workflows/:id          → Get specific workflow
GET  /workflows/summaries    → List workflow summaries
POST /workflows              → Publish workflow (requires auth)
```

### 6. Environment Variable Configuration

**Git Repository (Simple)**:
```bash
export WORKFLOW_GIT_REPO_URL=https://github.com/myteam/workflows.git
export WORKFLOW_GIT_REPO_BRANCH=main
export WORKFLOW_GIT_AUTH_TOKEN=${GITHUB_TOKEN}
export WORKFLOW_GIT_SYNC_INTERVAL=60
```

**Git Repository (Advanced - JSON)**:
```bash
export WORKFLOW_GIT_REPOS='[
  {
    "repositoryUrl": "https://github.com/workrail/community-workflows.git",
    "branch": "main",
    "syncInterval": 1440
  },
  {
    "repositoryUrl": "https://github.com/myteam/workflows.git",
    "branch": "production",
    "syncInterval": 60,
    "authToken": "'${GITHUB_TOKEN}'"
  }
]'
```

**Disable Sources**:
```bash
export WORKFLOW_INCLUDE_BUNDLED=false
export WORKFLOW_INCLUDE_USER=false
export WORKFLOW_INCLUDE_PROJECT=false
```

---

## Creating a Repository

### Repository Structure

External repositories should follow this structure:

```
workflow-repository/
├── README.md                    # Repository documentation
├── workflows/                   # Workflows directory (required)
│   ├── bug-investigation.json
│   ├── code-review.json
│   └── deployment.json
├── .gitignore
└── .github/
    └── workflows/
        └── validate.yml         # CI validation
```

### Required Conventions

1. **Directory Name**: Must be named `workflows/` (singular or plural)
2. **File Extension**: All workflow files must be `.json`
3. **File Naming**: Filename should match workflow ID (e.g., `bug-fix.json` → `"id": "bug-fix"`)
4. **Schema Compliance**: All workflows must validate against the WorkRail schema
5. **No Subdirectories**: Flat structure (no nested directories)

### Step-by-Step Guide

#### 1. Create Repository

```bash
# Create new repository
mkdir my-workflows
cd my-workflows
git init

# Create workflows directory
mkdir workflows

# Create README
cat > README.md << 'EOF'
# My Workflows

Shared workflow collection for our team.

## Usage

```bash
export WORKFLOW_GIT_REPO_URL=https://github.com/username/my-workflows.git
workrail init
workrail list
```

## Contributing

1. Add workflow to `workflows/` directory
2. Validate: `workrail validate workflows/your-workflow.json`
3. Submit pull request
EOF
```

#### 2. Add Workflow

```bash
cat > workflows/code-review.json << 'EOF'
{
  "id": "code-review",
  "name": "Code Review Workflow",
  "description": "Systematic code review process",
  "version": "1.0.0",
  "steps": [
    {
      "id": "review-changes",
      "title": "Review Code Changes",
      "prompt": "Review the code changes for correctness, style, and best practices.",
      "guidance": [
        "Check for logic errors",
        "Verify coding standards",
        "Look for security issues"
      ]
    }
  ]
}
EOF
```

#### 3. Add CI Validation

```bash
mkdir -p .github/workflows
cat > .github/workflows/validate.yml << 'EOF'
name: Validate Workflows

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - name: Install WorkRail
        run: npm install -g workrail
      - name: Validate Workflows
        run: |
          for file in workflows/*.json; do
            echo "Validating $file..."
            workrail validate "$file"
          done
EOF
```

#### 4. Add .gitignore

```bash
cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
.DS_Store
.vscode/
.idea/
*.swp
EOF
```

#### 5. Commit and Push

```bash
git add .
git commit -m "Initial workflow repository setup"

# Create GitHub repository (via gh CLI)
gh repo create my-workflows --public --source=. --remote=origin --push

# Or manually
git remote add origin https://github.com/username/my-workflows.git
git branch -M main
git push -u origin main
```

#### 6. Test

```bash
cd /tmp
export WORKFLOW_GIT_REPO_URL=https://github.com/username/my-workflows.git
workrail init
workrail list
```

---

## Implementation Guide

### Implementation Options

#### Option A: Minimal Integration (1 day)

Just enable `GitWorkflowStorage` for users who want it:

```typescript
// Add to docs/README.md
export WORKFLOW_GIT_REPO_URL=https://github.com/myteam/workflows.git
workrail init
```

**Pros**: Zero code changes, users can opt-in immediately  
**Cons**: Manual setup, not discoverable

#### Option B: Environment Variable Support (3 days)

Add env var support to default configuration:

```typescript
// container.ts - Update createDefaultWorkflowStorage()
const gitRepoUrl = process.env['WORKFLOW_GIT_REPO_URL'];
if (gitRepoUrl) {
  config.gitRepositories = [{
    repositoryUrl: gitRepoUrl,
    branch: process.env['WORKFLOW_GIT_REPO_BRANCH'] || 'main',
    authToken: process.env['GITHUB_TOKEN'],
    syncInterval: 60
  }];
}
```

**Pros**: Simple, opt-in, no breaking changes  
**Cons**: Limited discoverability

#### Option C: Full Integration (1 week)  RECOMMENDED

Create `EnhancedMultiSourceWorkflowStorage` and make it the default:

1. **Day 1-2**: Implement `EnhancedMultiSourceWorkflowStorage`
2. **Day 3**: Add CLI commands (`workrail repo add/remove/list/sync`)
3. **Day 4**: Add tests and validation
4. **Day 5**: Update documentation

**Pros**: Full-featured, discoverable, future-proof  
**Cons**: Most work (but still only 1 week)

### Recommended CLI Commands

```bash
# Add a Git repository
workrail repo add github https://github.com/myorg/workflows.git

# List configured repositories
workrail repo list

# Sync all repositories
workrail repo sync

# Remove a repository
workrail repo remove github

# Show workflows from specific source
workrail list --source=github
```

### Organization Size Recommendations

#### Small Teams (< 10 people)
**Use**: Git repository approach
- Single team repository
- Store in company GitHub/GitLab
- No additional infrastructure needed

#### Medium Organizations (10-100 people)
**Use**: Multi-repository approach
- Public community workflows (read-only)
- Team-specific repositories
- Optional: Internal registry for high-frequency updates

#### Large Enterprises (100+ people)
**Use**: Hybrid approach
- Internal HTTP registry for frequent updates
- Git repositories for team workflows
- Centralized workflow governance
- Consider plugin approach for distribution

---

## Security

### GitWorkflowStorage Security Features

1. **URL Validation**: Only whitelisted hosting providers
   - github.com, gitlab.com, bitbucket.org, dev.azure.com, sourceforge.net
   - Must use HTTPS or git:// protocol

2. **Command Injection Prevention**: All shell arguments are escaped

3. **Path Traversal Prevention**: All file operations validated against base directory

4. **Resource Limits**:
   - Max file size: 1MB (configurable)
   - Max files: 100 (configurable)
   - Clone timeout: 60 seconds
   - Pull timeout: 30 seconds

5. **Authentication**: Supports personal access tokens (not username/password)

### Best Practices

1. **Use Read-Only Tokens**: If using authentication, use tokens with read-only access
2. **Pin Branches**: Use specific branches or tags instead of 'main' in production
3. **Regular Audits**: Review workflow repositories regularly for unauthorized changes
4. **Access Control**: Use private repositories for sensitive workflows
5. **Sync Intervals**: Balance freshness vs. API rate limits (60+ minutes recommended)
6. **Token Security**:
   - Never commit tokens to version control
   - Rotate tokens regularly
   - Use environment variables for token storage
   - Consider GitHub Apps for organization-wide access

---

## Troubleshooting

### Repository Not Found

```bash
# Check Git URL
git ls-remote https://github.com/username/workflows.git

# Check authentication
git clone https://github.com/username/workflows.git /tmp/test
```

### Authentication Issues

```bash
# Verify token has access
curl -H "Authorization: token ${GITHUB_TOKEN}" \
  https://api.github.com/repos/username/workflows

# Test with explicit token
WORKFLOW_GIT_AUTH_TOKEN=ghp_xxx workrail init
```

### Sync Issues

```bash
# Force sync by removing cache
rm -rf ~/.workrail/team-workflows
workrail init

# Check sync logs
WORKFLOW_DEBUG=true workrail list
```

### Validation Failures

```bash
# Validate individual workflow
workrail validate workflows/my-workflow.json

# Common issues to check:
# - Missing required fields (id, name, description, version, steps)
# - Invalid step structure
# - Malformed JSON
```

---

## Best Practices

### Repository Organization

1. **Use descriptive repository names** (e.g., `myteam-workflows`)
2. **Document workflows in README** with usage examples
3. **Add CI validation** to catch errors before merge
4. **Use semantic versioning** for workflow versions
5. **Tag releases** for stable versions

### Security

1. **Never commit authentication tokens**
2. **Use read-only tokens** when possible
3. **Regularly audit** workflow repositories
4. **Use private repositories** for sensitive workflows
5. **Review pull requests** carefully before merging

### Performance

1. **Set appropriate sync intervals** (60+ minutes recommended)
2. **Use caching** (enabled by default)
3. **Limit repository size** (< 100 workflows)
4. **Keep workflows under 1MB** each
5. **Monitor API rate limits**

### Collaboration

1. **Use pull requests** for all changes
2. **Require approvals** for workflow changes
3. **Document workflow purposes** and usage
4. **Tag releases** for stable versions
5. **Maintain a staging repository** for testing

### Testing

1. **Validate workflows in CI/CD** before merge
2. **Test workflows** before merging to production branch
3. **Use feature branches** for development
4. **Maintain a staging repository** for pre-production testing
5. **Run end-to-end tests** for critical workflows

---

## Open Questions

1. **Repository Discovery**: Should we provide a workflow marketplace/directory?
2. **Workflow Signing**: Do we need GPG signing for security?
3. **SSH Keys**: Support SSH authentication in addition to tokens?
4. **Monorepo Support**: Load workflows from subdirectories?
5. **Webhooks**: Real-time sync instead of polling?
6. **Default Repositories**: Should we include a community repo by default?

---

## Conclusion

**The infrastructure is complete and production-ready. The only remaining work is integration.**

### Recommended Action

Implement **Option C (Full Integration)** over 1 week.

This provides:
1. Complete feature set
2. Good developer experience
3. Future extensibility
4. Minimal risk

### Why Git-Based Approach?

1.  No additional infrastructure needed (use GitHub/GitLab)
2.  Developers already understand Git workflows
3.  Perfect for collaboration (PRs, reviews, versioning)
4.  Already fully implemented and tested
5.  Free hosting with unlimited public repos

### Implementation Effort

- **Minimum viable**: 1 day (Option A)
- **Environment variables**: 3 days (Option B)
- **Full feature set**: 1 week (Option C) 

### Total Lines of Code Required

- `EnhancedMultiSourceWorkflowStorage`: ~100 LOC
- Configuration support: ~50 LOC
- CLI commands: ~200 LOC
- Tests: ~300 LOC
- **Total**: ~650 LOC

---

**Resources**:
- Implementation: `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`
- Tests: `tests/unit/enhanced-multi-source-workflow-storage.test.ts`
- Existing implementations: `git-workflow-storage.ts`, `remote-workflow-storage.ts`, `plugin-workflow-storage.ts`
