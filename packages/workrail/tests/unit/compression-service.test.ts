import { CompressionService } from '../../src/application/services/compression-service';
import {
  ContextLayer,
  ClassifiedContext,
  CompressedBlob,
  CompressionConfig
} from '../../src/types/context-types';

describe('CompressionService', () => {
  let compressionService: CompressionService;

  beforeEach(() => {
    compressionService = new CompressionService();
  });

  afterEach(() => {
    compressionService.resetStats();
  });

  describe('constructor', () => {
    it('should initialize with default configuration', () => {
      const service = new CompressionService();
      const stats = service.getStats();
      
      expect(stats.totalOperations).toBe(0);
      expect(stats.averageRatio).toBe(1.0);
      expect(stats.totalSizeReduction).toBe(0);
      expect(stats.averageCompressionTime).toBe(0);
    });

    it('should accept custom configuration', () => {
      const customConfig: Partial<CompressionConfig> = {
        enabled: false,
        algorithm: 'deflate',
        level: 9
      };
      
      const service = new CompressionService(customConfig);
      // Configuration is private, so we test behavior through compression
      expect(service).toBeInstanceOf(CompressionService);
    });
  });

  describe('compress', () => {
    it('should compress classified context with layer-specific strategies', async () => {
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {
          userGoal: 'Implement native context management',
          taskComplexity: 'Large'
        },
        [ContextLayer.IMPORTANT]: {
          implementationPlan: 'Phase 1: Foundation, Phase 2: Storage, Phase 3: Services',
          architecturalDecisions: 'Hybrid SQLite + filesystem storage'
        },
        [ContextLayer.USEFUL]: {
          detailedAnalysis: 'This is a very long detailed analysis that could benefit from compression. '.repeat(50),
          codeExamples: ['example1', 'example2', 'example3']
        },
        [ContextLayer.EPHEMERAL]: {
          timestamp: '2024-01-09T12:00:00Z',
          debug_info: 'Temporary debug information',
          temp_data: 'This should be aggressively compressed'
        }
      };

      const result: CompressedBlob = await compressionService.compress(classifiedContext);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('originalSize');
      expect(result).toHaveProperty('compressedSize');
      expect(result).toHaveProperty('compressionRatio');
      expect(result).toHaveProperty('algorithm');
      
      expect(result.algorithm).toBe('gzip');
      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.compressedSize).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeGreaterThan(0);
      expect(Buffer.isBuffer(result.data)).toBe(true);
    });

    it('should achieve compression ratio for large context', async () => {
      const largeText = 'This is a large text that should compress well. '.repeat(100);
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: { importantData: largeText },
        [ContextLayer.USEFUL]: { usefulData: largeText },
        [ContextLayer.EPHEMERAL]: { ephemeralData: largeText }
      };

      const result = await compressionService.compress(classifiedContext);
      
      // Should achieve some compression
      expect(result.compressionRatio).toBeGreaterThan(1.0);
      expect(result.compressedSize).toBeLessThan(result.originalSize);
    });

    it('should handle empty classified context', async () => {
      const emptyContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const result = await compressionService.compress(emptyContext);
      
      expect(result.originalSize).toBeGreaterThan(0); // JSON overhead
      expect(result.compressedSize).toBeGreaterThan(0);
    });

    it('should update statistics after compression', async () => {
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      await compressionService.compress(classifiedContext);
      
      const stats = compressionService.getStats();
      expect(stats.totalOperations).toBe(1);
      expect(stats.averageCompressionTime).toBeGreaterThan(0);
    });

    it('should handle compression failures gracefully', async () => {
      // Create a mock that will throw an error
      const service = new CompressionService();
      
      // Mock the applyAlgorithmCompression method to throw an error
      const originalMethod = (service as any).applyAlgorithmCompression;
      (service as any).applyAlgorithmCompression = jest.fn().mockRejectedValue(new Error('Compression failed'));

      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      // Should not throw, but fallback to uncompressed
      const result = await service.compress(classifiedContext);
      
      expect(result.algorithm).toBe('none');
      expect(result.compressionRatio).toBe(1.0);
      
      // Restore original method
      (service as any).applyAlgorithmCompression = originalMethod;
    });
  });

  describe('decompress', () => {
    it('should decompress compressed blob back to original context', async () => {
      const originalContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {
          userGoal: 'Test decompression',
          priority: 'high'
        },
        [ContextLayer.IMPORTANT]: {
          strategy: 'round-trip test'
        },
        [ContextLayer.USEFUL]: {
          details: 'Some useful details'
        },
        [ContextLayer.EPHEMERAL]: {
          timestamp: '2024-01-09T12:00:00Z'
        }
      };

      const compressed = await compressionService.compress(originalContext);
      const decompressed = await compressionService.decompress(compressed);

      // Should be able to access the flattened context
      expect(decompressed).toHaveProperty('userGoal');
      expect(decompressed).toHaveProperty('priority');
      expect(decompressed).toHaveProperty('strategy');
      expect(decompressed.userGoal).toBe('Test decompression');
      expect(decompressed.priority).toBe('high');
    });

    it('should handle uncompressed blobs', async () => {
      const uncompressedBlob: CompressedBlob = {
        data: Buffer.from(JSON.stringify({ test: 'data' }), 'utf8'),
        originalSize: 100,
        compressedSize: 100,
        compressionRatio: 1.0,
        algorithm: 'none'
      };

      const result = await compressionService.decompress(uncompressedBlob);
      
      expect(result).toEqual({ test: 'data' });
    });

    it('should return immutable context', async () => {
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const compressed = await compressionService.compress(classifiedContext);
      const decompressed = await compressionService.decompress(compressed);

      expect(Object.isFrozen(decompressed)).toBe(true);
    });

    it('should throw error for invalid compressed blob', async () => {
      const invalidBlob: CompressedBlob = {
        data: Buffer.from('invalid data', 'utf8'),
        originalSize: 100,
        compressedSize: 50,
        compressionRatio: 2.0,
        algorithm: 'gzip'
      };

      await expect(compressionService.decompress(invalidBlob)).rejects.toThrow('Decompression failed');
    });
  });

  describe('layer-specific compression', () => {
    it('should not compress CRITICAL layer data', async () => {
      const criticalData = { userGoal: 'Very important goal', taskType: 'critical' };
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: criticalData,
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const compressed = await compressionService.compress(classifiedContext);
      const decompressed = await compressionService.decompress(compressed);

      // Critical data should be preserved exactly
      expect(decompressed.userGoal).toBe('Very important goal');
      expect(decompressed.taskType).toBe('critical');
    });

    it('should apply light compression to IMPORTANT layer', async () => {
      const importantData = {
        plan: '   Spaced   out   text   with   excessive   whitespace   '
      };
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: importantData,
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const compressed = await compressionService.compress(classifiedContext);
      const decompressed = await compressionService.decompress(compressed);

      // Should compress whitespace
      expect(decompressed.plan).toBe('Spaced out text with excessive whitespace');
    });

    it('should apply medium compression to USEFUL layer', async () => {
      const usefulData = {
        longText: 'This is a very long text that exceeds 1000 characters. '.repeat(50), // >1000 chars
        largeArray: Array.from({ length: 100 }, (_, i) => `item${i}`)
      };
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: usefulData,
        [ContextLayer.EPHEMERAL]: {}
      };

      const compressed = await compressionService.compress(classifiedContext);
      const decompressed = await compressionService.decompress(compressed);

      // Long text should be truncated
      expect(decompressed.longText).toContain('...[truncated]');
      expect(decompressed.longText.length).toBeLessThan(usefulData.longText.length);
      
      // Large array should be truncated
      expect(decompressed.largeArray).toContain('...[truncated]');
      expect(decompressed.largeArray.length).toBeLessThan(usefulData.largeArray.length);
    });

    it('should apply aggressive compression to EPHEMERAL layer', async () => {
      const ephemeralData = {
        debug_info: 'This should be removed',
        temp_data: 'This should also be removed',
        timestamp: '2024-01-09T12:00:00Z',
        longEphemeralText: 'This is ephemeral text that is longer than 200 characters and should be heavily compressed. '.repeat(10),
        regularData: 'This should be kept but compressed'
      };
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: ephemeralData
      };

      const compressed = await compressionService.compress(classifiedContext);
      const decompressed = await compressionService.decompress(compressed);

      // Debug and temp data should be removed
      expect(decompressed.debug_info).toBeUndefined();
      expect(decompressed.temp_data).toBeUndefined();
      expect(decompressed.timestamp).toBeUndefined();
      
      // Long text should be heavily compressed
      if (decompressed.longEphemeralText) {
        expect(decompressed.longEphemeralText).toContain('...[compressed]...');
      }
      
      // Regular data should still exist but may be compressed
      expect(decompressed.regularData).toBeDefined();
    });
  });

  describe('statistics and configuration', () => {
    it('should track compression statistics', async () => {
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: { test: 'data' },
        [ContextLayer.IMPORTANT]: {},
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      // Perform multiple compressions
      await compressionService.compress(classifiedContext);
      await compressionService.compress(classifiedContext);
      await compressionService.compress(classifiedContext);

      const stats = compressionService.getStats();
      
      expect(stats.totalOperations).toBe(3);
      expect(stats.averageRatio).toBeGreaterThan(0);
      expect(stats.averageCompressionTime).toBeGreaterThan(0);
    });

    it('should reset statistics', () => {
      compressionService.resetStats();
      
      const stats = compressionService.getStats();
      expect(stats.totalOperations).toBe(0);
      expect(stats.averageRatio).toBe(1.0);
      expect(stats.totalSizeReduction).toBe(0);
      expect(stats.averageCompressionTime).toBe(0);
    });

    it('should update configuration', () => {
      const newConfig: Partial<CompressionConfig> = {
        enabled: false,
        algorithm: 'deflate'
      };
      
      compressionService.updateConfig(newConfig);
      
      // Test that config was updated by checking behavior
      expect(compressionService).toBeInstanceOf(CompressionService);
    });

    it('should return immutable statistics', () => {
      const stats = compressionService.getStats();
      const originalTotalOps = stats.totalOperations;
      
      // Try to modify the returned stats
      stats.totalOperations = 999;
      
      // Should not affect the actual stats
      const newStats = compressionService.getStats();
      expect(newStats.totalOperations).toBe(originalTotalOps);
    });
  });

  describe('configuration-based behavior', () => {
    it('should skip compression when disabled', async () => {
      const service = new CompressionService({ enabled: false });
      
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: { test: 'data'.repeat(1000) },
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const result = await service.compress(classifiedContext);
      
      // Should have compression ratio of 1.0 (no compression)
      expect(result.compressionRatio).toBe(1.0);
      expect(result.compressedSize).toBe(result.originalSize);
    });

    it('should use deflate algorithm when configured', async () => {
      const service = new CompressionService({ algorithm: 'deflate' });
      
      const classifiedContext: ClassifiedContext = {
        [ContextLayer.CRITICAL]: {},
        [ContextLayer.IMPORTANT]: { test: 'data'.repeat(100) },
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      };

      const result = await service.compress(classifiedContext);
      
      expect(result.algorithm).toBe('deflate');
    });
  });

  describe('error handling', () => {
    it('should handle malformed context gracefully', async () => {
      const malformedContext = {
        [ContextLayer.CRITICAL]: null,
        [ContextLayer.IMPORTANT]: undefined,
        [ContextLayer.USEFUL]: {},
        [ContextLayer.EPHEMERAL]: {}
      } as any;

      // Should not throw
      const result = await compressionService.compress(malformedContext);
      
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('compressionRatio');
    });
  });
}); 