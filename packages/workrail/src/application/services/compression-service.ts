import * as zlib from 'zlib';
import { promisify } from 'util';
import {
  ICompressionService,
  ClassifiedContext,
  ContextLayer,
  CompressedBlob,
  RawContext,
  CompressionConfig,
  CompressionStats
} from '../../types/context-types';

// Promisified zlib functions for async/await usage
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * Layer-specific compression strategies based on importance hierarchy
 */
const LAYER_COMPRESSION_SETTINGS = {
  [ContextLayer.CRITICAL]: {
    enabled: false,           // Never compress critical data
    aggressiveness: 'none' as const,
    level: 0
  },
  [ContextLayer.IMPORTANT]: {
    enabled: true,
    aggressiveness: 'light' as const,
    level: 3                  // Light compression to preserve readability
  },
  [ContextLayer.USEFUL]: {
    enabled: true,
    aggressiveness: 'medium' as const,
    level: 6                  // Balanced compression
  },
  [ContextLayer.EPHEMERAL]: {
    enabled: true,
    aggressiveness: 'aggressive' as const,
    level: 9                  // Maximum compression for temporary data
  }
} as const;

/**
 * Default compression configuration following ADR 002 guidelines
 */
const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: true,
  algorithm: 'gzip',
  level: 6,                   // Default balanced compression level
  layerSettings: LAYER_COMPRESSION_SETTINGS
};

/**
 * CompressionService implements intelligent, layer-specific context compression
 * 
 * This service applies different compression strategies based on context classification:
 * - CRITICAL: No compression (preserves data integrity)
 * - IMPORTANT: Light compression (preserves readability)
 * - USEFUL: Medium compression (balanced efficiency)
 * - EPHEMERAL: Aggressive compression (maximum space savings)
 * 
 * Features:
 * - Configurable compression algorithms (gzip, deflate)
 * - Performance monitoring with timing and ratio tracking
 * - Graceful fallback to no compression on errors
 * - Immutable data handling throughout pipeline
 */
export class CompressionService implements ICompressionService {
  private config: CompressionConfig;
  private stats: CompressionStats;

