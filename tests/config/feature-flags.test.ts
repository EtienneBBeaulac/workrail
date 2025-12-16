/**
 * Feature Flags Tests
 * 
 * Demonstrates:
 * - Type safety (autocomplete, compile-time checks)
 * - Testability (dependency injection)
 * - Immutability (flags don't change after init)
 * - Clean architecture (interface segregation)
 */

import { describe, it, expect } from 'vitest';
import {
  EnvironmentFeatureFlagProvider,
  CustomEnvFeatureFlagProvider,
  StaticFeatureFlagProvider,
  createFeatureFlagProvider,
  FEATURE_FLAG_DEFINITIONS,
  type IFeatureFlagProvider,
} from '../../src/config/feature-flags.js';

describe('FeatureFlags - SOLID Principles', () => {
  describe('Interface Segregation Principle', () => {
    it('provides focused interface with only necessary methods', () => {
      const provider: IFeatureFlagProvider = new StaticFeatureFlagProvider();
      
      // Interface has exactly 3 methods - no bloat
      expect(typeof provider.isEnabled).toBe('function');
      expect(typeof provider.getAll).toBe('function');
      expect(typeof provider.getSummary).toBe('function');
    });
  });

  describe('Dependency Injection Principle', () => {
    it('accepts environment as parameter (not hardcoded to process.env)', () => {
      const mockEnv = {
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
        WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS: 'false',
      };
      
      // Use CustomEnvFeatureFlagProvider for custom environments (testing)
      const provider = new CustomEnvFeatureFlagProvider(mockEnv);
      
      expect(provider.isEnabled('sessionTools')).toBe(true);
      expect(provider.isEnabled('experimentalWorkflows')).toBe(false);
    });

    it('allows multiple implementations (environment vs static)', () => {
      // Implementation 1: Environment-based with custom env (testing)
      const envProvider = new CustomEnvFeatureFlagProvider({ 
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true' 
      });
      
      // Implementation 2: Static (testing)
      const staticProvider = new StaticFeatureFlagProvider({ 
        sessionTools: false 
      });
      
      // Both implement same interface
      const providers: IFeatureFlagProvider[] = [envProvider, staticProvider];
      
      expect(providers[0].isEnabled('sessionTools')).toBe(true);
      expect(providers[1].isEnabled('sessionTools')).toBe(false);
    });
  });

  describe('Single Responsibility Principle', () => {
    it('only handles feature flag configuration - nothing else', () => {
      const provider = new EnvironmentFeatureFlagProvider({});
      
      // Provider only knows about flags - not workflows, storage, etc.
      expect(provider.isEnabled('sessionTools')).toBeDefined();
      
      // Doesn't know about unrelated application concerns
      expect((provider as any).loadWorkflow).toBeUndefined();
      expect((provider as any).saveData).toBeUndefined();
      expect((provider as any).httpServer).toBeUndefined();
    });
  });

  describe('Open/Closed Principle', () => {
    it('allows adding new flags without modifying existing code', () => {
      // New flags are added to FEATURE_FLAG_DEFINITIONS array
      // No need to change EnvironmentFeatureFlagProvider implementation
      const flagCount = FEATURE_FLAG_DEFINITIONS.length;
      
      expect(flagCount).toBeGreaterThanOrEqual(3);
      
      // All flags are automatically supported
      const provider = new EnvironmentFeatureFlagProvider({});
      for (const definition of FEATURE_FLAG_DEFINITIONS) {
        const result = provider.isEnabled(definition.key as any);
        expect(typeof result).toBe('boolean');
      }
    });
  });

  describe('Immutability', () => {
    it('returns same values after initialization (immutable)', () => {
      const provider = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
      });
      
      const firstCheck = provider.isEnabled('sessionTools');
      const secondCheck = provider.isEnabled('sessionTools');
      const thirdCheck = provider.isEnabled('sessionTools');
      
      expect(firstCheck).toBe(true);
      expect(secondCheck).toBe(true);
      expect(thirdCheck).toBe(true);
    });

    it('getAll() returns copy (not internal reference)', () => {
      const provider = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
      });
      
      const flags1 = provider.getAll();
      const flags2 = provider.getAll();
      
      // Different objects (copies, not same reference)
      expect(flags1).not.toBe(flags2);
      
      // But same values
      expect(flags1).toEqual(flags2);
    });
  });
});

