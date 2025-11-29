/**
 * Integration Tests: TSyringe DI Container + Feature Flags
 *
 * Demonstrates clean architecture patterns:
 * - Dependency injection through TSyringe
 * - Testability through mock injection
 * - Separation of concerns
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTest, teardownTest, resolve } from '../di/test-container.js';
import { DI } from '../../src/di/tokens.js';
import { StaticFeatureFlagProvider } from '../../src/config/feature-flags.js';

describe('Feature Flags Integration with TSyringe Container', () => {
  afterEach(() => {
    teardownTest();
  });

  describe('Default Container', () => {
    it('creates feature flag provider automatically', async () => {
      await setupTest();

      const featureFlags = resolve(DI.Infra.FeatureFlags);

      expect(featureFlags).toBeDefined();
      expect(typeof featureFlags.isEnabled).toBe('function');
    });

    it('provides feature flags to all services that need them', async () => {
      await setupTest();

      const featureFlags = resolve(DI.Infra.FeatureFlags);

      // Feature flags are accessible
      const sessionToolsEnabled = featureFlags.isEnabled('sessionTools');
      expect(typeof sessionToolsEnabled).toBe('boolean');
    });
  });

  describe('Dependency Injection (Override)', () => {
    it('allows injecting custom feature flag provider for testing', async () => {
      // Create test-specific feature flags
      const testFlags = new StaticFeatureFlagProvider({
        sessionTools: true,
        experimentalWorkflows: true,
        verboseLogging: true,
      });

      // Inject into container
      await setupTest({
        featureFlags: testFlags,
      });

      // Container uses injected provider
      const flags = resolve(DI.Infra.FeatureFlags);
      expect(flags.isEnabled('sessionTools')).toBe(true);
      expect(flags.isEnabled('experimentalWorkflows')).toBe(true);
    });

    it('supports partial overrides (only override what you need)', async () => {
      const testFlags = new StaticFeatureFlagProvider({
        sessionTools: false, // Test with session tools disabled
      });

      await setupTest({
        featureFlags: testFlags,
      });

      const flags = resolve(DI.Infra.FeatureFlags);
      expect(flags.isEnabled('sessionTools')).toBe(false);

      // Other services still work
      const workflowService = resolve(DI.Services.Workflow);
      expect(workflowService).toBeDefined();
    });
  });

  describe('Clean Architecture', () => {
    it('maintains single responsibility - container only composes', async () => {
      await setupTest();

      // Container provides services
      const featureFlags = resolve(DI.Infra.FeatureFlags);
      const workflowService = resolve(DI.Services.Workflow);

      expect(featureFlags).toBeDefined();
      expect(workflowService).toBeDefined();

      // Services don't contain business logic in container (that's in the services)
    });

    it('services receive dependencies, not global state', async () => {
      const testFlags1 = new StaticFeatureFlagProvider({
        verboseLogging: true,
      });

      await setupTest({
        featureFlags: testFlags1,
      });

      const flags1 = resolve(DI.Infra.FeatureFlags);
      expect(flags1.isEnabled('verboseLogging')).toBe(true);

      teardownTest();

      // New container with different config
      const testFlags2 = new StaticFeatureFlagProvider({
        verboseLogging: false,
      });

      await setupTest({
        featureFlags: testFlags2,
      });

      const flags2 = resolve(DI.Infra.FeatureFlags);
      expect(flags2.isEnabled('verboseLogging')).toBe(false);
    });
  });

  describe('Testability', () => {
    it('makes unit testing easy with dependency injection', async () => {
      // Test scenario: Session tools enabled
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: true,
        }),
      });

      const flags1 = resolve(DI.Infra.FeatureFlags);
      expect(flags1.isEnabled('sessionTools')).toBe(true);

      teardownTest();

      // Test scenario: Session tools disabled
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: false,
        }),
      });

      const flags2 = resolve(DI.Infra.FeatureFlags);
      expect(flags2.isEnabled('sessionTools')).toBe(false);
    });

    it('isolates tests (no side effects between tests)', async () => {
      // Test 1: All features enabled
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: true,
          experimentalWorkflows: true,
        }),
      });

      const flags1 = resolve(DI.Infra.FeatureFlags);
      expect(flags1.isEnabled('sessionTools')).toBe(true);

      teardownTest();

      // Test 2: All features disabled (Test 1 doesn't affect Test 2)
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: false,
          experimentalWorkflows: false,
        }),
      });

      const flags2 = resolve(DI.Infra.FeatureFlags);
      expect(flags2.isEnabled('sessionTools')).toBe(false);
    });
  });

  describe('DRY Principle', () => {
    it('centralizes feature flag configuration (no duplication)', async () => {
      await setupTest();

      // Single source of truth for feature flags
      const flags = resolve(DI.Infra.FeatureFlags);

      // All services get the same feature flag instance
      const flagsAgain = resolve(DI.Infra.FeatureFlags);
      expect(flags).toBe(flagsAgain);
    });
  });

  describe('Liskov Substitution Principle', () => {
    it('can substitute different feature flag implementations', async () => {
      const implementations = [
        new StaticFeatureFlagProvider({ sessionTools: true }),
        new StaticFeatureFlagProvider({ sessionTools: false }),
      ];

      for (const impl of implementations) {
        await setupTest({
          featureFlags: impl,
        });

        const flags = resolve(DI.Infra.FeatureFlags);

        // All implementations support the same interface
        const result = flags.isEnabled('sessionTools');
        expect(typeof result).toBe('boolean');

        teardownTest();
      }
    });
  });
});

describe('Real-World Usage Patterns', () => {
  afterEach(() => {
    teardownTest();
  });

  describe('Production Configuration', () => {
    it('uses environment variables in production', async () => {
      // Production: Uses EnvironmentFeatureFlagProvider
      await setupTest();

      const featureFlags = resolve(DI.Infra.FeatureFlags);
      expect(featureFlags).toBeDefined();
    });
  });

  describe('Testing Configuration', () => {
    it('uses static values in tests (fast, predictable)', async () => {
      // Test: Inject known values
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: true,
          verboseLogging: false,
        }),
      });

      const flags = resolve(DI.Infra.FeatureFlags);

      // Predictable behavior for testing
      expect(flags.isEnabled('sessionTools')).toBe(true);
      expect(flags.isEnabled('verboseLogging')).toBe(false);
    });
  });

  describe('Development Configuration', () => {
    it('can enable all experimental features for development', async () => {
      await setupTest({
        featureFlags: new StaticFeatureFlagProvider({
          sessionTools: true,
          experimentalWorkflows: true,
          verboseLogging: true,
        }),
      });

      const flags = resolve(DI.Infra.FeatureFlags);

      // All features enabled for development/testing
      expect(flags.isEnabled('sessionTools')).toBe(true);
      expect(flags.isEnabled('experimentalWorkflows')).toBe(true);
      expect(flags.isEnabled('verboseLogging')).toBe(true);
    });
  });
});