  constructor(config: Partial<CompressionConfig> = {}) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...config };
    this.stats = {
      totalOperations: 0,
      averageRatio: 1.0,
      totalSizeReduction: 0,
      averageCompressionTime: 0
    };
  }

  /**
   * Compress classified context using layer-specific strategies
   */
  async compress(classified: ClassifiedContext): Promise<CompressedBlob> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Process each layer with appropriate compression level
      const compressedLayers: Record<string, any> = {};
      let totalOriginalSize = 0;
      let totalCompressedSize = 0;

      for (const [layerName, layerData] of Object.entries(classified)) {
        const layer = layerName as ContextLayer;
        const layerConfig = this.config.layerSettings[layer];
        
        if (!layerConfig.enabled || !this.config.enabled) {
          // No compression for this layer - use safe data handling
          const safeData = layerData || {};
          compressedLayers[layer] = safeData;
          const serialized = JSON.stringify(safeData);
          totalOriginalSize += Buffer.byteLength(serialized, 'utf8');
          totalCompressedSize += Buffer.byteLength(serialized, 'utf8');
          continue;
        }

        // Apply layer-specific compression
        const result = await this.compressLayer(layerData, layer, layerConfig.aggressiveness);
        compressedLayers[layer] = result.data;
        totalOriginalSize += result.originalSize;
        totalCompressedSize += result.compressedSize;
      }

      // Serialize the complete compressed structure
      const serializedData = JSON.stringify(compressedLayers);
      let finalCompressedBuffer: Buffer;
      
      // Apply algorithm compression only if globally enabled
      if (this.config.enabled) {
        finalCompressedBuffer = await this.applyAlgorithmCompression(
          Buffer.from(serializedData, 'utf8'),
          this.config.level
        );
      } else {
        finalCompressedBuffer = Buffer.from(serializedData, 'utf8');
      }

      const finalOriginalSize = Buffer.byteLength(serializedData, 'utf8');
      const finalCompressedSize = finalCompressedBuffer.length;
      
      // When compression is disabled, ensure sizes and ratio are consistent
      if (!this.config.enabled) {
        return {
          data: finalCompressedBuffer,
          originalSize: finalCompressedSize, // Use compressed size as original to ensure they match
          compressedSize: finalCompressedSize,
          compressionRatio: 1.0,
          algorithm: 'none'
        };
      }
      
      // Calculate compression ratio
      const compressionRatio = totalOriginalSize > 0 ? totalOriginalSize / finalCompressedSize : 1.0;
      
      // Update performance statistics
      const endTime = process.hrtime.bigint();
      const compressionTimeMs = Number(endTime - startTime) / 1_000_000;
      this.updateStats(compressionRatio, totalOriginalSize - finalCompressedSize, compressionTimeMs);

      return {
        data: finalCompressedBuffer,
        originalSize: totalOriginalSize,
        compressedSize: finalCompressedSize,
        compressionRatio,
        algorithm: this.config.enabled ? this.config.algorithm : 'none'
      };

    } catch (error) {
      // Graceful fallback: return uncompressed data
      console.warn('Compression failed, falling back to uncompressed data:', error);
      return this.createUncompressedBlob(classified);
    }
  }

  /**
   * Decompress blob back to raw context
   */
  async decompress(blob: CompressedBlob): Promise<RawContext> {
    try {
      // Handle uncompressed data
      if (blob.algorithm === 'none') {
        return JSON.parse(blob.data.toString('utf8'));
      }

      // Decompress the main data
      const decompressedBuffer = await this.applyAlgorithmDecompression(blob.data);
      const decompressedData = JSON.parse(decompressedBuffer.toString('utf8'));

      // Reconstruct raw context from layered structure
      const rawContext: RawContext = {};
      
      for (const [layerName, layerData] of Object.entries(decompressedData)) {
        const layer = layerName as ContextLayer;
        const layerConfig = this.config.layerSettings[layer];
        
        if (!layerConfig.enabled) {
          // Data was not compressed, merge directly
          Object.assign(rawContext, layerData);
        } else {
          // Data was compressed, may need additional decompression
          const decompressedLayerData = await this.decompressLayer(layerData, layer);
          Object.assign(rawContext, decompressedLayerData);
        }
      }

      return Object.freeze(rawContext); // Return immutable context

    } catch (error) {
      throw new Error(`Decompression failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current compression statistics
   */
  getStats(): CompressionStats {
    return { ...this.stats }; // Return copy to maintain immutability
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      totalOperations: 0,
      averageRatio: 1.0,
      totalSizeReduction: 0,
      averageCompressionTime: 0
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Private helper methods

  private async compressLayer(
    layerData: Record<string, any>, 
    layer: ContextLayer, 
    aggressiveness: 'none' | 'light' | 'medium' | 'aggressive'
  ): Promise<{ data: any; originalSize: number; compressedSize: number }> {
    // Handle null/undefined values gracefully
    const safeLayerData = layerData || {};
    const serialized = JSON.stringify(safeLayerData);
    const originalSize = Buffer.byteLength(serialized, 'utf8');

    if (aggressiveness === 'none') {
      return {
        data: safeLayerData,
        originalSize,
        compressedSize: originalSize
      };
    }

    // Apply content-based compression strategies based on aggressiveness
    let processedData = safeLayerData;
    
    switch (aggressiveness) {
      case 'light':
        // Light compression: minimal string processing
        processedData = this.applyLightCompression(layerData);
        break;
      case 'medium':
        // Medium compression: string compression + key abbreviation
        processedData = this.applyMediumCompression(layerData);
        break;
      case 'aggressive':
        // Aggressive compression: full optimization for EPHEMERAL data
        processedData = this.applyAggressiveCompression(layerData);
        break;
    }

    const processedSerialized = JSON.stringify(processedData);
    const compressedSize = Buffer.byteLength(processedSerialized, 'utf8');

    return {
      data: processedData,
      originalSize,
      compressedSize
    };
  }

  private async decompressLayer(layerData: any, layer: ContextLayer): Promise<Record<string, any>> {
    // For now, return data as-is since we're not applying deep structural compression
    // This method is a placeholder for future advanced compression strategies
    return layerData;
  }

  private applyLightCompression(data: Record<string, any>): Record<string, any> {
    // Light compression: basic whitespace removal and key optimization
    const compressed: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        // Remove excessive whitespace
        compressed[key] = value.replace(/\s+/g, ' ').trim();
      } else {
        compressed[key] = value;
      }
    }
    
    return compressed;
  }

  private applyMediumCompression(data: Record<string, any>): Record<string, any> {
    // Medium compression: string optimization + truncation
    const compressed: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        // More aggressive string processing
        let processedValue = value.replace(/\s+/g, ' ').trim();
        
        // Truncate very long strings for USEFUL layer
        if (processedValue.length > 1000) {
          processedValue = processedValue.substring(0, 950) + '...[truncated]';
        }
        
        compressed[key] = processedValue;
      } else if (Array.isArray(value) && value.length > 50) {
        // Truncate large arrays
        compressed[key] = [...value.slice(0, 50), '...[truncated]'];
      } else {
        compressed[key] = value;
      }
    }
    
    return compressed;
  }

  private applyAggressiveCompression(data: Record<string, any>): Record<string, any> {
    // Aggressive compression: maximum space savings for EPHEMERAL data
    const compressed: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(data)) {
      // Skip debug and temporary data entirely
      if (key.includes('debug') || key.includes('temp') || key.includes('timestamp')) {
        continue;
      }
      
      if (typeof value === 'string') {
        // Heavily compress strings
        let processedValue = value.replace(/\s+/g, ' ').trim();
        
        if (processedValue.length > 200) {
          // Keep only first 100 and last 50 characters for context
          processedValue = processedValue.substring(0, 100) + 
                          '...[compressed]...' + 
                          processedValue.substring(processedValue.length - 50);
        }
        
        compressed[key] = processedValue;
      } else if (Array.isArray(value) && value.length > 10) {
        // Keep only essential array elements
        compressed[key] = [...value.slice(0, 5), '...[compressed]', ...value.slice(-2)];
      } else if (typeof value === 'object' && value !== null) {
        // Recursively compress objects
        compressed[key] = this.applyAggressiveCompression(value);
      } else {
        compressed[key] = value;
      }
    }
    
    return compressed;
  }

  private async applyAlgorithmCompression(data: Buffer, level: number): Promise<Buffer> {
    const options = { level };
    
    switch (this.config.algorithm) {
      case 'gzip':
        return await gzip(data, options);
      case 'deflate':
        return await deflate(data, options);
      default:
        throw new Error(`Unsupported compression algorithm: ${this.config.algorithm}`);
    }
  }

  private async applyAlgorithmDecompression(data: Buffer): Promise<Buffer> {
    switch (this.config.algorithm) {
      case 'gzip':
        return await gunzip(data);
      case 'deflate':
        return await inflate(data);
      default:
        throw new Error(`Unsupported compression algorithm: ${this.config.algorithm}`);
    }
  }

  private createUncompressedBlob(classified: ClassifiedContext): CompressedBlob {
    const serialized = JSON.stringify(classified);
    const data = Buffer.from(serialized, 'utf8');
    const size = data.length;
    
    return {
      data,
      originalSize: size,
      compressedSize: size,
      compressionRatio: 1.0,
      algorithm: 'none'
    };
  }



  private updateStats(ratio: number, sizeReduction: number, timeMs: number): void {
    const prevOps = this.stats.totalOperations;
    
    // Update rolling averages
    this.stats.totalOperations += 1;
    this.stats.averageRatio = (this.stats.averageRatio * prevOps + ratio) / this.stats.totalOperations;
    this.stats.totalSizeReduction += sizeReduction;
    this.stats.averageCompressionTime = (this.stats.averageCompressionTime * prevOps + timeMs) / this.stats.totalOperations;
  }
} 