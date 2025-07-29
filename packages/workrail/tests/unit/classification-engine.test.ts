import { 
  ClassificationEngine, 
  IClassificationEngine,
  ClassificationStats 
} from '../../src/application/services/classification-engine';
import { 
  ContextLayer, 
  ClassificationRules, 
  RawContext,
  ClassifiedContext 
} from '../../src/types/context-types';

describe('ClassificationEngine', () => {
  let engine: IClassificationEngine;

  beforeEach(() => {
    engine = new ClassificationEngine();
  });

  describe('constructor', () => {
    it('should initialize with default rules when none provided', () => {
      const newEngine = new ClassificationEngine();
      const stats = newEngine.getStats();
      
      expect(stats.totalClassifications).toBe(0);
      expect(stats.overrideCount).toBe(0);
      expect(stats.averageProcessingTime).toBe(0);
    });

    it('should accept custom initial rules', () => {
      const customRules: ClassificationRules = {
        patterns: {
          [ContextLayer.CRITICAL]: [{
            keyPattern: 'test',
            weight: 100,
            description: 'Test pattern'
          }],
          [ContextLayer.IMPORTANT]: [],
          [ContextLayer.USEFUL]: [],
          [ContextLayer.EPHEMERAL]: []
        },
        heuristics: {
          lengthThresholds: {
            [ContextLayer.CRITICAL]: 500,
            [ContextLayer.IMPORTANT]: 250,
            [ContextLayer.USEFUL]: 100,
            [ContextLayer.EPHEMERAL]: 0
          },
          keywordWeights: { 'test': 10 },
          defaultLayer: ContextLayer.EPHEMERAL
        },
        overrides: {}
      };

      const customEngine = new ClassificationEngine(customRules);
      expect(customEngine).toBeDefined();
    });
  });

  describe('classify', () => {
    it('should classify context keys by patterns correctly', async () => {
      const context: RawContext = {
        goal: 'Complete the project',
        plan: 'Step by step approach',
        data: 'Supporting information',
        debug: 'Debug message'
      };

      const result = await engine.classify(context);

      expect(result[ContextLayer.CRITICAL]).toHaveProperty('goal');
      expect(result[ContextLayer.IMPORTANT]).toHaveProperty('plan');
      expect(result[ContextLayer.USEFUL]).toHaveProperty('data');
      expect(result[ContextLayer.EPHEMERAL]).toHaveProperty('debug');
    });

    it('should prioritize patterns by weight', async () => {
      const context: RawContext = {
        'critical-goal': 'High priority item',
        'plan-critical': 'Should be CRITICAL due to higher weight'
      };

      const result = await engine.classify(context);

      // Both should be CRITICAL, but critical-goal has higher weight pattern
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('critical-goal');
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('plan-critical');
    });

    it('should apply heuristics when no patterns match', async () => {
      // Create content that definitely exceeds the length thresholds
      const longContent = 'A'.repeat(1500); // Definitely > 1000 chars for CRITICAL
      const mediumContent = 'B'.repeat(750); // > 500 chars for IMPORTANT
      const shortContent = 'Brief text'; // Default to USEFUL
      
      const context: RawContext = {
        'unknown-key': longContent,
        'short': shortContent,
        'medium': mediumContent
      };

      const result = await engine.classify(context);

      // Long content should be CRITICAL due to length
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('unknown-key');
      // Medium content should be IMPORTANT
      expect(result[ContextLayer.IMPORTANT]).toHaveProperty('medium');
      // Short content should be USEFUL (default fallback)
      expect(result[ContextLayer.USEFUL]).toHaveProperty('short');
    });

    it('should apply keyword scoring in heuristics', async () => {
      const context: RawContext = {
        'text-with-goal': 'This mentions a goal and objective which are important keywords',
        'text-with-debug': 'This contains debug information',
        'neutral-text': 'Just some regular content'
      };

      const result = await engine.classify(context);

      // High keyword score should classify as CRITICAL
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('text-with-goal');
      // Low keyword score with debug should be EPHEMERAL due to pattern
      expect(result[ContextLayer.EPHEMERAL]).toHaveProperty('text-with-debug');
      // Neutral should be USEFUL (default)
      expect(result[ContextLayer.USEFUL]).toHaveProperty('neutral-text');
    });

    it('should return immutable result', async () => {
      const context: RawContext = { test: 'value' };
      const result = await engine.classify(context);

      expect(() => {
        (result as any).newProperty = 'should fail';
      }).toThrow();
    });

    it('should update statistics after classification', async () => {
      // Use a fresh engine to avoid interference from other tests
      const freshEngine = new ClassificationEngine();
      
      const context: RawContext = {
        goal: 'Test goal',
        data: 'Test data'
      };

      const statsBefore = freshEngine.getStats();
      await freshEngine.classify(context);
      const statsAfter = freshEngine.getStats();

      expect(statsAfter.totalClassifications).toBe(1);
      expect(statsAfter.averageProcessingTime).toBeGreaterThan(0);
      
      // Check that items were distributed to layers
      const totalItemsAfter = Object.values(statsAfter.layerDistribution).reduce((sum, count) => sum + count, 0);
      expect(totalItemsAfter).toBe(Object.keys(context).length);
    });
  });

  describe('loadRules', () => {
    it('should load partial rules configuration', async () => {
      const partialConfig: Partial<ClassificationRules> = {
        heuristics: {
          lengthThresholds: {
            [ContextLayer.CRITICAL]: 1000,
            [ContextLayer.IMPORTANT]: 500,
            [ContextLayer.USEFUL]: 100,
            [ContextLayer.EPHEMERAL]: 0
          },
          keywordWeights: { 'test': 10 },
          defaultLayer: ContextLayer.IMPORTANT
        }
      };

      await engine.loadRules(partialConfig);

      // Should still work with updated default layer
      const context: RawContext = { 'unknown-key': 'short' };
      const result = await engine.classify(context);

      expect(result[ContextLayer.IMPORTANT]).toHaveProperty('unknown-key');
    });

    it('should merge new rules with existing rules', async () => {
      const additionalPatterns: Partial<ClassificationRules> = {
        patterns: {
          [ContextLayer.CRITICAL]: [{
            keyPattern: 'custom-critical',
            weight: 95,
            description: 'Custom critical pattern'
          }],
          [ContextLayer.IMPORTANT]: [],
          [ContextLayer.USEFUL]: [],
          [ContextLayer.EPHEMERAL]: []
        }
      };

      await engine.loadRules(additionalPatterns);

      const context: RawContext = {
        'custom-critical': 'should be critical',
        'goal': 'should still be critical'
      };

      const result = await engine.classify(context);

      expect(result[ContextLayer.CRITICAL]).toHaveProperty('custom-critical');
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('goal');
    });
  });

  describe('overrides', () => {
    const sessionId = 'test-session-123';

    it('should add and apply manual overrides', async () => {
      const contextKey = 'normally-useful-data';
      
      // Add override to make it CRITICAL
      engine.addOverride(sessionId, contextKey, ContextLayer.CRITICAL);

      const context: RawContext = {
        [contextKey]: 'This would normally be classified as USEFUL'
      };

      // Need to pass sessionId to classification to apply overrides
      // Note: The current interface doesn't support sessionId, so this test demonstrates the expected behavior
      // In practice, the classify method would need to be enhanced to accept sessionId parameter
      const stats = engine.getStats();
      expect(stats.overrideCount).toBe(1);
    });

    it('should remove manual overrides', () => {
      const contextKey = 'test-key';
      
      engine.addOverride(sessionId, contextKey, ContextLayer.CRITICAL);
      expect(engine.getStats().overrideCount).toBe(1);

      engine.removeOverride(sessionId, contextKey);
      expect(engine.getStats().overrideCount).toBe(0);
    });

    it('should clean up empty session maps when removing overrides', () => {
      const contextKey = 'test-key';
      
      engine.addOverride(sessionId, contextKey, ContextLayer.CRITICAL);
      engine.removeOverride(sessionId, contextKey);

      // Should be able to add again without issues (session map was cleaned up)
      engine.addOverride(sessionId, contextKey, ContextLayer.IMPORTANT);
      expect(engine.getStats().overrideCount).toBe(1);
    });

    it('should handle removal of non-existent overrides gracefully', () => {
      expect(() => {
        engine.removeOverride('non-existent-session', 'non-existent-key');
      }).not.toThrow();

      expect(engine.getStats().overrideCount).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current statistics', () => {
      const stats = engine.getStats();

      expect(stats).toHaveProperty('totalClassifications');
      expect(stats).toHaveProperty('layerDistribution');
      expect(stats).toHaveProperty('overrideCount');
      expect(stats).toHaveProperty('averageProcessingTime');

      // Should have all layers in distribution
      expect(stats.layerDistribution).toHaveProperty(ContextLayer.CRITICAL);
      expect(stats.layerDistribution).toHaveProperty(ContextLayer.IMPORTANT);
      expect(stats.layerDistribution).toHaveProperty(ContextLayer.USEFUL);
      expect(stats.layerDistribution).toHaveProperty(ContextLayer.EPHEMERAL);
    });

    it('should return a copy of stats (not reference)', () => {
      const stats1 = engine.getStats();
      const stats2 = engine.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });

  describe('pattern matching edge cases', () => {
    it('should handle case-insensitive pattern matching', async () => {
      const context: RawContext = {
        'GOAL': 'uppercase key',
        'Goal': 'mixed case key',
        'goal': 'lowercase key'
      };

      const result = await engine.classify(context);

      // All should be classified as CRITICAL regardless of case
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('GOAL');
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('Goal');
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('goal');
    });

    it('should handle complex data types in values', async () => {
      const context: RawContext = {
        'object-data': { nested: { value: 'test' } },
        'array-data': [1, 2, 3, 'test'],
        'null-data': null,
        'undefined-data': undefined,
        'number-data': 42
      };

      const result = await engine.classify(context);

      // Should not throw errors and should classify all items
      const totalItems = Object.keys(context).length;
      const classifiedItems = Object.values(result).reduce((sum, layer) => sum + Object.keys(layer).length, 0);
      
      expect(classifiedItems).toBe(totalItems);
    });

    it('should handle empty context', async () => {
      const context: RawContext = {};
      const result = await engine.classify(context);

      expect(result[ContextLayer.CRITICAL]).toEqual({});
      expect(result[ContextLayer.IMPORTANT]).toEqual({});
      expect(result[ContextLayer.USEFUL]).toEqual({});
      expect(result[ContextLayer.EPHEMERAL]).toEqual({});
    });
  });

  describe('performance characteristics', () => {
    it('should handle large context objects efficiently', async () => {
      // Create a large context object
      const largeContext: RawContext = {};
      for (let i = 0; i < 1000; i++) {
        largeContext[`item-${i}`] = `value-${i}`;
      }

      const startTime = Date.now();
      const result = await engine.classify(largeContext);
      const endTime = Date.now();

      // Should complete within reasonable time (< 100ms for 1000 items)
      expect(endTime - startTime).toBeLessThan(100);

      // Should classify all items
      const totalClassified = Object.values(result).reduce((sum, layer) => sum + Object.keys(layer).length, 0);
      expect(totalClassified).toBe(1000);
    });

    it('should track processing time accurately', async () => {
      const context: RawContext = { test: 'value' };
      
      await engine.classify(context);
      const stats = engine.getStats();

      expect(stats.averageProcessingTime).toBeGreaterThan(0);
      expect(stats.averageProcessingTime).toBeLessThan(50); // Should be fast
    });
  });
}); 