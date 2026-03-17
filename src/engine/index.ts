/**
 * WorkRail Library Engine — public entry point.
 *
 * Usage:
 *   import { createWorkRailEngine } from '@exaudeus/workrail/engine';
 *   const result = await createWorkRailEngine({ dataDir: '/tmp/workrail' });
 *   if (!result.ok) { console.error(result.error); return; }
 *   const engine = result.value;
 */

export { createWorkRailEngine } from './engine-factory.js';
export type {
  WorkRailEngine,
  EngineConfig,
  EngineResult,
  EngineError,
  InfraErrorCode,
  StepResponse,
  StepResponseOk,
  StepResponseBlocked,
  CheckpointResponse,
  WorkflowListResponse,
  WorkflowListItem,
  PendingStep,
  StepPreferences,
  Autonomy,
  RiskPolicy,
  NextIntent,
  Blocker,
  BlockerCode,
  StateToken,
  AckToken,
  CheckpointToken,
} from './types.js';

export { engineOk, engineErr, asStateToken, asAckToken, asCheckpointToken, unwrapToken } from './types.js';