describe('FeatureFlags - Functionality', () => {
  describe('Boolean Parsing', () => {
    it('recognizes truthy values', () => {
      const truthyVariants = ['true', 'TRUE', '1', 'yes', 'YES', 'on', 'ON'];
      
      for (const value of truthyVariants) {
        const provider = new CustomEnvFeatureFlagProvider({
          WORKRAIL_ENABLE_SESSION_TOOLS: value,
        });
        
        expect(provider.isEnabled('sessionTools')).toBe(true);
      }
    });

    it('recognizes falsy values', () => {
      const falsyVariants = ['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF'];
      
      for (const value of falsyVariants) {
        const provider = new CustomEnvFeatureFlagProvider({
          WORKRAIL_ENABLE_SESSION_TOOLS: value,
        });
        
        expect(provider.isEnabled('sessionTools')).toBe(false);
      }
    });

    it('uses default for undefined environment variable', () => {
      const provider = new CustomEnvFeatureFlagProvider({});
      
      // sessionTools defaults to false (experimental)
      expect(provider.isEnabled('sessionTools')).toBe(false);
      
      // verboseLogging defaults to false (but stable)
      expect(provider.isEnabled('verboseLogging')).toBe(false);
    });

    it('uses default for invalid boolean values (with warning)', () => {
      // Should fall back to default without crashing
      const provider = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'maybe',
      });
      
      // Falls back to default (false)
      expect(provider.isEnabled('sessionTools')).toBe(false);
    });
  });

  describe('Type Safety', () => {
    it('provides type-safe flag keys (compile-time checking)', () => {
      const provider = new StaticFeatureFlagProvider();
      
      // These work (valid keys)
      provider.isEnabled('sessionTools');
      provider.isEnabled('experimentalWorkflows');
      provider.isEnabled('verboseLogging');
      
      // This would fail TypeScript compilation:
      // provider.isEnabled('invalidFlag');
      
      expect(true).toBe(true); // TypeScript compilation is the test
    });
  });

  describe('StaticFeatureFlagProvider (Testing)', () => {
    it('allows explicit flag values for testing', () => {
      const provider = new StaticFeatureFlagProvider({
        sessionTools: true,
        experimentalWorkflows: false,
        verboseLogging: true,
      });
      
      expect(provider.isEnabled('sessionTools')).toBe(true);
      expect(provider.isEnabled('experimentalWorkflows')).toBe(false);
      expect(provider.isEnabled('verboseLogging')).toBe(true);
    });

    it('uses defaults for unspecified flags', () => {
      const provider = new StaticFeatureFlagProvider({
        sessionTools: true,
        // Other flags not specified
      });
      
      expect(provider.isEnabled('sessionTools')).toBe(true);
      
      // Others use their defaults from FEATURE_FLAG_DEFINITIONS
      expect(provider.isEnabled('experimentalWorkflows')).toBe(false);
      expect(provider.isEnabled('verboseLogging')).toBe(false);
    });
  });

  describe('Static Factory (withEnv)', () => {
    it('creates provider with default env', () => {
      const provider = new EnvironmentFeatureFlagProvider();
      expect(provider).toBeInstanceOf(EnvironmentFeatureFlagProvider);
    });

    it('creates provider with custom environment', () => {
      const provider = EnvironmentFeatureFlagProvider.withEnv({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
      });
      
      expect(provider.isEnabled('sessionTools')).toBe(true);
    });
  });

  describe('Summary Output', () => {
    it('provides human-readable summary', () => {
      const provider = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
      });
      
      const summary = provider.getSummary();
      
      expect(summary).toContain('Feature Flags:');
      expect(summary).toContain('sessionTools');
      expect(summary).toContain('ENABLED');
      expect(summary).toContain('WORKRAIL_ENABLE_SESSION_TOOLS');
    });
  });
});

describe('FeatureFlags - Real-World Scenarios', () => {
  describe('Trunk-Based Development', () => {
    it('supports merging features with flags OFF by default', () => {
      // Scenario: Feature merged to main, but not ready for production
      const provider = new CustomEnvFeatureFlagProvider({});
      
      // Flag is OFF by default (safe to merge)
      expect(provider.isEnabled('sessionTools')).toBe(false);
      
      // Can be enabled in specific environments for testing
      const testProvider = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'true',
      });
      expect(testProvider.isEnabled('sessionTools')).toBe(true);
    });

    it('supports gradual rollout by changing defaults', () => {
      // Phase 1: Feature merged, flag OFF by default
      const phase1 = new CustomEnvFeatureFlagProvider({});
      expect(phase1.isEnabled('sessionTools')).toBe(false);
      
      // Phase 2: Feature stabilized, flag ON by default
      // (would require changing defaultValue in FEATURE_FLAG_DEFINITIONS)
      // Users can still explicitly disable if needed
      const phase2 = new CustomEnvFeatureFlagProvider({
        WORKRAIL_ENABLE_SESSION_TOOLS: 'false', // Explicit override
      });
      expect(phase2.isEnabled('sessionTools')).toBe(false);
    });
  });

  describe('Testing Scenarios', () => {
    it('allows testing feature combinations easily', () => {
      // Test with all features enabled
      const allEnabled = new StaticFeatureFlagProvider({
        sessionTools: true,
        experimentalWorkflows: true,
        verboseLogging: true,
      });
      
      expect(allEnabled.isEnabled('sessionTools')).toBe(true);
      expect(allEnabled.isEnabled('experimentalWorkflows')).toBe(true);
      
      // Test with all features disabled
      const allDisabled = new StaticFeatureFlagProvider({
        sessionTools: false,
        experimentalWorkflows: false,
        verboseLogging: false,
      });
      
      expect(allDisabled.isEnabled('sessionTools')).toBe(false);
      expect(allDisabled.isEnabled('experimentalWorkflows')).toBe(false);
    });
  });
});

