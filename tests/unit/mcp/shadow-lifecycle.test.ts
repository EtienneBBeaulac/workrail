import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initShadowDirectory,
  resolveGitDir,
  rehydrateShadowFiles,
  extractShadowArtifacts,
  validateArtifactSchema,
} from '../../../src/mcp/handlers/v2-execution/shadow-lifecycle.js';

describe('shadow-lifecycle tests', () => {
  let tempWorkspace: string;

  beforeEach(() => {
    tempWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-shadow-test-')));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup failures
    }
  });

  describe('resolveGitDir', () => {
    it('returns error if no .git exists', () => {
      const res = resolveGitDir(tempWorkspace);
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().message).toContain('No .git directory or file found');
    });

    it('resolves normal .git directory', () => {
      const gitDir = path.join(tempWorkspace, '.git');
      fs.mkdirSync(gitDir);
      
      const res = resolveGitDir(tempWorkspace);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toBe(gitDir);
    });

    it('resolves .git worktree file with relative path', () => {
      const realGitDir = path.join(tempWorkspace, 'real-git-dir');
      fs.mkdirSync(realGitDir);

      const dotGit = path.join(tempWorkspace, '.git');
      fs.writeFileSync(dotGit, `gitdir: ./real-git-dir\n`, 'utf8');

      const res = resolveGitDir(tempWorkspace);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toBe(realGitDir);
    });

    it('resolves .git worktree file with absolute path', () => {
      const realGitDir = path.join(tempWorkspace, 'real-git-dir-abs');
      fs.mkdirSync(realGitDir);

      const dotGit = path.join(tempWorkspace, '.git');
      fs.writeFileSync(dotGit, `gitdir: ${realGitDir}\n`, 'utf8');

      const res = resolveGitDir(tempWorkspace);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toBe(realGitDir);
    });
  });

  describe('initShadowDirectory', () => {
    it('creates shadow directory and appends ignore pattern to .git/info/exclude', () => {
      const gitDir = path.join(tempWorkspace, '.git');
      fs.mkdirSync(gitDir);

      const res = initShadowDirectory(tempWorkspace, 'session_123');
      expect(res.isOk()).toBe(true);

      const { shadowPath, virtualOnly } = res._unsafeUnwrap();
      expect(virtualOnly).toBe(false);
      expect(shadowPath).toContain(path.join('.workrail', 'artifacts', 'session_123'));
      expect(fs.existsSync(shadowPath)).toBe(true);

      const excludePath = path.join(gitDir, 'info', 'exclude');
      expect(fs.existsSync(excludePath)).toBe(true);
      const excludeContent = fs.readFileSync(excludePath, 'utf8');
      expect(excludeContent.trim()).toBe('.workrail/');
    });

    it('does not duplicate ignore pattern if already present', () => {
      const gitDir = path.join(tempWorkspace, '.git');
      fs.mkdirSync(gitDir);
      const excludeDir = path.join(gitDir, 'info');
      fs.mkdirSync(excludeDir);
      const excludePath = path.join(excludeDir, 'exclude');
      fs.writeFileSync(excludePath, '# Existing ignores\n.workrail/\n', 'utf8');

      const res = initShadowDirectory(tempWorkspace, 'session_123');
      expect(res.isOk()).toBe(true);

      const excludeContent = fs.readFileSync(excludePath, 'utf8');
      const occurrences = excludeContent.split('\n').filter(line => line.trim() === '.workrail/').length;
      expect(occurrences).toBe(1);
    });

    it('falls back to Virtual-Only mode if shadow directory cannot be created', () => {
      // Create a file at the shadow path location to block directory creation
      const dotWorkrail = path.join(tempWorkspace, '.workrail');
      fs.writeFileSync(dotWorkrail, 'blocker', 'utf8');

      const res = initShadowDirectory(tempWorkspace, 'session_123');
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap().virtualOnly).toBe(true);
    });
  });

  describe('rehydrateShadowFiles', () => {
    const events = [
      {
        kind: 'node_output_appended',
        data: {
          outputId: 'artifact1.md',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:dummy1',
            contentType: 'text/markdown',
            content: '# First Artifact\nHello world\n',
          },
        },
      },
      {
        kind: 'node_output_appended',
        data: {
          outputId: 'artifact1.md', // Superseded content
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:dummy2',
            contentType: 'text/markdown',
            content: '# First Artifact\nHello world updated\n',
          },
        },
      },
      {
        kind: 'node_output_appended',
        data: {
          outputId: 'artifact2.json',
          outputChannel: 'artifact',
          payload: {
            payloadKind: 'artifact_ref',
            sha256: 'sha256:dummy3',
            contentType: 'application/json',
            content: '{"key": "value"}',
          },
        },
      },
    ];

    it('hydrates shadow directory with latest non-superseded artifacts', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      const res = rehydrateShadowFiles(events, shadowPath, false);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);

      const file1Path = path.join(shadowPath, 'artifact1.md');
      const file2Path = path.join(shadowPath, 'artifact2.json');

      expect(fs.existsSync(file1Path)).toBe(true);
      expect(fs.existsSync(file2Path)).toBe(true);

      expect(fs.readFileSync(file1Path, 'utf8')).toBe('# First Artifact\nHello world updated\n');
      expect(fs.readFileSync(file2Path, 'utf8')).toBe('{"key": "value"}');
    });

    it('skips overwriting locally modified files and issues warnings', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      // Write a local modified file
      const file1Path = path.join(shadowPath, 'artifact1.md');
      fs.writeFileSync(file1Path, '# First Artifact\nModified locally\n', 'utf8');

      const res = rehydrateShadowFiles(events, shadowPath, false);
      expect(res.isOk()).toBe(true);
      
      const warnings = res._unsafeUnwrap();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Local artifact file 'artifact1.md' has modified local edits");

      // Verify file1 was NOT overwritten
      expect(fs.readFileSync(file1Path, 'utf8')).toBe('# First Artifact\nModified locally\n');

      // Verify file2 was still hydrated
      const file2Path = path.join(shadowPath, 'artifact2.json');
      expect(fs.existsSync(file2Path)).toBe(true);
    });

    it('normalizes CRLF to LF for comparison to avoid false conflict triggers', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      // Write local file with CRLF line endings
      const file1Path = path.join(shadowPath, 'artifact1.md');
      fs.writeFileSync(file1Path, '# First Artifact\r\nHello world updated\r\n', 'utf8');

      const res = rehydrateShadowFiles(events, shadowPath, false);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]); // No warnings! Line endings normalized.
    });
  });

  describe('validateArtifactSchema', () => {
    it('validates valid loop control artifact', () => {
      const art = {
        kind: 'wr.loop_control',
        decision: 'continue',
        metadata: { reason: 'Test' }
      };
      const res = validateArtifactSchema(art);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual(art);
    });

    it('rejects invalid loop control artifact missing decision', () => {
      const art = {
        kind: 'wr.loop_control',
        metadata: { reason: 'Test' }
      };
      const res = validateArtifactSchema(art);
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().message).toContain('Artifact schema validation failed');
    });

    it('rejects unknown artifact kind', () => {
      const art = {
        kind: 'wr.unknown_kind',
      };
      const res = validateArtifactSchema(art);
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().message).toContain('Unknown artifact kind');
    });
  });

  describe('extractShadowArtifacts', () => {
    it('extracts new loop control artifact', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      const artFile = path.join(shadowPath, 'loop.json');
      const art = {
        kind: 'wr.loop_control',
        decision: 'continue',
        metadata: { reason: 'Test extraction' }
      };
      fs.writeFileSync(artFile, JSON.stringify(art), 'utf8');

      const res = extractShadowArtifacts(shadowPath, []);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([art]);
    });

    it('ignores unmodified rehydrated files', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      const file1Path = path.join(shadowPath, 'out_artifact_1');
      const art = {
        kind: 'wr.loop_control',
        decision: 'continue',
        metadata: { reason: 'Same' }
      };
      const content = JSON.stringify(art);
      fs.writeFileSync(file1Path, content, 'utf8');

      const crypto = require('crypto');
      const sha256 = 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');

      const events = [
        {
          kind: 'node_output_appended',
          data: {
            outputId: 'out_artifact_1',
            outputChannel: 'artifact',
            payload: {
              payloadKind: 'artifact_ref',
              sha256,
              contentType: 'application/json',
              content: art,
            }
          }
        }
      ];

      const res = extractShadowArtifacts(shadowPath, events);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
    });

    it('extracts modified rehydrated files', () => {
      const shadowPath = path.join(tempWorkspace, '.workrail', 'artifacts', 'session_123');
      fs.mkdirSync(shadowPath, { recursive: true });

      const file1Path = path.join(shadowPath, 'out_artifact_1');
      const artOld = {
        kind: 'wr.loop_control',
        decision: 'continue',
        metadata: { reason: 'Old' }
      };
      const artNew = {
        kind: 'wr.loop_control',
        decision: 'stop',
        metadata: { reason: 'New' }
      };
      
      fs.writeFileSync(file1Path, JSON.stringify(artNew), 'utf8');

      const crypto = require('crypto');
      const sha256Old = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(artOld), 'utf8').digest('hex');

      const events = [
        {
          kind: 'node_output_appended',
          data: {
            outputId: 'out_artifact_1',
            outputChannel: 'artifact',
            payload: {
              payloadKind: 'artifact_ref',
              sha256: sha256Old,
              contentType: 'application/json',
              content: artOld,
            }
          }
        }
      ];

      const res = extractShadowArtifacts(shadowPath, events);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([artNew]);
    });
  });
});
