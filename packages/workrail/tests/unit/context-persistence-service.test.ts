import { ContextPersistenceService } from '../../src/application/services/context-persistence-service';
import { ClassificationEngine } from '../../src/application/services/classification-engine';
import { CompressionService } from '../../src/application/services/compression-service';
import {
  ContextLayer,
  RawContext,
  ClassifiedContext,
  CompressedBlob,
  IClassificationEngine,
  ICompressionService
} from '../../src/types/context-types';

// Mock implementations for testing
class MockClassificationEngine implements IClassificationEngine {
  async classify(context: RawContext): Promise<ClassifiedContext> {
    return {
      [ContextLayer.CRITICAL]: { userGoal: context.userGoal || 'test goal' },
      [ContextLayer.IMPORTANT]: { strategy: context.strategy || 'test strategy' },
      [ContextLayer.USEFUL]: { details: context.details || 'test details' },
      [ContextLayer.EPHEMERAL]: { timestamp: context.timestamp || Date.now() }
    };
  }

  async markCritical(sessionId: string, contextKey: string): Promise<void> {
    // Mock implementation
  }

  async loadRules(): Promise<void> {
    // Mock implementation
  }
}

class MockCompressionService implements ICompressionService {
  async compress(classified: ClassifiedContext): Promise<CompressedBlob> {
    const serialized = JSON.stringify(classified);
    const data = Buffer.from(serialized, 'utf8');
    return {
      data,
      originalSize: data.length,
      compressedSize: Math.floor(data.length * 0.7), // Simulate 30% compression
      compressionRatio: 1.43,
      algorithm: 'gzip'
    };
  }

  async decompress(blob: CompressedBlob): Promise<RawContext> {
    const classified = JSON.parse(blob.data.toString('utf8')) as ClassifiedContext;
    // Flatten back to raw context
    const result: RawContext = {};
    Object.values(classified).forEach(layer => {
      Object.assign(result, layer);
    });
    return result;
  }

  getStats() {
    return {
      totalOperations: 1,
      averageRatio: 1.43,
      totalSizeReduction: 100,
      averageCompressionTime: 5
    };
  }
}

