/**
 * Tool Description Provider
 *
 * Injectable service that provides tool descriptions based on current mode.
 * Mode is determined at construction from feature flags (immutable).
 *
 * Implements Interface Segregation: focused interface for description access.
 *
 * @module mcp/tool-description-provider
 */

import { inject, injectable } from 'tsyringe';
import { DI } from '../di/tokens.js';
import type { IFeatureFlagProvider } from '../config/feature-flags.js';
import type { DescriptionMode, WorkflowToolName } from './types/tool-description-types.js';
import { DESCRIPTIONS } from './tool-descriptions.js';

/**
 * Interface for tool description access.
 *
 * Implement this interface to customize description behavior:
 * - A/B testing
 * - User customization
 * - Adaptive descriptions
 */
export interface IToolDescriptionProvider {
  /** Current description mode (immutable after construction) */
  readonly mode: DescriptionMode;

  /** Get description for a tool */
  getDescription(toolName: WorkflowToolName): string;
}

/**
 * Default implementation: reads mode from feature flags.
 */
@injectable()
export class ToolDescriptionProvider implements IToolDescriptionProvider {
  readonly mode: DescriptionMode;

  constructor(
    @inject(DI.Infra.FeatureFlags) featureFlags: IFeatureFlagProvider
  ) {
    this.mode = featureFlags.isEnabled('authoritativeDescriptions')
      ? 'authoritative'
      : 'standard';
  }

  getDescription(toolName: WorkflowToolName): string {
    return DESCRIPTIONS[this.mode][toolName];
  }
}

/**
 * Static implementation for testing.
 *
 * Allows tests to inject a specific mode without feature flags.
 */
export class StaticToolDescriptionProvider implements IToolDescriptionProvider {
  constructor(readonly mode: DescriptionMode) {}

  getDescription(toolName: WorkflowToolName): string {
    return DESCRIPTIONS[this.mode][toolName];
  }
}
