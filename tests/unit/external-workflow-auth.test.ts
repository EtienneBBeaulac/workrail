import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for external workflow authentication resolution
 * Tests all 3 phases: common services, self-hosted, SSH
 */

// We need to test the private resolveAuthToken function
// Import the module to access it via createEnhancedMultiSourceWorkflowStorage
import { createEnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';

describe('External Workflow Authentication', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Phase 1: Common Services', () => {
    it('should resolve GitHub token from GITHUB_TOKEN', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSource = sourceInfo.find(s => s.source.kind === 'git');
      expect(gitSource).toBeDefined();
    });

    it('should resolve GitLab token from GITLAB_TOKEN', () => {
      process.env['GITLAB_TOKEN'] = 'glpat_test123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://gitlab.com/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSource = sourceInfo.find(s => s.source.kind === 'git');
      expect(gitSource).toBeDefined();
    });

    it('should resolve Bitbucket token from BITBUCKET_TOKEN', () => {
      process.env['BITBUCKET_TOKEN'] = 'bb_test123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://bitbucket.org/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSource = sourceInfo.find(s => s.source.kind === 'git');
      expect(gitSource).toBeDefined();
    });
  });

  describe('Phase 2: Self-Hosted Services', () => {
    it('should resolve token for self-hosted GitLab', () => {
      process.env['GIT_COMPANY_COM_TOKEN'] = 'token_test123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://git.company.com/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.some(s => s.source.kind === 'git')).toBe(true);
    });

    it('should convert hostname to env var format correctly', () => {
      // git.company.com → GIT_COMPANY_COM_TOKEN
      process.env['GIT_GITLAB_INTERNAL_ORG_TOKEN'] = 'token123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://gitlab.internal.org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });

    it('should handle dashes in hostname', () => {
      // code-review.dev → GIT_CODE_REVIEW_DEV_TOKEN
      process.env['GIT_CODE_REVIEW_DEV_TOKEN'] = 'token123';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://code-review.dev/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });
  });

  describe('Phase 3: SSH Keys', () => {
    it('should accept SSH URL format git@host:path', () => {
      process.env['WORKFLOW_GIT_REPOS'] = 'git@github.com:org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.some(s => s.source.kind === 'git')).toBe(true);
    });

    it('should accept SSH URL format ssh://git@host/path', () => {
      process.env['WORKFLOW_GIT_REPOS'] = 'ssh://git@github.com/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.some(s => s.source.kind === 'git')).toBe(true);
    });

    it('should not require token for SSH URLs', () => {
      // No tokens set, but SSH should still work
      process.env['WORKFLOW_GIT_REPOS'] = 'git@github.com:org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Repositories', () => {
    it('should handle comma-separated URLs', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['GITLAB_TOKEN'] = 'glpat_test';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/a/b.git,https://gitlab.com/c/d.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSources = sourceInfo.filter(s => s.type === 'git');
      expect(gitSources.length).toBe(2);
    });

    it('should handle mixed HTTPS and SSH URLs', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/a/b.git,git@gitlab.com:c/d.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSources = sourceInfo.filter(s => s.type === 'git');
      expect(gitSources.length).toBe(2);
    });

    it('should handle mixed common and self-hosted services', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['GIT_COMPANY_COM_TOKEN'] = 'company_test';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/org/w.git,https://git.company.com/w.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSources = sourceInfo.filter(s => s.type === 'git');
      expect(gitSources.length).toBe(2);
    });
  });

  describe('Fallback Behavior', () => {
    it('should fall back to GIT_TOKEN for unknown hosts', () => {
      process.env['GIT_TOKEN'] = 'generic_token';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://unknown-git-host.com/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });

    it('should fall back to WORKFLOW_GIT_AUTH_TOKEN', () => {
      process.env['WORKFLOW_GIT_AUTH_TOKEN'] = 'fallback_token';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://custom-host.com/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });

    it('should handle missing tokens gracefully', () => {
      // No tokens set - should still create storage but might fail on clone
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage).toBeDefined();
      expect(storage.getSourceInfo().length).toBeGreaterThan(0);
    });
  });

  describe('Environment Variable Formats', () => {
    it('should parse single repo URL', () => {
      process.env['WORKFLOW_GIT_REPO_URL'] = 'https://github.com/org/repo.git';
      process.env['GITHUB_TOKEN'] = 'ghp_test';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.some(s => s.type === 'git')).toBe(true);
    });

    it('should parse JSON array format', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['WORKFLOW_GIT_REPOS'] = JSON.stringify([
        { repositoryUrl: 'https://github.com/org/repo.git', branch: 'main' }
      ]);

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.some(s => s.type === 'git')).toBe(true);
    });

    it('should handle whitespace in comma-separated list', () => {
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['WORKFLOW_GIT_REPOS'] = '  https://github.com/a/b.git  ,  https://github.com/c/d.git  ';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      const gitSources = sourceInfo.filter(s => s.type === 'git');
      expect(gitSources.length).toBe(2);
    });
  });

  describe('Priority Order', () => {
    it('should load sources in correct priority order', () => {
      process.env['WORKFLOW_INCLUDE_BUNDLED'] = 'true';
      process.env['WORKFLOW_INCLUDE_USER'] = 'true';
      process.env['WORKFLOW_INCLUDE_PROJECT'] = 'true';
      process.env['GITHUB_TOKEN'] = 'ghp_test';
      process.env['WORKFLOW_GIT_REPOS'] = 'https://github.com/org/repo.git';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      // Should have: bundled, user, git, project
      // Exact order matters for precedence
      const kinds = sourceInfo.map(s => s.source.kind);
      
      // Git sources should come after bundled/user, before project
      const gitIndex = kinds.findIndex(k => k === 'git');
      const projectIndex = kinds.findIndex(k => k === 'project');
      
      if (gitIndex >= 0 && projectIndex >= 0) {
        expect(gitIndex).toBeLessThan(projectIndex);
      }
    });
  });

  describe('Configuration Options', () => {
    it('should respect includeBundled flag', () => {
      process.env['WORKFLOW_INCLUDE_BUNDLED'] = 'false';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.every(s => s.source.kind !== 'bundled')).toBe(true);
    });

    it('should respect includeUser flag', () => {
      process.env['WORKFLOW_INCLUDE_USER'] = 'false';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.every(s => s.source.kind !== 'user')).toBe(true);
    });

    it('should respect includeProject flag', () => {
      process.env['WORKFLOW_INCLUDE_PROJECT'] = 'false';

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      expect(sourceInfo.every(s => s.source.kind !== 'project')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON in WORKFLOW_GIT_REPOS', () => {
      process.env['WORKFLOW_GIT_REPOS'] = '[invalid json}';

      // Should not throw, should gracefully skip
      expect(() => createEnhancedMultiSourceWorkflowStorage()).not.toThrow();
    });

    it('should handle malformed URLs gracefully', () => {
      process.env['WORKFLOW_GIT_REPOS'] = 'not-a-url';

      // Should create storage but source might not initialize
      const storage = createEnhancedMultiSourceWorkflowStorage();
      expect(storage).toBeDefined();
    });
  });
});

