import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Result, ok, err } from 'neverthrow';
import {
  LoopControlArtifactV1Schema,
  CoordinatorSignalArtifactV1Schema,
  ReviewVerdictArtifactV1Schema,
  DiscoveryHandoffArtifactV1Schema,
  GateVerdictArtifactV1Schema,
  ShapingHandoffArtifactV1Schema,
  CodingHandoffArtifactV1Schema,
  DifferentiationHandoffArtifactV1Schema,
  AssessmentArtifactV1Schema,
} from '../../../v2/durable-core/schemas/artifacts/index.js';

export interface ShadowLifecycleResult {
  readonly shadowPath: string;
  readonly virtualOnly: boolean;
}

/**
 * Initializes the shadow directory .workrail/artifacts/<sessionId> inside the workspace.
 * Resolves the true local Git repository (handling worktrees and directories) and writes
 * the shadow root directory '.workrail/' to info/exclude to ensure it is untracked.
 *
 * @param workspacePath The absolute path of the workspace.
 * @param sessionId The active session ID.
 * @returns A monadic Result wrapping the ShadowLifecycleResult.
 */
export function initShadowDirectory(
  workspacePath: string,
  sessionId: string
): Result<ShadowLifecycleResult, Error> {
  if (!workspacePath) {
    return err(new Error('Workspace path is empty or undefined.'));
  }

  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = fs.realpathSync(workspacePath);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const shadowParent = path.join(resolvedWorkspace, '.workrail');
  const shadowPath = path.join(shadowParent, 'artifacts', sessionId);

  try {
    fs.mkdirSync(shadowPath, { recursive: true });
  } catch (e) {
    // Fall back to Virtual-Only mode if filesystem writes are unavailable.
    console.warn(`[workrail:shadow] Failed to create shadow directory, falling back to Virtual-Only mode: ${e}`);
    return ok({ shadowPath, virtualOnly: true });
  }

  // Attempt to write '.workrail/' to info/exclude. Ignore failures gracefully to support read-only/unusual git environments.
  try {
    const gitDirResult = resolveGitDir(resolvedWorkspace);
    if (gitDirResult.isOk()) {
      const gitDir = gitDirResult.value;
      const excludePath = path.join(gitDir, 'info', 'exclude');

      // Create the info directory recursively if it is missing (e.g. fresh worktree)
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });

      const ignorePattern = '.workrail/';
      let currentContent = '';
      if (fs.existsSync(excludePath)) {
        currentContent = fs.readFileSync(excludePath, 'utf8');
      }

      if (!currentContent.split('\n').some(line => line.trim() === ignorePattern)) {
        const separator = currentContent.endsWith('\n') || currentContent === '' ? '' : '\n';
        fs.appendFileSync(excludePath, `${separator}${ignorePattern}\n`, 'utf8');
      }
    }
  } catch (e) {
    console.warn(`[workrail:shadow] Failed to update git exclude, ignoring gracefully: ${e}`);
  }

  return ok({ shadowPath, virtualOnly: false });
}

/**
 * Resolves the true git directory (.git) for the workspace.
 * Strictly bounds the search to the workspace directory to prevent traversals above the workspace root.
 * Supports standard directories and Git worktree .git text files referencing a gitdir.
 */
export function resolveGitDir(workspacePath: string): Result<string, Error> {
  const dotGitPath = path.join(workspacePath, '.git');
  if (!fs.existsSync(dotGitPath)) {
    return err(new Error(`No .git directory or file found inside workspace root: ${workspacePath}`));
  }

  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) {
      return ok(dotGitPath);
    } else if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        let gitDir = match[1].trim();
        if (!path.isAbsolute(gitDir)) {
          gitDir = path.resolve(workspacePath, gitDir);
        }
        const resolvedGitDir = fs.realpathSync(gitDir);
        const headPath = path.join(resolvedGitDir, 'HEAD');
        if (!fs.existsSync(headPath)) {
          return err(new Error(`Security violation: resolved git directory does not contain a valid Git HEAD file: ${resolvedGitDir}`));
        }
        return ok(resolvedGitDir);
      }
      return err(new Error(`Invalid .git worktree file format: ${dotGitPath}`));
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  return err(new Error(`Unknown .git file type at ${dotGitPath}`));
}

