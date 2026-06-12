/**
 * Workflow Reference Resolution
 * Delegating to the v2 use-case layer.
 */

export {
  resolveWorkflowReferences,
  defaultFileExists,
} from '../../v2/usecases/reference-resolver.js';
export type {
  ReferenceResolutionWarning,
  ReferenceResolutionResult,
  FileExistsPort,
} from '../../v2/usecases/reference-resolver.js';