describe('ContextPersistenceService', () => {
  let persistenceService: ContextPersistenceService;
  let mockClassificationEngine: MockClassificationEngine;
  let mockCompressionService: MockCompressionService;

  beforeEach(() => {
    mockClassificationEngine = new MockClassificationEngine();
    mockCompressionService = new MockCompressionService();
    persistenceService = new ContextPersistenceService(
      mockClassificationEngine,
      mockCompressionService
    );
  });

  afterEach(() => {
    persistenceService.resetMetrics();
  });

  describe('constructor', () => {
    it('should initialize with empty metrics', () => {
      const service = new ContextPersistenceService(
        mockClassificationEngine,
        mockCompressionService
      );
      
      const metrics = service.getMetrics();
      expect(metrics.totalOperations).toBe(0);
      expect(metrics.averageClassificationTime).toBe(0);
      expect(metrics.averageCompressionTime).toBe(0);
      expect(metrics.averageTotalTime).toBe(0);
    });
  });

  describe('classifyContext', () => {
    it('should classify context and return immutable result', async () => {
      const context: RawContext = {
        userGoal: 'Implement feature X',
        strategy: 'Use TDD approach',
        details: 'Write tests first',
        timestamp: Date.now()
      };

      const result = await persistenceService.classifyContext(context);

      expect(result).toHaveProperty(ContextLayer.CRITICAL);
      expect(result).toHaveProperty(ContextLayer.IMPORTANT);
      expect(result).toHaveProperty(ContextLayer.USEFUL);
      expect(result).toHaveProperty(ContextLayer.EPHEMERAL);
      
      expect(result[ContextLayer.CRITICAL]).toHaveProperty('userGoal');
      expect(result[ContextLayer.IMPORTANT]).toHaveProperty('strategy');
      
      // Should be immutable
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[ContextLayer.CRITICAL])).toBe(true);
    });

    it('should update classification metrics', async () => {
      const context: RawContext = { test: 'data' };

      await persistenceService.classifyContext(context);

      const metrics = persistenceService.getMetrics();
      expect(metrics.totalOperations).toBe(1);
      expect(metrics.averageClassificationTime).toBeGreaterThan(0);
    });

    it('should handle classification errors gracefully', async () => {
      // Mock classification engine to throw error
      jest.spyOn(mockClassificationEngine, 'classify').mockRejectedValue(new Error('Classification failed'));

      const context: RawContext = { test: 'data' };
      
      const result = await persistenceService.classifyContext(context);

      // Should fallback to putting all content in IMPORTANT layer
      expect(result[ContextLayer.IMPORTANT]).toEqual({ test: 'data' });
      expect(result[ContextLayer.CRITICAL]).toEqual({});
    });
  });

  describe('compressContext', () => {
    it('should compress classified context', async () => {
      const classified: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { userGoal: 'test' },
        [ContextLayer.IMPORTANT]: { strategy: 'test' },
        [ContextLayer.USEFUL]: { details: 'test' },
        [ContextLayer.EPHEMERAL]: { timestamp: Date.now() }
      };

      const result = await persistenceService.compressContext(classified);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('originalSize');
      expect(result).toHaveProperty('compressedSize');
      expect(result).toHaveProperty('compressionRatio');
      expect(result).toHaveProperty('algorithm');
      
      expect(Buffer.isBuffer(result.data)).toBe(true);
      expect(result.compressionRatio).toBeGreaterThan(1);
    });

    it('should update compression metrics', async () => {
      const classified: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      await persistenceService.compressContext(classified);

      const metrics = persistenceService.getMetrics();
      expect(metrics.averageCompressionTime).toBeGreaterThan(0);
    });

    it('should handle compression errors gracefully', async () => {
      // Mock compression service to throw error
      jest.spyOn(mockCompressionService, 'compress').mockRejectedValue(new Error('Compression failed'));

      const classified: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };
      
      const result = await persistenceService.compressContext(classified);

      // Should fallback to uncompressed blob
      expect(result.algorithm).toBe('none');
      expect(result.compressionRatio).toBe(1.0);
    });
  });

  describe('decompressContext', () => {
    it('should decompress blob back to raw context', async () => {
      const originalContext = { test: 'data', more: 'info' };
      const blob: CompressedBlob = {
        data: Buffer.from(JSON.stringify({
          [ContextLayer.CRITICAL]: { test: 'data' },
          [ContextLayer.IMPORTANT]: { more: 'info' },
          [ContextLayer.USEFUL]: {},
          [ContextLayer.EPHEMERAL]: {}
        }), 'utf8'),
        originalSize: 100,
        compressedSize: 70,
        compressionRatio: 1.43,
        algorithm: 'gzip'
      };

      const result = await persistenceService.decompressContext(blob);

      expect(result).toHaveProperty('test');
      expect(result).toHaveProperty('more');
      expect(result.test).toBe('data');
      expect(result.more).toBe('info');
      
      // Should be immutable
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('should throw error for invalid compressed blob', async () => {
      const invalidBlob: CompressedBlob = {
        data: Buffer.from('invalid data', 'utf8'),
        originalSize: 100,
        compressedSize: 70,
        compressionRatio: 1.43,
        algorithm: 'gzip'
      };

      // Mock compression service to throw error
      jest.spyOn(mockCompressionService, 'decompress').mockRejectedValue(new Error('Invalid data'));

      await expect(persistenceService.decompressContext(invalidBlob))
        .rejects.toThrow('Failed to decompress context');
    });
  });

  describe('generateSessionId', () => {
    it('should generate deterministic session ID', () => {
      const workflowId = 'test-workflow';
      const context: RawContext = { userGoal: 'test', timestamp: 123456 };

      const sessionId1 = persistenceService.generateSessionId(workflowId, context);
      const sessionId2 = persistenceService.generateSessionId(workflowId, context);

      expect(sessionId1).toBe(sessionId2); // Should be deterministic
      expect(sessionId1).toMatch(/^[a-zA-Z0-9-]+$/); // Should contain only valid characters
      expect(sessionId1.length).toBeLessThanOrEqual(32); // Should respect max length
    });

    it('should generate different session IDs for different inputs', () => {
      const workflowId = 'test-workflow';
      const context1: RawContext = { userGoal: 'test1' };
      const context2: RawContext = { userGoal: 'test2' };

      const sessionId1 = persistenceService.generateSessionId(workflowId, context1);
      const sessionId2 = persistenceService.generateSessionId(workflowId, context2);

      expect(sessionId1).not.toBe(sessionId2);
    });

    it('should handle session ID generation errors gracefully', () => {
      const workflowId = 'test-workflow';
      const context: RawContext = { circular: {} };
      context.circular = context; // Create circular reference

      // Should not throw, but use fallback
      const sessionId = persistenceService.generateSessionId(workflowId, context);
      
      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^[a-zA-Z0-9-]+$/);
    });
  });

  describe('processPersistencePipeline', () => {
    it('should execute complete persistence pipeline', async () => {
      const context: RawContext = {
        userGoal: 'Test pipeline',
        strategy: 'End-to-end test',
        details: 'Full pipeline execution'
      };
      const workflowId = 'test-workflow';

      const result = await persistenceService.processPersistencePipeline(context, workflowId);

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('classified');
      expect(result).toHaveProperty('compressed');
      expect(result).toHaveProperty('metrics');

      expect(result.sessionId).toMatch(/^[a-zA-Z0-9-]+$/);
      expect(result.classified).toHaveProperty(ContextLayer.CRITICAL);
      expect(result.compressed).toHaveProperty('data');
      
      expect(result.metrics.classificationTime).toBeGreaterThan(0);
      expect(result.metrics.compressionTime).toBeGreaterThan(0);
      expect(result.metrics.totalTime).toBeGreaterThan(0);
    });

    it('should handle pipeline errors gracefully', async () => {
      // Mock classification to fail
      jest.spyOn(mockClassificationEngine, 'classify').mockRejectedValue(new Error('Pipeline failed'));

      const context: RawContext = { test: 'data' };
      const workflowId = 'test-workflow';

      // Should not throw due to graceful fallback, but should still process
      const result = await persistenceService.processPersistencePipeline(context, workflowId);

      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('classified');
      expect(result).toHaveProperty('compressed');
      // Should have fallback classification with data in IMPORTANT layer
      expect(result.classified[ContextLayer.IMPORTANT]).toEqual({ test: 'data' });
    });
  });

  describe('processRestorationPipeline', () => {
    it('should execute complete restoration pipeline', async () => {
      const blob: CompressedBlob = {
        data: Buffer.from(JSON.stringify({
          [ContextLayer.CRITICAL]: { userGoal: 'Restored goal' },
          [ContextLayer.IMPORTANT]: { strategy: 'Restored strategy' },
          [ContextLayer.USEFUL]: {},
          [ContextLayer.EPHEMERAL]: {}
        }), 'utf8'),
        originalSize: 100,
        compressedSize: 70,
        compressionRatio: 1.43,
        algorithm: 'gzip'
      };

      const result = await persistenceService.processRestorationPipeline(blob);

      expect(result).toHaveProperty('context');
      expect(result).toHaveProperty('metrics');

      expect(result.context).toHaveProperty('userGoal');
      expect(result.context).toHaveProperty('strategy');
      expect(result.metrics.decompressionTime).toBeGreaterThan(0);
      
      // Should be immutable
      expect(Object.isFrozen(result.context)).toBe(true);
    });

    it('should handle restoration errors', async () => {
      // Mock decompression to fail
      jest.spyOn(mockCompressionService, 'decompress').mockRejectedValue(new Error('Decompression failed'));

      const blob: CompressedBlob = {
        data: Buffer.from('invalid', 'utf8'),
        originalSize: 100,
        compressedSize: 70,
        compressionRatio: 1.43,
        algorithm: 'gzip'
      };

      await expect(persistenceService.processRestorationPipeline(blob))
        .rejects.toThrow('Restoration pipeline error');
    });
  });

  describe('metrics and performance', () => {
    it('should track performance metrics', async () => {
      const context: RawContext = { test: 'data' };
      const workflowId = 'test-workflow';

      // Execute multiple operations
      await persistenceService.processPersistencePipeline(context, workflowId);
      await persistenceService.processPersistencePipeline(context, workflowId);

      const metrics = persistenceService.getMetrics();
      
      expect(metrics.totalOperations).toBe(2);
      expect(metrics.averageClassificationTime).toBeGreaterThan(0);
      expect(metrics.averageCompressionTime).toBeGreaterThan(0);
      expect(metrics.averageTotalTime).toBeGreaterThan(0);
      expect(metrics.lastOperationTime).toBeGreaterThan(0);
    });

    it('should reset metrics', () => {
      persistenceService.resetMetrics();
      
      const metrics = persistenceService.getMetrics();
      expect(metrics.totalOperations).toBe(0);
      expect(metrics.averageClassificationTime).toBe(0);
      expect(metrics.averageCompressionTime).toBe(0);
      expect(metrics.averageTotalTime).toBe(0);
    });

    it('should return immutable metrics', () => {
      const metrics = persistenceService.getMetrics();
      const originalTotalOps = metrics.totalOperations;
      
      // Try to modify the returned metrics
      metrics.totalOperations = 999;
      
      // Should not affect the actual metrics
      const newMetrics = persistenceService.getMetrics();
      expect(newMetrics.totalOperations).toBe(originalTotalOps);
    });
  });

  describe('interface compliance', () => {
    it('should implement IContextPersistenceService interface methods', () => {
      // These methods should exist but throw errors (placeholder implementations)
      expect(persistenceService.persistContext).toBeDefined();
      expect(persistenceService.restoreContext).toBeDefined();
      expect(persistenceService.getSession).toBeDefined();
    });

    it('should throw errors for placeholder interface methods', async () => {
      await expect(persistenceService.persistContext('session1', {}, {}))
        .rejects.toThrow('persistContext not implemented');
        
      await expect(persistenceService.restoreContext('checkpoint1'))
        .rejects.toThrow('restoreContext not implemented');
        
      await expect(persistenceService.getSession('session1'))
        .rejects.toThrow('getSession not implemented');
    });
  });

  describe('integration with real services', () => {
    it('should work with real ClassificationEngine and CompressionService', async () => {
      const realClassificationEngine = new ClassificationEngine() as any; // Cast to bypass interface mismatch
      const realCompressionService = new CompressionService();
      const realPersistenceService = new ContextPersistenceService(
        realClassificationEngine,
        realCompressionService
      );

      const context: RawContext = {
        userGoal: 'Test with real services',
        debugInfo: 'This should go to ephemeral',
        implementationDetails: 'This is a long implementation detail that should be useful layer and may get compressed'
      };
      const workflowId = 'integration-test';

      const result = await realPersistenceService.processPersistencePipeline(context, workflowId);

      expect(result.sessionId).toBeDefined();
      expect(result.classified[ContextLayer.CRITICAL]).toHaveProperty('userGoal');
      expect(result.compressed.algorithm).toBe('gzip');
      expect(result.metrics.totalTime).toBeGreaterThan(0);

      // Test round-trip
      const restored = await realPersistenceService.processRestorationPipeline(result.compressed);
      expect(restored.context).toHaveProperty('userGoal');
      expect(restored.context.userGoal).toBe('Test with real services');
    });
  });
}); 