/**
 * Helper to validate path containment and symlink segment verification for shadow rehydration.
 */
export function validateShadowPathContainment(targetPath: string, shadowPath: string): boolean {
  try {
    const resolvedShadow = fs.realpathSync(shadowPath);
    const resolvedTarget = path.resolve(resolvedShadow, targetPath);

    // Verify containment using relative check
    const relative = path.relative(resolvedShadow, resolvedTarget);
    const isContained = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!isContained) {
      return false;
    }

    // Verify no segment is a symbolic link
    let current = resolvedTarget;
    const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    const resolvedShadowNormalized = isCaseInsensitive
      ? resolvedShadow.toLowerCase()
      : resolvedShadow;

    while (
      (isCaseInsensitive ? current.toLowerCase() : current) !== resolvedShadowNormalized &&
      current !== path.dirname(current)
    ) {
      try {
        if (fs.existsSync(current)) {
          const stat = fs.lstatSync(current);
          if (stat.isSymbolicLink()) {
            return false;
          }
        }
      } catch {
        // Segment doesn't exist yet, which is fine
      }
      current = path.dirname(current);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Rehydrates/extracts artifacts from the session event log and writes them to the shadow directory.
 * If a local file has modified content relative to the event log, it skips overwriting it
 * and returns a warning, unless forceReset is true.
 *
 * @returns A monadic Result wrapping the list of skipped file warnings.
 */
export function rehydrateShadowFiles(
  events: readonly any[],
  shadowPath: string,
  forceReset: boolean
): Result<string[], Error> {
  try {
    // 1. Scan events to find the latest state of each artifact
    const latestArtifacts = new Map<string, { content: string; sha256: string; contentType: string }>();
    for (const e of events) {
      if (e.kind === 'node_output_appended' && e.data?.outputChannel === 'artifact') {
        const payload = e.data.payload;
        if (payload && payload.payloadKind === 'artifact_ref' && payload.content !== undefined) {
          const filename = e.data.outputId;
          latestArtifacts.set(filename, {
            content: String(payload.content),
            sha256: payload.sha256,
            contentType: payload.contentType ?? 'text/plain',
          });
        }
      }
    }

    const warnings: string[] = [];

    // 2. Hydrate each artifact
    const resolvedShadowPath = path.resolve(shadowPath);
    for (const [filename, art] of latestArtifacts.entries()) {
      if (!validateShadowPathContainment(filename, resolvedShadowPath)) {
        return err(new Error(`WorkspaceLockViolation: Path traversal detected or symbolic link segment detected in shadow rehydration for file: ${filename}`));
      }
      const filePath = path.resolve(resolvedShadowPath, filename);

      const isText = typeof art.content === 'string' && 
                     (art.contentType.startsWith('text/') || 
                      art.contentType === 'application/json' || 
                      art.contentType === 'application/javascript');

      if (fs.existsSync(filePath)) {
        const localContent = fs.readFileSync(filePath, 'utf8');
        
        // Normalize CRLF to LF for text file comparison
        const normLocal = isText ? localContent.replace(/\r\n/g, '\n') : localContent;
        const normEvent = isText ? art.content.replace(/\r\n/g, '\n') : art.content;
        
        const localSha = 'sha256:' + crypto.createHash('sha256').update(normLocal, 'utf8').digest('hex');
        const eventSha = 'sha256:' + crypto.createHash('sha256').update(normEvent, 'utf8').digest('hex');

        if (localSha !== eventSha) {
          if (forceReset) {
            fs.writeFileSync(filePath, art.content, 'utf8');
          } else {
            warnings.push(
              `Warning: Local artifact file '${filename}' has modified local edits that differ from the session event log. ` +
              `Rehydration skipped for this file to protect your changes. ` +
              `To overwrite, pass 'forceReset: true' or 'resetShadow: true' in your context parameters.`
            );
          }
        } else {
          // Contents match, but let's re-write to ensure line endings and mtime are correct.
          fs.writeFileSync(filePath, art.content, 'utf8');
        }
      } else {
        // File does not exist locally, write it.
        fs.writeFileSync(filePath, art.content, 'utf8');
      }
    }

    return ok(warnings);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Validates a single extracted artifact against its registered Zod schema based on its kind.
 */
export function validateArtifactSchema(artifact: any): Result<unknown, Error> {
  if (!artifact || typeof artifact !== 'object' || typeof artifact.kind !== 'string') {
    return err(new Error('Artifact must be an object with a string "kind" property.'));
  }

  let schema: any;
  switch (artifact.kind) {
    case 'wr.loop_control':
      schema = LoopControlArtifactV1Schema;
      break;
    case 'wr.coordinator_signal':
      schema = CoordinatorSignalArtifactV1Schema;
      break;
    case 'wr.review_verdict':
      schema = ReviewVerdictArtifactV1Schema;
      break;
    case 'wr.discovery_handoff':
      schema = DiscoveryHandoffArtifactV1Schema;
      break;
    case 'wr.gate_verdict':
      schema = GateVerdictArtifactV1Schema;
      break;
    case 'wr.shaping_handoff':
      schema = ShapingHandoffArtifactV1Schema;
      break;
    case 'wr.coding_handoff':
      schema = CodingHandoffArtifactV1Schema;
      break;
    case 'wr.differentiation_handoff':
      schema = DifferentiationHandoffArtifactV1Schema;
      break;
    case 'wr.assessment':
      schema = AssessmentArtifactV1Schema;
      break;
    default:
      return err(new Error(`Unknown artifact kind: ${artifact.kind}`));
  }

  const parseResult = schema.safeParse(artifact);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return err(new Error(`Artifact schema validation failed for kind ${artifact.kind}: ${issues}`));
  }

  return ok(parseResult.data);
}

/**
 * Scans the shadow directory for new or modified artifact files.
 * Compares them against the latest committed state in the event log.
 * Any new or modified JSON file with a `kind` field starting with "wr." is parsed, validated, and returned.
 *
 * @param shadowPath The absolute path of the shadow directory.
 * @param events The session events.
 * @returns A monadic Result wrapping the list of extracted artifacts.
 */
export function extractShadowArtifacts(
  shadowPath: string,
  events: readonly any[]
): Result<unknown[], Error> {
  try {
    if (!fs.existsSync(shadowPath)) {
      return ok([]);
    }

    // 1. Scan events to find the latest state of each artifact
    const latestArtifacts = new Map<string, { sha256: string; contentType: string }>();
    for (const e of events) {
      if (e.kind === 'node_output_appended' && e.data?.outputChannel === 'artifact') {
        const payload = e.data.payload;
        if (payload && payload.payloadKind === 'artifact_ref' && payload.content !== undefined) {
          const filename = e.data.outputId;
          latestArtifacts.set(filename, {
            sha256: payload.sha256,
            contentType: payload.contentType ?? 'text/plain',
          });
        }
      }
    }

    const files = fs.readdirSync(shadowPath);
    const extracted: unknown[] = [];

    for (const file of files) {
      const filePath = path.join(shadowPath, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      
      // Normalize CRLF to LF for comparison
      const normContent = content.replace(/\r\n/g, '\n');
      const localSha = 'sha256:' + crypto.createHash('sha256').update(normContent, 'utf8').digest('hex');

      const committed = latestArtifacts.get(file);
      if (committed && committed.sha256 === localSha) {
        // File matches last committed state, skip
        continue;
      }

      // Try parsing as JSON
      const isJsonExt = file.endsWith('.json') || file.startsWith('out_artifact_');
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (item && typeof item === 'object' && typeof item.kind === 'string' && item.kind.startsWith('wr.')) {
              const valRes = validateArtifactSchema(item);
              if (valRes.isErr()) {
                return err(new Error(`Failed to validate artifact in file '${file}': ${valRes.error.message}`));
              }
              extracted.push(valRes.value);
            }
          }
        }
      } catch (jsonErr) {
        if (isJsonExt) {
          return err(new Error(`Failed to parse JSON artifact file '${file}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`));
        }
      }
    }

    return ok(extracted);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

